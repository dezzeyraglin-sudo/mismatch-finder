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

        return {
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
