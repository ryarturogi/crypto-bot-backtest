import { backtest, printReport, RiskManager, SmaCrossover } from '../src/index.js';
import { computeMetrics } from '../src/engine/metrics.js';
import type { Candle } from '../src/types.js';

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
}

function approx(actual: number, expected: number, eps = 1e-9): boolean {
  return Math.abs(actual - expected) <= eps;
}

function synthCandles(n: number, seed = 42): Candle[] {
  let s = seed;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  let price = 50000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.48) * 900;
    price = Math.max(1000, price + drift);
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

const risk = {
  riskPerTrade: 0.01,
  maxPositionUsd: 500,
  maxDrawdown: 0.2,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  maxOpenTrades: 3,
};

console.log('\ncrypto-bot-backtest smoke tests\n');

const candles = synthCandles(1500);

const sma = new SmaCrossover({ fast: 20, slow: 50 });
sma.init(candles);
const signal = sma.onCandle(candles[candles.length - 1]!, candles);
assert(signal.side !== undefined, 'SMA strategy returns a signal');
assert(signal.strength >= 0 && signal.strength <= 1, 'signal strength is bounded 0..1');

let threw = false;
try {
  new SmaCrossover({ fast: 50, slow: 20 });
} catch {
  threw = true;
}
assert(threw, 'SmaCrossover rejects fast >= slow');

const rm = new RiskManager(risk, 10_000);
assert(approx(rm.sizePosition(10_000, 50_000), 0.01, 1e-12), 'position sizing caps at MAX_POSITION_USD');
assert(
  approx(new RiskManager({ ...risk, maxPositionUsd: 100_000 }, 10_000).sizePosition(10_000, 50_000), 0.06666666666666667, 1e-12),
  'risk sizing = equity × riskPerTrade ÷ stopPct ÷ price',
);
assert(approx(rm.stopsFor(100).stopLoss, 97, 1e-9), 'stop loss is 3% below entry');
assert(approx(rm.stopsFor(100).takeProfit, 106, 1e-9), 'take profit is 6% above entry');

rm.recordClose(-50);
rm.recordClose(-50);
rm.recordClose(-50);
assert(!rm.canOpen(10_000, 0).allowed, 'circuit breaker trips after 3 consecutive losses');
assert(!new RiskManager(risk, 10_000).canOpen(10_000, 3).allowed, 'max open trades is enforced');

const result = backtest(candles, sma, {
  symbol: 'TEST/USDT',
  timeframe: '1h',
  initialCapital: 10_000,
  risk,
});

assert(result.equityCurve.length > 0, 'backtest produces an equity curve');
assert(Number.isFinite(result.metrics.totalPnl), 'total P&L is finite (no NaN)');
assert(result.metrics.maxDrawdownPct >= 0, 'max drawdown is non-negative');
assert(result.metrics.winRate >= 0 && result.metrics.winRate <= 1, 'win rate within 0..1');
assert(result.trades.every((t) => t.exitPrice > 0), 'every trade has an exit price');
assert(
  result.trades.every((t) => Number.isFinite(t.pnl) && Number.isFinite(t.entryPrice) && Number.isFinite(t.exitPrice)),
  'no NaN in trade records',
);

const empty = computeMetrics([], [], 10_000);
assert(empty.totalTrades === 0 && empty.profitFactor === 0, 'empty backtest is handled without throwing');

let shortThrew = false;
try {
  backtest(candles.slice(0, 2), sma, { symbol: 'T', timeframe: '1h', initialCapital: 1000, risk });
} catch {
  shortThrew = true;
}
assert(shortThrew, 'backtest rejects fewer than 3 candles');

console.log('\nAll smoke tests passed.\n');
printReport(result);