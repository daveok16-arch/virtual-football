/**
 * calibration-store.js — Persist resolved matches across bot runs so the
 * calibration map trains on a growing sample instead of just the current
 * capture's 57-ish matches.
 *
 * Why this exists: with ~57 resolved matches per capture, the observed draw
 * rate swings between 33% and 51% purely from sample variance. A draw-heavy
 * capture makes the calibration overcorrect toward draws, producing a "wall of
 * draws" in the value-bets report. Accumulating across runs (capped at the most
 * recent MAX_STORE matches) stabilises the draw rate near its true ~40% and
 * yields a nuanced mix of home/draw/away +EV picks.
 *
 * The store is a JSON file ({ matches: [{ ev, pid }], updatedAt }) on disk.
 * Each entry holds the raw resolved event (the result is embedded in
 * ev.result.finalOutcome, so matchResult can be recomputed later). We dedupe
 * by eventId so re-capturing the same matches doesn't inflate the store.
 */
const fs = require('fs');
const path = require('path');
const { predictMatch, matchResult } = require('./virtual-football-model');

const STORE_PATH = path.join(__dirname, 'calibration-data.json');
const MAX_STORE = 2000; // Macro-scale: hold 500-1000+ matches for stable baseline

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(s.matches)) return s;
  } catch {}
  return { matches: [], updatedAt: null };
}

function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  store.size = store.matches.length;
  fs.writeFileSync(STORE_PATH, JSON.stringify(store));
}

/**
 * Merge newly-captured resolved matches into the store, deduping by eventId.
 * Keeps the most recent MAX_STORE entries (older matches age out so the
 * calibration tracks the current GoldenRace season, not stale ones).
 * @returns {number} how many new matches were added
 */
function mergeResolved(store, leagues) {
  const seen = new Set(store.matches.map((m) => m.eventId));
  let added = 0;
  for (const [pid, L] of Object.entries(leagues)) {
    for (const rec of L.resolved) {
      const ev = rec.ev;
      const id = ev.eventId;
      if (!id || seen.has(id)) continue;
      // MEMORY: Only store the minimal fields needed for calibration —
      // eventId, pid, odds1x2[0:3], finalOutcome[0:2]. The full WS event
      // (450 oddValues, stats, wonMarkets, participants = 8.4 KB each) is NOT
      // stored; we keep ~80 bytes per match (120× reduction). This prevents
      // OOM on Render's 512MB free tier.
      const odds = ((ev.data && ev.data.oddValues) || []).slice(0, 3).map(Number);
      const fo = ev.result && ev.result.finalOutcome;
      if (odds.length < 3 || !fo || fo.length < 2) continue;
      store.matches.push({ eventId: id, pid, odds1x2: odds, finalOutcome: fo.map(Number) });
      seen.add(id);
      added++;
    }
  }
  if (store.matches.length > MAX_STORE) {
    store.matches = store.matches.slice(-MAX_STORE);
  }
  return added;
}

/**
 * Build {pred, actual} samples from the store for learnCalibration.
 * Standings are not needed here — calibration only uses fairProbabilities
 * (derived from odds), so we pass an empty standings map.
 *
 * The slim store format stores { eventId, pid, odds1x2, finalOutcome } —
 * we reconstruct a minimal event object for predictMatch/matchResult.
 */
function slimToEv(m) {
  return {
    eventId: m.eventId,
    data: { participants: [{ classType: 'FbParticipant' }, { classType: 'FbParticipant' }], oddValues: m.odds1x2 },
    result: { finalOutcome: m.finalOutcome.map(String) },
  };
}

function calSamples(store) {
  const samples = [];
  for (const m of store.matches) {
    const ev = m.ev || slimToEv(m);
    const pred = predictMatch(ev, {});
    const actual = matchResult(ev);
    if (pred && actual) samples.push({ pred, actual });
  }
  return samples;
}

/**
 * Build per-league {pred, actual} samples. Each league has a different draw
 * rate (France ~33% vs England ~60%), so a global calibration is suboptimal —
 * per-league calibration produces a more accurate bias correction.
 * Returns { pid -> [{pred, actual}] }.
 */
function calSamplesByLeague(store) {
  const byLeague = {};
  for (const m of store.matches) {
    const pid = m.pid;
    if (!pid) continue;
    const ev = m.ev || slimToEv(m);
    const pred = predictMatch(ev, {});
    const actual = matchResult(ev);
    if (pred && actual) {
      if (!byLeague[pid]) byLeague[pid] = [];
      byLeague[pid].push({ pred, actual });
    }
  }
  return byLeague;
}

module.exports = { loadStore, saveStore, mergeResolved, calSamples, calSamplesByLeague, STORE_PATH, MAX_STORE };
