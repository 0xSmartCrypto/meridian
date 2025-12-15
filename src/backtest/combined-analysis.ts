/**
 * Combined Analysis: Realistic Implied Rates + Optimal Hold Time
 *
 * Question: What's the ACTUAL best strategy when we account for:
 * 1. Realistic implied rates (not just floating at entry)
 * 2. Different hold times
 * 3. Z-score based exits
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

type ImpliedModel = 'floating' | 'blend_50_50' | 'blend_70_30';

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1, ma7d: history[index].apr };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev, ma7d: mean };
}

function getImpliedRate(model: ImpliedModel, floating: number, ma7d: number): number {
  switch (model) {
    case 'floating': return floating;
    case 'blend_50_50': return (floating + ma7d) / 2;
    case 'blend_70_30': return 0.7 * ma7d + 0.3 * floating;
    default: return floating;
  }
}

interface Config {
  name: string;
  impliedModel: ImpliedModel;
  entryThreshold: number;
  holdHours: number;
  exitOnZRevert?: boolean;
  exitZThreshold?: number;
}

const CONFIGS: Config[] = [
  // Optimistic implied (floating) with different holds
  { name: 'Floating, 168h', impliedModel: 'floating', entryThreshold: 2.0, holdHours: 168 },
  { name: 'Floating, 72h', impliedModel: 'floating', entryThreshold: 2.0, holdHours: 72 },
  { name: 'Floating, 24h', impliedModel: 'floating', entryThreshold: 2.0, holdHours: 24 },
  { name: 'Floating, exit z<1', impliedModel: 'floating', entryThreshold: 2.0, holdHours: 168, exitOnZRevert: true, exitZThreshold: 1.0 },

  // Realistic implied (50/50 blend)
  { name: 'Blend50, 168h', impliedModel: 'blend_50_50', entryThreshold: 2.0, holdHours: 168 },
  { name: 'Blend50, 72h', impliedModel: 'blend_50_50', entryThreshold: 2.0, holdHours: 72 },
  { name: 'Blend50, 24h', impliedModel: 'blend_50_50', entryThreshold: 2.0, holdHours: 24 },
  { name: 'Blend50, exit z<1', impliedModel: 'blend_50_50', entryThreshold: 2.0, holdHours: 168, exitOnZRevert: true, exitZThreshold: 1.0 },

  // Conservative implied (70/30 blend)
  { name: 'Blend70, 168h', impliedModel: 'blend_70_30', entryThreshold: 2.0, holdHours: 168 },
  { name: 'Blend70, 72h', impliedModel: 'blend_70_30', entryThreshold: 2.0, holdHours: 72 },
  { name: 'Blend70, 24h', impliedModel: 'blend_70_30', entryThreshold: 2.0, holdHours: 24 },
  { name: 'Blend70, exit z<1', impliedModel: 'blend_70_30', entryThreshold: 2.0, holdHours: 168, exitOnZRevert: true, exitZThreshold: 1.0 },
];

function runBacktest(data: FundingData, config: Config) {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  const trades: { netPnl: number; holdHours: number }[] = [];

  let position: {
    type: 'LONG' | 'SHORT';
    entryImplied: number;
    entryIndex: number;
    notional: number;
  } | null = null;

  const positionSize = 10000;

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev, ma7d } = rollingStats(history, i);
    const floating = history[i].apr;
    const z = stdDev > 0 ? (floating - mean) / stdDev : 0;

    if (position) {
      const holdHours = i - position.entryIndex;
      let shouldExit = false;

      if (holdHours >= config.holdHours) {
        shouldExit = true;
      } else if (config.exitOnZRevert && Math.abs(z) < (config.exitZThreshold || 1.0)) {
        shouldExit = true;
      }

      if (shouldExit) {
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

        const daysHeld = holdHours / 24;
        const fees = positionSize * 0.0005 * (Math.max(holdHours, 24) / 24 / 365) +
                     positionSize * 0.002 * (daysHeld / 365);

        trades.push({ netPnl: grossPnl - fees, holdHours });
        position = null;
      }
    }

    if (!position) {
      const implied = getImpliedRate(config.impliedModel, floating, ma7d);

      if (z >= config.entryThreshold) {
        position = {
          type: 'SHORT',
          entryImplied: implied,
          entryIndex: i,
          notional: positionSize,
        };
      } else if (z <= -config.entryThreshold) {
        position = {
          type: 'LONG',
          entryImplied: implied,
          entryIndex: i,
          notional: positionSize,
        };
      }
    }
  }

  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length : 0;
  const totalHours = trades.reduce((s, t) => s + t.holdHours, 0);
  const pnlPerHour = totalHours > 0 ? totalPnl / totalHours : 0;

  return { trades: trades.length, totalPnl, winRate, avgHold, pnlPerHour };
}

async function main() {
  console.log('═'.repeat(95));
  console.log('  COMBINED ANALYSIS: REALISTIC IMPLIED RATES + OPTIMAL HOLD TIME');
  console.log('═'.repeat(95));
  console.log(`
  Testing all combinations of:
  - Implied model: floating (optimistic) vs blend_50_50 (moderate) vs blend_70_30 (conservative)
  - Hold time: 168h, 72h, 24h, or exit when z<1.0
`);

  const coins = ['HYPE', 'BTC', 'ETH'];
  const results: Record<string, Record<string, { pnl: number; trades: number; winRate: number; avgHold: number; pnlPerHour: number }>> = {};

  for (const coin of coins) {
    results[coin] = {};
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch { continue; }

    for (const config of CONFIGS) {
      const result = runBacktest(data, config);
      results[coin][config.name] = {
        pnl: result.totalPnl,
        trades: result.trades,
        winRate: result.winRate,
        avgHold: result.avgHold,
        pnlPerHour: result.pnlPerHour,
      };
    }
  }

  // Summary table
  console.log('─'.repeat(95));
  console.log(`  ${'Strategy'.padEnd(22)} | ${'HYPE PnL'.padStart(10)} | ${'BTC PnL'.padStart(10)} | ${'ETH PnL'.padStart(10)} | ${'TOTAL'.padStart(10)} | ${'$/Hour'.padStart(8)}`);
  console.log('─'.repeat(95));

  for (const config of CONFIGS) {
    const hypePnl = results['HYPE']?.[config.name]?.pnl || 0;
    const btcPnl = results['BTC']?.[config.name]?.pnl || 0;
    const ethPnl = results['ETH']?.[config.name]?.pnl || 0;
    const total = hypePnl + btcPnl + ethPnl;

    const hypeHours = (results['HYPE']?.[config.name]?.avgHold || 0) * (results['HYPE']?.[config.name]?.trades || 0);
    const btcHours = (results['BTC']?.[config.name]?.avgHold || 0) * (results['BTC']?.[config.name]?.trades || 0);
    const ethHours = (results['ETH']?.[config.name]?.avgHold || 0) * (results['ETH']?.[config.name]?.trades || 0);
    const totalHours = hypeHours + btcHours + ethHours;
    const pnlPerHour = totalHours > 0 ? total / totalHours : 0;

    const pnlColor = total >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    // Highlight rows
    const isFloating = config.impliedModel === 'floating';
    const prefix = isFloating ? '' : '  ';

    console.log(
      `${prefix}${config.name.padEnd(22 - prefix.length)} | ` +
      `${pnlColor}$${hypePnl.toFixed(0).padStart(8)}${reset} | ` +
      `${pnlColor}$${btcPnl.toFixed(0).padStart(8)}${reset} | ` +
      `${pnlColor}$${ethPnl.toFixed(0).padStart(8)}${reset} | ` +
      `${pnlColor}$${total.toFixed(0).padStart(8)}${reset} | ` +
      `$${pnlPerHour.toFixed(3).padStart(6)}`
    );

    if (config.name.includes('exit z<1')) {
      console.log('─'.repeat(95));
    }
  }

  // Find best strategy
  let bestConfig = '';
  let bestPnl = -Infinity;
  for (const config of CONFIGS) {
    const total = (results['HYPE']?.[config.name]?.pnl || 0) +
                  (results['BTC']?.[config.name]?.pnl || 0) +
                  (results['ETH']?.[config.name]?.pnl || 0);
    if (total > bestPnl) {
      bestPnl = total;
      bestConfig = config.name;
    }
  }

  // Find best realistic strategy
  let bestRealisticConfig = '';
  let bestRealisticPnl = -Infinity;
  for (const config of CONFIGS) {
    if (config.impliedModel === 'floating') continue;
    const total = (results['HYPE']?.[config.name]?.pnl || 0) +
                  (results['BTC']?.[config.name]?.pnl || 0) +
                  (results['ETH']?.[config.name]?.pnl || 0);
    if (total > bestRealisticPnl) {
      bestRealisticPnl = total;
      bestRealisticConfig = config.name;
    }
  }

  console.log('\n' + '═'.repeat(95));
  console.log('  KEY FINDINGS');
  console.log('═'.repeat(95));
  console.log(`
  Best overall (optimistic): ${bestConfig} → $${bestPnl.toFixed(0)}
  Best realistic:            ${bestRealisticConfig} → $${bestRealisticPnl.toFixed(0)}

  Edge degradation:          ${((1 - bestRealisticPnl / bestPnl) * 100).toFixed(0)}% loss with realistic implied rates

  CONCLUSION:
  - With realistic implied rates (blend), expected profit is ~$${bestRealisticPnl.toFixed(0)} over 90 days
  - Annualized: ~$${(bestRealisticPnl * 4).toFixed(0)} per year on $10k notional = ${((bestRealisticPnl * 4 / 10000) * 100).toFixed(1)}% APY
  - This is BEFORE accounting for:
    * Execution slippage
    * Boros implied rate variation
    * Market conditions changing
`);
}

main().catch(console.error);
