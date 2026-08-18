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
  // Deduplicate DURING ingestion using Maps keyed by eventId — GoldenRace
  // re-sends the same events in every frame, so an array would grow unbounded
  // and OOM the 512MB Render free tier before the capture window finishes.
  const leagues = {};
  const get = (pid) =>
    (leagues[pid] = leagues[pid] || {
      standings: {},
      _scheduled: new Map(),
      _resolved: new Map(),
    });
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
          const eventTime = b.eventTime;
          for (const ev of b.events || []) {
            const id = ev.eventId;
            if (id == null) continue;
            const rec = {
              ev,
              matchDay: md,
              eventTime,
              eBlockId: b.eBlockId,
              status: b.serverStatus,
            };
            if (b.serverStatus === 'RESOLVED') L._resolved.set(id, rec);
            else L._scheduled.set(id, rec);
          }
        }
      }
    },
    /**
     * Clear old scheduled events that have already been captured to prevent
     * unbounded Map growth during long capture sessions. GoldenRace re-sends
     * the same scheduled events in every frame, so the Maps are naturally
     * deduped by eventId — but over hours, thousands of unique event IDs
     * accumulate. This prunes scheduled events older than `maxAgeMs`.
     * Resolved events are NEVER pruned (needed for calibration).
     */
    pruneScheduled(maxAgeMs = 600000) {
      const now = Date.now();
      let pruned = 0;
      for (const L of Object.values(leagues)) {
        for (const [id, rec] of L._scheduled) {
          const age = now - (rec.eventTime || 0);
          if (age > maxAgeMs) {
            L._scheduled.delete(id);
            pruned++;
          }
        }
      }
      return pruned;
    },
    // Flatten the Maps to arrays for the prediction model.
    finalize() {
      for (const L of Object.values(leagues)) {
        L.scheduled = Array.from(L._scheduled.values());
        L.resolved = Array.from(L._resolved.values());
        delete L._scheduled;
        delete L._resolved;
      }
      return leagues;
    },
    // Quick stats for early-exit logic without finalizing.
    stats() {
      let s = 0, r = 0, n = 0, std = 0;
      for (const L of Object.values(leagues)) {
        n++;
        s += L._scheduled.size;
        r += L._resolved.size;
        std += Object.keys(L.standings).length;
      }
      return { leagues: n, scheduled: s, resolved: r, standingsTeams: std };
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
    pending, // expose for periodic cache flushing
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
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      // Render free tier is memory-constrained; trim Chromium's footprint.
      '--disable-extensions',
      '--disable-default-apps',
      '--no-first-run',
      '--mute-audio',
      // Memory-saving flags for low-memory environments (Render 512MB).
      '--single-process',        // no zygote → fewer forked processes
      '--no-zygote',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-component-extensions-with-background-pages',
      '--disable-sync',
      '--disable-translate',
      '--disable-notifications',
      '--force-memory-pressure-off', // prevent Chrome from discarding tabs
      '--max-old-space-size=256',    // cap V8 heap for the renderer
    ],
    defaultViewport: { width: 1280, height: 800 },
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
    // NOTE: use 'domcontentloaded' (not 'networkidle2') — SportyBet keeps
    // persistent connections open (analytics/polling/WS), so networkidle2 never
    // settles and times out, especially on Render's free tier. We wait for the
    // DOM + a short settle instead.
    console.log('[capture] navigating to SportyBet landing ...');
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));
    const origin = new URL(page.url()).origin;
    const region = new URL(page.url()).pathname.replace(/\/$/, '');
    const scheduledUrl = `${origin}${region}/virtual/#/scheduled/league/upcoming`;
    console.log(`[capture] landing url: ${page.url()}`);

    // Create the CDP session BEFORE navigating to the virtuals page, so we don't
    // miss the GoldenRace WebSocket's initial fixture burst when the iframe loads.
    const client = await page.target().createCDPSession();
    await client.send('Page.enable');
    await client.send('Network.enable');

    console.log(`[capture] navigating to virtuals: ${scheduledUrl}`);
    await page.goto(scheduledUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('iframe', { timeout: 30000 }).catch(() => {});
    console.log('[capture] iframe selector present');

    // Discover the cross-origin virtustec iframe target and attach a sub-session
    // so we can see its network (the GoldenRace WebSocket lives here). The iframe
    // may still be initializing, so retry patiently.
    let iframeTarget;
    for (let i = 0; !iframeTarget && i < 20; i++) {
      const t = await client.send('Target.getTargets');
      iframeTarget = t.targetInfos.find(
        (x) =>
          (x.type === 'iframe' || x.type === 'page') && /virtustec/i.test(x.url || '')
      );
      if (!iframeTarget) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!iframeTarget) throw new Error('virtustec iframe target not found');
    console.log(`[capture] found virtustec iframe: ${(iframeTarget.url || '').slice(0, 70)}`);

    const sub = createSubSession(client, iframeTarget.targetId);
    const attach = await client.send('Target.attachToTarget', {
      targetId: iframeTarget.targetId,
      flatten: false,
    });
    sub.sessionId = attach.sessionId;
    await sub.send('Network.enable');
    console.log('[capture] CDP sub-session attached, Network.enable sent');

    let wsFrameCount = 0;
    let lastCacheFlush = Date.now();
    // Attach the WS listener immediately — the iframe's WebSocket may push the
    // initial fixture/standings burst as soon as it attaches.
    sub.on('Network.webSocketFrameReceived', (e) => {
      const payload = e.response?.payloadData || '';
      if (!payload) return;
      wsFrameCount++;
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
      if (isFootball) {
        collector.ingest(parsed);
        console.log(`[capture] football frame #${wsFrameCount}: ${body.length} blocks`);

        // Clear the parsed frame reference so the large WS payload (50-200 KB
        // of odds/markets/standings data) can be GC'd immediately after the
        // collector extracts the fields it needs. Without this, V8 retains the
        // full frame in the closure scope until the next major GC sweep.
        parsed = null;
      } else {
        parsed = null;
      }

      // Every 5 minutes (300s), flush old pending CDP requests, prune stale
      // scheduled events, and hint GC. This clears accumulated old subscription
      // data and media URL strings from the CDP listener's retained payloads.
      if (Date.now() - lastCacheFlush > 300000) {
        lastCacheFlush = Date.now();
        if (sub.pending && sub.pending.size > 0) {
          for (const [id, p] of sub.pending) {
            try { p.reject(new Error('flushed by 5-min cache clear')); } catch {}
          }
          sub.pending.clear();
        }
        const pruned = collector.pruneScheduled(600000);
        if (global.gc) global.gc();
        console.log(`[capture] 5-min cache flush: pruned ${pruned} old scheduled events, GC'd`);
      }
    });

    // Give the GoldenRace SPA inside the iframe time to open its WebSocket.
    await new Promise((r) => setTimeout(r, 6000));

    // Trigger each league's WS subscription by clicking through the sidebar.
    const frameEl = await page.$(
      'iframe[src*="virtual"], iframe:not([src*="googletagmanager"])'
    );
    console.log(`[capture] frame element found: ${!!frameEl}`);
    if (frameEl) {
      const frame = await frameEl.contentFrame();
      console.log(`[capture] content frame accessible: ${!!frame}`);
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
        console.log(`[capture] league sidebar links found: ${links.length}`);
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

    // Capture window with EARLY EXIT. We want enough data to (a) produce top
    // picks AND (b) learn the calibration that powers the +EV value-bets layer.
    // The calibration needs ≥10 RESOLVED matches (past results), which arrive in
    // the initial WS subscription burst — so we must NOT exit before they arrive.
    // We exit early only once BOTH thresholds are met, with a stall fallback so
    // we don't hang if GoldenRace stops sending data.
    const EARLY_EXIT_LEAGUES = 4;
    const EARLY_EXIT_MIN_SCHEDULED = 100;
    const EARLY_EXIT_MIN_RESOLVED = 10;
    const STALL_MS = 20000; // exit if no new data for this long (after meeting scheduled threshold)
    console.log(
      `[capture] listening up to ${captureSeconds}s ` +
        `(early-exit @ ${EARLY_EXIT_LEAGUES} leagues / ${EARLY_EXIT_MIN_SCHEDULED} sched / ${EARLY_EXIT_MIN_RESOLVED} resolved) ...`
    );
    const start = Date.now();
    let lastDataAt = Date.now();
    let prevKey = '';
    let earlyExit = false;
    while (Date.now() - start < captureSeconds * 1000) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = collector.stats();
      const key = `${st.leagues}:${st.scheduled}:${st.resolved}`;
      if (key !== prevKey) { lastDataAt = Date.now(); prevKey = key; }
      const stalled = Date.now() - lastDataAt > STALL_MS;
      const schedMet = st.leagues >= EARLY_EXIT_LEAGUES && st.scheduled >= EARLY_EXIT_MIN_SCHEDULED;
      const resolvedMet = st.resolved >= EARLY_EXIT_MIN_RESOLVED;
      if (schedMet && resolvedMet) {
        earlyExit = true;
        console.log(`[capture] early-exit: both thresholds met ${JSON.stringify(st)}`);
        break;
      }
      // If scheduled threshold is met but we've stalled (no new data for 20s),
      // GoldenRace has likely finished its burst — exit rather than idle.
      if (schedMet && stalled) {
        earlyExit = true;
        console.log(`[capture] early-exit (stalled, resolved=${st.resolved}): ${JSON.stringify(st)}`);
        break;
      }
    }
    const st = collector.stats();
    console.log(
      `[capture] ${earlyExit ? 'early-exit' : 'window done'} — ws frames: ${wsFrameCount}, ${JSON.stringify(st)}`
    );
    if (st.resolved < EARLY_EXIT_MIN_RESOLVED) {
      console.warn(
        `[capture] WARNING: only ${st.resolved} resolved matches captured — ` +
          `calibration will be skipped (need ≥${EARLY_EXIT_MIN_RESOLVED}). ` +
          `Value-bets layer will be omitted from this report.`
      );
    }
  } finally {
    await browser.close().catch(() => {});
    console.log('[capture] browser closed');
  }

  collector.finalize();
  return collector.leagues;
}

module.exports = { captureFootball, leagueName };
