// ============================================================================
// OnePass IoT Smart Gate: Telegram Bot & Notification Service
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local storage fallback for tokens and logs
const DATA_DIR = path.join(__dirname, 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'telegram_tokens.json');
const LOGS_FILE = path.join(DATA_DIR, 'telegram_logs.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  }
  if (!fs.existsSync(TOKENS_FILE)) {
    try { fs.writeFileSync(TOKENS_FILE, JSON.stringify({}), 'utf8'); } catch (e) {}
  }
  if (!fs.existsSync(LOGS_FILE)) {
    try { fs.writeFileSync(LOGS_FILE, JSON.stringify([]), 'utf8'); } catch (e) {}
  }
}
ensureDataFiles();

function readLocalTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

function writeLocalTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (e) {}
}

function appendLocalLog(logEntry) {
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]');
    logs.unshift({ id: crypto.randomUUID(), ...logEntry, created_at: new Date().toISOString() });
    if (logs.length > 500) logs.length = 500; // Keep last 500
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {}
}

let supabaseClient = null;
let botPollingActive = false;
let lastUpdateId = 0;

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.trim() : '';
}

function getBotUsername() {
  return process.env.TELEGRAM_BOT_USERNAME ? process.env.TELEGRAM_BOT_USERNAME.replace('@', '').trim() : 'OnePassGateBot';
}

function getAppUrl() {
  return process.env.APP_BASE_URL || 'https://statistical-part-unsigned-considerable.trycloudflare.com';
}

// ----------------------------------------------------------------------------
// Telegram API Client (using native fetch)
// ----------------------------------------------------------------------------
async function callTelegramApi(method, body = {}) {
  const token = getBotToken();
  if (!token) {
    return { ok: false, simulated: true, description: 'TELEGRAM_BOT_TOKEN is not configured in .env' };
  }

  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Core Notification Dispatcher (Non-blocking, Retry & Block Detection)
// ----------------------------------------------------------------------------
async function sendTelegramMessage(chatId, text, options = {}, retries = 2) {
  if (!chatId) return { ok: false, error: 'No chatId provided' };

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: options.disable_web_page_preview ?? true
  };

  if (options.reply_markup) {
    payload.reply_markup = options.reply_markup;
  }

  let attempt = 0;
  while (attempt <= retries) {
    attempt++;
    const res = await callTelegramApi('sendMessage', payload);

    if (res.ok) {
      appendLocalLog({
        chat_id: chatId,
        notify_type: options.notify_type || 'general',
        message_preview: text.substring(0, 100),
        status: 'success'
      });
      return { ok: true, result: res.result };
    }

    // Check if user blocked the bot (Error 403)
    if (res.error_code === 403 || (res.description && res.description.toLowerCase().includes('bot was blocked'))) {
      console.warn(`⚠️ [TELEGRAM] User blocked the bot (chat_id: ${chatId}). Disconnecting...`);
      await handleUserBlockedBot(chatId);
      appendLocalLog({
        chat_id: chatId,
        notify_type: options.notify_type || 'general',
        message_preview: text.substring(0, 100),
        status: 'blocked',
        error_message: res.description
      });
      return { ok: false, blocked: true, description: res.description };
    }

    // If simulated mode (no token set)
    if (res.simulated) {
      console.log(`ℹ️ [TELEGRAM:SIMULATION] Message to ${chatId}:\n${text}`);
      appendLocalLog({
        chat_id: chatId,
        notify_type: options.notify_type || 'simulation',
        message_preview: text.substring(0, 100),
        status: 'simulated'
      });
      return { ok: true, simulated: true };
    }

    console.warn(`⚠️ [TELEGRAM] Attempt ${attempt} failed:`, res.description || res.error);
    if (attempt <= retries) {
      // Exponential backoff wait (e.g. 1.5s, 3s)
      await new Promise(r => setTimeout(r, attempt * 1500));
    } else {
      appendLocalLog({
        chat_id: chatId,
        notify_type: options.notify_type || 'general',
        message_preview: text.substring(0, 100),
        status: 'failed',
        error_message: res.description || res.error
      });
      return { ok: false, error: res.description || res.error };
    }
  }
}

// When user blocks the bot, reset connection in DB and local store
async function handleUserBlockedBot(chatId) {
  try {
    if (supabaseClient) {
      await supabaseClient
        .from('users')
        .update({
          telegram_chat_id: null,
          telegram_username: null,
          telegram_connected_at: null
        })
        .eq('telegram_chat_id', chatId);
    }
  } catch (e) {
    console.error('Error unlinking blocked telegram user in DB:', e.message);
  }

  // Update in profiles.json if present
  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
      for (const k in profs) {
        if (profs[k].telegram_chat_id == chatId) {
          profs[k].telegram_chat_id = null;
          profs[k].telegram_username = null;
          profs[k].telegram_connected_at = null;
        }
      }
      fs.writeFileSync(profPath, JSON.stringify(profs, null, 2), 'utf8');
    }
  } catch (e) {}
}

