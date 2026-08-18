/**
 * bot-runner.js — The deployed prediction bot.
 *
 * On startup it:
 *   1. Starts a health-check HTTP server (Render probes it on $PORT).
 *   2. Enters a capture → predict → notify loop:
 *        capture a bounded window of live GoldenRace data (capture.js),
 *        run the prediction model (virtual-football-model.js via format-predictions.js),
 *        and send the report to Telegram (telegram-notify.js).
 *   3. Repeats every RUN_INTERVAL_SECONDS (default 300s / 5 min).
 *
 * If a run fails it logs the error and keeps going (a single capture hiccup must
 * not kill the service). Telegram config is optional: if not set, reports are
 * printed to stdout instead (useful for local testing).
 *
 * Render / container deployment:
 *   Dockerfile + render.yaml configure Chromium + puppeteer. The bot runs as the
 *   web service's start command. Secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
 *   come from Render environment variables — never committed.
 */
const { start: startServer, setState } = require('./server');
const { captureFootball } = require('./capture');
const { buildPredictions, composeReport, composeValuePicks, composeValueBetsPending, slateMeta } = require('./format-predictions');
const { notify } = require('./telegram-notify');
const { loadStore, saveStore, mergeResolved, calSamples, calSamplesByLeague } = require('./calibration-store');
const { computeEdge, formatEdgeReport } = require('./edge-calculator');
const { composeKellyBets } = require('./kelly');

const INTERVAL = (Number(process.env.RUN_INTERVAL_SECONDS) || 300) * 1000;
const CAPTURE = Number(process.env.CAPTURE_SECONDS) || 90;
let running = false;

// Memory monitor — logs RSS (resident set size) every cycle to help identify
// leaks on Render's 512MB free tier.
function logMemory(label) {
  const mem = process.memoryUsage();
  console.log(
    `[mem] ${label}: RSS=${(mem.rss / 1024 / 1024).toFixed(0)}MB ` +
    `heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB ` +
    `ext=${(mem.external / 1024 / 1024).toFixed(0)}MB`
  );
}

// Never let an unexpected error crash the service — Render would restart it and
// we'd lose the health server. Log and keep going.
process.on('unhandledRejection', (e) => {
  console.error('[bot] unhandledRejection:', e && e.message ? e.message : e);
});
process.on('uncaughtException', (e) => {
  console.error('[bot] uncaughtException:', e && e.message ? e.message : e);
});

async function runOnce() {
  if (running) {
    console.log('[bot] previous run still active — skipping this tick');
    return;
  }
  running = true;
  const capturedAt = Date.now();
  logMemory('run-start');
  console.log(`[bot] run # starting — capturing for ${CAPTURE}s ...`);
  try {
    const leagues = await captureFootball(CAPTURE);
    logMemory('post-capture');

    // Persist newly-captured resolved matches into the calibration store so the
    // calibration trains on an accumulating sample (stabilises the draw rate
    // across runs instead of swinging with each 57-match capture).
    const store = loadStore();
    const added = mergeResolved(store, leagues);
    if (added > 0) saveStore(store);
    console.log(`[bot] calibration store: ${store.matches.length} matches (+${added} new)`);

    // Merge macro-logger data into the store if the macro-stats log exists
    // (macro-logger.js writes to macro-stats.jsonl continuously)
    try {
      const macroLines = require('fs').readFileSync(require('path').join(__dirname, 'macro-stats.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      let macroAdded = 0;
      const seen = new Set(store.matches.map((m) => m.eventId));
      for (const line of macroLines) {
        try {
          const m = JSON.parse(line);
          if (m.eventId && !seen.has(m.eventId)) {
            // Slim format — same as mergeResolved: only store what calibration needs
            store.matches.push({ eventId: m.eventId, pid: m.playlistId, odds1x2: m.odds1x2, finalOutcome: m.finalOutcome });
            seen.add(m.eventId);
            macroAdded++;
          }
        } catch {}
      }
      if (macroAdded > 0) {
        if (store.matches.length > 2000) store.matches = store.matches.slice(-2000);
        saveStore(store);
        console.log(`[bot] merged ${macroAdded} matches from macro-stats.jsonl`);
      }
    } catch (e) { /* macro-stats.jsonl may not exist yet */ }

    const allPicks = buildPredictions(leagues, {
      calSamples: calSamples(store),
      calSamplesByLeague: calSamplesByLeague(store),
    });
    const meta = { capturedAt, ...slateMeta(allPicks) };
    const report = composeReport(allPicks, meta);

    // Edge-Deficit Analysis (from macro-stats log or calibration store)
    const edgeAnalysis = await computeEdge({ window: 200 });
    const edgeReport = edgeAnalysis.error ? null : formatEdgeReport(edgeAnalysis);

    // Kelly-sized value bets (replaces the old composeValuePicks)
    const bankroll = Number(process.env.BANKROLL) || 1000;
    const kellyMsg = allPicks.calActive
      ? composeKellyBets(allPicks, bankroll, { kellyFraction: 0.25, minEdge: 0.03 })
      : composeValueBetsPending(allPicks.calSampleCount, allPicks.leagueCalStatus);

    const nLeagues = Object.keys(leagues).length;
    const nValue = allPicks.filter((p) => p.pred.valueEv != null && p.pred.valueEv > 0).length;
    const activeLeagues = allPicks.leagueCalStatus ? Object.values(allPicks.leagueCalStatus).filter(s => s.active).length : 0;
    const calStatus = allPicks.calActive ? `cal ON (${allPicks.calSampleCount} samples, ${activeLeagues}/6 leagues)` : `cal OFF (${allPicks.calSampleCount} samples)`;
    const summary = `${allPicks.length} matches, ${nLeagues} leagues, ${nValue} +EV, ${calStatus}`;
    console.log(`[bot] captured ${summary}`);
    // Combine report + edge analysis + Kelly bets into a single notification
    const parts = [report];
    if (edgeReport) parts.push(edgeReport);
    parts.push(kellyMsg);
    const fullReport = parts.join('\n\n');
    console.log('\n' + fullReport.replace(/<[^>]+>/g, '') + '\n');

    const tgOk = await notify(fullReport);
    if (!tgOk) console.log('[bot] (Telegram not configured or failed — report printed above)');

    logMemory('post-notify');

    setState({
      lastRunAt: capturedAt,
      lastRunOk: true,
      lastRunError: null,
      lastSummary: summary,
      runs: (require('./server').getState().runs || 0) + 1,
    });
  } catch (e) {
    console.error(`[bot] run failed: ${e.message}`);
    setState({
      lastRunAt: capturedAt,
      lastRunOk: false,
      lastRunError: e.message,
      runs: (require('./server').getState().runs || 0) + 1,
    });
  } finally {
    running = false;
  }
}

function main() {
  startServer();
  console.log(`[bot] interval=${INTERVAL / 1000}s capture=${CAPTURE}s`);
  // Report Telegram config status at startup so the logs immediately show whether
  // notifications will fire (the most common "no notification" cause: env not set).
  const tg = require('./telegram-notify').config();
  if (tg) {
    console.log(`[bot] Telegram configured — chat_id=${tg.chatId}, token=...${tg.token.slice(-4)}`);
  } else {
    console.log('[bot] Telegram NOT configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) — reports will print to logs only.');
  }
  // First run immediately, then on the interval.
  runOnce();
  setInterval(runOnce, INTERVAL);
}

main();
