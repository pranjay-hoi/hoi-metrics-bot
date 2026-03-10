const https = require("https");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const GA4_ACCOUNT_ID = "514659376";
const TRIGGER = "metrics today";
const PORT = process.env.PORT || 3000;
// ──────────────────────────────────────────────────────────────────────────────

// Keep-alive HTTP server so Railway doesn't sleep the container
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Hoi Metrics Bot is alive!");
}).listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

let offset = 0;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("JSON parse error: " + data.slice(0, 300)));
        }
      });
    }).on("error", reject);
  });
}

function httpsPost(hostname, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, raw: data }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function telegramRequest(method, payload) {
  const result = await httpsPost(
    "api.telegram.org",
    `/bot${TELEGRAM_TOKEN}/${method}`,
    payload
  );
  if (!result.ok) {
    console.error(`❌ Telegram ${method} failed:`, JSON.stringify(result));
  }
  return result;
}

async function getMetrics() {
  const today = new Date().toISOString().split("T")[0];
  const fields = [
    "active1_day_users",
    "active7_day_users",
    "active28_day_users",
    "dau_per_mau",
    "average_session_duration",
    "newusers",
    "totalusers",
    "sessions",
  ].join(",");

  const url =
    `https://connectors.windsor.ai/googleanalytics4` +
    `?api_key=${WINDSOR_API_KEY}` +
    `&account_id=${GA4_ACCOUNT_ID}` +
    `&date_from=${today}` +
    `&date_to=${today}` +
    `&fields=${fields}`;

  console.log("📡 Fetching Windsor.ai data for", today);
  const response = await httpsGet(url);
  console.log("📦 Windsor response:", JSON.stringify(response).slice(0, 300));

  const rows = response?.data || (Array.isArray(response) ? response : null);
  if (!rows || rows.length === 0) throw new Error("No data from Windsor.ai");
  return rows[0];
}

function fmt(n) {
  if (n == null || isNaN(n)) return "N/A";
  return Math.round(n).toLocaleString("en-IN");
}

function fmtDuration(s) {
  if (s == null || isNaN(s)) return "N/A";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function buildMessage(d) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });
  const stickiness = d.dau_per_mau != null
    ? (parseFloat(d.dau_per_mau) * 100).toFixed(2) + "%"
    : "N/A";

  return [
    `📊 *Hoi\\.in v1 — Product Metrics \\(Today\\)*`,
    `🗓 _${today}_`,
    ``,
    `👥 *DAU:* ${fmt(d.active1_day_users)}`,
    `📅 *WAU:* ${fmt(d.active7_day_users)}`,
    `🗓 *MAU:* ${fmt(d.active28_day_users)}`,
    `📌 *Stickiness \\(DAU/MAU\\):* ${stickiness}`,
    `⏱ *Avg\\. Session Length:* ${fmtDuration(d.average_session_duration)}`,
    `🆕 *New Users:* ${fmt(d.newusers)}`,
    `👤 *Total Users:* ${fmt(d.totalusers)}`,
    `🔁 *Sessions:* ${fmt(d.sessions)}`,
  ].join("\n");
}

async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
  });
}

async function poll() {
  try {
    const result = await telegramRequest("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message"],
    });

    if (result.ok && result.result?.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const text = msg.text.toLowerCase().trim();
        const chatId = msg.chat.id;
        console.log(`💬 Message from ${chatId}: "${text}"`);

        if (text === TRIGGER) {
          await sendMessage(chatId, "⏳ Fetching your metrics\\.\\.\\.");
          try {
            const data = await getMetrics();
            await sendMessage(chatId, buildMessage(data));
            console.log("✅ Metrics sent successfully");
          } catch (err) {
            console.error("❌ Metrics fetch error:", err.message);
            await sendMessage(chatId, "❌ Failed to fetch metrics\\. Please try again\\.");
          }
        } else {
          await sendMessage(
            chatId,
            `👋 Send *metrics today* to get today's Hoi\\.in product metrics\\.`
          );
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Poll error:", err.message);
    await new Promise(r => setTimeout(r, 5000)); // wait before retrying on error
  }

  setImmediate(poll);
}

// Startup
if (!TELEGRAM_TOKEN) { console.error("❌ Missing TELEGRAM_TOKEN"); process.exit(1); }
if (!WINDSOR_API_KEY) { console.error("❌ Missing WINDSOR_API_KEY"); process.exit(1); }

// Verify bot token on startup
telegramRequest("getMe", {}).then(res => {
  if (res.ok) {
    console.log(`🤖 Bot connected: @${res.result.username}`);
  } else {
    console.error("❌ Invalid Telegram token! Check TELEGRAM_TOKEN env var.");
    process.exit(1);
  }
});

console.log(`🚀 Starting Hoi Metrics Bot...`);
console.log(`📩 Trigger: "${TRIGGER}"`);
poll();
