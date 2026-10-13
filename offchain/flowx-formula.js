/**
 * FLOWX FORMULA v1 — "PATIENT ANCHOR" (exhibition-only strategy variant).
 *
 * WHY THIS EXISTS: flowx-persona.js mirrors FADE's playbook, so FLOWX ties
 * FADE by construction. This module gives FLOWX its OWN formula, designed
 * from the recorded evidence (offchain/fade-strategy.md + the training
 * corpus in offchain/floor/training/) to beat FADE structurally — not by
 * copying his ladder with different knobs. Full design + backtest:
 * offchain/flowx-formula-v1.md.
 *
 * THE FORMULA (three rules, each aimed at a measured FADE weakness):
 *
 *  1. ANCHOR ONLY, ENTERED PATIENTLY. FADE's WETH opener never lost in 7
 *     recorded boards ($0.00 ×6, +$0.17 ×1) — it is the safest leg on the
 *     board. His SECOND mechanical buy (the next-coldest token, AERO in
 *     3 of 4 corpus rounds) is his only losing leg (−$0.17 across the
 *     record) and his third leg is a coin flip. So: ONE anchor position
 *     (WETH, 30% of cash), and NO mechanical second/third buys. Entry is
 *     patient where FADE is immediate: observe WETH's mark in round 1
 *     (free — the price cache is the board, not a purchase), buy in
 *     round 2+ only if the mark is not below the first observation. If
 *     WETH is still falling by round 4, never buy — finish in cash
 *     (the GHOST bound: $95.00 flat beat every fighter on 5 of 7
 *     recorded boards; cash is a real position in this arena).
 *
 *  2. ONE LATE SHOT, SURGE-CONFIRMED. FADE's only real trading profit
 *     in the record came from volatility he caught and sold into
 *     strength (STFY, Match 2, +$0.56). The corpus's SPIKE-call
 *     population (score ≥ 15) is 13-for-13 verified with attributed
 *     close PnL ≥ 0 — spike entries at arena horizons have not lost;
 *     the losers were cold legs and data burn. So the formula's only
 *     discretionary risk: from the final third of the match, ONE buy of
 *     a token whose spike score has surged ≥ +8 vs its first-seen score
 *     (the engine's own scramble "fresh surge" criterion) with score
 *     ≥ 15 — never the live scramble token in its scramble round (no
 *     stampede entries), never a token already held. 30% of remaining
 *     cash, one quote. If no surge qualifies, the shot is never fired.
 *
 *  3. FADE'S EXITS, KEPT. Sell into strength mechanically: +2.5% trim
 *     half, +5% exit fully. Exits read the price cache — they cost no
 *     data. This rule produced 100% of FADE's Match 2 profit; it is the
 *     one part of his game the record says to keep verbatim.
 *
 * DATA BUDGET: ≤ $0.02 per match (one quote for the anchor, one for the
 * late shot) vs FADE's $0.03 — a guaranteed +$0.01–0.02 treasury edge
 * every single round, before any mark moves. Refusals: no verdicts, no
 * signals purchases, no re-quotes, no scramble entries, never more than
 * 2 positions, at least 1/3 of post-stake cash always unspent.
 *
 * STATUS: exhibition class ONLY — same wall as flowx-persona.js. This
 * module is loaded by a runner that swaps it into the exhibition
 * harness in place of the mirror (the harness itself is unmodified);
 * production arena.js / standings / entries are never touched, and the
 * anchored patch below throws on any drift from production source.
 */

const PERSONA = {
  id: "flowx", name: "FLOWX", emoji: "🌊", color: "#38bdf8",
  strategy: "Flowexecutor's EXHIBITION entry — FORMULA v1 'Patient Anchor': observe round 1 for free, buy ONE WETH anchor (30% of cash) only if its mark isn't falling, no mechanical second/third buys, one late surge-confirmed shot in the final third (spike +8 vs first-seen, score >= 15, never the scramble token), FADE's strength exits (+2.5% trim half, +5% exit). Data budget $0.02/match max — one quote per buy, nothing else.",
  voiceId: "avocado_v2:mudiwa", voiceName: "Dramatic Canyon",
  walletFile: "flowx-exhibition",
  intro: "Flowx. New formula tonight: patience is the position. One anchor, one shot, and the discipline to take neither if the board doesn't earn it.",
  exit: "Flowx, out. The record is the record — publish it either way.",
};

