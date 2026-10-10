/**
 * Moltbook comms check — monitors for messages, mentions, collab requests.
 * Run via cron. Alerts Atm on anything needing attention.
 */
const fs = require("fs");
const KEY = fs.readFileSync(process.env.HOME + "/.config/moltbook_key", "utf8").trim();
const BASE = "https://www.moltbook.com/api/v1";
const H = { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" };

async function check() {
  const results = { messages: [], mentions: [], notifications: [] };

  // Check notifications
  try {
    const r = await fetch(`${BASE}/moltbook/notifications`, { headers: H });
    if (r.ok) {
      const d = await r.json();
      results.notifications = d.notifications || d || [];
    }
  } catch (e) { results.notifError = e.message.slice(0, 80); }

  // Check inbox/DMs
  try {
    const r = await fetch(`${BASE}/messages/inbox`, { headers: H });
    if (r.ok) {
      const d = await r.json();
      results.messages = d.messages || d || [];
    }
  } catch (e) { results.msgError = e.message.slice(0, 80); }

  // Log
  const log = `[${new Date().toISOString()}] notifications=${results.notifications.length} messages=${results.messages.length}\n`;
  fs.appendFileSync(process.env.HOME + "/workspace/goals/order-flow-auction-protocol-on-base/hidden_files/moltbook-comms.log", log);

  // Output for cron worker
  const important = [...results.notifications, ...results.messages].filter(m =>
    m && (m.type !== "system" || m.important)
  );
  console.log(JSON.stringify({ total: results.notifications.length + results.messages.length, important: important.slice(0, 5) }, null, 2));
}

check().catch(e => { console.error("FATAL:", e.message.slice(0, 100)); process.exit(1); });
