/**
 * REGRESSION TESTS for this backtester.
 *
 * Each of these failed against the version published before a pre-launch audit.
 * They are the reason the sample numbers in the README changed.
 */
import { describe, it, expect } from 'vitest';
import { RiskManager } from '../src/risk/manager.js';
import { computeMetrics, formatReport } from '../src/engine/metrics.js';
import { backtest, barsPerYear } from '../src/engine/backtest.js';
import { SmaCrossover } from '../src/strategy/sma-crossover.js';
import { loadConfig } from '../src/config.js';
import { fetchHistory, buildStrategy } from '../src/index.js';
import { sma, rsi, clamp, last, previous } from '../src/utils/indicators.js';
import type { Candle, Trade } from '../src/types.js';
import { synthCandles, rampCandles, baseRisk } from './helpers.js';

const longAll = {
  name: 'always-long',
  onCandle: () => ({ side: 'long' as const, strength: 1, reason: 'hold' }),
};

describe('mark-to-market', () => {
  it('reports a non-zero drawdown while a position is held through a decline', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const close = i < 5 ? 100_000 : 100_000 * Math.pow(0.97, i - 4);
      candles.push({
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: close, high: close, low: close, close, volume: 1,
      });
    }

    const result = backtest(candles, longAll, {
      symbol: 'T',
      timeframe: '1h',
      initialCapital: 1_000,
      risk: {
        ...baseRisk,
        riskPerTrade: 0.5,
        maxPositionUsd: 500,
        stopLossPct: 0.9,
        takeProfitPct: 100,
        maxDrawdown: 0.99,
      },
    });

    // Unrealised P&L used to be absent from the curve, so this read 0.
    expect(result.metrics.maxDrawdownPct).toBeGreaterThan(0.05);
  });
});

describe('fee accounting', () => {
  it('finalCapital agrees with the final equity-curve point', () => {
    const candles = synthCandles(400, { seed: 11 });
    const strategy = new SmaCrossover({ fast: 5, slow: 20 });
    strategy.init(candles);

    const result = backtest(candles, strategy, {
      symbol: 'T',
      timeframe: '1h',
      initialCapital: 10_000,
      risk: baseRisk,
      feeRate: 0.001,
    });

    const lastPoint = result.equityCurve[result.equityCurve.length - 1];
    expect(lastPoint).toBeDefined();
    // Previously these differed by the sum of every entry fee.
    expect(Math.abs(result.finalCapital - lastPoint!.equity)).toBeLessThan(10);
  });

  it('charging a higher fee cannot improve results', () => {
    const candles = synthCandles(400, { seed: 12 });
    const run = (feeRate: number): number => {
      const s = new SmaCrossover({ fast: 5, slow: 20 });
      s.init(candles);
      return backtest(candles, s, {
        symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk, feeRate,
      }).metrics.totalPnl;
    };
    expect(run(0.002)).toBeLessThanOrEqual(run(0.001));
  });
});

describe('circuit breaker', () => {
  it('cools down instead of latching off permanently', () => {
    const rm = new RiskManager(baseRisk, 10_000, 3, 2);
    rm.recordClose(-10);
    rm.recordClose(-10);
    rm.recordClose(-10);

    expect(rm.canOpen(10_000, 0).allowed).toBe(false);
    expect(rm.stats.cooldown).toBe(1);
    rm.canOpen(10_000, 0);
    expect(rm.canOpen(10_000, 0).allowed).toBe(true);
  });

  it('a winning trade resets the loss streak', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    rm.recordClose(-1);
    rm.recordClose(-1);
    rm.recordClose(5);
    expect(rm.stats.consecutiveLosses).toBe(0);
    expect(rm.canOpen(10_000, 0).allowed).toBe(true);
  });
});

describe('risk manager', () => {
  it('seeds the drawdown baseline from a real balance', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    expect(rm.canOpen(500, 0).allowed).toBe(false);
    rm.seedPeak(500);
    expect(rm.canOpen(500, 0).allowed).toBe(true);
  });

  it('returns zero size for non-finite inputs rather than NaN', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    expect(rm.sizePosition(Number.NaN, 100)).toBe(0);
    expect(rm.sizePosition(10_000, 0)).toBe(0);
    expect(rm.sizePosition(0, 100)).toBe(0);
  });

  it('caps position size at MAX_POSITION_USD', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    expect(rm.sizePosition(10_000, 50_000)).toBeCloseTo(0.01, 12);
  });

  it('enforces max open trades', () => {
    expect(new RiskManager(baseRisk, 10_000).canOpen(10_000, 3).reason).toMatch(/max open trades/);
  });

  it('exposes running stats', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    rm.recordClose(5);
    expect(rm.stats.trades).toBe(1);
  });
});

