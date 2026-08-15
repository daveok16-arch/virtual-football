/**
 * format-predictions.js — Turn captured league data into prediction objects + a
 * Telegram-friendly HTML report. Kept separate from the runner so it is unit-testable.
 */
const { predictMatch } = require('./virtual-football-model');
const { leagueName } = require('./capture');

const pct = (x) => `${(x * 100).toFixed(0)}%`;

/** Build flat list of predictions from the leagues structure returned by capture(). */
function buildPredictions(leagues) {
  const all = [];
  for (const [pid, L] of Object.entries(leagues)) {
    for (const rec of L.scheduled) {
      const pred = predictMatch(rec.ev, L.standings);
      if (!pred) continue;
      all.push({ pid, league: leagueName(pid), rec, pred });
    }
  }
  return all;
}

/** HTML-escape for Telegram. */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Compose the Telegram notification. Returns a string of HTML.
 * Highlights only the actionable (HIGH/MEDIUM) picks to keep messages useful.
 */
function composeReport(allPicks, meta = {}) {
  const lines = [];
  const now = meta.capturedAt ? new Date(meta.capturedAt).toUTCString() : new Date().toUTCString();
  lines.push('⚽ <b>Virtual Football Predictions</b>');
  lines.push(`Captured: ${esc(now)}`);
  lines.push(`Matches analyzed: ${allPicks.length}`);
  const high = allPicks.filter((p) => p.pred.tier === 'HIGH');
  const med = allPicks.filter((p) => p.pred.tier === 'MEDIUM');
  lines.push(`Confidence: HIGH ${high.length} · MEDIUM ${med.length} · LOW ${allPicks.length - high.length - med.length}`);
  lines.push('━'.repeat(28));

  const ranked = [...allPicks].sort((a, b) => b.pred.adjustedConfidence - a.pred.adjustedConfidence);
  const shown = ranked.filter((p) => p.pred.tier !== 'LOW').slice(0, 15);
  if (!shown.length) {
    lines.push('No high/medium-confidence picks in this capture.');
  } else {
    lines.push('<b>Top picks (HIGH/MEDIUM):</b>');
    shown.forEach((p, i) => {
      const pr = p.pred;
      const flag = pr.standingsAgreement === 'DISAGREE' ? ' ⚠️table✗' : pr.standingsAgreement === 'AGREE' ? ' ✓table' : '';
      lines.push(
        `${i + 1}. <b>${esc(pr.pickLabel)}</b> @ ${pr.odds[pr.pick].toFixed(2)}` +
          ` — ${esc(pr.home.code)} vs ${esc(pr.away.code)}` +
          ` · conf ${pct(pr.adjustedConfidence)} [${pr.tier}]${flag}`
      );
    });
  }

  // Disagreements watch-list (odds vs standings) — a few of the most striking.
  const mism = ranked
    .filter((p) => p.pred.standingsAgreement === 'DISAGREE')
    .slice(0, 4);
  if (mism.length) {
    lines.push('');
    lines.push('⚠️ <b>Odds vs table watch-list:</b>');
    mism.forEach((p) => {
      lines.push(
        `· ${esc(p.pred.home.code)} vs ${esc(p.pred.away.code)}` +
          ` → odds favor ${esc(p.pred.pickLabel)}, table PPG Δ${p.pred.ppgGap >= 0 ? '+' : ''}${p.pred.ppgGap.toFixed(2)}`
      );
    });
  }

  if (meta.avgVig != null) {
    lines.push('');
    lines.push(`House edge (1X2 vig): ${pct(meta.avgVig)}`);
  }
  lines.push('');
  lines.push(`<i>Confidence = de-vigged P(correct). Virtual football is RNG + house vig — cannot beat vig long-term.</i>`);
  return lines.join('\n');
}

/** Compute slate-wide metadata (avg vig) for the report. */
function slateMeta(allPicks) {
  if (!allPicks.length) return {};
  const vigSum = allPicks.reduce((a, p) => a + (p.pred.overround - 1), 0);
  return { avgVig: vigSum / allPicks.length };
}

module.exports = { buildPredictions, composeReport, slateMeta };
