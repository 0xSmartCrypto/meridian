/**
 * Meridian - Leverage Strategy Backtests
 *
 * Testing different leverage approaches to maximize returns while managing risk:
 * 1. Signal-strength leverage scaling
 * 2. Time-decay leverage (add leverage as position matures)
 * 3. Profit-stacking (use profits as margin for new positions)
 * 4. Volatility-adjusted leverage
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
  leverage: number;
  collateral: number;
  entryZScore: number;
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
  leverage: number;
  roiOnCollateral: number;
  liquidated: boolean;
}

interface StrategyResult {
  name: string;
  coin: string;
  trades: Trade[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    liquidations: number;
    winRate: number;
    netPnl: number;
    avgLeverage: number;
    avgRoi: number;
    maxDrawdown: number;
    finalEquity: number;
    roiOnCapital: number;
  };
}

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1 };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev };
}

function recentVolatility(history: FundingRecord[], index: number, window: number = 168): number {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return 0.5;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  return Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length);
}

function zScore(value: number, mean: number, stdDev: number): number {
  return stdDev > 0 ? (value - mean) / stdDev : 0;
}

// Check if position would be liquidated (simplified: lose more than collateral)
function checkLiquidation(
  position: Position,
  currentPnl: number
): boolean {
  // Liquidation when losses exceed ~80% of collateral (health ratio < 1)
  return currentPnl < -(position.collateral * 0.8);
}

// Calculate running PnL for a position
function calculatePnl(
  position: Position,
  history: FundingRecord[],
  fromIndex: number,
  toIndex: number
): number {
  let pnl = 0;
  for (let j = fromIndex + 1; j <= toIndex; j++) {
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

// =============================================================================
// STRATEGY 1: Signal-Strength Leverage
// =============================================================================
function signalStrengthLeverage(z: number): number {
  const absZ = Math.abs(z);
  if (absZ >= 3.0) return 6;
  if (absZ >= 2.5) return 4;
  if (absZ >= 2.0) return 2;
  return 1;
}

// =============================================================================
// STRATEGY 2: Time-Decay Leverage
// =============================================================================
function timeDecayLeverage(hoursHeld: number, totalHours: number): number {
  const progress = hoursHeld / totalHours;
  if (progress >= 0.5) return 5;  // Last 50%: 5x
  if (progress >= 0.25) return 3; // 25-50%: 3x
  return 1.5;                     // First 25%: 1.5x
}

// =============================================================================
// STRATEGY 3: Volatility-Adjusted Leverage
// =============================================================================
function volatilityAdjustedLeverage(currentVol: number, baselineVol: number): number {
  if (baselineVol === 0) return 1;
  const ratio = currentVol / baselineVol;
  // Low vol = higher leverage, high vol = lower leverage
  if (ratio < 0.5) return 6;      // Very calm: 6x
  if (ratio < 0.75) return 4;     // Calm: 4x
  if (ratio < 1.0) return 3;      // Normal: 3x
  if (ratio < 1.5) return 2;      // Elevated: 2x
  return 1;                        // High vol: 1x
}

// =============================================================================
// RUN BACKTEST FOR A STRATEGY
// =============================================================================
function runBacktest(
  data: FundingData,
  strategyName: string,
  getLeverage: (z: number, hoursHeld: number, vol: number, baseVol: number, equity: number, initialEquity: number) => number,
  entryThreshold: number = 2.0,
  holdHours: number = 168
): StrategyResult {
  const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
  const TAKER_FEE = 0.0005;
  const INITIAL_EQUITY = 10000;
  const BASE_POSITION = 10000;

  let position: Position | null = null;
  const trades: Trade[] = [];
  let equity = INITIAL_EQUITY;
  let maxEquity = equity;
  let maxDrawdown = 0;

  // Calculate baseline volatility (first 7 days)
  const baselineVol = recentVolatility(history, 168);

  for (let i = 168; i < history.length; i++) {
    const { mean, stdDev } = rollingStats(history, i);
    const z = zScore(history[i].apr, mean, stdDev);
    const currentVol = recentVolatility(history, i);

    // Check existing position
    if (position) {
      const hoursHeld = i - position.entryIndex;
      const currentPnl = calculatePnl(position, history, position.entryIndex, i);

      // Update leverage based on strategy (for time-decay and profit-stacking)
      const newLeverage = getLeverage(
        position.entryZScore,
        hoursHeld,
        currentVol,
        baselineVol,
        equity + currentPnl,
        INITIAL_EQUITY
      );

      // Check for liquidation
      if (checkLiquidation(position, currentPnl)) {
        // Liquidated - lose collateral
        const lostAmount = position.collateral * 0.9; // Lose 90% of collateral
        trades.push({
          type: position.type,
          entryApr: position.entryApr,
          exitApr: history[i].apr,
          entryTime: position.entryTime,
          exitTime: history[i].timestamp,
          grossPnl: -lostAmount,
          fees: 0,
          netPnl: -lostAmount,
          holdHours: hoursHeld,
          leverage: position.leverage,
          roiOnCollateral: -90,
          liquidated: true,
        });

        equity -= lostAmount;
        maxEquity = Math.max(maxEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (maxEquity - equity) / maxEquity);
        position = null;
        continue;
      }

      // Time-based exit
      if (hoursHeld >= holdHours) {
        const grossPnl = currentPnl;
        const fees = position.notional * TAKER_FEE * 2;
        const netPnl = grossPnl - fees;
        const roiOnCollateral = (netPnl / position.collateral) * 100;

        trades.push({
          type: position.type,
          entryApr: position.entryApr,
          exitApr: history[i].apr,
          entryTime: position.entryTime,
          exitTime: history[i].timestamp,
          grossPnl,
          fees,
          netPnl,
          holdHours: hoursHeld,
          leverage: position.leverage,
          roiOnCollateral,
          liquidated: false,
        });

        equity += netPnl;
        maxEquity = Math.max(maxEquity, equity);
        maxDrawdown = Math.max(maxDrawdown, (maxEquity - equity) / maxEquity);
        position = null;
      }
    }

    // Check for new entry
    if (!position && equity > 1000) {
      let direction: 'LONG' | 'SHORT' | null = null;

      if (z > entryThreshold) {
        direction = 'SHORT';
      } else if (z < -entryThreshold) {
        direction = 'LONG';
      }

      if (direction) {
        const leverage = getLeverage(z, 0, currentVol, baselineVol, equity, INITIAL_EQUITY);
        const collateral = Math.min(equity * 0.2, BASE_POSITION / leverage); // Max 20% of equity per trade
        const notional = collateral * leverage;

        position = {
          type: direction,
          entryApr: history[i].apr,
          entryIndex: i,
          entryTime: history[i].timestamp,
          notional,
          leverage,
          collateral,
          entryZScore: z,
        };
      }
    }
  }

  // Calculate stats
  const wins = trades.filter(t => t.netPnl > 0 && !t.liquidated);
  const losses = trades.filter(t => t.netPnl <= 0 && !t.liquidated);
  const liquidations = trades.filter(t => t.liquidated);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgLeverage = trades.length > 0 ? trades.reduce((s, t) => s + t.leverage, 0) / trades.length : 0;
  const avgRoi = trades.length > 0 ? trades.reduce((s, t) => s + t.roiOnCollateral, 0) / trades.length : 0;

  return {
    name: strategyName,
    coin: data.coin,
    trades,
    stats: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      liquidations: liquidations.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      netPnl,
      avgLeverage,
      avgRoi,
      maxDrawdown,
      finalEquity: equity,
      roiOnCapital: ((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100,
    },
  };
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log('═'.repeat(80));
  console.log('MERIDIAN - LEVERAGE STRATEGY BACKTESTS');
  console.log('═'.repeat(80));
  console.log('\nTesting 4 leverage strategies to maximize returns:\n');
  console.log('1. BASELINE (1x)     - No leverage, pure signal');
  console.log('2. SIGNAL-STRENGTH   - Higher leverage on stronger signals (2-6x)');
  console.log('3. TIME-DECAY        - Add leverage as position matures (1.5-5x)');
  console.log('4. VOLATILITY-ADJ    - Higher leverage in calm markets (1-6x)');
  console.log('5. PROFIT-STACKING   - Use profits to increase leverage');
  console.log('\n' + '─'.repeat(80));

  const coins = ['HYPE', 'BTC', 'ETH'];
  const allResults: StrategyResult[] = [];

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`\nNo data for ${coin}, skipping...`);
      continue;
    }

    console.log(`\n${'═'.repeat(80)}`);
    console.log(`${coin} - ${data.stats.count} hours of data`);
    console.log('═'.repeat(80));

    // Strategy 1: Baseline (1x)
    const baseline = runBacktest(
      data,
      'BASELINE (1x)',
      () => 1
    );
    allResults.push(baseline);

    // Strategy 2: Signal-Strength
    const signalStrength = runBacktest(
      data,
      'SIGNAL-STRENGTH',
      (z) => signalStrengthLeverage(z)
    );
    allResults.push(signalStrength);

    // Strategy 3: Time-Decay
    const timeDecay = runBacktest(
      data,
      'TIME-DECAY',
      (z, hoursHeld) => {
        const baseLev = signalStrengthLeverage(z);
        const timeMult = timeDecayLeverage(hoursHeld, 168);
        return Math.min(baseLev * (timeMult / 2), 8); // Cap at 8x
      }
    );
    allResults.push(timeDecay);

    // Strategy 4: Volatility-Adjusted
    const volAdjusted = runBacktest(
      data,
      'VOLATILITY-ADJ',
      (z, _hours, vol, baseVol) => {
        return volatilityAdjustedLeverage(vol, baseVol);
      }
    );
    allResults.push(volAdjusted);

    // Strategy 5: Profit-Stacking (increase leverage as equity grows)
    const profitStack = runBacktest(
      data,
      'PROFIT-STACK',
      (z, _hours, _vol, _baseVol, equity, initialEquity) => {
        const profitRatio = equity / initialEquity;
        const baseLev = signalStrengthLeverage(z);
        // More profits = can afford more leverage
        if (profitRatio > 1.2) return Math.min(baseLev * 1.5, 8);
        if (profitRatio > 1.1) return Math.min(baseLev * 1.25, 6);
        if (profitRatio < 0.9) return Math.max(baseLev * 0.5, 1); // Reduce if losing
        return baseLev;
      }
    );
    allResults.push(profitStack);

    // Print results for this coin
    const coinResults = [baseline, signalStrength, timeDecay, volAdjusted, profitStack];

    console.log('\n' + '─'.repeat(80));
    console.log('Strategy           | Trades | Win% | Liq | Avg Lev | Net PnL   | ROI%   | MaxDD');
    console.log('─'.repeat(80));

    for (const r of coinResults) {
      const liqWarning = r.stats.liquidations > 0 ? '⚠️ ' : '   ';
      console.log(
        `${liqWarning}${r.name.padEnd(16)} | ` +
        `${r.stats.totalTrades.toString().padStart(6)} | ` +
        `${(r.stats.winRate * 100).toFixed(0).padStart(3)}% | ` +
        `${r.stats.liquidations.toString().padStart(3)} | ` +
        `${r.stats.avgLeverage.toFixed(1).padStart(7)}x | ` +
        `$${r.stats.netPnl.toFixed(0).padStart(8)} | ` +
        `${r.stats.roiOnCapital.toFixed(1).padStart(5)}% | ` +
        `${(r.stats.maxDrawdown * 100).toFixed(1)}%`
      );
    }

    // Show individual trades for best performer
    const best = coinResults.reduce((a, b) =>
      (b.stats.roiOnCapital > a.stats.roiOnCapital && b.stats.liquidations === 0) ? b : a
    );

    if (best.trades.length > 0 && best.trades.length <= 12) {
      console.log(`\n📊 ${best.name} Trades:`);
      for (const t of best.trades) {
        const icon = t.liquidated ? '💀' : (t.netPnl >= 0 ? '✅' : '❌');
        console.log(
          `  ${icon} ${t.type.padEnd(5)} | ` +
          `${t.leverage.toFixed(1)}x | ` +
          `${(t.entryApr * 100).toFixed(1).padStart(5)}% → ${(t.exitApr * 100).toFixed(1).padStart(5)}% | ` +
          `${t.holdHours}h | ` +
          `ROI: ${t.roiOnCollateral >= 0 ? '+' : ''}${t.roiOnCollateral.toFixed(1)}%`
        );
      }
    }
  }

  // =============================================================================
  // FINAL SUMMARY
  // =============================================================================
  console.log('\n' + '═'.repeat(80));
  console.log('FINAL SUMMARY - ALL COINS');
  console.log('═'.repeat(80));

  // Group by strategy
  const strategies = ['BASELINE (1x)', 'SIGNAL-STRENGTH', 'TIME-DECAY', 'VOLATILITY-ADJ', 'PROFIT-STACK'];

  console.log('\nAggregate Performance (sum across HYPE, BTC, ETH):\n');
  console.log('Strategy           | Total PnL | Avg ROI% | Total Liq | Risk-Adj Score');
  console.log('─'.repeat(70));

  for (const strat of strategies) {
    const stratResults = allResults.filter(r => r.name === strat);
    const totalPnl = stratResults.reduce((s, r) => s + r.stats.netPnl, 0);
    const avgRoi = stratResults.reduce((s, r) => s + r.stats.roiOnCapital, 0) / stratResults.length;
    const totalLiq = stratResults.reduce((s, r) => s + r.stats.liquidations, 0);
    const avgDD = stratResults.reduce((s, r) => s + r.stats.maxDrawdown, 0) / stratResults.length;

    // Risk-adjusted score: ROI / (1 + drawdown + liquidation_penalty)
    const liqPenalty = totalLiq * 0.2;
    const riskAdjScore = avgRoi / (1 + avgDD + liqPenalty);

    const warning = totalLiq > 0 ? '⚠️ ' : '   ';
    console.log(
      `${warning}${strat.padEnd(16)} | ` +
      `$${totalPnl.toFixed(0).padStart(9)} | ` +
      `${avgRoi.toFixed(1).padStart(7)}% | ` +
      `${totalLiq.toString().padStart(9)} | ` +
      `${riskAdjScore.toFixed(2)}`
    );
  }

  console.log('\n' + '─'.repeat(80));
  console.log('KEY INSIGHTS:');
  console.log('─'.repeat(80));
  console.log('• Liquidations (Liq) = times you would have lost 90% of collateral');
  console.log('• Risk-Adj Score = ROI penalized by drawdown and liquidations');
  console.log('• Higher leverage amplifies both wins AND liquidation risk');
  console.log('• Best strategy balances ROI with zero liquidations');
  console.log('─'.repeat(80));
}

main().catch(console.error);
