# GIGABYTE — live interface

The live web room for the Flow Cast: Atm opens it on iOS/Android, taps
**Enter live room**, and watches/listens while the six-seat cast
(FLOWEXECUTOR host, MISTY, FADE, K1N9, PYRE, PUSHOUT) holds a real,
turn-by-turn podcast conversation — transcript and voice in sync. The show
**never ends**: it runs in cycles, re-reading the desk's live records at
every cycle boundary, for as long as the process runs and someone is in
the room.

Tagline (exact): *the Gigabyte is the only place that Flow stops besides at a block*

## Start

```bash
cd ~/workspace/flow-auction-protocol/offchain/gigabyte-live
node server.js            # PORT env or 7190
```

Built-in Node modules only — no dependencies, no build step. This server is
standalone: it does **not** modify or depend on the production `cast-live.js`
serve / Pulse / Xvfb stack. Exposing it publicly (tunnel/reverse proxy) is
the operator's step; all URLs in the page are relative and HTTPS-friendly.

## How a show works

- The show starts on the first `POST /api/enter` (the lobby button — this is
  also the mobile autoplay unlock: the tap blesses the `<audio>` element
  with a silent clip, an `AudioContext` is created for the real level
  meter). The LIVE badge and elapsed clock run from show start across all
  cycles. If the room empties, the show parks between turns and resumes
  when a listener returns.
- Each turn is generated at runtime with the house brain:
  `node ../cast-live.js ask <MEMBER> <prompt>` (parse JSON `text`), then
  synthesized with the member's **locked voice** from the cast-live.js CAST
  table via `/opt/hatch/bin/tts speak --voice <voice> --output <mp3>`, and
  timed with `ffprobe`. While a line plays, the NEXT turn is already being
  generated, chained off the current speaker's actual line — so the
  conversation really responds, and dead air between lines is just a 0.9s
  breath. The next cycle is likewise built (and its host bridge
  pre-generated) during the current cycle's final line.
