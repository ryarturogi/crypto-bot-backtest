#!/usr/bin/env node
import { loadConfig, runBacktest } from './index.js';
import { fetchHistory, makeClient } from './index.js';
import { setLogLevel } from './utils/logger.js';

const USAGE = `
crypto-bot-backtest — backtest crypto strategies on 100+ exchanges

Usage:
  cbb backtest [days]      Run a backtest over N days (default: 365)
  cbb doctor               Check config and exchange connectivity

Environment (see .env.example):
  EXCHANGE_ID, SYMBOL, TIMEFRAME, SMA_FAST, SMA_SLOW,
  RISK_PER_TRADE, STOP_LOSS_PCT, TAKE_PROFIT_PCT, MAX_DRAWDOWN, INITIAL_CAPITAL, FEE_RATE
`;

async function doctor(): Promise<void> {
  const config = loadConfig();
  console.log('  config OK');
  console.log(`  exchange  ${config.exchangeId}`);
  console.log(`  symbol    ${config.symbol} ${config.timeframe}`);
  console.log(`  strategy  sma-crossover ${config.smaFast}/${config.smaSlow}`);
  console.log(`  risk      ${(config.risk.riskPerTrade * 100).toFixed(2)}% per trade, SL ${(config.risk.stopLossPct * 100).toFixed(1)}%`);
  const client = makeClient(config.exchangeId);
  const candles = await client.fetchOHLCV(config.symbol, config.timeframe, undefined, 5);
  console.log(`  reachable — last close ${candles[candles.length - 1]?.[4]}`);
}

async function main(): Promise<void> {
  const [command = 'backtest', arg] = process.argv.slice(2);
  setLogLevel('info');

  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'doctor') {
    await doctor();
    return;
  }
  if (command !== 'backtest') {
    console.error(`Unknown command "${command}"\n${USAGE}`);
    process.exit(1);
  }

  const overrides: Record<string, string | number> = {};
  if (arg && !Number.isNaN(Number(arg))) overrides.BACKTEST_DAYS = Number(arg);
  await runBacktest(loadConfig(overrides));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});