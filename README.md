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

## Backtest Results (90 days, $10k notional)

### Realistic vs Optimistic Returns

| Implied Rate Model | 90-Day PnL | Annualized APY | Notes |
|-------------------|------------|----------------|-------|
| Floating (optimistic) | $1,214 | 49% | If Boros implied = floating |
| **Blend 50/50 (realistic)** | **$551** | **22%** | Best estimate |
| 7d MA (pessimistic) | -$183 | -7% | If fully priced in |

**Key insight:** Original backtest assumed we lock in floating rate. In reality, Boros implied rate already prices in some reversion. Realistic expectation: ~22% APY.

### Per-Coin Performance (Realistic Model)

| Asset | Z Threshold | 90-Day PnL | Trades | Win Rate |
|-------|-------------|------------|--------|----------|
| HYPE | 2.5σ | +$396 | 10 | 90% |
| ETH | 1.8σ | +$105 | 8 | 88% |
| BTC | 2.2σ | +$51 | 9 | 78% |

**Hold for 7 days.** Reversion happens fast (2-6h) but profit accumulates AFTER.

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
# Strategy: mean_reversion (recommended) | spread_harvest | both
ALERT_STRATEGY=mean_reversion

# Hold period (7 days - don't exit early)
ALERT_HOLD_DAYS=7

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

### Automated Data Refresh

Historical data for z-score calculations is refreshed daily via cron:

```bash
# Add to crontab (crontab -e)
0 6 * * * cd /path/to/meridian && pnpm run data:fetch >> logs/data-fetch.log 2>&1
```

This keeps the 90-day baseline stats current. The monitor sends a Telegram notification on startup to confirm it's running.

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

### Spread Harvest (Paused)

> **Note:** Spread harvest is paused during paper trading. Mean reversion shows 6.7x better returns. May revisit later.

Enter when Boros implied rate diverges from underlying. Hold 14 days.

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
    sensitivity.ts    # Implied rate model testing
    spread-harvest.ts # Spread harvest backtest
  alerts/
    monitor.ts        # Rate monitoring + alerts
    notifiers.ts      # Telegram + email
    config.ts         # Configuration
  paper/
    tracker.ts        # Trade lifecycle management
    monitor.ts        # Position monitoring (exit checks)
    dashboard.ts      # Full metrics display
    cli.ts            # CLI commands
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
| `pnpm run paper:dashboard` | Full paper trading metrics |
| `pnpm run paper:status` | Quick position check |
| `pnpm run paper:monitor` | Check positions for exits |

## Leverage Tiering

From sensitivity analysis - when to use leverage:

| Z-Score Range | Win Rate | Recommended Leverage |
|---------------|----------|---------------------|
| 2.0 - 2.5σ | 86% | 1x |
| 2.5 - 4.0σ | 100% | 2x (sweet spot) |
| 4.0σ+ | 80% | 1x |

With 2x leverage on z 2.5-4.0: +53% more PnL ($844 vs $551 in backtest).

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
