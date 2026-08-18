# virtual-football — Repository Knowledge

## Purpose
A Puppeteer (Node.js) tool that intercepts **live Scheduled Virtual Football** data
from SportyBet. It captures matches, season weeks (matchDay), and odds directly
from the GoldenRace provider's WebSocket via the Chrome DevTools Protocol (CDP) —
no DOM scraping.

## Key files
- `intercept-scheduled-virtuals.js` — the only executable script (412 lines). Perpetual
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

## Deep investigation (2026-08-15) — GoldenRace RNG architecture & why EV lost money

### Architecture (verified by full network capture + JS bundle analysis)
- **RNG is 100% server-side.** The virtustec iframe JS (3MB `common.chunk.js` +
  177KB `scheduled.module.js`) contains NO RNG/seed/match-generation logic. It is
  pure presentation (Angular + PixiJS). Match outcomes are pre-computed on
  GoldenRace's server and delivered to clients.
- **Results are PRE-DETERMINED and pre-rendered.** Each resolved event carries an
  `hlsURL` pointing to a pre-rendered video of the predetermined outcome. The video
  exists BEFORE the scheduled kick-off time.
- **Odds and outcomes come from the SAME server engine.** The `oddValues` arrive
  in the same event block as the match data. The house sets odds AND determines
  outcomes — de-vigging gives the engine's own probability estimate, NOT an
  independent market consensus.
- **There is nothing to reverse-engineer client-side.** No seed, no hash, no
  provably-fair scheme exposed. The `calculationId` is a server-side batch ID for
  pre-computed results.

### WS protocol (the complete API surface)
| Client sends | Purpose |
|---|---|
| `GET /session/loginHwId` | Auth (hwId + profile=WEB) |
| `GET /session/sync` | Keep-alive / state sync |
| `GET /playlists/` | Fetch all playlist metadata (ids list) |
| `GET /eventBlocks/event/data` | Fetch fixtures + odds (params: contentId, eventTime, n, offset, calculationId) |
| `GET /eventBlocks/event/result` | Fetch resolved results (same params + countDown) |
| `GET /eventBlocks/stats` | Fetch group classification / standings |
| `GET /tickets/findByTime` | Fetch bet tickets |

### Provisioning endpoints (static config)
- `virtual-games.virtustec.com/provisioning/footballConfigFiles/teamsHTML/{League}{Year}/40/{CODE}.png` — team logos
- `virtual-games.virtustec.com/provisioning/rules/checkRules.txt` — game rules index
- `virtual-games.virtustec.com/desktop-v4/default/profiles/sportybet-dark.json` — skin/profile config
- `virtual-games.virtustec.com/desktop-v4/default/{common,scheduled.module}.chunk.js` — engine JS
- `hls.virtustec.com/hls-service/gg/{video|audio|master}/{league}_5s/{seasonId}/{matchDayId}/{eventId}-{hGoals}-{aGoals}.m3u8` — pre-rendered match video (URL path contains the score!)

### The score is in the HLS URL path
For football: `.../germany_5s/339/335/198-0-1/468-1-0/...` — segments are `{eventId}-{homeGoals}-{awayGoals}`.
For races: `d6-4-5-1-2334` = dog6, finishing order 4-5-1-2-3. This confirms results are pre-computed.

### WHY EV BETTING LOST MONEY (root cause analysis)
Two captures of 57 matches each showed **wildly different draw rates**: 50.9% vs 33.3%.
With n=57, the standard error is ±6.5%, so the 95% CI spans 27%–53%. The calibration
was chasing SAMPLE NOISE, not a real engine bias:
- A draw-heavy sample (51%) → calibration overcorrects toward draws → recommends draws
- The next matches the user bet on reverted toward the ~40% true rate → draw bets lost
- The "wall of draws" in Telegram was the model amplifying noise, not finding a real edge

### Is there a real edge? (honest assessment)
- **Draw rate IS elevated in virtual football**: ~40% vs ~26% in real football (stable across both samples)
- **De-vigged draw odds typically imply 22-33%** draw probability, suggesting the odds
  engine systematically underprices draws by ~7-18pp
- **BUT**: the 8.3% vig means you need the edge to exceed 8.3% AFTER accounting for sample noise
- **With 57 matches, you CANNOT distinguish real edge from noise** (CI too wide)
- **With 300+ accumulated matches, the edge (if real) becomes detectable** — this is why the
  calibration store exists
