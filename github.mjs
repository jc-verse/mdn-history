import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  hasItemMetadata,
  includedItem,
  validateItemMetadata,
  validateItemTitle,
} from "./history.mjs";

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
  return async (query, variables = {}, { allowMissingIssue = false } = {}) => {
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
      // A repository-scoped issue lookup returns NOT_FOUND for deleted or
      // transferred issues. Only that exact field may be treated as absent;
      // permission, rate-limit, repository and partial-response errors still fail.
      const errors = result.errors?.filter((error) => !(
        allowMissingIssue &&
        error.type === "NOT_FOUND" &&
        error.path?.length === 2 &&
        error.path[0] === "repository" && error.path[1] === "issue" &&
        result.data?.repository?.issue === null
      ));
      if (errors?.length)
        throw new Error(
          `GitHub: ${errors.map((e) => e.message).join("; ")}. Progress is saved.`,
        );
      if (!result.data) throw new Error("GitHub returned no data.");
      return result.data;
    }
  };
}

function timelineFields(kind, pageSize = 10) {
  const merged = kind === "pullRequests";
  return `timelineItems(first:${pageSize}, after:$eventCursor, itemTypes:[CLOSED_EVENT,REOPENED_EVENT${merged ? ",MERGED_EVENT" : ""}]) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on ClosedEvent { createdAt }
      ... on ReopenedEvent { createdAt }
      ${merged ? "... on MergedEvent { createdAt }" : ""}
    }
  }`;
}

function interactionFields(kind) {
  const pr = kind === "pullRequests";
  return `interactionItems: timelineItems(first:5, after:$interactionCursor, itemTypes:[ISSUE_COMMENT${pr ? ",PULL_REQUEST_REVIEW,PULL_REQUEST_REVIEW_THREAD" : ",CROSS_REFERENCED_EVENT,CONNECTED_EVENT"}]) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on IssueComment { author { __typename login } }
      ${pr ? `
      ... on PullRequestReview { author { __typename login } state }
      ... on PullRequestReviewThread { id ${reviewCommentsFields()} }
      ` : `
      ... on CrossReferencedEvent { source { __typename ... on PullRequest { baseRefName } } }
      ... on ConnectedEvent { subject { __typename ... on PullRequest { baseRefName } } }
      `}
    }
  }`;
}

function reviewCommentsFields(after = "") {
  return `comments(first:5${after}) {
    pageInfo { hasNextPage endCursor }
    nodes { author { __typename login } state }
  }`;
}

function labelFields(after = "") {
  return `labels(first:5${after}) {
    pageInfo { hasNextPage endCursor }
    nodes { name }
  }`;
}

async function hasSpamLabel(client, item, kind) {
  let labels = item.labels;
  const cursors = new Set();
  while (true) {
    if (!labels?.pageInfo || !Array.isArray(labels.nodes) ||
        labels.nodes.some((label) => typeof label?.name !== "string"))
      throw new Error("GitHub returned missing label metadata.");
    if (labels.nodes.some((label) => label.name.toLowerCase() === "spam")) return true;
    if (!labels.pageInfo.hasNextPage) return false;
    const cursor = labels.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("GitHub returned a missing or repeated label cursor.");
    cursors.add(cursor);
    const type = kind === "issues" ? "Issue" : "PullRequest";
    const data = await client(
      `query($id:ID!, $labelCursor:String) { node(id:$id) { ... on ${type} { ${labelFields(", after:$labelCursor")} } } }`,
      { id: item.id, labelCursor: cursor },
    );
    labels = data.node?.labels;
  }
}

