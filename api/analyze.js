// api/analyze.js
// Core mismatch engine with park + umpire context.
// Calls helper functions DIRECTLY (no HTTP) to avoid Vercel cold-start 404 issues.

import { PARK_FACTORS_BY_TEAM } from './_data/parkFactors.js';
import { UMPIRE_FACTORS, classifyUmp } from './_data/umpireFactors.js';
import { getProbables, getPitcherArsenal, getLineup, getHitterStats } from './_lib/data.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk } = req.query;
  if (!gamePk) return res.status(400).json({ error: 'gamePk required' });

  const season = new Date().getFullYear();

  try {
    // 1. Get today's slate & find the game
    // Use ET date since MLB schedules by ET - UTC midnight is already tomorrow for night games
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const sched = await getProbables(today);
    let game = (sched.games || []).find(g => String(g.gamePk) === String(gamePk));

    // If not found on ET-today, try yesterday and tomorrow (covers edge cases)
    if (!game) {
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const d of [yesterday, tomorrow]) {
        const s = await getProbables(d).catch(() => ({ games: [] }));
        const g = (s.games || []).find(g => String(g.gamePk) === String(gamePk));
        if (g) { game = g; break; }
      }
    }

    if (!game) {
      return res.status(404).json({ error: 'Game not found on schedule (tried today +/- 1 day ET)' });
    }

    // 2. Park factor
    let parkFactor = null;
    if (game.homeTeam?.abbreviation) {
      const key = game.homeTeam.abbreviation.toUpperCase();
      if (PARK_FACTORS_BY_TEAM[key]) {
        parkFactor = { ...PARK_FACTORS_BY_TEAM[key], team: key };
      }
    }

    // 3. Umpire (parallel with everything else)
    const umpPromise = fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    const results = {
      gamePk,
      awayTeam: game.awayTeam,
      homeTeam: game.homeTeam,
      venue: game.venue,
      gameTime: game.gameTime,
      park: parkFactor,
      umpire: null,
      awayVsHome: null,
      homeVsAway: null
    };

    // Resolve umpire
    const liveFeed = await umpPromise;
    if (liveFeed) {
      const officials = liveFeed?.gameData?.officials || [];
      const hp = officials.find(o => o.officialType === 'Home Plate' || o.officialType === 'Home');
      if (hp) {
        const umpName = hp.official?.fullName || '';
        const factors = UMPIRE_FACTORS[umpName] || null;
        const classification = classifyUmp(factors);
        results.umpire = {
          assigned: true,
          name: umpName,
          factors: factors || { k: 1.00, bb: 1.00, runs: 1.00, notes: 'No historical data' },
          ...classification
        };
      } else {
        results.umpire = { assigned: false, message: 'Not yet posted (~1-3hr before first pitch)' };
      }
    }

    const sides = [
      { hitTeamId: game.awayTeam.id, pitcher: game.homePitcher, key: 'awayVsHome', side: 'away' },
      { hitTeamId: game.homeTeam.id, pitcher: game.awayPitcher, key: 'homeVsAway', side: 'home' }
    ];

    // Process both sides in parallel using helpers directly (no HTTP)
    const sideResults = await Promise.all(sides.map(async s => {
      if (!s.pitcher || !s.hitTeamId) return null;

      const [arsenal, lineup] = await Promise.all([
        getPitcherArsenal(s.pitcher.id, season).catch(() => []),
        getLineup(s.hitTeamId, gamePk, s.side).catch(() => [])
      ]);

      const keyPitches = arsenal.slice(0, 3);
      const topHitters = lineup.slice(0, 9);

      // Fetch hitter stats in parallel
      const hitterData = await Promise.all(topHitters.map(async h => {
        try {
          const stats = await getHitterStats(h.id, season);
          return { ...h, stats };
        } catch {
          return { ...h, stats: { overall: {}, pitchTypes: [] } };
        }
      }));

      const analyzed = hitterData.map(h => {
        const pitchTypes = h.stats?.pitchTypes || [];
        const overall = h.stats?.overall || {};

        const matchedPitches = [];
        let maxXwoba = 0;
        let edgeScore = 0;

        for (const kp of keyPitches) {
          const kpLower = (kp.type || '').toLowerCase();
          const hitterPerf = pitchTypes.find(pt => {
            const ptLower = (pt.type || '').toLowerCase();
            return ptLower === kpLower ||
                   ptLower.includes(kpLower) ||
                   kpLower.includes(ptLower) ||
                   (kpLower.includes('4-seam') && ptLower.includes('four-seam')) ||
                   (kpLower.includes('four-seam') && ptLower.includes('4-seam'));
          });

          if (hitterPerf && hitterPerf.xwoba) {
            const xw = parseFloat(hitterPerf.xwoba);
            matchedPitches.push({
              pitch: kp.type,
              pitcherUsage: kp.usage,
              hitterXwoba: hitterPerf.xwoba,
              hitterXslg: hitterPerf.xslg
            });
            if (xw > maxXwoba) maxXwoba = xw;
            const usageWeight = parseFloat(kp.usage || 10) / 100;
            edgeScore += xw * usageWeight;
          }
        }

        // Park + umpire adjustments
        const adjustments = [];
        let contextMultiplier = 1.0;

        if (parkFactor) {
          const barrelPct = parseFloat(overall.barrel_batted_rate?.value || 0);
          const useHrFactor = barrelPct >= 10;
          const pfVal = useHrFactor
            ? (h.hand === 'L' ? parkFactor.lhbHr : parkFactor.rhbHr)
            : parkFactor.runs;
          const pfMult = pfVal / 100;
          contextMultiplier *= pfMult;
          if (Math.abs(pfMult - 1.0) >= 0.04) {
            adjustments.push({
              type: 'park',
              label: `${parkFactor.name} ${useHrFactor?'HR':'Run'} PF ${pfVal > 100 ? '+' : ''}${(pfVal-100)}`,
              multiplier: pfMult.toFixed(3),
              favor: pfMult > 1 ? 'hitter' : 'pitcher'
            });
          }
        }

        if (results.umpire?.assigned && results.umpire.factors) {
          const umpRunsMult = results.umpire.factors.runs || 1.0;
          contextMultiplier *= umpRunsMult;
          if (Math.abs(umpRunsMult - 1.0) >= 0.02) {
            adjustments.push({
              type: 'umpire',
              label: `${results.umpire.name} ${umpRunsMult > 1 ? '+' : ''}${((umpRunsMult-1)*100).toFixed(0)}% runs`,
              multiplier: umpRunsMult.toFixed(3),
              favor: umpRunsMult > 1 ? 'hitter' : 'pitcher'
            });
          }
        }

        const adjustedMaxXwoba = maxXwoba * contextMultiplier;
        const adjustedEdge = edgeScore * contextMultiplier;

        let tier = null;
        if (adjustedMaxXwoba >= 0.420) tier = 'elite';
        else if (adjustedMaxXwoba >= 0.370) tier = 'strong';
        else if (adjustedMaxXwoba >= 0.330) tier = 'solid';

        // Build plain-language edge description
        const description = buildEdgeDescription({
          hitter: h,
          matchedPitches,
          maxXwoba,
          overall,
          adjustments,
          parkFactor,
          tier
        });

        // Build ranked prop recommendations
        const propRecs = buildPropRecommendations({
          hitter: h,
          matchedPitches,
          maxXwoba,
          overall,
          parkFactor,
          adjustments,
          tier
        });

        return {
          hitterId: h.id,
          hitter: h.name,
          hand: h.hand,
          position: h.position,
          matchedPitches,
          maxXwoba: maxXwoba.toFixed(3),
          adjustedMaxXwoba: adjustedMaxXwoba.toFixed(3),
          edgeScore: edgeScore.toFixed(3),
          adjustedEdgeScore: adjustedEdge.toFixed(3),
          contextMultiplier: contextMultiplier.toFixed(3),
          adjustments,
          tier,
          description,
          propRecs,
          seasonStats: {
            xwoba: overall.xwoba?.value || null,
            barrelPct: overall.barrel_batted_rate?.value || null,
            hardHitPct: overall.hard_hit_percent?.value || null,
            avgEV: overall.avg_exit_velocity?.value || null,
            kPct: overall.k_percent?.value || null
          }
        };
      });

      const tiered = analyzed
        .filter(h => h.tier)
        .sort((a, b) => parseFloat(b.adjustedEdgeScore) - parseFloat(a.adjustedEdgeScore));

      // Aggregate pitcher-vs-lineup tier
      const lineupTier = computeLineupTier(analyzed, arsenal);

      return {
        key: s.key,
        data: {
          pitcher: s.pitcher,
          pitcherArsenal: arsenal,
          mismatches: tiered,
          lineupTier
        }
      };
    }));

    sideResults.forEach(r => { if (r) results[r.key] = r.data; });

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json(results);
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

