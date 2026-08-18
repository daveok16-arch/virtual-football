/**
 * macro-logger.js — Standalone perpetual capture script that continuously
 * records resolved football matches to macro-stats.jsonl for macro-scale
 * statistical analysis (N=500-1000+).
 *
 * Unlike bot-runner.js (which does 90s capture bursts every 5 min), this
 * script captures continuously — it stays attached to the virtustec WS and
 * logs every resolved match as it arrives. Run it in the background for
 * hours to accumulate the 500-1000 match baseline.
 *
 * Each NDJSON line records:
 *   { ts, eventId, playlistId, league, matchDay, eventTime,
 *     home, away, homeStars, awayStars,
 *     odds1x2: [h, d, a], fairProbs: [h, d, a], overround,
 *     finalOutcome: [hg, ag, htH, htA], outcome,
 *     totalGoals, wonMarkets }
 *
 * Usage: node macro-logger.js
 * Output: macro-stats.jsonl (gitignored)
 *         macro-stats-summary.json (rolling stats, updated every 10 matches)
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { leagueName } = require('./capture');

const LOG_PATH = path.join(__dirname, 'macro-stats.jsonl');
const SUMMARY_PATH = path.join(__dirname, 'macro-stats-summary.json');
const readline = require('readline');

/**
 * Bounded LRU set for seenIds — caps at MAX_SEEN entries and evicts the
 * oldest when full. Since GoldenRace re-sends recent events frequently but
 * rarely re-sends very old ones, a bounded ring is sufficient for dedup
 * without unbounded RAM growth over hours of running.
 * With a plain Set, seenIds would grow by ~57 IDs per 90s capture = ~2,000/hr
 * = ~48,000/day. The bounded set caps at 5000 (~3h of matches) and costs
 * only ~160 KB instead of ~1.5 MB for an unbounded day-long set.
 */
const MAX_SEEN = 5000;
const seenIds = new Set();
const seenOrder = []; // ring buffer for eviction order
function markSeen(id) {
  if (seenIds.has(id)) return;
  seenIds.add(id);
  seenOrder.push(id);
  if (seenOrder.length > MAX_SEEN) {
    const evict = seenOrder.shift();
    seenIds.delete(evict);
  }
}

/**
 * Pre-load seen IDs using a STREAM (readline) instead of readFileSync.
 * Reads the file line-by-line so the entire file is never held in RAM.
 */
(async () => {
  try {
    const stream = fs.createReadStream(LOG_PATH, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      try {
        const e = JSON.parse(line.trim());
        if (e.eventId) { markSeen(e.eventId); count++; }
      } catch {}
    }
    console.log(`[macro] loaded ${count} existing event IDs from log (via stream)`);
  } catch (e) {
    // file doesn't exist yet — fine
  }
})();

function fairProbs(odds) {
  const [h, d, a] = odds.map(Number);
  if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) return null;
  const imp = [1 / h, 1 / d, 1 / a];
  const sum = imp[0] + imp[1] + imp[2];
  return { fair: [imp[0] / sum, imp[1] / sum, imp[2] / sum], overround: sum };
}

