# crypto-bot-backtest

[![CI](https://github.com/ryarturogi/crypto-bot-backtest/actions/workflows/ci.yml/badge.svg)](https://github.com/ryarturogi/crypto-bot-backtest/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-104%20unit-5FA04E)](examples/smoke.ts)

**Backtest crypto strategies on 100+ exchanges.** Real fees, intrabar stops, Sharpe ratio, max drawdown. TypeScript, MIT, zero API keys required.

```bash
npm install
npx tsx examples/backtest.ts --symbol BTC/USDT --timeframe 1h --days 365
```

That downloads real history from KuCoin and prints a full performance report in about 10 seconds.

```
════════════════════════════════════════════════════════
  SMA-CROSSOVER  ·  BTC/USDT 1h
  2025-10-10 → 2026-10-10
════════════════════════════════════════════════════════
  Total trades   112
  Win rate       34.8%  (39W / 73L)
  Net P&L        -93.07 USDT  (-0.93%)
  Final equity   9906.93 USDT
  Profit factor  0.84
  Max drawdown   1.69%
  Sharpe (ann.)  -0.65
  Avg win        12.61
  Avg loss       8.01
  Largest win    +28.97
  Largest loss   -15.99
  Avg hold       1d 13h
════════════════════════════════════════════════════════
  ⚠ Sharpe below 0.5 — this edge likely does not survive fees and slippage.
────────────────────────────────────────────────────────
```

Captured verbatim from a real run. It is not the best-looking number we
could have picked, which is the point: **a backtester that tells you your
idea does not work is worth more than one that flatters you.**

**That is real output, not marketing.** The bundled SMA crossover
loses 0.94% over the last year on BTC/USDT after fees. We left it
in rather than tuning parameters until the screenshot looked good.
A backtester that tells you your idea does not work is worth more
than one that flatters you.

That last line is the point. **This tool tells you when a result is not worth trading** instead of letting you act on it.

---

## Why this exists

Most backtesting tutorials hand you a loop over some candles and print a profit number. That approach has three problems, and all three are fixable.

**1. Nobody models costs honestly.** A backtest that ignores fees will show you a 300% return on a strategy that loses money live. This one charges fees on entry *and* exit, configurable per venue.

**2. Stops are evaluated wrong.** Most backtesters check stops only at the close of a candle. In reality price pierces a stop intrabar. This one evaluates high/low within the bar and assumes the worse of stop-first, target-first.

**3. Nobody warns you about sample size.** Nine trades is not a backtest, it's a coincidence. The report flags it, flags a Sharpe below 0.5, and flags a drawdown that would put most people out of the position.

---

## Features

| | |
|---|---|
| **52 exchanges** | ccxt exposes 104 ids; 52 return public OHLCV keyless — KuCoin, Binance, Bybit, OKX, Coinbase, Kraken, Bitget, Gate |
| **Real backtester** | Fees on both sides, intrabar stops, equity curve |
| **12 metrics** | Sharpe, max drawdown, profit factor, avg win/loss, avg hold time |
| **Risk manager** | Position sizing from a risk budget, max drawdown, 3-loss circuit breaker |
| **Extensible** | `Strategy` is one interface. Add yours in 20 lines |
| **Typed** | Strict TypeScript with full `.d.ts` declarations |
| **Tested** | 106 tests · 100% line and function coverage · thresholds enforced on every run |
| **CLI** | `cbb backtest`, `cbb doctor` (run `npm run build` first) |

---

## Install

Requires Node 24.22.1+.

```bash
git clone <repo-url>
cd crypto-bot-backtest
npm install
```

No `.env` required. Defaults work out of the box.

---

## Usage

```bash
# Default: BTC/USDT 1h, 365 days, SMA 20/50
npx tsx examples/backtest.ts

# Different pair and timeframe
npx tsx examples/backtest.ts --symbol ETH/USDT --timeframe 4h --days 730

# Tighter crossovers
npx tsx examples/backtest.ts --fast 9 --slow 21

# Double the fee rate — does the edge survive?
npx tsx examples/backtest.ts --fee 0.002

# Print every trade
npx tsx examples/backtest.ts --trades true

# Check connectivity before you trust it
npx tsx src/cli.ts doctor
```

**Flags:** `--exchange` `--symbol` `--timeframe` `--days` `--fast` `--slow` `--fee` `--capital` `--trades`

---

## Configuration

Everything is optional — these are the defaults. Set them as env vars or CLI flags.

| Variable | Default | Meaning |
|---|---|---|
| `EXCHANGE_ID` | `kucoin` | Any CCXT exchange id |
| `SYMBOL` | `BTC/USDT` | Pair |
| `TIMEFRAME` | `1h` | Candle size |
| `SMA_FAST` / `SMA_SLOW` | `20` / `50` | Crossover windows |
| `RISK_PER_TRADE` | `0.01` | Fraction of equity risked per position |
| `STOP_LOSS_PCT` | `0.03` | Stop distance |
| `TAKE_PROFIT_PCT` | `0.06` | Target distance |
| `MAX_POSITION_USD` | `500` | Notional cap per position |
| `MAX_DRAWDOWN` | `0.20` | Trading halts when breached |
| `INITIAL_CAPITAL` | `10000` | Starting equity |
| `FEE_RATE` | `0.001` | Taker fee per side, fraction |

---

## Position sizing

You set a risk budget. The manager derives position size. You never hand-type a quantity.

```
risk budget     = equity × riskPerTrade      = 10000 × 0.01 = $100
notional allowed= risk budget ÷ stopPct       = 100 ÷ 0.03    = $3,333
capped at       = MAX_POSITION_USD                           = $500
quantity        = notional ÷ price                            = 0.006 BTC @ 83k
```

Change `RISK_PER_TRADE` and everything downstream follows. That is the whole point.

---

## Writing your own strategy

```ts
// Inside this repo use the relative path below. If you have installed the
// package from npm, import from 'crypto-bot-backtest' instead.
import type { Candle, Signal, Strategy } from '../src/index.js';
import { sma } from '../src/index.js';

export class BollingerBreakout implements Strategy {
  readonly name = 'bollinger-breakout';
  private mean: Array<number | null> = [];

  init(candles: Candle[]): void {
    this.mean = sma(candles.map(c => c.close), 20);
  }

  onCandle(candle: Candle, history: Candle[]): Signal {
    const i = history.length - 1;
    const ma = this.mean[i];

    if (typeof ma !== 'number') return { side: 'flat', strength: 0, reason: 'warming up' };

    if (candle.close > ma) {
      return { side: 'long', strength: 1, reason: 'broke above 20-period mean' };
    }
    return { side: 'flat', strength: 0.3, reason: 'below mean' };
  }
}
```

Pass it to `backtest(candles, myStrategy, options)`. Position sizing, stops, and the circuit breaker are inherited for free — the risk manager is separate from the strategy by design.

---

## Reading the metrics honestly

| Metric | What it actually tells you |
|---|---|
| **Win rate** | Nothing on its own. A 90% win rate with tiny wins and one huge loss is a losing system. |
| **Profit factor** | Gross profit ÷ gross loss. Under 1.0 loses money. Above 1.3 is the usual floor. |
| **Sharpe** | Risk-adjusted return. Below 0.5 and the edge probably dies after slippage. |
| **Max drawdown** | Worst peak-to-valley decline. If you would panic here, size down. |
| **Avg hold time** | Compare it to your actual attention span. |

### Before you trust any backtest

1. **More than 30 trades.** Fewer is noise.
2. **Out-of-sample.** Backtest on 2024, check 2025. Works on one period only means it does not work.
3. **Double the fees.** `--fee 0.002`. If the edge vanishes, it was never an edge.
4. **Check the drawdown is survivable.** 40% forces people out at the worst possible moment.

---

## Project layout

```
src/
├── config.ts              env + flag loading
├── types.ts               Candle, Signal, Strategy, Trade
├── cli.ts                 cbb backtest | doctor
├── engine/
│   ├── backtest.ts        event-driven backtester
│   └── metrics.ts         Sharpe, drawdown, profit factor
├── strategy/
│   └── sma-crossover.ts   trend following
├── risk/manager.ts        sizing, drawdown, circuit breaker
└── utils/                 indicators, logger
examples/
├── backtest.ts            CLI-driven backtest
└── smoke.ts               16 assertions, no network
```

---

## Testing

```bash
npm test          # 106 tests, ~1s, no network
npm run coverage  # coverage report + threshold enforcement
npm run typecheck
npm run build
```

Covers sizing arithmetic, the circuit breaker, max-trades enforcement, empty backtests, short-input rejection, and that no `NaN` ever reaches the trade log.

---

## Taking it live

This repo stops at the backtest boundary on purpose. Backtesting is where mistakes are cheap.

Running a strategy with real money needs different guarantees: order-fill realism, an emergency stop you can trigger from your phone, position limits enforced outside the strategy code, and logging you can audit after something goes wrong.

### crypto-bot-kit — live + paper trading, $49

The layer above this one. Same codebase, same authors, three things added:

- **Paper trading engine** — polls real candles, checks stops against real highs and lows, routes through the identical code path as live. Not a last-price simulator.
- **Live trading** — market orders, graceful shutdown, per-tick error isolation, on any exchange ccxt can fetch OHLCV from.
- **Risk manager in the loop** — position sizing, max drawdown halt, and a 3-loss circuit breaker enforced *outside* strategy code, so a buggy strategy can't take the account down.
- Bonus: RSI reversion strategy and a second strategy example.

```bash
npm install && cp .env.example .env
npx tsx src/cli.ts doctor    # verify connectivity + mode before risking anything
npx tsx src/cli.ts live      # paper until you add API keys
```

Paper mode is the default. Live activates only when both `API_KEY` and `API_SECRET` are set. MIT license — commercial use allowed.

**crypto-bot-kit (live + paper engine) is not for sale right now.**

A code audit found defects in the live engine and in the backtester's equity
accounting. Sales are paused while those are fixed. The free backtester in this
repo is unaffected and continues to work.

---

## License

MIT. Use it commercially, modify it, fork it. Attribution appreciated, not required.

---

## Disclaimer

Tooling, not financial advice. The included strategy is an educational starting point — an SMA crossover is a well-known retail approach and is not a proven edge on any market in any period. Backtest it yourself, understand it, and assume your live results will be worse than the backtest. You are responsible for every trade you place.