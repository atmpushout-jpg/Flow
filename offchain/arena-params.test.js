/**
 * Flow Arena — learned-params cutover tests (learning v1, 2026-10-12).
 *
 * Proves the three properties the cutover stands on:
 *  1. FALLBACK IDENTITY — with no params file, PARAMS equals the
 *     production defaults, knob for knob, and those defaults reproduce
 *     the exact literals the brains used before the cutover.
 *  2. LOADED TRUTH — the production arena-learned-params.json loads, and
 *     the learned values (from the verified full-corpus pass) are what
 *     the brains will run.
 *  3. BOUNDS — corrupt files and out-of-bounds values can never push a
 *     fighter outside their persona fence; FLOWX has no knobs at all.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const arena = require("./arena.js");
const learning = require("./arena-learning.js");
const T = arena.__test;

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("  ok", name); }
  catch (e) { failed++; console.log("FAIL", name, "—", e.message); }
}

// 1a. The engine's embedded spec and the learning module agree exactly.
ok("KNOB_SPEC defaults == arena-learning defaultParams()", () => {
  assert.deepStrictEqual(T.defaultKnobParams(), learning.defaultParams());
});

// 1b. Every default reproduces the pre-cutover brain literal it replaced.
ok("defaults reproduce the historical brain literals", () => {
  const d = T.defaultKnobParams();
  // entry sizes (were cash fractions 0.40 / 0.15 / 0.25 / 0.30 / 0.65 / 0.20)
  assert.strictEqual(d.vex.entrySizePct / 100, 0.4);
  assert.strictEqual(d.audrey.entrySizePct / 100, 0.15);
  assert.strictEqual(d.echo.entrySizePct / 100, 0.25);
  assert.strictEqual(d.fade.entrySizePct / 100, 0.3);
  assert.strictEqual(d.longshot.entrySizePct / 100, 0.65);
  assert.strictEqual(d.rook.entrySizePct / 100, 0.2);
  // thresholds and cadences, verbatim from the old brains
  assert.strictEqual(d.vex.requoteCount, 3);
  assert.strictEqual(d.vex.spikeEntryScore, 15);
  assert.strictEqual(d.vex.exitSpikeFloor, 8);
  assert.strictEqual(d.audrey.candidatesScanned, 3);
  assert.strictEqual(d.audrey.verdictScoreFloor, 70);
  assert.strictEqual(d.audrey.reverifyEveryRounds, 3);
  assert.strictEqual(d.echo.signalMaxAgeSec, 900);
  assert.strictEqual(d.echo.holdRounds, 3);
  assert.strictEqual(d.fade.sellFullPct, 5);
  assert.strictEqual(d.fade.sellHalfPct, 2.5);
  assert.strictEqual(d.fade.maxPositions, 3);
  assert.strictEqual(d.longshot.spikeEntryScore, 15);
  assert.strictEqual(d.longshot.shotsPerMatch, 2);
  assert.strictEqual(d.longshot.exitPct, 3);
  assert.strictEqual(d.longshot.lateGateRounds, 3);
  assert.strictEqual(d.rook.stopLossPct, 3);
  assert.strictEqual(d.rook.takeProfitPct, 4);
  assert.strictEqual(d.rook.signalsCheckEvery, 3);
  assert.strictEqual(d.rook.maxPositions, 3);
});

// 1c. Missing file -> defaults, source reported honestly.
ok("missing params file falls back to defaults", () => {
  arena.configure({ paramsFile: "arena-learned-params.__absent__.json", learnedParams: null });
  const meta = T.getParamsMeta();
  assert.strictEqual(meta.source, "defaults");
  assert.strictEqual(meta.learnedKnobs, 0);
  assert.deepStrictEqual(T.getParams(), T.defaultKnobParams());
});

// 2. The production file loads and carries the verified learned values.
ok("production arena-learned-params.json loads the learned knobs", () => {
  arena.configure({ paramsFile: null, learnedParams: null });
  const meta = T.getParamsMeta();
  assert.strictEqual(meta.source, "file");
  assert.deepStrictEqual(meta.rejected, []);
  const p = T.getParams();
  assert.strictEqual(p.vex.requoteCount, 2);
  assert.strictEqual(p.vex.exitSpikeFloor, 7);
  assert.strictEqual(p.audrey.candidatesScanned, 2);
  assert.strictEqual(p.audrey.verdictScoreFloor, 75);
  assert.strictEqual(p.audrey.reverifyEveryRounds, 4);
  assert.strictEqual(p.echo.signalMaxAgeSec, 600);
  assert.strictEqual(p.fade.sellFullPct, 5.5);
  assert.strictEqual(p.fade.sellHalfPct, 3);
  assert.strictEqual(p.fade.entrySizePct, 35);
  assert.strictEqual(p.longshot.spikeEntryScore, 13);
  assert.strictEqual(p.longshot.shotsPerMatch, 3);
  assert.strictEqual(p.longshot.lateGateRounds, 4);
  assert.strictEqual(p.rook.entrySizePct, 22.5);
  assert.strictEqual(p.rook.signalsCheckEvery, 2);
  assert.strictEqual(meta.learnedKnobs, 14);
});

// 2b. Loaded params equal the verified proof artifact, knob for knob.
ok("loaded params == verified full-corpus learned params", () => {
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "goals", "order-flow-auction-protocol-on-base", "hidden_files", "arena-learning-2026-10-12", "learned-params.json"), "utf8"));
  assert.deepStrictEqual(T.getParams(), proof.params);
});

// 3a. Out-of-bounds / wrong-type values are rejected per-knob, never fatal.
ok("out-of-bounds and non-numeric values fall back per-knob", () => {
  const { params, rejected } = T.sanitizeKnobParams({
    vex: { requoteCount: 99, spikeEntryScore: "15" },
    audrey: { verdictScoreFloor: 1000 },
    rook: { entrySizePct: 22.5 },
  });
  assert.strictEqual(params.vex.requoteCount, 3);
  assert.strictEqual(params.vex.spikeEntryScore, 15);
  assert.strictEqual(params.audrey.verdictScoreFloor, 70);
  assert.strictEqual(params.rook.entrySizePct, 22.5); // in-bounds value survives
  assert.strictEqual(rejected.length, 3);
});

// 3b. A crossed FADE exit pair resets both exit knobs to defaults.
ok("crossed FADE exits (half >= full) reset to defaults", () => {
  const { params, rejected } = T.sanitizeKnobParams({ fade: { sellFullPct: 3.5, sellHalfPct: 4 } });
  assert.strictEqual(params.fade.sellFullPct, 5);
  assert.strictEqual(params.fade.sellHalfPct, 2.5);
  assert.ok(rejected.includes("fade.sellHalfPct>=sellFullPct"));
});

// 3c. Corrupt file content falls back to defaults without throwing.
ok("corrupt params file falls back to defaults", () => {
  const tmp = path.join(__dirname, "arena-learned-params.__corrupt__.json");
  fs.writeFileSync(tmp, "{not json");
  try {
    arena.configure({ paramsFile: "arena-learned-params.__corrupt__.json", learnedParams: null });
    assert.strictEqual(T.getParamsMeta().source, "defaults");
    assert.deepStrictEqual(T.getParams(), T.defaultKnobParams());
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
    arena.configure({ paramsFile: null, learnedParams: null }); // restore production load
  }
});

// 3d. FLOWX is not a learned fighter — no knobs exist for it, and a
// flowx block in a params file is ignored entirely.
ok("FLOWX has no knobs and cannot be given any", () => {
  assert.ok(!("flowx" in T.KNOB_SPEC));
  assert.ok(!("flowx" in T.defaultKnobParams()));
  const { params } = T.sanitizeKnobParams({ flowx: { entrySizePct: 99 } });
  assert.ok(!("flowx" in params));
});

// 4. The training pass is gated to counted matches only.
ok("postMatchTraining is a no-op outside counted matches", () => {
  arena.configure({ paramsFile: null, learnedParams: null, liveMode: false, reserve: false });
  assert.strictEqual(T.postMatchTraining(), null);
  arena.configure({ liveMode: true, reserve: false }); // floor/exhibition signature
  assert.strictEqual(T.postMatchTraining(), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
