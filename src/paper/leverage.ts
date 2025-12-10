/**
 * Meridian Paper Trading - Leverage Strategies
 *
 * Calculates optimal leverage based on configured strategy:
 * - fixed: Static leverage for all trades
 * - signal_strength: Higher leverage on stronger signals (2-6x)
 * - profit_stack: Adjust leverage based on equity growth
 * - combined: Both signal strength + profit stacking (recommended)
 */

export type LeverageStrategy = 'fixed' | 'signal_strength' | 'profit_stack' | 'combined';

export interface LeverageConfig {
  strategy: LeverageStrategy;
  fixedLeverage: number;
  maxLeverage: number;
}

/**
 * Load leverage config from environment
 */
export function loadLeverageConfig(): LeverageConfig {
  const strategy = (process.env.PAPER_LEVERAGE_STRATEGY || 'fixed') as LeverageStrategy;
  const validStrategies: LeverageStrategy[] = ['fixed', 'signal_strength', 'profit_stack', 'combined'];

  return {
    strategy: validStrategies.includes(strategy) ? strategy : 'fixed',
    fixedLeverage: parseFloat(process.env.PAPER_FIXED_LEVERAGE || '1'),
    maxLeverage: parseFloat(process.env.PAPER_MAX_LEVERAGE || '6'),
  };
}

/**
 * Signal-strength leverage: bet bigger on stronger signals
 *
 * | Z-Score     | Leverage |
 * |-------------|----------|
 * | 2.0 - 2.5σ  | 2x       |
 * | 2.5 - 3.0σ  | 4x       |
 * | 3.0σ+       | 6x       |
 */
function signalStrengthLeverage(zScore: number): number {
  const absZ = Math.abs(zScore);
  if (absZ >= 3.0) return 6;
  if (absZ >= 2.5) return 4;
  if (absZ >= 2.0) return 2;
  return 1;
}

/**
 * Profit-stack leverage: use winnings to bet bigger, reduce when losing
 *
 * | Equity vs Start | Multiplier |
 * |-----------------|------------|
 * | Up 20%+         | 1.5x       |
 * | Up 10%+         | 1.25x      |
 * | Down 10%+       | 0.5x       |
 */
function profitStackMultiplier(currentEquity: number, startingEquity: number): number {
  const ratio = currentEquity / startingEquity;

  if (ratio >= 1.2) return 1.5;   // Up 20%+: aggressive
  if (ratio >= 1.1) return 1.25;  // Up 10%+: slightly aggressive
  if (ratio <= 0.9) return 0.5;   // Down 10%+: defensive
  return 1.0;                      // Normal
}

/**
 * Calculate leverage for a trade based on configured strategy
 */
export function calculateLeverage(
  config: LeverageConfig,
  zScore: number,
  currentEquity: number,
  startingEquity: number
): number {
  let leverage: number;

  switch (config.strategy) {
    case 'fixed':
      leverage = config.fixedLeverage;
      break;

    case 'signal_strength':
      leverage = signalStrengthLeverage(zScore);
      break;

    case 'profit_stack':
      // Base leverage of 2x, adjusted by profit
      leverage = 2 * profitStackMultiplier(currentEquity, startingEquity);
      break;

    case 'combined':
      // Signal strength as base, multiplied by profit factor
      const baseLeverage = signalStrengthLeverage(zScore);
      const multiplier = profitStackMultiplier(currentEquity, startingEquity);
      leverage = baseLeverage * multiplier;
      break;

    default:
      leverage = 1;
  }

  // Apply max cap
  leverage = Math.min(leverage, config.maxLeverage);

  // Never go below 1x
  leverage = Math.max(leverage, 1);

  return leverage;
}

/**
 * Get human-readable description of leverage calculation
 */
export function describeLeverage(
  config: LeverageConfig,
  zScore: number,
  currentEquity: number,
  startingEquity: number
): string {
  const leverage = calculateLeverage(config, zScore, currentEquity, startingEquity);
  const absZ = Math.abs(zScore);
  const profitRatio = ((currentEquity / startingEquity) - 1) * 100;

  switch (config.strategy) {
    case 'fixed':
      return `${leverage}x (fixed)`;

    case 'signal_strength':
      return `${leverage}x (${absZ.toFixed(1)}σ signal)`;

    case 'profit_stack':
      return `${leverage}x (${profitRatio >= 0 ? '+' : ''}${profitRatio.toFixed(1)}% equity)`;

    case 'combined':
      return `${leverage}x (${absZ.toFixed(1)}σ + ${profitRatio >= 0 ? '+' : ''}${profitRatio.toFixed(1)}% equity)`;

    default:
      return `${leverage}x`;
  }
}
