// Embedded in the offline HTML report alongside the tested calculations.
export function mountStatistics(history, summarize, select, react) {
  const number = (value) =>
    value.toLocaleString("en-US", Number.isInteger(value)
      ? { maximumFractionDigits: 0 }
      : { maximumSignificantDigits: 4 });
  const duration = (days) => {
    if (days === null) return "—";
    if (days < 1 / 1440) return `${number(days * 86400)} s`;
    if (days < 1 / 24) return `${number(days * 1440)} min`;
    if (days < 1) return `${number(days * 24)} h`;
    return `${number(days)} d`;
  };
  const ranking = (kind, order, entries) => {
    const body = document.querySelector(`#ranking-${kind}-${order}`);
    body.replaceChildren();
    if (!entries.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "ranking-empty";
      cell.textContent = `No ${kind === "issue" ? "issues" : "PRs"} with additional interaction closed in this period.`;
      row.append(cell);
      body.append(row);
      return;
    }
    for (const [index, entry] of entries.entries()) {
      const row = document.createElement("tr");
      const rank = document.createElement("td");
      rank.textContent = String(index + 1);
      const item = document.createElement("td");
      const link = document.createElement("a");
      link.href = `https://github.com/mdn/content/${kind === "issue" ? "issues" : "pull"}/${entry.number}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `#${entry.number} · ${entry.title}`;
      item.append(link);
      const elapsed = document.createElement("td");
      elapsed.textContent = duration(entry.duration);
      elapsed.title = `${(entry.duration * 86400).toLocaleString("en-US", { maximumFractionDigits: 3 })} seconds`;
      row.append(rank, item, elapsed);
      for (const timestamp of [entry.created, entry.at]) {
        const cell = document.createElement("td");
        const time = document.createElement("time");
        time.dateTime = new Date(timestamp).toISOString();
        time.textContent = time.dateTime.slice(0, 10);
        time.title = time.dateTime.replace("T", " ").replace(/\.\d+Z$/, " UTC");
        cell.append(time);
        row.append(cell);
      }
      const author = document.createElement("td");
      author.textContent = entry.author === null ? "Unknown / deleted" : `@${entry.author}`;
      row.append(author);
      body.append(row);
    }
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
  return (range) => {
    const stats = select(history.analytics, range, summarize);
    for (const [id, summary, color, label] of [
      ["age-issues", stats.openIssueAges, "#168273", "issues"],
      ["age-prs", stats.openPRAges, "#7b57b5", "PRs"],
    ]) {
      document.querySelector(`#${id}-scope`).textContent = range
        ? `At selection end: ${new Date(range.end).toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC")}`
        : "No selection within collected history";
      distribution(id, summary, color, `No open ${label} at selection end`);
    }
    for (const kind of ["issue", "pr"])
      for (const order of ["longest", "shortest"])
        ranking(kind, order, stats.rankings[kind][order]);
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
    const signed = (value) =>
      value === null
        ? "—"
        : `${value > 0 ? "+" : value < 0 ? "−" : ""}${number(Math.abs(value))}`;
    for (const kind of ["issues", "prs"]) {
      for (const [id, key] of [
        ["total", "total"],
        ["day", "perDay"],
        ["week", "perWeek"],
        ["month", "perMonth"],
      ]) {
        for (const direction of ["opened", "closed", "net"]) {
          const value = stats.turnaround[kind][direction][key];
          document.querySelector(`#turnaround-${kind}-${direction}-${id}`).textContent =
            range && value !== null
              ? (direction === "net" ? signed(value) : number(value))
              : "—";
        }
      }
    }
  };
}
