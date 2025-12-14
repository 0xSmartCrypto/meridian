/**
 * Meridian - Notification Senders
 */

import type { AlertConfig } from './config.js';

export type AlertType = 'mean_reversion' | 'spread_harvest';

export interface TradeAlert {
  type: AlertType;
  coin: string;
  direction: 'LONG' | 'SHORT';
  currentApr: number;
  impliedApr: number;
  zScore: number;
  meanApr: number;
  stdDev: number;
  spread: number;
  holdDays: number;
  timestamp: Date;
}

/**
 * Generate trade instructions for MEAN REVERSION strategy
 */
function generateMeanReversionInstructions(alert: TradeAlert): string {
  const { coin, direction, currentApr, zScore, meanApr, holdDays } = alert;

  const aprPercent = (currentApr * 100).toFixed(2);
  const meanPercent = (meanApr * 100).toFixed(2);

  const leverageGuide = Math.abs(zScore) >= 3 ? '2-3x' : Math.abs(zScore) >= 2.5 ? '1.5-2x' : '1x';
  const directionEmoji = direction === 'LONG' ? '🟢' : '🔴';

  return `
${directionEmoji} MEAN REVERSION ALERT: ${direction} ${coin}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRATEGY: MEAN REVERSION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Funding is ${Math.abs(zScore).toFixed(1)}σ ${zScore > 0 ? 'ABOVE' : 'BELOW'} mean.
Historical data shows ${direction === 'SHORT' ? 'high' : 'low'} funding reverts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARKET DATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current Funding APR: ${aprPercent}%
Historical Mean:     ${meanPercent}%
Z-Score:             ${zScore.toFixed(2)}σ

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRADE INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Direction:   ${direction}
Exit:        TRAIL 30% (or max ${holdDays}d)
Leverage:    ${leverageGuide}
Size:        10-20% of allocated capital

${direction === 'SHORT' ? `
WHY SHORT:
• Funding is elevated (${aprPercent}% vs ${meanPercent}% mean)
• You RECEIVE fixed rate, PAY floating rate
• Profit when funding drops toward mean
` : `
WHY LONG:
• Funding is depressed (${aprPercent}% vs ${meanPercent}% mean)
• You PAY fixed rate, RECEIVE floating rate
• Profit when funding rises toward mean
`}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXECUTION ON BOROS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Go to https://boros.pendle.finance
2. Connect wallet
3. Select ${coin} market (Hyperliquid)
4. Click "${direction}" tab
5. Set leverage to ${leverageGuide}
6. Enter position size
7. Review the fixed rate you'll ${direction === 'SHORT' ? 'RECEIVE' : 'PAY'}
8. Confirm transaction

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXIT STRATEGY: TRAIL 30%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Exit when EITHER:
• P&L drops 30% from peak (after 12h)
• OR max ${holdDays} days reached

Let winners run, cut giving-back trades.
Monitor: pnpm run paper:monitor

Time: ${alert.timestamp.toISOString()}
`.trim();
}

/**
 * Generate trade instructions for SPREAD HARVEST strategy
 */
function generateSpreadHarvestInstructions(alert: TradeAlert): string {
  const { coin, direction, currentApr, impliedApr, spread, holdDays } = alert;

  const currentPercent = (currentApr * 100).toFixed(2);
  const impliedPercent = (impliedApr * 100).toFixed(2);
  const spreadPercent = (spread * 100).toFixed(2);

  const directionEmoji = direction === 'LONG' ? '🟢' : '🔴';

  return `
${directionEmoji} SPREAD HARVEST ALERT: ${direction} ${coin}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRATEGY: SPREAD HARVEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Implied APR diverges from underlying.
Harvest the spread by holding to expiry.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARKET DATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Underlying APR: ${currentPercent}%
Implied APR:    ${impliedPercent}%
Spread:         ${spreadPercent}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRADE INSTRUCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Direction:   ${direction}
Hold Period: ${holdDays} DAYS (HOLD TO EXPIRY)
Leverage:    1-2x (conservative)
Size:        10-20% of allocated capital

${direction === 'SHORT' ? `
WHY SHORT:
• Implied (${impliedPercent}%) is ABOVE Underlying (${currentPercent}%)
• You RECEIVE high fixed rate
• You PAY lower floating rate
• Profit = spread earned over holding period
` : `
WHY LONG:
• Implied (${impliedPercent}%) is BELOW Underlying (${currentPercent}%)
• You PAY low fixed rate
• You RECEIVE higher floating rate
• Profit = spread earned over holding period
`}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPECTED PROFIT CALCULATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Spread: ${spreadPercent}%
Hold:   ${holdDays} days
Size:   $10,000 example

Est. Profit = ${spreadPercent}% × $10k × (${holdDays}/365)
            = $${((Math.abs(spread) * 10000 * holdDays) / 365).toFixed(2)}

(Before fees. Actual may vary.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXECUTION ON BOROS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Go to https://boros.pendle.finance
2. Connect wallet
3. Select ${coin} market (Hyperliquid)
4. Click "${direction}" tab
5. Set leverage (1-2x recommended)
6. Enter position size
7. VERIFY the fixed rate matches ~${impliedPercent}%
8. Confirm transaction

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL: HOLD TO EXPIRY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This strategy REQUIRES holding.
Early exit = forfeit spread profit.

Set calendar reminder: ${holdDays} days from now.

Time: ${alert.timestamp.toISOString()}
`.trim();
}

