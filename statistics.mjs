// Self-contained functions embedded in the offline report. Durations are days.
export function summarizeDistribution(values, { logarithmic = false } = {}) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Durations must be finite and nonnegative.");
  const count = sorted.length;
  if (!count)
    return {
      count: 0,
      min: null,
      max: null,
      average: null,
      median: null,
      q1: null,
      q3: null,
      histogram: [],
    };
  // Inclusive, linearly interpolated quantiles (rank = (n - 1) * p).
  const quantile = (p) => {
    const rank = (count - 1) * p;
    const low = Math.floor(rank);
    return sorted[low] + (sorted[Math.ceil(rank)] - sorted[low]) * (rank - low);
  };
  const min = sorted[0];
  const max = sorted.at(-1);
  // Equal widths on a log axis require geometric edges in the original units.
  // Zero durations remain in the summary and are disclosed beside the chart.
  const plotted = logarithmic ? sorted.filter((value) => value > 0) : sorted;
  const histogram = [];
  if (plotted.length) {
    const transform = logarithmic ? Math.log10 : (value) => value;
    const inverse = logarithmic ? (value) => 10 ** value : (value) => value;
    const low = transform(plotted[0]);
    const high = transform(plotted.at(-1));
    const bins =
      low === high ? 1 : Math.min(40, Math.ceil(Math.sqrt(plotted.length)));
    const width =
      low === high
        ? logarithmic
          ? 0.1
          : Math.max(1 / 86400, plotted[0] * 0.01)
        : (high - low) / bins;
    for (let i = 0; i < bins; i++) {
      histogram.push({
        start: i === 0 ? plotted[0] : inverse(low + i * width),
        end:
          i === bins - 1 && low !== high
            ? plotted.at(-1)
            : inverse(low + (i + 1) * width),
        count: 0,
      });
    }
    for (const value of plotted)
      histogram[
        Math.min(
          bins - 1,
          Math.max(0, Math.floor((transform(value) - low) / width)),
        )
      ].count++;
  }
  return {
    count,
    min,
    max,
    average: sorted.reduce((sum, value) => sum + value, 0) / count,
    median: quantile(0.5),
    q1: quantile(0.25),
    q3: quantile(0.75),
    histogram,
    ...(logarithmic ? { zeroCount: count - plotted.length } : {}),
  };
}

export function selectedStatistics(analytics, range, summarize) {
  const latestClosures = new Map();
  if (range) {
    for (const closure of analytics.closures) {
      if (closure.at > range.end) break;
      if (closure.at >= range.start)
        latestClosures.set(closure.number, closure);
    }
  }
  const durations = { issue: [], pr: [] };
  const ranked = { issue: [], pr: [] };
  for (const closure of latestClosures.values()) {
    const duration = (closure.at - closure.created) / 86400000;
    durations[closure.kind].push(duration);
    if (closure.hasAdditionalInteraction === true)
      ranked[closure.kind].push({ ...closure, duration });
  }
  const rankings = {};
  for (const kind of ["issue", "pr"]) {
    // Break duration ties by item number in both directions for stable lists.
    rankings[kind] = {
      shortest: [...ranked[kind]]
        .sort((a, b) => a.duration - b.duration || a.number - b.number)
        .slice(0, 10),
      longest: ranked[kind]
        .sort((a, b) => b.duration - a.duration || a.number - b.number)
        .slice(0, 10),
    };
  }
  const days = range ? (range.end - range.start) / 86400000 : 0;
  const rates = (total) => {
    const perDay = days > 0 ? total / days : null;
    return {
      total,
      perDay,
      perWeek: perDay === null ? null : perDay * 7,
      perMonth: perDay === null ? null : perDay * 30,
    };
  };
  const summarizeFlow = (activity) => {
    let created = 0;
    let reopened = 0;
    let closed = 0;
    if (range) {
      for (const event of activity) {
        if (event.at > range.end) break;
        if (event.at < range.start) continue;
        if (event.type === "created") created++;
        else if (event.type === "reopened") reopened++;
        else if (event.type === "closed") closed++;
      }
    }
    const { total: net, ...netRates } = rates(created + reopened - closed);
    return { created, reopened, closed, net, days, ...netRates };
  };
  const flow = summarizeFlow(analytics.issueActivity);
  const prFlow = summarizeFlow(analytics.prActivity);
  const turnaround = (flow) => ({
    opened: rates(flow.created + flow.reopened),
    closed: rates(flow.closed),
  });
  return {
    issues: summarize(durations.issue, { logarithmic: true }),
    prs: summarize(durations.pr, { logarithmic: true }),
    rankings,
    flow,
    prFlow,
    turnaround: {
      issues: turnaround(flow),
      prs: turnaround(prFlow),
    },
  };
}
