import assert from "node:assert/strict";
import test from "node:test";
import { buildHistory, weeklySamples } from "./history.mjs";

const at = (day, time = "12:00:00") =>
  `2026-08-${String(day).padStart(2, "0")}T${time}Z`;
const item = (number, kind, createdAt, events = [], closedAt = null) => ({
  number,
  kind,
  createdAt,
  events,
  closedAt,
});
const event = (type, day) => ({ type, at: at(day) });
const snapshot = (items, extra = {}) => ({
  repository: "mdn/content",
  createdAt: at(1),
  asOf: at(31),
  items,
  ...extra,
});

test("weekly dates end today, include the first day, and have only one partial first interval", () => {
  const samples = weeklySamples(at(1), at(31));
  assert.deepEqual(
    samples.map((s) => s.date),
    [
      "2026-08-01",
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ],
  );
  assert.equal(samples.at(-1).at, Date.parse(at(31)));
  assert.equal(samples[0].at, Date.parse(at(1, "23:59:59.999")));
  assert.equal(weeklySamples(at(31), at(31)).length, 1);
  assert.deepEqual(
    weeklySamples(at(3), at(31)).map((s) => s.date),
    samples.slice(1).map((s) => s.date),
  );
});

test("counts the backlog, including closure and reopening, rather than weekly creations", () => {
  const result = buildHistory(
    snapshot([
      item(
        1,
        "issue",
        at(1),
        [
          event("ClosedEvent", 5),
          event("ReopenedEvent", 12),
          event("ClosedEvent", 20),
        ],
        at(20),
      ),
      item(2, "issue", at(9)),
      item(
        3,
        "pr",
        at(2),
        [event("MergedEvent", 15), event("ClosedEvent", 15)],
        at(15),
      ),
      item(4, "pr", at(21)),
    ]),
  );
  assert.deepEqual(
    result.rows.map((r) => [r.openIssues, r.openPRs]),
    [
      [1, 0],
      [1, 1],
      [1, 1],
      [2, 0],
      [1, 1],
      [1, 1],
    ],
  );
  assert.equal(result.fallbackClosures, 0);
});

test("preserves reclosed periods for currently reopened items and handles duplicate merge events", () => {
  const result = buildHistory(
    snapshot([
      item(1, "pr", at(1), [
        event("ClosedEvent", 2),
        event("ReopenedEvent", 8),
        event("ClosedEvent", 12),
        event("ReopenedEvent", 20),
      ]),
    ]),
  );
  assert.deepEqual(
    result.rows.map((r) => r.openPRs),
    [1, 0, 1, 0, 1, 1],
  );
});

test("uses exact UTC boundaries and excludes changes after the snapshot", () => {
  const result = buildHistory(
    snapshot([
      item(1, "issue", at(3, "23:59:59")),
      item(2, "issue", at(4, "00:00:00")),
      item(3, "pr", at(31, "12:00:01")),
      item(
        4,
        "pr",
        at(31, "12:00:00"),
        [{ type: "ClosedEvent", at: at(31, "12:00:01") }],
        at(31, "12:00:01"),
      ),
      item(
        5,
        "issue",
        at(30),
        [{ type: "ClosedEvent", at: at(31, "12:00:00") }],
        at(31),
      ),
    ]),
  );
  assert.deepEqual(result.rows[1], {
    date: "2026-08-03",
    openIssues: 1,
    openPRs: 0,
  });
  assert.deepEqual(result.rows.at(-1), {
    date: "2026-08-31",
    openIssues: 2,
    openPRs: 1,
  });
});

test("includes older transferred records and adds missing final closure timestamps", () => {
  const result = buildHistory(
    snapshot([item(1, "issue", "2018-04-17T19:32:48Z", [], at(8))]),
  );
  assert.equal(result.firstDay, "2018-04-17");
  assert.equal(result.rows[0].openIssues, 1);
  assert.equal(result.rows.at(-1).openIssues, 0);
  assert.equal(result.fallbackClosures, 1);
});

test("an empty repository produces zeroes and malformed dates are rejected", () => {
  assert.ok(
    buildHistory(snapshot([])).rows.every(
      (r) => r.openIssues === 0 && r.openPRs === 0,
    ),
  );
  assert.throws(() => weeklySamples("invalid", at(31)), /Invalid timestamp/);
  assert.throws(() => weeklySamples(at(31), at(1)), /after/);
});
