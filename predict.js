#!/usr/bin/env node
/**
 * predict.js — Virtual Football prediction & overhead-analysis bot.
 *
 * Reads captured GoldenRace frames from virtual-football-live.ndjson (produced by
 * intercept-scheduled-virtuals.js) and outputs:
 *
 *   node predict.js                 -> live predictions for upcoming SCHEDULED matches
 *                                     + slate-wide overhead analysis (the "big picture")
 *   node predict.js backtest        -> calibration report on RESOLVED matches (how honest
 *                                     is the model's confidence? does it actually predict?)
 *
 * The model lives in virtual-football-model.js. See its header for the methodology
 * (de-vigged odds = best probability estimate; standings = secondary corroboration).
 *
 * Responsible note: virtual sports are house-edged RNG games. This tool quantifies and
 * organizes the slate for analysis; it cannot overcome the built-in vig long-term.
 */
const fs = require('fs');
const path = require('path');
const {
  predictMatch,
  matchResult,
  buildStandings,
  confidenceTier,
} = require('./virtual-football-model');

const NDJSON = path.join(__dirname, 'virtual-football-live.ndjson');
const MAPPINGS = path.join(__dirname, 'league-mappings.json');

let LEAGUE_NAMES = {};
try {
  LEAGUE_NAMES = JSON.parse(fs.readFileSync(MAPPINGS, 'utf8')).mappings || {};
} catch {}
const leagueName = (pid) => LEAGUE_NAMES[String(pid)] || LEAGUE_NAMES[pid] || `League ${pid}`;

const isFbEvents = (b) =>
  (b.events || []).some((ev) =>
    (ev?.data?.participants || []).some((p) => p?.classType === 'FbParticipant'));
const isFbMeta = (b) => b?.data?.classType === 'FbEventBlockData';
const isFbStandings = (b) => b?.stats?.groupClassification;
const isFootballBlock = (b) => isFbEvents(b) || isFbMeta(b) || isFbStandings(b);

/** Parse the NDJSON log into structured per-league records. */
function loadCaptures() {
  if (!fs.existsSync(NDJSON)) {
    console.error(`No capture log found at ${NDJSON}`);
    console.error('Run `node intercept-scheduled-virtuals.js` first to capture live data.');
    process.exit(1);
  }
  const lines = fs.readFileSync(NDJSON, 'utf8').trim().split('\n').filter(Boolean);

  // leagueKey (playlistId) -> { standings, scheduled:[], resolved:[] }
  const leagues = {};
  const get = (pid) => (leagues[pid] = leagues[pid] || { standings: {}, scheduled: [], resolved: [] });

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    // logToDisk wraps each frame as { ts, league, matchDay, source, data: <frame> }.
    // Support both the wrapped form and a raw frame.
    const frame = entry?.data?.res ? entry.data : entry;
    const blocks = frame?.res?.body || [];
    for (const b of blocks) {
      if (!isFootballBlock(b)) continue;
      const pid = b.playlistId;
      const L = get(pid);

      if (isFbStandings(b)) Object.assign(L.standings, buildStandings(b));

      if (isFbEvents(b)) {
        const md = b.data?.matchDay ?? entry?.matchDay;
        for (const ev of b.events || []) {
          const rec = { ev, matchDay: md, eBlockId: b.eBlockId, status: b.serverStatus };
          if (b.serverStatus === 'RESOLVED') L.resolved.push(rec);
          else L.scheduled.push(rec);
        }
      }
    }
  }
  return leagues;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const BAR = '═'.repeat(76);
const line = (s = '') => console.log(s);

