/**
 * Backtest a strategy on any CCXT-supported exchange.
 *
 *   npx tsx examples/backtest.ts
 *   npx tsx examples/backtest.ts --symbol ETH/USDT --timeframe 4h --days 730
 *   npx tsx examples/backtest.ts --fast 9 --slow 21 --fee 0.002
 *   npx tsx examples/backtest.ts --trades true
 *
 * Flags:
 *   --exchange   kucoin | binance | bybit | okx | coinbase | kraken | ...
 *   --symbol     BTC/USDT
 *   --timeframe  1h | 4h | 1d
 *   --days       how much history to fetch (default 365)
 *   --fast       fast SMA window (default 20)
 *   --slow       slow SMA window (default 50)
 *   --fee        taker fee per side as a fraction, e.g. 0.001 (default 0.001)
 *   --capital    starting equity (default 10000)
 *   --trades     true to print every trade
 */
import { backtest, printReport } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { fetchHistory, buildStrategy } from '../src/index.js';
import { setLogLevel } from '../src/utils/logger.js';

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg?.startsWith('--')) {
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
}

const overrides: Record<string, string | number> = {};
const set = (key: string, env: string): void => {
  const v = flags[key];
  if (v !== undefined && v !== 'true') overrides[env] = v;
};

set('exchange', 'EXCHANGE_ID');
set('symbol', 'SYMBOL');
set('timeframe', 'TIMEFRAME');
set('days', 'BACKTEST_DAYS');
set('fast', 'SMA_FAST');
set('slow', 'SMA_SLOW');
set('fee', 'FEE_RATE');
set('capital', 'INITIAL_CAPITAL');

const config = loadConfig(overrides);
setLogLevel(config.logLevel);

const until = Date.now();
const since = until - config.backtestDays * 86_400_000;

console.log(
  `\nFetching ${config.backtestDays} days of ${config.symbol} ${config.timeframe} from ${config.exchangeId}…`,
);

const candles = await fetchHistory(
  config.exchangeId,
  config.symbol,
  config.timeframe,
  since,
  until,
);

if (candles.length < 100) {
  console.error(
    `\nOnly ${candles.length} candles returned. Try a shorter timeframe (--timeframe 4h) or a shorter window (--days 180).`,
  );
  process.exit(1);
}

console.log(`Got ${candles.length} candles. Running sma-crossover ${config.smaFast}/${config.smaSlow}…\n`);

const result = backtest(candles, buildStrategy(config, candles), {
  symbol: config.symbol,
  timeframe: config.timeframe,
  initialCapital: config.initialCapital,
  risk: config.risk,
  feeRate: config.feeRate,
});

printReport(result);

if (flags.trades === 'true' && result.trades.length > 0) {
  console.log('  Trades');
  console.log('  ' + '─'.repeat(84));
  for (const t of result.trades.slice(0, 30)) {
    const when = new Date(t.entryTime).toISOString().slice(0, 16).replace('T', ' ');
    const pnl = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`;
    console.log(
      `  ${when}  ${t.side.padEnd(5)} ${t.entryPrice.toFixed(2).padStart(10)} → ${t.exitPrice
        .toFixed(2)
        .padStart(10)}  ${pnl.padStart(9)}  ${t.reason}`,
    );
  }
  if (result.trades.length > 30) {
    console.log(`  … ${result.trades.length - 30} more`);
  }
  console.log('');
}