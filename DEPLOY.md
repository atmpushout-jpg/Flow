# Flow Agent API — Deploy to Vercel (free)

## Cost: $0/month

Vercel's free tier includes 100GB bandwidth and serverless function
executions — more than enough for an agent-facing quote API.

## Steps (5 minutes)

1. **Push to GitHub:**
   ```bash
   cd ~/workspace/flow-auction-protocol
   git add api/ vercel.json
   git commit -m "Agent API for Vercel"
   git push
   ```

2. **Deploy:**
   - Go to [vercel.com](https://vercel.com) → sign up with GitHub
   - "Add New Project" → import `flow-auction-protocol`
   - Framework: "Other". Root directory: `./`
   - Deploy. Done.

3. **Your endpoints:**
   - `https://YOUR_PROJECT.vercel.app/api/quote`
   - `https://YOUR_PROJECT.vercel.app/api/fill`
   - `https://YOUR_PROJECT.vercel.app/api/health`

4. **Update AGENT_README.md** with your real URL.

## Why Vercel over Railway/Render?

- Free tier doesn't sleep (serverless, not a persistent server)
- No credit card required
- Auto-deploys on git push
- Global edge network = fast for agents anywhere

## Limits (free tier)

- 10s max per function (quote has 30s configured, may need Hobby $20/mo
  for longer — but quotes run in ~1s, so fine)
- 100GB bandwidth/month (thousands of agent calls)
