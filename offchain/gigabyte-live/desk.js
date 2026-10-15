'use strict';
/*
 * desk.js — the LIVE DESK digest for the GIGABYTE room.
 *
 * One digest, two consumers: the push relay attaches it to the hosted
 * state (gigabyte.html renders it as the desk panel above the cast), and
 * the show server leads every brain prompt with it — so the cast talks
 * off the exact dashboard the audience is looking at.
 *
 * Market data path is the forex desk's own (offchain/forex-desk.js):
 * the Dukascopy-derived 1m tape the pattern watch builds
 * (~/workspace/tmp-work/forex-lane/data), decoded BID/ASK -> MID and
 * aggregated into closed 15m buckets by the same Python construction,
 * and the same indicator math (Alligator SMMA 13/8/5 shifted +8/+5/+3
 * on median price, Wilder RSI(14)) computed on the same last-64-bucket
 * series the desk page charts. Lane records (tallies, open positions)
 * come from records.js — the same watcher/runner state files — with
 * units/entry joined from the runners' own RECONCILE log lines, exactly
 * as the forex desk page joins them. Nothing here invents a number.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const records = require('./records');

const HOME = os.homedir();
const HF = path.join(HOME, 'workspace/goals/flow-earning-daily/hidden_files');
const LANE_DATA = path.join(HOME, 'workspace/tmp-work/forex-lane/data');

const PAIRS = [
  { id: 'EUR_USD', tape: 'EURUSD', label: 'EUR/USD', dp: 5 },
  { id: 'GBP_USD', tape: 'GBPUSD', label: 'GBP/USD', dp: 5 },
  { id: 'USD_JPY', tape: 'USDJPY', label: 'USD/JPY', dp: 3 },
];

/* --- tape decode: verbatim construction from offchain/forex-desk.js --- */
const PY_DECODER = `
import sys, os, lzma, struct, json
from datetime import date, datetime, timezone
DATA = sys.argv[1]
FX = {'EURUSD': 100000, 'GBPUSD': 100000, 'USDJPY': 1000}
def decode(p):
    raw = lzma.decompress(open(p, 'rb').read())
    bars = {}
    for off in range(0, len(raw) - 23, 24):
        t, o, c, l, h, v = struct.unpack('>5if', raw[off:off + 24])
        bars[t] = (o, c, l, h)
    return bars
out = {}
try:
    files = sorted(os.listdir(DATA))
except Exception:
    files = []
for pair, div in FX.items():
    days = sorted(f for f in files if f.startswith('duka_' + pair + '_BID_') and f.endswith('.bi5'))[-2:]
    minutes = {}
    for fn in days:
        mmdd = fn[-8:-4]
        try:
            d = date(2026, int(mmdd[:2]), int(mmdd[2:]))
        except ValueError:
            continue
        base = int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())
        try:
            bid = decode(os.path.join(DATA, fn))
        except Exception:
            continue
        ask = {}
        afn = os.path.join(DATA, fn.replace('_BID_', '_ASK_'))
        if os.path.exists(afn):
            try:
                ask = decode(afn)
            except Exception:
                ask = {}
        for t, (o, c, l, h) in bid.items():
            a = ask.get(t)
            if a:
                minutes[base + t] = (base + t, (o + a[0]) / 2 / div, (c + a[1]) / 2 / div, (l + a[2]) / 2 / div, (h + a[3]) / 2 / div)
            else:
                minutes[base + t] = (base + t, o / div, c / div, l / div, h / div)
    mins = sorted(minutes.values())
    have = set(m[0] for m in mins)
    buckets = {}
    for (t, o, c, l, h) in mins:
        k = t - (t % 900)
        cur = buckets.get(k)
        if cur is None:
            buckets[k] = [k, o, h, l, c]
        else:
            cur[2] = max(cur[2], h); cur[3] = min(cur[3], l); cur[4] = c
    out[pair] = [buckets[k] for k in sorted(buckets) if k in have and (k + 840) in have]
print(json.dumps(out))
`;
function loadSeries() {
  const raw = execFileSync('python3', ['-c', PY_DECODER, LANE_DATA], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }).toString();
  const parsed = JSON.parse(raw);
  const series = {};
  for (const p of PAIRS) {
    series[p.id] = (parsed[p.tape] || []).map(([t, o, h, l, c]) => ({ t, o, h, l, c })).slice(-64);
  }
  return series;
}

