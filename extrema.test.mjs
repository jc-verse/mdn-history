import assert from "node:assert/strict";
import test from "node:test";
import { buildHistory } from "./history.mjs";
import { findExtrema } from "./extrema.mjs";

const at = (day, time = "12:00:00") =>
  `2026-08-${String(day).padStart(2, "0")}T${time}Z`;
const ms = (day, time) => Date.parse(at(day, time));
const item = (number, kind, createdAt, events = [], closedAt = null) => ({
  number,
  title: `Item ${number}`,
  author: "opener",
  authorIsBot: false,
  hasSpamLabel: false,
  hasAdditionalInteraction: true,
  kind,
  ...(kind === "pr" ? { targetBranch: "main" } : {}),
  createdAt,
  events,
  closedAt,
});
const event = (type, day, time) => ({ type, at: at(day, time) });
const history = (items) =>
  buildHistory({
    repository: "mdn/content",
    createdAt: at(1),
    asOf: at(31),
    items,
  });

test("finds brief peaks and troughs that all weekly samples miss", () => {
  const h = history([
    item(1, "issue", at(1), [
      event("ClosedEvent", 6),
      event("ReopenedEvent", 7),
    ]),
    item(2, "issue", at(4), [event("ClosedEvent", 5)], at(5)),
    item(3, "pr", at(1)),
    item(
      4,
      "pr",
      at(8),
      [event("MergedEvent", 9), event("ClosedEvent", 9)],
      at(9),
    ),
  ]);
  assert.ok(h.rows.every((row) => row.openIssues === 1 && row.openPRs === 1));
  const result = findExtrema(h, at(3), at(10));
  assert.deepEqual(result.openIssues, {
    min: { count: 0, at: ms(6) },
    max: { count: 2, at: ms(4) },
  });
  assert.deepEqual(result.openPRs, {
    min: { count: 1, at: ms(3) },
    max: { count: 2, at: ms(8) },
  });
  // The query must not depend on even having weekly rows available.
  delete h.rows;
  assert.deepEqual(findExtrema(h, at(3), at(10)), result);
});

test("carries counts into an event-free intraday range and reports its start", () => {
  const h = history([item(1, "issue", at(1))]);
  const result = findExtrema(h, at(4, "13:15:00"), at(4, "13:16:00"));
  assert.deepEqual(result.openIssues, {
    min: { count: 1, at: ms(4, "13:15:00") },
    max: { count: 1, at: ms(4, "13:15:00") },
  });
  assert.equal(result.openPRs.max.count, 0);
});

test("includes changes exactly at either boundary and supports a single instant", () => {
  const h = history([
    item(1, "issue", at(1), [
      event("ClosedEvent", 4),
      event("ReopenedEvent", 5),
    ]),
  ]);
  assert.deepEqual(findExtrema(h, at(4), at(5)).openIssues, {
    min: { count: 0, at: ms(4) },
    max: { count: 1, at: ms(5) },
  });
  assert.deepEqual(findExtrema(h, at(4), at(4)).openIssues, {
    min: { count: 0, at: ms(4) },
    max: { count: 0, at: ms(4) },
  });
  assert.equal(findExtrema(h, ms(4) - 1, ms(4) - 1).openIssues.min.count, 1);
});

test("groups simultaneous changes without inventing a transient minimum or maximum", () => {
  const items = [
    item(1, "issue", at(1), [event("ClosedEvent", 4)], at(4)),
    item(2, "issue", at(4)),
    item(3, "pr", at(4), [event("ClosedEvent", 4)], at(4)),
  ];
  for (const order of [items, [...items].reverse()]) {
    const h = history(order);
    const result = findExtrema(h, at(3), at(5));
    assert.equal(result.openIssues.min.count, 1);
    assert.equal(result.openIssues.max.count, 1);
    assert.equal(result.openPRs.max.count, 0);
    assert.equal(new Set(h.timeline.map((p) => p.at)).size, h.timeline.length);
  }
});

test("uses closure fallbacks and excludes events and items after the snapshot", () => {
  const h = history([
    item(1, "pr", at(1), [], at(4, "13:14:15")),
    item(2, "pr", at(31, "12:00:01")),
    item(3, "issue", at(1), [event("ClosedEvent", 31, "12:00:01")]),
  ]);
  const result = findExtrema(h, at(3), at(31, "23:59:59"));
  assert.deepEqual(result.openPRs.min, { count: 0, at: ms(4, "13:14:15") });
  assert.equal(result.openIssues.min.count, 1);
  assert.equal(result.end, ms(31));
});

test("normalizes reversed ranges, parses Plotly dates as UTC, and clips to coverage", () => {
  const h = history([item(1, "issue", at(1))]);
  assert.deepEqual(
    findExtrema(h, "2026-08-04 13:15:00", "2026-08-03"),
    findExtrema(h, at(3, "00:00:00"), at(4, "13:15:00")),
  );
  assert.deepEqual(
    findExtrema(h, "2026-08-04T06:15:00-07:00", at(5)),
    findExtrema(h, at(4, "13:15:00"), at(5)),
  );
  const result = findExtrema(h, "2020-01-01", "2030-01-01");
  assert.equal(result.start, ms(1, "00:00:00"));
  assert.equal(result.end, ms(31));
  assert.equal(findExtrema(h, "2020-01-01", "2021-01-01"), null);
  assert.equal(findExtrema(h, "2027-01-01", "2028-01-01"), null);
  assert.throws(() => findExtrema(h, "invalid", at(5)), /Invalid range/);
  assert.throws(() => findExtrema(h, NaN, at(5)), /Invalid range/);
});

test("empty histories have zero extrema and tied values keep the first occurrence", () => {
  assert.equal(findExtrema(history([]), at(1), at(3)).openIssues.max.count, 0);
  const h = history([
    item(1, "issue", at(2), [
      event("ClosedEvent", 3),
      event("ReopenedEvent", 4),
    ]),
  ]);
  assert.deepEqual(findExtrema(h, at(1), at(5)).openIssues, {
    min: { count: 0, at: ms(1) },
    max: { count: 1, at: ms(2) },
  });
  assert.throws(
    () => findExtrema({ rows: h.rows, asOf: h.asOf }, at(1), at(5)),
    /Exact event history/,
  );
});
