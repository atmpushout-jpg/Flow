# /api/verify — what it checks

`POST /api/verify` with `{ "address": "0x...", "chain": "base" }`
(`"token"` is accepted as an alias for `"address"`; chain defaults to `base`).

Read-only. Never touches funds. Dependency-free (stdlib `fetch` + raw
JSON-RPC only — no `ethers`, no `../_lib`). x402-gated only when
`X402_ENABLED=true`, exactly like `/api/quote` (free/bypass otherwise).

## Checks, in order

1. **Contract exists** — `eth_getCode`. Empty code → the address is an EOA
   (regular wallet), not a contract. Verdict: `caution`, advice
   `REVIEW_MANUALLY` ("nothing to approve, but no on-chain guarantees either").

2. **ERC20 sanity** — `eth_call` for `name()` / `symbol()` / `decimals()` /
   `totalSupply()` using hardcoded selectors. Reported in `details`; failures
   are tolerated (non-ERC20 contracts still get the remaining checks).

3. **Verified source (Sourcify, free, no key)** —
   `GET sourcify.dev/server/v2/contract/{chainId}/{address}?fields=sources,proxyResolution`.
   Records `sourceVerified` (`exact_match` / `match`) and pulls the full
   source files for the privilege scan. **Unverified → −25, high flag:**
   "the real logic cannot be inspected."

4. **Proxy detection** — Sourcify's own `proxyResolution` first; if Sourcify
   doesn't know, on-chain fallback in this order:
   - EIP-1167 minimal-proxy bytecode pattern → implementation address parsed
     from bytecode
   - EIP-1967 implementation slot
     (`0x360894…382bbc`) + admin slot (`0xb53127…319a`)
   - ZeppelinOS legacy implementation slot
     (`keccak("org.zeppelinos.proxy.implementation")`)
   - EIP-1967 beacon slot → `implementation()` on the beacon
   - EIP-2535 diamond (`facetAddresses()`)
   
   Any proxy → **−10, medium flag** ("upgradeable — code can be swapped by
   the upgrade keys"). The implementation contract's source is then fetched
   from Sourcify and scanned instead of the proxy's; unverified implementation
   → **−10 more, high flag**.

5. **Privilege scan (heuristic regex over verified source)** — each hit is a
   flag with a plain-English explanation and a score deduction:

   | Pattern | Severity | Deduct | Meaning |
   |---|---|---|---|
   | `selfdestruct(` | critical | 40 | contract can be destroyed, trapping funds |
   | `blacklist` (any) | high | 20 | owner can block addresses from moving tokens |
   | `function mint(` | high | 15 | owner can inflate supply at will |
   | `Pausable` / `function pause(` | high | 15 | one key can freeze all transfers |
   | `buyTax`/`sellTax`/`_taxFee`/… | medium | 10 | transfer taxes coded in |
   | `function set*(Fee\|Tax)(` | medium | 10 | owner can raise fees after launch |
   | `maxTxAmount`/`maxWallet…`/`tradingEnabled`/… | medium | 8 | transfer limits or trading on/off switch |
   | `.delegatecall(` | medium | 8 | execution delegated to external code |
   | `UUPSUpgradeable`/`Initializable` | low | 0 | informational only |

   Well-known tokens (WETH, USDC, USDbC, DAI, cbBTC) get these as
   **info, −0** — e.g. USDC's blacklist/mint/pause are the issuer's
   documented, regulated controls, not red flags.

6. **Ownership** — `owner()` call; falls back to nothing (no revert = info
   note). Zero address → renounced (good, no deduction). EOA owner →
   **−10, medium** ("single key controls the contract"). Contract owner →
   info ("possibly a multisig — verify it"). A separate proxy admin is
   reported as info.

7. **Honeypot simulation (Base only, skips canonical tokens)** — quotes a
   **buy of 0.01 WETH → token** then **sells the proceeds → WETH**, using both
   the Aerodrome Slipstream quoter and the Uniswap V3 quoter across all fee
   tiers / tick spacings (best quote wins each leg):
   - can't buy anywhere → **−15, medium** ("no DEX liquidity found")
   - can buy but can't sell → **−60, critical** ("HONEYPOT SIGNAL")
   - round-trip < 70% → **−25, high**; < 90% → **−10, medium**
   - ≥ 90% → info ("simulation healthy")

## Scoring → verdict

Start at 100, subtract deductions, clamp 0–100.
- **≥ 80 → `safe`** · agentAdvice `APPROVE`
- **50–79 → `caution`** · agentAdvice `REVIEW_MANUALLY`
- **< 50 → `danger`** · agentAdvice `DO_NOT_APPROVE`

`summary` is a 2–4 sentence plain-English report built from the findings.
Every response carries the `disclaimer`: heuristic pre-screen, not an audit.

## Data sources (all free, no keys)

- Base (and eth/optimism/arbitrum/polygon) public RPCs — `eth_getCode`,
  `eth_call`, `eth_getStorageAt`
- Sourcify v2 API — verification status, source files, proxy resolution
- On-chain DEX quoters (Aerodrome `0x254cF9E1…15b0`, Uniswap
  `0x3d4e44Eb1…35B76a`) — `eth_call` only, never executes

## Known limitations (be honest about these)

- The privilege scan is **regex over source text**, not semantic analysis. It
  can miss obfuscated logic and can false-positive on dead code or comments.
- Unverified contracts can't be privilege-scanned at all — the endpoint says
  so explicitly instead of guessing.
- The honeypot sim quotes 0.01 WETH; tiny/illiquid pools can produce noisy
  round-trip numbers, and tokens that only trade off-DEX (or on venues other
  than Uniswap/Aerodrome) report "no pool found."
- Proxy detection covers EIP-1167, EIP-1967 (impl/admin/beacon), ZeppelinOS
  legacy, and EIP-2535 diamonds. Exotic proxy schemes could slip through —
  an unverified implementation is always flagged regardless.
- `owner()` only reflects the Ownable pattern; role-based access
  (e.g. `masterMinter`, `pauser`) is visible only via the source scan.
- Nothing here replaces an audit. A `safe` verdict means "no known red
  flags found," not "proven secure."
