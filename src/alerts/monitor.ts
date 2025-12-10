/**
 * Meridian - Rate Monitor
 *
 * Monitors funding rates and sends alerts based on configured strategy:
 * - mean_reversion: Alert when z-score crosses threshold
 * - spread_harvest: Alert when implied-underlying spread is large
 * - both: Alert on either condition
 *
 * Run with: pnpm run alerts (single check) or pnpm run alerts:watch (continuous)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, validateConfig, getZThreshold, getMinSpread, type AlertConfig } from './config.js';
import { sendAlert, type TradeAlert, type AlertType } from './notifiers.js';
import { onAlert as onPaperAlert } from '../paper/hook.js';

const DATA_DIR = join(process.cwd(), 'data');
const STATE_FILE = join(DATA_DIR, 'alert-state.json');
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const BOROS_API = 'https://api.boros.finance/core/v1';

// Minimum hours between alerts for same coin/direction/strategy
const ALERT_COOLDOWN_HOURS = 4;

interface FundingData {
  coin: string;
  stats: {
    mean: number;
    stdDev: number;
  };
  history: Array<{ apr: number; time: number }>;
}

interface AlertState {
  lastAlerts: Record<string, number>; // "HYPE_LONG_mean_reversion" -> timestamp
}

interface BorosMarket {
  marketId: number;
  imData: { name: string };
  metadata: { platformName: string; assetSymbol: string };
  data: {
    markApr: number;
    floatingApr: number;
    ammImpliedApr: number;
  };
}

function loadState(): AlertState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { lastAlerts: {} };
}

function saveState(state: AlertState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isOnCooldown(state: AlertState, coin: string, direction: string, strategy: string): boolean {
  const key = `${coin}_${direction}_${strategy}`;
  const lastAlert = state.lastAlerts[key];
  if (!lastAlert) return false;
  const hoursSince = (Date.now() - lastAlert) / (1000 * 60 * 60);
  return hoursSince < ALERT_COOLDOWN_HOURS;
}

function markAlertSent(state: AlertState, coin: string, direction: string, strategy: string): void {
  const key = `${coin}_${direction}_${strategy}`;
  state.lastAlerts[key] = Date.now();
}

async function fetchCurrentFunding(coin: string): Promise<number | null> {
  try {
    const res = await fetch(HYPERLIQUID_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin,
        startTime: Date.now() - 2 * 60 * 60 * 1000,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.length === 0) return null;
    const latest = data[data.length - 1];
    return parseFloat(latest.fundingRate) * 24 * 365;
  } catch {
    return null;
  }
}

async function fetchBorosImplied(coin: string): Promise<number | null> {
  try {
    const res = await fetch(`${BOROS_API}/markets`);
    if (!res.ok) return null;
    const data = await res.json();
    const market = data.results.find(
      (m: BorosMarket) =>
        m.metadata.platformName === 'Hyperliquid' &&
        m.metadata.assetSymbol.toUpperCase() === coin.toUpperCase()
    );
    return market?.data.ammImpliedApr ?? null;
  } catch {
    return null;
  }
}

function loadHistoricalStats(coin: string): { mean: number; stdDev: number } | null {
  try {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    const data: FundingData = JSON.parse(readFileSync(filePath, 'utf-8'));
    return { mean: data.stats.mean, stdDev: data.stats.stdDev };
  } catch {
    return null;
  }
}

function calculateImplied(coin: string, premium: number = 0.03): number | null {
  try {
    const filePath = join(DATA_DIR, `funding-${coin.toLowerCase()}.json`);
    const data: FundingData = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Use recent 7-day average + premium as implied
    const recent = data.history.slice(-168);
    if (recent.length === 0) return null;
    const mean = recent.reduce((s, h) => s + h.apr, 0) / recent.length;
    return mean + premium;
  } catch {
    return null;
  }
}

function zScore(value: number, mean: number, stdDev: number): number {
  return stdDev > 0 ? (value - mean) / stdDev : 0;
}

async function checkMeanReversion(
  config: AlertConfig,
  coin: string,
  currentApr: number,
  state: AlertState
): Promise<void> {
  const stats = loadHistoricalStats(coin);
  if (!stats) {
    console.log(`  [Mean Rev] No historical data for ${coin}`);
    return;
  }

  const z = zScore(currentApr, stats.mean, stats.stdDev);
  const threshold = getZThreshold(config, coin);

  console.log(`  [Mean Rev] Z-Score: ${z.toFixed(2)}σ (threshold: ±${threshold}σ)`);

  let direction: 'LONG' | 'SHORT' | null = null;
  if (z > threshold) {
    direction = 'SHORT';
    console.log(`    🔴 SHORT SIGNAL: Funding ${z.toFixed(2)}σ above mean`);
  } else if (z < -threshold) {
    direction = 'LONG';
    console.log(`    🟢 LONG SIGNAL: Funding ${z.toFixed(2)}σ below mean`);
  } else {
    console.log(`    ⚪ No signal`);
    return;
  }

  if (isOnCooldown(state, coin, direction, 'mean_reversion')) {
    console.log(`    ⏸️  On cooldown`);
    return;
  }

  const impliedApr = await fetchBorosImplied(coin);

  const alert: TradeAlert = {
    type: 'mean_reversion',
    coin,
    direction,
    currentApr,
    impliedApr: impliedApr ?? currentApr,
    zScore: z,
    meanApr: stats.mean,
    stdDev: stats.stdDev,
    spread: 0,
    holdDays: config.holdDays,
    timestamp: new Date(),
  };

  await sendAlert(config, alert);
  await onPaperAlert(alert);
  markAlertSent(state, coin, direction, 'mean_reversion');
}

async function checkSpreadHarvest(
  config: AlertConfig,
  coin: string,
  currentApr: number,
  state: AlertState
): Promise<void> {
  const impliedApr = await fetchBorosImplied(coin);

  // Validate implied APR - reject if 0 or null (bad data from API)
  if (impliedApr === null || impliedApr === 0) {
    // Fall back to calculated implied
    const calcImplied = calculateImplied(coin);
    if (calcImplied === null) {
      console.log(`  [Spread] No valid implied data for ${coin} (API returned: ${impliedApr})`);
      return;
    }
  }

  // Use API value only if valid (non-zero), otherwise fall back to calculated
  const implied = (impliedApr && impliedApr !== 0) ? impliedApr : (calculateImplied(coin) ?? currentApr);
  const spread = implied - currentApr;
  const minSpread = getMinSpread(config, coin);

  // Sanity check: reject spreads that are unrealistically large (likely bad data)
  const MAX_REALISTIC_SPREAD = 0.15; // 15% spread is extremely high, anything above is suspicious
  if (Math.abs(spread) > MAX_REALISTIC_SPREAD) {
    console.log(`  [Spread] ⚠️  REJECTED: Spread ${(spread * 100).toFixed(2)}% exceeds sanity threshold (±15%)`);
    console.log(`           Implied: ${(implied * 100).toFixed(2)}%, Underlying: ${(currentApr * 100).toFixed(2)}%`);
    console.log(`           This is likely bad data from the API.`);
    return;
  }

  console.log(`  [Spread] Implied: ${(implied * 100).toFixed(2)}%, Underlying: ${(currentApr * 100).toFixed(2)}%, Spread: ${(spread * 100).toFixed(2)}%`);
  console.log(`           Threshold: ±${(minSpread * 100).toFixed(0)}%`);

  let direction: 'LONG' | 'SHORT' | null = null;
  if (spread >= minSpread) {
    direction = 'SHORT';
    console.log(`    🔴 SHORT SIGNAL: Implied >> Underlying (${(spread * 100).toFixed(1)}% spread)`);
  } else if (spread <= -minSpread) {
    direction = 'LONG';
    console.log(`    🟢 LONG SIGNAL: Implied << Underlying (${(spread * 100).toFixed(1)}% spread)`);
  } else {
    console.log(`    ⚪ No signal`);
    return;
  }

  if (isOnCooldown(state, coin, direction, 'spread_harvest')) {
    console.log(`    ⏸️  On cooldown`);
    return;
  }

  const stats = loadHistoricalStats(coin);

  const alert: TradeAlert = {
    type: 'spread_harvest',
    coin,
    direction,
    currentApr,
    impliedApr: implied,
    zScore: stats ? zScore(currentApr, stats.mean, stats.stdDev) : 0,
    meanApr: stats?.mean ?? currentApr,
    stdDev: stats?.stdDev ?? 0,
    spread,
    holdDays: config.spreadHoldDays,
    timestamp: new Date(),
  };

  await sendAlert(config, alert);
  await onPaperAlert(alert);
  markAlertSent(state, coin, direction, 'spread_harvest');
}

async function runCheck(config: AlertConfig): Promise<void> {
  console.log('\n' + '─'.repeat(60));
  console.log(`Meridian Monitor - ${new Date().toISOString()}`);
  console.log(`Strategy: ${config.strategy.toUpperCase()}`);
  console.log('─'.repeat(60));

  const state = loadState();

  for (const coin of config.coins) {
    console.log(`\n📊 ${coin}`);

    const currentApr = await fetchCurrentFunding(coin);
    if (currentApr === null) {
      console.log(`  ❌ Could not fetch current funding`);
      continue;
    }

    console.log(`  Current APR: ${(currentApr * 100).toFixed(2)}%`);

    // Check mean reversion
    if (config.strategy === 'mean_reversion' || config.strategy === 'both') {
      await checkMeanReversion(config, coin, currentApr, state);
    }

    // Check spread harvest
    if (config.strategy === 'spread_harvest' || config.strategy === 'both') {
      await checkSpreadHarvest(config, coin, currentApr, state);
    }
  }

  saveState(state);

  console.log('\n' + '─'.repeat(60));
  console.log('Check complete');
  console.log('─'.repeat(60));
}

async function main() {
  console.log('Meridian - Rate Monitor\n');

  const config = loadConfig();
  const validation = validateConfig(config);

  if (!validation.valid) {
    console.error('Configuration errors:');
    validation.errors.forEach(e => console.error(`  - ${e}`));
    console.error('\nPlease check your .env file');
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Strategy:      ${config.strategy}`);
  console.log(`  Coins:         ${config.coins.join(', ')}`);
  console.log(`  Telegram:      ${config.telegramChatId ? 'Configured' : 'Not configured'}`);
  console.log(`  Email:         ${config.emailTo ? 'Configured' : 'Not configured'}`);

  // Show per-coin thresholds
  console.log('  Thresholds:');
  for (const coin of config.coins) {
    const z = getZThreshold(config, coin);
    const spread = getMinSpread(config, coin);
    console.log(`    ${coin.padEnd(5)} Z: ${z}σ, Spread: ${(spread * 100).toFixed(0)}%`);
  }
  console.log(`  Hold:          Mean Rev ${config.holdDays}d, Spread ${config.spreadHoldDays}d`);

  const continuous = process.argv.includes('--continuous') || process.argv.includes('-c');
  const intervalMinutes = parseInt(process.env.ALERT_INTERVAL_MINUTES || '60');

  if (continuous) {
    console.log(`\nRunning in continuous mode (checking every ${intervalMinutes} minutes)`);
    console.log('Press Ctrl+C to stop\n');

    await runCheck(config);
    setInterval(async () => {
      await runCheck(config);
    }, intervalMinutes * 60 * 1000);
  } else {
    await runCheck(config);
  }
}

main().catch(err => {
  console.error('Monitor error:', err);
  process.exit(1);
});