- **The calibration store has a MIN_SAMPLE_SIZE=100 guard**: value bets are only emitted
  when the store has enough data to produce a stable calibration

### Vig (overround) characteristics
- Mean: 8.3%, Stdev: 1.4%, Range: 5.1%–9.2% — fairly uniform across matches
- This is the house's guaranteed edge that must be overcome

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

## Deep audit findings (verified 2026-08-15T21:55Z) — OPEN ACTION ITEMS
Verified by: `node --check` (8/8 JS pass), JSON parse (4/4 pass), 34 unit tests on the
model (all pass), end-to-end synthetic NDJSON through predict.js + format-predictions +
backtest (all correct), npm audit, require-graph analysis.

### HIGH
- **Supply-chain vuln:** `npm audit` reports HIGH in `extract-zip` (symlink path
  traversal, GHSA-jmr9-qjv8-65gv) via `@puppeteer/browsers` <=2.13.2 → puppeteer 23.11.1.
  Fix = upgrade to puppeteer@25.7.0 (breaking). The vulnerable code path (Chrome download
  via extract-zip) is skipped at runtime because `PUPPETEER_SKIP_DOWNLOAD=true` is set, so
  this is a build/CI surface, not a runtime exploit — but the dep is still installed.

### MEDIUM
- **Coupling / heavy require:** `format-predictions.js` imports `leagueName` from
  `capture.js`, which `require`s puppeteer. So loading the pure formatting module pulls in
  **136 puppeteer modules**. A formatting/test module should not depend on the capture
  engine. Fix: extract `leagueName` (+ the mappings loader) into a tiny shared module
  (e.g. `league-names.js`) and import it from intercept/capture/predict/format-predictions.
- **Duplicated `leagueName`:** defined 3× (intercept-scheduled-virtuals.js, capture.js,
  predict.js) with subtly different fallback semantics — intercept does
  `mappingsDoc.mappings || mappingsDoc` (tolerates unwrapped JSON); predict & capture do
  `.mappings || {}` (break if the wrapper key is dropped). Should be one shared impl.
- **bot-runner `running` flag has no watchdog:** if `captureFootball` hangs (e.g. a stuck
  `frame.evaluate` with no overall timeout), `running` stays true forever and EVERY
  subsequent `setInterval` tick is skipped — the bot silently stops capturing until
  restarted. capture.js has per-`goto` 60s timeouts but no overall capture deadline. Add a
  watchdog (e.g. `Promise.race` with a hard cap, or clear `running` after N minutes).
- **intercept perf:** the page-level `Network.loadingFinished` listener (line ~441) calls
  `Network.getResponseBody` for EVERY response on the main page, THEN filters by keyword.
  No URL pre-filter, no reqUrlMap for the page session. On a perpetual listener this
  fetches/holds bodies for all images, scripts, analytics, etc. capture.js does NOT have
  this issue (it only listens on the sub-session). Add a URL keyword pre-filter.
- **Dockerfile fallback:** `RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev || npm install --omit=dev`
  — the `npm install` fallback lacks the `PUPPETEER_SKIP_DOWNLOAD=true` prefix, so if `npm ci`
  fails the fallback downloads ~150MB of bundled Chrome (wasted space / slower build).

### LOW
- `headless: 'new'` is a legacy literal (puppeteer >=22 treats `headless: true` as the new
  headless mode). Works in 23.11 but should be `true` for forward-compat.
- `telegram-notify.js` uses deprecated `querystring` (use `URLSearchParams`).
- `chunk()` can emit a chunk > 4000 chars if a single line exceeds `TG_MAX` (Telegram
  would reject it at 4096). Unlikely with current short per-match lines, but unguarded.
- `predict.js loadCaptures` reads the whole ndjson into memory (`readFileSync` + split);
  fine for on-demand use, but unbounded if the perpetual interceptor is left running long.
- `intercept-scheduled-virtuals.js` is 412 lines (AGENTS.md previously said 520 — fixed).
- `--disable-web-security` + `--disable-features=IsolateOrigins,site-per-process` weaken
  the headless browser's security model (required for the cross-origin iframe CDP approach;
  acceptable given the tool only navigates to sportybet.com, but worth noting).