/* --- indicators: same math as offchain/forex-desk.js computeIndicators --- */
function smaArr(vals, n) {
  const out = new Array(vals.length).fill(null);
  let run = 0;
  for (let i = 0; i < vals.length; i++) {
    run += vals[i];
    if (i >= n) run -= vals[i - n];
    if (i >= n - 1) out[i] = run / n;
  }
  return out;
}
function smmaArr(vals, n) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += vals[i];
  out[n - 1] = seed / n;
  for (let i = n; i < vals.length; i++) out[i] = (out[i - 1] * (n - 1) + vals[i]) / n;
  return out;
}
function rsiArr(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
const lastOf = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
function pairIndicators(candles) {
  const closes = candles.map((c) => c.c);
  const med = candles.map((c) => (c.h + c.l) / 2);
  const shifted = (arr, by) => candles.map((_, i) => (i - by >= 0 ? arr[i - by] : null));
  const jaw = lastOf(shifted(smmaArr(med, 13), 8));
  const teeth = lastOf(shifted(smmaArr(med, 8), 5));
  const lips = lastOf(shifted(smmaArr(med, 5), 3));
  const rsi = lastOf(rsiArr(closes, 14));
  let gator = 'TANGLED';
  if (jaw != null && teeth != null && lips != null) {
    if (lips > teeth && teeth > jaw) gator = 'BULLISH';
    else if (lips < teeth && teeth < jaw) gator = 'BEARISH';
  }
  return { jaw, teeth, lips, gator, rsi };
}

/* --- open-position enrichment: RECONCILE entries from the runner logs ---
 * Same whitelisted extraction the forex desk page uses; log error lines
 * (which embed a broker URL) never match and never leave this process. */
const RE_ENTRY = /(\S+) open trade (\d+) units (-?\d+) price (\d+(?:\.\d+)?)/;
function readTail(file, bytes = 400000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
const LANE_LOGS = { MISTY: 'oanda-misty-live.log', PYRE: 'oanda-pyre-live.log', K1N9: 'oanda-k1n9-live.log', VOLT: 'oanda-volt-live.log' };
function entryByTrade(member) {
  const map = new Map();
  const log = LANE_LOGS[member];
  if (!log) return map;
  for (const line of readTail(path.join(HF, log)).split('\n')) {
    if (!line.includes(' | RECONCILE | ')) continue;
    const m = line.match(RE_ENTRY);
    if (m) map.set(m[2], { units: parseInt(m[3], 10), entry: parseFloat(m[4]) });
  }
  return map;
}

/* --- the digest (tape decode cached: the tape moves in 15m buckets) --- */
const TAPE_CACHE_MS = 90000;
let tapeCache = { atMs: 0, series: null };
function getSeries() {
  if (tapeCache.series && Date.now() - tapeCache.atMs < TAPE_CACHE_MS) return tapeCache.series;
  const series = loadSeries();
  tapeCache = { atMs: Date.now(), series };
  return series;
}

function readDeskDigest() {
  const d = records.readDigest();
  let series = {};
  try { series = getSeries(); } catch { series = {}; }
  const pairs = PAIRS.map((p) => {
    const candles = series[p.id] || [];
    const ind = candles.length ? pairIndicators(candles) : { jaw: null, teeth: null, lips: null, gator: 'TANGLED', rsi: null };
    const round = (v) => (v == null ? null : Math.round(v * 100000) / 100000);
    return {
      id: p.id, label: p.label, dp: p.dp,
      last: candles.length ? candles[candles.length - 1].c : null,
      tapeAt: candles.length ? new Date(candles[candles.length - 1].t * 1000).toISOString() : null,
      regime15: d.patterns.regimes[`${p.label}|15m`] || null,
      regime1h: d.patterns.regimes[`${p.label}|1h`] || null,
      rsi: ind.rsi != null ? Math.round(ind.rsi * 10) / 10 : null,
      gator: ind.gator,
      gatorLines: { jaw: round(ind.jaw), teeth: round(ind.teeth), lips: round(ind.lips) },
      closes: candles.map((c) => Math.round(c.c * Math.pow(10, p.dp)) / Math.pow(10, p.dp)),
    };
  });
  const entries = {};
  const lanes = Object.keys(d.lanes).map((member) => {
    const l = d.lanes[member];
    if (!entries[member]) entries[member] = entryByTrade(member);
    return {
      member, wins: l.wins, losses: l.losses, closed: l.closed, pnl: l.pnl,
      open: l.open.map((o) => {
        const e = entries[member].get(String(o.tradeId));
        return {
          pair: o.pair, dir: o.dir, tradeId: o.tradeId, openedAt: o.openedAt,
          units: e ? e.units : null, entry: e ? e.entry : null,
        };
      }),
    };
  });
  // Spike calls for the panel: every still-open/due call (EDEL among
  // them until it grades) plus the most recent graded one, oldest first.
  const shapeCall = (c) => ({
    member: c.member, symbol: c.symbol, direction: c.direction,
    priceAtCall: c.priceAtCall, gradeAt: c.gradeAt,
    gradeAtET: records.easternClock(c.gradeAt),
    status: c.status, minsToGrade: c.minsToGrade, grade: c.grade,
  });
  const calls = d.spikes.calls || [];
  const active = calls.filter((c) => c.status === 'open' || c.status === 'due').map(shapeCall);
  const graded = calls.filter((c) => c.status === 'graded');
  const spikes = graded.length ? [...active, shapeCall(graded[graded.length - 1])] : active;
  return {
    atMs: Date.now(), eastern: d.eastern,
    pairs, lanes, spikes,
    forming: d.patterns.forming || [],
    patternsUpdatedAt: d.patterns.updatedAt || null,
  };
}

/* Compact one-block summary for brain prompts — the desk, in words. */
function deskSummary(dd) {
  if (!dd) return '';
  const px = (p) => (p.last == null ? '?' : p.last.toFixed(p.dp));
  const parts = ['THE LIVE DESK (the same dashboard the audience sees):'];
  parts.push(dd.pairs.map((p) =>
    `${p.label} ${px(p)} · 15m ${p.regime15 || '?'} · RSI ${p.rsi == null ? '?' : p.rsi.toFixed(1)} · alligator ${String(p.gator).toLowerCase()}`
  ).join(' | '));
  parts.push('Lanes: ' + dd.lanes.map((l) =>
    `${l.member} ${l.wins}W-${l.losses}L ${records.money(l.pnl)} today` +
    (l.open.length ? ' · open ' + l.open.map((o) => `${o.pair} ${o.dir}${o.units != null ? ' ' + Math.abs(o.units) + 'u' : ''}${o.entry != null ? ' @ ' + o.entry : ''}`).join(', ') : ' · flat')
  ).join(' ; '));
  for (const s of dd.spikes || []) {
    parts.push(s.status === 'graded' && s.grade
      ? `Spike desk: ${s.member}'s ${s.symbol} ${s.direction} call from $${records.price(s.priceAtCall)} GRADED ${s.grade.result} (moved ${s.grade.movePct}% to $${records.price(s.grade.priceAtGrade)}).`
      : `Spike desk: ${s.member}'s ${s.symbol} ${s.direction} call from $${records.price(s.priceAtCall)} is ${s.status === 'due' ? 'at its grade time — grade posting' : `open, grading at ${s.gradeAtET}`}.`);
  }
  return parts.join('\n');
}

module.exports = { readDeskDigest, deskSummary, pairIndicators, loadSeries, PAIRS };
