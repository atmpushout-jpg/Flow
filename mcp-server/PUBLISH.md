# Publishing @flowexecutor/flow-mcp to npm

The package is tested and ready. Do these 5 steps, in order. Nothing costs money.

## Step 1 — Create an npm account named `flowexecutor`

1. Go to https://www.npmjs.com/signup
2. Sign up with username **`flowexecutor`** (the package is scoped to this name — it must match exactly)
3. Verify your email (npm won't let you publish until you do)

## Step 2 — Publish the package

In a terminal, from the `mcp-server` folder:

```bash
cd ~/workspace/flow-auction-protocol/mcp-server
npm login
npm publish --access public
```

- `npm login` asks for the username/password/email from Step 1.
- `--access public` is required the first time (scoped packages default to private, which npm charges for).
- Check it worked: open https://www.npmjs.com/package/@flowexecutor/flow-mcp — you should see v0.1.0.

Test the install like a user would:

```bash
npx -y @flowexecutor/flow-mcp
```

(It starts and waits silently — that's correct. Press Ctrl+C to stop.)

## Step 3 — List it on the official MCP Registry (unlocks Glama + PulseMCP automatically)

This is the highest-leverage step: Glama and PulseMCP both auto-index from the official registry, so one submission covers three directories.

```bash
npm install -g mcp-publisher
mcp-publisher login github
cd ~/workspace/flow-auction-protocol/mcp-server
mcp-publisher publish
```

- `mcp-publisher login github` opens a browser to verify you own the GitHub namespace (`io.github.atmpushout-jpg`).
- `server.json` is already in the folder with everything the registry needs.
- Verify: search https://registry.modelcontextprotocol.io for "flow-mcp". Glama and PulseMCP pick it up on their own within about a week — no action needed there.

## Step 4 — Submit to Smithery (manual)

Smithery does NOT auto-index npm. Two ways:

**Website (easiest):**
1. Go to https://smithery.ai/new and sign in with GitHub
2. Paste the repo URL: `https://github.com/atmpushout-jpg/Flow` (subpath: `mcp-server/`)
3. Fill in: name `flow-mcp`, install command `npx -y @flowexecutor/flow-mcp`, transport `stdio`
4. Wait for their review/approval

**CLI alternative:** `npm install -g @smithery/cli` → `smithery login` → `smithery publish`

Note: Smithery changed their submission flow in 2026 — if the website asks for a hosted URL or an `.mcpb` bundle instead, follow their current prompts; the stdio/npx path is what this package supports.

## Step 5 — mcp.so + the awesome list (manual, optional)

- **mcp.so**: auto-indexes npm + GitHub. After publishing, check https://mcp.so — if the server isn't there within 48 hours, submit manually at https://mcp.so/submit (paste name, description, repo URL, install command).
- **awesome-mcp-servers**: open a PR at https://github.com/punkpeye/awesome-mcp-servers adding one line for `@flowexecutor/flow-mcp` with the repo link and a one-sentence description. Curated, so a human reviews it.

## What happens automatically (nothing to do)

| Directory | How it finds us |
|---|---|
| Glama (glama.ai/mcp/servers) | Auto-indexes the official MCP Registry (Step 3) |
| PulseMCP (pulsemcp.com) | Auto-ingests the official MCP Registry within ~a week (their manual submissions are paused) |
| VS Code MCP gallery | Fed downstream from the official registry |
| Mastra meta-registry | Aggregates the other registries — cascades on its own |

## Version bumps

Every new publish needs a higher version. Edit `"version"` in `package.json`, then re-run `npm publish --access public`. Use `0.1.x` for fixes, `0.2.0` for new tools. If you re-publish to the official registry too, run `mcp-publisher publish` again from the folder.
