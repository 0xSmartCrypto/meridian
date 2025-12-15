/**
 * Sensitivity Analysis - Test mean reversion under different implied rate assumptions
 *
 * The key question: Does the edge survive if we DON'T lock in the extreme floating rate?
 *
 * Implied rate models to test:
 * 1. implied = floating at entry (optimistic - current assumption)
 * 2. implied = 7-day MA (conservative - market prices reversion)
 * 3. implied = blend of floating and 7dMA (realistic based on snapshot)
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
  entryFloating: number;
  entryImplied: number;
  entry7dMA: number;
  exitFloating: number;
  grossPnl: number;
  netPnl: number;
  holdHours: number;
}

type ImpliedModel = 'floating' | '7dma' | 'blend_50_50' | 'blend_70_30';

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

function getImpliedRate(
  model: ImpliedModel,
  floating: number,
  ma7d: number
): number {
  switch (model) {
    case 'floating':
      return floating;
    case '7dma':
      return ma7d;
    case 'blend_50_50':
      return (floating + ma7d) / 2;
    case 'blend_70_30':
      return 0.7 * ma7d + 0.3 * floating;
    default:
      return floating;
  }
}

function runBacktest(
  data: FundingData,
  impliedModel: ImpliedModel,
  entryThreshold: number = 2.5,
  holdHours: number = 168
) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  const trades: Trade[] = [];
  let position: {
    type: 'LONG' | 'SHORT';
    entryFloating: number;
    entryImplied: number;
    entry7dMA: number;
    entryIndex: number;
    notional: number;
  } | null = null;

  const positionSize = 10000;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const floating = history[i].apr;
    const ma7d = rollingMA(history, i, 168);
    const z = stdDev > 0 ? (floating - mean) / stdDev : 0;

    // Check for exit
    if (position) {
      const holdTime = i - position.entryIndex;

      if (holdTime >= holdHours) {
        // Calculate P&L: sum of (implied - hourly floating) for each hour
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

        // Fees (Boros structure)
        const daysHeld = holdTime / 24;
        const fees = positionSize * 0.0005 * (holdHours / 24 / 365) +
                     positionSize * 0.002 * (daysHeld / 365);

        trades.push({
          entryFloating: position.entryFloating,
          entryImplied: position.entryImplied,
          entry7dMA: position.entry7dMA,
          exitFloating: floating,
          grossPnl,
          netPnl: grossPnl - fees,
          holdHours: holdTime,
        });

        position = null;
      }
    }

    // Check for entry
    if (!position) {
      const implied = getImpliedRate(impliedModel, floating, ma7d);

      if (z >= entryThreshold) {
        // HIGH funding - SHORT (receive fixed implied, pay floating)
        position = {
          type: 'SHORT',
          entryFloating: floating,
          entryImplied: implied,
          entry7dMA: ma7d,
          entryIndex: i,
          notional: positionSize,
        };
      } else if (z <= -entryThreshold) {
        // LOW funding - LONG (pay fixed implied, receive floating)
        position = {
          type: 'LONG',
          entryFloating: floating,
          entryImplied: implied,
          entry7dMA: ma7d,
          entryIndex: i,
          notional: positionSize,
        };
      }
    }
  }

  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;

  return { trades, totalPnl, winRate };
}

async function main() {
  console.log('═'.repeat(90));
  console.log('  SENSITIVITY ANALYSIS: DOES EDGE SURVIVE DIFFERENT IMPLIED RATE ASSUMPTIONS?');
  console.log('═'.repeat(90));
  console.log(`
  The mean reversion backtest assumes you lock in the FLOATING rate at entry.
  But on Boros, you lock in the IMPLIED rate, which already prices in some reversion.

  From Boros snapshot:
    HYPE: implied 11.6%, floating 10.9%, 7dMA 12.8% → implied ≈ blend
    BTC:  implied 8.2%,  floating 10.9%, 7dMA 4.5%  → implied ≈ blend
    ETH:  implied 9.7%,  floating 14.0%, 7dMA 9.2%  → implied ≈ 7dMA

  Testing implied rate models:
    1. floating    - Lock in floating at entry (optimistic)
    2. 7dma        - Lock in 7-day MA (conservative)
    3. blend_50_50 - 50% floating + 50% 7dMA (moderate)
    4. blend_70_30 - 70% 7dMA + 30% floating (realistic based on snapshot)
`);

  const coins = ['HYPE', 'BTC', 'ETH'];
  const models: ImpliedModel[] = ['floating', '7dma', 'blend_50_50', 'blend_70_30'];

  console.log('─'.repeat(90));
  console.log(`  ${'Coin'.padEnd(6)} | ${'Implied Model'.padEnd(15)} | ${'Trades'.padStart(6)} | ${'Win%'.padStart(6)} | ${'Net PnL'.padStart(12)} | Edge?`);
  console.log('─'.repeat(90));

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }

    for (const model of models) {
      const result = runBacktest(data, model, 2.5, 168);

      const pnlColor = result.totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      const edge = result.totalPnl > 50 ? '✅ YES' : result.totalPnl > 0 ? '⚠️  WEAK' : '❌ NO';

      console.log(
        `  ${coin.padEnd(6)} | ` +
        `${model.padEnd(15)} | ` +
        `${result.trades.length.toString().padStart(6)} | ` +
        `${(result.winRate * 100).toFixed(0).padStart(5)}% | ` +
        `${pnlColor}$${result.totalPnl.toFixed(2).padStart(10)}${reset} | ` +
        `${edge}`
      );
    }
    console.log('─'.repeat(90));
  }

  // Summary
  console.log('\n' + '═'.repeat(90));
  console.log('  SUMMARY BY IMPLIED MODEL (ALL COINS)');
  console.log('═'.repeat(90));

  for (const model of models) {
    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;

    for (const coin of coins) {
      const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        const result = runBacktest(data, model, 2.5, 168);
        totalPnl += result.totalPnl;
        totalTrades += result.trades.length;
        totalWins += result.trades.filter(t => t.netPnl > 0).length;
      } catch {}
    }

    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const pnlColor = totalPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    console.log(
      `  ${model.padEnd(15)} | ` +
      `${totalTrades.toString().padStart(3)} trades | ` +
      `${winRate.toFixed(0).padStart(3)}% WR | ` +
      `${pnlColor}$${totalPnl.toFixed(0).padStart(6)} total${reset}`
    );
  }

  console.log('\n' + '═'.repeat(90));
  console.log('  INTERPRETATION');
  console.log('═'.repeat(90));
  console.log(`
  If edge survives with "7dma" model → ROBUST (edge exists even with conservative assumption)
  If edge only with "floating" model → FRAGILE (edge may be backtest artifact)

  The blend models represent realistic scenarios based on observed Boros pricing.
`);
}

main().catch(console.error);
