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

// ── Campaign finance (FEC) ───────────────────────────────────────────────
// Cash-on-hand and receipts for the six national party committees, summed
// by party. FEC allows a DEMO_KEY (rate-limited) so this also works locally;
// the Action uses the real FEC_API_KEY secret.
const CYCLE = 2026;
const FEC_COMMITTEES = {
  dem: { DNC: "C00010603", DSCC: "C00042366", DCCC: "C00000935" },
  rep: { RNC: "C00003418", NRSC: "C00027466", NRCC: "C00075820" },
};

async function committeeTotals(id, key) {
  const url =
    `https://api.open.fec.gov/v1/committee/${id}/totals/` +
    `?api_key=${key}&cycle=${CYCLE}&per_page=1&sort=-cycle`;
  const j = JSON.parse(await fetchText(url));
  const t = j.results && j.results[0];
  if (!t) throw new Error(`No FEC totals for ${id}`);
  return { coh: t.last_cash_on_hand_end_period || 0, receipts: t.receipts || 0 };
}

async function buildFinance() {
  const key = process.env.FEC_API_KEY || "DEMO_KEY";
  const partyTotals = async (ids) => {
    let cashOnHand = 0, receipts = 0;
    for (const id of Object.values(ids)) {
      const t = await committeeTotals(id, key);
      cashOnHand += t.coh;
      receipts += t.receipts;
    }
    return { cashOnHand: +cashOnHand.toFixed(2), receipts: +receipts.toFixed(2) };
  };
  return {
    cycle: CYCLE,
    asOf: new Date().toISOString().slice(0, 10),
    dem: await partyTotals(FEC_COMMITTEES.dem),
    rep: await partyTotals(FEC_COMMITTEES.rep),
    committees: { dem: Object.keys(FEC_COMMITTEES.dem), rep: Object.keys(FEC_COMMITTEES.rep) },
  };
}

// ── County demographics (Census) ─────────────────────────────────────────
// One representative large county; demonstrates the app's county + Census
// pairing. Requires CENSUS_API_KEY (Census rejects keyless requests and
// blocks browser CORS — so this only ever runs server-side).
const CENSUS_COUNTY = { name: "Maricopa County, Arizona", state: "04", county: "013", fips: "04013" };

async function buildDemographics() {
  const key = process.env.CENSUS_API_KEY;
  if (!key) throw new Error("CENSUS_API_KEY not set");
  // Prefer the most recent 1-year ACS; fall back to older / 5-year.
  const datasets = [["2024", "acs/acs1"], ["2023", "acs/acs1"], ["2023", "acs/acs5"]];
  for (const [year, ds] of datasets) {
    const url =
      `https://api.census.gov/data/${year}/${ds}` +
      `?get=NAME,B01003_001E,B19013_001E&for=county:${CENSUS_COUNTY.county}` +
      `&in=state:${CENSUS_COUNTY.state}&key=${key}`;
    try {
      const txt = await fetchText(url);
      if (!txt.trim().startsWith("[")) continue; // HTML error page (e.g. dataset not yet released)
      const [, row] = JSON.parse(txt);
      const population = parseInt(row[1], 10);
      const income = parseInt(row[2], 10);
      if (!Number.isFinite(population)) continue;
      return {
        county: CENSUS_COUNTY.name,
        fips: CENSUS_COUNTY.fips,
        population,
        medianHouseholdIncome: Number.isFinite(income) && income > 0 ? income : null,
        dataset: ds.endsWith("acs1") ? "ACS 1-year" : "ACS 5-year",
        asOf: year,
      };
    } catch {
      /* try next dataset */
    }
  }
  throw new Error("No Census dataset returned valid data");
}

async function main() {
  const path = join(DATA_DIR, "polls.json");
  let prev = {};
  try {
    prev = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* first run */
  }

  // Approval is required. Finance/demographics fall back to the previous
  // committed values if a fetch fails — we never wipe good data.
  const out = {
    updated: new Date().toISOString().slice(0, 10),
    approval: await buildApproval(),
    finance: await buildFinance().catch((e) => {
      console.warn("finance skipped:", e.message);
      return prev.finance;
    }),
    demographics: await buildDemographics().catch((e) => {
      console.warn("demographics skipped:", e.message);
      return prev.demographics;
    }),
    attribution: {
      source: "The New York Times",
      license: "CC BY 4.0",
      url: "https://www.nytimes.com/interactive/2026/us/elections/polls-trump-approval-rating.html",
    },
  };
  if (!out.finance) delete out.finance;
  if (!out.demographics) delete out.demographics;

  const next = JSON.stringify(out, null, 2) + "\n";
  const previous = JSON.stringify(prev, null, 2) + "\n";
  if (previous === next) {
    console.log("No data changes.");
    return;
  }
  await writeFile(path, next);
  console.log(
    `Wrote ${path} — approval ${out.approval.approve}% (${out.approval.asOf})` +
    (out.finance ? `, finance D $${(out.finance.dem.cashOnHand / 1e6).toFixed(0)}M / R $${(out.finance.rep.cashOnHand / 1e6).toFixed(0)}M` : "") +
    (out.demographics ? `, ${out.demographics.county} pop ${out.demographics.population}` : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
