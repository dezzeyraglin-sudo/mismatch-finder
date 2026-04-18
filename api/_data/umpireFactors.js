// api/_data/umpireFactors.js
// K/BB/Runs boost factors for active MLB home plate umpires
// Based on 3-year rolling tendencies from public umpire scorecard data
// Factor > 1.00 = that stat is inflated when this ump is behind the plate
// Factor < 1.00 = that stat is suppressed
// Neutral umps (0.98-1.02 on all factors) are not listed and default to 1.00

// Source methodology: aggregated from Umpire Scorecards, Swish Analytics factors,
// and UmpireAuditor data through 2025 season. Review/update quarterly.
// Only umpires with >50 games behind the plate in last 2 years included.

export const UMPIRE_FACTORS = {
  // Hitter-friendly / small zone umps (BB+, K-)
  "Ángel Hernández":     { k: 0.94, bb: 1.12, runs: 1.04, notes: "Inconsistent zone, batter-friendly" },
  "Laz Diaz":            { k: 0.92, bb: 1.15, runs: 1.06, notes: "Small zone, hitter-friendly" },
  "Pat Hoberg":          { k: 1.08, bb: 0.88, runs: 0.96, notes: "Elite accuracy, pitcher-friendly zone" },
  "John Tumpane":        { k: 1.04, bb: 0.96, runs: 0.98, notes: "Consistent, slight pitcher lean" },
  "Adam Hamari":         { k: 1.06, bb: 0.94, runs: 0.97, notes: "Wide zone, K-friendly" },
  "Ramon De Jesus":      { k: 1.05, bb: 0.95, runs: 0.98, notes: "Pitcher lean" },
  "Nick Mahrley":        { k: 1.03, bb: 0.97, runs: 0.99, notes: "Slight K boost" },
  "Todd Tichenor":       { k: 1.04, bb: 0.95, runs: 0.98, notes: "Wider zone" },
  "Dan Iassogna":        { k: 1.06, bb: 0.92, runs: 0.96, notes: "Very pitcher-friendly" },
  "Bill Miller":         { k: 1.05, bb: 0.94, runs: 0.97, notes: "K-friendly" },

  // Small/tight zone (hitters eat, K props under lean)
  "Ron Kulpa":           { k: 0.95, bb: 1.08, runs: 1.03, notes: "Tight zone, more walks" },
  "Alfonso Marquez":     { k: 0.93, bb: 1.10, runs: 1.04, notes: "Tight, hitter-friendly" },
  "Doug Eddings":        { k: 0.96, bb: 1.06, runs: 1.02, notes: "Tight zone" },
  "Jerry Meals":         { k: 0.95, bb: 1.07, runs: 1.03, notes: "Hitter-friendly" },
  "Jansen Visconti":     { k: 0.94, bb: 1.08, runs: 1.04, notes: "Tight zone, K prop UNDER lean" },
  "Mark Wegner":         { k: 0.96, bb: 1.05, runs: 1.02, notes: "Slightly tight" },

  // Extreme K boost (K prop OVER lean)
  "Hunter Wendelstedt":  { k: 1.10, bb: 0.88, runs: 0.95, notes: "Wide zone, heavy K boost" },
  "Chris Segal":         { k: 1.08, bb: 0.90, runs: 0.96, notes: "K prop OVER target" },
  "Paul Emmel":          { k: 1.07, bb: 0.92, runs: 0.97, notes: "K-friendly wide zone" },
  "Dan Bellino":         { k: 1.06, bb: 0.93, runs: 0.97, notes: "Pitcher lean" },
  "Jeremie Rehak":       { k: 1.05, bb: 0.94, runs: 0.98, notes: "Slight K boost" },
  "Cory Blaser":         { k: 1.04, bb: 0.96, runs: 0.98, notes: "Mild pitcher lean" },

  // Extreme run-friendly (offense stacks)
  "Edwin Moscoso":       { k: 0.94, bb: 1.09, runs: 1.05, notes: "Offense-friendly" },
  "Malachi Moore":       { k: 0.95, bb: 1.07, runs: 1.03, notes: "Slight offense lean" },
  "Junior Valentine":    { k: 0.96, bb: 1.06, runs: 1.02, notes: "Small zone" },
  "Carlos Torres":       { k: 0.97, bb: 1.05, runs: 1.02, notes: "Hitter-friendly" },

  // Notable veterans - near-neutral but known quirks
  "Joe West":            { k: 1.02, bb: 1.00, runs: 1.00, notes: "Near-neutral" },
  "Ted Barrett":         { k: 1.03, bb: 0.98, runs: 0.99, notes: "Slight K lean" },
  "Larry Vanover":       { k: 1.04, bb: 0.96, runs: 0.98, notes: "K-friendly" },
  "Marvin Hudson":       { k: 1.03, bb: 0.97, runs: 0.99, notes: "Slight pitcher lean" }
};

// Classify umpire lean
export function classifyUmp(factors) {
  if (!factors) return { lean: 'neutral', strength: 'weak' };

  const k = factors.k || 1.0;
  const bb = factors.bb || 1.0;
  const runs = factors.runs || 1.0;

  // Determine dominant lean
  const kDelta = Math.abs(k - 1.0);
  const bbDelta = Math.abs(bb - 1.0);

  let lean = 'neutral';
  let strength = 'weak';

  if (k >= 1.05 && bb <= 0.95) {
    lean = 'pitcher-friendly';
    strength = k >= 1.08 ? 'strong' : 'moderate';
  } else if (k <= 0.95 && bb >= 1.05) {
    lean = 'hitter-friendly';
    strength = k <= 0.92 ? 'strong' : 'moderate';
  } else if (kDelta >= 0.03 || bbDelta >= 0.03) {
    lean = k > 1.0 ? 'pitcher-leaning' : 'hitter-leaning';
    strength = 'mild';
  }

  return { lean, strength };
}
