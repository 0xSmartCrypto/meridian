/**
 * Meridian Paper Trading - Type Definitions
 *
 * This file defines all data structures used by the paper trading system.
 * Each type is documented to explain its purpose and fields.
 */

import type { AlertType } from '../alerts/notifiers.js';

// ============================================================================
// TRADE TYPES
// ============================================================================

/**
 * Trade Status
 *
 * - OPEN:   Position is active, accumulating P&L
 * - CLOSED: Position has been exited (time-based or manual)
 */
export type TradeStatus = 'OPEN' | 'CLOSED';

/**
 * Trade Direction
 *
 * - LONG:  Pay fixed rate, receive floating rate. Wins if funding goes UP.
 * - SHORT: Receive fixed rate, pay floating rate. Wins if funding goes DOWN.
 */
export type TradeDirection = 'LONG' | 'SHORT';

/**
 * Paper Trade Record
 *
 * Represents a single simulated trade from entry to exit.
 * This is the core data structure for tracking positions.
 */
export interface PaperTrade {
  /** Unique identifier for this trade (UUID) */
  id: string;

  /** Which coin this trade is on (e.g., "HYPE", "BTC", "ETH") */
  coin: string;

  /** Trade direction - determines how P&L is calculated */
  direction: TradeDirection;

  /** Which strategy triggered this trade */
  strategy: AlertType;

  /** Current status - OPEN means position is active */
  status: TradeStatus;

  // ─────────────────────────────────────────────────────────────────────────
  // ENTRY DATA (captured when trade opens)
  // ─────────────────────────────────────────────────────────────────────────

  /** ISO timestamp when trade was opened */
  entryTime: string;

  /** Funding APR at entry (annualized rate as decimal, e.g., 0.15 = 15%) */
  entryApr: number;

  /** Implied APR from Boros at entry */
  entryImpliedApr: number;

  /** 7-day MA APR at entry (for blend estimate calculation) */
  entry7dMA: number;

  /** Our estimated implied rate (50/50 blend of floating + 7dMA) */
  estimatedBlend5050: number;

  /**
   * Delta: Actual Boros implied vs our blend estimate
   * Positive = Boros prices HIGHER than our estimate (good for shorts, bad for longs)
   * Negative = Boros prices LOWER than our estimate (bad for shorts, good for longs)
   */
  impliedVsBlendDelta: number;

  /** Z-score at entry (how many std devs from mean) */
  entryZScore: number;

  /** Position size in USD (for P&L calculation) */
  notionalSize: number;

  /** Leverage used (1x, 2x, etc.) - affects liquidation, not P&L calc */
  leverage: number;

  // ─────────────────────────────────────────────────────────────────────────
  // HOLD PERIOD
  // ─────────────────────────────────────────────────────────────────────────

  /** Target hold duration in days (from backtest: 7 for mean rev, 14 for spread) */
  targetHoldDays: number;

  /** Scheduled exit time (ISO timestamp) */
  scheduledExitTime: string;

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT DATA (filled when trade closes)
  // ─────────────────────────────────────────────────────────────────────────

  /** ISO timestamp when trade was closed (null if still open) */
  exitTime: string | null;

  /** Funding APR at exit */
  exitApr: number | null;

  /** Z-score at exit */
  exitZScore: number | null;

  /** Why the trade was closed */
  exitReason: 'TIME_BASED' | 'MANUAL' | 'STOP_LOSS' | 'TRAILING_STOP' | null;

  // ─────────────────────────────────────────────────────────────────────────
  // P&L DATA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Realized P&L in USD (null if still open)
   *
   * Calculation:
   *   For each hour in holding period:
   *     hourlyFixed = entryApr / 8760
   *     hourlyFloating = currentApr / 8760
   *     if SHORT: pnl += (hourlyFixed - hourlyFloating) * notional
   *     if LONG:  pnl += (hourlyFloating - hourlyFixed) * notional
   */
  realizedPnl: number | null;

  /**
   * Current mark-to-market P&L for open positions
   * Updated every time we fetch current rates
   */
  unrealizedPnl: number;

