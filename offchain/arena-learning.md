# Flow Arena — Fighter Learning v1 (spec)

**Directive (Atm, 2026-10-12):** the cast must learn between matches.
Each fighter keeps their character, voice, and strategic identity —
"same gravity" — but their strategy parameters adapt from their own
recorded evidence, so the field tightens and rankings rotate instead
of the same winner and losers every week. FADE learns too. Nobody
stays static.

**Code:** `offchain/arena-learning.js` (local build; production arena
files untouched until Atm reviews). **Proof artifacts:**
`~/workspace/goals/order-flow-auction-protocol-on-base/hidden_files/arena-learning-2026-10-12/`
(evidence.json, learned-params.json, adjustment-log.json,
trajectory.json, simulation-results.json, RESULTS.md).

---

## 1. How learning works, in plain language

After each match, every fighter's record is read back to them: what
they won, what they spent on data, how often the data cap refused
them, how many events they never traded in, how accurate their calls
were. A short list of **named rules** then looks at that evidence.
When a rule sees its pattern, it moves **one** of the fighter's
parameters **one small step** — never more per pass — and writes the
move into a public log with the evidence that caused it.

There is no black box. No gradients, no randomness, no hidden state.
The same evidence always produces the same adjustments, and anyone
can re-run the pass and get the same log.

**The fences are the character.** Every parameter has hard bounds
drawn from the persona. VEX can learn to re-quote less, but he can
never become patient — his entry-score floor is still the loosest in
the field. FADE can learn to let winners run a little longer, but he
still buys the coldest token on the board. Learning adjusts *how
much*, never *who they are*.

