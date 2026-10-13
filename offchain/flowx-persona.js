/**
 * FLOWX — Flowexecutor's standing EXHIBITION fighter for the Flow Arena.
 *
 * FLOWX is the codified FADE-discipline playbook (offchain/fade-strategy.md)
 * wearing a name tag: skip the scramble, WETH first, then the coldest token
 * at ~30% of remaining cash, max 3 positions, >= 1/3 of post-stake cash
 * always held back, HOLD by default, sell into strength (+2.5% trim half,
 * +5% exit fully). Information discipline: exactly one $0.01 quote per buy —
 * no verdicts, no signals purchases, no re-quotes.
 *
 * STATUS: exhibition class ONLY. FLOWX exists so the house can benchmark
 * its own playbook against the cast on live tape. It is NOT one of the six
 * production personas in arena.js, it never appears in public standings,
 * public pages, or any public file, and its results are filed as
 * EXHIBITION records (the class the standings module never counts).
 *
 * HOW IT RUNS: production arena.js stays byte-identical. The exhibition
 * harness (offchain/arena-exhibition.js) builds a patched engine copy in
 * offchain/floor/exhibition-engine/ by applying the anchored insertions in
 * patchArenaSource() below — the same six patches the original one-off
 * FLOWX exhibition (2026-10-12, /tmp/flowx-exhibition) used, canonized
 * here as the single source. Every anchor must match production arena.js
 * EXACTLY once; any drift throws and no engine is built. Fail loud, never
 * silently run a 6-fighter match wearing an exhibition label.
 */

const PERSONA = {
  id: "flowx", name: "FLOWX", emoji: "🌊", color: "#38bdf8",
  strategy: "Flowexecutor's EXHIBITION entry — FADE-discipline: skip the scramble, WETH first, then the coldest token at ~30% of remaining cash, max 3 positions, at least 1/3 of cash always held back, HOLD by default, sell into strength (+2.5% trim half, +5% exit). One quote per buy; no verdicts, no signals, no re-quotes.",
  voiceId: "avocado_v2:mudiwa", voiceName: "Dramatic Canyon",
  walletFile: "flowx-exhibition",
  intro: "Flowx. I keep this house's books every day — tonight I find out if the discipline survives contact with the tape. Cheap information, cold entries, no chasing.",
  exit: "Flowx, out. The record is the record — publish it either way.",
};

const LINES = {
  buy: [
    "{sym}. Cold board, one clean quote, ${usd} in. That's the whole thesis.",
    "Buying {sym}, ${usd}. Thirty percent of what's left, no ceremony.",
    "{sym} qualifies: cold, liquid, unhurried. ${usd} in, one quote spent.",
    "A second chair at the table: {sym}, ${usd} — inside the rules, under the cap, on the record.",
    "{sym}. The board ignored it; the playbook didn't. ${usd}.",
    "Anchor logic says {sym}. ${usd}, sized so a third of the cash never leaves home.",
  ],
  sell: [
    "{sym} is up {pct} and suddenly popular. Selling into the applause.",
    "Strength is an exit, not an invitation. {sym} out at +{pct}.",
    "+{pct}% on {sym}. The rule trims here; the rule is the strategy. Out.",
    "{sym} ran to +{pct}%. Book the strength, keep the discipline.",
    "Selling {sym} at +{pct}%. Exits are free — that's why this book loves them.",
    "{sym} at +{pct}%: strength is where this house sells. Closed.",
  ],
  hold: [
    "Nothing cold enough, nothing strong enough. Holding — that's most of the job.",
    "Cash is a position. A third of it stays home, minimum. Watching.",
    "The book says wait. The book is undefeated at waiting.",
    "No buy qualifies. The record will show a hold, and the hold will be correct or cheap.",
    "Board scanned, quotes unspent. Discipline compounds quietly.",
    "Holding. Every cent of data I don't spend is a cent of edge I keep.",
    "Nothing earns a quote this round. The anchor watches with me.",
    "Patience, itemized: this round's entry reads 'no trade'.",
    "The tape hasn't met my price for action. It rarely does. That's the point.",
    "Still. Cold entries don't schedule themselves around my impatience.",
    "Watching the marks. Held cash and held positions are both decisions.",
    "No signal survives the checklist this round. Holding is the checklist working.",
    "The house book stays boring on purpose. Boring is where the edge lives.",
    "Quiet round, by design. This book trades rarely and sleeps well.",
  ],
  capHit: [
    "Data budget's gone, and I don't trade blind. Standing down.",
    "Cap reached. Without data this is just a seat in the stands. Sitting.",
    "Budget spent — by design it was never much. What I hold, I hold on one clean quote each.",
    "No data left. The record shows the discipline held to the last cent.",
  ],
  scramblePass: [
    "A scramble on {sym}. I sell the tickets here — I don't chase stampedes. Passing.",
    "{sym} at stampede speed. The playbook's scramble page is a single word: no.",
    "Scrambles are how this house gets paid, not how I play. {sym}: pass.",
    "The bell is entertainment. My entries are appointments. Passing on {sym}.",
    "Crowd's sprinting at {sym}; I walk the other way, unhurried.",
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
    "First place, {payout}. Cheap data, cold entries, no chasing — the book sends its regards.",
    "The title, at {payout}. Proof of discipline, exhibition class, full receipts.",
  ],
  podium: [
    "Podium, {payout}. The discipline placed; the record notes the margin for next time.",
    "{payout} for the podium. The winner spent more on data, probably. The record will tell.",
    "Top three. Quiet book, loud result. {payout} banked.",
  ],
  loss: [
    "Out of the money. The record is the record — publish it either way.",
    "No payout. The playbook lost within its rules, which is the only acceptable way.",
    "The discipline held and the tape didn't pay it. Both facts go in the book.",
    "Zero. Cheap information, cold entries — and a cold result. Itemized, accepted.",
    "Lost. This book doesn't chase losses either. It files them.",
  ],
};

