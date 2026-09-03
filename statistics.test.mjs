import assert from "node:assert/strict";
import test from "node:test";
import { buildHistory } from "./history.mjs";
import { summarizeDistribution, selectedStatistics } from "./statistics.mjs";

const day = 86400000;
const base = Date.parse("2026-08-01T00:00:00Z");
const at = (days) => new Date(base + days * day).toISOString();
const event = (type, days) => ({ type, at: at(days) });
const item = (number, kind, created, events = [], closed = null) => ({
  number,
  title: `Item ${number}`,
  author: "opener",
  authorIsBot: false,
  hasSpamLabel: false,
  hasAdditionalInteraction: true,
  kind,
  ...(kind === "pr" ? { targetBranch: "main" } : {}),
  createdAt: at(created),
  events,
  closedAt: closed === null ? null : at(closed),
});
const history = (items, asOf = 10, fetchedAt = asOf) =>
  buildHistory({
    repository: "mdn/content",
    createdAt: at(0),
    asOf: at(asOf),
    fetchedAt: at(fetchedAt),
    items,
  });
const select = (data, from, to) =>
  selectedStatistics(
    data.analytics,
    from === null
      ? null
      : {
          start: base + from * day,
          end: base + to * day,
        },
    summarizeDistribution,
  );

test("duration summaries use interpolated quartiles and histograms conserve all samples including extrema", () => {
  const stats = summarizeDistribution([4, 1, 3, 2]);
  assert.deepEqual(
    { ...stats, histogram: undefined },
    {
      count: 4,
      min: 1,
      max: 4,
      average: 2.5,
      median: 2.5,
      q1: 1.75,
      q3: 3.25,
      histogram: undefined,
    },
  );
  assert.deepEqual(
    stats.histogram.map((bin) => bin.count),
    [2, 2],
  );
  const skewed = summarizeDistribution([0, 0, 0.1, 1, 2, 1000]);
  assert.equal(
    skewed.histogram.reduce((sum, bin) => sum + bin.count, 0),
    6,
  );
  assert.equal(skewed.histogram.at(-1).count, 1);
  assert.equal(summarizeDistribution([0, 5, 10]).median, 5);
  for (const values of [[0], [2, 2, 2]]) {
    const equal = summarizeDistribution(values);
    assert.equal(equal.histogram.length, 1);
    assert.ok(equal.histogram[0].end > equal.histogram[0].start);
    for (const key of ["min", "max", "average", "median", "q1", "q3"])
      assert.equal(equal[key], values[0]);
  }
  const empty = summarizeDistribution([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.average, null);
  assert.equal(empty.q1, null);
  assert.deepEqual(empty.histogram, []);
  assert.throws(() => summarizeDistribution([-1]), /nonnegative/);
  assert.throws(() => summarizeDistribution([NaN]), /finite/);
});

test("time-to-close uses only the latest status change, excluding reopened items and superseded closures", () => {
  const data = history([
    item(1, "issue", -5, [
      event("ClosedEvent", 1),
      event("ReopenedEvent", 2),
      event("ClosedEvent", 4),
      event("ReopenedEvent", 5),
    ]),
    item(2, "issue", 1, [event("ClosedEvent", 3)], 3),
    item(3, "pr", 0, [event("MergedEvent", 3), event("ClosedEvent", 3)], 3),
    item(4, "pr", 2, [], 4),
    item(5, "issue", 0, [event("ClosedEvent", 8)], 8),
    item(6, "issue", 0, [event("ClosedEvent", 2), event("ReopenedEvent", 3), event("ClosedEvent", 7)], 7),
    item(7, "pr", 0, [event("ClosedEvent", 1), event("ReopenedEvent", 2), event("MergedEvent", 6)], 6),
    item(8, "pr", 0, [event("ClosedEvent", 1), event("ReopenedEvent", 2)]),
  ]);
  const stats = select(data, 1, 4);
  assert.equal(stats.issues.count, 1);
  assert.equal(stats.issues.min, 2);
  assert.equal(stats.issues.max, 2);
  assert.equal(stats.issues.average, 2);
  assert.equal(
    stats.prs.count,
    2,
    "merge and close notifications count once, missing final event is supplemented",
  );
  assert.equal(stats.prs.average, 2.5);
  assert.deepEqual(stats.rankings.issue.longest.map((entry) => entry.number), [2]);
  assert.deepEqual(stats.rankings.pr.shortest.map((entry) => entry.number), [4, 3]);
  assert.equal(stats.rankings.issue.longest[0].duration, 2);
  assert.equal(stats.rankings.issue.longest[0].at, base + 3 * day);
  assert.deepEqual(select(data, 1, 1).rankings.issue.longest, []);
  assert.deepEqual(select(data, 2, 2).rankings.issue.longest, [], "a later closure replaces earlier closures even outside the selection");
  assert.equal(select(data, 7, 7).issues.average, 7);
  assert.equal(select(data, 6, 6).prs.average, 6);
  assert.equal(select(data, 1, 1).prs.count, 0);
  assert.ok(data.analytics.closures.every((closure) => closure.number !== 8));
  assert.equal(stats.flow.closed, 1, "turnaround uses the same final-closure rule as durations");
  assert.deepEqual(select(data, 2.1, 2.9).rankings.issue.longest, []);
  assert.equal(
    select(data, 1, 1).issues.average,
    null,
    "a reopened item cannot contribute an earlier closure",
  );
  assert.equal(select(data, 2.1, 2.9).issues.count, 0);
  assert.equal(
    select(data, 8, 8).issues.max,
    8,
    "closure boundaries are inclusive",
  );
});

test("bot-authored and spam-labelled items are excluded from all ages but retained in volume and flow", () => {
  const items = ["issue", "pr"].flatMap((kind, i) => {
    const n = i * 10;
    return [
      item(n + 1, kind, 0, [event("ClosedEvent", 3)], 3),
      { ...item(n + 2, kind, 0, [event("ClosedEvent", 4)], 4), authorIsBot: true },
      { ...item(n + 3, kind, 0, [event("ClosedEvent", 5)], 5), hasSpamLabel: true },
      item(n + 4, kind, 2),
      { ...item(n + 5, kind, 0), authorIsBot: true },
      { ...item(n + 6, kind, 0), hasSpamLabel: true },
    ];
  });
  const data = history(items);
  const stats = select(data, 0, 10);
  assert.deepEqual(stats.openIssueAges, summarizeDistribution([8]));
  assert.deepEqual(stats.openPRAges, summarizeDistribution([8]));
  assert.deepEqual(select(data, 0, 2).openIssueAges, summarizeDistribution([2, 0]));
  assert.deepEqual(select(data, 0, 2).openPRAges, summarizeDistribution([2, 0]));
  assert.equal(data.items, 12);
  assert.equal(data.rows.at(-1).openIssues, 3);
  assert.equal(data.rows.at(-1).openPRs, 3);
  for (const [kind, offset] of [["issue", 0], ["pr", 10]]) {
    const summary = stats[kind === "issue" ? "issues" : "prs"];
    assert.equal(summary.count, 1);
    assert.equal(summary.average, 3);
    assert.deepEqual(stats.rankings[kind].shortest.map((entry) => entry.number), [offset + 1]);
    assert.deepEqual(stats.rankings[kind].longest.map((entry) => entry.number), [offset + 1]);
    const flow = kind === "issue" ? stats.flow : stats.prFlow;
    assert.equal(flow.created, 6);
    assert.equal(flow.closed, 3);
  }
});

test("ages use scraped state and final closure even when items change during collection", () => {
  for (const kind of ["issue", "pr"]) {
    const data = history([
      { ...item(1, kind, 0, [event("ClosedEvent", 2), event("ReopenedEvent", 11)]), state: "OPEN" },
      { ...item(2, kind, 0, [event("ClosedEvent", 2), event("ReopenedEvent", 3), event("ClosedEvent", 11)], 11), state: "CLOSED" },
      // The scraped state and closedAt also cover incomplete imported timelines.
      { ...item(3, kind, 1, [event("ClosedEvent", 4)]), state: "OPEN" },
      { ...item(4, kind, 1, [event("ClosedEvent", 5)], 5 + 1 / 86400), state: kind === "pr" ? "MERGED" : "CLOSED" },
      { ...item(5, kind, 11, [], 11.5), state: "CLOSED" },
    ], 10, 12);
    assert.deepEqual(select(data, 0, 12)[kind === "issue" ? "openIssueAges" : "openPRAges"], summarizeDistribution([12, 11]));
    assert.deepEqual(data.analytics.closures.map(({ number }) => number), [4, 2, 5]);
    const summaryKey = kind === "issue" ? "issues" : "prs";
    assert.equal(select(data, 2, 2)[summaryKey].count, 0, "superseded closures are excluded from earlier selections");
    assert.equal(select(data, 0, 10)[summaryKey].count, 1);
    assert.equal(select(data, 11, 11)[summaryKey].average, 11);
    assert.equal(select(data, 11.5, 11.5)[summaryKey].average, 0.5);
    assert.equal(data.analytics.closures[0].at, base + 5 * day + 1000);
  }
});

test("closure rankings cap each list at ten and sort zero durations and ties deterministically", () => {
  const items = [];
  for (const kind of ["issue", "pr"])
    for (let i = 12; i >= 0; i--)
      items.push(item(i + (kind === "pr" ? 100 : 1), kind, 0,
        [event(kind === "pr" ? "MergedEvent" : "ClosedEvent", Math.floor(i / 2))]));
  const data = history(items);
  const original = structuredClone(data.analytics);
  const stats = select(data, 0, 10);
  for (const [kind, offset] of [["issue", 1], ["pr", 100]]) {
    const { shortest, longest } = stats.rankings[kind];
    assert.deepEqual(shortest.map((entry) => entry.number),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i + offset));
    assert.deepEqual(longest.map((entry) => entry.number),
      [12, 10, 11, 8, 9, 6, 7, 4, 5, 2].map((i) => i + offset));
    assert.equal(shortest[0].duration, 0);
    assert.equal(longest[0].duration, 6);
    assert.deepEqual(select(data, null).rankings[kind], { shortest: [], longest: [] });
  }
  assert.deepEqual(data.analytics, original, "ranking must not reorder the shared event history");
});

