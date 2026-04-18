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

      return {
        key: s.key,
        data: {
          pitcher: s.pitcher,
          pitcherArsenal: arsenal,
          mismatches: tiered
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