// ----------------------------------------------------------------------------
// Link Token Management (Unguessable, 1-time use, 10-minute expiry)
// ----------------------------------------------------------------------------
async function createLinkToken(userId, username) {
  const token = crypto.randomBytes(16).toString('hex'); // 32 chars hex
  const shortCode = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit easy pairing code
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins

  // Save to database
  if (supabaseClient) {
    try {
      await supabaseClient.from('telegram_link_tokens').insert([{
        user_id: userId,
        token: token,
        expires_at: expiresAt,
        used: false
      }]);
    } catch (err) {
      console.warn('⚠️ [TELEGRAM] Fallback saving token locally:', err.message);
    }
  }

  // Also save to local tokens store for rapid lookup and fallback
  const tokens = readLocalTokens();
  // Clear old expired tokens for this user
  for (const k in tokens) {
    if (tokens[k].userId === userId || new Date(tokens[k].expiresAt) < new Date()) {
      delete tokens[k];
    }
  }

  const tokenData = {
    userId,
    username,
    token,
    shortCode,
    expiresAt,
    used: false,
    createdAt: new Date().toISOString()
  };

  // Map both 32-char hex token AND 6-digit numeric shortCode
  tokens[token] = tokenData;
  tokens[shortCode] = tokenData;
  writeLocalTokens(tokens);

  const botName = getBotUsername();
  const link = `https://t.me/${botName}?start=${token}`;
  const nativeLink = `tg://resolve?domain=${botName}&start=${token}`;
  return { token, shortCode, link, nativeLink, expiresAt, botUsername: botName };
}

async function verifyAndConsumeLinkToken(token) {
  if (!token) return null;
  const clean = String(token).trim();
  const now = new Date();

  // Check Supabase first
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('telegram_link_tokens')
        .select('*')
        .eq('token', clean)
        .eq('used', false)
        .gt('expires_at', now.toISOString())
        .maybeSingle();

      if (!error && data) {
        // Mark as used
        await supabaseClient
          .from('telegram_link_tokens')
          .update({ used: true })
          .eq('id', data.id);
        return data.user_id;
      }
    } catch (e) {}
  }

  // Check local fallback
  const tokens = readLocalTokens();
  const item = tokens[clean];
  if (item && !item.used && new Date(item.expiresAt) > now) {
    item.used = true;
    if (item.token && tokens[item.token]) tokens[item.token].used = true;
    if (item.shortCode && tokens[item.shortCode]) tokens[item.shortCode].used = true;
    writeLocalTokens(tokens);
    return item.userId;
  }

  return null;
}

// ----------------------------------------------------------------------------
// Link Account with Chat ID (1-to-1 pairing guarantee)
// ----------------------------------------------------------------------------
async function linkTelegramAccount(userId, chatId, tgUsername, tgFullName) {
  const connectedAt = new Date().toISOString();
  let updatedUser = null;

  // 1. Check if another user has this chatId, unlink them first (Requirement: 1 TG = 1 User)
  if (supabaseClient) {
    try {
      await supabaseClient
        .from('users')
        .update({
          telegram_chat_id: null,
          telegram_username: null,
          telegram_connected_at: null
        })
        .eq('telegram_chat_id', chatId);
    } catch (e) {}
  }

  // 2. Link this user in Supabase (try both id and username)
  if (supabaseClient) {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
      let query = supabaseClient.from('users').update({
        telegram_chat_id: chatId,
        telegram_username: tgUsername || tgFullName || 'Telegram User',
        telegram_connected_at: connectedAt
      });

      if (isUUID) {
        query = query.eq('id', userId);
      } else {
        query = query.eq('username', userId);
      }

      const { data } = await query.select().maybeSingle();
      if (data) updatedUser = data;
    } catch (e) {
      console.warn('⚠️ [TELEGRAM] Update user in Supabase failed:', e.message);
    }
  }

  // 3. Update in profiles.json fallback
  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');

      // Resolve user details from Supabase if available
      let dbUser = null;
      if (supabaseClient) {
        try {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
          const q = supabaseClient.from('users').select('id, username, full_name, role');
          const { data } = await (isUUID ? q.eq('id', userId) : q.eq('username', userId)).maybeSingle();
          dbUser = data;
        } catch (e) {}
      }

      const aliasKeys = [userId, dbUser?.id, dbUser?.username, dbUser?.role].filter(Boolean);

      for (const ak of aliasKeys) {
        if (!profs[ak]) profs[ak] = {};
        profs[ak].telegram_chat_id = chatId;
        profs[ak].telegram_username = tgUsername || tgFullName;
        profs[ak].telegram_connected_at = connectedAt;
        if (dbUser) {
          profs[ak].full_name = dbUser.full_name;
          profs[ak].role = dbUser.role;
          profs[ak].username = dbUser.username;
        }
      }

      for (const k in profs) {
        if (!aliasKeys.includes(k) && profs[k].telegram_chat_id == chatId) {
          profs[k].telegram_chat_id = null;
        }
      }
      fs.writeFileSync(profPath, JSON.stringify(profs, null, 2), 'utf8');
      if (!updatedUser) updatedUser = profs[userId];
    }
  } catch (e) {}

  return updatedUser;
}