  /** Estimated fees (entry + exit) */
  fees: number;

  // ─────────────────────────────────────────────────────────────────────────
  // TRAILING STOP DATA (Trail 30% Strategy)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Peak unrealized P&L reached during the trade
   * Used to calculate trailing stop trigger
   */
  peakUnrealizedPnl: number;

  /** Hour at which peak P&L was reached (for analysis) */
  peakPnlHour: number;

  /** Trailing stop percentage (default: 0.30 = 30% drawdown from peak triggers exit) */
  trailingStopPct: number;

  /** Minimum hours to hold before trailing stop can trigger (avoid whipsaws) */
  minHoldHours: number;
}

// ============================================================================
// STATE TYPES
// ============================================================================

/**
 * Paper Trading State
 *
 * Persisted to data/paper-state.json
 * Tracks currently open positions and running totals.
 */
export interface PaperState {
  /** All open position IDs (quick lookup) */
  openPositions: string[];

  /** Running equity (starting capital + cumulative realized P&L) */
  currentEquity: number;

  /** Starting capital for drawdown calculations */
  startingCapital: number;

  /** Highest equity reached (for max drawdown calculation) */
  peakEquity: number;

  /** Timestamp of last update */
  lastUpdated: string;
}

// ============================================================================
// RISK MANAGEMENT TYPES
// ============================================================================

/**
 * Risk Configuration
 *
 * Defines all risk management rules.
 * Loaded from environment variables with sensible defaults.
 */
export interface RiskConfig {
  /** Maximum position size as fraction of capital (default: 0.20 = 20%) */
  maxPositionSize: number;

  /** Maximum concurrent open positions (default: 3) */
  maxConcurrentPositions: number;

  /** Maximum total exposure as fraction of capital (default: 0.50 = 50%) */
  maxTotalExposure: number;

  /** Stop-loss threshold per position (default: -0.05 = -5%) */
  stopLossThreshold: number;

  /** Max total drawdown before pausing (default: -0.15 = -15%) */
  maxDrawdown: number;

  /** Maximum leverage allowed (default: 3) */
  maxLeverage: number;

  /** Cooldown trades after consecutive losses (default: 3) */
  consecutiveLossLimit: number;

  /** Cooldown period in days after hitting loss limit (default: 14) */
  cooldownDays: number;

  // ─────────────────────────────────────────────────────────────────────────
  // TRAILING STOP SETTINGS (DISABLED by default - Hold 7 days is optimal)
  // ─────────────────────────────────────────────────────────────────────────

  /** Whether trailing stop is enabled (default: false - Hold 7 days beats early exit) */
  trailingStopEnabled: boolean;

  /** Trailing stop percentage - exit when P&L drops this much from peak (default: 0.30 = 30%) */
  trailingStopPct: number;

  /** Minimum hours to hold before trailing stop can trigger (default: 12) */
  minHoldHours: number;
}

// ============================================================================
// METRICS TYPES
// ============================================================================

/**
 * Primary Metrics (Track Daily)
 *
 * These are the core performance metrics you should monitor every day.
 * They tell you if the strategy is working.
 */
export interface PrimaryMetrics {
  /**
   * WIN RATE
   *
   * What it measures: Percentage of trades that made money
   * How calculated:   (winning trades / total closed trades) × 100
   * Target:           >70% (backtest showed 89%, expect lower live)
   *
   * Why it matters: Base profitability indicator. Below 50% requires
   * very high win/loss ratio to be profitable.
   */
  winRate: number;

  /**
   * AVERAGE WIN / AVERAGE LOSS RATIO
   *
   * What it measures: How much you make on wins vs lose on losses
   * How calculated:   avg($profit on winning trades) / abs(avg($loss on losing trades))
   * Target:           >2.0
   *
   * Why it matters: Higher ratio means you can survive lower win rates.
   * At 2:1 ratio, you're profitable even at 40% win rate.
   */
  avgWinLossRatio: number;

