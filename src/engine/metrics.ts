import type { PerformanceMetrics, Trade } from '../types.js';

export function computeMetrics(
  trades: Trade[],
  equityCurve: Array<{ timestamp: number; equity: number }>,
  initialCapital: number,
  /** Bars per year for the timeframe these samples came from. Drives the Sharpe annualisation. */
  barsPerYear = 365,
): PerformanceMetrics {
  // Filter on the reason, not the timestamp. An exit at t=0 is still a closed
  // trade; filtering on exitTime silently deleted real P&L from the report.
  const closed = trades.filter((t) => t.reason.length > 0 && Number.isFinite(t.pnl));
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const finalCapital = initialCapital + totalPnl;

  let maxDrawdownPct = 0;
  let peak = initialCapital;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    if (peak > 0) {
      const dd = (peak - pt.equity) / peak;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const periodReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    const cur = equityCurve[i];
    if (prev && cur && prev.equity > 0) periodReturns.push((cur.equity - prev.equity) / prev.equity);
  }
  const mean = periodReturns.length ? periodReturns.reduce((s, r) => s + r, 0) / periodReturns.length : 0;
  const variance =
    periodReturns.length > 1
      ? periodReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (periodReturns.length - 1)
      : 0;
  const sd = Math.sqrt(variance);
  // Annualise by the actual sampling rate of this series. Hardcoding sqrt(365) made
  // the same equity curve report a 5x lower Sharpe on 1h data than on daily.
  const sharpe = sd === 0 ? 0 : (mean / sd) * Math.sqrt(barsPerYear);

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Reduce instead of Math.max(...array): spreading ~100k elements overflows the stack.
  const pnls = closed.map((t) => t.pnl);
  const largestWin = pnls.reduce((m, v) => (v > m ? v : m), 0);
  const largestLoss = pnls.reduce((m, v) => (v < m ? v : m), 0);

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    totalPnl,
    returnPct: initialCapital > 0 ? totalPnl / initialCapital : 0,
    maxDrawdownPct,
    sharpeRatio: sharpe,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    largestWin,
    largestLoss,
    avgHoldMs: closed.length ? closed.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / closed.length : 0,
  };
}

const MS_DAY = 86_400_000;

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const d = Math.floor(ms / MS_DAY);
  const h = Math.floor((ms % MS_DAY) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatReport(metrics: PerformanceMetrics, initialCapital: number): string {
  const pf = metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2);
  const rows: Array<[string, string]> = [
    ['Total trades', String(metrics.totalTrades)],
    ['Win rate', `${(metrics.winRate * 100).toFixed(1)}%  (${metrics.wins}W / ${metrics.losses}L)`],
    ['Net P&L', `${metrics.totalPnl >= 0 ? '+' : ''}${metrics.totalPnl.toFixed(2)} USDT  (${(metrics.returnPct * 100).toFixed(2)}%)`],
    ['Final equity', `${(initialCapital + metrics.totalPnl).toFixed(2)} USDT`],
    ['Profit factor', pf],
    ['Max drawdown', `${(metrics.maxDrawdownPct * 100).toFixed(2)}%`],
    ['Sharpe (ann.)', metrics.sharpeRatio.toFixed(2)],
    ['Avg win', `${metrics.avgWin.toFixed(2)}`],
    ['Avg loss', `${metrics.avgLoss.toFixed(2)}`],
    ['Largest win', `+${metrics.largestWin.toFixed(2)}`],
    ['Largest loss', `${metrics.largestLoss.toFixed(2)}`],
    ['Avg hold', fmtDuration(metrics.avgHoldMs)],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
}