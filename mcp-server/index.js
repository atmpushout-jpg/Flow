#!/usr/bin/env node
/**
 * @flowexecutor/flow-mcp — MCP server for the Flow best-execution swap quote API on Base.
 *
 * Tools:
 *   flow_wallet_setup — create (or load) the LOCAL Flow starter wallet and
 *                 claim the $0.05 seed pilot. The key is generated and kept
 *                 in the user's own ~/.config/flow-wallet.json (0600);
 *                 it is never sent anywhere and never shown by any tool.
 *   flow_quote  — multi-venue swap quote (Uniswap V3, PancakeSwap V3,
 *                 Aerodrome, two-hop routes) with edge vs baseline,
 *                 liquidity flag, block number and latency. PAID ($0.01
 *                 USDC via x402): auto-pays from the starter wallet when
 *                 it exists, is funded, and the price is within the hard
 *                 caps ($0.05/call, $1/day default).
 *   flow_health — API health check (chain, latest block) + starter-wallet
 *                 status when a wallet exists. Free.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadOrCreateWallet,
  loadWallet,
  getUsdcBalance,
  fetchWithPayment,
  dailyCapUsd,
  PER_CALL_CAP_USD,
} from "./wallet.js";

const API_BASE = process.env.FLOW_API_BASE || "https://flow-kg4x.vercel.app";

const server = new McpServer({
  name: "@flowexecutor/flow-mcp",
  version: "0.2.0",
});

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  return res.json();
}

function fundingInstructions(address) {
  return (
    `Fund it by sending USDC on Base (chain 8453) to ${address} — even $1 is plenty. ` +
    `That is the only manual step: afterwards paid Flow calls settle automatically within the caps.`
  );
}

server.tool(
  "flow_wallet_setup",
  "Set up the Flow starter wallet: generates a NEW EVM wallet locally on first use " +
    "(stored only in your own ~/.config/flow-wallet.json, mode 0600 — the key never leaves " +
    "this machine and is never displayed), or loads the existing one. Returns the public " +
    "address, funding instructions, current USDC balance, and claims the one-time $0.05 " +
    "starter seed from the Flow seed pilot when available. Run this once before paid tools.",
  {},
  async () => {
    const { address, created } = loadOrCreateWallet();
    const balance = await getUsdcBalance(address);
    let seedLine = "Seed pilot: not claimed (claim endpoint unreachable).";
    try {
      const r = await fetch(`${API_BASE}/api/starter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.status) {
        seedLine =
          `Seed pilot: claim ${d.status}` +
          (d.alreadyClaimed ? " (claimed previously — one seed per address, ever)" : "") +
          (d.txHash ? `, tx ${d.txHash}` : "") +
          ". The $0.05 USDC seed arrives from the Flow operational wallet once the claim is processed.";
      } else if (d.error) {
        seedLine = `Seed pilot: ${d.error}`;
      }
    } catch {
      /* keep default line */
    }
    const lines = [
      created
        ? `Starter wallet created locally: ${address}`
        : `Starter wallet already exists: ${address}`,
      `USDC balance: ${balance === null ? "unavailable (RPC unreachable)" : `$${balance.toFixed(4)}`}`,
      fundingInstructions(address),
      `Spend caps (enforced in code): max $${PER_CALL_CAP_USD} per call, $${dailyCapUsd()} per day (rolling 24h).`,
      seedLine,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "flow_quote",
  "Get a best-execution swap quote on Base. Compares Uniswap V3, PancakeSwap V3 and Aerodrome (plus two-hop routes via WETH), " +
    "returns the winning venue, expected output, edge in bps vs the baseline, " +
    "a liquidity flag (deep/watch/thin), the exact block number and timestamp, " +
    "and build latency. Paid endpoint ($0.01 USDC via x402): if you have run " +
    "flow_wallet_setup and funded the starter wallet, payment is automatic " +
    "within the spend caps. The quote itself is read-only — no swap executes.",
  {
    tokenIn: z
      .string()
      .describe("Input token contract address on Base (e.g. USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)"),
    tokenOut: z
      .string()
      .describe("Output token contract address on Base (e.g. WETH 0x4200000000000000000000000000000000000006)"),
    amountIn: z
      .string()
      .describe("Human-readable input amount, e.g. \"10\" for 10 USDC"),
    chainId: z
      .number()
      .optional()
      .describe("Chain id, defaults to 8453 (Base)"),
  },
  async ({ tokenIn, tokenOut, amountIn, chainId = 8453 }) => {
    const url = `${API_BASE}/api/quote`;
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenIn, tokenOut, amountIn, chainId }),
    };
    let out;
    try {
      out = await fetchWithPayment(url, init);
    } catch (e) {
      return { content: [{ type: "text", text: `Flow quote payment refused: ${e.message}` }] };
    }
    const text = await out.res.text();
    let q;
    try {
      q = JSON.parse(text);
    } catch {
      q = { raw: text, status: out.res.status };
    }
    if (out.res.status === 402) {
      const wallet = loadWallet();
      const hint = out.needsWallet || !wallet
        ? "No starter wallet yet — run flow_wallet_setup first, fund the address it returns, then retry."
        : out.insufficientFunds
          ? `Starter wallet ${wallet.address} has $${out.insufficientFunds.balance.toFixed(4)} USDC but this call needs $${out.insufficientFunds.needed}. ${fundingInstructions(wallet.address)}`
          : "Payment could not be completed automatically.";
      return {
        content: [
          { type: "text", text: `Flow quote is a paid x402 endpoint ($0.01 USDC on Base). ${hint}` },
          { type: "text", text: JSON.stringify(q, null, 2) },
        ],
      };
    }
    if (q.error) {
      return { content: [{ type: "text", text: `Flow quote error: ${q.error}` }] };
    }
    const summary = [
      `Best output: ${q.bestOut} ${tokenOut.slice(0, 10)}… via ${q.venue}`,
      `Edge vs baseline: ${q.edgeBps} bps`,
      `Liquidity: ${q.liquidity} | Spread: ${q.spreadBps} bps`,
      `Block ${q.blockNumber} @ ${q.quotedAt} (${q.latencyMs}ms build)`,
      `Protocol fee: ${q.protocolFee}`,
      out.payment
        ? `Paid $${out.payment.priceUsd} USDC via x402 from starter wallet ${out.payment.payer} (auto-pay, within caps).`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(q, null, 2) },
      ],
    };
  }
);

server.tool(
  "flow_health",
  "Check the Flow quote API health: status, chain, and latest synced block number. " +
    "Also reports starter-wallet status (address + USDC balance) when a wallet exists. Free.",
  {},
  async () => {
    const h = await getJson("/api/health");
    const lines = [JSON.stringify(h, null, 2)];
    const wallet = loadWallet();
    if (wallet) {
      const balance = await getUsdcBalance(wallet.address);
      lines.push(
        `Starter wallet: ${wallet.address} — USDC balance: ${
          balance === null ? "unavailable (RPC unreachable)" : `$${balance.toFixed(4)}`
        }`
      );
    } else {
      lines.push("Starter wallet: none yet — run flow_wallet_setup to create one locally.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
