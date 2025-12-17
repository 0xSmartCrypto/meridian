/**
 * Meridian Paper Trading - Position Monitor
 *
 * Monitors open positions for exit conditions:
 * 1. Trailing stop (Trail 30% strategy) - exit when P&L drops 30% from peak
 * 2. Time-based exit - exit when scheduled exit time is reached
 * 3. Stop-loss - exit when position hits stop-loss threshold
 *
 * Run modes:
 *   pnpm run paper:monitor        # Single check
 *   pnpm run paper:monitor:watch  # Continuous monitoring (hourly)
 */

import 'dotenv/config';
import {
  loadTrades,
  loadState,
  loadRiskConfig,
  updateUnrealizedPnl,
  getTradesDueForExit,
  getTradesAtStopLoss,
  getTradesAtTrailingStop,
  closeTrade,
  saveTrades,
  saveState,
  checkKillSwitches,
  loadKillSwitchStatus,
} from './tracker.js';
import { fetchCurrentBorosApr, fetchCurrentHyperliquidApr } from '../data/boros.js';
import { sendExitNotification, sendTelegram, type ExitNotification } from '../alerts/notifiers.js';
import { loadConfig } from '../alerts/config.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Fetch current APR for a coin (tries Boros first, falls back to Hyperliquid)
 */
async function fetchCurrentApr(coin: string): Promise<number | null> {
  // Try Boros first (implied rate)
  const borosApr = await fetchCurrentBorosApr(coin);
  if (borosApr !== null) return borosApr;

  // Fallback to Hyperliquid funding rate
  return fetchCurrentHyperliquidApr(coin);
}

/**
 * Get current z-score for a coin
 */
function getCurrentZScore(coin: string, currentApr: number): number {
  try {
    const statsFile = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    const data = JSON.parse(readFileSync(statsFile, 'utf-8'));
    const { mean, stdDev } = data.stats;
    return stdDev > 0 ? (currentApr - mean) / stdDev : 0;
  } catch {
    return 0;
  }
}

/**
 * Send console notification
 */
function notify(message: string): void {
  console.log(`\n🔔 ${message}`);
}

// ============================================================================
// MAIN MONITOR LOGIC
// ============================================================================

