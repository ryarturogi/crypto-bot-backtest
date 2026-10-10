/**
 * Core domain types. Everything else in the kit speaks these.
 */

export type Side = 'long' | 'short' | 'flat';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  side: Side;
  strength: number;
  reason: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface StrategyDecision {
  /** What the strategy asked for on this bar. */
  signal: Side;
  /** True when the engine is in a long position as a result of that signal. */
  inPosition: boolean;
}

export interface Strategy {
  readonly name: string;
  /** Called once before the loop starts, and again when the rolling buffer changes. */
  init?(candles: Candle[]): void;
  /** Return a Signal for the given candle. Called once per closed candle. */
  onCandle(candle: Candle, history: Candle[]): Signal;
  /**
   * Optional. Called after the engine acts on a signal.
   *
   * A strategy that tracks "am I long?" must not assume its own signal was
   * honoured — the risk manager can refuse the entry, in which case believing
   * otherwise makes it retry every bar forever.
   */
  onDecision?(decision: StrategyDecision): void;
}

export interface Position {
  side: Side;
  entryPrice: number;
  quantity: number;
  entryTime: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface RiskConfig {
  riskPerTrade: number;
  maxPositionUsd: number;
  maxDrawdown: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxOpenTrades: number;
}

export interface Trade {
  side: Side;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  reason: string;
}

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldMs: number;
}

export interface BacktestResult {
  strategy: string;
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  initialCapital: number;
  finalCapital: number;
  metrics: PerformanceMetrics;
  trades: Trade[];
  equityCurve: Array<{ timestamp: number; equity: number }>;
}