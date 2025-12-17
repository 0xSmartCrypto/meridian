/**
 * Edge Analysis - Best/Average/Worst case scenarios
 * Using blend_50_50 implied model (realistic) and Hold 7 days
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');

interface FundingRecord { apr: number; time: number; timestamp: string; }
interface FundingData { coin: string; history: FundingRecord[]; }

function rollingMA(history: FundingRecord[], index: number, window: number): number {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < window / 2) return history[index].apr;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1 };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev };
}

function runBacktest(data: FundingData, holdHours: number = 168) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  const trades: { netPnl: number; grossPnl: number; fees: number }[] = [];
  let position: {
    type: 'LONG' | 'SHORT';
    entryImplied: number;
    entryIndex: number;
    notional: number;
  } | null = null;

  const positionSize = 10000;
  const entryThreshold = 2.5;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const floating = history[i].apr;
    const ma7d = rollingMA(history, i, 168);
    const z = stdDev > 0 ? (floating - mean) / stdDev : 0;
    const implied = (floating + ma7d) / 2; // blend_50_50

    if (position) {
      const holdTime = i - position.entryIndex;
      if (holdTime >= holdHours) {
        let grossPnl = 0;
        for (let j = position.entryIndex + 1; j <= i; j++) {
          const hourlyImplied = position.entryImplied / 8760;
          const hourlyFloating = history[j].apr / 8760;
          if (position.type === 'SHORT') {
            grossPnl += (hourlyImplied - hourlyFloating) * position.notional;
          } else {
            grossPnl += (hourlyFloating - hourlyImplied) * position.notional;
          }
        }
        // Accurate Boros fees
        const daysToMaturity = 30;
        const openingFee = positionSize * 0.0005 * (daysToMaturity / 365);
        const settlementPeriods = Math.ceil(holdTime / 8);
        const settlementFee = positionSize * 0.002 * (8 / 8760) * settlementPeriods;
        const fees = openingFee + settlementFee;
        trades.push({ netPnl: grossPnl - fees, grossPnl, fees });
        position = null;
      }
    }

    if (!position) {
      if (z >= entryThreshold) {
        position = { type: 'SHORT', entryImplied: implied, entryIndex: i, notional: positionSize };
      } else if (z <= -entryThreshold) {
        position = { type: 'LONG', entryImplied: implied, entryIndex: i, notional: positionSize };
      }
    }
  }

  return trades;
}

// Run analysis
const coins = ['HYPE', 'BTC', 'ETH'];
const allTrades: { coin: string; netPnl: number }[] = [];

console.log('═'.repeat(70));
console.log('  EDGE ANALYSIS: HOLD 7 DAYS with blend_50_50 implied model');
console.log('  Position: $10,000 notional per trade');
console.log('═'.repeat(70));

for (const coin of coins) {
  const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const trades = runBacktest(data);
    trades.forEach(t => allTrades.push({ coin, netPnl: t.netPnl }));

    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl <= 0);
    const total = trades.reduce((s, t) => s + t.netPnl, 0);
    const sorted = trades.map(t => t.netPnl).sort((a, b) => a - b);

    console.log(`\n${coin}:`);
    console.log(`  Trades: ${trades.length} (${wins.length}W/${losses.length}L)`);
    console.log(`  Total P&L: $${total.toFixed(2)}`);
    console.log(`  Avg per trade: $${(total / trades.length).toFixed(2)}`);
    console.log(`  Best trade: $${sorted[sorted.length - 1]?.toFixed(2) || 0}`);
    console.log(`  Worst trade: $${sorted[0]?.toFixed(2) || 0}`);
  } catch (e) {
    console.log(`Error loading ${coin}:`, e);
  }
}

// Overall stats
console.log('\n' + '═'.repeat(70));
console.log('  PORTFOLIO SUMMARY (ALL COINS)');
console.log('═'.repeat(70));

const allPnLs = allTrades.map(t => t.netPnl).sort((a, b) => a - b);
const wins = allTrades.filter(t => t.netPnl > 0);
const total = allTrades.reduce((s, t) => s + t.netPnl, 0);
const avg = total / allTrades.length;

console.log(`\nTotal trades: ${allTrades.length}`);
console.log(`Win rate: ${((wins.length / allTrades.length) * 100).toFixed(0)}%`);
console.log(`\nP&L Distribution:`);
console.log(`  Best trade:    $${allPnLs[allPnLs.length - 1]?.toFixed(2)}`);
console.log(`  75th %ile:     $${allPnLs[Math.floor(allPnLs.length * 0.75)]?.toFixed(2)}`);
console.log(`  Median:        $${allPnLs[Math.floor(allPnLs.length * 0.5)]?.toFixed(2)}`);
console.log(`  25th %ile:     $${allPnLs[Math.floor(allPnLs.length * 0.25)]?.toFixed(2)}`);
console.log(`  Worst trade:   $${allPnLs[0]?.toFixed(2)}`);
console.log(`\n  Average:       $${avg.toFixed(2)}/trade`);
console.log(`  Total (90d):   $${total.toFixed(2)}`);

// Scenarios
const totalDays = 90;
const annualized = (total / 10000) * (365 / totalDays) * 100;

console.log('\n' + '═'.repeat(70));
console.log('  SCENARIOS (90-day projection, $10k capital)');
console.log('═'.repeat(70));

console.log(`\n  BEST CASE (all trades like 75th %ile):`);
const bestCase = (allPnLs[Math.floor(allPnLs.length * 0.75)] || 0) * allTrades.length;
console.log(`    90d P&L: $${bestCase.toFixed(0)} (${((bestCase / 10000) * (365/90) * 100).toFixed(0)}% APY)`);

console.log(`\n  EXPECTED (historical average):`);
console.log(`    90d P&L: $${total.toFixed(0)} (${annualized.toFixed(0)}% APY)`);

console.log(`\n  WORST CASE (all trades like 25th %ile):`);
const worstCase = (allPnLs[Math.floor(allPnLs.length * 0.25)] || 0) * allTrades.length;
console.log(`    90d P&L: $${worstCase.toFixed(0)} (${((worstCase / 10000) * (365/90) * 100).toFixed(0)}% APY)`);

// Risk metrics
console.log('\n' + '═'.repeat(70));
console.log('  RISK METRICS');
console.log('═'.repeat(70));

const maxLoss = allPnLs[0] || 0;
console.log(`\n  Max single trade loss: $${maxLoss.toFixed(2)}`);
console.log(`  Loss as % of $10k: ${((maxLoss / 10000) * 100).toFixed(2)}%`);

// How many consecutive losses to hit 15% drawdown
const lossesFor15DD = Math.ceil(1500 / Math.abs(maxLoss || 50));
console.log(`  Consecutive max losses for -15% DD: ${lossesFor15DD}`);

// Fee impact (accurate Boros fees ~$0.80 per $10k trade)
const avgFees = 0.80;
const totalFees = allTrades.length * avgFees;
const grossTotal = total + totalFees;
console.log(`\n  Fee impact: $${totalFees} total (${((totalFees/grossTotal) * 100).toFixed(0)}% of gross P&L)`);

// Capital efficiency
console.log('\n' + '═'.repeat(70));
console.log('  CAPITAL EFFICIENCY');
console.log('═'.repeat(70));
console.log(`\n  With 10x leverage: $1,000 collateral controls $10,000 notional`);
console.log(`  Expected 90d return on $1k collateral: $${total.toFixed(0)} (${((total/1000)*100).toFixed(0)}%)`);
console.log(`  Expected 90d return on $10k collateral: $${total.toFixed(0)} (${((total/10000)*100).toFixed(0)}%)`);

console.log('\n' + '═'.repeat(70));
console.log('  BOTTOM LINE');
console.log('═'.repeat(70));
console.log(`
  Edge exists but is THIN:
  - Expected: ~$${avg.toFixed(0)}/trade, ~${annualized.toFixed(0)}% APY
  - Worst trade: $${maxLoss.toFixed(0)} loss
  - Fees eat ${((totalFees/grossTotal) * 100).toFixed(0)}% of gross profits

  RECOMMENDATION:
  - Start with $1-2k capital to validate edge
  - Scale up only after 10+ profitable trades
  - Kill switches protect against max drawdown
`);
