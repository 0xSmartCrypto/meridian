/**
 * Spread Harvest Exit Strategy Comparison
 *
 * Tests different exit strategies for spread_harvest trades:
 * - Hold 14 days (baseline)
 * - Take profit at various levels
 * - Trailing stops
 * - Spread compression exit (exit when spread narrows)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

interface FundingRecord {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
  apr: number;
  timestamp: string;
}

interface FundingData {
  coin: string;
  stats: {
    mean: number;
    stdDev: number;
  };
  history: FundingRecord[];
}

interface Position {
  type: 'SHORT' | 'LONG';
  entryImplied: number;       // Fixed rate locked at entry
  entryUnderlying: number;
  entrySpread: number;
  entryTime: string;
  entryIndex: number;
  notional: number;
  peakPnl: number;
  peakHour: number;
  cumulativePnl: number;      // Sum of hourly P&L
  lastUpdateIndex: number;    // Last hour we updated P&L
}

interface Trade {
  type: 'SHORT' | 'LONG';
  entrySpread: number;
  exitSpread: number;
  holdingHours: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  exitReason: string;
  peakPnl: number;
  peakHour: number;
}

interface ExitStrategy {
  name: string;
  takeProfitPct?: number;      // Exit when P&L hits X% of notional
  trailingStopPct?: number;    // Exit when P&L drops X% from peak
  minHoldHours?: number;       // Minimum hours before trailing stop activates
  spreadCompressionPct?: number; // Exit when spread narrows to X% of entry
  maxHoldDays: number;         // Maximum hold period
}

const EXIT_STRATEGIES: ExitStrategy[] = [
  // Baseline - full hold
  { name: 'Hold 14d', maxHoldDays: 14 },
  { name: 'Hold 7d', maxHoldDays: 7 },

  // Take profit
  { name: 'TP 0.5%', takeProfitPct: 0.005, maxHoldDays: 14 },
  { name: 'TP 1%', takeProfitPct: 0.01, maxHoldDays: 14 },
  { name: 'TP 2%', takeProfitPct: 0.02, maxHoldDays: 14 },

  // Trailing stops
  { name: 'Trail 30%', trailingStopPct: 0.30, minHoldHours: 12, maxHoldDays: 14 },
  { name: 'Trail 50%', trailingStopPct: 0.50, minHoldHours: 12, maxHoldDays: 14 },
  { name: 'Trail 30% 24h', trailingStopPct: 0.30, minHoldHours: 24, maxHoldDays: 14 },

  // Spread compression (exit when spread narrows)
  { name: 'Spread 50%', spreadCompressionPct: 0.50, maxHoldDays: 14 },
  { name: 'Spread 25%', spreadCompressionPct: 0.25, maxHoldDays: 14 },

  // Combinations
  { name: 'Trail 30% + TP 1%', trailingStopPct: 0.30, minHoldHours: 12, takeProfitPct: 0.01, maxHoldDays: 14 },
  { name: 'Spread 50% + Trail 30%', spreadCompressionPct: 0.50, trailingStopPct: 0.30, minHoldHours: 12, maxHoldDays: 14 },
];

const CONFIG = {
  minSpreadToEnter: 0.05,  // 5% spread minimum
  impliedPremium: 0.03,    // 3% premium over underlying
  impliedWindow: 168,      // 7 days rolling window
  positionSize: 10000,
  // Boros fee structure (per trade):
  // - Opening: 0.05% × notional × (days/365) ≈ $0.19 for 14d
  // - Settlement: 0.2% annualized × notional × (days/365) ≈ $0.77 for 14d
  // - No closing fee
  // Total: ~$1-2 per 14d trade
  openingFeeRate: 0.0005,   // 0.05% opening fee rate
  settlementFeeRate: 0.002, // 0.2% annualized settlement fee
  slippagePct: 0.0001,      // 0.01% slippage (minimal for rate locking)
};

function calculateImplied(
  history: FundingRecord[],
  index: number,
  window: number,
  premium: number
): number {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index + 1).map(h => h.apr);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  return mean + premium;
}

/**
 * Calculate hourly P&L increment for spread harvest
 *
 * Spread harvest P&L accumulates each hour:
 * - SHORT: receive fixed (entry implied), pay floating (hourly underlying)
 * - LONG: pay fixed (entry implied), receive floating (hourly underlying)
 *
 * Hourly P&L = (fixed - floating) × notional × (1/8760)
 */
