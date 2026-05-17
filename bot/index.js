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

// Prevent crash on network blips and Telegram API timeouts
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

app.get('/', (req, res) => res.send('PFAS Bot is running'));

// Webhook endpoint for MacroDroid SMS forwarding
app.post('/sms', async (req, res) => {
  try {
    const smsText = req.body?.text || req.body?.sms || '';
    if (!smsText) {
      return res.status(400).json({ success: false, error: 'No SMS text provided' });
    }
    // Process the SMS as if it came from the Telegram chat
    await processIncomingSms(smsText);
    res.json({ success: true });
  } catch(e) {
    console.error('Webhook /sms error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Reusable SMS processor — called from both Telegram and webhook
async function processIncomingSms(text) {
  const txn = parseSMS(text);
  if (txn.confidence === -1) {
    return; // silently ignore (e.g. Standing Order scheduling notifications)
  }
  if (txn.confidence === 0) {
    return bot.sendMessage(CHAT_ID,
      '⚠️ Looks like an SMS but couldn\'t parse it. Send /start for help.',
      { parse_mode: 'Markdown' }
    );
  }
  const autoCategory = getAutoConfirm(txn.merchant, txn.raw_text);
  if (autoCategory) {
    txn.suggested_category = autoCategory;
    try {
      await saveToSheet(txn, []);
      const feeNote = txn.fee > 0 ? ` + fee KES ${txn.fee}` : '';
      return bot.sendMessage(CHAT_ID,
        `⚡ <b>Auto-logged</b>\n` +
        `${txn.source} ${txn.type} — ${txn.merchant}\n` +
        `💰 KES ${Number(txn.amount).toLocaleString()}${feeNote}\n` +
        `📂 ${autoCategory}`,
        { parse_mode: 'HTML' }
      );
    } catch(e) {
      return bot.sendMessage(CHAT_ID, `⚠️ Auto-log failed: ${e.message}. Sending for manual review.`);
    }
  }
  const txnId = `${Date.now()}`;
  pending[txnId] = { txn, splits: [], splitting: false };
  return bot.sendMessage(CHAT_ID, formatCard(txn, []), {
    parse_mode: 'Markdown', reply_markup: buildMainKeyboard(txnId)
  });
}
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const pending = {};

function feeCategory(source) {
  if (source === 'MPESA') return 'Fees & Charges:M-PESA Fee';
  if (source === 'LOOP') return 'Fees & Charges:Loop Fee';
  if (source === 'ABSA') return 'Fees & Charges:Bank Fee';
  return 'Fees & Charges:Bank Fee';
}

// --- Auto-confirm rules ---
const AUTO_CONFIRM_RULES = [
  { p: /kplc|kenya power|prepaid/i, c: 'Bills & Utilities:Electricity' },
  { p: /safaricom postpaid|postpaid bundles|airtime purchase|safaricom bundle/i, c: 'Bills & Utilities:Mobile Phone' },
  { p: /dstv|multichoice|zuku/i, c: 'Bills & Utilities:Pay TV' },
  { p: /atlas petroleum|total ruaka|shell karen|kenol|rubis|ola energy|astrol petroleum/i, c: 'Transport:Fuel' },
  { p: /naivas|carrefour|quickmart|quick mart|cleanshelf/i, c: 'Food & Dining:Groceries' },
  { p: /microsoft|office 365/i, c: 'Subscriptions:Software' },
  { p: /netflix|spotify|apple\.com\/bill|amazon kids/i, c: 'Entertainment:Streaming' },
  { p: /ziidi mmf|ziidi/i, c: 'Financial:Investment' },
  { p: /cytonn/i, c: 'Financial:Investment' },
  { p: /moja expressway|parkngo|parkingo|automatic park/i, c: 'Transport:Parking' },
  { p: /aar hospital|hospital ltd|kihara outpatient/i, c: 'Health:Doctor / Hospital' },
  { p: /pharmacy|chemist|goodlife/i, c: 'Health:Pharmacy' },
  { p: /loop c2b|714777/i, c: 'Transfers:Loop' },
  { p: /303030/i, c: 'Transfers:M-PESA to Bank' },
  { p: /od loan repayment|m-pesa overdraw|232323/i, c: 'Loan Payment:Fuliza' },
  { p: /m-shwari/i, c: 'Transfers:Savings' },
  { p: /lipa na kcb|kcb m-pesa deposit/i, c: 'Transfers:M-PESA to Bank' },
  { p: /equity paybill|equity bulk|247247/i, c: 'Transfers:Bank to M-PESA' },
  { p: /cooperative bank|co-operative bank|400200/i, c: 'Transfers:Bank to M-PESA' },
  { p: /grid link|pesapal.*sabi/i, c: 'Bills & Utilities:Internet' },
  { p: /e-citizen|222222/i, c: 'Tax:VAT' },
  { p: /meved dairy/i, c: 'Farm:Feed' },
  { p: /kirawa road|kindergarten/i, c: 'Education:School Fees' },
  { p: /marie stopes/i, c: 'Health:Doctor / Hospital' },
  { p: /airport lounge/i, c: 'Transport:Air Travel' },
];

// Returns category string if auto-confirm, null if needs manual confirmation
function getAutoConfirm(merchant, rawText) {
  // Check merchant name ONLY — not raw SMS text.
  // Raw SMS always contains promo footers like "Earn interest daily on Ziidi MMF"
  // which would wrongly auto-confirm every M-PESA send as Financial:Investment.
  for (const rule of AUTO_CONFIRM_RULES) {
    if (rule.p.test(merchant)) return rule.c;
  }
  return null;
}

function parseSMS(text) {
  const txn = {
    raw_text: text, source: 'UNKNOWN', type: 'OTHER',
    amount: 0, currency: 'KES', merchant: '', reference: '',
    fee: 0, balance_after: 0, date: '', time: '', confidence: 0
  };

  // Silently ignore Standing Order scheduling notifications (not transactions)
  if (/Standing Order.*has been scheduled to run/i.test(text)) {
    txn.confidence = -1; // signal to bot: ignore silently
    return txn;
  }

  // SEND to person (with phone number)
  let m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(.+?)\s+0\d{9}/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'SEND';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 95;
  }

  // SEND to paybill/merchant name (no phone number e.g. ZIIDI, KPLC)
  if (!m) {
    m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+([A-Z][A-Z0-9 ]+?)\s+on\s+\d/i);
    if (m) {
      txn.source = 'MPESA'; txn.type = 'BILL_PAYMENT';
      txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
      txn.merchant = m[3].trim(); txn.confidence = 92;
    }
  }

  // RECEIVE from person
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.You have received\s+Ksh([\d,]+\.\d+)\s+from\s+(.+?)\s+0\d[\d*]+\s+on/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'RECEIVE';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 95;
  }

  // RECEIVE from business/paybill (no phone). Allows hyphens/mixed case in merchant name.
  if (!m) {
    m = text.match(/([A-Z0-9]+)\s+Confirmed\.?\s*You have received\s+Ksh([\d,]+\.\d+)\s+from\s+(.+?)\s+on\s+\d/i);
    if (m) {
      txn.source = 'MPESA'; txn.type = 'RECEIVE';
      txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
      // Strip trailing paybill account numbers (5+ digits) from merchant name
      txn.merchant = m[3].trim().replace(/\s+\d{5,}$/, '').trim();
      txn.confidence = 90;
    }
  }

  // PAYBILL (for account)
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(.+?)\s+for account/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'BILL_PAYMENT';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 92;
  }

  // FULIZA loan drawdown notification
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Fuliza M-PESA amount is Ksh\s*([\d,]+\.\d+)/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'LOAN_DRAWDOWN';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'Fuliza M-PESA';
    const feeM = text.match(/Access Fee charged Ksh\s*([\d,]+\.\d+)/i);
    if (feeM) txn.fee = parseFloat(feeM[1].replace(/,/g, ''));
    txn.confidence = 95;
  }

  // FULIZA repayment
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh\s*([\d,]+\.\d+)\s+from your M-PESA has been used to.*?Fuliza/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'LOAN_REPAYMENT';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'Fuliza Repayment'; txn.confidence = 95;
  }

  // M-SHWARI withdraw (to M-PESA)
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.Ksh([\d,]+\.\d+)\s+transferred from M-Shwari/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'TRANSFER';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'M-Shwari'; txn.confidence = 95;
  }

  // KCB M-PESA transfer
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+transfer(?:r?ed)?\s+to\s+KCB M-PESA/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'TRANSFER';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'KCB M-PESA'; txn.confidence = 95;
  }

  // RATIBA / Standing Order: "Confirmed M-PESA Ratiba. Ksh X sent to NAME, PHONE, on DATE"
  m = text.match(/([A-Z0-9]+)\s+Confirmed M-PESA Ratiba\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(.+?),\s+[\d]/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'SEND';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 95;
  }

  // BUY GOODS / Till number: "Confirmed. Ksh X paid to MERCHANT NAME. on DATE"
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+paid to\s+(.+?)\.\s+on/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'CARD_SPEND';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 92;
  }

  // AGENT WITHDRAWAL: "Ksh X withdrawn from M-PESA at Agent Till XXXX - MERCHANT"
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+withdrawn.*?Agent.*?-\s+(.+?)\s+on/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'WITHDRAWAL';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 95;
  }

  // AIRTEL MONEY / Offnet: "Ksh X sent to AIRTEL MONEY for Mobile No."
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Ksh([\d,]+\.\d+)\s+sent to\s+(AIRTEL MONEY)\s+for/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'SEND';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'Airtel Money'; txn.confidence = 95;
  }

  // FULIZA LOAN NOTIFICATION: standalone "Fuliza M-PESA amount is Ksh X. Access Fee charged Ksh Y"
  m = text.match(/([A-Z0-9]+)\s+Confirmed\.\s+Fuliza M-PESA amount is Ksh\s*([\d,]+\.?\d*)/i);
  if (m) {
    txn.source = 'MPESA'; txn.type = 'LOAN_DRAWDOWN';
    txn.reference = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = 'Fuliza M-PESA';
    const accessFee = text.match(/Access Fee charged Ksh\s*([\d,]+\.?\d*)/i);
    if (accessFee) txn.fee = parseFloat(accessFee[1].replace(/,/g, ''));
    txn.confidence = 95;
  }

  m = text.match(/M-PESA Paybill Successful:KES\.([\d,]+\.?\d*)\s+to\s+\d+\s+-\s+(.+?)\s+-/i);
  if (m) {
    txn.source = 'LOOP'; txn.type = 'BILL_PAYMENT';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = m[2].trim(); txn.confidence = 90;
  }

  m = text.match(/Online transaction of (USD|KES)\.([\d,]+\.?\d*)\s+has been approved.*?at\s+(.+?)\s+on/i);
  if (m) {
    txn.source = 'LOOP'; txn.type = 'CARD_SPEND';
    txn.currency = m[1]; txn.amount = parseFloat(m[2].replace(/,/g, ''));
    txn.merchant = m[3].trim(); txn.confidence = 92;
  }

  m = text.match(/transaction of KES ([\d,]+\.?\d*)\s+has been made on your Absa card.*?at\s+(.+?)\.\s+Your/i);
  if (m) {
    txn.source = 'ABSA'; txn.type = 'CARD_SPEND';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = m[2].trim(); txn.confidence = 92;
  }

  m = text.match(/Absa confirms receipt of payment.*?of KES ([\d,]+\.?\d*)/i);
  if (m) {
    txn.source = 'ABSA'; txn.type = 'CARD_PAYMENT';
    txn.amount = parseFloat(m[1].replace(/,/g, ''));
    txn.merchant = 'Absa Card Payment'; txn.confidence = 88;
  }

  const dateM = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (dateM) txn.date = dateM[1];
  const dateM2 = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateM2 && !txn.date) txn.date = dateM2[1];
  const timeM = text.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (timeM) txn.time = timeM[1];
  const timeM2 = text.match(/at\s+(\d{1,2}:\d{2}:\d{2})/i);
  if (timeM2 && !txn.time) txn.time = timeM2[1];

  const feeM = text.match(/Transaction cost[,\s]+Ksh([\d,]+\.\d+)/i);
  if (feeM) txn.fee = parseFloat(feeM[1].replace(/,/g, ''));
  const feeM2 = text.match(/Fee:\s*KES\.([\d,]+\.?\d*)/i);
  if (feeM2) txn.fee = parseFloat(feeM2[1].replace(/,/g, ''));

  const balM = text.match(/New M-PESA balance is Ksh([\d,]+\.\d+)/i);
  if (balM) txn.balance_after = parseFloat(balM[1].replace(/,/g, ''));
  const balM2 = text.match(/available balance to spend is ([\d,]+\.?\d*)/i);
  if (balM2) txn.balance_after = parseFloat(balM2[1].replace(/,/g, ''));

  // FIX: suggest category from MERCHANT only, not raw_text
  // (Old logic scanned raw_text containing "Transaction cost" → wrongly tagged as M-PESA Fee)
  txn.suggested_category = suggestCategory(txn.merchant);

  return txn;
}

