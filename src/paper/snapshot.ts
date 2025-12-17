/**
 * Meridian Paper Trading - Daily Snapshot
 *
 * Captures daily metrics for time-series analysis:
 * - Equity curve
 * - Rolling win rate
 * - Rolling Sharpe
 *
 * Run daily via cron: pnpm run paper:snapshot
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadTrades, loadState } from './tracker.js';
import type { DailySnapshot, PaperTrade } from './types.js';

const DATA_DIR = join(process.cwd(), 'data');
const SNAPSHOTS_FILE = join(DATA_DIR, 'paper-snapshots.json');

/**
 * Load existing snapshots
 */
function loadSnapshots(): DailySnapshot[] {
  try {
    if (existsSync(SNAPSHOTS_FILE)) {
      return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * Save snapshots
 */
function saveSnapshots(snapshots: DailySnapshot[]): void {
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2));
}

/**
 * Calculate rolling win rate over last N trades
 */
function calculateRollingWinRate(trades: PaperTrade[], lookback: number = 7): number {
  const closedTrades = trades.filter(t => t.status === 'CLOSED');
  if (closedTrades.length === 0) return 0;

  const recentTrades = closedTrades.slice(-lookback);
  const wins = recentTrades.filter(t => (t.realizedPnl ?? 0) > 0).length;
  return wins / recentTrades.length;
}

/**
 * Calculate rolling Sharpe ratio
 * Sharpe = (mean return - risk free) / std dev
 * Using 0% risk-free for simplicity
 */
function calculateRollingSharpe(trades: PaperTrade[], lookback: number = 7): number {
  const closedTrades = trades.filter(t => t.status === 'CLOSED');
  if (closedTrades.length < 2) return 0;

  const recentTrades = closedTrades.slice(-lookback);
  const returns = recentTrades.map(t => (t.realizedPnl ?? 0) / t.notionalSize);

  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: assume ~50 trades/year for this strategy
  const annualizedReturn = mean * 50;
  const annualizedStdDev = stdDev * Math.sqrt(50);

  return annualizedReturn / annualizedStdDev;
}

/**
 * Calculate daily P&L (trades closed today)
 */
function calculateDailyPnl(trades: PaperTrade[], date: string): number {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const todaysTrades = trades.filter(t => {
    if (!t.exitTime) return false;
    const exitDate = new Date(t.exitTime);
    return exitDate >= dayStart && exitDate <= dayEnd;
  });

  return todaysTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
}

/**
 * Capture today's snapshot
 */
export function captureSnapshot(): DailySnapshot {
  const trades = loadTrades();
  const state = loadState();

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const snapshot: DailySnapshot = {
    date: today,
    equity: state.currentEquity,
    dailyPnl: calculateDailyPnl(trades, today),
    openPositions: state.openPositions.length,
    rolling7dWinRate: calculateRollingWinRate(trades, 7),
    rolling7dSharpe: calculateRollingSharpe(trades, 7),
  };

  return snapshot;
}

/**
 * Save today's snapshot (updates if already exists for today)
 */
export function saveSnapshot(): void {
  const snapshots = loadSnapshots();
  const newSnapshot = captureSnapshot();

  // Check if we already have a snapshot for today
  const todayIndex = snapshots.findIndex(s => s.date === newSnapshot.date);

  if (todayIndex >= 0) {
    // Update existing
    snapshots[todayIndex] = newSnapshot;
    console.log(`📸 Updated snapshot for ${newSnapshot.date}`);
  } else {
    // Add new
    snapshots.push(newSnapshot);
    console.log(`📸 Captured snapshot for ${newSnapshot.date}`);
  }

  saveSnapshots(snapshots);

  // Display
  console.log(`   Equity: $${newSnapshot.equity.toFixed(2)}`);
  console.log(`   Daily P&L: $${newSnapshot.dailyPnl.toFixed(2)}`);
  console.log(`   Open positions: ${newSnapshot.openPositions}`);
  console.log(`   Rolling 7d win rate: ${(newSnapshot.rolling7dWinRate * 100).toFixed(0)}%`);
  console.log(`   Rolling 7d Sharpe: ${newSnapshot.rolling7dSharpe.toFixed(2)}`);
}

/**
 * Display snapshot history
 */
export function displayHistory(): void {
  const snapshots = loadSnapshots();

  if (snapshots.length === 0) {
    console.log('No snapshots yet. Run: pnpm run paper:snapshot');
    return;
  }

  console.log('\n📊 EQUITY HISTORY');
  console.log('─'.repeat(70));
  console.log('Date        | Equity     | Daily P&L | Open | Win Rate | Sharpe');
  console.log('─'.repeat(70));

  for (const s of snapshots) {
    const pnlSign = s.dailyPnl >= 0 ? '+' : '';
    console.log(
      `${s.date} | $${s.equity.toFixed(2).padStart(9)} | ${pnlSign}$${s.dailyPnl.toFixed(2).padStart(7)} | ${s.openPositions.toString().padStart(4)} | ${(s.rolling7dWinRate * 100).toFixed(0).padStart(6)}% | ${s.rolling7dSharpe.toFixed(2).padStart(6)}`
    );
  }

  console.log('─'.repeat(70));

  // Summary stats
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const totalReturn = last.equity - first.equity;
  const totalReturnPct = (totalReturn / first.equity) * 100;

  console.log(`\nTotal: ${totalReturn >= 0 ? '+' : ''}$${totalReturn.toFixed(2)} (${totalReturnPct.toFixed(1)}%)`);
  console.log(`Days: ${snapshots.length}`);
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--history') || args.includes('-h')) {
  displayHistory();
} else {
  saveSnapshot();
}
