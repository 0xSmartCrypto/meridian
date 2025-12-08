/**
 * Meridian - Mean Reversion Backtest
 *
 * Key insight: Hold positions for FULL WEEK (168h), don't exit on z-score revert.
 * The edge comes from accumulating spread over time, not timing the reversion.
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
}

interface Config {
  name: string;
  entryThreshold: number;
  holdHours: number;
  takerFee: number;
  positionSize: number;
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

function runBacktest(data: FundingData, config: Config) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  let position: Position | null = null;
  const trades: Trade[] = [];

  // Track equity for drawdown
  let equity = 10000;
  let maxEquity = equity;
  let maxDrawdown = 0;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const z = zScore(history[i].apr, mean, stdDev);

    // Check for exit (time-based only)
    if (position) {
      const holdHours = i - position.entryIndex;

      if (holdHours >= config.holdHours) {
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

        const fees = config.positionSize * config.takerFee * 2;
        const netPnl = grossPnl - fees;

        trades.push({
          type: position.type,
          entryApr: position.entryApr,
          exitApr: history[i].apr,
          entryTime: position.entryTime,
          exitTime: history[i].timestamp,
          grossPnl,
          fees,
          netPnl,
          holdHours,
        });

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
        };
      } else if (z < -config.entryThreshold) {
        position = {
          type: 'LONG',
          entryApr: history[i].apr,
          entryIndex: i,
          entryTime: history[i].timestamp,
          notional: config.positionSize,
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

  // Sharpe
  const returns = trades.map(t => (t.netPnl / config.positionSize) * 100);
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length - 1))
    : 1;
  const tradesPerYear = (trades.length / (history.length / 24)) * 365;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(tradesPerYear) : 0;

  // Annualized return
  const totalDays = history.length / 24;
  const annualized = totalDays > 0 ? (netPnl / 10000) * (365 / totalDays) * 100 : 0;

  // Profit factor
  const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

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
      maxDrawdown,
      sharpe,
      annualized,
      profitFactor,
      finalEquity: equity,
    },
  };
}

async function main() {
  console.log('Meridian - Mean Reversion Backtest\n');
  console.log('═'.repeat(80));
  console.log('\nStrategy: Enter on extreme z-scores, HOLD for full period (time-based exit)');
  console.log('Key insight: Don\'t exit on z-score revert - hold to accumulate spread\n');
  console.log('Assumptions:');
  console.log('  • Taker fee: 0.05% per trade (0.1% round trip)');
  console.log('  • Position size: $10,000 notional');
  console.log('  • Starting capital: $10,000');
  console.log('  • Rolling 7-day stats for signal generation');
  console.log('═'.repeat(80));

  const coins = ['HYPE', 'BTC', 'ETH'];

  const configs: Config[] = [
    { name: '2.5σ / 1 week', entryThreshold: 2.5, holdHours: 168, takerFee: 0.0005, positionSize: 10000 },
    { name: '2.0σ / 1 week', entryThreshold: 2.0, holdHours: 168, takerFee: 0.0005, positionSize: 10000 },
    { name: '3.0σ / 1 week', entryThreshold: 3.0, holdHours: 168, takerFee: 0.0005, positionSize: 10000 },
    { name: '2.5σ / 2 weeks', entryThreshold: 2.5, holdHours: 336, takerFee: 0.0005, positionSize: 10000 },
  ];

  const allResults: ReturnType<typeof runBacktest>[] = [];

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`\nNo data for ${coin}, skipping...`);
      continue;
    }

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`${coin} BACKTEST (${data.stats.count} hours of data)`);
    console.log('─'.repeat(80));

    for (const config of configs) {
      const result = runBacktest(data, config);
      allResults.push(result);

      const profitable = result.stats.netPnl > 0;
      const icon = profitable ? '✅' : '❌';

      console.log(`\n${icon} ${config.name}`);
      console.log(`   Trades:        ${result.stats.totalTrades}`);

      if (result.stats.totalTrades === 0) {
        console.log('   (No trades - threshold too high for data)');
        continue;
      }

      console.log(`   Win Rate:      ${(result.stats.winRate * 100).toFixed(0)}% (${result.stats.wins}W / ${result.stats.losses}L)`);
      console.log(`   Gross PnL:     $${result.stats.grossPnl.toFixed(2)}`);
      console.log(`   Fees:          $${result.stats.totalFees.toFixed(2)}`);
      console.log(`   Net PnL:       $${result.stats.netPnl.toFixed(2)}`);
      console.log(`   Avg PnL/Trade: $${result.stats.avgPnl.toFixed(2)}`);
      console.log(`   Max Drawdown:  ${(result.stats.maxDrawdown * 100).toFixed(2)}%`);
      console.log(`   Profit Factor: ${result.stats.profitFactor.toFixed(2)}`);
      console.log(`   Sharpe:        ${result.stats.sharpe.toFixed(2)}`);
      console.log(`   Annualized:    ${result.stats.annualized.toFixed(1)}%`);

      // Show trades
      if (result.trades.length > 0 && result.trades.length <= 15) {
        console.log(`\n   Trades:`);
        for (const t of result.trades) {
          const sign = t.netPnl >= 0 ? '+' : '';
          console.log(`     ${t.type.padEnd(5)} ${(t.entryApr * 100).toFixed(1).padStart(6)}% → ${(t.exitApr * 100).toFixed(1).padStart(6)}% | ${t.holdHours}h | ${sign}$${t.netPnl.toFixed(2)}`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('SUMMARY');
  console.log('═'.repeat(80));

  const profitable = allResults.filter(r => r.stats.netPnl > 0 && r.stats.totalTrades >= 3);

  if (profitable.length > 0) {
    console.log('\n✅ PROFITABLE CONFIGURATIONS:\n');
    profitable.sort((a, b) => b.stats.annualized - a.stats.annualized);

    for (const r of profitable) {
      console.log(`${r.coin.padEnd(5)} | ${r.config.name.padEnd(15)} | ${(r.stats.winRate * 100).toFixed(0)}% WR | $${r.stats.netPnl.toFixed(0)} PnL | ${r.stats.annualized.toFixed(0)}% Ann. | Sharpe ${r.stats.sharpe.toFixed(2)}`);
    }
  }

  const unprofitable = allResults.filter(r => r.stats.netPnl <= 0 && r.stats.totalTrades >= 3);
  if (unprofitable.length > 0) {
    console.log('\n❌ UNPROFITABLE CONFIGURATIONS:\n');
    for (const r of unprofitable) {
      console.log(`${r.coin.padEnd(5)} | ${r.config.name.padEnd(15)} | ${(r.stats.winRate * 100).toFixed(0)}% WR | $${r.stats.netPnl.toFixed(0)} PnL`);
    }
  }

  console.log('\n' + '─'.repeat(80));
  console.log('KEY TAKEAWAY: Mean reversion works when you HOLD (1-2 weeks), not when you');
  console.log('exit on z-score reversion. The edge is in accumulating spread over time.');
  console.log('─'.repeat(80));
}

main().catch(console.error);
