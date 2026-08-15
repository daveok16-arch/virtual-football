/**
 * telegram-notify.js — Send predictions/alerts to a Telegram chat.
 *
 * Uses the Telegram Bot HTTP API directly (no extra dependency). Reads the bot
 * token + chat id from environment variables so no secret is ever committed.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  (required) bot token from @BotFather
 *   TELEGRAM_CHAT_ID    (required) target chat/channel id
 *
 * Messages are HTML-formatted and split to respect Telegram's 4096-char limit.
 */
const https = require('https');
const querystring = require('querystring');

const TG_MAX = 4000; // leave headroom under Telegram's 4096 limit

function config() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** POST a single sendMessage call. Resolves on success, rejects on HTTP/API error. */
function sendMessage(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: 'true',
    });
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let j;
          try { j = JSON.parse(data); } catch { return reject(new Error('bad telegram response')); }
          if (j.ok) resolve(j);
          else reject(new Error(j.description || 'telegram api error'));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('telegram timeout')); });
    req.write(body);
    req.end();
  });
}

/** Split a long message into Telegram-safe chunks (on newline boundaries). */
function chunk(text) {
  if (text.length <= TG_MAX) return [text];
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > TG_MAX) {
      if (buf) chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Send a message (auto-chunked) to the configured Telegram chat.
 * Returns true on success, false if Telegram isn't configured or all sends failed.
 */
async function notify(message) {
  const cfg = config();
  if (!cfg) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping.');
    return false;
  }
  console.log(`[telegram] sending message (${message.length} chars, chat=${cfg.chatId}) ...`);
  let ok = true;
  let sent = 0;
  for (const part of chunk(message)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sendMessage(cfg.token, cfg.chatId, part);
        sent++;
        break;
      } catch (e) {
        console.error(`[telegram] send attempt ${attempt} failed: ${e.message}`);
        if (attempt === 3) {
          ok = false;
        } else {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400)); // avoid rate-limit (≈30 msg/sec)
  }
  console.log(`[telegram] done — ${sent} chunk(s) sent, ok=${ok}`);
  return ok;
}

module.exports = { notify, config };