test("all four rankings exclude unengaged items before taking ten without filtering other statistics", () => {
  const items = [];
  for (const [kind, offset] of [["issue", 0], ["pr", 100]]) {
    for (let i = 0; i < 24; i++) items.push({
      ...item(offset + i, kind, 0, [event("ClosedEvent", i / 3)]),
      author: i === 1 ? null : "original-author",
      hasAdditionalInteraction: i % 2 === 1,
    });
  }
  const data = history(items);
  const stats = select(data, 0, 10);
  assert.equal(stats.issues.count, 24);
  assert.equal(stats.prs.count, 24);
  assert.equal(stats.flow.closed, 24);
  assert.equal(data.items, 48);
  for (const [kind, offset] of [["issue", 0], ["pr", 100]]) {
    assert.deepEqual(stats.rankings[kind].shortest.map((entry) => entry.number),
      Array.from({ length: 10 }, (_, i) => offset + i * 2 + 1));
    assert.deepEqual(stats.rankings[kind].longest.map((entry) => entry.number),
      Array.from({ length: 10 }, (_, i) => offset + 23 - i * 2));
    assert.equal(stats.rankings[kind].longest[0].author, "original-author");
    assert.equal(stats.rankings[kind].shortest[0].author, null);
    const unengagedOnly = select(data, 0, 0);
    assert.deepEqual(unengagedOnly.rankings[kind], { shortest: [], longest: [] });
    assert.equal(unengagedOnly[kind === "issue" ? "issues" : "prs"].count, 1);
  }
});

