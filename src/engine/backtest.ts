import type {
  BacktestResult,
  Candle,
  Position,
  RiskConfig,
  Strategy,
  Trade,
} from '../types.js';
import { RiskManager } from '../risk/manager.js';
import { computeMetrics, formatReport } from './metrics.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('backtest');

/** Bars per year for a CCXT timeframe string. Used to annualise Sharpe correctly. */
export function barsPerYear(timeframe: string): number {
  const match = /^(\d+)([mhdwM])$/.exec(timeframe.trim());
  if (!match) return 365;
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return 365;
  // Bars in a single day for a ONE-unit candle of that width. A 15m candle is
  // 1440/15 bars per day, not 15*1440.
  const perDayForUnit: Record<string, number> = { m: 1440, h: 24, d: 1, w: 1 / 7, M: 1 / 30 };
  const perDay = perDayForUnit[match[2] as string];
  if (perDay === undefined) return 365;
  return (perDay / size) * 365;
}

export interface BacktestOptions {
  symbol: string;
  timeframe: string;
  initialCapital: number;
  risk: RiskConfig;
  /** Taker fee as a fraction, e.g. 0.001 for 0.1%. */
  feeRate?: number;
  /** Force-close any open position on the final candle. */
  closeAtEnd?: boolean;
}

/**
 * Event-driven backtester. One decision per closed candle; intrabar stops are
 * evaluated conservatively (stop before target if the bar spans both).
 */
export function backtest(candles: Candle[], strategy: Strategy, opts: BacktestOptions): BacktestResult {
  if (candles.length < 3) throw new Error('Need at least 3 candles');

  // A caller passing a fresh strategy should not have to remember init().
  strategy.init?.(candles);

  const feeRate = opts.feeRate ?? 0.001;
  const risk = new RiskManager(opts.risk, opts.initialCapital);

  let equity = opts.initialCapital;
  // Seed with the first candle so that on bar i the history is candles[0..i],
  // matching what a slicing implementation would have handed the strategy.
  const history: Candle[] = candles[0] ? [candles[0]] : [];
  let cooldownBars = 0;
  let haltedAt: number | undefined;
  const trades: Trade[] = [];
  const equityCurve: Array<{ timestamp: number; equity: number }> = [];
  let position: Position | null = null;

  const closePosition = (price: number, time: number, reason: string): void => {
    if (!position) return;
    const gross = (price - position.entryPrice) * position.quantity;
    const fees = position.entryPrice * position.quantity * feeRate + price * position.quantity * feeRate;
    const pnl = gross - fees;
    equity += pnl;
    trades.push({
      side: position.side,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      exitTime: time,
      exitPrice: price,
      quantity: position.quantity,
      pnl,
      pnlPct: position.entryPrice > 0 ? (price - position.entryPrice) / position.entryPrice : 0,
      fees,
      reason,
    });
    risk.recordClose(pnl);
    position = null;
  };

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const prev = candles[i - 1];
    if (!candle || !prev) continue;

    // Grow one shared history array instead of re-slicing the whole series each
    // bar: slicing made the loop O(n²) — 23s at 200k candles.
    history.push(candle);

    // 1. Manage the open position against this bar's range.
    if (position) {
      const { stopLoss, takeProfit } = position;
      if (stopLoss !== undefined && candle.low <= stopLoss) {
        closePosition(stopLoss, candle.timestamp, 'stop loss');
        cooldownBars = 3;
      } else if (takeProfit !== undefined && candle.high >= takeProfit) {
        closePosition(takeProfit, candle.timestamp, 'take profit');
        cooldownBars = 0;
      }
    }

    // 2. Ask the strategy for a signal.
    const signal = strategy.onCandle(candle, history);

    if (position && signal.side === 'flat') {
      closePosition(candle.close, candle.timestamp, signal.reason);
    } else if (!position && signal.side === 'long' && cooldownBars === 0) {
      const gate = risk.canOpen(equity, 0);
      if (gate.allowed) {
        const qty = risk.sizePosition(equity, candle.close);
        if (qty > 0) {
          const { stopLoss, takeProfit } = risk.stopsFor(candle.close);
          // Entry fee is charged once, inside closePosition's round-trip `fees`.
          // Deducting it here as well made internal equity disagree with reported P&L.
          position = {
            side: 'long',
            entryPrice: candle.close,
            quantity: qty,
            entryTime: candle.timestamp,
            stopLoss,
            takeProfit,
          };
        }
      }
    } else if (cooldownBars > 0) {
      cooldownBars -= 1;
    }

    // Mark the open position to market before recording the curve point. Without
    // this, unrealised P&L is invisible and a -55% collapse reports 0% drawdown.
    const markPrice = candle.close;
    equityCurve.push({
      timestamp: candle.timestamp,
      equity: equity + (position ? (markPrice - position.entryPrice) * position.quantity : 0),
    });

    if (risk.drawdownPct(equity + (position ? (markPrice - position.entryPrice) * position.quantity : 0)) >= opts.risk.maxDrawdown) {
      log.warn(`max drawdown breached at ${new Date(candle.timestamp).toISOString()} — flattening`);
      closePosition(candle.close, candle.timestamp, 'max drawdown');
      haltedAt = candle.timestamp;
      break;
    }
  }

  if (opts.closeAtEnd !== false && position) {
    const last = candles[candles.length - 1];
    if (last) closePosition(last.close, last.timestamp, 'end of backtest');
  }

  const first = candles[0];
  const endTime = haltedAt ?? candles[candles.length - 1]?.timestamp ?? 0;
  const metrics = computeMetrics(trades, equityCurve, opts.initialCapital, barsPerYear(opts.timeframe));

  return {
    strategy: strategy.name,
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    startTime: first?.timestamp ?? 0,
    endTime,
    initialCapital: opts.initialCapital,
    finalCapital: opts.initialCapital + metrics.totalPnl,
    metrics,
    trades,
    equityCurve,
  };
}

export function printReport(result: BacktestResult): void {
  const start = new Date(result.startTime).toISOString().slice(0, 10);
  const end = new Date(result.endTime).toISOString().slice(0, 10);
  const m = result.metrics;

  console.log('\n' + '═'.repeat(56));
  console.log(`  ${result.strategy.toUpperCase()}  ·  ${result.symbol} ${result.timeframe}`);
  console.log(`  ${start} → ${end}`);
  console.log('═'.repeat(56));
  console.log(formatReport(m, result.initialCapital));
  console.log('═'.repeat(56));

  if (m.totalTrades === 0) {
    console.log('  No trades generated. Widen the SMA window or loosen the filters.');
  } else if (m.totalTrades < 30) {
    console.log(`  ⚠ Only ${m.totalTrades} trades — statistically meaningless. Extend the date range.`);
  } else if (m.sharpeRatio < 0.5) {
    console.log('  ⚠ Sharpe below 0.5 — this edge likely does not survive fees and slippage.');
  } else if (m.maxDrawdownPct > 0.25) {
    console.log(`  ⚠ ${(m.maxDrawdownPct * 100).toFixed(0)}% drawdown — most people cannot hold through that.`);
  }
  console.log('─'.repeat(56) + '\n');
}