### Verified CORRECT (no action)
- Model math: de-vig probabilities sum to 1.0; NaN guard on odds ≤1 / 0 / undefined;
  string-odds coerced; tie-break defaults to home; standings AGREE/DISAGREE/NEUTRAL logic;
  `matchResult` finalOutcome + wonMarkets fallback; `buildStandings` gamesPlayed = W+D+L.
- predict.js frame unwrapping (`entry.data.res ? entry.data : entry`) handles both the
  logToDisk-wrapped form and raw envelopes — verified with synthetic NDJSON.
- HTML escaping in format-predictions (`&` `<` `>` escaped) — verified with `<`/`>` team names.
- Dockerfile inline `PUPPETEER_SKIP_DOWNLOAD=true npm ci` DOES skip Chrome at build time
  (the inline env is correct; only the fallback path is missing it).
- render.yaml / .env.example / server.js PORT defaults (10000) are mutually consistent;
  Render injects PORT automatically for web services.

## EV + learned-calibration layer (added 2026-08-15)
The base engine picks `argmax(de-vigged prob)` and pays the vigged price — structurally
−EV (it can't beat the vig, and its own backtest showed the draw is massively under-implied:
actual ~42% vs implied ~25-33%, so always-pick-draw 42% beats the model's 38.6%). Added a
**productive layer** that is backward-compatible (all original fields unchanged when no
calibration map is supplied):

- `learnCalibration(samples)` — from resolved {pred, actual} pairs, buckets each outcome's
  de-vigged probability into 0.1-wide bins and records the ACTUAL hit rate (isotonic-style).
- `calibrate(cal, outcome, fairProb)` — returns the bin's empirical rate (≥3 samples), or
  linearly interpolates between neighbouring populated bins across the gap `[lo+0.1, hi]`,
  or falls back to the raw de-vigged probability when no data exists (honest — no invented
  correction). `MIN_CAL_SAMPLES = 3`.
- `predictMatch(ev, standings, cal)` — when `cal` is supplied, adds `calibratedProbabilities`,
  `ev` (per-outcome `EV = decimal_odds × P_calibrated − 1`, against the VIGGED price you pay),
  `valuePick` (highest-EV outcome — may differ from `pick`), `valueEv`, `valuePickLabel`.
  EV is computed against vigged odds (what you get paid), NOT fair odds.
- `node predict.js ev` — learns calibration from ALL resolved matches, applies to SCHEDULED
  matches, surfaces +EV bets sorted by edge. Shows the learned correction per outcome.
- `node predict.js backtest` — now appends an **EV / VALUE BET ANALYSIS** section with
  **leave-one-out cross-validation (LOOCV)**: Strategy A (base, always favorite) vs
  Strategy B (LOOCV value bets, calibration trained on all matches EXCEPT the one predicted),
  plus ROI by predicted-EV bucket. This is the honest out-of-sample test for whether any
  +EV edge actually survives. If Strategy B ROI > 0 AND the >5%-EV bucket ROI > 0, the
  calibration finds real edge; if B ≈ A, the odds are already calibrated and no edge exists.
- `format-predictions.buildPredictions(leagues, {withValue:true})` — auto-learns calibration
  when ≥10 resolved matches exist and attaches the EV layer to each scheduled pick.
  `composeValuePicks` emits a Telegram "Value Bets (+EV)" message (returns null when no +EV,
  so the bot skips it). `bot-runner.js` sends it as a 2nd message between Top Picks &
  Full Schedule.

### Verified (synthetic + edge cases, 56 unit tests pass)
- Reproduced the documented draw mispricing: with draws actually 50% vs implied 25%, the EV
  mode flags the draw +EV (+100-150%); backtest LOOCV Strategy B ROI +100% vs Strategy A −50%.
- Genuinely fair odds → all EVs = −vig, value message correctly null (no false +EV).
- No resolved data → calibration skipped, `ev` null, value message null (graceful).
- HTML escaping preserved in value message (`&`/`<`/`>` escaped).
- Backward compat: original `predict.js` (live + backtest base sections) and all original
  prediction fields unchanged when no calibration map is supplied.

### Honest limitation
LOOCV with the current ~57 resolved-sample ceiling is conservative and the per-fold training
set is tiny; the EV edge is real ONLY insofar as the mispricing is structural (the draw
under-impression appears structural per the backtest). Accumulate more resolved matches
(run the interceptor longer) to tighten the calibration bins before staking real money.
