const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const { CATEGORIES, CATEGORY_GROUPS, suggestCategory } = require('./categories');

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const WORKER_URL = process.env.WORKER_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// Keep-alive endpoint for Render
app.get('/', (req, res) => res.send('PFAS Bot is running'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- In-memory pending transactions ---
// Key: messageId, Value: transaction object
const pending = {};

// --- SMS Parser ---
function parseSMS(text) {
  const txn = {
    raw_text: text,
    source: 'UNKNOWN',
    type: 'OTHER',
    amount: 0,
    currency: 'KES',
    merchant: '',
    reference: '',
    fee: 0,
    balance_after: 0,
    date: '',
    time: '',
    confidence: 0
  };

  // M-PESA SEND
  let m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(.+?)\s+\d{10}/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'SEND';
    txn.reference = m[1];
    txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim();
    txn.confidence = 95;
  }

  // M-PESA RECEIVE
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.You have received\s+Ksh([\d,]+\.\d+)\s+from\s+(.+?)\s+on/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'RECEIVE';
    txn.reference = m[1];
    txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim();
    txn.confidence = 95;
  }

  // M-PESA PAYBILL
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(.+?)\s+for account/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'BILL_PAYMENT';
    txn.reference = m[1];
    txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim();
    txn.confidence = 92;
  }

  // LOOP Paybill
  m = text.match(/M-PESA Paybill Successful:KES\.([\d,]+\.?\d*)\s+to\s+\d+\s+-\s+(.+?)\s+-/i);
  if (m) {
    txn.source = 'LOOP'; txn.type = 'BILL_PAYMENT';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = m[2].trim();
    txn.confidence = 90;
  }

  // LOOP Card spend
  m = text.match(/Online transaction of (USD|KES)\.([\d,]+\.?\d*)\s+has been approved.*?at\s+(.+?)\s+on/i);
  if (m) {
    txn.source = 'LOOP'; txn.type = 'CARD_SPEND';
    txn.currency = m[1];
    txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim();
    txn.confidence = 92;
  }

  // ABSA Card spend
  m = text.match(/transaction of KES ([\d,]+\.?\d*)\s+has been made on your Absa card.*?at\s+(.+?)\.\s+Your/i);
  if (m) {
    txn.source = 'ABSA'; txn.type = 'CARD_SPEND';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = m[2].trim();
    txn.confidence = 92;
  }

  // ABSA Card payment received
  m = text.match(/Absa confirms receipt of payment.*?of KES ([\d,]+\.?\d*)/i);
  if (m) {
    txn.source = 'ABSA'; txn.type = 'CARD_PAYMENT';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = 'Absa Card Payment';
    txn.confidence = 88;
  }

  // Extract date/time
  const dateM = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (dateM) txn.date = dateM[1];
  const dateM2 = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateM2 && !txn.date) txn.date = dateM2[1];
  const timeM = text.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (timeM) txn.time = timeM[1];
  const timeM2 = text.match(/at\s+(\d{1,2}:\d{2}:\d{2})/i);
  if (timeM2 && !txn.time) txn.time = timeM2[1];

  // Extract fee
  const feeM = text.match(/Transaction cost[,\s]+Ksh([\d,]+\.\d+)/i);
  if (feeM) txn.fee = parseFloat(feeM[1].replace(/,/g, ''));
  const feeM2 = text.match(/Fee:\s*KES\.([\d,]+\.?\d*)/i);
  if (feeM2) txn.fee = parseFloat(feeM2[1].replace(/,/g, ''));

  // Extract balance
  const balM = text.match(/New M-PESA balance is Ksh([\d,]+\.\d+)/i);
  if (balM) txn.balance_after = parseFloat(balM[1].replace(/,/g, ''));
  const balM2 = text.match(/available balance to spend is ([\d,]+\.?\d*)/i);
  if (balM2) txn.balance_after = parseFloat(balM2[1].replace(/,/g, ''));

  // Suggest category
  txn.suggested_category = suggestCategory(txn.merchant + ' ' + txn.raw_text);

  return txn;
}

// --- Format transaction card ---
function formatCard(txn, splits) {
  const src = { MPESA: '📱', LOOP: '💳', ABSA: '🏦', UNKNOWN: '❓' }[txn.source] || '❓';
  const typeLabel = {
    SEND: '→ Send', RECEIVE: '← Receive', CARD_SPEND: '💸 Card Spend',
    BILL_PAYMENT: '📄 Bill Payment', CARD_PAYMENT: '✅ Card Payment', OTHER: 'Other'
  }[txn.type] || txn.type;

  let text = `${src} *NEW TRANSACTION*\n\n`;
  text += `📅 ${txn.date || 'Unknown date'}  🕐 ${txn.time || 'Unknown time'}\n`;
  text += `🏦 ${txn.source} — ${typeLabel}\n`;
  text += `👤 ${txn.merchant || 'Unknown'}\n`;
  text += `💰 ${txn.currency} ${Number(txn.amount).toLocaleString()}`;
  if (txn.fee > 0) text += `  |  Fee: ${Number(txn.fee).toLocaleString()}`;
  text += '\n\n';

  if (splits && splits.length > 0) {
    text += `*Split:*\n`;
    splits.forEach((s, i) => {
      text += `  ${i + 1}. ${txn.currency} ${Number(s.amount).toLocaleString()} — ${s.category}\n`;
    });
    const splitTotal = splits.reduce((sum, s) => sum + s.amount, 0);
    const remaining = txn.amount - splitTotal;
    if (remaining > 0) text += `  ⚠️ Unallocated: ${txn.currency} ${Number(remaining).toLocaleString()}\n`;
    text += '\n';
  } else {
    text += `📂 Category: *${txn.suggested_category}*\n\n`;
  }

  text += `_Confidence: ${txn.confidence}%_`;
  return text;
}

