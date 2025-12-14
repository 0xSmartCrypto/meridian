/**
 * Meridian - Boros API Helpers
 *
 * Functions for fetching current market data from Boros API.
 */

const BOROS_API = 'https://api.boros.finance/core/v1';

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

/**
 * Fetch all markets from Boros
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
 * Fetch current floating APR for a specific coin from Boros
 *
 * Returns the current funding APR (floating rate) for the given coin.
 * Returns null if the market is not found.
 *
 * @param coin - Coin symbol (e.g., "HYPE", "BTC", "ETH")
 */
export async function fetchCurrentBorosApr(coin: string): Promise<number | null> {
  try {
    const markets = await fetchBorosMarkets();

    // Find the market for this coin
    const market = markets.find(m =>
      m.metadata.assetSymbol.toUpperCase() === coin.toUpperCase()
    );

    if (!market) {
      console.warn(`Market not found for ${coin}`);
      return null;
    }

    // Return the floating APR (current funding rate)
    return market.data.floatingApr;
  } catch (err) {
    console.error(`Error fetching Boros APR for ${coin}:`, err);
    return null;
  }
}

/**
 * Fetch current funding APR from Hyperliquid API (fallback)
 *
 * @param coin - Coin symbol (e.g., "HYPE", "BTC", "ETH")
 */
export async function fetchCurrentHyperliquidApr(coin: string): Promise<number | null> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin: coin.toUpperCase(),
        startTime: Date.now() - 2 * 60 * 60 * 1000, // Last 2 hours
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data || data.length === 0) return null;

    // Get most recent funding rate and convert to APR
    const latest = data[data.length - 1];
    const fundingRate = parseFloat(latest.fundingRate);
    const apr = fundingRate * 24 * 365; // Convert hourly rate to APR

    return apr;
  } catch (err) {
    console.error(`Error fetching Hyperliquid APR for ${coin}:`, err);
    return null;
  }
}
