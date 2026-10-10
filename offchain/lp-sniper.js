/**
 * Flow LP Sniper — finds hot new Base pools for $20 LP rotation.
 * Uses DexScreener API. Run: node offchain/lp-sniper.js
 */
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function getPools(token) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []).filter((p) => p.chainId === "base");
}

async function main() {
  console.log("Scanning Base for LP opportunities...\n");

  const [wethPools, usdcPools] = await Promise.all([
    getPools(WETH),
    getPools(USDC),
  ]);

  const all = [...wethPools, ...usdcPools];
  // Dedupe by pair address
  const seen = new Set();
  const pools = all.filter((p) => {
    if (seen.has(p.pairAddress)) return false;
    seen.add(p.pairAddress);
    return true;
  });

  console.log(`Found ${pools.length} Base pools.\n`);

  const candidates = pools
    .map((p) => {
      const vol24h = p.volume?.h24 || 0;
      const liq = p.liquidity?.usd || 0;
      const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
      const ageHrs = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : 9999;
      // Est APR at 0.3% fee: (daily fees / TVL) * 365
      const estApr = liq > 0 ? ((vol24h * 0.003) / liq) * 365 * 100 : 0;
      return {
        dex: p.dexId,
        pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
        address: p.pairAddress,
        ageHrs: Math.round(ageHrs),
        vol24h, liq, txns, estApr,
      };
    })
    .filter((c) => c.liq > 15000 && c.vol24h > 30000 && c.txns > 50)
    .sort((a, b) => b.estApr - a.estApr)
    .slice(0, 8);

  if (!candidates.length) {
    console.log("No pools meet criteria right now.");
    return;
  }

  console.log("Top opportunities by est. APR:\n");
  candidates.forEach((c, i) => {
    const daily20 = ((20 * c.estApr) / 36500).toFixed(2);
    console.log(
      `${i + 1}. ${c.pair} on ${c.dex}\n` +
      `   Vol: $${c.vol24h.toLocaleString()} | Liq: $${c.liq.toLocaleString()} | ` +
      `APR: ${c.estApr.toFixed(0)}% | $20 earns ~$${daily20}/day\n` +
      `   ${c.address}\n`
    );
  });
}

main().catch((e) => { console.error("FATAL:", e.message.slice(0, 150)); process.exit(1); });
