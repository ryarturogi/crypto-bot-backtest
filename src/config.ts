import 'dotenv/config';
import type { RiskConfig } from './types.js';
import type { LogLevel } from './utils/logger.js';

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

/**
 * Reads a setting and refuses to hand back NaN.
 *
 * `Number('abc')` is NaN, and a NaN that reaches position sizing produces a
 * zero-trade run that looks like a strategy problem rather than a typo.
 */
function num(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; int?: boolean; raw?: string } = {},
): number {
  const source = opts.raw ?? process.env[name];
  const raw = source;
  if (raw === undefined || String(raw).trim() === '') return fallback;

  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number — got "${raw}"`);
  }
  if (opts.int && !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number — got "${raw}"`);
  }
  if (opts.min !== undefined && value <= opts.min) {
    throw new Error(`${name} must be greater than ${opts.min} — got "${raw}"`);
  }
  if (opts.max !== undefined && value >= opts.max) {
    throw new Error(`${name} must be less than ${opts.max} — got "${raw}"`);
  }
  return value;
}

export interface BacktestConfig {
  exchangeId: string;
  symbol: string;
  timeframe: string;
  smaFast: number;
  smaSlow: number;
  risk: RiskConfig;
  backtestDays: number;
  initialCapital: number;
  feeRate: number;
  logLevel: LogLevel;
}

export function loadConfig(overrides: Record<string, string | number> = {}): BacktestConfig {
  const get = (key: string, fallback: string): string => {
    const v = overrides[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
    return process.env[key] ?? fallback;
  };

  const smaFast = Number(get('SMA_FAST', '20'));
  const smaSlow = Number(get('SMA_SLOW', '50'));
  if (!Number.isInteger(smaFast) || !Number.isInteger(smaSlow)) {
    throw new Error(`SMA_FAST and SMA_SLOW must be whole numbers — got "${get('SMA_FAST', '20')}" / "${get('SMA_SLOW', '50')}"`);
  }
  if (smaFast >= smaSlow) throw new Error('SMA_FAST must be less than SMA_SLOW');

  const logLevel = get('LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} — got "${logLevel}"`);
  }

  // `raw` routes CLI flags through the same validation as .env, so a flag
  // cannot slip past the range checks.
  const risk: RiskConfig = {
    riskPerTrade: num('RISK_PER_TRADE', 0.01, { min: 0, max: 1, raw: get('RISK_PER_TRADE', '0.01') }),
    maxPositionUsd: num('MAX_POSITION_USD', 500, { min: 0, raw: get('MAX_POSITION_USD', '500') }),
    maxDrawdown: num('MAX_DRAWDOWN', 0.2, { min: 0, max: 1, raw: get('MAX_DRAWDOWN', '0.2') }),
    stopLossPct: num('STOP_LOSS_PCT', 0.03, { min: 0, max: 1, raw: get('STOP_LOSS_PCT', '0.03') }),
    takeProfitPct: num('TAKE_PROFIT_PCT', 0.06, { min: 0, max: 1, raw: get('TAKE_PROFIT_PCT', '0.06') }),
    maxOpenTrades: num('MAX_OPEN_TRADES', 3, { min: 0, int: true, raw: get('MAX_OPEN_TRADES', '3') }),
  };

  // num() already rejects NaN and out-of-range values for every entry above,
  // so this loop only re-checks what cannot happen.
  for (const key of ['riskPerTrade', 'maxDrawdown', 'stopLossPct', 'takeProfitPct'] as const) {
    const v = risk[key];
    if (v <= 0 || v >= 1) throw new Error(`${key} must be between 0 and 1 — got ${v}`);
  }
  if (risk.takeProfitPct <= risk.stopLossPct) {
    throw new Error('TAKE_PROFIT_PCT must be greater than STOP_LOSS_PCT');
  }

  return {
    exchangeId: get('EXCHANGE_ID', 'kucoin'),
    symbol: get('SYMBOL', 'BTC/USDT'),
    timeframe: get('TIMEFRAME', '1h'),
    smaFast,
    smaSlow,
    risk,
    backtestDays: num('BACKTEST_DAYS', 365, { min: 0, int: true, raw: get('BACKTEST_DAYS', '365') }),
    initialCapital: num('INITIAL_CAPITAL', 10_000, { min: 0, raw: get('INITIAL_CAPITAL', '10000') }),
    feeRate: num('FEE_RATE', 0.001, { min: 0, max: 1, raw: get('FEE_RATE', '0.001') }),
    logLevel: logLevel as LogLevel,
  };
}