export const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const mad = (xs: number[]): number => { const m = median(xs); return median(xs.map((x) => Math.abs(x - m))); };

export interface LogStats { n: number; median: number; mad: number }
/** Stats in log space: money varies multiplicatively. */
export function logStats(amounts: number[]): LogStats {
  const l = amounts.filter((a) => a > 0).map(Math.log);
  return { n: l.length, median: median(l), mad: mad(l) };
}

/** Signed modified z-score (Iglewicz–Hoaglin) in log space, with a MAD floor so tight histories don't explode. */
export function logModifiedZ(amount: number, s: LogStats, madFloor = 0.15): number {
  if (!s.n || amount <= 0) return 0;
  return (0.6745 * (Math.log(amount) - s.median)) / Math.max(s.mad, madFloor);
}

export const typicalAmount = (s: LogStats) => (Number.isFinite(s.median) ? Math.exp(s.median) : NaN);
