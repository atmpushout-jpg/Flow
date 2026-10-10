# @flowexecutor/flow-mcp

MCP (Model Context Protocol) server wrapper for the **Flow best-execution API** on Base.
Gives any MCP-compatible AI agent direct access to multi-venue DEX quoting —
Uniswap V3 + Aerodrome Slipstream/legacy — with no API key.

Live API: `https://flow-kg4x.vercel.app`

## Tools

### `flow_quote`
Get the best-execution quote for swapping one ERC-20 token for another on Base.
Compares venues and returns the best route, expected output, venue, fee tier,
and edge vs baseline in basis points.

| Param | Type | Required | Description |
|---|---|---|---|
| `tokenIn` | string | yes | ERC-20 address of input token |
| `tokenOut` | string | yes | ERC-20 address of output token |
| `amountIn` | string | yes | Input amount in **raw units** (e.g. USDC has 6 decimals → `$1 = "1000000"`) |

### `flow_health`
Check Flow API + Base chain health. Returns chain id, latest block, API status.

## Known token addresses (Base, chainId 8453)

| Token | Address |
|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

## Install & run

```bash
cd mcp-server
npm install
npm start            # speaks MCP over stdio
```

Point the API elsewhere if needed:

```bash
FLOW_API_URL=https://your-fork.vercel.app npm start
```

## Use with an MCP client (e.g. Claude Desktop)

Add to your MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "flow": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/index.js"]
    }
  }
}
```

## Publish (maintainer)

```bash
cd mcp-server
npm login
npm publish --access public
```

## Notes

- `flow_quote` is a live read against real Base mainnet liquidity. No key, no signup.
- The underlying `/api/fill` endpoint is currently a stub (returns "queued",
  does not execute) — this MCP server intentionally does **not** expose it.
- Quotes are size-dependent: thin pools can show large edge at large sizes that
  vanishes at small sizes. Always quote at your real trade size.