test("log histograms use equal logarithmic widths and start at the smallest positive observation", () => {
  const values = [1, 2, 5, 10, 20, 50, 100, 200, 1000];
  const stats = summarizeDistribution(values, { logarithmic: true });
  assert.equal(stats.histogram[0].start, 1);
  assert.equal(stats.histogram.at(-1).end, 1000);
  assert.deepEqual(
    stats.histogram.map((bin) => bin.count),
    [3, 3, 3],
  );
  for (const bin of stats.histogram) {
    assert.ok(
      Math.abs(Math.log10(bin.end) - Math.log10(bin.start) - 1) < 1e-12,
    );
    // Bar edges after the existing gap are also equally spaced on the log axis.
    const center = (bin.start + bin.end) / 2;
    const halfWidth = ((bin.end - bin.start) * 0.94) / 2;
    const visibleWidth =
      Math.log10(center + halfWidth) - Math.log10(center - halfWidth);
    assert.ok(Math.abs(visibleWidth - Math.log10(9.73 / 1.27)) < 1e-12);
  }
  const linear = summarizeDistribution(values);
  for (const key of ["count", "min", "max", "average", "median", "q1", "q3"])
    assert.equal(
      stats[key],
      linear[key],
      "scaling must not change summary statistics",
    );
  const single = summarizeDistribution([0.25], { logarithmic: true });
  assert.equal(single.histogram[0].start, 0.25);
  assert.ok(single.histogram[0].end > 0.25);
});