// ===== EDGE DESCRIPTION GENERATOR =====
// Builds a plain-language explanation of WHY a hitter has an edge in this matchup
function buildEdgeDescription({ hitter, matchedPitches, maxXwoba, overall, adjustments, parkFactor, tier }) {
  if (!tier || matchedPitches.length === 0) return null;

  const parts = [];

  // Primary reason: the best pitch-type mismatch
  const best = matchedPitches.reduce((a, b) =>
    parseFloat(a.hitterXwoba) > parseFloat(b.hitterXwoba) ? a : b
  );
  const bestXwoba = parseFloat(best.hitterXwoba);

  // Craft the hook based on xwOBA severity
  let verb;
  if (bestXwoba >= 0.500) verb = 'demolishes';
  else if (bestXwoba >= 0.420) verb = 'crushes';
  else if (bestXwoba >= 0.370) verb = 'handles';
  else verb = 'does well vs';

  parts.push(`${verb} the ${best.pitch.toLowerCase()} (${bestXwoba.toFixed(3)} xwOBA)`);

  // Usage context — if the pitcher throws it a lot, the edge is bigger
  const usage = parseFloat(best.pitcherUsage || 0);
  if (usage >= 35) {
    parts[0] += `, and the pitcher leans on it heavily (${usage.toFixed(0)}% usage)`;
  } else if (usage >= 20) {
    parts[0] += ` (${usage.toFixed(0)}% usage)`;
  }

  // Secondary pitch crushed?
  const others = matchedPitches
    .filter(m => m !== best && parseFloat(m.hitterXwoba) >= 0.370)
    .sort((a, b) => parseFloat(b.hitterXwoba) - parseFloat(a.hitterXwoba));
  if (others.length > 0) {
    parts.push(`Also strong vs the ${others[0].pitch.toLowerCase()} (${others[0].hitterXwoba})`);
  }

  // Power profile
  const barrel = parseFloat(overall.barrel_batted_rate?.value || 0);
  const hardHit = parseFloat(overall.hard_hit_percent?.value || 0);
  const ev = parseFloat(overall.avg_exit_velocity?.value || 0);
  const powerSignals = [];
  if (barrel >= 12) powerSignals.push(`${barrel.toFixed(1)}% barrel`);
  if (hardHit >= 45) powerSignals.push(`${hardHit.toFixed(0)}% hard-hit`);
  if (ev >= 91) powerSignals.push(`${ev.toFixed(1)} EV`);
  if (powerSignals.length >= 2) {
    parts.push(`Elite contact quality (${powerSignals.join(', ')})`);
  } else if (powerSignals.length === 1) {
    parts.push(powerSignals[0]);
  }

  // Context adjustments
  const hitterAdjustments = adjustments.filter(a => a.favor === 'hitter');
  if (hitterAdjustments.length > 0) {
    const parkAdj = hitterAdjustments.find(a => a.type === 'park');
    const umpAdj = hitterAdjustments.find(a => a.type === 'umpire');
    const ctxBits = [];
    if (parkAdj && parkFactor) {
      ctxBits.push(`${parkFactor.name} boost`);
    }
    if (umpAdj) {
      ctxBits.push('hitter-friendly ump');
    }
    if (ctxBits.length > 0) {
      parts.push(`Boosted by ${ctxBits.join(' + ')}`);
    }
  }

  const pitcherAdjustments = adjustments.filter(a => a.favor === 'pitcher');
  if (pitcherAdjustments.length > 0 && hitterAdjustments.length === 0) {
    // Only mention headwinds if nothing helped
    const badParkAdj = pitcherAdjustments.find(a => a.type === 'park');
    if (badParkAdj && parkFactor) {
      parts.push(`(${parkFactor.name} suppresses offense — still clears tier)`);
    }
  }

  // Join as sentences
  return parts.join('. ') + '.';
}

