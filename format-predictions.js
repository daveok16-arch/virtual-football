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
 * Group picks into league → week → [picks sorted by kick-off time].
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
        picks: picks.sort((a, b) => timeSortKey(a.rec.eventTime) - timeSortKey(b.rec.eventTime)),
      }))
      .sort((a, b) => a.week - b.week);
    sections.push({ league, weeks: weekEntries });
  }
  return sections;
}

/**
 * Compose the "Top Picks" summary — HIGH-confidence picks only, grouped by
 * league → week → time. This is the actionable notification.
 */
function composeTopPicks(allPicks, meta = {}) {
  const lines = [];
  const now = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
  const high = allPicks.filter((p) => p.pred.tier === 'HIGH');
  const med = allPicks.filter((p) => p.pred.tier === 'MEDIUM');
  const low = allPicks.filter((p) => p.pred.tier === 'LOW');

  lines.push('⚽ <b>Virtual Football — Top Picks</b>');
  lines.push(`📅 ${esc(now.toUTCString())}`);
  lines.push(`📊 ${allPicks.length} matches | 🟢${high.length} 🟡${med.length} ⚪${low.length}`);
  if (meta.avgVig != null) lines.push(`💰 House vig: ${pct(meta.avgVig)}`);
  lines.push('━'.repeat(20));

  if (!high.length) {
    lines.push('No HIGH-confidence picks this cycle.');
    lines.push('');
    lines.push('<i>Confidence = de-vigged P(correct). Match times in UTC.</i>');
    return lines.join('\n');
  }

  const highPicks = high.sort(
    (a, b) => b.pred.adjustedConfidence - a.pred.adjustedConfidence
  );
  const sections = groupByLeagueWeek(highPicks);

  for (const sec of sections) {
    lines.push(`\n🏆 <b>${esc(sec.league)}</b>`);
    for (const w of sec.weeks) {
      lines.push(`  📆 Week ${w.week}`);
      for (const p of w.picks) {
        const pr = p.pred;
        const flag =
          pr.standingsAgreement === 'DISAGREE'
            ? ' ⚠️'
            : pr.standingsAgreement === 'AGREE'
              ? ' ✓'
              : '';
        lines.push(
          `  ⏰${timeLabel(p.rec.eventTime)}  <b>${pickSymbol(pr)}</b>@${pr.odds[pr.pick].toFixed(2)}` +
            `  ${esc(code(pr.home))} v ${esc(code(pr.away))}` +
            `  ${pct(pr.adjustedConfidence)}${flag}`
        );
      }
    }
  }

  lines.push('');
  lines.push('<i>🟢≥55% 🟡≥40% ⚪<40% · ✓table agrees ⚠️table disagrees · Times in UTC</i>');
  return lines.join('\n');
}

/**
 * Compose the "Full Schedule" — ALL matches grouped by league → week → time,
 * in a compact table-like list. Sent as a second message so the top-picks
 * summary stays concise.
 */
function composeFullSchedule(allPicks, meta = {}) {
  const lines = [];
  const now = meta.capturedAt ? new Date(meta.capturedAt) : new Date();
  lines.push('📋 <b>Virtual Football — Full Schedule</b>');
  lines.push(`📅 ${esc(now.toUTCString())} · ${allPicks.length} matches`);
  lines.push('━'.repeat(20));

  const sections = groupByLeagueWeek(allPicks);

  for (const sec of sections) {
    lines.push(`\n🏆 <b>${esc(sec.league)}</b>`);
    for (const w of sec.weeks) {
      lines.push(`  📆 Week ${w.week}  (${w.picks.length} matches)`);
      for (const p of w.picks) {
        const pr = p.pred;
        const icon = TIER_ICON[pr.tier] || '⚪';
        const flag =
          pr.standingsAgreement === 'DISAGREE'
            ? '⚠️'
            : pr.standingsAgreement === 'AGREE'
              ? '✓'
              : ' ';
        lines.push(
          `  ${icon}⏰${timeLabel(p.rec.eventTime)} ${pickSymbol(pr)}@${pr.odds[pr.pick].toFixed(2)}` +
            ` ${esc(code(pr.home))}v${esc(code(pr.away))} ${pct(pr.adjustedConfidence)}${flag}`
        );
      }
    }
  }

  lines.push('');
  lines.push('<i>1=Home X=Draw 2=Away · 🟢HIGH 🟡MED ⚪LOW · ✓/⚠️ table agreement · UTC</i>');
  return lines.join('\n');
}

/** Backward-compatible single-message report (top picks + watch-list). */
function composeReport(allPicks, meta = {}) {
  return composeTopPicks(allPicks, meta);
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
  composeTopPicks,
  composeFullSchedule,
  slateMeta,
};
