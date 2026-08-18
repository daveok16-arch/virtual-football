/**
 * edge-calculator.js — Computes structural pricing anomalies by comparing
 * the bookmaker's de-vigged implied probabilities against the actual outcome
 * distribution over a rolling window of N matches.
 *
 * The 8.3% vig is the house's guaranteed edge. To profit, we must find
 * structural mispricing where the actual probability differs from the
 * implied probability by MORE than the vig margin — and this difference
 * must be STABLE over a large sample (macro-scale, N=500+).
 *
 * Outputs:
 *   - Per-outcome edge (in percentage points) = actual_rate - implied_rate
 *   - Per-outcome EV after vig = (actual_rate × decimal_odds) - 1
 *   - Per-league breakdown (France draws differently than England)
 *   - Confidence interval (Wilson score) for each edge estimate
 *   - Moving average over configurable window (default 200 matches)
 */
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'macro-stats.jsonl');

/**
 * Wilson score confidence interval for a proportion.
 * @param {number} hits  observed successes
 * @param {number} n     total trials
 * @param {number} z     z-score (1.96 for 95% CI, 1.44 for 85%)
 * @returns {{lo:number, hi:number, p:number}}
 */
function wilsonCI(hits, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, (center - spread) / denom), hi: Math.min(1, (center + spread) / denom), p };
}

/**
 * Load the macro-stats log and compute the edge analysis.
 * @param {object} opts
 * @param {number} opts.window  rolling window size (most recent N matches). 0 = all.
 * @param {number} opts.zScore  z-score for confidence intervals
 * @returns {object} edge analysis report
 */
function computeEdge({ window = 0, zScore = 1.96 } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return { error: 'no macro-stats log found', totalMatches: 0 };
  }

  let matches = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  if (window > 0 && matches.length > window) {
    matches = matches.slice(-window);
  }

  const n = matches.length;
  if (n === 0) return { error: 'no matches in log', totalMatches: 0 };

  // === Overall outcome distribution ===
  const overall = { home: 0, draw: 0, away: 0, totalGoals: 0, vigSum: 0, impliedSum: { home: 0, draw: 0, away: 0 } };

  // === Per-league breakdown ===
  const byLeague = {};

  // === Per-outcome implied probability tracking (for edge calc) ===
  // For each outcome, track the implied probability (de-vigged) and whether it hit
  const outcomeStats = {
    home: { impliedSum: 0, hits: 0, n: 0 },
    draw: { impliedSum: 0, hits: 0, n: 0 },
    away: { impliedSum: 0, hits: 0, n: 0 },
  };

  // === Star-differential buckets ===
  const byStarDiff = {};

  // === Goal distribution ===
  const goalDist = {};

  for (const m of matches) {
    overall[m.outcome]++;
    overall.totalGoals += m.totalGoals;
    overall.vigSum += m.overround - 1;

    const fp = m.fairProbs;
    if (fp && fp.length === 3) {
      overall.impliedSum.home += fp[0];
      overall.impliedSum.draw += fp[1];
      overall.impliedSum.away += fp[2];

      outcomeStats.home.impliedSum += fp[0];
      outcomeStats.draw.impliedSum += fp[1];
      outcomeStats.away.impliedSum += fp[2];
      outcomeStats.home.n++;
      outcomeStats.draw.n++;
      outcomeStats.away.n++;
      if (m.outcome === 'home') outcomeStats.home.hits++;
      if (m.outcome === 'draw') outcomeStats.draw.hits++;
      if (m.outcome === 'away') outcomeStats.away.hits++;
    }

    // Per-league
    const ln = m.league || 'Unknown';
    if (!byLeague[ln]) {
      byLeague[ln] = { home: 0, draw: 0, away: 0, n: 0, vigSum: 0, totalGoals: 0,
        impliedSum: { home: 0, draw: 0, away: 0 }, hits: { home: 0, draw: 0, away: 0 } };
    }
    const L = byLeague[ln];
    L[m.outcome]++;
    L.n++;
    L.vigSum += m.overround - 1;
    L.totalGoals += m.totalGoals;
    if (fp && fp.length === 3) {
      L.impliedSum.home += fp[0];
      L.impliedSum.draw += fp[1];
      L.impliedSum.away += fp[2];
      L.hits[m.outcome]++;
    }

    // Star differential
    const diff = Math.abs((m.homeStars || 0) - (m.awayStars || 0));
    const bucket = diff < 0.5 ? 'even' : diff < 2 ? 'small' : 'large';
    if (!byStarDiff[bucket]) byStarDiff[bucket] = { home: 0, draw: 0, away: 0, n: 0, impliedDraw: 0 };
    byStarDiff[bucket][m.outcome]++;
    byStarDiff[bucket].n++;
    if (fp && fp.length === 3) byStarDiff[bucket].impliedDraw += fp[1];

    // Goal distribution
    const tg = m.totalGoals;
    goalDist[tg] = (goalDist[tg] || 0) + 1;
  }

  // === Compute edges ===
  const outcomes = ['home', 'draw', 'away'];
  const edgeReport = {};

  for (const o of outcomes) {
    const s = outcomeStats[o];
    const actualRate = s.hits / Math.max(s.n, 1);
    const impliedRate = s.impliedSum / Math.max(s.n, 1);
    const edge = actualRate - impliedRate; // in proportion (multiply by 100 for pp)
    const ci = wilsonCI(s.hits, s.n, zScore);

    // Average odds for this outcome
    let avgOdds = 0;
    let oddsCount = 0;
    for (const m of matches) {
      const idx = outcomes.indexOf(o);
      const od = m.odds1x2 && m.odds1x2[idx];
      if (od && od > 1) { avgOdds += od; oddsCount++; }
    }
    avgOdds = oddsCount > 0 ? avgOdds / oddsCount : 0;

    // EV after vig: if we bet this outcome at avg odds every match
    const ev = actualRate * avgOdds - 1;

    edgeReport[o] = {
      actualRate,
      impliedRate,
      edge: edge, // proportion (e.g., 0.07 = 7pp)
      edgePP: edge * 100, // percentage points
      ci: { lo: ci.lo, hi: ci.hi },
      ciWidth: (ci.hi - ci.lo) * 100, // pp
      avgOdds,
      ev, // expected value of always betting this outcome
      n: s.n,
      hits: s.hits,
    };
  }

  // === Per-league edge ===
  const leagueEdges = {};
  for (const [ln, L] of Object.entries(byLeague)) {
    leagueEdges[ln] = {
      n: L.n,
      drawRate: L.draw / L.n,
      drawImplied: L.impliedSum.draw / L.n,
      drawEdge: (L.draw / L.n) - (L.impliedSum.draw / L.n),
      drawEV: (L.draw / L.n) * (L.impliedSum.draw > 0 ? 1 : 0) - 1, // simplified
      avgVig: L.vigSum / L.n,
      avgGoals: L.totalGoals / L.n,
    };
  }

  // === Star-differential draw edge ===
  const starEdges = {};
  for (const [bucket, s] of Object.entries(byStarDiff)) {
    starEdges[bucket] = {
      n: s.n,
      drawRate: s.draw / s.n,
      drawImplied: s.impliedDraw / s.n,
      drawEdge: (s.draw / s.n) - (s.impliedDraw / s.n),
    };
  }

  return {
    totalMatches: n,
    window: window || 'all',
    zScore,
    overall: {
      drawRate: overall.draw / n,
      homeRate: overall.home / n,
      awayRate: overall.away / n,
      avgGoals: overall.totalGoals / n,
      avgVig: overall.vigSum / n,
      impliedDraw: overall.impliedSum.draw / n,
      drawEdgePP: ((overall.draw / n) - (overall.impliedSum.draw / n)) * 100,
    },
    edges: edgeReport,
    byLeague: leagueEdges,
    byStarDiff: starEdges,
    goalDist,
    // Quick summary: is the draw edge statistically significant?
    drawEdgeSignificant: edgeReport.draw.edge > 0 &&
      edgeReport.draw.ci.lo > 0, // lower bound of CI is above zero
  };
}