// ===== PITCHER-VS-LINEUP TIER =====
// Aggregates mismatch data across the full lineup to score how exploitable the pitcher is overall
function computeLineupTier(analyzedHitters, arsenal) {
  const total = analyzedHitters.length;
  if (total === 0) {
    return {
      tier: 'unknown',
      label: 'No lineup data',
      eliteCount: 0,
      strongCount: 0,
      solidCount: 0,
      tieredCount: 0,
      lineupSize: 0,
      avgMaxXwoba: null,
      summary: 'Lineup unavailable'
    };
  }

  const eliteCount = analyzedHitters.filter(h => h.tier === 'elite').length;
  const strongCount = analyzedHitters.filter(h => h.tier === 'strong').length;
  const solidCount = analyzedHitters.filter(h => h.tier === 'solid').length;
  const tieredCount = eliteCount + strongCount + solidCount;

  // Average adjusted max xwOBA across whole lineup (not just tiered)
  const xwobas = analyzedHitters
    .map(h => parseFloat(h.adjustedMaxXwoba))
    .filter(x => !isNaN(x) && x > 0);
  const avgMaxXwoba = xwobas.length > 0
    ? (xwobas.reduce((a, b) => a + b, 0) / xwobas.length)
    : 0;

  // Weighted score: elite counts 3x, strong 2x, solid 1x
  // Plus bonus for high average xwOBA across whole lineup
  const weightedScore = (eliteCount * 3) + (strongCount * 2) + (solidCount * 1);
  const avgBonus = avgMaxXwoba >= 0.370 ? 3 : avgMaxXwoba >= 0.330 ? 2 : avgMaxXwoba >= 0.300 ? 1 : 0;
  const totalScore = weightedScore + avgBonus;

  // Tier assignment
  let tier, label, summary;
  if (eliteCount >= 2 || totalScore >= 10) {
    tier = 'exploitable';
    label = 'EXPLOITABLE';
    summary = `Lineup can stack against this arsenal (${eliteCount} elite, ${strongCount} strong, ${solidCount} solid across ${total} hitters)`;
  } else if (eliteCount >= 1 || totalScore >= 6) {
    tier = 'leaky';
    label = 'LEAKY';
    summary = `Multiple hitters have edges (${tieredCount}/${total} tiered, avg xwOBA ${avgMaxXwoba.toFixed(3)})`;
  } else if (tieredCount >= 2 || totalScore >= 3) {
    tier = 'spot';
    label = 'SPOT START';
    summary = `A couple of hitters can do damage, but arsenal mostly holds up`;
  } else if (arsenal.length === 0) {
    tier = 'unknown';
    label = 'NO DATA';
    summary = 'Pitcher arsenal not available yet (early season / low sample)';
  } else {
    tier = 'tough';
    label = 'TOUGH MATCHUP';
    summary = `Arsenal suppresses this lineup (${tieredCount}/${total} with any edge, avg xwOBA ${avgMaxXwoba.toFixed(3)})`;
  }

  return {
    tier,
    label,
    eliteCount,
    strongCount,
    solidCount,
    tieredCount,
    lineupSize: total,
    avgMaxXwoba: avgMaxXwoba.toFixed(3),
    totalScore,
    summary
  };
}