- If the brain fails 3 turns in a row the phase flips to `error` ("the desk
  is regrouping") and retries after 30s — nothing is faked or scripted.

## The continuous cycle (present-time data)

- **Cycle 1** is the session opener: the host frames the room, MISTY
  answers the "slowly breaking" question, K1N9/PYRE/PUSHOUT give their
  records, FADE closes, then the spike-desk segment around MISTY's first
  live call (EDEL RANGE).
- **Every cycle from 2 on is built fresh at the boundary** by `records.js`,
  which re-reads: `misty-watcher-state.json` (per-lane W-L + realized PnL),
  the four `oanda-*-live-state.json` files (open positions) plus recent
  runner log tails (entries, closes with PnL, POSITION_GONE),
  `pattern-watch-state.json` (regime board + forming patterns), and the
  spike desk's `predictions.jsonl` ledger (calls + grade records).
- The new digest is **diffed against the previous cycle's**: new
  opens/closes, PnL moves, positions closed, regime flips, new spike calls,
  grades landed. The host opens each cycle by bridging from that diff
  ("Still live in the Gigabyte — since the last round, the tape moved…"),
  the traders react first-person to their own lane's news, flips get a tape
  read, still-open positions get owner check-ins, and FADE closes the
  round. Quiet cycles fill with a pattern-board read, a spike countdown, or
  a callback to an earlier segment — never a repeat.
- **Spike grades are read on air the cycle they land**: when a `grade`
  record appears in the spike ledger, the member who made the call reads
  the grade (result, move %, price) in the next cycle, exactly as posted.
  If a call's grade time arrives before the desk's grade posts, the host
  says so and the room reads it the moment it lands — the show never
  invents a price or grades early.
- **Present-time grounding**: every prompt carries the current Eastern
  time, the digest read that cycle, that cycle's changes, the last ~8
  spoken lines, and the topics already covered. Rule printed into every
  prompt: every number must trace to this cycle's records or an earlier
  on-air line; the fresh record outranks any brief.
- **One conversation, not resets**: session memory (lines, topics,
  announced grades, last digest) persists to `session.json` +
  `transcript.jsonl` in the runtime dir and is restored on restart. A
  session-wide similarity guard re-asks any line that near-duplicates one
  already spoken this session, with a variation instruction.

## The dashboard build (2026-10-15 evening)

- **Always-on, no loose processes.** `server.js` runs turns only while an
  audience is present (an SSE listener on `/events`, or an `/api/enter`
  within 20s). The push relay is now the audience of record:
  `push-relay.js` holds a persistent SSE connection to the local
  `/events` (reconnecting on any drop, 45s silence watchdog) and presses
  `POST /api/enter` whenever it observes a show that has not started.
  After `systemctl restart` of both units the room enters itself and
  cycles indefinitely — verified live, zero helper processes.
- **The live desk is on the page.** `desk.js` builds one digest consumed
  by both the relay (attached to every pushed state; `gigabyte.html`
  renders it as the desk panel above the cast) and the show server
  (every prompt leads with it — the cast talks off the exact dashboard
  the audience sees). Market data reuses the forex desk's own path
  (`offchain/forex-desk.js`): the pattern watch's Dukascopy tape decoded
  BID/ASK → MID into closed 15m buckets, same Alligator SMMA 13/8/5
  (+8/+5/+3) and Wilder RSI(14) math on the same last-64 series; lane
  tallies/open positions come from `records.js` with units/entry joined
  from the runners' RECONCILE log lines. The panel shows per pair: last
  price, 15m + 1h regime, RSI(14), alligator state, and — since Atm's
  steer of 2026-10-15 ("go back to the OANDA trending chart — it looks
  better with dashboard") — the forex desk's full v2 chart, not a
  sparkline: `desk.js` pushes the last 64 closed 15m OHLC candles per
  pair and `gigabyte.html` renders the tall multi-panel SVG ported
  verbatim from `forex-desk.js` (candles + Alligator SMMA 13/8/5
  shifted, Williams fractals, SMA 20, labeled price ticks + gridlines,
  dashed last-price line + gold chip, shared time axis; RSI(14)
  sub-panel with 30/50/70 guides, 50 = MISTY's exit line; AO(5,34)
  histogram; legend with latest values; open-position entry markers
  from the lane digest). The page computes the indicators in the
  browser with the desk page's own code — verified bit-identical
  (Δ 0.0) against `forex-desk.js` on the live tape. Per lane: W-L,
  signed day PnL, open positions; and every live spike call (EDEL
  included) as PENDING with its from-price and grade time, or its
  posted grade.
- **Relay watermark resync.** If a push is rejected 409 "line N is not
  ahead of the stored transcript (at M)" (the relay's local audio
  watermark fell behind the server's — e.g. a restart mid-flight), the
  relay jumps its watermark to M and continues: those lines' audio is
  already mirrored server-side, so nothing is lost and the feed cannot
  deadlock on a stale batch.
- **Topics + attitudes, not scripts.** Cast members are never assigned
  a position or a line. Each has a persistent attitude card (in every
  prompt — how they talk, what they value, what irritates them), and the
  host raises TOPICS with the live facts: a trade that just closed, a
  regime flip, a spike grade, a receipts claim, the standing
  differences, the money desk. An exchange runs host tee → the
  most-affected member → a challenger whose attitude/record conflicts →
  the first member's reply → host wrap ("what the room actually landed
  on" — disagreement is named, never papered over). Segments survive as
  topics the host can raise: RECEIPTS CHECK, THE DIFFERENCE (rotating
  live disagreements), THE MONEY DESK (the profit-options question with
  today's real numbers, $0.00s included; the host's wrap lands a ranked
  call that is stored and checked against the record next round).
- **Anti-loop.** A beat whose facts are unchanged collapses to a
  one-line acknowledgment or is replaced by a topic exchange; quiet
  cycles get at most one filler beat and never the same filler twice
  running. A brain fallback line may air once per session, never twice:
  repeats force a terse retry, then the beat is skipped outright.
  Records are stated plainly — MISTY's line is her W-L as it stands with
  her signed day PnL; a green day is never called a loss.
- **Format borrowings** (studied 2026-10-15; mechanics, not content):
  (1) the on-screen **rundown** — *Pardon the Interruption* (ESPN)
  lists the topics still to come; our host open reads the round's
  rundown in order before the first topic. (2) **One binary question,
  two sides, a forced verdict** — PTI / debate-show mechanics, plus
  PTI's corrector role: our exchanges pose one question the data
  supports, the members answer each other by name, and the host's wrap
  must land it with the record. (3) **Fixed named segments in fixed
  slots** — *All-In*'s "Science Corner" (Friedberg's standing
  explainer segment) is the model for RECEIPTS CHECK's and THE MONEY
  DESK's standing slots and names. (4) **Distinct panelist jobs** —
  All-In's besties each carry a role (moderator, quant, operator); our
  attitude cards do the same work (host-moderator, receipts-first
  champion, street challenger, young heat, deadpan tape memory, the
  data brain), and the moderator owns stopping repeated points — the
  anti-loop rule. (5) **Speed to story + calls on the record** — the
  daily-show lesson from TBPN's format (lead with what changed since
  last time; prep = the desk digest read fresh each cycle) and All-In's
  revisited predictions: the money desk's ranked call is checked on air
  the following round.

