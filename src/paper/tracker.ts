/**
 * Meridian Paper Trading - Trade Tracker
 *
 * Handles all trade lifecycle operations:
 * - Opening new paper trades when alerts fire
 * - Updating unrealized P&L for open positions
 * - Closing trades (time-based, manual, or stop-loss)
 * - Persisting trade data to JSON files
 *
 * Data is stored in:
 * - data/paper-trades.json  → All trades (open and closed)
 * - data/paper-state.json   → Current state (equity, open position IDs)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  PaperTrade,
  PaperState,
  TradeDirection,
  RiskConfig,
  KillSwitchStatus,
  KillSwitchConfig,
} from './types.js';
import type { TradeAlert } from '../alerts/notifiers.js';
import { loadLeverageConfig, calculateLeverage, describeLeverage } from './leverage.js';

// ============================================================================
// FILE PATHS
// ============================================================================

const DATA_DIR = join(process.cwd(), 'data');
const TRADES_FILE = join(DATA_DIR, 'paper-trades.json');
const STATE_FILE = join(DATA_DIR, 'paper-state.json');
const SNAPSHOTS_FILE = join(DATA_DIR, 'paper-snapshots.json');
const ALERTS_LOG_FILE = join(DATA_DIR, 'paper-alerts-log.json');
const KILLSWITCH_FILE = join(DATA_DIR, 'paper-killswitch.json');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default starting capital for paper trading */
const DEFAULT_STARTING_CAPITAL = 1_000;

/** Default position size (collateral per trade, notional = this × leverage) */
const DEFAULT_POSITION_SIZE = 1000; // 100% of $1k capital

// ============================================================================
// BOROS FEE STRUCTURE (from docs.pendle.finance/boros-dev/Mechanics/Fees)
// ============================================================================

/**
 * Opening fee: Position Size × 0.05% × Time to Maturity (in years)
 * - Only charged on taker orders
 * - Time to maturity is swap maturity, not hold time
 */
const OPENING_FEE_RATE = 0.0005; // 0.05%

/**
 * Settlement fee: Position Size × 0.2% × Settlement Period (in years)
 * - Charged every 8 hours while position is open
 * - Rate varies by market, using 0.2% as default
 */
const SETTLEMENT_FEE_RATE = 0.002; // 0.2%
const SETTLEMENT_PERIOD_HOURS = 8;

/**
 * Market entrance fee: ~$1 one-time per market (negligible, ignored)
 */

/**
 * Calculate opening fee for a position
 * @param notionalSize Position size in USD
 * @param daysToMaturity Days until swap maturity (default 30 for typical swaps)
 */
function calculateOpeningFee(notionalSize: number, daysToMaturity: number = 30): number {
  const yearsToMaturity = daysToMaturity / 365;
  return notionalSize * OPENING_FEE_RATE * yearsToMaturity;
}

/**
 * Calculate settlement fees for a position
 * @param notionalSize Position size in USD
 * @param hoursHeld How long position was held
 */
function calculateSettlementFees(notionalSize: number, hoursHeld: number): number {
  const settlementPeriods = Math.ceil(hoursHeld / SETTLEMENT_PERIOD_HOURS);
  const yearsPerPeriod = SETTLEMENT_PERIOD_HOURS / 8760;
  return notionalSize * SETTLEMENT_FEE_RATE * yearsPerPeriod * settlementPeriods;
}

/**
 * Calculate total fees for a trade
 */
function calculateTotalFees(notionalSize: number, hoursHeld: number, daysToMaturity: number = 30): number {
  const openingFee = calculateOpeningFee(notionalSize, daysToMaturity);
  const settlementFees = calculateSettlementFees(notionalSize, hoursHeld);
  return openingFee + settlementFees;
}

// ============================================================================
// RISK CONFIGURATION
// ============================================================================

/**
 * Load risk configuration from environment with defaults
 */
