const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = "8443545096:AAFk0Z6impMy_1rYVkbaLgKOGX_RIKtXUZo";
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY; // set in Railway env vars
const GA4_ACCOUNT_ID = "514659376";
const TRIGGER = "metrics today";
// ──────────────────────────────────────────────────────────────────────────────

let offset = 0;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getMetrics() {
  const today = new Date().toISOString().split("T")[0];
  const url =
    `https://connectors.windsor.ai/googleanalytics4` +
    `?api_key=${WINDSOR_API_KEY}` +
    `&account_id=${GA4_ACCOUNT_ID}` +
    `&date_from=${today}` +
    `&date_to=${today}` +
    `&fields=active1_day_users,active7_day_users,active28_day_users,` +
    `dau_per_mau,average_session_duration,newusers,totalusers,sessions`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data?.[0] || json[0] || {});
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function formatDuration(seconds) {
  if (!seconds) return "N/A";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatNumber(n) {
  if (!n) return "N/A";
  return Math.round(n).toLocaleString("en-IN");
}

function buildMessage(data) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });

  const dau = formatNumber(data.active1_day_users);
  const wau = formatNumber(data.active7_day_users);
  const mau = formatNumber(data.active28_day_users);
  const stickiness = data.dau_per_mau
    ? (data.dau_per_mau * 100).toFixed(2) + "%"
    : "N/A";
  const avgSession = formatDuration(data.average_session_duration);
  const newUsers = formatNumber(data.newusers);
  const totalUsers = formatNumber(data.totalusers);
  const sessions = formatNumber(data.sessions);

  return (
    `📊 *Hoi.in v1 — Product Metrics (Today)*\n` +
    `🗓 _${today}_\n\n` +
    `👥 *DAU:* ${dau}\n` +
    `📅 *WAU:* ${wau}\n` +
    `🗓 *MAU:* ${mau}\n` +
    `📌 *Stickiness (DAU/MAU):* ${stickiness}\n` +
    `⏱ *Avg. Session Length:* ${avgSession}\n` +
    `🆕 *New Users:* ${newUsers}\n` +
    `👤 *Total Users:* ${totalUsers}\n` +
    `🔁 *Sessions:* ${sessions}`
  );
}

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await httpsPost(url, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });
}

async function poll() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
    const result = await httpsGet(url);

    for (const update of result.result || []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const text = msg.text.toLowerCase().trim();
      const chatId = msg.chat.id;

      if (text === TRIGGER) {
        await sendMessage(chatId, "⏳ Fetching your metrics...");
        try {
          const data = await getMetrics();
          const reply = buildMessage(data);
          await sendMessage(chatId, reply);
        } catch (err) {
          await sendMessage(chatId, "❌ Failed to fetch metrics. Please try again.");
          console.error("Metrics error:", err);
        }
      } else {
        await sendMessage(
          chatId,
          `👋 Send *"${TRIGGER}"* to get today's Hoi.in product metrics.`
        );
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  setTimeout(poll, 1000);
}

console.log("🤖 Hoi Metrics Bot is running...");
console.log(`📩 Trigger: "${TRIGGER}"`);
poll();
