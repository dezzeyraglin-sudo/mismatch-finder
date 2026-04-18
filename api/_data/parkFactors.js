// api/_data/parkFactors.js
// Park factors based on Baseball Savant 3-year rolling PF (2023-2025)
// PF > 100 = hitter-friendly, PF < 100 = pitcher-friendly
// 100 = league average for that metric
// Source: baseballsavant.mlb.com/leaderboard/statcast-park-factors

// Primary lookup: keyed by team abbreviation (reliable + matches our schedule data)
export const PARK_FACTORS_BY_TEAM = {
  // AL East
  NYY: { name: "Yankee Stadium",     runs: 103, hr: 113, hits: 100, so: 99,  bb: 101, lhbHr: 117, rhbHr: 110 },
  BOS: { name: "Fenway Park",        runs: 108, hr: 99,  hits: 106, so: 96,  bb: 100, lhbHr: 97,  rhbHr: 100 },
  TOR: { name: "Rogers Centre",      runs: 102, hr: 105, hits: 100, so: 98,  bb: 100, lhbHr: 103, rhbHr: 107 },
  BAL: { name: "Oriole Park",        runs: 101, hr: 98,  hits: 100, so: 100, bb: 100, lhbHr: 99,  rhbHr: 98  },
  TB:  { name: "Tropicana Field",    runs: 95,  hr: 91,  hits: 97,  so: 103, bb: 99,  lhbHr: 90,  rhbHr: 92  },

  // AL Central
  CLE: { name: "Progressive Field",  runs: 97,  hr: 95,  hits: 98,  so: 101, bb: 100, lhbHr: 94,  rhbHr: 96  },
  DET: { name: "Comerica Park",      runs: 96,  hr: 92,  hits: 99,  so: 101, bb: 100, lhbHr: 91,  rhbHr: 93  },
  KC:  { name: "Kauffman Stadium",   runs: 100, hr: 91,  hits: 102, so: 99,  bb: 99,  lhbHr: 89,  rhbHr: 93  },
  MIN: { name: "Target Field",       runs: 99,  hr: 98,  hits: 100, so: 99,  bb: 99,  lhbHr: 96,  rhbHr: 100 },
  CWS: { name: "Rate Field",         runs: 103, hr: 111, hits: 101, so: 98,  bb: 101, lhbHr: 113, rhbHr: 109 },
  CHW: { name: "Rate Field",         runs: 103, hr: 111, hits: 101, so: 98,  bb: 101, lhbHr: 113, rhbHr: 109 },

  // AL West
  HOU: { name: "Daikin Park",        runs: 100, hr: 105, hits: 99,  so: 100, bb: 100, lhbHr: 110, rhbHr: 101 },
  SEA: { name: "T-Mobile Park",      runs: 94,  hr: 93,  hits: 96,  so: 103, bb: 100, lhbHr: 90,  rhbHr: 95  },
  TEX: { name: "Globe Life Field",   runs: 100, hr: 100, hits: 100, so: 100, bb: 100, lhbHr: 100, rhbHr: 100 },
  LAA: { name: "Angel Stadium",      runs: 98,  hr: 97,  hits: 99,  so: 100, bb: 99,  lhbHr: 95,  rhbHr: 99  },
  ATH: { name: "Sutter Health Park", runs: 102, hr: 106, hits: 101, so: 98,  bb: 100, lhbHr: 104, rhbHr: 107 },
  OAK: { name: "Sutter Health Park", runs: 102, hr: 106, hits: 101, so: 98,  bb: 100, lhbHr: 104, rhbHr: 107 },

  // NL East
  NYM: { name: "Citi Field",         runs: 97,  hr: 95,  hits: 98,  so: 101, bb: 100, lhbHr: 93,  rhbHr: 97  },
  PHI: { name: "Citizens Bank Park", runs: 102, hr: 107, hits: 100, so: 98,  bb: 100, lhbHr: 109, rhbHr: 104 },
  ATL: { name: "Truist Park",        runs: 100, hr: 100, hits: 100, so: 100, bb: 100, lhbHr: 99,  rhbHr: 100 },
  MIA: { name: "loanDepot park",     runs: 95,  hr: 90,  hits: 97,  so: 101, bb: 99,  lhbHr: 88,  rhbHr: 91  },
  WSH: { name: "Nationals Park",     runs: 100, hr: 101, hits: 100, so: 99,  bb: 100, lhbHr: 100, rhbHr: 102 },
  WAS: { name: "Nationals Park",     runs: 100, hr: 101, hits: 100, so: 99,  bb: 100, lhbHr: 100, rhbHr: 102 },

  // NL Central
  CHC: { name: "Wrigley Field",      runs: 101, hr: 102, hits: 100, so: 99,  bb: 100, lhbHr: 101, rhbHr: 103 },
  MIL: { name: "American Family",    runs: 101, hr: 104, hits: 100, so: 99,  bb: 100, lhbHr: 104, rhbHr: 103 },
  CIN: { name: "Great American",     runs: 108, hr: 117, hits: 102, so: 96,  bb: 101, lhbHr: 120, rhbHr: 115 },
  PIT: { name: "PNC Park",           runs: 96,  hr: 93,  hits: 98,  so: 101, bb: 100, lhbHr: 90,  rhbHr: 95  },
  STL: { name: "Busch Stadium",      runs: 97,  hr: 93,  hits: 98,  so: 101, bb: 100, lhbHr: 92,  rhbHr: 94  },

  // NL West
  LAD: { name: "Dodger Stadium",     runs: 100, hr: 104, hits: 99,  so: 100, bb: 100, lhbHr: 103, rhbHr: 105 },
  SF:  { name: "Oracle Park",        runs: 92,  hr: 85,  hits: 95,  so: 102, bb: 99,  lhbHr: 83,  rhbHr: 87  },
  SD:  { name: "Petco Park",         runs: 95,  hr: 92,  hits: 97,  so: 101, bb: 100, lhbHr: 89,  rhbHr: 94  },
  COL: { name: "Coors Field",        runs: 115, hr: 112, hits: 108, so: 92,  bb: 103, lhbHr: 110, rhbHr: 114 },
  ARI: { name: "Chase Field",        runs: 101, hr: 102, hits: 101, so: 99,  bb: 100, lhbHr: 101, rhbHr: 104 }
};

// Empty venueId lookup kept for compatibility with park-factor.js
// (primary lookup is team abbreviation via PARK_FACTORS_BY_TEAM)
export const PARK_FACTORS = {};

// Classify a park factor value into a tier for display
export function classifyPF(value, metric) {
  if (!value || value === 100) return 'neutral';
  const delta = value - 100;
  const threshold = metric === 'hr' ? 8 : 4;
  if (delta >= threshold) return 'hitter-friendly';
  if (delta <= -threshold) return 'pitcher-friendly';
  return 'neutral';
}
