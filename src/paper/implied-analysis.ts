/**
 * Implied Rate Analysis
 *
 * Compares actual Boros implied rates to our blend estimate
 * to validate the backtest assumptions.
 *
 * Key question: Is Boros implied rate closer to:
 * - Floating (optimistic for us)
 * - 7d MA (pessimistic, edge disappears)
 * - Blend 50/50 (our assumption)
 */

import { loadTrades, loadState, getClosedTrades, getOpenTrades } from './tracker.js';
import type { PaperTrade } from './types.js';

interface ImpliedAnalysis {
  trades: number;
  avgDelta: number;           // Avg (actual implied - blend estimate)
  avgAbsDelta: number;        // Avg |delta| - how far off we are
  closerToFloating: number;   // % of trades where implied closer to floating
  closerTo7dMA: number;       // % of trades where implied closer to 7dMA
  implications: string;       // What this means for our edge
}

function analyzeImpliedRates(trades: PaperTrade[]): ImpliedAnalysis | null {
  // Filter trades with implied rate logging data
  const validTrades = trades.filter(t =>
    t.entry7dMA !== undefined &&
    t.estimatedBlend5050 !== undefined &&
    t.impliedVsBlendDelta !== undefined
  );

  if (validTrades.length === 0) {
    return null;
  }

  let sumDelta = 0;
  let sumAbsDelta = 0;
  let closerToFloating = 0;
  let closerTo7dMA = 0;

  for (const trade of validTrades) {
    const delta = trade.impliedVsBlendDelta;
    sumDelta += delta;
    sumAbsDelta += Math.abs(delta);

    // Check if implied is closer to floating or 7dMA
    const distToFloating = Math.abs(trade.entryImpliedApr - trade.entryApr);
    const distTo7dMA = Math.abs(trade.entryImpliedApr - trade.entry7dMA);

    if (distToFloating < distTo7dMA) {
      closerToFloating++;
    } else {
      closerTo7dMA++;
    }
  }

  const avgDelta = sumDelta / validTrades.length;
  const avgAbsDelta = sumAbsDelta / validTrades.length;
  const pctCloserToFloating = (closerToFloating / validTrades.length) * 100;
  const pctCloserTo7dMA = (closerTo7dMA / validTrades.length) * 100;

  // Determine implications
  let implications: string;
  if (pctCloserToFloating > 60) {
    implications = 'BULLISH: Boros prices closer to floating → edge likely HIGHER than backtest';
  } else if (pctCloserTo7dMA > 60) {
    implications = 'BEARISH: Boros prices closer to 7dMA → edge likely LOWER than backtest';
  } else {
    implications = 'NEUTRAL: Boros prices near blend 50/50 → backtest estimate (~22% APY at 2x) likely accurate';
  }

  return {
    trades: validTrades.length,
    avgDelta,
    avgAbsDelta,
    closerToFloating: pctCloserToFloating,
    closerTo7dMA: pctCloserTo7dMA,
    implications,
  };
}

function printTradeDetails(trades: PaperTrade[]): void {
  const validTrades = trades.filter(t => t.entry7dMA !== undefined);

  if (validTrades.length === 0) {
    console.log('No trades with implied rate data yet.');
    return;
  }

  console.log('');
  console.log('TRADE-BY-TRADE IMPLIED RATE COMPARISON');
  console.log('─'.repeat(110));
  console.log(
    'Date'.padEnd(12) + ' | ' +
    'Coin'.padEnd(5) + ' | ' +
    'Dir'.padEnd(5) + ' | ' +
    'Floating'.padStart(9) + ' | ' +
    '7d MA'.padStart(9) + ' | ' +
    'Our Est'.padStart(9) + ' | ' +
    'Boros Impl'.padStart(11) + ' | ' +
    'Delta'.padStart(8) + ' | ' +
    'Closer To'
  );
  console.log('─'.repeat(110));

  for (const trade of validTrades) {
    const date = trade.entryTime.slice(0, 10);
    const floating = (trade.entryApr * 100).toFixed(1) + '%';
    const ma7d = (trade.entry7dMA * 100).toFixed(1) + '%';
    const estimate = (trade.estimatedBlend5050 * 100).toFixed(1) + '%';
    const actual = (trade.entryImpliedApr * 100).toFixed(1) + '%';
    const delta = (trade.impliedVsBlendDelta * 100).toFixed(2) + '%';

    const distToFloating = Math.abs(trade.entryImpliedApr - trade.entryApr);
    const distTo7dMA = Math.abs(trade.entryImpliedApr - trade.entry7dMA);
    const closerTo = distToFloating < distTo7dMA ? 'Floating ✅' : '7d MA ⚠️';

    console.log(
      date.padEnd(12) + ' | ' +
      trade.coin.padEnd(5) + ' | ' +
      trade.direction.padEnd(5) + ' | ' +
      floating.padStart(9) + ' | ' +
      ma7d.padStart(9) + ' | ' +
      estimate.padStart(9) + ' | ' +
      actual.padStart(11) + ' | ' +
      delta.padStart(8) + ' | ' +
      closerTo
    );
  }
  console.log('─'.repeat(110));
}

async function main() {
  console.log('');
  console.log('═'.repeat(80));
  console.log('  IMPLIED RATE ANALYSIS - VALIDATING BACKTEST ASSUMPTIONS');
  console.log('═'.repeat(80));
  console.log('');
  console.log('This report compares actual Boros implied rates to our blend estimate.');
  console.log('The backtest assumes implied ≈ blend 50/50 (floating + 7dMA) / 2');
  console.log('');

  const trades = loadTrades();
  const state = loadState();
  const allTrades = [...getClosedTrades(trades), ...getOpenTrades(trades, state)];

  const analysis = analyzeImpliedRates(allTrades);

  if (!analysis) {
    console.log('No trades with implied rate data yet.');
    console.log('New trades will automatically log this data.');
    console.log('');
    console.log('Run this report again after opening some trades to see the analysis.');
    return;
  }

  console.log('SUMMARY');
  console.log('─'.repeat(80));
  console.log(`Trades analyzed:        ${analysis.trades}`);
  console.log(`Avg delta:              ${(analysis.avgDelta * 100).toFixed(2)}% (+ = Boros higher than estimate)`);
  console.log(`Avg |delta|:            ${(analysis.avgAbsDelta * 100).toFixed(2)}% (how far off our estimate)`);
  console.log(`Closer to Floating:     ${analysis.closerToFloating.toFixed(0)}%`);
  console.log(`Closer to 7d MA:        ${analysis.closerTo7dMA.toFixed(0)}%`);
  console.log('');
  console.log('IMPLICATION:');
  console.log(`  ${analysis.implications}`);

  printTradeDetails(allTrades);

  console.log('');
  console.log('═'.repeat(80));
  console.log('  HOW TO INTERPRET');
  console.log('═'.repeat(80));
  console.log(`
  If "Closer to Floating" > 60%:
    → Boros implied ≈ floating rate (optimistic scenario)
    → Expected APY at 2x: ~45% (vs our 41% estimate)
    → Edge is BETTER than backtest suggested

  If "Closer to 7d MA" > 60%:
    → Boros implied ≈ 7d MA (pessimistic scenario)
    → Expected APY at 2x: ~0% or negative
    → Edge may NOT exist - reconsider strategy

  If roughly 50/50:
    → Boros pricing matches our blend assumption
    → Expected APY at 2x: ~41% (our estimate)
    → Proceed with confidence

  Need 5-10 trades minimum for reliable signal.
`);
}

main().catch(console.error);
