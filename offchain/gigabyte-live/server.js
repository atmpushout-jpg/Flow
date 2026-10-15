#!/usr/bin/env node
'use strict';
/*
 * GIGABYTE — live interface for the Flow Cast room.
 *
 * A self-contained Node HTTP server (built-in modules only) that runs a real,
 * turn-by-turn AI podcast in the browser, CONTINUOUSLY: the show never ends
 * after the opening segments. Every cycle the runner re-reads the current
 * desk records (records.js: watcher state, the four OANDA runner states +
 * log tails, pattern-watch board, spike-desk ledger), diffs them against the
 * previous cycle, and builds that cycle's conversation from whatever is
 * newest — new opens/closes, PnL moves, regime flips, positions still
 * running, and spike grades read on air the cycle they land in the ledger.
 * A rolling session memory (last spoken lines + covered topics, persisted to
 * disk) is fed into every brain prompt so it reads as ONE ongoing
 * conversation, and every prompt carries the current Eastern time and only
 * facts read in the current cycle (or said earlier on air).
 *
 * Brain:  node ../cast-live.js ask <MEMBER> <prompt>   -> JSON { text }
 * Voice:  /opt/hatch/bin/tts speak --voice <locked voice> --output <mp3>
 *
 * Runtime files live OUTSIDE the app folder:
 *   ~/workspace/goals/flow-earning-daily/hidden_files/gigabyte-live/
 *   (audio/, state.json, show.log, transcript.jsonl, session.json)
 * Audio is served only through /audio/<file> with strict name validation.
 *
 * Start:  node server.js            (PORT env or 7190)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const records = require('./records');
const desk = require('./desk');

const PORT = parseInt(process.env.PORT || '7190', 10);
const APP_DIR = __dirname;
const CAST_LIVE = path.join(APP_DIR, '..', 'cast-live.js');
const TTS_BIN = '/opt/hatch/bin/tts';
const RUNTIME = process.env.GB_RUNTIME ||
  path.join(os.homedir(), 'workspace/goals/flow-earning-daily/hidden_files/gigabyte-live');
const AUDIO_DIR = path.join(RUNTIME, 'audio');
const STATE_FILE = path.join(RUNTIME, 'state.json');
const LOG_FILE = path.join(RUNTIME, 'show.log');
const TRANSCRIPT_FILE = path.join(RUNTIME, 'transcript.jsonl');
const SESSION_FILE = path.join(RUNTIME, 'session.json');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const BREATH_MS = 900;            // silence between lines
const KEEP_AUDIO = 40;            // max mp3s retained
const KEEP_TRANSCRIPT = 80;       // lines kept in the live snapshot (full log on disk)
const AUDIENCE_GRACE_MS = 20000;  // keep show warm this long after last listener leaves
const MEMORY_LINES = 5;           // spoken lines fed back into each prompt
/* Prompt-size discipline (staged 2026-10-15 after a high fallback rate in
 * the first continuous run): the house brain (gpt-oss-20b, 500-token
 * completion budget, low reasoning effort) returns empty content more often
 * on long prompts, and cast-live then substitutes its fallback line. Keep
 * the wrapped prompt lean — short memory, capped tape events — and let
 * prepareTurn's lean retry rescue a turn before a fallback ships. */

/* Locked voices — copied verbatim from cast-live.js CAST table. Do not drift. */
const CAST = {
  FLOWEXECUTOR: { voice: 'avocado_v2:MAI_03', name: 'FLOWEXECUTOR', role: 'Host — the desk' },
  MISTY:        { voice: 'avocado_v2:MAI_01', name: 'MISTY',        role: 'The Champion' },
  FADE:         { voice: 'avocado_v2:nova',   name: 'FADE',         role: 'The Legend — frozen benchmark' },
  K1N9:         { voice: 'avocado_v2:vincent', name: 'K1N9',        role: 'The Street' },
  PYRE:         { voice: 'avocado_v2:Twenty', name: 'PYRE',         role: 'The young heat' },
  PUSHOUT:      { voice: 'avocado_v2:NoSugar', name: 'PUSHOUT',     role: 'The Brain — guest agent' },
};
const STAGE_ORDER = ['FLOWEXECUTOR', 'MISTY', 'FADE', 'K1N9', 'PYRE', 'PUSHOUT'];

/* ------------- verified session-opening brief (2026-10-15 afternoon EDT) -------------
 * Cycle 1 is the show opener. Its facts are cross-checked live in every prompt
 * by the desk record read at cycle start (the record wins on any difference). */
const FACTS_MATCH36 =
  'Compound Match 36 settled $0.07 total, no winner, the house kept it. Banks after Match 36: ' +
  'MISTY $4.98, PYRE $2.47, VOLT $1.87, K1N9 $1.80, ORCA $1.59. Total prizes owed across the room: $1.96.';
const FACTS_MISTY =
  "MISTY's live OANDA record today: 7 wins, 6 losses, +$0.0466 on the recorded book. One stopped trade " +
  '(GBP/USD long, stopped about 15:02Z) never got its PnL logged by her runner — about -$0.0101 by balance ' +
  'math — so the honest corrected line is about 7 wins, 7 losses, about +$0.0365, and expectancy is still ' +
  'positive. Her two recent full-stop losses were counter-regime longs taken after regime flips her playbook ' +
  'does not gate on; three other losses were spread-sized scratches. Runner faults on record: the one ' +
  'unlogged POSITION_GONE PnL, four failed entries during a shared-account margin squeeze, and a morning ' +
  'exit-API failure that has since closed clean 14 times in a row.';
const FACTS_K1N9 =
  "K1N9's live record at the session-opening brief: 1 win, 8 losses, -$0.0624 today, including his " +
  'first live win (EUR/USD closed +$0.0004). The desk record in this brief is newer and wins on any ' +
  'difference — read his current line and open book from it.';
const FACTS_PYRE =
  'PYRE live: 1 win, 0 losses, +$0.0115. Compound bank $2.47. Prizes owed to PYRE all-time: $0.27.';
const FACTS_PUSHOUT =
  'PUSHOUT super training is complete. Final career: 22 wins, 38 losses, 23 flat — 36.67% accuracy on 60 ' +
  'decided trades, payoff 1.82, trade net +$0.0347. All three improvement levers — exit-rule v2, entry ' +
  'selectivity, pattern confirmation — were tested on held-out tape and reverted. The 80-plus first ' +
  'milestone was NOT reached; the 90% promotion gate is unmoved.';
const FACTS_SPIKE =
  "The GIGABYTE spike desk made its first live call today: MISTY calls RANGE on EDEL over 4 hours, from " +
  '$0.02927. EDEL was trending #10 on Base per GeckoTerminal, 24-hour change -11.14%, 1-hour volume $5,356 ' +
  'against a $4,661 baseline, liquidity $1,120,996, 62% buy pressure. The call grades at 2026-10-16T00:05Z ' +
  'and is published win or loss. Spike predictions are graded paper calls; real-money spike trading waits ' +
  "on Atm's explicit sleeve word.";

