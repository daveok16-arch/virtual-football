# virtual-football — Repository Knowledge

## Purpose
A Puppeteer (Node.js) tool that intercepts **live Scheduled Virtual Football** data
from SportyBet. It captures matches, season weeks (matchDay), and odds directly
from the GoldenRace provider's WebSocket via the Chrome DevTools Protocol (CDP) —
no DOM scraping.

## Key files
- `intercept-scheduled-virtuals.js` — the only executable script (520 lines). Perpetual
  listener; run with `node intercept-scheduled-virtuals.js` (Ctrl+C to stop).
- `league-mappings.json` — `playlistId -> league name` for the 6 football leagues
  (41104 England, 41106 France, 41108 Germany, 41110 Italy, 41113 Spain, 41114 Turkey).
- `live-weeks-snapshot.json` — point-in-time capture of current matchDay per league.
- `virtual-football-live.ndjson` — runtime output log (gitignored).

## How it works (CDP sub-session)
1. Launch headless Chrome with `--disable-web-security` + `--disable-features=IsolateOrigins,site-per-process`
   (the virtuals app is a cross-origin OOPIF).
2. Navigate to `sportybet.com -> /virtual/#/scheduled/league/upcoming`, wait for iframe.
3. Page-level CDP session: `Network.enable`, then `Target.getTargets` to find the
   `virtustec` iframe target.
4. `Target.attachToTarget` (flatten:false) -> sub-session -> `Network.enable` on it.
5. Listen for `Network.webSocketFrameReceived` (primary live stream) and
   `Network.loadingFinished` (HTTP fallback). Football detection: events with
   `participants[].classType === 'FbParticipant'`, OR `data.classType === 'FbEventBlockData'`.
6. Pretty-print fixtures/odds/standings; append to NDJSON log.

## Prediction bot (predict.js + virtual-football-model.js)
Two new files add a prediction/overhead-analysis bot DECOUPLED from the interceptor:
the interceptor writes `virtual-football-live.ndjson` perpetually; `predict.js` reads
it on demand.

- `node predict.js` — live predictions for SCHEDULED matches + slate-wide overhead
  analysis (top picks, watch-list disagreements, house vig, tightest matches).
- `node predict.js backtest` — calibration report on RESOLVED matches.

### Methodology (see virtual-football-model.js header)
Virtual football outcomes come from GoldenRace's RNG; the published 1X2 odds are set
by the same engine. So the **de-vigged odds-implied probability is the best probability
estimate** — PREDICTION = highest fair probability; CONFIDENCE = that probability
(literally P(correct)). Standings (points/form/goals) are a SECONDARY sanity check only:
AGREE/NEUTRAL/DISAGREE with the odds favorite, nudging adjusted confidence ±2–5pp.

### Key GoldenRace data fields (verified from live capture)
- `event.data.oddValues[0,1,2]` = 1X2 decimal odds [Home, Draw, Away] (indices 3+ are
  double-chance and other markets).
- Standings: blocks with `stats.groupClassification[].entries[]` — full 20-team tables
  with `fifaCode, points, win, draw, lost, goalsScored, goalsConceded, history` (form:
  "3"=W/"1"=D/"0"=L), plus `participants[].stars` team-strength rating.
- RESOLVED results: `event.result.finalOutcome = [homeGoals, awayGoals, htHome, htAway]`
  (strings); `event.result.wonMarkets` also contains the bare token "Home"/"Draw"/"Away".
  This enables real backtesting/calibration.
- `logToDisk` wraps each frame as `{ts, league, matchDay, source, data: <frame>}` —
  `predict.js` handles this wrapped form (entry.data.res) AND raw frames.

### Backtest findings (sample of 57 resolved matches)
- Overall accuracy 38.6% (always-pick-favorite baseline).
- HIGH tier (≥55% conf) is well-calibrated: predicted 61.2% vs actual 62.5%.
- MEDIUM/LOW tiers OVER-predict (predicted 45%/41% vs actual 32%/29%) — i.e. mid-low
  confidence picks are less reliable than the odds imply. The HIGH tier is the actionable zone.
- Actual outcome distribution: Home 30% / Draw 42% / Away 28% — draws are over-represented
  in virtual football vs real football.
- House vig (1X2 overround) averages ~8.3–8.9%.

### Run
```
npm install
node intercept-scheduled-virtuals.js   # capture (Ctrl+C when done)
node predict.js                         # predictions + overhead analysis
node predict.js backtest                # calibration on resolved matches
```
Note: resolved matches arrive mainly in the initial WS subscription burst; run the
interceptor long enough (or re-trigger leagues) to accumulate a backtest sample.

## Telegram + Render deployment (bot-runner.js)
Deployable prediction bot: capture → predict → Telegram, on a recurring loop.

Files: `capture.js` (reusable capture fn), `format-predictions.js` (report builder),
`telegram-notify.js` (zero-dep Bot API sender), `server.js` (health check on $PORT),
`bot-runner.js` (orchestrator entry point), `Dockerfile` + `render.yaml` + `.env.example`.

- `npm start` / `node bot-runner.js` runs the loop: every RUN_INTERVAL_SECONDS (300)
  it captures CAPTURE_SECONDS (90) of live data, predicts, and sends an HTML report
  of HIGH/MEDIUM picks to Telegram. A health server on $PORT keeps Render happy.
- Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) are env vars only — `.env` is
  gitignored; `.env.example` documents them. If unset, reports print to stdout.
- Dockerfile installs system Chromium + sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
- render.yaml: docker web service, free plan, secret env vars marked `sync: false`.
- capture.js navigation MUST go: START_URL (networkidle2) → derive region →
  `${origin}${region}/virtual/#/scheduled/league/upcoming` (networkidle2) → waitForSelector
  iframe → 6s warmup → CDP Target.getTargets for virtustec. Skipping the virtuals URL
  means the iframe never loads. (Verified: fixed after initial miss.)

## Audit findings (verified 2026-08-15) — FIXED
- `node --check` passes; syntax valid. JSON files parse and are mutually consistent
  (same 6 playlist IDs, names match across both files). mappings load correctly at runtime.
- **package.json mismatch (FIXED):** removed stale `main`/`scrape`/`scrape:football`
  references to non-existent scrape scripts. Now `main` + `intercept` + `start` all
  point to `intercept-scheduled-virtuals.js`.
- **Null-guard (FIXED):** `frameEl.contentFrame()` now preceded by an explicit
  `if (!frameEl) throw ...` with a clear message.
- **Step-counter mismatch (FIXED):** runtime logs now use `[1/5]`..`[5/5]` matching the
  documented 5-step header structure.
- **Live test (2026-08-15T09:55Z):** ran a bounded capture — confirmed working. Captured
  **456 football matches** across all 6 leagues with 1X2 odds + standings. Updated
  `live-weeks-snapshot.json` with fresh matchDay values (England 21, France 9, Germany 30,
  Italy 20, Spain 21, Turkey 21) and top-5 group standings.
  System Chromium at `/usr/bin/chromium` (v151) is used via `executablePath`; puppeteer's
  bundled Chromium is NOT downloaded. The site redirects to `sportybet.com/ng/...` (Nigeria region).
- **Deprecated CDP APIs (OPEN):** uses `Target.sendMessageToTarget` /
  `Target.receivedMessageFromTarget` (deprecated in modern Chrome in favor of flat
  `sessionId` mode via `flatten:true`). Works but fragile across puppeteer/Chrome versions.
- Several `.catch(()=>{})` swallow errors silently (acceptable for a resilient listener).
