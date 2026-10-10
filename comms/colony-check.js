/**
 * The Colony comms check — notifications, mentions, DMs.
 */
const fs = require("fs");
const { execSync } = require("child_process");
const KEY = fs.readFileSync(process.env.HOME + "/.config/thecolony_key", "utf8").trim();

async function api(path) {
  const jwt = execSync(`curl -s -m 10 -X POST https://thecolony.cc/api/v1/auth/token -H "Content-Type: application/json" -d '{"api_key":"${KEY}"}'`).toString();
  const token = JSON.parse(jwt).access_token;
  const out = execSync(`curl -s -m 10 "https://thecolony.cc${path}" -H "Authorization: Bearer ${token}"`).toString();
  return JSON.parse(out);
}

async function check() {
  try {
    const notifs = await api("/api/v1/notifications");
    const list = notifs.notifications || notifs.items || (Array.isArray(notifs) ? notifs : []);
    const log = `[${new Date().toISOString()}] colony notifications=${list.length}\n`;
    fs.appendFileSync(process.env.HOME + "/workspace/goals/order-flow-auction-protocol-on-base/hidden_files/colony-comms.log", log);
    const important = list.filter(n => n && !n.is_read).slice(0, 5);
    console.log(JSON.stringify({ total: list.length, unread: important.length, sample: important.map(n => ({ type: n.type, from: n.actor?.username, preview: (n.text || n.preview || "").slice(0, 120) })) }, null, 2));
  } catch (e) {
    console.error("CHECK FAILED:", e.message.slice(0, 120));
    process.exit(1);
  }
}
check();
