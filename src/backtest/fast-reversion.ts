/**
 * Fast Reversion Strategy - Exit when z-score normalizes, not after fixed time
 *
 * Key insight: Reversion happens in 3-6 hours on average, not 7 days.
 * So instead of holding 168h, exit when |z| < 1.0 (funding normalized)
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
  history: FundingRecord[];
}

interface Trade {
  type: 'LONG' | 'SHORT';
  entryZ: number;
  exitZ: number;
  entryApr: number;
  exitApr: number;
  holdHours: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
}

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1 };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev };
}

interface StrategyConfig {
  name: string;
  entryThreshold: number;
  exitMethod: 'z_revert' | 'fixed_time' | 'z_revert_or_time';
  exitZThreshold?: number;  // Exit when |z| drops below this
  maxHoldHours?: number;    // Max hold time
  minHoldHours?: number;    // Min hold before z-based exit
}

const STRATEGIES: StrategyConfig[] = [
  // Baseline - fixed time
  { name: 'Fixed 168h (baseline)', entryThreshold: 2.0, exitMethod: 'fixed_time', maxHoldHours: 168 },
  { name: 'Fixed 24h', entryThreshold: 2.0, exitMethod: 'fixed_time', maxHoldHours: 24 },
  { name: 'Fixed 12h', entryThreshold: 2.0, exitMethod: 'fixed_time', maxHoldHours: 12 },
  { name: 'Fixed 6h', entryThreshold: 2.0, exitMethod: 'fixed_time', maxHoldHours: 6 },

  // Z-score reversion exit
  { name: 'Exit at z<1.0', entryThreshold: 2.0, exitMethod: 'z_revert', exitZThreshold: 1.0, maxHoldHours: 168 },
  { name: 'Exit at z<0.5', entryThreshold: 2.0, exitMethod: 'z_revert', exitZThreshold: 0.5, maxHoldHours: 168 },
  { name: 'Exit at z<1.5', entryThreshold: 2.0, exitMethod: 'z_revert', exitZThreshold: 1.5, maxHoldHours: 168 },

  // Hybrid - wait min time then exit on z revert
  { name: 'Min 3h then z<1.0', entryThreshold: 2.0, exitMethod: 'z_revert_or_time', exitZThreshold: 1.0, minHoldHours: 3, maxHoldHours: 168 },
  { name: 'Min 6h then z<1.0', entryThreshold: 2.0, exitMethod: 'z_revert_or_time', exitZThreshold: 1.0, minHoldHours: 6, maxHoldHours: 168 },
  { name: 'Min 12h then z<1.0', entryThreshold: 2.0, exitMethod: 'z_revert_or_time', exitZThreshold: 1.0, minHoldHours: 12, maxHoldHours: 168 },

  // Different entry thresholds with fast exit
  { name: 'Entry z>2.5, exit z<1.0', entryThreshold: 2.5, exitMethod: 'z_revert', exitZThreshold: 1.0, maxHoldHours: 168 },
  { name: 'Entry z>3.0, exit z<1.0', entryThreshold: 3.0, exitMethod: 'z_revert', exitZThreshold: 1.0, maxHoldHours: 168 },
];

function runBacktest(data: FundingData, config: StrategyConfig) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  const trades: Trade[] = [];

  let position: {
    type: 'LONG' | 'SHORT';
    entryApr: number;
    entryZ: number;
    entryIndex: number;
    notional: number;
  } | null = null;

  const positionSize = 10000;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const apr = history[i].apr;
    const z = stdDev > 0 ? (apr - mean) / stdDev : 0;

    // Check for exit
    if (position) {
      const holdHours = i - position.entryIndex;
      let shouldExit = false;
      let exitReason = '';

      switch (config.exitMethod) {
        case 'fixed_time':
          if (holdHours >= (config.maxHoldHours || 168)) {
            shouldExit = true;
            exitReason = 'time';
          }
          break;

        case 'z_revert':
          if (Math.abs(z) < (config.exitZThreshold || 1.0)) {
            shouldExit = true;
            exitReason = 'z_revert';
          } else if (holdHours >= (config.maxHoldHours || 168)) {
            shouldExit = true;
            exitReason = 'max_time';
          }
          break;

        case 'z_revert_or_time':
          if (holdHours >= (config.minHoldHours || 0) && Math.abs(z) < (config.exitZThreshold || 1.0)) {
            shouldExit = true;
            exitReason = 'z_revert_after_min';
          } else if (holdHours >= (config.maxHoldHours || 168)) {
            shouldExit = true;
            exitReason = 'max_time';
          }
          break;
      }

      if (shouldExit) {
        // Calculate P&L
        let grossPnl = 0;
        for (let j = position.entryIndex + 1; j <= i; j++) {
          const hourlyEntry = position.entryApr / 8760;
          const hourlyActual = history[j].apr / 8760;
          if (position.type === 'SHORT') {
            grossPnl += (hourlyEntry - hourlyActual) * position.notional;
          } else {
            grossPnl += (hourlyActual - hourlyEntry) * position.notional;
          }
        }

        const daysHeld = holdHours / 24;
        const fees = positionSize * 0.0005 * (Math.max(holdHours, 24) / 24 / 365) +
                     positionSize * 0.002 * (daysHeld / 365);

        trades.push({
          type: position.type,
          entryZ: position.entryZ,
          exitZ: z,
          entryApr: position.entryApr,
          exitApr: apr,
          holdHours,
          grossPnl,
          fees,
          netPnl: grossPnl - fees,
        });

        position = null;
      }
    }

    // Check for entry
    if (!position) {
      if (z >= config.entryThreshold) {
        position = {
          type: 'SHORT',
          entryApr: apr,
          entryZ: z,
          entryIndex: i,
          notional: positionSize,
        };
      } else if (z <= -config.entryThreshold) {
        position = {
          type: 'LONG',
          entryApr: apr,
          entryZ: z,
          entryIndex: i,
          notional: positionSize,
        };
      }
    }
  }

  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalGross = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length : 0;
  const winRate = trades.length > 0 ? wins / trades.length : 0;

  // Capital efficiency: PnL per hour of capital locked
  const totalHours = trades.reduce((s, t) => s + t.holdHours, 0);
  const pnlPerHour = totalHours > 0 ? totalPnl / totalHours : 0;
  const annualizedPnlPerHour = pnlPerHour * 8760;

  return {
    trades,
    totalGross,
    totalFees,
    totalPnl,
    winRate,
    avgHold,
    pnlPerHour,
    annualizedPnlPerHour,
  };
}

async function main() {
  console.log('═'.repeat(100));
  console.log('  FAST REVERSION STRATEGY TEST');
  console.log('═'.repeat(100));
  console.log(`
  Key insight: Funding reverts in 3-6 hours, not 7 days.
  Testing: What if we exit when z-score normalizes instead of holding fixed time?

  Metrics:
    - Total PnL: Absolute profit
    - PnL/Hour: Capital efficiency (can recycle capital faster)
    - Annualized PnL/Hour: What this would be over a year
`);

  const coins = ['HYPE', 'BTC', 'ETH'];

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    console.log('─'.repeat(100));
    console.log(`  ${coin}`);
    console.log('─'.repeat(100));
    console.log(`  ${'Strategy'.padEnd(30)} | ${'Trades'.padStart(6)} | ${'Win%'.padStart(5)} | ${'AvgHold'.padStart(8)} | ${'GrossPnL'.padStart(10)} | ${'NetPnL'.padStart(10)} | ${'$/Hour'.padStart(8)} | ${'Ann$/Hr'.padStart(10)}`);
    console.log('─'.repeat(100));

    for (const strategy of STRATEGIES) {
      const result = runBacktest(data, strategy);

      const pnlColor = result.totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';

      console.log(
        `  ${strategy.name.padEnd(30)} | ` +
        `${result.trades.length.toString().padStart(6)} | ` +
        `${(result.winRate * 100).toFixed(0).padStart(4)}% | ` +
        `${result.avgHold.toFixed(1).padStart(5)}h   | ` +
        `${pnlColor}$${result.totalGross.toFixed(0).padStart(8)}${reset} | ` +
        `${pnlColor}$${result.totalPnl.toFixed(0).padStart(8)}${reset} | ` +
        `$${result.pnlPerHour.toFixed(3).padStart(6)} | ` +
        `${pnlColor}$${result.annualizedPnlPerHour.toFixed(0).padStart(8)}${reset}`
      );
    }
    console.log();
  }

  // Summary across all coins
  console.log('\n' + '═'.repeat(100));
  console.log('  SUMMARY: ALL COINS COMBINED');
  console.log('═'.repeat(100));
  console.log(`  ${'Strategy'.padEnd(30)} | ${'Trades'.padStart(6)} | ${'TotalPnL'.padStart(10)} | ${'AvgHold'.padStart(8)} | ${'Ann$/Hr'.padStart(12)}`);
  console.log('─'.repeat(100));

  for (const strategy of STRATEGIES) {
    let totalPnl = 0;
    let totalTrades = 0;
    let totalHours = 0;

    for (const coin of coins) {
      const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        const result = runBacktest(data, strategy);
        totalPnl += result.totalPnl;
        totalTrades += result.trades.length;
        totalHours += result.trades.reduce((s, t) => s + t.holdHours, 0);
      } catch {}
    }

    const avgHold = totalTrades > 0 ? totalHours / totalTrades : 0;
    const pnlPerHour = totalHours > 0 ? totalPnl / totalHours : 0;
    const annualized = pnlPerHour * 8760;

    const pnlColor = totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    console.log(
      `  ${strategy.name.padEnd(30)} | ` +
      `${totalTrades.toString().padStart(6)} | ` +
      `${pnlColor}$${totalPnl.toFixed(0).padStart(8)}${reset} | ` +
      `${avgHold.toFixed(1).padStart(5)}h   | ` +
      `${pnlColor}$${annualized.toFixed(0).padStart(10)}${reset}`
    );
  }

  console.log('\n' + '═'.repeat(100));
  console.log('  INTERPRETATION');
  console.log('═'.repeat(100));
  console.log(`
  If fast reversion beats 168h hold:
    → Edge is in the REVERSION, not the HOLD
    → Can recycle capital faster = higher annualized returns

  If 168h hold still wins:
    → Edge is in accumulating spread over time
    → Fast exit gives up too much profit
`);
}

main().catch(console.error);