// --- Build category keyboard ---
function buildCategoryKeyboard(txnId) {
  const groups = Object.keys(CATEGORY_GROUPS);
  const keyboard = groups.map(group => [{
    text: group,
    callback_data: `grp:${txnId}:${group}`
  }]);
  keyboard.push([{ text: '↩️ Back to transaction', callback_data: `back:${txnId}` }]);
  return { inline_keyboard: keyboard };
}

function buildGroupKeyboard(txnId, group) {
  const items = CATEGORY_GROUPS[group] || [];
  const keyboard = items.map(item => [{
    text: item.label,
    callback_data: `cat:${txnId}:${item.full}`
  }]);
  keyboard.push([{ text: '↩️ Back to groups', callback_data: `cats:${txnId}` }]);
  return { inline_keyboard: keyboard };
}

function buildMainKeyboard(txnId, hasSplits) {
  const keyboard = [
    [
      { text: '✅ Confirm', callback_data: `confirm:${txnId}` },
      { text: '📂 Category', callback_data: `cats:${txnId}` }
    ],
    [
      { text: '✂️ Split', callback_data: `split:${txnId}` },
      { text: '🗑️ Skip', callback_data: `skip:${txnId}` }
    ]
  ];
  return { inline_keyboard: keyboard };
}

// --- Save to Google Sheet ---
async function saveToSheet(txn, splits) {
  const ts = new Date().toISOString();
  let rows = [];

  if (splits && splits.length > 0) {
    splits.forEach((s, i) => {
      rows.push([
        `TXN-${Date.now()}-${i}`,
        txn.date, txn.time, txn.source, txn.type,
        s.amount, txn.currency, txn.merchant,
        txn.reference, i === 0 ? txn.fee : 0,
        i === 0 ? txn.balance_after : 0,
        s.category, s.notes || '', txn.confidence,
        i === 0 ? txn.raw_text.substring(0, 500) : `[Split ${i + 1} of ${splits.length}]`,
        ts
      ]);
    });
  } else {
    rows.push([
      `TXN-${Date.now()}-0`,
      txn.date, txn.time, txn.source, txn.type,
      txn.amount, txn.currency, txn.merchant,
      txn.reference, txn.fee, txn.balance_after,
      txn.suggested_category, '', txn.confidence,
      txn.raw_text.substring(0, 500), ts
    ]);
  }

  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'append', rows })
  });
  return await res.json();
}

// --- Handle incoming messages ---
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const text = msg.text || '';

  // /start command
  if (text === '/start') {
    return bot.sendMessage(CHAT_ID,
      '👋 *PFAS Bot ready.*\n\nSend or forward any M-PESA, Loop, or Absa SMS and I\'ll parse it for you.',
      { parse_mode: 'Markdown' }
    );
  }

  // /pending command
  if (text === '/pending') {
    const count = Object.keys(pending).length;
    return bot.sendMessage(CHAT_ID,
      count > 0
        ? `⏳ You have *${count}* unconfirmed transaction(s). Scroll up to review.`
        : '✅ No pending transactions.',
      { parse_mode: 'Markdown' }
    );
  }

  // Try to parse as SMS
  const txn = parseSMS(text);
  if (txn.confidence === 0) {
    return bot.sendMessage(CHAT_ID,
      '⚠️ Could not parse this as a transaction. Forward an M-PESA, Loop, or Absa SMS.',
      { parse_mode: 'Markdown' }
    );
  }

  // Send transaction card
  const txnId = `${Date.now()}`;
  pending[txnId] = { txn, splits: [] };

  await bot.sendMessage(CHAT_ID, formatCard(txn, []), {
    parse_mode: 'Markdown',
    reply_markup: buildMainKeyboard(txnId, false)
  });
});

