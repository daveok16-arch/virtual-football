/**
 * virtual-football-model.js
 *
 * Prediction model for GoldenRace Scheduled Virtual Football on SportyBet.
 *
 * CORE PRINCIPLE
 * --------------
 * Virtual football outcomes are produced by GoldenRace's RNG simulation, and
 * the published 1X2 decimal odds are set by that same engine. The de-vigged
 * (overround-removed) odds-implied probability is therefore the best available
 * estimate of each outcome's true probability — no external signal can beat it.
 *
 * So:
 *   PREDICTION  = the outcome with the highest fair (de-vigged) probability
 *   CONFIDENCE  = that probability (literally P(prediction correct))
 *
 * SECONDARY SIGNAL — standings corroboration
 * ------------------------------------------
 * The full league table (points, form, goals) is a lagging, noisy reflection of
 * the same team strengths the odds already encode. We use it ONLY as a sanity
 * check: compare each team's points-per-game. When the standings favorite
 * disagrees with the odds favorite, we nudge confidence down (form may have
 * shifted) and flag the match. It never overrides the odds.
 *
 * ODDS LAYOUT (verified from intercepted frames)
 * ----------------------------------------------
 * event.data.oddValues = [
 *   0: 1 (Home win), 1: X (Draw), 2: 2 (Away win),   <- 1X2, indices 0..2
 *   3: DoubleChance 1X, 4: 12, 5: X2, ...            <- many more markets
 * ]
 * We consume only indices 0,1,2 for the 1X2 market.
 *
 * RESULTS (for backtesting, from RESOLVED events)
 * -----------------------------------------------
 * event.result.finalOutcome = [homeGoals, awayGoals, htHome, htAway] (strings)
 * event.result.wonMarkets includes the bare token "Home" | "Draw" | "Away"
 */

/**
 * Convert 1X2 decimal odds to fair (de-vigged) probabilities.
 * @param {[number,number,number]} odds [home, draw, away]
 * @returns {{home:number,draw:number,away:number,overround:number}} probs sum to ~1.0
 */
function fairProbabilities(odds) {
  const [h, d, a] = odds.map((o) => Number(o));
  if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) {
    return { home: NaN, draw: NaN, away: NaN, overround: NaN };
  }
  const imp = [1 / h, 1 / d, 1 / a];
  const sum = imp[0] + imp[1] + imp[2];
  return {
    home: imp[0] / sum,
    draw: imp[1] / sum,
    away: imp[2] / sum,
    overround: sum, // >1 means built-in house edge (vig)
  };
}

/**
 * EMPIRICAL CALIBRATION — corrects the de-vigged odds' systematic bias.
 *
 * The base model ASSUMES de-vigged odds = true probability. The backtest proves
 * this is FALSE per-outcome: the draw is massively under-implied (actual ~42%
 * vs implied ~25-33%), while favorites (home) over-actual their implied rate at
 * low confidence. We learn a per-outcome calibration map from resolved matches:
 * bucket the de-vigged probability into 0.1-wide bins per outcome, and record
 * the ACTUAL hit rate. At predict time we look up (or interpolate) the bin to
 * get a bias-corrected probability estimate. This is a isotonic-style smoother.
 *
 * Calibration map shape:
 *   { home: { "0.5": {n, hits, actual} }, draw: {...}, away: {...} }
 *
 * If a bin has no data we fall back to the raw de-vigged probability (honest:
 * we do not invent correction where we have no evidence).
 */

/** Bin a probability into a 0.1-wide bucket key ("0.0".."0.9"). */
function probBin(p) {
  const b = Math.max(0, Math.min(0.9, Math.floor(p * 10) / 10));
  // toFixed avoids float keys like 0.30000000000000004
  return b.toFixed(1);
}

/**
 * Learn a calibration map from an iterable of {pred, actual} pairs, where pred
 * is a predictMatch() result (with fairProbabilities + pick) and actual is the
 * resolved outcome ('home'|'draw'|'away'). Records, per outcome, how often each
 * de-vigged-probability bin actually occurred.
 */
function learnCalibration(samples) {
  const cal = { home: {}, draw: {}, away: {} };
  for (const { pred, actual } of samples) {
    if (!pred || !pred.fairProbabilities || !actual) continue;
    for (const o of OUTCOMES) {
      const p = pred.fairProbabilities[o];
      if (p == null || Number.isNaN(p)) continue;
      const key = probBin(p);
      const slot = (cal[o][key] = cal[o][key] || { n: 0, hits: 0 });
      slot.n++;
      if (actual === o) slot.hits++;
    }
  }
  for (const o of OUTCOMES) {
    for (const key of Object.keys(cal[o])) {
      const s = cal[o][key];
      s.actual = s.n ? s.hits / s.n : null;
    }
  }
  return cal;
}