async function unlinkTelegramAccount(userId) {
  if (supabaseClient) {
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
      let query = supabaseClient.from('users').update({
        telegram_chat_id: null,
        telegram_username: null,
        telegram_connected_at: null
      });
      if (isUUID) {
        query = query.eq('id', userId);
      } else {
        query = query.eq('username', userId);
      }
      await query;
    } catch (e) {}
  }

  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
      for (const k in profs) {
        if (k === userId || profs[k].id === userId || profs[k].username === userId) {
          profs[k].telegram_chat_id = null;
          profs[k].telegram_username = null;
          profs[k].telegram_connected_at = null;
        }
      }
      fs.writeFileSync(profPath, JSON.stringify(profs, null, 2), 'utf8');
    }
  } catch (e) {}
}

async function findUserByChatId(chatId) {
  if (!chatId) return null;
  if (supabaseClient) {
    try {
      const { data } = await supabaseClient
        .from('users')
        .select('*')
        .eq('telegram_chat_id', chatId)
        .maybeSingle();
      if (data) return data;
    } catch (e) {}
  }
  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
      for (const k in profs) {
        if (profs[k].telegram_chat_id == chatId) {
          return profs[k];
        }
      }
    }
  } catch (e) {}
  return null;
}

// ----------------------------------------------------------------------------
// Telegram Update Processing (Handles /start <token>)
// ----------------------------------------------------------------------------
async function processTelegramUpdate(update) {
  if (!update || !update.message) return;
  const msg = update.message;
  const chatId = msg.chat?.id;
  const rawText = (msg.text || '').trim();
  const from = msg.from || {};
  const tgUsername = from.username ? `@${from.username}` : (from.first_name || 'ผู้ใช้งาน');

  // ตรวจสอบหารหัส Token (32-char hex หรือ 6-digit numeric shortCode)
  let candidateToken = '';
  if (rawText.startsWith('/start')) {
    const parts = rawText.split(/\s+/);
    candidateToken = parts[1] ? parts[1].trim() : '';
  } else if (rawText.startsWith('/link')) {
    const parts = rawText.split(/\s+/);
    candidateToken = parts[1] ? parts[1].trim() : '';
  } else if (/^[0-9]{6}$/.test(rawText)) {
    candidateToken = rawText;
  }

  // 1. กรณีผู้ใช้ส่ง Token หรือ รหัส 6 หลักมา
  if (candidateToken) {
    const userId = await verifyAndConsumeLinkToken(candidateToken);
    if (userId) {
      // ผูกบัญชีสำเร็จ
      const user = await linkTelegramAccount(userId, chatId, tgUsername, `${from.first_name || ''} ${from.last_name || ''}`.trim());
      const displayName = user ? (user.full_name || user.username) : 'ผู้ใช้งาน';
      const roleLabel = getRoleLabel(user ? user.role : '');

      await sendTelegramMessage(
        chatId,
        `🎉 <b>เชื่อมต่อบัญชี OnePass สำเร็จเรียบร้อยแล้ว (ถาวร)!</b>\n\n` +
        `👤 <b>บัญชี:</b> ${displayName}\n` +
        `🏷️ <b>ตำแหน่ง/บทบาท:</b> ${roleLabel}\n` +
        `⏰ <b>วันที่เชื่อมต่อ:</b> ${new Date().toLocaleString('th-TH')}\n\n` +
        `📲 คุณจะได้รับการแจ้งเตือนสถานะคำร้อง การอนุมัติ และการผ่านประตูแบบเรียลไทม์ที่นี่ตลอดไปครับ (การเชื่อมต่อเป็นแบบถาวร ไม่ต้องเชื่อมต่อซ้ำ)`,
        { notify_type: 'account_linked' }
      );
      console.log(`✅ [TELEGRAM] Linked chatId ${chatId} with user: ${displayName} (${userId})`);
      return;
    } else {
      // รหัสไม่ถูกต้องหรือหมดอายุ
      await sendTelegramMessage(
        chatId,
        `⚠️ <b>รหัสเชื่อมต่อไม่ถูกต้องหรือหมดอายุแล้ว</b>\n\n` +
        `รหัส 6 หลักและลิงก์มีอายุ 10 นาที (เพื่อความปลอดภัย)\n` +
        `กรุณากดเปิดหน้าต่าง "เชื่อมต่อ Telegram" บนหน้าเว็บ OnePass เพื่อดูรหัสใหม่อีกครั้งครับ\n\n` +
        `🆔 <b>Chat ID ของคุณคือ:</b> <code>${chatId}</code>`,
        { notify_type: 'token_invalid' }
      );
      return;
    }
  }

  // 2. ตรวจสอบว่า Chat ID นี้ผูกบัญชีไว้อยู่แล้วหรือไม่
  const existing = await findUserByChatId(chatId);
  if (existing) {
    const displayName = existing.full_name || existing.username || 'ผู้ใช้งาน';
    const roleLabel = getRoleLabel(existing.role || '');
    await sendTelegramMessage(
      chatId,
      `✅ <b>บัญชีของคุณเชื่อมต่อกับ OnePass เรียบร้อยแล้ว (สถานะ: ถาวร)</b>\n\n` +
      `👤 <b>บัญชีที่ผูก:</b> ${displayName}\n` +
      `🏷️ <b>ตำแหน่ง/บทบาท:</b> ${roleLabel}\n` +
      `🟢 <b>การแจ้งเตือน:</b> พร้อมทำงานตามปกติ\n\n` +
      `<i>ระบบจะส่งการแจ้งเตือนคำร้องและการผ่านประตูมาที่นี่โดยอัตโนมัติครับ</i>`,
      { notify_type: 'bot_status' }
    );
    return;
  }

  // 3. ผู้ใช้ยังไม่เคยผูก และไม่ได้ส่งรหัสมา -> ส่งคู่มือพร้อมแสดง Chat ID ชัดเจน
  await sendTelegramMessage(
    chatId,
    `👋 <b>ยินดีต้อนรับสู่ OnePass IoT Smart Gate Bot</b>\n` +
    `วิทยาลัยการอาชีพองครักษ์\n\n` +
    `🆔 <b>Telegram Chat ID ของคุณคือ:</b>\n` +
    `👉 <code>${chatId}</code> 👈 <i>(แตะที่ตัวเลขเพื่อคัดลอก)</i>\n\n` +
    `📌 <b>วิธีเชื่อมต่อบัญชี (เลือกทำ 1 วิธี):</b>\n` +
    `1️⃣ <b>พิมพ์รหัส 6 หลัก:</b> เปิดหน้าเว็บ OnePass แล้วพิมพ์รหัส 6 หลักที่แสดงบนหน้าเว็บ ส่งตอบกลับมาที่นี่ได้ทันที\n` +
    `2️⃣ <b>กรอก Chat ID บนเว็บ:</b> คัดลอกเลข <code>${chatId}</code> ด้านบน ไปวางในช่อง "ระบุ Chat ID ด้วยตนเอง" บนหน้าเว็บ แล้วกดปุ่มเชื่อมต่อ\n\n` +
    `เมื่อเชื่อมต่อแล้ว ระบบจะส่งแจ้งเตือนการขออนุญาตและผลการอนุมัติให้คุณทันทีครับ`,
    { notify_type: 'welcome_guide' }
  );
}

