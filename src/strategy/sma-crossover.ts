import type { Candle, Signal, Strategy } from '../types.js';
import { closes, previous, sma } from '../utils/indicators.js';

export interface SmaCrossoverParams {
  fast: number;
  slow: number;
}

/**
 * Classic trend-following: go long when the fast SMA crosses above the slow SMA.
 * Deliberately conservative — it only trades in the direction of the established trend.
 */
export class SmaCrossover implements Strategy {
  readonly name = 'sma-crossover';
  private fast: Array<number | null> = [];
  private slow: Array<number | null> = [];

  constructor(private readonly params: SmaCrossoverParams) {
    if (params.fast >= params.slow) throw new Error('fast must be < slow');
  }

  init(candles: Candle[]): void {
    const c = closes(candles);
    this.fast = sma(c, this.params.fast);
    this.slow = sma(c, this.params.slow);
  }

  onCandle(_candle: Candle, history: Candle[]): Signal {
    const i = history.length - 1;
    const f = this.fast[i];
    const s = this.slow[i];
    const fPrev = this.fast[i - 1];
    const sPrev = this.slow[i - 1];

    if (typeof f !== 'number' || typeof s !== 'number' || typeof fPrev !== 'number' || typeof sPrev !== 'number') {
      return { side: 'flat', strength: 0, reason: 'warming up' };
    }

    if (fPrev <= sPrev && f > s) {
      const spread = (f - s) / s;
      return { side: 'long', strength: Math.min(Math.abs(spread) * 1000, 1), reason: `SMA${this.params.fast} crossed above SMA${this.params.slow}` };
    }
    if (fPrev >= sPrev && f < s) {
      const spread = (f - s) / s;
      return { side: 'flat', strength: Math.min(Math.abs(spread) * 1000, 1), reason: `SMA${this.params.fast} crossed below SMA${this.params.slow} — exit` };
    }
    if (f > s) return { side: 'long', strength: 0.4, reason: 'trend up, holding' };
    return { side: 'flat', strength: 0.2, reason: 'trend down, flat' };
  }

  static from(values: number[]): SmaCrossover | undefined {
    const fast = values[0];
    const slow = values[1];
    return fast !== undefined && slow !== undefined ? new SmaCrossover({ fast, slow }) : undefined;
  }
}

export function buildSma(history: Candle[], fast: number, slow: number): SmaCrossover {
  const s = new SmaCrossover({ fast, slow });
  s.init(history);
  return s;
}

export { previous };