import type { RiskBand } from '../types.js';

/** One independent piece of evidence. Points add up; `minBand` is a floor no score can undercut. */
export interface Signal {
  code: string;
  points: number;
  detail: string;       // plain language, safe to speak aloud
  minBand?: RiskBand;
  /** Force the readback to spell the amount digit by digit. */
  digitReadback?: boolean;
}

export const BAND_ORDER: RiskBand[] = ['read', 'low', 'medium', 'high', 'severe', 'blocked'];
export const bandRank = (b: RiskBand) => BAND_ORDER.indexOf(b);
export const maxBand = (...bs: RiskBand[]): RiskBand => bs.reduce((a, b) => (bandRank(b) > bandRank(a) ? b : a), 'read' as RiskBand);
