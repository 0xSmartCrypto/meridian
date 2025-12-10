/**
 * Meridian Paper Trading Module
 *
 * Simulates trades without real capital to validate strategy performance.
 *
 * Files:
 *   types.ts     - Type definitions for all data structures
 *   tracker.ts   - Trade lifecycle (open/update/close)
 *   metrics.ts   - Performance calculations (Primary/Secondary/Meta)
 *   dashboard.ts - Visual display of all metrics
 *   cli.ts       - Command-line interface
 *   hook.ts      - Integration with alert system
 *
 * Data files (in data/):
 *   paper-trades.json     - All trade records
 *   paper-state.json      - Current equity and open positions
 *   paper-snapshots.json  - Daily snapshots for trend analysis
 *   paper-alerts-log.json - All alerts received (for signal-to-trade ratio)
 */

export * from './types.js';
export * from './tracker.js';
export * from './metrics.js';
export { onAlert } from './hook.js';
