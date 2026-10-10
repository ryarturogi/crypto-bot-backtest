import type { RiskConfig } from '../types.js';
import { clamp } from '../utils/indicators.js';

/**
 * Position sizing and portfolio guards.
 * Every engine routes through this — it is the only place that decides how much to risk.
 */
export class RiskManager {
  private peakEquity: number;
  private tradeCount = 0;
  private consecutiveLosses = 0;
  private cooldown = 0;

  constructor(
    private readonly config: RiskConfig,
    initialCapital: number,
    private readonly lossLimit = 3,
    private readonly cooldownSignals = 5,
  ) {
    this.peakEquity = initialCapital;
  }

  /**
   * Re-base the drawdown high-water mark on a real account balance.
   * Without this, a $500 account against a config seeded with $10,000 is treated as
   * a 95% drawdown and blocked from ever trading again.
   */
  seedPeak(equity: number): void {
    if (Number.isFinite(equity) && equity > 0) this.peakEquity = equity;
  }

  /**
   * Size a position from risk-per-trade and the distance to stop loss.
   * riskPerTrade 0.01 means "lose 1% of equity if stopped out".
   */
  sizePosition(equity: number, price: number): number {
    if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(price) || price <= 0) return 0;
    const maxByRisk = (equity * this.config.riskPerTrade) / this.config.stopLossPct;
    const maxByCap = this.config.maxPositionUsd;
    const usd = Math.min(maxByRisk, maxByCap);
    const qty = usd / price;
    return clamp(qty, 0, Number.MAX_SAFE_INTEGER);
  }

  stopsFor(entryPrice: number): { stopLoss: number; takeProfit: number } {
    return {
      stopLoss: entryPrice * (1 - this.config.stopLossPct),
      takeProfit: entryPrice * (1 + this.config.takeProfitPct),
    };
  }

  /**
   * Returns true if a new position is allowed right now.
   *
   * NOTE: while the circuit breaker is cooling down this call decrements the cooldown,
   * so callers must invoke it at most once per decision point.
   */
  canOpen(equity: number, openPositions: number): { allowed: boolean; reason: string } {
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return { allowed: false, reason: `circuit breaker cooling down (${this.cooldown} more signals)` };
    }
    if (openPositions >= this.config.maxOpenTrades) {
      return { allowed: false, reason: `max open trades (${this.config.maxOpenTrades}) reached` };
    }
    const dd = this.drawdownPct(equity);
    if (dd >= this.config.maxDrawdown) {
      return { allowed: false, reason: `max drawdown breached (${(dd * 100).toFixed(1)}%)` };
    }
    return { allowed: true, reason: 'ok' };
  }

  drawdownPct(equity: number): number {
    if (!Number.isFinite(equity)) return 0;
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity <= 0) return 0;
    return (this.peakEquity - equity) / this.peakEquity;
  }

  /**
   * Call on every closed trade so the circuit breaker stays accurate.
   * Trips after `lossLimit` consecutive losses and then cools down for
   * `cooldownSignals` decisions, so a bad streak pauses trading instead of
   * latching it off permanently.
   */
  recordClose(pnl: number): void {
    this.tradeCount += 1;
    if (pnl < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.lossLimit) {
        this.consecutiveLosses = 0;
        this.cooldown = this.cooldownSignals;
      }
    } else {
      this.consecutiveLosses = 0;
    }
  }

  get stats(): { trades: number; consecutiveLosses: number; cooldown: number; peakEquity: number } {
    return {
      trades: this.tradeCount,
      consecutiveLosses: this.consecutiveLosses,
      cooldown: this.cooldown,
      peakEquity: this.peakEquity,
    };
  }
}