  /**
   * SHARPE RATIO
   *
   * What it measures: Risk-adjusted returns (return per unit of volatility)
   * How calculated:   (annualized return - risk free rate) / annualized std dev
   * Target:           >1.5
   *
   * Why it matters: A 20% return with 40% volatility (Sharpe 0.5) is worse
   * than 10% return with 5% volatility (Sharpe 2.0). Quality over quantity.
   */
  sharpeRatio: number;

  /**
   * MAX DRAWDOWN
   *
   * What it measures: Largest peak-to-trough equity decline
   * How calculated:   (peak equity - lowest equity after peak) / peak equity
   * Target:           <15%
   *
   * Why it matters: Capital preservation. A 50% drawdown requires 100%
   * gain to recover. Circuit breaker should trigger at threshold.
   */
  maxDrawdown: number;

  /** Total realized P&L across all closed trades */
  totalRealizedPnl: number;

  /** Total unrealized P&L across all open positions */
  totalUnrealizedPnl: number;

  /** Number of closed trades */
  totalTrades: number;

  /** Number of winning trades */
  wins: number;

  /** Number of losing trades */
  losses: number;
}

/**
 * Secondary Metrics (Track Weekly)
 *
 * These provide deeper insight into trading behavior and patterns.
 * Review weekly to catch drift from the strategy.
 */
export interface SecondaryMetrics {
  /**
   * SIGNAL-TO-TRADE RATIO
   *
   * What it measures: How many alerts resulted in actual trades
   * How calculated:   trades entered / alerts received
   *
   * Why it matters: If you're skipping most alerts, either thresholds
   * are too sensitive or you're second-guessing the system.
   */
  signalToTradeRatio: number;

  /**
   * AVERAGE HOLD DURATION (days)
   *
   * What it measures: How long you actually held vs target
   * How calculated:   avg(exit time - entry time)
   * Target:           Should match targetHoldDays (7 or 14)
   *
   * Why it matters: Exiting early is the #1 backtest-to-live gap.
   * If avg hold < target, you're leaving money on table.
   */
  avgHoldDuration: number;

  /**
   * P&L BY ASSET
   *
   * What it measures: Which coins are profitable
   *
   * Why it matters: If one coin carries all the profit, you have
   * concentration risk. If one coin bleeds, consider removing it.
   */
  pnlByAsset: Record<string, { pnl: number; trades: number; winRate: number }>;

  /**
   * P&L BY STRATEGY
   *
   * What it measures: Which strategy (mean_reversion vs spread_harvest) works
   *
   * Why it matters: If one strategy dominates, consider focusing on it.
   */
  pnlByStrategy: Record<string, { pnl: number; trades: number; winRate: number }>;

  /**
   * AVERAGE Z-SCORE AT EXIT
   *
   * What it measures: Where funding ends up when you close
   * Target:           Closer to 0 than entry
   *
   * Why it matters: Validates mean reversion thesis. If exit z-score
   * is still extreme, maybe hold period is too short.
   */
  avgExitZScore: number;

  /** Number of alerts received (for signal-to-trade ratio) */
  alertsReceived: number;
}

/**
 * Meta Metrics (Track Monthly)
 *
 * Strategic metrics that reveal long-term viability of the edge.
 * Review monthly to decide if strategy needs adjustment.
 */
export interface MetaMetrics {
  /**
   * EDGE DECAY
   *
   * What it measures: Is win rate / Sharpe declining over time?
   * How calculated:   Compare last 30 days metrics to previous 30 days
   *
   * Why it matters: As more capital enters Boros, edge may compress.
   * Declining metrics = the trade is getting crowded.
   */
  edgeDecay: {
    winRateTrend: 'improving' | 'stable' | 'declining';
    sharpeTrend: 'improving' | 'stable' | 'declining';
    last30DaysWinRate: number;
    previous30DaysWinRate: number;
  };

  /**
   * CORRELATION TO BTC
   *
   * What it measures: Does your P&L just follow BTC price?
   * How calculated:   Correlation coefficient between daily P&L and BTC returns
   * Target:           <0.3 (low correlation)
   *
   * Why it matters: If highly correlated, you're just long crypto with
   * extra steps and fees. The strategy should be market-neutral.
   */
  btcCorrelation: number;