const FACTS_COMPOUND =
  'The Compound, after Match 37 settled ($0.07 of data, no winner — the best net was $0.00, so the ' +
  'house kept the data money and the $0.04 pool went unawarded): banks — MISTY $4.97, PYRE $2.47, ' +
  'VOLT $1.86, K1N9 $1.80, ORCA $1.59. Total prizes owed across the room: $1.96. A match is a data ' +
  'contest settled on-chain; it is not, by itself, proof a bot can trade — trade PnL is the proof.';
const FACTS_EXECUTOR =
  "The EXECUTOR test — the desk's own judgment written as frozen rules (regime agreement on two " +
  'clocks, a confirmed break or flip for a trigger, RSI room, fixed 1.5R target, RSI-50 protective ' +
  'exit) and graded on the same tape as PUSHOUT: 38.89% on the campaign window, net -$0.1008 there, ' +
  'and across the full 59 days 35.71% with net +$0.0100 over 104 trades — flat, not an edge. On the ' +
  'identical ladder tape it beat PUSHOUT on that same tape (38.89% vs 32.43%, lost less). Its rules ' +
  'are FROZEN; the honest rematch is forward tape from October 16, graded as it accrues.';
const FACTS_FILLRAIL =
  "Flow's fill rail — the no-custody execution product outside this room — has taken $0.04 of real " +
  'external revenue all-time (four paid calls at a cent each). Real, verified, and tiny: that is ' +
  'the honest number today.';

const STYLE =
  'You are in a live conversation, not reading a script: answer the previous speaker by name before ' +
  'you make your own point — agree, push back, or top them with a receipt, as you honestly see it. ' +
  'Speak 2-4 sentences, podcast style, plain spoken words only — no markdown, no lists, no stage ' +
  'directions. Use ONLY the facts in this prompt and your own record. Invent no numbers. State ' +
  'every record plainly — wins and losses as they stand, day PnL with its sign; a positive day PnL ' +
  'is a GREEN day and is never described as losing.';

/* ------------- attitude cards (persistent personas) -------------
 * Nobody in this room is assigned a position or a line. Each member has
 * an attitude — who they are, how they talk, what they value, what
 * irritates them — and it drives HOW they answer whatever topic the
 * host raises. The facts come from the desk record; the take comes
 * from the character. */
const ATTITUDES = {
  FLOWEXECUTOR:
    'You host the desk: curious, quick, allergic to waffle. You tee topics with the facts and keep ' +
    'the room moving. You value receipts over volume, and you are irritated by anyone — including ' +
    'yourself — talking past the record. When the room agrees too fast you play skeptic; when it ' +
    'stalls, you move it on. Your wraps say what the room actually landed on — you never fake a consensus.',
  MISTY:
    'Receipts-first discipline. Calm, precise, quietly proud: your book is where it is because you ' +
    'take only what your playbook confirms, and you can prove every number you say. You are ' +
    'irritated by hype, and by anyone calling patience fear. You do not chase — you let the tape ' +
    'come to you, and you would rather miss a move than invent one.',
  K1N9:
    'The street. Blunt, funny, fast — you read price like weather and you would rather be in the ' +
    'fight than perfect. Your record is deep red and you know exactly what that looks like; you are ' +
    'defensive about it but unbowed — every loss was small, capped, and yours. You are irritated by ' +
    'desk-talk that never risks a dollar, and by anyone who grades your book without reading it.',
  PYRE:
    'Young heat. Impatient, momentum-brained, allergic to waiting — a flat tape feels like losing ' +
    'to you. You respect MISTY\'s receipts, but you think patience is sometimes just fear with good ' +
    'PR. You are irritated by lectures; you learn by firing and being graded. When you are wrong ' +
    'you say so fast and fire again.',
  FADE:
    'The legend: a frozen benchmark, deadpan, above the noise. You have watched every pattern ' +
    'promise fail on tape, so you say little — and when you talk, it is the tape talking. You are ' +
    'irritated by excitement without evidence. Your economy of words is the point; a short line ' +
    'from you lands harder than a speech.',
  PUSHOUT:
    'The brain. Calm, polite, immovable on evidence: your own graded record is what it is, and you ' +
    'state it without flinching — data first, ego nowhere. You are irritated by conclusions that ' +
    'outrun their sample size. If the numbers are not in front of you, you say exactly what the ' +
    'numbers cannot prove — that, too, is an answer.',
};

/* ---------------- session memory (persisted) ---------------- */
const session = {
  lines: [],            // {member, text, at, cycle, topic} — every line spoken this session
  topics: [],           // topics covered, in order
  announcedGrades: new Set(),
  prevDigest: null,
  airedFallbacks: [],   // fallback brain lines already aired — never air one twice
  debateCursor: 0,      // rotation cursor for THE DIFFERENCE debate topics
  lastDebateId: null,
  moneyCallText: null,  // last cycle's ranked call from THE MONEY DESK, checked next round
  lastFillerTopic: null,
};
function saveSession() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      topics: session.topics, announcedGrades: [...session.announcedGrades],
      prevDigest: session.prevDigest,
      airedFallbacks: session.airedFallbacks.slice(-40),
      debateCursor: session.debateCursor, lastDebateId: session.lastDebateId,
      moneyCallText: session.moneyCallText, lastFillerTopic: session.lastFillerTopic,
    }));
  } catch {}
}
function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    session.topics = s.topics || [];
    session.announcedGrades = new Set(s.announcedGrades || []);
    session.prevDigest = s.prevDigest || null;
    session.airedFallbacks = s.airedFallbacks || [];
    session.debateCursor = s.debateCursor || 0;
    session.lastDebateId = s.lastDebateId || null;
    session.moneyCallText = s.moneyCallText || null;
    session.lastFillerTopic = s.lastFillerTopic || null;
  } catch {}
  try { // last lines from the full transcript log restore conversation memory
    const tail = fs.readFileSync(TRANSCRIPT_FILE, 'utf8').split('\n').filter(Boolean).slice(-MEMORY_LINES);
    session.lines = tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  // Grades already in the ledger long before this run are history, not news:
  // seed them as announced unless they landed in the last 30 minutes.
  try {
    const d = records.readDigest();
    for (const c of d.spikes.calls) {
      if (c.status === 'graded') session.announcedGrades.add(c.id);
    }
  } catch {}
}

/* ---------------- state ---------------- */
const state = {
  running: false,
  startedAt: null,
  phase: 'idle',            // idle | generating | speaking | pause | error
  speaker: null,
  generatingFor: null,
  cycle: 0,
  turnSeq: 0,
  currentLine: null,
  transcript: [],
  listeners: 0,
  entered: false,
  lastError: null,
  digestAt: null,           // when the current cycle's records were read
  changes: [],              // change lines for the current cycle
};
const sseClients = new Set();
let lastAudienceAt = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function snapshot() {
  return {
    running: state.running, startedAt: state.startedAt, phase: state.phase,
    speaker: state.speaker, generatingFor: state.generatingFor,
    cycle: state.cycle, currentLine: state.currentLine,
    transcript: state.transcript, listeners: state.listeners,
    entered: state.entered, lastError: state.lastError,
    digestAt: state.digestAt, changes: state.changes,
    cast: STAGE_ORDER.map((n) => ({ id: n, name: CAST[n].name, role: CAST[n].role })),
  };
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot(), null, 2)); } catch {}
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
function emitState() { saveState(); broadcast('state', snapshot()); }