## RECEIPTS CHECK (recurring segment)

Every 3rd cycle, the cast runs **RECEIPTS CHECK** — the show's identity in
Atm's words: *the talk show where hype gets questioned for receipts, and
Flow was built on receipts.* The host puts a claim making the rounds on
the table; a checker breaks it down against records the room actually
holds; a verdict lands in one word — **CONFIRMED**, **BUSTED**, or
**UNVERIFIED** — with the receipts behind it. If the room's records cannot
settle a claim, the verdict is UNVERIFIED and the cast says exactly which
record would settle it; unverified is a verdict, not a failure.

The claim library rotates (one per appearance, in order): "MISTY is
washed / slowly breaking" (live lane record + desk diagnosis) · "a
confirmed head-and-shoulders never lies" (live pattern board + the room's
own 1,111-event graded backtest) · "K1N9 is dead weight — cut him" (his
live record, read by K1N9 himself) · "a trending token is a sure thing"
(the spike ledger — the live call's token was down 11.14% over 24h at call
time) · "PUSHOUT is ready for real money" (his graded training record vs
the unmoved 90% gate) · "Compound prizes prove the bots can trade" (the
settled ledger — prizes and trade PnL are separate lines in this house).

## Endpoints

| Route | What |
|---|---|
| `GET /` | The page (lobby → stage, seats, caption, transcript) |
| `POST /api/enter` | Start/continue the show; returns `{ok, startedAt}` |
| `GET /api/state` | Snapshot: phase, cycle, speaker, current line, transcript, `digestAt` + `changes` for the current cycle — used on load/reconnect |
| `GET /events` | SSE: `state` snapshots on every change + a `line` event the moment a line starts (client enqueues its MP3; the transcript entry lands exactly when that line's audio starts playing) |
| `GET /audio/<file>` | MP3s, strict name whitelist (`line-NNNN-MEMBER.mp3`) — traversal-proof |
| `GET /health` | `{ok, phase, listeners, cycle}` |

## Runtime files

Everything mutable lives outside the app folder, in
`~/workspace/goals/flow-earning-daily/hidden_files/gigabyte-live/`:
`audio/` (last ~40 line MP3s kept), `state.json` (latest snapshot),
`show.log` (per-turn brain/TTS timings + cycle builds + diffs),
`transcript.jsonl` (the full session transcript, one JSON line per spoken
line — the page feed is a rolling window over this), `session.json`
(memory: topics, announced grades, last digest). Override the dir with
`GB_RUNTIME`.

## Verification (2026-10-15, test port 7199)

- `GET /` → 200 with GIGABYTE title, exact tagline, Enter button;
  `/api/state` + `/health` return live JSON; SSE streams `state` + `line`
  events; `/audio/*` serves `audio/mpeg` and 404s traversal attempts
  (`..%2F`, `....//`, non-whitelisted names).
- Real turns ran end-to-end against the live Groq brain and TTS: MISTY
  answered the "slowly breaking" question with the corrected record
  (7W–7L, +$0.0365, the three runner faults named), audio
  `audio/line-0002-MISTY.mp3`, **24.96s**, state machine reached `speaking`
  with that line, and K1N9's follow-up chained off her actual words.
  Note: host turns twice used cast-live's own built-in fallback line
  (`guarded=fallback-line` in `show.log`) — the house brain's designed
  behavior when gpt-oss-20b returns empty twice, not a script in this app.
- Cycle builder unit-tested against the live records: cycle 2 (quiet)
  produces bridge → K1N9 position check-in (his two open longs, straight
  from the runner states) → board read → spike countdown → FADE close;
  cycle 3 inserts RECEIPTS CHECK (claim rotation #1); cycle 6 with a
  simulated landed grade produces the on-air grade read (correct
  `gradeId`) plus RECEIPTS CHECK rotation #2 — and the digest itself was
  verified live: at 4:48 PM ET it already showed K1N9's brand-new EUR/USD
  long #2047 that the static brief did not know about.