// ===== PROP RECOMMENDATIONS =====
// Ranks prop types by edge quality for this specific matchup
function buildPropRecommendations({ hitter, matchedPitches, maxXwoba, overall, parkFactor, adjustments, tier }) {
  if (!tier || matchedPitches.length === 0) return [];

  const barrel = parseFloat(overall.barrel_batted_rate?.value || 0);
  const hardHit = parseFloat(overall.hard_hit_percent?.value || 0);
  const ev = parseFloat(overall.avg_exit_velocity?.value || 0);
  const kPct = parseFloat(overall.k_percent?.value || 22); // default to league avg if missing
  const seasonXwoba = parseFloat(overall.xwoba?.value || 0);

  // Compute max xSLG from matched pitches (power indicator)
  const maxXslg = matchedPitches.reduce((max, mp) => {
    const x = parseFloat(mp.hitterXslg || 0);
    return x > max ? x : max;
  }, 0);

  // Park factor helpers
  const hrParkBoost = parkFactor
    ? (hitter.hand === 'L' ? (parkFactor.lhbHr || 100) : (parkFactor.rhbHr || 100)) / 100
    : 1.0;
  const runParkBoost = parkFactor ? (parkFactor.runs || 100) / 100 : 1.0;

  // Is there an umpire adjustment favoring hitter?
  const hitterFriendlyUmp = adjustments.some(a => a.type === 'umpire' && a.favor === 'hitter');

  // ---- Score each prop type ----
  // Scoring scale 0-100. Higher = stronger play.

  // HIT prop — hitter gets at least 1 hit
  // Good when: high xwOBA vs arsenal, low K% against, contact profile
  let hitScore = 0;
  hitScore += maxXwoba * 100;                         // base: pitch matchup quality
  hitScore += (seasonXwoba * 50);                     // overall contact
  hitScore += (hardHit / 2);                          // contact quality helps
  hitScore -= Math.max(0, (kPct - 20)) * 1.2;         // strikeout risk penalty
  hitScore += runParkBoost > 1.03 ? 8 : 0;            // offensive park bonus
  hitScore += hitterFriendlyUmp ? 4 : 0;

  // HR prop — hitter hits a homer
  // Good when: high barrel%, high EV, hot HR park factor for handedness, strong xSLG vs arsenal
  let hrScore = 0;
  if (barrel >= 8) hrScore += barrel * 2;             // barrel% is the strongest HR signal
  if (ev >= 90) hrScore += (ev - 88) * 3;
  hrScore += maxXslg * 60;                            // power vs arsenal
  if (hrParkBoost >= 1.05) hrScore += (hrParkBoost - 1) * 80;  // big park boost
  if (hrParkBoost <= 0.92) hrScore -= (1 - hrParkBoost) * 60;  // HR suppressor park penalty
  hrScore -= Math.max(0, (kPct - 25)) * 0.6;

  // TB prop — 2+ total bases (extra-base hit or 2+ singles)
  // Good when: high xSLG, barrel%, power park, but also decent contact
  let tbScore = 0;
  tbScore += maxXslg * 80;
  tbScore += barrel * 1.3;
  tbScore += maxXwoba * 40;
  tbScore += hardHit / 3;
  if (hrParkBoost >= 1.05) tbScore += (hrParkBoost - 1) * 40;
  tbScore -= Math.max(0, (kPct - 22)) * 0.8;

  // RBI prop — drives in a run
  // Good when: overall mismatch quality + park runs + reasonable power
  let rbiScore = 0;
  rbiScore += maxXwoba * 90;
  rbiScore += barrel * 0.8;
  rbiScore += maxXslg * 25;
  rbiScore += runParkBoost > 1.03 ? 10 : 0;
  rbiScore += hitterFriendlyUmp ? 5 : 0;
  rbiScore -= Math.max(0, (kPct - 22)) * 0.6;

  // R prop — scores a run
  // Mostly about getting on base + lineup environment
  let rScore = 0;
  rScore += maxXwoba * 80;
  rScore += (seasonXwoba * 40);
  rScore += runParkBoost > 1.03 ? 8 : 0;
  rScore -= Math.max(0, (kPct - 22)) * 0.9;

  // HRR (H+R+RBI 1.5 — standard PP line, needs 2+ combined)
  const hrr = Math.max(hitScore * 0.9, rbiScore * 0.85, rScore * 0.85) + 8;

  // Fantasy score projection - estimate points from signals
  // Rough heuristic: expected PA ~4, weight by contact & power profile
  const estSingles = maxXwoba * 1.2;       // ~xwOBA converted to contact rate
  const estXBH = maxXslg * 0.6;            // extra-base hits
  const estHR = (barrel / 100) * 0.4;      // barrel-based HR rate per PA
  const estR = maxXwoba * 0.8 * runParkBoost;
  const estRBI = maxXwoba * 0.9 * runParkBoost;
  const estBB = Math.max(0, (parseFloat(overall.bb_percent?.value || 8) / 100)) * 4;
  const projFS = (estSingles * 3) + (estXBH * 6) + (estHR * 10) + (estR * 2) + (estRBI * 2) + (estBB * 2);

  // PP/UD Fantasy Score props - score based on how comfortably we clear the line
  const fs_pp6 = (projFS - 6) * 12 + 40;    // cleared 6 line
  const fs_pp8 = (projFS - 8) * 12 + 30;    // cleared 8 line (harder)
  const fs_ud5 = (projFS - 5) * 12 + 42;    // UD 5 line (easier)
  const fs_ud7 = (projFS - 7) * 12 + 32;    // UD 7 line

  const allProps = [
    { key: 'H',        label: 'HITS 0.5',       platform: 'BOTH', score: hitScore,   reason: hitReason(maxXwoba, kPct, hardHit, runParkBoost) },
    { key: 'HR',       label: 'HR 0.5',         platform: 'BOTH', score: hrScore,    reason: hrReason(barrel, ev, maxXslg, hrParkBoost, hitter.hand, parkFactor) },
    { key: 'TB',       label: 'TB 1.5',         platform: 'BOTH', score: tbScore,    reason: tbReason(maxXslg, barrel, hrParkBoost) },
    { key: 'RBI',      label: 'RBI 0.5',        platform: 'BOTH', score: rbiScore,   reason: rbiReason(maxXwoba, barrel, runParkBoost) },
    { key: 'R',        label: 'RUNS 0.5',       platform: 'BOTH', score: rScore,     reason: rReason(maxXwoba, kPct, runParkBoost) },
    { key: 'HRR',      label: 'H+R+RBI 1.5',    platform: 'PP',   score: hrr,        reason: 'Multiple pathways to the over (PrizePicks)' },
    { key: 'PP_FS_6',  label: 'PP FS 6',        platform: 'PP',   score: fs_pp6,     reason: `Projected ~${projFS.toFixed(1)} pts (need 6+)` },
    { key: 'PP_FS_8',  label: 'PP FS 8',        platform: 'PP',   score: fs_pp8,     reason: `Projected ~${projFS.toFixed(1)} pts (need 8+)` },
    { key: 'UD_FS_5',  label: 'UD FS 5',        platform: 'UD',   score: fs_ud5,     reason: `Projected ~${projFS.toFixed(1)} pts (need 5+)` },
    { key: 'UD_FS_7',  label: 'UD FS 7',        platform: 'UD',   score: fs_ud7,     reason: `Projected ~${projFS.toFixed(1)} pts (need 7+)` }
  ];

  // Sort by score, take top 4
  allProps.sort((a, b) => b.score - a.score);
  const ranked = allProps.slice(0, 4);

  // Tag the first as best bet
  ranked.forEach((p, i) => { p.rank = i; p.isBest = i === 0; });

  return ranked;
}