/* ------------------------------------------------------------------ */
/* LIVE PREDICTION + OVERHEAD ANALYSIS                                 */
/* ------------------------------------------------------------------ */
function livePrediction() {
  const leagues = loadCaptures();
  const allPicks = [];
  line(BAR);
  line('VIRTUAL FOOTBALL — LIVE PREDICTIONS & SLATE ANALYSIS');
  line(`Source: ${NDJSON}`);
  line(BAR);

  let totalScheduled = 0, totalResolved = 0, leaguesSeen = 0;
  let vigSum = 0, vigCount = 0;

  for (const [pid, L] of Object.entries(leagues)) {
    // de-dup scheduled by eventId, keep most recent (latest capture wins)
    const seen = new Set();
    const sched = [];
    for (const rec of [...L.scheduled].reverse()) {
      const id = rec.ev.eventId;
      if (id && seen.has(id)) continue;
      seen.add(id);
      sched.unshift(rec);
    }
    if (!sched.length && !L.resolved.length) continue;
    leaguesSeen++;
    totalScheduled += sched.length;
    totalResolved += L.resolved.length;

    line(`\n┌─ ${leagueName(pid)} (playlist ${pid})`);
    const standingsLine = Object.keys(L.standings).length
      ? `${Object.keys(L.standings).length} teams in table`
      : 'no table captured';
    line(`│  Standings: ${standingsLine}  |  Scheduled: ${sched.length}  |  Resolved: ${L.resolved.length}`);

    // standings snapshot — top 5
    if (Object.keys(L.standings).length) {
      const top = Object.values(L.standings)
        .sort((a, b) => (a.ranking || 999) - (b.ranking || 999))
        .slice(0, 5);
      const sl = top.map((t) => {
        const code = Object.keys(L.standings).find((k) => L.standings[k] === t);
        return `${code}(${t.points}pts, W${t.win}/D${t.draw}/L${t.lost})`;
      }).join('  ');
      line(`│  Top 5: ${sl}`);
    }

    // per-match predictions
    const leaguePicks = [];
    let leagueVigSum = 0;
    for (const rec of sched) {
      const pred = predictMatch(rec.ev, L.standings);
      if (!pred) continue;
      leagueVigSum += pred.overround;
      const flag = pred.standingsAgreement === 'DISAGREE' ? ' ⚠' : '';
      line(`│  ${pred.home.code} vs ${pred.away.code}` +
        `  → ${pred.pickLabel} @ ${pred.odds[pred.pick].toFixed(2)}` +
        `  conf ${pct(pred.adjustedConfidence)} [${pred.tier}]${flag}`);
      line(`│      fair P: 1=${pct(pred.fairProbabilities.home)} X=${pct(pred.fairProbabilities.draw)} 2=${pct(pred.fairProbabilities.away)}` +
        `  | table: ${pred.standingsAgreement}` +
        (pred.ppgGap != null ? ` (PPG Δ${pred.ppgGap >= 0 ? '+' : ''}${pred.ppgGap.toFixed(2)})` : ''));
      leaguePicks.push({ pid, rec, pred });
      allPicks.push({ pid, league: leagueName(pid), rec, pred });
    }
    if (leaguePicks.length) {
      const avgVig = leagueVigSum / leaguePicks.length;
      vigSum += leagueVigSum; vigCount += leaguePicks.length;
      const best = leaguePicks.reduce((a, b) => (b.pred.adjustedConfidence > a.pred.adjustedConfidence ? b : a));
      const tight = leaguePicks.reduce((a, b) => (b.pred.margin < a.pred.margin ? b : a));
      const mism = leaguePicks.reduce((a, b) => (b.pred.odds[b.pred.pick] > a.pred.odds[a.pred.pick] ? b : a));
      line(`│  ─ best pick: ${best.pred.home.code} vs ${best.pred.away.code} → ${best.pred.pickLabel} (${pct(best.pred.adjustedConfidence)})`);
      line(`│  ─ tightest: ${tight.pred.home.code} vs ${tight.pred.away.code} (edge ${pct(tight.pred.margin)})`);
      line(`│  ─ biggest upset-odds: ${mism.pred.home.code} vs ${mism.pred.away.code} → ${mism.pred.pickLabel} @ ${mism.pred.odds[mism.pred.pick].toFixed(2)}`);
      line(`│  ─ avg house vig: ${pct(avgVig - 1)} on 1X2`);
    }
    line(`└──────────────────────────────────────────────────────────────────`);
  }

  // ---- Slate-wide overhead analysis ----
  line('\n' + BAR);
  line('SLATE-WIDE OVERHEAD ANALYSIS');
  line(BAR);
  line(`Leagues: ${leaguesSeen}  |  Scheduled matches: ${totalScheduled}  |  Resolved (logged): ${totalResolved}`);

  if (allPicks.length) {
    const byTier = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const p of allPicks) byTier[p.pred.tier]++;
    line(`Confidence tiers: HIGH ${byTier.HIGH}  MEDIUM ${byTier.MEDIUM}  LOW ${byTier.LOW}`);

    const disagreements = allPicks.filter((p) => p.pred.standingsAgreement === 'DISAGREE');
    line(`Odds-vs-table disagreements (watch list): ${disagreements.length}`);
    for (const d of disagreements.slice(0, 6)) {
      line(`   ⚠ ${d.pred.home.code} vs ${d.pred.away.code} [${d.league}] — odds favor ${d.pred.pickLabel}, table PPG Δ${d.pred.ppgGap >= 0 ? '+' : ''}${d.pred.ppgGap.toFixed(2)}`);
    }

    const avgVig = vigCount ? vigSum / vigCount - 1 : 0;
    line(`Average house edge (1X2 overround): ${pct(avgVig)}  — this is the vig you must beat to profit`);

    line('\nTOP 10 HIGHEST-CONFIDENCE PICKS ACROSS ALL LEAGUES:');
    const ranked = [...allPicks].sort((a, b) => b.pred.adjustedConfidence - a.pred.adjustedConfidence).slice(0, 10);
    ranked.forEach((p, i) => {
      line(`  ${String(i + 1).padStart(2)}. [${p.league}] ${p.pred.home.code} vs ${p.pred.away.code}` +
        ` → ${p.pred.pickLabel} @ ${p.pred.odds[p.pred.pick].toFixed(2)}` +
        `  conf ${pct(p.pred.adjustedConfidence)} [${p.pred.tier}]` +
        (p.pred.standingsAgreement !== 'N/A' ? `  table:${p.pred.standingsAgreement}` : ''));
    });

    line('\nTIGHTEST MATCHES (lowest edge — most unpredictable, avoid for high-conf bets):');
    [...allPicks].sort((a, b) => a.pred.margin - b.pred.margin).slice(0, 5).forEach((p, i) => {
      line(`  ${i + 1}. [${p.league}] ${p.pred.home.code} vs ${p.pred.away.code} — edge ${pct(p.pred.margin)} (${p.pred.pickLabel})`);
    });
  }

  line('\n' + BAR);
  line('NOTE: Confidence = de-vigged probability of the pick (P(prediction correct)).');
  line('Virtual football is RNG + house vig ~' + pct(allPicks.length ? vigSum / vigCount - 1 : 0) +
    '. The model organizes the slate honestly; it cannot beat the vig long-term.');
  line(BAR);
}

