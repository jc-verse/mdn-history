# mdn/content open issue and PR history

A standalone command-line tool that fetches public GitHub data and generates an interactive Plotly chart of the **number of open items over time**, sampled weekly or at six-hour/hourly intervals for shorter selections, plus exact minimum and maximum counts for a selected period. Issues and pull requests are separate series. The chart includes hover values, legend toggles, zoom, a date range slider, and SVG export. All chart data, including the event-level count timeline, is embedded in the HTML report.

Only PRs whose target branch is exactly `main` at collection time are included. Other PRs are excluded from the cache, all historical counts and dates, distributions, ages, activity/turnaround statistics, rankings, and exports. A link to a non-`main` PR also does not qualify an issue for interaction. Retargeting applies this inclusion rule to the PR's entire history, not just events after the branch change. Each retained PR records `targetBranch` from GitHub's `baseRefName` (not its source/head branch).

## Run

From the repository root, using Node.js 24 or later:

```sh
npm ci
node index.mjs
```

Open `output/index.html` in a browser. It works directly from disk without a server or network connection. Keep its sibling `plotly.min.js` with it when moving or sharing the report. These are the only two generated bundle files.

The collector calls [GitHub's public GraphQL API](https://docs.github.com/en/graphql/overview/about-the-graphql-api). GraphQL requires authentication even for public repositories: it reads `GH_TOKEN`, then `GITHUB_TOKEN`, then an existing `gh auth login` for `github.com`. No token is stored in the cache or report. It only performs queries and does not modify GitHub or the local issue board.

Initial collection covers tens of thousands of items and takes several minutes. Progress is printed for every 100 items. Repository connections and each item's close/reopen/merge history are fully paginated. Interaction evidence is fetched separately in batches of five comments/reviews/link events, stopping as soon as one qualifies; batches containing only self-comments or excluded bot comments continue. Inline review replies also use batches of five. Merged PRs and issues with linked PRs skip comment/review requests entirely. Timeline pagination uses bounded concurrency and retains ordered, atomic page checkpoints. GitHub Search's 1,000-result limit is not involved. Transient network and HTTP 5xx errors are retried; rate limits stop with a resumable error.

Subsequent runs reuse the completed history. Issues and PRs are listed by most recent update, stopping once a page reaches records older than the previous collection's start time (with a five-minute overlap). Only new or changed records in that window need timeline requests; unchanged records retain their cached history. This includes recently created, closed, reopened, and merged records, even when originally opened years ago. The API supports update ordering for both [issues](https://docs.github.com/en/graphql/reference/issues#issueorderfield) and [pull requests](https://docs.github.com/en/graphql/reference/pulls#pullrequestorderfield). Older snapshots missing author, interaction, bot/spam, or target-branch metadata are backfilled automatically on the next online run: all listing pages are scanned, and items missing those fields are fetched even if unchanged. Branch-only upgrades reuse unchanged cached histories from the listing data. Other metadata upgrades can cost about as much as an initial collection, but completed records are checkpointed and reused on same-day retries. Offline reports require that backfill first.

Each cached issue/PR records `author` (the original author's GitHub login, or `null` for an unavailable/deleted author) and `hasAdditionalInteraction` (a boolean). Interaction means a comment, submitted review, or submitted inline review reply by another account; a PR linked to an issue (including PR cross-references and closed PRs); or a merged PR. Self-comments/reviews, pending reviews, and closure alone do not qualify. Comments and reviews whose GraphQL author has `__typename: "Bot"` never qualify, regardless of login. Automation using an ordinary `User` account is not identified as a bot by this check. Missing identities alone cannot prove different authors. The PR target branch and these fields also accompany closure records in the report's embedded data.

The four **Top 10 longest & shortest times to close** lists exclude items without qualifying interaction and show the original author. Interaction reflects evidence available at collection time, not only activity within the selected period. Age distributions and closure rankings, including the top-10 lists, exclude items with `authorIsBot: true` or `hasSpamLabel: true`. These cached flags use the original author’s GraphQL account type and the current, exact `spam` label (case-insensitive). Label pages are checked until spam is found or all labels are exhausted. Backlog counts and activity/flow statistics still include these items.

Age statistics use each item’s original creation and its state at fetch time, including changes observed after collection started. Items open at fetch are treated as continuously open since creation, regardless of earlier closures. Items closed at fetch use creation to their last closure (or merge); only that final closure can contribute a sample in the selected period. Open-age graphs recalculate at the selection’s right boundary, measuring age from original creation. They include items created by that boundary whose final closure is later, or which remain open at fetch; items closed exactly at the boundary are excluded. The left boundary does not restrict which creation dates qualify. Full lifecycle events remain cached for historical backlog calculations.

**Issue/PR turnaround** shows **Opened**, **Closed**, and **Net** columns in side-by-side issue and PR tables. Each shows the selected-period total and average per day, per seven-day week, and per 30-day month. Opened counts only original creations in the selected period. Closed counts only the final closure or merge of items closed at fetch. Reopenings and earlier closures are ignored, even when they fall within the selection; items open at fetch are treated as continuously open since creation. Net is original creations minus final closures using exact values: positive means more items were created than finally closed; negative means more were finally closed than created. These rules also mean Net can differ from the historical backlog change across a selection. Items need not be both opened and closed within the period. Rates divide activity by the selected interval’s elapsed time, including inactive days; zero-length selections show totals but no average rates. These cards update with the chart selection and include all in-scope items regardless of interaction. The embedded report data includes separate `issueActivity` and `prActivity` arrays containing only original creations and final closures.

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

Each run restores the previous history cache, collects changes, saves a new cache, and uploads the two generated files as an `mdn-history-report` artifact retained for seven days. Only one sync runs at a time. Checkpoints are cached even when collection fails so that a same-day retry can resume. Failed syncs do not deploy a stale report.

The `cache-seed` GitHub release contains an initial `snapshot.json` taken from the completed local collection. It is downloaded only when no Actions cache exists, avoiding an expensive initial fetch without committing generated data. If neither cache nor seed is available, the collector performs a full download. This seed contains public issue/PR history only, with no triage notes or tokens.

Actions restores and saves caches under the `history-main-no-bots-spam-` prefix, excluding older caches without bot-author and spam-label flags or with bot comments counted as interaction. Each run saves a new cache entry; subsequent runs restore the newest matching entry. The release seed must contain titles, original authors, interaction flags, PR target branches, bot-author flags, and spam-label flags for every in-scope item, but it does not need a daily upload. Cache files have no schema version field; cache freshness is maintained manually through the seed and Actions cache key.

### Cloudflare Pages deployment

Daily sync works without Cloudflare credentials and always saves its report as a downloadable Actions artifact. To also update your existing **Cloudflare Pages project**, set these under **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | An API token with Account → Cloudflare Pages → Edit permission |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account containing that Pages project |
| Variable | `CLOUDFLARE_PAGES_PROJECT_NAME` | The exact existing Pages project name, such as `mdn-history` |

When the Pages-project variable is empty, deployment is skipped. Once it is set, missing credentials fail the deployment step visibly. The workflow runs `wrangler pages deploy output --project-name=...` and uploads the generated static report to that Pages project. The `pages_build_output_dir` setting in `wrangler.json` identifies `output/` as the Pages build output. Configure the Pages project's production branch as `main` so daily runs update production; manual runs from other branches create preview deployments. See [Cloudflare's Pages CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/) for token setup and deployment details.

For a manual deployment after generating the report and authenticating Wrangler:

```sh
npx wrangler pages deploy output --project-name YOUR_PAGES_PROJECT_NAME --branch main
```

The committed configuration names the Pages project `mdn-history`. The `--project-name` flag selects the intended Pages project when deploying.