function getRoleLabel(role) {
  const map = {
    student: 'นักเรียน/นักศึกษา',
    teacher: 'ครูผู้สอน / ครูที่ปรึกษา',
    subject_teacher: 'ครูประจำวิชา',
    head_dept: 'หัวหน้าแผนกวิชา',
    discipline_head: 'ฝ่ายปกครอง',
    deputy: 'รองผู้อำนวยการ',
    director: 'ผู้อำนวยการ',
    security: 'เจ้าหน้าที่ รปภ. / ประตู',
    admin: 'ผู้ดูแลระบบ (Admin)'
  };
  return map[role] || 'บุคลากร';
}

// ----------------------------------------------------------------------------
// Background Polling Engine (If no Webhook configured)
// ----------------------------------------------------------------------------
async function startBotPolling() {
  const token = getBotToken();
  if (!token) {
    console.log('ℹ️ [TELEGRAM] Bot polling standby (No TELEGRAM_BOT_TOKEN set in .env)');
    return;
  }
  if (botPollingActive) return;
  botPollingActive = true;

  console.log(`🤖 [TELEGRAM] Starting Bot Polling service for @${getBotUsername()}...`);

  const poll = async () => {
    if (!botPollingActive) return;
    try {
      const res = await callTelegramApi('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 20
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          try {
            await processTelegramUpdate(update);
          } catch (procErr) {
            console.error('Error processing update:', procErr);
          }
        }
      } else if (!res.ok && res.error_code === 409) {
        // Webhook conflict, delete webhook
        console.warn('⚠️ [TELEGRAM] Conflict: Webhook active, removing webhook to use polling...');
        await callTelegramApi('deleteWebhook');
      }
    } catch (err) {
      // Ignore network abort
    }
    setTimeout(poll, 1500);
  };

  poll();
}

function stopBotPolling() {
  botPollingActive = false;
}

// ----------------------------------------------------------------------------
// High-Level Notification Triggers (Requirements 7, 8, 9, 10, 11)
// ----------------------------------------------------------------------------

