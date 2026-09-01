// Self-contained so the generated report can embed the same tested calculation
// and work directly from disk, without module imports or fetching JSON.
export function findExtrema(history, from, to) {
  const timestamp = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") throw new Error("Invalid range timestamp");
    // Plotly date-axis ranges omit a timezone. Interpret those strings as UTC,
    // consistently with the source events, regardless of the browser's zone.
    let iso = value.trim().replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00";
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
    const at = Date.parse(iso);
    if (!Number.isFinite(at))
      throw new Error(`Invalid range timestamp: ${value}`);
    return at;
  };
  const { timeline } = history;
  if (!Array.isArray(timeline) || !timeline.length)
    throw new Error("Exact event history is required; regenerate the report.");
  const a = timestamp(from);
  const b = timestamp(to);
  const start = Math.max(Math.min(a, b), timeline[0].at);
  const end = Math.min(Math.max(a, b), timestamp(history.asOf));
  if (start > end) return null;

  // Find the state carried into the inclusive left boundary. A selection can
  // contain no events (or no weekly sample) and still have a valid open count.
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid].at <= start) low = mid + 1;
    else high = mid;
  }
  const initial = timeline[low - 1];
  const result = { start, end };
  for (const key of ["openIssues", "openPRs"]) {
    result[key] = {
      min: { count: initial[key], at: start },
      max: { count: initial[key], at: start },
    };
  }
  for (let i = low; i < timeline.length && timeline[i].at <= end; i++) {
    const point = timeline[i];
    for (const key of ["openIssues", "openPRs"]) {
      if (point[key] < result[key].min.count)
        result[key].min = { count: point[key], at: point.at };
      if (point[key] > result[key].max.count)
        result[key].max = { count: point[key], at: point.at };
    }
  }
  return result;
}
