// api/_lib/conversionRate.js
// Team-level "Runners In Scoring Position" (RISP) and "Left In Scoring Position" (LISP)
// metrics. These signal how efficiently a team converts scoring opportunities into runs.
//
// The intuition: two lineups can have identical raw quality (xwOBA, OPS, etc.) but
// different conversion profiles. Team A might consistently leave runners stranded on 2nd
// (poor situational hitting, weak bottom of order, manager pinch-hits the wrong way).
// Team B might convert at a league-leading rate. Over a season this becomes a stable signal
// — typically worth ±0.3 runs per game in projected total.
//
// Sources:
//   - statsapi.mlb.com/api/v1/teams/{teamId}/stats?stats=season&group=hitting
//     Returns regular season totals including RISP-context stats
//   - The "leftOnBase" field at team level is the season cumulative LOB
//
// Output: { rispAvg, lispRate, conversionMult, sampleSize }
//
// conversionMult is 1.0 for league average, <1.0 for poor converters, >1.0 for efficient.
// Capped at ±8% to prevent overfitting on small samples or fluky early-season data.

const SEASON = new Date().getFullYear();
const LEAGUE_AVG_RISP_AVG = 0.252;       // MLB 2024-2025 typical RISP batting average
const LEAGUE_AVG_LISP_PER_GAME = 7.1;    // Roughly 7 LOB per team per game league-wide

// In-memory cache — team conversion stats change slowly (every game), no need to refetch
// on every analyze call. 1-hour TTL is appropriate.
const _cache = new Map();
const TTL_MS = 60 * 60 * 1000;

function cacheKey(teamId) { return `${teamId}-${SEASON}`; }

/**
 * Fetch and compute conversion-rate metrics for a single team.
 * Returns null if data is unavailable (early season, API failure, etc.).
 */
export async function getTeamConversionRate(teamId) {
  if (!teamId) return null;
  const k = cacheKey(teamId);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.data;

  try {
    // Fetch season hitting stats for the team
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${SEASON}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const json = await res.json();

    // Stats path: stats[0].splits[0].stat
    const stat = json?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;

    const games = parseInt(stat.gamesPlayed) || 0;
    const ab = parseInt(stat.atBats) || 0;
    const lob = parseInt(stat.leftOnBase) || 0;

    // Need a meaningful sample — at least 10 games before signal is trustworthy
    if (games < 10) {
      const data = {
        rispAvg: null,
        lispRate: null,
        lispPerGame: null,
        conversionMult: 1.0,
        sampleSize: games,
        signal: 'insufficient',
        detail: `Only ${games} games played — using league avg`,
      };
      _cache.set(k, { data, fetchedAt: Date.now() });
      return data;
    }

    // Compute LISP rate (how often a team strands runners per game)
    const lispPerGame = lob / Math.max(1, games);

    // Try to extract RISP-specific batting average
    // The MLB API may expose this as runnersInScoringPositionAverage or similar
    // If not directly available, fall back to using LISP-per-game as the signal
    let rispAvg = null;
    if (stat.runnersInScoringPositionAverage != null) {
      rispAvg = parseFloat(stat.runnersInScoringPositionAverage);
    } else if (stat.batting?.rispAvg != null) {
      rispAvg = parseFloat(stat.batting.rispAvg);
    }

    // Build the conversion multiplier
    // Two signals blended: LISP rate (lower = better) and RISP avg (higher = better)
    let lispDeviation = 0;       // 0 = league avg, negative = team strands MORE (worse), positive = strands LESS (better)
    let rispDeviation = 0;       // 0 = league avg, positive = better RISP performance

    // LISP signal: how many MORE/FEWER runners stranded than league avg
    // 1 LOB per game above avg corresponds to roughly -0.20 runs per game expected
    lispDeviation = (LEAGUE_AVG_LISP_PER_GAME - lispPerGame) / LEAGUE_AVG_LISP_PER_GAME;

    // RISP signal: deviation from .252 league avg
    // .280 RISP avg = strongly converts; .220 = poor converter
    if (rispAvg != null && !isNaN(rispAvg)) {
      rispDeviation = (rispAvg - LEAGUE_AVG_RISP_AVG) / LEAGUE_AVG_RISP_AVG;
    }

    // Combine signals: LISP weighted 60%, RISP 40% (LISP is the more reliable team-level signal)
    // The combined deviation scaled by 0.10 gives roughly ±8% multiplier max
    const combinedDev = (lispDeviation * 0.60) + (rispDeviation * 0.40);
    const rawMult = 1.0 + (combinedDev * 0.10);

    // Cap the multiplier to ±8% so even extreme outliers don't dominate the projection
    const conversionMult = Math.max(0.92, Math.min(1.08, rawMult));

    let signal = 'neutral';
    if (conversionMult >= 1.04) signal = 'efficient';
    else if (conversionMult >= 1.015) signal = 'slight-edge';
    else if (conversionMult <= 0.96) signal = 'stranded';
    else if (conversionMult <= 0.985) signal = 'slight-drag';

    const data = {
      rispAvg: rispAvg != null ? parseFloat(rispAvg.toFixed(3)) : null,
      lispPerGame: parseFloat(lispPerGame.toFixed(2)),
      lispRate: lispPerGame > 0 ? parseFloat((lispPerGame / Math.max(1, ab / games)).toFixed(3)) : null,
      conversionMult: parseFloat(conversionMult.toFixed(3)),
      sampleSize: games,
      signal,
      detail: signal === 'efficient'
        ? `Converts well: ${lispPerGame.toFixed(1)} LOB/game (vs ${LEAGUE_AVG_LISP_PER_GAME} avg)`
        : signal === 'stranded'
        ? `Strands runners: ${lispPerGame.toFixed(1)} LOB/game (vs ${LEAGUE_AVG_LISP_PER_GAME} avg)`
        : signal === 'slight-edge'
        ? `Slight conversion edge: ${lispPerGame.toFixed(1)} LOB/game`
        : signal === 'slight-drag'
        ? `Slight conversion drag: ${lispPerGame.toFixed(1)} LOB/game`
        : `Average conversion: ${lispPerGame.toFixed(1)} LOB/game`,
    };
    _cache.set(k, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[conversionRate] Failed for team ${teamId}:`, err.message);
    return null;
  }
}

/**
 * Get conversion rates for both teams in a matchup, in parallel.
 */
export async function getMatchupConversionRates(awayTeamId, homeTeamId) {
  const [away, home] = await Promise.all([
    getTeamConversionRate(awayTeamId),
    getTeamConversionRate(homeTeamId),
  ]);
  return { away, home };
}
