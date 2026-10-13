// GET /api/passport?id=<fighterId> — the fighter's house-signed
// passport: counted-match record and exhibition record as SEPARATE
// sections, every figure folded from the arena's frozen records
// (api/_records.js), signed by the Flow operations wallet.
//
// Passports are minted OFFLINE by offchain/mint-passport.js (the
// signing key never enters this runtime) and committed to the repo
// in api/_passport-data.json; static copies are served at
// /passport/<fighterId>.json. A fighter with no underlying record
// has no passport: this route answers 404, never a fabricated card.

const passportData = require("../_passport-data.json");

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  let id = null;
  try {
    id = new URL(req.url, "https://flow-kg4x.vercel.app").searchParams.get("id");
  } catch {
    id = null;
  }
  if (!id) {
    return res.status(200).json({
      service: "flow-arena-passport",
      offer:
        "House-signed fighter passports, minted from the Arena's own records: counted-match record and exhibition record as separate sections, career prizes, career data spend, and efficiency (prize per data cent), each backed by the match receipts named on the card. Signed by the Flow operations wallet — verify the signature against the canonical payload (the document as stable JSON with sorted keys, without the signature field) with ethers.verifyMessage.",
      passports: Object.keys(passportData.passports || {}).sort(),
      read: "GET /api/passport?id=<fighterId> — or the static copy at /passport/<fighterId>.json",
      signer: passportData.signer,
      mintedAt: passportData.generatedAt,
    });
  }
  const key = String(id).trim().toLowerCase();
  const passport = (passportData.passports || {})[key];
  if (!passport) {
    return res.status(404).json({
      error: `No passport for "${key}" — a passport is minted only from a real arena record, and no record under that id exists. Minted passports: ${Object.keys(passportData.passports || {}).sort().join(", ")}.`,
      code: "NO_PASSPORT",
    });
  }
  return res.status(200).json(passport);
}

module.exports = handler;
