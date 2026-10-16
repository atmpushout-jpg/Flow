#!/usr/bin/env node
// Problem Exchange — importer (spec step 5): pipeline.json → listings.
//
// Reads ~/workspace/bounties/pipeline.json (the jobs-engine ledger:
// {updated, jobs: [{id, title, url, amountUsd, ourOfferUsd, status,
// notes}]}), and reconciles it with the board:
//   - a job whose url is already a listing's subject.source.ref is
//     reported already_on_board (dedupe key: the source ref);
//   - a job on the explicit exclusion list is NOT imported; it is
//     logged with its reason code (dead targets, unverified escrow,
//     points-not-USD, unconfirmed payability);
//   - any other job becomes a NEW candidate listing, conservatively:
//     WATCH + FUNDING_UNVERIFIED (or AMOUNT_TBD when no amount is
//     stated) unless the pipeline status itself says the funding is
//     confirmed in writing. New listings print for operator review —
//     the importer never invents a funding state the pipeline lacks.
//
//   node offchain/exchange-import.js [--pipeline <path>] [--write]
//     [--report <path>]
//
// Default: dry run; prints the report. --write also saves the merged
// state to offchain/exchange-state.json (push it afterwards with
// exchange-operate.js push). The curated cluster expansions (e.g. the
// spaceapp job → PX-0003..PX-0008) live in the seed; the importer
// recognizes them through their anchor refs.
const fs = require("fs");
const path = require("path");
const px = require("../api/_exchange.js");

const DEFAULT_PIPELINE = path.join(process.env.HOME, "workspace", "bounties", "pipeline.json");
const STATE_FILE = path.join(__dirname, "exchange-state.json");
const SEED_FILE = path.join(__dirname, "..", "api", "_exchange-seed.json");

// Explicit, auditable exclusions (spec §1.3 "excluded at import").
// Matched against the pipeline job id + title + url, case-insensitive.
const EXCLUSIONS = [
  { match: "toku", code: "TARGET_DEAD", note: "target dead (repo gone — GitHub search total_count 0 at pipeline check)" },
  { match: "wisewallet", code: "TARGET_DEAD", note: "target dead (org deleted — GitHub API 404 at pipeline check)" },
  { match: "aquarium-of-gullibles", code: "ESCROW_UNVERIFIED", note: "bounty denominated in AQUA points, no escrow verified" },
  { match: "astraldeep", code: "POINTS_NOT_USD", note: "points-denominated rewards, ~$1 total" },
  { match: "earnly", code: "PAYABILITY_UNCONFIRMED", note: "posted by a non-maintainer; no maintainer reply on either issue" },
  { match: "parabola", code: "PAYABILITY_UNCONFIRMED", note: "org-level bounties page not verified" },
];

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes("--" + name);

function exclusionFor(job) {
  const t = `${job.id} ${job.title} ${job.url}`.toLowerCase();
  return EXCLUSIONS.find((x) => t.includes(x.match)) || null;
}

function main() {
  const pipeline = JSON.parse(fs.readFileSync(arg("pipeline", DEFAULT_PIPELINE), "utf8"));
  const jobs = Array.isArray(pipeline.jobs) ? pipeline.jobs : [];
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));

  const onBoard = new Set(state.listings.map((l) => l.subject.source.ref));
  const report = {
    at: new Date().toISOString(),
    pipeline_updated: pipeline.updated || null,
    imported: [], already_on_board: [], excluded: [], skipped: [],
  };
  let nextNum = Math.max(0, ...state.listings.map((l) => parseInt(l.id.slice(3), 10) || 0)) + 1;

  for (const job of jobs) {
    const label = job.title || job.id;
    if (job.status === "dead") {
      report.excluded.push({ job: job.id, item: label, ref: job.url, code: "TARGET_DEAD", note: "pipeline status: dead" });
      continue;
    }
    const ex = exclusionFor(job);
    if (ex) {
      report.excluded.push({ job: job.id, item: label, ref: job.url, code: ex.code, note: ex.note });
      continue;
    }
    if (!job.url) { report.skipped.push({ job: job.id, item: label, why: "no url" }); continue; }
    if (onBoard.has(job.url)) { report.already_on_board.push({ job: job.id, item: label, ref: job.url }); continue; }

    const now = new Date().toISOString();
    const amount = typeof job.amountUsd === "number" ? job.amountUsd : null;
    const awaiting = String(job.status || "").includes("awaiting-maintainer");
    const listing = {
      schema: "problem-listing/0.1",
      id: "PX-" + String(nextNum++).padStart(4, "0"),
      subject: {
        lister: { id: job.id, kind: "imported" },
        source: { kind: "github-issue", ref: job.url, imported_at: now },
      },
      problem: {
        title: label,
        statement: "As stated at source (linked). Imported by exchange-import.js from the jobs-engine pipeline; the funding state below is carried from the pipeline record, not re-verified at import.",
        category: "dev-tooling",
        acceptance: "As stated at source.",
      },
      budget: {
        ...(amount ? { amount_usd: amount } : {}),
        asset: "USD",
        funding_state: awaiting ? "CLAIMED" : amount ? "FUNDING_UNVERIFIED" : "AMOUNT_TBD",
        funding_evidence: [{ kind: "page", ref: job.url }],
      },
      doors: ["DONE"],
      status: awaiting ? "OPEN" : "WATCH",
      reasons: [awaiting
        ? { code: "AWAITING_MAINTAINER_CONFIRMATION", severity: "info" }
        : { code: amount ? "FUNDING_UNVERIFIED" : "AMOUNT_TBD", severity: "info" }],
      route_answer: null, bypass_offer: null,
      bids: typeof job.ourOfferUsd === "number" ? [{
        bidder: { id: "flowexecutor", passport: "https://flow-kg4x.vercel.app/api/passport?id=flowexecutor" },
        amount_usd: job.ourOfferUsd, at: now, ref: job.url,
        note: "recorded from the pipeline ledger at import",
      }] : [],
      solution: null, verdict: null,
      history: [], history_root: "sha256:" + px.EMPTY_ROOT,
      created_at: now, updated_at: now, checked_at: now,
      rules_version: px.RULES_VERSION,
    };
    px.applyEvent(listing, "LISTING_CREATED", { via: "exchange-import", job: job.id }, now);
    const err = px.validateListing(listing);
    if (err) { report.skipped.push({ job: job.id, item: label, why: "validation: " + err }); continue; }
    state.listings.push(listing);
    onBoard.add(job.url);
    report.imported.push({ id: listing.id, job: job.id, item: label, ref: job.url, status: listing.status });
  }

  const stateErr = px.validateState(state);
  if (stateErr) throw new Error("merged state invalid: " + stateErr);
  console.log(JSON.stringify(report, null, 2));
  const reportPath = arg("report", null);
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (has("write")) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    console.log("local state updated:", STATE_FILE, "— push with: node offchain/exchange-operate.js push");
  } else if (report.imported.length) {
    console.log(`dry run: ${report.imported.length} new listing(s) would be added (re-run with --write to save)`);
  }
}

main();