test("log histograms disclose zero durations without shifting them to invented positive values", () => {
  const stats = summarizeDistribution([0, 0, 1, 10], { logarithmic: true });
  assert.equal(stats.count, 4);
  assert.equal(stats.min, 0);
  assert.equal(stats.zeroCount, 2);
  assert.equal(stats.histogram[0].start, 1);
  assert.equal(
    stats.histogram.reduce((sum, bin) => sum + bin.count, 0) + stats.zeroCount,
    stats.count,
  );
  const zero = summarizeDistribution([0, 0], { logarithmic: true });
  assert.equal(zero.average, 0);
  assert.equal(zero.zeroCount, 2);
  assert.deepEqual(zero.histogram, []);
  assert.deepEqual(
    summarizeDistribution([], { logarithmic: true }).histogram,
    [],
  );
});

test("open issue ages use the right boundary and original creation, including items closed later", () => {
  const data = history(
    [
      item(1, "issue", 0, [event("ClosedEvent", 11)], 11),
      item(2, "issue", 1, [
        event("ClosedEvent", 2),
        event("ReopenedEvent", 11),
      ]),
      item(3, "issue", 11),
      item(4, "pr", 0),
      item(5, "issue", 12),
      item(6, "issue", 13),
    ],
    10,
    12,
  );
  assert.deepEqual(select(data, 0, 12).openIssueAges, summarizeDistribution([11, 1, 0]));
  assert.equal(
    data.rows.at(-1).openIssues,
    1,
    "backlog chart still ends at collection start",
  );
  assert.deepEqual(select(data, 0, 1).openIssueAges, summarizeDistribution([1, 0]));
  assert.deepEqual(select(data, 5, 10).openIssueAges, summarizeDistribution([10, 9]));
  assert.deepEqual(select(data, 10, 10).openIssueAges, select(data, 0, 10).openIssueAges,
    "the left boundary never limits the age population");
  assert.deepEqual(select(data, 11, 11).openIssueAges, summarizeDistribution([10, 0]),
    "creation is inclusive and final closure is exclusive at the right boundary");
  assert.deepEqual(select(data, 0, 0).openIssueAges, summarizeDistribution([0]));
  assert.deepEqual(select(data, null).openIssueAges, summarizeDistribution([]));
});

