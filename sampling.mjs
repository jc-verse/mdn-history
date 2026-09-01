// Self-contained for embedding in the offline report. Boundaries are normalized
// UTC milliseconds from findExtrema; counts come from events, not interpolation.
export function sampleRange(history, start, end) {
  const hour = 3600000;
  const span = end - start;
  const intervalHours =
    span <= 7 * 24 * hour ? 1 : span <= 30 * 24 * hour ? 6 : null;
  if (!intervalHours) {
    return {
      points: history.weekly,
      intervalHours,
      visibleCount: history.weekly.filter(
        (point) => point.at >= start && point.at <= end,
      ).length,
    };
  }
  const interval = intervalHours * hour;
  const times = [start];
  for (
    let at = (Math.floor(start / interval) + 1) * interval;
    at < end;
    at += interval
  )
    times.push(at);
  if (end !== start) times.push(end);

  const { timeline } = history;
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid].at <= start) low = mid + 1;
    else high = mid;
  }
  let cursor = Math.max(0, low - 1);
  const samples = times.map((at) => {
    while (cursor + 1 < timeline.length && timeline[cursor + 1].at <= at)
      cursor++;
    return { ...timeline[cursor], at };
  });
  // Keep the weekly overview outside the selection so the slider and All time
  // continue to cover the entire history when the visible plot is resampled.
  return {
    points: [
      ...history.weekly.filter((point) => point.at < start),
      ...samples,
      ...history.weekly.filter((point) => point.at > end),
    ],
    intervalHours,
    visibleCount: samples.length,
  };
}