// Helper to get user telegram info
async function getUserTelegramInfo(ident) {
  if (!ident) return null;
  const target = typeof ident === 'object' ? (ident.id || ident.username || ident.role) : String(ident);
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);

  // 1. Look up user record in DB to get both ID and username
  let dbUser = null;
  if (supabaseClient) {
    try {
      let q = supabaseClient.from('users').select('id, username, full_name, role');
      if (isUUID) {
        q = q.eq('id', target);
      } else {
        q = q.eq('username', target);
      }
      const { data } = await q.maybeSingle();
      if (data) dbUser = data;
    } catch (e) {}
  }

  // 2. Check profiles.json fallback
  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
      const keysToCheck = [
        target,
        dbUser ? dbUser.id : null,
        dbUser ? dbUser.username : null,
        typeof ident === 'object' ? ident.role : null,
        typeof ident === 'object' ? ident.username : null
      ].filter(Boolean);

      for (const k of keysToCheck) {
        if (profs[k] && profs[k].telegram_chat_id) {
          return { ...(dbUser || {}), ...profs[k], telegram_chat_id: profs[k].telegram_chat_id };
        }
      }

      for (const k in profs) {
        const u = profs[k];
        if (keysToCheck.includes(u.id) || keysToCheck.includes(u.username) || keysToCheck.includes(k)) {
          if (u.telegram_chat_id) {
            return { ...(dbUser || {}), ...u, telegram_chat_id: u.telegram_chat_id };
          }
        }
      }
    }
  } catch (e) {}

  return dbUser;
}

// Requirement 7: แจ้งเตือนผู้อนุมัติเมื่อคำร้องถึงคิว
async function notifyApproverQueue(approverUser, request, stepNumber) {
  if (!approverUser) return;
  const user = await getUserTelegramInfo(approverUser.id || approverUser.username || approverUser);
  if (!user || !user.telegram_chat_id) return;

  const settings = user.telegram_notify_settings || {};
  if (settings.pending_approval === false) return; // User opted out

  const appUrl = getAppUrl();
  const depTime = request.departure_time || request.departureTime || request.start_time || request.startTime || '13:00';
  const retTime = request.no_return || request.noReturn
    ? 'ลากลับบ้าน'
    : (request.expected_return_time || request.expectedReturnTime || request.end_time || request.endTime || '15:30') + ' น.';

  const text = 
    `📋 <b>มีคำร้องขอออกนอกสถานศึกษาใหม่รอการอนุมัติ (ขั้นตอนที่ ${stepNumber})</b>\n\n` +
    `👤 <b>นักเรียน:</b> ${request.student_name || request.studentName || 'นักเรียน'} (${request.student_code || request.studentCode || '-'})\n` +
    `🏢 <b>แผนก:</b> ${request.department_name || request.deptName || request.department || '-'}\n` +
    `📅 <b>วันที่:</b> ${request.leave_date || request.leaveDate || request.date || 'วันนี้'}\n` +
    `⏰ <b>ช่วงเวลา:</b> ${depTime} - ${retTime}\n` +
    `📝 <b>เหตุผล:</b> ${request.reason || '-'}\n\n` +
    `👉 <a href="${appUrl}">กดที่นี่เพื่อเข้าสู่ระบบ OnePass และอนุมัติคำร้อง</a>`;

  // Send non-blocking
  return sendTelegramMessage(user.telegram_chat_id, text, { notify_type: 'approver_queue' });
}

// Requirement 7: เตือนซ้ำเมื่อคำร้องค้างเกินเวลา
async function notifyApproverOverdueReminder(approverUser, request, minutesWaiting) {
  const user = await getUserTelegramInfo(approverUser.id || approverUser.username || approverUser);
  if (!user || !user.telegram_chat_id) return;

  const settings = user.telegram_notify_settings || {};
  if (settings.pending_approval === false) return;

  const appUrl = getAppUrl();
  const text = 
    `⏳ <b>แจ้งเตือนคำร้องค้างการอนุมัติเกิน ${minutesWaiting} นาที</b>\n\n` +
    `👤 <b>นักเรียน:</b> ${request.student_name || request.studentName}\n` +
    `📝 <b>เหตุผล:</b> ${request.reason || '-'}\n` +
    `⏰ <b>เวลาที่ขอออก:</b> ${request.start_time || request.startTime}\n\n` +
    `กรุณาเข้าสู่ระบบเพื่อดำเนินการพิจารณา:\n` +
    `👉 <a href="${appUrl}">เปิดหน้าการอนุมัติ OnePass</a>`;

  sendTelegramMessage(user.telegram_chat_id, text, { notify_type: 'overdue_reminder' });
}

