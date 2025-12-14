/**
 * Meridian - Scalping vs Hold Strategy Comparison
 *
 * Hypothesis: Taking profits early and redeploying to new signals
 * might outperform holding for the full 7-day period.
 *
 * This backtest compares:
 * 1. Current: Hold for 7 days regardless of PnL
 * 2. Scalping: Exit early when profitable, redeploy capital
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

interface FundingRecord {
  apr: number;
  time: number;
  timestamp: string;
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
  entryTime: string;
  notional: number;
  peakPnl: number;
}

interface Trade {
  type: 'LONG' | 'SHORT';
  entryApr: number;
  exitApr: number;
  entryTime: string;
  exitTime: string;
  grossPnl: number;
  fees: number;
  netPnl: number;
  holdHours: number;
  exitReason: string;
  peakPnl: number;
  peakHour: number;
}

interface Config {
  name: string;
  entryThreshold: number;
  takerFee: number;
  positionSize: number;
  // Exit conditions
  maxHoldHours: number;
  takeProfitPct?: number;     // Exit if profit >= X% of notional
  trailingStopPct?: number;   // Exit if drawdown from peak >= X%
  minHoldHours?: number;      // Don't exit before this (avoid whipsaws)
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

function calculatePnlAtIndex(
  position: Position,
  history: FundingRecord[],
  currentIndex: number
): number {
  let pnl = 0;
  for (let j = position.entryIndex + 1; j <= currentIndex; j++) {
    const hourlyFixed = position.entryApr / 8760;
    const hourlyFloating = history[j].apr / 8760;
    if (position.type === 'SHORT') {
      pnl += (hourlyFixed - hourlyFloating) * position.notional;
    } else {
      pnl += (hourlyFloating - hourlyFixed) * position.notional;
    }
  }
  return pnl;
}

function runBacktest(data: FundingData, config: Config) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  let position: Position | null = null;
  const trades: Trade[] = [];

  // Track metrics
  let equity = 10000;
  let maxEquity = equity;
  let maxDrawdown = 0;
  let totalHoursInPosition = 0;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const z = zScore(history[i].apr, mean, stdDev);

    // Check for exit conditions
    if (position) {
      const holdHours = i - position.entryIndex;
      const currentPnl = calculatePnlAtIndex(position, history, i);
      const currentPnlPct = currentPnl / position.notional;

      // Update peak PnL tracking
      if (currentPnl > position.peakPnl) {
        position.peakPnl = currentPnl;
      }

      const drawdownFromPeak = position.peakPnl > 0
        ? (position.peakPnl - currentPnl) / position.peakPnl
        : 0;

      let shouldExit = false;
      let exitReason = '';
      const minHoldMet = !config.minHoldHours || holdHours >= config.minHoldHours;

      // Check exit conditions
      if (holdHours >= config.maxHoldHours) {
        shouldExit = true;
        exitReason = 'max_hold';
      } else if (minHoldMet && config.takeProfitPct && currentPnlPct >= config.takeProfitPct) {
        shouldExit = true;
        exitReason = `take_profit_${(config.takeProfitPct * 100).toFixed(1)}%`;
      } else if (minHoldMet && config.trailingStopPct && position.peakPnl > 0 && drawdownFromPeak >= config.trailingStopPct) {
        shouldExit = true;
        exitReason = `trailing_stop_${(config.trailingStopPct * 100).toFixed(0)}%`;
      }

      if (shouldExit) {
        const fees = config.positionSize * config.takerFee * 2;
        const netPnl = currentPnl - fees;

        // Find peak hour
        let peakHour = 0;
        let peakVal = 0;
        for (let k = position.entryIndex + 1; k <= i; k++) {
          const pnl = calculatePnlAtIndex(position, history, k);
          if (pnl > peakVal) {
            peakVal = pnl;
            peakHour = k - position.entryIndex;
          }
        }

        trades.push({
          type: position.type,
          entryApr: position.entryApr,
          exitApr: history[i].apr,
          entryTime: position.entryTime,
          exitTime: history[i].timestamp,
          grossPnl: currentPnl,
          fees,
          netPnl,
          holdHours,
          exitReason,
          peakPnl: position.peakPnl,
          peakHour,
        });

        totalHoursInPosition += holdHours;
        equity += netPnl;
        maxEquity = Math.max(maxEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (maxEquity - equity) / maxEquity);
        position = null;
      }
    }

    // Check for entry
    if (!position) {
      if (z > config.entryThreshold) {
        position = {
          type: 'SHORT',
          entryApr: history[i].apr,
          entryIndex: i,
          entryTime: history[i].timestamp,
          notional: config.positionSize,
          peakPnl: 0,
        };
      } else if (z < -config.entryThreshold) {
        position = {
          type: 'LONG',
          entryApr: history[i].apr,
          entryIndex: i,
          entryTime: history[i].timestamp,
          notional: config.positionSize,
          peakPnl: 0,
        };
      }
    }
  }

  // Calculate stats
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossPnl = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgHoldHours = trades.length > 0 ? totalHoursInPosition / trades.length : 0;

  // Capital efficiency: how much time was capital deployed?
  const totalDataHours = history.length - 168;
  const capitalUtilization = totalDataHours > 0 ? totalHoursInPosition / totalDataHours : 0;

  // Annualized return
  const totalDays = history.length / 24;
  const annualized = totalDays > 0 ? (netPnl / 10000) * (365 / totalDays) * 100 : 0;

  // PnL per hour in position (efficiency metric)
  const pnlPerHour = totalHoursInPosition > 0 ? netPnl / totalHoursInPosition : 0;

  return {
    coin: data.coin,
    config,
    trades,
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      grossPnl,
      totalFees,
      netPnl,
      avgPnl: trades.length > 0 ? netPnl / trades.length : 0,
      avgHoldHours,
      maxDrawdown,
      annualized,
      capitalUtilization,
      pnlPerHour,
      finalEquity: equity,
    },
  };
}

async function main() {
  console.log('Meridian - Scalping vs Hold Comparison\n');
  console.log('═'.repeat(90));
  console.log('\nHypothesis: Early profit-taking + redeployment beats fixed hold periods');
  console.log('Testing: Multiple exit strategies on same entry signals\n');

  const coins = ['HYPE', 'BTC', 'ETH'];
  const baseConfig = {
    entryThreshold: 2.5,
    takerFee: 0.0005,
    positionSize: 10000,
  };

  const strategies: Omit<Config, 'entryThreshold' | 'takerFee' | 'positionSize'>[] = [
    // Current approach
    { name: 'HOLD 7 days', maxHoldHours: 168 },

    // Scalping: Take profit targets
    { name: 'TP 0.5%', maxHoldHours: 168, takeProfitPct: 0.005, minHoldHours: 6 },
    { name: 'TP 1.0%', maxHoldHours: 168, takeProfitPct: 0.01, minHoldHours: 6 },
    { name: 'TP 2.0%', maxHoldHours: 168, takeProfitPct: 0.02, minHoldHours: 6 },
    { name: 'TP 3.0%', maxHoldHours: 168, takeProfitPct: 0.03, minHoldHours: 6 },

    // Trailing stops (exit when giving back profits)
    { name: 'Trail 30%', maxHoldHours: 168, trailingStopPct: 0.30, minHoldHours: 12 },
    { name: 'Trail 50%', maxHoldHours: 168, trailingStopPct: 0.50, minHoldHours: 12 },

    // Combined: Take profit OR trailing stop
    { name: 'TP 1% + Trail 50%', maxHoldHours: 168, takeProfitPct: 0.01, trailingStopPct: 0.50, minHoldHours: 6 },
    { name: 'TP 2% + Trail 30%', maxHoldHours: 168, takeProfitPct: 0.02, trailingStopPct: 0.30, minHoldHours: 12 },

    // Shorter max holds
    { name: 'HOLD 3 days', maxHoldHours: 72 },
    { name: 'HOLD 1 day', maxHoldHours: 24 },
  ];

  const allResults: Map<string, ReturnType<typeof runBacktest>[]> = new Map();

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`No data for ${coin}, skipping...`);
      continue;
    }

    console.log(`\n${'─'.repeat(90)}`);
    console.log(`${coin} (${data.stats.count} hours of data)`);
    console.log('─'.repeat(90));

    const results: ReturnType<typeof runBacktest>[] = [];

    for (const strat of strategies) {
      const config: Config = { ...baseConfig, ...strat };
      const result = runBacktest(data, config);
      results.push(result);
    }

    allResults.set(coin, results);

    // Print comparison table
    console.log('\n' + 'Strategy'.padEnd(22) + 'Trades'.padStart(8) + 'WinRate'.padStart(10) +
                'NetPnL'.padStart(12) + 'AvgHold'.padStart(10) + '$/Hour'.padStart(10) +
                'Ann%'.padStart(10));
    console.log('─'.repeat(82));

    for (const r of results) {
      const profitable = r.stats.netPnl > 0;
      const icon = profitable ? '✅' : '❌';
      console.log(
        `${icon} ${r.config.name.padEnd(20)}` +
        `${r.stats.totalTrades.toString().padStart(6)}` +
        `${(r.stats.winRate * 100).toFixed(0).padStart(8)}%` +
        `$${r.stats.netPnl.toFixed(0).padStart(10)}` +
        `${r.stats.avgHoldHours.toFixed(0).padStart(8)}h` +
        `$${r.stats.pnlPerHour.toFixed(2).padStart(8)}` +
        `${r.stats.annualized.toFixed(1).padStart(9)}%`
      );
    }
  }

  // Trade-level PnL curve analysis for HYPE
  console.log('\n' + '═'.repeat(90));
  console.log('TRADE-LEVEL ANALYSIS: HYPE');
  console.log('═'.repeat(90));

  const hypeResults = allResults.get('HYPE');
  if (hypeResults) {
    const holdTrades = hypeResults.find(r => r.config.name === 'HOLD 7 days')?.trades || [];

    console.log('\nPnL progression within each 7-day hold trade:');
    console.log('(Shows peak PnL and when it occurred)\n');

    console.log('Trade#'.padEnd(8) + 'Type'.padEnd(7) + 'FinalPnL'.padStart(12) +
                'PeakPnL'.padStart(12) + 'PeakHour'.padStart(10) + 'MissedGain'.padStart(12));
    console.log('─'.repeat(61));

    let totalMissed = 0;
    let tradesWithEarlyPeak = 0;

    for (let i = 0; i < holdTrades.length; i++) {
      const t = holdTrades[i];
      const missedGain = t.peakPnl - t.netPnl - t.fees;
      if (t.peakHour < t.holdHours * 0.8 && missedGain > 10) {
        tradesWithEarlyPeak++;
        totalMissed += missedGain;
      }

      console.log(
        `#${(i + 1).toString().padEnd(6)}` +
        `${t.type.padEnd(7)}` +
        `$${t.netPnl.toFixed(2).padStart(10)}` +
        `$${t.peakPnl.toFixed(2).padStart(10)}` +
        `${t.peakHour.toString().padStart(8)}h` +
        `$${missedGain.toFixed(2).padStart(10)}`
      );
    }

    console.log('─'.repeat(61));
    console.log(`\nTrades where peak occurred early (< 80% of hold): ${tradesWithEarlyPeak}/${holdTrades.length}`);
    console.log(`Total potential gain from earlier exits: $${totalMissed.toFixed(2)}`);
  }

  // Summary
  console.log('\n' + '═'.repeat(90));
  console.log('SUMMARY: BEST STRATEGY PER COIN');
  console.log('═'.repeat(90));

  for (const [coin, results] of allResults) {
    const best = results.reduce((a, b) => a.stats.netPnl > b.stats.netPnl ? a : b);
    const hold = results.find(r => r.config.name === 'HOLD 7 days')!;

    console.log(`\n${coin}:`);
    console.log(`  Best: ${best.config.name} → $${best.stats.netPnl.toFixed(0)} (${best.stats.annualized.toFixed(1)}% ann.)`);
    console.log(`  Hold: $${hold.stats.netPnl.toFixed(0)} (${hold.stats.annualized.toFixed(1)}% ann.)`);

    if (best.config.name !== 'HOLD 7 days') {
      const improvement = ((best.stats.netPnl - hold.stats.netPnl) / Math.abs(hold.stats.netPnl)) * 100;
      console.log(`  Δ: ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}% vs hold`);
    }
  }

  console.log('\n' + '─'.repeat(90));
  console.log('KEY QUESTION: Is the higher $/hour from scalping offset by lower capital utilization?');
  console.log('─'.repeat(90));

  // Deep dive: WHY do trailing stops help?
  console.log('\n' + '═'.repeat(90));
  console.log('DEEP DIVE: WHY TRAILING STOPS WIN');
  console.log('═'.repeat(90));

  for (const [coin, results] of allResults) {
    const hold = results.find(r => r.config.name === 'HOLD 7 days')!;
    const trail30 = results.find(r => r.config.name === 'Trail 30%')!;

    console.log(`\n${coin}:`);
    console.log(`  HOLD 7d: ${hold.stats.totalTrades} trades, ${hold.stats.wins}W/${hold.stats.losses}L`);
    console.log(`  Trail30: ${trail30.stats.totalTrades} trades, ${trail30.stats.wins}W/${trail30.stats.losses}L`);

    // Analyze exit reasons
    const exitReasons = trail30.trades.reduce((acc, t) => {
      acc[t.exitReason] = (acc[t.exitReason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(`  Exit reasons: ${JSON.stringify(exitReasons)}`);

    // Compare avg losing trade
    const holdLosses = hold.trades.filter(t => t.netPnl < 0);
    const trailLosses = trail30.trades.filter(t => t.netPnl < 0);

    if (holdLosses.length > 0) {
      const avgHoldLoss = holdLosses.reduce((s, t) => s + t.netPnl, 0) / holdLosses.length;
      console.log(`  Hold avg loss: $${avgHoldLoss.toFixed(2)}`);
    }
    if (trailLosses.length > 0) {
      const avgTrailLoss = trailLosses.reduce((s, t) => s + t.netPnl, 0) / trailLosses.length;
      console.log(`  Trail avg loss: $${avgTrailLoss.toFixed(2)}`);
    }
  }
}

main().catch(console.error);
