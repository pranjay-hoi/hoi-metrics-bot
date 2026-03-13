const https = require("https");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const GA4_ACCOUNT_ID = "514659376";
const CHAT_ID = process.env.CHAT_ID || "948548292"; // your Telegram chat ID

// ⏰ Morning report time (24hr format, in IST = UTC+5:30)
const MORNING_HOUR_IST = 9;    // 9 AM
const MORNING_MINUTE_IST = 0;  // :00

const PORT = process.env.PORT || 3000;

// ─── METRICS CONFIG ───────────────────────────────────────────────────────────
// Add or remove fields here to customize your report.
// Full list of available fields: https://docs.windsor.ai
const METRICS_FIELDS = [
  "active_day_users",        // DAU
  "active7_day_users",        // WAU
  "active28_day_users",       // MAU
  "dau_per_mau",              // Stickiness ratio
  "average_session_duration", // Avg session length
  "newusers",                 // New users
  "sessions",                 // Sessions
  "engagement_rate",          // Engagement rate
  "bounce_rate",              // Bounce rate
];
// ──────────────────────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Hoi Metrics Bot is alive!");
}).listen(PORT, () => console.log(`🌐 Keep-alive server on port ${PORT}`));

let offset = 0;
let lastMorningReportDate = null; // tracks if we've sent today's morning report

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function httpsGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error("JSON parse failed: " + data.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("GET timed out")); });
    req.on("error", reject);
  });
}

function httpsPost(hostname, path, payload, timeoutMs = 30000) {
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
  const result = await httpsPost("api.telegram.org", `/bot${TELEGRAM_TOKEN}/${method}`, payload);
  if (!result.ok) console.error(`❌ Telegram ${method} failed:`, JSON.stringify(result).slice(0, 300));
  return result;
}

// ─── METRICS FETCHER ──────────────────────────────────────────────────────────
async function getMetrics(date) {
  const url = `https://connectors.windsor.ai/googleanalytics4` +
    `?api_key=${WINDSOR_API_KEY}` +
    `&date_from=${date}` +
    `&date_to=${date}` +
    `&fields=${METRICS_FIELDS.join(",")}`;

  const { status, body } = await httpsGet(url);
  if (status !== 200) throw new Error(`Windsor HTTP ${status}`);

  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("No data from Windsor.ai");

  console.log(`✅ Windsor data for ${date}:`, JSON.stringify(rows[0]));
  return rows[0];
}

// ─── FORMATTING ───────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || n === "" || isNaN(Number(n))) return "N/A";
  return Math.round(Number(n)).toLocaleString("en-IN");
}

function fmtDuration(s) {
  if (s == null || s === "" || isNaN(Number(s))) return "N/A";
  const sec = Number(s);
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function fmtPercent(n) {
  if (n == null || n === "" || isNaN(Number(n))) return "N/A";
  return (Number(n) * 100).toFixed(1) + "%";
}

function buildMessage(d, label) {
  const stickiness = d.dau_per_mau != null && d.dau_per_mau !== ""
    ? (parseFloat(d.dau_per_mau) * 100).toFixed(2) + "%"
    : "N/A";

  // ── Edit this section to add/remove metrics from the message ──
  return [
    `📊 Hoi.in v1 — Product Metrics (${label})`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `👥 DAU: ${fmt(d.active_day_users)}`,
    `📅 WAU: ${fmt(d.active7_day_users)}`,
    `🗓 MAU: ${fmt(d.active28_day_users)}`,
    `📌 Daily Return User%: ${stickiness}`,
    `⏱ Avg Session: ${fmtDuration(d.average_session_duration)}`,
    `🆕 New Users: ${fmt(d.newusers)}`,
    `🔁 Sessions: ${fmt(d.sessions)}`,
    `💡 Engagement Rate: ${fmtPercent(d.engagement_rate)}`,
    `↩️  Bounce Rate: ${fmtPercent(d.bounce_rate)}`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", { chat_id: chatId, text });
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function getISTDate(offsetDays = 0) {
  const now = new Date();
  // IST = UTC + 5:30
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000));
  return ist.toISOString().split("T")[0];
}

function getISTHourMinute() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return { hour: ist.getUTCHours(), minute: ist.getUTCMinutes(), dateStr: ist.toISOString().split("T")[0] };
}