/* ------------------------------------------------------------------ */
/* BACKTEST / CALIBRATION                                              */
/* ------------------------------------------------------------------ */
function backtest() {
  const leagues = loadCaptures();
  let n = 0, correct = 0;
  const byTier = {};
  // calibration: for each 0.1 bin, expected vs actual hit rate
  const bins = {};

  for (const L of Object.values(leagues)) {
    for (const rec of L.resolved) {
      const pred = predictMatch(rec.ev, L.standings);
      const actual = matchResult(rec.ev);
      if (!pred || !actual) continue;
      n++;
      const hit = pred.pick === actual ? 1 : 0;
      correct += hit;

      const t = pred.tier;
      byTier[t] = byTier[t] || { n: 0, hits: 0, confSum: 0 };
      byTier[t].n++;
      byTier[t].hits += hit;
      byTier[t].confSum += pred.confidence;

      const bin = Math.floor(pred.confidence * 10) / 10;
      bins[bin] = bins[bin] || { n: 0, hits: 0, confSum: 0 };
      bins[bin].n++;
      bins[bin].hits += hit;
      bins[bin].confSum += pred.confidence;
    }
  }

  line(BAR);
  line('BACKTEST / CALIBRATION REPORT (RESOLVED matches)');
  line(BAR);
  if (!n) {
    line('No RESOLVED matches with odds+result found in the log.');
    line('Run the interceptor longer (a few rounds) to capture resolved matches, then re-run.');
    line(BAR);
    return;
  }

  line(`Sample: ${n} resolved matches`);
  line(`Overall accuracy: ${correct}/${n} = ${pct(correct / n)}`);
  line(`  (naive "always pick favorite" baseline — this IS that, since pick = odds favorite)`);
  line('');

  line('PER-TIER CALIBRATION (is the confidence honest?):');
  line('  tier     n     predicted   actual    gap');
  for (const t of ['HIGH', 'MEDIUM', 'LOW']) {
    const b = byTier[t];
    if (!b) { line(`  ${t.padEnd(8)} 0     -           -         -`); continue; }
    const pred = b.confSum / b.n;
    const act = b.hits / b.n;
    const gap = act - pred;
    line(`  ${t.padEnd(8)} ${String(b.n).padStart(4)}  ${pct(pred).padStart(9)}   ${pct(act).padStart(7)}  ${gap >= 0 ? '+' : ''}${pct(gap).replace('%', '')}%`);
  }

  line('\nPROBABILITY-BIN CALIBRATION (predicted vs actual hit rate):');
  line('  prob bin   n     predicted   actual');
  for (const bin of Object.keys(bins).sort()) {
    const b = bins[bin];
    const pred = b.confSum / b.n;
    const act = b.hits / b.n;
    line(`  ${(Number(bin) * 100).toFixed(0)}-${(Number(bin) * 100 + 10).toFixed(0)}%     ${String(b.n).padStart(4)}  ${pct(pred).padStart(9)}   ${pct(act).padStart(7)}`);
  }
  line('\nInterpretation: if "predicted" ≈ "actual" across bins, the confidence is calibrated');
  line('(a 60% confidence pick really wins ~60% of the time). Large gaps = miscalibration.');

  // outcome distribution
  const dist = { home: 0, draw: 0, away: 0 };
  for (const L of Object.values(leagues)) {
    for (const rec of L.resolved) {
      const a = matchResult(rec.ev);
      if (a) dist[a]++;
    }
  }
  const dn = dist.home + dist.draw + dist.away;
  if (dn) {
    line('\nACTUAL OUTCOME DISTRIBUTION:');
    line(`  Home ${dist.home} (${pct(dist.home / dn)})  Draw ${dist.draw} (${pct(dist.draw / dn)})  Away ${dist.away} (${pct(dist.away / dn)})`);
  }
  line(BAR);
}

const mode = process.argv[2];
if (mode === 'backtest') backtest();
else livePrediction();
