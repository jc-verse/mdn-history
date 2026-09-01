import assert from "node:assert/strict";
import test from "node:test";
import { sampleRange } from "./sampling.mjs";

const hour = 3600000;
const day = 24 * hour;
const start = Date.parse("2026-08-01T00:00:00Z");
const history = {
  timeline: [
    { at: start, openIssues: 2, openPRs: 1 },
    { at: start + hour, openIssues: 3, openPRs: 0 },
    { at: start + 6 * hour, openIssues: 1, openPRs: 2 },
  ],
  weekly: [
    { at: start, openIssues: 2, openPRs: 1 },
    { at: start + 7 * day, openIssues: 1, openPRs: 2 },
    { at: start + 40 * day, openIssues: 1, openPRs: 2 },
  ],
};

test("uses inclusive seven-day and thirty-day thresholds and restores weekly sampling for wider ranges", () => {
  assert.equal(sampleRange(history, start, start + 7 * day).intervalHours, 1);
  assert.equal(
    sampleRange(history, start, start + 7 * day + 1).intervalHours,
    6,
  );
  assert.equal(sampleRange(history, start, start + 30 * day).intervalHours, 6);
  const wider = sampleRange(history, start, start + 30 * day + 1);
  assert.equal(wider.intervalHours, null);
  assert.deepEqual(wider.points, history.weekly);
  assert.equal(wider.visibleCount, 2);
  const monthly = sampleRange(history, start, start + 30 * day);
  assert.equal(monthly.visibleCount, 121);
  assert.equal(monthly.points[1].at - monthly.points[0].at, 6 * hour);
  assert.equal(monthly.points[1].openIssues, 1);
});

test("samples carried counts at UTC hour boundaries, includes exact endpoints, and retains the full overview", () => {
  const from = start + hour / 2;
  const to = start + 6.25 * hour;
  const { points, visibleCount } = sampleRange(history, from, to);
  const visible = points.filter((point) => point.at >= from && point.at <= to);
  assert.equal(visibleCount, 8);
  assert.deepEqual(
    visible.map((point) => point.openIssues),
    [2, 3, 3, 3, 3, 3, 1, 1],
  );
  assert.deepEqual(
    visible.map((point) => point.openPRs),
    [1, 0, 0, 0, 0, 0, 2, 2],
  );
  assert.equal(visible[0].at, from);
  assert.equal(visible[1].at, start + hour);
  assert.equal(visible.at(-1).at, to);
  assert.deepEqual(points[0], history.weekly[0]);
  assert.deepEqual(points.at(-1), history.weekly.at(-1));
  assert.equal(new Set(points.map((point) => point.at)).size, points.length);
});

test("a single instant produces one sample without duplicate endpoints", () => {
  const { points, visibleCount } = sampleRange(
    history,
    start + hour,
    start + hour,
  );
  assert.equal(visibleCount, 1);
  assert.equal(points.find((point) => point.at === start + hour).openIssues, 3);
});
