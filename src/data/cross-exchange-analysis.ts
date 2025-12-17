/**
 * Cross-Exchange Funding Rate Arbitrage Analysis
 *
 * Compares historical funding rates between Hyperliquid and OKX
 * to determine if arbitrage spreads are persistent and worth pursuing.
 */

import 'dotenv/config';

const COINS = ['BTC', 'ETH'];
const OKX_API = 'https://www.okx.com/api/v5/public';
const HL_API = 'https://api.hyperliquid.xyz/info';

interface FundingRecord {
  timestamp: number;
  coin: string;
  exchange: 'HL' | 'OKX';
  rate: number; // per-period rate
  apr: number; // annualized
}

interface SpreadRecord {
  timestamp: number;
  coin: string;
  hlApr: number;
  okxApr: number;
  spread: number; // HL - OKX
  direction: 'SHORT_HL_LONG_OKX' | 'LONG_HL_SHORT_OKX' | 'NO_ARB';
}

// Fetch OKX historical funding (last 100 periods = ~33 days at 8h intervals)
async function fetchOkxHistory(coin: string): Promise<FundingRecord[]> {
  const instId = `${coin}-USDT-SWAP`;
  const url = `${OKX_API}/funding-rate-history?instId=${instId}&limit=100`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== '0' || !data.data) {
      console.error(`OKX error for ${coin}:`, data.msg);
      return [];
    }

    return data.data.map((d: any) => ({
      timestamp: parseInt(d.fundingTime),
      coin,
      exchange: 'OKX' as const,
      rate: parseFloat(d.fundingRate),
      apr: parseFloat(d.fundingRate) * 3 * 365, // 8h periods, 3 per day
    }));
  } catch (err) {
    console.error(`Failed to fetch OKX ${coin}:`, err);
    return [];
  }
}

// Fetch Hyperliquid historical funding
async function fetchHlHistory(coin: string): Promise<FundingRecord[]> {
  const startTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  try {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin,
        startTime,
      }),
    });

    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error(`HL error for ${coin}:`, data);
      return [];
    }

    return data.map((d: any) => ({
      timestamp: d.time,
      coin,
      exchange: 'HL' as const,
      rate: parseFloat(d.fundingRate),
      apr: parseFloat(d.fundingRate) * 24 * 365, // hourly, 24 per day
    }));
  } catch (err) {
    console.error(`Failed to fetch HL ${coin}:`, err);
    return [];
  }
}

// Align timestamps and calculate spreads
// OKX settles every 8h, HL every 1h
// We'll sample at 8h intervals (OKX settlement times)
function calculateSpreads(hlData: FundingRecord[], okxData: FundingRecord[]): SpreadRecord[] {
  const spreads: SpreadRecord[] = [];

  // Group HL data by 8h windows to match OKX
  const hlByWindow = new Map<number, FundingRecord[]>();

  for (const hl of hlData) {
    // Round to 8h window
    const window = Math.floor(hl.timestamp / (8 * 60 * 60 * 1000)) * (8 * 60 * 60 * 1000);
    if (!hlByWindow.has(window)) {
      hlByWindow.set(window, []);
    }
    hlByWindow.get(window)!.push(hl);
  }

  // For each OKX settlement, calculate HL average for that 8h window
  for (const okx of okxData) {
    const window = Math.floor(okx.timestamp / (8 * 60 * 60 * 1000)) * (8 * 60 * 60 * 1000);
    const hlRecords = hlByWindow.get(window);

    if (!hlRecords || hlRecords.length === 0) continue;

    // Sum the 8 hourly HL rates and annualize
    const hlTotalRate = hlRecords.reduce((sum, r) => sum + r.rate, 0);
    const hlApr = hlTotalRate * 3 * 365; // 8h equivalent, 3 per day

    const spread = hlApr - okx.apr;

    let direction: SpreadRecord['direction'] = 'NO_ARB';
    if (spread > 0.01) { // HL higher, short HL + long OKX
      direction = 'SHORT_HL_LONG_OKX';
    } else if (spread < -0.01) { // OKX higher, long HL + short OKX
      direction = 'LONG_HL_SHORT_OKX';
    }

    spreads.push({
      timestamp: okx.timestamp,
      coin: okx.coin,
      hlApr,
      okxApr: okx.apr,
      spread,
      direction,
    });
  }

  return spreads.sort((a, b) => a.timestamp - b.timestamp);
}

