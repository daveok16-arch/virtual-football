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
const { loadStore, saveStore, mergeResolved, calSamples } = require('./calibration-store');

const INTERVAL = (Number(process.env.RUN_INTERVAL_SECONDS) || 300) * 1000;
const CAPTURE = Number(process.env.CAPTURE_SECONDS) || 90;
let running = false;

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
  console.log(`[bot] run # starting — capturing for ${CAPTURE}s ...`);
  try {
    const leagues = await captureFootball(CAPTURE);

    // Persist newly-captured resolved matches into the calibration store so the
    // calibration trains on an accumulating sample (stabilises the draw rate
    // across runs instead of swinging with each 57-match capture).
    const store = loadStore();
    const added = mergeResolved(store, leagues);
    if (added > 0) saveStore(store);
    console.log(`[bot] calibration store: ${store.matches.length} matches (+${added} new)`);

    const allPicks = buildPredictions(leagues, { calSamples: calSamples(store) });
    const meta = { capturedAt, ...slateMeta(allPicks) };
    const report = composeReport(allPicks, meta);

    // Value bets: only emit when calibration is active (≥100 accumulated samples).
    // Below that threshold, show a "pending" notice so the user knows why +EV bets
    // are not shown — the calibration is intentionally gated to prevent the noisy
    // small-sample predictions that caused real losses.
    const valueMsg = allPicks.calActive
      ? composeValuePicks(allPicks, meta)
      : composeValueBetsPending(allPicks.calSampleCount);

    const nLeagues = Object.keys(leagues).length;
    const nValue = allPicks.filter((p) => p.pred.valueEv != null && p.pred.valueEv > 0).length;
    const calStatus = allPicks.calActive ? `cal ON (${allPicks.calSampleCount})` : `cal OFF (${allPicks.calSampleCount}/100)`;
    const summary = `${allPicks.length} matches across ${nLeagues} leagues, ${nValue} +EV, ${calStatus}`;
    console.log(`[bot] captured ${summary}`);
    // Combine report + value bets into a single notify() call so the auto-delete
    // logic (which clears the previous batch at the start of each notify) treats
    // them as one notification batch, not two separate ones.
    const fullReport = valueMsg ? report + '\n\n' + valueMsg : report;
    console.log('\n' + fullReport.replace(/<[^>]+>/g, '') + '\n');

    const tgOk = await notify(fullReport);
    if (!tgOk) console.log('[bot] (Telegram not configured or failed — report printed above)');

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