function hitReason(maxXwoba, kPct, hardHit, parkBoost) {
  const bits = [];
  if (maxXwoba >= 0.420) bits.push('elite pitch-type edge');
  else if (maxXwoba >= 0.370) bits.push('strong pitch-type edge');
  if (hardHit >= 45) bits.push('high hard-hit rate');
  if (kPct <= 18) bits.push('rarely strikes out');
  if (parkBoost > 1.05) bits.push('offensive park');
  return bits.length ? bits.join(', ') : 'Contact profile is solid';
}

function hrReason(barrel, ev, xslg, parkBoost, hand, park) {
  const bits = [];
  if (barrel >= 12) bits.push(`${barrel.toFixed(1)}% barrel rate`);
  if (ev >= 92) bits.push(`${ev.toFixed(1)} mph EV`);
  if (xslg >= 0.500) bits.push(`${xslg.toFixed(3)} xSLG vs arsenal`);
  if (parkBoost >= 1.08) bits.push(`${park?.name || 'park'} big HR boost for ${hand}HB`);
  return bits.length ? bits.join(', ') : 'Modest HR signals';
}

function tbReason(xslg, barrel, parkBoost) {
  const bits = [];
  if (xslg >= 0.500) bits.push(`${xslg.toFixed(3)} xSLG vs arsenal`);
  if (barrel >= 10) bits.push(`${barrel.toFixed(1)}% barrel`);
  if (parkBoost >= 1.05) bits.push('power park');
  return bits.length ? bits.join(', ') : 'Moderate extra-base upside';
}

function rbiReason(xwoba, barrel, parkBoost) {
  const bits = [];
  if (xwoba >= 0.400) bits.push('elite matchup');
  if (barrel >= 10) bits.push(`${barrel.toFixed(1)}% barrel`);
  if (parkBoost > 1.03) bits.push('run-friendly park');
  return bits.length ? bits.join(', ') : 'Middle-of-order opportunity';
}

function rReason(xwoba, kPct, parkBoost) {
  const bits = [];
  if (xwoba >= 0.400) bits.push('gets on base vs this arsenal');
  if (kPct <= 18) bits.push('puts ball in play');
  if (parkBoost > 1.03) bits.push('run-friendly park');
  return bits.length ? bits.join(', ') : 'Decent OBP profile';
}
