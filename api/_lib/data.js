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

// Build a team's bullpen composite arsenal - aggregated pitch-type usage
// across all relievers (excluding today's SP), weighted by pitches thrown.
// Returns arsenal in same shape as getPitcherArsenal().
export async function getBullpenProfile(teamAbbr, season, excludePitcherId) {
  // Savant uses team_name_alt codes like NYY, LAD, etc. Some differ:
  const abbr = (teamAbbr === 'CWS' ? 'CHW' :
                teamAbbr === 'WSH' ? 'WSH' :
                teamAbbr === 'ATH' ? 'OAK' :
                teamAbbr === 'AZ'  ? 'AZ'  : teamAbbr);

  const allRows = await fetchSavantCSV(arsenalURL(season, 'pitcher'));
  const excludeId = String(excludePitcherId || '').trim();

  // Filter to this team, excluding the starter
  const teamRows = allRows.filter(r => {
    const t = String(r.team_name_alt || '').trim();
    const pid = String(r.player_id || '').trim();
    // Accept common variants
    return (t === abbr || t === teamAbbr) && pid !== excludeId;
  });

  if (teamRows.length === 0) return { pitches: [], pitcherCount: 0 };

  // Identify relievers by checking who has low per-pitcher total pitch volume
  // (SPs typically have 200+ pitches of one type; RPs have < 100)
  // Group by player, sum pitches
  const playerTotals = {};
  teamRows.forEach(r => {
    const pid = String(r.player_id);
    if (!playerTotals[pid]) playerTotals[pid] = 0;
    playerTotals[pid] += parseInt(r.pitches) || 0;
  });

  // For reliever identification use a threshold - RPs rarely have > 300 total pitches per pitch-type early season
  // but this is secondary; the primary filter is "not today's starter"
  const relieverIds = new Set(Object.keys(playerTotals));

  // Filter to reliever rows only
  const rpRows = teamRows.filter(r => relieverIds.has(String(r.player_id)));

  // Aggregate by pitch type: weighted average of usage, xwoba, etc.
  // Weight by total pitches thrown across the bullpen
  const byPitch = {};
  let totalPitchesAll = 0;
  rpRows.forEach(r => {
    const pitches = parseInt(r.pitches) || 0;
    if (pitches < 5) return; // ignore tiny samples
    totalPitchesAll += pitches;
    const key = r.pitch_name || r.pitch_type || 'Unknown';
    if (!byPitch[key]) {
      byPitch[key] = {
        type: key,
        typeCode: r.pitch_type,
        totalPitches: 0,
        weightedXwoba: 0,
        weightedSlg: 0,
        weightedWhiff: 0,
        weightedHardHit: 0,
        pitcherCount: 0
      };
    }
    const bp = byPitch[key];
    bp.totalPitches += pitches;
    bp.pitcherCount += 1;
    if (r.est_woba) bp.weightedXwoba += parseFloat(r.est_woba) * pitches;
    if (r.slg) bp.weightedSlg += parseFloat(r.slg) * pitches;
    if (r.whiff_percent) bp.weightedWhiff += parseFloat(r.whiff_percent) * pitches;
    if (r.hard_hit_percent) bp.weightedHardHit += parseFloat(r.hard_hit_percent) * pitches;
  });

  // Convert aggregates into final arsenal rows
  const pitches = Object.values(byPitch).map(bp => ({
    type: bp.type,
    typeCode: bp.typeCode,
    // Usage in bullpen = share of this pitch across all bullpen pitches
    usage: totalPitchesAll > 0 ? ((bp.totalPitches / totalPitchesAll) * 100).toFixed(1) : '0',
    xwoba: bp.totalPitches > 0 ? (bp.weightedXwoba / bp.totalPitches).toFixed(3) : null,
    slg:   bp.totalPitches > 0 ? (bp.weightedSlg   / bp.totalPitches).toFixed(3) : null,
    whiffPct: bp.totalPitches > 0 ? (bp.weightedWhiff / bp.totalPitches).toFixed(1) : null,
    hardHitPct: bp.totalPitches > 0 ? (bp.weightedHardHit / bp.totalPitches).toFixed(1) : null,
    pitches: bp.totalPitches,
    pitcherCount: bp.pitcherCount
  })).filter(p => p.type && p.pitches >= 20)  // require meaningful sample
    .sort((a, b) => parseFloat(b.usage) - parseFloat(a.usage));

  return {
    pitches,
    pitcherCount: Object.keys(playerTotals).length,
    totalPitches: totalPitchesAll
  };
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

// Get a hitter's platoon splits (vs RHP and vs LHP)
// Uses MLB Stats API statSplits endpoint with situation codes vr/vl
// Returns { vsR: {ops, avg, slg, pa, ...}, vsL: {...} }
export async function getHitterSplits(mlbam, season) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=statSplits&group=hitting&season=${season}&sitCodes=vr,vl`;
    const r = await fetch(url);
    if (!r.ok) return { vsR: null, vsL: null };
    const data = await r.json();

    const splits = { vsR: null, vsL: null };
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const code = split.split?.code;
        const s = split.stat || {};
        const row = {
          avg: s.avg || null,
          obp: s.obp || null,
          slg: s.slg || null,
          ops: s.ops || null,
          pa: s.plateAppearances || 0,
          hr: s.homeRuns || 0,
          k: s.strikeOuts || 0,
          bb: s.baseOnBalls || 0,
          h: s.hits || 0,
          doubles: s.doubles || 0,
          triples: s.triples || 0
        };
        // K rate (since MLB API doesn't return K%)
        row.kPct = row.pa > 0 ? ((row.k / row.pa) * 100).toFixed(1) : null;
        row.iso = s.sluggingPct && s.battingAvg
          ? (parseFloat(s.sluggingPct) - parseFloat(s.battingAvg)).toFixed(3)
          : null;
        if (code === 'vr') splits.vsR = row;
        else if (code === 'vl') splits.vsL = row;
      }
    }
    return splits;
  } catch (err) {
    return { vsR: null, vsL: null };
  }
}

// Get a pitcher's splits vs LHB and RHB
export async function getPitcherSplits(mlbam, season) {
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${mlbam}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=vr,vl`;
    const r = await fetch(url);
    if (!r.ok) return { vsR: null, vsL: null };
    const data = await r.json();

    const splits = { vsR: null, vsL: null };
    for (const block of (data.stats || [])) {
      for (const split of (block.splits || [])) {
        const code = split.split?.code;
        const s = split.stat || {};
        const row = {
          avg: s.avg || null,
          opsAgainst: s.ops || null,
          slgAgainst: s.slg || null,
          obpAgainst: s.obp || null,
          pa: s.plateAppearances || 0,
          hr: s.homeRuns || 0,
          k: s.strikeOuts || 0,
          bb: s.baseOnBalls || 0,
          hitsAllowed: s.hits || 0
        };
        row.kPct = row.pa > 0 ? ((row.k / row.pa) * 100).toFixed(1) : null;
        row.bbPct = row.pa > 0 ? ((row.bb / row.pa) * 100).toFixed(1) : null;
        // 'vr' for pitcher = vs RHB, 'vl' = vs LHB
        if (code === 'vr') splits.vsR = row;
        else if (code === 'vl') splits.vsL = row;
      }
    }
    return splits;
  } catch (err) {
    return { vsR: null, vsL: null };
  }
}

