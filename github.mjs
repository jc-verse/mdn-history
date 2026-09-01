import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REPOSITORY = "mdn/content";
const ENDPOINT = "https://api.github.com/graphql";

export function githubToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "GitHub GraphQL requires authentication. Run gh auth login, or set GH_TOKEN / GITHUB_TOKEN. Only public repository data is read.",
    );
  }
}

export function createClient(token, fetcher = fetch) {
  return async (query, variables = {}) => {
    // Never print or persist the token, request headers, or full response bodies.
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "mdn-content-history",
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        if (attempt === 3)
          throw new Error(
            "Cannot reach api.github.com. Progress is saved; rerun to resume.",
          );
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** attempt),
        );
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** attempt),
        );
        continue;
      }
      if (!response.ok) {
        const reset = response.headers.get("x-ratelimit-reset");
        const retry = response.headers.get("retry-after");
        throw new Error(
          `GitHub HTTP ${response.status}. ${reset ? `Rate limit resets ${new Date(Number(reset) * 1000).toISOString()}. ` : ""}${retry ? `Retry after ${retry} seconds. ` : ""}Progress is saved; rerun to resume.`,
        );
      }
      let result;
      try {
        result = await response.json();
      } catch {
        if (attempt === 3)
          throw new Error(
            "GitHub response was interrupted. Progress is saved; rerun to resume.",
          );
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** attempt),
        );
        continue;
      }
      if (result.errors?.length)
        throw new Error(
          `GitHub: ${result.errors.map((e) => e.message).join("; ")}. Progress is saved.`,
        );
      if (!result.data) throw new Error("GitHub returned no data.");
      return result.data;
    }
  };
}

function timelineFields(kind) {
  const merged = kind === "pullRequests";
  return `timelineItems(first:10, after:$eventCursor, itemTypes:[CLOSED_EVENT,REOPENED_EVENT${merged ? ",MERGED_EVENT" : ""}]) {
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on ClosedEvent { createdAt } ... on ReopenedEvent { createdAt } ${merged ? "... on MergedEvent { createdAt }" : ""} }
  }`;
}

export function pageQuery(kind, incremental = false) {
  if (!["issues", "pullRequests"].includes(kind))
    throw new Error("Invalid item kind.");
  return `query($cursor:String) {
    repository(owner:"mdn", name:"content") {
      createdAt
      ${kind}(first:100, after:$cursor, orderBy:{field:${incremental ? "UPDATED_AT,direction:DESC" : "CREATED_AT,direction:ASC"}}) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id number updatedAt }
      }
    }
    rateLimit { remaining resetAt }
  }`;
}

export async function completeTimeline(client, item, kind) {
  let timeline = item.timelineItems;
  const events = [...timeline.nodes];
  while (timeline.pageInfo.hasNextPage) {
    const cursor = timeline.pageInfo.endCursor;
    const type = kind === "issues" ? "Issue" : "PullRequest";
    const data = await client(
      `query($id:ID!, $eventCursor:String) { node(id:$id) { ... on ${type} { ${timelineFields(kind)} } } }`,
      { id: item.id, eventCursor: cursor },
    );
    if (!data.node)
      throw new Error(
        `Item #${item.number} disappeared during collection. Rerun with --fresh.`,
      );
    timeline = data.node.timelineItems;
    if (timeline.pageInfo.hasNextPage && timeline.pageInfo.endCursor === cursor)
      throw new Error("GitHub returned a repeated timeline cursor.");
    events.push(...timeline.nodes);
  }
  return {
    number: item.number,
    updatedAt: item.updatedAt,
    kind: kind === "issues" ? "issue" : "pr",
    createdAt: item.createdAt,
    closedAt: item.closedAt,
    state: item.state,
    events: events.map((event) => ({
      type: event.__typename,
      at: event.createdAt,
    })),
  };
}