test("open PR ages update at the selection end, including drafts and ignoring intermediate closures", () => {
  const data = history(
    [
      { ...item(1, "pr", 1), isDraft: true },
      item(
        2,
        "pr",
        2,
        [event("MergedEvent", 11), event("ClosedEvent", 11)],
        11,
      ),
      item(3, "pr", 3, [event("ClosedEvent", 9)], 9),
      item(4, "pr", 4, [event("ClosedEvent", 5), event("ReopenedEvent", 11)]),
      item(5, "pr", 11),
      item(6, "pr", 13),
      item(7, "issue", 1),
    ],
    10,
    12,
  );
  assert.deepEqual(select(data, 0, 12).openPRAges, summarizeDistribution([11, 8, 1]));
  assert.deepEqual(select(data, 0, 12).openIssueAges, summarizeDistribution([11]));
  assert.deepEqual(select(data, 0, 1).openPRAges, summarizeDistribution([0]));
  assert.deepEqual(select(data, 5, 10).openPRAges, summarizeDistribution([9, 8, 6]));
  assert.deepEqual(select(data, 5, 8).openPRAges, summarizeDistribution([7, 6, 5, 4]));
  assert.deepEqual(select(data, 0, 11).openPRAges, summarizeDistribution([10, 7, 0]));
  assert.deepEqual(select(history([]), 0, 10).openPRAges, summarizeDistribution([]));
});

test("turnaround ignores reopenings and superseded closures across selections for issues and PRs", () => {
  for (const kind of ["issue", "pr"]) {
    const data = history([
      { ...item(1, kind, 0, [
        event("ClosedEvent", 2), event("ReopenedEvent", 3),
        event("ClosedEvent", 4), event("ReopenedEvent", 11),
      ]), state: "OPEN" },
      { ...item(2, kind, 0, [
        event("ClosedEvent", 2), event("ReopenedEvent", 3),
        event("ClosedEvent", 11),
      ], 11), state: kind === "pr" ? "MERGED" : "CLOSED" },
    ], 10, 12);
    const key = kind === "issue" ? "issues" : "prs";
    for (const [start, end] of [[2, 2], [3, 3], [2, 10]]) {
      const stats = select(data, start, end).turnaround[key];
      assert.equal(stats.opened.total, 0, "reopening never counts as opening");
      assert.equal(stats.closed.total, 0, "only the final closure at fetch counts");
      assert.equal(stats.net.total, 0);
    }
    assert.equal(select(data, 0, 0).turnaround[key].opened.total, 2);
    const final = select(data, 11, 11).turnaround[key];
    assert.equal(final.opened.total, 0);
    assert.equal(final.closed.total, 1);
    assert.equal(final.net.total, -1);
    assert.equal(select(data, 0, 12).turnaround[key].opened.total, 2);
    assert.equal(data.timeline.at(-1)[kind === "issue" ? "openIssues" : "openPRs"], 1,
      "historical backlog still uses real transitions up to collection start");
  }
});

test("net issue rates count original creations and final closures, with partial-day and zero-span handling", () => {
  const data = history([
    item(
      1,
      "issue",
      0,
      [
        event("ClosedEvent", 2),
        event("ReopenedEvent", 3),
        event("ClosedEvent", 3.5),
      ],
      3.5,
    ),
    item(2, "issue", 3),
    item(3, "issue", 0, [event("ClosedEvent", 3.5)], 3.5),
    item(4, "pr", 3),
  ]);
  const selected = select(data, 3, 3.5).flow;
  assert.deepEqual(selected, {
    created: 1,
    closed: 2,
    net: -1,
    days: 0.5,
    perDay: -2,
    perWeek: -14,
    perMonth: -60,
  });
  const falling = select(data, 3.1, 3.6).flow;
  assert.equal(falling.net, -2);
  assert.equal(falling.perDay, -4);
  assert.equal(falling.perWeek, -28);
  assert.equal(falling.perMonth, -120);
  const growing = select(data, 2.5, 3).flow;
  assert.equal(growing.net, 1);
  assert.equal(growing.perDay, 2);
  const instant = select(data, 3, 3).flow;
  assert.equal(instant.net, 1);
  assert.equal(instant.perDay, null);
  assert.equal(instant.perMonth, null);
  assert.equal(select(data, 5, 6).flow.perDay, 0);
  const outside = select(data, null);
  assert.equal(outside.flow.perDay, null);
  assert.equal(outside.issues.count, 0);
  assert.equal(select(data, 0, 10).flow.net, data.rows.at(-1).openIssues);
});

