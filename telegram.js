/**
 * OnePass Telegram Notification & Inline Approval Service
 * - Displays all dates in Thai Buddhist Era (พ.ศ.)
 * - Allows teachers and administrators to approve/reject directly in Telegram via Inline Buttons
 * - Sends official Digital Gate Pass QR Code directly in Telegram upon final approval
 * - Automatically notifies the student at EVERY step of the process
 * - Long-polling loop listens for button clicks without requiring public webhooks/tunnels!
 */

const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { query } = require('./db');

let cachedConfig = null;
let lastCacheTime = 0;
let isPollingStarted = false;
let lastUpdateId = 0;

// Thai Date & Time Formatters (พ.ศ.)
function formatThaiDate(dateStr) {
  if (!dateStr) return '-';
  const parts = String(dateStr).split('T')[0].split(' ')[0].split('-');
  const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    return `${d} ${thaiMonths[m]} ${y + 543}`;
  }
  const dt = new Date(dateStr);
  if (isNaN(dt.getTime())) return dateStr;
  return `${dt.getDate()} ${thaiMonths[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}

function formatThaiDateTime(dateTimeStr) {
  if (!dateTimeStr) return '-';
  const dt = new Date(dateTimeStr);
  if (isNaN(dt.getTime())) return dateTimeStr;
  const datePart = formatThaiDate(dt);
  const hours = String(dt.getHours()).padStart(2, '0');
  const minutes = String(dt.getMinutes()).padStart(2, '0');
  return `${datePart} เวลา ${hours}:${minutes} น.`;
}

async function getTelegramConfig() {
  const now = Date.now();
  if (cachedConfig && now - lastCacheTime < 30000) {
    return cachedConfig;
  }
  try {
    const [rows] = await query('SELECT bot_token, chat_id FROM telegram_settings WHERE id = 1 LIMIT 1');
    if (rows.length > 0 && rows[0].bot_token) {
      cachedConfig = {
        botToken: rows[0].bot_token.trim(),
        defaultChatId: rows[0].chat_id ? rows[0].chat_id.trim() : null
      };
      lastCacheTime = now;
      return cachedConfig;
    }
  } catch (e) {
    console.error('[Telegram] Error reading telegram_settings:', e.message);
  }

  return {
    botToken: '9171059639:AAFnCl0tqD356M2UsY6Q8tVO1vvlnruy4-c',
    defaultChatId: '8527824695'
  };
}

/**
 * Send Telegram message with optional Inline Keyboard
 */
async function sendTelegramMessage(chatId, text, inlineKeyboard = null) {
  const config = await getTelegramConfig();
  const targetChatId = chatId || config.defaultChatId;

  if (!config.botToken || !targetChatId) {
    console.log('[Telegram] Missing bot token or target chat_id, skipped.');
    return null;
  }

  const payloadObj = {
    chat_id: targetChatId,
    text: text,
    parse_mode: 'HTML'
  };

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    payloadObj.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  const payload = JSON.stringify(payloadObj);

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${config.botToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            console.log(`[Telegram] Sent successfully to ${targetChatId} (Msg ID: ${json.result.message_id})`);
            resolve(json.result);
          } else {
            console.warn(`[Telegram] API error:`, json.description);
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Telegram] Network request error:`, err.message);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send Telegram Photo (Multipart / form-data)
 */
async function sendTelegramPhoto(chatId, photoBuffer, caption = '') {
  const config = await getTelegramConfig();
  const targetChatId = chatId || config.defaultChatId;
  if (!config.botToken || !targetChatId || !photoBuffer) return null;

  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
  const crlf = '\r\n';
  let body = [];

  body.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="chat_id"${crlf}${crlf}${targetChatId}${crlf}`));

  if (caption) {
    body.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="caption"${crlf}${crlf}${caption}${crlf}`));
    body.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="parse_mode"${crlf}${crlf}HTML${crlf}`));
  }

  body.push(Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="photo"; filename="onepass_qr.png"${crlf}Content-Type: image/png${crlf}${crlf}`));
  body.push(photoBuffer);
  body.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));

  const payload = Buffer.concat(body);

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${config.botToken}/sendPhoto`,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': payload.length
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            console.log(`[Telegram] QR Code Photo sent successfully to ${targetChatId} (Msg ID: ${json.result.message_id})`);
            resolve(json.result);
          } else {
            console.warn(`[Telegram] sendPhoto API error:`, json.description);
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Telegram] sendPhoto Network error:`, err.message);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Edit an existing message in Telegram
 */