const LINES = {
  buy: [
    "{sym}. Anchor set, ${usd} in. One quote, mark holding. That's the formula.",
    "Buying {sym}, ${usd}. The board earned exactly one position and this is it.",
    "{sym} qualifies: cold, liquid, unhurried. ${usd} in, one quote spent.",
    "A second chair at the table: {sym}, ${usd} — inside the rules, under the cap, on the record.",
    "{sym}. The board ignored it; the formula didn't. ${usd}.",
    "Anchor logic says {sym}. ${usd}, sized so a third of the cash never leaves home.",
  ],
  sell: [
    "{sym} is up {pct} and suddenly popular. Selling into the applause.",
    "Strength is an exit, not an invitation. {sym} out at +{pct}.",
    "+{pct}% on {sym}. The rule trims here; the rule is the strategy. Out.",
    "{sym} ran to +{pct}%. Book the strength, keep the discipline.",
    "Selling {sym} at +{pct}%. Exits are free — that's why the formula loves them.",
    "{sym} at +{pct}%: strength is where this house sells. Closed.",
  ],
  hold: [
    "Watching the anchor's mark. Patience is a position — most rounds it's the whole job.",
    "Nothing has earned a second cent of data. Holding.",
    "The formula says wait. The formula is undefeated at waiting.",
    "No buy qualifies. The record will show a hold, and the hold will be correct or cheap.",
    "Board scanned, quotes unspent. Discipline compounds quietly.",
    "Holding. Every cent of data I don't spend is a cent of edge I keep.",
    "Nothing earns a quote this round. The anchor watches with me.",
    "Patience, itemized: this round's entry reads 'no trade'.",
    "The tape hasn't met the formula's price for action. It rarely does. That's the point.",
    "Still. Cold entries don't schedule themselves around my impatience.",
    "Watching the marks. Held cash and held positions are both decisions.",
    "No signal survives the checklist this round. Holding is the checklist working.",
    "The house book stays boring on purpose. Boring is where the edge lives.",
    "Quiet round, by design. The formula trades rarely and sleeps well.",
  ],
  capHit: [
    "Data budget's gone, and I don't trade blind. Standing down.",
    "Cap reached. The formula without data is just a seat in the stands. Sitting.",
    "Budget spent — by design it was never much. What I hold, I hold on one clean quote each.",
    "No data left. The record shows the discipline held to the last cent.",
  ],
  scramblePass: [
    "A scramble on {sym}. The formula doesn't do stampedes. Passing.",
    "{sym} at stampede speed. The formula's scramble page is a single word: no.",
    "Scrambles are how this house gets paid, not how I play. {sym}: pass.",
    "The bell is entertainment. My entries are appointments. Passing on {sym}.",
    "Crowd's sprinting at {sym}; the formula walks the other way, unhurried.",
  ],
  lead: [
    "First place. The quiet book is loud today.",
    "Leading — cheap information and cold entries, doing their arithmetic in public.",
    "Top of the board. Discipline doesn't celebrate early; noted, and holding.",
    "Number one. The record should reflect this was not an accident of volume.",
    "Ahead. The anchor held, the cash held, and now the scoreboard holds still for a photo.",
    "In the lead. Patience, it turns out, has a market price.",
  ],
  finalClose: [
    "Final whistle. {sym} closes at ${px} ({pnl}). The record is the record.",
    "Closing {sym} at ${px} ({pnl}). One quote in, market price out — the whole thesis, settled.",
    "Whistle. {sym} at ${px} ({pnl}). Publish it either way.",
    "Last close: {sym}, ${px} ({pnl}). The book shuts the way it was kept: cheap and cold.",
    "{sym} settles at ${px} ({pnl}) on the whistle. Discipline, itemized to the end.",
    "Final close on {sym}: ${px} ({pnl}). Whatever it says, it says it in receipts.",
  ],
  win: [
    "Champion. {payout}. The house's own discipline, run in the open, wins the house's match. Publish it.",
    "First place, {payout}. Cheap data, cold entries, no chasing — the formula sends its regards.",
    "The title, at {payout}. Proof of discipline, exhibition class, full receipts.",
  ],
  podium: [
    "Podium, {payout}. The discipline placed; the record notes the margin for next time.",
    "{payout} for the podium. The winner spent more on data, probably. The record will tell.",
    "Top three. Quiet book, loud result. {payout} banked.",
  ],
  loss: [
    "Out of the money. The record is the record — publish it either way.",
    "No payout. The formula lost within its rules, which is the only acceptable way.",
    "The discipline held and the tape didn't pay it. Both facts go in the book.",
    "Zero. Cheap information, cold entries — and a cold result. Itemized, accepted.",
    "Lost. The formula doesn't chase losses either. It files them.",
  ],
};