export function loadRiskConfig(): RiskConfig {
  return {
    maxPositionSize: parseFloat(process.env.PAPER_MAX_POSITION_SIZE || '1.0'), // 100% sizing
    maxConcurrentPositions: parseInt(process.env.PAPER_MAX_CONCURRENT || '1'), // 100% sizing = 1 position
    maxTotalExposure: parseFloat(process.env.PAPER_MAX_EXPOSURE || '1.0'), // 100% exposure allowed
    stopLossThreshold: parseFloat(process.env.PAPER_STOP_LOSS || '-0.05'),
    maxDrawdown: parseFloat(process.env.PAPER_MAX_DRAWDOWN || '-0.15'),
    maxLeverage: parseFloat(process.env.PAPER_MAX_LEVERAGE || '1.4'), // Boros current max
    consecutiveLossLimit: parseInt(process.env.PAPER_LOSS_LIMIT || '3'),
    cooldownDays: parseInt(process.env.PAPER_COOLDOWN_DAYS || '14'),
    // Trailing stop (disabled by default - Hold 7 days is optimal per backtest)
    trailingStopPct: parseFloat(process.env.PAPER_TRAILING_STOP_PCT || '1.0'),
    minHoldHours: parseInt(process.env.PAPER_MIN_HOLD_HOURS || '12'),
  };
}

// ============================================================================
// DATA PERSISTENCE
// ============================================================================

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load all paper trades from disk
 * Also migrates legacy trades to include new trailing stop fields
 */
export function loadTrades(): PaperTrade[] {
  try {
    if (existsSync(TRADES_FILE)) {
      const trades: PaperTrade[] = JSON.parse(readFileSync(TRADES_FILE, 'utf-8'));

      // Migrate legacy trades without trailing stop fields
      let migrated = false;
      for (const trade of trades) {
        if (trade.peakUnrealizedPnl === undefined) {
          trade.peakUnrealizedPnl = Math.max(0, trade.unrealizedPnl);
          trade.peakPnlHour = 0;
          trade.trailingStopPct = 0.30; // Default 30%
          trade.minHoldHours = 12;      // Default 12h
          migrated = true;
        }
        // Migrate legacy trades without implied rate logging fields
        if (trade.entry7dMA === undefined) {
          // For old trades, estimate 7dMA as the mean (close enough)
          trade.entry7dMA = trade.entryApr; // Best guess - no historical data
          trade.estimatedBlend5050 = (trade.entryApr + trade.entry7dMA) / 2;
          trade.impliedVsBlendDelta = trade.entryImpliedApr - trade.estimatedBlend5050;
          migrated = true;
        }
      }

      // Save migrated data
      if (migrated) {
        writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
        console.log('📝 Migrated existing trades to Trail 30% strategy');
      }

      return trades;
    }
  } catch {
    console.error('Error loading trades file, starting fresh');
  }
  return [];
}

/**
 * Save all trades to disk
 */