/**
 * Generate trade instructions based on alert type
 */
export function generateTradeInstructions(alert: TradeAlert): string {
  if (alert.type === 'mean_reversion') {
    return generateMeanReversionInstructions(alert);
  } else {
    return generateSpreadHarvestInstructions(alert);
  }
}

/**
 * Send email via Resend
 */
export async function sendEmail(
  config: AlertConfig,
  subject: string,
  body: string
): Promise<boolean> {
  if (!config.resendApiKey || !config.emailTo) {
    console.log('Email not configured, skipping...');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Meridian Alerts <alerts@resend.dev>',
        to: config.emailTo,
        subject,
        text: body,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
      return false;
    }

    console.log('Email sent successfully');
    return true;
  } catch (err) {
    console.error('Email send failed:', err);
    return false;
  }
}

/**
 * Send Telegram message (FREE)
 */
export async function sendTelegram(
  config: AlertConfig,
  message: string
): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log('Telegram not configured, skipping...');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Telegram error:', err);
      return false;
    }

    console.log('Telegram sent successfully');
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err);
    return false;
  }
}

/**
 * Send alert via all configured channels
 */
export async function sendAlert(config: AlertConfig, alert: TradeAlert): Promise<void> {
  const instructions = generateTradeInstructions(alert);
  const strategyName = alert.type === 'mean_reversion' ? 'Mean Rev' : 'Spread';
  const subject = `[${strategyName}] ${alert.direction} ${alert.coin}`;

  console.log('\n' + '='.repeat(50));
  console.log('SENDING ALERT');
  console.log('='.repeat(50));
  console.log(instructions);
  console.log('='.repeat(50));

  await Promise.all([
    sendEmail(config, subject, instructions),
    sendTelegram(config, instructions),
  ]);
}

/**
 * Exit notification data
 */
export interface ExitNotification {
  coin: string;
  direction: 'LONG' | 'SHORT';
  exitReason: 'TRAILING_STOP' | 'TIME_BASED' | 'STOP_LOSS' | 'MANUAL';
  entryApr: number;
  exitApr: number;
  holdHours: number;
  peakPnl: number;
  realizedPnl: number;
  drawdownFromPeak?: number;
}

/**
 * Generate exit notification message
 */
function generateExitMessage(exit: ExitNotification): string {
  const { coin, direction, exitReason, holdHours, peakPnl, realizedPnl, drawdownFromPeak } = exit;

  const holdDays = (holdHours / 24).toFixed(1);
  const pnlSign = realizedPnl >= 0 ? '+' : '';
  const resultEmoji = realizedPnl >= 0 ? '✅' : '❌';

  const reasonText = {
    'TRAILING_STOP': `TRAIL 30% (DD: ${(drawdownFromPeak ?? 0).toFixed(0)}% from peak)`,
    'TIME_BASED': 'Max hold period reached',
    'STOP_LOSS': 'Stop loss hit',
    'MANUAL': 'Manual exit',
  }[exitReason];

  return `
${resultEmoji} POSITION CLOSED: ${coin} ${direction}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXIT REASON: ${exitReason}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${reasonText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Realized P&L:  ${pnlSign}$${realizedPnl.toFixed(2)}
Peak P&L:      $${peakPnl.toFixed(2)}
Hold Duration: ${holdDays} days (${holdHours.toFixed(0)}h)

Time: ${new Date().toISOString()}
`.trim();
}

/**
 * Send exit notification via Telegram
 */
export async function sendExitNotification(config: AlertConfig, exit: ExitNotification): Promise<void> {
  const message = generateExitMessage(exit);

  console.log('\n' + '='.repeat(50));
  console.log('SENDING EXIT NOTIFICATION');
  console.log('='.repeat(50));
  console.log(message);
  console.log('='.repeat(50));

  await sendTelegram(config, message);
}
