/**
 * Intercept live Scheduled Virtual Football data directly from the network
 * layer using the Chrome DevTools Protocol (CDP) — no DOM scraping.
 *
 * The SportyBet "Scheduled Virtuals" football fixtures are pushed by the
 * GoldenRace provider through a WebSocket opened by a cross-origin iframe
 * (virtual-games.virtustec.com). Because the iframe is an out-of-process
 * frame (OOPIF), its network traffic is NOT visible on the page-level CDP
 * session. We therefore discover the iframe target with Target.getTargets,
 * attach to it with Target.attachToTarget, enable the Network domain on that
 * sub-session, and listen to Network.webSocketFrameReceived / HTTP events.
 *
 * Structure (as requested):
 *   1. Navigate to https://sportybet.com and wait for the cross-origin iframe.
 *   2. Enable Network tracing via CDP (on the page + on the iframe sub-session).
 *   3. Attach event listeners to catch incoming data streams:
 *        - Network.webSocketFrameReceived  (live fixture/odds push)
 *        - Network.loadingFinished         (continuous HTTP EventStreams / XHR)
 *   4. Filter the payload for virtual-football keywords/fields
 *      ("FbParticipant", "SCHEDULED", "PLAYLIST", "France", "England", ...).
 *   5. Pretty-print the raw JSON containing live schedules + countdown timers.
 *
 * Run:  node intercept-scheduled-virtuals.js
 * (Ctrl+C to stop — the stream stays alive perpetually.)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const START_URL = 'https://sportybet.com';
const OUTPUT_LOG = path.join(__dirname, 'virtual-football-live.ndjson');
const LEAGUE_MAPPINGS_FILE = path.join(__dirname, 'league-mappings.json');

// Load the playlistId -> league name reference mapping. Verified against the
// intercepted WebSocket metadata (FbParticipant team fifaCodes) and the UI.
let LEAGUE_NAMES = {};
try {
  const mappingsDoc = JSON.parse(fs.readFileSync(LEAGUE_MAPPINGS_FILE, 'utf8'));
  LEAGUE_NAMES = mappingsDoc.mappings || mappingsDoc;
} catch (err) {
  console.warn(
    `[mapping] Could not load ${LEAGUE_MAPPINGS_FILE}: ${err.message}. ` +
      'Output will show raw playlist IDs.'
  );
}

/** Resolve a playlistId to its human-readable league name. */
function leagueName(playlistId) {
  const key = String(playlistId);
  return LEAGUE_NAMES[key] || LEAGUE_NAMES[playlistId] || `League ${playlistId}`;
}

// Keywords / JSON fields that identify virtual-football fixture payloads.
// The GoldenRace stream multiplexes football, horse racing, greyhounds, etc.;
// these filters keep only the football schedule data.
const FOOTBALL_KEYWORDS = [
  'FbParticipant', // football teams (vs HorseParticipant / greyhounds)
  'contentBlockType',
  'PLAYLIST',
  'SCHEDULED',
  'oddValues',
  'fifaCode',
  'match_result',
  'league',
  'fixture',
  'schedule',
  'odds',
  'match-item',
  'leagues',
  'France',
  'England',
  'Spain',
  'Italy',
  'Germany',
  'Turkey',
];

const KEYWORD_RE = new RegExp(FOOTBALL_KEYWORDS.join('|'), 'i');

/**
 * Create a lightweight CDP sub-session bound to a discovered target.
 * Commands are sent through the parent session via Target.sendMessageToTarget;
 * responses/events arrive on Target.receivedMessageFromTarget and are routed
 * back here by sessionId.
 */
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
        try { cb(params); } catch (e) { /* listener error */ }
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

  // Wire up routing for this sub-session's responses/events.
  const route = (evt) => {
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
  };
  parentClient.on('Target.receivedMessageFromTarget', route);

  return sub;
}

