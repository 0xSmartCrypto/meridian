# Meridian Paper Trading System

Simulates trades without real capital to validate strategy performance before going live.

---

## Quick Start

```bash
# 1. View dashboard (full metrics display)
pnpm run paper:dashboard

# 2. Check open positions
pnpm run paper:status

# 3. Manually open a paper trade
pnpm run paper:open HYPE SHORT mean_reversion

# 4. Process expired positions (run daily)
pnpm run paper:process

# 5. Capture daily snapshot (for trend analysis)
pnpm run paper:snapshot
```

---

## How It Works

### Trade Lifecycle

```
ALERT FIRES
    │
    ├─► [Auto Mode] Trade opens automatically
    │   OR
    ├─► [Manual Mode] Alert logged, you decide
    │
    ▼
POSITION OPEN
    │
    ├─► Unrealized P&L updates hourly
    ├─► Stop-loss checked on each update
    │
    ▼
EXIT TRIGGER
    │
    ├─► Time-based (7d mean rev, 14d spread)
    ├─► Stop-loss (-5% per position)
    └─► Manual close
    │
    ▼
POSITION CLOSED
    │
    └─► Realized P&L calculated, equity updated
```

### P&L Calculation

For each hour in holding period:

```
hourlyFixed = entryApr / 8760
hourlyFloating = currentApr / 8760

if SHORT: pnl += (hourlyFixed - hourlyFloating) * notional
if LONG:  pnl += (hourlyFloating - hourlyFixed) * notional

netPnl = grossPnl - fees
```

**Translation:**
- **SHORT**: You receive fixed rate, pay floating. Win if funding drops.
- **LONG**: You pay fixed rate, receive floating. Win if funding rises.

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `paper:dashboard` | Full metrics display with all three tiers |
| `paper:status` | Quick view of open positions |
| `paper:open <COIN> <DIR> <STRAT>` | Manually open a trade |
| `paper:close <ID>` | Manually close a trade |
| `paper:process` | Auto-close expired/stopped positions |
| `paper:snapshot` | Capture daily metrics for trend analysis |
| `paper:export` | Export trades to CSV |
| `paper:reset --confirm` | Delete all paper trading data |

---

## Configuration

Add to your `.env` file:

```env
# Paper Trading Mode
PAPER_MODE=manual              # auto = auto-trade on alerts, manual = log only
PAPER_POSITION_SIZE=1000       # Default position size in USD

# Risk Management
PAPER_MAX_POSITION_SIZE=0.20   # Max 20% of equity per trade
PAPER_MAX_CONCURRENT=3         # Max 3 open positions
PAPER_MAX_EXPOSURE=0.50        # Max 50% of equity deployed
PAPER_STOP_LOSS=-0.05          # -5% stop-loss per position
PAPER_MAX_DRAWDOWN=-0.15       # -15% circuit breaker
PAPER_MAX_LEVERAGE=3           # Max 3x leverage
PAPER_LOSS_LIMIT=3             # Pause after 3 consecutive losses
PAPER_COOLDOWN_DAYS=14         # Cooldown period after hitting loss limit
```

---

## Understanding the Dashboard

The dashboard displays three tiers of metrics, each serving a different purpose:

### 1. Primary Metrics (Check Daily)

These are your core health indicators. Check every day.

| Metric | What It Measures | Target | Why It Matters |
|--------|------------------|--------|----------------|
| **Win Rate** | % of trades profitable | >70% | Base profitability. Below 50% is dangerous. |
| **Avg Win/Loss Ratio** | Avg profit / Avg loss | >2.0x | At 2:1, you're profitable even at 40% WR |
| **Sharpe Ratio** | Risk-adjusted returns | >1.5 | Quality over quantity |
| **Max Drawdown** | Worst peak-to-trough decline | <15% | Capital preservation |

**Dashboard display:**
```
📊 PRIMARY METRICS (Check Daily)
──────────────────────────────────────────────────────────────────────

  WIN RATE                 78.5%  ✅
    What: Percentage of trades that made money
    Target: >70% (you have 11W / 3L)

  AVG WIN/LOSS RATIO       2.34x  ✅
    What: Average profit on wins vs average loss on losses
    Target: >2.0x (profitable even at 40% win rate)
```

### 2. Secondary Metrics (Check Weekly)

Behavioral patterns that reveal drift from the strategy.

| Metric | What It Measures | Why It Matters |
|--------|------------------|----------------|
| **Signal-to-Trade Ratio** | Alerts → Trades conversion | Are you second-guessing the system? |
| **Avg Hold Duration** | Actual vs target hold time | Exiting early = leaving money on table |
| **P&L by Asset** | Per-coin profitability | Concentration risk detection |
| **P&L by Strategy** | Mean rev vs spread performance | Which strategy actually works? |
| **Avg Exit Z-Score** | Where funding was at exit | Validates mean reversion thesis |

