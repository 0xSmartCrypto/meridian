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

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default starting capital for paper trading */
const DEFAULT_STARTING_CAPITAL = 10_000;

/** Default position size (per trade) */
const DEFAULT_POSITION_SIZE = 1_000;

/** Taker fee rate (round trip) based on Boros */
const TAKER_FEE_RATE = 0.001; // 0.1% each side = 0.2% round trip

// ============================================================================
// RISK CONFIGURATION
// ============================================================================

/**
 * Load risk configuration from environment with defaults
 */
export function loadRiskConfig(): RiskConfig {
  return {
    maxPositionSize: parseFloat(process.env.PAPER_MAX_POSITION_SIZE || '0.20'),
    maxConcurrentPositions: parseInt(process.env.PAPER_MAX_CONCURRENT || '3'),
    maxTotalExposure: parseFloat(process.env.PAPER_MAX_EXPOSURE || '0.50'),
    stopLossThreshold: parseFloat(process.env.PAPER_STOP_LOSS || '-0.05'),
    maxDrawdown: parseFloat(process.env.PAPER_MAX_DRAWDOWN || '-0.15'),
    maxLeverage: parseFloat(process.env.PAPER_MAX_LEVERAGE || '3'),
    consecutiveLossLimit: parseInt(process.env.PAPER_LOSS_LIMIT || '3'),
    cooldownDays: parseInt(process.env.PAPER_COOLDOWN_DAYS || '14'),
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
 */
export function loadTrades(): PaperTrade[] {
  try {
    if (existsSync(TRADES_FILE)) {
      return JSON.parse(readFileSync(TRADES_FILE, 'utf-8'));
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

  // Calculate fees (entry side only, exit added at close)
  const entryFee = notionalSize * TAKER_FEE_RATE;

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
 * Formula (hourly accrual):
 *   For each hour in holding period:
 *     hourlyFixed = entryApr / 8760
 *     hourlyFloating = currentApr / 8760
 *     if SHORT: pnl += (hourlyFixed - hourlyFloating) * notional
 *     if LONG:  pnl += (hourlyFloating - hourlyFixed) * notional
 */
export function calculatePnl(
  trade: PaperTrade,
  currentApr: number,
  hoursHeld: number
): number {
  const hourlyFixed = trade.entryApr / 8760;
  const hourlyFloating = currentApr / 8760;

  let pnl = 0;
  if (trade.direction === 'SHORT') {
    // Receive fixed, pay floating
    pnl = (hourlyFixed - hourlyFloating) * trade.notionalSize * hoursHeld;
  } else {
    // Pay fixed, receive floating
    pnl = (hourlyFloating - hourlyFixed) * trade.notionalSize * hoursHeld;
  }

  return pnl;
}

/**
 * Update unrealized P&L for all open positions
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
  exitReason: 'TIME_BASED' | 'MANUAL' | 'STOP_LOSS'
): void {
  const entryTime = new Date(trade.entryTime);
  const hoursHeld = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

  // Calculate realized P&L
  const grossPnl = calculatePnl(trade, exitApr, hoursHeld);

  // Add exit fee
  const exitFee = trade.notionalSize * TAKER_FEE_RATE;
  trade.fees += exitFee;

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