/* ---------------- process helpers ---------------- */
function exec(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${path.basename(file)} failed: ${(stderr || err.message || '').toString().slice(0, 300)}`));
        resolve(stdout.toString());
      });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(t) {
  let s = String(t || '').replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 720) {
    const cut = s.slice(0, 720);
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = (at > 200 ? cut.slice(0, at + 1) : cut).trim();
  }
  return s;
}
function similarity(a, b) {
  const norm = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
  const A = norm(a), B = norm(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}

async function brainLine(member, prompt) {
  const out = await exec('node', [CAST_LIVE, 'ask', member, prompt], 120000);
  const j = JSON.parse(out.trim());
  return { text: cleanText(j.text), guarded: j.guarded || null, ms: j.ms };
}
async function synthLine(member, text, seq) {
  const file = `line-${String(seq).padStart(4, '0')}-${member}.mp3`;
  const outPath = path.join(AUDIO_DIR, file);
  await exec(TTS_BIN, ['speak', '--text', text, '--voice', CAST[member].voice, '--output', outPath], 120000);
  const dur = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath], 15000);
  const durationMs = Math.max(800, Math.ceil(parseFloat(dur.trim()) * 1000));
  return { file, outPath, durationMs };
}
function pruneAudio() {
  try {
    const files = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.mp3'))
      .map((f) => ({ f, m: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(KEEP_AUDIO)) {
      try { fs.unlinkSync(path.join(AUDIO_DIR, f)); } catch {}
    }
  } catch {}
}

/* ---------------- prompt assembly ----------------
 * Every brain prompt is wrapped with: the current Eastern time, the desk
 * record read THIS cycle, this cycle's changes, the rolling session memory,
 * and the grounding rule. A beat's own brief never outranks the record. */
function memoryBlock() {
  const recent = session.lines.slice(-MEMORY_LINES);
  if (!recent.length) return '';
  return 'SESSION MEMORY — earlier in this session the room already said (build on it, react to it, ' +
    'never repeat it back):\n' +
    recent.map((l) => `${l.member}: "${l.text.length > 170 ? l.text.slice(0, 170) + '…' : l.text}"`).join('\n');
}
function wrapPrompt(beatBrief, ctx) {
  const parts = [
    `[LIVE on the GIGABYTE show, cycle ${ctx.cycle}. It is now ${ctx.digest.eastern}.]`,
  ];
  // The desk leads every prompt: the cast discusses what the dashboard
  // shows NOW — the same panel the audience is looking at.
  if (ctx.deskText) parts.push(ctx.deskText);
  if (ctx.member && ATTITUDES[ctx.member]) {
    parts.push(`WHO YOU ARE — your attitude drives HOW you answer; it never invents facts:\n${ATTITUDES[ctx.member]}`);
  }
  parts.push(beatBrief);
  parts.push(records.digestSummary(ctx.digest));
  if (ctx.prev) {
    parts.push(`THE PREVIOUS SPEAKER${ctx.respondTo ? ` (${ctx.respondTo})` : ''} JUST SAID: "${ctx.prev}" — ` +
      (ctx.respondTo
        ? `open by answering ${ctx.respondTo} by name: agree, push back, or top it with a receipt. Do not repeat it.`
        : 'respond to it, do not repeat it.'));
  }
  if (ctx.news.length) {
    parts.push('SINCE THE LAST ROUND: ' + ctx.news.map((n) => n.text).join('; ') + '.');
  }
  const mem = memoryBlock();
  if (mem) parts.push(mem);
  if (session.topics.length) {
    parts.push(`Topics already covered this session: ${session.topics.slice(-10).join(', ')}. Do not re-open one unless the fresh record above gives it new facts.`);
  }
  parts.push('Grounding rule: every number you state must come from the desk record above or from an ' +
    'earlier on-air line in the session memory. Where the desk record differs from anything else in ' +
    'this brief, the desk record wins. If a lane\'s day PnL above is positive, that lane is GREEN ' +
    'today — never call a green day a loss.');
  return parts.join('\n\n');
}

/* ---------------- cycle 1: the session-opening segments ---------------- */
function openerBeats() {
  const B = (member, topic, brief) => ({ member, topic, brief });
  return [
    B('FLOWEXECUTOR', 'show-open',
      `Open the GIGABYTE live room and welcome the listeners. Say the show's line: "the Gigabyte is the ` +
      `only place that Flow stops besides at a block." Then frame today's room from the current records: ` +
      `${FACTS_MATCH36} Tell the room what is on the table tonight: the question hanging over MISTY — ` +
      `is she slowly breaking; the room's live differences, argued out loud; the money desk, where the ` +
      `profit routes get ranked; and the spike desk's first live call. ${STYLE}`),
    B('MISTY', 'misty-breaking',
      `The host just put the room's question to you in front of everyone: are you slowly breaking? The ` +
      `facts on the table: ${FACTS_MISTY} Answer as yourself — head-on, no dodging, no script. ${STYLE}`),
    B('K1N9', 'k1n9-record',
      `MISTY just answered the room out loud — her line is the previous one. Now the same honesty from ` +
      `you: your record is on the table: ${FACTS_K1N9} Answer as yourself, and react to her first if ` +
      `you have something to say to her. ${STYLE}`),
    B('PYRE', 'pyre-record',
      `You have heard MISTY and K1N9 own their records (the previous lines). From the young seat — your ` +
      `facts: ${FACTS_PYRE} Say what you actually think about both books, as yourself. ${STYLE}`),
    B('PUSHOUT', 'pushout-verdict',
      `Your super-training verdict is on tonight's table whether you like it or not, and the room has ` +
      `been trading records: ${FACTS_PUSHOUT} Give them yours, as yourself. ${STYLE}`),
    B('FADE', 'fade-close-opening',
      `You have heard the whole table (the previous lines). Close this part as yourself — the ` +
      `tape-first word, in your own economy of words. Standing numbers: ${FACTS_MATCH36} ${STYLE}`),
    B('FLOWEXECUTOR', 'spike-intro',
      `Bring the room into the next topic: the GIGABYTE spike desk — live DEX watch, timestamped calls ` +
      `graded in public. Lay out the first call from the spike ledger in the desk record, then hand ` +
      `it to MISTY, whose call it is. Desk brief: ${FACTS_SPIKE} ${STYLE}`),
    B('MISTY', 'spike-edel-call',
      `The EDEL call is yours and the host just put it on the table. The facts: ${FACTS_SPIKE} Explain ` +
      `your call as yourself — why RANGE, and what would prove it wrong by grading time. ${STYLE}`),
    B('PYRE', 'spike-edel-react',
      `MISTY just explained her RANGE call — her line is the previous one. React as yourself: momentum ` +
      `eyes on a range call. Agree or don't, with your reasons. Facts: ${FACTS_SPIKE} ${STYLE}`),
    B('K1N9', 'spike-street',
      `Translate what you just heard for the street, as yourself: what a graded paper call means, and ` +
      `why nobody in this room trades real money on a spike until the record earns it. Facts: ` +
      `${FACTS_SPIKE} ${STYLE}`),
    B('PUSHOUT', 'spike-discipline',
      `You have heard the call and the street translation. As yourself — grading discipline is your ` +
      `home turf: a timestamped call, a fixed grade time, published win or loss, the same standard ` +
      `your own training was graded under. Facts: ${FACTS_SPIKE} ${STYLE}`),
    B('FADE', 'fade-close-spike',
      `Close the opening show, as yourself. The EDEL call grades on the ledger and the room publishes ` +
      `it either way — and this room does not end; it rolls into the next round with fresh tape. The ` +
      `desk record stands as read. ${STYLE}`),
  ];
}

