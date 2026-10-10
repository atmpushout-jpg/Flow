# @flowexecutor/flow-mcp

MCP server for the [Flow](https://flow-kg4x.vercel.app) best-execution swap quote API on Base. Gives AI agents multi-venue swap quotes with edge, liquidity flags, and freshness metadata — read-only, no keys, no funds move.

## Tools

- **`flow_quote`** — Best-execution swap quote on Base. Compares Uniswap V3 and Aerodrome, returns the winning venue, expected output, edge in bps vs baseline, a liquidity flag (`deep` / `watch` / `thin`), the exact block number and timestamp, and build latency.
- **`flow_health`** — API health check: status, chain, latest synced block.

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

- Free during beta. Quotes are informational snapshots, not execution guarantees — always verify on execution.
- Chain: Base (8453) only.

## License

MIT