export function saveTrades(trades: PaperTrade[]): void {
  ensureDataDir();
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

/**
 * Load paper trading state
 */
export function loadState(): PaperState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    console.error('Error loading state file, starting fresh');
  }
  return {
    openPositions: [],
    currentEquity: DEFAULT_STARTING_CAPITAL,
    startingCapital: DEFAULT_STARTING_CAPITAL,
    peakEquity: DEFAULT_STARTING_CAPITAL,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Save paper trading state
 */
export function saveState(state: PaperState): void {
  ensureDataDir();
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Log an alert (for signal-to-trade ratio tracking)
 */
export function logAlert(alert: TradeAlert): void {
  ensureDataDir();
  let alerts: Array<{ timestamp: string; coin: string; direction: string; strategy: string }> = [];
  try {
    if (existsSync(ALERTS_LOG_FILE)) {
      alerts = JSON.parse(readFileSync(ALERTS_LOG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }

  alerts.push({
    timestamp: new Date().toISOString(),
    coin: alert.coin,
    direction: alert.direction,
    strategy: alert.type,
  });

  writeFileSync(ALERTS_LOG_FILE, JSON.stringify(alerts, null, 2));
}

// ============================================================================
// TRADE OPERATIONS
// ============================================================================

/**
 * Check if we can open a new trade based on risk rules
 */
export function canOpenTrade(
  state: PaperState,
  trades: PaperTrade[],
  coin: string,
  riskConfig: RiskConfig
): { allowed: boolean; reason?: string } {
  // Check kill switch status first
  const killStatus = loadKillSwitchStatus();
  if (!killStatus.tradingEnabled) {
    return {
      allowed: false,
      reason: `Kill switch triggered: ${killStatus.disabledReason}`,
    };
  }

  // Check if this specific coin is disabled
  if (!isCoinAllowed(coin)) {
    return {
      allowed: false,
      reason: `${coin} disabled by kill switch (underperforming)`,
    };
  }

  // Check max concurrent positions
  if (state.openPositions.length >= riskConfig.maxConcurrentPositions) {
    return {
      allowed: false,
      reason: `Max concurrent positions (${riskConfig.maxConcurrentPositions}) reached`,
    };
  }

  // Check if already have open position in this coin
  const openTrades = trades.filter(t => state.openPositions.includes(t.id));
  const hasOpenInCoin = openTrades.some(t => t.coin === coin);
  if (hasOpenInCoin) {
    return {
      allowed: false,
      reason: `Already have open position in ${coin}`,
    };
  }

  // Check total exposure
  const totalExposure = openTrades.reduce((sum, t) => sum + t.notionalSize, 0);
  const maxExposure = state.currentEquity * riskConfig.maxTotalExposure;
  if (totalExposure >= maxExposure) {
    return {
      allowed: false,
      reason: `Max total exposure (${(riskConfig.maxTotalExposure * 100).toFixed(0)}%) reached`,
    };
  }

  // Check drawdown
  const currentDrawdown = (state.peakEquity - state.currentEquity) / state.peakEquity;
  if (currentDrawdown >= Math.abs(riskConfig.maxDrawdown)) {
    return {
      allowed: false,
      reason: `Max drawdown (${(riskConfig.maxDrawdown * 100).toFixed(0)}%) reached - trading paused`,
    };
  }

  // Check consecutive losses (on this coin)
  const recentTrades = trades
    .filter(t => t.coin === coin && t.status === 'CLOSED')
    .slice(-riskConfig.consecutiveLossLimit);

  const allLosses = recentTrades.length === riskConfig.consecutiveLossLimit &&
    recentTrades.every(t => (t.realizedPnl ?? 0) < 0);

  if (allLosses) {
    const lastLoss = recentTrades[recentTrades.length - 1];
    const cooldownEnd = new Date(lastLoss.exitTime!);
    cooldownEnd.setDate(cooldownEnd.getDate() + riskConfig.cooldownDays);

    if (new Date() < cooldownEnd) {
      return {
        allowed: false,
        reason: `${coin} on cooldown until ${cooldownEnd.toISOString().split('T')[0]} (${riskConfig.consecutiveLossLimit} consecutive losses)`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Open a new paper trade from an alert
 */
export function openTrade(
  alert: TradeAlert,
  state: PaperState,
  trades: PaperTrade[],
  riskConfig: RiskConfig,
  positionSize?: number
): { trade: PaperTrade | null; reason?: string; leverageInfo?: string } {
  // Log the alert first (for signal-to-trade ratio)
  logAlert(alert);

  // Check if we can open
  const check = canOpenTrade(state, trades, alert.coin, riskConfig);
  if (!check.allowed) {
    return { trade: null, reason: check.reason };
  }

  // Calculate leverage based on configured strategy
  const leverageConfig = loadLeverageConfig();
  const leverage = calculateLeverage(
    leverageConfig,
    alert.zScore,
    state.currentEquity,
    state.startingCapital
  );
  const leverageInfo = describeLeverage(
    leverageConfig,
    alert.zScore,
    state.currentEquity,
    state.startingCapital
  );

  // Cap leverage at risk config max
  const finalLeverage = Math.min(leverage, riskConfig.maxLeverage);

  // Calculate position size
  // With leverage, collateral = notional / leverage
  const maxSize = state.currentEquity * riskConfig.maxPositionSize;
  const baseSize = positionSize ?? DEFAULT_POSITION_SIZE;
  const collateral = Math.min(baseSize, maxSize);
  const notionalSize = collateral * finalLeverage;

  // Calculate scheduled exit time
  const exitDate = new Date();
  exitDate.setDate(exitDate.getDate() + alert.holdDays);

  // Calculate opening fee (Boros: 0.05% × time to maturity)
  const entryFee = calculateOpeningFee(notionalSize);

  // Calculate our blend estimate for implied rate comparison
  const estimatedBlend5050 = (alert.currentApr + alert.meanApr) / 2;
  const impliedVsBlendDelta = alert.impliedApr - estimatedBlend5050;

  const trade: PaperTrade = {
    id: randomUUID(),
    coin: alert.coin,
    direction: alert.direction,
    strategy: alert.type,
    status: 'OPEN',

    // Entry data
    entryTime: new Date().toISOString(),
    entryApr: alert.currentApr,
    entryImpliedApr: alert.impliedApr,
    entry7dMA: alert.meanApr,
    estimatedBlend5050,
    impliedVsBlendDelta,
    entryZScore: alert.zScore,
    notionalSize,
    leverage: finalLeverage,

    // Hold period
    targetHoldDays: alert.holdDays,
    scheduledExitTime: exitDate.toISOString(),

    // Exit data (filled on close)
    exitTime: null,
    exitApr: null,
    exitZScore: null,
    exitReason: null,

    // P&L
    realizedPnl: null,
    unrealizedPnl: 0,
    fees: entryFee,

    // Trailing stop data (Trail 30% strategy)
    peakUnrealizedPnl: 0,
    peakPnlHour: 0,
    trailingStopPct: riskConfig.trailingStopPct,
    minHoldHours: riskConfig.minHoldHours,
  };

  // Update state
  state.openPositions.push(trade.id);

  // Save
  trades.push(trade);
  saveTrades(trades);
  saveState(state);

  return { trade, leverageInfo };
}

/**
 * Calculate P&L for a trade given current market data
 *
 * On Boros:
 *   - Fixed rate = entryImpliedApr (the rate you lock in at entry)
 *   - Floating rate = current funding APR (changes over time)
 *
 * Formula (hourly accrual):
 *   For each hour in holding period:
 *     hourlyFixed = entryImpliedApr / 8760
 *     hourlyFloating = currentApr / 8760
 *     if SHORT: pnl += (hourlyFixed - hourlyFloating) * notional
 *     if LONG:  pnl += (hourlyFloating - hourlyFixed) * notional
 */
export function calculatePnl(
  trade: PaperTrade,
  currentApr: number,
  hoursHeld: number
): number {
  // Fixed rate is the IMPLIED APR locked in at entry (not the entry funding rate!)
  const hourlyFixed = trade.entryImpliedApr / 8760;
  const hourlyFloating = currentApr / 8760;

  let pnl = 0;
  if (trade.direction === 'SHORT') {
    // Receive fixed (implied), pay floating (current funding)
    pnl = (hourlyFixed - hourlyFloating) * trade.notionalSize * hoursHeld;
  } else {
    // Pay fixed (implied), receive floating (current funding)
    pnl = (hourlyFloating - hourlyFixed) * trade.notionalSize * hoursHeld;
  }

  return pnl;
}

/**
 * Update unrealized P&L for all open positions
 * Also tracks peak P&L for trailing stop strategy
 */
export async function updateUnrealizedPnl(
  trades: PaperTrade[],
  state: PaperState,
  fetchCurrentApr: (coin: string) => Promise<number | null>
): Promise<void> {
  const openTrades = trades.filter(t => state.openPositions.includes(t.id));

  for (const trade of openTrades) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) continue;

    const entryTime = new Date(trade.entryTime);
    const hoursHeld = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

    trade.unrealizedPnl = calculatePnl(trade, currentApr, hoursHeld);

    // Update peak P&L tracking for trailing stop
    if (trade.unrealizedPnl > trade.peakUnrealizedPnl) {
      trade.peakUnrealizedPnl = trade.unrealizedPnl;
      trade.peakPnlHour = Math.floor(hoursHeld);
    }
  }

  saveTrades(trades);
}

/**
 * Close a trade
 */
export function closeTrade(
  trade: PaperTrade,
  state: PaperState,
  trades: PaperTrade[],
  exitApr: number,
  exitZScore: number,
  exitReason: 'TIME_BASED' | 'MANUAL' | 'STOP_LOSS' | 'TRAILING_STOP'
): void {
  const entryTime = new Date(trade.entryTime);
  const hoursHeld = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

  // Calculate realized P&L
  const grossPnl = calculatePnl(trade, exitApr, hoursHeld);

  // Add settlement fees (Boros: 0.2% × position × time, charged every 8h)
  const settlementFees = calculateSettlementFees(trade.notionalSize, hoursHeld);
  trade.fees += settlementFees;

  // Net P&L
  const netPnl = grossPnl - trade.fees;

  // Update trade
  trade.status = 'CLOSED';
  trade.exitTime = new Date().toISOString();
  trade.exitApr = exitApr;
  trade.exitZScore = exitZScore;
  trade.exitReason = exitReason;
  trade.realizedPnl = netPnl;
  trade.unrealizedPnl = 0;

  // Update state
  state.openPositions = state.openPositions.filter(id => id !== trade.id);
  state.currentEquity += netPnl;

  // Update peak equity for drawdown tracking
  if (state.currentEquity > state.peakEquity) {
    state.peakEquity = state.currentEquity;
  }

  // Save
  saveTrades(trades);
  saveState(state);
}

/**
 * Check for trades that should be closed (time-based exit)
 */
export function getTradesDueForExit(trades: PaperTrade[], state: PaperState): PaperTrade[] {
  const now = new Date();
  return trades.filter(t =>
    state.openPositions.includes(t.id) &&
    new Date(t.scheduledExitTime) <= now
  );
}

/**
 * Check for trades that hit stop-loss
 */
export function getTradesAtStopLoss(
  trades: PaperTrade[],
  state: PaperState,
  riskConfig: RiskConfig
): PaperTrade[] {
  return trades.filter(t => {
    if (!state.openPositions.includes(t.id)) return false;

    const pnlPercent = t.unrealizedPnl / t.notionalSize;
    return pnlPercent <= riskConfig.stopLossThreshold;
  });
}

/**
 * Check for trades that hit trailing stop (Trail 30% strategy)
 *
 * Trailing stop triggers when:
 * 1. Strategy is mean_reversion (NOT spread_harvest - needs full hold)
 * 2. Position has been held for at least minHoldHours
 * 3. Peak P&L was positive (we had unrealized gains)
 * 4. Current P&L dropped by trailingStopPct from peak
 *
 * Example with 30% trailing stop:
 * - Peak P&L: $100
 * - Current P&L: $65 (35% drawdown from peak)
 * - Result: TRIGGER (35% > 30%)
 */
export function getTradesAtTrailingStop(
  trades: PaperTrade[],
  state: PaperState
): PaperTrade[] {
  return trades.filter(t => {
    if (!state.openPositions.includes(t.id)) return false;

    // Only apply trailing stop to mean_reversion trades
    // spread_harvest needs full hold period to capture spread convergence
    if (t.strategy !== 'mean_reversion') return false;

    // Check minimum hold time
    const entryTime = new Date(t.entryTime);
    const hoursHeld = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    if (hoursHeld < t.minHoldHours) return false;

    // Need to have had some positive P&L first
    if (t.peakUnrealizedPnl <= 0) return false;

    // Calculate drawdown from peak
    const drawdownFromPeak = (t.peakUnrealizedPnl - t.unrealizedPnl) / t.peakUnrealizedPnl;

    // Trigger if drawdown exceeds threshold
    return drawdownFromPeak >= t.trailingStopPct;
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get all open trades
 */
export function getOpenTrades(trades: PaperTrade[], state: PaperState): PaperTrade[] {
  return trades.filter(t => state.openPositions.includes(t.id));
}

/**
 * Get closed trades
 */
export function getClosedTrades(trades: PaperTrade[]): PaperTrade[] {
  return trades.filter(t => t.status === 'CLOSED');
}

/**
 * Get trades for a specific coin
 */
export function getTradesByCoin(trades: PaperTrade[], coin: string): PaperTrade[] {
  return trades.filter(t => t.coin.toUpperCase() === coin.toUpperCase());
}

/**
 * Get total alerts received (for signal-to-trade ratio)
 */
export function getTotalAlerts(): number {
  try {
    if (existsSync(ALERTS_LOG_FILE)) {
      const alerts = JSON.parse(readFileSync(ALERTS_LOG_FILE, 'utf-8'));
      return alerts.length;
    }
  } catch { /* ignore */ }
  return 0;
}

// ============================================================================
// KILL SWITCH SYSTEM
// ============================================================================

/**
 * Load kill switch configuration from environment
 */
export function loadKillSwitchConfig(): KillSwitchConfig {
  return {
    rollingPnlLookback: parseInt(process.env.KILLSWITCH_ROLLING_LOOKBACK || '10'),
    coinWinRateThreshold: parseFloat(process.env.KILLSWITCH_COIN_WINRATE || '0.60'),
    coinLookbackTrades: parseInt(process.env.KILLSWITCH_COIN_LOOKBACK || '5'),
    monthlyReduceThreshold: parseFloat(process.env.KILLSWITCH_MONTHLY_REDUCE || '0.05'),
    monthlyStopThreshold: parseFloat(process.env.KILLSWITCH_MONTHLY_STOP || '0'),
    maxDrawdown: parseFloat(process.env.PAPER_MAX_DRAWDOWN || '0.15'),
  };
}

/**
 * Get default kill switch status (all clear)
 */
function getDefaultKillSwitchStatus(config: KillSwitchConfig): KillSwitchStatus {
  return {
    tradingEnabled: true,
    disabledReason: null,
    triggeredAt: null,
    switches: {
      rollingPnl: {
        triggered: false,
        lastNTradesAvgPnl: 0,
        threshold: 0,
        lookbackTrades: config.rollingPnlLookback,
      },
      coinPerformance: {
        triggered: false,
        disabledCoins: [],
        threshold: config.coinWinRateThreshold,
        lookbackTrades: config.coinLookbackTrades,
      },
      monthlyPerformance: {
        triggered: false,
        last30DaysApy: 0,
        reduceSize: false,
        fullStop: false,
        threshold: config.monthlyStopThreshold,
      },
      drawdown: {
        triggered: false,
        currentDrawdown: 0,
        threshold: config.maxDrawdown,
      },
    },
  };
}

/**
 * Load kill switch status from disk
 */
export function loadKillSwitchStatus(): KillSwitchStatus {
  const config = loadKillSwitchConfig();
  try {
    if (existsSync(KILLSWITCH_FILE)) {
      return JSON.parse(readFileSync(KILLSWITCH_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return getDefaultKillSwitchStatus(config);
}

/**
 * Save kill switch status to disk
 */
export function saveKillSwitchStatus(status: KillSwitchStatus): void {
  ensureDataDir();
  writeFileSync(KILLSWITCH_FILE, JSON.stringify(status, null, 2));
}

/**
 * Check all kill switches and return updated status
 * Returns { status, alerts } where alerts are messages to send
 */
export function checkKillSwitches(
  trades: PaperTrade[],
  state: PaperState
): { status: KillSwitchStatus; alerts: string[] } {
  const config = loadKillSwitchConfig();
  const currentStatus = loadKillSwitchStatus();
  const alerts: string[] = [];

  const closedTrades = trades.filter(t => t.status === 'CLOSED');

  // ─────────────────────────────────────────────────────────────────────────
  // 1. ROLLING P&L CHECK
  // ─────────────────────────────────────────────────────────────────────────
  if (closedTrades.length >= config.rollingPnlLookback) {
    const lastNTrades = closedTrades.slice(-config.rollingPnlLookback);
    const avgPnl = lastNTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0) / lastNTrades.length;

    currentStatus.switches.rollingPnl.lastNTradesAvgPnl = avgPnl;

    if (avgPnl < 0 && !currentStatus.switches.rollingPnl.triggered) {
      currentStatus.switches.rollingPnl.triggered = true;
      currentStatus.tradingEnabled = false;
      currentStatus.disabledReason = `Rolling ${config.rollingPnlLookback}-trade avg P&L is negative ($${avgPnl.toFixed(2)})`;
      currentStatus.triggeredAt = new Date().toISOString();

      alerts.push(`🚨 KILL SWITCH: Rolling P&L

Last ${config.rollingPnlLookback} trades avg: $${avgPnl.toFixed(2)}

Edge may not exist. Trading PAUSED.

To reset: delete data/paper-killswitch.json`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. PER-COIN PERFORMANCE CHECK
  // ─────────────────────────────────────────────────────────────────────────
  const coins = [...new Set(closedTrades.map(t => t.coin))];

  for (const coin of coins) {
    const coinTrades = closedTrades.filter(t => t.coin === coin);

    if (coinTrades.length >= config.coinLookbackTrades) {
      const lastN = coinTrades.slice(-config.coinLookbackTrades);
      const wins = lastN.filter(t => (t.realizedPnl ?? 0) > 0).length;
      const winRate = wins / lastN.length;

      if (winRate < config.coinWinRateThreshold) {
        if (!currentStatus.switches.coinPerformance.disabledCoins.includes(coin)) {
          currentStatus.switches.coinPerformance.disabledCoins.push(coin);
          currentStatus.switches.coinPerformance.triggered = true;

          alerts.push(`🚨 KILL SWITCH: ${coin} Underperforming

Win rate: ${(winRate * 100).toFixed(0)}% (last ${config.coinLookbackTrades} trades)
Threshold: ${(config.coinWinRateThreshold * 100).toFixed(0)}%

${coin} removed from rotation. Other coins continue.`);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. MONTHLY PERFORMANCE CHECK
  // ─────────────────────────────────────────────────────────────────────────
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const last30DaysTrades = closedTrades.filter(
    t => new Date(t.exitTime!).getTime() > thirtyDaysAgo
  );

  if (last30DaysTrades.length >= 3) { // Need at least 3 trades to evaluate
    const pnl30Days = last30DaysTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
    const apy30Days = (pnl30Days / state.startingCapital) * (365 / 30);

    currentStatus.switches.monthlyPerformance.last30DaysApy = apy30Days;

    // Full stop if APY < 0
    if (apy30Days < config.monthlyStopThreshold && !currentStatus.switches.monthlyPerformance.fullStop) {
      currentStatus.switches.monthlyPerformance.triggered = true;
      currentStatus.switches.monthlyPerformance.fullStop = true;
      currentStatus.tradingEnabled = false;
      currentStatus.disabledReason = `30-day APY is negative (${(apy30Days * 100).toFixed(1)}%)`;
      currentStatus.triggeredAt = new Date().toISOString();

      alerts.push(`🚨 KILL SWITCH: Monthly Performance

30-day realized APY: ${(apy30Days * 100).toFixed(1)}%
30-day P&L: $${pnl30Days.toFixed(2)}

Edge gone. Trading PAUSED.

To reset: delete data/paper-killswitch.json`);
    }
    // Reduce size if APY < 5% but > 0
    else if (apy30Days < config.monthlyReduceThreshold && apy30Days >= 0 && !currentStatus.switches.monthlyPerformance.reduceSize) {
      currentStatus.switches.monthlyPerformance.reduceSize = true;

      alerts.push(`⚠️ WARNING: Edge Compression

30-day realized APY: ${(apy30Days * 100).toFixed(1)}%
Threshold: ${(config.monthlyReduceThreshold * 100).toFixed(0)}%

Consider reducing position sizes.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. DRAWDOWN CHECK (already in canOpenTrade, but track here too)
  // ─────────────────────────────────────────────────────────────────────────
  const currentDrawdown = (state.peakEquity - state.currentEquity) / state.peakEquity;
  currentStatus.switches.drawdown.currentDrawdown = currentDrawdown;

  // Use absolute value since config may be stored as negative (e.g., -0.15)
  const drawdownThreshold = Math.abs(config.maxDrawdown);
  if (currentDrawdown >= drawdownThreshold && !currentStatus.switches.drawdown.triggered) {
    currentStatus.switches.drawdown.triggered = true;
    currentStatus.tradingEnabled = false;
    currentStatus.disabledReason = `Max drawdown (${(currentDrawdown * 100).toFixed(1)}%) exceeded`;
    currentStatus.triggeredAt = new Date().toISOString();

    alerts.push(`🚨 KILL SWITCH: Max Drawdown

Current drawdown: ${(currentDrawdown * 100).toFixed(1)}%
Threshold: ${(drawdownThreshold * 100).toFixed(0)}%

Circuit breaker triggered. Trading PAUSED.

To reset: delete data/paper-killswitch.json`);
  }

  // Save updated status
  saveKillSwitchStatus(currentStatus);

  return { status: currentStatus, alerts };
}

/**
 * Check if trading is allowed for a specific coin
 */
export function isCoinAllowed(coin: string): boolean {
  const status = loadKillSwitchStatus();
  return !status.switches.coinPerformance.disabledCoins.includes(coin);
}

/**
 * Reset kill switches (manual intervention)
 */
export function resetKillSwitches(): void {
  const config = loadKillSwitchConfig();
  saveKillSwitchStatus(getDefaultKillSwitchStatus(config));
  console.log('Kill switches reset. Trading re-enabled.');
}