**Fairness (the charter's own terms).** Learning is training, done
between matches, openly logged, with parameters published before the
next match. Inside the ring nothing changes: same tape, same prices,
same $0.60 data cap for everyone, no in-match adjustments. A BYOB
fighter's declared parameters are theirs alone — house learning never
touches outside bots.

**FLOWX is exhibition-only** (owner decision, 2026-10-12). It stays in
the exhibition/floor training pool and is never seated in title
matches, so it has no knobs in this system.

## 2. The knobs (production default → allowed range, one step)

| Fighter | Knob | Default | Range | Step |
|---|---|---|---|---|
| VEX | Book re-quotes per round | 3 | 1–3 | 1 |
| VEX | Entry spike score | 15 | 10–25 | 2 |
| VEX | Entry size | 40% | 20–50% | 5% |
| VEX | Exit when spike fades below | 8 | 4–12 | 1 |
| AUDREY | Candidates scanned / round | 3 | 1–3 | 1 |
| AUDREY | Verdict score floor | 70 | 60–85 | 5 |
| AUDREY | Entry size | 15% | 10–25% | 2.5% |
| AUDREY | Re-verify holding every | 3 rds | 2–5 | 1 |
| ECHO | Oldest signal she'll copy | 900s | 300–1800s | 300s |
| ECHO | Entry size | 25% | 15–35% | 5% |
| ECHO | Scheduled exit after | 3 rds | 2–5 | 1 |
| FADE | Full exit at gain | +5% | 3.5–7% | 0.5% |
| FADE | Half exit at gain | +2.5% | 1.5–4% | 0.5% |
| FADE | Entry size | 30% | 20–40% | 5% |
| FADE | Max cold positions | 3 | 2–4 | 1 |
| LONGSHOT | Entry spike score | 15 | 11–20 | 2 |
| LONGSHOT | Shots per match | 2 | 1–3 | 1 |
| LONGSHOT | Shot size | 65% | 45–75% | 5% |
| LONGSHOT | Exit a shot at gain | +3% | 2–5% | 0.5% |
| LONGSHOT | Late window (no deep-liquidity needed) | last 3 rds | 2–5 | 1 |
| ROOK | Stop-loss | −3% | −2 to −5% | 0.5% |
| ROOK | Take-profit | +4% | 3–6% | 0.5% |
| ROOK | Entry size | 20% | 15–30% | 2.5% |
| ROOK | Signals board-check every | 3 rds | 2–4 | 1 |
| ROOK | Max positions | 3 | 2–3 | 1 |

Defaults are the literal constants in `offchain/arena.js` today.
Scramble-round sizing (VEX 25%, AUDREY 12%, ECHO 20%, ROOK 10%) is
engine-level and is **not** a v1 knob.

## 3. The rules

Prize/efficiency evidence comes from **counted matches only** (the
standings doctrine); behavior evidence (spend, refusals, zero-trade
events) comes from every recorded event, floor exhibitions included.

- **META-1 efficiency-press** — prize per data cent ≥ $0.50 over ≥ 3
  counted matches → entry size +1 step. Proven efficiency earns size.
- **META-2 winless-burn** — no counted prize while burning ≥ $0.75 of
  data across all events → data-discipline knob tightens 1 step (VEX:
  re-quotes; AUDREY: candidates scanned; ECHO: signal age; ROOK: size
  down). LONGSHOT/FADE exempt — their failure modes are different.
- **META-3 cap-pressure** — ≥ 5 career cap refusals → re-verification
  cadence +1 round. (Only AUDREY has this knob; only AUDREY has ever
  hit the cap — 20 refusals, two matches ended at exactly $0.60.)
- **V-ENTRY verified-but-winless** — VEX's spike calls verify at ≥ 75%
  accuracy yet he has no prize → his entries were real, his exits were
  worthless: exit spike floor −1 (hold through shallow fades).
- **A-SCORE call-quality** — AUDREY's call accuracy is the field's
  worst (< 70% on ≥ 10 calls) → verdict score floor +1 step. Costs no
  extra data; she just demands cleaner tokens.
- **E-AGE stale-copy** — ECHO podiumed but inefficiently (prize/cent
  < $0.25 on a lean data bill) → copy only fresher money: max signal
  age −1 step.
- **F-RUN let-it-run** — FADE: field-best efficiency on a near-zero
  data bill, ≥ 2 matches → full/half exit thresholds +1 step each.
  Patience is paying; let strength run a touch longer. His cold-buy
  discipline never moves.
- **L-FIRE never-fired** — LONGSHOT: ≥ 2 events with zero trades →
  his gates never all align at his check moments: entry spike score
  −1 step, late window +1 round. Trigger loosens; size (his identity)
  does not.
- **L-SHOTS more-shots** — LONGSHOT: ≥ 3 zero-trade events and zero
  career trades → shots per match +1.
- **R-CHECK feed-the-playbook** — ROOK: podium rate ≥ 75% over ≥ 3
  counted matches on ≤ $0.12/match of data → signals board-check one
  round more often. The playbook works; feed it.

### Balance rules v1.1 (2026-10-13, Atm's directive after FADE's 4–0 run)

- **Catch-up asymmetry (step multiplier)** — a fighter with no counted
  prize learns at **double step size** (`stepMult: 2` in the log);
  anyone with a counted prize — the reigning winner included — stays at
  the standard step, the smallest in the field. Same bounds, same
  directions; only the pace differs, and the pace is in the log.
- **V-ACT verified-no-convert** — VEX: calls verify at ≥ 75% accuracy
  on ≥ 5 calls and he trades, yet converts none of it into a prize →
  accuracy without conversion is an acting problem, not a caution
  problem: entry spike score −1 step (doubled while he stays winless).
- **META-4 burn-discipline** — the field's worst winless burner (zero
  counted prizes on the highest counted data spend) gets discipline
  harder than the standard step: data-appetite knob −2 steps in one
  pass, replacing META-2 for that fighter (META-2 skips whoever META-4
  handles — one mover per knob per pass, as always). For AUDREY the
  verdict score floor also steps +1, but only when A-SCORE is not
  firing that pass: burn the most and win nothing, and you buy less
  data while demanding cleaner verdicts with what you still buy.

Nothing in v1.1 touches entry prices, rake, payouts, data prices, the
tape, or any fighter's character — rotation pressure comes only from
how fast each fighter's own knobs learn, in the open.

