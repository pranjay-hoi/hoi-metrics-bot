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
  console.log(`🌐 Keep-alive server on port ${PORT}`);
});

let offset = 0;

// Generic HTTPS GET with timeout
function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        console.log(`📥 HTTP ${res.statusCode} — ${url.replace(WINDSOR_API_KEY || "", "***").slice(0, 80)}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) {
          console.error("❌ JSON parse error. Raw:", data.slice(0, 300));
          reject(new Error("JSON parse failed: " + data.slice(0, 200)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

// Generic HTTPS POST
function httpsPost(hostname, path, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      { hostname, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ ok: false, raw: data }); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("POST timed out")); });
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
  if (!result.ok) console.error(`❌ Telegram ${method} failed:`, JSON.stringify(result).slice(0, 200));
  return result;
}

async function getMetrics() {
  const today = new Date().toISOString().split("T")[0];
  const fields = [
    "active1_day_users", "active7_day_users", "active28_day_users",
    "dau_per_mau", "average_session_duration", "newusers", "totalusers", "sessions"
  ].join(",");

  // Correct Windsor.ai REST API format per their docs
  const url = `https://connectors.windsor.ai/googleanalytics4` +
    `?api_key=${WINDSOR_API_KEY}` +
    `&date_from=${today}` +
    `&date_to=${today}` +
    `&fields=${fields}`;

  console.log(`📡 Windsor URL: ${url.replace(WINDSOR_API_KEY, "***")}`);

  const { status, body } = await httpsGet(url, 20000);

  if (status !== 200) throw new Error(`Windsor returned HTTP ${status}`);

  console.log("📦 Windsor body keys:", Object.keys(body));

  // Windsor returns { data: [...] }
  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error("❌ Unexpected Windsor response:", JSON.stringify(body).slice(0, 300));
    throw new Error("No data rows returned from Windsor.ai");
  }

  console.log("✅ Got row:", JSON.stringify(rows[0]));
  return rows[0];
}

function fmt(n) {
  if (n == null || n === "" || isNaN(Number(n))) return "N/A";
  return Math.round(Number(n)).toLocaleString("en-IN");
}

function fmtDuration(s) {
  if (s == null || s === "" || isNaN(Number(s))) return "N/A";
  const secs = Number(s);
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

function buildMessage(d) {
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric", month: "long", year: "numeric",
  });
  const stickiness = d.dau_per_mau != null && d.dau_per_mau !== ""
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
    chat_id: chatId, text, parse_mode: "MarkdownV2",
  });
}

async function poll() {
  try {
    const result = await telegramRequest("getUpdates", {
      offset, timeout: 25, allowed_updates: ["message"],
    });

    if (result.ok && result.result?.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const text = msg.text.toLowerCase().trim();
        const chatId = msg.chat.id;
        console.log(`💬 [${chatId}]: "${text}"`);

        if (text === TRIGGER) {
          await sendMessage(chatId, "⏳ Fetching your metrics\\.\\.\\.");
          try {
            const data = await getMetrics();
            await sendMessage(chatId, buildMessage(data));
            console.log("✅ Metrics sent!");
          } catch (err) {
            console.error("❌ Metrics error:", err.message);
            await sendMessage(chatId, `❌ Error: ${err.message.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&")}`);
          }
        } else {
          await sendMessage(chatId,
            `👋 Send *metrics today* to get today's Hoi\\.in product metrics\\.`
          );
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Poll error:", err.message);
    await new Promise(r => setTimeout(r, 5000));
  }
  setImmediate(poll);
}

// Startup checks
if (!TELEGRAM_TOKEN) { console.error("❌ Missing TELEGRAM_TOKEN"); process.exit(1); }
if (!WINDSOR_API_KEY) { console.error("❌ Missing WINDSOR_API_KEY"); process.exit(1); }

telegramRequest("getMe", {}).then(res => {
  if (res.ok) console.log(`🤖 Bot connected: @${res.result.username}`);
  else { console.error("❌ Invalid Telegram token!"); process.exit(1); }
});

console.log(`🚀 Starting Hoi Metrics Bot... Trigger: "${TRIGGER}"`);
poll();
