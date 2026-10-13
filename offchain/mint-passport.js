/**
 * MINT FIGHTER PASSPORTS — house-signed career cards built ONLY from
 * real records. Run: node offchain/mint-passport.js [fighterId ...]
 *
 * WHY OFFCHAIN: the passport is signed with the Flow operations
 * wallet key (~/.config/flowexecutor_wallet_key, mode 600). That key
 * never enters the Vercel runtime, a request, a log, or this file's
 * output — the minter reads it, signs locally, and writes signed
 * JSON. GET /api/passport serves the minted documents; the static
 * copies land at passport/<fighterId>.json.
 *
 * FIGURES: every number folds api/_records-data.json through
 * api/_records.js — the same rows behind GET /api/arena/results —
 * so a passport and the results feed can never disagree. Counted
 * (OFFICIAL) and exhibition records are separate sections, never
 * blended. A fighter with no underlying record is never minted:
 * there is no code path here that fabricates a card.
 *
 * FLOWX is exhibition-class only by house rule: his passport carries
 * counted: null, and his exhibition section is scoped to the
 * completed formula-v1 debut series (the scope is printed on the
 * card). The fictional sample fighter PULSE (owner "Mara Voss" in
 * the registration kit's sample spec) is deliberately NOT minted —
 * it has no record; the BYOB ledger's PULSE exhibition rows belong
 * to a registration-round test, not to a career.
 *
 * SIGNATURE: EIP-191 personal_sign over the canonical payload — the
 * passport serialized as stable JSON (object keys sorted, recursively)
 * WITHOUT the signature field. Anyone can verify: recompute the
 * canonical payload, recover the signer from the signature, compare
 * with the issuer address printed on the card (ethers.verifyMessage).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const records = require("../api/_records.js");

const ROOT = path.join(__dirname, "..");
const KEY_PATH = path.join(process.env.HOME || "/home/hatch", ".config", "flowexecutor_wallet_key");
const EXPECTED_SIGNER = "0x3D650013F46DD2d96B5afEFe4acAb7A7f2727561"; // Flow operations wallet
const PASSPORT_DIR = path.join(ROOT, "passport");
const DATA_OUT = path.join(ROOT, "api", "_passport-data.json");

// The house cast (counted careers) + FLOWX (exhibition only). Any
// other id found in the records is a guest seat, not a passport
// subject, until the house says otherwise.
const CAST = ["fade", "rook", "longshot", "echo", "vex", "audrey"];
const FLOWX_EXHIBITION_PREFIX = "exhibition-flowx-formula-v1-";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function loadWallet() {
  const raw = fs.readFileSync(KEY_PATH, "utf8").trim();
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : "0x" + raw);
  if (wallet.address.toLowerCase() !== EXPECTED_SIGNER.toLowerCase()) {
    throw new Error(`signing key resolves to ${wallet.address}, not the Flow operations wallet ${EXPECTED_SIGNER} — refusing to mint`);
  }
  return wallet;
}

function nameOf(id) {
  for (const m of [...records.data.countedMatches, ...records.data.exhibitionEvents]) {
    const seat = m.seats.find((s) => s.fighterId === id);
    if (seat) return seat.name;
  }
  return id.toUpperCase();
}

function section(agg) {
  if (!agg) return null;
  return {
    matches: agg.matches,
    wins: agg.wins,
    titles: agg.wins, // a counted/exhibition win is a title in its class
    prizesUsd: agg.prizesUsd,
    dataUsd: agg.dataUsd,
    efficiency: {
      prizePerDataCent: agg.efficiency,
      note: "prize dollars won per cent of data spent (prizes / (data x 100))",
    },
    trades: agg.trades,
    pnlUsd: agg.pnlUsd,
    perMatch: agg.perMatch,
    receipts: agg.receipts,
  };
}

function buildPassport(id, issuedAt) {
  const isFlowx = id === "flowx";
  const counted = isFlowx ? null : records.countedRecord(id);
  const exhibition = isFlowx
    ? records.exhibitionRecord(id, FLOWX_EXHIBITION_PREFIX)
    : records.exhibitionRecord(id);
  if (!counted && !exhibition) return null; // no record, no card — ever
  const passport = {
    passportVersion: 1,
    kind: "flow-arena-fighter-passport",
    fighterId: id,
    name: nameOf(id),
    affiliation: isFlowx ? "HOUSE — exhibition class only" : "HOUSE",
    issuedAt,
    issuer: {
      name: "Flow Arena — House of Intelligence",
      signer: EXPECTED_SIGNER,
      signatureNote:
        "Signed by the Flow operations wallet (EIP-191 personal_sign over the canonical payload: this document as stable JSON with sorted keys, without the signature field). Verify with ethers.verifyMessage(canonicalPayload, signature) — it must recover the signer address above.",
    },
    counted: section(counted),
    countedNote: isFlowx
      ? "FLOWX has never played a counted match and never will under the house exhibition rule — his record is exhibition class only. Nothing in the counted standings includes him."
      : undefined,
    exhibition: section(exhibition),
    exhibitionNote: isFlowx
      ? "Scoped to the FLOWX formula-v1 debut series (3 exhibitions, 2026-10-12) — the first completed, verified FLOWX series. FLOWX also sits in other exhibition events in the same public record files (control/mirror runs, later series); those are not folded into this card."
      : "All exhibition-class events for this fighter in the frozen record set (api/_records-data.json, generated from offchain/floor/exhibition/*.standings-record.json + the frozen standings history). Exhibitions never count toward the career standings.",
    recordsGeneratedAt: records.data.generatedAt,
  };
  if (passport.countedNote === undefined) delete passport.countedNote;
  return passport;
}

function canonicalPayload(passport) {
  const { signature, ...unsigned } = passport;
  return stableStringify(unsigned);
}

async function signPassport(wallet, passport) {
  const value = await wallet.signMessage(canonicalPayload(passport));
  return {
    ...passport,
    signature: {
      alg: "secp256k1 EIP-191 personal_sign",
      signer: wallet.address,
      value,
    },
  };
}

function verifyPassport(passport) {
  if (!passport || !passport.signature) return false;
  try {
    const recovered = ethers.verifyMessage(canonicalPayload(passport), passport.signature.value);
    return recovered.toLowerCase() === String(passport.signature.signer).toLowerCase();
  } catch {
    return false;
  }
}

async function main() {
  const wallet = loadWallet();
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : [...CAST, "flowx"];
  const issuedAt = new Date().toISOString();
  fs.mkdirSync(PASSPORT_DIR, { recursive: true });

  let existing = { passports: {} };
  try {
    existing = JSON.parse(fs.readFileSync(DATA_OUT, "utf8"));
  } catch { /* first mint */ }

  const minted = {};
  for (const id of ids) {
    const built = buildPassport(id, issuedAt);
    if (!built) {
      console.log(`SKIP ${id}: no underlying record — no passport minted`);
      continue;
    }
    const signed = await signPassport(wallet, built);
    minted[id] = signed;
    fs.writeFileSync(path.join(PASSPORT_DIR, `${id}.json`), JSON.stringify(signed, null, 1) + "\n");
    console.log(
      `minted ${id}: counted=${signed.counted ? `${signed.counted.matches}m/${signed.counted.wins}w $${signed.counted.prizesUsd}/$${signed.counted.dataUsd}` : "null"} exhibition=${signed.exhibition ? `${signed.exhibition.matches}m/${signed.exhibition.wins}w $${signed.exhibition.prizesUsd}/$${signed.exhibition.dataUsd}` : "null"}`
    );
  }

  const merged = { ...(existing.passports || {}), ...minted };
  const out = { version: 1, generatedAt: issuedAt, signer: wallet.address, passports: merged };
  fs.writeFileSync(DATA_OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote api/_passport-data.json with ${Object.keys(merged).length} passports; static copies in passport/`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}

module.exports = { buildPassport, canonicalPayload, signPassport, verifyPassport, stableStringify, CAST, FLOWX_EXHIBITION_PREFIX };
