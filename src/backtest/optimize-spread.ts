/**
 * Meridian - Spread Harvest Parameter Optimization
 *
 * Tests different configurations to find optimal spread harvesting setup.
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

interface Config {
  minSpread: number;        // Minimum spread to enter (e.g., 0.05 = 5%)
  holdDays: number;         // Hold period in days
  impliedPremium: number;   // Assumed premium of implied over underlying
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
  avgHoldDays: number;
  sharpe: number;
  annualized: number;
  maxDrawdown: number;
}

function calculateImplied(history: FundingRecord[], index: number, window: number, premium: number): number {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length === 0) return 0;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  return mean + premium;
}

function runBacktest(data: FundingData, config: Config): Result {
  const history = data.history.filter(h => h.apr >= -1.5 && h.apr <= 1.5);
  const holdHours = config.holdDays * 24;
  const impliedWindow = 168; // 7 days

  let position: { type: 'LONG' | 'SHORT'; entryImplied: number; entryIndex: number } | null = null;
  const trades: { pnl: number; holdDays: number }[] = [];

  let equity = 10000;
  let maxEquity = equity;
  let maxDrawdown = 0;

  for (let i = impliedWindow; i < history.length - holdHours; i++) {
    const underlying = history[i].apr;
    const implied = calculateImplied(history, i, impliedWindow, config.impliedPremium);
    const spread = implied - underlying;

    // Check for exit
    if (position && (i - position.entryIndex) >= holdHours) {
      // Calculate average underlying over hold period
      let sumUnderlying = 0;
      for (let j = position.entryIndex; j <= i; j++) {
        sumUnderlying += history[j].apr;
      }
      const avgUnderlying = sumUnderlying / (i - position.entryIndex + 1);

      // PnL calculation
      let grossPnl: number;
      if (position.type === 'SHORT') {
        // Receive implied (fixed), pay underlying (floating)
        grossPnl = (position.entryImplied - avgUnderlying) * config.positionSize * (config.holdDays / 365);
      } else {
        // Pay implied (fixed), receive underlying (floating)
        grossPnl = (avgUnderlying - position.entryImplied) * config.positionSize * (config.holdDays / 365);
      }

      const fees = config.positionSize * config.takerFee * 2;
      const netPnl = grossPnl - fees;
      trades.push({ pnl: netPnl, holdDays: config.holdDays });

      equity += netPnl;
      maxEquity = Math.max(maxEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, (maxEquity - equity) / maxEquity);

      position = null;
    }

    // Check for entry
    if (!position) {
      if (spread >= config.minSpread) {
        // SHORT: implied >> underlying, receive high fixed
        position = { type: 'SHORT', entryImplied: implied, entryIndex: i };
      } else if (spread <= -config.minSpread) {
        // LONG: implied << underlying, pay low fixed
        position = { type: 'LONG', entryImplied: implied, entryIndex: i };
      }
    }
  }

  // Stats
  const wins = trades.filter(t => t.pnl > 0);
  const grossPnl = trades.reduce((s, t) => s + t.pnl + config.positionSize * config.takerFee * 2, 0);
  const fees = trades.length * config.positionSize * config.takerFee * 2;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);

  // Sharpe
  const returns = trades.map(t => (t.pnl / config.positionSize) * 100);
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length - 1))
    : 1;
  const tradesPerYear = trades.length > 0 ? (trades.length / (history.length / 24)) * 365 : 0;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(tradesPerYear) : 0;

  // Annualized
  const totalDays = history.length / 24;
  const annualized = totalDays > 0 ? (netPnl / 10000) * (365 / totalDays) * 100 : 0;

  return {
    config,
    coin: data.coin,
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    grossPnl,
    fees,
    netPnl,
    avgHoldDays: config.holdDays,
    sharpe,
    annualized,
    maxDrawdown,
  };
}

async function main() {
  console.log('Meridian - Spread Harvest Parameter Optimization\n');
  console.log('Testing configurations to find optimal spread harvesting setup...\n');
  console.log('═'.repeat(80));

  const coins = ['HYPE', 'BTC', 'ETH'];
  const allResults: Result[] = [];

  // Parameter grid
  const minSpreads = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]; // 2% to 10%
  const holdDays = [7, 14, 21, 28]; // 1 to 4 weeks
  const impliedPremiums = [0.01, 0.02, 0.03, 0.04, 0.05]; // 1% to 5%
  const fees = [0.0005, 0.0002]; // 0.05%, 0.02%

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    console.log(`\nTesting ${coin}...`);

    for (const minSpread of minSpreads) {
      for (const hold of holdDays) {
        for (const premium of impliedPremiums) {
          for (const fee of fees) {
            const config: Config = {
              minSpread,
              holdDays: hold,
              impliedPremium: premium,
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

  // Filter profitable
  const profitable = allResults.filter(r => r.netPnl > 0 && r.trades >= 3);

  console.log('\n' + '═'.repeat(80));
  console.log('RESULTS');
  console.log('═'.repeat(80));

  if (profitable.length === 0) {
    console.log('\n❌ NO PROFITABLE CONFIGURATIONS FOUND\n');

    const bestLosers = [...allResults]
      .filter(r => r.trades >= 3)
      .sort((a, b) => b.netPnl - a.netPnl)
      .slice(0, 10);

    if (bestLosers.length > 0) {
      console.log('Least bad configurations:');
      console.log('─'.repeat(80));
      for (const r of bestLosers) {
        console.log(`${r.coin} | ${(r.config.minSpread * 100).toFixed(0)}% spread | ${r.config.holdDays}d | ${(r.config.impliedPremium * 100).toFixed(0)}% premium | fee=${(r.config.takerFee * 100).toFixed(2)}%`);
        console.log(`  Trades: ${r.trades} | WR: ${(r.winRate * 100).toFixed(0)}% | Net: $${r.netPnl.toFixed(2)} | Ann: ${r.annualized.toFixed(1)}%`);
      }
    }
  } else {
    profitable.sort((a, b) => b.annualized - a.annualized);

    console.log(`\n✅ FOUND ${profitable.length} PROFITABLE CONFIGURATIONS\n`);

    // Group by coin
    for (const coin of coins) {
      const coinResults = profitable.filter(r => r.coin === coin).slice(0, 5);
      if (coinResults.length === 0) continue;

      console.log(`\n${coin}:`);
      console.log('─'.repeat(80));

      for (const r of coinResults) {
        console.log(`  ${(r.config.minSpread * 100).toFixed(0)}% spread | ${r.config.holdDays}d | ${(r.config.impliedPremium * 100).toFixed(0)}% premium | fee=${(r.config.takerFee * 100).toFixed(2)}%`);
        console.log(`    Trades: ${r.trades} | WR: ${(r.winRate * 100).toFixed(0)}% | Net: $${r.netPnl.toFixed(2)} | Ann: ${r.annualized.toFixed(1)}% | Sharpe: ${r.sharpe.toFixed(2)} | MaxDD: ${(r.maxDrawdown * 100).toFixed(1)}%`);
      }
    }

    // Overall best
    console.log('\n' + '═'.repeat(80));
    console.log('TOP 10 OVERALL (by Annualized Return)');
    console.log('═'.repeat(80));

    for (const r of profitable.slice(0, 10)) {
      console.log(`${r.coin.padEnd(5)} | ${(r.config.minSpread * 100).toFixed(0)}% spread | ${r.config.holdDays}d | ${(r.config.impliedPremium * 100).toFixed(0)}% prem | ${(r.config.takerFee * 100).toFixed(2)}% fee`);
      console.log(`       Trades: ${r.trades} | WR: ${(r.winRate * 100).toFixed(0)}% | Net: $${r.netPnl.toFixed(2)} | Ann: ${r.annualized.toFixed(1)}% | Sharpe: ${r.sharpe.toFixed(2)}`);
    }
  }

  // Compare to mean reversion
  console.log('\n' + '═'.repeat(80));
  console.log('COMPARISON: SPREAD HARVEST vs MEAN REVERSION');
  console.log('═'.repeat(80));

  const bestSpread = profitable[0];
  if (bestSpread) {
    console.log(`\nBest Spread Harvest:`);
    console.log(`  ${bestSpread.coin} | ${(bestSpread.config.minSpread * 100).toFixed(0)}% spread, ${bestSpread.config.holdDays}d hold`);
    console.log(`  ${bestSpread.annualized.toFixed(1)}% annualized | Sharpe ${bestSpread.sharpe.toFixed(2)}`);
  }

  console.log(`\nBest Mean Reversion (from previous test):`);
  console.log(`  HYPE | 2.5σ, 168h hold`);
  console.log(`  37% annualized | Sharpe 7.21`);

  console.log('\n' + '─'.repeat(80));
  if (bestSpread && bestSpread.annualized > 37) {
    console.log('VERDICT: Spread harvest outperforms mean reversion');
  } else {
    console.log('VERDICT: Mean reversion outperforms spread harvest');
    console.log('         (But spread harvest may be more robust to regime changes)');
  }
  console.log('─'.repeat(80));
}

main().catch(console.error);
