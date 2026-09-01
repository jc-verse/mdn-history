import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { validateItemMetadata, validateItemTitle, weeklySamples } from "./history.mjs";
import { findExtrema } from "./extrema.mjs";
import { mountRangeSummary } from "./report-client.mjs";
import { sampleRange } from "./sampling.mjs";
import { summarizeDistribution, selectedStatistics } from "./statistics.mjs";
import { mountStatistics } from "./statistics-client.mjs";

export function renderReport(history, directory) {
  if (!history.timeline?.length)
    throw new Error(
      "Exact event history is required; regenerate from the snapshot.",
    );
  if (!history.analytics)
    throw new Error(
      "Item histories are required for statistics; regenerate from the snapshot.",
    );
  for (const closure of history.analytics.closures) {
    validateItemTitle(closure);
    validateItemMetadata(closure);
  }
  fs.mkdirSync(directory, { recursive: true });
  const require = createRequire(import.meta.url);
  const plotly = fs.readFileSync(require.resolve("plotly.js-dist-min"), "utf8");
  fs.writeFileSync(path.join(directory, "plotly.min.js"), plotly);
  const latest = history.rows.at(-1);
  const dates = weeklySamples(history.startAt, history.asOf).map(({ at }) =>
    new Date(at).toISOString(),
  );
  const exactHistory = {
    asOf: history.asOf,
    timeline: history.timeline,
    analytics: history.analytics,
    weekly: history.rows.map((row, i) => ({
      at: Date.parse(dates[i]),
      openIssues: row.openIssues,
      openPRs: row.openPRs,
    })),
  };
  const series = [
    {
      name: "Open issues",
      key: "openIssues",
      color: "#2165d6",
      fill: "rgba(33,101,214,0.07)",
    },
    {
      name: "Open pull requests",
      key: "openPRs",
      color: "#b64b25",
      fill: "rgba(182,75,37,0.05)",
    },
  ].map(({ name, key, color, fill }) => ({
    x: dates,
    y: history.rows.map((row) => row[key]),
    name,
    type: "scatter",
    mode: "lines",
    line: { color, width: 2.5 },
    fill: "tozeroy",
    fillcolor: fill,
    hovertemplate: `%{y:,d}<extra>${name}</extra>`,
  }));
  const layout = {
    autosize: true,
    margin: { l: 70, r: 30, t: 30, b: 80 },
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: {
      family: "Inter, system-ui, sans-serif",
      color: "#29374b",
      size: 13,
    },
    hovermode: "x unified",
    dragmode: "zoom",
    selectdirection: "h",
    hoverlabel: { bgcolor: "#ffffff", bordercolor: "#dce3eb" },
    legend: { orientation: "h", x: 0, y: 1.12 },
    xaxis: {
      type: "date",
      hoverformat: "%Y-%m-%d %H:%M UTC",
      range: [history.startAt, history.asOf],
      gridcolor: "#edf0f4",
      showgrid: false,
      rangeslider: { visible: true, thickness: 0.1, bgcolor: "#f5f7fa" },
      rangeselector: {
        x: 1,
        xanchor: "right",
        y: 1.13,
        buttons: [
          { count: 7, label: "7 days", step: "day", stepmode: "backward" },
          { count: 30, label: "30 days", step: "day", stepmode: "backward" },
          { count: 6, label: "6 months", step: "month", stepmode: "backward" },
          { count: 1, label: "1 year", step: "year", stepmode: "backward" },
          { count: 3, label: "3 years", step: "year", stepmode: "backward" },
          { label: "All time", step: "all" },
        ],
      },
    },
    yaxis: {
      title: { text: "Open items" },
      rangemode: "tozero",
      gridcolor: "#edf0f4",
      zerolinecolor: "#dce3eb",
      separatethousands: true,
    },
  };
  const config = {
    responsive: true,
    displaylogo: false,
    toImageButtonOptions: {
      format: "svg",
      filename: "mdn-content-open-history",
      width: 1400,
      height: 700,
    },
  };
  const extremaCards = [
    ["openIssues", "Open issues", "issues"],
    ["openPRs", "Open pull requests", "prs"],
  ]
    .map(
      ([key, title, color]) => `<section class="extrema-card">
<h3 class="${color}">${title}</h3><div class="extrema-values">${[
        ["min", "Minimum"],
        ["max", "Maximum"],
      ]
        .map(
          ([extremum, label]) =>
            `<div><span class="extrema-label">${label}</span><strong id="${key}-${extremum}-count">—</strong><time id="${key}-${extremum}-time"></time></div>`,
        )
        .join("")}</div></section>`,
    )
    .join("");
  const distributionCards = [
    [
      "duration-issues",
      "Issue time-to-close",
      "Closed in the selected period",
      "issues",
    ],
    [
      "duration-prs",
      "PR time-to-close",
      "Closed or merged in the selected period",
      "prs",
    ],
    [
      "age-issues",
      "Current open issue age",
      `Fixed at fetch: ${history.analytics.ageAsOf.replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
      "ages",
    ],
    [
      "age-prs",
      "Current open PR age",
      `Fixed at fetch: ${history.analytics.ageAsOf.replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
      "pr-ages",
    ],
  ]
    .map(
      ([
        id,
        title,
        scope,
        color,
      ]) => `<section class="distribution-card" aria-labelledby="${id}-title">
<h3 id="${id}-title" class="${color}">${title}</h3>
<p class="distribution-scope">${scope}<br><strong id="${id}-count">0</strong> items</p>
<dl class="distribution-values">${[
        ["min", "Min"],
        ["max", "Max"],
        ["average", "Average"],
        ["q1", "Q1"],
        ["median", "Median"],
        ["q3", "Q3"],
      ]
        .map(
          ([key, label]) =>
            `<div><dt>${label}</dt><dd id="${id}-${key}">—</dd></div>`,
        )
        .join("")}</dl>
<div id="${id}-histogram" class="histogram" role="img" aria-label="${title} histogram in days"></div>
<p id="${id}-histogram-note" class="distribution-scope"></p>
</section>`,
    )
    .join("");
  const flowPeriods = [
    ["total", "Selected period"],
    ["day", "Per day"],
    ["week", "Per week"],
    ["month", "Per 30-day month"],
  ];
  const flowCards = [
    ["flow", "Net issue change", "issues"],
    ["pr-flow", "Net PR change", "prs"],
  ].map(([id, title, color]) => `<section class="flow-card" aria-labelledby="${id}-card-title">
<h3 id="${id}-card-title" class="${color}">${title}</h3>
<dl class="flow-values">${flowPeriods.map(([period, label]) =>
    `<div><dt>${label}</dt><dd id="${id}-${period}">—</dd></div>`,
  ).join("")}</dl>
<p id="${id}-detail" class="analytics-help"></p>
</section>`).join("");
  const turnaroundCards = [
    ["issues", "Issue turnaround"],
    ["prs", "PR turnaround"],
  ].map(([kind, title]) => `<section class="flow-card" aria-labelledby="turnaround-${kind}-title">
<h3 id="turnaround-${kind}-title" class="${kind}">${title}</h3>
<table class="turnaround-table"><thead><tr><th scope="col">Time span</th><th scope="col">Opened</th><th scope="col">Closed</th></tr></thead>
<tbody>${flowPeriods.map(([period, label]) =>
    `<tr><th scope="row">${label}</th>${["opened", "closed"].map((direction) =>
      `<td id="turnaround-${kind}-${direction}-${period}">—</td>`,
    ).join("")}</tr>`,
  ).join("")}</tbody></table>
</section>`).join("");
  const rankingCards = [
    ["issue", "Issues", "issues"],
    ["pr", "PRs", "prs"],
  ]
    .flatMap(([kind, label, color]) =>
      ["longest", "shortest"].map(
        (order) => `<section class="ranking-card" aria-labelledby="ranking-${kind}-${order}-title">
<h3 id="ranking-${kind}-${order}-title" class="${color}">${label} · ${order === "longest" ? "Longest" : "Shortest"} time to close</h3>
<div class="ranking-scroll" tabindex="0" role="region" aria-labelledby="ranking-${kind}-${order}-title">
<table class="ranking-table"><thead><tr><th scope="col">Rank</th><th scope="col">${kind === "issue" ? "Issue" : "PR"}</th><th scope="col">Time to close</th><th scope="col">Created (UTC)</th><th scope="col">Closed (UTC)</th><th scope="col">Original author</th></tr></thead>
<tbody id="ranking-${kind}-${order}"></tbody></table>
</div></section>`,
      ),
    )
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mdn/content · Open issues & pull requests</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#17263b;font-family:Inter,system-ui,-apple-system,sans-serif}main{max-width:1440px;margin:0 auto;padding:44px 36px}.eyebrow{color:#617088;font-size:12px;letter-spacing:.12em;font-weight:700;text-transform:uppercase}h1{font-size:clamp(26px,3vw,40px);letter-spacing:-.04em;margin:12px 0}p{line-height:1.7;color:#617088;font-size:14px}.stats{display:flex;gap:36px;margin:28px 0}.stat{padding-right:36px;border-right:1px solid #d9e1eb}.stat:last-child{border:0}.stat strong{display:block;font-size:34px;letter-spacing:-.04em}.stat span{font-size:12px;color:#617088}.issues{color:#2165d6}.prs{color:#b64b25}.panel{background:white;border:1px solid #e0e6ef;border-radius:16px;padding:30px 10px 8px;box-shadow:0 8px 30px #26354b06}#plot{height:580px;width:100%}.footer{display:flex;justify-content:space-between;gap:24px;margin-top:18px}.footer p{margin:0;font-size:12px;max-width:1000px}a{color:#2165d6;text-decoration:none}a:hover{text-decoration:underline}.downloads{white-space:nowrap;font-size:13px;padding-top:3px}@media(max-width:700px){main{padding:24px 12px}.stats{gap:18px}.stat{padding-right:18px}.stat strong{font-size:28px}.footer{display:block}.downloads{margin-top:12px}#plot{height:480px}.panel{padding-top:40px}}
.range-summary{margin:28px 0 24px}.range-summary h2{font-size:20px;letter-spacing:-.025em;margin:0 0 6px}.range-period{font-size:13px;font-variant-numeric:tabular-nums;margin:0;color:#29374b}.range-help{max-width:1000px;font-size:12px;margin:8px 0 16px}.extrema-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.extrema-card{background:white;border:1px solid #e0e6ef;border-radius:12px;padding:20px 24px;min-width:0}.extrema-card h3{font-size:14px;margin:0 0 16px}.extrema-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.extrema-label{display:block;color:#617088;font-size:12px}.extrema-values strong{display:block;font-size:32px;letter-spacing:-.04em;margin:4px 0}.extrema-values time{display:block;font-size:11px;line-height:1.6;color:#617088;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}@media(max-width:700px){.extrema-grid{grid-template-columns:1fr}.extrema-card{padding:18px}}
.custom-range{margin:0 0 18px;background:white;border:1px solid #e0e6ef;border-radius:12px;padding:14px 20px}.custom-range summary{cursor:pointer;font-size:14px;font-weight:600;color:#2165d6}.custom-range form{display:flex;flex-wrap:wrap;align-items:end;gap:14px;margin-top:16px}.custom-range label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:#617088}.custom-range input,.custom-range button{font:inherit;font-size:14px;border:1px solid #cbd5e1;border-radius:6px;padding:9px 12px;min-height:40px}.custom-range button{background:#2165d6;color:white;border-color:#2165d6;cursor:pointer}.custom-range :focus-visible{outline:2px solid #2165d6;outline-offset:3px}.custom-range .date-help{font-size:12px;margin:12px 0 0}.custom-range .date-error{font-size:13px;color:#a52626;margin:8px 0 0}.date-error:empty{display:none}
.analytics-section{margin:28px 0}.analytics-section h2{font-size:20px;letter-spacing:-.025em;margin:0 0 8px}.analytics-help{font-size:12px;max-width:1100px;margin:0 0 16px}.distribution-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.distribution-card{background:white;border:1px solid #e0e6ef;border-radius:12px;padding:20px 16px 8px;min-width:0}.distribution-card h3{font-size:15px;margin:0 0 8px}.ages{color:#168273}.pr-ages{color:#7b57b5}.distribution-scope{font-size:11px;line-height:1.7;min-height:38px;margin:0 0 14px}.distribution-values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 10px;margin:0}.distribution-values dt{font-size:11px;color:#617088}.distribution-values dd{font-size:19px;font-weight:600;margin:4px 0 0;font-variant-numeric:tabular-nums}.histogram{height:260px;width:100%}.distribution-scope:empty{display:none}.flow-values{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:16px 0}.flow-values div{min-width:0}.flow-values dt{font-size:12px;color:#617088}.flow-values dd{font-size:24px;letter-spacing:-.03em;margin:6px 0 0;font-weight:600;font-variant-numeric:tabular-nums}@media(max-width:700px){.distribution-grid{grid-template-columns:1fr}.distribution-card{padding:20px 24px 8px}.distribution-values{grid-template-columns:repeat(3,minmax(0,1fr))}.flow-values{grid-template-columns:repeat(2,minmax(0,1fr))}}
.flow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.flow-card{background:white;border:1px solid #e0e6ef;border-radius:12px;padding:20px 24px;min-width:0}.flow-card h3{font-size:15px;margin:0 0 16px}.flow-card .analytics-help{margin:16px 0 0;line-height:1.6}.turnaround-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.turnaround-table th,.turnaround-table td{padding:12px 0;border-bottom:1px solid #edf0f4;text-align:right}.turnaround-table th{font-size:12px;color:#617088;font-weight:400}.turnaround-table th:first-child{text-align:left}.turnaround-table thead th{font-weight:600}.turnaround-table td{font-size:20px;font-weight:600}.turnaround-table tbody tr:last-child>*{border-bottom:0}@media(max-width:1100px){.flow-values{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.flow-grid{grid-template-columns:1fr}.flow-card{padding:18px}}
.ranking-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.ranking-card{background:white;border:1px solid #e0e6ef;border-radius:12px;padding:20px 16px;min-width:0}.ranking-card h3{font-size:15px;margin:0 0 16px}.ranking-scroll{overflow-x:auto}.ranking-scroll:focus-visible{outline:2px solid #2165d6;outline-offset:3px}.ranking-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}.ranking-table th,.ranking-table td{padding:10px 8px;text-align:left;border-bottom:1px solid #edf0f4}.ranking-table th{font-size:11px;font-weight:600;color:#617088}.ranking-table td:nth-child(2){white-space:normal;min-width:160px;overflow-wrap:anywhere;line-height:1.5}.ranking-table td:first-child{color:#617088}.ranking-table td:nth-child(3){font-weight:600}.ranking-table tbody tr:last-child td{border-bottom:0}.ranking-table .ranking-empty{white-space:normal;padding:24px 8px;color:#617088}@media(max-width:1000px){.ranking-grid{grid-template-columns:1fr}}
</style><script src="plotly.min.js"></script></head><body><main>
<div class="eyebrow">MDN Web Docs / Repository history</div>
<h1>Open issues & pull requests</h1>
<p>Only PRs targeting <strong>main</strong> at collection time are included throughout this report and its downloads. Other target branches are excluded from all historical counts and statistics.</p>
<p><a href="https://github.com/mdn/content">mdn/content</a> · ${history.firstDay} — ${latest.date} · <span id="sample-precision">Weekly samples</span>, UTC</p>
<div class="stats"><div class="stat"><strong class="issues">${latest.openIssues.toLocaleString("en-US")}</strong><span>open issues at snapshot</span></div><div class="stat"><strong class="prs">${latest.openPRs.toLocaleString("en-US")}</strong><span>open pull requests at snapshot</span></div><div class="stat"><strong id="sample-count">${history.rows.length}</strong><span>samples in selected period</span></div></div>
<details class="custom-range">
<summary>Custom date range</summary>
<form id="custom-range-form" aria-describedby="custom-range-help custom-range-error" novalidate>
<label for="custom-range-start">Start date (UTC)<input id="custom-range-start" name="start" type="date" min="${history.firstDay}" max="${latest.date}" required></label>
<label for="custom-range-end">End date (UTC)<input id="custom-range-end" name="end" type="date" min="${history.firstDay}" max="${latest.date}" required></label>
<button type="submit">Apply range</button>
</form>
<p id="custom-range-help" class="date-help">Includes both dates, through the latest collected time on the last day. Available: ${history.firstDay} — ${latest.date}.</p>
<p id="custom-range-error" class="date-error" role="alert"></p>
</details>
<div class="panel"><div id="plot" role="img" aria-label="Number of open issues and pull requests in mdn/content, sampled weekly, every six hours, or hourly depending on the selected range. Download the CSV for weekly values."></div></div>
<section class="range-summary" aria-labelledby="range-title">
<h2 id="range-title">Selected period</h2>
<p id="range-period" class="range-period"></p>
<p class="range-help">Drag across the graph or adjust the date slider to choose a period. Ranges of 30 days or less use 6-hour samples; 7 days or less use hourly samples. Longer ranges use weekly samples. Minimum and maximum counts use every recorded event, including changes between samples. Times show the first occurrence within the selected period, in UTC.</p>
<div class="extrema-grid" aria-live="polite" aria-atomic="true">${extremaCards}</div>
</section>
<section class="analytics-section" aria-labelledby="flow-title">
<h2 id="flow-title">Net change · selected period</h2>
<p class="analytics-help">Positive values mean the open backlog grew; negative values mean it shrank. Rates use the selected interval’s elapsed time. A week is 7 days; a month is normalized to 30 days.</p>
<div class="flow-grid">${flowCards}</div>
</section>
<section class="analytics-section" aria-labelledby="turnaround-title">
<h2 id="turnaround-title">Issue/PR turnaround · selected period</h2>
<p class="analytics-help">Opened and closed activity is shown separately, not subtracted. Opened includes creations and reopenings; closed includes PR merges. Each actual transition counts, so an item can contribute more than once, and items need not be both opened and closed in this period. Selected period shows totals; daily, weekly, and 30-day monthly averages use the interval’s elapsed time, including inactive days. Average rates require a nonzero interval.</p>
<div class="flow-grid">${turnaroundCards}</div>
</section>
<section class="analytics-section" aria-labelledby="distribution-title">
<h2 id="distribution-title">Close times & open item ages</h2>
<p class="analytics-help">Close time runs from original creation to the final closure as of the snapshot, when that closure falls within the selected period; PR merges count as closures. Only the latest status transition counts: reopened items have no closure sample, and earlier closures of reclosed items are excluded. Bot-authored and spam-labelled items are excluded from all age and duration statistics, but remain in backlog and activity counts. Open issue and PR ages run from creation to fetch time and stay fixed as you change the selection. Open draft PRs are included. Q1 and Q3 are the 25th and 75th percentiles, using linear interpolation. Time-to-close bins have equal widths in log space; age bins have equal widths in days. Axes start at the minimum plotted value. Zero-duration closures remain in the statistics and are noted separately from the log charts.</p>
<div class="distribution-grid">${distributionCards}</div>
</section>
<section class="analytics-section" aria-labelledby="rankings-title">
<h2 id="rankings-title">Top 10 longest & shortest times to close</h2>
<p class="analytics-help">Issues and PRs closed in the selected period, ranked separately by elapsed time from creation to their final closure as of the snapshot. Bot-authored and spam-labelled items are excluded, as are items whose latest status transition is a reopening. Only items with proof of additional interaction are included: a comment or submitted PR review by someone other than the original author (excluding bot accounts), a linked main-targeting PR on an issue, or a merged PR. Evidence reflects the latest collection, even if it occurred outside the selected period. Additional interaction is required only for these lists; age and duration distributions still include other age-eligible items. Each list shows up to 10 items, including zero-duration closures; ties use the lowest item number first. Hover over dates for exact UTC timestamps.</p>
<div class="ranking-grid">${rankingCards}</div>
</section>
<div class="footer"><p>Reconstructed from creation, close, reopen, and merge events in GitHub’s public API. Issues exclude pull requests; only PRs targeting main are included, and draft PRs count as open. Weekly samples use end of day UTC; intraday samples use UTC hour boundaries and selection endpoints. The latest snapshot is ${history.asOf.replace("T", " ").replace(/\.\d+Z$/, " UTC")}. Weeks are anchored to that last date, with a shorter first interval if needed. Available items include transferred history; deleted or inaccessible items and historical repository membership cannot be reconstructed. ${history.fallbackClosures ? `Final closure timestamps supplement timeline timestamps for ${history.fallbackClosures} items. ` : ""}Hover for values; drag to zoom; click a legend label to toggle a series.</p><div class="downloads"><a href="history.csv" download>Weekly CSV</a> · <a href="history.json" download>JSON</a></div></div>
<noscript><p>Enable JavaScript to view the interactive chart, or download the CSV above.</p></noscript>
</main><script>
${findExtrema.toString()}
${sampleRange.toString()}
${summarizeDistribution.toString()}
${selectedStatistics.toString()}
${mountStatistics.toString()}
${mountRangeSummary.toString()}
const reportHistory = ${JSON.stringify(exactHistory).replace(/</g, "\\u003c")};
const updateStatistics = mountStatistics(reportHistory,summarizeDistribution,selectedStatistics,Plotly.react);
Plotly.newPlot("plot",${JSON.stringify(series)},${JSON.stringify(layout)},${JSON.stringify(config)})
  .then(plot => mountRangeSummary(plot,reportHistory,findExtrema,sampleRange,Plotly.restyle,Plotly.relayout,updateStatistics));
</script></body></html>`;
  fs.writeFileSync(path.join(directory, "index.html"), html);
  fs.writeFileSync(
    path.join(directory, "history.json"),
    JSON.stringify(history, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(directory, "history.csv"),
    "date,open_issues,open_pull_requests\n" +
      history.rows
        .map((r) => `${r.date},${r.openIssues},${r.openPRs}`)
        .join("\n") +
      "\n",
  );
  return path.join(directory, "index.html");
}
