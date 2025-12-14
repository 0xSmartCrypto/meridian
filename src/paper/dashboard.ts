/**
 * Meridian Paper Trading - Dashboard
 *
 * Displays all paper trading metrics in a clear, organized format.
 *
 * Usage:
 *   pnpm run paper:dashboard
 *
 * Sections:
 *   1. ACCOUNT SUMMARY     - Current equity, drawdown, open positions
 *   2. OPEN POSITIONS      - Details of each active trade
 *   3. PRIMARY METRICS     - Win rate, Sharpe, etc. (check daily)
 *   4. SECONDARY METRICS   - Behavior patterns (check weekly)
 *   5. META METRICS        - Edge decay, correlation (check monthly)
 *   6. RECENT TRADES       - Last 10 closed trades
 */

import 'dotenv/config';
import {
  loadTrades,
  loadState,
  getOpenTrades,
  getClosedTrades,
  updateUnrealizedPnl,
} from './tracker.js';
import { calculateDashboardMetrics, loadSnapshots } from './metrics.js';
import type { PaperTrade, PaperState } from './types.js';
import { fetchCurrentBorosApr } from '../data/boros.js';

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

const LINE = '─'.repeat(70);
const DOUBLE_LINE = '═'.repeat(70);

function formatPercent(value: number, decimals = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

function colorize(value: number, text: string): string {
  // ANSI colors: green for positive, red for negative
  if (value > 0) return `\x1b[32m${text}\x1b[0m`; // Green
  if (value < 0) return `\x1b[31m${text}\x1b[0m`; // Red
  return text;
}

function statusEmoji(trend: 'improving' | 'stable' | 'declining'): string {
  if (trend === 'improving') return '📈';
  if (trend === 'declining') return '📉';
  return '➡️ ';
}

// ============================================================================
// SECTION RENDERERS
// ============================================================================

function renderHeader(): void {
  console.log('\n' + DOUBLE_LINE);
  console.log('  MERIDIAN PAPER TRADING DASHBOARD');
  console.log('  ' + new Date().toISOString());
  console.log(DOUBLE_LINE);
}

function renderAccountSummary(state: PaperState): void {
  console.log('\n📊 ACCOUNT SUMMARY');
  console.log(LINE);

  const pnl = state.currentEquity - state.startingCapital;
  const pnlPercent = (pnl / state.startingCapital) * 100;
  const drawdown = ((state.peakEquity - state.currentEquity) / state.peakEquity) * 100;

  console.log(`  Starting Capital:    $${state.startingCapital.toFixed(2)}`);
  console.log(`  Current Equity:      $${state.currentEquity.toFixed(2)} ${colorize(pnl, `(${formatUsd(pnl)}, ${formatPercent(pnlPercent)})`)}`);
  console.log(`  Peak Equity:         $${state.peakEquity.toFixed(2)}`);
  console.log(`  Current Drawdown:    ${colorize(-drawdown, formatPercent(-drawdown))}`);
  console.log(`  Open Positions:      ${state.openPositions.length}`);
  console.log(`  Last Updated:        ${formatDate(state.lastUpdated)}`);
}

function renderOpenPositions(trades: PaperTrade[], state: PaperState): void {
  const openTrades = getOpenTrades(trades, state);

  console.log('\n📈 OPEN POSITIONS (Trail 30% Strategy)');
  console.log(LINE);

  if (openTrades.length === 0) {
    console.log('  No open positions');
    return;
  }

  // Header row 1
  console.log(
    '  ' +
    padRight('COIN', 6) +
    padRight('DIR', 6) +
    padRight('SIZE', 10) +
    padRight('UNREAL P&L', 14) +
    padRight('PEAK P&L', 12) +
    padRight('DD FROM PEAK', 14) +
    'EXIT'
  );
  console.log('  ' + '-'.repeat(68));

  for (const trade of openTrades) {
    const daysToExit = Math.max(0,
      (new Date(trade.scheduledExitTime).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    // Handle legacy trades without trailing stop fields
    const peakPnl = trade.peakUnrealizedPnl ?? Math.max(0, trade.unrealizedPnl);

    // Calculate drawdown from peak
    const drawdownFromPeak = peakPnl > 0
      ? ((peakPnl - trade.unrealizedPnl) / peakPnl) * 100
      : 0;

    // Trailing stop threshold (default 30%)
    const trailThreshold = (trade.trailingStopPct ?? 0.30) * 100;

    // Color coding: red if approaching trailing stop
    const ddText = `${drawdownFromPeak.toFixed(0)}% / ${trailThreshold.toFixed(0)}%`;
    const ddColor = drawdownFromPeak >= trailThreshold * 0.8 ? -1 : 0; // Yellow-ish warning

    // Exit info: either "Xd" for time-based or "TRAIL" if trailing stop close
    const exitInfo = drawdownFromPeak >= trailThreshold
      ? '\x1b[31mTRAIL!\x1b[0m'
      : `${daysToExit.toFixed(1)}d`;

    console.log(
      '  ' +
      padRight(trade.coin, 6) +
      padRight(trade.direction, 6) +
      padRight(`$${trade.notionalSize}`, 10) +
      padRight(colorize(trade.unrealizedPnl, formatUsd(trade.unrealizedPnl)), 24) +
      padRight(formatUsd(peakPnl), 12) +
      padRight(colorize(ddColor, ddText), 24) +
      exitInfo
    );
  }

  // Legend
  console.log('\n  Legend: DD FROM PEAK = current / threshold (30% = trailing stop trigger)');
}

function renderPrimaryMetrics(metrics: ReturnType<typeof calculateDashboardMetrics>): void {
  const { primary } = metrics;

  console.log('\n📊 PRIMARY METRICS (Check Daily)');
  console.log(LINE);
  console.log('  These are your core performance indicators.\n');

  // Win Rate
  const winRateTarget = primary.winRate >= 70 ? '✅' : '⚠️ ';
  console.log(`  WIN RATE                 ${primary.winRate.toFixed(1)}%  ${winRateTarget}`);
  console.log(`    What: Percentage of trades that made money`);
  console.log(`    Target: >70% (you have ${primary.wins}W / ${primary.losses}L)`);
  console.log();

  // Avg Win/Loss Ratio
  const ratioTarget = primary.avgWinLossRatio >= 2 ? '✅' : '⚠️ ';
  console.log(`  AVG WIN/LOSS RATIO       ${primary.avgWinLossRatio.toFixed(2)}x  ${ratioTarget}`);
  console.log(`    What: Average profit on wins vs average loss on losses`);
  console.log(`    Target: >2.0x (profitable even at 40% win rate)`);
  console.log();

  // Sharpe Ratio
  const sharpeTarget = primary.sharpeRatio >= 1.5 ? '✅' : '⚠️ ';
  console.log(`  SHARPE RATIO             ${primary.sharpeRatio.toFixed(2)}  ${sharpeTarget}`);
  console.log(`    What: Risk-adjusted returns (return per unit of volatility)`);
  console.log(`    Target: >1.5 (quality over quantity)`);
  console.log();

  // Max Drawdown
  const ddTarget = primary.maxDrawdown <= 15 ? '✅' : '⚠️ ';
  console.log(`  MAX DRAWDOWN             ${primary.maxDrawdown.toFixed(1)}%  ${ddTarget}`);
  console.log(`    What: Largest peak-to-trough equity decline`);
  console.log(`    Target: <15% (circuit breaker at this level)`);
  console.log();

  // P&L Summary
  console.log(`  REALIZED P&L             ${colorize(primary.totalRealizedPnl, formatUsd(primary.totalRealizedPnl))}`);
  console.log(`  UNREALIZED P&L           ${colorize(primary.totalUnrealizedPnl, formatUsd(primary.totalUnrealizedPnl))}`);
  console.log(`  TOTAL TRADES             ${primary.totalTrades}`);
}

function renderSecondaryMetrics(metrics: ReturnType<typeof calculateDashboardMetrics>): void {
  const { secondary } = metrics;

  console.log('\n📈 SECONDARY METRICS (Check Weekly)');
  console.log(LINE);
  console.log('  Behavior patterns and drift detection.\n');

  // Signal-to-Trade Ratio
  console.log(`  SIGNAL-TO-TRADE RATIO    ${(secondary.signalToTradeRatio * 100).toFixed(0)}%`);
  console.log(`    What: How many alerts resulted in trades`);
  console.log(`    Alerts received: ${secondary.alertsReceived}, Trades entered: ${Math.round(secondary.alertsReceived * secondary.signalToTradeRatio)}`);
  console.log();

  // Average Hold Duration
  const holdTarget = secondary.avgHoldDuration >= 6 ? '✅' : '⚠️ ';
  console.log(`  AVG HOLD DURATION        ${secondary.avgHoldDuration.toFixed(1)} days  ${holdTarget}`);
  console.log(`    What: How long you actually held positions`);
  console.log(`    Target: 7-14 days (per backtest findings)`);
  console.log();

  // P&L by Asset
  console.log(`  P&L BY ASSET:`);
  for (const [coin, data] of Object.entries(secondary.pnlByAsset)) {
    const pnlColor = colorize(data.pnl, formatUsd(data.pnl));
    console.log(`    ${padRight(coin, 6)} ${padLeft(pnlColor, 20)}  (${data.trades} trades, ${data.winRate.toFixed(0)}% WR)`);
  }
  console.log();

  // P&L by Strategy
  console.log(`  P&L BY STRATEGY:`);
  for (const [strategy, data] of Object.entries(secondary.pnlByStrategy)) {
    const pnlColor = colorize(data.pnl, formatUsd(data.pnl));
    console.log(`    ${padRight(strategy, 16)} ${padLeft(pnlColor, 12)}  (${data.trades} trades, ${data.winRate.toFixed(0)}% WR)`);
  }
  console.log();

  // Average Exit Z-Score
  console.log(`  AVG EXIT Z-SCORE         ${secondary.avgExitZScore.toFixed(2)}σ`);
  console.log(`    What: Where funding ended up when you closed`);
  console.log(`    Ideal: Closer to 0 than entry (validates mean reversion)`);
}

function renderMetaMetrics(metrics: ReturnType<typeof calculateDashboardMetrics>): void {
  const { meta } = metrics;

  console.log('\n🔮 META METRICS (Check Monthly)');
  console.log(LINE);
  console.log('  Long-term viability indicators.\n');

  // Edge Decay
  console.log(`  EDGE DECAY:`);
  console.log(`    Win Rate Trend:        ${statusEmoji(meta.edgeDecay.winRateTrend)} ${meta.edgeDecay.winRateTrend}`);
  console.log(`    Last 30d Win Rate:     ${meta.edgeDecay.last30DaysWinRate.toFixed(1)}%`);
  console.log(`    Prev 30d Win Rate:     ${meta.edgeDecay.previous30DaysWinRate.toFixed(1)}%`);
  console.log(`    Sharpe Trend:          ${statusEmoji(meta.edgeDecay.sharpeTrend)} ${meta.edgeDecay.sharpeTrend}`);
  console.log();

  // Other Meta Metrics
  console.log(`  BTC CORRELATION          ${meta.btcCorrelation.toFixed(2)}`);
  console.log(`    What: Does P&L just follow BTC price?`);
  console.log(`    Target: <0.3 (strategy should be market-neutral)`);
  console.log();

  console.log(`  AVG SLIPPAGE             ${(meta.avgSlippage * 100).toFixed(2)}%`);
  console.log(`    What: Gap between alert rate and entry rate`);
  console.log();

  console.log(`  DAYS ACTIVE              ${meta.daysActive}`);
  console.log(`  TOTAL CAPITAL DEPLOYED   $${meta.totalCapitalDeployed.toFixed(2)}`);
  console.log(`  CAPITAL EFFICIENCY       ${(meta.capitalEfficiency * 100).toFixed(2)}%`);
  console.log(`    What: Total P&L / Total capital deployed`);
}

function renderRecentTrades(trades: PaperTrade[]): void {
  const closedTrades = getClosedTrades(trades)
    .filter(t => t.exitTime)
    .sort((a, b) => new Date(b.exitTime!).getTime() - new Date(a.exitTime!).getTime())
    .slice(0, 10);

  console.log('\n📜 RECENT TRADES (Last 10)');
  console.log(LINE);

  if (closedTrades.length === 0) {
    console.log('  No closed trades yet');
    return;
  }

  // Header
  console.log(
    '  ' +
    padRight('DATE', 14) +
    padRight('COIN', 6) +
    padRight('DIR', 6) +
    padRight('HOLD', 6) +
    padRight('ENTRY Z', 9) +
    padRight('EXIT Z', 9) +
    padRight('P&L', 12) +
    'EXIT'
  );
  console.log('  ' + '-'.repeat(68));

  for (const trade of closedTrades) {
    const holdDays = trade.exitTime
      ? (new Date(trade.exitTime).getTime() - new Date(trade.entryTime).getTime()) / (1000 * 60 * 60 * 24)
      : 0;

    const pnl = trade.realizedPnl ?? 0;
    const result = pnl > 0 ? '✅' : '❌';

    console.log(
      '  ' +
      padRight(formatDate(trade.exitTime!), 14) +
      padRight(trade.coin, 6) +
      padRight(trade.direction, 6) +
      padRight(`${holdDays.toFixed(1)}d`, 6) +
      padRight(`${trade.entryZScore.toFixed(2)}σ`, 9) +
      padRight(`${(trade.exitZScore ?? 0).toFixed(2)}σ`, 9) +
      padRight(colorize(pnl, formatUsd(pnl)), 22) + // Extra space for ANSI codes
      (trade.exitReason ?? '-')
    );
  }
}

function renderEquityCurve(): void {
  const snapshots = loadSnapshots();

  console.log('\n📉 EQUITY CURVE (Last 14 days)');
  console.log(LINE);

  if (snapshots.length === 0) {
    console.log('  No snapshots yet (run paper:snapshot daily to build history)');
    return;
  }

  const recent = snapshots.slice(-14);

  // Header
  console.log(
    '  ' +
    padRight('DATE', 12) +
    padRight('EQUITY', 12) +
    padRight('DAILY P&L', 12) +
    padRight('OPEN', 6) +
    'WIN RATE'
  );
  console.log('  ' + '-'.repeat(50));

  for (const snap of recent) {
    console.log(
      '  ' +
      padRight(snap.date, 12) +
      padRight(`$${snap.equity.toFixed(0)}`, 12) +
      padRight(colorize(snap.dailyPnl, formatUsd(snap.dailyPnl)), 22) +
      padRight(`${snap.openPositions}`, 6) +
      `${snap.rolling7dWinRate.toFixed(0)}%`
    );
  }
}

function renderFooter(): void {
  console.log('\n' + DOUBLE_LINE);
  console.log('  Commands:');
  console.log('    pnpm run paper:status     - View open positions');
  console.log('    pnpm run paper:close      - Manually close a position');
  console.log('    pnpm run paper:snapshot   - Capture daily snapshot');
  console.log('    pnpm run paper:export     - Export all data to CSV');
  console.log(DOUBLE_LINE + '\n');
}

// ============================================================================
// MAIN
// ============================================================================

export async function runDashboard(): Promise<void> {
  const trades = loadTrades();
  const state = loadState();

  // Update unrealized P&L for all open positions before rendering
  if (state.openPositions.length > 0) {
    console.log('Updating unrealized P&L for open positions...');
    await updateUnrealizedPnl(trades, state, fetchCurrentBorosApr);
  }

  const metrics = calculateDashboardMetrics();

  renderHeader();
  renderAccountSummary(state);
  renderOpenPositions(trades, state);
  renderPrimaryMetrics(metrics);
  renderSecondaryMetrics(metrics);
  renderMetaMetrics(metrics);
  renderRecentTrades(trades);
  renderEquityCurve();
  renderFooter();
}

// Run if called directly
runDashboard().catch(console.error);