// FLOWX's brain. Defined here so its source can be injected into the
// patched exhibition engine (BRAIN_SOURCE below). It references engine
// internals (priceCache, doSell, doBuy, payData, precheck, pickLine,
// holdLine, round2, WETH, START_TREASURY, ENTRY_STAKE, S) that exist in
// arena.js's scope at injection point — it is never called from this
// module. Logic is verbatim the codified playbook from fade-strategy.md.
async function actFlowx(agent, ctx) {
  // FLOWX — Flowexecutor's exhibition entrant, running the FADE-discipline
  // playbook codified in offchain/fade-strategy.md:
  //   - sell into strength first: +2.5% trim half, +5% exit fully (STFY rule)
  //   - opening buy is WETH; the round-1 scramble token is never bought
  //     (scrambles are passed in runScramble)
  //   - then the coldest token on the board (lowest social-velocity score)
  //   - size ~30% of remaining cash; max 3 positions; keep >= 1/3 of the
  //     post-stake cash in reserve; HOLD is the default action
  //   - information: exactly one $0.01 quote per buy — no verdicts, no
  //     signals purchases, no re-quotes (same as FADE's record)
  for (const pos of [...agent.positions]) {
    const px = priceCache[pos.token.toLowerCase()] || pos.entryPrice;
    const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
    if (pct >= 5) { doSell(agent, pos, 1, { line: pickLine("flowx", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
    if (pct >= 2.5) { doSell(agent, pos, 0.5, { line: pickLine("flowx", "sell", { sym: pos.symbol, pct: pct.toFixed(1), round: S.currentRound }) }); return; }
  }
  if (agent.positions.length < 3) {
    let target = null;
    if (!agent._opened) {
      // opening move: WETH first
      target = ctx.universe.find((t) => t.address.toLowerCase() === WETH.toLowerCase()) || null;
    } else {
      const scored = ctx.universe.map((t) => {
        const sv = ctx.spikes.find((sp) => sp.token.toLowerCase() === t.address.toLowerCase());
        return { tok: t, score: sv ? sv.score : 0 };
      }).sort((a, b) => a.score - b.score);
      const cold = scored.find((c) => !agent.positions.some((pp) => pp.token.toLowerCase() === c.tok.address.toLowerCase()));
      target = cold ? cold.tok : null;
    }
    if (target) {
      const usd = round2(agent.cash * 0.3);
      const reserveFloor = (START_TREASURY - ENTRY_STAKE) / 3; // keep >= 1/3 of post-stake cash
      if (usd >= 1 && round2(agent.cash - usd) >= reserveFloor) {
        const q = await payData(agent, "quote", target.address);
        if (!q.ok) return; // cap line spoken; no data, no trade
        const pc = await precheck(target.address);
        if (doBuy(agent, target, usd, { block: pc.block, venue: pc.venue, dataCharge: q.price, line: pickLine("flowx", "buy", { sym: target.symbol, usd, round: S.currentRound }) })) {
          agent._opened = true;
          return;
        }
      }
    }
  }
  holdLine(agent);
}

const BRAIN_SOURCE = actFlowx.toString();

function indent(src, pad) {
  return src.split("\n").map((l, i) => (i === 0 ? l : pad + l)).join("\n");
}

function replaceOnce(src, anchor, replacement, label) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`FLOWX patch "${label}": anchor found ${n} times (expected exactly 1) — production arena.js has drifted; refusing to build the exhibition engine. Anchor: ${JSON.stringify(anchor.slice(0, 80))}`);
  return src.replace(anchor, replacement);
}

/**
 * Apply the six FLOWX patches to production arena.js source and return the
 * patched source. Throws on any anchor drift. Patches:
 *  1. FLOWX persona appended to PERSONAS (after ROOK).
 *  2. FLOWX line bank added to LINES (after ROOK's).
 *  3. actFlowx brain inserted before actLongshot.
 *  4. BRAINS map gains flowx.
 *  5. runScramble gains the FLOWX pass branch (before ROOK's).
 *  6. Cosmetic: "Six agents" / "across six agents" -> fighter count.
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
    "const BRAINS = { vex: actVex, audrey: actAudrey, echo: actEcho, fade: actFade, longshot: actLongshot, rook: actRook, flowx: actFlowx };",
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
