# Meridian

Funding rate mean reversion trading system for Boros (Pendle's funding rate platform). Captures alpha when funding rates deviate from historical norms - rates that spike tend to revert, rates that crash tend to recover. Backtested +9% over 90 days on HYPE with 89% win rate.

## Status

| Phase | Status |
|-------|--------|
| 1. Data | Done |
| 2. Backtest | Done |
| 3. Alerts | Done |
| 4. Paper Trade | Ongoing |
| 5. Live | Not started |

## Backtest Results (Preliminary - 90 days)

| Strategy | Best Config | 90-Day Return | Win Rate |
|----------|-------------|---------------|----------|
| **Mean Reversion** | HYPE 2.5σ, 7d hold | **+$904 (9%)** | 89% (8/9) |
| Spread Harvest | HYPE 5% spread, 14d | +$135 (1.4%) | 75% |

*Based on $10k notional. Results are preliminary - more data needed for statistical significance.*

**Key insight:** Hold positions for 7-14 days. Don't exit early when signals revert.

## Quick Start

```bash
pnpm install
cp .env.example .env
```

### Setup Telegram Alerts (Free)

1. Message `@BotFather` on Telegram, send `/newbot`
2. Copy the bot token
3. Message your new bot (send "hello")
4. Get chat ID: Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
5. Add to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```

### Configure Strategy

```env
# Strategy: mean_reversion | spread_harvest | both
ALERT_STRATEGY=both

# Hold periods
ALERT_HOLD_DAYS=7
ALERT_SPREAD_HOLD_DAYS=14

# Default thresholds
ALERT_Z_THRESHOLD=2.2
ALERT_MIN_SPREAD=0.05

# Per-coin Z thresholds (optimized from backtest)
ALERT_Z_THRESHOLD_HYPE=2.5   # Stronger edge, higher threshold
ALERT_Z_THRESHOLD_BTC=2.2
ALERT_Z_THRESHOLD_ETH=1.8    # More signals, same win rate

# Coins
ALERT_COINS=HYPE,BTC,ETH
```

### Run

```bash
# 1. Fetch historical data (required for z-score baseline)
pnpm run data:fetch

# 2. Run backtest (optional - verify strategy performance)
pnpm run backtest

# 3. Start alerts
pnpm run alerts              # Single check
pnpm run alerts:watch        # Continuous (foreground)
pnpm run alerts:start        # PM2 daemon (auto-restart)
```

### PM2 Commands (Production)

```bash
pnpm run alerts:start        # Start daemon
pnpm run alerts:stop         # Stop daemon
pnpm run alerts:restart      # Restart daemon
pnpm run alerts:logs         # View logs
pnpm run alerts:status       # Check status
```

To survive server reboots:
```bash
pm2 startup                  # Generate startup script
pm2 save                     # Save current processes
```

## Strategies

### Mean Reversion (Recommended)

Enter when funding deviates significantly from historical mean.

| Signal | Condition | Action |
|--------|-----------|--------|
| SHORT | Z-score > threshold | Funding too high, bet it drops |
| LONG | Z-score < -threshold | Funding too low, bet it rises |

**Per-coin thresholds (optimized):**
| Coin | Z Threshold | Why |
|------|-------------|-----|
| HYPE | 2.5σ | Strongest edge at extremes |
| BTC | 2.2σ | Stable returns across thresholds |
| ETH | 1.8σ | More signals without hurting win rate |

**Hold for 7 days.** Don't exit when z-score reverts - profit comes from accumulating spread over time.

### Spread Harvest

Enter when Boros implied rate diverges from underlying.

| Signal | Condition | Action |
|--------|-----------|--------|
| SHORT | Implied >> Underlying | Receive high fixed, pay low floating |
| LONG | Implied << Underlying | Pay low fixed, receive high floating |

**Hold for 14 days** (or to expiry).

## How Boros Works

| Position | You Pay | You Receive | Win When |
|----------|---------|-------------|----------|
| LONG | Fixed rate | Floating rate | Funding goes UP |
| SHORT | Floating rate | Fixed rate | Funding stays LOW |

## Project Structure

```
src/
  data/
    fetch.ts          # Fetch from Hyperliquid + Boros
    analyze.ts        # Stats and signal analysis
  backtest/
    run.ts            # Mean reversion backtest
    spread-harvest.ts # Spread harvest backtest
    optimize.ts       # Parameter optimization
  alerts/
    monitor.ts        # Rate monitoring + alerts
    notifiers.ts      # Telegram + email
    config.ts         # Configuration
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm run data:fetch` | Fetch 90 days funding history |
| `pnpm run data:analyze` | Analyze mean reversion patterns |
| `pnpm run backtest` | Run mean reversion backtest |
| `pnpm run backtest:spread` | Run spread harvest backtest |
| `pnpm run alerts` | Single alert check |
| `pnpm run alerts:watch` | Continuous monitoring (foreground) |
| `pnpm run alerts:start` | Start PM2 daemon (production) |
| `pnpm run alerts:stop` | Stop PM2 daemon |
| `pnpm run alerts:logs` | View PM2 logs |

## Performance by Asset (Preliminary)

From 90-day backtest with optimized per-coin thresholds, 7-day hold, $10k notional:

| Asset | Z Threshold | 90-Day PnL | Trades | Win Rate |
|-------|-------------|------------|--------|----------|
| HYPE | 2.5σ | +$904 | 9 | 89% |
| ETH | 1.8σ | +$149 | 8 | 100% |
| BTC | 2.2σ | +$104 | 9 | 89% |

HYPE shows strongest mean reversion behavior. *More data needed for statistical significance.*

## Risk Notes

**Leverage & Liquidation:**
- Boros positions use leverage - you CAN be liquidated
- Funding rates can spike unexpectedly (100%+ APR moves happen)
- A 7-day hold with adverse funding can drain margin quickly
- Start with 1-2x leverage max until you understand the mechanics
- Never use leverage you can't afford to lose

**General:**
- Backtest ≠ live performance
- Only 90 days of data, 9 trades - statistically limited
- Edge may compress as more capital enters Boros
- Use appropriate position sizing (10-20% of allocated capital)
- This is NOT financial advice

## License

MIT - @0xSmartCrypto

## Contact

- [X - @0xSmartCrypto](https://x.com/0xSmartCrypto)