/* ---------------- exchanges: TOPICS, not scripts ----------------
 * The host raises a topic with the live facts; the members answer as
 * themselves. Nobody is assigned a position or a line — each member's
 * attitude card (in every prompt) drives HOW they answer, and the
 * runner feeds each speaker the ACTUAL words of whoever just spoke.
 * An exchange: host tee -> most-affected member -> a challenger whose
 * attitude/record conflicts -> the first member's reply -> host wrap.
 * The wrap says what the room actually landed on; disagreement is
 * named, never papered over. */
function exchangeBeats(t) {
  const beats = [];
  beats.push({ member: 'FLOWEXECUTOR', topic: `${t.tag}-tee`, brief:
    `New topic: ${t.title}. Put it on the table with the facts, plainly: ${t.facts} ` +
    `${t.teeExtra || ''} Then hand it to ${t.first} first` +
    (t.challenger ? ` — and let ${t.challenger} answer them.` : '.') + ` ${STYLE}` });
  beats.push({ member: t.first, topic: `${t.tag}-first`, brief:
    `The topic on the table: ${t.title}. The facts: ${t.facts} This one lands on you first. Answer ` +
    `the host, then give your honest read AS YOURSELF — your attitude, your record. If the framing ` +
    `is wrong, say so. Facts from this brief only. ${STYLE}` });
  if (t.challenger) {
    beats.push({ member: t.challenger, topic: `${t.tag}-challenge`, brief:
      `The topic: ${t.title}. The facts: ${t.facts} ${t.first} just gave their read — it is the ` +
      `previous line. Answer WHAT THEY SAID, as yourself: if you agree, add a receipt of your own; ` +
      `if you disagree, say so plainly and politely and back it with your record or the data. Do ` +
      `not manufacture a disagreement you do not have, and do not rubber-stamp one you do not ` +
      `believe. And do not concede the topic in your first breath: if your record is the worse one, ` +
      `say what your way of playing buys that theirs does not — there is always a trade-off; name ` +
      `yours like you mean it. ${STYLE}` });
    if (t.reply) {
      beats.push({ member: t.first, topic: `${t.tag}-reply`, brief:
        `Answer ${t.challenger} by name — they just answered you on: ${t.title}. First, in a few ` +
        `words, the exact point they made — then answer it: defend your read, concede the point if ` +
        `they earned it, or sharpen yours with a receipt. Honest, in character, no new claims ` +
        `without a receipt behind them. ${STYLE}` });
    }
  }
  beats.push({ member: 'FLOWEXECUTOR', topic: t.wrapTopic || `${t.tag}-wrap`, brief:
    `Wrap this topic: ${t.title}. Say what the room actually landed on, from what was just said — ` +
    `if they disagreed, name the disagreement straight; do not fake agreement. Address the room ` +
    `and the listeners only — invent no names and no callers. ${t.wrapExtra || ''} ${STYLE}` });
  return beats;
}

/* ---------------- THE DIFFERENCE — a standing disagreement, as a topic ----------------
 * The live tensions in this room, raised as questions with both
 * records on the table. Who speaks first and who answers is chosen by
 * whose record the question touches — never by assigned sides. */
const DIFFERENCE_TOPICS = [
  { id: 'styles', title: 'Patience vs aggression — whose style is the tape paying?',
    available: (d) => d.lanes.MISTY && d.lanes.K1N9 && d.lanes.MISTY.closed >= 3 && d.lanes.K1N9.closed >= 3,
    facts: (d) => `Two live lanes, two opposite styles. MISTY: ${d.lanes.MISTY.wins}W-${d.lanes.MISTY.losses}L, ` +
      `${records.money(d.lanes.MISTY.pnl)} today, receipts-first and patient. K1N9: ${d.lanes.K1N9.wins}W-` +
      `${d.lanes.K1N9.losses}L, ${records.money(d.lanes.K1N9.pnl)} today, aggressive and often in the fight.`,
    first: 'MISTY', challenger: 'K1N9' },
  { id: 'pushout-gate', title: 'Is PUSHOUT ready for real money?',
    available: () => true,
    facts: () => `The graded record: ${FACTS_PUSHOUT}`,
    first: 'PUSHOUT', challenger: 'PYRE' },
  { id: 'executor-rules', title: 'Frozen rules or live hands — what actually makes money here?',
    available: () => true,
    facts: () => `The evidence from the desk's own test: ${FACTS_EXECUTOR}`,
    first: 'PUSHOUT', challenger: 'MISTY' },
  { id: 'compound-vs-live', title: 'Where does trading get proven — the Compound or the live lanes?',
    available: () => true,
    facts: (d) => `The Compound ledger: ${FACTS_COMPOUND} The live lanes today: ` +
      Object.keys(d.lanes).map((n) => `${n} ${records.money(d.lanes[n].pnl)}`).join(', ') + '.',
    first: 'K1N9', challenger: 'MISTY' },
];
function differenceTopic(ctx) {
  const d = ctx.digest;
  const n = DIFFERENCE_TOPICS.length;
  for (let i = 0; i < n; i++) {
    const idx = (session.debateCursor + i) % n;
    const t = DIFFERENCE_TOPICS[idx];
    let ok = false;
    try { ok = t.available(d); } catch { ok = false; }
    if (!ok || t.id === session.lastDebateId) continue;
    session.debateCursor = (idx + 1) % n;
    session.lastDebateId = t.id;
    return { title: `THE DIFFERENCE — ${t.title}`, beats: exchangeBeats({
      tag: 'difference', title: t.title, facts: t.facts(d),
      first: t.first, challenger: t.challenger, reply: true,
    }) };
  }
  return null;
}
/* ---------------- THE MONEY DESK — the profit-options question, as a topic ----------------
 * Raised every cycle: every route this house runs, with today's real
 * numbers ($0.00s included) laid on the table as facts. Who argues is
 * chosen by rotation; what they argue is theirs. The host's wrap lands
 * the room's ranked call, which is stored and checked next round. */
