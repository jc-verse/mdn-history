# mdn/content open issue and PR history

A standalone command-line tool that fetches public GitHub data and generates an interactive Plotly chart of the **number of open items over time**, sampled weekly or at six-hour/hourly intervals for shorter selections, plus exact minimum and maximum counts for a selected period. Issues and pull requests are separate series. The chart includes hover values, legend toggles, zoom, a date range slider, and SVG export. CSV contains the plotted weekly values; JSON also includes the event-level count timeline.

## Run

From the repository root, using Node.js 24 or later:

```sh
npm ci
node index.mjs
```

Open `output/index.html` in a browser. It works directly from disk without a server or network connection. Keep its sibling `plotly.min.js`, `history.csv`, and `history.json` files together when moving or sharing the report.

The collector calls [GitHub's public GraphQL API](https://docs.github.com/en/graphql/overview/about-the-graphql-api). GraphQL requires authentication even for public repositories: it reads `GH_TOKEN`, then `GITHUB_TOKEN`, then an existing `gh auth login` for `github.com`. No token is stored in the cache or report. It only performs queries and does not modify GitHub or the local issue board.

Initial collection covers tens of thousands of items and takes several minutes. Progress is printed for every 100 items. Repository connections and each item's close/reopen/merge timeline are fully paginated; GitHub Search's 1,000-result limit is not involved. Transient network and HTTP 5xx errors are retried; rate limits stop with a resumable error.

Subsequent runs reuse the completed history. Issues and PRs are listed by most recent update, stopping once a page reaches records older than the previous collection's start time (with a five-minute overlap). Only new or changed records in that window need timeline requests; unchanged records retain their cached history. This includes recently created, closed, reopened, and merged records, even when originally opened years ago. The API supports update ordering for both [issues](https://docs.github.com/en/graphql/reference/issues#issueorderfield) and [pull requests](https://docs.github.com/en/graphql/reference/pulls#pullrequestorderfield). Existing caches are upgraded automatically without a full download.

```sh
# Resume an interrupted same-day collection, or refresh a completed collection.
node index.mjs

# Regenerate from the last completed snapshot without API requests.
node index.mjs --offline

# Rebuild all history from scratch, bypassing the incremental cache.
node index.mjs --fresh

# Override the cache and report locations.
node index.mjs --cache /tmp/mdn-history-cache --output /tmp/mdn-history-report

# Run the focused calculation and collection tests.
npm test
```

Cache files and generated outputs are ignored by Git. Do not run two collectors against the same cache simultaneously. A completed snapshot is published atomically to `snapshot.json`; failed refreshes leave it available with `--offline`. Initial downloads checkpoint pages, and incremental refreshes checkpoint completed timelines in `refresh.json`. On retry, incremental listings restart at the newest record because update ordering can move; unchanged checkpointed timelines are reused. Interrupted work from an earlier UTC date restarts automatically, so a normal run ends on today's date. Offline mode retains and displays the original snapshot date.

Incremental refreshes cannot discover deletions, transfers out of the repository, or records that become accessible without a recent update timestamp. Use `--fresh` to reconcile the entire cache with GitHub's currently available records.

## Daily GitHub sync

The **Daily sync** workflow runs at midnight UTC each day and when collector or deployment files change on `main`. You can also run it manually from the Actions tab. CI runs the existing tests on pushes and pull requests; daily sync also tests before collecting or publishing anything.

The workflow uses the built-in `GITHUB_TOKEN` to read public `mdn/content` history. An optional `GH_READ_TOKEN` Actions secret can override it if you need a higher API quota. Neither token is included in generated reports or caches.

Each run restores the previous history cache, collects changes, saves a new cache, and uploads the four generated files as an `mdn-history-report` artifact retained for seven days. Only one sync runs at a time. Checkpoints are cached even when collection fails so that a same-day retry can resume. Failed syncs do not deploy a stale report.

The `cache-seed` GitHub release contains an initial `snapshot.json` taken from the completed local collection. It is downloaded only when no Actions cache exists, avoiding an expensive initial fetch without committing generated data. If neither cache nor seed is available, the collector performs a full download. This seed contains public issue/PR history only, with no triage notes or tokens.

Actions restores and saves caches under the `history-v3-titles-` prefix, excluding older caches without titles. Each run saves a new cache entry; subsequent runs restore the newest matching entry. The release seed must also contain titles for every item, but it does not need a daily upload.

### Cloudflare deployment

Daily sync works without Cloudflare credentials and always saves its report as a downloadable Actions artifact. To also update your existing **Worker**, set these under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | An API token authorized to deploy the Worker |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account containing that Worker |
| Variable | `CLOUDFLARE_WORKER_NAME` | The exact existing Worker name |

When the Worker-name variable is empty, deployment is skipped. Once it is set, missing credentials fail the deployment step visibly. The workflow overrides the default `name` in `wrangler.json` with that variable and deploys only `output/` as static assets. It does not configure custom domains or DNS.

For a manual deployment after generating the report and authenticating Wrangler:

```sh
npx wrangler deploy --name YOUR_WORKER_NAME
```

The committed configuration defaults to a Worker named `mdn-history` for local use. Set the name to match your intended target before deploying.

## Counting and dates

Drag across the graph to zoom into any date range, adjust the slider, or use a range preset. The **Selected period** panel updates the minimum and maximum number of open issues and open PRs, with the first timestamp in that period at which each count occurs. Box selections also use their continuous date bounds, even when they contain no weekly point. Reset the graph or choose All time to return to the full range.

The **7 days** and **30 days** presets select the preceding seven or 30 days. Expand **Custom date range** above the chart, enter a start and end date, and choose **Apply range** to zoom to specific dates. Both dates are inclusive in UTC, with the final day capped at the latest collected time. The fields follow the current selection, and invalid or unavailable dates leave the chart unchanged. Any selected range of 30 days or less uses samples every six hours; a range of seven days or less uses hourly samples. Wider ranges return to weekly samples. These rules apply to presets, zoom, the date slider, and box selections. Intraday samples use UTC hour boundaries and include both selection endpoints, with counts taken directly from the event timeline. The chart shows the current sampling interval and number of samples in the selected period. The slider retains the full history, and the CSV download continues to contain the weekly baseline.

Extrema use counts after every creation, closure, reopening, and merge, **not weekly samples or interpolated chart lines**. The count at the start of the range includes earlier events; events exactly at either endpoint are included. If a count already holds at the start, its occurrence is reported at that start. Equal timestamps are applied together, since GitHub provides no ordering within them. Results are exact to the available event timestamp precision and coverage. All timestamps and timezone-free graph selections are UTC. Selections are clipped to the first recorded UTC day through the collection timestamp; ranges entirely outside that coverage show no observations.

### Duration distributions and net issue change

Four cards in a 2×2 grid show issue time-to-close, PR time-to-close, and the ages of issues and PRs open at fetch time. Each includes a histogram, sample count, minimum, maximum, average, median, Q1, and Q3. Time-to-close histograms use logarithmic axes and geometric bin edges, giving equal visual widths in log space. Age histograms use linear axes and equal-width bins in days. Each x-axis starts at its minimum plotted value, with no automatic padding toward zero. Zero-duration closures remain in the summary statistics but cannot appear on a logarithmic axis; their count is shown below the chart, which starts at the smallest positive duration. A single-valued distribution uses one bin with a small upper extension. Summary durations display seconds, minutes, hours, or days as appropriate. Q1, median, and Q3 use linear interpolation at ranks `(n - 1) × 0.25`, `(n - 1) × 0.5`, and `(n - 1) × 0.75`. An empty distribution shows no bars and dashes for summary values.

- **Time-to-close** follows the selected interval, filtering by closure time with inclusive endpoints. It measures elapsed time from original creation to the item's latest closure within that interval, one observation per item. The item may have been created before the interval or reopened after closing. PR merges count as closures; duplicate merge/close events count once. Missing final closure events use the same `closedAt` fallback as the backlog chart.
- **Current open issue and PR ages** measure original creation to the saved fetch completion time (`fetchedAt`, or `asOf` for older snapshots without it). Open state is reconstructed from the available events through that time, including reopenings. Open draft PRs are included; closed and merged PRs are excluded. These distributions stay fixed when the selection changes.
- **Net issue change** is creations plus reopenings minus closure transitions inside the selected interval. Every actual transition counts, even if the same issue closes more than once. Positive means backlog growth; negative means backlog reduction. Average rates divide this net change by the selected interval's elapsed days, including partial days, then multiply by 7 for a week and 30 for a normalized month. These are rates over the whole selection, not averages of only days with activity. Zero-duration selections show their net count but no average rate.

These calculations use cached item timelines and require no additional GitHub requests. The JSON download includes the closure/activity data and saved open issue and PR ages used by the panels; the CSV remains the weekly backlog series.

The **Top 10 longest & shortest times to close** section ranks issues and PRs separately in four lists. Each row shows the item number and title in a GitHub link that opens in a new tab, plus elapsed time, creation date, and closure date (hover for exact UTC timestamps). Lists follow the selected period and use the same latest-closure-per-item rule as the histograms, including merges, reopened items, and zero-duration closures. Each list shows up to 10 items; equal durations are ordered by ascending item number. Empty selections show an explicit empty state.

Every cached item must have a nonempty title; collection and report generation throw an error when a title is missing. Titles reflect the latest collection rather than historical titles at closure.

- The first sample is the earliest of repository creation and the creation dates of available issues/PRs. Some transferred issues retain creation dates before `mdn/content` existed, so the available history starts in April 2018, while the repository was created in September 2020.
- The remaining samples are seven calendar days apart, anchored backward from today's **UTC** date. The first interval can be shorter than a week so the chart includes the very first day.
- Historical dates are evaluated at the end of their UTC day. Today's point is evaluated at the collection start timestamp, displayed on the report. It does not project counts to the future end of today.
- Creation opens an item; closing or merging closes it; reopening opens it again. Repeated close/merge notifications are counted once. Draft pull requests count as open. Issues exclude PRs.
- The collector retrieves all states, including closed issues and merged PRs. It reconstructs each item's open intervals from its timeline, rather than assuming it was continuously open until its last closure. If the final closure event is missing or its timestamp differs from `closedAt`, that final closure timestamp supplements the timeline. The report discloses how many items needed this supplementation; event timestamps sometimes lag by a second.

GitHub exposes the history of currently accessible records, not an immutable historical repository census. Deleted/inaccessible items and historical repository membership after transfers cannot be recovered. This chart includes the available items' original histories. Pagination is not an atomic GitHub snapshot: records deleted or transferred during collection can affect coverage. Events after collection start are excluded, and duplicate records cause an error rather than inflating counts.

Plot rendering uses [Plotly.js](https://plotly.com/javascript/line-charts/), installed as the only runtime dependency of this project.
