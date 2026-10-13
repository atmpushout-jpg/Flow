// GET /api/arena/results — per-seat results for counted Flow Arena
// matches: one row per seat per match {matchId, fighter, placing,
// prizeUsd, dataUsd, efficiency}. The format SKR's Flow Arena
// benchmark asked for ("per-seat results").
//
// Exhibitions are excluded — see the note in the body for where the
// exhibition records live. Every row folds api/_records-data.json
// through api/_records.js, the same rows the fighter passports are
// minted from, so this feed and the passports can never disagree.

const records = require("../../_records");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  return res.status(200).json(records.resultsBody());
}

module.exports = handler;
