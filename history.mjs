const DAY = 86400000;
const WEEK = 7 * DAY;

export function validateItemTitle(item) {
  if (typeof item.title !== "string" || !item.title.trim())
    throw new Error(
      `Missing title for #${item.number}. Every item must have a nonempty title.`,
    );
}

function timestamp(value) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`Invalid timestamp: ${value}`);
  return result;
}

function lifecycle(item, until) {
  if (!["issue", "pr"].includes(item.kind))
    throw new Error(`Invalid kind for #${item.number}`);
  const created = timestamp(item.createdAt);
  const events = item.events
    .map((event) => ({ type: event.type, at: timestamp(event.at) }))
    .sort((a, b) => a.at - b.at);
  // Imported timelines can omit the final closure or lag closedAt by a second.
  const fallback =
    !!item.closedAt &&
    !events.some(
      (event) =>
        ["ClosedEvent", "MergedEvent"].includes(event.type) &&
        event.at === timestamp(item.closedAt),
    );
  if (fallback) {
    events.push({ type: "ClosedEvent", at: timestamp(item.closedAt) });
    events.sort((a, b) => a.at - b.at);
  }
  const transitions = [{ at: created, type: "created", delta: 1 }];
  let open = true;
  for (const event of events) {
    if (event.at < created || event.at > until) continue;
    if (!["ClosedEvent", "MergedEvent", "ReopenedEvent"].includes(event.type))
      throw new Error(`Unknown event for #${item.number}: ${event.type}`);
    const nextOpen = event.type === "ReopenedEvent";
    // MergedEvent and ClosedEvent can describe the same transition.
    if (open !== nextOpen)
      transitions.push({
        at: event.at,
        type: nextOpen ? "reopened" : "closed",
        delta: nextOpen ? 1 : -1,
      });
    open = nextOpen;
  }
  return { created, transitions, open, fallback };
}

// Calendar dates are UTC. Prior dates are sampled at day end; today at collection start.
export function weeklySamples(start, asOf) {
  const end = timestamp(asOf);
  const startDay = Math.floor(timestamp(start) / DAY) * DAY;
  const endDay = Math.floor(end / DAY) * DAY;
  if (startDay > endDay) throw new Error("History starts after the snapshot.");
  const days = [endDay];
  for (let day = endDay - WEEK; day > startDay; day -= WEEK) days.push(day);
  if (startDay !== endDay) days.push(startDay);
  return days.reverse().map((day) => ({
    date: new Date(day).toISOString().slice(0, 10),
    at: day === endDay ? end : day + DAY - 1,
  }));
}

export function buildHistory(snapshot) {
  for (const item of snapshot.items) validateItemTitle(item);
  const asOf = timestamp(snapshot.asOf);
  const relevant = snapshot.items.filter(
    (item) => timestamp(item.createdAt) <= asOf,
  );
  const first = relevant.reduce(
    (earliest, item) => Math.min(earliest, timestamp(item.createdAt)),
    timestamp(snapshot.createdAt),
  );
  const samples = weeklySamples(new Date(first).toISOString(), snapshot.asOf);
  const changes = [];
  const analytics = {
    closures: [],
    issueActivity: [],
    openIssueAges: [],
    openPRAges: [],
    ageAsOf: snapshot.fetchedAt || snapshot.asOf,
  };
  let fallbackClosures = 0;
  for (const item of relevant) {
    const { created, transitions, fallback } = lifecycle(item, asOf);
    if (fallback) fallbackClosures++;
    for (const transition of transitions) {
      changes.push({
        at: transition.at,
        kind: item.kind,
        delta: transition.delta,
      });
      if (item.kind === "issue") analytics.issueActivity.push(transition);
      if (transition.type === "closed")
        analytics.closures.push({
          number: item.number,
          title: item.title,
          kind: item.kind,
          created,
          at: transition.at,
        });
    }
  }
  const ageAt = timestamp(analytics.ageAsOf);
  for (const item of snapshot.items) {
    if (timestamp(item.createdAt) > ageAt) continue;
    const { created, open } = lifecycle(item, ageAt);
    if (open) {
      const ages =
        item.kind === "issue" ? analytics.openIssueAges : analytics.openPRAges;
      ages.push((ageAt - created) / DAY);
    }
  }
  analytics.closures.sort((a, b) => a.at - b.at);
  analytics.issueActivity.sort((a, b) => a.at - b.at);
  changes.sort((a, b) => a.at - b.at);
  const counts = { issue: 0, pr: 0 };
  const startAt = `${samples[0].date}T00:00:00.000Z`;
  const timeline = [{ at: timestamp(startAt), openIssues: 0, openPRs: 0 }];
  let cursor = 0;
  while (cursor < changes.length) {
    const at = changes[cursor].at;
    // GitHub timestamps cannot order simultaneous changes. Apply the entire
    // group before observing counts, avoiding artificial intermediate extrema.
    do {
      const change = changes[cursor++];
      counts[change.kind] += change.delta;
    } while (cursor < changes.length && changes[cursor].at === at);
    const point = { at, openIssues: counts.issue, openPRs: counts.pr };
    if (timeline.at(-1).at === at) timeline[timeline.length - 1] = point;
    else timeline.push(point);
  }
  cursor = 0;
  const rows = samples.map(({ date, at }) => {
    while (cursor + 1 < timeline.length && timeline[cursor + 1].at <= at)
      cursor++;
    const { openIssues, openPRs } = timeline[cursor];
    return { date, openIssues, openPRs };
  });
  return {
    repository: snapshot.repository,
    asOf: snapshot.asOf,
    fetchedAt: snapshot.fetchedAt,
    firstDay: samples[0].date,
    startAt,
    items: relevant.length,
    fallbackClosures,
    rows,
    timeline,
    analytics,
  };
}
