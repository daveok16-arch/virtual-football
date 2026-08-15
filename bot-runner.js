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
const { buildPredictions, composeReport, slateMeta } = require('./format-predictions');
const { notify } = require('./telegram-notify');

const INTERVAL = (Number(process.env.RUN_INTERVAL_SECONDS) || 300) * 1000;
const CAPTURE = Number(process.env.CAPTURE_SECONDS) || 90;
let running = false;

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
    const allPicks = buildPredictions(leagues);
    const meta = { capturedAt, ...slateMeta(allPicks) };
    const report = composeReport(allPicks, meta);

    const nLeagues = Object.keys(leagues).length;
    const summary = `${allPicks.length} matches across ${nLeagues} leagues`;
    console.log(`[bot] captured ${summary}`);
    console.log('\n' + report.replace(/<[^>]+>/g, '') + '\n');

    const tgOk = await notify(report);
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
  // First run immediately, then on the interval.
  runOnce();
  setInterval(runOnce, INTERVAL);
}

main();
