/**
 * kelly.js — Fractional Kelly Criterion bankroll management.
 *
 * The Kelly Criterion computes the optimal bet size to maximize long-term
 * bankroll growth:
 *   f* = (p × b − q) / b
 * where:
 *   p = probability of winning (calibrated)
 *   b = net odds (decimal_odds − 1)
 *   q = 1 − p (probability of losing)
 *   f* = fraction of bankroll to bet
 *
 * We use FRACTIONAL Kelly (default 0.25× / "Quarter-Kelly") because:
 *   1. Our probability estimates have uncertainty (small samples, model error)
 *   2. Full Kelly is extremely volatile (large drawdowns)
 *   3. The house's 8.3% vig reduces the effective edge
 *   4. Quarter-Kelly sacrifices ~25% of growth for ~50% less variance
 *
 * The Kelly fraction is capped at 0.05 (5% of bankroll) for any single bet
 * to prevent catastrophic loss from a single bad outcome. Negative Kelly
 * (no edge) means: don't bet.
 *
 * Usage:
 *   const k = kellyBet({ calibratedProb: 0.42, decimalOdds: 3.5, bankroll: 1000, kellyFraction: 0.25 });
 *   // → { kelly: 0.193, betFraction: 0.048, betAmount: 48.0, shouldBet: true }
 */
const path = require('path');
const { computeEdge } = require('./edge-calculator');

const DEFAULT_KELLY_FRACTION = 0.25; // Quarter-Kelly
const MAX_BET_FRACTION = 0.05; // never risk more than 5% on one bet
const MIN_EDGE = 0.0; // only bet when Kelly > 0 (positive expected value)

/**
 * Compute the Kelly-optimal bet size for a single outcome.
 *
 * @param {object} params
 * @param {number} params.calibratedProb  estimated probability of winning (0-1)
 * @param {number} params.decimalOdds     the decimal odds being offered
 * @param {number} params.bankroll        current bankroll in account currency
 * @param {number} [params.kellyFraction]  fraction of full Kelly to use (default 0.25)
 * @returns {object} { kelly, betFraction, betAmount, shouldBet, edge }
 */
function kellyBet({ calibratedProb, decimalOdds, bankroll, kellyFraction = DEFAULT_KELLY_FRACTION }) {
  const p = Math.max(0, Math.min(1, calibratedProb));
  const q = 1 - p;
  const b = decimalOdds - 1; // net odds

  if (b <= 0 || p <= 0 || p >= 1) {
    return { kelly: 0, betFraction: 0, betAmount: 0, shouldBet: false, edge: 0, ev: 0 };
  }

  // Full Kelly fraction
  const kelly = (p * b - q) / b;
  // Fractional Kelly, capped at MAX_BET_FRACTION
  const betFraction = Math.min(MAX_BET_FRACTION, Math.max(0, kelly * kellyFraction));
  const betAmount = betFraction * bankroll;

  // Edge = calibrated probability × decimal odds − 1
  const ev = p * decimalOdds - 1;

  return {
    kelly, // full Kelly fraction (can be negative)
    betFraction, // actual fraction to bet (fractional, capped)
    betAmount, // absolute amount in bankroll currency
    shouldBet: betFraction > 0 && ev > MIN_EDGE,
    edge: ev, // expected value as proportion (e.g., 0.15 = +15% EV)
    ev: ev,
    bankroll,
    odds: decimalOdds,
    prob: p,
  };
}

/**
 * Compute Kelly bet sizes for all three outcomes of a match.
 * Uses the calibrated probabilities and the 1X2 odds.
 *
 * @param {object} pred  a predictMatch() result with calibratedProbabilities + odds
 * @param {number} bankroll
 * @param {number} [kellyFraction]
 * @returns {object} { home, draw, away } each a kellyBet() result, plus best (highest EV)
 */
function kellyForMatch(pred, bankroll, kellyFraction = DEFAULT_KELLY_FRACTION) {
  if (!pred || !pred.calibratedProbabilities || !pred.odds) return null;

  const outcomes = ['home', 'draw', 'away'];
  const result = {};
  let best = null;

  for (const o of outcomes) {
    const k = kellyBet({
      calibratedProb: pred.calibratedProbabilities[o],
      decimalOdds: pred.odds[o],
      bankroll,
      kellyFraction,
    });
    result[o] = k;
    if (!best || k.ev > best.ev) best = k;
  }

  result.best = best;
  result.bestOutcome = best && best.shouldBet
    ? outcomes.find((o) => result[o] === best)
    : null;
  return result;
}

