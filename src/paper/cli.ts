/**
 * Meridian Paper Trading - CLI Commands
 *
 * Individual command scripts for paper trading operations.
 *
 * Commands:
 *   pnpm run paper:status     - Show current open positions
 *   pnpm run paper:close      - Close a position manually
 *   pnpm run paper:process    - Check and close expired positions
 *   pnpm run paper:snapshot   - Capture daily snapshot
 *   pnpm run paper:reset      - Reset all paper trading data
 */

import 'dotenv/config';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  loadTrades,
  loadState,
  saveTrades,
  saveState,
  loadRiskConfig,
  getOpenTrades,
  getTradesDueForExit,
  getTradesAtStopLoss,
  closeTrade,
} from './tracker.js';
import { captureDailySnapshot } from './metrics.js';
import type { PaperTrade } from './types.js';

const DATA_DIR = join(process.cwd(), 'data');
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';

// ============================================================================
// HELPERS
// ============================================================================

async function fetchCurrentApr(coin: string): Promise<number | null> {
  try {
    const res = await fetch(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin,
        startTime: Date.now() - 2 * 60 * 60 * 1000,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.length === 0) return null;
    const latest = data[data.length - 1];
    return parseFloat(latest.fundingRate) * 24 * 365;
  } catch {
    return null;
  }
}

function loadHistoricalStats(coin: string): { mean: number; stdDev: number } | null {
  try {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return { mean: data.stats.mean, stdDev: data.stats.stdDev };
  } catch {
    return null;
  }
}

function calculateZScore(value: number, mean: number, stdDev: number): number {
  return stdDev > 0 ? (value - mean) / stdDev : 0;
}

// ============================================================================
// STATUS COMMAND
// ============================================================================

export async function statusCommand(): Promise<void> {
  console.log('\n📊 PAPER TRADING STATUS\n');

  const trades = loadTrades();
  const state = loadState();
  const openTrades = getOpenTrades(trades, state);

  console.log(`Equity: $${state.currentEquity.toFixed(2)} (started: $${state.startingCapital.toFixed(2)})`);
  console.log(`Peak:   $${state.peakEquity.toFixed(2)}`);
  console.log(`Open Positions: ${openTrades.length}\n`);

  if (openTrades.length === 0) {
    console.log('No open positions.\n');
    return;
  }

  console.log('OPEN POSITIONS:');
  console.log('─'.repeat(80));

  for (const trade of openTrades) {
    const currentApr = await fetchCurrentApr(trade.coin);
    const stats = loadHistoricalStats(trade.coin);
    const currentZ = currentApr && stats
      ? calculateZScore(currentApr, stats.mean, stats.stdDev)
      : null;

    const daysToExit = Math.max(0,
      (new Date(trade.scheduledExitTime).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    console.log(`\n  ${trade.coin} ${trade.direction} (${trade.strategy})`);
    console.log(`    ID:            ${trade.id.slice(0, 8)}...`);
    console.log(`    Size:          $${trade.notionalSize}`);
    console.log(`    Entry:         ${new Date(trade.entryTime).toLocaleString()}`);
    console.log(`    Entry Z-Score: ${trade.entryZScore.toFixed(2)}σ`);
    console.log(`    Current Z:     ${currentZ ? `${currentZ.toFixed(2)}σ` : 'N/A'}`);
    console.log(`    Unrealized:    $${trade.unrealizedPnl.toFixed(2)}`);
    console.log(`    Exit in:       ${daysToExit.toFixed(1)} days`);
  }

  console.log('\n' + '─'.repeat(80) + '\n');
}

// ============================================================================
// PROCESS COMMAND (Check and close expired positions)
// ============================================================================

export async function processCommand(): Promise<void> {
  console.log('\n⏰ PROCESSING PAPER TRADES\n');

  const trades = loadTrades();
  const state = loadState();
  const riskConfig = loadRiskConfig();

  // Check for time-based exits
  const dueForExit = getTradesDueForExit(trades, state);
  console.log(`Trades due for exit: ${dueForExit.length}`);

  for (const trade of dueForExit) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) {
      console.log(`  ⚠️  Could not fetch current APR for ${trade.coin}, skipping`);
      continue;
    }

    const stats = loadHistoricalStats(trade.coin);
    const exitZScore = stats ? calculateZScore(currentApr, stats.mean, stats.stdDev) : 0;

    closeTrade(trade, state, trades, currentApr, exitZScore, 'TIME_BASED');
    console.log(`  ✅ Closed ${trade.coin} ${trade.direction}: P&L = $${trade.realizedPnl?.toFixed(2)}`);
  }

  // Check for stop-losses
  const atStopLoss = getTradesAtStopLoss(trades, state, riskConfig);
  console.log(`Trades at stop-loss: ${atStopLoss.length}`);

  for (const trade of atStopLoss) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) continue;

    const stats = loadHistoricalStats(trade.coin);
    const exitZScore = stats ? calculateZScore(currentApr, stats.mean, stats.stdDev) : 0;

    closeTrade(trade, state, trades, currentApr, exitZScore, 'STOP_LOSS');
    console.log(`  🛑 Stop-loss ${trade.coin} ${trade.direction}: P&L = $${trade.realizedPnl?.toFixed(2)}`);
  }

  console.log('\nDone.\n');
}

