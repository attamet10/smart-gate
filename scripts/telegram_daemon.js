const https = require('https');
const path = require('path');
const tg = require('../telegram');
const db = require('../db');

console.log('====================================================');
console.log('🤖 OnePass Telegram Bot Autonomous 24/7 Daemon');
console.log('====================================================');

async function run() {
  const config = await tg.getTelegramConfig();
  if (!config.botToken) {
    console.error('❌ Missing bot token! Retrying in 5s...');
    setTimeout(run, 5000);
    return;
  }

  // Delete any webhook so getUpdates polling can receive all incoming messages directly
  https.get(`https://api.telegram.org/bot${config.botToken}/deleteWebhook?drop_pending_updates=false`, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      console.log('✅ Webhook cleared. Polling loop activated.');
      poll(config.botToken, 0);
    });
  }).on('error', (err) => {
    console.error('Webhook clear error:', err.message);
    setTimeout(run, 3000);
  });
}

function fetchUpdates(token, offset) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok && Array.isArray(json.result)) {
            resolve(json.result);
          } else {
            resolve([]);
          }
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(25000, () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function poll(token, initialOffset) {
  let offset = initialOffset;
  console.log('🚀 Telegram Bot is now actively listening and auto-responding in real-time...');

  while (true) {
    try {
      const updates = await fetchUpdates(token, offset);
      if (updates && updates.length > 0) {
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);

          if (update.message) {
            const sender = update.message.from ? (update.message.from.first_name || 'User') : 'User';
            console.log(`[Auto-Reply] Incoming from ${sender} (${update.message.chat.id}): "${update.message.text || ''}"`);
            // Non-blocking auto response
            tg.handleTelegramMessage(update.message).catch(err => {
              console.error('[Message Handler Error]:', err.message);
            });
          } else if (update.callback_query) {
            console.log(`[Auto-Reply] Button Callback: ${update.callback_query.data}`);
            tg.handleTelegramCallbackQuery(update.callback_query).catch(err => {
              console.error('[Callback Handler Error]:', err.message);
            });
          }
        }
      }
    } catch (err) {
      console.error('[Polling Exception]:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

run().catch(err => {
  console.error('[Fatal Daemon Error]:', err);
});
