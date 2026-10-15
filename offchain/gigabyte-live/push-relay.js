#!/usr/bin/env node
'use strict';
/*
 * GIGABYTE push relay — forwards the local live room to the Flow site.
 *
 * The show runs on this VM (server.js, http://localhost:7199). Atm's
 * networks filter the free tunnel domains, so the audience door is
 * https://flow-kg4x.vercel.app/gigabyte.html, fed by:
 *   POST https://flow-kg4x.vercel.app/api/gigabyte-push
 * This loop polls the local state every ~3s and pushes every new
 * transcript line (with its MP3) plus the full show state; it re-posts
 * the state alone every ~30s as a self-heal (keeps the stored state
 * inside its TTL and carries phase changes between lines).
 *
 * AUTH: the push key is read from ~/.config/gigabyte_push_key (600).
 * It is sent only as the x-gigabyte-key header over HTTPS — never
 * logged, never in argv, never written anywhere else. The server
 * stores only sha256(key). BOOTSTRAP: if the server answers 401/503
 * "not bootstrapped", this relay claims the hash once (same payload +
 * {bootstrap:true, keyHash}) and retries; if the hash was claimed by
 * anyone else, the claim 409s and pushes keep failing loudly in the log.
 *
 * Watermark: hidden_files/gigabyte-live/push-watermark.json
 *   {session, lastPushedId, skipped:[ids with no local mp3]}
 * Log: hidden_files/gigabyte-live/push-relay.log
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME = process.env.HOME || '/home/hatch';
const LOCAL_STATE = 'http://localhost:7199/api/state';
const AUDIO_DIR = path.join(HOME, 'workspace/goals/flow-earning-daily/hidden_files/gigabyte-live/audio');
const RUNTIME_DIR = path.join(HOME, 'workspace/goals/flow-earning-daily/hidden_files/gigabyte-live');
const WATERMARK_FILE = path.join(RUNTIME_DIR, 'push-watermark.json');
const LOG_FILE = path.join(RUNTIME_DIR, 'push-relay.log');
const KEY_FILE = path.join(HOME, '.config/gigabyte_push_key');
const PUSH_URL = 'https://flow-kg4x.vercel.app/api/gigabyte-push';
const POLL_MS = 3000;
const SELF_HEAL_MS = 30000;
const MAX_STATE_TRANSCRIPT = 40; // the hosted page needs recent history, not the archive
const MAX_BATCH_B64 = 2500000; // stay well under the platform body limit

const PUSH_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const KEY_HASH = crypto.createHash('sha256').update(PUSH_KEY, 'utf8').digest('hex');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}

function loadWatermark() {
  try {
    const w = JSON.parse(fs.readFileSync(WATERMARK_FILE, 'utf8'));
    return { session: w.session || null, lastPushedId: w.lastPushedId || 0, skipped: w.skipped || [] };
  } catch {
    return { session: null, lastPushedId: 0, skipped: [] };
  }
}
function saveWatermark(w) {
  const tmp = WATERMARK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w));
  fs.renameSync(tmp, WATERMARK_FILE);
}

function fetchLocalState() {
  return new Promise((resolve, reject) => {
    const req = http.get(LOCAL_STATE, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`local state HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('local state timeout')));
  });
}

async function postPush(payload, useBootstrap) {
  const body = useBootstrap ? { ...payload, bootstrap: true, keyHash: KEY_HASH } : payload;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gigabyte-key': PUSH_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

function relayState(local) {
  // Trim to recent history and point every line at the hosted audio door.
  const t = Array.isArray(local.transcript) ? local.transcript.slice(-MAX_STATE_TRANSCRIPT) : [];
  const rewrite = (l) => (l ? { ...l, audioUrl: `/api/gigabyte-audio?id=${l.id}` } : l);
  return { ...local, transcript: t.map(rewrite), currentLine: rewrite(local.currentLine) };
}

let wm = loadWatermark();
let lastHealAt = 0;
let lastStateFingerprint = '';
let bootstrapped = false;

async function tick() {
  let local;
  try {
    local = await fetchLocalState();
  } catch (e) {
    log(`local state unavailable: ${e.message}`);
    return;
  }
  if (!local || !local.startedAt) return;

  if (wm.session !== local.startedAt) {
    log(`new show session ${local.startedAt} (was ${wm.session}) — watermark reset`);
    wm = { session: local.startedAt, lastPushedId: 0, skipped: [], edgeInitialized: false };
    saveWatermark(wm);
  }

  // Start at the live edge, not the archive: the show keeps only the
  // newest ~40 mp3s on disk, so backfilling from line 1 chases files
  // that prune away mid-flight. Jump to a few lines behind the newest
  // one and keep pace from there — the state push still carries the
  // full recent transcript as text for the hosted page's history.
  if (!wm.edgeInitialized) {
    const all = local.transcript || [];
    const newest = all.length ? all[all.length - 1].id : 0;
    wm.lastPushedId = Math.max(0, newest - 6);
    wm.edgeInitialized = true;
    saveWatermark(wm);
    log(`edge initialized at line ${wm.lastPushedId} (newest ${newest})`);
  }

  // New lines: in the transcript, ahead of the watermark, mp3 on disk.
  const skippedSet = new Set(wm.skipped);
  const fresh = (local.transcript || [])
    .filter((l) => l.id > wm.lastPushedId && !skippedSet.has(l.id))
    .sort((a, b) => a.id - b.id);

  const batch = [];
  let batchB64 = 0;
  const newestId = fresh.length ? fresh[fresh.length - 1].id : 0;
  let watermarkDirty = false;
  for (const line of fresh) {
    const file = path.join(AUDIO_DIR, path.basename(line.audioUrl || ''));
    if (!line.audioUrl || !fs.existsSync(file)) {
      // The show prunes its audio dir (keeps the newest ~40 lines), so a
      // missing mp3 for any line that is no longer near the head is gone
      // for good: skip it permanently (the hosted page shows the line as
      // text and moves on) instead of deadlocking the whole feed behind it.
      const laterExists = (local.transcript || []).some(
        (l) => l.id > line.id && l.audioUrl && fs.existsSync(path.join(AUDIO_DIR, path.basename(l.audioUrl)))
      );
      if (laterExists || line.id <= newestId - 2) {
        wm.skipped.push(line.id);
        wm.lastPushedId = line.id;
        watermarkDirty = true;
        log(`line ${line.id}: mp3 pruned locally — skipping permanently`);
        continue;
      }
      log(`line ${line.id}: no local mp3 yet (${line.audioUrl || 'no audioUrl'}) — will retry`);
      break; // newest line may still be rendering: keep order, retry next tick
    }
    const b64 = fs.readFileSync(file).toString('base64');
    if (batch.length >= 8) break; // endpoint accepts at most 10 lines per push
    if (batch.length && batchB64 + b64.length > MAX_BATCH_B64) break;
    batch.push({ id: line.id, member: line.member, mp3b64: b64 });
    batchB64 += b64.length;
  }
  if (watermarkDirty) saveWatermark(wm);

  const state = relayState(local);
  const fingerprint = JSON.stringify([local.cycle, local.phase, local.speaker, local.currentLine && local.currentLine.id, state.transcript.length]);
  const healDue = Date.now() - lastHealAt >= SELF_HEAL_MS;

  if (!batch.length && !healDue && fingerprint === lastStateFingerprint) return;
  if (!batch.length && !healDue) return;

  const payload = { state, lines: batch };
  let res;
  try {
    res = await postPush(payload, false);
    if ((res.status === 401 || res.status === 503) && !bootstrapped) {
      log(`push answered ${res.status} (${res.json && res.json.error}) — attempting one-time bootstrap claim`);
      res = await postPush(payload, true);
      if (res.status === 200) {
        bootstrapped = true;
        log('bootstrap claim accepted — push key hash is ours');
      } else {
        log(`bootstrap FAILED: ${res.status} ${res.text}`);
      }
    }
  } catch (e) {
    log(`push request failed: ${e.message}`);
    return;
  }

  if (res.status !== 200) {
    log(`push rejected: ${res.status} ${res.text}`);
    return;
  }
  bootstrapped = true;
  lastHealAt = Date.now();
  lastStateFingerprint = fingerprint;
  if (batch.length) {
    wm.lastPushedId = batch[batch.length - 1].id;
    saveWatermark(wm);
    log(`pushed state + lines [${batch.map((b) => b.id).join(',')}] (cycle ${local.cycle}, phase ${local.phase})`);
  }
}

log(`gigabyte push relay starting — local ${LOCAL_STATE} -> ${PUSH_URL}`);
(async () => {
  for (;;) {
    try { await tick(); } catch (e) { log(`tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
