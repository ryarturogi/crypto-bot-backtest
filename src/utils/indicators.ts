import type { Candle } from '../types.js';

export function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) continue;
    sum += v;
    if (i >= period) {
      const drop = values[i - period];
      if (drop !== undefined) sum -= drop;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period || period <= 0) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const cur = values[i];
    const prev = values[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const diff = cur - prev;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const cur = values[i];
    const prev = values[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const diff = cur - prev;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function last<T>(arr: T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[arr.length - 1];
}

export function previous<T>(arr: T[]): T | undefined {
  return arr.length < 2 ? undefined : arr[arr.length - 2];
}

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}