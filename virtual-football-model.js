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
 * @returns {object} prediction
 */
function predictMatch(ev, standings = {}) {
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
  CONFIDENCE_TIERS,
  OUTCOMES,
};
