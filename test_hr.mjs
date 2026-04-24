import handler from './api/analyze.js';
import { getProbables } from './api/_lib/data.js';

const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const { games } = await getProbables(tomorrow);
const game = games.find(g => g.awayTeam.abbreviation === 'KC' && g.homeTeam.abbreviation === 'NYY') || games[0];
if (!game) { console.log('no game'); process.exit(); }

console.log(`Testing ${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}, deep mode`);
const req = { method: 'GET', query: { gamePk: game.gamePk, deep: '1' } };
let captured = null;
const res = { setHeader:()=>{}, status:(c)=>({json:(d)=>{captured=d;return captured;},end:()=>{}}) };
await handler(req, res);

console.log('\n=== HR BADGES ===');
['awayVsHome', 'homeVsAway'].forEach(k => {
  const side = captured?.[k];
  if (!side) return;
  const teamLabel = k === 'awayVsHome' ? captured.awayTeam.abbreviation : captured.homeTeam.abbreviation;
  console.log(`\n${teamLabel}:`);
  (side.mismatches || []).forEach(m => {
    if (m.hrChance) {
      console.log(`  ${m.hrChance.emoji} ${m.hitter} (${m.hand}) — HR ${m.hrChance.tier.toUpperCase()} score=${m.hrChance.score}`);
      m.hrChance.criteria.forEach(c => console.log(`      ▸ ${c}`));
    }
  });
});
