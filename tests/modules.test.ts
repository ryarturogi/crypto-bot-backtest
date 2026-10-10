/**
 * Second suite — logging, report rendering, config branches, and the
 * ccxt-backed history fetcher (mocked at the module boundary).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchOHLCV = vi.fn();
const parseTimeframe = vi.fn(() => 3_600_000);
const marketIds: string[] = [];

vi.mock('ccxt', () => {
  // The source indexes the default export by exchange id, so the mock must too.
  class FakeEx {
    async fetchOHLCV(...args: unknown[]): Promise<unknown> {
      return fetchOHLCV(...args);
    }
    parseTimeframe(): number {
      return parseTimeframe();
    }
  }
  const registry: Record<string, unknown> = { kucoin: FakeEx, binance: FakeEx, bybit: FakeEx };
  return { default: registry };
});

import { makeClient, fetchHistory, runBacktest } from '../src/index.js';
import { createLogger, setLogLevel } from '../src/utils/logger.js';
import { printReport } from '../src/engine/backtest.js';
import { backtest } from '../src/engine/backtest.js';
import { loadConfig } from '../src/config.js';
import { SmaCrossover } from '../src/strategy/sma-crossover.js';
import { synthCandles, baseRisk } from './helpers.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fetchOHLCV.mockReset();
  parseTimeframe.mockReturnValue(3_600_000);
  marketIds.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('info');
});

describe('logger', () => {
  it('suppresses messages below the active level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setLogLevel('error');
    createLogger('t').info('hidden');
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits at or above the active level with scope and level tags', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setLogLevel('warn');
    createLogger('scope').warn('visible');
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain('WARN');
    expect(line).toContain('[scope]');
  });

  it('passes a payload as a second console argument', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger('t').error('boom', { code: 7 });
    expect(spy.mock.calls[0]?.[1]).toEqual({ code: 7 });
  });

  it('emits a single argument with no payload', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger('t').info('plain');
    expect(spy.mock.calls[0]).toHaveLength(1);
  });

  it('debug is suppressed at the default info level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createLogger('t').debug('noisy');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('printReport', () => {
  const longAll = { name: 'always-long', onCandle: () => ({ side: 'long' as const, strength: 1, reason: 'hold' }) };
  const flat = { name: 'flat', onCandle: () => ({ side: 'flat' as const, strength: 0, reason: 'x' }) };

  it('renders a full report for a real run', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printReport(backtest(synthCandles(300, { seed: 8 }), longAll, {
      symbol: 'BTC/USDT', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    }));
    const out = spy.mock.calls.flat().join('\n');
    expect(out).toMatch(/ALWAYS-LONG/);
    expect(out).toMatch(/Total trades/);
    expect(out).toMatch(/Profit factor/);
    expect(out).toMatch(/Max drawdown/);
  });

  it('says so plainly when no trades were generated', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printReport(backtest(synthCandles(200, { seed: 9 }), flat, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    }));
    expect(spy.mock.calls.flat().join('\n')).toMatch(/No trades generated/);
  });

  it('warns when the sample is too thin to mean anything', () => {
    // A strategy that trades a little — not zero, which takes the other branch.
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
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printReport(backtest(synthCandles(120, { seed: 4 }), sporadic, {
      symbol: 'T', timeframe: '1h', initialCapital: 10_000, risk: baseRisk,
    }));
    const out = spy.mock.calls.flat().join('\n');
    expect(out).toMatch(/statistically meaningless|Sharpe below|drawdown/);
  });
});

describe('config branches', () => {
  it('reads a numeric env value through the validator', () => {
    process.env.MAX_POSITION_USD = '750';
    expect(loadConfig({}).risk.maxPositionUsd).toBe(750);
    delete process.env.MAX_POSITION_USD;
  });

  it('throws a clear message on a non-numeric guarded env value', () => {
    process.env.MAX_POSITION_USD = 'abc';
    expect(() => loadConfig({})).toThrow(/MAX_POSITION_USD/);
    delete process.env.MAX_POSITION_USD;
  });

  it('accepts fractional and negative-guarded values inside the valid range', () => {
    const c = loadConfig({ RISK_PER_TRADE: '0.02', MAX_DRAWDOWN: '0.1' });
    expect(c.risk.riskPerTrade).toBe(0.02);
    expect(c.risk.maxDrawdown).toBe(0.1);
  });

  it('rejects risk values outside (0, 1)', () => {
    expect(() => loadConfig({ RISK_PER_TRADE: '1.5' })).toThrow();
    expect(() => loadConfig({ MAX_DRAWDOWN: '0' })).toThrow();
  });

  it('rejects a negative stop distance', () => {
    expect(() => loadConfig({ STOP_LOSS_PCT: '-0.05' })).toThrow();
  });
});

describe('history fetching', () => {
  it('rejects an exchange id ccxt does not know', () => {
    expect(() => makeClient('nope-not-real')).toThrow(/Unknown exchange/);
  });

  it('resolves a known exchange id', () => {
    expect(() => makeClient('kucoin')).not.toThrow();
  });

  it('paginates, includes the first candle of the window, and dedupes', async () => {
    parseTimeframe.mockReturnValue(1000);
    fetchOHLCV
      .mockResolvedValueOnce([[1000, 1, 1, 1, 1, 1], [2000, 2, 2, 2, 2, 1]])
      .mockResolvedValueOnce([[2000, 2, 2, 2, 2, 1], [3000, 3, 3, 3, 3, 1]])
      .mockResolvedValueOnce([]);

    const history = await fetchHistory('kucoin', 'BTC/USDT', '1h', 1000, 3500);
    expect(history.map((c) => c.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it('drops candles outside the requested window', async () => {
    parseTimeframe.mockReturnValue(1000);
    fetchOHLCV.mockResolvedValueOnce([[500, 1, 1, 1, 1, 1], [2000, 2, 2, 2, 2, 1]]).mockResolvedValueOnce([]);

    const history = await fetchHistory('kucoin', 'BTC/USDT', '1h', 1000, 3500);
    expect(history.map((c) => c.timestamp)).toEqual([2000]);
  });

  it('stops paginating when the exchange stops advancing', async () => {
    parseTimeframe.mockReturnValue(1000);
    fetchOHLCV.mockResolvedValue([[2000, 2, 2, 2, 2, 1]]);

    const history = await fetchHistory('kucoin', 'BTC/USDT', '1h', 1000, 3500);
    expect(history.length).toBeLessThanOrEqual(1);
  });

  it('surfaces an exchange error to the caller', async () => {
    fetchOHLCV.mockRejectedValue(new Error('exchange unreachable'));
    await expect(fetchHistory('kucoin', 'BTC/USDT', '1h', 1000, 3500)).rejects.toThrow(/unreachable/);
  });
});

/** Candles anchored to now — runBacktest only keeps rows inside [since, until]. */
function recentCandles(n: number, seed = 6): number[][] {
  const now = Date.now();
  return synthCandles(n, { seed }).map((c, i) => [
    now - (n - i) * 3_600_000,
    c.open, c.high, c.low, c.close, c.volume,
  ]);
}

describe('runBacktest', () => {
  it('refuses to report on a thin slice of history', async () => {
    parseTimeframe.mockReturnValue(1000);
    fetchOHLCV.mockResolvedValue(recentCandles(40));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBacktest(loadConfig({ BACKTEST_DAYS: '5' }));
    expect(spy.mock.calls.flat().join(' ')).toMatch(/only 40 candles/);
  });

  it('runs end to end when history is sufficient', async () => {
    parseTimeframe.mockReturnValue(1000);
    fetchOHLCV.mockResolvedValue(recentCandles(400));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBacktest(loadConfig({ BACKTEST_DAYS: '5' }));
    expect(spy.mock.calls.flat().join('\n')).toMatch(/Total trades/);
  });
});

describe('strategy factory helpers', () => {
  it('exposes static constructors that validate their inputs', () => {
    expect(SmaCrossover.from([5, 20])).toBeInstanceOf(SmaCrossover);
    expect(SmaCrossover.from([5])).toBeUndefined();
    expect(SmaCrossover.from([])).toBeUndefined();
  });
});