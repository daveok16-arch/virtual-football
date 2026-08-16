/**
 * format-predictions.js — Turn captured league data into prediction objects + a
 * Telegram-friendly HTML report. Kept separate from the runner so it is unit-testable.
 */
const { predictMatch, learnCalibration, matchResult, OUTCOMES } = require('./virtual-football-model');
const { leagueName } = require('./capture');

const pct = (x) => `${(x * 100).toFixed(0)}%`;

/**
 * Build flat list of predictions from the leagues structure returned by capture().
 * When `withValue` is true and enough resolved matches exist, a calibration map is
 * learned from the resolved set and applied to the scheduled set so each prediction
 * carries calibratedProbabilities + per-outcome EV + valuePick (+EV outcome).
 */
function buildPredictions(leagues, { withValue = true } = {}) {
  let cal = null;
  if (withValue) {
    const train = [];
    for (const L of Object.values(leagues)) {
      for (const rec of L.resolved) {
        const pred = predictMatch(rec.ev, L.standings);
        const actual = matchResult(rec.ev);
        if (pred && actual) train.push({ pred, actual });
      }
    }
    if (train.length >= 10) cal = learnCalibration(train);
  }

  const all = [];
  for (const [pid, L] of Object.entries(leagues)) {
    for (const rec of L.scheduled) {
      const pred = predictMatch(rec.ev, L.standings, cal);
      if (!pred) continue;
      all.push({ pid, league: leagueName(pid), rec, pred });
    }
  }
  return all;
}

/** HTML-escape for Telegram. */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Short team code only (for compact table rows). */
function code(t) {
  return (t && (t.code || t.fifaCode)) || '?';
}

/** Pretty-print a participant: "FRE (freiburg)". */
function teamLabel(t) {
  if (!t) return '?';
  const c = t.code || t.fifaCode || '';
  const name = (t.name || '').replace(/_/g, ' ');
  return c ? `${c} (${name})` : name;
}

/** Format the eventTime as a short HH:MM UTC string (or '—' if missing). */
function timeLabel(eventTime) {
  if (!eventTime) return '--:--';
  try {
    const d = new Date(eventTime);
    return d.toUTCString().slice(17, 22); // "HH:MM"
  } catch {
    return '--:--';
  }
}

/** Numeric sort key from eventTime (epoch ms), missing → Infinity (sorts last). */
function timeSortKey(eventTime) {
  if (!eventTime) return Infinity;
  const t = new Date(eventTime).getTime();
  return Number.isNaN(t) ? Infinity : t;
}

/** Compact pick symbol for a row: "1", "X", "2". */
function pickSymbol(pred) {
  return { home: '1', draw: 'X', away: '2' }[pred.pick] || '?';
}

/** Tier emoji for quick visual scan. */
const TIER_ICON = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' };

/**
 * Group picks into league → week → [picks sorted by confidence desc].
 * Weeks are sorted numerically. Returns an ordered array of league sections.
 */
function groupByLeagueWeek(allPicks) {
  const tree = {};
  for (const p of allPicks) {
    const wk = p.rec.matchDay || 0;
    if (!tree[p.league]) tree[p.league] = {};
    if (!tree[p.league][wk]) tree[p.league][wk] = [];
    tree[p.league][wk].push(p);
  }
  const sections = [];
  for (const [league, weeks] of Object.entries(tree)) {
    const weekEntries = Object.entries(weeks)
      .map(([wk, picks]) => ({
        week: Number(wk),
        picks: picks.sort(
          (a, b) => b.pred.adjustedConfidence - a.pred.adjustedConfidence
        ),
      }))
      .sort((a, b) => a.week - b.week);
    sections.push({ league, weeks: weekEntries });
  }
  return sections;
}

/**
 * Compose a single clean message: the TOP pick per league per week.
 * Only HIGH/MEDIUM confidence. One line per pick. No noise.
 */