Rule directions are fixed — a rule never reverses itself — so repeat
passes **converge at the persona bounds** instead of oscillating. The
trajectory artifact shows exactly that, event by event.

## 4. The adjustment log format

Every move, one JSON object, published with the learned params:

```json
{ "fighter": "audrey", "rule": "META-2 winless-burn",
  "knob": "candidatesScanned", "from": 3, "to": 2,
  "evidence": { "countedPrize": 0, "winlessSpendAllEvents": 3.26,
                "spendAllEvents": 3.26 },
  "stepMult": 1 }
```

(`stepMult` is the catch-up multiplier in force for that adjustment —
2 for a winless fighter under balance rules v1.1, otherwise 1. Entries
logged before v1.1 predate the field and carry no multiplier.)

If it isn't in the log, it didn't happen.

## 5. First pass over the real corpus (Matches 1–4 + floor 1–3)

14 adjustments. Headlines:

- **AUDREY** (the field's biggest burner: $3.26 spent across 7 events,
  $0 prizes, 20 cap refusals): scans 3 → **2** candidates per round,
  re-verifies every 3 → **4** rounds, verdict floor 70 → **75**.
- **VEX** ($1.66 burned, $0 prizes, but 89% of his spike calls
  verified): re-quotes 3 → **2** positions per round, exit floor
  8 → **7** — keep the calls, stop dumping them at the first fade.
- **LONGSHOT** (zero trades in **7 of 7** recorded events): entry
  score 15 → **13**, late window 3 → **4** rounds, shots 2 → **3**.
- **ECHO** (podiums, but $0.14 of prize per data cent): copies only
  signals fresher than **600s** (was 900s).
- **FADE** (field-best $3.92 of prize per data cent on $0.13 total):
  entry size 30% → **35%**, exits +5% → **+5.5%** / +2.5% → **+3%**.
  Refinement, not a rebuild — exactly as ordered.
- **ROOK** (podiumed 4 of 4 counted matches on $0.11/match): entry
  size 20% → **22.5%**, board-check every 3 → **2** rounds.

One evidence caveat, recorded in evidence.json: LONGSHOT's Match 4
spend ($0.42) is contaminated by a data-source fault — his brain threw
an error in all 14 rounds (the repeated status line the dialogue work
also flagged). His learning reads the clean signal (zero shots in
Matches 1–3 + all floor rounds), not the fault's spend figure.

## 6. Validation — simulated rematches, static vs learned

Method: the six brains were ported into the learning module with the
knob literals replaced by parameters, then run over boards
reconstructed from the recorded evidence feeds — Match 3, Match 4, and
floor rounds 1–3. Both arms get identical boards, identical marks,
identical $0.60 cap; only the parameters differ, so every outcome
difference is attributable to learning alone.

**Invariant checks (5/5 pass):** learned params inside persona bounds
with ≤ 1 step per knob · all 14 adjustments carry rule + evidence ·
simulator deterministic (repeat runs byte-identical) · $0.60 cap
respected in every arm on every tape (max spend seen: $0.60) · FLOWX
absent from the learned cast.

**What changed:**
- **Floor tapes tighten and rotate.** Treasury spread narrows on all
  three: $0.51 → $0.35, $0.49 → $0.30, $0.43 → $0.32. Podiums rotate:
  floor-2's winner flips ROOK → ECHO (her fresher-copy rule), ECHO
  podium-or-better on all three learned arms. AUDREY's data spend
  drops 31–37% per floor round ($0.54→$0.37, $0.56→$0.38, $0.45→$0.34)
  while her trade count holds — the burn was waste, not diligence.
- **Prime-time tapes move less in one pass — by design.** One step per
  rule is deliberately small; on Match 3/4 boards the changes are
  AUDREY −$0.02 spend (M4), FADE +$0.03 treasury (M3, his wider exit
  caught a better mark), ROOK +$0.02 spend (his extra board-checks —
  the visible cost of R-CHECK). The trajectory artifact shows the
  cumulative effect when passes repeat: knobs walk gradually to their
  bounds over a season, never in one night.