// =============================================================
// DEEP SPLITS: per-pitch-type xwOBA filtered by pitcher handedness
// =============================================================
// Pulls raw pitch-by-pitch from Statcast search endpoint and aggregates.
// Heavier than regular arsenal stats (each call = 300-800 rows of CSV),
// so cache aggressively and use only when needed ("deep mode").

const deepCache = new Map();
const DEEP_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 minutes

function pitchNameFromCode(code) {
  const map = {
    FF: '4-Seam Fastball', FT: '2-Seam Fastball', SI: 'Sinker', FC: 'Cutter',
    SL: 'Slider', ST: 'Sweeper', SV: 'Slurve', CU: 'Curveball', KC: 'Knuckle Curve',
    CH: 'Changeup', FS: 'Split-Finger', FO: 'Forkball', KN: 'Knuckleball',
    EP: 'Eephus', SC: 'Screwball', CS: 'Slow Curve'
  };
  return map[code] || code;
}

// Simple CSV line parser (handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// Fetch per-pitch-type xwOBA for a hitter filtered to one pitcher hand.
// Returns array of { type, typeCode, pitches, pa, xwoba, xwobaSampleSize }
export async function getHitterPitchTypeByHand(mlbam, season, pitcherHand) {
  const key = `${mlbam}-${season}-${pitcherHand}`;
  const cached = deepCache.get(key);
  if (cached && Date.now() - cached.t < DEEP_CACHE_TTL_MS) return cached.data;

  try {
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=${season}%7C&player_type=batter&pitcher_throws=${pitcherHand}&batters_lookup%5B%5D=${mlbam}&type=details`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Mismatch Finder)' },
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }
    const text = await r.text();
    if (text.startsWith('<') || text.length < 200) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const cleaned = text.replace(/^\uFEFF/, '');
    const lines = cleaned.split('\n');
    if (lines.length < 2) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const idx = {
      pitch_type: headers.indexOf('pitch_type'),
      events: headers.indexOf('events'),
      estimated_woba: headers.indexOf('estimated_woba_using_speedangle'),
      woba_value: headers.indexOf('woba_value')
    };

    if (idx.pitch_type < 0 || idx.events < 0) {
      deepCache.set(key, { t: Date.now(), data: [] });
      return [];
    }

    const byPitch = {};
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cells = parseCSVLine(lines[i]);
      if (cells.length < Math.max(idx.pitch_type, idx.events) + 1) continue;
      const pt = (cells[idx.pitch_type] || '').trim();
      if (!pt) continue;

      if (!byPitch[pt]) {
        byPitch[pt] = { pitches: 0, pa: 0, xwobaSum: 0, xwobaN: 0 };
      }
      byPitch[pt].pitches++;

      const events = (cells[idx.events] || '').trim();
      if (events) {
        byPitch[pt].pa++;
        const ewRaw = idx.estimated_woba >= 0 ? (cells[idx.estimated_woba] || '').trim() : '';
        const wvRaw = idx.woba_value >= 0 ? (cells[idx.woba_value] || '').trim() : '';
        let val = null;
        if (ewRaw && ewRaw !== 'null' && ewRaw !== 'NaN') {
          const n = parseFloat(ewRaw);
          if (!isNaN(n)) val = n;
        }
        if (val === null && wvRaw && wvRaw !== 'null' && wvRaw !== 'NaN') {
          const n = parseFloat(wvRaw);
          if (!isNaN(n)) val = n;
        }
        if (val !== null) {
          byPitch[pt].xwobaSum += val;
          byPitch[pt].xwobaN++;
        }
      }
    }

    const result = Object.entries(byPitch).map(([code, d]) => ({
      type: pitchNameFromCode(code),
      typeCode: code,
      pitches: d.pitches,
      pa: d.pa,
      xwoba: d.xwobaN > 0 ? (d.xwobaSum / d.xwobaN).toFixed(3) : null,
      xwobaSampleSize: d.xwobaN
    })).filter(p => p.pitches >= 5)
      .sort((a, b) => b.pitches - a.pitches);

    deepCache.set(key, { t: Date.now(), data: result });
    return result;
  } catch (err) {
    deepCache.set(key, { t: Date.now(), data: [] });
    return [];
  }
}
