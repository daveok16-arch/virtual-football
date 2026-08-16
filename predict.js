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
  learnCalibration,
  OUTCOMES,
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

/** Build the list of {rec, pred, actual} for every resolved match that has odds+result. */
function resolvedSamples(leagues) {
  const out = [];
  for (const L of Object.values(leagues)) {
    for (const rec of L.resolved) {
      const pred = predictMatch(rec.ev, L.standings);
      const actual = matchResult(rec.ev);
      if (pred && actual) out.push({ rec, pred, actual });
    }
  }
  return out;
}

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

  // ----------------------------------------------------------------
  // EV PROFITABILITY + LEAVE-ONE-OUT CALIBRATION (the productive test)
  // ----------------------------------------------------------------
  // The base model picks argmax(de-vigged prob) and pays the vigged price.
  // We now test whether LEARNING a per-outcome calibration correction from the
  // resolved matches yields any +EV edge, evaluated with leave-one-out
  // cross-validation (LOOCV) so the calibration never sees the match it predicts.
  line('\n' + '─'.repeat(76));
  line('EV / VALUE BET ANALYSIS (LOOCV — calibration never trains on the match it predicts)');
  line('─'.repeat(76));

  const samples = resolvedSamples(leagues);
  if (samples.length < 10) {
    line(`Only ${samples.length} resolved samples — too few for a reliable LOOCV EV test (need >=10).`);
    line('Run the interceptor longer to accumulate resolved matches.');
    line(BAR);
    return;
  }

  // Strategy A — base model: bet the argmax pick at vigged odds.
  // Strategy B — value model: learn calibration on all OTHER matches (LOOCV),
  //              then bet the +EV outcome (highest EV) at vigged odds.
  let aStake = 0, aReturn = 0; // base model: 1 unit staked per bet
  let bStake = 0, bReturn = 0; // value model
  let bBets = 0, bWins = 0;
  const evBuckets = { '<0': { n: 0, stake: 0, ret: 0 }, '0-5%': { n: 0, stake: 0, ret: 0 }, '>5%': { n: 0, stake: 0, ret: 0 } };
  const bPickDist = { home: 0, draw: 0, away: 0 };

  for (let i = 0; i < samples.length; i++) {
    const { rec, actual } = samples[i];
    // A: base pick
    const basePred = samples[i].pred;
    aStake += 1;
    if (basePred.pick === actual) aReturn += basePred.odds[basePred.pick];

    // B: LOOCV calibration trained on all samples EXCEPT i
    const train = samples.filter((_, j) => j !== i);
    const cal = learnCalibration(train.map((s) => ({ pred: s.pred, actual: s.actual })));
    const vpred = predictMatch(rec.ev, {}, cal);
    if (!vpred || vpred.valueEv == null) continue;
    const pick = vpred.valuePick;
    bPickDist[pick]++;
    bBets++;
    bStake += 1;
    if (pick === actual) { bReturn += vpred.odds[pick]; bWins++; }
    // bucket by predicted EV
    const e = vpred.valueEv;
    const bk = e < 0 ? '<0' : e < 0.05 ? '0-5%' : '>5%';
    evBuckets[bk].n++;
    evBuckets[bk].stake += 1;
    if (pick === actual) evBuckets[bk].ret += vpred.odds[pick];
  }

  const aROI = aStake ? (aReturn - aStake) / aStake : 0;
  const bROI = bStake ? (bReturn - bStake) / bStake : 0;
  line(`Strategy A (base, always favorite): ${samples.length} bets, ROI ${(aROI * 100).toFixed(1)}% (stake ${aStake.toFixed(0)}, return ${aReturn.toFixed(1)})`);
  line(`Strategy B (LOOCV value bets):     ${bBets} bets, ROI ${(bROI * 100).toFixed(1)}% (stake ${bStake.toFixed(0)}, return ${bReturn.toFixed(1)}, win ${pct(bBets ? bWins / bBets : 0)})`);
  line(`  value-pick distribution: 1=${bPickDist.home} X=${bPickDist.draw} 2=${bPickDist.away}`);

  line('\n  ROI by predicted-EV bucket (does higher predicted EV actually pay more?):');
  line('  bucket    n     stake   return   ROI');
  for (const bk of ['<0', '0-5%', '>5%']) {
    const b = evBuckets[bk];
    if (!b.n) { line(`  ${bk.padEnd(9)} 0     -       -        -`); continue; }
    const roi = (b.ret - b.stake) / b.stake;
    line(`  ${bk.padEnd(9)} ${String(b.n).padStart(4)}  ${b.stake.toFixed(0).padStart(6)}  ${b.ret.toFixed(1).padStart(7)}  ${(roi * 100).toFixed(1)}%`);
  }
  line('\nInterpretation:');
  line('  - Strategy A ROI is the realistic floor: betting every favorite at vigged odds.');
  line('  - If Strategy B ROI > 0 AND the >5% bucket ROI > 0, the calibration finds real edge.');
  line('  - If Strategy B ≈ Strategy A, the odds are already calibrated and no edge exists.');
  line('  - LOOCV is conservative (small training set per fold); more data can only help B.');
  line(BAR);
}

