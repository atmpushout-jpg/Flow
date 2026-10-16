/* =====================================================================
   GIGABYTE STAGE — feed + playback driver
   Polls the show state, plays each new line's audio through one shared
   AudioContext, drives the speaker's mouth from the Rhubarb viseme
   track (falling back to live amplitude), and runs the caption bar.
   Lines from cast members who are not on stage yet (Phase 2) still get
   captions; the on-stage cast turns toward the "door" for them.
   ===================================================================== */
import { CONFIG, Stage, showFallback, fallbackSetSpeaker } from './stage.js';

const $ = (id) => document.getElementById(id);
const CAST_NAMES = { FLOWEXECUTOR: 'LIL GIG', MISTY: 'MISTY', FADE: 'FADE', K1N9: 'K1N9', PYRE: 'PYRE', PUSHOUT: 'PUSHOUT' };
// Rhubarb mouth shapes -> VRM viseme weights (five-shape approximation)
const RHUBARB_MAP = {
  A: { aa: 0.00, ih: 0.00, ou: 0.00, ee: 0.00, oh: 0.00 },  // closed (M/B/P, silence-ish)
  B: { aa: 0.22, ih: 0.10, ou: 0.00, ee: 0.38, oh: 0.00 },  // consonants (K/S/T/D/N…)
  C: { aa: 0.10, ih: 0.18, ou: 0.00, ee: 0.85, oh: 0.00 },  // EE
  D: { aa: 0.92, ih: 0.00, ou: 0.00, ee: 0.05, oh: 0.10 },  // AA/AH open
  E: { aa: 0.18, ih: 0.00, ou: 0.10, ee: 0.00, oh: 0.85 },  // O/OH round
  F: { aa: 0.00, ih: 0.05, ou: 0.90, ee: 0.00, oh: 0.12 },  // OO/W pucker
  G: { aa: 0.06, ih: 0.55, ou: 0.00, ee: 0.22, oh: 0.00 },  // F/V (teeth on lip -> ih-ish)
  H: { aa: 0.42, ih: 0.10, ou: 0.00, ee: 0.10, oh: 0.00 },  // L (tongue up, half open)
  X: { aa: 0.00, ih: 0.00, ou: 0.00, ee: 0.00, oh: 0.00 },  // silence
};
const SILENCE = RHUBARB_MAP.X;

export class Feed {
  constructor(stage) {
    this.stage = stage;                 // may be null in fallback mode
    this.lastLineId = 0;
    this.lastSpoken = null;             // last line that aired (caption holds it between lines)
    this.queue = [];
    this.playing = null;                // { line, audio, src, visemes, mode, startedAt }
    this.audioCtx = null;
    this.analyser = null;
    this.analyserData = null;
    this.soundEnabled = false;
    this.seenFeed = false;
    this._raf = null;
  }

