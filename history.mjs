const DAY = 86400000;
const WEEK = 7 * DAY;

export function validateItemTitle(item) {
  if (typeof item.title !== "string" || !item.title.trim())
    throw new Error(
      `Missing title for #${item.number}. Every item must have a nonempty title.`,
    );
}

export function hasItemMetadata(item) {
  return (
    (item.author === null ||
      (typeof item.author === "string" && !!item.author.trim())) &&
    typeof item.hasAdditionalInteraction === "boolean" &&
    typeof item.authorIsBot === "boolean" &&
    typeof item.hasSpamLabel === "boolean" &&
    (item.kind !== "pr" || (typeof item.targetBranch === "string" && !!item.targetBranch))
  );
}

export function validateItemMetadata(item) {
  if (!hasItemMetadata(item))
    throw new Error(
      `Missing author, interaction, bot/spam, or target branch metadata for #${item.number}. Run without --offline to backfill; use --fresh if the item is no longer accessible.`,
    );
}

export function includedItem(item) {
  if (item.kind !== "pr") return true;
  if (typeof item.targetBranch !== "string" || !item.targetBranch)
    throw new Error(`Missing target branch for PR #${item.number}. Run without --offline to backfill.`);
  return item.targetBranch === "main";
}

export function eligibleForAges(item) {
  return !item.authorIsBot && !item.hasSpamLabel;
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
  const items = snapshot.items.filter(includedItem);
  for (const item of items) {
    validateItemTitle(item);
    validateItemMetadata(item);
  }
  const asOf = timestamp(snapshot.asOf);
  const relevant = items.filter(
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
    prActivity: [],
    openIssueCreated: [],
    openPRCreated: [],
  };
  let fallbackClosures = 0;
  for (const item of relevant) {
    const { transitions, fallback } = lifecycle(item, asOf);
    if (fallback) fallbackClosures++;
    for (const transition of transitions) {
      changes.push({
        at: transition.at,
        kind: item.kind,
        delta: transition.delta,
      });
    }
  }
  // Ages use the state observed during scraping, including changes after the
  // collection start. Intermediate closures never split or reset an item's age.
  const ageAt = timestamp(snapshot.fetchedAt || snapshot.asOf);
  for (const item of items) {
    if (timestamp(item.createdAt) > ageAt) continue;
    const { created, open, transitions } = lifecycle(item, ageAt);
    // Turnaround counts original creation and, for currently closed items,
    // final closure only. Full transitions above still reconstruct the backlog.
    const activity = item.kind === "issue" ? analytics.issueActivity : analytics.prActivity;
    activity.push({ at: created, type: "created", delta: 1 });
    const currentlyOpen = item.state === undefined ? open : item.state === "OPEN";
    if (currentlyOpen) {
      const creations =
        item.kind === "issue" ? analytics.openIssueCreated : analytics.openPRCreated;
      if (eligibleForAges(item)) creations.push(created);
      continue;
    }
    // closedAt is authoritative when imported timeline events are incomplete
    // or differ from the final closure timestamp by a second.
    const closed = item.closedAt
      ? timestamp(item.closedAt)
      : transitions.findLast((transition) => transition.type === "closed")?.at;
    if (closed >= created && closed <= ageAt) {
      activity.push({ at: closed, type: "closed", delta: -1 });
      if (!eligibleForAges(item)) continue;
      analytics.closures.push({
        number: item.number,
        title: item.title,
        author: item.author,
        authorIsBot: item.authorIsBot,
        hasSpamLabel: item.hasSpamLabel,
        hasAdditionalInteraction: item.hasAdditionalInteraction,
        kind: item.kind,
        ...(item.kind === "pr" ? { targetBranch: item.targetBranch } : {}),
        created,
        at: closed,
      });
    }
  }
  analytics.closures.sort((a, b) => a.at - b.at);
  analytics.issueActivity.sort((a, b) => a.at - b.at);
  analytics.prActivity.sort((a, b) => a.at - b.at);
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
