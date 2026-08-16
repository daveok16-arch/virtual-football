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

/** POST a single sendMessage call. Resolves with the API response (includes message_id). */
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

/** Delete a message by its message_id. Silent on failure (already deleted, too old, etc). */
function deleteMessage(token, chatId, messageId) {
  return new Promise((resolve) => {
    const body = querystring.stringify({ chat_id: chatId, message_id: messageId });
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/deleteMessage`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
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

// Track message IDs from the last notify() call so we can delete them before
// sending the next batch — keeps the chat clean (no flooding).
let lastMessageIds = [];

/**
 * Delete all messages from the previous notify() call, if any.
 * Silent on failure (message may already be deleted, or older than 48h which
 * Telegram won't delete).
 */
async function deletePrevious() {
  const cfg = config();
  if (!cfg || !lastMessageIds.length) return;
  console.log(`[telegram] deleting ${lastMessageIds.length} previous message(s) ...`);
  const ids = lastMessageIds;
  lastMessageIds = [];
  let deleted = 0;
  for (const id of ids) {
    if (await deleteMessage(cfg.token, cfg.chatId, id)) deleted++;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[telegram] deleted ${deleted}/${ids.length} previous message(s)`);
}

/**
 * Send a message (auto-chunked) to the configured Telegram chat.
 * Before sending, deletes the previous batch of messages to avoid flooding.
 * Returns true on success, false if Telegram isn't configured or all sends failed.
 */
async function notify(message) {
  const cfg = config();
  if (!cfg) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping.');
    return false;
  }

  // Delete the previous notification(s) first to keep the chat clean.
  await deletePrevious();

  console.log(`[telegram] sending message (${message.length} chars, chat=${cfg.chatId}) ...`);
  let ok = true;
  const newIds = [];
  for (const part of chunk(message)) {
    let sent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await sendMessage(cfg.token, cfg.chatId, part);
        if (resp.result && resp.result.message_id) newIds.push(resp.result.message_id);
        sent = true;
        break;
      } catch (e) {
        console.error(`[telegram] send attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
        else ok = false;
      }
    }
    if (!sent) ok = false;
    await new Promise((r) => setTimeout(r, 400)); // avoid rate-limit (≈30 msg/sec)
  }
  // Remember the IDs so the NEXT notify() call can delete these.
  lastMessageIds = newIds;
  console.log(`[telegram] done — ${newIds.length} message(s) sent (ids: ${newIds.join(',')}), ok=${ok}`);
  return ok;
}

module.exports = { notify, config, deletePrevious };