function calculateHourlyPnl(
  position: Position,
  hourlyUnderlying: number
): number {
  const hourlyFraction = 1 / 8760;  // 1 hour / 8760 hours per year

  if (position.type === 'SHORT') {
    // Receive fixed, pay floating
    const hourlySpread = position.entryImplied - hourlyUnderlying;
    return hourlySpread * position.notional * hourlyFraction;
  } else {
    // Pay fixed, receive floating
    const hourlySpread = hourlyUnderlying - position.entryImplied;
    return hourlySpread * position.notional * hourlyFraction;
  }
}

function runBacktest(
  data: FundingData,
  strategy: ExitStrategy
): { trades: Trade[]; totalPnl: number; avgHoldHours: number } {
  const history = data.history.filter(h => h.apr >= -1.0 && h.apr <= 1.5);
  const trades: Trade[] = [];
  let position: Position | null = null;

  const maxHoldHours = strategy.maxHoldDays * 24;

  for (let i = CONFIG.impliedWindow; i < history.length; i++) {
    const record = history[i];
    const underlying = record.apr;
    const implied = calculateImplied(history, i, CONFIG.impliedWindow, CONFIG.impliedPremium);
    const currentSpread = implied - underlying;

    // Update position if open
    if (position) {
      const hoursHeld = i - position.entryIndex;

      // Accumulate hourly P&L for each hour since last update
      for (let h = position.lastUpdateIndex + 1; h <= i; h++) {
        const hourlyUnderlying = history[h].apr;
        position.cumulativePnl += calculateHourlyPnl(position, hourlyUnderlying);
      }
      position.lastUpdateIndex = i;

      const currentPnl = position.cumulativePnl;

      // Track peak
      if (currentPnl > position.peakPnl) {
        position.peakPnl = currentPnl;
        position.peakHour = hoursHeld;
      }

      let shouldExit = false;
      let exitReason = '';

      // Check max hold
      if (hoursHeld >= maxHoldHours) {
        shouldExit = true;
        exitReason = 'MAX_HOLD';
      }

      // Check take profit
      if (!shouldExit && strategy.takeProfitPct) {
        const tpThreshold = CONFIG.positionSize * strategy.takeProfitPct;
        if (currentPnl >= tpThreshold) {
          shouldExit = true;
          exitReason = 'TAKE_PROFIT';
        }
      }

      // Check spread compression
      if (!shouldExit && strategy.spreadCompressionPct) {
        const spreadNow = position.type === 'SHORT'
          ? implied - underlying
          : underlying - implied;
        const spreadRatio = spreadNow / Math.abs(position.entrySpread);
        if (spreadRatio <= strategy.spreadCompressionPct) {
          shouldExit = true;
          exitReason = 'SPREAD_COMPRESSED';
        }
      }

      // Check trailing stop (after min hold)
      if (!shouldExit && strategy.trailingStopPct && strategy.minHoldHours) {
        if (hoursHeld >= strategy.minHoldHours && position.peakPnl > 0) {
          const drawdownFromPeak = (position.peakPnl - currentPnl) / position.peakPnl;
          if (drawdownFromPeak >= strategy.trailingStopPct) {
            shouldExit = true;
            exitReason = 'TRAILING_STOP';
          }
        }
      }

      if (shouldExit) {
        // Boros fee structure:
        // - Opening fee: 0.05% × notional × (days to maturity / 365)
        // - Settlement fee: 0.2% × notional × (days held / 365)
        // - Slippage: minimal
        const daysHeld = hoursHeld / 24;
        const openingFee = CONFIG.positionSize * CONFIG.openingFeeRate * (strategy.maxHoldDays / 365);
        const settlementFee = CONFIG.positionSize * CONFIG.settlementFeeRate * (daysHeld / 365);
        const slippage = CONFIG.positionSize * CONFIG.slippagePct;
        const fees = openingFee + settlementFee + slippage;
        trades.push({
          type: position.type,
          entrySpread: position.entrySpread,
          exitSpread: currentSpread,
          holdingHours: hoursHeld,
          grossPnl: currentPnl,
          fees,
          netPnl: currentPnl - fees,
          exitReason,
          peakPnl: position.peakPnl,
          peakHour: position.peakHour,
        });
        position = null;
      }
    }

    // Check for new entry
    if (!position) {
      const spread = implied - underlying;

      if (spread >= CONFIG.minSpreadToEnter) {
        position = {
          type: 'SHORT',
          entryImplied: implied,
          entryUnderlying: underlying,
          entrySpread: spread,
          entryTime: record.timestamp,
          entryIndex: i,
          notional: CONFIG.positionSize,
          peakPnl: 0,
          peakHour: 0,
          cumulativePnl: 0,
          lastUpdateIndex: i,
        };
      } else if (spread <= -CONFIG.minSpreadToEnter) {
        position = {
          type: 'LONG',
          entryImplied: implied,
          entryUnderlying: underlying,
          entrySpread: spread,
          entryTime: record.timestamp,
          entryIndex: i,
          notional: CONFIG.positionSize,
          peakPnl: 0,
          peakHour: 0,
          cumulativePnl: 0,
          lastUpdateIndex: i,
        };
      }
    }
  }

  const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);
  const totalGrossPnl = trades.reduce((sum, t) => sum + t.grossPnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);
  const avgHoldHours = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.holdingHours, 0) / trades.length
    : 0;

  return { trades, totalPnl, avgHoldHours, totalGrossPnl, totalFees };
}

