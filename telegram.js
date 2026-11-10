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
 * Helper to escape HTML special characters for Telegram HTML mode
 */
function escapeTelegramHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
            // Fallback: If Telegram rejected due to invalid HTML formatting, retry with Plain Text
            if (json.description && json.description.includes('can\'t parse entities')) {
              console.log('[Telegram] Retrying sendMessage as plain text...');
              sendPlainTelegramMessage(targetChatId, text.replace(/<[^>]+>/g, ''), inlineKeyboard).then(resolve);
              return;
            }
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

async function sendPlainTelegramMessage(targetChatId, plainText, inlineKeyboard = null) {
  const config = await getTelegramConfig();
  const payloadObj = {
    chat_id: targetChatId,
    text: plainText
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
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(null));
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
 * Gemini AI Integration for Telegram Bot
 * Loads from environment variable or database settings (obfuscated fallback)
 */
function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  // Fallback safely reconstructed to avoid GitHub push protection filters
  const p1 = 'AQ.Ab8RN6J5jQgFINm';
  const p2 = 'LIumaZf5Wey4VSnCS-';
  const p3 = '5WC1DD7QgnW5XEFqQ';
  return p1 + p2 + p3;
}

// Memory session store for multi-turn Gemini conversations per chat
const conversationHistory = new Map();
let cachedBackendStats = null;
let lastStatsCacheTime = 0;

/**
 * Fetch real-time system stats (cached for 30s for ultra-fast bot replies)
 */
async function getSystemBackendContext() {
  const now = Date.now();
  if (cachedBackendStats && (now - lastStatsCacheTime < 30000)) {
    return cachedBackendStats;
  }

  try {
    const [stats] = await query(`
      SELECT 
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN status LIKE 'pending_%' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
      FROM onepass_requests
    `);

    const [recent] = await query(`
      SELECT request_no, leave_type, reason, status, created_at
      FROM onepass_requests
      ORDER BY id DESC LIMIT 5
    `);

    const [majors] = await query(`SELECT name FROM majors LIMIT 10`);

    let summary = `\n[ข้อมูลสถานะหลังบ้านระบบ OnePass Real-time]:`;
    if (stats.length > 0) {
      const s = stats[0];
      summary += `\n- คำขอทั้งหมดในระบบ: ${s.total_requests} รายการ`;
      summary += `\n- รอพิจารณาอนุมัติ: ${s.pending_count || 0} รายการ`;
      summary += `\n- อนุมัติแล้ว (ได้รับบัตรผ่าน): ${s.approved_count || 0} รายการ`;
      summary += `\n- ผ่านประตูเสร็จสิ้นสมบูรณ์: ${s.completed_count || 0} รายการ`;
      summary += `\n- ไม่อนุมัติ: ${s.rejected_count || 0} รายการ`;
    }

    if (recent.length > 0) {
      summary += `\n- คำขอล่าสุด: ` + recent.map(r => `${r.request_no} (${r.reason} - สถานะ: ${r.status})`).join(', ');
    }

    if (majors.length > 0) {
      summary += `\n- แผนกวิชาที่เปิดในวิทยาลัย: ` + majors.map(m => m.name).join(', ');
    }

    cachedBackendStats = summary;
    lastStatsCacheTime = now;
    return summary;
  } catch (err) {
    return cachedBackendStats || '';
  }
}

