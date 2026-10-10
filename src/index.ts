import type { Candle, Strategy } from './types.js';
import { loadConfig, type BacktestConfig } from './config.js';
import { RiskManager } from './risk/manager.js';
import { backtest, printReport, type BacktestOptions } from './engine/backtest.js';
import { SmaCrossover } from './strategy/sma-crossover.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import ccxt, { type Exchange, type OHLCV } from 'ccxt';

export * from './types.js';
export { loadConfig, type BacktestConfig } from './config.js';
export { RiskManager } from './risk/manager.js';
export { backtest, printReport, type BacktestOptions } from './engine/backtest.js';
export { computeMetrics, formatReport } from './engine/metrics.js';
export { SmaCrossover } from './strategy/sma-crossover.js';
export { createLogger, setLogLevel } from './utils/logger.js';
export { sma, rsi } from './utils/indicators.js';

function toCandle(o: OHLCV): Candle {
  return {
    timestamp: o[0] as number,
    open: o[1] as number,
    high: o[2] as number,
    low: o[3] as number,
    close: o[4] as number,
    volume: o[5] as number,
  };
}

export function makeClient(exchangeId: string): Exchange {
  const ctor = (ccxt as unknown as Record<string, new (cfg: object) => Exchange>)[exchangeId];
  if (typeof ctor !== 'function') {
    throw new Error(`Unknown exchange "${exchangeId}". See https://github.com/ccxt/ccxt/wiki/ccxt.exchanges`);
  }
  return new ctor({ enableRateLimit: true, timeout: 20_000 });
}

export async function fetchHistory(
  exchangeId: string,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
): Promise<Candle[]> {
  const client = makeClient(exchangeId);
  const out: Candle[] = [];
  const step = client.parseTimeframe(timeframe) ?? 3_600_000;
  let cursor = since;

  while (cursor < until) {
    const batch = (await client.fetchOHLCV(symbol, timeframe, cursor, 500)) as OHLCV[];
    if (batch.length === 0) break;
    for (const o of batch) out.push(toCandle(o));
    const lastTs = batch[batch.length - 1]?.[0];
    if (typeof lastTs !== 'number' || lastTs <= cursor) break;
    cursor = lastTs + step;
    if (out.length > 200_000) break;
  }

  const deduped = new Map<number, Candle>();
  for (const c of out) if (c.timestamp >= since && c.timestamp <= until) deduped.set(c.timestamp, c);
  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function buildStrategy(config: BacktestConfig, history: Candle[]): Strategy {
  const strategy = new SmaCrossover({ fast: config.smaFast, slow: config.smaSlow });
  strategy.init(history);
  return strategy;
}

export async function runBacktest(config: BacktestConfig = loadConfig()): Promise<void> {
  setLogLevel(config.logLevel);
  const log = createLogger('run');

  const until = Date.now();
  const since = until - config.backtestDays * 86_400_000;

  log.info(`fetching ${config.backtestDays}d of ${config.symbol} ${config.timeframe} from ${config.exchangeId}…`);
  const candles = await fetchHistory(config.exchangeId, config.symbol, config.timeframe, since, until);

  if (candles.length < 100) {
    log.error(`only ${candles.length} candles — try a shorter timeframe or a longer window`);
    return;
  }
  log.info(`got ${candles.length} candles`);

  printReport(
    backtest(candles, buildStrategy(config, candles), {
      symbol: config.symbol,
      timeframe: config.timeframe,
      initialCapital: config.initialCapital,
      risk: config.risk,
      feeRate: config.feeRate,
    }),
  );
}

export { barsPerYear } from './engine/backtest.js';