async function hasInteraction(client, item, kind, events) {
  if (
    kind === "pullRequests" &&
    (item.state === "MERGED" ||
      events.some((event) => event.__typename === "MergedEvent"))
  )
    return true;
  if (
    kind === "issues" &&
    (item.hasLinkedMainPR || item.closedByPullRequestsReferences?.nodes?.some((pr) => pr?.baseRefName === "main") ||
      events.some((event) =>
        (event.__typename === "CrossReferencedEvent" &&
          event.source?.__typename === "PullRequest" && event.source.baseRefName === "main") ||
        (event.__typename === "ConnectedEvent" &&
          event.subject?.__typename === "PullRequest" && event.subject.baseRefName === "main"),
      ))
  )
    return true;
  // Missing/deleted identities cannot prove that two commenters differ.
  const author = item.author?.login?.toLowerCase();
  const otherAuthor = (comment) => {
    const login = comment?.author?.login?.toLowerCase();
    return !!author && !!login && login !== author &&
      comment.author.__typename !== "Bot";
  };
  if (events.some((event) =>
    (event.__typename === "IssueComment" ||
      (event.__typename === "PullRequestReview" && event.state !== "PENDING")) &&
    otherAuthor(event),
  ))
    return true;
  if (!author) return false;
  const threads = events.filter((event) => event.__typename === "PullRequestReviewThread");
  const submittedByOther = (comment) =>
    comment?.state === "SUBMITTED" && otherAuthor(comment);
  // Inspect every already-fetched thread before requesting any more replies.
  if (threads.some((thread) => thread.comments?.nodes?.some(submittedByOther)))
    return true;
  for (const thread of threads) {
    let comments = thread.comments;
    const cursors = new Set();
    while (true) {
      if (!comments?.pageInfo || !Array.isArray(comments.nodes))
        throw new Error("GitHub returned missing review comments.");
      if (comments.nodes.some(submittedByOther))
        return true;
      if (!comments.pageInfo.hasNextPage) break;
      const cursor = comments.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        throw new Error("GitHub returned a missing or repeated review comment cursor.");
      cursors.add(cursor);
      const data = await client(
        `query($id:ID!, $commentCursor:String) { node(id:$id) { ... on PullRequestReviewThread { ${reviewCommentsFields(", after:$commentCursor")} } } }`,
        { id: thread.id, commentCursor: cursor },
      );
      comments = data.node?.comments;
    }
  }
  return false;
}

async function completeInteraction(client, item, kind, events) {
  // Lifecycle pagination is independent: finding a comment never truncates
  // closure history, and later lifecycle pages never fetch more comments.
  if (await hasInteraction(client, item, kind, events)) return true;
  if (kind === "pullRequests" && !item.author?.login) return false;
  let evidence = item.interactionItems;
  const cursors = new Set();
  while (true) {
    if (!evidence?.pageInfo || !Array.isArray(evidence.nodes))
      throw new Error("GitHub returned missing interaction evidence.");
    if (await hasInteraction(client, item, kind, evidence.nodes)) return true;
    if (!evidence.pageInfo.hasNextPage) return false;
    const cursor = evidence.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub returned a missing or repeated interaction cursor.");
    cursors.add(cursor);
    const type = kind === "issues" ? "Issue" : "PullRequest";
    const data = await client(
      `query($id:ID!, $interactionCursor:String) { node(id:$id) { ... on ${type} { ${interactionFields(kind)} } } }`,
      { id: item.id, interactionCursor: cursor },
    );
    evidence = data.node?.interactionItems;
  }
}

export function pageQuery(kind, incremental = false) {
  if (!["issues", "pullRequests"].includes(kind))
    throw new Error("Invalid item kind.");
  return `query($cursor:String) {
    repository(owner:"mdn", name:"content") {
      createdAt
      ${kind}(first:100, ${kind === "pullRequests" && !incremental ? 'baseRefName:"main", ' : ""}after:$cursor, orderBy:{field:${incremental ? "UPDATED_AT,direction:DESC" : "CREATED_AT,direction:ASC"}}) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id number updatedAt state ${kind === "pullRequests" ? "baseRefName" : ""} }
      }
    }
    rateLimit { remaining resetAt }
  }`;
}