test("empty histories and closures after the selected snapshot do not manufacture statistics", () => {
  const empty = select(history([]), 0, 10);
  assert.equal(empty.issues.average, null);
  assert.equal(empty.prs.count, 0);
  assert.equal(empty.flow.perDay, 0);
  const data = history(
    [item(1, "issue", 0, [event("ClosedEvent", 11)], 11)],
    10,
    12,
  );
  assert.equal(select(data, 0, 10).issues.count, 0);
  assert.deepEqual(select(data, 0, 10).openIssueAges, summarizeDistribution([10]));
});

test("PR net change and turnaround count original creations and final closures across all four spans", () => {
  const data = history([
    item(1, "pr", 0, [
      event("ClosedEvent", 1),
      event("ReopenedEvent", 3),
      event("MergedEvent", 3.5),
      event("ClosedEvent", 3.5),
    ], 3.5),
    { ...item(2, "pr", 3), isDraft: true, hasAdditionalInteraction: false },
    item(3, "pr", 0, [], 3.5),
    item(4, "issue", 3, [event("ClosedEvent", 3.5)], 3.5),
    item(5, "pr", 4, [event("ClosedEvent", 11)], 11),
  ]);
  const stats = select(data, 3, 3.5);
  assert.deepEqual(stats.prFlow, {
    created: 1, closed: 2, net: -1, days: 0.5,
    perDay: -2, perWeek: -14, perMonth: -60,
  });
  assert.deepEqual(stats.turnaround, {
    issues: {
      opened: { total: 1, perDay: 2, perWeek: 14, perMonth: 60 },
      closed: { total: 1, perDay: 2, perWeek: 14, perMonth: 60 },
      net: { total: 0, perDay: 0, perWeek: 0, perMonth: 0 },
    },
    prs: {
      opened: { total: 1, perDay: 2, perWeek: 14, perMonth: 60 },
      closed: { total: 2, perDay: 4, perWeek: 28, perMonth: 120 },
      net: { total: -1, perDay: -2, perWeek: -14, perMonth: -60 },
    },
  });
  const falling = select(data, 3.1, 3.6);
  assert.equal(falling.prFlow.net, -2);
  assert.equal(falling.prFlow.perDay, -4);
  assert.equal(falling.prFlow.perWeek, -28);
  assert.equal(falling.prFlow.perMonth, -120);
  assert.equal(falling.turnaround.prs.opened.total, 0);
  assert.equal(falling.turnaround.prs.closed.total, 2);
  assert.deepEqual(falling.turnaround.prs.net, {
    total: -2, perDay: -4, perWeek: -28, perMonth: -120,
  });
  const instant = select(data, 3, 3);
  assert.equal(instant.prFlow.net, 1);
  assert.equal(instant.turnaround.prs.opened.total, 1);
  assert.equal(instant.turnaround.prs.opened.perDay, null);
  assert.equal(instant.turnaround.prs.net.total, 1);
  assert.equal(instant.turnaround.prs.net.perDay, null);
  assert.equal(instant.turnaround.issues.closed.perMonth, null);
  assert.equal(select(data, null).prFlow.perWeek, null);
  assert.equal(select(data, null).turnaround.prs.closed.perDay, null);
  const quiet = select(data, 5, 6);
  assert.equal(quiet.prFlow.perDay, 0);
  assert.equal(quiet.turnaround.prs.opened.perMonth, 0);
  assert.equal(quiet.turnaround.prs.closed.perMonth, 0);
  const full = select(data, 0, 10);
  assert.equal(full.prFlow.net, data.rows.at(-1).openPRs);
  assert.equal(full.prFlow.closed, 2, "only final closures count; duplicate merges and future events do not");
  assert.equal(full.turnaround.prs.opened.perDay, 0.4, "inactive days contribute to the denominator");
});