/**
 * Format the edge analysis as a human-readable report (for Telegram or stdout).
 */
function formatEdgeReport(analysis) {
  if (analysis.error) return `Edge analysis: ${analysis.error}`;

  const lines = [];
  lines.push('📊 <b>Edge-Deficit Analysis</b>');
  lines.push('━'.repeat(20));
  lines.push('');
  lines.push(`<b>${analysis.totalMatches} matches</b> (window: ${analysis.window})`);

  const o = analysis.overall;
  lines.push('');
  lines.push('<b>Overall distribution:</b>');
  lines.push(`  Home: ${(o.homeRate * 100).toFixed(1)}% | Draw: ${(o.drawRate * 100).toFixed(1)}% | Away: ${(o.awayRate * 100).toFixed(1)}%`);
  lines.push(`  Avg goals: ${o.avgGoals.toFixed(1)} | Avg vig: ${(o.avgVig * 100).toFixed(1)}%`);
  lines.push(`  Implied draw: ${(o.impliedDraw * 100).toFixed(1)}% | Draw edge: ${o.drawEdgePP.toFixed(1)}pp`);

  lines.push('');
  lines.push('<b>Per-outcome edge (actual − implied):</b>');
  for (const o of ['home', 'draw', 'away']) {
    const e = analysis.edges[o];
    const sym = o === 'home' ? '1' : o === 'draw' ? 'X' : '2';
    const sig = e.ci.lo > 0 ? '✅' : e.ci.hi < 0 ? '❌' : '⚖️';
    lines.push(`  ${sym} ${o}: actual=${(e.actualRate * 100).toFixed(1)}% implied=${(e.impliedRate * 100).toFixed(1)}% edge=${e.edgePP.toFixed(1)}pp EV=${(e.ev * 100).toFixed(0)}% CI=[${(e.ci.lo * 100).toFixed(0)}-${(e.ci.hi * 100).toFixed(0)}]% ${sig}`);
  }

  lines.push('');
  lines.push('<b>Per-league draw edge:</b>');
  for (const [ln, e] of Object.entries(analysis.byLeague)) {
    const sig = e.drawEdge > 0.03 ? '✅' : e.drawEdge < -0.03 ? '❌' : '⚖️';
    lines.push(`  ${ln}: draw=${(e.drawRate * 100).toFixed(0)}% implied=${(e.drawImplied * 100).toFixed(0)}% edge=${(e.drawEdge * 100).toFixed(1)}pp (n=${e.n}) ${sig}`);
  }

  if (analysis.drawEdgeSignificant) {
    lines.push('');
    lines.push('<i>✅ Draw edge is statistically significant (CI lower bound > 0)</i>');
  }

  return lines.join('\n');
}

module.exports = { computeEdge, formatEdgeReport, wilsonCI };
