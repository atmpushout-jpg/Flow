// In-memory usage counter (per serverless instance).
// Approximate by design: resets on cold start, separate per region/instance.
// A poller aggregates these into trend data. Zero external deps, zero signup.
const started = Date.now();
let quotes = 0;
let errors = 0;

module.exports = {
  trackQuote() { quotes++; },
  trackError() { errors++; },
  snapshot() {
    return {
      quotesServed: quotes,
      errors,
      instanceStarted: new Date(started).toISOString(),
      uptimeSec: Math.round((Date.now() - started) / 1000),
      note: "Per-instance approximate counter. Resets on cold start.",
    };
  },
};