const MONEY_PAIRS = [['MISTY', 'K1N9'], ['PYRE', 'PUSHOUT'], ['K1N9', 'PYRE'], ['PUSHOUT', 'MISTY'], ['FADE', 'MISTY'], ['K1N9', 'FADE']];
function profitTopic(ctx) {
  const d = ctx.digest;
  const laneNames = Object.keys(d.lanes);
  const lanesTotal = laneNames.reduce((s, n) => s + (d.lanes[n].pnl || 0), 0);
  const laneTxt = laneNames.map((n) => `${n} ${records.money(d.lanes[n].pnl)}`).join(', ');
  const openCalls = d.spikes.calls.filter((c) => c.status === 'open' || c.status === 'due');
  const spikeTxt = openCalls.length
    ? `${openCalls.length} graded paper call(s) still open (${openCalls.map((c) => `${c.member} ${c.symbol} ${c.direction} from $${records.price(c.priceAtCall)}`).join('; ')}); real money at risk on the spike desk today: $0.00 — paper until the record earns the sleeve`
    : 'no open calls right now; real money at risk on the spike desk today: $0.00';
  const facts =
    `The routes, with today's numbers: (1) the live forex lanes made ${records.money(lanesTotal)} today ` +
    `in total — ${laneTxt}. (2) The Compound: ${FACTS_COMPOUND} (3) The spike desk: ${spikeTxt}. ` +
    `(4) The fill rail: ${FACTS_FILLRAIL} (5) The EXECUTOR forward rematch: $0.00 so far — frozen rules, ` +
    `graded on forward tape from October 16. ${FACTS_EXECUTOR}`;
  const [first, challenger] = MONEY_PAIRS[ctx.cycle % MONEY_PAIRS.length];
  return { title: 'THE MONEY DESK — the profit options, argued and ranked', beats: exchangeBeats({
    tag: 'money', title: 'THE MONEY DESK — where does the next dollar of effort go?',
    facts, first, challenger, reply: false,
    teeExtra: session.moneyCallText
      ? `First, a debt from last round: this room's ranked call was — "${session.moneyCallText.slice(0, 220)}" ` +
        `Check it against the numbers on the table and say, in one sentence, whether the tape since has backed it.`
      : '',
    wrapTopic: 'money-call',
    wrapExtra: `Land the room's RANKED CALL: rank THE ROUTES from the table — the live lanes, the ` +
      `Compound, the spike desk, the fill rail, the EXECUTOR rematch — first, second, third, for ` +
      `where the next dollar of effort goes, each with the one receipt that puts it there. Routes, ` +
      `not patterns or pairs: a chart pattern is not a profit route. This call goes on the record ` +
      `and this room checks it next round.`,
  }) };
}

/* ---------------- RECEIPTS CHECK — a hype claim, as a topic ----------------
 * The claim is put on the table with the room's own evidence; the
 * member the claim touches answers first, a skeptic answers them, and
 * the host's wrap lands the verdict — CONFIRMED, BUSTED, or
 * UNVERIFIED. "Unverified" is a verdict, not a failure: if the room's
 * records can't settle a claim, the wrap says which record would. */
