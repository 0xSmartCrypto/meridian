/**
 * Meridian - Data Fetching Module
 *
 * Fetches funding rate data from:
 * - Hyperliquid: Historical hourly funding rates
 * - Boros: Current implied vs underlying APR
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Types
interface HyperliquidFundingRecord {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

interface BorosMarket {
  marketId: number;
  imData: { name: string };
  metadata: { platformName: string; assetSymbol: string };
  data: {
    markApr: number;
    floatingApr: number;
    ammImpliedApr: number;
    volume24h: number;
    notionalOI: number;
  };
}

// Config
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const BOROS_API = 'https://api.boros.finance/core/v1';
const DATA_DIR = join(process.cwd(), 'data');

// Coins to track
const COINS = ['HYPE', 'BTC', 'ETH'];

/**
 * Fetch funding history from Hyperliquid (single page)
 */
async function fetchHyperliquidFundingPage(
  coin: string,
  startTime: number,
  endTime?: number
): Promise<HyperliquidFundingRecord[]> {
  const body: Record<string, unknown> = {
    type: 'fundingHistory',
    coin,
    startTime,
  };
  if (endTime) body.endTime = endTime;

  const res = await fetch(HYPERLIQUID_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  return res.json();
}

/**
 * Fetch all funding history with pagination
 */
async function fetchHyperliquidFunding(
  coin: string,
  startTime: number
): Promise<HyperliquidFundingRecord[]> {
  const allRecords: HyperliquidFundingRecord[] = [];
  let currentStart = startTime;
  const now = Date.now();

  while (currentStart < now) {
    const page = await fetchHyperliquidFundingPage(coin, currentStart);

    if (page.length === 0) break;

    allRecords.push(...page);

    // Get the last timestamp and add 1ms to avoid duplicates
    const lastTime = page[page.length - 1].time;
    currentStart = lastTime + 1;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));

    // Log progress
    process.stdout.write(`\r  Fetched ${allRecords.length} records...`);

    // If we got less than 500, we've reached the end
    if (page.length < 500) break;
  }

  console.log(''); // New line after progress
  return allRecords;
}

/**
 * Fetch all Hyperliquid markets from Boros
 */
async function fetchBorosMarkets(): Promise<BorosMarket[]> {
  const res = await fetch(`${BOROS_API}/markets`);
  if (!res.ok) throw new Error(`Boros API error: ${res.status}`);
  const data = await res.json();

  // Filter for Hyperliquid markets
  return data.results.filter(
    (m: BorosMarket) => m.metadata.platformName === 'Hyperliquid'
  );
}

/**
 * Convert hourly funding rate to APR
 * fundingRate is per-hour, so APR = rate * 24 * 365
 */
function fundingRateToApr(rate: string): number {
  return parseFloat(rate) * 24 * 365;
}

/**
 * Main data fetching routine
 */
async function main() {
  console.log('Meridian - Data Fetch\n');

  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // 1. Fetch current Boros state
  console.log('Fetching Boros markets...');
  const borosMarkets = await fetchBorosMarkets();

  console.log('\nHyperliquid Markets on Boros:');
  console.log('─'.repeat(70));
  console.log(
    'Market'.padEnd(25),
    'Implied APR'.padEnd(15),
    'Floating APR'.padEnd(15),
    'Spread'
  );
  console.log('─'.repeat(70));

  for (const market of borosMarkets) {
    const implied = (market.data.ammImpliedApr * 100).toFixed(2);
    const floating = (market.data.floatingApr * 100).toFixed(2);
    const spread = ((market.data.ammImpliedApr - market.data.floatingApr) * 100).toFixed(2);

    console.log(
      market.imData.name.slice(0, 24).padEnd(25),
      `${implied}%`.padEnd(15),
      `${floating}%`.padEnd(15),
      `${spread}%`
    );
  }

  // Save Boros snapshot
  writeFileSync(
    join(DATA_DIR, 'boros-snapshot.json'),
    JSON.stringify({ timestamp: Date.now(), markets: borosMarkets }, null, 2)
  );

  // 2. Fetch historical funding from Hyperliquid
  console.log('\n\nFetching Hyperliquid funding history...');

  // Start from 90 days ago (or as far back as available)
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  for (const coin of COINS) {
    console.log(`\nFetching ${coin}...`);

    try {
      const history = await fetchHyperliquidFunding(coin, ninetyDaysAgo);

      if (history.length === 0) {
        console.log(`  No data for ${coin}`);
        continue;
      }

      // Convert to APR and calculate stats
      const aprs = history.map(h => fundingRateToApr(h.fundingRate));
      const mean = aprs.reduce((a, b) => a + b, 0) / aprs.length;
      const sortedAprs = [...aprs].sort((a, b) => a - b);
      const median = sortedAprs[Math.floor(sortedAprs.length / 2)];
      const min = Math.min(...aprs);
      const max = Math.max(...aprs);
      const stdDev = Math.sqrt(
        aprs.reduce((sum, apr) => sum + Math.pow(apr - mean, 2), 0) / aprs.length
      );

      console.log(`  Records: ${history.length}`);
      console.log(`  Mean APR: ${(mean * 100).toFixed(2)}%`);
      console.log(`  Median APR: ${(median * 100).toFixed(2)}%`);
      console.log(`  Min APR: ${(min * 100).toFixed(2)}%`);
      console.log(`  Max APR: ${(max * 100).toFixed(2)}%`);
      console.log(`  Std Dev: ${(stdDev * 100).toFixed(2)}%`);

      // Save to file
      const enrichedHistory = history.map(h => ({
        ...h,
        apr: fundingRateToApr(h.fundingRate),
        timestamp: new Date(h.time).toISOString(),
      }));

      writeFileSync(
        join(DATA_DIR, `funding-${coin.toLowerCase()}.json`),
        JSON.stringify({
          coin,
          fetchedAt: new Date().toISOString(),
          stats: { mean, median, min, max, stdDev, count: history.length },
          history: enrichedHistory,
        }, null, 2)
      );

    } catch (err) {
      console.log(`  Error fetching ${coin}: ${err}`);
    }
  }

  console.log('\n\nData saved to ./data/');
  console.log('─'.repeat(70));
  console.log('Files:');
  console.log('  - boros-snapshot.json (current Boros state)');
  for (const coin of COINS) {
    console.log(`  - funding-${coin.toLowerCase()}.json (30-day funding history)`);
  }
}

main().catch(console.error);
