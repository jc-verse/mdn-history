import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHistory } from "./history.mjs";
import {
  collect,
  completeTimeline,
  createClient,
  readSnapshot,
} from "./github.mjs";

const date = "2026-08-31T12:00:00.000Z";
const pageInfo = (more, cursor) => ({ hasNextPage: more, endCursor: cursor });
const record = (number) => ({
  id: `id-${number}`,
  number,
  title: `Item ${number}`,
  createdAt: "2020-09-15T12:00:00Z",
  updatedAt: date,
  closedAt: null,
  state: "OPEN",
  timelineItems: { nodes: [], pageInfo: pageInfo(false, null) },
});
const response = (kind, nodes, more = false, cursor = null) => ({
  repository: {
    createdAt: "2020-09-15T12:00:00Z",
    [kind]: {
      nodes,
      pageInfo: pageInfo(more, cursor),
      totalCount: kind === "issues" ? 2 : 1,
    },
  },
  rateLimit: { remaining: 4000 },
});

test("paginates long timelines without truncating reopen events", async () => {
  const input = record(1);
  input.timelineItems = {
    nodes: [{ __typename: "ClosedEvent", createdAt: date }],
    pageInfo: pageInfo(true, "next"),
  };
  const output = await completeTimeline(
    async (query, variables) => {
      assert.equal(variables.eventCursor, "next");
      assert.match(query, /ReopenedEvent/);
      return {
        node: {
          timelineItems: {
            nodes: [{ __typename: "ReopenedEvent", createdAt: date }],
            pageInfo: pageInfo(false, "end"),
          },
        },
      };
    },
    input,
    "issues",
  );
  assert.equal(output.title, "Item 1");
  assert.deepEqual(
    output.events.map((e) => e.type),
    ["ClosedEvent", "ReopenedEvent"],
  );
});

test("rejects API records without titles before fetching timeline pages", async () => {
  await assert.rejects(
    completeTimeline(
      async () => assert.fail("missing titles must fail immediately"),
      { ...record(7), title: undefined },
      "issues",
    ),
    /Missing title for #7/,
  );
});

test("interrupted collection resumes only unfinished pages and never renders partial data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fail = true;
  const calls = [];
  const client = async (query, variables) => {
    if (variables.ids)
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    calls.push([kind, variables.cursor]);
    if (kind === "pullRequests") return response(kind, [record(3)]);
    if (!variables.cursor) return response(kind, [record(1)], true, "page2");
    if (fail) throw new Error("rate limited");
    return response(kind, [record(2)]);
  };
  const options = {
    directory,
    client,
    now: new Date(date),
    log: () => {},
    batchSize: 1,
  };
  await assert.rejects(collect(options), /rate limited/);
  assert.throws(() => readSnapshot(directory), /No complete snapshot/);
  fail = false;
  calls.length = 0;
  const snapshot = await collect(options);
  assert.equal(snapshot.items.length, 3);
  assert.deepEqual(calls, [["issues", "page2"]]);
  assert.equal(snapshot.asOf, date);
  assert.deepEqual(readSnapshot(directory), snapshot);
  calls.length = 0;
  await collect(options);
  assert.ok(
    calls.some(([kind, cursor]) => kind === "issues" && cursor === null),
    "completed snapshots are refreshed on a normal run",
  );
});

test("GraphQL failures are surfaced even with HTTP 200, and requests only use the public API", async () => {
  const client = createClient("test-token", async (url, options) => {
    assert.equal(url, "https://api.github.com/graphql");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return new Response(
      JSON.stringify({ errors: [{ message: "rate limit exceeded" }] }),
      { status: 200 },
    );
  });
  await assert.rejects(
    client("query { viewer { login } }"),
    /rate limit exceeded/,
  );
});

test("parallel pages finishing out of order still produce contiguous, resumable checkpoints", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mdn-history-batch-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const completed = [];
  const client = async (query, variables) => {
    if (variables.ids) {
      const number = Number(variables.ids[0].slice(3));
      if (number !== 100) {
        await new Promise((resolve) => setTimeout(resolve, (5 - number) * 5));
        completed.push(number - 1);
      }
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
    }
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    if (kind === "pullRequests") return response(kind, [record(100)]);
    const page = variables.cursor ? Number(variables.cursor) : 0;
    const result = response(
      kind,
      [record(page + 1)],
      page < 3,
      String(page + 1),
    );
    return result;
  };
  const result = await collect({
    directory,
    client,
    now: new Date(date),
    log: () => {},
  });
  assert.deepEqual(completed, [3, 2, 1, 0]);
  assert.deepEqual(
    result.items.filter((i) => i.kind === "issue").map((i) => i.number),
    [1, 2, 3, 4],
  );
  assert.equal(result.streams.issues.pages, 4);
  assert.equal(result.streams.issues.done, true);
});