// Requirement 8: แจ้งเตือนนักเรียนเมื่อผลคำร้องออก (อนุมัติ / ได้ QR Pass)
async function notifyStudentApproved(studentUser, request) {
  const user = await getUserTelegramInfo(studentUser.id || studentUser.username || studentUser);
  if (!user || !user.telegram_chat_id) return;

  const settings = user.telegram_notify_settings || {};
  if (settings.request_result === false) return;

  const appUrl = getAppUrl();
  const text = 
    `🎉 <b>คำร้องขอออกนอกสถานศึกษาได้รับการอนุมัติเรียบร้อยแล้ว!</b>\n\n` +
    `📅 <b>วันที่:</b> ${request.leave_date || request.date || 'วันนี้'}\n` +
    `⏰ <b>ช่วงเวลา:</b> ${request.start_time || request.startTime} - ${request.end_time || request.endTime}\n` +
    `📝 <b>เหตุผล:</b> ${request.reason || '-'}\n\n` +
    `📲 <b>บัตรผ่านดิจิทัล (QR Pass) พร้อมใช้งานแล้ว</b>\n` +
    `⚠️ <i>เพื่อความปลอดภัยและความเป็นส่วนตัว ระบบจะไม่ส่งรหัส QR ผ่านแชท กรุณากดเปิดบัตรผ่านในแอป:</i>\n` +
    `👉 <a href="${appUrl}">เปิดบัตรผ่าน QR Pass บนมือถือ</a>`;

  sendTelegramMessage(user.telegram_chat_id, text, { notify_type: 'student_approved' });
}

// Requirement 8: แจ้งเตือนนักเรียนเมื่อคำร้องไม่ผ่าน (พร้อมเหตุผล)
async function notifyStudentRejected(studentUser, request, approverRole, rejectReason) {
  const user = await getUserTelegramInfo(studentUser.id || studentUser.username || studentUser);
  if (!user || !user.telegram_chat_id) return;

  const settings = user.telegram_notify_settings || {};
  if (settings.request_result === false) return;

  const appUrl = getAppUrl();
  const text = 
    `❌ <b>คำร้องขอออกนอกสถานศึกษาไม่ได้รับการอนุมัติ</b>\n\n` +
    `👤 <b>พิจารณาโดย:</b> ${getRoleLabel(approverRole)}\n` +
    `📝 <b>เหตุผลที่ปฏิเสธ:</b> ${rejectReason || 'ไม่ระบุเหตุผล'}\n` +
    `📅 <b>วันที่:</b> ${request.leave_date || request.date || 'วันนี้'}\n\n` +
    `👉 <a href="${appUrl}">ตรวจสอบรายละเอียดคำร้องในระบบ</a>`;

  sendTelegramMessage(user.telegram_chat_id, text, { notify_type: 'student_rejected' });
}

// Requirement 10: แจ้งเตือนสแกนเข้า/ออก (นักเรียน และ ผู้ปกครองที่ยินยอม)
async function notifyScanGateEvent(studentUser, type, timestamp, gateName) {
  const user = await getUserTelegramInfo(studentUser.id || studentUser.username || studentUser);
  if (!user || !user.telegram_chat_id) return;

  const settings = user.telegram_notify_settings || {};
  if (settings.parent_scan === false) return;

  const isExit = (type === 'exit');
  const actionText = isExit ? '🚪 <b>บันทึกการสแกน: เดินทางออกจากสถานศึกษา</b>' : '🏫 <b>บันทึกการสแกน: กลับเข้าสถานศึกษาเรียบร้อยแล้ว</b>';
  const caution = isExit ? `\n⚠️ <i>กรุณาเดินทางกลับเข้าสถานศึกษาให้ตรงตามเวลาที่ได้รับอนุมัติ</i>` : `\n✅ <i>ขอบคุณที่ปฏิบัติตามกฎระเบียบของวิทยาลัย</i>`;

  const text = 
    `${actionText}\n\n` +
    `👤 <b>นักเรียน:</b> ${user.full_name || user.username}\n` +
    `📍 <b>จุดตรวจ:</b> ${gateName || 'ประตูใหญ่ OnePass IoT Gate'}\n` +
    `⏰ <b>เวลาที่บันทึก:</b> ${timestamp || new Date().toLocaleTimeString('th-TH')}` +
    caution;

  sendTelegramMessage(user.telegram_chat_id, text, { notify_type: 'scan_event' });
}

// Requirement 9: แจ้งเตือนแอดมิน (ไม้กั้นออฟไลน์, สแกนล้มเหลวผิดปกติ)
async function notifyAdminAlert(alertTitle, alertMessage, severity = 'warning') {
  // Find all admin users with telegram connected
  let admins = [];
  if (supabaseClient) {
    try {
      const { data } = await supabaseClient
        .from('users')
        .select('id, username, telegram_chat_id, telegram_notify_settings')
        .eq('role', 'admin')
        .not('telegram_chat_id', 'is', null);
      if (data) admins = data;
    } catch (e) {}
  }

  // Fallback profiles.json
  if (admins.length === 0) {
    try {
      const profPath = path.join(DATA_DIR, 'profiles.json');
      if (fs.existsSync(profPath)) {
        const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
        for (const k in profs) {
          if (profs[k].role === 'admin' && profs[k].telegram_chat_id) {
            admins.push(profs[k]);
          }
        }
      }
    } catch (e) {}
  }

  const icon = severity === 'danger' ? '🚨' : '⚠️';
  const text = 
    `${icon} <b>แจ้งเตือนเหตุขัดข้องระบบ OnePass Gate (Admin)</b>\n\n` +
    `📌 <b>หัวข้อ:</b> ${alertTitle}\n` +
    `📝 <b>รายละเอียด:</b> ${alertMessage}\n` +
    `⏰ <b>เวลา:</b> ${new Date().toLocaleString('th-TH')}`;

  for (const admin of admins) {
    const settings = admin.telegram_notify_settings || {};
    if (settings.gate_alert !== false) {
      sendTelegramMessage(admin.telegram_chat_id, text, { notify_type: 'admin_alert' });
    }
  }
}