export async function completeTimeline(client, item, kind) {
  if (kind === "pullRequests" && !includedItem({ ...item, kind: "pr", targetBranch: item.baseRefName }))
    return null;
  validateItemTitle(item);
  if (item.author && typeof item.author.__typename !== "string")
    throw new Error("GitHub returned missing author account type.");
  let timeline = item.timelineItems;
  const events = [...timeline.nodes];
  while (timeline.pageInfo.hasNextPage) {
    const cursor = timeline.pageInfo.endCursor;
    const type = kind === "issues" ? "Issue" : "PullRequest";
    const data = await client(
      `query($id:ID!, $eventCursor:String) { node(id:$id) { ... on ${type} { ${timelineFields(kind, 100)} } } }`,
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
    title: item.title,
    author: item.author?.login ?? null,
    authorIsBot: item.author?.__typename === "Bot",
    hasSpamLabel: await hasSpamLabel(client, item, kind),
    hasAdditionalInteraction: await completeInteraction(client, item, kind, events),
    updatedAt: item.updatedAt,
    kind: kind === "issues" ? "issue" : "pr",
    ...(kind === "pullRequests" ? { targetBranch: item.baseRefName } : {}),
    createdAt: item.createdAt,
    closedAt: item.closedAt,
    state: item.state,
    events: events
      .filter((event) =>
        ["ClosedEvent", "ReopenedEvent", "MergedEvent"].includes(event.__typename),
      )
      .map((event) => ({ type: event.__typename, at: event.createdAt })),
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
    `query($ids:[ID!]!, $eventCursor:String) { nodes(ids:$ids) { ... on ${type} { id number title author { __typename login } ${labelFields()} createdAt updatedAt closedAt state ${kind === "issues" ? linkedPRFields() : "baseRefName"} ${timelineFields(kind)} } } }`,
    { ids: nodes.map((item) => item.id), eventCursor: null },
  );
  validateNodes(details.nodes, nodes);
  if (kind === "issues")
    for (const item of details.nodes)
      item.hasLinkedMainPR = await linkedMainPR(client, item);
  // Check cheap, conclusive evidence before requesting any comments/reviews.
  // Batch five evidence candidates for records that still need a proof.
  const pending = details.nodes.filter((item) =>
    kind === "issues"
      ? !item.hasLinkedMainPR
      : item.baseRefName === "main" && item.state !== "MERGED" && !!item.author?.login,
  );
  if (pending.length) {
    const evidence = await client(
      `query($ids:[ID!]!, $interactionCursor:String) { nodes(ids:$ids) { ... on ${type} { id ${interactionFields(kind)} } } }`,
      { ids: pending.map((item) => item.id), interactionCursor: null },
    );
    validateNodes(evidence.nodes, pending);
    for (let i = 0; i < pending.length; i++)
      pending[i].interactionItems = evidence.nodes[i].interactionItems;
  }
  return details.nodes;
}

function linkedPRFields(after = "") {
  return `closedByPullRequestsReferences(first:5, includeClosedPrs:true${after}) {
    pageInfo { hasNextPage endCursor }
    nodes { baseRefName }
  }`;
}

async function linkedMainPR(client, item) {
  let links = item.closedByPullRequestsReferences;
  const cursors = new Set();
  while (true) {
    if (!links?.pageInfo || !Array.isArray(links.nodes))
      throw new Error("GitHub returned missing linked PR information.");
    if (links.nodes.some((pr) => pr?.baseRefName === "main")) return true;
    if (!links.pageInfo.hasNextPage) return false;
    const cursor = links.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub returned a missing or repeated linked PR cursor.");
    cursors.add(cursor);
    const data = await client(
      `query($id:ID!, $linkCursor:String) { node(id:$id) { ... on Issue { ${linkedPRFields(", after:$linkCursor")} } } }`,
      { id: item.id, linkCursor: cursor },
    );
    links = data.node?.closedByPullRequestsReferences;
  }
}

function validateNodes(actual, expected) {
  if (
    !Array.isArray(actual) || actual.length !== expected.length ||
    actual.some((item, i) => !item || item.id !== expected[i].id)
  )
    throw new Error(
      "GitHub returned missing or mismatched timeline items. Rerun with --fresh.",
    );
}

async function completeItems(client, nodes, kind) {
  const items = new Array(nodes.length);
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, nodes.length) }, async () => {
      while (next < nodes.length) {
        const index = next++;
        items[index] = await completeTimeline(client, nodes[index], kind);
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return items.filter(Boolean);
}

export async function collect(options) {
  const { directory, fresh = false } = options;
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const snapshotPath = path.join(directory, "snapshot.json");
  const manifest = fs.existsSync(manifestPath) ? readJSON(manifestPath) : null;
  // Preserve legacy page caches before a refresh or full rebuild starts.
  if (!fs.existsSync(snapshotPath) && manifest?.complete)
    writeJSON(snapshotPath, readFullSnapshot(directory, { allowMissingTargetBranch: true }));
  let snapshot;
  if (
    !fresh &&
    manifest?.complete !== false &&
    (fs.existsSync(snapshotPath) || manifest?.complete)
  ) {
    snapshot = await refreshSnapshot(options, readSnapshot(directory, { allowMissingTargetBranch: true }));
  } else {
    snapshot = await collectFull(options);
  }
  // One atomic replacement publishes the entire snapshot. Failed full and
  // incremental runs leave the previous completed snapshot available offline.
  for (const item of snapshot.items) {
    validateItemTitle(item);
    validateItemMetadata(item);
  }
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
  // Older snapshots need a full listing, even for items outside the update window.
  const backfill = previous.items.some((item) => !hasItemMetadata(item));
  const refreshed = new Map(
    checkpoint.items.map((item) => [item.number, item]),
  );
  const removed = new Set(checkpoint.removedNumbers || []);
  const streams = {};
  log(
    `Refreshing GitHub history updated since ${new Date(since).toISOString()}.`,
  );
  if (backfill)
    log("Backfilling missing metadata for older cached items.");
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
        const changed = [];
        for (const item of (backfill ? page.nodes : recent)) {
          const saved = refreshed.get(item.number) || cached.get(item.number);
          if (kind === "pullRequests") {
            if (!includedItem({ kind: "pr", number: item.number, targetBranch: item.baseRefName })) {
              removed.add(item.number);
              refreshed.delete(item.number);
              continue;
            }
            removed.delete(item.number);
            // A new scalar field does not require downloading unchanged history.
            const upgraded = saved && { ...saved, targetBranch: item.baseRefName };
            if (upgraded && hasItemMetadata(upgraded) && saved.updatedAt === item.updatedAt) {
              if (saved.targetBranch !== item.baseRefName) refreshed.set(item.number, upgraded);
              continue;
            }
          }
          if (!saved || !hasItemMetadata(saved) || saved.updatedAt !== item.updatedAt)
            changed.push(item);
        }
        const details = await fetchDetails(client, changed, kind);
        if (kind === "pullRequests")
          for (const item of details)
            if (item.baseRefName !== "main") removed.add(item.number);
        const items = await completeItems(client, details, kind);
        for (const item of items) {
          removed.delete(item.number);
          refreshed.set(item.number, item);
        }
        for (const number of removed) refreshed.delete(number);
        checkpoint.items = [...refreshed.values()];
        checkpoint.removedNumbers = [...removed];
        writeJSON(checkpointPath, checkpoint);
        count += items.length;
        pages++;
        streams[kind] = { pages, count, total: page.totalCount, done: true };
        log(
          `${kind}: ${count.toLocaleString()} timelines fetched (${data.rateLimit.remaining} API points left)`,
        );
        if (
          (!backfill && recent.length < page.nodes.length) ||
          !page.pageInfo.hasNextPage
        )
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
  for (const number of removed) cached.delete(number);
  const saveReconciliation = () => {
    checkpoint.items = [...refreshed.values()];
    checkpoint.removedNumbers = [...removed];
    writeJSON(checkpointPath, checkpoint);
  };
  await reconcileOpenIssues({
    client, cached, log,
    saveItem(item) {
      cached.set(item.number, item);
      refreshed.set(item.number, item);
      removed.delete(item.number);
      saveReconciliation();
    },
    removeItem(number) {
      cached.delete(number);
      refreshed.delete(number);
      removed.add(number);
      saveReconciliation();
    },
  });
  const items = [...cached.values()].filter(includedItem);
  for (const [stream, kind] of [["issues", "issue"], ["pullRequests", "pr"]])
    streams[stream].total = items.filter((item) => item.kind === kind).length;
  return {
    repository: REPOSITORY,
    createdAt: previous.createdAt,
    asOf: checkpoint.asOf,
    fetchedAt: new Date().toISOString(),
    complete: true,
    streams,
    items,
  };
}

async function reconcileOpenIssues({ client, cached, saveItem, removeItem, log }) {
  const open = new Map();
  const cursors = new Set();
  let cursor = null;
  let pages = 0;
  // Only list open issues, with scalar fields. Timelines are fetched solely for
  // changed/new records or a missing cached issue confirmed to have closed.
  do {
    const data = await client(`query OpenIssues($cursor:String) {
      repository(owner:"mdn", name:"content") {
        issues(first:100, states:OPEN, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes { id number updatedAt state }
        }
      }
    }`, { cursor });
    const page = data.repository?.issues;
    if (!page?.pageInfo || typeof page.pageInfo.hasNextPage !== "boolean" ||
        !Array.isArray(page.nodes) || page.nodes.some((item) =>
          !item?.id || !Number.isInteger(item.number) || item.state !== "OPEN" ||
          !Number.isFinite(Date.parse(item.updatedAt))))
      throw new Error("GitHub returned invalid open-issue pagination or metadata.");
    for (const item of page.nodes) open.set(item.number, item);
    pages++;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub returned a missing or repeated open-issue cursor.");
    cursors.add(cursor);
  } while (true);

  let checked = 0;
  let removed = 0;
  let updated = 0;
  const refresh = async (nodes) => {
    const details = await fetchDetails(client, nodes, "issues");
    for (const item of await completeItems(client, details, "issues")) {
      saveItem(item);
      updated++;
    }
  };
  // Also catch reopenings/new issues seen after the ordinary update listing.
  const changed = [...open.values()].filter((item) => {
    const saved = cached.get(item.number);
    return !saved || saved.state !== "OPEN" || saved.updatedAt !== item.updatedAt;
  });
  for (let start = 0; start < changed.length; start += 100)
    await refresh(changed.slice(start, start + 100));

  for (const item of [...cached.values()]) {
    if (item.kind !== "issue" || item.state !== "OPEN" || open.has(item.number)) continue;
    // A missing list entry alone is not evidence of a transfer/deletion: it
    // might have closed, or the listing may have moved while being paginated.
    const data = await client(`query MissingOpenIssue($number:Int!) {
      repository(owner:"mdn", name:"content") {
        issue(number:$number) { id number state updatedAt repository { nameWithOwner } }
      }
    }`, { number: item.number }, { allowMissingIssue: true });
    checked++;
    if (!data.repository || !Object.hasOwn(data.repository, "issue"))
      throw new Error("GitHub returned no repository-scoped issue lookup.");
    const current = data.repository.issue;
    if (current === null) {
      removeItem(item.number);
      removed++;
      continue;
    }
    if (!current.id || !Number.isInteger(current.number) ||
        !["OPEN", "CLOSED"].includes(current.state) ||
        !Number.isFinite(Date.parse(current.updatedAt)) ||
        typeof current.repository?.nameWithOwner !== "string")
      throw new Error("GitHub returned invalid issue lookup metadata.");
    if (current.repository.nameWithOwner !== REPOSITORY) {
      removeItem(item.number);
      removed++;
    } else {
      if (current.number !== item.number)
        throw new Error("GitHub returned a mismatched issue number.");
      if (current.state !== item.state || current.updatedAt !== item.updatedAt)
        await refresh([current]);
    }
  }
  log(`Open issues: ${pages} listing pages, ${checked} missing records checked, ${updated} timelines refreshed, ${removed} departed records removed.`);
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
              kind === "pullRequests"
                ? nodes.filter((item) => includedItem({ kind: "pr", number: item.number, targetBranch: item.baseRefName }))
                : nodes,
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
          // Bound timeline pagination while keeping each saved page in item order.
          const items = await completeItems(client, page.nodes, kind);
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
          if (stream.done) stream.total = stream.count;
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

function readFullSnapshot(directory, options) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
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
  return scopeSnapshot({ ...manifest, items }, options);
}

export function readSnapshot(directory, options) {
  const snapshotPath = path.join(directory, "snapshot.json");
  if (!fs.existsSync(snapshotPath)) return readFullSnapshot(directory, options);
  const snapshot = readJSON(snapshotPath);
  if (
    snapshot.repository !== REPOSITORY ||
    !snapshot.complete ||
    !Array.isArray(snapshot.items)
  )
    throw new Error(
      "No complete snapshot. Run without --offline to finish downloading.",
    );
  return scopeSnapshot(snapshot, options);
}

function scopeSnapshot(snapshot, { allowMissingTargetBranch = false } = {}) {
  const items = snapshot.items.filter((item) =>
    (allowMissingTargetBranch && item.kind === "pr" && !item.targetBranch) || includedItem(item),
  );
  for (const item of items) validateItemTitle(item);
  return { ...snapshot, items };
}
