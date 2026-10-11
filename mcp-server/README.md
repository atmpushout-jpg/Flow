# @flowexecutor/flow-mcp

MCP server for the [Flow](https://flow-kg4x.vercel.app) best-execution swap quote API on Base. Gives AI agents multi-venue swap quotes with edge, liquidity flags, and freshness metadata. Quotes are paid ($0.01 USDC via x402) and settle automatically from a **local starter wallet** — see below.

## Tools

- **`flow_wallet_setup`** — Create (or load) the local starter wallet and claim the one-time $0.05 seed. Run once before paid tools.
- **`flow_quote`** — Best-execution swap quote on Base. Compares Uniswap V3, PancakeSwap V3 and Aerodrome (plus two-hop routes via WETH), returns the winning venue, expected output, edge in bps vs baseline, a liquidity flag (`deep` / `watch` / `thin`), the exact block number and timestamp, and build latency. Auto-pays $0.01 via x402 when the starter wallet is funded.
- **`flow_health`** — API health check: status, chain, latest synced block, plus starter-wallet status. Free.

## Starter wallet & x402 auto-pay

`flow_wallet_setup` generates an EVM wallet **locally** and stores it at `~/.config/flow-wallet.json` with `0600` permissions. The key never leaves your machine, is never sent to Flow's API, and is never displayed by any tool. Fund the address it returns with USDC on Base (even $1 is plenty) — afterwards, paid Flow calls sign an EIP-3009 authorization and retry automatically.

Hard caps, enforced in code before any signature:

- **Per call:** max $0.05
- **Per day:** $1 default (rolling 24h), override with `FLOW_DAILY_SPEND_CAP_USD`

Spend is tracked locally in `~/.config/flow-spend-ledger.jsonl`. This client only ever pays Flow's own payee address; a 402 asking to pay anyone else is refused.

**Seed pilot:** setup also claims a one-time **$0.05 USDC seed** (one per address, ever) from the Flow operational wallet, so your first calls work before you fund. Pilot is capped at 19 seeds total — when it's gone, it's gone.

## Install

```bash
npm install -g @flowexecutor/flow-mcp
```

Or run without installing:

```bash
npx -y @flowexecutor/flow-mcp
```

## Configure

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "flow": {
      "command": "npx",
      "args": ["-y", "@flowexecutor/flow-mcp"]
    }
  }
}
```

### Any MCP client (stdio)

- Command: `npx -y @flowexecutor/flow-mcp`
- Transport: stdio

Optional env var: `FLOW_API_BASE` (defaults to `https://flow-kg4x.vercel.app`).

## Example

Ask your agent: *"Get me a Flow quote for 10 USDC → WETH on Base."*

The agent calls `flow_quote` with:
- `tokenIn`: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC)
- `tokenOut`: `0x4200000000000000000000000000000000000006` (WETH)
- `amountIn`: `"10"`

and gets back the winning venue, edge, liquidity flag, block number, and latency.

## Notes

- Pricing: quote $0.01 per call via x402 (USDC on Base); health is free. Quotes are informational snapshots, not execution guarantees — always verify on execution.
- Chain: Base (8453) only.

## License

MIT