// ============================================================================
// CLOSE COMMAND (Manual close)
// ============================================================================

export async function closeCommand(): Promise<void> {
  const tradeId = process.argv[3];

  if (!tradeId) {
    console.log('\nUsage: pnpm run paper:close <trade-id>\n');
    console.log('Get trade IDs from: pnpm run paper:status\n');
    return;
  }

  const trades = loadTrades();
  const state = loadState();

  const trade = trades.find(t => t.id.startsWith(tradeId));
  if (!trade) {
    console.log(`\n❌ Trade not found: ${tradeId}\n`);
    return;
  }

  if (trade.status === 'CLOSED') {
    console.log(`\n⚠️  Trade already closed\n`);
    return;
  }

  const currentApr = await fetchCurrentApr(trade.coin);
  if (currentApr === null) {
    console.log(`\n❌ Could not fetch current APR for ${trade.coin}\n`);
    return;
  }

  const stats = loadHistoricalStats(trade.coin);
  const exitZScore = stats ? calculateZScore(currentApr, stats.mean, stats.stdDev) : 0;

  closeTrade(trade, state, trades, currentApr, exitZScore, 'MANUAL');

  console.log(`\n✅ Closed ${trade.coin} ${trade.direction}`);
  console.log(`   P&L: $${trade.realizedPnl?.toFixed(2)}`);
  console.log(`   Exit Reason: MANUAL\n`);
}

// ============================================================================
// SNAPSHOT COMMAND
// ============================================================================

export function snapshotCommand(): void {
  console.log('\n📸 CAPTURING DAILY SNAPSHOT\n');

  const snapshot = captureDailySnapshot();

  console.log(`Date:           ${snapshot.date}`);
  console.log(`Equity:         $${snapshot.equity.toFixed(2)}`);
  console.log(`Daily P&L:      $${snapshot.dailyPnl.toFixed(2)}`);
  console.log(`Open Positions: ${snapshot.openPositions}`);
  console.log(`7d Win Rate:    ${snapshot.rolling7dWinRate.toFixed(1)}%`);
  console.log('\nSnapshot saved.\n');
}

// ============================================================================
// RESET COMMAND
// ============================================================================

export function resetCommand(): void {
  const confirm = process.argv[3];

  if (confirm !== '--confirm') {
    console.log('\n⚠️  This will delete all paper trading data!\n');
    console.log('To confirm: pnpm run paper:reset --confirm\n');
    return;
  }

  const files = [
    'paper-trades.json',
    'paper-state.json',
    'paper-snapshots.json',
    'paper-alerts-log.json',
  ];

  for (const file of files) {
    const path = join(DATA_DIR, file);
    try {
      unlinkSync(path);
      console.log(`Deleted: ${file}`);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  console.log('\n✅ Paper trading data reset.\n');
}

// ============================================================================
// EXPORT COMMAND
// ============================================================================

export function exportCommand(): void {
  const trades = loadTrades();

  if (trades.length === 0) {
    console.log('\nNo trades to export.\n');
    return;
  }

  // Generate CSV
  const headers = [
    'id', 'coin', 'direction', 'strategy', 'status',
    'entryTime', 'exitTime', 'holdDays',
    'entryApr', 'exitApr', 'entryZScore', 'exitZScore',
    'notionalSize', 'leverage', 'fees', 'realizedPnl', 'exitReason'
  ];

  const rows = trades.map(t => {
    const holdDays = t.exitTime
      ? (new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) / (1000 * 60 * 60 * 24)
      : '';
    return [
      t.id.slice(0, 8),
      t.coin,
      t.direction,
      t.strategy,
      t.status,
      t.entryTime,
      t.exitTime || '',
      holdDays,
      (t.entryApr * 100).toFixed(2),
      t.exitApr ? (t.exitApr * 100).toFixed(2) : '',
      t.entryZScore.toFixed(2),
      t.exitZScore?.toFixed(2) || '',
      t.notionalSize,
      t.leverage,
      t.fees.toFixed(2),
      t.realizedPnl?.toFixed(2) || '',
      t.exitReason || ''
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');

  const exportPath = join(DATA_DIR, `paper-trades-export-${new Date().toISOString().split('T')[0]}.csv`);
  writeFileSync(exportPath, csv);

  console.log(`\n✅ Exported ${trades.length} trades to:`);
  console.log(`   ${exportPath}\n`);
}

// ============================================================================
// COMMAND ROUTER
// ============================================================================

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'status':
      await statusCommand();
      break;
    case 'process':
      await processCommand();
      break;
    case 'close':
      await closeCommand();
      break;
    case 'snapshot':
      snapshotCommand();
      break;
    case 'reset':
      resetCommand();
      break;
    case 'export':
      exportCommand();
      break;
    default:
      console.log('\nMeridian Paper Trading CLI\n');
      console.log('Commands:');
      console.log('  status     Show open positions and current state');
      console.log('  process    Check and close expired positions');
      console.log('  close      Manually close a position by ID');
      console.log('  snapshot   Capture daily snapshot for trend analysis');
      console.log('  reset      Delete all paper trading data');
      console.log('  export     Export trades to CSV');
      console.log('\nExamples:');
      console.log('  pnpm run paper:status');
      console.log('  pnpm run paper:close abc123');
      console.log('  pnpm run paper:reset --confirm\n');
  }
}

main().catch(console.error);