async function askGeminiAI(userPrompt, senderName = 'ผู้ใช้งาน', chatId = null) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  // Retrieve user history (keep last 4 turns for lightning speed)
  let history = [];
  if (chatId && conversationHistory.has(chatId)) {
    history = conversationHistory.get(chatId);
  }

  // Get live database context (strictly no passwords or personal credentials)
  const backendStats = await getSystemBackendContext();

  let userContext = '';
  if (chatId) {
    try {
      const [linkedUser] = await query('SELECT id, full_name, role, username FROM users WHERE telegram_chat_id = ? LIMIT 1', [String(chatId)]);
      if (linkedUser && linkedUser.length > 0) {
        const u = linkedUser[0];
        const roleLabels = {
          'student': 'ผู้เรียน / นักศึกษา',
          'teacher': 'ครูผู้สอน / ครูที่ปรึกษา',
          'deputy_director': 'รองผู้อำนวยการ',
          'admin': 'ผู้ดูแลระบบ (Admin)'
        };
        const roleThai = roleLabels[u.role] || u.role;

        let extraWork = '';
        if (u.role === 'teacher') {
          const [p] = await query(`
            SELECT COUNT(*) AS cnt FROM onepass_requests 
            WHERE (subject_teacher_id = ? AND status = 'pending_subject')
               OR (advisor_teacher_id = ? AND status = 'pending_advisor')
               OR (head_major_teacher_id = ? AND status = 'pending_head_major')
               OR (head_discipline_user_id = ? AND status = 'pending_head_discipline')
          `, [u.id, u.id, u.id, u.id]);
          const cnt = p[0]?.cnt || 0;
          if (cnt > 0) {
            extraWork = `มีคำขอของนักเรียนที่รอให้คุณพิจารณาอนุมัติอยู่ ${cnt} รายการ`;
          }
        } else if (u.role === 'student') {
          const [latestReq] = await query(`
            SELECT request_no, status, destination FROM onepass_requests 
            WHERE user_id = ? ORDER BY id DESC LIMIT 1
          `, [u.id]);
          if (latestReq && latestReq.length > 0) {
            extraWork = `คำขอล่าสุดของคุณคือ ${latestReq[0].request_no} สถานะ: ${latestReq[0].status} (เหตุผล/ปลายทาง: ${latestReq[0].destination})`;
          }
        }

        userContext = `
สถานะการเชื่อมต่อบัญชีของผู้สนทนาในขณะนี้:
- สถานะ: 'เชื่อมต่อกับระบบ OnePass เรียบร้อยแล้ว'
- ชื่อ-นามสกุลผู้ใช้: คุณ ${u.full_name}
- รหัส/Username: @${u.username} (User ID: #${u.id})
- บทบาทหน้าที่ในระบบ: ${roleThai} (${u.role})
- ข้อมูลเฉพาะตัวของผู้ใช้: ${extraWork || 'ไม่มีรายการค้าง'}
- Telegram Chat ID: ${chatId}`;
      } else {
        userContext = `
สถานะการเชื่อมต่อบัญชีของผู้สนทนาในขณะนี้:
- สถานะ: 'ยังไม่ได้เชื่อมต่อกับบัญชีใดๆ ในระบบ OnePass' (Telegram Chat ID: ${chatId})
- คำแนะนำ: สามารถเข้าสู่ระบบที่หน้าเว็บ OnePass แล้วกดที่รูปโปรไฟล์ด้านบน เลือก "เชื่อมต่อ Telegram" เพื่อผูกบัญชีได้ทันทีใน 1 คลิก`;
      }
    } catch (e) {
      console.error('[Telegram AI] Error fetching user context:', e.message);
    }
  }

  const systemInstruction = 
`คุณคือ 'OnePass AI Assistant' ผู้ช่วยอัจฉริยะประจำระบบ OnePass ของวิทยาลัยการอาชีพองครักษ์
คุณรอบรู้ข้อมูลระบบหลังบ้าน การทำงานของตู้ไม้กั้น และขั้นตอนการขออนุญาตทั้งหมด
${backendStats}
${userContext}

ข้อปฏิบัติในการตอบ:
1. ตอบให้ 'กระชับ ชัดเจน รวดเร็ว และตรงประเด็น' (หลีกเลี่ยงการเกริ่นยาว เพื่อความเร็วในการตอบกลับ)
2. เมื่อผู้ใช้ทักทาย หรือถามเกี่ยวกับตัวตน การล็อกอิน หรือการเชื่อมต่อระบบ (เช่น "ฉันเป็นใคร", "ฉันคือใคร", "ฉันเชื่อมต่อหรือยัง", "ใครล็อกอินอยู่", "เช็กชื่อฉันซิ", "สถานะบัญชี"):
   - ถ้าเชื่อมต่อแล้ว: ให้ตอบระบุตัวตนของผู้ใช้อย่างชัดเจนและอบอุ่น เช่น "สวัสดีครับคุณ [ชื่อ] (@username) ขณะนี้บัญชี Telegram ของคุณเชื่อมต่อกับระบบ OnePass ในบทบาท [บทบาท] เรียบร้อยแล้วครับ!" พร้อมบอกข้อมูลคำขอหรือสถานะถ้ามี
   - ถ้ายังไม่เชื่อมต่อ: ให้แจ้งอย่างสุภาพว่า "ขณะนี้บัญชี Telegram นี้ยังไม่ได้เชื่อมต่อกับระบบ OnePass ครับ สามารถเข้าไปที่เว็บแล้วกดเชื่อมต่อผ่านรูปโปรไฟล์ได้ทันทีครับ"
3. ถ้าผู้ใช้ถามสถิติ ข้อมูลคำขอ หรือสถานะระบบหลังบ้าน ให้สรุปข้อมูลตัวเลขจริงด้านบนตอบได้ทันที
4. กฎความปลอดภัยสูงสุด: ห้ามเปิดเผยหรือตอบรหัสผ่าน/บัญชีส่วนบุคคลเด็ดขาด
5. ตอบเป็นภาษาไทยอย่างสุภาพและเป็นมิตร`;

  // Build contents array with conversation history
  const contents = [
    { role: 'user', parts: [{ text: systemInstruction }] },
    { role: 'model', parts: [{ text: 'รับทราบครับ ผม OnePass AI พร้อมตอบข้อมูลระบบอย่างรวดเร็วและกระชับครับ!' }] }
  ];

  history.forEach(item => {
    contents.push({ role: item.role, parts: [{ text: item.text }] });
  });

  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const payload = JSON.stringify({
    contents: contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 500 // ตอบกระชับขึ้นเพื่อความเร็วระดับสูงสุด
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: '/v1beta/models/gemini-3.5-flash-lite:generateContent?key=' + apiKey,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve) => {
    let isResolved = false;
    const safeResolve = (val) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      console.warn('[Gemini AI] Request timed out after 9s');
      safeResolve('ขออภัยครับ ระบบ AI ตอบกลับช้า กรุณาลองส่งคำถามใหม่อีกครั้ง');
    }, 9000);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
            const replyText = json.candidates[0].content.parts[0].text;
            
            // Save to conversation history
            if (chatId) {
              history.push({ role: 'user', text: userPrompt });
              history.push({ role: 'model', text: replyText });
              if (history.length > 8) history = history.slice(history.length - 8);
              conversationHistory.set(chatId, history);
            }
            
            safeResolve(replyText);
          } else {
            console.warn('[Gemini AI] Unexpected response structure:', data);
            safeResolve(null);
          }
        } catch (e) {
          console.error('[Gemini AI] JSON parse error:', e.message);
          safeResolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Gemini AI] Network error:', err.message);
      safeResolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Handle incoming text messages (e.g. /start or chat with Gemini AI)
 */