/** Try to parse a WebSocket/HTTP payload as JSON; return null if not JSON. */
function tryParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Pretty-print a football fixture payload to the terminal. */
function printFixturePayload(source, parsed, raw) {
  const ts = new Date().toISOString();
  console.log('\n' + '='.repeat(78));
  console.log(`[${ts}] ${source}`);
  console.log('='.repeat(78));

  // Walk the GoldenRace envelope and pull out the football event blocks.
  // Envelope: { type, res: { statusCode, body: [ { blockType, contentBlockType,
  //            serverStatus, eBlockId, playlistId, events, data, stats } ] } }
  const blocks = parsed?.res?.body;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const events = block.events || [];
      const data = block.data || {};
      // A block is football if its events carry FbParticipant teams, OR its
      // top-level data is FbEventBlockData (the metadata/standings frame that
      // carries matchDay/weekDay but no per-match events).
      const isFootballByEvents = events.some(
        (ev) =>
          ev?.data?.participants?.some(
            (p) => p?.classType === 'FbParticipant'
          )
      );
      const isFootballMeta = data.classType === 'FbEventBlockData';
      if (!isFootballByEvents && !isFootballMeta) continue;

      const status = block.serverStatus || '?';
      const eBlockId = block.eBlockId;
      const playlistId = block.playlistId;
      const name = leagueName(playlistId); // resolve via league-mappings.json
      const matchDay = data.matchDay;
      const weekDay = data.weekDay;
      const legOrder = data.legOrder;
      const phase = data.phase;

      // Header line includes the current week (matchDay) when available —
      // this is the live "week" of the virtual league season.
      const weekPart = matchDay != null ? ` Week ${matchDay}` : '';
      const phasePart = phase ? ` [${phase}]` : '';
      console.log(
        `\n  [${name}] EventBlock #${eBlockId} (playlist ${playlistId})${weekPart}${phasePart} — status: ${status}`
      );

      if (isFootballByEvents) {
        for (const ev of events) {
          const evData = ev.data || {};
          const parts = evData.participants || [];
          if (parts.length >= 2) {
            const home = parts[0];
            const away = parts[1];
            const odds = evData.oddValues || [];
            // Countdown / kick-off time if present.
            const countdown = ev.countdown || evData.countdown || evData.timeToStart;
            console.log(
              `    ${home.fifaCode || home.name} vs ${away.fifaCode || away.name}` +
                (countdown ? `  (starts in ${countdown})` : '')
            );
            if (odds.length) {
              // First three oddValues are the 1X2 (Home/Draw/Away) for match_result.
              console.log(
                `      1X2 -> 1: ${odds[0] || '-'}  X: ${odds[1] || '-'}  2: ${odds[2] || '-'}`
              );
            }
          }
        }
      } else if (isFootballMeta) {
        // Metadata/standings frame: report the season week + group standings.
        const groups = data && block.stats?.groupClassification;
        console.log(
          `    Season week ${matchDay ?? '?'} (leg ${legOrder ?? '?'}, weekDay ${weekDay ?? '?'})`
        );
        if (Array.isArray(groups)) {
          for (const g of groups) {
            const entries = (g.entries || []).slice(0, 5);
            const line = entries
              .map((e) => `${e.fifaCode}(${e.points}pts)`)
              .join('  ');
            console.log(`    Group ${g.group}: ${line}`);
          }
        }
      }
    }
  }

  // Always pretty-print the full raw JSON object too, so nothing is lost.
  console.log('\n  --- raw JSON ---');
  console.log(JSON.stringify(parsed, null, 2).slice(0, 4000));
  if (raw.length > 4000) console.log(`  ... (truncated, full length ${raw.length})`);
}