/**
 * Look up the calibrated (bias-corrected) probability for an outcome given its
 * de-vigged probability. Uses the bin's empirical hit rate; interpolates linearly
 * between populated neighbouring bins when the exact bin is empty; falls back to
 * the raw de-vigged probability if no calibration data exists at all.
 *
 * SHRINKAGE: bin empirical rates are blended with the overall outcome rate,
 * weighted by the bin's sample count (Bayesian shrinkage). This prevents
 * extreme extrapolation from small samples — e.g., a draw at 12.10 odds
 * (implied 8%) shouldn't be calibrated to 50% just because the overall draw
 * rate is 50%. With N=500+, the shrinkage vanishes and the empirical rate
 * dominates. With N=57, the blend is ~50/50, pulling extreme values toward
 * the raw de-vigged probability.
 */
function calibrate(cal, outcome, fairProb) {
  const bins = cal && cal[outcome];
  if (!bins) return fairProb; // no calibration data — honest fallback
  const key = probBin(fairProb);
  const slot = bins[key];
  if (slot && slot.n >= MIN_CAL_SAMPLES) {
    return shrink(slot, fairProb, cal, outcome);
  }

  // Interpolate between nearest populated bins on either side of fairProb.
  const populated = Object.keys(bins)
    .map(Number)
    .filter((b) => bins[b.toFixed(1)].n >= MIN_CAL_SAMPLES)
    .sort((a, b) => a - b);
  if (!populated.length) return fairProb;
  let lo = null, hi = null;
  for (const b of populated) {
    if (b + 0.1 <= fairProb) lo = b;
    if (b >= fairProb && hi == null) hi = b;
  }
  if (lo != null && hi != null && lo !== hi) {
    const loA = shrink(bins[lo.toFixed(1)], fairProb, cal, outcome);
    const hiA = shrink(bins[hi.toFixed(1)], fairProb, cal, outcome);
    const span = hi - (lo + 0.1);
    const t = span > 0 ? (fairProb - (lo + 0.1)) / span : 0;
    return loA + (hiA - loA) * Math.max(0, Math.min(1, t));
  }
  const single = lo != null ? lo : hi;
  return shrink(bins[single.toFixed(1)], fairProb, cal, outcome);
}

/**
 * Bayesian shrinkage: blend the bin's empirical actual rate with the raw
 * de-vigged probability. The weight on the empirical rate grows with the bin's
 * sample count: w = n / (n + PRIOR_STRENGTH). With PRIOR_STRENGTH=20, a bin
 * with 20 samples is 50% empirical / 50% prior; with 100+ samples it's ~83%+
 * empirical. This prevents the calibration from assigning 50% draw probability
 * to a match with 8% implied draw odds based on just a few samples.
 */
const PRIOR_STRENGTH = 20;
function shrink(slot, fairProb, cal, outcome) {
  if (!slot || !slot.n) return fairProb;
  const w = slot.n / (slot.n + PRIOR_STRENGTH);
  return w * slot.actual + (1 - w) * fairProb;
}

/** Minimum resolved samples in a bin before we trust its empirical rate. */
const MIN_CAL_SAMPLES = 3;

const CONFIDENCE_TIERS = [
  { label: 'HIGH', min: 0.55 },
  { label: 'MEDIUM', min: 0.4 },
  { label: 'LOW', min: 0 },
];

function confidenceTier(p) {
  return CONFIDENCE_TIERS.find((t) => p >= t.min).label;
}

const OUTCOMES = ['home', 'draw', 'away'];

/**
 * Build a per-match prediction from a captured GoldenRace football event.
 *
 * @param {object} ev        a football event block: ev.data.participants, ev.data.oddValues
 * @param {object} standings optional standings map: { fifaCode -> {points, win, draw, lost, gamesPlayed, ...} }
 * @param {object} [cal]     optional learned calibration map (see learnCalibration). When
 *                           supplied, calibratedProbabilities + per-outcome EV are computed;
 *                           the `valuePick` is the +EV outcome (may differ from `pick`).
 * @returns {object} prediction
 */
