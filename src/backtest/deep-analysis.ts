/**
 * Deep Analysis - Looking for patterns in funding rate data
 *
 * Questions to answer:
 * 1. At extreme z-scores, what's the gap between floating and 7dMA?
 * 2. How fast does funding revert from extremes?
 * 3. Are there time patterns (hour of day, day of week)?
 * 4. Does the "premium" field predict funding movements?
 * 5. Cross-asset correlations?
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
  history: FundingRecord[];
}

function rollingStats(history: FundingRecord[], index: number, window: number = 168) {
  const start = Math.max(0, index - window);
  const slice = history.slice(start, index).map(h => h.apr);
  if (slice.length < 24) return { mean: 0, stdDev: 0.1, ma: 0 };
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length) || 0.01;
  return { mean, stdDev, ma: mean };
}

async function main() {
  const coins = ['HYPE', 'BTC', 'ETH'];
  const allData: Record<string, FundingData> = {};

  for (const coin of coins) {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    try {
      allData[coin] = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {}
  }

  console.log('═'.repeat(90));
  console.log('  DEEP ANALYSIS: HUNTING FOR EDGE');
  console.log('═'.repeat(90));

  // ==========================================
  // 1. AT EXTREMES: FLOATING VS 7DMA GAP
  // ==========================================
  console.log('\n\n📊 1. AT EXTREME Z-SCORES: FLOATING vs 7DMA GAP');
  console.log('─'.repeat(90));
  console.log('   Question: When funding spikes, how far is it from the 7dMA?');
  console.log('   Why it matters: Larger gap = more potential profit if implied tracks floating\n');

  for (const coin of coins) {
    const data = allData[coin];
    if (!data) continue;

    const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
    const extremes: { z: number; floating: number; ma7d: number; gap: number; gapPct: number }[] = [];

    for (let i = 168; i < history.length; i++) {
      const { mean, stdDev, ma } = rollingStats(history, i);
      const floating = history[i].apr;
      const z = stdDev > 0 ? (floating - mean) / stdDev : 0;

      if (Math.abs(z) >= 2.0) {
        const gap = floating - ma;
        const gapPct = ma !== 0 ? (gap / Math.abs(ma)) * 100 : 0;
        extremes.push({ z, floating, ma7d: ma, gap, gapPct });
      }
    }

    if (extremes.length === 0) continue;

    const avgGap = extremes.reduce((s, e) => s + Math.abs(e.gap), 0) / extremes.length;
    const avgGapPct = extremes.reduce((s, e) => s + Math.abs(e.gapPct), 0) / extremes.length;

    // Split by direction
    const highExtremes = extremes.filter(e => e.z > 0);
    const lowExtremes = extremes.filter(e => e.z < 0);

    console.log(`  ${coin}:`);
    console.log(`    Total extreme events (|z| >= 2.0): ${extremes.length}`);
    console.log(`    Avg absolute gap: ${(avgGap * 100).toFixed(1)}% APR`);
    console.log(`    Avg gap as % of 7dMA: ${avgGapPct.toFixed(0)}%`);

    if (highExtremes.length > 0) {
      const avgHighGap = highExtremes.reduce((s, e) => s + e.gap, 0) / highExtremes.length;
      console.log(`    HIGH funding events (z > 2): ${highExtremes.length}, avg gap +${(avgHighGap * 100).toFixed(1)}%`);
    }
    if (lowExtremes.length > 0) {
      const avgLowGap = lowExtremes.reduce((s, e) => s + e.gap, 0) / lowExtremes.length;
      console.log(`    LOW funding events (z < -2): ${lowExtremes.length}, avg gap ${(avgLowGap * 100).toFixed(1)}%`);
    }
    console.log();
  }

  // ==========================================
  // 2. REVERSION SPEED ANALYSIS
  // ==========================================
  console.log('\n📊 2. REVERSION SPEED: HOW FAST DOES FUNDING NORMALIZE?');
  console.log('─'.repeat(90));
  console.log('   Question: After an extreme, how many hours until z-score < 1.0?');
  console.log('   Why it matters: Faster reversion = more profit captured in same time\n');

  for (const coin of coins) {
    const data = allData[coin];
    if (!data) continue;

    const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
    const reversionTimes: number[] = [];

    for (let i = 168; i < history.length - 168; i++) {
      const { mean, stdDev } = rollingStats(history, i);
      const z = stdDev > 0 ? (history[i].apr - mean) / stdDev : 0;

      if (Math.abs(z) >= 2.5) {
        // Find when it reverts to |z| < 1.0
        for (let j = i + 1; j < Math.min(i + 168, history.length); j++) {
          const stats2 = rollingStats(history, j);
          const z2 = stats2.stdDev > 0 ? (history[j].apr - stats2.mean) / stats2.stdDev : 0;
          if (Math.abs(z2) < 1.0) {
            reversionTimes.push(j - i);
            break;
          }
        }
      }
    }

    if (reversionTimes.length === 0) continue;

    const avgReversion = reversionTimes.reduce((a, b) => a + b, 0) / reversionTimes.length;
    const minReversion = Math.min(...reversionTimes);
    const maxReversion = Math.max(...reversionTimes);
    const medianReversion = reversionTimes.sort((a, b) => a - b)[Math.floor(reversionTimes.length / 2)];

    console.log(`  ${coin}:`);
    console.log(`    Extreme events tracked: ${reversionTimes.length}`);
    console.log(`    Avg hours to revert: ${avgReversion.toFixed(1)}h (${(avgReversion/24).toFixed(1)} days)`);
    console.log(`    Median: ${medianReversion}h, Min: ${minReversion}h, Max: ${maxReversion}h`);

    // Distribution
    const fast = reversionTimes.filter(t => t <= 24).length;
    const medium = reversionTimes.filter(t => t > 24 && t <= 72).length;
    const slow = reversionTimes.filter(t => t > 72).length;
    console.log(`    Speed distribution: ${fast} fast (<24h), ${medium} medium (24-72h), ${slow} slow (>72h)`);
    console.log();
  }

  // ==========================================
  // 3. TIME PATTERNS
  // ==========================================
  console.log('\n📊 3. TIME PATTERNS: WHEN DO EXTREMES OCCUR?');
  console.log('─'.repeat(90));
  console.log('   Question: Are there predictable times when funding spikes?\n');

  for (const coin of coins) {
    const data = allData[coin];
    if (!data) continue;

    const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);
    const hourCounts: number[] = new Array(24).fill(0);
    const dayCounts: number[] = new Array(7).fill(0);
    let totalExtremes = 0;

    for (let i = 168; i < history.length; i++) {
      const { mean, stdDev } = rollingStats(history, i);
      const z = stdDev > 0 ? (history[i].apr - mean) / stdDev : 0;

      if (Math.abs(z) >= 2.0) {
        const date = new Date(history[i].timestamp);
        hourCounts[date.getUTCHours()]++;
        dayCounts[date.getUTCDay()]++;
        totalExtremes++;
      }
    }

    if (totalExtremes === 0) continue;

    // Find peak hours
    const avgPerHour = totalExtremes / 24;
    const hotHours = hourCounts
      .map((count, hour) => ({ hour, count, ratio: count / avgPerHour }))
      .filter(h => h.ratio > 1.3)
      .sort((a, b) => b.ratio - a.ratio);

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const avgPerDay = totalExtremes / 7;
    const hotDays = dayCounts
      .map((count, day) => ({ day: days[day], count, ratio: count / avgPerDay }))
      .filter(d => d.ratio > 1.2)
      .sort((a, b) => b.ratio - a.ratio);

    console.log(`  ${coin}: ${totalExtremes} extreme events`);
    if (hotHours.length > 0) {
      console.log(`    Hot hours (UTC): ${hotHours.map(h => `${h.hour}:00 (${(h.ratio).toFixed(1)}x)`).join(', ')}`);
    } else {
      console.log(`    No significant hour pattern`);
    }
    if (hotDays.length > 0) {
      console.log(`    Hot days: ${hotDays.map(d => `${d.day} (${(d.ratio).toFixed(1)}x)`).join(', ')}`);
    } else {
      console.log(`    No significant day pattern`);
    }
    console.log();
  }

  // ==========================================
  // 4. PREMIUM AS PREDICTOR
  // ==========================================
  console.log('\n📊 4. PREMIUM AS LEADING INDICATOR');
  console.log('─'.repeat(90));
  console.log('   Question: Does the premium field predict funding rate changes?');
  console.log('   Premium = (mark price - index price) / index price\n');

  for (const coin of coins) {
    const data = allData[coin];
    if (!data) continue;

    const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);

    // Check if premium predicts next-hour funding direction
    let correctPredictions = 0;
    let totalPredictions = 0;

    for (let i = 1; i < history.length - 1; i++) {
      const premium = parseFloat(history[i].premium);
      const currentApr = history[i].apr;
      const nextApr = history[i + 1].apr;
      const aprChange = nextApr - currentApr;

      // Does premium sign predict apr change direction?
      if (Math.abs(premium) > 0.0001 && Math.abs(aprChange) > 0.001) {
        totalPredictions++;
        if ((premium > 0 && aprChange > 0) || (premium < 0 && aprChange < 0)) {
          correctPredictions++;
        }
      }
    }

    const accuracy = totalPredictions > 0 ? (correctPredictions / totalPredictions) * 100 : 0;
    console.log(`  ${coin}: Premium predicts next-hour direction ${accuracy.toFixed(1)}% of time (n=${totalPredictions})`);

    // Check if extreme premium predicts extreme funding
    let extremePremiumLeadsToExtreme = 0;
    let extremePremiumCount = 0;

    for (let i = 168; i < history.length - 24; i++) {
      const premium = parseFloat(history[i].premium);
      if (Math.abs(premium) > 0.001) { // Extreme premium
        extremePremiumCount++;
        // Check if funding becomes extreme in next 24 hours
        for (let j = i + 1; j <= i + 24 && j < history.length; j++) {
          const { mean, stdDev } = rollingStats(history, j);
          const z = stdDev > 0 ? (history[j].apr - mean) / stdDev : 0;
          if (Math.abs(z) >= 2.0) {
            extremePremiumLeadsToExtreme++;
            break;
          }
        }
      }
    }

    if (extremePremiumCount > 0) {
      const extremeAccuracy = (extremePremiumLeadsToExtreme / extremePremiumCount) * 100;
      console.log(`    Extreme premium (>0.1%) leads to extreme funding within 24h: ${extremeAccuracy.toFixed(1)}% (n=${extremePremiumCount})`);
    }
  }

  // ==========================================
  // 5. CROSS-ASSET CORRELATION
  // ==========================================
  console.log('\n\n📊 5. CROSS-ASSET SIGNALS');
  console.log('─'.repeat(90));
  console.log('   Question: Can BTC/ETH extremes predict HYPE extremes?\n');

  if (allData['HYPE'] && allData['BTC'] && allData['ETH']) {
    const hypeHistory = allData['HYPE'].history.filter(h => h.apr >= -2 && h.apr <= 2);
    const btcHistory = allData['BTC'].history.filter(h => h.apr >= -2 && h.apr <= 2);
    const ethHistory = allData['ETH'].history.filter(h => h.apr >= -2 && h.apr <= 2);

    // Create time-aligned data
    const timeMap = new Map<number, { hype?: number; btc?: number; eth?: number }>();

    for (const h of hypeHistory) {
      const hourKey = Math.floor(h.time / 3600000);
      if (!timeMap.has(hourKey)) timeMap.set(hourKey, {});
      timeMap.get(hourKey)!.hype = h.apr;
    }
    for (const h of btcHistory) {
      const hourKey = Math.floor(h.time / 3600000);
      if (!timeMap.has(hourKey)) timeMap.set(hourKey, {});
      timeMap.get(hourKey)!.btc = h.apr;
    }
    for (const h of ethHistory) {
      const hourKey = Math.floor(h.time / 3600000);
      if (!timeMap.has(hourKey)) timeMap.set(hourKey, {});
      timeMap.get(hourKey)!.eth = h.apr;
    }

    // Check correlation
    const aligned: { hype: number; btc: number; eth: number }[] = [];
    for (const [_, v] of timeMap) {
      if (v.hype !== undefined && v.btc !== undefined && v.eth !== undefined) {
        aligned.push({ hype: v.hype, btc: v.btc, eth: v.eth });
      }
    }

    if (aligned.length > 100) {
      // Calculate correlations
      const hypeArr = aligned.map(a => a.hype);
      const btcArr = aligned.map(a => a.btc);
      const ethArr = aligned.map(a => a.eth);

      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const correlation = (a: number[], b: number[]) => {
        const meanA = mean(a);
        const meanB = mean(b);
        let num = 0, denA = 0, denB = 0;
        for (let i = 0; i < a.length; i++) {
          num += (a[i] - meanA) * (b[i] - meanB);
          denA += Math.pow(a[i] - meanA, 2);
          denB += Math.pow(b[i] - meanB, 2);
        }
        return num / Math.sqrt(denA * denB);
      };

      const hypeBtcCorr = correlation(hypeArr, btcArr);
      const hypeEthCorr = correlation(hypeArr, ethArr);
      const btcEthCorr = correlation(btcArr, ethArr);

      console.log(`  Funding rate correlations (${aligned.length} hours):`);
      console.log(`    HYPE-BTC: ${(hypeBtcCorr * 100).toFixed(1)}%`);
      console.log(`    HYPE-ETH: ${(hypeEthCorr * 100).toFixed(1)}%`);
      console.log(`    BTC-ETH:  ${(btcEthCorr * 100).toFixed(1)}%`);

      // Check if BTC extreme leads HYPE extreme
      let btcLeadsHype = 0;
      let btcExtremeCount = 0;

      const keys = Array.from(timeMap.keys()).sort((a, b) => a - b);
      for (let i = 168; i < keys.length - 24; i++) {
        const btcApr = timeMap.get(keys[i])?.btc;
        if (btcApr === undefined) continue;

        // Simple z-score approximation
        const recentBtc = keys.slice(Math.max(0, i - 168), i)
          .map(k => timeMap.get(k)?.btc)
          .filter(v => v !== undefined) as number[];

        if (recentBtc.length < 24) continue;

        const btcMean = mean(recentBtc);
        const btcStd = Math.sqrt(recentBtc.reduce((s, v) => s + Math.pow(v - btcMean, 2), 0) / recentBtc.length) || 0.01;
        const btcZ = (btcApr - btcMean) / btcStd;

        if (Math.abs(btcZ) >= 2.5) {
          btcExtremeCount++;
          // Check if HYPE becomes extreme in next 24h
          for (let j = 1; j <= 24; j++) {
            const hypeApr = timeMap.get(keys[i + j])?.hype;
            if (hypeApr === undefined) continue;

            const recentHype = keys.slice(Math.max(0, i + j - 168), i + j)
              .map(k => timeMap.get(k)?.hype)
              .filter(v => v !== undefined) as number[];

            if (recentHype.length < 24) continue;

            const hypeMean = mean(recentHype);
            const hypeStd = Math.sqrt(recentHype.reduce((s, v) => s + Math.pow(v - hypeMean, 2), 0) / recentHype.length) || 0.01;
            const hypeZ = (hypeApr - hypeMean) / hypeStd;

            if (Math.abs(hypeZ) >= 2.0) {
              btcLeadsHype++;
              break;
            }
          }
        }
      }

      if (btcExtremeCount > 0) {
        console.log(`\n  Leading indicator test:`);
        console.log(`    BTC extreme → HYPE extreme within 24h: ${((btcLeadsHype / btcExtremeCount) * 100).toFixed(1)}% (n=${btcExtremeCount})`);
      }
    }
  }

  // ==========================================
  // 6. OPTIMAL ENTRY TIMING
  // ==========================================
  console.log('\n\n📊 6. OPTIMAL ENTRY: WAIT FOR THE SPIKE OR CATCH IT EARLY?');
  console.log('─'.repeat(90));
  console.log('   Question: Is it better to enter at first z>2.0 or wait for z>2.5 or z>3.0?\n');

  for (const coin of coins) {
    const data = allData[coin];
    if (!data) continue;

    const history = data.history.filter(h => h.apr >= -2 && h.apr <= 2);

    // Track extreme sequences
    const sequences: { peakZ: number; peakIdx: number; entryAt2: number; entryAt25: number; entryAt3: number }[] = [];
    let inExtreme = false;
    let currentSeq: { startIdx: number; peakZ: number; peakIdx: number; entryAt2?: number; entryAt25?: number; entryAt3?: number } | null = null;

    for (let i = 168; i < history.length; i++) {
      const { mean, stdDev } = rollingStats(history, i);
      const z = stdDev > 0 ? (history[i].apr - mean) / stdDev : 0;
      const absZ = Math.abs(z);

      if (absZ >= 2.0 && !inExtreme) {
        // Start new sequence
        inExtreme = true;
        currentSeq = { startIdx: i, peakZ: absZ, peakIdx: i };
        currentSeq.entryAt2 = i;
      } else if (inExtreme && currentSeq) {
        if (absZ >= 2.5 && !currentSeq.entryAt25) {
          currentSeq.entryAt25 = i;
        }
        if (absZ >= 3.0 && !currentSeq.entryAt3) {
          currentSeq.entryAt3 = i;
        }
        if (absZ > currentSeq.peakZ) {
          currentSeq.peakZ = absZ;
          currentSeq.peakIdx = i;
        }
        if (absZ < 1.5) {
          // End sequence
          sequences.push({
            peakZ: currentSeq.peakZ,
            peakIdx: currentSeq.peakIdx,
            entryAt2: currentSeq.entryAt2 || currentSeq.peakIdx,
            entryAt25: currentSeq.entryAt25 || currentSeq.peakIdx,
            entryAt3: currentSeq.entryAt3 || currentSeq.peakIdx,
          });
          inExtreme = false;
          currentSeq = null;
        }
      }
    }

    if (sequences.length === 0) continue;

    // Analyze timing
    const avgPeakZ = sequences.reduce((s, seq) => s + seq.peakZ, 0) / sequences.length;
    const reachedZ25 = sequences.filter(s => s.entryAt25 !== s.peakIdx).length;
    const reachedZ3 = sequences.filter(s => s.entryAt3 !== s.peakIdx).length;

    // Hours from z>2.0 to peak
    const hoursTo2ToPeak = sequences.map(s => s.peakIdx - s.entryAt2);
    const avgHours2ToPeak = hoursTo2ToPeak.reduce((a, b) => a + b, 0) / hoursTo2ToPeak.length;

    console.log(`  ${coin}: ${sequences.length} extreme sequences`);
    console.log(`    Avg peak z-score: ${avgPeakZ.toFixed(2)}`);
    console.log(`    Reached z>2.5: ${reachedZ25}/${sequences.length} (${((reachedZ25/sequences.length)*100).toFixed(0)}%)`);
    console.log(`    Reached z>3.0: ${reachedZ3}/${sequences.length} (${((reachedZ3/sequences.length)*100).toFixed(0)}%)`);
    console.log(`    Avg hours from z>2.0 to peak: ${avgHours2ToPeak.toFixed(1)}h`);
    console.log();
  }

  console.log('\n' + '═'.repeat(90));
  console.log('  SUMMARY: ACTIONABLE INSIGHTS');
  console.log('═'.repeat(90));
}

main().catch(console.error);