/* ------------------------------------------------------------------ */
/* VALUE BETS — +EV picks on SCHEDULED matches via learned calibration */
/* ------------------------------------------------------------------ */
function valueBets() {
  const leagues = loadCaptures();
  const samples = resolvedSamples(leagues);

  line(BAR);
  line('VIRTUAL FOOTBALL — VALUE BETS (+EV via learned calibration)');
  line(BAR);

  if (samples.length < 10) {
    line(`Calibration training set: ${samples.length} resolved matches (need >=10 to trust).`);
    line('Too few to learn a reliable correction. Run the interceptor longer, then re-run `node predict.js ev`.');
    line('Falling back: showing base-model favorites only (no EV computed).');
    line(BAR);
    return;
  }

  // Learn calibration from ALL resolved matches (the historical truth), then
  // apply it to SCHEDULED (unresolved) matches to estimate true probabilities
  // and compute EV against the vigged odds.
  const cal = learnCalibration(samples.map((s) => ({ pred: s.pred, actual: s.actual })));
  line(`Calibration trained on ${samples.length} resolved matches.`);
  line('Calibration correction by outcome (de-vigged bin -> actual hit rate):');
  for (const o of OUTCOMES) {
    const bins = Object.keys(cal[o]).map(Number).sort((a, b) => a - b);
    const parts = bins
      .filter((b) => cal[o][b.toFixed(1)].n >= 3)
      .map((b) => `${(b * 100).toFixed(0)}%→${pct(cal[o][b.toFixed(1)].actual).replace('%', '')}%(${cal[o][b.toFixed(1)].n})`);
    line(`  ${o.padEnd(5)} ${parts.join('  ') || '(no bins with >=3 samples)'}`);
  }

  // Build +EV picks across all scheduled matches.
  const picks = [];
  for (const [pid, L] of Object.entries(leagues)) {
    const seen = new Set();
    for (const rec of [...L.scheduled].reverse()) {
      const id = rec.ev.eventId;
      if (id && seen.has(id)) continue;
      seen.add(id);
      const pred = predictMatch(rec.ev, L.standings, cal);
      if (!pred || pred.valueEv == null) continue;
      picks.push({ pid, league: leagueName(pid), rec, pred });
    }
  }

  // Sort by EV descending; the head is the most +EV slate.
  picks.sort((a, b) => b.pred.valueEv - a.pred.valueEv);

  line('');
  line(`SCHEDULED matches scanned: ${picks.length}`);
  const positive = picks.filter((p) => p.pred.valueEv > 0);
  line(`+EV bets found: ${positive.length} (predicted edge > 0%)`);

  if (!positive.length) {
    line('No +EV bets — the learned calibration finds no mispricing at current odds.');
    line('This is the honest answer: either the odds are well-calibrated, or the');
    line('sample is too small for the calibration to detect the edge. See `node predict.js backtest`.');
    line(BAR);
    return;
  }

  line('\nTOP +EV BETS (highest predicted edge first):');
  line('  #  match                  bet   odds   P_cal  EV      vs.favorite');
  positive.slice(0, 20).forEach((p, i) => {
    const pr = p.pred;
    const vsFav = pr.valuePick === pr.pick ? '=' : `${pr.pickLabel.split(' ')[0]}@${pr.odds[pr.pick].toFixed(2)}`;
    line(
      `  ${String(i + 1).padStart(2)}  ${(pr.home.code + ' v ' + pr.away.code).padEnd(23)}` +
      `${pr.valuePickLabel.split(' ')[0].padEnd(5)} ${pr.odds[pr.valuePick].toFixed(2).padEnd(5)} ` +
      `${pct(pr.calibratedProbabilities[pr.valuePick]).padStart(6)} ${(pr.valueEv >= 0 ? '+' : '')}${(pr.valueEv * 100).toFixed(1)}%`.padEnd(12) +
      ` ${vsFav}`
    );
  });

  line('\nNOTE:');
  line(`  - EV = decimal_odds * P_calibrated - 1, using bias-corrected probabilities`);
  line(`    learned from ${samples.length} resolved matches (LOOCV-validated in backtest).`);
  line('  - +EV ≠ guaranteed win; it means the price is favourable vs the calibrated truth.');
  line('  - Virtual football is RNG + house vig; small samples make calibration fragile.');
  line('  - Always cross-check with `node predict.js backtest` Strategy B ROI before staking.');
  line(BAR);
}

const mode = process.argv[2];
if (mode === 'backtest') backtest();
else if (mode === 'ev') valueBets();
else livePrediction();
