/**
 * Coverage completion — config validation branches and remaining defensive paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RiskManager } from '../src/risk/manager.js';
import { computeMetrics } from '../src/engine/metrics.js';
import { printReport } from '../src/engine/backtest.js';
import { backtest } from '../src/engine/backtest.js';
import { createLogger, setLogLevel } from '../src/utils/logger.js';
import { buildSma } from '../src/strategy/sma-crossover.js';
import { sma, rsi } from '../src/utils/indicators.js';
import { synthCandles, baseRisk } from './helpers.js';
import type { BacktestResult, Candle, PerformanceMetrics } from '../src/types.js';

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => undefined));
afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('info');
  delete process.env.MAX_POSITION_USD;
  delete process.env.BACKTEST_DAYS;
});

function fakeResult(overrides: Partial<PerformanceMetrics>): BacktestResult {
  return {
    strategy: 'test', symbol: 'T', timeframe: '1h', startTime: 0, endTime: 1,
    initialCapital: 10_000, finalCapital: 10_000,
    metrics: {
      totalTrades: 50, wins: 25, losses: 25, winRate: 0.5, totalPnl: 100,
      returnPct: 0.01, maxDrawdownPct: 0.1, sharpeRatio: 1.2, profitFactor: 1.5,
      avgWin: 10, avgLoss: 10, largestWin: 50, largestLoss: -50, avgHoldMs: 3_600_000,
      ...overrides,
    },
    trades: [], equityCurve: [],
  };
}

describe('config numeric validation', () => {
  it('rejects a non-numeric guarded env value', () => {
    process.env.MAX_POSITION_USD = 'abc';
    expect(() => loadConfig({})).toThrow(/MAX_POSITION_USD/);
  });

  it('treats a whitespace-only guarded value as unset', () => {
    process.env.MAX_POSITION_USD = '   ';
    expect(loadConfig({}).risk.maxPositionUsd).toBe(500);
  });

  it('rejects a fractional value where a whole number is required', () => {
    process.env.BACKTEST_DAYS = '7.5';
    expect(() => loadConfig({})).toThrow(/whole number/);
  });

  it('rejects a guarded value at or below its floor', () => {
    process.env.BACKTEST_DAYS = '0';
    expect(() => loadConfig({})).toThrow();
  });

  it('accepts a guarded value above the floor', () => {
    process.env.BACKTEST_DAYS = '30';
    expect(loadConfig({}).backtestDays).toBe(30);
  });

  it.each(['0', '1', '1.4', '-0.2'])('rejects a fraction out of range: %s', (value) => {
    expect(() => loadConfig({ RISK_PER_TRADE: value })).toThrow();
  });

  it('rejects fractional SMA windows', () => {
    expect(() => loadConfig({ SMA_FAST: '10.5' })).toThrow(/whole numbers/);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it.each(['debug', 'info', 'warn', 'error'])('accepts the %s log level', (level) => {
    expect(loadConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('rejects a take-profit at or below the stop', () => {
    expect(() => loadConfig({ TAKE_PROFIT_PCT: '0.02', STOP_LOSS_PCT: '0.03' })).toThrow(/TAKE_PROFIT/);
  });

  it('trims surrounding whitespace on string settings', () => {
    expect(loadConfig({ SYMBOL: '  ETH/USDT  ' }).symbol).toBe('ETH/USDT');
  });

  it('accepts numeric overrides as well as strings', () => {
    const c = loadConfig({ SMA_FAST: 9, SMA_SLOW: 21 });
    expect(c.smaFast).toBe(9);
    expect(c.smaSlow).toBe(21);
  });
});

describe('printReport warning chain', () => {
  it('warns on a weak Sharpe with enough trades', () => {
    printReport(fakeResult({ sharpeRatio: 0.2 }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sharpe below 0.5'));
  });

  it('warns on an unh survivable drawdown', () => {
    printReport(fakeResult({ maxDrawdownPct: 0.5 }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('cannot hold through'));
  });

  it('stays silent when everything is healthy', () => {
    printReport(fakeResult({}));
    const out = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(out).not.toContain('⚠');
  });
});

describe('metrics defensive arms', () => {
  it('returns a zero return when the account starts empty', () => {
    expect(computeMetrics([], [{ timestamp: 0, equity: 10 }], 0).returnPct).toBe(0);
  });

  it('returns zero drawdown when the peak is zero', () => {
    expect(computeMetrics([], [{ timestamp: 0, equity: 0 }], 0).maxDrawdownPct).toBe(0);
  });

  it('skips return periods that open at zero equity', () => {
    const m = computeMetrics([], [
      { timestamp: 0, equity: 0 }, { timestamp: 1, equity: 100 }, { timestamp: 2, equity: 120 },
    ], 100);
    expect(Number.isFinite(m.sharpeRatio)).toBe(true);
  });

  it('handles a one-point and an empty curve', () => {
    expect(computeMetrics([], [{ timestamp: 0, equity: 1_000 }], 1_000).sharpeRatio).toBe(0);
    expect(computeMetrics([], [], 1_000).sharpeRatio).toBe(0);
  });
});

describe('risk manager guards', () => {
  it('returns zero for non-finite equity', () => {
    expect(new RiskManager(baseRisk, 10_000).drawdownPct(Number.NaN)).toBe(0);
  });

  it('returns zero drawdown when the peak is zero', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    (rm as unknown as { peakEquity: number }).peakEquity = 0;
    expect(rm.drawdownPct(500)).toBe(0);
  });

  it('ignores a non-finite or non-positive seed', () => {
    const rm = new RiskManager(baseRisk, 10_000);
    rm.seedPeak(Number.NaN);
    rm.seedPeak(0);
    rm.seedPeak(-100);
    expect(rm.stats.peakEquity).toBe(10_000);
  });

  it('exposes cooldown in its stats', () => {
    const rm = new RiskManager(baseRisk, 10_000, 3, 4);
    rm.recordClose(-1); rm.recordClose(-1); rm.recordClose(-1);
    expect(rm.stats.cooldown).toBe(4);
  });
});

describe('indicator guards', () => {
  it('skips holes in a sparse series', () => {
    const sparse = [1, 2, , 4, 5] as unknown as number[];
    expect(() => sma(sparse, 2)).not.toThrow();
    expect(() => rsi(sparse, 3)).not.toThrow();
  });

  it('returns all nulls when the period exceeds the series', () => {
    expect(sma([1, 2], 10).every((v) => v === null)).toBe(true);
  });
});

describe('strategy factory', () => {
  it('buildSma returns a primed instance', () => {
    const candles = synthCandles(120, { seed: 33 });
    const s = buildSma(candles, 5, 20);
    expect(s.onCandle(candles[candles.length - 1]!, candles).reason).not.toBe('warming up');
  });
});

describe('logger levels', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)('tags %s', (level) => {
    setLogLevel('debug');
    createLogger('scope')[level]('msg');
    expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toContain(level.toUpperCase());
  });
});

describe('backtest sample warning', () => {
  it('warns on a thin but non-zero sample', () => {
    let calls = 0;
    const sporadic = {
      name: 'sporadic',
      onCandle: () => {
        calls += 1;
        return calls % 7 === 0
          ? { side: 'long' as const, strength: 1, reason: 'enter' }
          : { side: 'flat' as const, strength: 0, reason: 'exit' };
      },
    };
    printReport(backtest(synthCandles(120, { seed: 4 }), sporadic, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    }));
    const out = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(out).toMatch(/statistically meaningless|Sharpe below|drawdown/);
  });
});
describe('backtest history semantics', () => {
  it('hands the strategy candles[0..i] on bar i', () => {
    // Growing one shared array must match what a slice would have produced.
    const lengths: number[] = [];
    let currentIsLast = false;
    const probe = {
      name: 'probe',
      init: () => undefined,
      onCandle: (c: Candle, h: Candle[]) => {
        lengths.push(h.length);
        currentIsLast = h[h.length - 1]?.timestamp === c.timestamp;
        return { side: 'flat' as const, strength: 0, reason: 'x' };
      },
    };
    const candles = synthCandles(30, { seed: 44 });
    backtest(candles, probe, { symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk });

    expect(lengths[0]).toBe(2);
    expect(lengths[1]).toBe(3);
    expect(lengths.at(-1)).toBe(candles.length);
    expect(currentIsLast).toBe(true);
  });

  it('stays linear on a large series', () => {
    const candles = synthCandles(200_000, { seed: 45 });
    const t0 = performance.now();
    backtest(candles, { name: 'x', init: () => undefined, onCandle: () => ({ side: 'flat' as const, strength: 0, reason: 'x' }) }, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    });
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