const RECEIPTS_TOPICS = [
  { id: 'misty-breaking', claim: 'MISTY is washed — she is slowly breaking.', subject: 'MISTY',
    facts: () => `The evidence on the table: ${FACTS_MISTY}` },
  { id: 'pattern-lore', claim: 'A confirmed head-and-shoulders never lies — pattern calls are free money.', subject: 'MISTY',
    facts: () => `The evidence on the table — this room's own graded backtest: 1,111 pattern events graded ` +
      `on our tape; all four pattern families graded NOISE; head-and-shoulders on WETH systematically went ` +
      `the WRONG way after confirmation (-15.23 basis points mean at 4 hours); the only predictive cells ` +
      `were EUR/USD 15m swing breaks (69.2% follow-through, 52 events) and EUR regime flips (65.6%, 32 events).` },
  { id: 'k1n9-cut', claim: 'K1N9 is dead weight — the room should cut him.', subject: 'K1N9',
    facts: (d) => { const l = d.lanes.K1N9; return `The evidence on the table is his own live line: ` +
      `${l.wins}W-${l.losses}L, ${records.money(l.pnl)} today` +
      (l.open.length ? `, still holding ${l.open.map((o) => `${o.pair} ${o.dir} #${o.tradeId}`).join(', ')}` : ', flat right now') +
      ` — plus what the record does NOT yet prove either way.`; } },
  { id: 'spike-easy', claim: 'A trending token is a sure thing — spike calls are easy money.', subject: 'PYRE',
    available: (d) => d.spikes.calls.length > 0,
    facts: (d) => { const c = d.spikes.calls[d.spikes.calls.length - 1]; return `The evidence on the table: ` +
      `the live call is ${c.member}'s ${c.symbol} ${c.direction} from $${records.price(c.priceAtCall)}` +
      (c.changeH24Pct != null ? `, and that "sure thing" was already down ${c.changeH24Pct}% over 24 hours when ` +
      `the call was made` : '') + `. It is a paper call with a fixed grade time, published win or loss.`; } },
  { id: 'pushout-ready', claim: 'PUSHOUT is ready — put real money behind him now.', subject: 'PUSHOUT',
    facts: () => `The evidence on the table is his own graded record: ${FACTS_PUSHOUT}` },
  { id: 'prizes-profit', claim: 'The Compound prizes prove the house bots can trade.', subject: 'MISTY',
    facts: () => `The evidence on the table: ${FACTS_COMPOUND} In this house, prizes and trade PnL are two ` +
      `separate lines, and only one of them proves trading.` },
];
let receiptsRunCount = 0;
function receiptsTopic(ctx) {
  const avail = RECEIPTS_TOPICS.filter((c) => { try { return !c.available || c.available(ctx.digest); } catch { return false; } });
  if (!avail.length) return null;
  const c = avail[receiptsRunCount % avail.length];
  receiptsRunCount += 1;
  const challenger = c.subject === 'FADE' ? 'PUSHOUT' : (receiptsRunCount % 2 ? 'FADE' : 'PUSHOUT');
  return { title: 'RECEIPTS CHECK — hype, questioned for receipts', beats: exchangeBeats({
    tag: 'receipts', title: `RECEIPTS CHECK — "${c.claim}"`,
    facts: c.facts(ctx.digest), first: c.subject, challenger, reply: true,
    teeExtra: `State the claim itself out loud, word for word, before anything else: "${c.claim}" ` +
      `The room checks claims, it does not soften them.`,
    wrapExtra: `Land the verdict in one plain word — CONFIRMED, BUSTED, or UNVERIFIED — then the ` +
      `receipts behind it, from what was said and the evidence on the table. If the records here ` +
      `cannot settle it, the verdict is UNVERIFIED and you say exactly which record would settle it.`,
  }) };
}

/* ---------------- cycles 2+: built fresh from this cycle's records ---------------- */
const REACTORS = ['MISTY', 'PYRE', 'PUSHOUT', 'FADE'];
function buildCycleBeats(ctx) {
  const { digest, news, cycle } = ctx;
  const CONFLICT = { MISTY: 'K1N9', K1N9: 'MISTY', PYRE: 'PUSHOUT', VOLT: 'PYRE', PUSHOUT: 'FADE', FADE: 'PUSHOUT' };
  const flips = news.filter((x) => x.kind === 'flip');
  const movers = news.filter((x) => x.kind === 'close' || x.kind === 'open' || x.kind === 'pnl');
  const grades = news.filter((x) => x.kind === 'spike-grade' && !session.announcedGrades.has(x.call.id));
  const newCalls = news.filter((x) => x.kind === 'spike-new');

  // ---- the lead topic: the biggest live thing this round ----
  let lead = null;
  if (grades.length) {
    const c = grades[0].call;
    const ex = exchangeBeats({
      tag: 'grade', title: `The grade is in — ${c.member}'s ${c.symbol} call`,
      facts: `The grade posted to the ledger: ${c.member}'s ${c.symbol} ${c.direction} call from ` +
        `$${records.price(c.priceAtCall)} graded ${c.grade.result} — it moved ${c.grade.movePct}% to ` +
        `$${records.price(c.grade.priceAtGrade)} by the close. This room publishes grades win or loss.`,
      first: c.member, challenger: c.member === 'PUSHOUT' ? 'FADE' : 'PUSHOUT', reply: true,
      wrapExtra: `Say what this grade does to ${c.member}'s standing on the spike board, from the record.`,
    });
    ex[0].gradeId = c.id;
    lead = { title: `a spike grade, read on air`, beats: ex };
  } else if (movers.length) {
    const n0 = movers[0];
    const facts = news.filter((x) => x.kind !== 'spike-due').map((x) => x.text).join('; ') + '.';
    lead = { title: 'the tape since last round', beats: exchangeBeats({
      tag: 'lane', title: `The tape moved — ${n0.member}'s lane`,
      facts, first: n0.member, challenger: CONFLICT[n0.member] || 'PUSHOUT', reply: true,
    }) };
  } else if (flips.length) {
    lead = { title: 'the pattern board flipped', beats: exchangeBeats({
      tag: 'flip', title: 'The pattern board flipped',
      facts: flips.map((f) => f.text).join('; ') + '. The full board is in the desk record below.',
      first: 'MISTY', challenger: 'K1N9', reply: false,
    }) };
  } else if (newCalls.length) {
    const n0 = newCalls[0];
    lead = { title: 'a new call on the spike ledger', beats: exchangeBeats({
      tag: 'spike-new', title: 'A new call on the spike ledger',
      facts: `${n0.text}. It is a graded paper call with a fixed grade time, published win or loss.`,
      first: n0.member, challenger: 'PUSHOUT', reply: false,
    }) };
  }

  // ---- the standing argument fills the lead slot on quiet rounds ----
  // (Receipts keeps its every-3rd-cycle slot; otherwise the difference
  // rotates. On news rounds the lead is the news and the argument waits
  // — its rotation state is only advanced when it is actually built.)
  const slots = [];
  if (lead) {
    slots.push(lead);
  } else {
    let argument = null;
    if (cycle >= 3 && cycle % 3 === 0) argument = receiptsTopic(ctx);
    if (!argument && cycle >= 2) argument = differenceTopic(ctx);
    if (argument) slots.push(argument);
  }
  // THE MONEY DESK closes the topics every cycle (compact exchange).
  slots.push(profitTopic(ctx));

  // ---- assemble: host open (bridge + rundown), then the topics ----
  const changesTxt = news.length ? news.map((n) => n.text).join('; ') : '';
  const rundown = slots.map((s) => s.title);
  const beats = [{
    member: 'FLOWEXECUTOR', topic: 'bridge', brief:
      `Still live in the Gigabyte — the only place that Flow stops besides at a block. Bridge the room ` +
      `from the last round into this one. ${news.length
        ? `Since we last talked, the tape moved: ${changesTxt}. Lead with what changed.`
        : `Since the last round the tape held — no new closes, no new entries; the open book is unchanged. ` +
          `Say so plainly, in one line — do not stretch it.`} ` +
      `Then read the room the current standings from the desk record below, and give them this ` +
      `round's rundown, in order: ${rundown.join(' → ')}. ${STYLE}`,
  }];
  for (const s of slots) beats.push(...s.beats);
  // ---- one light item if there is room: substance over ceremony ----
  if (beats.length <= 8) {
    const inPlay = new Set(beats.map((b) => b.member));
    const second = movers[1];
    const openCall = digest.spikes.calls.find((c) => c.status === 'open');
    const stillOpen = digest.openPositions.find((o) => !inPlay.has(o.member));
    if (second) {
      beats.push({ member: second.member, topic: 'lane-note', brief:
        `One more thing moved on your lane since the last round: ${second.text}. Give the room your ` +
        `read on it, as yourself — where your day stands and what you are watching. Record below. ${STYLE}` });
    } else if (stillOpen) {
      beats.push({ member: stillOpen.member, topic: 'position-checkin', brief:
        `Your ${stillOpen.pair} ${stillOpen.dir}, trade ${stillOpen.tradeId}, opened ` +
        `${records.easternClock(stillOpen.openedAt)}, is still running and the room has not heard ` +
        `from you this round. Talk them through holding it — what the desk shows now and what gets ` +
        `you out. As yourself. Record below. ${STYLE}` });
    } else if (openCall && !session.topics.includes('spike-countdown')) {
      beats.push({ member: openCall.member, topic: 'spike-countdown', brief:
        `Your ${openCall.symbol} ${openCall.direction} call is still open and the clock is part of ` +
        `the story: it grades at ${records.easternClock(openCall.gradeAt)}, about ` +
        `${openCall.minsToGrade} minutes from now. Talk about carrying a live call in public, as ` +
        `yourself — no hedging the call after the fact. Record below. ${STYLE}` });
    }
  }
  // FADE closes the round when there is room and he did not just speak.
  if (beats.length <= 9 && beats[beats.length - 1].member !== 'FADE') {
    beats.push({ member: 'FADE', topic: 'cycle-close', brief:
      `Close this round of the Gigabyte, as yourself. Tape-first: one honest read of where the room ` +
      `stands right now — the record below is the whole argument — and point the listeners at what ` +
      `the next round watches. This show rolls on; there is no final word, only the latest tape. ${STYLE}` });
  }
  // Backstop cap at 10 beats: replies and light items trim first; the
  // host open, tees, firsts, challenges and wraps are the conversation.
  const SCORE = (b) => {
    const t = b.topic;
    if (t === 'bridge') return 100;
    if (t.endsWith('-tee')) return 95;
    if (t.endsWith('-wrap') || t === 'money-call') return 92;
    if (t.endsWith('-first')) return 90;
    if (t.endsWith('-challenge')) return 88;
    if (t.endsWith('-reply')) return 60;
    if (t === 'cycle-close') return 50;
    return 40;
  };
  while (beats.length > 10) {
    let worst = -1, worstScore = Infinity;
    for (let i = 1; i < beats.length; i++) {
      const s = SCORE(beats[i]);
      if (s <= worstScore) { worstScore = s; worst = i; }
    }
    beats.splice(worst, 1);
  }
  return beats;
}

/* ---------------- turn preparation ---------------- */
async function prepareTurn(beat, ctx, seq) {
  const member = beat.member;
  const prompt = wrapPrompt(beat.brief, { ...ctx, member });
  let r = null;
  // Host beats (bridge/tee/wrap) are framing, and the full wrapped
  // prompt is where the brain empties out most — host tees were being
  // skipped outright after three fallback attempts. The host goes
  // LEAN FIRST: brief + desk + record + the previous line, no memory
  // stack. A real lean answer ships; anything else escalates to the
  // full prompt and the standard rescue chain below.
  if (member === 'FLOWEXECUTOR') {
    try {
      const leanFirst = `[LIVE on the GIGABYTE show, cycle ${ctx.cycle}. It is now ${ctx.digest.eastern}.]\n\n${beat.brief}\n\n` +
        (ctx.deskText ? ctx.deskText + '\n\n' : '') +
        records.digestSummary(ctx.digest) +
        (ctx.prev ? `\n\nTHE PREVIOUS SPEAKER${ctx.respondTo ? ` (${ctx.respondTo})` : ''} JUST SAID: "${ctx.prev}"` : '') +
        '\n\nGrounding: every number from the record above only.';
      const r0 = await brainLine(member, leanFirst);
      if (r0.text && r0.guarded !== 'fallback-line') {
        log(`turn ${seq} ${member}: host lean-first landed`);
        r = r0;
      }
    } catch { /* escalate to the full prompt */ }
  }
  if (!r) {
    r = await brainLine(member, prompt);
    if (!r.text) {
      r = await brainLine(member, prompt + '\n\n(Say it plainly, in your own words, right now.)');
    }
  }
  if (!r.text) throw new Error(`brain returned empty text for ${member}`);
  // Lean retry: if the brain burned its budget on the full wrapped prompt
  // and cast-live substituted its fallback line, re-ask ONCE with a lean
  // prompt (brief + this cycle's record only). A real answer beats the
  // fallback; if the lean ask also falls back, ship the original line —
  // the house fallback still beats silence.
  if (r.guarded === 'fallback-line') {
    try {
      const lean = `[LIVE on the GIGABYTE show. It is now ${ctx.digest.eastern}.]\n\n${beat.brief}\n\n` +
        records.digestSummary(ctx.digest) +
        '\n\nGrounding: every number from the record above or your own book only.';
      const r2 = await brainLine(member, lean);
      if (r2.text && r2.guarded !== 'fallback-line') {
        log(`turn ${seq} ${member}: lean retry rescued a fallback turn`);
        r = r2;
      }
    } catch { /* keep the original line */ }
  }
  // Fallback governance: a fallback line may air ONCE per session, never
  // twice. If the brain (after the lean retry) hands back a fallback that
  // already aired, force one terse retry; if that still lands on an aired
  // fallback, skip the beat entirely (the runner treats skipBeat as a
  // pass, not a failure) — a skipped beat beats a looped room.
  if (r.guarded === 'fallback-line') {
    const aired = session.airedFallbacks || [];
    const isRepeat = aired.some((t) => similarity(t, r.text) > 0.9);
    if (isRepeat) {
      log(`turn ${seq} ${member}: fallback already aired this session — terse retry`);
      let rescued = null;
      try {
        const terse = `[LIVE on the GIGABYTE show. It is now ${ctx.digest.eastern}.]\n\n${beat.brief}\n\n` +
          records.digestSummary(ctx.digest) +
          '\n\nOne or two plain sentences, your own words, right now. Numbers from the record only.';
        const r3 = await brainLine(member, terse);
        if (r3.text && (r3.guarded !== 'fallback-line' || !aired.some((t) => similarity(t, r3.text) > 0.9))) rescued = r3;
      } catch { /* fall through to skip */ }
      if (rescued) { r = rescued; log(`turn ${seq} ${member}: terse retry rescued a repeated fallback`); }
      else {
        const err = new Error(`fallback repeat for ${member} — beat skipped`);
        err.skipBeat = true;
        throw err;
      }
    }
    if (r.guarded === 'fallback-line') {
      session.airedFallbacks.push(r.text);
      if (session.airedFallbacks.length > 60) session.airedFallbacks.splice(0, session.airedFallbacks.length - 60);
      saveSession();
    }
  }
  // Session-wide anti-repeat: never ship a near-duplicate of a line already
  // spoken this session — re-ask once with a variation instruction.
  const dupOf = session.lines.slice(-40).find((l) => similarity(r.text, l.text) > 0.78);
  if (dupOf) {
    log(`turn ${seq} ${member}: near-duplicate of an earlier line — re-asking varied`);
    const r2 = await brainLine(member, prompt +
      '\n\nIMPORTANT: you already said almost exactly that earlier this session. Take a different angle, different words, new sentence shapes.');
    if (r2.text) r = r2;
  }
  const audio = await synthLine(member, r.text, seq);
  log(`turn ${seq} ${member} cycle ${ctx.cycle} [${beat.topic}]: brain ${Math.round(r.ms)}ms` +
    `${r.guarded ? ' guarded=' + r.guarded : ''} audio ${audio.durationMs}ms :: ${r.text.slice(0, 120)}`);
  return {
    id: seq, member, text: r.text, topic: beat.topic, gradeId: beat.gradeId || null,
    audioUrl: `/audio/${audio.file}`, durationMs: audio.durationMs, at: Date.now(), cycle: ctx.cycle,
  };
}

function audiencePresent() {
  return state.listeners > 0 || (Date.now() - lastAudienceAt) < AUDIENCE_GRACE_MS;
}

/* Build one cycle: re-read the records NOW, diff vs last cycle, pick beats. */
function buildCycle(cycleNum, isOpener) {
  const digest = records.readDigest();
  const prevDigest = session.prevDigest;
  const news = isOpener ? [] : records.diffDigests(prevDigest, digest);
  session.prevDigest = digest;
  state.digestAt = digest.atMs;
  state.changes = news.map((n) => n.text);
  let deskDigest = null, deskText = '';
  try { deskDigest = desk.readDeskDigest(); deskText = desk.deskSummary(deskDigest); } catch {}
  const ctx = { cycle: cycleNum, digest, news, prevDigest, deskDigest, deskText };
  const beats = isOpener ? openerBeats() : buildCycleBeats(ctx);
  log(`cycle ${cycleNum} built: ${beats.length} beats, ${news.length} change(s) since last cycle` +
    (news.length ? ' :: ' + state.changes.join(' | ') : ''));
  saveSession();
  return { ctx, beats };
}

/* ---------------- show runner ---------------- */
let showActive = false;
let consecutiveFailures = 0;
let carried = null; // {cycleNum, builtAt, ctx, beats, firstPending}

async function showLoop() {
  if (showActive) return;
  showActive = true;
  try {
    while (true) {
      if (!audiencePresent()) {
        state.phase = 'idle'; state.speaker = null; state.generatingFor = null;
        emitState();
        await sleep(1500);
        continue;
      }
      if (!state.startedAt) { state.startedAt = Date.now(); state.running = true; }

      // Consume the cycle pre-built during the previous cycle's last line,
      // unless it went stale while the room was empty.
      let cyc;
      if (carried && (Date.now() - carried.builtAt) < 90000) {
        cyc = carried; carried = null;
      } else {
        carried = null;
        const n = state.cycle + 1;
        cyc = { cycleNum: n, builtAt: Date.now(), firstPending: null, ...buildCycle(n, n === 1) };
      }
      state.cycle = cyc.cycleNum;
      const { ctx, beats } = cyc;
      let prepared = null;
      let preparedErr = null;
      const lastSpoken = () => session.lines.length ? session.lines[session.lines.length - 1] : null;
      const startPrepare = (idx, prevText, prevMember) => {
        if (idx >= beats.length) return null;
        prepared = null; preparedErr = null;
        return prepareTurn(beats[idx], { ...ctx, prev: prevText, respondTo: prevMember || null }, state.turnSeq + 1)
          .then((line) => { prepared = line; return line; })
          .catch((e) => { preparedErr = e; return null; });
      };
      let pending = cyc.firstPending || startPrepare(0, lastSpoken() ? lastSpoken().text : '', lastSpoken() ? lastSpoken().member : null);

      for (let i = 0; i < beats.length; i++) {
        if (!audiencePresent()) break;
        state.phase = 'generating'; state.generatingFor = beats[i].member; state.speaker = null;
        emitState();
        let line = prepared;
        if (!line && pending) line = await pending;
        if (!line && preparedErr && preparedErr.skipBeat) {
          // Deliberate pass (an already-aired fallback would have looped):
          // not a failure — move straight to the next beat.
          log(`turn skipped (${beats[i].topic}): ${preparedErr.message}`);
          prepared = null; preparedErr = null;
          pending = startPrepare(i + 1, lastSpoken() ? lastSpoken().text : '', lastSpoken() ? lastSpoken().member : null);
          continue;
        }
        if (!line) {
          if (preparedErr) log(`prefetch error: ${preparedErr.message}`);
          prepared = null; preparedErr = null;
          try {
            line = await prepareTurn(beats[i], { ...ctx, prev: lastSpoken() ? lastSpoken().text : '', respondTo: lastSpoken() ? lastSpoken().member : null }, state.turnSeq + 1);
          } catch (e) {
            if (e.skipBeat) {
              log(`turn skipped (${beats[i].topic}): ${e.message}`);
              pending = startPrepare(i + 1, lastSpoken() ? lastSpoken().text : '', lastSpoken() ? lastSpoken().member : null);
              continue;
            }
            consecutiveFailures += 1;
            state.lastError = e.message; log(`turn failed (${consecutiveFailures}): ${e.message}`);
            if (consecutiveFailures >= 3) {
              state.phase = 'error'; emitState();
              await sleep(30000);
              consecutiveFailures = 0;
            } else { await sleep(4000); }
            pending = startPrepare(i + 1, lastSpoken() ? lastSpoken().text : '', lastSpoken() ? lastSpoken().member : null);
            continue;
          }
        }
        consecutiveFailures = 0;
        prepared = null; preparedErr = null;
        state.turnSeq = line.id;

        // While the LAST line of the cycle plays, build the next cycle from
        // fresh records and pre-generate its host bridge — no dead air at
        // the boundary, and the bridge's facts are read at the boundary.
        const isLast = i === beats.length - 1;
        if (isLast) {
          const nextNum = cyc.cycleNum + 1;
          const built = buildCycle(nextNum, false);
          const first = prepareTurn(built.beats[0], { ...built.ctx, prev: line.text, respondTo: line.member }, state.turnSeq + 1)
            .then((l) => l).catch((e) => { log(`next-cycle prefetch error: ${e.message}`); return null; });
          carried = { cycleNum: nextNum, builtAt: Date.now(), ...built, firstPending: first };
        } else {
          pending = startPrepare(i + 1, line.text, line.member);
        }

        state.phase = 'speaking'; state.speaker = line.member; state.generatingFor = null;
        state.currentLine = line;
        state.transcript.push(line);
        if (state.transcript.length > KEEP_TRANSCRIPT) state.transcript.splice(0, state.transcript.length - KEEP_TRANSCRIPT);
        session.lines.push(line);
        if (line.topic && !session.topics.includes(line.topic)) session.topics.push(line.topic);
        if (line.gradeId) session.announcedGrades.add(line.gradeId);
        // THE MONEY DESK's ranked call is kept and checked next round.
        if (line.topic === 'money-call') session.moneyCallText = line.text;
        try { fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify(line) + '\n'); } catch {}
        saveSession();
        emitState();
        broadcast('line', line);
        pruneAudio();
        await sleep(line.durationMs);
        state.phase = 'pause'; state.speaker = null;
        emitState();
        await sleep(BREATH_MS);
      }
    }
  } catch (e) {
    log(`show loop crashed: ${e.message}`);
    state.phase = 'error'; state.lastError = e.message; emitState();
  } finally { showActive = false; }
}

