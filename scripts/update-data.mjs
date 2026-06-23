#!/usr/bin/env node
/**
 * update-data.mjs
 *
 * Refreshes the real data that powers the Ballotics marketing site.
 * Runs in GitHub Actions (Node 20+, global `fetch`), writes JSON into /data,
 * and the workflow commits any changes. The static site reads those JSON
 * files same-origin — so no API keys are ever shipped to the browser and
 * there are no CORS problems (Census, for one, blocks browser requests).
 *
 * Secrets are read from the environment (set them in the workflow):
 *   FEC_API_KEY     — https://api.open.fec.gov  (optional, for finance)
 *   CENSUS_API_KEY  — https://api.census.gov     (optional, for demographics)
 *
 * Data sourced from The New York Times is available under the Creative
 * Commons Attribution 4.0 International license (CC BY 4.0). The site
 * attributes The Times wherever this data appears.
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");

const NYT_APPROVAL_AVERAGES =
  "https://www.nytimes.com/newsgraphics/polls/approval/president-averages.csv";

/** Evenly sample `n` values across an array. */
function sample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

/** Minimal CSV line splitter (the NYT averages file has no quoted commas). */
function parseCsv(text) {
  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c.trim(), cells[i]]));
  });
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ballotics-site-bot" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function buildApproval() {
  const rows = parseCsv(await fetchText(NYT_APPROVAL_AVERAGES)).map((r) => ({
    date: r.date,
    answer: r.answer,
    pct: parseFloat(r.pct),
  }));
  const series = (answer) =>
    rows
      .filter((r) => r.answer === answer && Number.isFinite(r.pct))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

  const approve = series("Approve");
  const disapprove = series("Disapprove");
  if (!approve.length) throw new Error("No approval rows parsed");

  const last = approve[approve.length - 1];
  const monthAgo = approve[Math.max(0, approve.length - 31)];

  return {
    subject: "Trump",
    approve: last.pct,
    disapprove: disapprove.length ? disapprove[disapprove.length - 1].pct : null,
    delta30: +(last.pct - monthAgo.pct).toFixed(1),
    asOf: last.date,
    approveTrend: sample(approve.map((r) => r.pct), 24),
    disapproveTrend: sample(disapprove.map((r) => r.pct), 24),
  };
}

async function main() {
  const out = {
    updated: new Date().toISOString().slice(0, 10),
    approval: await buildApproval(),
    attribution: {
      source: "The New York Times",
      license: "CC BY 4.0",
      url: "https://www.nytimes.com/interactive/2026/us/elections/polls-trump-approval-rating.html",
    },
  };

  // ── Optional: campaign finance + demographics ──────────────────────────
  // These require keys and run server-side only (never in the browser).
  // Flip them on by adding the secrets to the workflow, then map the
  // results into `out` and render them on the page.
  //
  // if (process.env.FEC_API_KEY) {
  //   const fec = await fetchText(
  //     `https://api.open.fec.gov/v1/...&api_key=${process.env.FEC_API_KEY}`
  //   );
  //   out.finance = /* parse */;
  // }
  // if (process.env.CENSUS_API_KEY) {
  //   const census = await fetchText(
  //     `https://api.census.gov/data/...&key=${process.env.CENSUS_API_KEY}`
  //   );
  //   out.demographics = /* parse */;
  // }

  const path = join(DATA_DIR, "polls.json");
  let previous = "";
  try {
    previous = await readFile(path, "utf8");
  } catch {
    /* first run */
  }
  const next = JSON.stringify(out, null, 2) + "\n";
  if (previous === next) {
    console.log("No data changes.");
    return;
  }
  await writeFile(path, next);
  console.log(`Wrote ${path} (approval ${out.approval.approve}% as of ${out.approval.asOf}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
