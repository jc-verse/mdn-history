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
  kind,
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

test("time-to-close selects the latest closure per item inside the interval, including merged PRs and reopened items", () => {
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
  ]);
  const stats = select(data, 1, 4);
  assert.equal(stats.issues.count, 2);
  assert.equal(stats.issues.min, 2);
  assert.equal(stats.issues.max, 9);
  assert.equal(stats.issues.average, 5.5);
  assert.equal(
    stats.prs.count,
    2,
    "merge and close notifications count once, missing final event is supplemented",
  );
  assert.equal(stats.prs.average, 2.5);
  assert.deepEqual(stats.rankings.issue.longest.map((entry) => entry.number), [1, 2]);
  assert.deepEqual(stats.rankings.pr.shortest.map((entry) => entry.number), [4, 3]);
  assert.equal(stats.rankings.issue.longest[0].duration, 9);
  assert.equal(stats.rankings.issue.longest[0].at, base + 4 * day);
  assert.equal(select(data, 1, 1).rankings.issue.longest[0].duration, 6);
  assert.deepEqual(select(data, 2.1, 2.9).rankings.issue.longest, []);
  assert.equal(
    select(data, 1, 1).issues.average,
    6,
    "earlier selection uses its own latest closure",
  );
  assert.equal(select(data, 2.1, 2.9).issues.count, 0);
  assert.equal(
    select(data, 8, 8).issues.max,
    8,
    "closure boundaries are inclusive",
  );
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

test("current open issue ages use fetch time, original creation, and events observed after collection start", () => {
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
  assert.equal(data.analytics.ageAsOf, at(12));
  assert.deepEqual(data.analytics.openIssueAges, [11, 1, 0]);
  assert.equal(
    data.rows.at(-1).openIssues,
    1,
    "backlog chart still ends at collection start",
  );
  const savedAges = [...data.analytics.openIssueAges];
  select(data, 0, 1);
  select(data, 5, 10);
  assert.deepEqual(data.analytics.openIssueAges, savedAges);
  assert.equal(summarizeDistribution(savedAges).average, 4);
});

test("open PR ages include drafts and reopenings but exclude merged and closed PRs at fetch", () => {
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
  assert.deepEqual(data.analytics.openPRAges, [11, 8, 1]);
  assert.deepEqual(data.analytics.openIssueAges, [11]);
  assert.equal(summarizeDistribution(data.analytics.openPRAges).median, 8);
  select(data, 0, 1);
  select(data, 5, 10);
  assert.deepEqual(data.analytics.openPRAges, [11, 8, 1]);
  assert.deepEqual(history([]).analytics.openPRAges, []);
});

test("net issue rates include creations, reopenings and all actual closures, with partial-day and zero-span handling", () => {
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
  const balanced = select(data, 3, 3.5).flow;
  assert.deepEqual(balanced, {
    created: 1,
    reopened: 1,
    closed: 2,
    net: 0,
    days: 0.5,
    perDay: 0,
    perWeek: 0,
    perMonth: 0,
  });
  const falling = select(data, 3.1, 3.6).flow;
  assert.equal(falling.net, -2);
  assert.equal(falling.perDay, -4);
  assert.equal(falling.perWeek, -28);
  assert.equal(falling.perMonth, -120);
  const growing = select(data, 2.5, 3).flow;
  assert.equal(growing.net, 2);
  assert.equal(growing.perDay, 4);
  const instant = select(data, 3, 3).flow;
  assert.equal(instant.net, 2);
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
  assert.deepEqual(data.analytics.openIssueAges, []);
});
