/**
 * capture.js — Reusable GoldenRace virtual-football capture.
 *
 * Encapsulates the CDP WebSocket interception logic (originally in
 * intercept-scheduled-virtuals.js) as an importable async function so the
 * prediction bot / Telegram runner can capture a bounded window of live data
 * and feed it straight into the prediction model — no NDJSON round-trip needed.
 *
 * Returns the same in-memory structure predict.js.loadCaptures() produces:
 *   { playlistId -> { standings, scheduled:[], resolved:[] } }
 *
 * Environment:
 *   PUPPETEER_EXECUTABLE_PATH  (optional) path to a Chromium binary. Defaults
 *                               to puppeteer's bundled Chromium.
 *   CAPTURE_SECONDS            (optional) how long to listen. Default 90.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { buildStandings } = require('./virtual-football-model');

const START_URL = 'https://sportybet.com';
const LEAGUE_MAPPINGS_FILE = path.join(__dirname, 'league-mappings.json');

let LEAGUE_NAMES = {};
try {
  LEAGUE_NAMES =
    JSON.parse(fs.readFileSync(LEAGUE_MAPPINGS_FILE, 'utf8')).mappings || {};
} catch {}
function leagueName(pid) {
  return LEAGUE_NAMES[String(pid)] || LEAGUE_NAMES[pid] || `League ${pid}`;
}

const isFbEvents = (b) =>
  (b.events || []).some((ev) =>
    (ev?.data?.participants || []).some((p) => p?.classType === 'FbParticipant'));
const isFbStandings = (b) => !!b?.stats?.groupClassification;

/** In-memory collector that mirrors predict.js.loadCaptures output. */
function newLeagues() {
  const leagues = {};
  const get = (pid) =>
    (leagues[pid] = leagues[pid] || { standings: {}, scheduled: [], resolved: [] });
  return {
    leagues,
    ingest(parsed) {
      const blocks = parsed?.res?.body;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (!isFbEvents(b) && !isFbStandings(b)) continue;
        const pid = b.playlistId;
        if (pid == null) continue;
        const L = get(pid);
        if (isFbStandings(b)) Object.assign(L.standings, buildStandings(b));
        if (isFbEvents(b)) {
          const md = b.data?.matchDay;
          for (const ev of b.events || []) {
            const rec = { ev, matchDay: md, eBlockId: b.eBlockId, status: b.serverStatus };
            if (b.serverStatus === 'RESOLVED') L.resolved.push(rec);
            else L.scheduled.push(rec);
          }
        }
      }
    },
  };
}

/** Lightweight CDP sub-session routed by sessionId (same approach as the interceptor). */
function createSubSession(parentClient, targetId) {
  let _id = 0;
  const pending = new Map();
  const listeners = new Map();
  const sub = {
    sessionId: null,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return sub;
    },
    emit(event, params) {
      (listeners.get(event) || []).forEach((cb) => {
        try { cb(params); } catch {}
      });
    },
    async send(method, params = {}) {
      const id = ++_id;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        parentClient
          .send('Target.sendMessageToTarget', {
            targetId,
            sessionId: sub.sessionId,
            message: JSON.stringify({ id, method, params }),
          })
          .catch(reject);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.get(id).reject(new Error(`timeout: ${method}`));
            pending.delete(id);
          }
        }, 10000);
      });
    },
  };
  parentClient.on('Target.receivedMessageFromTarget', (evt) => {
    if (evt.sessionId !== sub.sessionId) return;
    let msg;
    try { msg = JSON.parse(evt.message); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      sub.emit(msg.method, msg.params);
    }
  });
  return sub;
}

/**
 * Capture live virtual-football data for `captureSeconds`, then return the
 * structured per-league data ready for the prediction model.
 */
async function captureFootball(captureSeconds) {
  if (captureSeconds == null) captureSeconds = Number(process.env.CAPTURE_SECONDS) || 90;
  const collector = newLeagues();

  const launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1440, height: 900 },
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to the region landing page first, then to the Scheduled Virtuals
    // view — the GoldenRace (virtustec) iframe only loads on the virtuals page.
    await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    const origin = new URL(page.url()).origin;
    const region = new URL(page.url()).pathname.replace(/\/$/, '');
    const scheduledUrl = `${origin}${region}/virtual/#/scheduled/league/upcoming`;
    await page.goto(scheduledUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('iframe', { timeout: 30000 });
    // Give the GoldenRace SPA inside the iframe time to open its WebSocket.
    await new Promise((r) => setTimeout(r, 6000));

    const client = await page.target().createCDPSession();
    await client.send('Page.enable');
    await client.send('Network.enable');

    // Discover the cross-origin virtustec iframe target (may still be initializing).
    let iframeTarget;
    for (let i = 0; !iframeTarget && i < 15; i++) {
      const t = await client.send('Target.getTargets');
      iframeTarget = t.targetInfos.find(
        (x) =>
          (x.type === 'iframe' || x.type === 'page') && /virtustec/i.test(x.url || '')
      );
      if (!iframeTarget) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!iframeTarget) throw new Error('virtustec iframe target not found');

    const sub = createSubSession(client, iframeTarget.targetId);
    const attach = await client.send('Target.attachToTarget', {
      targetId: iframeTarget.targetId,
      flatten: false,
    });
    sub.sessionId = attach.sessionId;
    await sub.send('Network.enable');

    sub.on('Network.webSocketFrameReceived', (e) => {
      const payload = e.response?.payloadData || '';
      if (!payload) return;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { return; }
      const body = parsed?.res?.body;
      if (!Array.isArray(body)) return;
      const isFootball = body.some(
        (b) =>
          (b.events || []).some((ev) =>
            (ev?.data?.participants || []).some((p) => p?.classType === 'FbParticipant')) ||
          b?.stats?.groupClassification
      );
      if (isFootball) collector.ingest(parsed);
    });

    // Trigger each league's WS subscription by clicking through the sidebar.
    const frameEl = await page.$(
      'iframe[src*="virtual"], iframe:not([src*="googletagmanager"])'
    );
    if (frameEl) {
      const frame = await frameEl.contentFrame();
      if (frame) {
        await frame
          .waitForFunction(
            () => document.body.innerText.split('\n').filter(Boolean).length > 5,
            { timeout: 30000 }
          )
          .catch(() => {});
        await frame
          .evaluate(() => {
            const tg = Array.from(
              document.querySelectorAll('a.toggler, a[title="Football League"]')
            ).find((a) => /Football League/i.test(a.textContent));
            if (tg) tg.click();
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));
        const links = await frame
          .evaluate(() =>
            Array.from(
              document.querySelectorAll('a[href*="#/scheduled/league/playlist/"]')
            ).map((a) => a.getAttribute('href'))
          )
          .catch(() => []);
        for (const href of links) {
          await frame
            .evaluate((h) => {
              const a = document.querySelector(`a[href="${h}"]`);
              if (a) a.click();
            }, href)
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 2200));
        }
      }
    }

    // Listen for the capture window.
    await new Promise((r) => setTimeout(r, captureSeconds * 1000));
  } finally {
    await browser.close().catch(() => {});
  }

  // De-duplicate scheduled events by eventId (latest capture wins), like predict.js.
  for (const L of Object.values(collector.leagues)) {
    const seen = new Set();
    const sched = [];
    for (const rec of [...L.scheduled].reverse()) {
      const id = rec.ev.eventId;
      if (id && seen.has(id)) continue;
      seen.add(id);
      sched.unshift(rec);
    }
    L.scheduled = sched;
  }
  return collector.leagues;
}

module.exports = { captureFootball, leagueName };
