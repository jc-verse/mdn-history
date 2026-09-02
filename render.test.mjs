import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { buildHistory } from "./history.mjs";
import { renderReport } from "./render.mjs";
import { mountRangeSummary } from "./report-client.mjs";
import { findExtrema } from "./extrema.mjs";
import { sampleRange } from "./sampling.mjs";

test("y-axis fits visible lines on zoom, pan, reset, and legend changes", () => {
  const point = (date, openIssues, openPRs = 20) => ({
    at: Date.parse(date), openIssues, openPRs,
  });
  const points = [
    point("2026-06-01", 1000),
    point("2026-07-01", 100),
    point("2026-08-01", 110),
    point("2026-08-31", 120),
  ];
  const history = { timeline: points, weekly: points, asOf: "2026-08-31" };
  const nodes = new Map();
  const listeners = {};
  const plot = {
    data: [{}, {}],
    layout: { xaxis: { range: ["2026-06-01", history.asOf] }, yaxis: {} },
    on(event, handler) { listeners[event] = handler; },
  };
  let relayoutCount = 0;
  // Use the same self-contained client as the generated offline report.
  const mount = vm.runInNewContext(`(${mountRangeSummary.toString()})`, {
    document: {
      querySelector(id) {
        if (!nodes.has(id)) nodes.set(id, {
          addEventListener() {}, removeAttribute() {},
        });
        return nodes.get(id);
      },
    },
  });
  mount(plot, history, findExtrema, sampleRange, () => {}, (_, changes) => {
    assert.ok(++relayoutCount < 30, "axis updates must not cause a relayout loop");
    plot.layout.yaxis.range = changes["yaxis.range"];
    plot.layout.yaxis.autorange = changes["yaxis.autorange"];
    listeners.plotly_relayout?.(changes);
  }, () => {});
  const axis = () => [...plot.layout.yaxis.range];
  const zoom = (start, end) => {
    plot.layout.xaxis.range = [start, end];
    listeners.plotly_relayout({ "xaxis.range": [start, end] });
  };
  const show = (index, visible) => {
    plot.data[index].visible = visible;
    listeners.plotly_restyle([{ visible: [visible] }, [index]]);
  };
  assert.deepEqual(axis(), [0, 1049]);
  zoom("2026-07-01", "2026-08-31");
  assert.deepEqual(axis(), [15, 125], "off-screen peak must not determine the scale");
  show(1, "legendonly");
  assert.deepEqual(axis(), [99, 121], "hidden PRs must not force the axis toward zero");

  zoom("2026-06-30", "2026-08-02");
  assert.deepEqual(axis(), [98.5, 131.5], "include interpolated values at viewport edges");
  zoom("2026-07-01T06:00:00Z", "2026-07-31T18:00:00Z");
  assert.ok(Math.abs(axis()[0] - (99 + 2.5 / 31)) < 1e-9);
  assert.ok(Math.abs(axis()[1] - (111 - 2.5 / 31)) < 1e-9,
    "a viewport between weekly samples must fit the line crossing it");
  zoom("2026-07-02", "2026-07-03");
  assert.deepEqual(axis(), [99, 101], "constant intraday counts need a nonzero range");
  show(0, false);
  assert.deepEqual(axis(), [0, 1], "all-hidden data needs a finite fallback");
  show(1, true);
  assert.deepEqual(axis(), [19, 21]);
  show(0, true);
  assert.deepEqual(axis(), [16, 104]);
  zoom("2026-08-02", "2026-08-03");
  assert.deepEqual(axis(), [15.5, 114.5], "panning should refit the axis");

  listeners.plotly_selected({ range: { x: ["2026-06-01", "2026-06-02"] } });
  assert.ok(Math.abs(axis()[1] - 115.2) < 1e-9,
    "box selection must fit the viewport, not the selected period");
  zoom("2027-01-01", "2027-01-02");
  assert.deepEqual(axis(), [0, 1]);
  plot.layout.xaxis.range = ["2026-06-01", history.asOf];
  plot.layout.yaxis.autorange = true;
  listeners.plotly_relayout({ "xaxis.autorange": true, "yaxis.autorange": true });
  assert.deepEqual(axis(), [0, 1049], "reset restores the full-history scale");
  plot.layout.yaxis.range = [0, 5000];
  plot.layout.yaxis.autorange = true;
  listeners.plotly_relayout({ "yaxis.autorange": true });
  assert.deepEqual(axis(), [0, 1049], "autoscale refits even when the date range is unchanged");
});

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
        author: "opener",
        authorIsBot: false,
        hasSpamLabel: false,
        hasAdditionalInteraction: true,
        title: 'Fix </script><img src=x onerror=alert(1)> & "examples"',
        kind: "issue",
        createdAt: "2026-08-04T12:00:00Z",
        closedAt: "2026-08-04T12:00:01Z",
        events: [{ type: "ClosedEvent", at: "2026-08-04T12:00:01Z" }],
      },
      {
        number: 2,
        author: null,
        authorIsBot: false,
        hasSpamLabel: false,
        hasAdditionalInteraction: false,
        title: "Update documentation",
        kind: "pr",
        targetBranch: "main",
        createdAt: "2026-08-31T11:59:59Z",
        closedAt: null,
        events: [],
      },
    ],
  });
  const html = fs.readFileSync(renderReport(history, directory), "utf8");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["index.html", "plotly.min.js"]);
  assert.doesNotMatch(html, /(?:href|src)=["']history\.(json|csv)["']/i);
  assert.ok(!html.includes('</script><img'), "titles must not break out of the embedded script");
  const ids = new Set(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => `#${m[1]}`),
  );
  const nodes = new Map();
  const createElement = (tagName) => ({
    tagName,
    textContent: "",
    children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const get = (id) => {
    assert.ok(ids.has(id), `Missing report element ${id}`);
    if (!nodes.has(id))
      nodes.set(id, {
        ...createElement("div"),
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
    document: { querySelector: get, createElement },
    Plotly: {
      react: (id, series, layout) => {
        assert.ok(ids.has(`#${id}`));
        assert.equal(series[0].type, "bar");
        histograms.set(id, { series, layout });
        histogramCalls.push(id);
      },
      relayout: (plot, changes) => {
        assert.equal(plot, graph);
        if ("xaxis.range" in changes) {
          plot.layout.xaxis.range = changes["xaxis.range"];
          assert.equal(changes["xaxis.autorange"], false);
          assert.equal(changes["xaxis.rangeselector.active"], -1);
        }
        if ("yaxis.range" in changes) {
          plot.layout.yaxis.range = changes["yaxis.range"];
          plot.layout.yaxis.autorange = changes["yaxis.autorange"];
        }
        listeners.plotly_relayout?.(changes);
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
          data: series,
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
  const issueRanking = get("#ranking-issue-longest").children;
  assert.equal(issueRanking.length, 1);
  assert.equal(issueRanking[0].children[1].children[0].textContent, '#1 · Fix </script><img src=x onerror=alert(1)> & "examples"');
  assert.equal(issueRanking[0].children[1].children[0].href, "https://github.com/mdn/content/issues/1");
  assert.equal(issueRanking[0].children[1].children[0].target, "_blank");
  assert.equal(issueRanking[0].children[1].children[0].rel, "noopener noreferrer");
  assert.equal(issueRanking[0].children[2].textContent, "1 s");
  assert.equal(issueRanking[0].children[4].children[0].dateTime, "2026-08-04T12:00:01.000Z");
  assert.equal(issueRanking[0].children[5].textContent, "@opener");
  assert.equal(get("#ranking-pr-shortest").children[0].children[0].textContent, "No PRs with additional interaction closed in this period.");
  assert.equal(get("#duration-prs-count").textContent, "0");
  assert.equal(get("#duration-prs-average").textContent, "—");
  assert.equal(get("#age-issues-count").textContent, "0");
  assert.equal(get("#age-prs-count").textContent, "1");
  assert.equal(get("#age-prs-median").textContent, "1 s");
  assert.equal(histograms.get("age-prs-histogram").series[0].y[0], 1);
  assert.equal(get("#flow-total").textContent, "0");
  assert.equal(get("#pr-flow-total").textContent, "+1");
  assert.equal(get("#turnaround-issues-opened-total").textContent, "1");
  assert.equal(get("#turnaround-issues-closed-total").textContent, "1");
  assert.equal(get("#turnaround-prs-opened-total").textContent, "1");
  assert.equal(get("#turnaround-prs-closed-total").textContent, "0");
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
  assert.equal(get("#ranking-issue-longest").children[0].children[0].textContent, "No issues with additional interaction closed in this period.");
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
  assert.equal(get("#flow-total").textContent, "0");
  assert.equal(get("#pr-flow-week").textContent, "+1");
  assert.equal(get("#turnaround-issues-opened-total").textContent, "0");
  assert.equal(get("#turnaround-issues-closed-total").textContent, "0");
  assert.equal(get("#turnaround-prs-opened-week").textContent, "1");
  assert.equal(get("#turnaround-prs-opened-month").textContent, "4.286");
  assert.equal(get("#turnaround-prs-closed-day").textContent, "0");

  listeners.plotly_selected({
    range: { x: ["2026-08-31T11:59:59Z", "2026-08-31T11:59:59Z"] },
    points: [],
  });
  assert.equal(get("#pr-flow-total").textContent, "+1");
  assert.equal(get("#pr-flow-day").textContent, "—");
  assert.equal(get("#turnaround-prs-opened-total").textContent, "1");
  assert.equal(get("#turnaround-prs-opened-day").textContent, "—");
  assert.equal(get("#turnaround-issues-closed-month").textContent, "—");
  assert.match(get("#pr-flow-detail").textContent, /nonzero interval/);
  listeners.plotly_deselect();
  assert.equal(get("#pr-flow-week").textContent, "+1");

  graph.layout.xaxis.range = ["2027-01-01", "2027-01-02"];
  listeners.plotly_relayout({
    "xaxis.range[0]": "2027-01-01",
    "xaxis.range[1]": "2027-01-02",
  });
  assert.equal(get("#openIssues-max-count").textContent, "—");
  assert.equal(get("#openIssues-max-time").dateTime, undefined);
  assert.match(get("#range-period").textContent, /outside/);
  assert.equal(get("#flow-day").textContent, "—");
  for (const period of ["total", "day", "week", "month"]) {
    assert.equal(get(`#pr-flow-${period}`).textContent, "—");
    for (const kind of ["issues", "prs"])
      for (const direction of ["opened", "closed"])
        assert.equal(get(`#turnaround-${kind}-${direction}-${period}`).textContent, "—");
  }
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
  assert.equal(get("#pr-flow-total").textContent, "+1");
  assert.equal(get("#turnaround-prs-opened-total").textContent, "1");
  assert.equal(get("#turnaround-issues-closed-total").textContent, "0");
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
  submit("2026-08-05", "2026-08-05");
  assert.deepEqual([...graph.layout.yaxis.range], [0, 1],
    "a custom date range with only zero counts must exclude off-screen peaks");
  submit("2026-08-01", "2026-08-31");
  assert.deepEqual([...graph.layout.yaxis.range], [0, 2]);
  const saved = JSON.parse(html.match(/const reportHistory = (.+);\n/)[1]);
  assert.deepEqual(saved.timeline, history.timeline);
  assert.deepEqual(saved.analytics, history.analytics);
  assert.equal(get("#duration-issues-count").textContent, "1");
  assert.equal(get("#ranking-issue-shortest").children[0].children[1].children[0].textContent, '#1 · Fix </script><img src=x onerror=alert(1)> & "examples"');
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
  for (const name of ["history.json", "history.csv"])
    fs.writeFileSync(path.join(directory, name), "stale export");
  renderReport(history, directory);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["index.html", "plotly.min.js"], "regeneration removes stale exports from the published bundle");
});
