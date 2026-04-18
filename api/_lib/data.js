// api/_lib/data.js
// Core data-fetching helpers used by both standalone endpoints and analyze.js
// This avoids the Vercel "function calling function" 404 issue.

import { getAbbr } from '../_data/teams.js';
import { fetchSavantCSV, arsenalURL, expectedStatsURL } from './savant.js';

const CUSTOM_URL = (season) =>
  `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=batter&filter=&min=10&selections=exit_velocity_avg%2Cbrl_percent%2Chard_hit_percent%2Ck_percent%2Cbb_percent&chart=false&x=exit_velocity_avg&y=exit_velocity_avg&r=no&chartType=beeswarm&sortDir=desc&csv=true`;

// Fetch today's slate with probable pitchers + handedness
export async function getProbables(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,venue`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MLB API ${response.status}`);

  const data = await response.json();
  const games = [];
  const pitcherIds = new Set();

  if (data.dates?.length > 0) {
    for (const d of data.dates) {
      for (const game of d.games) {
        const gameTime = new Date(game.gameDate).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
        }) + ' ET';

        const awayTeamId = game.teams.away.team.id;
        const homeTeamId = game.teams.home.team.id;
        const awayPP = game.teams.away.probablePitcher;
        const homePP = game.teams.home.probablePitcher;

        if (awayPP?.id) pitcherIds.add(awayPP.id);
        if (homePP?.id) pitcherIds.add(homePP.id);

        games.push({
          gamePk: game.gamePk,
          awayTeam: {
            id: awayTeamId,
            name: game.teams.away.team.name,
            abbreviation: getAbbr(awayTeamId, game.teams.away.team.teamName)
          },
          homeTeam: {
            id: homeTeamId,
            name: game.teams.home.team.name,
            abbreviation: getAbbr(homeTeamId, game.teams.home.team.teamName)
          },
          awayPitcher: awayPP ? { id: awayPP.id, name: awayPP.fullName, hand: 'R' } : null,
          homePitcher: homePP ? { id: homePP.id, name: homePP.fullName, hand: 'R' } : null,
          venue: game.venue?.name || '',
          gameTime,
          status: game.status?.detailedState || ''
        });
      }
    }
  }

  // Batch-fetch pitcher hands
  if (pitcherIds.size > 0) {
    try {
      const ids = [...pitcherIds].join(',');
      const pr = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}`);
      if (pr.ok) {
        const pdata = await pr.json();
        const handMap = {};
        (pdata.people || []).forEach(p => { handMap[p.id] = p.pitchHand?.code || 'R'; });
        games.forEach(g => {
          if (g.awayPitcher) g.awayPitcher.hand = handMap[g.awayPitcher.id] || 'R';
          if (g.homePitcher) g.homePitcher.hand = handMap[g.homePitcher.id] || 'R';
        });
      }
    } catch (_) {}
  }

  return { date, games };
}

// Get a pitcher's arsenal
export async function getPitcherArsenal(mlbam, season) {
  const rows = await fetchSavantCSV(arsenalURL(season, 'pitcher'));
  const pid = String(mlbam).trim();
  const myRows = rows.filter(r => String(r.player_id).trim() === pid);

  return myRows.map(r => ({
    type: r.pitch_name || r.pitch_type || '',
    typeCode: r.pitch_type || '',
    usage: r.pitch_usage ? parseFloat(r.pitch_usage).toFixed(1) : null,
    whiffPct: r.whiff_percent ? parseFloat(r.whiff_percent).toFixed(1) : null,
    kPct: r.k_percent ? parseFloat(r.k_percent).toFixed(1) : null,
    xwoba: r.est_woba ? parseFloat(r.est_woba).toFixed(3) : null,
    ba: r.ba ? parseFloat(r.ba).toFixed(3) : null,
    slg: r.slg ? parseFloat(r.slg).toFixed(3) : null,
    hardHitPct: r.hard_hit_percent ? parseFloat(r.hard_hit_percent).toFixed(1) : null,
    pitches: parseInt(r.pitches) || 0
  })).filter(p => p.type && p.pitches > 0)
    .sort((a, b) => parseFloat(b.usage || 0) - parseFloat(a.usage || 0));
}

// Get team lineup (posted or active-roster fallback)
export async function getLineup(teamId, gamePk, side) {
  let hitters = [];

  if (gamePk) {
    try {
      const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
      if (boxRes.ok) {
        const box = await boxRes.json();
        const teamSide = side === 'home' ? 'home' : 'away';
        const teamBox = box.teams?.[teamSide];
        const battingOrder = teamBox?.battingOrder || [];
        if (battingOrder.length > 0) {
          for (const batterId of battingOrder) {
            const p = teamBox.players?.[`ID${batterId}`];
            if (p) {
              hitters.push({
                id: batterId,
                name: p.person?.fullName || '',
                position: p.position?.abbreviation || '',
                battingOrder: p.battingOrder || '',
                hand: 'R' // placeholder - batSide not in boxscore, we batch-fetch below
              });
            }
          }
        }
      }
    } catch (_) {}
  }

  if (hitters.length === 0 && teamId) {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person`);
    if (!r.ok) throw new Error(`Roster API ${r.status}`);
    const data = await r.json();

    hitters = (data.roster || [])
      .filter(p => p.position?.type !== 'Pitcher' && p.position?.abbreviation !== 'P')
      .map(p => ({
        id: p.person.id,
        name: p.person.fullName,
        position: p.position?.abbreviation || '',
        battingOrder: '',
        hand: p.person.batSide?.code || 'R'
      }));
    // Roster path already has hand, no extra fetch needed
    return hitters;
  }

  // Boxscore path: batch-fetch bat hands from people endpoint
  if (hitters.length > 0) {
    try {
      const ids = hitters.map(h => h.id).join(',');
      const pr = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}`);
      if (pr.ok) {
        const pdata = await pr.json();
        const handMap = {};
        (pdata.people || []).forEach(p => { handMap[p.id] = p.batSide?.code || 'R'; });
        hitters.forEach(h => { h.hand = handMap[h.id] || 'R'; });
      }
    } catch (_) {}
  }

  return hitters;
}

// Get hitter Statcast data
export async function getHitterStats(mlbam, season) {
  const pid = String(mlbam).trim();

  const [arsenalRows, expectedRows, customRows] = await Promise.all([
    fetchSavantCSV(arsenalURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(expectedStatsURL(season, 'batter')).catch(() => []),
    fetchSavantCSV(CUSTOM_URL(season)).catch(() => [])
  ]);

  const myArsenal = arsenalRows.filter(r => String(r.player_id).trim() === pid);
  const pitchTypes = myArsenal.map(r => ({
    type: r.pitch_name || r.pitch_type || '',
    typeCode: r.pitch_type || '',
    pitches: parseInt(r.pitches) || 0,
    pa: parseInt(r.pa) || 0,
    xwoba: r.est_woba ? parseFloat(r.est_woba).toFixed(3) : null,
    xba: r.est_ba ? parseFloat(r.est_ba).toFixed(3) : null,
    xslg: r.est_slg ? parseFloat(r.est_slg).toFixed(3) : null,
    whiffPct: r.whiff_percent ? parseFloat(r.whiff_percent).toFixed(1) : null,
    kPct: r.k_percent ? parseFloat(r.k_percent).toFixed(1) : null
  })).filter(p => p.type && p.pa > 0);

  const expRow = expectedRows.find(r => String(r.player_id).trim() === pid) || {};
  const custRow = customRows.find(r => String(r.player_id).trim() === pid) || {};

  return {
    overall: {
      xwoba: { value: expRow.est_woba ? parseFloat(expRow.est_woba).toFixed(3) : null },
      xba: { value: expRow.est_ba ? parseFloat(expRow.est_ba).toFixed(3) : null },
      xslg: { value: expRow.est_slg ? parseFloat(expRow.est_slg).toFixed(3) : null },
      barrel_batted_rate: { value: custRow.brl_percent ? parseFloat(custRow.brl_percent).toFixed(1) : null },
      hard_hit_percent: { value: custRow.hard_hit_percent ? parseFloat(custRow.hard_hit_percent).toFixed(1) : null },
      avg_exit_velocity: { value: custRow.exit_velocity_avg ? parseFloat(custRow.exit_velocity_avg).toFixed(1) : null },
      k_percent: { value: custRow.k_percent ? parseFloat(custRow.k_percent).toFixed(1) : null }
    },
    pitchTypes
  };
}