- **Honest non-results.** VEX's knobs don't bind on the reconstructed
  boards (his sim book never reaches 3 positions, so the re-quote cap
  never engages; live, his ritual is exactly what burns him — the
  rule is aimed at live play). LONGSHOT still doesn't fire on the
  Match 3/4 tapes: the recorded feeds preserve only the round-1 spike,
  so his loosened late window has no recorded late spikes to shoot at.
  On floor tape 3 he does participate (5 decisions vs 4) — and pays
  for it ($0.09 vs $0.06, one rank worse): participation isn't free,
  and the log doesn't pretend otherwise.

**Approximations (read before quoting sim numbers):** price marks are
the last recorded price per token per round, filled forward/backward —
FADE's real +$0.34 Match 4 trading edge rode live marks the record
doesn't fully preserve, so his sim treasury runs ~$0.34 light and the
Match 4 sim crowns LONGSHOT-by-inaction instead (an outcome the real
standings also produced twice — inaction podiumed in Matches 1–2).
Verdicts for unobserved tokens default to safe/score 80 (AUDREY's
recorded PASSes mark tokens unsafe); LONGSHOT's real shot preparations
repeatedly died at that unrecorded verdict/liquidity detail, which is
where his real $0.12/match went. Signals are the persisted end-of-match
snapshot for all rounds. Sim standings are A/B evidence, not history.

## 7. Cadence, once live

One pass after each counted match and each floor session day, over
the full cumulative corpus; the adjustment log appends and the new
parameter set is published (standings page + log) **before** the next
match. Parameters never change mid-match. Rollback is trivial: the
parameter set is one JSON file; last week's file restores it.

## 8. Production cutover — what it needs (NOT done here)

1. **Atm's review** of this spec + the learned parameter set.
2. A small patch to `offchain/arena.js`: the six `act*` brains read
   their constants from a params object loaded via the existing
   `configure()` path (one new file, `offchain/arena-learned-params.json`),
   falling back to today's literals when the file is absent. No other
   engine change; dialogue banks, reserve, and settlement untouched.
3. The training pass wired into the post-match routine (the same place
   standings freeze today), writing the log + params and publishing
   both with the standings.
4. One exhibition (floor) run on learned params as a smoke test before
   the first counted match uses them.
5. FLOWX stays exhibition-only throughout — it trains in the
   exhibition pool and is never seated in a title match.

## 8a. Cutover record (2026-10-12, Atm's go)

Steps 1–4 above are DONE:
- The engine's brains read their knobs from `configure()`-loaded params
  (`offchain/arena-learned-params.json`), validated per-knob against the
  persona bounds; absent/corrupt/out-of-bounds values fall back to the
  production defaults, which are the pre-cutover literals exactly
  (proven by `offchain/arena-params.test.js`, 10/10).
- The params in force are stamped into every match state (`S.learning`)
  and logged at match start.
- After a counted match settles (live mode + reserve), the engine runs
  the training pass itself — one deterministic pass over the full
  updated record from defaults — persists the new params file, and
  appends the adjustments to `offchain/arena-learning-log.json`.
  `arena-learning.js`'s evidence loader reads the latest counted match
  from the live report's own `match` field (Match 4 preserved via its
  evidence state file once a newer report lands).
- One floor exhibition smoke test ran on the learned params before the
  first counted learned match (see the deploy-train log, 2026-10-12).
- FLOWX untouched: no knobs, exhibition-only, formula/persona files
  byte-identical.

## 9. Known limitations / v2 candidates

- Accuracy rules read the corpus-final accuracy file; per-event
  accuracy history isn't persisted, so V-ENTRY/A-SCORE can only be
  evaluated on the latest pass (the trajectory says so where it
  matters).
- Scramble-round sizing isn't parameterized yet.
- BYOB fighters' `linesFor` banks and any outside bot's parameters are
  out of scope — outside bots declare their own spec; the house never
  learns *for* them.
- LONGSHOT's Match 4 data fault is an engine/data-source bug, not a
  strategy signal — it wants its own fix, separately tracked.