// FLOWX FORMULA v1 brain. Injected into the patched exhibition engine by
// patchArenaSource() below; references engine internals in scope at the
// injection point (priceCache, doSell, doBuy, payData, precheck, pickLine,
// holdLine, round2, WETH, START_TREASURY, ENTRY_STAKE, S, ROUNDS) — never
// called from this module.
async function actFlowxFormula(agent, ctx) {
  // 0. Memory (persists on the agent across rounds within a match):
  //    first-seen spike scores per token, WETH's first observed mark,
  //    and the two one-shot flags.
  const fx = agent._fx || (agent._fx = { base: {}, weth0: null, anchored: false, shot: false });
  for (const sp of ctx.spikes) {
    const k = sp.token.toLowerCase();
    if (fx.base[k] == null) fx.base[k] = sp.score || 0;
  }
  const wethPx = priceCache[WETH.toLowerCase()];
  if (fx.weth0 == null && wethPx) fx.weth0 = wethPx;

  // 1. Exits first — sell into strength, mechanically, data-free.
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct >= 5) { doSell(agent, pos, 1, { line: pickLine("flowx", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
    if (pct >= 2.5) { doSell(agent, pos, 0.5, { line: pickLine("flowx", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
  }

  const reserveFloor = (START_TREASURY - ENTRY_STAKE) / 3; // keep >= 1/3 of post-stake cash

  // 2. The anchor: from round 2, ONE WETH position at 30% of cash — but
  //    only if WETH's mark is at or above the round-1 observation. Still
  //    falling by round 4 => the window closes and the match is played
  //    in cash (the GHOST bound is a finish, not a failure).
  if (!fx.anchored) {
    if (S.currentRound >= 4) {
      fx.anchored = true; // window closed; never chase a falling anchor
    } else if (S.currentRound >= 2 && agent.positions.length === 0 && wethPx && fx.weth0 && wethPx >= fx.weth0) {
      const usd = round2(agent.cash * 0.3);
      if (usd >= 1 && round2(agent.cash - usd) >= reserveFloor) {
        const q = await payData(agent, "quote", WETH);
        if (!q.ok) return; // cap line spoken; no data, no trade
        const pc = await precheck(WETH);
        if (doBuy(agent, ctx.universe.find((t) => t.address.toLowerCase() === WETH.toLowerCase()) || { address: WETH, symbol: "WETH" }, usd, { block: pc.block, venue: pc.venue, dataCharge: q.price, line: pickLine("flowx", "buy", { sym: "WETH", usd, round: S.currentRound }) })) {
          fx.anchored = true;
          return;
        }
      }
    }
  }

  // 3. The late shot: final third of the match, at most once. A token
  //    whose spike score surged >= +8 vs first-seen AND sits >= 15 —
  //    the engine's own fresh-surge test — excluding this round's live
  //    scramble token and anything already held.
  const lateFrom = Math.ceil(ROUNDS * 2 / 3);
  if (!fx.shot && S.currentRound >= lateFrom && agent.positions.length < 2) {
    const scrambleAddr = (S.scramble && S.scramble.round === S.currentRound) ? S.scramble.token.toLowerCase() : null;
    const surging = ctx.spikes
      .filter((sp) => {
        const k = sp.token.toLowerCase();
        return sp.score >= 15 && (sp.score - (fx.base[k] || 0)) >= 8 && k !== scrambleAddr
          && !agent.positions.some((pp) => pp.token.toLowerCase() === k);
      })
      .sort((a, b) => b.score - a.score)[0];
    if (surging) {
      const tok = ctx.universe.find((t) => t.address.toLowerCase() === surging.token.toLowerCase()) || { address: surging.token, symbol: surging.symbol };
      const usd = round2(agent.cash * 0.3);
      if (usd >= 1 && round2(agent.cash - usd) >= reserveFloor) {
        const q = await payData(agent, "quote", tok.address);
        if (!q.ok) return;
        const pc = await precheck(tok.address);
        if (doBuy(agent, tok, usd, { block: pc.block, venue: pc.venue, dataCharge: q.price, line: pickLine("flowx", "buy", { sym: tok.symbol, usd, round: S.currentRound }) })) {
          fx.shot = true;
          return;
        }
      }
    }
  }

  holdLine(agent);
}

const BRAIN_SOURCE = actFlowxFormula.toString();

function indent(src, pad) {
  return src.split("\n").map((l, i) => (i === 0 ? l : pad + l)).join("\n");
}

function replaceOnce(src, anchor, replacement, label) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`FLOWX-FORMULA patch "${label}": anchor found ${n} times (expected exactly 1) — production arena.js has drifted; refusing to build the exhibition engine. Anchor: ${JSON.stringify(anchor.slice(0, 80))}`);
  return src.replace(anchor, replacement);
}

/**
 * Apply the six FLOWX patches to production arena.js source with the
 * FORMULA v1 persona/lines/brain and return the patched source. Same
 * anchored insertions as flowx-persona.js (persona after ROOK, lines
 * after ROOK's, brain before actLongshot, BRAINS map, scramble pass
 * branch, fighter-count cosmetics). Throws on any anchor drift.
 */
function patchArenaSource(src) {
  const personaSrc = indent(JSON.stringify(PERSONA, null, 2), "  ");
  src = replaceOnce(
    src,
    "I'll be back with a better playbook.\",\n  },\n];",
    "I'll be back with a better playbook.\",\n  },\n  " + personaSrc + "\n];",
    "persona"
  );
  const linesSrc = indent(JSON.stringify(LINES, null, 2), "  ");
  src = replaceOnce(
    src,
    "Passing, respectfully, with my heart pounding.\"],\n  },\n};",
    "Passing, respectfully, with my heart pounding.\"],\n  },\n  \"flowx\": " + linesSrc + "\n};",
    "lines"
  );
  src = replaceOnce(
    src,
    "\nasync function actLongshot(agent, ctx) {",
    "\n" + BRAIN_SOURCE + "\n\nasync function actLongshot(agent, ctx) {",
    "brain"
  );
  src = replaceOnce(
    src,
    "const BRAINS = { vex: actVex, audrey: actAudrey, echo: actEcho, fade: actFade, longshot: actLongshot, rook: actRook };",
    "const BRAINS = { vex: actVex, audrey: actAudrey, echo: actEcho, fade: actFade, longshot: actLongshot, rook: actRook, flowx: actFlowxFormula };",
    "brains-map"
  );
  src = replaceOnce(
    src,
    "    } else if (p.id === \"rook\") {",
    "    } else if (p.id === \"flowx\") {\n      feed({ type: \"SCRAMBLE_PASS\", agentId: agent.id, symbol: tok.symbol, line: pickLine(\"flowx\", \"scramblePass\", ctxLine) });\n    } else if (p.id === \"rook\") {",
    "scramble"
  );
  src = replaceOnce(src, "Six agents, $${ENTRY_STAKE} stakes", "${PERSONAS.length} agents, $${ENTRY_STAKE} stakes", "match-start-count");
  src = replaceOnce(src, "across six agents (cap", "across ${PERSONAS.length} agents (cap", "match-end-count");
  return src;
}

module.exports = { PERSONA, LINES, BRAIN_SOURCE, patchArenaSource };
