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

/** Pretty-print a participant: "FRE (freiburg)". */
function teamLabel(t) {
  if (!t) return '?';
  const code = t.code || t.fifaCode || '';
  const name = (t.name || '').replace(/_/g, ' ');
  return code ? `${code} (${name})` : name;
}

/** Format the eventTime as a short HH:MM UTC string (or '—' if missing). */
function timeLabel(eventTime) {
  if (!eventTime) return '—';
  try {
    const d = new Date(eventTime);
    return d.toUTCString().slice(17, 22); // "HH:MM"
  } catch {
    return '—';
  }
}

/**
 * Compose the Telegram notification. Returns a string of HTML.
 * Groups picks by league, showing league name, week/matchDay, match time,
 * full team names, and whether the match is upcoming.
 */
function composeReport(allPicks, meta = {}) {
  const lines = [];
  const now = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
  lines.push('⚽ <b>Virtual Football Predictions</b>');
  lines.push(`Captured: ${esc(now.toUTCString())}`);
  lines.push(`Matches analyzed: ${allPicks.length}`);
  const high = allPicks.filter((p) => p.pred.tier === 'HIGH');
  const med = allPicks.filter((p) => p.pred.tier === 'MEDIUM');
  lines.push(
    `Confidence: HIGH ${high.length} · MEDIUM ${med.length} · LOW ${allPicks.length - high.length - med.length}`
  );
  lines.push('━'.repeat(28));

  const ranked = [...allPicks].sort(
    (a, b) => b.pred.adjustedConfidence - a.pred.adjustedConfidence
  );
  const shown = ranked.filter((p) => p.pred.tier !== 'LOW').slice(0, 20);

  if (!shown.length) {
    lines.push('No high/medium-confidence picks in this capture.');
  } else {
    // Group by league for readability.
    const byLeague = {};
    for (const p of shown) {
      (byLeague[p.league] = byLeague[p.league] || []).push(p);
    }
    for (const [league, picks] of Object.entries(byLeague)) {
      const week = picks[0].rec.matchDay;
      lines.push(`\n🏆 <b>${esc(league)}</b>${week ? ` · Week ${week}` : ''}`);
      picks.forEach((p, i) => {
        const pr = p.pred;
        const t = timeLabel(p.rec.eventTime);
        const flag =
          pr.standingsAgreement === 'DISAGREE'
            ? ' ⚠️table✗'
            : pr.standingsAgreement === 'AGREE'
              ? ' ✓table'
              : '';
        lines.push(
          `  ${i + 1}. <b>${esc(pr.pickLabel)}</b> @ ${pr.odds[pr.pick].toFixed(2)}` +
            ` — ${esc(teamLabel(pr.home))} vs ${esc(teamLabel(pr.away))}` +
            ` ⏰${t}UTC · conf ${pct(pr.adjustedConfidence)} [${pr.tier}]${flag}`
        );
      });
    }
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
        `· ${esc(teamLabel(p.pred.home))} vs ${esc(teamLabel(p.pred.away))}` +
          ` → odds favor ${esc(p.pred.pickLabel)}, table PPG Δ${p.pred.ppgGap >= 0 ? '+' : ''}${p.pred.ppgGap.toFixed(2)}`
      );
    });
  }

  if (meta.avgVig != null) {
    lines.push('');
    lines.push(`House edge (1X2 vig): ${pct(meta.avgVig)}`);
  }
  lines.push('');
  lines.push(
    '<i>Confidence = de-vigged P(correct). Match times in UTC. Virtual football is RNG + house vig — cannot beat vig long-term.</i>'
  );
  return lines.join('\n');
}

/** Compute slate-wide metadata (avg vig) for the report. */
function slateMeta(allPicks) {
  if (!allPicks.length) return {};
  const vigSum = allPicks.reduce((a, p) => a + (p.pred.overround - 1), 0);
  return { avgVig: vigSum / allPicks.length };
}

module.exports = { buildPredictions, composeReport, slateMeta };