export async function runMonitor(): Promise<{
  checked: number;
  trailingStopExits: number;
  timeBasedExits: number;
  stopLossExits: number;
}> {
  const trades = loadTrades();
  const state = loadState();
  const riskConfig = loadRiskConfig();
  const alertConfig = loadConfig();

  const openCount = state.openPositions.length;

  if (openCount === 0) {
    console.log('📊 No open positions to monitor');
    return { checked: 0, trailingStopExits: 0, timeBasedExits: 0, stopLossExits: 0 };
  }

  console.log(`\n📊 Monitoring ${openCount} open position(s)...`);
  console.log(`   Strategy: Hold ${riskConfig.minHoldHours}h min, 7 days max`);

  // Update unrealized P&L for all open positions
  await updateUnrealizedPnl(trades, state, fetchCurrentApr);

  let trailingStopExits = 0;
  let timeBasedExits = 0;
  let stopLossExits = 0;

  // 1. Check for trailing stop exits (Trail 30% strategy)
  const trailingStopTrades = getTradesAtTrailingStop(trades, state);
  for (const trade of trailingStopTrades) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) continue;

    const zScore = getCurrentZScore(trade.coin, currentApr);
    const entryTime = new Date(trade.entryTime);
    const holdHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    const drawdownPct = (trade.peakUnrealizedPnl - trade.unrealizedPnl) / trade.peakUnrealizedPnl * 100;

    notify(`TRAILING STOP: ${trade.coin} ${trade.direction}`);
    console.log(`   Peak P&L: $${trade.peakUnrealizedPnl.toFixed(2)} at hour ${trade.peakPnlHour}`);
    console.log(`   Current P&L: $${trade.unrealizedPnl.toFixed(2)}`);
    console.log(`   Drawdown: ${drawdownPct.toFixed(1)}% (threshold: ${(trade.trailingStopPct * 100).toFixed(0)}%)`);

    closeTrade(trade, state, trades, currentApr, zScore, 'TRAILING_STOP');
    trailingStopExits++;

    const pnlSign = (trade.realizedPnl ?? 0) >= 0 ? '+' : '';
    console.log(`   ✅ Closed with ${pnlSign}$${(trade.realizedPnl ?? 0).toFixed(2)} realized P&L`);

    // Send Telegram notification
    const exitNotif: ExitNotification = {
      coin: trade.coin,
      direction: trade.direction,
      exitReason: 'TRAILING_STOP',
      entryApr: trade.entryApr,
      exitApr: currentApr,
      holdHours,
      peakPnl: trade.peakUnrealizedPnl,
      realizedPnl: trade.realizedPnl ?? 0,
      drawdownFromPeak: drawdownPct,
    };
    await sendExitNotification(alertConfig, exitNotif);
  }

  // 2. Check for time-based exits
  const timeBasedTrades = getTradesDueForExit(trades, state);
  for (const trade of timeBasedTrades) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) continue;

    const zScore = getCurrentZScore(trade.coin, currentApr);
    const entryTime = new Date(trade.entryTime);
    const holdHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

    notify(`TIME EXIT: ${trade.coin} ${trade.direction} (${trade.targetHoldDays}d hold complete)`);

    closeTrade(trade, state, trades, currentApr, zScore, 'TIME_BASED');
    timeBasedExits++;

    const pnlSign = (trade.realizedPnl ?? 0) >= 0 ? '+' : '';
    console.log(`   ✅ Closed with ${pnlSign}$${(trade.realizedPnl ?? 0).toFixed(2)} realized P&L`);

    // Send Telegram notification
    const peakPnl = trade.peakUnrealizedPnl ?? Math.max(0, trade.realizedPnl ?? 0);
    const exitNotif: ExitNotification = {
      coin: trade.coin,
      direction: trade.direction,
      exitReason: 'TIME_BASED',
      entryApr: trade.entryApr,
      exitApr: currentApr,
      holdHours,
      peakPnl,
      realizedPnl: trade.realizedPnl ?? 0,
    };
    await sendExitNotification(alertConfig, exitNotif);
  }

  // 3. Check for stop-loss exits
  const stopLossTrades = getTradesAtStopLoss(trades, state, riskConfig);
  for (const trade of stopLossTrades) {
    const currentApr = await fetchCurrentApr(trade.coin);
    if (currentApr === null) continue;

    const zScore = getCurrentZScore(trade.coin, currentApr);
    const entryTime = new Date(trade.entryTime);
    const holdHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
    const lossPct = ((trade.unrealizedPnl / trade.notionalSize) * 100).toFixed(1);

    notify(`STOP LOSS: ${trade.coin} ${trade.direction} (${lossPct}% loss)`);

    closeTrade(trade, state, trades, currentApr, zScore, 'STOP_LOSS');
    stopLossExits++;

    console.log(`   ❌ Closed with $${(trade.realizedPnl ?? 0).toFixed(2)} realized P&L`);

    // Send Telegram notification
    const peakPnl = trade.peakUnrealizedPnl ?? 0;
    const exitNotif: ExitNotification = {
      coin: trade.coin,
      direction: trade.direction,
      exitReason: 'STOP_LOSS',
      entryApr: trade.entryApr,
      exitApr: currentApr,
      holdHours,
      peakPnl,
      realizedPnl: trade.realizedPnl ?? 0,
    };
    await sendExitNotification(alertConfig, exitNotif);
  }

  // Save updates
  saveTrades(trades);
  saveState(state);

  // ═══════════════════════════════════════════════════════════════════════════
  // KILL SWITCH CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  const { status: killStatus, alerts: killAlerts } = checkKillSwitches(trades, state);

  // Send Telegram alerts for any kill switch triggers
  for (const alert of killAlerts) {
    console.log(`\n🚨 KILL SWITCH ALERT:\n${alert}`);
    await sendTelegram(alertConfig, alert);
  }

  // Show kill switch status
  if (!killStatus.tradingEnabled) {
    console.log(`\n⛔ TRADING PAUSED: ${killStatus.disabledReason}`);
  } else if (killStatus.switches.coinPerformance.disabledCoins.length > 0) {
    console.log(`\n⚠️  Disabled coins: ${killStatus.switches.coinPerformance.disabledCoins.join(', ')}`);
  } else if (killStatus.switches.monthlyPerformance.reduceSize) {
    console.log(`\n⚠️  Warning: Edge compression detected. Consider reducing size.`);
  }

  // Summary
  const totalExits = trailingStopExits + timeBasedExits + stopLossExits;
  if (totalExits > 0) {
    console.log(`\n📊 Monitor Summary:`);
    console.log(`   Trailing stop exits: ${trailingStopExits}`);
    console.log(`   Time-based exits: ${timeBasedExits}`);
    console.log(`   Stop-loss exits: ${stopLossExits}`);
    console.log(`   Remaining open: ${state.openPositions.length}`);
  } else {
    console.log(`\n✅ All ${openCount} position(s) still within thresholds`);

    // Show current status of each position
    const openTrades = trades.filter(t => state.openPositions.includes(t.id));
    for (const trade of openTrades) {
      const entryTime = new Date(trade.entryTime);
      const hoursHeld = Math.floor((Date.now() - entryTime.getTime()) / (1000 * 60 * 60));

      // Handle legacy trades without trailing stop fields
      const peakPnl = trade.peakUnrealizedPnl ?? trade.unrealizedPnl;
      const drawdownPct = peakPnl > 0
        ? ((peakPnl - trade.unrealizedPnl) / peakPnl * 100)
        : 0;

      const pnlSign = trade.unrealizedPnl >= 0 ? '+' : '';
      console.log(
        `   ${trade.coin} ${trade.direction}: ${pnlSign}$${trade.unrealizedPnl.toFixed(2)} ` +
        `(peak: $${peakPnl.toFixed(2)}, DD: ${drawdownPct.toFixed(0)}%, held: ${hoursHeld}h)`
      );
    }
  }

  return { checked: openCount, trailingStopExits, timeBasedExits, stopLossExits };
}

/**
 * Run monitor in watch mode (checks every hour)
 */
async function runWatchMode(): Promise<void> {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  console.log('═'.repeat(70));
  console.log('  MERIDIAN POSITION MONITOR - WATCH MODE');
  console.log('  Strategy: Hold 7 days (time-based exit)');
  console.log('  Interval: Every hour');
  console.log('═'.repeat(70));

  // Initial check
  await runMonitor();

  // Schedule recurring checks
  setInterval(async () => {
    console.log('\n' + '─'.repeat(70));
    console.log(`  Check at ${new Date().toISOString()}`);
    console.log('─'.repeat(70));
    await runMonitor();
  }, INTERVAL_MS);

  console.log('\n⏰ Watch mode active. Press Ctrl+C to stop.\n');
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--watch') || args.includes('-w')) {
  runWatchMode().catch(console.error);
} else {
  runMonitor()
    .then(() => {
      console.log('\n💡 Tip: Use --watch for continuous monitoring');
    })
    .catch(console.error);
}