  /**
   * EXECUTION SLIPPAGE
   *
   * What it measures: Gap between alert rate and actual entry rate
   * How calculated:   avg(abs(alert rate - entry rate))
   *
   * Why it matters: In live trading, you won't execute at exact alert price.
   * High slippage = less profit than backtest suggests.
   */
  avgSlippage: number;

  /** Strategy age in days (for context) */
  daysActive: number;

  /** Total capital deployed over lifetime */
  totalCapitalDeployed: number;

  /** Capital efficiency (total P&L / total capital deployed) */
  capitalEfficiency: number;
}

/**
 * Combined Dashboard Metrics
 *
 * All metrics in one object for dashboard display.
 */
export interface DashboardMetrics {
  primary: PrimaryMetrics;
  secondary: SecondaryMetrics;
  meta: MetaMetrics;
  lastCalculated: string;
}

// ============================================================================
// KILL SWITCH TYPES
// ============================================================================

/**
 * Kill Switch Status
 *
 * Tracks whether any kill switches have been triggered.
 * When a kill switch triggers, trading is paused until manually reset.
 */
export interface KillSwitchStatus {
  /** Overall: Is trading allowed? */
  tradingEnabled: boolean;

  /** Reason trading is disabled (if applicable) */
  disabledReason: string | null;

  /** Timestamp when kill switch was triggered */
  triggeredAt: string | null;

  /** Individual kill switch states */
  switches: {
    /**
     * ROLLING P&L CHECK
     * Triggers if last N trades have negative average P&L
     * Catches: Bad model assumption
     */
    rollingPnl: {
      triggered: boolean;
      lastNTradesAvgPnl: number;
      threshold: number; // 0 = must be positive
      lookbackTrades: number; // default: 10
    };

    /**
     * PER-COIN PERFORMANCE
     * Triggers if a specific coin's win rate drops below threshold
     * Catches: Single coin regime change (e.g., HYPE stops working)
     */
    coinPerformance: {
      triggered: boolean;
      disabledCoins: string[];
      threshold: number; // default: 0.60 (60% win rate)
      lookbackTrades: number; // default: 5
    };

    /**
     * MONTHLY PERFORMANCE REVIEW
     * Triggers if 30-day realized APY drops below threshold
     * Catches: Gradual edge decay
     */
    monthlyPerformance: {
      triggered: boolean;
      last30DaysApy: number;
      reduceSize: boolean; // true if APY < 5% (reduce size)
      fullStop: boolean; // true if APY < 0% (stop trading)
      threshold: number; // default: 0 (must be positive)
    };

    /**
     * DRAWDOWN CIRCUIT BREAKER (existing)
     * Already implemented in canOpenTrade
     */
    drawdown: {
      triggered: boolean;
      currentDrawdown: number;
      threshold: number; // default: 0.15 (15%)
    };
  };
}

/**
 * Kill Switch Configuration
 */
export interface KillSwitchConfig {
  /** Rolling P&L: number of trades to look back */
  rollingPnlLookback: number;

  /** Per-coin: minimum win rate before disabling coin */
  coinWinRateThreshold: number;

  /** Per-coin: number of trades to evaluate */
  coinLookbackTrades: number;

  /** Monthly: APY threshold for reducing size */
  monthlyReduceThreshold: number;

  /** Monthly: APY threshold for full stop */
  monthlyStopThreshold: number;

  /** Drawdown: max drawdown before stopping */
  maxDrawdown: number;
}

// ============================================================================
// DAILY SNAPSHOT TYPE
// ============================================================================

/**
 * Daily Snapshot
 *
 * Captured once per day for time-series analysis.
 * Enables trend detection and edge decay monitoring.
 */
export interface DailySnapshot {
  /** ISO date (YYYY-MM-DD) */
  date: string;

  /** Equity at end of day */
  equity: number;

  /** Daily P&L */
  dailyPnl: number;

  /** Number of open positions */
  openPositions: number;

  /** Rolling 7-day win rate */
  rolling7dWinRate: number;

  /** Rolling 7-day Sharpe */
  rolling7dSharpe: number;
}
