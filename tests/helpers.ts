import type { Candle } from '../src/types.js';

/** Deterministic pseudo-random walk. Seeded so failures reproduce exactly. */
export function synthCandles(n: number, opts: { seed?: number; drift?: number; start?: number } = {}): Candle[] {
  const { seed = 42, drift = 0, start = 50_000 } = opts;
  let s = seed;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  let price = start;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    price = Math.max(100, price + (rand() - 0.48) * 900 + drift);
    const open = price;
    const close = price + (rand() - 0.5) * 400;
    out.push({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open,
      high: Math.max(open, close) + rand() * 200,
      low: Math.min(open, close) - rand() * 200,
      close,
      volume: 10 + rand() * 90,
    });
  }
  return out;
}

/** A clean monotone series — useful for exercising RSI's avgLoss === 0 arm. */
export function rampCandles(n: number, from = 100, step = 1): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = from + i * step;
    return {
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    };
  });
}

export const baseRisk = {
  riskPerTrade: 0.01,
  maxPositionUsd: 500,
  maxDrawdown: 0.2,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  maxOpenTrades: 3,
};