describe('metrics', () => {
  const mkTrade = (pnl: number): Trade => ({
    side: 'long', entryTime: 1, entryPrice: 100, exitTime: 2, exitPrice: 100 + pnl,
    quantity: 1, pnl, pnlPct: pnl / 100, fees: 0, reason: 'test',
  });

  it('profit factor is Infinity when nothing lost', () => {
    expect(computeMetrics([mkTrade(10), mkTrade(5)], [], 1_000).profitFactor).toBe(Infinity);
  });

  it('an empty run produces no NaN anywhere', () => {
    const m = computeMetrics([], [], 10_000);
    for (const [k, v] of Object.entries(m)) {
      expect(Number.isNaN(v as number), `${k} is NaN`).toBe(false);
    }
    expect(m.profitFactor).toBe(0);
  });

  it('survives a large trade set (was Math.max(...arr) stack overflow)', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => mkTrade(i % 7 === 0 ? -5 : 3));
    expect(() => computeMetrics(many, [], 1_000)).not.toThrow();
  });

  it('measures drawdown peak to valley', () => {
    const curve = [
      { timestamp: 0, equity: 10_000 },
      { timestamp: 1, equity: 5_000 },
      { timestamp: 2, equity: 10_000 },
    ];
    expect(computeMetrics([], curve, 10_000).maxDrawdownPct).toBeCloseTo(0.5, 6);
  });
});

describe('sharpe annualisation', () => {
  it.each([
    ['1d', 365],
    ['1h', 365 * 24],
    ['15m', 365 * 24 * 4],
    ['4h', (365 * 24) / 4],
  ])('scales %s correctly', (tf, expected) => {
    expect(barsPerYear(tf)).toBeCloseTo(expected, 6);
  });

  it('falls back to daily for unparseable input', () => {
    expect(barsPerYear('garbage')).toBe(365);
    expect(barsPerYear('')).toBe(365);
    expect(barsPerYear('0m')).toBe(365);
  });

  it('changes with the sampling rate rather than being hardcoded', () => {
    let eq = 10_000;
    const curve = Array.from({ length: 60 }, (_, i) => {
      eq *= 1.01;
      return { timestamp: i, equity: eq };
    });
    const daily = computeMetrics([], curve, 10_000, 365);
    const hourly = computeMetrics([], curve, 10_000, 365 * 24);
    expect(daily.sharpeRatio).toBeGreaterThan(0);
    expect(hourly.sharpeRatio / daily.sharpeRatio).toBeCloseTo(Math.sqrt(24), 4);
  });
});

describe('formatReport', () => {
  const m = computeMetrics([], [{ timestamp: 0, equity: 10_000 }], 10_000);

  it.each([
    [0, /0s/],
    [45 * 60_000, /45m/],
    [90 * 60_000, /1h 30m/],
    [50 * 3_600_000, /2d 2h/],
  ])('formats a %i ms hold', (ms, pattern) => {
    expect(formatReport({ ...m, avgHoldMs: ms }, 10_000)).toMatch(pattern);
  });

  it('renders an infinite profit factor as a symbol', () => {
    const win: Trade = {
      side: 'long', entryTime: 0, entryPrice: 1, exitTime: 1, exitPrice: 2,
      quantity: 1, pnl: 1, pnlPct: 1, fees: 0, reason: 'x',
    };
    expect(formatReport(computeMetrics([win], [], 10_000), 10_000)).toContain('∞');
  });
});

describe('backtest engine', () => {
  it('halts and flattens when max drawdown is breached', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const close = 100_000 * Math.pow(0.97, i);
      candles.push({
        timestamp: 1_700_000_000_000 + i * 3_600_000, open: close, high: close, low: close, close, volume: 1,
      });
    }

    const result = backtest(candles, longAll, {
      symbol: 'T', timeframe: '1h', initialCapital: 1_000,
      risk: { ...baseRisk, riskPerTrade: 0.5, stopLossPct: 0.9, takeProfitPct: 100, maxDrawdown: 0.02 },
    });

    expect(result.trades.some((t) => t.reason === 'max drawdown')).toBe(true);
    expect(result.equityCurve.length).toBeLessThan(candles.length);
  });

  it('leaves an open position untouched when closeAtEnd is false', () => {
    const result = backtest(synthCandles(20, { seed: 5 }), longAll, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk, closeAtEnd: false,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.finalCapital).toBe(10_000);
  });

  it('takes the stop when one bar spans both stop and target', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 12; i++) {
      candles.push({
        timestamp: 1_700_000_000_000 + i * 3_600_000, open: 100, high: 100, low: 100, close: 100, volume: 1,
      });
    }
    candles[5] = { timestamp: 1_700_000_000_000 + 5 * 3_600_000, open: 100, high: 200, low: 50, close: 100, volume: 1 };

    let call = 0;
    const strategy = {
      name: 'hold-through',
      onCandle: () => {
        call += 1;
        return call <= 5
          ? { side: 'long' as const, strength: 1, reason: 'hold' }
          : { side: 'flat' as const, strength: 0, reason: 'exit' };
      },
    };

    const result = backtest(candles, strategy, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000,
      risk: { ...baseRisk, stopLossPct: 0.1, takeProfitPct: 0.5, maxPositionUsd: 5_000 },
    });
    expect(result.trades[0]?.reason).toBe('stop loss');
  });

  it('rejects fewer than three candles', () => {
    expect(() =>
      backtest(synthCandles(2), longAll, { symbol: 'T', timeframe: '1h', initialCapital: 1, risk: baseRisk }),
    ).toThrow(/at least 3 candles/);
  });

  it('never emits NaN into the trade log', () => {
    const result = backtest(synthCandles(500, { seed: 77 }), longAll, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    });
    for (const t of result.trades) {
      expect(Number.isFinite(t.pnl)).toBe(true);
      expect(Number.isFinite(t.entryPrice)).toBe(true);
      expect(Number.isFinite(t.exitPrice)).toBe(true);
    }
    expect(Number.isFinite(result.metrics.totalPnl)).toBe(true);
  });
});

