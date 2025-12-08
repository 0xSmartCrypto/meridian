/**
 * Meridian - Alert Configuration
 */

export type AlertStrategy = 'mean_reversion' | 'spread_harvest' | 'both';

export interface CoinConfig {
  zThreshold: number;
  minSpread: number;
}

export interface AlertConfig {
  // Strategy selection
  strategy: AlertStrategy;

  // Default thresholds (used if no per-coin config)
  defaultZThreshold: number;
  defaultMinSpread: number;

  // Per-coin thresholds
  coinConfig: Record<string, CoinConfig>;

  // Hold periods
  holdDays: number;
  spreadHoldDays: number;

  // General
  coins: string[];

  // Email (Resend)
  resendApiKey: string | null;
  emailTo: string | null;

  // Telegram (FREE)
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

/**
 * Get threshold for a specific coin
 */
export function getZThreshold(config: AlertConfig, coin: string): number {
  return config.coinConfig[coin.toUpperCase()]?.zThreshold ?? config.defaultZThreshold;
}

export function getMinSpread(config: AlertConfig, coin: string): number {
  return config.coinConfig[coin.toUpperCase()]?.minSpread ?? config.defaultMinSpread;
}

/**
 * Parse per-coin config from env
 * Format: ALERT_Z_THRESHOLD_HYPE=2.5, ALERT_Z_THRESHOLD_BTC=2.2
 */
function parseCoinConfig(coins: string[], defaultZ: number, defaultSpread: number): Record<string, CoinConfig> {
  const config: Record<string, CoinConfig> = {};

  for (const coin of coins) {
    const upperCoin = coin.toUpperCase();
    const zEnv = process.env[`ALERT_Z_THRESHOLD_${upperCoin}`];
    const spreadEnv = process.env[`ALERT_MIN_SPREAD_${upperCoin}`];

    config[upperCoin] = {
      zThreshold: zEnv ? parseFloat(zEnv) : defaultZ,
      minSpread: spreadEnv ? parseFloat(spreadEnv) : defaultSpread,
    };
  }

  return config;
}

export function loadConfig(): AlertConfig {
  const strategyRaw = process.env.ALERT_STRATEGY || 'both';
  let strategy: AlertStrategy = 'both';
  if (strategyRaw === 'mean_reversion' || strategyRaw === 'spread_harvest') {
    strategy = strategyRaw;
  }

  const coins = (process.env.ALERT_COINS || 'HYPE,BTC,ETH').split(',').map(c => c.trim());
  const defaultZThreshold = parseFloat(process.env.ALERT_Z_THRESHOLD || '2.5');
  const defaultMinSpread = parseFloat(process.env.ALERT_MIN_SPREAD || '0.05');

  return {
    strategy,

    // Defaults
    defaultZThreshold,
    defaultMinSpread,

    // Per-coin config
    coinConfig: parseCoinConfig(coins, defaultZThreshold, defaultMinSpread),

    // Hold periods
    holdDays: parseInt(process.env.ALERT_HOLD_DAYS || '7'),
    spreadHoldDays: parseInt(process.env.ALERT_SPREAD_HOLD_DAYS || '14'),

    // General
    coins,

    resendApiKey: process.env.RESEND_API_KEY || null,
    emailTo: process.env.ALERT_EMAIL_TO || null,

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
  };
}

export function validateConfig(config: AlertConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const hasEmail = config.resendApiKey && config.emailTo;
  const hasTelegram = config.telegramBotToken && config.telegramChatId;

  if (!hasEmail && !hasTelegram) {
    errors.push('At least one notification method required (email or Telegram)');
  }

  // Validate per-coin thresholds
  for (const coin of config.coins) {
    const z = getZThreshold(config, coin);
    const spread = getMinSpread(config, coin);

    if (z < 1.5 || z > 4) {
      errors.push(`${coin}: Z threshold should be between 1.5 and 4 (got ${z})`);
    }

    if (spread < 0.01 || spread > 0.20) {
      errors.push(`${coin}: Min spread should be between 0.01 (1%) and 0.20 (20%) (got ${spread})`);
    }
  }

  if (config.coins.length === 0) {
    errors.push('At least one coin required');
  }

  return { valid: errors.length === 0, errors };
}