/** Append a captured payload to an on-disk NDJSON log for later replay. */
function logToDisk(source, parsed) {
  // Derive the league name + current week (matchDay) from the payload's first
  // football block (either an events block with FbParticipant teams, or a
  // metadata block carrying FbEventBlockData with matchDay).
  let name = null;
  let matchDay = null;
  const blocks = parsed?.res?.body;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const isFootballByEvents = (block.events || []).some(
        (ev) =>
          ev?.data?.participants?.some(
            (p) => p?.classType === 'FbParticipant'
          )
      );
      const isFootballMeta = block.data?.classType === 'FbEventBlockData';
      if ((isFootballByEvents || isFootballMeta) && block.playlistId != null) {
        name = leagueName(block.playlistId);
        if (block.data?.matchDay != null) matchDay = block.data.matchDay;
        break;
      }
    }
  }
  try {
    fs.appendFileSync(
      OUTPUT_LOG,
      JSON.stringify({
        ts: Date.now(),
        league: name,
        matchDay,
        source,
        data: parsed,
      }) + '\n',
      'utf8'
    );
  } catch { /* disk error — non-fatal */ }
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // The scheduled-virtuals app is cross-origin; allow frame access so we
      // can attach a CDP sub-session to the iframe target.
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1440, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ---- Step 1: Navigate and wait for the cross-origin iframe ------------
    console.log(`[1/5] Navigating to ${START_URL} ...`);
    await page.goto(START_URL, { waitUntil: 'networkidle2' });
    const origin = new URL(page.url()).origin;
    const region = new URL(page.url()).pathname.replace(/\/$/, '');
    const scheduledUrl = `${origin}${region}/virtual/#/scheduled/league/upcoming`;
    console.log(`      Opening Scheduled Virtuals: ${scheduledUrl}`);
    await page.goto(scheduledUrl, { waitUntil: 'networkidle2' });
    await page.waitForSelector('iframe', { timeout: 30000 });
    // Give the GoldenRace SPA inside the iframe time to open its WebSocket.
    await new Promise((r) => setTimeout(r, 6000));

    // ---- Step 2: Enable Network tracing via CDP --------------------------
    // Page-level session (captures the main sportybet.com traffic).
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    console.log('[2/5] CDP Network.enable sent on page session.');

    // Discover the cross-origin iframe target and attach a sub-session so we
    // can see ITS network (the GoldenRace WebSocket lives here).
    const targets = await client.send('Target.getTargets');
    let iframeTarget = targets.targetInfos.find(
      (t) =>
        (t.type === 'iframe' || t.type === 'page') &&
        /virtustec/i.test(t.url || '')
    );

    // Retry a few times — the iframe may still be initialising.
    for (let i = 0; !iframeTarget && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const t2 = await client.send('Target.getTargets');
      iframeTarget = t2.targetInfos.find(
        (t) =>
          (t.type === 'iframe' || t.type === 'page') &&
          /virtustec/i.test(t.url || '')
      );
    }

    if (!iframeTarget) {
      throw new Error('Could not find the virtustec virtuals iframe target.');
    }
    console.log(`      Found iframe target: ${iframeTarget.url.slice(0, 70)}...`);

    const sub = createSubSession(client, iframeTarget.targetId);
    const attachResp = await client.send('Target.attachToTarget', {
      targetId: iframeTarget.targetId,
      flatten: false,
    });
    sub.sessionId = attachResp.sessionId;
    await sub.send('Network.enable');
    console.log('[3/5] Network.enable sent on iframe sub-session; attaching listeners...');

    // ---- Step 3: Attach event listeners to catch incoming data streams ---
    // Track HTTP request URLs so loadingFinished can fetch the right body.
    const reqUrlMap = new Map();
    sub.on('Network.requestWillBeSent', (e) => {
      reqUrlMap.set(e.requestId, e.request.url);
    });
    sub.on('Network.responseReceived', (e) => {
      reqUrlMap.set(e.requestId, e.response.url);
    });

    // (a) WebSocket frames — the primary live fixture/odds stream.
    sub.on('Network.webSocketCreated', (e) => {
      console.log(`\n[WS OPEN] ${(e.url || '').slice(0, 100)}`);
    });

    sub.on('Network.webSocketFrameReceived', (e) => {
      const payload = e.response?.payloadData || '';
      if (!payload) return;

      // ---- Step 4: Filter for virtual-football data ----
      const parsed = tryParseJSON(payload);
      const isJson = !!parsed;
      const matchesKeywords = KEYWORD_RE.test(payload);

      // GoldenRace football fixtures carry FbParticipant teams in PLAYLIST
      // blocks with serverStatus SCHEDULED. Football metadata/standings frames
      // instead carry FbEventBlockData (with matchDay/weekDay) and no per-match
      // events. Both are football — route them through the full pretty-printer.
      const isFootballJson =
        isJson &&
        Array.isArray(parsed?.res?.body) &&
        parsed.res.body.some(
          (b) =>
            (b.events || []).some((ev) =>
              (ev?.data?.participants || []).some(
                (p) => p?.classType === 'FbParticipant'
              )
            ) || b?.data?.classType === 'FbEventBlockData'
        );

      if (!isFootballJson && !matchesKeywords) return;

      // ---- Step 5: Pretty-print the live schedules + countdown timers ----
      if (isFootballJson) {
        const label =
          parsed?.res?.body?.some((b) => b?.data?.classType === 'FbEventBlockData')
            ? 'WebSocket frame (live football league week/standings)'
            : 'WebSocket frame (live football fixtures)';
        printFixturePayload(label, parsed, payload);
        logToDisk('ws-football', parsed);
      } else if (isJson) {
        // Keyword-matched JSON that isn't a full fixture block (e.g. config).
        // Prefix with the league name when the payload carries a playlistId.
        const pid =
          parsed?.res?.body?.find((b) => b?.playlistId != null)?.playlistId;
        const prefix = pid != null ? `[${leagueName(pid)}] ` : '';
        console.log(`\n${prefix}[WS JSON match] ${payload.slice(0, 800)}`);
        logToDisk('ws-keyword', parsed);
      } else {
        console.log(`\n[WS text match] ${payload.slice(0, 800)}`);
      }
    });

    // (b) Continuous HTTP EventStreams / XHR — some data may arrive over HTTP.
    sub.on('Network.loadingFinished', async (e) => {
      const url = reqUrlMap.get(e.requestId) || '';
      if (!/json|event-stream|text/i.test(url) && !KEYWORD_RE.test(url)) return;
      try {
        const body = await sub.send('Network.getResponseBody', {
          requestId: e.requestId,
        });
        const text = body?.body || '';
        if (!text || !KEYWORD_RE.test(text)) return;
        const parsed = tryParseJSON(text);
        if (parsed) {
          printFixturePayload(`HTTP ${url.slice(0, 60)}`, parsed, text);
          logToDisk('http', parsed);
        } else {
          console.log(`\n[HTTP match ${url.slice(0, 60)}] ${text.slice(0, 800)}`);
        }
      } catch {
        // body evicted / not available — ignore
      }
    });

    // Also listen on the main page session for any sportybet-level virtual
    // config APIs (e.g. /api/ng/sportySim/...) that carry football metadata.
    client.on('Network.loadingFinished', async (e) => {
      const resp = await client
        .send('Network.getResponseBody', { requestId: e.requestId })
        .catch(() => null);
      const text = resp?.body || '';
      if (text && KEYWORD_RE.test(text)) {
        const parsed = tryParseJSON(text);
        if (parsed) {
          console.log(`\n[PAGE HTTP match]`);
          console.log(JSON.stringify(parsed, null, 2).slice(0, 1500));
          logToDisk('page-http', parsed);
        }
      }
    });

    // Trigger the fixture feed by clicking through the football leagues in
    // the sidebar — this makes the SPA subscribe to each league's event block.
    console.log('[trigger] Clicking through football leagues to request data ...');
    const frameEl = await page.$(
      'iframe[src*="virtual"], iframe:not([src*="googletagmanager"])'
    );
    if (!frameEl) {
      throw new Error(
        'Could not find the virtuals iframe on the page — the SPA may not have loaded.'
      );
    }
    const frame = await frameEl.contentFrame();
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
    const leagueLinks = await frame
      .evaluate(() =>
        Array.from(
          document.querySelectorAll('a[href*="#/scheduled/league/playlist/"]')
        ).map((a) => ({ href: a.getAttribute('href'), name: a.getAttribute('title') }))
      )
      .catch(() => []);
    console.log(
      `        Leagues: ${leagueLinks.map((l) => l.name).join(', ') || '(none found)'}`
    );

    // Click each league once to kick off the WS subscription, then let the
    // perpetual listener below keep capturing live updates.
    for (const l of leagueLinks) {
      await frame
        .evaluate((href) => {
          const a = document.querySelector(`a[href="${href}"]`);
          if (a) a.click();
        }, l.href)
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }

    // ---- Perpetual wait: keep the stream alive until interrupted ----------
    console.log('\n[5/5] Live interception active. Listening for fixture streams...');
    console.log('      (Press Ctrl+C to stop. Logging to ' + OUTPUT_LOG + ')');
    console.log('      League mappings loaded from ' + LEAGUE_MAPPINGS_FILE + ':');
    Object.entries(LEAGUE_NAMES).forEach(([pid, name]) =>
      console.log(`        ${pid} -> ${name}`)
    );
    console.log('      The GoldenRace WebSocket pushes fresh fixture/odds');
    console.log('      rounds every few minutes — they will print below.\n');

    // Never-resolving promise keeps the process + browser alive indefinitely.
    await new Promise(() => {});
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Interception failed:', err);
  process.exit(1);
});