describe('indicators', () => {
  it('sma returns nulls for a non-positive period', () => {
    expect(sma([1, 2, 3], 0).every((v) => v === null)).toBe(true);
  });

  it('sma computes a correct rolling mean', () => {
    const out = sma([10, 11, 12, 13, 14], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(11);
    expect(out[4]).toBeCloseTo(13);
  });

  it('rsi pins to 100 on an uptrend and 0 on a downtrend', () => {
    expect(rsi(rampCandles(40).map((c) => c.close), 14).at(-1)).toBe(100);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(rsi(down, 14).at(-1)).toBe(0);
  });

  it('rsi is all nulls when history is shorter than the period', () => {
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true);
  });

  it('clamp, last and previous behave on edge inputs', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(last([])).toBeUndefined();
    expect(last([1, 2])).toBe(2);
    expect(previous([1])).toBeUndefined();
    expect(previous([1, 2, 3])).toBe(2);
  });
});

describe('strategy', () => {
  it('rejects fast >= slow', () => {
    expect(() => new SmaCrossover({ fast: 50, slow: 20 })).toThrow();
  });

  it('goes flat during warm-up', () => {
    const few = synthCandles(5);
    const s = new SmaCrossover({ fast: 20, slow: 50 });
    s.init(few);
    expect(s.onCandle(few[few.length - 1]!, few).side).toBe('flat');
  });

  it('signals a crossover on a clean uptrend', () => {
    const candles = synthCandles(200, { seed: 21, drift: 12 });
    const s = new SmaCrossover({ fast: 5, slow: 20 });
    s.init(candles);
    const signals = candles.map((c, i) => s.onCandle(c, candles.slice(0, i + 1)));
    expect(signals.some((sig) => /crossed above/.test(sig.reason))).toBe(true);
  });

  it('keeps signal strength bounded to 0..1', () => {
    const candles = synthCandles(300, { seed: 99 });
    const s = new SmaCrossover({ fast: 5, slow: 20 });
    s.init(candles);
    for (let i = 0; i < candles.length; i++) {
      const sig = s.onCandle(candles[i]!, candles.slice(0, i + 1));
      expect(sig.strength).toBeGreaterThanOrEqual(0);
      expect(sig.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe('config', () => {
  it('accepts valid overrides', () => {
    const c = loadConfig({ SYMBOL: 'ETH/USDT', TIMEFRAME: '4h', FEE_RATE: '0.002' });
    expect(c.symbol).toBe('ETH/USDT');
    expect(c.timeframe).toBe('4h');
    expect(c.feeRate).toBe(0.002);
  });

  it('falls through to defaults when a value is empty', () => {
    expect(loadConfig({ SYMBOL: '' }).symbol).toBe('BTC/USDT');
  });

  it('rejects a fast window at or above the slow window', () => {
    expect(() => loadConfig({ SMA_FAST: '90', SMA_SLOW: '50' })).toThrow();
  });

  it('exposes the documented defaults', () => {
    const c = loadConfig({});
    expect(c.exchangeId).toBe('kucoin');
    expect(c.timeframe).toBe('1h');
    expect(c.backtestDays).toBe(365);
    expect(c.risk.stopLossPct).toBe(0.03);
  });
});

describe('public surface', () => {
  it('builds a primed SMA strategy', () => {
    const candles = synthCandles(120);
    const s = buildStrategy(loadConfig({}), candles);
    expect(s.onCandle(candles[candles.length - 1]!, candles).reason).not.toBe('warming up');
  });

  it('exposes a paginating history fetcher', () => {
    expect(typeof fetchHistory).toBe('function');
  });
});