/**
 * Build a Kelly-sized value bets report for Telegram.
 * Only includes matches where the best outcome has positive Kelly (positive EV).
 * Bets are ordered by edge (highest first).
 *
 * @param {object[]} allPicks  array of { pid, league, rec, pred } from buildPredictions
 * @param {number} bankroll     current bankroll
 * @param {object} [opts]
 * @param {number} [opts.kellyFraction]  default 0.25
 * @param {number} [opts.maxBets]        max bets to show (default 10)
 * @param {number} [opts.minEdge]        minimum EV to include (default 0.03 = 3%)
 */
function composeKellyBets(allPicks, bankroll, opts = {}) {
  const kellyFraction = opts.kellyFraction || DEFAULT_KELLY_FRACTION;
  const maxBets = opts.maxBets || 10;
  const minEdge = opts.minEdge || 0.03;

  const candidates = [];
  for (const p of allPicks) {
    if (!p.pred || !p.pred.calibratedProbabilities || p.pred.valueEv == null) continue;
    const ks = kellyForMatch(p.pred, bankroll, kellyFraction);
    if (!ks || !ks.best || !ks.best.shouldBet) continue;
    if (ks.best.ev < minEdge) continue;
    candidates.push({
      pick: p,
      kelly: ks.best,
      outcome: ks.bestOutcome,
      kellyBets: ks,
    });
  }

  // Sort by edge descending
  candidates.sort((a, b) => b.kelly.ev - a.kelly.ev);
  const top = candidates.slice(0, maxBets);

  if (top.length === 0) {
    return [
      '💰 <b>Kelly Value Bets</b>',
      '━'.repeat(20),
      '',
      `Bankroll: <b>${bankroll}</b> | Kelly: ${kellyFraction}× | Min edge: +${(minEdge * 100).toFixed(0)}%`,
      '',
      '<i>No +EV bets found this cycle. The 8.3% vig filters most matches.</i>',
    ].join('\n');
  }

  const lines = [];
  lines.push('💰 <b>Kelly Value Bets (Quarter-Kelly sizing)</b>');
  lines.push('━'.repeat(20));
  lines.push('');
  lines.push(`Bankroll: <b>${bankroll}</b> | Kelly: ${kellyFraction}× | Max/bet: ${(MAX_BET_FRACTION * 100).toFixed(0)}%`);
  lines.push('');

  // Group by league
  const byLeague = {};
  for (const c of top) {
    const ln = c.pick.league;
    if (!byLeague[ln]) byLeague[ln] = [];
    byLeague[ln].push(c);
  }

  const sym = { home: '1', draw: 'X', away: '2' };

  for (const [ln, bets] of Object.entries(byLeague)) {
    lines.push(`🏆 ${ln}`);
    for (const c of bets) {
      const p = c.pick.pred;
      const k = c.kelly;
      const outcome = c.outcome;
      const t = timeLabel(c.pick.rec.eventTime);
      const w = weekLabel(c.pick.rec.matchDay);
      lines.push(
        `  ${w} · ${t}  <b>${sym[outcome]}</b> ${esc(code(p.home))} v ${esc(code(p.away))}` +
          ` @ ${k.odds.toFixed(2)} · EV +${(k.ev * 100).toFixed(0)}% · P=${(k.prob * 100).toFixed(0)}% · bet <b>${k.betAmount.toFixed(0)}</b> (${(k.betFraction * 100).toFixed(1)}%)`
      );
    }
    lines.push('');
  }

  const totalStake = top.reduce((a, c) => a + c.kelly.betAmount, 0);
  const totalEdge = top.reduce((a, c) => a + c.kelly.ev, 0) / top.length;
  lines.push(
    `<i>${top.length} bets · total stake ${totalStake.toFixed(0)} (${((totalStake / bankroll) * 100).toFixed(0)}% bankroll) · avg edge +${(totalEdge * 100).toFixed(0)}% · UTC</i>`
  );

  return lines.join('\n');
}

// Helpers (duplicated from format-predictions to avoid circular dep)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function code(t) {
  return (t && (t.code || t.fifaCode)) || '?';
}
function timeLabel(eventTime) {
  if (!eventTime) return '--:--';
  try {
    const d = new Date(eventTime);
    return d.toISOString().slice(11, 16);
  } catch { return '--:--'; }
}
function weekLabel(matchDay) {
  if (matchDay == null) return '';
  return `W${matchDay}`;
}

module.exports = {
  kellyBet,
  kellyForMatch,
  composeKellyBets,
  DEFAULT_KELLY_FRACTION,
  MAX_BET_FRACTION,
};