// --- Handle button presses ---
bot.on('callback_query', async (query) => {
  const data = query.data;
  const msgId = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  const [action, txnId, ...rest] = data.split(':');
  const entry = pending[txnId];
  if (!entry && action !== 'back') return;

  // CONFIRM
  if (action === 'confirm') {
    try {
      const result = await saveToSheet(entry.txn, entry.splits);
      delete pending[txnId];
      await bot.editMessageText(
        `✅ *Saved!*\n\n${formatCard(entry.txn, entry.splits.length ? entry.splits : null)}`,
        { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown' }
      );
    } catch(e) {
      await bot.sendMessage(CHAT_ID, `❌ Save failed: ${e.message}`);
    }
  }

  // SKIP
  else if (action === 'skip') {
    delete pending[txnId];
    await bot.editMessageText(
      `🗑️ *Skipped.*`,
      { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown' }
    );
  }

  // SHOW CATEGORY GROUPS
  else if (action === 'cats') {
    await bot.editMessageReplyMarkup(
      buildCategoryKeyboard(txnId),
      { chat_id: CHAT_ID, message_id: msgId }
    );
  }

  // SHOW CATEGORIES IN GROUP
  else if (action === 'grp') {
    const group = rest.join(':');
    await bot.editMessageReplyMarkup(
      buildGroupKeyboard(txnId, group),
      { chat_id: CHAT_ID, message_id: msgId }
    );
  }

  // SET CATEGORY
  else if (action === 'cat') {
    const category = rest.join(':');
    entry.txn.suggested_category = category;
    await bot.editMessageText(
      formatCard(entry.txn, entry.splits),
      { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: buildMainKeyboard(txnId, entry.splits.length > 0) }
    );
  }

  // SPLIT
  else if (action === 'split') {
    await bot.sendMessage(CHAT_ID,
      `✂️ *Split transaction: ${entry.txn.currency} ${Number(entry.txn.amount).toLocaleString()}*\n\n` +
      `Send each split line as:\n` +
      `\`amount | category\`\n\n` +
      `Example:\n` +
      `\`1200 | Food & Dining:Groceries\`\n` +
      `\`800 | Health:Pharmacy\`\n` +
      `\`200 | Home:Household Items\`\n\n` +
      `When done, send \`/done ${txnId}\``,
      { parse_mode: 'Markdown' }
    );
    entry.splitting = true;
  }

  // BACK TO MAIN
  else if (action === 'back') {
    if (!entry) return;
    await bot.editMessageReplyMarkup(
      buildMainKeyboard(txnId, entry.splits.length > 0),
      { chat_id: CHAT_ID, message_id: msgId }
    );
  }
});

// --- Handle split line entry ---
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const text = msg.text || '';

  // /done <txnId>
  const doneM = text.match(/^\/done\s+(\d+)$/);
  if (doneM) {
    const txnId = doneM[1];
    const entry = pending[txnId];
    if (!entry) return bot.sendMessage(CHAT_ID, '⚠️ Transaction not found.');
    entry.splitting = false;
    const splitTotal = entry.splits.reduce((sum, s) => sum + s.amount, 0);
    const remaining = entry.txn.amount - splitTotal;
    await bot.sendMessage(CHAT_ID,
      `✂️ *Split summary:*\n${formatCard(entry.txn, entry.splits)}\n\n` +
      (remaining > 0 ? `⚠️ Still unallocated: ${entry.txn.currency} ${Number(remaining).toLocaleString()}\n\n` : '') +
      `Tap Confirm to save or keep adding lines.`,
      { parse_mode: 'Markdown', reply_markup: buildMainKeyboard(txnId, true) }
    );
    return;
  }

  // Split line: amount | category
  const splitEntry = Object.entries(pending).find(([, e]) => e.splitting);
  if (splitEntry) {
    const [txnId, entry] = splitEntry;
    const parts = text.split('|').map(p => p.trim());
    if (parts.length >= 2) {
      const amount = parseFloat(parts[0].replace(/,/g, ''));
      const category = parts[1];
      if (!isNaN(amount) && amount > 0) {
        entry.splits.push({ amount, category, notes: parts[2] || '' });
        const splitTotal = entry.splits.reduce((sum, s) => sum + s.amount, 0);
        const remaining = entry.txn.amount - splitTotal;
        await bot.sendMessage(CHAT_ID,
          `✅ Added: ${entry.txn.currency} ${Number(amount).toLocaleString()} → ${category}\n` +
          `Remaining: ${entry.txn.currency} ${Number(remaining).toLocaleString()}\n\n` +
          `Add another line or send \`/done ${txnId}\``,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }
    await bot.sendMessage(CHAT_ID, '⚠️ Format: `amount | category`\nExample: `1200 | Food & Dining:Groceries`', { parse_mode: 'Markdown' });
  }
});

// --- Daily 7am EAT nudge (UTC+3 = 4am UTC) ---
cron.schedule('0 4 * * *', async () => {
  const count = Object.keys(pending).length;
  if (count > 0) {
    await bot.sendMessage(CHAT_ID,
      `☀️ *Good morning!*\n\nYou have *${count}* unconfirmed transaction(s) from yesterday.\n\nSend /pending to review.`,
      { parse_mode: 'Markdown' }
    );
  }
});

console.log('PFAS Bot started.');