  /* ---------- audio plumbing ---------- */
  enableSound() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyserData = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.audioCtx.destination);
    }
    this.audioCtx.resume();
    this.soundEnabled = true;
    $('soundGate').classList.remove('show');
    this._pump();
  }
  needsSoundGate() { return !this.soundEnabled; }

  _makeAudio(url) {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    if (this.audioCtx && this.analyser) {
      try {
        const src = this.audioCtx.createMediaElementSource(el);
        src.connect(this.analyser);
      } catch { /* element already wired / CORS — element still plays via default output if ctx absent */ }
    }
    return el;
  }

  /* ---------- feed polling ---------- */
  async poll() {
    try {
      const r = await fetch(CONFIG.stateUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error(`state ${r.status}`);
      const st = await r.json();
      this.seenFeed = true;
      $('liveBadge').classList.add('on');
      $('liveText').textContent = 'LIVE';
      $('hudFeed').textContent = `cycle ${st.cycle ?? '—'} · ${st.phase ?? ''}`;
      const line = st.currentLine;
      if (line && line.id > this.lastLineId) {
        // catch up: enqueue every transcript line newer than what we played
        const newer = (st.transcript || []).filter((l) => l.id > this.lastLineId);
        const fresh = newer.length ? newer : [line];
        for (const l of fresh) {
          if (l.id <= this.lastLineId) continue;
          this.lastLineId = l.id;
          // skip stale lines (page opened mid-show): only play the newest one
          const age = Date.now() - (l.at || 0);
          this.queue.push({ line: l, silent: age > 45000 && l.id !== line.id });
        }
        this._pump();
      }
    } catch (e) {
      $('hudFeed').textContent = 'unreachable';
      $('liveText').textContent = 'FEED DOWN';
      $('liveBadge').classList.remove('on');
    }
  }

  async enqueueById(id, memberHint) {
    // used by ?testline= : pull the line from the transcript if present, else synthesize
    try {
      const r = await fetch(CONFIG.stateUrl, { cache: 'no-store' });
      const st = await r.json();
      const line = (st.transcript || []).find((l) => l.id === id) || st.currentLine;
      if (line) { this.queue.push({ line, silent: false, force: true }); this._pump(); return true; }
    } catch { /* fall through */ }
    if (memberHint) {
      this.queue.push({ line: { id, member: memberHint, text: '(test line)', at: Date.now() }, silent: false, force: true });
      this._pump(); return true;
    }
    return false;
  }

  /* ---------- visemes ---------- */
  async _fetchVisemes(id) {
    try {
      const r = await fetch(CONFIG.visemeUrl(id), { cache: 'force-cache' });
      if (!r.ok) return null;
      const j = await r.json();
      if (j && Array.isArray(j.mouthCues) && j.mouthCues.length) return j.mouthCues;
      return null;
    } catch { return null; }
  }

  _mouthAt(cues, tSec) {
    // binary search the cue covering tSec
    let lo = 0, hi = cues.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tSec < cues[mid].start) hi = mid - 1;
      else if (tSec >= cues[mid].end) lo = mid + 1;
      else { ans = cues[mid]; break; }
    }
    return ans ? (RHUBARB_MAP[ans.value] || SILENCE) : SILENCE;
  }

  /* ---------- playback ---------- */
  async _pump() {
    if (this.playing || !this.queue.length) return;
    const item = this.queue.shift();
    const { line } = item;
    const onStage = !!this.stage && !!this.stage.chars[line.member];
    this._caption(line);
    if (this.stage) {
      const addressed = this._addresseeOf(line);
      this.stage.setSpeaker(onStage ? line.member : null, addressed);
      if (!onStage) this.stage.setSpeaker(null, 'DOOR'); // offstage voice: cast looks to the door
    } else {
      fallbackSetSpeaker(onStage ? line.member : null);
    }
    $('hudLine').textContent = `#${line.id} ${line.member}`;

    if (item.silent || !onStage && !item.force) {
      // caption-only beat for offstage members / stale lines: hold roughly reading time
      const hold = item.silent ? 350 : clamp(1200 + (line.text || '').length * 28, 2000, 9000);
      this.playing = { line, mode: 'caption', until: performance.now() + hold };
      setTimeout(() => { this.playing = null; this._afterLine(); }, hold);
      return;
    }

    // on-stage line: fetch visemes + audio, then play
    const [cues] = await Promise.all([this._fetchVisemes(line.id)]);
    const audio = this._makeAudio(CONFIG.audioUrl(line.id));
    this.playing = { line, audio, cues, mode: cues ? 'viseme' : 'amplitude', startedAt: null };
    $('hudSync').textContent = cues ? 'VISEME' : 'AMPLITUDE';
    $('hudSync').className = cues ? 'ok' : 'warn';
    const finish = () => { if (this.playing && this.playing.audio === audio) { this.playing = null; this._afterLine(); } };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', () => {
      // audio missing (relay race/TTL): fall back to a text-timed silent performance
      if (this.playing && this.playing.audio === audio) {
        this.playing.mode = 'text';
        $('hudSync').textContent = 'TEXT (no audio)';
        const dur = clamp((line.durationMs || (line.text || '').length * 65), 2500, 60000);
        setTimeout(finish, dur);
        this._textEnvelope(line);
      }
    });
    try {
      await audio.play();
      this.playing.startedAt = performance.now();
      this._driveMouth();
    } catch {
      // autoplay blocked: show the sound gate; keep the line queued at head
      this.playing = null;
      this.queue.unshift(item);
      if (this.needsSoundGate()) $('soundGate').classList.add('show');
    }
  }

  _textEnvelope(line) {
    // pseudo mouth envelope for text-mode lines: word-length bumps
    const words = (line.text || '').split(/\s+/).filter(Boolean);
    let i = 0;
    const step = () => {
      if (!this.playing || this.playing.line !== line) return;
      const w = words[i++] || '';
      if (this.stage) this.stage.setMouthAmp(line.member, clamp(0.25 + w.length * 0.07, 0, 0.9));
      if (i < words.length) setTimeout(step, 300);
      else if (this.stage) this.stage.setMouthAmp(line.member, 0);
    };
    step();
  }

  _driveMouth() {
    const loop = () => {
      const p = this.playing;
      if (!p || !p.audio) { this._raf = null; return; }
      const rig = this.stage && this.stage.chars[p.line.member];
      if (rig && p.mode !== 'text') {
        const t = p.audio.currentTime || 0;
        if (p.mode === 'viseme' && p.cues) {
          this.stage.setMouth(p.line.member, this._mouthAt(p.cues, t));
          this.stage.setMouthAmp(p.line.member, 0); // visemes carry it
        } else if (this.analyser && this.analyserData) {
          this.analyser.getFloatTimeDomainData(this.analyserData);
          let sum = 0; for (let i = 0; i < this.analyserData.length; i += 2) sum += this.analyserData[i] * this.analyserData[i];
          const rms = Math.sqrt(sum / (this.analyserData.length / 2));
          const v = clamp(rms * 3.4, 0, 1);
          this.stage.setMouthAmp(p.line.member, v);
          if (v > 0.62) rig.nod();
        }
      }
      this._raf = requestAnimationFrame(loop);
    };
    if (!this._raf) this._raf = requestAnimationFrame(loop);
  }

  _afterLine() {
    if (this.stage) { this.stage.setSpeaker(null); }
    else fallbackSetSpeaker(null);
    $('hudSync').textContent = '—';
    if (!this.queue.length) {
      // between lines the room panel HOLDS the last line spoken (with its
      // speaker) instead of dropping to a bare "Listening…" void
      const last = this.lastSpoken;
      if (last) {
        $('capWho').textContent = CAST_NAMES[last.member] || last.member;
        $('capWho').classList.toggle('misty', last.member === 'MISTY');
        $('capWhat').textContent = last.text || '';
      } else {
        $('capWho').textContent = 'THE ROOM';
        $('capWhat').textContent = 'Listening for the next line…';
      }
      $('caption').classList.add('idle');
    }
    this._pump();
  }

  _caption(line) {
    $('caption').classList.remove('idle');
    this.lastSpoken = line;
    const who = $('capWho');
    who.textContent = CAST_NAMES[line.member] || line.member;
    who.classList.toggle('misty', line.member === 'MISTY');
    $('capWhat').textContent = line.text || '';
    // the speech panel rides to the speaking anchor's side of the stage:
    // host (Lil Gig) holds the left, MISTY the right, offstage voices center
    const cap = $('caption');
    cap.classList.toggle('cap-host', line.member === 'FLOWEXECUTOR');
    cap.classList.toggle('cap-misty', line.member === 'MISTY');
    cap.classList.toggle('cap-center', line.member !== 'FLOWEXECUTOR' && line.member !== 'MISTY');
  }

  _addresseeOf(line) {
    // "MISTY, you opened…" / "Flowexecutor, yeah…" — debate lines open by naming the addressee
    const m = /^\s*([A-Za-z0-9]+)\s*,/.exec(line.text || '');
    if (!m) return 'CAMERA';
    const name = m[1].toUpperCase();
    if (name === line.member) return 'CAMERA';
    if (name === 'FLOWEXECUTOR' || name === 'MISTY' || name === 'LIL' || name === 'GIG') return 'PARTNER';
    return 'CAMERA';
  }
}

