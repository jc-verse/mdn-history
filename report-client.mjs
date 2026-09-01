// Embedded in the offline HTML report by render.mjs.
export function mountRangeSummary(
  plot,
  history,
  findExtrema,
  sampleRange,
  restyle,
  relayout,
  updateStatistics,
) {
  const form = document.querySelector("#custom-range-form");
  const startInput = document.querySelector("#custom-range-start");
  const endInput = document.querySelector("#custom-range-end");
  const error = document.querySelector("#custom-range-error");
  const formatTime = (at) =>
    new Date(at)
      .toISOString()
      .replace("T", " ")
      .replace(/\.000Z$/, "Z")
      .replace("Z", " UTC");
  let lastSamplingRange;
  const update = (range) => {
    const result = findExtrema(history, range[0], range[1]);
    document.querySelector("#range-period").textContent = result
      ? `${formatTime(result.start)} — ${formatTime(result.end)}`
      : "This selection is outside the collected history.";
    if (result) {
      startInput.value = new Date(result.start).toISOString().slice(0, 10);
      endInput.value = new Date(result.end).toISOString().slice(0, 10);
      error.textContent = "";
    }
    for (const key of ["openIssues", "openPRs"]) {
      for (const extremum of ["min", "max"]) {
        const value = result?.[key][extremum];
        document.querySelector(`#${key}-${extremum}-count`).textContent = value
          ? value.count.toLocaleString("en-US")
          : "—";
        const time = document.querySelector(`#${key}-${extremum}-time`);
        time.textContent = value ? formatTime(value.at) : "No observations";
        if (value) time.dateTime = new Date(value.at).toISOString();
        else time.removeAttribute("datetime");
      }
    }
    const samplingRange = result ? `${result.start}:${result.end}` : "outside";
    if (samplingRange === lastSamplingRange) return;
    lastSamplingRange = samplingRange;
    updateStatistics(result);
    const samples = result
      ? sampleRange(history, result.start, result.end)
      : { points: history.weekly, intervalHours: null, visibleCount: 0 };
    document.querySelector("#sample-precision").textContent =
      samples.intervalHours === 1
        ? "Hourly samples"
        : samples.intervalHours === 6
          ? "6-hour samples"
          : "Weekly samples";
    document.querySelector("#sample-count").textContent =
      samples.visibleCount.toLocaleString("en-US");
    const dates = samples.points.map((point) =>
      new Date(point.at).toISOString(),
    );
    restyle(plot, {
      x: [dates, dates],
      y: ["openIssues", "openPRs"].map((key) =>
        samples.points.map((point) => point[key]),
      ),
    });
  };
  update(plot.layout.xaxis.range);
  // Zoom, pan, range-slider drags, presets, and reset all change this range.
  plot.on("plotly_relayout", () => update(plot.layout.xaxis.range));
  // Box selection uses its continuous x range, never just selected weekly dots.
  plot.on("plotly_selected", (event) => {
    if (event?.range?.x) update(event.range.x);
  });
  plot.on("plotly_deselect", () => update(plot.layout.xaxis.range));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const dateTimestamp = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
      const at = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(at) &&
        new Date(at).toISOString().slice(0, 10) === value
        ? at
        : NaN;
    };
    const start = dateTimestamp(startInput.value);
    const end = dateTimestamp(endInput.value);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      error.textContent = "Enter both a start date and an end date.";
      return;
    }
    if (start > end) {
      error.textContent = "The end date must be on or after the start date.";
      return;
    }
    const earliest = history.timeline[0].at;
    const latest = Date.parse(history.asOf);
    if (start < Math.floor(earliest / 86400000) * 86400000 || end > latest) {
      error.textContent = "Choose dates within the collected history.";
      return;
    }
    error.textContent = "";
    // Date inputs include the entire end day, clipped to the actual snapshot.
    relayout(plot, {
      "xaxis.range": [
        new Date(Math.max(start, earliest)).toISOString(),
        new Date(Math.min(end + 86400000 - 1, latest)).toISOString(),
      ],
      "xaxis.autorange": false,
      "xaxis.rangeselector.active": -1,
    });
  });
}