function writeJSON(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchDetails(client, nodes, kind) {
  if (!nodes.length) return [];
  const type = kind === "issues" ? "Issue" : "PullRequest";
  const details = await client(
    `query($ids:[ID!]!, $eventCursor:String) { nodes(ids:$ids) { ... on ${type} { id number createdAt updatedAt closedAt state ${timelineFields(kind)} } } }`,
    { ids: nodes.map((item) => item.id), eventCursor: null },
  );
  if (
    details.nodes.length !== nodes.length ||
    details.nodes.some((item, i) => !item || item.id !== nodes[i].id)
  )
    throw new Error(
      "GitHub returned missing or mismatched timeline items. Rerun with --fresh.",
    );
  return details.nodes;
}

export async function collect(options) {
  const { directory, fresh = false } = options;
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const snapshotPath = path.join(directory, "snapshot.json");
  const manifest = fs.existsSync(manifestPath) ? readJSON(manifestPath) : null;
  // Preserve legacy page caches before a refresh or full rebuild starts.
  if (!fs.existsSync(snapshotPath) && manifest?.complete)
    writeJSON(snapshotPath, readFullSnapshot(directory));
  let snapshot;
  if (
    !fresh &&
    manifest?.complete !== false &&
    (fs.existsSync(snapshotPath) || manifest?.complete)
  ) {
    snapshot = await refreshSnapshot(options, readSnapshot(directory));
  } else {
    snapshot = await collectFull(options);
  }
  // One atomic replacement publishes the entire snapshot. Failed full and
  // incremental runs leave the previous completed snapshot available offline.
  writeJSON(snapshotPath, snapshot);
  fs.rmSync(path.join(directory, "refresh.json"), { force: true });
  return snapshot;
}

async function refreshSnapshot(
  { directory, client, log = console.log, now = new Date() },
  previous,
) {
  const checkpointPath = path.join(directory, "refresh.json");
  let checkpoint = fs.existsSync(checkpointPath)
    ? readJSON(checkpointPath)
    : null;
  if (
    !checkpoint ||
    checkpoint.baseAsOf !== previous.asOf ||
    checkpoint.asOf.slice(0, 10) !== now.toISOString().slice(0, 10)
  ) {
    checkpoint = {
      baseAsOf: previous.asOf,
      asOf: now.toISOString(),
      items: [],
    };
  }
  // Use collection START, not completion, and overlap the boundary to cover
  // timestamp precision and updates made while the previous fetch was running.
  const since = Date.parse(previous.asOf) - 5 * 60 * 1000;
  const cached = new Map(previous.items.map((item) => [item.number, item]));
  const refreshed = new Map(
    checkpoint.items.map((item) => [item.number, item]),
  );
  const streams = {};
  log(
    `Refreshing GitHub history updated since ${new Date(since).toISOString()}.`,
  );
  const results = await Promise.allSettled(
    ["issues", "pullRequests"].map(async (kind) => {
      let cursor = null;
      const cursors = new Set();
      let count = 0;
      let pages = 0;
      // Updated-order cursors move when records change. On retry, restart the
      // cheap listing from the head and reuse completed, unchanged timelines.
      while (true) {
        const data = await client(pageQuery(kind, true), { cursor });
        const page = data.repository?.[kind];
        if (!page?.pageInfo)
          throw new Error("GitHub returned no pagination information.");
        if (
          page.nodes.some(
            (item) => !item || !Number.isFinite(Date.parse(item.updatedAt)),
          )
        )
          throw new Error(
            "GitHub returned an unavailable item or update timestamp.",
          );
        const recent = page.nodes.filter(
          (item) => Date.parse(item.updatedAt) >= since,
        );
        const changed = recent.filter((item) => {
          const saved = refreshed.get(item.number) || cached.get(item.number);
          return !saved || saved.updatedAt !== item.updatedAt;
        });
        const details = await fetchDetails(client, changed, kind);
        const items = [];
        for (const item of details)
          items.push(await completeTimeline(client, item, kind));
        for (const item of items) refreshed.set(item.number, item);
        checkpoint.items = [...refreshed.values()];
        writeJSON(checkpointPath, checkpoint);
        count += items.length;
        pages++;
        streams[kind] = { pages, count, total: page.totalCount, done: true };
        log(
          `${kind}: ${count.toLocaleString()} timelines fetched (${data.rateLimit.remaining} API points left)`,
        );
        if (recent.length < page.nodes.length || !page.pageInfo.hasNextPage)
          break;
        const next = page.pageInfo.endCursor;
        if (!next || cursors.has(next))
          throw new Error("GitHub returned a missing or repeated page cursor.");
        cursors.add(next);
        cursor = next;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  for (const item of refreshed.values()) cached.set(item.number, item);
  return {
    version: 2,
    repository: REPOSITORY,
    createdAt: previous.createdAt,
    asOf: checkpoint.asOf,
    fetchedAt: new Date().toISOString(),
    complete: true,
    streams,
    items: [...cached.values()],
  };
}

async function collectFull({
  directory,
  client,
  fresh = false,
  log = console.log,
  now = new Date(),
  batchSize = 4,
}) {
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  let manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;
  // Resume incomplete downloads from today. A normal run always refreshes a completed download.
  if (
    fresh ||
    !manifest ||
    manifest.complete ||
    manifest.asOf.slice(0, 10) !== now.toISOString().slice(0, 10)
  ) {
    manifest = {
      version: 1,
      repository: REPOSITORY,
      asOf: now.toISOString(),
      complete: false,
      streams: Object.fromEntries(
        ["issues", "pullRequests"].map((kind) => [
          kind,
          { pages: 0, cursor: null, done: false, count: 0 },
        ]),
      ),
    };
    writeJSON(manifestPath, manifest);
  }
  log(`Fetching public GitHub history, snapshot ${manifest.asOf}.`);
  const results = await Promise.allSettled(
    Object.entries(manifest.streams).map(async ([kind, stream]) => {
      while (!stream.done) {
        // List IDs cheaply, then fetch timelines in bounded parallel batches.
        // Commit in order so every checkpoint is contiguous.
        const batch = [];
        let nextCursor = stream.cursor;
        while (batch.length < batchSize) {
          const data = await client(pageQuery(kind), { cursor: nextCursor });
          const info = data.repository?.[kind]?.pageInfo;
          if (!info)
            throw new Error("GitHub returned no pagination information.");
          batch.push({ cursor: nextCursor, data });
          if (!info.hasNextPage) break;
          if (
            !info.endCursor ||
            batch.some((entry) => entry.cursor === info.endCursor)
          )
            throw new Error(
              "GitHub returned a missing or repeated page cursor.",
            );
          nextCursor = info.endCursor;
        }
        const pages = await Promise.all(
          batch.map(async ({ cursor, data }) => {
            const nodes = data.repository[kind].nodes;
            if (nodes.some((item) => !item))
              throw new Error("GitHub returned an unavailable item.");
            data.repository[kind].nodes = await fetchDetails(
              client,
              nodes,
              kind,
            );
            return { cursor, data };
          }),
        );
        for (const { cursor, data } of pages) {
          if (cursor !== stream.cursor)
            throw new Error(
              "GitHub pagination changed during collection. Rerun with --fresh.",
            );
          if (!data.repository)
            throw new Error(
              "Repository mdn/content was not returned by GitHub.",
            );
          manifest.createdAt = data.repository.createdAt;
          const page = data.repository[kind];
          const items = [];
          // Usually one event per item; only unusually active timelines need extra requests.
          for (const item of page.nodes) {
            if (!item)
              throw new Error(
                "GitHub returned an unavailable item. Rerun with --fresh.",
              );
            items.push(await completeTimeline(client, item, kind));
          }
          if (
            page.pageInfo.hasNextPage &&
            (!page.pageInfo.endCursor ||
              page.pageInfo.endCursor === stream.cursor)
          )
            throw new Error(
              "GitHub returned a missing or repeated page cursor.",
            );
          writeJSON(
            path.join(directory, `${kind}-${stream.pages}.json`),
            items,
          );
          stream.pages++;
          stream.count += items.length;
          stream.cursor = page.pageInfo.endCursor;
          stream.done = !page.pageInfo.hasNextPage;
          stream.total = page.totalCount;
          writeJSON(manifestPath, manifest);
          log(
            `${kind}: ${stream.count.toLocaleString()} / ${stream.total.toLocaleString()} (${data.rateLimit.remaining} API points left)`,
          );
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  manifest.complete = true;
  manifest.fetchedAt = new Date().toISOString();
  writeJSON(manifestPath, manifest);
  return readFullSnapshot(directory);
}

function readFullSnapshot(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    manifest.repository !== REPOSITORY ||
    !manifest.complete
  )
    throw new Error(
      "No complete snapshot. Run without --offline to finish downloading.",
    );
  const items = [];
  const numbers = new Set();
  for (const [kind, stream] of Object.entries(manifest.streams)) {
    for (let page = 0; page < stream.pages; page++) {
      for (const item of JSON.parse(
        fs.readFileSync(path.join(directory, `${kind}-${page}.json`), "utf8"),
      )) {
        if (numbers.has(item.number))
          throw new Error(`Duplicate #${item.number}; rerun with --fresh.`);
        numbers.add(item.number);
        items.push(item);
      }
    }
  }
  return { ...manifest, items };
}

export function readSnapshot(directory) {
  const snapshotPath = path.join(directory, "snapshot.json");
  if (!fs.existsSync(snapshotPath)) return readFullSnapshot(directory);
  const snapshot = readJSON(snapshotPath);
  if (
    ![1, 2].includes(snapshot.version) ||
    snapshot.repository !== REPOSITORY ||
    !snapshot.complete ||
    !Array.isArray(snapshot.items)
  )
    throw new Error(
      "No complete snapshot. Run without --offline to finish downloading.",
    );
  return snapshot;
}