function composeReport(allPicks, meta = {}) {
  const lines = [];
  const now = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
  const high = allPicks.filter((p) => p.pred.tier === 'HIGH');
  const med = allPicks.filter((p) => p.pred.tier === 'MEDIUM');

  lines.push('⚽ <b>Top Picks</b>');
  lines.push(esc(now.toUTCString().slice(0, 22)));
  lines.push('━'.repeat(16));

  // Group by league → week, pick the SINGLE best from each.
  const sections = groupByLeagueWeek(allPicks.filter((p) => p.pred.tier !== 'LOW'));

  for (const sec of sections) {
    lines.push(`\n🏆 ${esc(sec.league)}`);
    for (const w of sec.weeks) {
      const best = w.picks[0]; // already sorted by confidence desc
      if (!best) continue;
      const pr = best.pred;
      const sym = pickSymbol(pr);
      const t = timeLabel(best.rec.eventTime);
      const agree =
        pr.standingsAgreement === 'AGREE' ? ' ✓' :
        pr.standingsAgreement === 'DISAGREE' ? ' ⚠️' : '';
      lines.push(
        `  W${w.week} · ${t}  <b>${sym}</b> ${esc(code(pr.home))} v ${esc(code(pr.away))}` +
          ` @ ${pr.odds[pr.pick].toFixed(2)} · ${pct(pr.adjustedConfidence)}${agree}`
      );
    }
  }

  lines.push('');
  lines.push(
    `<i>${allPicks.length} matches · 🟢${high.length} 🟡${med.length} · vig ${meta.avgVig != null ? pct(meta.avgVig) : '?'} · UTC</i>`
  );
  return lines.join('\n');
}

/**
 * Identify the eventIds that composeReport selects as its top picks (the
 * highest-confidence match per league per week, HIGH/MEDIUM only). Used by
 * composeValuePicks to exclude those matches so the two sections don't overlap.
 */
function topPickEventIds(allPicks) {
  const ids = new Set();
  const sections = groupByLeagueWeek(allPicks.filter((p) => p.pred.tier !== 'LOW'));
  for (const sec of sections) {
    for (const w of sec.weeks) {
      if (w.picks[0]) ids.add(w.picks[0].rec.ev.eventId);
    }
  }
  return ids;
}

/**
 * Compose the "Value Bets" message — +EV picks grouped by league → week,
 * mirroring the Top Picks layout but covering DIFFERENT matches (the ones
 * Top Picks did not already select). Shows the single best +EV pick per
 * league per week from the remaining pool, sorted by EV descending.
 *
 * Only emitted when the predictions carry the EV layer (calibration applied);
 * returns null when there are no +EV bets after excluding Top Picks matches.
 */
function composeValuePicks(allPicks, meta = {}) {
  const exclude = topPickEventIds(allPicks);
  const value = allPicks.filter(
    (p) =>
      p.pred.valueEv != null &&
      p.pred.valueEv > 0 &&
      !exclude.has(p.rec.ev.eventId)
  );
  if (!value.length) return null;
  const now = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
  const lines = [];

  // Summarise the calibration finding so the reader understands WHY value
  // bets lean draw (or whatever the dominant +EV outcome is).
  const pickCounts = { home: 0, draw: 0, away: 0 };
  for (const p of value) pickCounts[p.pred.valuePick]++;
  const dominant = Object.entries(pickCounts).sort((a, b) => b[1] - a[1])[0][0];
  const domSym = { home: '1', draw: 'X', away: '2' }[dominant];

  lines.push('💰 <b>Value Bets (+EV)</b>');
  lines.push(esc(now.toUTCString().slice(0, 22)));
  lines.push('━'.repeat(20));

  const sections = groupByLeagueWeek(value);
  for (const sec of sections) {
    lines.push(`\n🏆 ${esc(sec.league)}`);
    for (const w of sec.weeks) {
      // Re-sort by EV desc (groupByLeagueWeek sorted by confidence) and take the top.
      w.picks.sort((a, b) => (b.pred.valueEv || 0) - (a.pred.valueEv || 0));
      const best = w.picks[0];
      if (!best) continue;
      const pr = best.pred;
      const sym = { home: '1', draw: 'X', away: '2' }[pr.valuePick] || '?';
      const t = timeLabel(best.rec.eventTime);
      const diff = pr.valuePick !== pr.pick ? ` ⚡${pickSymbol(pr)}` : '';
      lines.push(
        `  W${w.week} · ${t}  <b>${sym}</b> ${esc(code(pr.home))} v ${esc(code(pr.away))}` +
          ` @ ${pr.odds[pr.valuePick].toFixed(2)} · EV +${(pr.valueEv * 100).toFixed(0)}%${diff}`
      );
    }
  }

  lines.push('');
  lines.push(
    `<i>${value.length} +EV bets (excl. Top Picks) · ` +
      `dominant: ${domSym} (${pickCounts[dominant]}/${value.length}) · ` +
      `EV = odds × calibrated P − 1 · UTC</i>`
  );
  return lines.join('\n');
}

/** Compute slate-wide metadata (avg vig) for the report. */
function slateMeta(allPicks) {
  if (!allPicks.length) return {};
  const vigSum = allPicks.reduce((a, p) => a + (p.pred.overround - 1), 0);
  return { avgVig: vigSum / allPicks.length };
}

module.exports = {
  buildPredictions,
  composeReport,
  composeValuePicks,
  slateMeta,
};