async function main() {
  console.log('═'.repeat(90));
  console.log('  SPREAD HARVEST EXIT STRATEGY COMPARISON');
  console.log('═'.repeat(90));
  console.log(`\n  Entry criteria: Spread >= ${(CONFIG.minSpreadToEnter * 100).toFixed(0)}%`);
  console.log(`  Position size: $${CONFIG.positionSize.toLocaleString()}`);
  console.log(`  Boros fees (14d trade example):`);
  console.log(`    Opening: ${(CONFIG.openingFeeRate * 100).toFixed(2)}% × (14/365) = $${(CONFIG.positionSize * CONFIG.openingFeeRate * 14/365).toFixed(2)}`);
  console.log(`    Settlement: ${(CONFIG.settlementFeeRate * 100).toFixed(1)}% ann. × (14/365) = $${(CONFIG.positionSize * CONFIG.settlementFeeRate * 14/365).toFixed(2)}`);
  console.log(`    Slippage: ${(CONFIG.slippagePct * 100).toFixed(2)}% = $${(CONFIG.positionSize * CONFIG.slippagePct).toFixed(2)}`);
  console.log(`    Total: ~$${(CONFIG.positionSize * CONFIG.openingFeeRate * 14/365 + CONFIG.positionSize * CONFIG.settlementFeeRate * 14/365 + CONFIG.positionSize * CONFIG.slippagePct).toFixed(2)} per 14d trade\n`);

  const coins = ['HYPE', 'BTC', 'ETH'];
  const results: Record<string, Record<string, { pnl: number; trades: number; avgHold: number; winRate: number; grossPnl: number; fees: number }>> = {};

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`No data for ${coin}, skipping...\n`);
      continue;
    }

    console.log(`\n${'─'.repeat(90)}`);
    console.log(`  ${coin} SPREAD HARVEST`);
    console.log('─'.repeat(90));
    console.log(`  ${'Strategy'.padEnd(25)} | ${'Trades'.padStart(6)} | ${'Win%'.padStart(5)} | ${'Avg Hold'.padStart(10)} | ${'Total PnL'.padStart(12)} | Peak Info`);
    console.log('─'.repeat(90));

    results[coin] = {};

    for (const strategy of EXIT_STRATEGIES) {
      const { trades, totalPnl, avgHoldHours, totalGrossPnl, totalFees } = runBacktest(data, strategy);
      const wins = trades.filter(t => t.netPnl > 0).length;
      const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

      results[coin][strategy.name] = {
        pnl: totalPnl,
        trades: trades.length,
        avgHold: avgHoldHours,
        winRate,
        grossPnl: totalGrossPnl,
        fees: totalFees,
      };

      if (trades.length === 0) {
        console.log(`  ${strategy.name.padEnd(25)} | ${'0'.padStart(6)} | ${'-'.padStart(5)} | ${'-'.padStart(10)} | ${'-'.padStart(12)} |`);
        continue;
      }

      const avgPeakHour = trades.reduce((s, t) => s + t.peakHour, 0) / trades.length;
      const avgPeakPnl = trades.reduce((s, t) => s + t.peakPnl, 0) / trades.length;
      const pnlColor = totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';

      console.log(
        `  ${strategy.name.padEnd(25)} | ` +
        `${trades.length.toString().padStart(6)} | ` +
        `${winRate.toFixed(0).padStart(4)}% | ` +
        `${(avgHoldHours / 24).toFixed(1).padStart(7)}d   | ` +
        `${pnlColor}$${totalPnl.toFixed(2).padStart(10)}${reset} | ` +
        `Peak $${avgPeakPnl.toFixed(2)} @ ${avgPeakHour.toFixed(0)}h`
      );
    }
  }

  // Summary comparison
  console.log('\n' + '═'.repeat(90));
  console.log('  SUMMARY: TOTAL PNL BY STRATEGY (ALL COINS)');
  console.log('═'.repeat(90));

  const strategyTotals: { name: string; total: number; avgHold: number; trades: number; grossPnl: number; fees: number }[] = [];

  for (const strategy of EXIT_STRATEGIES) {
    let total = 0;
    let totalHold = 0;
    let trades = 0;
    let grossPnl = 0;
    let fees = 0;
    let count = 0;
    for (const coin of coins) {
      if (results[coin]?.[strategy.name]) {
        total += results[coin][strategy.name].pnl;
        totalHold += results[coin][strategy.name].avgHold;
        trades += results[coin][strategy.name].trades;
        grossPnl += results[coin][strategy.name].grossPnl;
        fees += results[coin][strategy.name].fees;
        count++;
      }
    }
    strategyTotals.push({
      name: strategy.name,
      total,
      avgHold: count > 0 ? totalHold / count : 0,
      trades,
      grossPnl,
      fees,
    });
  }

  // Sort by total PnL
  strategyTotals.sort((a, b) => b.total - a.total);

  const baseline = strategyTotals.find(s => s.name === 'Hold 14d')?.total || 0;

  console.log(`\n  ${'Strategy'.padEnd(20)} | ${'Trades'.padStart(6)} | ${'Gross PnL'.padStart(10)} | ${'Fees+Slip'.padStart(10)} | ${'Net PnL'.padStart(10)} | ${'Avg Hold'.padStart(8)}`);
  console.log('─'.repeat(90));

  for (const s of strategyTotals) {
    const pnlColor = s.total >= 0 ? '\x1b[32m' : '\x1b[31m';
    const grossColor = s.grossPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const best = s === strategyTotals[0] ? ' ★' : '';

    console.log(
      `  ${s.name.padEnd(20)} | ` +
      `${s.trades.toString().padStart(6)} | ` +
      `${grossColor}$${s.grossPnl.toFixed(0).padStart(8)}${reset} | ` +
      `\x1b[31m$${s.fees.toFixed(0).padStart(8)}${reset} | ` +
      `${pnlColor}$${s.total.toFixed(0).padStart(8)}${reset} | ` +
      `${(s.avgHold / 24).toFixed(1).padStart(5)}d${best}`
    );
  }

  console.log('\n' + '═'.repeat(90));
  console.log('  KEY INSIGHTS');
  console.log('═'.repeat(90));

  const best = strategyTotals[0];
  const hold14d = strategyTotals.find(s => s.name === 'Hold 14d');

  if (best && hold14d) {
    const improvement = ((best.total - hold14d.total) / Math.abs(hold14d.total)) * 100;
    const holdReduction = ((hold14d.avgHold - best.avgHold) / hold14d.avgHold) * 100;

    console.log(`
  Best strategy: ${best.name}
    Total PnL: $${best.total.toFixed(0)} vs $${hold14d.total.toFixed(0)} (Hold 14d)
    Improvement: ${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%
    Avg hold: ${(best.avgHold / 24).toFixed(1)}d vs ${(hold14d.avgHold / 24).toFixed(1)}d
    Hold reduction: ${holdReduction.toFixed(0)}% faster capital turnover
`);
  }

  // Exit reason breakdown
  console.log('─'.repeat(90));
  console.log('  EXIT REASON ANALYSIS (for winning strategies)\n');

  for (const strategy of EXIT_STRATEGIES.slice(0, 8)) {
    let exitReasons: Record<string, number> = {};
    for (const coin of coins) {
      const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        const { trades } = runBacktest(data, strategy);
        for (const t of trades) {
          exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
        }
      } catch {}
    }

    if (Object.keys(exitReasons).length > 0) {
      const total = Object.values(exitReasons).reduce((a, b) => a + b, 0);
      const breakdown = Object.entries(exitReasons)
        .map(([reason, count]) => `${reason}: ${((count / total) * 100).toFixed(0)}%`)
        .join(', ');
      console.log(`  ${strategy.name.padEnd(20)}: ${breakdown}`);
    }
  }
}

main().catch(console.error);