/* =====================================================================
   BOOT
   ===================================================================== */
async function boot() {
  let stage = null;
  try {
    stage = await new Stage($('stage')).init();
    stage.onStats = (s) => {
      $('hudFps').textContent = s.fps;
      $('hudTris').textContent = s.tris.toLocaleString();
      $('hudCalls').textContent = s.calls;
      $('hudQuality').textContent = stage.quality.toUpperCase() + (s.prLevel ? ` · PR${s.prLevel}` : '');
    };
  } catch (e) {
    showFallback(e.message);
  }
  const feed = new Feed(stage);
  window.__stage = { stage, feed, CONFIG };
  $('soundBtn').addEventListener('click', () => feed.enableSound());
  // headless/automated contexts: try to enable sound without a gesture (may still need the tap)
  if (CONFIG.testLine) { try { feed.enableSound(); } catch { /* gate stays */ } }
  $('btnQuality').addEventListener('click', (ev) => {
    if (!stage) return;
    const order = ['auto', 'high', 'low'];
    const next = order[(order.indexOf(stage.quality) + 1) % order.length];
    stage.setQuality(next);
    ev.currentTarget.textContent = `QUALITY: ${next.toUpperCase()}`;
    ev.currentTarget.setAttribute('aria-pressed', next !== 'auto');
  });
  $('btnFallback').addEventListener('click', () => {
    const on = !$('fallback').classList.contains('show');
    if (on) showFallback('manual toggle'); else location.reload();
  });
  await feed.poll();
  setInterval(() => feed.poll(), CONFIG.pollMs);
  if (CONFIG.testLine) {
    const st = await (await fetch(CONFIG.stateUrl)).json().catch(() => null);
    const line = st && (st.transcript || []).find((l) => l.id === CONFIG.testLine);
    feed.enqueueById(CONFIG.testLine, line ? line.member : 'MISTY');
  }
}
boot();
