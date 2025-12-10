/**
 * Meridian Paper Trading - Alert Hook
 *
 * This module hooks into the alert system to automatically log paper trades
 * when alerts fire. It can be run in two modes:
 *
 * 1. AUTO mode:  Automatically open paper trades for every alert
 * 2. MANUAL mode: Just log alerts, require manual entry via CLI
 *
 * Set via PAPER_MODE env variable: "auto" or "manual" (default: manual)
 */

import 'dotenv/config';
import type { TradeAlert } from '../alerts/notifiers.js';
import {
  loadTrades,
  loadState,
  loadRiskConfig,
  openTrade,
  logAlert,
} from './tracker.js';

/**
 * Paper trading mode
 * - auto: Open trades automatically when alerts fire
 * - manual: Just log alerts, user must manually enter trades
 */
type PaperMode = 'auto' | 'manual';

function getPaperMode(): PaperMode {
  const mode = process.env.PAPER_MODE?.toLowerCase();
  return mode === 'auto' ? 'auto' : 'manual';
}

/**
 * Hook called when an alert is generated
 *
 * In AUTO mode: Opens a paper trade
 * In MANUAL mode: Just logs the alert for signal-to-trade ratio
 */
export async function onAlert(alert: TradeAlert): Promise<void> {
  const mode = getPaperMode();
  const trades = loadTrades();
  const state = loadState();
  const riskConfig = loadRiskConfig();

  console.log(`\n📝 [Paper] Alert received: ${alert.coin} ${alert.direction} (${alert.type})`);

  if (mode === 'manual') {
    // Just log the alert
    logAlert(alert);
    console.log(`   Mode: MANUAL - Alert logged, no trade opened`);
    console.log(`   To open trade: pnpm run paper:open ${alert.coin} ${alert.direction} ${alert.type}`);
    return;
  }

  // AUTO mode: Open the trade
  const positionSize = parseFloat(process.env.PAPER_POSITION_SIZE || '1000');
  const result = openTrade(alert, state, trades, riskConfig, positionSize);

  if (result.trade) {
    console.log(`   Mode: AUTO - Trade opened`);
    console.log(`   ID: ${result.trade.id.slice(0, 8)}...`);
    console.log(`   Leverage: ${result.leverageInfo}`);
    console.log(`   Collateral: $${(result.trade.notionalSize / result.trade.leverage).toFixed(0)}`);
    console.log(`   Notional: $${result.trade.notionalSize.toFixed(0)}`);
    console.log(`   Exit: ${result.trade.scheduledExitTime.split('T')[0]}`);
  } else {
    console.log(`   Mode: AUTO - Trade NOT opened`);
    console.log(`   Reason: ${result.reason}`);
  }
}

/**
 * Manually open a paper trade (for MANUAL mode)
 *
 * Usage: pnpm run paper:open HYPE SHORT mean_reversion
 */
export async function manualOpen(): Promise<void> {
  const [, , , coin, direction, strategy] = process.argv;

  if (!coin || !direction || !strategy) {
    console.log('\nUsage: pnpm run paper:open <COIN> <LONG|SHORT> <mean_reversion|spread_harvest>\n');
    console.log('Example: pnpm run paper:open HYPE SHORT mean_reversion\n');
    return;
  }

  const trades = loadTrades();
  const state = loadState();
  const riskConfig = loadRiskConfig();

  // Fetch current market data
  const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
  const res = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'fundingHistory',
      coin: coin.toUpperCase(),
      startTime: Date.now() - 2 * 60 * 60 * 1000,
    }),
  });

  if (!res.ok) {
    console.log('\n❌ Could not fetch current funding rate\n');
    return;
  }

  const data = await res.json();
  if (!data || data.length === 0) {
    console.log('\n❌ No funding data available\n');
    return;
  }

  const latest = data[data.length - 1];
  const currentApr = parseFloat(latest.fundingRate) * 24 * 365;

  // Load historical stats for z-score
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const DATA_DIR = join(process.cwd(), 'data');
  let zScore = 0;
  let mean = currentApr;
  let stdDev = 0;

  try {
    const statsFile = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    const statsData = JSON.parse(readFileSync(statsFile, 'utf-8'));
    mean = statsData.stats.mean;
    stdDev = statsData.stats.stdDev;
    zScore = stdDev > 0 ? (currentApr - mean) / stdDev : 0;
  } catch {
    console.log('⚠️  Could not load historical stats, using defaults');
  }

  // Fetch Boros implied rate
  let impliedApr = currentApr;
  try {
    const borosRes = await fetch('https://api.boros.finance/core/v1/markets');
    if (borosRes.ok) {
      const borosData = await borosRes.json();
      const market = borosData.results.find(
        (m: any) =>
          m.metadata.platformName === 'Hyperliquid' &&
          m.metadata.assetSymbol.toUpperCase() === coin.toUpperCase()
      );
      if (market) {
        impliedApr = market.data.ammImpliedApr;
      }
    }
  } catch {
    // Use current APR as fallback
  }

  // Create synthetic alert
  const holdDays = strategy === 'spread_harvest' ? 14 : 7;
  const alert: TradeAlert = {
    type: strategy as 'mean_reversion' | 'spread_harvest',
    coin: coin.toUpperCase(),
    direction: direction.toUpperCase() as 'LONG' | 'SHORT',
    currentApr,
    impliedApr,
    zScore,
    meanApr: mean,
    stdDev,
    spread: impliedApr - currentApr,
    holdDays,
    timestamp: new Date(),
  };

  const positionSize = parseFloat(process.env.PAPER_POSITION_SIZE || '1000');
  const result = openTrade(alert, state, trades, riskConfig, positionSize);

  if (result.trade) {
    console.log(`\n✅ Paper trade opened`);
    console.log(`   ID:         ${result.trade.id.slice(0, 8)}...`);
    console.log(`   Coin:       ${result.trade.coin}`);
    console.log(`   Direction:  ${result.trade.direction}`);
    console.log(`   Strategy:   ${result.trade.strategy}`);
    console.log(`   Size:       $${result.trade.notionalSize}`);
    console.log(`   Entry APR:  ${(result.trade.entryApr * 100).toFixed(2)}%`);
    console.log(`   Entry Z:    ${result.trade.entryZScore.toFixed(2)}σ`);
    console.log(`   Exit Date:  ${result.trade.scheduledExitTime.split('T')[0]}\n`);
  } else {
    console.log(`\n❌ Could not open trade: ${result.reason}\n`);
  }
}

// Run manual open if called directly with args
if (process.argv[2] === 'open') {
  manualOpen().catch(console.error);
}
