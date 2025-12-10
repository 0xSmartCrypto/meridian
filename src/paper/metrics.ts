/**
 * Meridian Paper Trading - Metrics Calculator
 *
 * Calculates all performance metrics at three levels:
 *
 * PRIMARY (Track Daily):
 *   - Win Rate, Avg Win/Loss Ratio, Sharpe Ratio, Max Drawdown
 *   - Core indicators of strategy health
 *
 * SECONDARY (Track Weekly):
 *   - Signal-to-Trade Ratio, Avg Hold Duration, P&L by Asset/Strategy
 *   - Behavior patterns and drift detection
 *
 * META (Track Monthly):
 *   - Edge Decay, BTC Correlation, Execution Slippage
 *   - Long-term viability indicators
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  PaperTrade,
  PaperState,
  PrimaryMetrics,
  SecondaryMetrics,
  MetaMetrics,
  DashboardMetrics,
  DailySnapshot,
} from './types.js';
import { loadTrades, loadState, getClosedTrades, getOpenTrades, getTotalAlerts } from './tracker.js';

const DATA_DIR = join(process.cwd(), 'data');
const SNAPSHOTS_FILE = join(DATA_DIR, 'paper-snapshots.json');

// ============================================================================
// PRIMARY METRICS
// ============================================================================

/**
 * Calculate primary metrics from trade history
 *
 * These are the most important metrics - check daily.
 */
export function calculatePrimaryMetrics(
  trades: PaperTrade[],
  state: PaperState
): PrimaryMetrics {
  const closedTrades = getClosedTrades(trades);
  const openTrades = getOpenTrades(trades, state);

  // Basic counts
  const wins = closedTrades.filter(t => (t.realizedPnl ?? 0) > 0);
  const losses = closedTrades.filter(t => (t.realizedPnl ?? 0) <= 0);

  // Win rate
  const winRate = closedTrades.length > 0
    ? (wins.length / closedTrades.length) * 100
    : 0;

  // Average win / loss ratio
  const avgWin = wins.length > 0
    ? wins.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0) / wins.length
    : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0) / losses.length)
    : 1; // Avoid division by zero
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin;

  // Sharpe ratio (simplified: using daily returns)
  const sharpeRatio = calculateSharpeRatio(closedTrades, state);

  // Max drawdown
  const maxDrawdown = calculateMaxDrawdown(closedTrades, state);

  // P&L totals
  const totalRealizedPnl = closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const totalUnrealizedPnl = openTrades.reduce((sum, t) => sum + t.unrealizedPnl, 0);

  return {
    winRate,
    avgWinLossRatio,
    sharpeRatio,
    maxDrawdown,
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
  };
}

/**
 * Calculate Sharpe Ratio
 *
 * Formula: (Annualized Return - Risk Free Rate) / Annualized Std Dev
 *
 * Simplified approach:
 * 1. Calculate daily returns from trade P&Ls
 * 2. Annualize mean and std dev
 * 3. Assume 0% risk-free rate
 */
function calculateSharpeRatio(closedTrades: PaperTrade[], state: PaperState): number {
  if (closedTrades.length < 2) return 0;

  // Group P&L by day
  const dailyPnl: Record<string, number> = {};
  for (const trade of closedTrades) {
    if (!trade.exitTime) continue;
    const date = trade.exitTime.split('T')[0];
    dailyPnl[date] = (dailyPnl[date] ?? 0) + (trade.realizedPnl ?? 0);
  }

  const dailyReturns = Object.values(dailyPnl);
  if (dailyReturns.length < 2) return 0;

  // Calculate mean and std dev
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize (assume 365 trading days for crypto)
  const annualizedReturn = mean * 365;
  const annualizedStdDev = stdDev * Math.sqrt(365);

  // Sharpe (risk-free = 0)
  return annualizedReturn / annualizedStdDev;
}

/**
 * Calculate Maximum Drawdown
 *
 * Formula: (Peak Equity - Trough Equity) / Peak Equity
 *
 * Tracks equity curve through all trades to find worst peak-to-trough decline.
 */