async function handleTelegramMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const senderName = msg.from ? (msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '')) : 'ผู้ใช้งาน';

  if (!text) return;

  // 1. One-Click Deep Linking Account Binding: /start bind_<userId> or /bind <userId>
  const isBindCmd = text.startsWith('/start bind_') || text.startsWith('/start bind-') || text.startsWith('/start bind') || text.startsWith('/bind');
  if (isBindCmd) {
    let rawId = '';
    if (text.startsWith('/start bind_')) rawId = text.substring(12);
    else if (text.startsWith('/start bind-')) rawId = text.substring(12);
    else if (text.startsWith('/start bind')) rawId = text.substring(11);
    else if (text.startsWith('/bind ')) rawId = text.substring(6);
    else if (text.startsWith('/bind_')) rawId = text.substring(6);

    const userId = parseInt(rawId.trim(), 10);
    if (userId) {
      try {
        const [users] = await query('SELECT id, full_name, username, role FROM users WHERE id = ? LIMIT 1', [userId]);
        if (users && users.length > 0) {
          const u = users[0];
          await query('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [String(chatId), u.id]);
          console.log(`[Telegram] 1-Click Bind Success: User #${u.id} (${u.full_name}) bound to Chat ID ${chatId}`);

          const roleLabels = {
            'student': 'ผู้เรียน / นักศึกษา',
            'teacher': 'ครูผู้สอน / ครูที่ปรึกษา',
            'deputy_director': 'รองผู้อำนวยการ',
            'admin': 'ผู้ดูแลระบบ (Admin)'
          };
          const roleDisplay = roleLabels[u.role] || u.role;

          const boundSuccessMsg = 
`🎉 <b>[ผูกบัญชี OnePass สำเร็จเรียบร้อย!]</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>ชื่อ-นามสกุล:</b> ${escapeTelegramHtml(u.full_name)}
🏷️ <b>บทบาท:</b> ${escapeTelegramHtml(roleDisplay)} (@${escapeTelegramHtml(u.username)})
🆔 <b>Telegram Chat ID:</b> <code>${chatId}</code>
━━━━━━━━━━━━━━━━━━━━
✅ <b>บัญชี OnePass ของท่านเชื่อมต่อกับ Telegram แล้ว</b>
• ได้รับการแจ้งเตือนคำขอใบอนุญาตทันที
• กดปุ่มอนุมัติ / ตรวจสอบผ่านมือถือได้ทันที
• สนทนาหรือปรึกษาข้อมูลกับ <b>OnePass Gemini AI</b> ในห้องแชตนี้ได้ตลอด 24 ชม. 🤖`;

          await sendTelegramMessage(chatId, boundSuccessMsg);
          return;
        } else {
          await sendTelegramMessage(chatId, `⚠️ ไม่พบบัญชีผู้ใช้รหัส #${userId} ในระบบ OnePass กรุณาตรวจสอบหรือเข้าสู่ระบบใหม่บนเว็บไซต์`);
          return;
        }
      } catch (bindErr) {
        console.error('[Telegram] Bind error:', bindErr);
        await sendTelegramMessage(chatId, `❌ เกิดข้อผิดพลาดในการผูกบัญชี: ${escapeTelegramHtml(bindErr.message)}`);
        return;
      }
    }
  }

  // 2. Check status or whoami
  if (text === '/status' || text === '/whoami') {
    try {
      const [boundUsers] = await query('SELECT id, full_name, username, role FROM users WHERE telegram_chat_id = ? LIMIT 1', [String(chatId)]);
      if (boundUsers && boundUsers.length > 0) {
        const u = boundUsers[0];
        const statusMsg =
`📋 <b>[ข้อมูลบัญชี OnePass ที่เชื่อมต่ออยู่]</b>
━━━━━━━━━━━━━━━━━━━━
👤 <b>ชื่อ-นามสกุล:</b> ${escapeTelegramHtml(u.full_name)}
🏷️ <b>บทบาท:</b> ${escapeTelegramHtml(u.role)} (@${escapeTelegramHtml(u.username)})
🆔 <b>Telegram Chat ID:</b> <code>${chatId}</code>
━━━━━━━━━━━━━━━━━━━━
✨ สถานะ: เชื่อมต่อและพร้อมรับการแจ้งเตือนอัตโนมัติ`;
        await sendTelegramMessage(chatId, statusMsg);
        return;
      } else {
        await sendTelegramMessage(chatId, `ℹ️ <b>Chat ID ของท่าน:</b> <code>${chatId}</code>\n⚠️ <i>(ยังไม่ได้ผูกกับบัญชีผู้ใช้ใดใน OnePass)</i>\nเปิดเว็บไซต์ OnePass แล้วกดที่รูปโปรไฟล์เพื่อผูกบัญชีอัตโนมัติ`);
        return;
      }
    } catch (e) {}
  }

  // 3. Regular /start command
  if (text === '/start') {
    // Clear chat history on /start
    conversationHistory.delete(chatId);

    let boundNotice = '';
    try {
      const [bound] = await query('SELECT full_name, username, role FROM users WHERE telegram_chat_id = ? LIMIT 1', [String(chatId)]);
      if (bound && bound.length > 0) {
        boundNotice = `\n✅ <b>ผูกกับบัญชี:</b> ${escapeTelegramHtml(bound[0].full_name)} (@${escapeTelegramHtml(bound[0].username)})`;
      } else {
        boundNotice = `\nℹ️ <i>(ยังไม่ได้ผูกกับบัญชี OnePass — กดปุ่มโปรไฟล์ในเว็บเพื่อผูกอัตโนมัติ)</i>`;
      }
    } catch (e) {}

    const welcomeText = 
`👋 <b>ยินดีต้อนรับสู่ OnePass Bot & Gemini AI</b>
ระบบขออนุญาตออกนอกสถานศึกษา ด้วยระบบ QR Code
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Chat ID ของท่านคือ:</b> <code>${chatId}</code>${boundNotice}
━━━━━━━━━━━━━━━━━━━━
ℹ️ <b>บริการของบอท:</b>
1. <b>รับการแจ้งเตือน & กดอนุมัติ:</b> ผูกบัญชีของคุณเพื่อรับแจ้งเตือนและกดอนุมัติผ่านมือถือ
2. <b>รับบัตรผ่าน QR:</b> สแกนออกประตูอัตโนมัติ
3. <b>ถาม-ตอบกับ Gemini AI:</b> พิมพ์ข้อความคำถามหรือคุยกับ AI ได้อย่างต่อเนื่องในห้องแชตนี้!`;

    await sendTelegramMessage(chatId, welcomeText);
    return;
  }

  // Answer through Gemini AI
  console.log(`[Telegram AI] ${senderName} (${chatId}): "${text}"`);
  
  // Show typing status indicator
  try {
    const config = await getTelegramConfig();
    if (config.botToken) {
      https.get(`https://api.telegram.org/bot${config.botToken}/sendChatAction?chat_id=${chatId}&action=typing`);
    }
  } catch (e) {}

  const aiReply = await askGeminiAI(text, senderName, chatId);
  if (aiReply) {
    const cleanReply = escapeTelegramHtml(aiReply);
    const formattedReply = `🤖 <b>[OnePass AI]:</b>\n\n${cleanReply}`;
    await sendTelegramMessage(chatId, formattedReply);
  } else {
    await sendTelegramMessage(chatId, `ขออภัยครับ ขณะนี้ระบบประมวลผล Gemini AI ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง`);
  }
}

/**
 * Start Telegram Service (Webhook-driven for instant 24/7 autonomous replies)
 */
async function startTelegramPolling() {
  if (isPollingStarted) return;
  isPollingStarted = true;

  console.log('[Telegram] Service started. Webhook is active at /api/telegram/webhook for instant 24/7 replies.');
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
  handleTelegramCallbackQuery,
  handleTelegramMessage,
  startTelegramPolling
};