// Escape Telegram MarkdownV1 special characters in dynamic text
function escMd(text) {
  return String(text).replace(/[_*`[]/g, '\\$&');
}

function formatCard(txn, splits) {
  const src = { MPESA: '📱', LOOP: '💳', ABSA: '🏦', UNKNOWN: '❓' }[txn.source] || '❓';
  const typeLabel = {
    SEND: '→ Send', RECEIVE: '← Receive', CARD_SPEND: '💸 Card Spend',
    BILL_PAYMENT: '📄 Bill Payment', CARD_PAYMENT: '✅ Card Payment', OTHER: 'Other'
  }[txn.type] || txn.type;

  let text = `${src} *NEW TRANSACTION*\n\n`;
  text += `📅 ${txn.date || 'Unknown date'}  🕐 ${txn.time || 'Unknown time'}\n`;
  text += `🏦 ${txn.source} — ${typeLabel}\n`;
  text += `👤 ${escMd(txn.merchant || 'Unknown')}\n`;
  text += `💰 ${txn.currency} ${Number(txn.amount).toLocaleString()}`;
  if (txn.fee > 0) text += `  |  Fee: ${Number(txn.fee).toLocaleString()} _(logs as separate row)_`;
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

function buildCategoryKeyboard(txnId) {
  const groups = Object.keys(CATEGORY_GROUPS);
  const keyboard = groups.map(group => [{ text: group, callback_data: `grp:${txnId}:${group}` }]);
  keyboard.push([{ text: '↩️ Back to transaction', callback_data: `back:${txnId}` }]);
  return { inline_keyboard: keyboard };
}

function buildGroupKeyboard(txnId, group) {
  const items = CATEGORY_GROUPS[group] || [];
  const keyboard = items.map(item => [{ text: item.label, callback_data: `cat:${txnId}:${item.full}` }]);
  keyboard.push([{ text: '↩️ Back to groups', callback_data: `cats:${txnId}` }]);
  return { inline_keyboard: keyboard };
}

function buildMainKeyboard(txnId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Confirm', callback_data: `confirm:${txnId}` }, { text: '📂 Category', callback_data: `cats:${txnId}` }],
      [{ text: '✂️ Split', callback_data: `split:${txnId}` }, { text: '🗑️ Skip', callback_data: `skip:${txnId}` }]
    ]
  };
}

// SAVE TO SHEET — Fee as separate row (Option C)
async function saveToSheet(txn, splits) {
  const ts = new Date().toISOString();
  const baseId = Date.now();
  let rows = [];

  if (splits && splits.length > 0) {
    splits.forEach((s, i) => {
      rows.push([
        `TXN-${baseId}-${i}`,
        txn.date, txn.time, txn.source, txn.type,
        s.amount, txn.currency, txn.merchant,
        txn.reference, 0, // fee logged separately below
        i === 0 ? txn.balance_after : 0,
        s.category, s.notes || '', txn.confidence,
        i === 0 ? txn.raw_text.substring(0, 500) : `[Split ${i + 1} of ${splits.length}]`,
        ts
      ]);
    });
  } else {
    rows.push([
      `TXN-${baseId}-0`,
      txn.date, txn.time, txn.source, txn.type,
      txn.amount, txn.currency, txn.merchant,
      txn.reference, 0, txn.balance_after,
      txn.suggested_category, '', txn.confidence,
      txn.raw_text.substring(0, 500), ts
    ]);
  }

  // FEE AS SEPARATE LEDGER ROW
  if (txn.fee > 0) {
    rows.push([
      `TXN-${baseId}-FEE`,
      txn.date, txn.time, txn.source, 'FEE',
      txn.fee, txn.currency, `${txn.source} Fee`,
      txn.reference, 0, 0,
      feeCategory(txn.source),
      `Fee for ${txn.reference || txn.merchant}`,
      txn.confidence,
      `[Fee for TXN-${baseId}]`,
      ts
    ]);
  }

  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'append', rows })
  });
  return await res.json();
}

function detectIntent(text) {
  if (!text) return 'unknown';
  if (text === '/start') return 'start';
  if (text === '/pending') return 'pending';
  if (/^\/done\s+\d+$/.test(text)) return 'done';
  if (/^[\d,]+\.?\d*\s*\|/.test(text)) return 'splitline';
  if (/\b(Ksh|KES|USD)[\d.,\s]/i.test(text) || /\b(Confirmed|Paybill|Absa)\b/i.test(text)) return 'sms';
  return 'unknown';
}

// SINGLE MERGED MESSAGE HANDLER (was two handlers before — caused duplicate "Could not parse")
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== CHAT_ID) return;
  const text = (msg.text || '').trim();
  const intent = detectIntent(text);

  if (intent === 'start') {
    return bot.sendMessage(CHAT_ID,
      '👋 *PFAS Bot ready.*\n\nForward any M-PESA, Loop, or Absa SMS and I\'ll parse it.\n\n' +
      'Commands:\n• /pending — view unconfirmed\n• /start — show help',
      { parse_mode: 'Markdown' }
    );
  }

  if (intent === 'pending') {
    const count = Object.keys(pending).length;
    return bot.sendMessage(CHAT_ID,
      count > 0 ? `⏳ ${count} unconfirmed transaction(s). Scroll up to review.` : '✅ No pending transactions.',
      { parse_mode: 'Markdown' }
    );
  }

  if (intent === 'done') {
    const txnId = text.match(/^\/done\s+(\d+)$/)[1];
    const entry = pending[txnId];
    if (!entry) return bot.sendMessage(CHAT_ID, '⚠️ Transaction not found.');
    entry.splitting = false;
    const splitTotal = entry.splits.reduce((sum, s) => sum + s.amount, 0);
    const remaining = entry.txn.amount - splitTotal;
    return bot.sendMessage(CHAT_ID,
      `✂️ *Split summary:*\n${formatCard(entry.txn, entry.splits)}\n\n` +
      (remaining > 0 ? `⚠️ Still unallocated: ${entry.txn.currency} ${Number(remaining).toLocaleString()}\n\n` : '') +
      `Tap Confirm to save.`,
      { parse_mode: 'Markdown', reply_markup: buildMainKeyboard(txnId) }
    );
  }

  if (intent === 'splitline') {
    const splitEntry = Object.entries(pending).find(([, e]) => e.splitting);
    if (!splitEntry) return; // silent — not in split mode
    const [txnId, entry] = splitEntry;
    const parts = text.split('|').map(p => p.trim());
    if (parts.length >= 2) {
      const amount = parseFloat(parts[0].replace(/,/g, ''));
      const category = parts[1];
      if (!isNaN(amount) && amount > 0) {
        entry.splits.push({ amount, category, notes: parts[2] || '' });
        const splitTotal = entry.splits.reduce((sum, s) => sum + s.amount, 0);
        const remaining = entry.txn.amount - splitTotal;
        return bot.sendMessage(CHAT_ID,
          `✅ Added: ${entry.txn.currency} ${Number(amount).toLocaleString()} → ${category}\n` +
          `Remaining: ${entry.txn.currency} ${Number(remaining).toLocaleString()}\n\n` +
          `Add another or send \`/done ${txnId}\``,
          { parse_mode: 'Markdown' }
        );
      }
    }
    return bot.sendMessage(CHAT_ID, '⚠️ Format: `amount | category`', { parse_mode: 'Markdown' });
  }

  if (intent === 'sms') {
    return processIncomingSms(text);
  }

  // Unknown — only respond to longer attempts, not random short noise
  if (text.length > 20) {
    return bot.sendMessage(CHAT_ID,
      '⚠️ Could not parse this as a transaction. Forward an M-PESA, Loop, or Absa SMS.',
      { parse_mode: 'Markdown' }
    );
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const msgId = query.message.message_id;
  await bot.answerCallbackQuery(query.id);

  const [action, txnId, ...rest] = data.split(':');
  const entry = pending[txnId];
  if (!entry && action !== 'back') return;

  if (action === 'confirm') {
    try {
      await saveToSheet(entry.txn, entry.splits);
      delete pending[txnId];
      const feeNote = entry.txn.fee > 0 ? `\n💸 Fee row: ${entry.txn.currency} ${entry.txn.fee} → ${feeCategory(entry.txn.source)}` : '';
      await bot.editMessageText(
        `✅ *Saved!*${feeNote}\n\n${formatCard(entry.txn, entry.splits.length ? entry.splits : null)}`,
        { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown' }
      );
    } catch(e) {
      await bot.sendMessage(CHAT_ID, `❌ Save failed: ${e.message}`);
    }
  }
  else if (action === 'skip') {
    delete pending[txnId];
    await bot.editMessageText(`🗑️ *Skipped.*`,
      { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown' });
  }
  else if (action === 'cats') {
    await bot.editMessageReplyMarkup(buildCategoryKeyboard(txnId),
      { chat_id: CHAT_ID, message_id: msgId });
  }
  else if (action === 'grp') {
    const group = rest.join(':');
    await bot.editMessageReplyMarkup(buildGroupKeyboard(txnId, group),
      { chat_id: CHAT_ID, message_id: msgId });
  }
  else if (action === 'cat') {
    const category = rest.join(':');
    entry.txn.suggested_category = category;
    await bot.editMessageText(formatCard(entry.txn, entry.splits),
      { chat_id: CHAT_ID, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: buildMainKeyboard(txnId) });
  }
  else if (action === 'split') {
    await bot.sendMessage(CHAT_ID,
      `✂️ *Split: ${entry.txn.currency} ${Number(entry.txn.amount).toLocaleString()}*\n\n` +
      `Send each line as:\n\`amount | category\`\n\n` +
      `When done, send \`/done ${txnId}\``,
      { parse_mode: 'Markdown' }
    );
    entry.splitting = true;
  }
  else if (action === 'back') {
    if (!entry) return;
    await bot.editMessageReplyMarkup(buildMainKeyboard(txnId),
      { chat_id: CHAT_ID, message_id: msgId });
  }
});

cron.schedule('0 4 * * *', async () => {
  const count = Object.keys(pending).length;
  if (count > 0) {
    await bot.sendMessage(CHAT_ID,
      `☀️ *Good morning!*\n\n${count} unconfirmed transaction(s).\n\nSend /pending to review.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Keep-alive ping every 10 minutes to prevent Render free tier sleep
cron.schedule('*/10 * * * *', async () => {
  try {
    await fetch(`http://localhost:${PORT}/`);
  } catch(e) {
    // silent — just keeping the process warm
  }
});

console.log('PFAS Bot v2 started.');
