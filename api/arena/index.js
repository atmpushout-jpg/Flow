// GET /api/arena — the live-state read path for Flow Arena.
//
// arena.html polls this FIRST (before the static arena-live.json on
// GitHub/Vercel). The live match's publisher (offchain/
// arena-publish-upstash.js) writes the current match state to the shared
// Upstash store on every state change, so the public page sees the
// broadcast tick by tick WITHOUT a git push + Vercel deployment per
// update (the old wire's bottleneck: every push was a deploy, and
// Vercel's daily deploy cap can freeze the page mid-match).
//
// Contract with arena.html: always answer 200 with JSON for GET. When
// there is no live state (store unset, key absent/expired, or the
// stored state is the resting state), the body has liveMode:false and
// the page falls back to the static arena-live.json / arena-state.json
// chain exactly as before. When a live (or finished-just-now) state is
// stored, it is returned verbatim.

const REDIS_KEY = "flow:arena-live";
const STORE_TIMEOUT_MS = 1500;

async function readStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return { data: null, source: "none" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
    const r = await fetch(`${url}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${tok}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { data: null, source: "error" };
    const d = await r.json();
    if (d && d.result) {
      try {
        return { data: JSON.parse(d.result), source: "upstash" };
      } catch {
        return { data: null, source: "error" };
      }
    }
    return { data: null, source: "upstash" };
  } catch {
    return { data: null, source: "error" };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }
  // The page polls every 4s during a match — never let an edge cache
  // hold a stale frame.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const { data, source } = await readStore();
  if (!data) {
    return res.json({
      game: "Flow Arena™",
      version: 2,
      liveMode: false,
      status: "idle",
      matchId: null,
      currentRound: 0,
      totalRounds: 0,
      source,
      note: "No live match state in the store — arena.html falls back to the static files.",
    });
  }
  res.setHeader("X-Arena-Source", source);
  return res.json(data);
};