**Dashboard display:**
```
📈 SECONDARY METRICS (Check Weekly)
──────────────────────────────────────────────────────────────────────

  AVG HOLD DURATION        6.8 days  ⚠️
    What: How long you actually held positions
    Target: 7-14 days (per backtest findings)

  P&L BY ASSET:
    HYPE   +$523.45  (8 trades, 87% WR)
    BTC    +$89.22   (4 trades, 75% WR)
    ETH    -$12.33   (2 trades, 50% WR)
```

### 3. Meta Metrics (Check Monthly)

Long-term viability indicators.

| Metric | What It Measures | Why It Matters |
|--------|------------------|----------------|
| **Edge Decay** | Is performance declining? | More capital → compressed edge |
| **BTC Correlation** | P&L vs BTC price | >0.3 means you're just long crypto |
| **Avg Slippage** | Alert price vs entry price | Live trading friction |
| **Capital Efficiency** | P&L / Capital deployed | ROI per dollar committed |

**Dashboard display:**
```
🔮 META METRICS (Check Monthly)
──────────────────────────────────────────────────────────────────────

  EDGE DECAY:
    Win Rate Trend:        📈 improving
    Last 30d Win Rate:     82.3%
    Prev 30d Win Rate:     71.2%
    Sharpe Trend:          ➡️ stable
```

---

## Risk Management Rules

These rules are enforced automatically:

| Rule | Default | Purpose |
|------|---------|---------|
| Max position size | 20% of equity | No single trade blows up account |
| Max concurrent positions | 3 | Diversification across assets |
| Max total exposure | 50% of equity | Keep dry powder |
| Stop-loss | -5% per position | Cap downside on bad trades |
| Max drawdown | -15% total | Circuit breaker pauses trading |
| Consecutive loss limit | 3 | Cooldown after losing streak |

### What Happens When Rules Trigger

- **Position limit hit**: New trades rejected with message
- **Stop-loss hit**: Position auto-closed, logged as STOP_LOSS
- **Max drawdown hit**: All new trades rejected until equity recovers
- **Consecutive losses**: That coin paused for cooldown period

---

## Data Files

All data stored in `data/` directory:

| File | Contents |
|------|----------|
| `paper-trades.json` | All trade records (open + closed) |
| `paper-state.json` | Current equity, open position IDs |
| `paper-snapshots.json` | Daily equity snapshots for trend analysis |
| `paper-alerts-log.json` | All alerts received (for signal-to-trade ratio) |

### Trade Record Structure

```json
{
  "id": "abc123...",
  "coin": "HYPE",
  "direction": "SHORT",
  "strategy": "mean_reversion",
  "status": "OPEN",

  "entryTime": "2024-12-08T14:30:00Z",
  "entryApr": 0.15,
  "entryZScore": 2.7,
  "notionalSize": 1000,

  "targetHoldDays": 7,
  "scheduledExitTime": "2024-12-15T14:30:00Z",

  "exitTime": null,
  "exitApr": null,
  "realizedPnl": null,
  "unrealizedPnl": 45.23,
  "fees": 1.00
}
```

---

## Daily Workflow

### Morning Check (2 min)
```bash
pnpm run paper:dashboard
```
- Glance at Primary metrics
- Check any positions hitting stop-loss

### Evening Process (1 min)
```bash
pnpm run paper:process
pnpm run paper:snapshot
```
- Closes any expired positions
- Captures daily snapshot for trend analysis

### Weekly Review (10 min)
```bash
pnpm run paper:dashboard
```
- Review Secondary metrics
- Check P&L by asset/strategy
- Verify avg hold duration matches targets

### Monthly Review (30 min)
```bash
pnpm run paper:dashboard
pnpm run paper:export
```
- Check Meta metrics for edge decay
- Export to CSV for deeper analysis
- Decide if strategy needs adjustment

---

## Success Criteria for Going Live

Before deploying real capital, you should have:

| Criteria | Minimum | Ideal |
|----------|---------|-------|
| Paper trades | 20+ | 50+ |
| Days tracking | 30+ | 60+ |
| Win rate | >65% | >75% |
| Sharpe ratio | >1.0 | >1.5 |
| Max drawdown | <15% | <10% |
| Consecutive losses | <5 | <3 |

**Red flags that should delay live:**
- Win rate below 60%
- Max drawdown above 20%
- Edge decay showing "declining" for 2+ weeks
- Average hold duration far from targets (exiting early)
- Single asset carrying >80% of profits

---

## Troubleshooting

### "No historical stats" error
```bash
# Fetch funding data first
pnpm run data:fetch
```

### Trades not auto-opening
```bash
# Check mode in .env
PAPER_MODE=auto  # Change from 'manual'
```

### Dashboard shows $0 everywhere
```bash
# Initialize with a trade
pnpm run paper:open HYPE SHORT mean_reversion
```

### Want to start fresh
```bash
pnpm run paper:reset --confirm
```