function calculateMaxDrawdown(closedTrades: PaperTrade[], state: PaperState): number {
  if (closedTrades.length === 0) return 0;

  // Sort trades by exit time
  const sortedTrades = [...closedTrades]
    .filter(t => t.exitTime)
    .sort((a, b) => new Date(a.exitTime!).getTime() - new Date(b.exitTime!).getTime());

  let equity = state.startingCapital;
  let peak = equity;
  let maxDrawdown = 0;

  for (const trade of sortedTrades) {
    equity += trade.realizedPnl ?? 0;

    if (equity > peak) {
      peak = equity;
    }

    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown * 100; // Return as percentage
}

// ============================================================================
// SECONDARY METRICS
// ============================================================================

/**
 * Calculate secondary metrics from trade history
 *
 * Review weekly to catch behavioral drift.
 */
export function calculateSecondaryMetrics(
  trades: PaperTrade[],
  state: PaperState
): SecondaryMetrics {
  const closedTrades = getClosedTrades(trades);

  // Signal-to-trade ratio
  const totalAlerts = getTotalAlerts();
  const signalToTradeRatio = totalAlerts > 0
    ? trades.length / totalAlerts
    : 1;

  // Average hold duration
  const holdDurations = closedTrades
    .filter(t => t.exitTime)
    .map(t => {
      const entry = new Date(t.entryTime);
      const exit = new Date(t.exitTime!);
      return (exit.getTime() - entry.getTime()) / (1000 * 60 * 60 * 24); // days
    });

  const avgHoldDuration = holdDurations.length > 0
    ? holdDurations.reduce((a, b) => a + b, 0) / holdDurations.length
    : 0;

  // P&L by asset
  const pnlByAsset: Record<string, { pnl: number; trades: number; winRate: number }> = {};
  for (const trade of closedTrades) {
    if (!pnlByAsset[trade.coin]) {
      pnlByAsset[trade.coin] = { pnl: 0, trades: 0, winRate: 0 };
    }
    pnlByAsset[trade.coin].pnl += trade.realizedPnl ?? 0;
    pnlByAsset[trade.coin].trades += 1;
  }
  // Calculate win rate per asset
  for (const coin of Object.keys(pnlByAsset)) {
    const coinTrades = closedTrades.filter(t => t.coin === coin);
    const coinWins = coinTrades.filter(t => (t.realizedPnl ?? 0) > 0);
    pnlByAsset[coin].winRate = coinTrades.length > 0
      ? (coinWins.length / coinTrades.length) * 100
      : 0;
  }

  // P&L by strategy
  const pnlByStrategy: Record<string, { pnl: number; trades: number; winRate: number }> = {};
  for (const trade of closedTrades) {
    if (!pnlByStrategy[trade.strategy]) {
      pnlByStrategy[trade.strategy] = { pnl: 0, trades: 0, winRate: 0 };
    }
    pnlByStrategy[trade.strategy].pnl += trade.realizedPnl ?? 0;
    pnlByStrategy[trade.strategy].trades += 1;
  }
  // Calculate win rate per strategy
  for (const strategy of Object.keys(pnlByStrategy)) {
    const stratTrades = closedTrades.filter(t => t.strategy === strategy);
    const stratWins = stratTrades.filter(t => (t.realizedPnl ?? 0) > 0);
    pnlByStrategy[strategy].winRate = stratTrades.length > 0
      ? (stratWins.length / stratTrades.length) * 100
      : 0;
  }

  // Average Z-score at exit
  const exitZScores = closedTrades
    .filter(t => t.exitZScore !== null)
    .map(t => t.exitZScore!);

  const avgExitZScore = exitZScores.length > 0
    ? exitZScores.reduce((a, b) => a + b, 0) / exitZScores.length
    : 0;

  return {
    signalToTradeRatio,
    avgHoldDuration,
    pnlByAsset,
    pnlByStrategy,
    avgExitZScore,
    alertsReceived: totalAlerts,
  };
}

// ============================================================================
// META METRICS
// ============================================================================

/**
 * Calculate meta metrics for strategic analysis
 *
 * Review monthly to assess long-term viability.
 */
export function calculateMetaMetrics(
  trades: PaperTrade[],
  state: PaperState
): MetaMetrics {
  const closedTrades = getClosedTrades(trades);

  // Days active
  const firstTrade = trades[0];
  const daysActive = firstTrade
    ? Math.floor((Date.now() - new Date(firstTrade.entryTime).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // Edge decay - compare last 30 days to previous 30 days
  const edgeDecay = calculateEdgeDecay(closedTrades);

  // BTC correlation (placeholder - would need BTC price data)
  const btcCorrelation = 0; // TODO: Implement with price feed

  // Execution slippage (placeholder - would need alert rate data)
  const avgSlippage = 0; // TODO: Implement when we have alert rates

  // Capital metrics
  const totalCapitalDeployed = trades.reduce((sum, t) => sum + t.notionalSize, 0);
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const capitalEfficiency = totalCapitalDeployed > 0
    ? totalPnl / totalCapitalDeployed
    : 0;

  return {
    edgeDecay,
    btcCorrelation,
    avgSlippage,
    daysActive,
    totalCapitalDeployed,
    capitalEfficiency,
  };
}

/**
 * Calculate edge decay by comparing recent vs historical performance
 */
function calculateEdgeDecay(closedTrades: PaperTrade[]): MetaMetrics['edgeDecay'] {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Last 30 days
  const last30 = closedTrades.filter(t =>
    t.exitTime && new Date(t.exitTime) >= thirtyDaysAgo
  );
  const last30Wins = last30.filter(t => (t.realizedPnl ?? 0) > 0);
  const last30DaysWinRate = last30.length > 0
    ? (last30Wins.length / last30.length) * 100
    : 0;

  // Previous 30 days (30-60 days ago)
  const prev30 = closedTrades.filter(t =>
    t.exitTime &&
    new Date(t.exitTime) >= sixtyDaysAgo &&
    new Date(t.exitTime) < thirtyDaysAgo
  );
  const prev30Wins = prev30.filter(t => (t.realizedPnl ?? 0) > 0);
  const previous30DaysWinRate = prev30.length > 0
    ? (prev30Wins.length / prev30.length) * 100
    : 0;

  // Determine trends
  const winRateDiff = last30DaysWinRate - previous30DaysWinRate;
  let winRateTrend: 'improving' | 'stable' | 'declining' = 'stable';
  if (winRateDiff > 5) winRateTrend = 'improving';
  if (winRateDiff < -5) winRateTrend = 'declining';

  // Sharpe trend (simplified)
  const sharpeTrend: 'improving' | 'stable' | 'declining' = 'stable'; // TODO: implement properly

  return {
    winRateTrend,
    sharpeTrend,
    last30DaysWinRate,
    previous30DaysWinRate,
  };
}

// ============================================================================
// DASHBOARD METRICS
// ============================================================================

/**
 * Calculate all metrics for dashboard display
 */
export function calculateDashboardMetrics(): DashboardMetrics {
  const trades = loadTrades();
  const state = loadState();

  return {
    primary: calculatePrimaryMetrics(trades, state),
    secondary: calculateSecondaryMetrics(trades, state),
    meta: calculateMetaMetrics(trades, state),
    lastCalculated: new Date().toISOString(),
  };
}

// ============================================================================
// DAILY SNAPSHOT
// ============================================================================

/**
 * Load daily snapshots
 */
export function loadSnapshots(): DailySnapshot[] {
  try {
    if (existsSync(SNAPSHOTS_FILE)) {
      return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Save daily snapshots
 */
export function saveSnapshots(snapshots: DailySnapshot[]): void {
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2));
}

/**
 * Capture today's snapshot (call once per day via cron)
 */
export function captureDailySnapshot(): DailySnapshot {
  const trades = loadTrades();
  const state = loadState();
  const snapshots = loadSnapshots();

  const today = new Date().toISOString().split('T')[0];

  // Check if we already have today's snapshot
  const existingIndex = snapshots.findIndex(s => s.date === today);

  // Calculate today's P&L (trades closed today)
  const closedToday = trades.filter(t =>
    t.exitTime && t.exitTime.startsWith(today)
  );
  const dailyPnl = closedToday.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);

  // Calculate rolling 7-day metrics
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const last7Days = trades.filter(t =>
    t.exitTime && new Date(t.exitTime) >= sevenDaysAgo
  );
  const last7Wins = last7Days.filter(t => (t.realizedPnl ?? 0) > 0);
  const rolling7dWinRate = last7Days.length > 0
    ? (last7Wins.length / last7Days.length) * 100
    : 0;

  // Simplified 7-day Sharpe
  const rolling7dSharpe = 0; // TODO: Implement properly

  const snapshot: DailySnapshot = {
    date: today,
    equity: state.currentEquity,
    dailyPnl,
    openPositions: state.openPositions.length,
    rolling7dWinRate,
    rolling7dSharpe,
  };

  if (existingIndex >= 0) {
    snapshots[existingIndex] = snapshot;
  } else {
    snapshots.push(snapshot);
  }

  saveSnapshots(snapshots);
  return snapshot;
}