function predictMatch(ev, standings = {}, cal = null) {
  const data = ev.data || {};
  const parts = data.participants || [];
  const odds = (data.oddValues || []).slice(0, 3);
  if (parts.length < 2 || odds.length < 3) return null;

  const home = parts[0];
  const away = parts[1];
  const fair = fairProbabilities(odds);
  if (Number.isNaN(fair.home)) return null;

  const probs = { home: fair.home, draw: fair.draw, away: fair.away };
  const pick = OUTCOMES.reduce((best, o) => (probs[o] > probs[best] ? o : best), 'home');
  const confidence = probs[pick];

  // --- standings corroboration (secondary, never overrides odds) ---
  const hs = standings[home.fifaCode];
  const as = standings[away.fifaCode];
  let standingsAgreement = 'N/A';
  let confidenceAdjust = 0;
  let ppgGap = null;
  if (hs && as) {
    const hPpg = hs.gamesPlayed ? hs.points / hs.gamesPlayed : null;
    const aPpg = as.gamesPlayed ? as.points / as.gamesPlayed : null;
    if (hPpg != null && aPpg != null) {
      ppgGap = hPpg - aPpg; // + => home stronger
      const standingsFav = ppgGap > 0.15 ? 'home' : ppgGap < -0.15 ? 'away' : 'draw';
      if (standingsFav === pick) {
        standingsAgreement = 'AGREE';
        confidenceAdjust = +0.02; // small boost — two signals align
      } else if (standingsFav !== 'draw') {
        standingsAgreement = 'DISAGREE';
        confidenceAdjust = -0.05; // odds & table point different ways -> less certain
      } else {
        standingsAgreement = 'NEUTRAL';
      }
    }
  }
  const adjustedConfidence = Math.max(0, Math.min(1, confidence + confidenceAdjust));

  // --- empirical calibration + expected value (the productive layer) ---
  // Calibrated probabilities are the bias-corrected true-prob estimates. EV is
  // computed against the VIGGED decimal odds (what you actually get paid):
  //   EV(outcome) = decimal_odds * P_calibrated(outcome) - 1.
  // A +EV outcome is a productive bet EVEN if it is not the most likely outcome
  // (e.g. a 42%-true draw at 4.0 pays +68% while a 55%-true favorite at 1.5 loses).
  let calibratedProbabilities = null;
  let evMap = null;
  let valuePick = null;
  let valueEv = null;
  if (cal) {
    calibratedProbabilities = {};
    evMap = {};
    for (const o of OUTCOMES) {
      calibratedProbabilities[o] = calibrate(cal, o, probs[o]);
      evMap[o] = Number(odds[OUTCOMES.indexOf(o)]) * calibratedProbabilities[o] - 1;
    }
    valuePick = OUTCOMES.reduce((best, o) => (evMap[o] > evMap[best] ? o : best), 'home');
    valueEv = evMap[valuePick];
  }

  return {
    home: { code: home.fifaCode || home.name, name: home.name, stars: home.stars },
    away: { code: away.fifaCode || away.name, name: away.name, stars: away.stars },
    odds: { home: Number(odds[0]), draw: Number(odds[1]), away: Number(odds[2]) },
    fairProbabilities: probs,
    overround: fair.overround,
    pick,
    pickLabel: { home: '1 (Home)', draw: 'X (Draw)', away: '2 (Away)' }[pick],
    confidence,
    adjustedConfidence,
    tier: confidenceTier(adjustedConfidence),
    standingsAgreement,
    ppgGap,
    margin: confidence - Math.max(...OUTCOMES.filter((o) => o !== pick).map((o) => probs[o])),
    // EV layer (present only when a calibration map is supplied):
    calibratedProbabilities,
    ev: evMap,
    valuePick,
    valueEv,
    valuePickLabel: valuePick && { home: '1 (Home)', draw: 'X (Draw)', away: '2 (Away)' }[valuePick],
  };
}

/**
 * Extract the 1X2 result from a RESOLVED event for backtesting.
 * @returns {'home'|'draw'|'away'|null}
 */
function matchResult(ev) {
  const fo = ev?.result?.finalOutcome;
  if (Array.isArray(fo) && fo.length >= 2) {
    const [hg, ag] = fo.map(Number);
    if (Number.isNaN(hg) || Number.isNaN(ag)) return null;
    return hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
  }
  // fallback: wonMarkets token
  const wm = ev?.result?.wonMarkets || [];
  if (wm.includes('Home')) return 'home';
  if (wm.includes('Draw')) return 'draw';
  if (wm.includes('Away')) return 'away';
  return null;
}

/**
 * Build a standings lookup from a captured FbEventBlockData/stats frame.
 * Returns { fifaCode -> { ranking, points, gamesPlayed, win, draw, lost, goalsFor, goalsAgainst, form } }
 */
function buildStandings(block) {
  const out = {};
  const gc = block?.stats?.groupClassification;
  if (!Array.isArray(gc)) return out;
  for (const g of gc) {
    for (const e of g.entries || []) {
      const games = (e.win || 0) + (e.draw || 0) + (e.lost || 0);
      out[e.fifaCode] = {
        ranking: e.ranking,
        points: e.points,
        gamesPlayed: games,
        win: e.win,
        draw: e.draw,
        lost: e.lost,
        goalsFor: e.goalsScored,
        goalsAgainst: e.goalsConceded,
        form: e.history, // array of "3"(W)/"1"(D)/"0"(L)
        group: g.group,
      };
    }
  }
  return out;
}

module.exports = {
  fairProbabilities,
  confidenceTier,
  predictMatch,
  matchResult,
  buildStandings,
  learnCalibration,
  calibrate,
  probBin,
  CONFIDENCE_TIERS,
  OUTCOMES,
  MIN_CAL_SAMPLES,
};