// ─── MORNING REPORT SCHEDULER ─────────────────────────────────────────────────
async function checkMorningReport() {
  const { hour, minute, dateStr } = getISTHourMinute();

  if (
    hour === MORNING_HOUR_IST &&
    minute === MORNING_MINUTE_IST &&
    lastMorningReportDate !== dateStr
  ) {
    lastMorningReportDate = dateStr;
    console.log(`🌅 Sending morning report for yesterday...`);

    try {
      const yesterday = getISTDate(-1);
      const data = await getMetrics(yesterday);
      const label = `Yesterday, ${new Date(yesterday + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`;
      await sendMessage(CHAT_ID, `🌅 Good morning! Here's yesterday's report:\n\n` + buildMessage(data, label));
      console.log("✅ Morning report sent!");
    } catch (err) {
      console.error("❌ Morning report error:", err.message);
      await sendMessage(CHAT_ID, `❌ Morning report failed: ${err.message}`);
    }
  }
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
async function poll() {
  // Check if it's time for the morning report
  await checkMorningReport();

  try {
    const result = await telegramRequest("getUpdates", {
      offset, timeout: 20, allowed_updates: ["message"],
    });

    if (result.ok && result.result?.length > 0) {
      for (const update of result.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const text = msg.text.toLowerCase().trim();
        const chatId = msg.chat.id;
        console.log(`💬 [${chatId}]: "${text}"`);

        if (text === "metrics today") {
          await sendMessage(chatId, "⏳ Fetching today's metrics...");
          try {
            const today = getISTDate(0);
            const data = await getMetrics(today);
            await sendMessage(chatId, buildMessage(data, "Today"));
            console.log("✅ Today's metrics sent!");
          } catch (err) {
            console.error("❌ Error:", err.message);
            await sendMessage(chatId, `❌ Error: ${err.message}`);
          }

        } else if (text === "metrics yesterday") {
          await sendMessage(chatId, "⏳ Fetching yesterday's metrics...");
          try {
            const yesterday = getISTDate(-1);
            const data = await getMetrics(yesterday);
            const label = `Yesterday (${yesterday})`;
            await sendMessage(chatId, buildMessage(data, label));
            console.log("✅ Yesterday's metrics sent!");
          } catch (err) {
            console.error("❌ Error:", err.message);
            await sendMessage(chatId, `❌ Error: ${err.message}`);
          }

        } else {
          await sendMessage(chatId,
            `👋 Available commands:\n\n` +
            `📊 "metrics today" — live stats for today\n` +
            `📊 "metrics yesterday" — stats for yesterday\n\n` +
            `🌅 You'll also get an automatic morning report at 9 AM IST with yesterday's data.`
          );
        }
      }
    }
  } catch (err) {
    console.error("⚠️ Poll error:", err.message);
    await new Promise(r => setTimeout(r, 5000));
  }

  setTimeout(poll, 1000); // check every second (needed for minute-accurate scheduling)
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
if (!TELEGRAM_TOKEN) { console.error("❌ Missing TELEGRAM_TOKEN"); process.exit(1); }
if (!WINDSOR_API_KEY) { console.error("❌ Missing WINDSOR_API_KEY"); process.exit(1); }

telegramRequest("getMe", {}).then(res => {
  if (res.ok) console.log(`🤖 Bot connected: @${res.result.username}`);
  else { console.error("❌ Invalid Telegram token!"); process.exit(1); }
});

console.log(`🚀 Hoi Metrics Bot starting...`);
console.log(`⏰ Morning report scheduled at ${MORNING_HOUR_IST}:${String(MORNING_MINUTE_IST).padStart(2,"0")} IST`);
poll();
