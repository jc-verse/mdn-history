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
  pageQuery,
  readSnapshot,
} from "./github.mjs";

const date = "2026-08-31T12:00:00.000Z";
const pageInfo = (more, cursor) => ({ hasNextPage: more, endCursor: cursor });
const record = (number) => ({
  id: `id-${number}`,
  number,
  title: `Item ${number}`,
  author: { __typename: "User", login: "opener" },
  labels: { nodes: [], pageInfo: pageInfo(false, null) },
  baseRefName: "main",
  closedByPullRequestsReferences: { nodes: [], pageInfo: pageInfo(false, null) },
  createdAt: "2020-09-15T12:00:00Z",
  updatedAt: date,
  closedAt: null,
  state: "OPEN",
  timelineItems: { nodes: [], pageInfo: pageInfo(false, null) },
  interactionItems: { nodes: [], pageInfo: pageInfo(false, null) },
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
      assert.match(query, /timelineItems\(first:100/);
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

test("full listings filter main while incremental listings detect PRs retargeted away", () => {
  assert.match(pageQuery("pullRequests"), /baseRefName:"main"/);
  assert.doesNotMatch(pageQuery("pullRequests", true), /baseRefName:"main"/);
  assert.match(pageQuery("pullRequests", true), /state baseRefName/);
  assert.doesNotMatch(pageQuery("issues"), /baseRefName/);
});

test("out-of-scope PRs are discarded without fetching comments or lifecycle pages", async () => {
  for (const baseRefName of ["release", "master", "Main"]) {
    const result = await completeTimeline(async () => assert.fail("must skip out-of-scope PRs"), {
      ...record(1), baseRefName, headRefName: "main", timelineItems: { nodes: [], pageInfo: pageInfo(true, "unused") },
    }, "pullRequests");
    assert.equal(result, null);
  }
  const main = await completeTimeline(async () => assert.fail("no extra pages"), { ...record(1), headRefName: "feature" }, "pullRequests");
  assert.equal(main.targetBranch, "main");
  await assert.rejects(completeTimeline(async () => {}, { ...record(1), baseRefName: undefined }, "pullRequests"), /Missing target branch/);
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

test("records original authors and only qualifying evidence of additional interaction", async () => {
  const comment = (login, type = "User") => ({ __typename: "IssueComment", author: login ? { __typename: type, login } : null });
  const review = (login, state, type = "User") => ({ __typename: "PullRequestReview", author: { __typename: type, login }, state });
  const cases = [
    ["issues", [], {}, false],
    ["issues", [comment("opener"), comment("OPENER"), comment(null)], {}, false],
    ["issues", [comment("someone-else")], {}, true],
    ["issues", [comment("someone-else")], { author: { __typename: "Bot", login: "robot-helper" } }, true],
    ["pullRequests", [comment("robot-helper")], {}, true],
    ...["issues", "pullRequests"].flatMap((kind) =>
      ["github-actions", "dependabot", "robot-helper"].map((login) =>
        [kind, [comment(login, "Bot")], {}, false])),
    ["pullRequests", [comment("robot-helper", "Bot")], { state: "MERGED" }, true],
    ["issues", [comment("robot-helper", "Bot")], { hasLinkedMainPR: true }, true],
    ["pullRequests", [review("opener", "COMMENTED")], {}, false],
    ["pullRequests", [review("reviewer", "PENDING")], {}, false],
    ...["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].map((state) =>
      ["pullRequests", [review("reviewer", state)], {}, true]),
    ...["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].flatMap((state) =>
      ["github-actions", "dependabot", "robot-helper"].map((login) =>
        ["pullRequests", [review(login, state, "Bot")], {}, false])),
    ["pullRequests", [{ __typename: "PullRequestReviewThread", comments: {
      nodes: [{ author: { __typename: "Bot", login: "robot-helper" }, state: "SUBMITTED" }],
      pageInfo: pageInfo(false, null),
    } }], {}, false],
    ["issues", [{ __typename: "ClosedEvent", createdAt: date }], { state: "CLOSED" }, false],
    ["pullRequests", [{ __typename: "ClosedEvent", createdAt: date }], { state: "CLOSED" }, false],
    ["pullRequests", [], { state: "MERGED", author: null }, true],
    ["pullRequests", [{ __typename: "MergedEvent", createdAt: date }], {}, true],
    ["issues", [], { closedByPullRequestsReferences: { nodes: [{ baseRefName: "main" }], pageInfo: pageInfo(false, null) }, author: null }, true],
    ["issues", [{ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", baseRefName: "main" } }], {}, true],
    ["issues", [{ __typename: "ConnectedEvent", subject: { __typename: "PullRequest", baseRefName: "main" } }], {}, true],
    ["issues", [{ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", baseRefName: "release" } }], {}, false],
    ["issues", [{ __typename: "ConnectedEvent", subject: { __typename: "PullRequest", baseRefName: "master" } }], {}, false],
    ["issues", [], { closedByPullRequestsReferences: { nodes: [{ baseRefName: "release" }], pageInfo: pageInfo(false, null) } }, false],
    ["issues", [{ __typename: "CrossReferencedEvent", source: { __typename: "Issue" } }], {}, false],
    ["issues", [comment("someone-else")], { author: null }, false],
  ];
  for (const [kind, events, extra, expected] of cases) {
    const lifecycle = events.filter((event) => ["ClosedEvent", "MergedEvent"].includes(event.__typename));
    const input = {
      ...record(1), ...extra,
      timelineItems: { nodes: lifecycle, pageInfo: pageInfo(false, null) },
      interactionItems: { nodes: events.filter((event) => !lifecycle.includes(event)), pageInfo: pageInfo(false, null) },
    };
    const output = await completeTimeline(async () => assert.fail("unexpected pagination"), input, kind);
    assert.equal(output.author, input.author?.login ?? null);
    if (kind === "pullRequests") assert.equal(output.targetBranch, "main");
    assert.equal(output.hasAdditionalInteraction, expected, JSON.stringify({ kind, events, extra }));
    assert.ok(output.events.every((event) => ["ClosedEvent", "ReopenedEvent", "MergedEvent"].includes(event.type)));
  }
});

test("finds evidence on later timeline and inline review comment pages", async () => {
  for (const [kind, author] of ["issues", "pullRequests"].flatMap((kind) =>
    [{ __typename: "User", login: "opener" }, { __typename: "Bot", login: "robot-helper" }]
      .map((author) => [kind, author]))) {
    const input = record(1);
    input.interactionItems = {
      nodes: Array.from({ length: 5 }, () => ({ __typename: "IssueComment", author })),
      pageInfo: pageInfo(true, "evidence-2"),
    };
    const calls = [];
    const output = await completeTimeline(async (query, variables) => {
      calls.push(variables);
      if (variables.interactionCursor) {
        assert.equal(variables.interactionCursor, "evidence-2");
        assert.match(query, /timelineItems\(first:5/);
        assert.match(query, /ISSUE_COMMENT/);
        assert.match(query, /author \{ __typename login \}/);
        if (kind === "pullRequests") assert.match(query, /PULL_REQUEST_REVIEW_THREAD/);
        return { node: { interactionItems: {
          pageInfo: pageInfo(true, "must-not-fetch"),
          nodes: kind === "issues" ? [{ __typename: "IssueComment", author: { login: "other" } }] : [{
            __typename: "PullRequestReviewThread", id: "thread-1",
            comments: {
              nodes: [
                ...Array.from({ length: 4 }, () => ({ author, state: "SUBMITTED" })),
                { author: { login: "other" }, state: "PENDING" },
              ],
              pageInfo: pageInfo(true, "comments-2"),
            },
          }],
        } } };
      }
      assert.equal(variables.id, "thread-1");
      assert.equal(variables.commentCursor, "comments-2");
      assert.match(query, /comments\(first:5, after:\$commentCursor/);
      assert.match(query, /author \{ __typename login \}/);
      return { node: { comments: {
        nodes: [{ author: { login: "other" }, state: "SUBMITTED" }],
        pageInfo: pageInfo(false, null),
      } } };
    }, input, kind);
    assert.equal(output.hasAdditionalInteraction, true);
    assert.deepEqual(output.events, []);
    assert.equal(calls.length, kind === "issues" ? 1 : 2);
  }
});

test("review pagination errors cannot publish a false no-interaction result", async () => {
  const input = record(1);
  const comments = { nodes: [], pageInfo: pageInfo(true, "same") };
  input.interactionItems.nodes = [{ __typename: "PullRequestReviewThread", id: "thread", comments }];
  await assert.rejects(completeTimeline(async () => ({ node: { comments } }), input, "pullRequests"), /repeated review comment cursor/);
  await assert.rejects(completeTimeline(async () => ({ node: null }), input, "pullRequests"), /missing review comments/);
});

test("records bot authors and finds an exact spam label beyond the first label page", async () => {
  for (const kind of ["issues", "pullRequests"]) {
    const input = {
      ...record(1), author: { __typename: "Bot", login: "service-account" },
      labels: { nodes: ["notspam", "spammy", "a", "b", "c"].map((name) => ({ name })), pageInfo: pageInfo(true, "labels-2") },
    };
    let calls = 0;
    const result = await completeTimeline(async (query, variables) => {
      calls++;
      assert.equal(variables.labelCursor, "labels-2");
      assert.match(query, /labels\(first:5, after:\$labelCursor/);
      return { node: { labels: { nodes: [{ name: "SpAm" }], pageInfo: pageInfo(true, "do-not-fetch") } } };
    }, input, kind);
    assert.equal(calls, 1);
    assert.equal(result.authorIsBot, true);
    assert.equal(result.hasSpamLabel, true);
  }
});

test("bot and spam metadata cannot silently ignore missing fields or broken label pagination", async () => {
  const input = record(1);
  input.labels.nodes = [{ name: "spammy" }];
  const result = await completeTimeline(async () => assert.fail("unexpected request"), input, "issues");
  assert.equal(result.hasSpamLabel, false);
  assert.equal(result.authorIsBot, false);
  await assert.rejects(completeTimeline(async () => {}, { ...input, author: { login: "opener" } }, "issues"), /missing author account type/);
  await assert.rejects(completeTimeline(async () => {}, { ...input, labels: undefined }, "issues"), /missing label metadata/);
  input.labels.pageInfo = pageInfo(true, "repeated");
  await assert.rejects(completeTimeline(async () => ({ node: { labels: input.labels } }), input, "issues"), /repeated label cursor/);
});

test("a qualifying first batch stops evidence fetching without truncating lifecycle history", async () => {
  for (const kind of ["issues", "pullRequests"]) {
    const input = record(1);
    input.timelineItems.pageInfo = pageInfo(true, "last-closure");
    input.interactionItems = {
      nodes: Array.from({ length: 5 }, (_, i) => ({
        __typename: "IssueComment", author: { login: i === 4 ? "other" : "opener" },
      })),
      pageInfo: pageInfo(true, "do-not-request"),
    };
    let calls = 0;
    const result = await completeTimeline(async (query, variables) => {
      calls++;
      assert.equal(variables.eventCursor, "last-closure");
      assert.doesNotMatch(query, /ISSUE_COMMENT|PULL_REQUEST_REVIEW/);
      return { node: { timelineItems: {
        nodes: [{ __typename: "ClosedEvent", createdAt: date }],
        pageInfo: pageInfo(false, null),
      } } };
    }, input, kind);
    assert.equal(calls, 1);
    assert.equal(result.hasAdditionalInteraction, true);
    assert.deepEqual(result.events, [{ type: "ClosedEvent", at: date }]);
  }
});

test("author and excluded-bot evidence is exhausted and invalid evidence cursors fail safely", async () => {
  const input = record(1);
  input.interactionItems = {
    nodes: Array.from({ length: 5 }, (_, i) => ({ __typename: "IssueComment", author: {
      __typename: i % 2 ? "User" : "Bot", login: i % 2 ? "opener" : "robot-helper",
    } })),
    pageInfo: pageInfo(true, "next"),
  };
  const result = await completeTimeline(async () => ({ node: {
    interactionItems: { nodes: [], pageInfo: pageInfo(false, null) },
  } }), input, "issues");
  assert.equal(result.hasAdditionalInteraction, false);
  await assert.rejects(completeTimeline(async () => ({ node: {
    interactionItems: input.interactionItems,
  } }), input, "issues"), /repeated interaction cursor/);
  await assert.rejects(completeTimeline(async () => ({ node: null }), input, "issues"), /missing interaction evidence/);
});

test("proof in an already-fetched thread skips pagination of earlier author-only threads", async () => {
  const input = record(1);
  input.interactionItems = {
    nodes: ["opener", "other"].map((login) => ({
      __typename: "PullRequestReviewThread", id: login,
      comments: {
        nodes: [{ author: { login }, state: "SUBMITTED" }],
        pageInfo: pageInfo(true, "do-not-request"),
      },
    })),
    pageInfo: pageInfo(true, "do-not-request"),
  };
  const result = await completeTimeline(async () => assert.fail("proof is already in the batch"), input, "pullRequests");
  assert.equal(result.hasAdditionalInteraction, true);
});

test("interrupted collection resumes only unfinished pages and never renders partial data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fail = true;
  const calls = [];
  const client = async (query, variables) => {
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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
  assert.equal(Object.hasOwn(snapshot, "version"), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"))), "version"), false);
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
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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

test("paginates item timelines concurrently with a bound and preserves page order", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-timelines-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let active = 0;
  let peak = 0;
  const records = Array.from({ length: 20 }, (_, i) => record(i + 1));
  const client = async (query, variables) => {
    if (variables.ids) return { nodes: records.map((item) => ({
      ...item, timelineItems: { nodes: [], pageInfo: pageInfo(true, "next") },
    })) };
    if (variables.id) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { node: { timelineItems: {
        nodes: [{ __typename: "ReopenedEvent", createdAt: date }],
        pageInfo: pageInfo(false, null),
      } } };
    }
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    return response(kind, kind === "issues" ? records : []);
  };
  const result = await collect({ directory, client, now: new Date(date), log: () => {} });
  assert.ok(peak > 1 && peak <= 8);
  assert.deepEqual(result.items.map((item) => item.number), records.map((item) => item.number));
  assert.ok(result.items.every((item) => item.events[0].type === "ReopenedEvent"));
});

test("merged PRs and linked issues skip comments but still paginate lifecycle history", async (t) => {
  for (const kind of ["issues", "pullRequests"]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-shortcut-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const records = [record(1), {
      ...record(2),
      ...(kind === "issues" ? { closedByPullRequestsReferences: { nodes: [{ baseRefName: "main" }], pageInfo: pageInfo(false, null) } } : { state: "MERGED" }),
    }, record(3)];
    const client = async (query, variables) => {
      if (variables.ids && Object.hasOwn(variables, "interactionCursor")) {
        assert.deepEqual(variables.ids, ["id-1", "id-3"]);
        assert.match(query, /timelineItems\(first:5/);
        assert.equal((query.match(/author \{ __typename login \}/g) || []).length, kind === "issues" ? 1 : 3);
        return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
      }
      if (variables.ids) {
        assert.deepEqual(variables.ids, ["id-1", "id-2", "id-3"]);
        assert.doesNotMatch(query, /ISSUE_COMMENT|PULL_REQUEST_REVIEW/);
        return { nodes: records.map((item) => ({
          ...item,
          timelineItems: { nodes: [], pageInfo: pageInfo(item.number === 2, "next") },
        })) };
      }
      if (variables.id) {
        assert.equal(variables.id, "id-2");
        assert.doesNotMatch(query, /ISSUE_COMMENT|PULL_REQUEST_REVIEW/);
        return { node: { timelineItems: {
          nodes: [{ __typename: "ClosedEvent", createdAt: date }],
          pageInfo: pageInfo(false, null),
        } } };
      }
      const requested = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
      return response(requested, kind === requested ? records : []);
    };
    const result = await collect({ directory, client, now: new Date(date), log: () => {} });
    assert.deepEqual(result.items.map((item) => item.number), [1, 2, 3]);
    assert.equal(result.items[1].hasAdditionalInteraction, true);
    assert.deepEqual(result.items[1].events, [{ type: "ClosedEvent", at: date }]);
  }
});

test("linked PR checks skip non-main branches and stop at the first main link", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-links-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let linkPages = 0;
  const client = async (query, variables) => {
    if (variables.linkCursor) {
      linkPages++;
      assert.equal(variables.linkCursor, "links-2");
      assert.match(query, /nodes \{ baseRefName \}/);
      return { node: { closedByPullRequestsReferences: {
        nodes: [{ baseRefName: "main" }], pageInfo: pageInfo(true, "unused"),
      } } };
    }
    if (variables.ids) {
      assert.ok(!Object.hasOwn(variables, "interactionCursor"), "a main link skips comments");
      return { nodes: [{ ...record(1), closedByPullRequestsReferences: {
        nodes: Array.from({ length: 5 }, () => ({ baseRefName: "release" })),
        pageInfo: pageInfo(true, "links-2"),
      } }] };
    }
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    return response(kind, kind === "issues" ? [record(1)] : []);
  };
  const result = await collect({ directory, client, now: new Date(date), log: () => {} });
  assert.equal(linkPages, 1);
  assert.equal(result.items[0].hasAdditionalInteraction, true);
});

test("full collection never fetches details for non-main PRs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdn-history-branches-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = async (query, variables) => {
    if (variables.ids) {
      assert.deepEqual(variables.ids, ["id-1"]);
      return { nodes: [record(1)] };
    }
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    return response(kind, kind === "pullRequests" ? [record(1), { ...record(2), baseRefName: "release" }] : []);
  };
  const result = await collect({ directory, client, now: new Date(date), log: () => {} });
  assert.deepEqual(result.items.map((item) => [item.number, item.targetBranch]), [[1, "main"]]);
  const snapshotPath = path.join(directory, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({ ...result, items: [...result.items, {
    ...result.items[0], number: 2, targetBranch: "release",
  }] }));
  assert.equal(readSnapshot(directory).items.length, 1);
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
    author: "opener",
    authorIsBot: false,
    hasSpamLabel: false,
    hasAdditionalInteraction: false,
    kind: number === 3 ? "pr" : "issue",
    ...(number === 3 ? { targetBranch: "main" } : {}),
    createdAt: "2020-09-15T12:00:00Z",
    closedAt: null,
    state: "OPEN",
    events: [],
    ...(legacy ? {} : { updatedAt: "2026-08-30T12:00:00Z" }),
  }));
  const manifest = {
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
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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
  assert.equal(Object.hasOwn(snapshot, "version"), false);
});

test("inclusive overlap spans pagination boundaries and unchanged timelines are reused", async (t) => {
  const options = await seedCache(t);
  const before = readSnapshot(options.directory);
  const cutoff = "2026-08-31T11:55:00.000Z";
  const calls = [];
  options.client = async (query, variables) => {
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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

test("backfills old unchanged records beyond the refresh cutoff and resumes completed metadata", async (t) => {
  const options = await seedCache(t);
  const old = readSnapshot(options.directory);
  for (const item of old.items) {
    delete item.author;
    delete item.hasAdditionalInteraction;
  }
  const snapshotPath = path.join(options.directory, "snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify(old));
  const details = [];
  let fail = true;
  options.client = async (query, variables) => {
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => ({
        ...record(Number(id.slice(3))),
        interactionItems: {
          nodes: [{ __typename: "IssueComment", author: { login: "other" } }],
          pageInfo: pageInfo(false, null),
        },
      })) };
    if (variables.ids) {
      assert.match(query, /author \{ __typename login \}/);
      assert.doesNotMatch(query, /ISSUE_COMMENT/);
      if (query.includes("... on Issue {"))
        assert.match(query, /closedByPullRequestsReferences\(first:5, includeClosedPrs:true\)/);
      details.push(...variables.ids);
      return { nodes: variables.ids.map((id) => ({
        ...record(Number(id.slice(3))), updatedAt: "2026-08-30T12:00:00Z",
      })) };
    }
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    if (kind === "issues" && variables.cursor && fail) throw new Error("rate limited");
    const number = kind === "pullRequests" ? 3 : variables.cursor ? 2 : 1;
    return response(kind, [{ ...record(number), updatedAt: "2026-08-30T12:00:00Z" }], number === 1, number === 1 ? "old-page" : null);
  };
  await assert.rejects(collect(options), /rate limited/);
  assert.deepEqual(readSnapshot(options.directory), old);
  assert.deepEqual(details.sort(), ["id-1", "id-3"]);
  details.length = 0;
  fail = false;
  const result = await collect(options);
  assert.deepEqual(details, ["id-2"]);
  assert.ok(result.items.every((item) => item.author === "opener" && item.hasAdditionalInteraction));
  assert.doesNotThrow(() => buildHistory(result));
  assert.deepEqual(readSnapshot(options.directory), result);
});

test("branch-only backfill reuses unchanged PR histories instead of refetching them", async (t) => {
  const options = await seedCache(t);
  const previous = readSnapshot(options.directory);
  delete previous.items.find((item) => item.kind === "pr").targetBranch;
  fs.writeFileSync(path.join(options.directory, "snapshot.json"), JSON.stringify(previous));
  assert.throws(() => readSnapshot(options.directory), /Missing target branch/);
  options.client = async (query, variables) => {
    assert.ok(!variables.ids, "no detailed history requests for unchanged records");
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    return response(kind, (kind === "issues" ? [1, 2] : [3]).map((number) => ({
      ...record(number), updatedAt: "2026-08-30T12:00:00Z",
    })));
  };
  const result = await collect(options);
  assert.equal(result.items.find((item) => item.kind === "pr").targetBranch, "main");
  assert.deepEqual(result.items.find((item) => item.kind === "pr").events, []);
});

test("refresh retargeting removes old PRs and includes incoming PRs, with resumable removals", async (t) => {
  const options = await seedCache(t);
  const before = readSnapshot(options.directory);
  let fail = true;
  options.client = async (query, variables) => {
    if (variables.ids) {
      assert.deepEqual(variables.ids, ["id-4"], "outgoing PR needs no details");
      return { nodes: [record(4)] };
    }
    const kind = query.includes("pullRequests(first:") ? "pullRequests" : "issues";
    if (kind === "issues") return response(kind, []);
    assert.doesNotMatch(query, /baseRefName:"main"/, "must see outgoing PRs");
    if (!variables.cursor) return response(kind, [{ ...record(3), baseRefName: "release" }], true, "next");
    if (fail) throw new Error("rate limited");
    return response(kind, [record(4)]);
  };
  await assert.rejects(collect(options), /rate limited/);
  assert.deepEqual(readSnapshot(options.directory), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.directory, "refresh.json"))).removedNumbers, [3]);
  fail = false;
  const result = await collect(options);
  assert.deepEqual(result.items.map((item) => item.number).sort(), [1, 2, 4]);
  assert.equal(result.streams.pullRequests.total, 1);
  assert.equal(result.items.find((item) => item.number === 4).targetBranch, "main");
});

test("failed refresh preserves the published snapshot and retries from the head with cached completed timelines", async (t) => {
  const options = await seedCache(t, { legacy: true });
  const before = readSnapshot(options.directory);
  let fail = true;
  const details = [];
  const listings = [];
  options.client = async (query, variables) => {
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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
    if (variables.ids && Object.hasOwn(variables, "interactionCursor"))
      return { nodes: variables.ids.map((id) => record(Number(id.slice(3)))) };
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