function analyzeReturns(spreads: SpreadRecord[], minSpread: number = 0.05): void {
  const viable = spreads.filter(s => Math.abs(s.spread) >= minSpread);

  if (viable.length === 0) {
    console.log(`  No opportunities with spread >= ${(minSpread * 100).toFixed(0)}%`);
    return;
  }

  const avgSpread = viable.reduce((s, r) => s + Math.abs(r.spread), 0) / viable.length;
  const maxSpread = Math.max(...viable.map(r => Math.abs(r.spread)));
  const minSpreadFound = Math.min(...viable.map(r => Math.abs(r.spread)));

  // Calculate returns at different leverage levels
  const positions = viable.length; // number of 8h periods with opportunity
  const daysWithOpportunity = positions / 3; // 3 periods per day

  console.log(`  Opportunities: ${viable.length} / ${spreads.length} periods (${(viable.length / spreads.length * 100).toFixed(0)}%)`);
  console.log(`  Days with arb: ${daysWithOpportunity.toFixed(1)} days`);
  console.log(`  Avg spread: ${(avgSpread * 100).toFixed(2)}%`);
  console.log(`  Max spread: ${(maxSpread * 100).toFixed(2)}%`);
  console.log(`  Min spread: ${(minSpreadFound * 100).toFixed(2)}%`);

  // Estimate returns
  // If we capture the avg spread for those periods
  const periodsPerYear = 3 * 365;
  const captureRate = viable.length / spreads.length;
  const effectiveApr = avgSpread * captureRate * periodsPerYear / periodsPerYear; // simplified

  console.log(`\n  📊 Estimated Returns ($10k notional):`);

  for (const leverage of [1, 2, 3]) {
    const capitalRequired = (10000 * 2) / leverage; // split across 2 exchanges
    const annualReturn = avgSpread * 10000 * captureRate;
    const effectiveReturn = (annualReturn / capitalRequired) * 100;

    console.log(`    ${leverage}x leverage: $${capitalRequired.toFixed(0)} capital → ${effectiveReturn.toFixed(1)}% effective APR`);
  }
}

async function main() {
  console.log('Cross-Exchange Funding Rate Arbitrage Analysis');
  console.log('═'.repeat(60));
  console.log('Comparing Hyperliquid vs OKX (last 30 days)\n');

  for (const coin of COINS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📊 ${coin}`);
    console.log('─'.repeat(60));

    console.log('Fetching Hyperliquid history...');
    const hlData = await fetchHlHistory(coin);
    console.log(`  Got ${hlData.length} records`);

    console.log('Fetching OKX history...');
    const okxData = await fetchOkxHistory(coin);
    console.log(`  Got ${okxData.length} records`);

    if (hlData.length === 0 || okxData.length === 0) {
      console.log('  ❌ Insufficient data');
      continue;
    }

    const spreads = calculateSpreads(hlData, okxData);
    console.log(`\nCalculated ${spreads.length} spread records`);

    // Show current rates
    const latest = spreads[spreads.length - 1];
    if (latest) {
      console.log(`\n📍 Latest (${new Date(latest.timestamp).toISOString()}):`);
      console.log(`  HL APR:  ${(latest.hlApr * 100).toFixed(2)}%`);
      console.log(`  OKX APR: ${(latest.okxApr * 100).toFixed(2)}%`);
      console.log(`  Spread:  ${(latest.spread * 100).toFixed(2)}%`);
      console.log(`  Direction: ${latest.direction}`);
    }

    // Analyze at different thresholds
    console.log(`\n📈 Analysis at different spread thresholds:`);

    for (const threshold of [0.03, 0.05, 0.10]) {
      console.log(`\n  Threshold: ${(threshold * 100).toFixed(0)}% spread`);
      analyzeReturns(spreads, threshold);
    }

    // Distribution of spreads
    console.log(`\n📊 Spread Distribution:`);
    const buckets = {
      'negative (OKX > HL)': spreads.filter(s => s.spread < -0.01).length,
      '0-3%': spreads.filter(s => s.spread >= -0.01 && s.spread < 0.03).length,
      '3-5%': spreads.filter(s => s.spread >= 0.03 && s.spread < 0.05).length,
      '5-10%': spreads.filter(s => s.spread >= 0.05 && s.spread < 0.10).length,
      '10%+': spreads.filter(s => s.spread >= 0.10).length,
    };

    for (const [bucket, count] of Object.entries(buckets)) {
      const pct = (count / spreads.length * 100).toFixed(0);
      const bar = '█'.repeat(Math.round(count / spreads.length * 30));
      console.log(`  ${bucket.padEnd(20)} ${count.toString().padStart(3)} (${pct.padStart(2)}%) ${bar}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('Analysis complete');
}

main().catch(console.error);
