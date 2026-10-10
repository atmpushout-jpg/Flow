// Shared usage counter for the Flow quote API.
//
// Why this exists: on Vercel every API route is a separate serverless
// function with its own memory. An in-memory counter incremented by
// /api/quote can never be seen by /api/stats, so the stats endpoint
// always reported 0 no matter how much traffic arrived. Counts must
// live in a shared store.
//
// Store: Upstash Redis over plain HTTPS (free tier, no npm deps).
// Set these two Vercel env vars to enable shared counting:
//   UPSTASH_REDIS_REST_URL    e.g. https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  the REST token from the Upstash dashboard
// Without them, everything falls back to in-memory per-instance counters
// (approximate, resets on cold start) — same as the old behavior.

const STORE_URL = process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_STORE = Boolean(STORE_URL && STORE_TOKEN);

const KEY_QUOTES = "flow:quotes";
const KEY_ERRORS = "flow:errors";
const TIMEOUT_MS = 1500;

const started = Date.now();
let memQuotes = 0;
let memErrors = 0;

async function storeCall(path, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${STORE_URL}${path}`, {
      method: method || "GET",
      headers: { Authorization: `Bearer ${STORE_TOKEN}` },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`store responded ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function memBump(key) {
  if (key === KEY_QUOTES) memQuotes++;
  else memErrors++;
}

async function bump(key) {
  if (!HAS_STORE) {
    memBump(key);
    return;
  }
  try {
    await storeCall(`/incr/${key}`, "POST");
  } catch {
    // Store unreachable: count in memory rather than breaking the quote.
    memBump(key);
  }
}

async function snapshot() {
  const base = {
    instanceStarted: new Date(started).toISOString(),
    uptimeSec: Math.round((Date.now() - started) / 1000),
  };
  if (!HAS_STORE) {
    return {
      quotesServed: memQuotes,
      errors: memErrors,
      store: "memory",
      note: "Per-instance approximate counter. Resets on cold start. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for shared counts.",
      ...base,
    };
  }
  try {
    const d = await storeCall(`/mget/${KEY_QUOTES}/${KEY_ERRORS}`, "POST");
    const vals = (d && d.result) || [];
    return {
      quotesServed: parseInt(vals[0] || "0", 10) || 0,
      errors: parseInt(vals[1] || "0", 10) || 0,
      store: "upstash",
      note: "Shared counter across all instances.",
      ...base,
    };
  } catch {
    return {
      quotesServed: memQuotes,
      errors: memErrors,
      store: "memory (shared store unreachable)",
      note: "Shared store unreachable; showing this instance only.",
      ...base,
    };
  }
}

module.exports = {
  trackQuote: () => bump(KEY_QUOTES),
  trackError: () => bump(KEY_ERRORS),
  snapshot,
};
