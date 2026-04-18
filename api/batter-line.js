// api/batter-line.js
// Returns a batter's final box score line for a given game.
// Used for auto-grading tracked hitters.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { gamePk, mlbam } = req.query;
  if (!gamePk || !mlbam) {
    return res.status(400).json({ error: 'gamePk and mlbam required' });
  }

  try {
    const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`MLB API ${r.status}`);
    const data = await r.json();

    // Also fetch game status from schedule to know if final
    const statusUrl = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live?fields=gameData,status`;
    const sr = await fetch(statusUrl).catch(() => null);
    const statusData = sr && sr.ok ? await sr.json() : null;
    const gameStatus = statusData?.gameData?.status?.abstractGameState || 'Unknown';
    const detailedStatus = statusData?.gameData?.status?.detailedState || '';
    const isFinal = gameStatus === 'Final';

    // Look up player in both teams
    const pidKey = `ID${mlbam}`;
    let playerData = null;
    let team = null;
    for (const side of ['home', 'away']) {
      const p = data.teams?.[side]?.players?.[pidKey];
      if (p) {
        playerData = p;
        team = side;
        break;
      }
    }

    if (!playerData) {
      return res.status(200).json({
        gamePk, mlbam,
        found: false,
        gameStatus, detailedStatus, isFinal,
        message: 'Player not in this game boxscore'
      });
    }

    const batting = playerData.stats?.batting || {};
    const didPlay = (batting.atBats || 0) > 0 || (batting.plateAppearances || 0) > 0;

    const line = {
      AB: batting.atBats || 0,
      PA: batting.plateAppearances || 0,
      H: batting.hits || 0,
      R: batting.runs || 0,
      RBI: batting.rbi || 0,
      HR: batting.homeRuns || 0,
      TB: batting.totalBases || 0,
      BB: batting.baseOnBalls || 0,
      K: batting.strikeOuts || 0,
      SB: batting.stolenBases || 0,
      HBP: batting.hitByPitch || 0,
      doubles: batting.doubles || 0,
      triples: batting.triples || 0,
      summary: batting.summary || ''
    };

    // Auto-grade against each outcome type
    const outcomes = {
      H: line.H >= 1,
      R: line.R >= 1,
      RBI: line.RBI >= 1,
      HR: line.HR >= 1,
      TB: line.TB >= 2,          // Total Bases 1.5+ (so 2+)
      HRR: (line.H + line.R + line.RBI) >= 1,  // Any H+R+RBI contribution
      FANTASY: (line.H + line.R + line.RBI + line.HR + line.TB + line.BB + line.SB) >= 1  // Any box score positive
    };

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      gamePk, mlbam,
      found: true,
      didPlay,
      gameStatus, detailedStatus, isFinal,
      team,
      playerName: playerData.person?.fullName || '',
      line,
      outcomes
    });
  } catch (err) {
    console.error('batter-line error:', err);
    return res.status(500).json({ error: err.message });
  }
}
