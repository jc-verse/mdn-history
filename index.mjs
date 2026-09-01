import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collect, createClient, githubToken, readSnapshot } from "./github.mjs";
import { buildHistory } from "./history.mjs";
import { renderReport } from "./render.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const { values } = parseArgs({
    options: {
      offline: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      cache: { type: "string", default: path.join(root, "cache") },
      output: { type: "string", default: path.join(root, "output") },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage: node tools/mdn-history/index.mjs [options]

Fetch mdn/content history through today and generate an interactive Plotly chart.
Authentication: GH_TOKEN, GITHUB_TOKEN, or an existing gh auth login.

  --offline       Render the last complete snapshot without network access
  --fresh         Rebuild all history, bypassing the incremental cache
  --cache PATH    Download/checkpoint directory (default: beside this script)
  --output PATH   HTML and Plotly directory (default: output/)
  -h, --help      Show help

Normal runs fetch recently updated issues/PRs and reuse cached history.
Interrupted same-day downloads reuse completed work.
Offline mode preserves the original snapshot date instead of inventing new data.`);
  } else {
    if (values.offline && values.fresh)
      throw new Error("--offline and --fresh cannot be used together.");
    const directory = path.resolve(values.cache);
    const snapshot = values.offline
      ? readSnapshot(directory)
      : await collect({
          directory,
          client: createClient(githubToken()),
          fresh: values.fresh,
        });
    const history = buildHistory(snapshot);
    const report = renderReport(history, path.resolve(values.output));
    console.log(
      `\nSaved ${history.rows.length} samples (${history.firstDay} through ${history.rows.at(-1).date}).`,
    );
    console.log(`Open the report: ${report}`);
    console.log(
      `Latest counts: ${history.rows.at(-1).openIssues} issues, ${history.rows.at(-1).openPRs} pull requests.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