// Requirement 5, 6, 9: แจ้งเตือนฝ่ายปกครองเมื่อมีนักเรียนบันทึกกลับเข้าสถานศึกษา
async function notifyDisciplineStudentReturn({
  studentName,
  studentCode,
  dept,
  classroom,
  plateNo,
  returnTime,
  expectedTime,
  returnMethod = 'button',
  verificationStatus = 'verified',
  distanceCm = null,
  maxDistanceCm = 60,
  note = '',
  notifyMode = 'all'
}) {
  const isFlagged = verificationStatus === 'flagged_review';
  if (notifyMode === 'abnormal_only' && !isFlagged) {
    return; // ข้ามการแจ้งเตือนกรณีตั้งค่าให้แจ้งเฉพาะรายการผิดปกติ
  }

  let recipients = [];
  if (supabaseClient) {
    try {
      const { data } = await supabaseClient
        .from('users')
        .select('id, username, role, telegram_chat_id, telegram_notify_settings')
        .in('role', ['discipline_head', 'admin'])
        .not('telegram_chat_id', 'is', null);
      if (data) recipients = data;
    } catch (e) {}
  }

  try {
    const profPath = path.join(DATA_DIR, 'profiles.json');
    if (fs.existsSync(profPath)) {
      const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
      for (const k in profs) {
        if (['discipline_head', 'admin'].includes(profs[k].role) && profs[k].telegram_chat_id) {
          if (!recipients.some(r => r.username === profs[k].username)) {
            recipients.push(profs[k]);
          }
        }
      }
    }
  } catch (e) {}

  const methodLabel = returnMethod === 'button' ? '📱 กดปุ่มในแอป (นักเรียน)' : (returnMethod === 'manual' ? '✍️ ฝ่ายปกครองบันทึกแทน' : 'สแกน QR');
  const statusBadge = isFlagged 
    ? '🚨 <b>ต้องตรวจสอบ! (ผิดเงื่อนไข)</b>' 
    : (verificationStatus === 'manual_verified' ? '🟢 รับรองโดยฝ่ายปกครอง' : '✅ ตรวจสอบผ่านแล้ว');

  let distInfo = '';
  if (distanceCm !== null && distanceCm !== undefined) {
    const distNum = Number(distanceCm).toFixed(1);
    distInfo = `\n📏 <b>ระยะห่างจำลอง:</b> ${distNum} ซม. (เกณฑ์ไม่เกิน ${maxDistanceCm} ซม.)`;
  }

  let noteInfo = note ? `\n📝 <b>หมายเหตุ:</b> ${note}` : '';

  const header = isFlagged
    ? `🚨 <b>[OnePass แจ้งฝ่ายปกครอง: พบการกลับที่ต้องตรวจสอบ!]</b>`
    : `📍 <b>[OnePass: นักเรียนบันทึกกลับเข้าสถานศึกษา]</b>`;

  const text = 
    `${header}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>นักเรียน:</b> ${studentName} (${studentCode || '-'})\n` +
    `🏢 <b>แผนกวิชา:</b> ${dept || '-'} (${classroom || '-'})\n` +
    `🛵 <b>ยานพาหนะ:</b> ${plateNo || '-'}\n` +
    `⏰ <b>เวลากลับเข้า:</b> ${returnTime} น. (กำหนด: ${expectedTime || '-'} น.)\n` +
    `🎯 <b>สถานะ:</b> ${statusBadge}\n` +
    `🔄 <b>วิธีกลับ:</b> ${methodLabel}${distInfo}${noteInfo}\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `💡 สามารถตรวจสอบรายการสดหรือเพิกถอนได้ในระบบ OnePass`;

  for (const r of recipients) {
    sendTelegramMessage(r.telegram_chat_id, text, { notify_type: 'student_return' });
  }
}

// ----------------------------------------------------------------------------
// Express Router
// ----------------------------------------------------------------------------
function createTelegramRouter(authenticateToken) {
  const express = require('express');
  const router = express.Router();

  // 1. Generate Pairing Link & Token (Expires 10m)
  router.post('/generate-link', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id || req.user.username;
      const username = req.user.username;
      const result = await createLinkToken(userId, username);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 1.5 Manual Link by Chat ID (ทางเลือกกรอก Chat ID ด้วยตนเอง)
  router.post('/manual-link', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id || req.user.username;
      const { chatId, telegramUsername } = req.body;
      const numericChatId = Number(chatId);
      if (!chatId || isNaN(numericChatId)) {
        return res.status(400).json({ success: false, message: 'กรุณากรอก Chat ID เป็นตัวเลขให้ถูกต้อง' });
      }

      const user = await linkTelegramAccount(userId, numericChatId, telegramUsername || 'Telegram User', 'Direct Link');
      const displayName = user ? (user.full_name || req.user.username) : req.user.username;

      // ส่งข้อความยืนยันเข้า Telegram ทันที
      await sendTelegramMessage(
        numericChatId,
        `🎉 <b>เชื่อมต่อบัญชี OnePass สำเร็จเรียบร้อยแล้ว!</b>\n\n` +
        `👤 <b>บัญชี:</b> ${displayName}\n` +
        `⏰ <b>เวลา:</b> ${new Date().toLocaleString('th-TH')}\n\n` +
        `ระบบจะส่งการแจ้งเตือนคำร้องและการผ่านประตูมาที่นี่ตลอดไปครับ`,
        { notify_type: 'account_linked' }
      );

      res.json({ success: true, message: 'เชื่อมต่อบัญชี Telegram สำเร็จเรียบร้อยแล้ว!', user });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 2. Get Telegram Connection Status & Preferences
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id || req.user.username;
      const user = await getUserTelegramInfo(userId);
      if (!user || !user.telegram_chat_id) {
        return res.json({
          connected: false,
          botUsername: getBotUsername(),
          hasBotToken: !!getBotToken()
        });
      }
      res.json({
        connected: true,
        chatId: user.telegram_chat_id,
        username: user.telegram_username,
        connectedAt: user.telegram_connected_at,
        settings: user.telegram_notify_settings || {
          pending_approval: true,
          request_result: true,
          qr_ready: true,
          parent_scan: true,
          gate_alert: true
        },
        botUsername: getBotUsername(),
        hasBotToken: !!getBotToken()
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 3. Disconnect Telegram Account
  router.post('/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id || req.user.username;
      await unlinkTelegramAccount(userId);
      res.json({ success: true, message: 'ยกเลิกการเชื่อมต่อ Telegram เรียบร้อยแล้ว' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 4. Update Notification Preferences
  router.post('/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id || req.user.username;
      const newSettings = req.body.settings;
      if (!newSettings || typeof newSettings !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid settings payload' });
      }

      if (supabaseClient) {
        await supabaseClient
          .from('users')
          .update({ telegram_notify_settings: newSettings })
          .eq('id', userId);
      }

      // Local fallback
      const profPath = path.join(DATA_DIR, 'profiles.json');
      if (fs.existsSync(profPath)) {
        const profs = JSON.parse(fs.readFileSync(profPath, 'utf8') || '{}');
        for (const k in profs) {
          if (profs[k].id === userId || profs[k].username === req.user.username) {
            profs[k].telegram_notify_settings = newSettings;
          }
        }
        fs.writeFileSync(profPath, JSON.stringify(profs, null, 2), 'utf8');
      }

      res.json({ success: true, settings: newSettings });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 5. Webhook endpoint (for production HTTPS)
  router.post('/webhook', async (req, res) => {
    try {
      await processTelegramUpdate(req.body);
      res.json({ ok: true });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 6. Simulation Test Endpoint (for local dev pairing test without real bot)
  router.post('/simulate-pairing', authenticateToken, async (req, res) => {
    try {
      const { token } = req.body;
      const userId = await verifyAndConsumeLinkToken(token);
      if (!userId) {
        return res.status(400).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุแล้ว' });
      }

      const mockChatId = 998877665;
      const mockTgUsername = `@Test_${req.user.username}`;
      const user = await linkTelegramAccount(userId, mockChatId, mockTgUsername, 'Simulated User');

      res.json({
        success: true,
        message: 'จำลองการเชื่อมต่อ Telegram สำเร็จ!',
        user
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}

// ----------------------------------------------------------------------------
// Module Initialization
// ----------------------------------------------------------------------------
function initTelegramBot(supabaseInstance) {
  supabaseClient = supabaseInstance;
  const token = getBotToken();
  if (token) {
    startBotPolling();
  } else {
    console.log('ℹ️ [TELEGRAM] Bot ready in Simulation Mode (Add TELEGRAM_BOT_TOKEN in .env to activate live bot)');
  }
}

module.exports = {
  initTelegramBot,
  createTelegramRouter,
  sendTelegramMessage,
  notifyApproverQueue,
  notifyApproverOverdueReminder,
  notifyStudentApproved,
  notifyStudentRejected,
  notifyScanGateEvent,
  notifyAdminAlert,
  notifyDisciplineStudentReturn,
  createLinkToken,
  getUserTelegramInfo
};
