// Embedded in the offline HTML report alongside the tested calculations.
export function mountStatistics(history, summarize, select, react) {
  const number = (value) =>
    value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  const duration = (days) => {
    if (days === null) return "—";
    if (days < 1 / 1440) return `${number(days * 86400)} s`;
    if (days < 1 / 24) return `${number(days * 1440)} min`;
    if (days < 1) return `${number(days * 24)} h`;
    return `${number(days)} d`;
  };
  const distribution = (id, summary, color, empty) => {
    document.querySelector(`#${id}-count`).textContent =
      summary.count.toLocaleString("en-US");
    for (const key of ["min", "max", "average", "median", "q1", "q3"])
      document.querySelector(`#${id}-${key}`).textContent = duration(
        summary[key],
      );
    const bins = summary.histogram;
    const logScale = id.startsWith("duration-");
    document.querySelector(`#${id}-histogram-note`).textContent =
      summary.zeroCount
        ? `${summary.zeroCount.toLocaleString("en-US")} zero-duration closures are included in the statistics but cannot appear on a log axis.`
        : "";
    const xRange = bins.length
      ? [bins[0].start, bins.at(-1).end].map((value) =>
          logScale ? Math.log10(value) : value,
        )
      : undefined;
    react(
      `${id}-histogram`,
      [
        {
          type: "bar",
          x: bins.map((bin) => (bin.start + bin.end) / 2),
          y: bins.map((bin) => bin.count),
          width: bins.map((bin) => (bin.end - bin.start) * 0.94),
          customdata: bins.map((bin) => [
            duration(bin.start),
            duration(bin.end),
          ]),
          marker: { color },
          hovertemplate:
            "%{customdata[0]}–%{customdata[1]}<br>%{y:,d} items<extra></extra>",
        },
      ],
      {
        autosize: true,
        height: 260,
        margin: { l: 50, r: 12, t: 16, b: 55 },
        font: {
          family: "Inter, system-ui, sans-serif",
          color: "#617088",
          size: 11,
        },
        paper_bgcolor: "#ffffff",
        plot_bgcolor: "#ffffff",
        xaxis: {
          title: { text: logScale ? "Days (log scale)" : "Days" },
          ...(logScale
            ? { type: "log" }
            : { type: "linear", rangemode: "nonnegative" }),
          ...(xRange
            ? { range: xRange, autorange: false }
            : { autorange: true }),
          gridcolor: "#edf0f4",
        },
        yaxis: {
          title: { text: logScale ? "Items (log scale)" : "Items" },
          ...(logScale
            ? { type: "log" }
            : {
                type: "linear",
                rangemode: "tozero",
                dtick: Math.max(
                  1,
                  Math.ceil(Math.max(0, ...bins.map((bin) => bin.count)) / 4),
                ),
              }),
          gridcolor: "#edf0f4",
        },
        showlegend: false,
        annotations: bins.length
          ? []
          : [
              {
                text: summary.zeroCount
                  ? "No positive durations to plot"
                  : empty,
                x: 0.5,
                y: 0.5,
                xref: "paper",
                yref: "paper",
                showarrow: false,
              },
            ],
      },
      {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: "svg", filename: id },
      },
    );
  };
  // Ages describe the saved fetch and stay fixed when the selected period moves.
  distribution(
    "age-issues",
    summarize(history.analytics.openIssueAges),
    "#168273",
    "No open issues at fetch",
  );
  distribution(
    "age-prs",
    summarize(history.analytics.openPRAges),
    "#7b57b5",
    "No open PRs at fetch",
  );
  return (range) => {
    const stats = select(history.analytics, range, summarize);
    distribution(
      "duration-issues",
      stats.issues,
      "#2165d6",
      "No issues closed in this period",
    );
    distribution(
      "duration-prs",
      stats.prs,
      "#b64b25",
      "No PRs closed in this period",
    );
    const { flow } = stats;
    const signed = (value) =>
      value === null
        ? "—"
        : `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value))}`;
    for (const [id, value] of [
      ["total", flow.net],
      ["day", flow.perDay],
      ["week", flow.perWeek],
      ["month", flow.perMonth],
    ])
      document.querySelector(`#flow-${id}`).textContent = range
        ? signed(value)
        : "—";
    document.querySelector("#flow-detail").textContent = !range
      ? "This selection is outside the collected history."
      : `${flow.created.toLocaleString("en-US")} created + ${flow.reopened.toLocaleString("en-US")} reopened − ${flow.closed.toLocaleString("en-US")} closures over ${number(flow.days)} days.${flow.days === 0 ? " Average rates require a nonzero interval." : ""}`;
  };
}