test("HTTP rate limits give a resumable error without revealing credentials", async () => {
  const client = createClient(
    "secret-token",
    async () =>
      new Response("limited", {
        status: 403,
        headers: { "retry-after": "60" },
      }),
  );
  await assert.rejects(client("query {}"), (error) => {
    assert.match(error.message, /Retry after 60 seconds/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

async function seedCache(t, { legacy = false } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mdn-history-refresh-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const items = [1, 2, 3].map((number) => ({
    number,
    title: `Item ${number}`,
    kind: number === 3 ? "pr" : "issue",
    createdAt: "2020-09-15T12:00:00Z",
    closedAt: null,
    state: "OPEN",
    events: [],
    ...(legacy ? {} : { updatedAt: "2026-08-30T12:00:00Z" }),
  }));
  const manifest = {
    version: 1,
    repository: "mdn/content",
    createdAt: "2020-09-15T12:00:00Z",
    asOf: date,
    // The cutoff must use asOf, even when downloading took hours.
    fetchedAt: "2026-08-31T16:00:00Z",
    complete: true,
    streams: {
      issues: { pages: 1, done: true, count: 2 },
      pullRequests: { pages: 1, done: true, count: 1 },
    },
  };
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(directory, "issues-0.json"),
    JSON.stringify(items.slice(0, 2)),
  );
  fs.writeFileSync(
    path.join(directory, "pullRequests-0.json"),
    JSON.stringify(items.slice(2)),
  );
  return {
    directory,
    client: null,
    now: new Date("2026-09-01T12:00:00Z"),
    log: () => {},
  };
}

test("missing cached titles fail instead of triggering compatibility requests", async (t) => {
  const options = await seedCache(t);
  const snapshot = readSnapshot(options.directory);
  delete snapshot.items[0].title;
  fs.writeFileSync(
    path.join(options.directory, "snapshot.json"),
    JSON.stringify(snapshot),
  );
  assert.throws(() => readSnapshot(options.directory), /Missing title for #1/);
  options.client = async () => assert.fail("no compatibility requests");
  await assert.rejects(collect(options), /Missing title for #1/);
});

test("refreshes only recent records, merging creations, closures, reopens and merges into existing history", async (t) => {
  const options = await seedCache(t);
  const records = new Map(
    [1, 2, 3, 4].map((number) => [number, record(number)]),
  );
  Object.assign(records.get(1), {
    updatedAt: "2026-08-31T13:00:00Z",
    state: "CLOSED",
    closedAt: "2026-08-31T13:00:00Z",
    timelineItems: {
      nodes: [{ __typename: "ClosedEvent", createdAt: "2026-08-31T13:00:00Z" }],
      pageInfo: pageInfo(false, null),
    },
  });
  Object.assign(records.get(2), {
    updatedAt: "2026-08-31T14:00:00Z",
    timelineItems: {
      nodes: [
        { __typename: "ClosedEvent", createdAt: "2026-08-31T13:00:00Z" },
        { __typename: "ReopenedEvent", createdAt: "2026-08-31T14:00:00Z" },
      ],
      pageInfo: pageInfo(false, null),
    },
  });
  Object.assign(records.get(3), {
    updatedAt: "2026-08-31T15:00:00Z",
    state: "MERGED",
    closedAt: "2026-08-31T15:00:00Z",
    timelineItems: {
      nodes: [{ __typename: "MergedEvent", createdAt: "2026-08-31T15:00:00Z" }],
      pageInfo: pageInfo(false, null),
    },
  });
  Object.assign(records.get(4), {
    createdAt: "2026-08-31T16:00:00Z",
    updatedAt: "2026-08-31T16:00:00Z",
  });
  const old = { ...record(5), updatedAt: "2020-01-01T00:00:00Z" };
  const details = [];
  const listings = [];
  options.client = async (query, variables) => {
    if (variables.ids) {
      details.push(...variables.ids);
      return {
        nodes: variables.ids.map((id) => records.get(Number(id.slice(3)))),
      };
    }
    assert.match(query, /field:UPDATED_AT,direction:DESC/);
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    listings.push([kind, variables.cursor]);
    assert.equal(
      variables.cursor,
      null,
      "must stop at the first page containing older records",
    );
    return response(
      kind,
      kind === "issues"
        ? [records.get(4), records.get(2), records.get(1), old]
        : [records.get(3), old],
      true,
      "older",
    );
  };
  const snapshot = await collect(options);
  assert.deepEqual(details.sort(), ["id-1", "id-2", "id-3", "id-4"]);
  assert.equal(snapshot.items.length, 4);
  assert.deepEqual(
    snapshot.items
      .find((item) => item.number === 2)
      .events.map((event) => event.type),
    ["ClosedEvent", "ReopenedEvent"],
  );
  assert.deepEqual(buildHistory(snapshot).rows.at(-1), {
    date: "2026-09-01",
    openIssues: 2,
    openPRs: 0,
  });
  assert.deepEqual(readSnapshot(options.directory), snapshot);
  assert.equal(listings.length, 2);
});

test("inclusive overlap spans pagination boundaries and unchanged timelines are reused", async (t) => {
  const options = await seedCache(t);
  const before = readSnapshot(options.directory);
  const cutoff = "2026-08-31T11:55:00.000Z";
  const calls = [];
  options.client = async (query, variables) => {
    if (variables.ids) {
      calls.push(...variables.ids);
      return {
        nodes: variables.ids.map((id) => ({
          ...record(Number(id.slice(3))),
          updatedAt: cutoff,
        })),
      };
    }
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    if (kind === "pullRequests")
      return response(kind, [
        { ...record(3), updatedAt: "2026-08-30T12:00:00Z" },
      ]);
    if (!variables.cursor)
      return response(
        kind,
        [{ ...record(1), updatedAt: cutoff }],
        true,
        "next",
      );
    return response(kind, [{ ...record(2), updatedAt: cutoff }]);
  };
  const first = await collect(options);
  assert.deepEqual(calls, ["id-1", "id-2"]);
  assert.deepEqual(
    first.items.find((item) => item.number === 3),
    before.items.find((item) => item.number === 3),
  );
  // Repeat with the same cutoff to exercise the timestamp cache within overlap.
  const snapshotPath = path.join(options.directory, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({ ...first, asOf: date }));
  calls.length = 0;
  await collect(options);
  assert.deepEqual(
    calls,
    [],
    "unchanged recent records need no timeline calls",
  );
});

test("failed refresh preserves the published snapshot and retries from the head with cached completed timelines", async (t) => {
  const options = await seedCache(t, { legacy: true });
  const before = readSnapshot(options.directory);
  let fail = true;
  const details = [];
  const listings = [];
  options.client = async (query, variables) => {
    if (variables.ids) {
      details.push(...variables.ids);
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
    }
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    listings.push([kind, variables.cursor]);
    if (kind === "pullRequests") return response(kind, []);
    if (!variables.cursor) return response(kind, [record(1)], true, "next");
    if (fail) throw new Error("rate limited");
    return response(kind, [record(2)]);
  };
  await assert.rejects(collect(options), /rate limited/);
  assert.deepEqual(readSnapshot(options.directory), before);
  assert.deepEqual(details, ["id-1"]);
  fail = false;
  details.length = 0;
  listings.length = 0;
  const snapshot = await collect(options);
  assert.deepEqual(details, ["id-2"]);
  assert.deepEqual(
    listings.filter(([kind]) => kind === "issues"),
    [
      ["issues", null],
      ["issues", "next"],
    ],
  );
  assert.equal(snapshot.items.length, 3);
  assert.equal(
    fs.existsSync(path.join(options.directory, "refresh.json")),
    false,
  );
});

test("fresh rebuild reads all pages and preserves a legacy snapshot if interrupted", async (t) => {
  const options = await seedCache(t, { legacy: true });
  const before = readSnapshot(options.directory);
  let fail = true;
  options.client = async (query, variables) => {
    if (variables.ids)
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
    assert.match(query, /field:CREATED_AT,direction:ASC/);
    if (fail) throw new Error("offline");
    const kind = query.includes("pullRequests(first:")
      ? "pullRequests"
      : "issues";
    return response(kind, kind === "issues" ? [record(1)] : []);
  };
  await assert.rejects(collect({ ...options, fresh: true }), /offline/);
  assert.deepEqual(readSnapshot(options.directory), before);
  fail = false;
  const result = await collect(options);
  assert.equal(
    result.items.length,
    1,
    "full rebuild replaces records removed from GitHub",
  );
  assert.deepEqual(readSnapshot(options.directory), result);
});

test("invalid update timestamps and repeated cursors never publish partial refreshes", async (t) => {
  for (const invalidTimestamp of [true, false]) {
    const options = await seedCache(t);
    const before = readSnapshot(options.directory);
    options.client = async (query, variables) => {
      if (variables.ids) return { nodes: [record(1)] };
      const kind = query.includes("pullRequests(first:")
        ? "pullRequests"
        : "issues";
      if (kind === "pullRequests") return response(kind, []);
      return response(
        kind,
        [{ ...record(1), updatedAt: invalidTimestamp ? null : date }],
        true,
        "same",
      );
    };
    await assert.rejects(
      collect(options),
      invalidTimestamp ? /update timestamp/ : /repeated page cursor/,
    );
    assert.deepEqual(readSnapshot(options.directory), before);
  }
});
