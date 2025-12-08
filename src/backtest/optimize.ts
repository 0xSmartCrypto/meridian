/**
 * Meridian - Mean Reversion Parameter Optimization
 *
 * Honest attempt to find profitable configuration.
 * Tests multiple parameters systematically.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

interface FundingRecord {
  apr: number;
  time: number;
}

interface FundingData {
  coin: string;
  stats: { mean: number; stdDev: number; count: number };
  history: FundingRecord[];
}

interface Position {
  type: 'LONG' | 'SHORT';
  entryApr: number;
  entryIndex: number;
  notional: number;
}

interface Config {
  entryThreshold: number;
  minHoldHours: number;
  maxHoldHours: number;
  exitMode: 'zscore' | 'time' | 'profit_target';
  exitZThreshold: number;
  profitTargetPercent: number;
  takerFee: number;
  positionSize: number;
}

interface Result {
  config: Config;
  coin: string;
  trades: number;
  winRate: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  avgHoldHours: number;
  sharpe: number;
}

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1 };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev };
}

function zScore(value: number, mean: number, stdDev: number): number {
  return stdDev > 0 ? (value - mean) / stdDev : 0;
}

function runBacktest(data: FundingData, config: Config): Result {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  let position: Position | null = null;
  const trades: { pnl: number; holdHours: number }[] = [];

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const z = zScore(history[i].apr, mean, stdDev);

    if (position) {
      const holdHours = i - position.entryIndex;
      let shouldExit = false;

      // Check exit conditions based on mode
      if (config.exitMode === 'time') {
        shouldExit = holdHours >= config.maxHoldHours;
      } else if (config.exitMode === 'zscore') {
        if (holdHours >= config.minHoldHours) {
          if (position.type === 'SHORT' && z < config.exitZThreshold) shouldExit = true;
          if (position.type === 'LONG' && z > -config.exitZThreshold) shouldExit = true;
        }
        if (holdHours >= config.maxHoldHours) shouldExit = true;
      } else if (config.exitMode === 'profit_target') {
        // Calculate current PnL
        let runningPnl = 0;
        for (let j = position.entryIndex + 1; j <= i; j++) {
          const hourlyFixed = position.entryApr / 8760;
          const hourlyFloating = history[j].apr / 8760;
          if (position.type === 'SHORT') {
            runningPnl += (hourlyFixed - hourlyFloating) * position.notional;
          } else {
            runningPnl += (hourlyFloating - hourlyFixed) * position.notional;
          }
        }
        const pnlPercent = (runningPnl / (position.notional / 1)) * 100; // assuming 1x leverage for collateral
        if (pnlPercent >= config.profitTargetPercent) shouldExit = true;
        if (holdHours >= config.maxHoldHours) shouldExit = true;
      }

      if (shouldExit) {
        // Calculate settlement PnL
        let grossPnl = 0;
        for (let j = position.entryIndex + 1; j <= i; j++) {
          const hourlyFixed = position.entryApr / 8760;
          const hourlyFloating = history[j].apr / 8760;
          if (position.type === 'SHORT') {
            grossPnl += (hourlyFixed - hourlyFloating) * position.notional;
          } else {
            grossPnl += (hourlyFloating - hourlyFixed) * position.notional;
          }
        }
        const fees = position.notional * config.takerFee * 2;
        trades.push({ pnl: grossPnl - fees, holdHours });
        position = null;
      }
    }

    // Entry
    if (!position) {
      if (z > config.entryThreshold) {
        position = { type: 'SHORT', entryApr: history[i].apr, entryIndex: i, notional: config.positionSize };
      } else if (z < -config.entryThreshold) {
        position = { type: 'LONG', entryApr: history[i].apr, entryIndex: i, notional: config.positionSize };
      }
    }
  }

  // Stats
  const wins = trades.filter(t => t.pnl > 0);
  const grossPnl = trades.reduce((s, t) => s + t.pnl + config.positionSize * config.takerFee * 2, 0);
  const fees = trades.length * config.positionSize * config.takerFee * 2;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length : 0;

  // Sharpe
  const returns = trades.map(t => t.pnl / config.positionSize * 100);
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length - 1))
    : 1;
  const sharpe = stdRet > 0 ? avgRet / stdRet : 0;

  return {
    config,
    coin: data.coin,
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    grossPnl,
    fees,
    netPnl,
    avgHoldHours: avgHold,
    sharpe,
  };
}

async function main() {
  console.log('Meridian - Mean Reversion Parameter Optimization\n');
  console.log('Testing all combinations to find profitable configuration...\n');
  console.log('═'.repeat(80));

  const coins = ['HYPE', 'BTC', 'ETH'];
  const allResults: Result[] = [];

  // Parameter grid
  const entryThresholds = [2.0, 2.5, 3.0, 3.5];
  const minHoldHours = [24, 48, 72, 168]; // 1d, 2d, 3d, 1w
  const maxHoldHours = [168, 336, 504]; // 1w, 2w, 3w
  const exitModes: ('zscore' | 'time' | 'profit_target')[] = ['zscore', 'time', 'profit_target'];
  const fees = [0.0005, 0.0002, 0.0001]; // 0.05%, 0.02%, 0.01%

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    console.log(`\nTesting ${coin}...`);

    for (const entry of entryThresholds) {
      for (const minHold of minHoldHours) {
        for (const maxHold of maxHoldHours) {
          if (minHold >= maxHold) continue;
          for (const exitMode of exitModes) {
            for (const fee of fees) {
              const config: Config = {
                entryThreshold: entry,
                minHoldHours: minHold,
                maxHoldHours: maxHold,
                exitMode,
                exitZThreshold: 0.5,
                profitTargetPercent: 0.5, // 0.5% profit target
                takerFee: fee,
                positionSize: 10000,
              };

              const result = runBacktest(data, config);
              if (result.trades > 0) {
                allResults.push(result);
              }
            }
          }
        }
      }
    }
  }

  // Filter profitable results
  const profitable = allResults.filter(r => r.netPnl > 0 && r.trades >= 5);

  console.log('\n' + '═'.repeat(80));
  console.log('RESULTS');
  console.log('═'.repeat(80));

  if (profitable.length === 0) {
    console.log('\n❌ NO PROFITABLE CONFIGURATIONS FOUND\n');
    console.log('Tested', allResults.length, 'configurations across all coins.');
    console.log('Mean reversion strategy is NOT profitable with current data.\n');

    // Show best losing configs
    const bestLosers = [...allResults]
      .filter(r => r.trades >= 5)
      .sort((a, b) => b.netPnl - a.netPnl)
      .slice(0, 5);

    if (bestLosers.length > 0) {
      console.log('Least bad configurations:');
      console.log('─'.repeat(80));
      for (const r of bestLosers) {
        console.log(`${r.coin} | ${r.config.entryThreshold}σ | ${r.config.exitMode} | ${r.config.minHoldHours}h-${r.config.maxHoldHours}h | fee=${(r.config.takerFee * 100).toFixed(2)}%`);
        console.log(`  Trades: ${r.trades} | WR: ${(r.winRate * 100).toFixed(0)}% | Net: $${r.netPnl.toFixed(2)} | Avg Hold: ${r.avgHoldHours.toFixed(0)}h`);
      }
    }
  } else {
    // Sort by net PnL
    profitable.sort((a, b) => b.netPnl - a.netPnl);

    console.log(`\n✅ FOUND ${profitable.length} PROFITABLE CONFIGURATIONS\n`);
    console.log('Top 10:');
    console.log('─'.repeat(80));

    for (const r of profitable.slice(0, 10)) {
      console.log(`${r.coin} | ${r.config.entryThreshold}σ | ${r.config.exitMode} | ${r.config.minHoldHours}h-${r.config.maxHoldHours}h | fee=${(r.config.takerFee * 100).toFixed(2)}%`);
      console.log(`  Trades: ${r.trades} | WR: ${(r.winRate * 100).toFixed(0)}% | Gross: $${r.grossPnl.toFixed(2)} | Fees: $${r.fees.toFixed(2)} | Net: $${r.netPnl.toFixed(2)} | Sharpe: ${r.sharpe.toFixed(2)}`);
      console.log('');
    }

    // Check if profitable at realistic fees
    const realisticFee = profitable.filter(r => r.config.takerFee >= 0.0002);
    if (realisticFee.length === 0) {
      console.log('⚠️  WARNING: Profitable configs only exist at unrealistically low fees (0.01%)');
      console.log('   At realistic fees (0.02%+), strategy is NOT profitable.');
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('VERDICT');
  console.log('═'.repeat(80));

  const realisticProfitable = profitable.filter(r => r.config.takerFee >= 0.0002 && r.trades >= 5);

  if (realisticProfitable.length > 0) {
    console.log('\n✅ Mean reversion CAN be profitable with right parameters.');
    console.log('   Recommended config:');
    const best = realisticProfitable[0];
    console.log(`   - Entry threshold: ${best.config.entryThreshold}σ`);
    console.log(`   - Min hold: ${best.config.minHoldHours}h`);
    console.log(`   - Max hold: ${best.config.maxHoldHours}h`);
    console.log(`   - Exit mode: ${best.config.exitMode}`);
  } else {
    console.log('\n❌ Mean reversion is NOT profitable at realistic fee levels.');
    console.log('   RECOMMENDATION: Pivot to spread-harvest strategy only.');
  }
}

main().catch(console.error);