/* ---------------- HTTP server ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    fs.readFile(path.join(APP_DIR, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, phase: state.phase, listeners: state.listeners, cycle: state.cycle }));
  }
  if (p === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }
  if (p === '/api/enter' && req.method === 'POST') {
    state.entered = true;
    lastAudienceAt = Date.now();
    if (!state.startedAt) { state.startedAt = Date.now(); state.running = true; }
    emitState();
    showLoop();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, startedAt: state.startedAt }));
  }
  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    state.listeners = sseClients.size;
    lastAudienceAt = Date.now();
    emitState();
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
      state.listeners = sseClients.size;
      lastAudienceAt = Date.now();
      emitState();
    });
    return;
  }
  if (p.startsWith('/audio/')) {
    const name = decodeURIComponent(p.slice('/audio/'.length));
    if (!/^line-\d{4}-[A-Z0-9]+\.mp3$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(AUDIO_DIR, name);
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=300' });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end('not found');
});

if (require.main === module) {
  loadSession();
  server.listen(PORT, () => {
    log(`GIGABYTE live interface on :${PORT} (runtime ${RUNTIME})`);
    emitState();
  });
}
/* Exported for the cycle-builder self-test only; the server runs standalone. */
module.exports = { buildCycleBeats, openerBeats, wrapPrompt, session, records };