function logMatch(ev, block) {
  const data = ev.data || {};
  const parts = data.participants || [];
  if (parts.length < 2) return null;
  if (!parts.some((p) => p.classType === 'FbParticipant')) return null;
  const odds = (data.oddValues || []).slice(0, 3);
  if (odds.length < 3) return null;
  const r = ev.result || {};
  const fo = r.finalOutcome;
  if (!Array.isArray(fo) || fo.length < 2) return null;

  const [hg, ag] = fo.map(Number);
  if (Number.isNaN(hg) || Number.isNaN(ag)) return null;

  const fp = fairProbs(odds);
  if (!fp) return null;

  const outcome = hg > ag ? 'home' : hg === ag ? 'draw' : 'away';
  const pid = block.playlistId;
  const ln = leagueName(pid);

  return {
    ts: Date.now(),
    eventId: ev.eventId,
    playlistId: pid,
    league: ln,
    matchDay: block.data && block.data.matchDay,
    eventTime: block.eventTime,
    home: parts[0].name,
    away: parts[1].name,
    homeStars: parts[0].stars,
    awayStars: parts[1].stars,
    odds1x2: odds.map(Number),
    fairProbs: fp.fair,
    overround: fp.overround,
    finalOutcome: fo.map(Number),
    outcome,
    totalGoals: hg + ag,
    // wonMarkets omitted — 1.8 KB per match, never used by edge-calculator or Kelly.
    // Keeping it out saves ~3.5 MB across 2000 matches and prevents heap bloat.
  };
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

/**
 * Streaming summary — reads the log line-by-line via readline so the entire
 * file is never held in RAM. Accumulates only aggregate counters (a few KB
 * regardless of file size) and writes the summary to disk.
 */
let matchCount = 0;
async function updateSummary() {
  try {
    const stream = fs.createReadStream(LOG_PATH, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let n = 0;
    const stats = {
      updatedAt: new Date().toISOString(),
      totalMatches: 0,
      overall: { home: 0, draw: 0, away: 0, totalGoals: 0, vigSum: 0 },
      byLeague: {},
      byStarDiff: { even: { h: 0, d: 0, a: 0, n: 0 }, small: { h: 0, d: 0, a: 0, n: 0 }, large: { h: 0, d: 0, a: 0, n: 0 } },
      drawRateTrend: [],
    };

    let drawRateWindow = [];

    for await (const line of rl) {
      let m;
      try { m = JSON.parse(line.trim()); } catch { continue; }
      n++;
      stats.totalMatches = n;
      stats.overall[m.outcome]++;
      stats.overall.totalGoals += m.totalGoals;
      stats.overall.vigSum += m.overround - 1;

      const ln = m.league || 'Unknown';
      if (!stats.byLeague[ln]) stats.byLeague[ln] = { home: 0, draw: 0, away: 0, n: 0, vigSum: 0, totalGoals: 0 };
      stats.byLeague[ln][m.outcome]++;
      stats.byLeague[ln].n++;
      stats.byLeague[ln].vigSum += m.overround - 1;
      stats.byLeague[ln].totalGoals += m.totalGoals;

      const diff = Math.abs((m.homeStars || 0) - (m.awayStars || 0));
      const bucket = diff < 0.5 ? 'even' : diff < 2 ? 'small' : 'large';
      const sb = stats.byStarDiff[bucket];
      sb[m.outcome === 'home' ? 'h' : m.outcome === 'draw' ? 'd' : 'a']++;
      sb.n++;

      drawRateWindow.push(m.outcome === 'draw' ? 1 : 0);
    }

    if (n === 0) return;

    stats.overall.drawRate = stats.overall.draw / n;
    stats.overall.homeRate = stats.overall.home / n;
    stats.overall.awayRate = stats.overall.away / n;
    stats.overall.avgGoals = stats.overall.totalGoals / n;
    stats.overall.avgVig = stats.overall.vigSum / n;

    for (const [ln, s] of Object.entries(stats.byLeague)) {
      s.drawRate = s.draw / s.n;
      s.homeRate = s.home / s.n;
      s.awayRate = s.away / s.n;
      s.avgGoals = s.totalGoals / s.n;
      s.avgVig = s.vigSum / s.n;
    }

    if (drawRateWindow.length >= 10) {
      for (let i = 0; i < drawRateWindow.length; i += 10) {
        const batch = drawRateWindow.slice(i, i + 10);
        stats.drawRateTrend.push(batch.reduce((a, b) => a + b, 0) / batch.length);
      }
    }

    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(stats, null, 2));
    console.log(`[macro] summary updated: ${n} matches, drawRate=${(stats.overall.drawRate * 100).toFixed(1)}%`);
  } catch (e) {
    console.error('[macro] summary error:', e.message);
  }
}

async function run() {
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-extensions', '--disable-default-apps', '--no-first-run', '--mute-audio',
      // Memory-saving flags for low-memory environments (Render 512MB).
      '--single-process', '--no-zygote',
      '--disable-background-networking', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-sync', '--disable-translate',
      '--disable-notifications', '--force-memory-pressure-off', '--max-old-space-size=256'],
    defaultViewport: { width: 1280, height: 800 },
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  const browser = await puppeteer.launch(launchOpts);
  console.log('[macro] browser launched');

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://sportybet.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 4000));
    const origin = new URL(page.url()).origin;
    const region = new URL(page.url()).pathname.replace(/\/$/, '');
    const scheduledUrl = `${origin}${region}/virtual/#/scheduled/league/upcoming`;
    console.log(`[macro] navigating to ${scheduledUrl}`);
    await page.goto(scheduledUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('iframe', { timeout: 30000 }).catch(() => {});

    const client = await page.target().createCDPSession();
    await client.send('Page.enable');
    await client.send('Network.enable');

    // Find virtustec iframe
    let iframeTarget;
    for (let i = 0; !iframeTarget && i < 20; i++) {
      const t = await client.send('Target.getTargets');
      iframeTarget = t.targetInfos.find(
        (x) => (x.type === 'iframe' || x.type === 'page') && /virtustec/i.test(x.url || '')
      );
      if (!iframeTarget) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!iframeTarget) throw new Error('virtustec iframe not found');
    console.log(`[macro] iframe: ${iframeTarget.url.slice(0, 80)}`);

    // CDP sub-session
    const sub = {
      sessionId: null, _id: 0, pending: new Map(), listeners: new Map(),
      on(ev, cb) { if (!this.listeners.has(ev)) this.listeners.set(ev, []); this.listeners.get(ev).push(cb); return this; },
      emit(ev, p) { (this.listeners.get(ev) || []).forEach((cb) => { try { cb(p); } catch {} }); },
      async send(method, params = {}) {
        const id = ++this._id;
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          client.send('Target.sendMessageToTarget', {
            targetId: iframeTarget.targetId, sessionId: this.sessionId,
            message: JSON.stringify({ id, method, params }),
          }).catch(reject);
          setTimeout(() => { if (this.pending.has(id)) { this.pending.get(id).reject(new Error('timeout: ' + method)); this.pending.delete(id); } }, 10000);
        });
      },
    };
    client.on('Target.receivedMessageFromTarget', (evt) => {
      if (evt.sessionId !== sub.sessionId) return;
      let msg; try { msg = JSON.parse(evt.message); } catch { return; }
      if (msg.id && sub.pending.has(msg.id)) {
        const p = sub.pending.get(msg.id); sub.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method) { sub.emit(msg.method, msg.params); }
    });

    const attach = await client.send('Target.attachToTarget', { targetId: iframeTarget.targetId, flatten: false });
    sub.sessionId = attach.sessionId;
    await sub.send('Network.enable');
    await sub.send('Page.enable');
    console.log('[macro] CDP attached, waiting for WS frames...');

    let lastSummaryUpdate = 0;

    sub.on('Network.webSocketFrameReceived', (e) => {
      const payload = e && e.response && e.response.payloadData;
      if (!payload) return;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { return; }
      const body = parsed && parsed.res && parsed.res.body;
      if (!Array.isArray(body)) return;

      for (const b of body) {
        if (!b || !b.events) continue;
        if (b.serverStatus !== 'RESOLVED') continue;

        for (const ev of b.events) {
          if (!ev || !ev.eventId) continue;
          if (seenIds.has(ev.eventId)) continue;

          const entry = logMatch(ev, b);
          if (!entry) continue;

          markSeen(ev.eventId);
          appendLog(entry);
          matchCount++;
          console.log(`[macro] #${matchCount} ${entry.league} ${entry.home} v ${entry.away} → ${entry.finalOutcome[0]}-${entry.finalOutcome[1]} (${entry.outcome}) odds=${entry.odds1x2.join('/')}`);
        }
      }

      // Clear references to the parsed frame so the GC can reclaim the large
      // WS payload (each frame can be 50-200 KB of odds/markets data).
      parsed = null;

      // Update summary every 10 new matches or every 60s (non-blocking)
      if (matchCount > 0 && (matchCount % 10 === 0 || Date.now() - lastSummaryUpdate > 60000)) {
        updateSummary().catch(() => {});
        lastSummaryUpdate = Date.now();
      }
    });

    // Click through leagues to trigger subscriptions
    await new Promise((r) => setTimeout(r, 8000));
    const frameEl = await page.$('iframe[src*="virtual"], iframe:not([src*="googletagmanager"])');
    if (frameEl) {
      const frame = await frameEl.contentFrame();
      if (frame) {
        await frame.evaluate(() => {
          const tg = Array.from(document.querySelectorAll('a.toggler, a[title="Football League"]')).find((a) => /Football League/i.test(a.textContent));
          if (tg) tg.click();
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        const links = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('a[href*="#/scheduled/league/playlist/"]')).map((a) => a.getAttribute('href'))
        ).catch(() => []);
        console.log(`[macro] league links: ${links.length}`);
        for (const href of links) {
          await frame.evaluate((h) => { const a = document.querySelector(`a[href="${h}"]`); if (a) a.click(); }, href).catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    // Perpetual loop — keep the session alive and periodically re-trigger leagues
    console.log('[macro] perpetual capture started. Press Ctrl+C to stop.');
    let retriggerCount = 0;
    while (true) {
      await new Promise((r) => setTimeout(r, 60000)); // check every 60s
      retriggerCount++;
      // Every 5 minutes, re-click through leagues to refresh WS subscriptions
      // AND clear accumulated old subscription data / media URL strings to
      // prevent unbounded growth of the CDP listener's retained payloads.
      if (retriggerCount % 5 === 0 && frameEl) {
        // Clear any old pending CDP requests that may hold large payloads
        if (sub.pending) {
          for (const [id, p] of sub.pending) {
            try { p.reject(new Error('cleared by 5-min cache flush')); } catch {}
          }
          sub.pending.clear();
        }

        const frame = await frameEl.contentFrame();
        if (frame) {
          const links = await frame.evaluate(() =>
            Array.from(document.querySelectorAll('a[href*="#/scheduled/league/playlist/"]')).map((a) => a.getAttribute('href'))
          ).catch(() => []);
          for (const href of links.slice(0, 2)) {
            await frame.evaluate((h) => { const a = document.querySelector(`a[href="${h}"]`); if (a) a.click(); }, href).catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
          }
          console.log(`[macro] re-triggered leagues, flushed CDP cache (${seenIds.size} IDs tracked, ${matchCount} logged)`);
        }

        // Hint the GC to reclaim cleared frame payloads. Without this the V8
        // heap can grow steadily as old WS payloads linger until the next
        // major GC cycle, which may not happen before hitting the Render limit.
        if (global.gc) {
          global.gc();
          const mem = process.memoryUsage();
          console.log(`[macro] post-gc: RSS=${(mem.rss / 1048576).toFixed(0)}MB heap=${(mem.heapUsed / 1048576).toFixed(0)}MB`);
        }
      }
    }
  } finally {
    await updateSummary().catch(() => {});
    console.log(`[macro] shutting down. Total matches logged: ${matchCount}`);
    await browser.close().catch(() => {});
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[macro] SIGINT received, writing final summary...');
  updateSummary().catch(() => {}).finally(() => process.exit(0));
});

run().catch((e) => { console.error('[macro] FAILED:', e); process.exit(1); });
