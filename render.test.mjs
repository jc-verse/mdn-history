import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { buildHistory } from "./history.mjs";
import { renderReport } from "./render.mjs";

test("offline report updates exact extrema on zoom, slider, selection, and reset", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "mdn-history-render-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = buildHistory({
    repository: "mdn/content",
    createdAt: "2026-08-01T00:00:00Z",
    asOf: "2026-08-31T12:00:00Z",
    items: [
      {
        number: 1,
        kind: "issue",
        createdAt: "2026-08-04T12:00:00Z",
        closedAt: "2026-08-04T12:00:01Z",
        events: [{ type: "ClosedEvent", at: "2026-08-04T12:00:01Z" }],
      },
      {
        number: 2,
        kind: "pr",
        createdAt: "2026-08-31T11:59:59Z",
        closedAt: null,
        events: [],
      },
    ],
  });
  const html = fs.readFileSync(renderReport(history, directory), "utf8");
  const ids = new Set(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => `#${m[1]}`),
  );
  const nodes = new Map();
  const get = (id) => {
    assert.ok(ids.has(id), `Missing report element ${id}`);
    if (!nodes.has(id))
      nodes.set(id, {
        textContent: "",
        value: "",
        addEventListener(event, handler) {
          this[event] = handler;
        },
        removeAttribute() {
          delete this.dateTime;
        },
      });
    return nodes.get(id);
  };
  const listeners = {};
  let graph;
  const restyles = [];
  const histograms = new Map();
  const histogramCalls = [];
  await vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { querySelector: get },
    Plotly: {
      react: (id, series, layout) => {
        assert.ok(ids.has(`#${id}`));
        assert.equal(series[0].type, "bar");
        histograms.set(id, { series, layout });
        histogramCalls.push(id);
      },
      relayout: (plot, changes) => {
        assert.equal(plot, graph);
        plot.layout.xaxis.range = changes["xaxis.range"];
        assert.equal(changes["xaxis.autorange"], false);
        assert.equal(changes["xaxis.rangeselector.active"], -1);
        listeners.plotly_relayout(changes);
      },
      restyle: (plot, data) => {
        assert.equal(plot, graph);
        restyles.push(data);
      },
      newPlot: async (id, series, layout) => {
        assert.equal(id, "plot");
        assert.equal(series[0].x.at(-1), "2026-08-31T12:00:00.000Z");
        for (const count of [7, 30]) {
          const preset = layout.xaxis.rangeselector.buttons.find(
            (button) => button.label === `${count} days`,
          );
          assert.equal(preset.count, count);
          assert.equal(preset.step, "day");
          assert.equal(preset.stepmode, "backward");
        }
        graph = {
          layout,
          on: (event, handler) => {
            listeners[event] = handler;
          },
        };
        return graph;
      },
    },
  });
  assert.equal(get("#openIssues-max-count").textContent, "1");
  assert.equal(get("#sample-precision").textContent, "Weekly samples");
  assert.equal(get("#openPRs-max-count").textContent, "1");
  assert.equal(get("#duration-issues-count").textContent, "1");
  assert.equal(get("#duration-issues-median").textContent, "1 s");
  assert.equal(get("#duration-prs-count").textContent, "0");
  assert.equal(get("#duration-prs-average").textContent, "—");
  assert.equal(get("#age-issues-count").textContent, "0");
  assert.equal(get("#age-prs-count").textContent, "1");
  assert.equal(get("#age-prs-median").textContent, "1 s");
  assert.equal(histograms.get("age-prs-histogram").series[0].y[0], 1);
  assert.equal(get("#flow-total").textContent, "0");
  assert.equal(histograms.get("duration-issues-histogram").series[0].y[0], 1);
  const closeAxis = histograms.get("duration-issues-histogram").layout.xaxis;
  assert.equal(closeAxis.type, "log");
  assert.equal(closeAxis.autorange, false);
  assert.equal(closeAxis.range[0], Math.log10(1 / 86400));
  const ageAxis = histograms.get("age-prs-histogram").layout.xaxis;
  assert.equal(ageAxis.type, "linear");
  assert.equal(ageAxis.range[0], 1 / 86400);
  assert.equal(
    get("#openIssues-max-time").dateTime,
    "2026-08-04T12:00:00.000Z",
  );

  graph.layout.xaxis.range = ["2026-08-04 11:59:59", "2026-08-04 12:00:01"];
  listeners.plotly_relayout({ "xaxis.range": graph.layout.xaxis.range });
  assert.equal(get("#openIssues-min-count").textContent, "0");
  assert.equal(get("#openIssues-max-count").textContent, "1");
  assert.equal(get("#openPRs-max-count").textContent, "0");
  assert.equal(get("#sample-precision").textContent, "Hourly samples");
  const hourly = restyles.at(-1);
  const hourIndex = hourly.x[0].indexOf("2026-08-04T12:00:00.000Z");
  assert.equal(
    hourly.y[0][hourIndex],
    1,
    "chart must use event counts, not weekly interpolation",
  );

  // A subsecond range without a weekly data point must still find the open item.
  listeners.plotly_selected({
    range: { x: ["2026-08-04 12:00:00.250", "2026-08-04 12:00:00.750"] },
    points: [],
  });
  assert.equal(get("#openIssues-min-count").textContent, "1");
  assert.equal(get("#duration-issues-count").textContent, "0");
  assert.equal(get("#duration-issues-min").textContent, "—");
  assert.deepEqual(
    [...histograms.get("duration-issues-histogram").series[0].y],
    [],
  );
  assert.equal(
    get("#openIssues-min-time").dateTime,
    "2026-08-04T12:00:00.250Z",
  );
  listeners.plotly_deselect();
  assert.equal(get("#openIssues-min-count").textContent, "0");

  graph.layout.xaxis.range = ["2026-08-01T12:00:00Z", history.asOf];
  listeners.plotly_relayout({ "xaxis.range": graph.layout.xaxis.range });
  assert.equal(get("#sample-precision").textContent, "6-hour samples");
  assert.equal(get("#sample-count").textContent, "121");
  const sixHour = restyles.at(-1).x[0];
  assert.ok(sixHour.includes("2026-08-02T06:00:00.000Z"));

  graph.layout.xaxis.range = ["2026-08-24T12:00:00Z", history.asOf];
  listeners.plotly_relayout({ "xaxis.range": graph.layout.xaxis.range });
  assert.equal(get("#sample-precision").textContent, "Hourly samples");
  assert.equal(get("#sample-count").textContent, "169");

  graph.layout.xaxis.range = ["2027-01-01", "2027-01-02"];
  listeners.plotly_relayout({
    "xaxis.range[0]": "2027-01-01",
    "xaxis.range[1]": "2027-01-02",
  });
  assert.equal(get("#openIssues-max-count").textContent, "—");
  assert.equal(get("#openIssues-max-time").dateTime, undefined);
  assert.match(get("#range-period").textContent, /outside/);
  assert.equal(get("#flow-day").textContent, "—");
  assert.equal(get("#duration-issues-count").textContent, "0");

  graph.layout.xaxis.range = [history.startAt, history.asOf];
  listeners.plotly_relayout({ "xaxis.autorange": true });
  assert.equal(get("#openPRs-max-count").textContent, "1");
  assert.equal(get("#openIssues-max-count").textContent, "1");
  assert.equal(get("#sample-precision").textContent, "Weekly samples");
  assert.equal(restyles.at(-1).x[0].length, history.rows.length);

  const startInput = get("#custom-range-start");
  const endInput = get("#custom-range-end");
  const error = get("#custom-range-error");
  assert.equal(startInput.value, "2026-08-01");
  assert.equal(endInput.value, "2026-08-31");
  const submit = (start, end) => {
    startInput.value = start;
    endInput.value = end;
    let prevented = false;
    get("#custom-range-form").submit({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
  };
  submit("2026-08-04", "2026-08-04");
  assert.equal(graph.layout.xaxis.range[0], "2026-08-04T00:00:00.000Z");
  assert.equal(graph.layout.xaxis.range[1], "2026-08-04T23:59:59.999Z");
  assert.equal(get("#openIssues-max-count").textContent, "1");
  assert.equal(get("#sample-precision").textContent, "Hourly samples");
  submit("2026-08-01", "2026-08-30");
  assert.equal(get("#sample-precision").textContent, "6-hour samples");
  submit("2026-08-25", "2026-08-31");
  assert.equal(
    graph.layout.xaxis.range[1],
    "2026-08-31T12:00:00.000Z",
    "end date stops at collected time",
  );
  assert.equal(get("#sample-precision").textContent, "Hourly samples");
  assert.equal(get("#openPRs-max-count").textContent, "1");
  const validRange = [...graph.layout.xaxis.range];
  for (const [start, end, message] of [
    ["", "2026-08-31", /both/],
    ["2026-02-30", "2026-08-31", /both/],
    ["2026-08-15", "2026-08-14", /on or after/],
    ["2026-07-31", "2026-08-31", /within/],
    ["2026-08-01", "2026-09-01", /within/],
  ]) {
    submit(start, end);
    assert.match(error.textContent, message);
    assert.deepEqual(
      [...graph.layout.xaxis.range],
      validRange,
      "invalid dates leave the chart unchanged",
    );
  }
  submit("2026-08-01", "2026-08-31");
  assert.equal(error.textContent, "");
  assert.equal(get("#sample-precision").textContent, "Weekly samples");
  const saved = JSON.parse(
    fs.readFileSync(path.join(directory, "history.json")),
  );
  assert.deepEqual(saved.timeline, history.timeline);
  assert.deepEqual(saved.analytics, history.analytics);
  assert.equal(get("#duration-issues-count").textContent, "1");
  assert.equal(
    histogramCalls.filter((id) => id === "age-issues-histogram").length,
    1,
    "fetch-age histogram stays fixed across selections",
  );
  assert.equal(
    histogramCalls.filter((id) => id === "age-prs-histogram").length,
    1,
  );
  assert.equal(get("#age-prs-median").textContent, "1 s");
  assert.ok(fs.existsSync(path.join(directory, "plotly.min.js")));
});