async function editTelegramMessage(chatId, messageId, newText) {
  const config = await getTelegramConfig();
  if (!config.botToken || !chatId || !messageId) return;

  const payload = JSON.stringify({
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'HTML'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${config.botToken}/editMessageText`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

/**
 * Answer Telegram callback query (closes loading spinner)
 */
async function answerCallbackQuery(queryId, text = '', showAlert = false) {
  const config = await getTelegramConfig();
  if (!config.botToken || !queryId) return;

  const payload = JSON.stringify({
    callback_query_id: queryId,
    text: text,
    show_alert: showAlert
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${config.botToken}/answerCallbackQuery`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

/**
 * Get user's preferred chat_id or fallback
 */
async function getUserChatId(userId) {
  try {
    const [rows] = await query('SELECT telegram_chat_id FROM users WHERE id = ? LIMIT 1', [userId]);
    if (rows.length > 0 && rows[0].telegram_chat_id) {
      return rows[0].telegram_chat_id.trim();
    }
  } catch (e) {}
  const cfg = await getTelegramConfig();
  return cfg.defaultChatId;
}

// -------------------------------------------------------------
// WORKFLOW NOTIFICATIONS (WITH INLINE APPROVAL BUTTONS)
// -------------------------------------------------------------

/**
 * 1. Student creates new leave request
 */
async function notifyRequestCreated(request, studentUser, subjectTeacherUser) {
  const studentChatId = await getUserChatId(studentUser.id);
  const teacherChatId = await getUserChatId(subjectTeacherUser.id);

  const thaiLeaveDate = formatThaiDate(request.leave_date);
  const thaiSubmitTime = formatThaiDateTime(new Date());

  // A) Notify Student (ทุกลำดับ - ไม่มีปุ่มอนุมัติใดๆ)
  const studentMsg = 
`🎓 <b>[การแจ้งเตือนสำหรับผู้เรียน] OnePass</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้ขอ:</b> ${studentUser.full_name} (${studentUser.username})
📅 <b>วันที่ขอออก:</b> ${thaiLeaveDate} เวลา ${request.leave_time} น.
📝 <b>ประเภท:</b> ${request.is_not_returning ? 'ออกแล้วไม่กลับ (กลับบ้าน)' : 'ออกชั่วคราว'}
💡 <b>เหตุผล:</b> ${request.reason} ${request.reason_detail ? '(' + request.reason_detail + ')' : ''}
🕒 <b>เวลาที่ส่งคำขอ:</b> ${thaiSubmitTime}
━━━━━━━━━━━━━━━━━━━━
⏳ <b>สถานะปัจจุบัน:</b> ส่งคำขอเรียบร้อยแล้ว อยู่ระหว่างรอครูรายวิชา (<b>${subjectTeacherUser.full_name}</b>) พิจารณาอนุมัติ (ลำดับที่ 1/5)
ℹ️ <i>(ข้อความนี้เป็นการแจ้งเตือนสถานะสำหรับนักเรียนเท่านั้น ไม่มีปุ่มอนุมัติ)</i>`;

  await sendTelegramMessage(studentChatId, studentMsg);

  // B) Notify Subject Teacher WITH INLINE BUTTONS (เฉพาะคุณครูผู้มีอำนาจเท่านั้น)
  const teacherMsg = 
`🧑‍🏫 <b>[สำหรับคุณครูผู้สอน / ผู้มีอำนาจลงนามเท่านั้น]</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้เรียนที่ขอออก:</b> ${studentUser.full_name} (${studentUser.username})
📅 <b>วันที่ขอออก:</b> ${thaiLeaveDate} เวลา ${request.leave_time} น.
💡 <b>เหตุผล:</b> ${request.reason} ${request.reason_detail ? '(' + request.reason_detail + ')' : ''}
🕒 <b>เวลายื่น:</b> ${thaiSubmitTime}
━━━━━━━━━━━━━━━━━━━━
👉 <b>เรียน:</b> ${subjectTeacherUser.full_name} (ครูรายวิชา - ลำดับที่ 1/5)
⚠️ <i>เฉพาะคุณครูที่มีรายชื่อข้างต้นเท่านั้นที่มีสิทธิ์กดปุ่มด้านล่าง (นักเรียนไม่มีสิทธิ์อนุมัติ):</i>`;

  const inlineKeyboard = [
    [
      { text: '✅ อนุมัติคำขอ (ในนามครูผู้สอน)', callback_data: `appr:${request.id}:subject_teacher` },
      { text: '❌ ไม่อนุมัติ', callback_data: `rejt:${request.id}:subject_teacher` }
    ]
  ];

  await sendTelegramMessage(teacherChatId, teacherMsg, inlineKeyboard);
}

/**
 * 2. Approver performs action (Approve / Reject)
 */
async function notifyApprovalAction({
  request,
  actorRole,
  actorName,
  decision,
  comment,
  studentUser,
  nextApproverUser,
  isFullyApproved
}) {
  const studentChatId = await getUserChatId(studentUser.id);

  const roleLabels = {
    subject_teacher: '1. ครูรายวิชา',
    advisor: '2. ครูที่ปรึกษา',
    head_major: '3. หัวหน้าแผนกวิชา',
    head_discipline: '4. หัวหน้างานปกครอง',
    deputy_director: '5. รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา'
  };
  const roleLabel = roleLabels[actorRole] || actorRole;
  const thaiNow = formatThaiDateTime(new Date());
  const thaiLeaveDate = formatThaiDate(request.leave_date);

  // Case A: REJECTED
  if (decision === 'reject') {
    const rejectMsg = 
`❌ <b>[OnePass] คำขอออกนอกสถานศึกษา "ไม่อนุมัติ"</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้ขอ:</b> ${studentUser.full_name} (${studentUser.username})
🚫 <b>พิจารณาโดย:</b> ${roleLabel} (${actorName})
🕒 <b>เวลาที่ไม่อนุมัติ:</b> ${thaiNow}
💬 <b>เหตุผล:</b> ${comment || 'ไม่อนุมัติ'}
━━━━━━━━━━━━━━━━━━━━
⚠️ คำขอนี้สิ้นสุดลงแล้วและไม่สามารถใช้งานผ่านประตูได้`;

    await sendTelegramMessage(studentChatId, rejectMsg);
    return;
  }

  // Case B: FULLY APPROVED (All 5 stages completed) -> SEND QR CODE PHOTO DIRECTLY TO TELEGRAM!
  if (isFullyApproved) {
    const qrToken = request.qr_token || ('OP-' + crypto.randomBytes(8).toString('hex').toUpperCase());
    const expDate = request.qr_expires_at ? new Date(request.qr_expires_at) : new Date(Date.now() + 30 * 60 * 1000);
    const thaiExpiresTime = formatThaiDateTime(expDate);

    const approvedCaption = 
`🎉 <b>[OnePass] บัตรผ่านดิจิทัล (Digital Gate Pass)</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้ขอ:</b> ${studentUser.full_name} (${studentUser.username})
📅 <b>วันที่อนุญาตให้ออก:</b> ${thaiLeaveDate} เวลา ${request.leave_time} น.
📝 <b>ประเภท:</b> ${request.is_not_returning ? 'ออกแล้วไม่กลับ (กลับบ้าน)' : 'ออกชั่วคราว'}
🔑 <b>รหัสบัตรผ่าน (Token):</b> <code>${qrToken}</code>
✅ <b>อนุมัติครบทั้ง 5 ระดับเรียบร้อยแล้ว</b>
👑 <b>ผู้อนุมัติขั้นสุดท้าย:</b> ${actorName} (รอง ผอ. ฝ่ายกิจการฯ)
🕒 <b>เวลาอนุมัติ:</b> ${thaiNow}
━━━━━━━━━━━━━━━━━━━━
⏳ <b>อายุการใช้งาน QR Code: 30 นาที</b>
⚠️ <b>หมดอายุเวลา: ${thaiExpiresTime}</b>
<i>(หากไม่สแกนออกภายใน 30 นาที QR Code จะถูกทำลายอัตโนมัติ และต้องยื่นขออนุญาตใหม่)</i>
━━━━━━━━━━━━━━━━━━━━
📱 <b>คำแนะนำ:</b> ยื่นภาพ QR Code ด้านบนนี้ให้เครื่องสแกนที่ตู้ประตูเพื่อยกไม้กั้นอัตโนมัติได้ทันที`;

    try {
      const qrBuffer = await QRCode.toBuffer(qrToken, { width: 450, margin: 2 });
      await sendTelegramPhoto(studentChatId, qrBuffer, approvedCaption);
    } catch (e) {
      console.error('[Telegram] Error sending QR Code Photo:', e.message);
      await sendTelegramMessage(studentChatId, approvedCaption);
    }
    return;
  }

  // Case C: APPROVED STEP (Advancing to next approver)
  const stepApprovedMsg = 
`✅ <b>[OnePass] อัปเดตสถานะคำขอ (ผ่านระดับ ${roleLabel} แล้ว)</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้ขอ:</b> ${studentUser.full_name} (${studentUser.username})
ผู้ลงนาม: ${roleLabel} (${actorName}) - อนุมัติเรียบร้อย
🕒 <b>เวลาที่ลงนาม:</b> ${thaiNow}
💬 <b>ความเห็น:</b> ${comment || 'อนุมัติ'}
━━━━━━━━━━━━━━━━━━━━
⏳ <b>ขั้นตอนถัดไป:</b> ส่งต่อไปยัง <b>${nextApproverUser ? nextApproverUser.full_name : 'ผู้มีอำนาจลำดับถัดไป'}</b> เพื่อพิจารณาอนุมัติ`;

  // Always notify Student at this step!
  await sendTelegramMessage(studentChatId, stepApprovedMsg);

  // Notify the NEXT approver in line WITH INLINE BUTTONS!
  if (nextApproverUser) {
    const nextApproverChatId = await getUserChatId(nextApproverUser.id);
    let nextRole = 'advisor';
    let stepTitle = 'ครูที่ปรึกษา (ลำดับที่ 2/5)';
    if (actorRole === 'subject_teacher') { nextRole = 'advisor'; stepTitle = 'ครูที่ปรึกษา (ลำดับที่ 2/5)'; }
    else if (actorRole === 'advisor') { nextRole = 'head_major'; stepTitle = 'หัวหน้าแผนก (ลำดับที่ 3/5)'; }
    else if (actorRole === 'head_major') { nextRole = 'head_discipline'; stepTitle = 'หัวหน้างานปกครอง (ลำดับที่ 4/5)'; }
    else if (actorRole === 'head_discipline') { nextRole = 'deputy_director'; stepTitle = 'รอง ผอ. ฝ่ายกิจการฯ (ลำดับที่ 5/5)'; }

    const nextMsg = 
`🧑‍🏫 <b>[สำหรับคุณครูผู้สอน / ผู้มีอำนาจลงนามเท่านั้น]</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้เรียนที่ขอออก:</b> ${studentUser.full_name} (${studentUser.username})
(ผ่านการพิจารณาอนุมัติจาก ${roleLabel} แล้ว)
📅 <b>วันที่ขอออก:</b> ${thaiLeaveDate} เวลา ${request.leave_time} น.
💡 <b>เหตุผล:</b> ${request.reason}
🕒 <b>เวลาที่ส่งต่อ:</b> ${thaiNow}
━━━━━━━━━━━━━━━━━━━━
👉 <b>เรียน:</b> ${nextApproverUser.full_name} (${stepTitle})
⚠️ <i>เฉพาะคุณครูที่มีรายชื่อข้างต้นเท่านั้นที่มีสิทธิ์กดปุ่มด้านล่าง (นักเรียนไม่มีสิทธิ์อนุมัติ):</i>`;

    const inlineKeyboard = [
      [
        { text: `✅ อนุมัติคำขอ (ในนาม ${stepTitle.split(' ')[0]})`, callback_data: `appr:${request.id}:${nextRole}` },
        { text: '❌ ไม่อนุมัติ', callback_data: `rejt:${request.id}:${nextRole}` }
      ]
    ];

    await sendTelegramMessage(nextApproverChatId, nextMsg, inlineKeyboard);
  }
}

/**
 * 3. Gate Staff records student exit / return
 */
async function notifyGateRecord(request, studentUser, actionType, timestamp) {
  const studentChatId = await getUserChatId(studentUser.id);
  const thaiTimeStr = formatThaiDateTime(timestamp);

  let msg = '';
  if (actionType === 'exit') {
    msg = 
`🚶 <b>[OnePass] บันทึกเวลาออกจากสถานศึกษา</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้เรียน:</b> ${studentUser.full_name} (${studentUser.username})
⏱️ <b>เวลาออกจากประตูจริง:</b> ${thaiTimeStr}
👮 เจ้าหน้าที่เวรประตูได้บันทึกเวลาออกเรียบร้อยแล้ว`;
  } else {
    msg = 
`🏠 <b>[OnePass] บันทึกเวลากลับเข้าสถานศึกษาเรียบร้อยแล้ว</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${request.request_no}</code>
👤 <b>ผู้เรียน:</b> ${studentUser.full_name} (${studentUser.username})
⏱️ <b>เวลากลับเข้าประตูจริง:</b> ${thaiTimeStr}
✅ <b>สถานะคำขอ: สิ้นสุดสมบูรณ์ (Completed)</b> ขอบคุณที่ปฏิบัติตามระเบียบของสถานศึกษา`;
  }

  await sendTelegramMessage(studentChatId, msg);
}

// -------------------------------------------------------------
// TELEGRAM INLINE APPROVAL LISTENER (LONG-POLLING)
// -------------------------------------------------------------

/**
 * Process a button tap from Telegram (callback_query)
 */
async function handleTelegramCallbackQuery(callbackQuery) {
  const queryId = callbackQuery.id;
  const fromUser = callbackQuery.from;
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const data = callbackQuery.data; // e.g. "appr:15:subject_teacher" or "rejt:15:advisor"

  console.log(`[Telegram] Received button tap from ${fromUser.first_name} (${fromUser.id}): ${data}`);

  if (!data || (!data.startsWith('appr:') && !data.startsWith('rejt:'))) {
    await answerCallbackQuery(queryId, 'คำสั่งไม่ถูกต้อง');
    return;
  }

  const [action, reqIdStr, roleActed] = data.split(':');
  const requestId = parseInt(reqIdStr, 10);
  const isApprove = (action === 'appr');

  if (!requestId || isNaN(requestId)) {
    console.error(`[Telegram] Invalid requestId in callback data: ${data}`);
    await answerCallbackQuery(queryId, 'รหัสคำขอไม่ถูกต้อง');
    await editTelegramMessage(chatId, messageId, '⚠️ ไม่พบรหัสคำขอที่ถูกต้อง หรือคำขอนี้ถูกสร้างขึ้นก่อนการอัปเดตระบบ กรุณาสร้างคำขอใหม่');
    return;
  }

  await answerCallbackQuery(queryId, isApprove ? 'กำลังดำเนินการอนุมัติ...' : 'กำลังดำเนินการไม่อนุมัติ...');

  try {
    // 1. Fetch current request
    const [rows] = await query('SELECT * FROM onepass_requests WHERE id = ? LIMIT 1', [requestId]);
    if (rows.length === 0) {
      await editTelegramMessage(chatId, messageId, '⚠️ ไม่พบคำขอนี้ในระบบ หรือคำขอถูกลบไปแล้ว');
      return;
    }

    const current = rows[0];

    // Security check: If telegram user is linked to a user in the system
    const [linkedUsers] = await query('SELECT id, role, full_name, username FROM users WHERE telegram_chat_id = ? LIMIT 1', [String(fromUser.id)]);
    if (linkedUsers.length > 0) {
      const clicker = linkedUsers[0];
      if (clicker.id === current.user_id || clicker.role === 'student') {
        console.warn(`[Telegram Security] Blocked student ${clicker.username} (${clicker.full_name}) from approving request ${requestId}`);
        await answerCallbackQuery(queryId, '⛔ คุณคือนักเรียนผู้ยื่นคำขอ ไม่มีสิทธิ์ในการอนุมัติคำขอของตนเองหรือผู้อื่น', true);
        return;
      }

      const isAdmin = ['admin', 'super_admin'].includes(clicker.role);
      if (!isAdmin) {
        let isAuthorized = false;
        if (roleActed === 'subject_teacher' && current.subject_teacher_id === clicker.id) isAuthorized = true;
        else if (roleActed === 'advisor' && current.advisor_teacher_id === clicker.id) isAuthorized = true;
        else if (roleActed === 'head_major' && current.head_major_teacher_id === clicker.id) isAuthorized = true;
        else if (roleActed === 'head_discipline' && current.head_discipline_user_id === clicker.id) isAuthorized = true;
        else if (roleActed === 'deputy_director' && current.deputy_director_user_id === clicker.id) isAuthorized = true;

        if (!isAuthorized) {
          console.warn(`[Telegram Security] Blocked user ${clicker.username} from approving role ${roleActed} for request ${requestId}`);
          await answerCallbackQuery(queryId, `⛔ ท่านไม่มีสิทธิ์พิจารณาในขั้นตอนนี้ (${config.label})`, true);
          return;
        }
      }
    }

    // Check if already processed
    if (['approved', 'rejected', 'completed', 'cancelled'].includes(current.status)) {
      await editTelegramMessage(chatId, messageId, `⚠️ คำขอนี้ได้รับการดำเนินการเสร็จสิ้นไปแล้ว (สถานะปัจจุบัน: ${current.status})`);
      return;
    }

    const roleMap = {
      subject_teacher: { prefix: 'subject', nextStatus: 'pending_advisor', label: 'ครูรายวิชา' },
      advisor: { prefix: 'advisor', nextStatus: 'pending_head_major', label: 'ครูที่ปรึกษา' },
      head_major: { prefix: 'head_major', nextStatus: 'pending_head_discipline', label: 'หัวหน้าแผนกวิชา' },
      head_discipline: { prefix: 'head_discipline', nextStatus: 'pending_deputy', label: 'หัวหน้างานปกครอง' },
      deputy_director: { prefix: 'deputy_director', nextStatus: 'approved', label: 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา' }
    };

    const config = roleMap[roleActed];
    if (!config) {
      await editTelegramMessage(chatId, messageId, '⚠️ บทบาทผู้ลงนามไม่ถูกต้อง');
      return;
    }

    // Check if already signed this tier
    if (current[`${config.prefix}_status`] === 'approved' || current[`${config.prefix}_status`] === 'rejected') {
      await editTelegramMessage(chatId, messageId, `ℹ️ ขั้นตอนนี้ (${config.label}) ได้รับการพิจารณาไปแล้ว`);
      return;
    }

    const now = new Date();
    const updateFields = [];
    const updateParams = [];
    const decisionStatus = isApprove ? 'approved' : 'rejected';
    const comment = isApprove ? 'อนุมัติผ่าน Telegram' : 'ไม่อนุมัติผ่าน Telegram';

    updateFields.push(`\`${config.prefix}_status\` = ?`, `\`${config.prefix}_comment\` = ?`, `\`${config.prefix}_action_at\` = ?`);
    updateParams.push(decisionStatus, comment, now);

    let newStatus = current.status;
    let qrToken = current.qr_token;
    let qrExpiresAt = current.qr_expires_at;

    if (!isApprove) {
      newStatus = 'rejected';
    } else {
      newStatus = config.nextStatus;
      if (newStatus === 'approved') {
        qrToken = 'OP-' + crypto.randomBytes(8).toString('hex').toUpperCase();
        // QR Code expires in exactly 30 minutes from approval!
        const expDate = new Date(Date.now() + 30 * 60 * 1000);
        const pad = n => String(n).padStart(2, '0');
        qrExpiresAt = `${expDate.getFullYear()}-${pad(expDate.getMonth()+1)}-${pad(expDate.getDate())} ${pad(expDate.getHours())}:${pad(expDate.getMinutes())}:${pad(expDate.getSeconds())}`;
      }
    }

    updateFields.push('`status` = ?');
    updateParams.push(newStatus);

    if (qrToken && !current.qr_token) {
      updateFields.push('`qr_token` = ?', '`qr_expires_at` = ?');
      updateParams.push(qrToken, qrExpiresAt);
    }

    updateParams.push(requestId);
    await query(`UPDATE onepass_requests SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);

    // Find actor user id
    let actorUserId = null;
    if (roleActed === 'subject_teacher') actorUserId = current.subject_teacher_id;
    else if (roleActed === 'advisor') actorUserId = current.advisor_teacher_id;
    else if (roleActed === 'head_major') actorUserId = current.head_major_teacher_id;
    else if (roleActed === 'head_discipline') actorUserId = current.head_discipline_user_id;
    else if (roleActed === 'deputy_director') actorUserId = current.deputy_director_user_id;

    // Log action
    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, ?, ?, ?)
    `, [requestId, actorUserId || 1, roleActed, isApprove ? 'approved' : 'rejected', `[${config.label}] ${comment}`]);

    // Edit original message in Telegram to show completed action
    const actorName = fromUser.first_name + (fromUser.last_name ? ' ' + fromUser.last_name : '');
    const thaiSignTime = formatThaiDateTime(now);
    const updatedOriginalMsg = isApprove
      ? `✅ <b>[OnePass] ท่านได้ "อนุมัติคำขอ" เรียบร้อยแล้วผ่าน Telegram</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${current.request_no}</code>
👤 <b>ผู้ลงนาม:</b> ${config.label} (${actorName})
🕒 <b>เวลาที่บันทึก:</b> ${thaiSignTime}
⏳ <b>สถานะล่าสุด:</b> ${newStatus === 'approved' ? 'อนุมัติครบ 5 ระดับแล้ว (ออกบัตรผ่าน QR ให้ผู้เรียนแล้ว)' : 'ส่งต่อไปยังขั้นถัดไปเรียบร้อยแล้ว'}`
      : `❌ <b>[OnePass] ท่านได้บันทึก "ไม่อนุมัติ" คำขอนี้แล้วผ่าน Telegram</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${current.request_no}</code>
👤 <b>ผู้ลงนาม:</b> ${config.label} (${actorName})
🕒 <b>เวลาที่บันทึก:</b> ${thaiSignTime}
⚠️ <b>สถานะ:</b> คำขอถูกปฏิเสธ`;

    await editTelegramMessage(chatId, messageId, updatedOriginalMsg);

    // Trigger next notifications (Student + Next Approver)
    const [studentRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [current.user_id]);
    let nextApproverUser = null;

    if (isApprove && newStatus !== 'approved') {
      let nextApproverId = null;
      if (roleActed === 'subject_teacher') nextApproverId = current.advisor_teacher_id;
      else if (roleActed === 'advisor') nextApproverId = current.head_major_teacher_id;
      else if (roleActed === 'head_major') nextApproverId = current.head_discipline_user_id;
      else if (roleActed === 'head_discipline') nextApproverId = current.deputy_director_user_id;

      if (nextApproverId) {
        const [nextRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [nextApproverId]);
        if (nextRows.length > 0) nextApproverUser = nextRows[0];
      }
    }

    if (studentRows.length > 0) {
      await notifyApprovalAction({
        request: { ...current, qr_token: qrToken || current.qr_token },
        actorRole: roleActed,
        actorName: `${config.label} (${actorName})`,
        decision: isApprove ? 'approve' : 'reject',
        comment: comment,
        studentUser: studentRows[0],
        nextApproverUser: nextApproverUser,
        isFullyApproved: (newStatus === 'approved')
      });
    }

    console.log(`[Telegram] Successfully processed ${action} for request ${requestId} via Telegram button!`);
  } catch (err) {
    console.error('[Telegram] Error processing callback query:', err);
    await editTelegramMessage(chatId, messageId, '⚠️ เกิดข้อผิดพลาดในการประมวลผลคำขอ: ' + err.message);
  }
}

/**
 * Handle incoming text messages (e.g. /start)
 */
async function handleTelegramMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/start') {
    const welcomeText = 
`👋 <b>ยินดีต้อนรับสู่ OnePass Bot</b>
ระบบขออนุญาตออกนอกสถานศึกษา ด้วยระบบ QR Code
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Chat ID ของท่านคือ:</b> <code>${chatId}</code>
━━━━━━━━━━━━━━━━━━━━
ℹ️ <b>วิธีใช้งาน:</b>
1. นำ Chat ID ด้านบนไปกรอกในระบบข้อมูลผู้ใช้ หรือตั้งค่าระบบ OnePass เพื่อรับการแจ้งเตือน
2. เมื่อมีคำขอถึงท่าน ระบบจะส่งการแจ้งเตือนมายังห้องแชทนี้โดยอัตโนมัติ
3. ผู้มีอำนาจสามารถกดปุ่ม [อนุมัติ] หรือ [ไม่อนุมัติ] ได้ทันทีผ่าน Telegram นี้
4. เมื่อคำขออนุมัติครบสาย ผู้เรียนจะได้รับรูปภาพ <b>QR Code บัตรผ่านดิจิทัล</b> ทาง Telegram ทันที เพื่อนำไปสแกนที่ป้อมยามหน้าประตู`;

    await sendTelegramMessage(chatId, welcomeText);
  }
}

/**
 * Start Background Polling Loop for Telegram Bot
 */
async function startTelegramPolling() {
  if (isPollingStarted) return;
  isPollingStarted = true;

  console.log('[Telegram] Background Polling Listener started (Listening for button approvals)...');

  const poll = async () => {
    try {
      const config = await getTelegramConfig();
      if (!config.botToken) {
        setTimeout(poll, 5000);
        return;
      }

      const url = `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;

      https.get(url, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', async () => {
          try {
            const data = JSON.parse(rawData);
            if (data.ok && Array.isArray(data.result)) {
              for (const update of data.result) {
                lastUpdateId = Math.max(lastUpdateId, update.update_id);

                // Handle button click (callback_query)
                if (update.callback_query) {
                  await handleTelegramCallbackQuery(update.callback_query);
                }

                // Handle text message (/start)
                if (update.message) {
                  await handleTelegramMessage(update.message);
                }
              }
            }
          } catch (e) {}
          setTimeout(poll, 1000);
        });
      }).on('error', (err) => {
        setTimeout(poll, 3000);
      });
    } catch (err) {
      setTimeout(poll, 5000);
    }
  };

  poll();
}

module.exports = {
  formatThaiDate,
  formatThaiDateTime,
  getUserChatId,
  sendTelegramMessage,
  sendTelegramPhoto,
  notifyRequestCreated,
  notifyApprovalAction,
  notifyGateRecord,
  startTelegramPolling
};
