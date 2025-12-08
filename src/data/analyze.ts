/**
 * Meridian - Data Analysis Module
 *
 * Analyzes funding rate data for mean reversion patterns
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
    median: number;
    min: number;
    max: number;
    stdDev: number;
    count: number;
  };
  history: FundingRecord[];
}

/**
 * Calculate z-score (how many std devs from mean)
 */
function zScore(value: number, mean: number, stdDev: number): number {
  return (value - mean) / stdDev;
}

/**
 * Find mean reversion signals
 */
function findSignals(data: FundingData, threshold: number = 1.5) {
  const { mean, stdDev } = data.stats;
  const signals: Array<{
    time: string;
    apr: number;
    zScore: number;
    signal: 'SHORT' | 'LONG' | 'NONE';
  }> = [];

  for (const record of data.history) {
    const z = zScore(record.apr, mean, stdDev);
    let signal: 'SHORT' | 'LONG' | 'NONE' = 'NONE';

    if (z > threshold) signal = 'SHORT'; // Funding too high, bet it goes down
    if (z < -threshold) signal = 'LONG'; // Funding too low, bet it goes up

    signals.push({
      time: record.timestamp,
      apr: record.apr,
      zScore: z,
      signal,
    });
  }

  return signals;
}

/**
 * Analyze mean reversion behavior
 */
function analyzeMeanReversion(data: FundingData) {
  const { mean, stdDev } = data.stats;
  const history = data.history;

  // Track how often extreme readings revert
  let extremeHighs = 0;
  let extremeHighsReverted = 0;
  let extremeLows = 0;
  let extremeLowsReverted = 0;

  const lookforward = 24; // 24 hours to revert

  for (let i = 0; i < history.length - lookforward; i++) {
    const z = zScore(history[i].apr, mean, stdDev);

    if (z > 1.5) {
      extremeHighs++;
      // Check if it reverted within lookforward period
      for (let j = i + 1; j < Math.min(i + lookforward, history.length); j++) {
        const futureZ = zScore(history[j].apr, mean, stdDev);
        if (futureZ < 1.0) {
          extremeHighsReverted++;
          break;
        }
      }
    }

    if (z < -1.5) {
      extremeLows++;
      for (let j = i + 1; j < Math.min(i + lookforward, history.length); j++) {
        const futureZ = zScore(history[j].apr, mean, stdDev);
        if (futureZ > -1.0) {
          extremeLowsReverted++;
          break;
        }
      }
    }
  }

  return {
    extremeHighs,
    extremeHighsReverted,
    highReversionRate: extremeHighs > 0 ? extremeHighsReverted / extremeHighs : 0,
    extremeLows,
    extremeLowsReverted,
    lowReversionRate: extremeLows > 0 ? extremeLowsReverted / extremeLows : 0,
  };
}

/**
 * Calculate autocorrelation (does funding predict next funding?)
 */
function autocorrelation(data: FundingData, lag: number = 1): number {
  const aprs = data.history.map(h => h.apr);
  const mean = data.stats.mean;
  const n = aprs.length - lag;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (aprs[i] - mean) * (aprs[i + lag] - mean);
  }

  for (let i = 0; i < aprs.length; i++) {
    denominator += Math.pow(aprs[i] - mean, 2);
  }

  return numerator / denominator;
}

/**
 * Main analysis
 */
async function main() {
  console.log('Meridian - Data Analysis\n');
  console.log('═'.repeat(70));

  const coins = ['HYPE', 'BTC', 'ETH'];

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    let data: FundingData;

    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      console.log(`No data for ${coin}, skipping...`);
      continue;
    }

    console.log(`\n${coin} Analysis`);
    console.log('─'.repeat(70));

    // Basic stats
    console.log('\n📊 Basic Stats:');
    console.log(`   Mean APR:    ${(data.stats.mean * 100).toFixed(2)}%`);
    console.log(`   Median APR:  ${(data.stats.median * 100).toFixed(2)}%`);
    console.log(`   Std Dev:     ${(data.stats.stdDev * 100).toFixed(2)}%`);
    console.log(`   Range:       ${(data.stats.min * 100).toFixed(2)}% to ${(data.stats.max * 100).toFixed(2)}%`);

    // Mean reversion analysis
    const reversion = analyzeMeanReversion(data);
    console.log('\n📈 Mean Reversion (24h window):');
    console.log(`   Extreme highs (>1.5σ):    ${reversion.extremeHighs}`);
    console.log(`   → Reverted within 24h:    ${reversion.extremeHighsReverted} (${(reversion.highReversionRate * 100).toFixed(1)}%)`);
    console.log(`   Extreme lows (<-1.5σ):    ${reversion.extremeLows}`);
    console.log(`   → Reverted within 24h:    ${reversion.extremeLowsReverted} (${(reversion.lowReversionRate * 100).toFixed(1)}%)`);

    // Autocorrelation
    const ac1 = autocorrelation(data, 1);
    const ac6 = autocorrelation(data, 6);
    const ac24 = autocorrelation(data, 24);
    console.log('\n🔄 Autocorrelation (persistence):');
    console.log(`   1-hour lag:   ${ac1.toFixed(3)} ${ac1 > 0.5 ? '(high persistence)' : ac1 > 0.2 ? '(moderate)' : '(low)'}`);
    console.log(`   6-hour lag:   ${ac6.toFixed(3)}`);
    console.log(`   24-hour lag:  ${ac24.toFixed(3)}`);

    // Signal distribution
    const signals = findSignals(data, 1.5);
    const shortSignals = signals.filter(s => s.signal === 'SHORT').length;
    const longSignals = signals.filter(s => s.signal === 'LONG').length;
    console.log('\n🎯 Signal Distribution (1.5σ threshold):');
    console.log(`   SHORT signals: ${shortSignals} (${((shortSignals / signals.length) * 100).toFixed(1)}%)`);
    console.log(`   LONG signals:  ${longSignals} (${((longSignals / signals.length) * 100).toFixed(1)}%)`);
    console.log(`   No signal:     ${signals.length - shortSignals - longSignals} (${(((signals.length - shortSignals - longSignals) / signals.length) * 100).toFixed(1)}%)`);

    // Current state
    const latest = data.history[data.history.length - 1];
    const currentZ = zScore(latest.apr, data.stats.mean, data.stats.stdDev);
    console.log('\n⚡ Current State:');
    console.log(`   Latest APR:   ${(latest.apr * 100).toFixed(2)}%`);
    console.log(`   Z-Score:      ${currentZ.toFixed(2)}σ`);
    console.log(`   Signal:       ${currentZ > 1.5 ? 'SHORT' : currentZ < -1.5 ? 'LONG' : 'NONE'}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('\n💡 Key Insights:');
  console.log('   - High reversion rate = mean reversion strategy viable');
  console.log('   - High autocorrelation = trends persist, wait for confirmation');
  console.log('   - Low autocorrelation = faster mean reversion');
}

main().catch(console.error);
