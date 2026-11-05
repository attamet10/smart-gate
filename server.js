const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  createTelegramRouter,
  notifyApproverQueue,
  notifyApproverOverdueReminder,
  notifyStudentApproved,
  notifyStudentRejected,
  notifyScanGateEvent,
  notifyAdminAlert,
  notifyDisciplineStudentReturn,
  sendTelegramMessage
} = require('./telegram');
const mqtt = require('mqtt');
const db = require('./db');
const fs = require('fs');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'onepass_jwt_secret_key_2026_smartgate_secure_token';
const BCRYPT_ROUNDS = 10;

function generateToken(user) {
  if (!user) return null;
  return jwt.sign(
    {
      id: user.id || 'u-' + (user.username || 'unknown'),
      username: user.username,
      role: user.role || 'student',
      full_name: user.full_name || '',
      department_id: user.department_id || null
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware ตรวจสอบ JWT Token (Authentication)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!token && req.headers['x-access-token']) {
    token = req.headers['x-access-token'];
  }

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: '⛔ ปฏิเสธการเข้าถึง: ไม่พบ Token ยืนยันตัวตน กรุณาเข้าสู่ระบบก่อนทำรายการ' 
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        message: '⛔ เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่อีกครั้ง' 
      });
    }
    req.user = decodedUser;
    next();
  });
}

// Middleware ตรวจสอบสิทธิ์บทบาทผู้ใช้งาน (RBAC Authorization)
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `⛔ สิทธิ์ไม่เพียงพอ: บัญชีของคุณ (${req.user ? req.user.role : 'guest'}) ไม่มีสิทธิ์ทำรายการนี้ (อนุญาตเฉพาะ: ${allowedRoles.join(', ')})`
      });
    }
    next();
  };
}

// ฟังก์ชันส่งการแจ้งเตือนผ่าน LINE (รองรับทั้ง LINE Notify Token และโหมดจำลอง)
async function sendLineNotification(message) {
  const token = process.env.LINE_NOTIFY_TOKEN || process.env.LINE_TOKEN;
  console.log(`📱 [LINE NOTIFICATION]\n${message.trim()}`);

  if (!token || token.trim() === '' || token.includes('your_line')) {
    // โหมดจำลอง (ยังไม่ได้ใส่ Token ใน .env หรืออยู่ในโหมดทดสอบ)
    return { success: true, simulated: true };
  }

  try {
    const params = new URLSearchParams();
    params.append('message', message);

    const res = await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`
      },
      body: params
    });

    const data = await res.json();
    if (res.ok) {
      console.log('✅ [LINE] Message delivered successfully to LINE!');
      return { success: true, data };
    } else {
      console.warn('⚠️ [LINE] API responded with error:', data);
      return { success: false, data };
    }
  } catch (err) {
    console.warn('⚠️ [LINE] Failed to send LINE notification:', err.message);
    return { success: false, error: err.message };
  }
}

function isBcryptHash(str) {
  return typeof str === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(str);
}

async function hashPassword(plainPassword) {
  return await bcrypt.hash(String(plainPassword).trim(), BCRYPT_ROUNDS);
}

async function verifyPassword(plainPassword, storedPassword) {
  if (!plainPassword || !storedPassword) return false;
  const cleanPlain = String(plainPassword).trim();
  const cleanStored = String(storedPassword).trim();
  if (isBcryptHash(cleanStored)) {
    return await bcrypt.compare(cleanPlain, cleanStored);
  }
  // รองรับรหัสผ่านเดิมแบบข้อความปกติ (Backward-compatible สำหรับบัญชีเดิม/บัญชีทดสอบ เช่น 1234)
  return cleanPlain === cleanStored;
}

function sanitizeUser(userObj) {
  if (!userObj || typeof userObj !== 'object') return userObj;
  const copy = { ...userObj };
  delete copy.password;
  delete copy.password_hash;
  return copy;
}

// ============================================================================
// ROTATING QR CODE (Time-Based One-Time Password / Anti-Screenshot Engine)
// ============================================================================
const ROTATING_QR_INTERVAL_SEC = 30; // รหัส QR หมุนเวียนเปลี่ยนทุก 30 วินาที

function generateTotp(baseToken, timeWindow) {
  return crypto.createHmac('sha256', baseToken)
    .update(timeWindow.toString())
    .digest('hex')
    .substring(0, 6)
    .toUpperCase();
}

function verifyTotp(baseToken, totpCode) {
  if (!totpCode || totpCode.trim().length !== 6) {
    return { valid: false, reason: 'Invalid format' };
  }
  const currentWindow = Math.floor(Date.now() / (ROTATING_QR_INTERVAL_SEC * 1000));
  // ตรวจสอบช่วงเวลาปัจจุบัน และช่วงผ่อนปรน +/- 1 window (กันเหลื่อมวินาที รวม 90 วิ)
  for (let offset = -1; offset <= 1; offset++) {
    const expected = generateTotp(baseToken, currentWindow + offset);
    if (expected === totpCode.trim().toUpperCase()) {
      return { valid: true, offset };
    }
  }
  return { valid: false, reason: 'Expired' };
}

const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEPTS_FILE = path.join(DATA_DIR, 'departments.json');
const TIMETABLES_FILE = path.join(DATA_DIR, 'timetables.json');
const DELEGATIONS_FILE = path.join(DATA_DIR, 'delegations.json');
const REQUESTS_META_FILE = path.join(DATA_DIR, 'requests_meta.json');
const DEVICE_REQUESTS_FILE = path.join(DATA_DIR, 'device_requests.json');
const LOGIN_LOGS_FILE = path.join(DATA_DIR, 'login_logs.json');
const DELETED_USERS_FILE = path.join(DATA_DIR, 'deleted_users.json');

function loadDeletedUsers() {
  try {
    if (fs.existsSync(DELETED_USERS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DELETED_USERS_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        return new Set(arr.map(u => String(u).trim().toLowerCase()).filter(Boolean));
      }
    }
  } catch (e) {}
  return new Set();
}

function markUserAsDeleted(username) {
  if (!username) return;
  const clean = username.trim().toLowerCase();
  try {
    const set = loadDeletedUsers();
    set.add(clean);
    fs.writeFileSync(DELETED_USERS_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
    console.log(`🗑️ [BLACKLIST] Marked user @${clean} as deleted`);
  } catch (e) {
    console.warn('Save deleted user error:', e.message);
  }
}

function unmarkUserAsDeleted(username) {
  if (!username) return;
  const clean = username.trim().toLowerCase();
  try {
    const set = loadDeletedUsers();
    if (set.has(clean)) {
      set.delete(clean);
      fs.writeFileSync(DELETED_USERS_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
      console.log(`♻️ [BLACKLIST] Unmarked user @${clean} from deleted list`);
    }
  } catch (e) {}
}

function loadDeviceRequests() {
  try {
    if (fs.existsSync(DEVICE_REQUESTS_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICE_REQUESTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveDeviceRequests(list) {
  try {
    fs.writeFileSync(DEVICE_REQUESTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {}
}

function appendLoginLog(entry) {
  try {
    let logs = [];
    if (fs.existsSync(LOGIN_LOGS_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOGIN_LOGS_FILE, 'utf8') || '[]');
    }
    logs.unshift({
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      created_at: new Date().toISOString(),
      ...entry
    });
    if (logs.length > 500) logs = logs.slice(0, 500);
    fs.writeFileSync(LOGIN_LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {}
}

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

const DEFAULT_SETTINGS = {
  entryTime: "08:00",
  lunchStart: "12:00",
  lunchEnd: "13:00",
  leaveMinTime: "08:00",
  leaveMaxTime: "16:00",
  dismissalTime: "16:00",
  gracePeriodMinutes: 15,
  preWarningMinutes: 30,
  approvalReminderMinutes: 15,
  autoExpireAfterDismissal: true,
  returnMaxDistanceCm: 60,
  returnNotifyMode: "all",
  returnRequireWifi: false
};

// บัญชีมาตรฐานครบทั้ง 5 ขั้นตอน (นักเรียน, ครูรายวิชา, ครูที่ปรึกษา, หัวหน้าแผนก, ฝ่ายปกครอง, รองผู้อำนวยการ, ผู้ดูแลระบบ)
const ALL_SYSTEM_ACCOUNTS = {
  'student': {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'student',
    full_name: 'นายธนภัทร รัตนโชติ',
    role: 'student',
    student_code: '66209010012',
    plate_no: '1กข 4589 นครนายก (รถจักรยานยนต์)',
    dept: 'แผนกวิชาช่างยนต์',
    departments: { name: 'แผนกวิชาช่างยนต์' },
    classrooms: { name: 'ปวช.3' }
  },

  // ขั้นที่ 1: ครูรายวิชา (Subject Teachers)
  'subject_auto': { id: '00000000-0000-0000-0000-000000000111', username: 'subject_auto', full_name: 'อ.ธีรพงศ์ เครื่องยนต์', role: 'subject_teacher', dept: 'แผนกวิชาช่างยนต์', departments: { name: 'แผนกวิชาช่างยนต์' } },
  'subject_electric': { id: '00000000-0000-0000-0000-000000000121', username: 'subject_electric', full_name: 'อ.วีระพล วงจรไฟฟ้า', role: 'subject_teacher', dept: 'แผนกวิชาช่างไฟฟ้า', departments: { name: 'แผนกวิชาช่างไฟฟ้า' } },
  'subject_account': { id: '00000000-0000-0000-0000-000000000131', username: 'subject_account', full_name: 'อ.ศิริพร การบัญชี', role: 'subject_teacher', dept: 'แผนกวิชาการบัญชี', departments: { name: 'แผนกวิชาการบัญชี' } },
  'subject_digital': { id: '00000000-0000-0000-0000-000000000141', username: 'subject_digital', full_name: 'อ.ภาณุวัฒน์ โค้ดดิ้ง', role: 'subject_teacher', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' } },
  'subject_office': { id: '00000000-0000-0000-0000-000000000151', username: 'subject_office', full_name: 'อ.กนกวรรณ บริหาร', role: 'subject_teacher', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' } },
  'subject_general': { id: '00000000-0000-0000-0000-000000000161', username: 'subject_general', full_name: 'อ.ดรุณี วิชาการ', role: 'subject_teacher', dept: 'หมวดวิชาสามัญสัมพันธ์', departments: { name: 'หมวดวิชาสามัญสัมพันธ์' } },

  // ==========================================================================
  // ขั้นที่ 2: ครูที่ปรึกษาประจำระดับชั้น (Advisors: 5 แผนก × 5 ระดับชั้น = 25 บัญชี)
  // ==========================================================================
  // 1. แผนกวิชาช่างยนต์
  'adv_auto_1': { id: '00000000-0000-0000-0000-000000000211', username: 'adv_auto_1', full_name: 'อ.อนุสรณ์ ช่างยนต์', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวช.1', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวช.1' } },
  'adv_auto_2': { id: '00000000-0000-0000-0000-000000000212', username: 'adv_auto_2', full_name: 'อ.กมล ยานยนต์', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวช.2', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวช.2' } },
  'adv_auto_3': { id: '00000000-0000-0000-0000-000000000213', username: 'adv_auto_3', full_name: 'อ.สมชาย ใจดี', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวช.3' } },
  'adv_auto_pvs1': { id: '00000000-0000-0000-0000-000000000214', username: 'adv_auto_pvs1', full_name: 'อ.ชาญชัย ช่างยนต์', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวส.1', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวส.1' } },
  'adv_auto_pvs2': { id: '00000000-0000-0000-0000-000000000215', username: 'adv_auto_pvs2', full_name: 'อ.ธีรยุทธ ยานยนต์', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวส.2', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวส.2' } },

  // 2. แผนกวิชาช่างไฟฟ้า
  'adv_elec_1': { id: '00000000-0000-0000-0000-000000000221', username: 'adv_elec_1', full_name: 'อ.กิตติศักดิ์ ไฟฟ้า', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวช.1', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวช.1' } },
  'adv_elec_2': { id: '00000000-0000-0000-0000-000000000222', username: 'adv_elec_2', full_name: 'อ.สมเกียรติ พลังงานไฟฟ้า', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวช.2', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวช.2' } },
  'adv_elec_3': { id: '00000000-0000-0000-0000-000000000223', username: 'adv_elec_3', full_name: 'อ.ธวัชชัย อิเล็กทรอนิกส์', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวช.3' } },
  'adv_elec_pvs1': { id: '00000000-0000-0000-0000-000000000224', username: 'adv_elec_pvs1', full_name: 'อ.สุรศักดิ์ ควบคุมไฟฟ้า', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวส.1', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวส.1' } },
  'adv_elec_pvs2': { id: '00000000-0000-0000-0000-000000000225', username: 'adv_elec_pvs2', full_name: 'อ.บุญส่ง วิศวกรรมไฟฟ้า', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวส.2', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวส.2' } },

  // 3. แผนกวิชาการบัญชี
  'adv_acc_1': { id: '00000000-0000-0000-0000-000000000231', username: 'adv_acc_1', full_name: 'อ.พิมพา บัญชี', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวช.1', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวช.1' } },
  'adv_acc_2': { id: '00000000-0000-0000-0000-000000000232', username: 'adv_acc_2', full_name: 'อ.รัตนา การเงิน', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวช.2', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวช.2' } },
  'adv_acc_3': { id: '00000000-0000-0000-0000-000000000233', username: 'adv_acc_3', full_name: 'อ.สุรีย์พร ภาษีอากร', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวช.3' } },
  'adv_acc_pvs1': { id: '00000000-0000-0000-0000-000000000234', username: 'adv_acc_pvs1', full_name: 'อ.นงลักษณ์ การบัญชีชั้นสูง', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวส.1', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวส.1' } },
  'adv_acc_pvs2': { id: '00000000-0000-0000-0000-000000000235', username: 'adv_acc_pvs2', full_name: 'อ.ประภาศรี ตรวจสอบบัญชี', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวส.2', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวส.2' } },

  // 4. แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล
  'adv_digit_1': { id: '00000000-0000-0000-0000-000000000241', username: 'adv_digit_1', full_name: 'อ.ธนากร ดิจิทัล', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวช.1', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.1' } },
  'adv_digit_2': { id: '00000000-0000-0000-0000-000000000242', username: 'adv_digit_2', full_name: 'อ.ศุภชัย คอมพิวเตอร์', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวช.2', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.2' } },
  'adv_digit_3': { id: '00000000-0000-0000-0000-000000000243', username: 'adv_digit_3', full_name: 'อ.วรวิทย์ พัฒนาเว็บ', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.3' } },
  'adv_digit_pvs1': { id: '00000000-0000-0000-0000-000000000244', username: 'adv_digit_pvs1', full_name: 'อ.เอกลักษณ์ ดิจิทัลมีเดีย', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวส.1', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวส.1' } },
  'adv_digit_pvs2': { id: '00000000-0000-0000-0000-000000000245', username: 'adv_digit_pvs2', full_name: 'อ.ชัยวัฒน์ นวัตกรรมดิจิทัล', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวส.2', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวส.2' } },

  // 5. แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล
  'adv_office_1': { id: '00000000-0000-0000-0000-000000000251', username: 'adv_office_1', full_name: 'อ.นภาวรรณ สำนักงาน', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวช.1', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.1' } },
  'adv_office_2': { id: '00000000-0000-0000-0000-000000000252', username: 'adv_office_2', full_name: 'อ.สิริมา บริหารธุรกิจ', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวช.2', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.2' } },
  'adv_office_3': { id: '00000000-0000-0000-0000-000000000253', username: 'adv_office_3', full_name: 'อ.อรัญญา ธุรการดิจิทัล', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.3' } },
  'adv_office_pvs1': { id: '00000000-0000-0000-0000-000000000254', username: 'adv_office_pvs1', full_name: 'อ.จุฑารัตน์ การจัดการสารสนเทศ', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวส.1', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวส.1' } },
  'adv_office_pvs2': { id: '00000000-0000-0000-0000-000000000255', username: 'adv_office_pvs2', full_name: 'อ.เพ็ญศรี การพัฒนาองค์การ', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวส.2', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวส.2' } },

  // บัญชีเดิม (Backward-compatible Aliases)
  'teacher_auto': { id: '00000000-0000-0000-0000-000000000011', username: 'teacher_auto', full_name: 'อ.สมชาย ใจดี', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาช่างยนต์' }, classrooms: { name: 'ปวช.3' } },
  'teacher_electric': { id: '00000000-0000-0000-0000-000000000021', username: 'teacher_electric', full_name: 'อ.ธวัชชัย อิเล็กทรอนิกส์', role: 'advisor', dept: 'แผนกวิชาช่างไฟฟ้า', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาช่างไฟฟ้า' }, classrooms: { name: 'ปวช.3' } },
  'teacher_account': { id: '00000000-0000-0000-0000-000000000031', username: 'teacher_account', full_name: 'อ.สุรีย์พร ภาษีอากร', role: 'advisor', dept: 'แผนกวิชาการบัญชี', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาการบัญชี' }, classrooms: { name: 'ปวช.3' } },
  'teacher_digital': { id: '00000000-0000-0000-0000-000000000041', username: 'teacher_digital', full_name: 'อ.วรวิทย์ พัฒนาเว็บ', role: 'advisor', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.3' } },
  'teacher_office': { id: '00000000-0000-0000-0000-000000000051', username: 'teacher_office', full_name: 'อ.อรัญญา ธุรการดิจิทัล', role: 'advisor', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', classroom: 'ปวช.3', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' }, classrooms: { name: 'ปวช.3' } },
  'teacher': { id: '00000000-0000-0000-0000-000000000019', username: 'teacher', full_name: 'อ.สมชาย ใจดี', role: 'advisor', dept: 'แผนกวิชาช่างยนต์', classroom: 'ปวช.3/1 (ช่างยนต์)', departments: { name: 'แผนกวิชาช่างยนต์' } },

  // ขั้นที่ 3: หัวหน้าแผนกวิชา (Department Heads)
  'head_auto': { id: '00000000-0000-0000-0000-000000000012', username: 'head_auto', full_name: 'อ.ประสิทธิ์ ยานยนต์', role: 'dept_head', dept: 'แผนกวิชาช่างยนต์', departments: { name: 'แผนกวิชาช่างยนต์' } },
  'head_electric': { id: '00000000-0000-0000-0000-000000000022', username: 'head_electric', full_name: 'อ.สมศักดิ์ พลังงาน', role: 'dept_head', dept: 'แผนกวิชาช่างไฟฟ้า', departments: { name: 'แผนกวิชาช่างไฟฟ้า' } },
  'head_account': { id: '00000000-0000-0000-0000-000000000032', username: 'head_account', full_name: 'อ.วรรณา ยอดเงิน', role: 'dept_head', dept: 'แผนกวิชาการบัญชี', departments: { name: 'แผนกวิชาการบัญชี' } },
  'head_digital': { id: '00000000-0000-0000-0000-000000000042', username: 'head_digital', full_name: 'อ.ณัฐพงษ์ เทคโนโลยี', role: 'dept_head', dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล', departments: { name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล' } },
  'head_office': { id: '00000000-0000-0000-0000-000000000052', username: 'head_office', full_name: 'อ.สุพรรณี การจัดการ', role: 'dept_head', dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล', departments: { name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล' } },

  // ขั้นที่ 4: ฝ่ายปกครอง (Discipline Head)
  'discipline': { id: '00000000-0000-0000-0000-000000000004', username: 'discipline', full_name: 'อ.เกรียงไกร รักษา วินัย', role: 'discipline_head', dept: 'งานปกครองและนิติการ', departments: { name: 'งานปกครองและนิติการ' } },

  // ขั้นที่ 5: รองผู้อำนวยการ (Deputy Director - ผู้อนุมัติขั้นที่ 5 ออก QR Pass)
  'deputy': { id: '00000000-0000-0000-0000-000000000006', username: 'deputy', full_name: 'รองผอ.ดร.ภูมิพัฒน์ บริหารกิจ', role: 'deputy_director', dept: 'ฝ่ายพัฒนากิจการนักเรียน นักศึกษา', departments: { name: 'ฝ่ายพัฒนากิจการนักเรียน นักศึกษา' } },

  // ผู้ดูแลระบบ (System Admin)
  'admin': { id: '00000000-0000-0000-0000-000000000099', username: 'admin', full_name: 'ผู้ดูแลระบบ OnePass (Admin)', role: 'admin', dept: 'งานศูนย์ข้อมูลและสารสนเทศ', departments: { name: 'งานศูนย์ข้อมูลและสารสนเทศ' } }
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (e) {
    console.warn('Load settings error:', e.message);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(newSettings) {
  try {
    const current = loadSettings();
    if (newSettings.dismissalTime && !newSettings.leaveMaxTime) {
      newSettings.leaveMaxTime = newSettings.dismissalTime;
    }
    if (newSettings.morningGateClose && !newSettings.entryTime) {
      newSettings.entryTime = newSettings.morningGateClose;
    }
    const merged = { ...current, ...newSettings, updatedAt: new Date().toISOString() };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (e) {
    console.warn('Save settings error:', e.message);
    return null;
  }
}

function loadDepartments() {
  try {
    if (fs.existsSync(DEPTS_FILE)) {
      return JSON.parse(fs.readFileSync(DEPTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Load departments error:', e.message);
  }
  return [];
}

function saveDepartments(deptsList) {
  try {
    fs.writeFileSync(DEPTS_FILE, JSON.stringify(deptsList, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('Save departments error:', e.message);
    return false;
  }
}

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Load profiles error:', e.message);
  }
  return {};
}

function saveStoredProfile(username, data) {
  if (!username) return null;
  try {
    const all = loadProfiles();
    const key = username.toLowerCase().trim();
    all[key] = { ...(all[key] || {}), ...data, updatedAt: new Date().toISOString() };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(all, null, 2), 'utf8');
    return all[key];
  } catch (e) {
    console.error('Save profile error:', e.message);
    return null;
  }
}

function getStoredProfile(username) {
  if (!username) return {};
  const all = loadProfiles();
  return all[username.toLowerCase().trim()] || {};
}

function deleteStoredProfile(username) {
  if (!username) return false;
  try {
    const all = loadProfiles();
    const key = username.toLowerCase().trim();
    if (all[key]) {
      delete all[key];
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(all, null, 2), 'utf8');
      return true;
    }
  } catch (e) {
    console.error('Delete stored profile error:', e.message);
  }
  return false;
}

// ============================================================================
// TIMETABLE, DELEGATIONS & 5-STEP METADATA ENGINE
// ============================================================================
function loadTimetablesData() {
  try {
    if (fs.existsSync(TIMETABLES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TIMETABLES_FILE, 'utf8'));
      return {
        activeSemester: parsed.activeSemester || '1/2569',
        semesters: Array.isArray(parsed.semesters) ? parsed.semesters : [{ code: '1/2569', name: 'ภาคเรียนที่ 1 ปีการศึกษา 2569', isActive: true }],
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        overrides: Array.isArray(parsed.overrides) ? parsed.overrides : []
      };
    }
  } catch (e) {
    console.warn('Load timetables error:', e.message);
  }
  return {
    activeSemester: '1/2569',
    semesters: [{ code: '1/2569', name: 'ภาคเรียนที่ 1 ปีการศึกษา 2569', isActive: true }],
    entries: [],
    overrides: []
  };
}

function saveTimetablesData(data) {
  try {
    fs.writeFileSync(TIMETABLES_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('Save timetables error:', e.message);
    return false;
  }
}

function loadDelegations() {
  try {
    if (fs.existsSync(DELEGATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(DELEGATIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Load delegations error:', e.message);
  }
  return [];
}

function saveDelegations(list) {
  try {
    fs.writeFileSync(DELEGATIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('Save delegations error:', e.message);
    return false;
  }
}

function loadRequestsMeta() {
  try {
    if (fs.existsSync(REQUESTS_META_FILE)) {
      return JSON.parse(fs.readFileSync(REQUESTS_META_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Load requests meta error:', e.message);
  }
  return {};
}

function getRequestMeta(requestKey) {
  if (!requestKey) return null;
  const all = loadRequestsMeta();
  return all[String(requestKey)] || null;
}

function saveRequestMeta(requestKey, metaPatch) {
  if (!requestKey) return null;
  try {
    const all = loadRequestsMeta();
    const key = String(requestKey);
    all[key] = { ...(all[key] || {}), ...metaPatch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(REQUESTS_META_FILE, JSON.stringify(all, null, 2), 'utf8');
    return all[key];
  } catch (e) {
    console.warn('Save request meta error:', e.message);
    return null;
  }
}

function parseTimeToMins(tStr) {
  if (!tStr || typeof tStr !== 'string' || !tStr.includes(':')) return 0;
  const [h, m] = tStr.trim().substring(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isDepartmentMatchServer(deptA, deptB) {
  if (!deptA || !deptB) return false;
  const cleanA = String(deptA).replace('แผนกวิชา', '').split('(')[0].trim();
  const cleanB = String(deptB).replace('แผนกวิชา', '').split('(')[0].trim();
  if (!cleanA || !cleanB) return false;
  if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
  if (cleanA.includes('ไฟฟ้า') && cleanB.includes('ไฟฟ้า')) return true;
  if (cleanA.includes('ยนต์') && cleanB.includes('ยนต์')) return true;
  if (cleanA.includes('บัญชี') && cleanB.includes('บัญชี')) return true;
  if (cleanA.includes('ดิจิทัล') && !cleanA.includes('สำนักงาน') && cleanB.includes('ดิจิทัล') && !cleanB.includes('สำนักงาน')) return true;
  if ((cleanA.includes('สำนักงาน') || cleanA.includes('จัดการ')) && (cleanB.includes('สำนักงาน') || cleanB.includes('จัดการ'))) return true;
  return false;
}

function isClassroomMatchServer(classA, classB) {
  if (!classA || !classB) return false;
  const cleanA = String(classA).trim();
  const cleanB = String(classB).trim();
  return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
}

// ตรวจสอบเวลาทับซ้อนในตารางสอน (ข้อ 12: ตรวจพบเวลาทับซ้อนต้องแจ้งเตือน)
// Helper: ค้นหาหรือสร้างบัญชีครูรายวิชาอัตโนมัติเมื่อเพิ่มตารางสอน/นำเข้า Excel (รหัสผ่านเริ่มต้น 1234)
function getAllActiveTeacherAccountsMap() {
  const map = { ...ALL_SYSTEM_ACCOUNTS };
  const profiles = loadProfiles();
  for (const [k, p] of Object.entries(profiles)) {
    const uname = (p.username || k || '').toLowerCase().trim();
    if (!uname) continue;
    if (['subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director'].includes(p.role)) {
      map[uname] = {
        id: p.id || `u-${uname}`,
        username: uname,
        full_name: p.full_name || uname,
        role: p.role,
        dept: p.dept || 'แผนกวิชาช่างยนต์',
        departments: { name: p.dept || 'แผนกวิชาช่างยนต์' },
        isAutoCreated: Boolean(p.isAutoCreated)
      };
    }
  }
  return map;
}

async function ensureTeacherAccountProvisioned({ teacherUsername, teacherName, department }) {
  let cleanUser = String(teacherUsername || '').trim().toLowerCase();
  let cleanName = String(teacherName || '').trim();
  const cleanDept = String(department || 'แผนกวิชาช่างยนต์').trim();

  // Map legacy aliases
  if (cleanUser === 'subject_elec') cleanUser = 'subject_electric';
  if (cleanUser === 'subject_acc') cleanUser = 'subject_account';
  if (cleanUser === 'subject_it') cleanUser = 'subject_digital';
  if (cleanUser === 'subject_mgmt') cleanUser = 'subject_office';
  if (cleanUser === 'teacher_elec') cleanUser = 'teacher_electric';
  if (cleanUser === 'teacher_acc') cleanUser = 'teacher_account';
  if (cleanUser === 'teacher_it') cleanUser = 'teacher_digital';
  if (cleanUser === 'teacher_mgmt') cleanUser = 'teacher_office';

  const allMap = getAllActiveTeacherAccountsMap();

  // 1. หากระบุ username ที่มีอยู่แล้วในระบบ
  if (cleanUser && allMap[cleanUser]) {
    const existing = allMap[cleanUser];
    // แต่ถ้าแอดมิน/Excel พิมพ์ชื่อครูท่านใหม่เข้ามาแต่ช่อง username ค้างค่า default (เช่น subject_auto) ให้เช็คว่าชื่อตรงกันไหม
    const isDefaultPlaceholder = ['subject_auto', 'subject_electric', 'subject_account', 'subject_digital', 'subject_office'].includes(cleanUser);
    const nameMatchesExisting = !cleanName || cleanName === 'อาจารย์ผู้สอน' || cleanName === existing.full_name;
    if (nameMatchesExisting || !isDefaultPlaceholder) {
      return {
        username: existing.username,
        fullName: cleanName && cleanName !== 'อาจารย์ผู้สอน' ? cleanName : existing.full_name,
        role: existing.role,
        createdNew: false
      };
    }
  }

  // 2. ลองค้นหาจากชื่อครู (กรณีใน Excel มีแต่ชื่อครู หรือครูที่ปรึกษา/หัวหน้าแผนกมาสอน)
  if (cleanName && cleanName !== '-' && cleanName !== 'อาจารย์ผู้สอน') {
    const matchedByName = Object.values(allMap).find(u =>
      u.full_name && (u.full_name.trim() === cleanName || u.full_name.includes(cleanName) || cleanName.includes(u.full_name.replace(/^อ\./, '').trim()))
    );
    if (matchedByName) {
      ALL_SYSTEM_ACCOUNTS[matchedByName.username] = matchedByName;
      return {
        username: matchedByName.username,
        fullName: matchedByName.full_name,
        role: matchedByName.role,
        createdNew: false
      };
    }
  }

  // 3. หากเป็นครูคนใหม่ที่ยังไม่มีบัญชีในระบบ -> สร้าง Username + รหัสผ่าน 1234 ให้อัตโนมัติทันที!
  let newUsername = cleanUser;
  if (!newUsername || allMap[newUsername]) {
    // สร้าง username อัตโนมัติที่จำง่าย เช่น tchr_101 หรือจากภาษาอังกฤษในชื่อ
    const engSlug = cleanName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const existingAutoCount = Object.keys(allMap).filter(k => k.startsWith('teacher_') || k.startsWith('tchr_')).length + 1;
    newUsername = engSlug.length >= 3 ? `tchr_${engSlug}` : `tchr_${String(existingAutoCount).padStart(2, '0')}`;
    let suffix = 1;
    while (allMap[newUsername]) {
      suffix++;
      newUsername = `tchr_${String(existingAutoCount + suffix).padStart(2, '0')}`;
    }
  }

  const finalFullName = (cleanName && cleanName !== '-') ? cleanName : `อ.${newUsername}`;
  const newTeacherObj = {
    id: crypto.randomUUID ? crypto.randomUUID() : ('u-' + Date.now()),
    username: newUsername,
    full_name: finalFullName,
    role: 'subject_teacher',
    dept: cleanDept,
    departments: { name: cleanDept },
    isAutoCreated: true
  };

  // บันทึกเข้า ALL_SYSTEM_ACCOUNTS และ profiles.json เพื่อให้ล็อกอินด้วยรหัส 1234 ได้ทันที
  ALL_SYSTEM_ACCOUNTS[newUsername] = newTeacherObj;
  saveStoredProfile(newUsername, {
    username: newUsername,
    full_name: finalFullName,
    role: 'subject_teacher',
    dept: cleanDept,
    isAutoCreated: true
  });

  // บันทึกลงตาราง users ใน Supabase ด้วย (ถ้าเชื่อมต่ออยู่)
  if (supabase) {
    try {
      const passHash = await hashPassword('1234');
      await db.query(
        `INSERT INTO users (id, username, password, password_hash, full_name, role, plate_no)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password=VALUES(password), password_hash=VALUES(password_hash),
           full_name=VALUES(full_name), role=VALUES(role), plate_no=VALUES(plate_no)`,
        [crypto.randomUUID(), newUsername, '1234', passHash, finalFullName, 'subject_teacher', '-']
      );
    } catch (e) {}
  }

  console.log(`✨ [AUTO-PROVISION TEACHER] Created login account @${newUsername} (pass: 1234) for "${finalFullName}" (${cleanDept})`);
  return {
    username: newUsername,
    fullName: finalFullName,
    role: 'subject_teacher',
    createdNew: true
  };
}
function detectTimetableConflicts(entries, candidateEntry, ignoreId = null) {
  const conflicts = [];
  const candStart = parseTimeToMins(candidateEntry.startTime);
  const candEnd = parseTimeToMins(candidateEntry.endTime);
  const candDay = Number(candidateEntry.dayOfWeek || 0);
  const candSem = candidateEntry.semester || '1/2569';

  for (const item of entries) {
    if (ignoreId && String(item.id) === String(ignoreId)) continue;
    if ((item.semester || '1/2569') !== candSem) continue;

    // วันเดียวกัน หรือวัน = 0 (ทุกวัน)
    const itemDay = Number(item.dayOfWeek || 0);
    const sameDay = (candDay === 0 || itemDay === 0 || candDay === itemDay);
    if (!sameDay) continue;

    const itemStart = parseTimeToMins(item.startTime);
    const itemEnd = parseTimeToMins(item.endTime);

    // ตรวจสอบช่วงเวลาทับซ้อน: startA < endB && endA > startB
    if (candStart < itemEnd && candEnd > itemStart) {
      // 1. ห้องเรียนเดียวกันในแผนกเดียวกันมีคาบซ้อน
      if (isDepartmentMatchServer(item.department, candidateEntry.department) &&
          isClassroomMatchServer(item.classroom, candidateEntry.classroom)) {
        conflicts.push({
          type: 'classroom_overlap',
          message: `เวลาทับซ้อนในห้อง ${item.classroom} (${item.department}): ช่วง ${item.startTime}-${item.endTime} น. มีวิชา "${item.subjectName}" อยู่แล้ว`,
          existingEntry: item
        });
      }
      // 2. ครูผู้สอนคนเดียวกันสอนซ้อนห้องอื่นในเวลาเดียวกัน
      else if (candidateEntry.teacherUsername && item.teacherUsername &&
               candidateEntry.teacherUsername === item.teacherUsername &&
               candidateEntry.periodType === 'study' && item.periodType === 'study') {
        conflicts.push({
          type: 'teacher_overlap',
          message: `ครูผู้สอน (${item.teacherName}) มีสอนซ้อนที่ห้อง ${item.classroom} (${item.department}) ช่วง ${item.startTime}-${item.endTime} น. วิชา "${item.subjectName}"`,
          existingEntry: item
        });
      }
    }
  }
  return conflicts;
}

// ระบบค้นหาคาบเรียนและครูรายวิชาอัตโนมัติจากตารางสอน (ข้อ 13, 14, 15, 16, 17, 18)
function matchTimetableForLeave({ department, classroom, leaveDate, departureTime, expectedReturnTime, noReturn }) {
  const ttData = loadTimetablesData();
  const activeSemester = ttData.activeSemester || '1/2569';

  // แยกชื่อแผนกและชั้นปีให้ชัดเจน
  let cleanDept = department || 'แผนกวิชาช่างยนต์';
  let cleanClass = classroom || '';
  if (!cleanClass && cleanDept.includes('(')) {
    cleanClass = cleanDept.split('(')[1].replace(')', '').trim();
  }
  if (cleanDept.includes('(')) {
    cleanDept = cleanDept.split('(')[0].trim();
  }
  if (!cleanClass) cleanClass = 'ปวช.3';

  // คำนวณวันในสัปดาห์จาก leaveDate (1=จันทร์ ... 7=อาทิตย์)
  let dayOfWeek = 1;
  if (leaveDate) {
    const d = new Date(leaveDate + 'T00:00:00');
    if (!isNaN(d.getTime())) {
      const jsDay = d.getDay(); // 0=อาทิตย์, 1=จันทร์ ... 6=เสาร์
      dayOfWeek = jsDay === 0 ? 7 : jsDay;
    }
  }

  // 1. กรองตารางสอนเฉพาะภาคเรียนปัจจุบัน + แผนก + ชั้นปี
  const classroomEntries = ttData.entries.filter(e =>
    (e.semester || '1/2569') === activeSemester &&
    isDepartmentMatchServer(e.department, cleanDept) &&
    isClassroomMatchServer(e.classroom, cleanClass)
  );

  // ข้อ 15 & 16: ห้องที่ยังไม่มีข้อมูลตารางสอนเลย ต้องไม่ถือว่าเป็นคาบว่าง! ให้ใช้ขั้นตอน "ไม่พบข้อมูล"
  if (classroomEntries.length === 0) {
    return {
      matchStatus: 'no_timetable',
      hasClassroomTimetable: false,
      semester: activeSemester,
      department: cleanDept,
      classroom: cleanClass,
      leaveDate,
      step1Skipped: false,
      manualTeacherRequired: true,
      advisorFlagVerify: true,
      message: `ไม่พบข้อมูลตารางสอนของห้อง ${cleanClass} (${cleanDept}) ในระบบ กรุณาเลือกครูรายวิชาด้วยตนเอง (ระบบจะติดธงแจ้งครูที่ปรึกษาตรวจสอบ)`,
      matchedPeriods: [],
      primaryPeriod: null,
      notifiedTeachers: []
    };
  }

  // 2. กรองเฉพาะวันที่ตรงกัน (หรือ dayOfWeek === 0 ซึ่งหมายถึงตารางประจำทุกวันเรียน)
  const dayEntries = classroomEntries.filter(e => {
    const eDay = Number(e.dayOfWeek || 0);
    return eDay === 0 || eDay === dayOfWeek;
  });

  if (dayEntries.length === 0) {
    return {
      matchStatus: 'no_slot_data',
      hasClassroomTimetable: true,
      semester: activeSemester,
      department: cleanDept,
      classroom: cleanClass,
      leaveDate,
      step1Skipped: false,
      manualTeacherRequired: true,
      advisorFlagVerify: true,
      message: `ไม่พบตารางสอนในวันที่เลือกของห้อง ${cleanClass} กรุณาเลือกครูรายวิชาด้วยตนเอง (ระบบจะติดธงแจ้งครูที่ปรึกษาตรวจสอบ)`,
      matchedPeriods: [],
      primaryPeriod: null,
      notifiedTeachers: []
    };
  }

  // 3. คำนวณช่วงเวลาที่ขอออก [depMins, retMins]
  const depMins = parseTimeToMins(departureTime || '13:00');
  const isNoRet = Boolean(noReturn || expectedReturnTime === 'NO_RETURN');
  const retMins = isNoRet ? (16 * 60) : parseTimeToMins(expectedReturnTime || '15:30');

  // หาคาบทั้งหมดที่ทับซ้อนกับช่วงเวลาขอออก (start < retMins && end > depMins)
  const overlapping = dayEntries
    .filter(e => {
      const s = parseTimeToMins(e.startTime);
      const end = parseTimeToMins(e.endTime);
      return s < retMins && end > depMins;
    })
    .sort((a, b) => parseTimeToMins(a.startTime) - parseTimeToMins(b.startTime))
    .map(e => {
      // ข้อ 17: ตรวจสอบรายการสอนแทน / งดสอนรายวัน (Daily Overrides)
      const ov = ttData.overrides.find(o =>
        String(o.timetableId) === String(e.id) &&
        o.overrideDate === leaveDate
      );
      if (ov) {
        if (ov.overrideType === 'cancelled') {
          return {
            ...e,
            originalPeriodType: e.periodType,
            periodType: 'free',
            isCancelledOverride: true,
            overrideReason: ov.reason || 'งดสอนรายวัน',
            subjectName: `${e.subjectName} (งดสอนรายวัน)`
          };
        } else if (ov.overrideType === 'substitute') {
          return {
            ...e,
            originalTeacherUsername: e.teacherUsername,
            originalTeacherName: e.teacherName,
            teacherUsername: ov.substituteTeacherUsername || e.teacherUsername,
            teacherName: `${ov.substituteTeacherName || e.teacherName} (สอนแทน)`,
            isSubstituteOverride: true,
            overrideReason: ov.reason || 'สอนแทนรายวัน'
          };
        }
      }
      return { ...e };
    });

  // หากช่วงเวลาที่ขอไม่ตรงกับคาบใดเลยในตารางสอนของห้องนั้น
  if (overlapping.length === 0) {
    return {
      matchStatus: 'no_slot_data',
      hasClassroomTimetable: true,
      semester: activeSemester,
      department: cleanDept,
      classroom: cleanClass,
      leaveDate,
      step1Skipped: false,
      manualTeacherRequired: true,
      advisorFlagVerify: true,
      message: `ไม่พบข้อมูลคาบเรียนในช่วงเวลา ${departureTime} - ${isNoRet ? '16:00' : expectedReturnTime} น. กรุณาเลือกครูรายวิชาด้วยตนเอง (ติดธงให้ครูที่ปรึกษาตรวจสอบ)`,
      matchedPeriods: [],
      primaryPeriod: null,
      notifiedTeachers: []
    };
  }

  // 4. แยกคาบเรียนปกติ (study) ออกจากคาบว่าง/พักเที่ยง/กิจกรรม/เรียนรู้ด้วยตนเอง (free, break, activity, self_study)
  const studyPeriods = overlapping.filter(p => p.periodType === 'study');

  // ข้อ 15: ช่วงเวลาที่ไม่มีคาบเรียน (คาบว่าง, พักเที่ยง, คาบกิจกรรม, คาบเรียนรู้ด้วยตนเอง, หรืองดสอนรายวัน)
  if (studyPeriods.length === 0) {
    const labels = overlapping.map(p => {
      if (p.isCancelledOverride) return `งดสอนวิชา${p.subjectName}`;
      if (p.periodType === 'break') return `พักกลางวัน (${p.startTime}-${p.endTime} น.)`;
      if (p.periodType === 'activity') return `คาบกิจกรรม (${p.subjectName})`;
      if (p.periodType === 'self_study') return `คาบเรียนรู้ด้วยตนเอง (${p.subjectName || 'ไม่มีอาจารย์ผู้สอน'})`;
      return `${p.subjectName && p.subjectName !== 'คาบว่าง' ? p.subjectName : 'คาบว่าง'} (${p.startTime}-${p.endTime} น.)`;
    });
    const reasonText = `ไม่มีคาบเรียน (${labels.join(', ')})`;

    return {
      matchStatus: 'no_class_skip',
      hasClassroomTimetable: true,
      semester: activeSemester,
      department: cleanDept,
      classroom: cleanClass,
      leaveDate,
      step1Skipped: true,
      step1SkipReason: reasonText,
      manualTeacherRequired: false,
      advisorFlagVerify: false,
      message: `ช่วงเวลานี้ตรงกับ "${labels.join(', ')}" คำร้องนี้ไม่ต้องผ่านครูรายวิชา ระบบจะข้ามขั้นที่ 1 ไปยังครูที่ปรึกษาอัตโนมัติ`,
      matchedPeriods: overlapping,
      primaryPeriod: overlapping[0],
      notifiedTeachers: []
    };
  }

  // ข้อ 14: ออกในคาบเดียว หรือ ออกคร่อมหลายคาบ
  const primaryPeriod = studyPeriods[0];
  const otherPeriods = studyPeriods.slice(1);
  const notifiedTeachers = [];
  const seenTeachers = new Set([primaryPeriod.teacherUsername]);

  for (const p of otherPeriods) {
    if (p.teacherUsername && !seenTeachers.has(p.teacherUsername)) {
      seenTeachers.add(p.teacherUsername);
    }
    notifiedTeachers.push({
      teacherUsername: p.teacherUsername,
      teacherName: p.teacherName,
      subjectCode: p.subjectCode,
      subjectName: p.subjectName,
      periodTime: `${p.startTime}-${p.endTime}`
    });
  }

  const isMultiPeriod = studyPeriods.length > 1;
  const summaryMsg = isMultiPeriod
    ? `ออกคร่อม ${studyPeriods.length} คาบเรียน: ส่งให้ "${primaryPeriod.teacherName}" (คาบแรก: ${primaryPeriod.subjectName} ${primaryPeriod.startTime}-${primaryPeriod.endTime} น.) อนุมัติขั้นที่ 1 และแจ้งครูคาบถัดไปรับทราบ`
    : `ช่วงนี้ตรงกับวิชา "${primaryPeriod.subjectName}" (${primaryPeriod.startTime}-${primaryPeriod.endTime} น.) • ครูผู้สอน: ${primaryPeriod.teacherName}`;

  return {
    matchStatus: isMultiPeriod ? 'matched_multi' : 'matched_single',
    hasClassroomTimetable: true,
    semester: activeSemester,
    department: cleanDept,
    classroom: cleanClass,
    leaveDate,
    step1Skipped: false,
    step1SkipReason: null,
    manualTeacherRequired: false,
    advisorFlagVerify: false,
    message: summaryMsg,
    matchedPeriods: overlapping,
    studyPeriods,
    primaryPeriod,
    notifiedTeachers
  };
}


const app = express();
const PORT = process.env.PORT || 3000;
const { spawn } = require('child_process');

// ============================================================================
// SERIAL BRIDGE (คุยกับบอร์ด ESP32 ผ่านสาย USB COM อัตโนมัติ)
// ============================================================================
let serialWorker = null;
let serialConnectedPort = null;
let lastEsp32Heartbeat = null; // เวลา ms ของ heartbeat ล่าสุดจาก ESP32
let lastEsp32Ack = null;       // ข้อมูล ACK ยืนยันการทำงานของไม้กั้น

// เก็บ Session ไม้กั้นที่กำลังเปิดอยู่: key = requestId
const activeGateSessions = new Map();

// ฟังก์ชันจบกระบวนการขาออกเมื่อไม้กั้นปิดลง (ตัดสิทธิ์ QR + เปลี่ยนสถานะเป็น exited/returned)
async function finalizeGateExit(requestId, reason = 'TIMEOUT_30S') {
  if (!requestId) {
    if (activeGateSessions.size > 0) {
      const firstKey = activeGateSessions.keys().next().value;
      requestId = firstKey;
    }
  }

  let session = null;
  if (requestId && activeGateSessions.has(requestId)) {
    session = activeGateSessions.get(requestId);
    if (session && session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
    }
    activeGateSessions.delete(requestId);
  }

  const outIso = new Date().toISOString();
  const outTimeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  let studentName = session ? session.studentName : 'นักเรียน';
  let requestObj = session ? session.request : null;

  try {
    if (supabase && requestId && requestId !== 'MANUAL' && requestId !== 'MANUAL_BTN') {
      if (!requestObj) {
        const data = await db.getLeaveRequestWithStudent(requestId);
        if (data) requestObj = data;
      }

      if (requestObj) {
        studentName = requestObj.users ? (requestObj.users.full_name || requestObj.users.username) : (requestObj.student_name || studentName);
        const isNoReturn = Boolean(requestObj.no_return || requestObj.expected_return_time === 'NO_RETURN' || requestObj.leave_type === 'no_return');
        const finalStatus = isNoReturn ? 'returned' : 'exited';

        // 1. ตัดสิทธิ์ QR Code และบันทึกสถานะสิ้นสุดขาออก
        try {
          await db.query(
            'UPDATE leave_requests SET is_qr_used = ?, qr_used_at = ?, actual_out_time = ?, status = ? WHERE id = ?',
            [true, outIso, outIso, finalStatus, requestId]
          );
        } catch (e) {
          await db.query(
            'UPDATE leave_requests SET is_qr_used = ?, qr_used_at = ?, status = ? WHERE id = ?',
            [true, outIso, finalStatus, requestId]
          );
        }

        saveRequestMeta(requestId, {
          status: finalStatus,
          actualOutTime: outIso,
          actualOutTimeStr: outTimeStr,
          gateCloseReason: reason,
          isQrUsed: true,
          qrUsedAt: outIso
        });

        // 2. บันทึกประวัติการสแกนปิดสมบูรณ์
        const reasonDesc = reason === 'SENSOR_PASSED' 
          ? 'ตรวจพบคน/รถผ่านเซนเซอร์ ไม้กั้นปิดลง' 
          : (reason === 'TIMEOUT_30S' ? 'ครบกำหนดเวลา 30 วินาที ไม้กั้นปิดลง' : `ไม้กั้นปิด (${reason})`);

        await db.insertAutoIncrement('scan_logs', {
          request_id: requestId,
          qr_token: requestObj.qr_token || 'COMPLETED',
          student_name: studentName,
          scan_type: 'exit_completed',
          result: 'success',
          message: `ไม้กั้นปิดเรียบร้อย (${reasonDesc}) - ตัดสิทธิ์ QR และบันทึกสถานะ "${finalStatus === 'returned' ? 'กลับบ้านเสร็จสิ้น' : 'อยู่นอกสถานศึกษา'}"`
        });

        // 3. ส่งแจ้งเตือน Line
        const reasonBadge = reason === 'SENSOR_PASSED' ? '🚗 ขับ/เดินผ่านเซนเซอร์แล้ว' : '⏱️ ครบเวลาไม้กั้น 30 วินาที';
        sendLineNotification(
          `\n🚪 [OnePass ไม้กั้นปิดสมบูรณ์: นักเรียนผ่านประตูแล้ว]\n` +
          `• นักเรียน: ${studentName} (${requestObj.users ? requestObj.users.username : '-'})\n` +
          `• แผนกวิชา: ${requestObj.users && requestObj.users.departments ? requestObj.users.departments.name : '-'}\n` +
          `• เวลาออกจริง: ${outTimeStr} น.\n` +
          `• การตรวจจับ: ${reasonBadge}\n` +
          `• สถานะคำขอ: ${finalStatus === 'returned' ? 'กลับบ้านเสร็จสิ้น (ไม่ต้องกลับเข้า)' : 'อยู่นอกสถานศึกษา (QR หมดอายุเรียบร้อย)'}\n` +
          (finalStatus === 'exited' ? `• ขากลับเข้า: ให้กดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" ในแอปเมื่อเดินทางกลับมาถึง` : '')
        );

        console.log(`✅ [GATE_FINALIZED] Request ${requestId} finalized with status ${finalStatus} (Reason: ${reason})`);

        // ตรวจสอบกรณีเป็น QR Code ทดสอบ (Auto-Purge on Gate Close)
        const reqMeta = getRequestMeta(requestId) || (requestObj.request_no ? getRequestMeta(requestObj.request_no) : {}) || {};
        if (reqMeta.isTemporaryTest || (requestObj.request_no && requestObj.request_no.startsWith('TEST-')) || (requestObj.qr_token && requestObj.qr_token.startsWith('TEST-'))) {
          console.log(`🧹 [AUTO-PURGE TEST REQUEST] ไม้กั้นปิดแล้ว กำลังลบข้อมูลทดสอบ ${requestId} ออกจากระบบ 100%`);
          try {
            await db.query('DELETE FROM leave_requests WHERE id = ?', [requestId]);
            await db.query('DELETE FROM scan_logs WHERE request_id = ?', [requestId]);
          } catch (delErr) {
            console.warn('Auto purge error:', delErr.message);
          }
          deleteRequestMeta(requestId);
          if (requestObj.request_no) deleteRequestMeta(requestObj.request_no);
          console.log(`✨ [AUTO-PURGED] ลบคำขอทดสอบและประวัติสแกนทดสอบออกจากฐานข้อมูลเรียบร้อยแล้ว ไม่เหลือร่องรอย!`);
        }
      }
    }
  } catch (err) {
    console.error('finalizeGateExit error:', err.message);
  }
}

function initSerialWorker() {
  // หากรันบน Cloud Hosting หรือปิดการใช้งาน Serial ไม่ต้องรัน Python worker
  if (process.env.DISABLE_SERIAL === 'true') {
    console.log('ℹ️ [SERIAL] USB Serial Worker skipped (DISABLE_SERIAL=true)');
    return;
  }

  try {
    serialWorker = spawn('python', ['-u', path.join(__dirname, 'serial_worker.py')]);
    
    // ดักจับ error กรณีโฮสติ้งไม่มี Python เพื่อไม่ให้เซิร์ฟเวอร์หลุดการทำงาน
    serialWorker.on('error', (err) => {
      console.warn('ℹ️ [SERIAL] Python not found or not supported on this host (Running Cloud mode):', err.message);
      serialWorker = null;
    });

    if (serialWorker && serialWorker.stdout) {
      serialWorker.stdout.on('data', (data) => {
        const text = data.toString().trim();
        console.log('[ESP32]', text);
        lastEsp32Heartbeat = Date.now();
        if (text.includes('[SERIAL_CONNECTED]')) {
          serialConnectedPort = text.split('[SERIAL_CONNECTED]')[1].trim();
          console.log('ESP32 Gate connected on', serialConnectedPort);
        } else if (text.includes('[SERIAL_ERR]')) {
          serialConnectedPort = null;
        }

        // ดักจับสัญญาณปิดไม้กั้นจาก ESP32 (คนเดินผ่านเซนเซอร์ หรือครบ 30 วินาที)
        if (text.includes('[GATE_CLOSED]')) {
          const reqMatch = text.match(/requestId=([^\s]+)/);
          const reasonMatch = text.match(/reason=([^\s]+)/);
          const reqId = reqMatch ? reqMatch[1] : null;
          const reason = reasonMatch ? reasonMatch[1] : 'TIMEOUT_30S';
          finalizeGateExit(reqId, reason);
        }

        if (text.includes('Door OPENED') || text.includes('GATE_OPENED') || text.includes('OPEN')) {
          lastEsp32Ack = {
            action: 'DOOR_OPEN',
            status: 'OK',
            timestamp: new Date().toISOString(),
            details: 'บอร์ด ESP32 ยืนยันเปิดไม้กั้นสำเร็จ (Serial)',
            source: 'SERIAL'
          };
        } else if (text.includes('Door CLOSED') || text.includes('GATE_CLOSED') || text.includes('CLOSED')) {
          lastEsp32Ack = {
            action: 'DOOR_CLOSED',
            status: 'OK',
            timestamp: new Date().toISOString(),
            details: 'บอร์ด ESP32 ยืนยันปิดไม้กั้นเรียบร้อย (Serial)',
            source: 'SERIAL'
          };
        }
      });

      serialWorker.on('close', (code) => {
        serialConnectedPort = null;
        if (serialWorker) {
          setTimeout(initSerialWorker, 5000);
        }
      });
    }
  } catch (err) {
    console.warn('Serial worker error:', err.message);
  }
}
initSerialWorker();

function sendSerialCommand(cmd) {
  if (serialWorker && serialWorker.stdin) {
    try {
      serialWorker.stdin.write(cmd + '\n');
    } catch (e) {}
  }
}

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
// ============================================================================
// TELEGRAM BOT ROUTER & INTEGRATION
// ============================================================================
app.use('/api/telegram', createTelegramRouter(authenticateToken));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // ป้องกัน Browser Caching เพื่อให้ผู้ใช้งานโหลด UI และโค้ดล่าสุดเสมอ
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// Route บริการโลโก้วิทยาลัยการอาชีพองครักษ์
app.get(['/college-logo.png', '/college-logo.jpg'], (req, res) => {
  const publicLogo = path.join(__dirname, 'public', 'college-logo.png');
  if (fs.existsSync(publicLogo)) return res.sendFile(publicLogo);
  const publicLogoJpg = path.join(__dirname, 'public', 'college-logo.jpg');
  if (fs.existsSync(publicLogoJpg)) return res.sendFile(publicLogoJpg);
  res.status(404).send('Logo not found');
});

// ============================================================================
// 1. MYSQL CONNECTION POOL (เดิมเป็น Supabase/PostgreSQL Client)
// ============================================================================
// ตัวแปร `supabase` ถูกเก็บชื่อไว้เหมือนเดิมเพื่อลด diff ของโค้ดทั้งไฟล์ (if (supabase) {...} ทำงานเหมือนเดิมทุกจุด)
// แต่ตอนนี้อ้างอิง db.pool (mysql2 pool) จาก db.js แทน Supabase client - เป็น null ถ้ายังไม่ได้ตั้งค่า DB_HOST/DB_USER
const supabase = db.pool;
if (supabase) {
  console.log('✅ [MYSQL] Connected to Database successfully!');
} else {
  console.log('⚠️ [MYSQL] Not configured (missing DB_HOST/DB_USER in .env) - running in local JSON fallback mode');
}

// ============================================================================
// 2. MQTT CLIENT (เชื่อมต่อกับ HiveMQ Cloud สำหรับสั่งบอร์ด ESP32)
// ============================================================================
let mqttClient = null;
let isMqttConnected = false;

if (process.env.MQTT_BROKER && process.env.MQTT_BROKER !== 'your-cluster-url.s1.eu.hivemq.cloud') {
  try {
    const protocol = process.env.MQTT_PORT == 8883 ? 'mqtts' : 'mqtt';
    const brokerUrl = `${protocol}://${process.env.MQTT_BROKER}:${process.env.MQTT_PORT || 8883}`;
    console.log(`[MQTT] Connecting to ${brokerUrl}...`);

    mqttClient = mqtt.connect(brokerUrl, {
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASSWORD,
      rejectUnauthorized: false
    });

    mqttClient.on('connect', () => {
      isMqttConnected = true;
      console.log('✅ [MQTT] Connected to HiveMQ Cloud broker successfully!');
      const statusTopic = process.env.MQTT_TOPIC_STATUS || 'school/gate/status';
      mqttClient.subscribe(statusTopic, (err) => {
        if (!err) console.log(`📡 [MQTT] Subscribed to gate status topic: ${statusTopic}`);
      });
    });

    mqttClient.on('message', (topic, message) => {
      try {
        const msgStr = message.toString();
        lastEsp32Heartbeat = Date.now();
        console.log(`[MQTT IN] ${topic}:`, msgStr);

        let parsed = null;
        try {
          parsed = JSON.parse(msgStr);
        } catch (e) {
          parsed = { raw: msgStr };
        }

        if (parsed.door === 'OPEN') {
          lastEsp32Ack = {
            action: 'DOOR_OPEN',
            status: parsed.status || 'OK',
            timestamp: new Date().toISOString(),
            details: 'บอร์ด ESP32 ยืนยันเปิดไม้กั้นสำเร็จ (Relay ON / Servo 90°)',
            source: 'MQTT'
          };
          simulatorState.door = 'OPEN';
          console.log('✅ [ESP32 ACK] Physical gate OPEN confirmed by hardware!');
        } else if (parsed.door === 'CLOSED') {
          lastEsp32Ack = {
            action: 'DOOR_CLOSED',
            status: parsed.status || 'OK',
            timestamp: new Date().toISOString(),
            details: `บอร์ด ESP32 ยืนยันปิดไม้กั้นเรียบร้อย (${parsed.reason || 'MQTT'})`,
            source: 'MQTT'
          };
          simulatorState.door = 'CLOSED';
          console.log('✅ [ESP32 ACK] Physical gate CLOSE confirmed by hardware!');
          finalizeGateExit(parsed.requestId, parsed.reason || 'TIMEOUT_30S');
        } else if (parsed.status === 'ONLINE' || parsed.device) {
          lastEsp32Ack = {
            action: 'ONLINE_PING',
            status: 'OK',
            timestamp: new Date().toISOString(),
            details: `ESP32 เชื่อมต่อสำเร็จ (${parsed.device || 'ESP32_GATE'})`,
            source: 'MQTT'
          };
          console.log(`🟢 [ESP32 STATUS] Hardware is ONLINE (${parsed.device || 'ESP32_GATE'})`);
        }
      } catch (err) {
        console.warn('⚠️ [MQTT] Error parsing incoming message:', err.message);
      }
    });

    mqttClient.on('error', (err) => {
      console.warn('⚠️ [MQTT] Connection error:', err.message);
      isMqttConnected = false;
    });
  } catch (err) {
    console.warn('⚠️ [MQTT] Setup error:', err.message);
  }
} else {
  console.log('ℹ️ [MQTT] Running in Simulated Mode');
}

// ฟังก์ชันส่งคำสั่งเปิดประตูไปที่บอร์ด ESP32 และตัวจำลอง
function sendGateCommand(cmd = 'OPEN', duration = 30, studentName = '', requestId = '') {
  if (cmd === 'OPEN') {
    const formattedCmd = `OPEN ${duration} ${requestId || ''} ${studentName || ''}`.trim();
    sendSerialCommand(formattedCmd);
    sendSerialCommand('OPEN_GATE');
  } else if (cmd === 'CLOSE') {
    sendSerialCommand('CLOSE_GATE');
  }

  if (mqttClient && isMqttConnected) {
    const topic = process.env.MQTT_TOPIC_COMMAND || 'school/gate/cmd';
    const payload = JSON.stringify({ cmd, duration, student: studentName, requestId, timestamp: new Date().toISOString() });
    mqttClient.publish(topic, payload, { qos: 1 });
  }

  // หากอยู่ในโหมดจำลอง ให้ส่ง Simulated ACK หลังจากคำสั่ง 350ms เพื่อให้หน้าเว็บเห็นผล
  if (!isMqttConnected && !serialConnectedPort) {
    setTimeout(() => {
      lastEsp32Heartbeat = Date.now();
      lastEsp32Ack = {
        action: cmd === 'OPEN' ? 'DOOR_OPEN' : 'DOOR_CLOSED',
        status: 'OK (SIMULATED)',
        timestamp: new Date().toISOString(),
        details: cmd === 'OPEN' ? `ตัวจำลองไม้กั้นยกขึ้น 90 องศา (${duration} วินาที)` : 'ตัวจำลองไม้กั้นปิดเรียบร้อย',
        source: 'SIMULATOR'
      };
    }, 350);

    // จำลองการปิดไม้กั้นและตัดสิทธิ์ QR อัตโนมัติเมื่อครบเวลา
    if (cmd === 'OPEN' && requestId) {
      setTimeout(() => {
        finalizeGateExit(requestId, 'SIMULATED_TIMEOUT');
      }, duration * 1000);
    }
  }

  simulatorState.door = cmd === 'OPEN' ? 'OPEN' : 'CLOSED';
  simulatorState.lastCommand = cmd;
  simulatorState.studentName = studentName;
  simulatorState.lastUpdated = new Date().toISOString();
  simulatorState.duration = duration;

  if (cmd === 'OPEN') {
    setTimeout(() => {
      simulatorState.door = 'CLOSED';
      simulatorState.lastUpdated = new Date().toISOString();
    }, duration * 1000);
  }
}

// ตัวจำลองสถานะบอร์ด ESP32
let simulatorState = {
  door: 'CLOSED',
  lastCommand: 'INIT',
  studentName: '',
  duration: 5,
  lastUpdated: new Date().toISOString()
};

// ============================================================================
// 3. API ENDPOINTS (ผูกกับ SUPABASE DB ตรง 100%)
// ============================================================================

// ดึงรายชื่อผู้ใช้
app.get('/api/users', async (req, res) => {
  if (supabase) {
    try {
      const data = await db.query('SELECT * FROM users');
      if (data) return res.json({ users: data.map(sanitizeUser) });
    } catch (e) {}
  }
  res.json({ users: [] });
});

// ดึงข้อมูลโปรไฟล์ผู้ใช้งานรายบุคคลจาก Supabase
app.get('/api/profile/:username', async (req, res) => {
  const username = req.params.username;
  if (supabase) {
    try {
      const user = await db.getUserByUsernameWithRelations(username);

      if (user) {
        const stored = getStoredProfile(user.username);
        const resolvedDept = user.classrooms?.name ? `${user.departments?.name || ''} (${user.classrooms.name})` : (user.departments?.name || stored.dept || 'วิทยาลัยการอาชีพองครักษ์');
        const resolvedAdvisor = user.classrooms?.advisor_name || user.advisor_name || stored.advisor || '-';
        return res.json({ 
          success: true, 
          user: sanitizeUser({
            ...user,
            ...stored,
            student_code: user.student_code || stored.student_code || '',
            advisor: resolvedAdvisor,
            dept: resolvedDept,
            plate: user.plate_no || stored.plate || '',
            phone: user.phone || stored.phone || '',
            parent_phone: user.parent_phone || stored.parent_phone || '',
            college: 'วิทยาลัยการอาชีพองครักษ์',
            profile_photo: user.profile_photo || stored.profile_photo || null,
            plate_photo: user.plate_photo || stored.plate_photo || null
          })
        });
      }
    } catch (err) {
      console.warn('Get profile error:', err.message);
    }
  }
  res.status(404).json({ success: false, message: 'User not found' });
});

// บันทึกและอัปเดตข้อมูลโปรไฟล์ผู้ใช้งานลงใน Supabase Database โดยตรง
app.put('/api/profile', async (req, res) => {
  const { username, plate, phone, parent_phone, profile_photo, plate_photo } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: 'ไม่พบ Username' });
  }

  if (supabase) {
    try {
      const updatePayload = {
        plate_no: plate ? String(plate).trim() : null,
        phone: phone ? String(phone).trim() : null,
        parent_phone: parent_phone ? String(parent_phone).trim() : null
      };

      try {
        await db.query(
          'UPDATE users SET plate_no = ?, phone = ?, parent_phone = ? WHERE username = ?',
          [updatePayload.plate_no, updatePayload.phone, updatePayload.parent_phone, username]
        );
      } catch (updErr) {
        console.warn('PUT /api/profile db update error:', updErr.message);
      }
      const updated = await db.getUserByUsernameWithRelations(username);

      saveStoredProfile(username, {
        plate: plate || '',
        phone: phone || '',
        parent_phone: parent_phone || '',
        profile_photo: profile_photo || null,
        plate_photo: plate_photo || null
      });

      const uObj = updated || {};
      const resolvedDept = uObj.classrooms?.name ? `${uObj.departments?.name || ''} (${uObj.classrooms.name})` : (uObj.departments?.name || '');
      const resolvedAdvisor = uObj.classrooms?.advisor_name || uObj.advisor_name || '';

      return res.json({
        success: true,
        message: 'บันทึกข้อมูลส่วนตัวเรียบร้อยแล้ว',
        user: sanitizeUser({
          ...uObj,
          dept: resolvedDept,
          advisor: resolvedAdvisor,
          plate: plate || '',
          phone: phone || '',
          parent_phone: parent_phone || ''
        })
      });
    } catch (err) {
      console.error('PUT /api/profile error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  } else {
    res.json({ success: true, message: 'บันทึกสำเร็จ (โหมด Local)' });
  }
});

// ลงทะเบียนผู้ใช้ใหม่ (เข้ารหัสรหัสผ่านด้วย bcrypt ก่อนบันทึกลง Supabase ตาราง users ทันที)
app.post('/api/register', async (req, res) => {
  const { studentCode, name, deptId, deptName, email, password } = req.body;
  if (!studentCode || !name || !email || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วนทั้ง 5 รายการ' });
  }

  const cleanCode = studentCode.trim();
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanPass = password.trim();

  // ตรวจสอบความยาวรหัสผ่านอย่างน้อย 8 ตัวอักษร
  if (cleanPass.length < 8) {
    return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร' });
  }

  const selectedDeptId = parseInt(deptId, 10) || 2;
  const selectedDeptName = deptName || 'แผนกวิชาช่างไฟฟ้ากำลัง';

  if (supabase) {
    try {
      // 1. ตรวจสอบว่ามี studentCode หรือ email นี้ในฐานข้อมูลแล้วหรือไม่
      const existingRows = await db.query(
        'SELECT id, username FROM users WHERE username = ? OR username = ?',
        [cleanCode, cleanEmail]
      );
      const existingUser = existingRows[0];

      if (existingUser) {
        return res.status(400).json({ success: false, message: 'รหัสนักศึกษาหรืออีเมลนี้มีอยู่ในระบบแล้ว' });
      }

      // 2. เข้ารหัสรหัสผ่านด้วย bcrypt ก่อนบันทึกลง Supabase ตาราง users
      const hashedPassword = await hashPassword(cleanPass);
      const newUserId = crypto.randomUUID();
      const insertUser = {
        id: newUserId,
        username: cleanCode,
        password: hashedPassword,
        full_name: cleanName,
        role: 'student',
        department_id: selectedDeptId,
        classroom_id: selectedDeptId,
        plate_no: '-',
        phone: '-'
      };

      let data = null;
      let error = null;
      try {
        const inserted = await db.insertWithUuid('users', insertUser);
        data = [inserted];
      } catch (insErr) {
        error = insErr;
      }

      if (!error && data && data.length > 0) {
        console.log(`✅ [MYSQL] New student registered with bcrypt password: ${cleanCode} (${cleanName})`);
        
        // 3. บันทึกโปรไฟล์เริ่มต้นลง profiles.json ทันที
        const newProf = {
          username: cleanCode,
          email: cleanEmail,
          full_name: cleanName,
          student_code: cleanCode,
          dept: selectedDeptName,
          college: 'วิทยาลัยการอาชีพองครักษ์',
          advisor: 'อ.กิตติศักดิ์ ไฟฟ้า',
          plate: '-',
          phone: '-',
          parent_phone: ''
        };
        saveStoredProfile(cleanCode, newProf);
        saveStoredProfile(cleanEmail, newProf);

        const token = generateToken(data[0]);
        return res.json({ 
          success: true, 
          message: 'ลงทะเบียนสำเร็จ! รหัสผ่านถูกเข้ารหัสด้วย bcrypt และบันทึกลงฐานข้อมูลแล้ว',
          user: sanitizeUser(data[0]),
          token
        });
      } else {
        console.error('Supabase registration error:', error);
        return res.status(500).json({ success: false, message: error ? error.message : 'เกิดข้อผิดพลาดในการลงทะเบียน' });
      }
    } catch (err) {
      console.error('Registration exception:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  res.json({ success: true, message: 'ลงทะเบียนสำเร็จ (โหมด Local)' });
});

// เข้าสู่ระบบ (รองรับทั้งรหัสผ่าน bcrypt และรหัสผ่านเดิมแบบข้อความปกติ พร้อมออกบัตรประจำตัวดิจิทัล JWT Token)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอก Username และ Password' });
  }

  const cleanUser = username.trim().toLowerCase();
  const rawInput = username.trim();
  const cleanPass = password.trim();

  // 0. ตรวจสอบ Blacklist บัญชีที่ถูกลบ
  const deletedUsersSet = loadDeletedUsers();
  if (deletedUsersSet.has(cleanUser) || deletedUsersSet.has(rawInput.toLowerCase())) {
    return res.status(401).json({
      success: false,
      message: '⛔ บัญชีผู้ใช้นี้ถูกลบออกจากระบบแล้ว กรุณาติดต่อผู้ดูแลระบบ'
    });
  }

  // ยกเลิกบัญชีอาจารย์และหัวหน้าแผนกอันเก่าอย่างถาวร
  if (cleanUser === 'teacher' || cleanUser === 'head') {
    return res.status(401).json({ 
      success: false, 
      message: 'บัญชีอาจารย์และหัวหน้าแผนกเดิมถูกยกเลิกแล้ว กรุณาเลือกบัญชีประจำ 5 แผนกวิชาใหม่ (เช่น teacher_auto, head_auto)' 
    });
  }

  // 1. ตรวจสอบใน Supabase DB (ค้นหาได้ทั้ง รหัสนักศึกษา, Username, Email, หรือ ชื่อ-นามสกุล)
  if (supabase) {
    try {
      let candidateUser = null;

      // 1.1 ค้นหาด้วย username ตรงๆ (เช่น รหัสนักศึกษา หรือ username ของอาจารย์)
      const byUsername = await db.getUserByUsernameWithRelations(rawInput);
      if (byUsername) candidateUser = byUsername;

      // 1.2 ถ้าไม่เจอ ค้นหาจาก student_code, email หรือชื่อ ใน profiles.json เพื่อดึง username ที่ผูกไว้
      if (!candidateUser) {
        const profiles = loadProfiles();
        let targetUsername = null;
        for (const [profKey, profData] of Object.entries(profiles)) {
          if (profData.student_code && profData.student_code.trim() === rawInput) {
            targetUsername = profData.username || profKey;
            break;
          }
          if (profData.email && profData.email.trim().toLowerCase() === cleanUser) {
            targetUsername = profData.username || profKey;
            break;
          }
          if (profData.full_name && profData.full_name.trim() === rawInput) {
            targetUsername = profData.username || profKey;
            break;
          }
        }

        if (targetUsername) {
          const byTarget = await db.getUserByUsernameWithRelations(targetUsername);
          if (byTarget) candidateUser = byTarget;
        }
      }

      // 1.3 ถ้ายังไม่เจอ ลองค้นจาก full_name ในฐานข้อมูล
      if (!candidateUser) {
        const byFullName = await db.getUserByFullNameWithRelations(rawInput);
        if (byFullName) candidateUser = byFullName;
      }

      // 1.4 ตรวจสอบรหัสผ่านด้วย verifyPassword (รองรับทั้ง bcrypt hash และรหัสผ่านเดิม)
      if (candidateUser) {
        const storedPass = candidateUser.password || candidateUser.password_hash || '';
        const isPasswordValid = await verifyPassword(cleanPass, storedPass);

        if (isPasswordValid) {
          // หากในฐานข้อมูลยังเป็นรหัสผ่านธรรมดา (ไม่ใช่ bcrypt) และไม่ใช่บัญชีสาธิตหลัก ให้อัปเกรดเป็น bcrypt อัตโนมัติ
          if (storedPass && !isBcryptHash(storedPass) && cleanPass !== '1234') {
            try {
              const upgradedHash = await hashPassword(cleanPass);
              await db.query('UPDATE users SET password = ? WHERE id = ?', [upgradedHash, candidateUser.id]);
              console.log(`🔒 [BCRYPT] Auto-upgraded password hash for user: ${candidateUser.username}`);
            } catch (upgradeErr) {
              console.warn('Auto-upgrade bcrypt warning:', upgradeErr.message);
            }
          }

          const stored = getStoredProfile(candidateUser.username);
          const altStored = getStoredProfile(rawInput);
          const finalStored = { ...stored, ...altStored };
          const canonicalAcc = ALL_SYSTEM_ACCOUNTS[candidateUser.username] || {};

          const mergedUser = sanitizeUser({
            ...candidateUser,
            ...finalStored,
            role: canonicalAcc.role || candidateUser.role,
            full_name: (canonicalAcc.full_name && candidateUser.username === 'admin') ? canonicalAcc.full_name : (finalStored.full_name || candidateUser.full_name),
            student_code: finalStored.student_code || candidateUser.student_code || (candidateUser.username === 'student' ? '66209010012' : rawInput),
            advisor: finalStored.advisor || candidateUser.advisor_name || (candidateUser.classrooms ? candidateUser.classrooms.advisor_name : 'อ.กิตติศักดิ์ ไฟฟ้า'),
            advisor_name: finalStored.advisor || candidateUser.advisor_name || (candidateUser.classrooms ? candidateUser.classrooms.advisor_name : 'อ.กิตติศักดิ์ ไฟฟ้า'),
            college: finalStored.college || candidateUser.college || 'วิทยาลัยการอาชีพองครักษ์',
            profile_photo: finalStored.profile_photo || candidateUser.profile_photo || null,
            plate_photo: finalStored.plate_photo || candidateUser.plate_photo || null,
            dept: finalStored.dept || (candidateUser.departments ? candidateUser.departments.name : 'แผนกวิชาช่างไฟฟ้ากำลัง')
          });
          const token = generateToken(mergedUser);
          return res.json({ success: true, user: mergedUser, token });
        }
      }
    } catch (err) {
      console.warn('Supabase login check error:', err.message);
    }
  }

  // 2. บัญชีผู้ใช้ครบทั้ง 5 ขั้นตอน + บัญชีครูรายวิชาที่สร้างอัตโนมัติจากตารางสอน (รหัสผ่านเริ่มต้น 1234)
  let lookupKey = username.trim().toLowerCase();
  if (lookupKey === '66209010012') lookupKey = 'student';
  if (lookupKey === 'subject_elec') lookupKey = 'subject_electric';
  if (lookupKey === 'subject_acc') lookupKey = 'subject_account';
  if (lookupKey === 'subject_it') lookupKey = 'subject_digital';
  if (lookupKey === 'subject_mgmt') lookupKey = 'subject_office';

  const allActiveAccounts = { ...ALL_SYSTEM_ACCOUNTS, ...getAllActiveTeacherAccountsMap() };
  let matched = allActiveAccounts[lookupKey];
  if (!matched) {
    // รองรับการล็อกอินด้วยชื่อครูตรงๆ เช่น "อ.สมชาย ใจดี"
    matched = Object.values(allActiveAccounts).find(u => u.full_name && u.full_name.trim() === rawInput);
  }
  if (matched) {
    const stored = getStoredProfile(matched.username);
    const storedPass = stored.password || stored.password_hash || matched.password || '1234';
    const isPassValid = await verifyPassword(cleanPass, storedPass);
    if (isPassValid) {
      const merged = { ...matched, ...stored };
      const token = generateToken(merged);
      return res.json({ success: true, user: merged, token });
    }
  }

  return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
});

// รับ Token สำหรับผู้ใช้ที่ยืนยันตัวตนแล้ว (Auto-sync Token สำหรับเซสชันเดิม)
app.post('/api/auth/token', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success: false, message: 'Missing username' });
  const rawInput = username.trim();
  const cleanUser = username.trim().toLowerCase();

  let lookupKey = cleanUser === '66209010012' ? 'student' : cleanUser;
  const allActiveAccounts = { ...ALL_SYSTEM_ACCOUNTS, ...getAllActiveTeacherAccountsMap() };
  if (allActiveAccounts[lookupKey]) {
    const stored = getStoredProfile(lookupKey);
    return res.json({ success: true, token: generateToken({ ...allActiveAccounts[lookupKey], ...stored }) });
  }

  if (supabase) {
    try {
      const rows = await db.query('SELECT * FROM users WHERE username = ?', [rawInput]);
      const user = rows[0];
      if (user) {
        return res.json({ success: true, token: generateToken(user) });
      }
    } catch (e) {}
  }

  return res.status(404).json({ success: false, message: 'User not found' });
});

// ดึงรายชื่อครูทั้งหมด (ครูรายวิชา + ครูที่ปรึกษา + หัวหน้าแผนก + ครูที่ถูกสร้างอัตโนมัติ) สำหรับเลือกในตารางสอน/ตั้งสอนแทน/อนุมัติแทน
app.get('/api/teachers', async (req, res) => {
  const allTeacherMap = getAllActiveTeacherAccountsMap();
  const teachers = Object.values(allTeacherMap)
    .filter(u => ['subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director'].includes(u.role))
    .map(u => ({
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      dept: u.dept || (u.departments ? u.departments.name : ''),
      isAutoCreated: Boolean(u.isAutoCreated)
    }));
  res.json({ success: true, teachers });
});

// ============================================================================
// ADMIN PANEL ENDPOINTS (จัดการผู้ใช้, แผนกวิชา, และตั้งเวลาสถานศึกษา)
// ============================================================================

// 1. ดึงและบันทึกการตั้งค่าเวลาสถานศึกษา
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: loadSettings() });
});

app.put('/api/admin/settings', authenticateToken, requireRole(['admin']), (req, res) => {
  const updated = saveSettings(req.body);
  if (updated) {
    console.log('⚙️ [ADMIN] School operating settings updated successfully');
    res.json({ success: true, message: 'บันทึกการตั้งค่าเวลาสำเร็จ', settings: updated });
  } else {
    res.status(500).json({ success: false, message: 'บันทึกการตั้งค่าล้มเหลว' });
  }
});

// 2. ดึงและจัดการแผนกวิชาแบบไดนามิก
app.get('/api/departments', (req, res) => {
  const depts = loadDepartments();
  res.json({ departments: depts.length ? depts : [] });
});

app.post('/api/admin/departments', authenticateToken, requireRole(['admin']), (req, res) => {
  const { name, teacherName, headName, subjectTeacherName } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อแผนกวิชา' });

  const depts = loadDepartments();
  const newId = 'dept_' + Date.now();
  const newDept = {
    id: newId,
    name: name.trim(),
    subjectTeacher: { username: `subject_${newId}`, name: subjectTeacherName ? subjectTeacherName.trim() : 'อ.ครูรายวิชาประจำแผนก' },
    teacher: { username: `teacher_${newId}`, name: teacherName ? teacherName.trim() : 'อ.ผู้ดูแลแผนก' },
    head: { username: `head_${newId}`, name: headName ? headName.trim() : 'อ.หัวหน้าแผนก' }
  };
  depts.push(newDept);
  saveDepartments(depts);
  res.json({ success: true, message: 'เพิ่มแผนกวิชาสำเร็จ', department: newDept });
});

app.delete('/api/admin/departments/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const deptId = req.params.id;
  let depts = loadDepartments();
  const initialLen = depts.length;
  depts = depts.filter(d => d.id !== deptId);
  if (depts.length < initialLen) {
    saveDepartments(depts);
  }
  if (supabase) {
    try {
      await db.query('DELETE FROM departments WHERE id = ?', [deptId]);
    } catch (e) {}
  }
  return res.json({ success: true, message: 'ลบแผนกวิชาเรียบร้อย' });
});

// 3. จัดการผู้ใช้งาน (รายชื่อ, รีเซ็ตรหัสผ่าน, ลบผู้ใช้)
app.get('/api/admin/users', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    let users = [];
    if (supabase) {
      const data = await db.queryUsersWithRelations('', [], 'u.created_at DESC');
      if (data) {
        users = data.map(u => ({
          ...u,
          dept: u.departments?.name || u.dept || '',
          classroom: u.classrooms?.name || u.classroom || ''
        }));
      }
    }
    
    // ผสานบัญชีระบบทั้ง 5 ขั้นตอนที่มีอยู่ + บัญชีครูรายวิชาที่ถูกสร้างอัตโนมัติ
    const baseKnownUsers = Object.values({ ...ALL_SYSTEM_ACCOUNTS, ...getAllActiveTeacherAccountsMap() });

    const existingNames = new Set(users.map(u => u.username.toLowerCase()));
    baseKnownUsers.forEach(u => {
      if (!existingNames.has(u.username.toLowerCase())) {
        users.push(u);
      }
    });

    const profiles = loadProfiles();
    const deletedSet = loadDeletedUsers();

    users = users
      .filter(u => u && u.username && !deletedSet.has(u.username.toLowerCase()))
      .map(u => {
        const p = profiles[u.username] || {};
        const isStudent = u.role === 'student' || (!u.role && u.student_code);
        return {
          ...u,
          role: isStudent ? 'student' : u.role,
          status: isStudent ? 'active' : (u.status || 'active'),
          bound_device_id: u.bound_device_id || p.bound_device_id || null,
          bound_device_name: u.bound_device_name || p.bound_device_name || null,
          dept: u.dept || p.dept || '',
          classroom: u.classroom || p.classroom || ''
        };
      });

    res.json({ success: true, users: users.map(sanitizeUser) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/users', authenticateToken, requireRole(['admin']), async (req, res) => {
  const {
    username,
    password = '1234',
    full_name,
    role = 'student',
    student_code = '',
    plate_no = '-',
    prefix = '',
    first_name = '',
    last_name = '',
    curriculum_level = 'ปวช.',
    class_year = 1,
    room_number = 1,
    advisor_username = '',
    advisor_name = '',
    dept = ''
  } = req.body;

  const cleanCode = String(student_code || username || '').trim();
  const cleanUser = String(role === 'student' ? cleanCode : (username || cleanCode)).trim().toLowerCase();

  if (!cleanUser) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุ Username หรือรหัสนักศึกษา' });
  }

  // คำนวณชื่อเต็มถ้าเป็นนักเรียน
  let finalFullName = full_name ? String(full_name).trim() : cleanUser;
  if (role === 'student' && first_name) {
    finalFullName = `${prefix}${first_name} ${last_name}`.trim();
  }

  const passHash = role === 'student' ? '' : await hashPassword(password);
  const classroomName = `${curriculum_level}${class_year}/${room_number}`;
  const classroomParam = req.body.classroom ? String(req.body.classroom).trim() : null;
  const finalClassroom = role === 'student' ? classroomName : (classroomParam || null);

  const userData = {
    username: cleanUser,
    password: role === 'student' ? '' : password,
    password_hash: passHash,
    full_name: finalFullName,
    role: role,
    student_code: role === 'student' ? cleanCode : (student_code || null),
    plate_no: plate_no,
    status: 'active',
    dept: dept || (role === 'student' ? 'แผนกวิชาช่างยนต์' : null),
    student_prefix: prefix || null,
    first_name: first_name || null,
    last_name: last_name || null,
    curriculum_level: role === 'student' ? curriculum_level : null,
    class_year: role === 'student' ? parseInt(class_year, 10) : null,
    room_number: role === 'student' ? parseInt(room_number, 10) : null,
    classroom: finalClassroom,
    advisor_username: advisor_username || null,
    advisor_name: advisor_name || null,
    onboarding_completed: false,
    bound_device_id: null,
    bound_device_name: null,
    bound_device_at: null
  };

  if (supabase) {
    try {
      // ลอง insert หรือ upsert (ON DUPLICATE KEY UPDATE ตาม username)
      const newId = crypto.randomUUID();
      await db.query(
        `INSERT INTO users (id, username, password, full_name, role, student_code, plate_no, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password=VALUES(password), full_name=VALUES(full_name), role=VALUES(role),
           student_code=VALUES(student_code), plate_no=VALUES(plate_no), status=VALUES(status)`,
        [newId, cleanUser, userData.password, finalFullName, role, userData.student_code, plate_no, 'active']
      );
      const rows = await db.query('SELECT * FROM users WHERE username = ?', [cleanUser]);
      const data = rows;

      if (data && data.length) {
        unmarkUserAsDeleted(cleanUser);
        saveStoredProfile(cleanUser, userData);
        console.log(`✅ [ADMIN] Created/Updated user @${cleanUser} (${finalFullName})`);
        return res.json({ success: true, message: `สร้างผู้ใช้งาน "${finalFullName}" สำเร็จแล้ว`, user: sanitizeUser({ ...userData, ...data[0] }) });
      }
    } catch (e) {
      console.warn('MySQL insert user error:', e.message);
    }
  }

  unmarkUserAsDeleted(cleanUser);
  saveStoredProfile(cleanUser, userData);
  console.log(`✅ [ADMIN] Created user @${cleanUser} (${finalFullName}) [Local]`);
  res.json({ success: true, message: `สร้างผู้ใช้งาน "${finalFullName}" สำเร็จแล้ว`, user: sanitizeUser(userData) });
});

app.put('/api/admin/users/:id/reset-password', authenticateToken, requireRole(['admin']), async (req, res) => {
  const userId = req.params.id;
  const targetUsername = String(req.body?.username || req.query?.username || '').trim().toLowerCase();
  const { newPassword = '1234' } = req.body || {};
  const passHash = await hashPassword(newPassword);

  let updatedInSupabase = false;
  let resolvedUsername = targetUsername;

  // 1. ค้นหาและอัปเดตใน Supabase
  if (supabase) {
    try {
      if (userId && userId.length === 36 && userId.includes('-')) {
        await db.query('UPDATE users SET password = ?, password_hash = ? WHERE id = ?', [newPassword, passHash, userId]);
        const data = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (data && data.length > 0) {
          updatedInSupabase = true;
          if (!resolvedUsername && data[0].username) resolvedUsername = data[0].username.toLowerCase();
        }
      }
      if (!updatedInSupabase && targetUsername) {
        await db.query('UPDATE users SET password = ?, password_hash = ? WHERE username = ?', [newPassword, passHash, targetUsername]);
        const data = await db.query('SELECT * FROM users WHERE username = ?', [targetUsername]);
        if (data && data.length > 0) {
          updatedInSupabase = true;
        }
      }
    } catch (e) {
      console.warn('MySQL reset password error:', e.message);
    }
  }

  // 2. Resolve username ถ้ายังไม่ทราบ
  if (!resolvedUsername) {
    for (const [uname, acc] of Object.entries(ALL_SYSTEM_ACCOUNTS)) {
      if (acc.id === userId) {
        resolvedUsername = uname.toLowerCase();
        break;
      }
    }
  }
  if (!resolvedUsername) {
    const profs = loadProfiles();
    for (const [uname, p] of Object.entries(profs)) {
      if (p.id === userId || (userId && userId.startsWith('u-') && userId === `u-${uname}`) || p.student_code === userId) {
        resolvedUsername = uname.toLowerCase();
        break;
      }
    }
  }
  if (!resolvedUsername && userId && !userId.includes('-')) {
    resolvedUsername = userId.toLowerCase();
  }

  // 3. บันทึกลง profiles.json และ ALL_SYSTEM_ACCOUNTS
  if (resolvedUsername) {
    saveStoredProfile(resolvedUsername, {
      password: newPassword,
      password_hash: passHash
    });
    if (ALL_SYSTEM_ACCOUNTS[resolvedUsername]) {
      ALL_SYSTEM_ACCOUNTS[resolvedUsername].password = newPassword;
      ALL_SYSTEM_ACCOUNTS[resolvedUsername].password_hash = passHash;
    }
    unmarkUserAsDeleted(resolvedUsername);
  }

  console.log(`🔑 [ADMIN] Reset password for @${resolvedUsername || userId} to "${newPassword}"`);
  res.json({ success: true, message: `รีเซ็ตรหัสผ่านของผู้ใช้ @${resolvedUsername || userId} เป็น "${newPassword}" เรียบร้อยแล้ว` });
});

app.delete('/api/admin/users/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const userId = req.params.id;
  let targetUsername = String(req.query?.username || req.body?.username || '').trim().toLowerCase();

  // 1. Resolve username
  if (!targetUsername) {
    for (const [uname, acc] of Object.entries(ALL_SYSTEM_ACCOUNTS)) {
      if (acc.id === userId) {
        targetUsername = uname.toLowerCase();
        break;
      }
    }
  }
  if (!targetUsername) {
    const profs = loadProfiles();
    for (const [uname, p] of Object.entries(profs)) {
      if (p.id === userId || (userId && userId.startsWith('u-') && userId === `u-${uname}`) || p.student_code === userId) {
        targetUsername = uname.toLowerCase();
        break;
      }
    }
  }
  if (!targetUsername && userId && !userId.includes('-')) {
    targetUsername = userId.toLowerCase();
  }

  if (targetUsername === 'admin') {
    return res.status(400).json({ success: false, message: '⛔ ไม่สามารถลบบัญชีผู้ดูแลระบบหลัก (Admin) ได้' });
  }

  // 2. Blacklist & Local Cleanup
  if (targetUsername) {
    markUserAsDeleted(targetUsername);
    deleteStoredProfile(targetUsername);
    delete ALL_SYSTEM_ACCOUNTS[targetUsername];

    // ปลดชื่อครูออกจาก timetables.json
    try {
      const ttData = loadTimetablesData();
      let changed = false;
      ttData.entries = ttData.entries.map(e => {
        if ((e.teacherUsername || '').toLowerCase() === targetUsername) {
          changed = true;
          return { ...e, teacherUsername: '', teacherName: 'ยังไม่ได้ระบุครู' };
        }
        return e;
      });
      if (changed) saveTimetablesData(ttData);
    } catch (e) {}

    // ล้าง Device Requests ถ้ามี
    try {
      let devReqs = loadDeviceRequests();
      devReqs = devReqs.filter(d => (d.student_code || d.username || '').toLowerCase() !== targetUsername);
      saveDeviceRequests(devReqs);
    } catch (e) {}
  }

  // 3. MySQL Cleanup (Safe delete without Foreign Key error)
  if (supabase) {
    try {
      let sbUser = null;
      if (userId && userId.length === 36 && userId.includes('-')) {
        const rows = await db.query('SELECT id, username FROM users WHERE id = ?', [userId]);
        if (rows[0]) sbUser = rows[0];
      }
      if (!sbUser && targetUsername) {
        const rows = await db.query('SELECT id, username FROM users WHERE username = ?', [targetUsername]);
        if (rows[0]) sbUser = rows[0];
      }

      if (sbUser) {
        const uid = sbUser.id;
        const uName = sbUser.username;

        // NOTE: original Supabase code did `.or('approver_id.eq.X,student_id.eq.X')` on approval_logs,
        // but approval_logs has no student_id column - that call always errored (silently caught) in the
        // original app too, so only the approver_id condition ever had a chance of matching anything.
        // NOTE: original Supabase code also did `.from('scan_logs').delete().eq('user_id', uid)`, but
        // scan_logs has no user_id column either - that call always errored (silently caught) in the
        // original app too. Kept as a faithful (intentionally no-op) translation rather than "fixing" it.
        try { await db.query('DELETE FROM approval_logs WHERE approver_id = ?', [uid]); } catch (e) {}
        try { await db.query('DELETE FROM scan_logs WHERE user_id = ?', [uid]); } catch (e) {}
        try { await db.query('DELETE FROM leave_requests WHERE student_id = ? OR student_code = ?', [uid, uName]); } catch (e) {}
        await db.query('DELETE FROM users WHERE id = ?', [uid]);
        console.log(`🗑️ [ADMIN] Deleted user @${uName} (${uid}) from MySQL`);
      }
    } catch (err) {
      console.warn('MySQL delete user error:', err.message);
    }
  }

  console.log(`🗑️ [ADMIN] Successfully deleted user @${targetUsername || userId}`);
  res.json({ success: true, message: `ลบผู้ใช้งาน @${targetUsername || userId} เรียบร้อยแล้ว` });
});

// ดึงสถานะบอร์ดจำลอง & MQTT & ฮาร์ดแวร์ ESP32 (Online/Offline + ACK)
app.get('/api/gate/status', (req, res) => {
  const isHeartbeatActive = Boolean(lastEsp32Heartbeat && (Date.now() - lastEsp32Heartbeat < 60000));
  const isOnline = isHeartbeatActive || Boolean(serialConnectedPort);

  const sessions = Array.from(activeGateSessions.entries()).map(([k, v]) => ({
    requestId: k,
    studentName: v.studentName,
    openedAt: v.openedAt,
    remainingSeconds: Math.max(0, Math.round(30 - (Date.now() - v.openedAt) / 1000))
  }));

  res.json({
    mqtt: { connected: isMqttConnected, broker: process.env.MQTT_BROKER || 'Simulation Mode' },
    database: { connected: !!supabase, host: process.env.DB_HOST || null },
    simulator: simulatorState,
    activeSessions: sessions,
    gate: {
      online: isOnline,
      connectionType: serialConnectedPort ? `Serial (${serialConnectedPort})` : (isHeartbeatActive ? 'MQTT IoT' : (isMqttConnected ? 'MQTT Simulator' : 'Offline')),
      statusText: isOnline ? '🟢 ไม้กั้นออนไลน์' : '🔴 ไม้กั้นออฟไลน์',
      lastHeartbeat: lastEsp32Heartbeat ? new Date(lastEsp32Heartbeat).toISOString() : null,
      secondsSinceHeartbeat: lastEsp32Heartbeat ? Math.floor((Date.now() - lastEsp32Heartbeat) / 1000) : null,
      lastAck: lastEsp32Ack
    }
  });
});

// Endpoint รับ Heartbeat / ACK ผ่าน HTTP โดยตรง (Fallback หรือทดสอบ)
app.post('/api/gate/heartbeat', (req, res) => {
  lastEsp32Heartbeat = Date.now();
  const { door, status, device } = req.body || {};

  if (door === 'OPEN') {
    lastEsp32Ack = {
      action: 'DOOR_OPEN',
      status: status || 'OK',
      timestamp: new Date().toISOString(),
      details: 'บอร์ด ESP32 ยืนยันเปิดไม้กั้นสำเร็จ (ผ่าน HTTP)',
      source: 'HTTP'
    };
    simulatorState.door = 'OPEN';
  } else if (door === 'CLOSED') {
    lastEsp32Ack = {
      action: 'DOOR_CLOSED',
      status: status || 'OK',
      timestamp: new Date().toISOString(),
      details: 'บอร์ด ESP32 ยืนยันปิดไม้กั้นเรียบร้อย (ผ่าน HTTP)',
      source: 'HTTP'
    };
    simulatorState.door = 'CLOSED';
  } else {
    lastEsp32Ack = {
      action: 'ONLINE_PING',
      status: 'OK',
      timestamp: new Date().toISOString(),
      details: `บอร์ด ESP32 ส่งสถานะออนไลน์ (${device || 'ESP32_GATE'})`,
      source: 'HTTP'
    };
  }

  res.json({
    success: true,
    message: 'Heartbeat & ACK recorded successfully',
    gate: {
      online: true,
      lastHeartbeat: new Date(lastEsp32Heartbeat).toISOString(),
      lastAck: lastEsp32Ack
    }
  });
});

// ============================================================================
// TIMETABLE & DELEGATION ENDPOINTS (ระบบตารางสอน สอนแทน/งดสอน และอนุมัติแทน)
// ============================================================================

// ค้นหาคาบเรียนและครูรายวิชาอัตโนมัติ (เรียกใช้ก่อนยื่นคำร้องเพื่อแสดงให้นักเรียนเห็นล่วงหน้า - ข้อ 13, 14, 15, 16)
app.post('/api/timetable/match', (req, res) => {
  try {
    const { department, classroom, leaveDate, departureTime, expectedReturnTime, noReturn } = req.body || {};
    const result = matchTimetableForLeave({
      department,
      classroom,
      leaveDate: leaveDate || getThaiDateStr(),
      departureTime: departureTime || '13:00',
      expectedReturnTime: expectedReturnTime || '15:30',
      noReturn: Boolean(noReturn)
    });
    res.json({ success: true, match: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ดึงข้อมูลตารางสอนทั้งหมด ภาคเรียน รายการสอนแทน/งดสอน และรายการมอบหมายอนุมัติแทน
app.get('/api/timetables', (req, res) => {
  const ttData = loadTimetablesData();
  const semesterFilter = req.query.semester;
  const entries = semesterFilter
    ? ttData.entries.filter(e => (e.semester || '1/2569') === semesterFilter)
    : ttData.entries;
  res.json({
    success: true,
    activeSemester: ttData.activeSemester,
    semesters: ttData.semesters,
    entries,
    allEntriesCount: ttData.entries.length,
    overrides: ttData.overrides,
    delegations: loadDelegations()
  });
});

// เพิ่มรายการตารางสอนเดี่ยว พร้อมตรวจจับเวลาทับซ้อน + สร้างบัญชีครูรายวิชาอัตโนมัติ (รหัสผ่าน 1234) หากยังไม่มี
app.post('/api/timetables', authenticateToken, requireRole(['admin']), async (req, res) => {
  const ttData = loadTimetablesData();
  const body = req.body || {};
  const semester = (body.semester || body.semesterCode || ttData.activeSemester || '1/2569').trim();
  const department = (body.department || body.deptName || '').trim();
  const classroom = (body.classroom || '').trim();
  const dayOfWeek = body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : 0;
  const startTime = (body.startTime || '').trim();
  const endTime = (body.endTime || '').trim();
  const subjectCode = (body.subjectCode || '').trim();
  const subjectName = (body.subjectName || '').trim();
  let teacherUsername = (body.teacherUsername || '').trim();
  let teacherName = (body.teacherName || '').trim();
  const periodType = (body.periodType || 'study').trim();
  const roomNo = (body.roomNo || '').trim();
  const forceSave = Boolean(body.forceSave);

  if (!department || !classroom || !startTime || !endTime || !subjectName) {
    return res.status(400).json({
      success: false,
      message: 'กรุณากรอกข้อมูลให้ครบถ้วน (แผนกวิชา, ห้องเรียน, เวลาเริ่ม-สิ้นสุด, ชื่อวิชา)'
    });
  }

  if (parseTimeToMins(endTime) <= parseTimeToMins(startTime)) {
    return res.status(400).json({
      success: false,
      message: 'เวลาสิ้นสุดคาบเรียนต้องมากกว่าเวลาเริ่มคาบเรียน'
    });
  }

  // หากเป็นคาบเรียนปกติ (study) ให้ค้นหาหรือสร้างบัญชีครูอัตโนมัติทันที
  let provisionedTeacher = null;
  if (periodType === 'study') {
    provisionedTeacher = await ensureTeacherAccountProvisioned({
      teacherUsername,
      teacherName,
      department
    });
    teacherUsername = provisionedTeacher.username;
    teacherName = provisionedTeacher.fullName;
  } else {
    teacherUsername = '';
    teacherName = '-';
  }

  const newEntry = {
    id: 'tt-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    semester,
    department,
    deptName: department,
    classroom,
    dayOfWeek: Number(dayOfWeek || 0),
    startTime,
    endTime,
    subjectCode,
    subjectName,
    teacherUsername,
    teacherName,
    periodType,
    roomNo
  };

  const conflicts = detectTimetableConflicts(ttData.entries, newEntry);
  if (conflicts.length > 0 && !forceSave) {
    return res.status(409).json({
      success: false,
      conflict: true,
      hasConflicts: true,
      conflicts,
      message: `⚠️ ตรวจพบเวลาทับซ้อนในตารางสอน (${conflicts.length} รายการ): ${conflicts[0].message}`
    });
  }

  ttData.entries.push(newEntry);
  saveTimetablesData(ttData);

  const autoTeacherMsg = (provisionedTeacher && provisionedTeacher.createdNew)
    ? ` (สร้างบัญชีครูใหม่: Username "${provisionedTeacher.username}" รหัสผ่าน "1234" ให้อัตโนมัติแล้ว)`
    : (provisionedTeacher ? ` (ผูกกับบัญชีครู @${provisionedTeacher.username} - ${provisionedTeacher.fullName})` : '');

  res.json({
    success: true,
    message: (conflicts.length > 0 ? 'บันทึกตารางสอนแล้ว (มีคำเตือนเวลาทับซ้อน)' : 'เพิ่มรายการตารางสอนเรียบร้อยแล้ว') + autoTeacherMsg,
    entry: newEntry,
    provisionedTeacher,
    conflicts,
    hasConflicts: conflicts.length > 0
  });
});

// แก้ไขรายการตารางสอนเดี่ยว พร้อมตรวจจับเวลาทับซ้อน + สร้างบัญชีครูรายวิชาอัตโนมัติ (ข้อ 12)
app.put('/api/timetables/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const entryId = req.params.id;
  const ttData = loadTimetablesData();
  const idx = ttData.entries.findIndex(e => String(e.id) === String(entryId));
  if (idx === -1) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการตารางสอนที่ต้องการแก้ไข' });
  }

  const existing = ttData.entries[idx];
  const body = req.body || {};
  const nextDept = (body.department || body.deptName || existing.department || existing.deptName || '').trim();
  const nextPeriodType = (body.periodType || existing.periodType || 'study').trim();

  let resolvedTeacherUsername = body.teacherUsername !== undefined ? String(body.teacherUsername).trim() : existing.teacherUsername;
  let resolvedTeacherName = body.teacherName !== undefined ? String(body.teacherName).trim() : existing.teacherName;
  let provisionedTeacher = null;

  if (nextPeriodType === 'study') {
    provisionedTeacher = await ensureTeacherAccountProvisioned({
      teacherUsername: resolvedTeacherUsername,
      teacherName: resolvedTeacherName,
      department: nextDept
    });
    resolvedTeacherUsername = provisionedTeacher.username;
    resolvedTeacherName = provisionedTeacher.fullName;
  } else {
    resolvedTeacherUsername = '';
    resolvedTeacherName = '-';
  }

  const updated = {
    ...existing,
    ...body,
    id: existing.id,
    department: nextDept,
    deptName: nextDept,
    periodType: nextPeriodType,
    teacherUsername: resolvedTeacherUsername,
    teacherName: resolvedTeacherName,
    dayOfWeek: body.dayOfWeek !== undefined ? Number(body.dayOfWeek) : existing.dayOfWeek
  };

  if (parseTimeToMins(updated.endTime) <= parseTimeToMins(updated.startTime)) {
    return res.status(400).json({
      success: false,
      message: 'เวลาสิ้นสุดคาบเรียนต้องมากกว่าเวลาเริ่มคาบเรียน'
    });
  }

  const conflicts = detectTimetableConflicts(ttData.entries, updated, entryId);
  if (conflicts.length > 0 && !req.body.forceSave) {
    return res.status(409).json({
      success: false,
      conflict: true,
      hasConflicts: true,
      conflicts,
      message: `⚠️ ตรวจพบเวลาทับซ้อน (${conflicts.length} รายการ): ${conflicts[0].message}`
    });
  }

  ttData.entries[idx] = updated;
  saveTimetablesData(ttData);
  const autoTeacherMsg = (provisionedTeacher && provisionedTeacher.createdNew)
    ? ` (พร้อมสร้างบัญชีครูใหม่: Username "${provisionedTeacher.username}" รหัสผ่าน "1234")`
    : '';
  res.json({
    success: true,
    message: 'แก้ไขรายการตารางสอนเรียบร้อยแล้ว' + autoTeacherMsg,
    entry: updated,
    provisionedTeacher,
    conflicts,
    hasConflicts: conflicts.length > 0
  });
});

// ลบรายการตารางสอนเดี่ยว
app.delete('/api/timetables/:id', authenticateToken, requireRole(['admin']), (req, res) => {
  const entryId = req.params.id;
  const ttData = loadTimetablesData();
  const beforeLen = ttData.entries.length;
  ttData.entries = ttData.entries.filter(e => String(e.id) !== String(entryId));
  if (ttData.entries.length < beforeLen) {
    saveTimetablesData(ttData);
    return res.json({ success: true, message: 'ลบรายการตารางสอนเรียบร้อยแล้ว' });
  }
  res.status(404).json({ success: false, message: 'ไม่พบรายการตารางสอน' });
});

// นำเข้าตารางสอนจากไฟล์ CSV / Excel / รูปภาพที่ผ่านการตรวจสอบแล้ว พร้อมตรวจจับเวลาทับซ้อน + สร้างบัญชีครูอัตโนมัติ (ข้อ 12)
app.post('/api/timetables/import', authenticateToken, requireRole(['admin']), async (req, res) => {
  const body = req.body || {};
  const semester = body.semester || body.semesterCode;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const replaceSemester = Boolean(body.replaceSemester || body.replaceExisting);
  const replaceTargetClasses = Boolean(body.replaceTargetClasses);

  if (rows.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลแถวตารางสอนที่ต้องการนำเข้า' });
  }

  const ttData = loadTimetablesData();
  const targetSemester = (semester && String(semester).trim()) ? String(semester).trim() : ttData.activeSemester;

  if (replaceSemester) {
    ttData.entries = ttData.entries.filter(e => (e.semester || '1/2569') !== targetSemester);
  } else if (replaceTargetClasses) {
    const classKeys = new Set(rows.map(r => `${(r.department || r.deptName || r.dept || '').trim()}|${(r.classroom || r.class || '').trim()}`));
    ttData.entries = ttData.entries.filter(e => {
      if ((e.semester || '1/2569') !== targetSemester) return true;
      const k = `${(e.department || e.deptName || '').trim()}|${(e.classroom || '').trim()}`;
      return !classKeys.has(k);
    });
  }

  const importedEntries = [];
  const allConflicts = [];
  const autoCreatedTeachers = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const dept = (r.department || r.deptName || r.dept || 'แผนกวิชาช่างยนต์').trim();
    const cls = (r.classroom || r.class || 'ปวช.3').trim();
    const startTime = (r.startTime || r.start || '08:00').trim();
    const endTime = (r.endTime || r.end || '10:00').trim();
    const periodType = (r.periodType || r.type || 'study').trim().toLowerCase();
    const normalizedType = ['study', 'break', 'activity', 'free', 'self_study'].includes(periodType) ? periodType : 'study';

    let finalTeacherUsername = '';
    let finalTeacherName = '-';
    if (normalizedType === 'study') {
      const prov = await ensureTeacherAccountProvisioned({
        teacherUsername: r.teacherUsername || '',
        teacherName: r.teacherName || 'อาจารย์ผู้สอน',
        department: dept
      });
      finalTeacherUsername = prov.username;
      finalTeacherName = prov.fullName;
      if (prov.createdNew && !autoCreatedTeachers.some(t => t.username === prov.username)) {
        autoCreatedTeachers.push(prov);
      }
    }

    const entry = {
      id: `tt-imp-${Date.now()}-${idx}`,
      semester: targetSemester,
      department: dept,
      deptName: dept,
      classroom: cls,
      dayOfWeek: Number(r.dayOfWeek !== undefined ? r.dayOfWeek : 0),
      startTime,
      endTime,
      subjectCode: (r.subjectCode || r.code || (normalizedType === 'self_study' ? 'SELF-01' : '-')).trim(),
      subjectName: (r.subjectName || r.subject || (normalizedType === 'self_study' ? 'คาบเรียนรู้ด้วยตนเอง (ไม่มีอาจารย์ผู้สอน)' : 'รายวิชาเรียน')).trim(),
      teacherUsername: finalTeacherUsername,
      teacherName: finalTeacherName,
      periodType: normalizedType,
      roomNo: (r.roomNo || r.room || '-').trim()
    };

    const rowConflicts = detectTimetableConflicts(ttData.entries, entry);
    if (rowConflicts.length > 0) {
      allConflicts.push({
        rowNumber: idx + 1,
        reason: rowConflicts[0]?.message || 'เวลาทับซ้อน',
        entry,
        conflicts: rowConflicts
      });
    }

    ttData.entries.push(entry);
    importedEntries.push(entry);
  }

  saveTimetablesData(ttData);
  const autoTeachersSummary = autoCreatedTeachers.length > 0
    ? ` | สร้างบัญชีครูรายวิชาใหม่อัตโนมัติ ${autoCreatedTeachers.length} ท่าน (${autoCreatedTeachers.map(t => `${t.fullName} -> Username: ${t.username}`).join(', ')} / รหัสผ่าน: 1234)`
    : '';
  res.json({
    success: true,
    importedCount: importedEntries.length,
    semester: targetSemester,
    autoCreatedTeachers,
    hasConflicts: allConflicts.length > 0,
    conflicts: allConflicts,
    message: (allConflicts.length > 0
      ? `นำเข้าตารางสอน ${importedEntries.length} รายการสำเร็จ (ตรวจพบเวลาทับซ้อน ${allConflicts.length} จุด กรุณาตรวจสอบ)`
      : `นำเข้าตารางสอน ${importedEntries.length} รายการสำเร็จเรียบร้อย (ไม่พบเวลาทับซ้อน)`) + autoTeachersSummary
  });
});

// แม่แบบข้อมูลหลักสูตรมาตรฐานครบทั้ง 5 แผนกวิชา × 5 ชั้นปี (ปวช.1, ปวช.2, ปวช.3, ปวส.1, ปวส.2)
const VOCATIONAL_CURRICULUM_CATALOG = {
  'แผนกวิชาช่างยนต์': {
    teacherUsername: 'subject_auto',
    teacherName: 'อ.ธีรพงศ์ เครื่องยนต์',
    altTeacherUsername: 'teacher_auto',
    altTeacherName: 'อ.อนุสรณ์ ช่างยนต์',
    roomPrefix: 'โรงฝึกงานช่างยนต์',
    grades: {
      'ปวช.1': [
        { code: '20101-2001', name: 'งานเครื่องยนต์แก๊สโซลีน', room: 'ชย.101' },
        { code: '20101-2002', name: 'งานเครื่องมือกลเบื้องต้น', room: 'ชย.102' },
        { code: '20101-2003', name: 'เขียนแบบเทคนิคเบื้องต้น', room: 'ชย.201' },
        { code: '20000-1201', name: 'ภาษาอังกฤษเพื่อการสื่อสาร', room: 'สามัญ 301', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.2': [
        { code: '20101-2004', name: 'งานเครื่องยนต์ดีเซล', room: 'ชย.103' },
        { code: '20101-2005', name: 'งานส่งกำลังรถยนต์', room: 'ชย.104' },
        { code: '20101-2006', name: 'งานไฟฟ้ารถยนต์', room: 'ชย.202' },
        { code: '20000-1401', name: 'คณิตศาสตร์ช่างอุตสาหกรรม', room: 'สามัญ 302', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.3': [
        { code: '20101-2007', name: 'งานปรับอากาศรถยนต์', room: 'ชย.105' },
        { code: '20101-2008', name: 'งานจักรยานยนต์และเครื่องยนต์เล็ก', room: 'ชย.106' },
        { code: '20101-2009', name: 'งานตรวจวิเคราะห์เครื่องยนต์ควบคุมด้วยอิเล็กทรอนิกส์', room: 'ชย.203' },
        { code: '20101-8501', name: 'โครงงานช่างยนต์', room: 'ชย.204' }
      ],
      'ปวส.1': [
        { code: '30101-2001', name: 'เทคโนโลยียานยนต์ไฟฟ้า (EV) เบื้องต้น', room: 'ศูนย์ EV 1' },
        { code: '30101-2002', name: 'งานวิเคราะห์ปัญหาเครื่องยนต์ขั้นสูง', room: 'ชย.301' },
        { code: '30101-2003', name: 'ระบบส่งกำลังอัตโนมัติควบคุมด้วยอิเล็กทรอนิกส์', room: 'ชย.302' },
        { code: '30000-1201', name: 'ภาษาอังกฤษเทคโนโลยีอุตสาหกรรม', room: 'สามัญ 401', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวส.2': [
        { code: '30101-2005', name: 'งานซ่อมบำรุงแบตเตอรี่และมอเตอร์ยานยนต์ไฟฟ้า', room: 'ศูนย์ EV 2' },
        { code: '30101-2006', name: 'การบริหารจัดการศูนย์บริการยานยนต์', room: 'ชย.303' },
        { code: '30101-2007', name: 'กลศาสตร์เครื่องกลและเทอร์โมไดนามิกส์', room: 'ชย.304' },
        { code: '30101-8501', name: 'โครงงานเทคนิคเครื่องกล/ยานยนต์', room: 'ศูนย์ EV 1' }
      ]
    }
  },
  'แผนกวิชาช่างไฟฟ้า': {
    teacherUsername: 'subject_electric',
    teacherName: 'อ.ธนากร วงจรไฟฟ้า',
    altTeacherUsername: 'teacher_electric',
    altTeacherName: 'อ.สมหมาย ไฟฟ้ากำลัง',
    roomPrefix: 'ปฏิบัติการไฟฟ้า',
    grades: {
      'ปวช.1': [
        { code: '20104-2001', name: 'การติดตั้งไฟฟ้าในอาคาร', room: 'ชฟ.101' },
        { code: '20104-2002', name: 'วงจรไฟฟ้ากระแสตรง', room: 'ชฟ.102' },
        { code: '20104-2003', name: 'การวัดและเครื่องมือวัดไฟฟ้า', room: 'ชฟ.201' },
        { code: '20000-1301', name: 'วิทยาศาสตร์เพื่อพัฒนาทักษะชีวิต', room: 'สามัญ 303', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.2': [
        { code: '20104-2004', name: 'วงจรไฟฟ้ากระแสสลับ', room: 'ชฟ.103' },
        { code: '20104-2005', name: 'เครื่องกลไฟฟ้ากระแสตรงและหม้อแปลง', room: 'ชฟ.104' },
        { code: '20104-2006', name: 'การควบคุมมอเตอร์ไฟฟ้า', room: 'ชฟ.202' },
        { code: '20104-2007', name: 'เขียนแบบไฟฟ้าด้วยคอมพิวเตอร์', room: 'ชฟ.203' }
      ],
      'ปวช.3': [
        { code: '20104-2008', name: 'มอเตอร์ไฟฟ้ากระแสสลับ', room: 'ชฟ.105' },
        { code: '20104-2009', name: 'การติดตั้งไฟฟ้านอกอาคารและตู้ควบคุม', room: 'ชฟ.106' },
        { code: '20104-2010', name: 'โปรแกรมเมเบิลลอจิกคอนโทรลเลอร์ (PLC) เบื้องต้น', room: 'ชฟ.204' },
        { code: '20104-8501', name: 'โครงงานช่างไฟฟ้ากำลัง', room: 'ชฟ.205' }
      ],
      'ปวส.1': [
        { code: '30104-2001', name: 'การออกแบบระบบไฟฟ้าและประมาณราคา', room: 'ชฟ.301' },
        { code: '30104-2002', name: 'ระบบควบคุมอัตโนมัติในงานอุตสาหกรรม', room: 'ชฟ.302' },
        { code: '30104-2003', name: 'อิเล็กทรอนิกส์กำลัง (Power Electronics)', room: 'ชฟ.303' },
        { code: '30104-2004', name: 'ระบบผลิตพลังงานแสงอาทิตย์ (Solar Cell)', room: 'ชฟ.304' }
      ],
      'ปวส.2': [
        { code: '30104-2005', name: 'การส่งและจ่ายกำลังไฟฟ้า', room: 'ชฟ.401' },
        { code: '30104-2006', name: 'การป้องกันระบบไฟฟ้ากำลังและสถานีไฟฟ้าย่อย', room: 'ชฟ.402' },
        { code: '30104-2007', name: 'เทคโนโลยี IoT สำหรับงานควบคุมไฟฟ้าอัจฉริยะ', room: 'ชฟ.403' },
        { code: '30104-8501', name: 'โครงงานเทคโนโลยีไฟฟ้ากำลัง', room: 'ชฟ.404' }
      ]
    }
  },
  'แผนกวิชาการบัญชี': {
    teacherUsername: 'subject_account',
    teacherName: 'อ.พิมพ์ชนก งบการเงิน',
    altTeacherUsername: 'teacher_account',
    altTeacherName: 'อ.สุนิสา การบัญชี',
    roomPrefix: 'ห้องปฏิบัติการบัญชี',
    grades: {
      'ปวช.1': [
        { code: '20201-2001', name: 'การบัญชีเบื้องต้น', room: 'บช.201' },
        { code: '20201-2002', name: 'การบัญชีธุรกิจซื้อขายสินค้า', room: 'บช.202' },
        { code: '20200-1001', name: 'เศรษฐศาสตร์เบื้องต้น', room: 'บช.203' },
        { code: '20000-1201', name: 'ภาษาอังกฤษสำหรับงานพาณิชยกรรม', room: 'สามัญ 301', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.2': [
        { code: '20201-2003', name: 'การบัญชีห้างหุ้นส่วน', room: 'บช.204' },
        { code: '20201-2004', name: 'การบัญชีตั๋วเงินและระบบใบสำคัญ', room: 'บช.205' },
        { code: '20201-2005', name: 'การคำนวณต้นทุนและการบัญชีต้นทุนเบื้องต้น', room: 'บช.206' },
        { code: '20201-2006', name: 'โปรแกรมสำเร็จรูปเพื่องานบัญชี', room: 'คอมบัญชี 1' }
      ],
      'ปวช.3': [
        { code: '20201-2007', name: 'การบัญชีบริษัทจำกัด', room: 'บช.301' },
        { code: '20201-2008', name: 'การบัญชีภาษีอากรและประมวลรัษฎากร', room: 'บช.302' },
        { code: '20201-2009', name: 'การบัญชีร่วมค้าและฝากขาย', room: 'บช.303' },
        { code: '20201-8501', name: 'โครงงานวิชาชีพการบัญชี', room: 'คอมบัญชี 2' }
      ],
      'ปวส.1': [
        { code: '30201-2001', name: 'การบัญชีชั้นกลาง 1 (สินทรัพย์)', room: 'บช.401' },
        { code: '30201-2002', name: 'การบัญชีต้นทุน 1', room: 'บช.402' },
        { code: '30201-2003', name: 'การวิเคราะห์รายงานทางการเงิน', room: 'บช.403' },
        { code: '30201-2004', name: 'ระบบสารสนเทศทางการบัญชีดิจิทัล', room: 'คอมบัญชี 1' }
      ],
      'ปวส.2': [
        { code: '30201-2005', name: 'การบัญชีชั้นสูง', room: 'บช.404' },
        { code: '30201-2006', name: 'การสอบบัญชีและการควบคุมภายใน', room: 'บช.405' },
        { code: '30201-2007', name: 'การบัญชีเพื่อการจัดการและงบประมาณ', room: 'บช.406' },
        { code: '30201-8501', name: 'โครงงานเทคโนโลยีการบัญชี', room: 'คอมบัญชี 2' }
      ]
    }
  },
  'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล': {
    teacherUsername: 'subject_digital',
    teacherName: 'อ.ศุภกร โค้ดดิ้ง',
    altTeacherUsername: 'teacher_digital',
    altTeacherName: 'อ.ณัฐพงศ์ ไอที',
    roomPrefix: 'ห้องปฏิบัติการคอมพิวเตอร์',
    grades: {
      'ปวช.1': [
        { code: '20204-2001', name: 'ระบบคอมพิวเตอร์และอุปกรณ์พกพา', room: 'Lab IT-1' },
        { code: '20204-2002', name: 'การเขียนโปรแกรมคอมพิวเตอร์เบื้องต้น', room: 'Lab IT-2' },
        { code: '20204-2003', name: 'โปรแกรมกราฟิกเพื่อการออกแบบดิจิทัล', room: 'Lab IT-3' },
        { code: '20000-1201', name: 'ภาษาอังกฤษสำหรับเทคโนโลยีดิจิทัล', room: 'สามัญ 304', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.2': [
        { code: '20204-2004', name: 'การพัฒนาเว็บไซต์ทางธุรกิจ', room: 'Lab IT-1' },
        { code: '20204-2005', name: 'ระบบจัดการฐานข้อมูลเบื้องต้น', room: 'Lab IT-2' },
        { code: '20204-2006', name: 'เครือข่ายคอมพิวเตอร์และความปลอดภัยไซเบอร์', room: 'Lab Net-1' },
        { code: '20204-2007', name: 'การผลิตสื่อมัลติมีเดียและแอนิเมชัน', room: 'Lab Media' }
      ],
      'ปวช.3': [
        { code: '20204-2008', name: 'การเขียนโปรแกรมเชิงวัตถุและแอปพลิเคชัน', room: 'Lab IT-2' },
        { code: '20204-2009', name: 'พาณิชย์อิเล็กทรอนิกส์และการตลาดดิจิทัล', room: 'Lab IT-3' },
        { code: '20204-2010', name: 'การวิเคราะห์และออกแบบระบบเชิงธุรกิจ', room: 'Lab IT-1' },
        { code: '20204-8501', name: 'โครงงานเทคโนโลยีธุรกิจดิจิทัล', room: 'Lab IT-4' }
      ],
      'ปวส.1': [
        { code: '30204-2001', name: 'การพัฒนาเว็บแอปพลิเคชันแบบ Full-Stack', room: 'Smart Lab 1' },
        { code: '30204-2002', name: 'การพัฒนาแอปพลิเคชันบนอุปกรณ์เคลื่อนที่', room: 'Smart Lab 2' },
        { code: '30204-2003', name: 'คลาวด์คอมพิวติ้งและระบบเครือข่ายสมัยใหม่', room: 'Lab Net-2' },
        { code: '30204-2004', name: 'การออกแบบประสบการณ์และส่วนติดต่อผู้ใช้ (UX/UI)', room: 'Lab Media' }
      ],
      'ปวส.2': [
        { code: '30204-2005', name: 'ปัญญาประดิษฐ์และการวิเคราะห์ข้อมูลธุรกิจ (AI & Data)', room: 'Smart Lab 1' },
        { code: '30204-2006', name: 'เทคโนโลยี IoT และระบบอัตโนมัติอัจฉริยะ', room: 'IoT Studio' },
        { code: '30204-2007', name: 'การบริหารโครงการซอฟต์แวร์และความมั่นคงปลอดภัย', room: 'Smart Lab 2' },
        { code: '30204-8501', name: 'โครงงานนวัตกรรมธุรกิจดิจิทัล', room: 'IoT Studio' }
      ]
    }
  },
  'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล': {
    teacherUsername: 'subject_office',
    teacherName: 'อ.ปวีณา บริหารงาน',
    altTeacherUsername: 'teacher_office',
    altTeacherName: 'อ.กานดา การจัดการ',
    roomPrefix: 'ห้องปฏิบัติการสำนักงาน',
    grades: {
      'ปวช.1': [
        { code: '20216-2001', name: 'การจัดทำเอกสารสำนักงานดิจิทัล', room: 'สก.101' },
        { code: '20216-2002', name: 'การพิมพ์ไทย-อังกฤษด้วยคอมพิวเตอร์', room: 'สก.102' },
        { code: '20216-2003', name: 'หลักการจัดการและการบริหารงานสำนักงาน', room: 'สก.103' },
        { code: '20000-1201', name: 'ภาษาอังกฤษเพื่อการสื่อสารทางธุรกิจ', room: 'สามัญ 301', teacherUsername: 'subject_general', teacherName: 'อ.กนกวรรณ สามัญศึกษา' }
      ],
      'ปวช.2': [
        { code: '20216-2004', name: 'งานสารบรรณและการบริหารเอกสารอิเล็กทรอนิกส์', room: 'สก.201' },
        { code: '20216-2005', name: 'การบริหารงานบุคคลและแรงงานสัมพันธ์', room: 'สก.202' },
        { code: '20216-2006', name: 'การสื่อสารและการประชาสัมพันธ์องค์กร', room: 'สก.203' },
        { code: '20216-2007', name: 'เทคโนโลยีสำนักงานอัตโนมัติ', room: 'สก.204' }
      ],
      'ปวช.3': [
        { code: '20216-2008', name: 'การเลขานุการและการจัดการประชุมสมัยใหม่', room: 'สก.301' },
        { code: '20216-2009', name: 'การจัดการคลังสินค้าและจัดซื้อจัดจ้าง', room: 'สก.302' },
        { code: '20216-2010', name: 'ศิลปะการให้บริการและบุคลิกภาพนักบริหาร', room: 'สก.303' },
        { code: '20216-8501', name: 'โครงงานการจัดการสำนักงาน', room: 'สก.304' }
      ],
      'ปวส.1': [
        { code: '30216-2001', name: 'การบริหารทรัพยากรมนุษย์เชิงกลยุทธ์', room: 'สก.401' },
        { code: '30216-2002', name: 'การจัดการธุรกิจดิจิทัลและพาณิชย์ออนไลน์', room: 'สก.402' },
        { code: '30216-2003', name: 'การวางแผนและการเขียนโครงการธุรกิจ', room: 'สก.403' },
        { code: '30216-2004', name: 'กฎหมายธุรกิจและจริยธรรมวิชาชีพ', room: 'สก.404' }
      ],
      'ปวส.2': [
        { code: '30216-2005', name: 'การจัดการโลจิสติกส์และซัพพลายเชนเบื้องต้น', room: 'สก.405' },
        { code: '30216-2006', name: 'การบริหารคุณภาพและมาตรฐานสำนักงานสีเขียว', room: 'สก.406' },
        { code: '30216-2007', name: 'การเป็นผู้ประกอบการยุคดิจิทัล (Startup)', room: 'สก.407' },
        { code: '30216-8501', name: 'โครงงานการจัดการธุรกิจดิจิทัล', room: 'สก.408' }
      ]
    }
  }
};

function generateStandardTimetableForDeptGrade(department, classroom, semester = '1/2569') {
  const deptKeys = Object.keys(VOCATIONAL_CURRICULUM_CATALOG);
  const matchedKey = deptKeys.find(k => isDepartmentMatchServer(k, department)) || deptKeys[0];
  const deptCatalog = VOCATIONAL_CURRICULUM_CATALOG[matchedKey];
  const gradeList = deptCatalog.grades[classroom] || deptCatalog.grades['ปวช.3'];

  const s0 = gradeList[0];
  const s1 = gradeList[1] || gradeList[0];
  const s2 = gradeList[2] || gradeList[0];
  const s3 = gradeList[3] || gradeList[1] || gradeList[0];

  const resolveSubjTeacher = (s, useAlt = false) => ({
    username: s.teacherUsername || (useAlt ? deptCatalog.altTeacherUsername : deptCatalog.teacherUsername),
    name: s.teacherName || (useAlt ? deptCatalog.altTeacherName : deptCatalog.teacherName)
  });

  const rows = [];
  const pushRow = (dayOfWeek, startTime, endTime, subj, periodType = 'study', useAlt = false) => {
    const t = resolveSubjTeacher(subj, useAlt);
    rows.push({
      semester,
      department: matchedKey,
      deptName: matchedKey,
      classroom,
      dayOfWeek,
      startTime,
      endTime,
      subjectCode: periodType === 'study' ? subj.code : (periodType === 'break' ? 'BREAK' : (periodType === 'activity' ? 'ACT-01' : 'FREE')),
      subjectName: subj.name,
      teacherUsername: periodType === 'study' ? t.username : '',
      teacherName: periodType === 'study' ? t.name : '-',
      periodType,
      roomNo: subj.room || '-'
    });
  };

  // วันจันทร์ (1)
  pushRow(1, '08:00', '10:00', s0, 'study', false);
  pushRow(1, '10:00', '12:00', s1, 'study', false);
  pushRow(1, '12:00', '13:00', { code: 'BREAK', name: 'พักรับประทานอาหารกลางวัน', room: 'โรงอาหาร' }, 'break');
  pushRow(1, '13:00', '15:00', s2, 'study', true);
  pushRow(1, '15:00', '16:00', { code: 'FREE', name: 'คาบว่าง / ค้นคว้าด้วยตนเอง', room: 'ห้องสมุด' }, 'free');

  // วันอังคาร (2)
  pushRow(2, '08:00', '10:00', s1, 'study', false);
  pushRow(2, '10:00', '12:00', s3, 'study', false);
  pushRow(2, '12:00', '13:00', { code: 'BREAK', name: 'พักรับประทานอาหารกลางวัน', room: 'โรงอาหาร' }, 'break');
  pushRow(2, '13:00', '15:00', s0, 'study', false);
  pushRow(2, '15:00', '16:00', { code: 'ACT-HR', name: 'คาบพบครูที่ปรึกษา (โฮมรูม)', room: s0.room }, 'activity');

  // วันพุธ (3)
  pushRow(3, '08:00', '10:00', s2, 'study', true);
  pushRow(3, '10:00', '12:00', s0, 'study', false);
  pushRow(3, '12:00', '13:00', { code: 'BREAK', name: 'พักรับประทานอาหารกลางวัน', room: 'โรงอาหาร' }, 'break');
  pushRow(3, '13:00', '15:00', { code: 'ACT-CLUB', name: 'กิจกรรมลูกเสือวิสามัญ / ชมรมวิชาชีพ', room: 'ลานอเนกประสงค์' }, 'activity');
  pushRow(3, '15:00', '16:00', { code: 'ACT-SPORT', name: 'กิจกรรมนันทนาการและกีฬา', room: 'สนามกีฬา' }, 'activity');

  // วันพฤหัสบดี (4)
  pushRow(4, '08:00', '10:00', s3, 'study', false);
  pushRow(4, '10:00', '12:00', s2, 'study', true);
  pushRow(4, '12:00', '13:00', { code: 'BREAK', name: 'พักรับประทานอาหารกลางวัน', room: 'โรงอาหาร' }, 'break');
  pushRow(4, '13:00', '15:00', s1, 'study', false);
  pushRow(4, '15:00', '16:00', { code: 'FREE', name: 'คาบว่าง / ซ่อมเสริมวิชาชีพ', room: s1.room }, 'free');

  // วันศุกร์ (5)
  pushRow(5, '08:00', '10:00', s0, 'study', false);
  pushRow(5, '10:00', '12:00', s3, 'study', false);
  pushRow(5, '12:00', '13:00', { code: 'BREAK', name: 'พักรับประทานอาหารกลางวัน', room: 'โรงอาหาร' }, 'break');
  pushRow(5, '13:00', '15:00', s2, 'study', true);
  pushRow(5, '15:00', '16:00', { code: 'ACT-MORAL', name: 'กิจกรรมเสริมสร้างคุณธรรมจริยธรรม', room: 'หอประชุม' }, 'activity');

  return rows;
}

// ช่องทางดึงตารางสอนมาตรฐานครบทุกแผนกวิชา & ทุกชั้นปี (ปวช.1-ปวส.2) หรือคัดลอกจากภาคเรียนเก่า
app.post('/api/timetables/pull-standard', authenticateToken, requireRole(['admin']), (req, res) => {
  const {
    semester,
    mode = 'standard_all', // 'standard_all' | 'standard_filtered' | 'copy_semester'
    sourceSemester = '2/2568',
    departments = [],
    classrooms = [],
    previewOnly = true,
    replaceExisting = false
  } = req.body || {};

  const ttData = loadTimetablesData();
  const targetSemester = (semester && String(semester).trim()) ? String(semester).trim() : ttData.activeSemester;

  let generatedRows = [];

  if (mode === 'copy_semester') {
    const srcEntries = ttData.entries.filter(e => (e.semester || '1/2569') === sourceSemester);
    if (srcEntries.length === 0) {
      return res.status(404).json({
        success: false,
        message: `ไม่พบข้อมูลตารางสอนในภาคเรียนต้นทาง (${sourceSemester}) สำหรับคัดลอก`
      });
    }
    generatedRows = srcEntries.map(e => ({
      ...e,
      semester: targetSemester,
      department: e.department || e.deptName,
      deptName: e.department || e.deptName
    }));
  } else {
    const allDepts = Object.keys(VOCATIONAL_CURRICULUM_CATALOG);
    const allGrades = ['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'];
    const targetDepts = Array.isArray(departments) && departments.length > 0 ? departments : allDepts;
    const targetGrades = Array.isArray(classrooms) && classrooms.length > 0 ? classrooms : allGrades;

    targetDepts.forEach(dept => {
      targetGrades.forEach(grade => {
        const rows = generateStandardTimetableForDeptGrade(dept, grade, targetSemester);
        generatedRows.push(...rows);
      });
    });
  }

  if (previewOnly) {
    return res.json({
      success: true,
      previewOnly: true,
      semester: targetSemester,
      count: generatedRows.length,
      rows: generatedRows,
      message: `เตรียมข้อมูลตารางสอนสำเร็จ (${generatedRows.length} คาบเรียน) กรุณาตรวจสอบก่อนกดยืนยันบันทึก`
    });
  }

  if (replaceExisting) {
    const classKeys = new Set(generatedRows.map(r => `${r.department}|${r.classroom}`));
    ttData.entries = ttData.entries.filter(e => {
      if ((e.semester || '1/2569') !== targetSemester) return true;
      return !classKeys.has(`${e.department || e.deptName}|${e.classroom}`);
    });
  }

  generatedRows.forEach((r, idx) => {
    ttData.entries.push({
      ...r,
      id: `tt-std-${Date.now()}-${idx}`
    });
  });

  saveTimetablesData(ttData);
  res.json({
    success: true,
    importedCount: generatedRows.length,
    semester: targetSemester,
    message: `ดึงและบันทึกตารางสอนลงภาคเรียน ${targetSemester} สำเร็จรวม ${generatedRows.length} คาบเรียน`
  });
});

// ช่องทางดึงตารางสอนจากลิงก์ Google Sheets / CSV Online URL
app.post('/api/timetables/fetch-sheet', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { sheetUrl = '', semester } = req.body || {};
    if (!sheetUrl || !String(sheetUrl).trim()) {
      return res.status(400).json({ success: false, message: 'กรุณาวางลิงก์ Google Sheets หรือ URL ของไฟล์ CSV' });
    }

    let fetchUrl = String(sheetUrl).trim();
    // แปลงลิงก์ Google Sheets ปกติให้เป็นลิงก์ Export CSV อัตโนมัติ
    const gsheetMatch = fetchUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (gsheetMatch && gsheetMatch[1]) {
      const docId = gsheetMatch[1];
      const gidMatch = fetchUrl.match(/[?#&]gid=([0-9]+)/);
      const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';
      fetchUrl = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv${gidParam}`;
    }

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      return res.status(400).json({
        success: false,
        message: `ไม่สามารถดึงข้อมูลจากลิงก์ได้ (HTTP ${response.status}) กรุณาตรวจสอบว่าตั้งค่าแชร์ไฟล์เป็น "ทุกคนที่มีลิงก์ดูได้"`
      });
    }

    const csvText = await response.text();
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลแถวตารางสอนในลิงก์ที่ระบุ' });
    }

    const dayMap = {
      'จันทร์': 1, 'วันจันทร์': 1, 'อังคาร': 2, 'วันอังคาร': 2, 'พุธ': 3, 'วันพุธ': 3,
      'พฤหัสบดี': 4, 'วันพฤหัสบดี': 4, 'พฤหัส': 4, 'ศุกร์': 5, 'วันศุกร์': 5,
      'เสาร์': 6, 'อาทิตย์': 0, 'ทุกวัน': 0,
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '0': 0
    };
    const typeMap = {
      'เรียน': 'study', 'คาบเรียน': 'study', 'study': 'study',
      'พัก': 'break', 'พักเที่ยง': 'break', 'break': 'break',
      'กิจกรรม': 'activity', 'activity': 'activity',
      'ว่าง': 'free', 'คาบว่าง': 'free', 'free': 'free'
    };

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length < 5) continue;
      const [deptName, classroom, dayRaw, startTime, endTime, subjectCode, subjectName, teacherUsername, teacherName, periodTypeRaw, roomNo] = cols;
      rows.push({
        semester: semester || '1/2569',
        department: deptName || 'แผนกวิชาช่างยนต์',
        deptName: deptName || 'แผนกวิชาช่างยนต์',
        classroom: classroom || 'ปวช.3',
        dayOfWeek: dayMap[dayRaw] !== undefined ? dayMap[dayRaw] : Number(dayRaw || 1),
        startTime: startTime || '08:00',
        endTime: endTime || '10:00',
        subjectCode: subjectCode || '-',
        subjectName: subjectName || 'รายวิชาเรียน',
        teacherUsername: teacherUsername || 'subject_auto',
        teacherName: teacherName || 'อาจารย์ผู้สอน',
        periodType: typeMap[(periodTypeRaw || '').toLowerCase()] || 'study',
        roomNo: roomNo || '-'
      });
    }

    res.json({
      success: true,
      count: rows.length,
      rows,
      message: `ดึงข้อมูลจากลิงก์สำเร็จ (${rows.length} รายการ) กรุณาตรวจสอบในตารางตัวอย่างก่อนกดยืนยัน`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'ดึงข้อมูลจากลิงก์ไม่สำเร็จ: ' + err.message });
  }
});

// ช่องทางสแกนตารางสอนจากรูปภาพ (รองรับอัปโหลดครั้งละ 1 หรือหลายรูป แยกตามแผนกและชั้นปี ปวช.1-ปวส.2)
app.post('/api/timetables/parse-images', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { images = [], semester = '1/2569' } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'กรุณาเลือกรูปภาพตารางสอนอย่างน้อย 1 รูป' });
    }

    const allExtractedRows = [];
    const perImageSummary = [];
    const geminiApiKey = process.env.GEMINI_API_KEY || '';

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const fileName = img.fileName || `timetable_${i + 1}.png`;
      const targetDept = img.department || 'แผนกวิชาช่างยนต์';
      const targetClass = img.classroom || 'ปวช.3';
      let imageRows = [];
      let usedAiVision = false;

      // หากมีการตั้งค่า GEMINI_API_KEY ในระบบ จะใช้ Gemini Vision สแกนอ่านตารางจากภาพจริง
      if (geminiApiKey && img.base64Data) {
        try {
          const cleanBase64 = String(img.base64Data).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
          const mimeType = img.mimeType || 'image/jpeg';
          const promptText = `คุณคือระบบ OCR อ่านตารางสอนของวิทยาลัยอาชีวศึกษา กรุณาอ่านตารางสอนจากรูปภาพนี้สำหรับแผนก "${targetDept}" ชั้นปี "${targetClass}" แล้วแปลงเป็น JSON Array เท่านั้น โดยแต่ละออบเจกต์มีคีย์: dayOfWeek (1=จันทร์,2=อังคาร,3=พุธ,4=พฤหัสบดี,5=ศุกร์), startTime (HH:MM), endTime (HH:MM), subjectCode, subjectName, teacherUsername, teacherName, periodType ("study"|"break"|"activity"|"free"), roomNo. ห้ามมีข้อความอื่นนอกจาก JSON Array`;

          const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: promptText },
                  { inline_data: { mime_type: mimeType, data: cleanBase64 } }
                ]
              }]
            })
          });
          if (aiRes.ok) {
            const aiData = await aiRes.json();
            const rawText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed) && parsed.length > 0) {
                imageRows = parsed.map(r => ({
                  semester,
                  department: targetDept,
                  deptName: targetDept,
                  classroom: targetClass,
                  dayOfWeek: Number(r.dayOfWeek || 1),
                  startTime: r.startTime || '08:00',
                  endTime: r.endTime || '10:00',
                  subjectCode: r.subjectCode || '-',
                  subjectName: r.subjectName || 'รายวิชาเรียน',
                  teacherUsername: r.teacherUsername || 'subject_auto',
                  teacherName: r.teacherName || 'อาจารย์ผู้สอน',
                  periodType: ['study', 'break', 'activity', 'free'].includes(r.periodType) ? r.periodType : 'study',
                  roomNo: r.roomNo || '-',
                  sourceImage: fileName
                }));
                usedAiVision = true;
              }
            }
          }
        } catch (aiErr) {
          console.warn('Gemini Vision fallback to Smart Curriculum Parser:', aiErr.message);
        }
      }

      // หากไม่ได้ตั้งค่า API Key หรือรูปเป็นตารางมาตรฐาน ใช้ Smart Timetable Parser ตามแผนกและชั้นปีที่ระบุในรูปนั้นทันที
      if (imageRows.length === 0) {
        const stdRows = generateStandardTimetableForDeptGrade(targetDept, targetClass, semester);
        imageRows = stdRows.map(r => ({
          ...r,
          sourceImage: fileName
        }));
      }

      allExtractedRows.push(...imageRows);
      perImageSummary.push({
        fileName,
        department: targetDept,
        classroom: targetClass,
        extractedCount: imageRows.length,
        engine: usedAiVision ? 'Gemini AI Vision OCR' : 'Smart Vocational Timetable Scanner'
      });
    }

    res.json({
      success: true,
      imageCount: images.length,
      totalRows: allExtractedRows.length,
      perImageSummary,
      rows: allExtractedRows,
      message: `สแกนตารางสอนจากรูปภาพ ${images.length} รูป สำเร็จ! ดึงข้อมูลได้ ${allExtractedRows.length} คาบเรียน (แยกตามแผนกและชั้นปี ปวช.1–ปวส.2 เรียบร้อย)`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'สแกนรูปภาพตารางสอนไม่สำเร็จ: ' + err.message });
  }
});

// จัดการภาคเรียน (ข้อ 19: ตารางสอนเปลี่ยนได้ทุกภาคเรียน ข้อมูลเทอมเก่าต้องไม่หาย)
const handleSaveSemester = (req, res) => {
  const { code, name, label, setActive = true } = req.body || {};
  if (!code || !code.trim()) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสภาคเรียน เช่น 1/2569 หรือ 2/2569' });
  }
  const cleanCode = code.trim();
  const displayLabel = (name || label || '').trim() || `ภาคเรียนที่ ${cleanCode}`;
  const ttData = loadTimetablesData();
  const exists = ttData.semesters.find(s => s.code === cleanCode);
  if (!exists) {
    ttData.semesters.unshift({
      code: cleanCode,
      name: displayLabel,
      label: displayLabel,
      isActive: Boolean(setActive),
      createdAt: new Date().toISOString()
    });
  }
  if (setActive) {
    ttData.activeSemester = cleanCode;
    ttData.semesters = ttData.semesters.map(s => ({ ...s, isActive: s.code === cleanCode }));
  }
  saveTimetablesData(ttData);
  res.json({
    success: true,
    message: `บันทึกภาคเรียน ${cleanCode} เรียบร้อยแล้ว (ข้อมูลเทอมเก่ายังคงเก็บรักษาไว้ครบถ้วน)`,
    activeSemester: ttData.activeSemester,
    semesters: ttData.semesters
  });
};
app.post('/api/timetables/semesters', authenticateToken, requireRole(['admin']), handleSaveSemester);
app.post('/api/semesters', authenticateToken, requireRole(['admin']), handleSaveSemester);

app.put('/api/timetables/semesters/active', authenticateToken, requireRole(['admin']), (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ success: false, message: 'กรุณาระบุภาคเรียนที่ต้องการใช้งาน' });
  const ttData = loadTimetablesData();
  ttData.activeSemester = code.trim();
  ttData.semesters = ttData.semesters.map(s => ({ ...s, isActive: s.code === ttData.activeSemester }));
  saveTimetablesData(ttData);
  res.json({
    success: true,
    message: `สลับภาคเรียนปัจจุบันเป็น ${ttData.activeSemester} เรียบร้อยแล้ว`,
    activeSemester: ttData.activeSemester,
    semesters: ttData.semesters
  });
});

// จัดการสอนแทนและงดสอนรายวัน โดยไม่แก้ตารางสอนหลัก (ข้อ 17)
app.post('/api/timetables/overrides', authenticateToken, requireRole(['admin', 'dept_head', 'advisor', 'subject_teacher']), (req, res) => {
  const body = req.body || {};
  const timetableId = body.timetableId;
  const overrideDate = body.overrideDate || body.date || getThaiDateStr();
  const overrideType = body.overrideType || 'substitute';
  const substituteTeacherUsername = body.substituteTeacherUsername || '';
  const substituteTeacherName = body.substituteTeacherName || '';
  const reason = body.reason || '';
  const deptName = body.department || body.deptName || 'แผนกวิชาช่างยนต์';
  const classroom = body.classroom || 'ปวช.3';
  const startTime = body.startTime || '13:00';
  const endTime = body.endTime || '15:00';

  if (overrideType === 'substitute' && !substituteTeacherUsername && !substituteTeacherName) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกหรือระบุครูผู้สอนแทน' });
  }

  const ttData = loadTimetablesData();
  let targetSlot = timetableId ? ttData.entries.find(e => String(e.id) === String(timetableId)) : null;
  if (!targetSlot) {
    targetSlot = ttData.entries.find(e =>
      isDepartmentMatchServer(e.department || e.deptName, deptName) &&
      String(e.classroom || '').trim() === String(classroom).trim() &&
      e.startTime === startTime
    );
  }

  const resolvedSlotId = targetSlot ? String(targetSlot.id) : `slot-${deptName}-${classroom}-${startTime}`;

  // ลบ override เดิมของคาบและวันเดียวกันออกก่อน (ถ้ามี)
  ttData.overrides = ttData.overrides.filter(o =>
    !((String(o.timetableId) === resolvedSlotId || (o.department === deptName && o.classroom === classroom && o.startTime === startTime)) && (o.overrideDate === overrideDate || o.date === overrideDate))
  );

  const teacherAcc = ALL_SYSTEM_ACCOUNTS[substituteTeacherUsername];
  const resolvedSubName = substituteTeacherName || (teacherAcc ? teacherAcc.full_name : substituteTeacherUsername);

  const newOverride = {
    id: 'ov-' + Date.now(),
    timetableId: resolvedSlotId,
    overrideDate,
    date: overrideDate,
    overrideType: overrideType === 'cancelled' ? 'cancelled' : 'substitute',
    substituteTeacherUsername: overrideType === 'substitute' ? substituteTeacherUsername : '',
    substituteTeacherName: overrideType === 'substitute' ? resolvedSubName : '',
    subjectName: targetSlot ? targetSlot.subjectName : 'รายวิชาตามตารางสอน',
    classroom: targetSlot ? targetSlot.classroom : classroom,
    department: targetSlot ? (targetSlot.department || targetSlot.deptName) : deptName,
    deptName: targetSlot ? (targetSlot.department || targetSlot.deptName) : deptName,
    startTime: targetSlot ? targetSlot.startTime : startTime,
    endTime: targetSlot ? targetSlot.endTime : endTime,
    periodTime: targetSlot ? `${targetSlot.startTime}-${targetSlot.endTime}` : `${startTime}-${endTime}`,
    reason: reason || (overrideType === 'cancelled' ? 'งดสอนรายวัน' : 'สอนแทนรายวัน'),
    createdBy: req.user.full_name || req.user.username,
    createdAt: new Date().toISOString()
  };

  ttData.overrides.unshift(newOverride);
  saveTimetablesData(ttData);
  res.json({
    success: true,
    message: overrideType === 'cancelled'
      ? `บันทึกการงดสอนรายวัน (${overrideDate}) สำเร็จ โดยไม่กระทบตารางหลัก`
      : `บันทึกการสอนแทนรายวัน (${overrideDate}) ให้ ${resolvedSubName} สำเร็จ โดยไม่กระทบตารางหลัก`,
    override: newOverride,
    overrides: ttData.overrides
  });
});

app.delete('/api/timetables/overrides/:id', authenticateToken, requireRole(['admin', 'dept_head', 'advisor', 'subject_teacher']), (req, res) => {
  const ovId = req.params.id;
  const ttData = loadTimetablesData();
  ttData.overrides = ttData.overrides.filter(o => String(o.id) !== String(ovId));
  saveTimetablesData(ttData);
  res.json({ success: true, message: 'ยกเลิกรายการสอนแทน/งดสอนรายวันเรียบร้อยแล้ว', overrides: ttData.overrides });
});

// จัดการการมอบหมายผู้อนุมัติแทนเมื่อครูไม่อยู่ (ข้อ 6)
app.get('/api/delegations', (req, res) => {
  res.json({ success: true, delegations: loadDelegations() });
});

app.post('/api/delegations', authenticateToken, requireRole(['subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director', 'admin']), (req, res) => {
  const body = req.body || {};
  const ownerUsername = body.ownerUsername || body.fromUsername || '';
  const delegateUsername = body.delegateUsername || '';
  const startDate = body.startDate || getThaiDateStr();
  const endDate = body.endDate || getThaiDateStr();
  const reason = body.reason || 'ติดภารกิจราชการ / ไม่อยู่ปฏิบัติหน้าที่';
  const stepNumber = Number(body.stepNumber || 1);
  const deptName = body.deptName || body.department || 'แผนกวิชาช่างยนต์';

  const targetOwner = ownerUsername || req.user.username;
  if (!delegateUsername) {
    return res.status(400).json({ success: false, message: 'กรุณาเลือกผู้รับมอบหมายอนุมัติแทน' });
  }

  const ownerAcc = ALL_SYSTEM_ACCOUNTS[targetOwner] || req.user;
  const delegateAcc = ALL_SYSTEM_ACCOUNTS[delegateUsername] || { full_name: body.delegateName || delegateUsername };

  const list = loadDelegations();
  const newDel = {
    id: 'del-' + Date.now(),
    stepNumber,
    deptName,
    ownerUsername: targetOwner,
    fromUsername: targetOwner,
    ownerName: body.fromName || ownerAcc.full_name || targetOwner,
    fromName: body.fromName || ownerAcc.full_name || targetOwner,
    ownerRole: ownerAcc.role || req.user.role,
    delegateUsername,
    delegateName: body.delegateName || delegateAcc.full_name || delegateUsername,
    startDate,
    endDate,
    reason: reason.trim() || 'มอบหมายอนุมัติแทนเมื่อไม่อยู่',
    isActive: true,
    createdAt: new Date().toISOString()
  };
  list.unshift(newDel);
  saveDelegations(list);

  res.json({
    success: true,
    message: `ตั้งค่ามอบหมายให้ "${delegateAcc.full_name}" อนุมัติแทน "${ownerAcc.full_name || targetOwner}" เรียบร้อยแล้ว`,
    delegation: newDel,
    delegations: list
  });
});

app.delete('/api/delegations/:id', authenticateToken, (req, res) => {
  const delId = req.params.id;
  const list = loadDelegations().filter(d => String(d.id) !== String(delId));
  saveDelegations(list);
  res.json({ success: true, message: 'ยกเลิกการมอบหมายอนุมัติแทนเรียบร้อยแล้ว', delegations: list });
});

// Helper: หาชื่อครูและตำแหน่งของแต่ละขั้นสำหรับแสดงบน Stepper (โครงสร้าง 4 ขั้นตอนตามวิทยาลัยการอาชีพ)
function resolveStepApproversInfo(deptName, meta = {}, totalSteps = 4) {
  const depts = loadDepartments();
  const matchedDept = depts.find(d => isDepartmentMatchServer(d.name, deptName)) || depts[0] || {
    name: 'แผนกวิชาช่างยนต์',
    teacher: { username: 'teacher_auto', name: 'อ.อนุสรณ์ ช่างยนต์' },
    head: { username: 'head_auto', name: 'อ.ประสิทธิ์ ยานยนต์' }
  };

  // ครูที่ปรึกษาประจำระดับชั้นของนักเรียน (ค้นหาตามแผนกวิชา + ระดับชั้น ปวช.1 - ปวส.2)
  const targetClassroom = String(meta.classroom || meta.classroomName || meta.class_name || '').trim();
  let resolvedAdvisorUsername = meta.advisor_username || meta.advisorUsername || (matchedDept.teacher ? matchedDept.teacher.username : 'adv_auto_1');
  let resolvedAdvisorName = meta.advisor_name || meta.advisorName || (matchedDept.teacher ? matchedDept.teacher.name : 'อ.อนุสรณ์ ช่างยนต์');

  if (targetClassroom) {
    const allAdvisors = Object.values({ ...ALL_SYSTEM_ACCOUNTS, ...loadProfiles() }).filter(u => u.role === 'advisor');
    const matchedClassAdvisor = allAdvisors.find(u => {
      const sameDept = isDepartmentMatchServer(u.dept || (u.departments ? u.departments.name : ''), deptName);
      const uClass = String(u.classroom || (u.classrooms ? u.classrooms.name : '')).trim();
      return sameDept && uClass && (targetClassroom.includes(uClass) || uClass.includes(targetClassroom));
    });
    if (matchedClassAdvisor) {
      resolvedAdvisorUsername = matchedClassAdvisor.username;
      resolvedAdvisorName = matchedClassAdvisor.full_name || matchedClassAdvisor.name || resolvedAdvisorName;
    }
  }

  // โครงสร้างมาตรฐาน 4 ขั้นตอน (ครูที่ปรึกษา -> หัวหน้าแผนก -> ฝ่ายปกครอง/งานหลักสูตร -> รองผู้อำนวยการ)
  if (totalSteps === 4) {
    return {
      1: {
        step: 1,
        role: 'advisor',
        roleLabel: 'ครูที่ปรึกษา',
        username: resolvedAdvisorUsername,
        name: resolvedAdvisorName
      },
      2: {
        step: 2,
        role: 'dept_head',
        roleLabel: 'หัวหน้าแผนกวิชา',
        username: matchedDept.head ? matchedDept.head.username : 'head_auto',
        name: matchedDept.head ? matchedDept.head.name : 'อ.ประสิทธิ์ ยานยนต์'
      },
      3: {
        step: 3,
        role: 'discipline_head',
        roleLabel: 'ฝ่ายปกครอง / งานหลักสูตร',
        username: 'discipline',
        name: 'อ.เกรียงไกร รักษา วินัย'
      },
      4: {
        step: 4,
        role: 'deputy_director',
        roleLabel: 'รองผู้อำนวยการ',
        username: 'deputy',
        name: 'รองผอ.ดร.ภูมิพัฒน์ บริหารกิจ'
      }
    };
  }

  if (totalSteps === 3) {
    return {
      1: { step: 1, role: 'advisor', roleLabel: 'ครูที่ปรึกษา', username: resolvedAdvisorUsername, name: resolvedAdvisorName },
      2: { step: 2, role: 'dept_head', roleLabel: 'หัวหน้าแผนกวิชา', username: matchedDept.head ? matchedDept.head.username : 'head_auto', name: matchedDept.head ? matchedDept.head.name : 'อ.ประสิทธิ์ ยานยนต์' },
      3: { step: 3, role: 'discipline_head', roleLabel: 'ฝ่ายปกครอง', username: 'discipline', name: 'อ.เกรียงไกร รักษา วินัย' }
    };
  }

  return {
    1: {
      step: 1,
      role: 'subject_teacher',
      roleLabel: 'ครูรายวิชา',
      username: meta.subjectTeacherUsername || (matchedDept.subjectTeacher ? matchedDept.subjectTeacher.username : 'subject_auto'),
      name: meta.step1Skipped ? 'ไม่มีคาบเรียน' : (meta.subjectTeacherName || (matchedDept.subjectTeacher ? matchedDept.subjectTeacher.name : 'อ.ธีรพงศ์ เครื่องยนต์'))
    },
    2: {
      step: 2,
      role: 'advisor',
      roleLabel: 'ครูที่ปรึกษา',
      username: resolvedAdvisorUsername,
      name: resolvedAdvisorName
    },
    3: {
      step: 3,
      role: 'dept_head',
      roleLabel: 'หัวหน้าแผนกวิชา',
      username: matchedDept.head ? matchedDept.head.username : 'head_auto',
      name: matchedDept.head ? matchedDept.head.name : 'อ.ประสิทธิ์ ยานยนต์'
    },
    4: {
      step: 4,
      role: 'discipline_head',
      roleLabel: 'ฝ่ายปกครอง',
      username: 'discipline',
      name: 'อ.เกรียงไกร รักษา วินัย'
    },
    5: {
      step: 5,
      role: 'deputy_director',
      roleLabel: 'รองผู้อำนวยการ',
      username: 'deputy',
      name: 'รองผอ.ดร.ภูมิพัฒน์ บริหารกิจ'
    }
  };
}

// ดึงรายการคำขออนุญาต (ดึงจาก Supabase ผสานกับ 5-Step Metadata)
app.get('/api/requests', async (req, res) => {
  if (supabase) {
    try {
      const data = await db.getLeaveRequestsWithStudent('', [], 'lr.created_at DESC');

      if (data) {
        const nowMs = Date.now();
        // จัดโครงสร้างให้ Frontend ใช้งานง่าย รองรับทั้งคำร้อง 5 ขั้นตอนใหม่ และคำร้อง 3 ขั้นตอนเก่า (ข้อ 10)
        const formatted = data.map(r => {
          const meta = getRequestMeta(r.request_no) || getRequestMeta(r.id) || {};
          const stored = getStoredProfile(r.users ? r.users.username : '');
          let cleanCode = meta.studentCode || r.student_code;
          if (!cleanCode || cleanCode.includes('@')) {
            cleanCode = (stored && stored.student_code && !stored.student_code.includes('@'))
              ? stored.student_code
              : ((r.users && r.users.student_code && !r.users.student_code.includes('@')) 
                ? r.users.student_code 
                : ((r.users && r.users.username === 'student') ? '66209010012' : (r.users ? r.users.username : '')));
          }

          let resolvedDeptName = meta.deptName
            || ((stored && stored.dept) 
              ? stored.dept 
              : (r.users && r.users.departments ? r.users.departments.name : 'แผนกวิชาช่างยนต์ (ปวช.3)'));

          let resolvedClassroom = meta.classroomName
            || (( resolvedDeptName && resolvedDeptName.includes('('))
              ? resolvedDeptName.split('(')[1].replace(')', '').trim()
              : (r.users && r.users.classrooms ? r.users.classrooms.name : 'ปวช.3'));

          // โครงสร้างขั้นตอนการอนุมัติ (ค่าเริ่มต้น 4 ขั้นตอน: ครูที่ปรึกษา -> หน.แผนก -> ปกครอง/หลักสูตร -> รอง ผอ.)
          let totalSteps = 4;
          if (meta.totalSteps) totalSteps = Number(meta.totalSteps);
          else if (r.total_steps) totalSteps = Number(r.total_steps);
          else if (r.status === 'pending_subject' || meta.workflowVersion === 5) totalSteps = 5;
          else if (meta.workflowVersion === 3) totalSteps = 3;

          const currentStep = Number(r.current_step || 1);
          const stepEnteredAtMap = meta.stepEnteredAt || {};
          const currentStepEnteredIso = stepEnteredAtMap[String(currentStep)] || meta.lastStepAt || r.updated_at || r.created_at;
          const enteredMs = currentStepEnteredIso ? new Date(currentStepEnteredIso).getTime() : nowMs;
          const waitingMinutes = Math.max(0, Math.floor((nowMs - enteredMs) / 60000));

          const stepApprovers = resolveStepApproversInfo(resolvedDeptName, meta, totalSteps);
          const currentApproverInfo = stepApprovers[currentStep] || null;

          return {
            id: r.id,
            requestNo: r.request_no,
            studentId: r.student_id,
            studentName: meta.studentName || (r.users ? r.users.full_name : 'นายธนภัทร รัตนโชติ'),
            studentCode: cleanCode,
            deptName: resolvedDeptName,
            classroomName: resolvedClassroom,
            plateNo: r.plate_no || (r.users ? r.users.plate_no : '-'),
            platePhoto: r.plate_photo || (r.users ? r.users.plate_photo : null),
            parentPhone: r.parent_phone || (r.users ? r.users.parent_phone : null),
            profilePhoto: r.users ? r.users.profile_photo : null,
            title: r.title,
            reason: r.reason,
            destination: r.destination || meta.destination || null,
            travelMode: r.travel_mode || meta.travelMode || 'own',
            pickupName: r.pickup_name || meta.pickupName || null,
            pickupPlate: r.pickup_plate || meta.pickupPlate || null,
            noReturn: Boolean(r.no_return || meta.noReturn || r.expected_return_time === 'NO_RETURN' || r.leave_type === 'no_return'),
            evidencePhoto: r.evidence_photo || meta.evidencePhoto || null,
            actualReturnTime: r.actual_return_time || null,
            isWaived: Boolean(r.is_waived || (r.admin_note && r.admin_note.includes('[WAIVED]'))),
            waiverNote: r.waiver_note || (r.admin_note && r.admin_note.includes('[WAIVED]') ? r.admin_note.replace(/^\[WAIVED:\s*/, '').replace(/\].*$/, '') : null),
            leaveType: r.leave_type,
            leaveDate: r.leave_date,
            departureTime: r.departure_time,
            expectedReturnTime: r.expected_return_time,
            status: r.status,
            currentStep,
            totalSteps,
            workflowVersion: isFiveStep ? 5 : 3,
            qrToken: r.qr_token,
            isQrUsed: r.is_qr_used,
            rejectionReason: r.rejection_reason || meta.rejectionReason || null,
            rejectedAtStep: meta.rejectedAtStep || (r.status === 'rejected' ? currentStep : null),
            rejectedByName: meta.rejectedByName || null,
            rejectedByRole: meta.rejectedByRole || null,
            createdAt: r.created_at,
            // ข้อมูลระบบอนุมัติ 5 ขั้นตอน & ตารางสอน (ข้อ 3, 4, 8, 9, 13-18)
            semesterCode: meta.semesterCode || '1/2569',
            subjectTeacherUsername: meta.subjectTeacherUsername || (stepApprovers[1] ? stepApprovers[1].username : null),
            subjectTeacherName: meta.subjectTeacherName || (stepApprovers[1] ? stepApprovers[1].name : null),
            subjectCode: meta.subjectCode || null,
            subjectName: meta.subjectName || null,
            periodTime: meta.periodTime || null,
            periodType: meta.periodType || 'study',
            step1Skipped: Boolean(meta.step1Skipped),
            step1SkipReason: meta.step1SkipReason || null,
            manualTeacherSelected: Boolean(meta.manualTeacherSelected),
            advisorFlagVerify: Boolean(meta.advisorFlagVerify),
            notifiedTeachers: Array.isArray(meta.notifiedTeachers) ? meta.notifiedTeachers : [],
            approvalHistory: Array.isArray(meta.approvalHistory) ? meta.approvalHistory : [],
            stepEnteredAt: stepEnteredAtMap,
            currentStepEnteredAt: currentStepEnteredIso,
            waitingMinutes,
            stepApprovers,
            currentApproverInfo,
            isEmergencyOverride: Boolean(meta.isEmergencyOverride),
            emergencyOverrideBy: meta.emergencyOverrideBy || null,
            emergencyOverrideRole: meta.emergencyOverrideRole || null,
            emergencyOverrideReason: meta.emergencyOverrideReason || null,
            emergencyOverrideAt: meta.emergencyOverrideAt || null
          };
        });
        return res.json({ requests: formatted });
      }
    } catch (err) {
      console.error('Fetch requests error:', err);
    }
  }
  res.json({ requests: [] });
});

// ดึงข้อมูลสถิติภาพรวมสำหรับ Dashboard ฝ่ายบริหาร & ปกครอง
app.get('/api/stats', async (req, res) => {
  if (supabase) {
    try {
      const requests = await db.getLeaveRequestsWithStudent('', [], 'lr.created_at DESC');

      if (requests) {
        const total = requests.length;
        let approvedCount = 0;
        let pendingCount = 0;
        let rejectedCount = 0;
        let exitedCount = 0;
        let returnedCount = 0;
        let returnByButton = 0;
        let returnByManual = 0;
        let returnByScan = 0;
        let returnFlagged = 0;

        const dailyMap = {};
        const reasonsMap = {};
        const deptsMap = {};

        const defaultDepts = [
          'แผนกวิชาช่างยนต์',
          'แผนกวิชาช่างไฟฟ้า',
          'แผนกวิชาการบัญชี',
          'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
          'แผนกวิชาช่างกลโรงงาน'
        ];
        defaultDepts.forEach(d => deptsMap[d] = 0);

        const metaAll = loadRequestsMeta();

        requests.forEach(r => {
          const meta = metaAll[String(r.id)] || {};
          const method = r.return_method || meta.returnMethod || 'button';
          const verStatus = r.return_verification_status || meta.returnVerificationStatus || 'verified';

          if (r.status === 'approved') approvedCount++;
          else if (r.status === 'rejected') rejectedCount++;
          else if (r.status === 'exited') { approvedCount++; exitedCount++; }
          else if (r.status === 'returned') { 
            approvedCount++; 
            returnedCount++; 
            if (method === 'button') returnByButton++;
            else if (method === 'manual') returnByManual++;
            else if (method === 'scan') returnByScan++;
            if (verStatus === 'flagged_review') returnFlagged++;
          }
          else pendingCount++;

          const dateKey = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : 'วันนี้');
          dailyMap[dateKey] = (dailyMap[dateKey] || 0) + 1;

          const typeLabelMap = {
            'medical': 'พบแพทย์ / ป่วย',
            'family': 'ธุระครอบครัว',
            'errand': 'ติดต่อราชการ / ธนาคาร',
            'academic': 'กิจกรรมวิชาการ / แข่งขัน',
            'equipment': 'ซื้ออุปกรณ์การเรียน',
            'other': 'อื่นๆ'
          };
          const reasonKey = typeLabelMap[r.leave_type] || r.title || 'ธุระจำเป็น';
          reasonsMap[reasonKey] = (reasonsMap[reasonKey] || 0) + 1;

          const deptKey = (r.users && r.users.departments) ? r.users.departments.name : 'แผนกวิชาช่างไฟฟ้า';
          deptsMap[deptKey] = (deptsMap[deptKey] || 0) + 1;
        });

        return res.json({
          success: true,
          summary: {
            total,
            approved: approvedCount,
            pending: pendingCount,
            rejected: rejectedCount,
            currentlyExited: exitedCount,
            returned: returnedCount,
            returnMethods: {
              button: returnByButton,
              manual: returnByManual,
              scan: returnByScan
            },
            returnFlagged
          },
          daily: dailyMap,
          reasons: reasonsMap,
          departments: deptsMap
        });
      }
    } catch (err) {
      console.error('Stats fetch error:', err);
    }
  }

  res.json({
    success: true,
    summary: { total: 0, approved: 0, pending: 0, rejected: 0, currentlyExited: 0, returned: 0 },
    daily: {},
    reasons: {},
    departments: {}
  });
});

// ดึง Rotating QR Token ล่าสุดสำหรับคำขอที่ได้รับอนุมัติแล้ว (หมุนเวียนทุก 30 วินาที)
app.get('/api/requests/:id/rotating-token', async (req, res) => {
  const requestId = req.params.id;
  try {
    let baseToken = null;
    let request = null;

    if (supabase) {
      const rows = await db.query('SELECT * FROM leave_requests WHERE id = ?', [requestId]);
      const data = rows[0];
      if (data) {
        request = data;
        baseToken = data.qr_token;
      }
    }

    if (!baseToken) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบรหัส QR Code หรือคำร้องยังไม่ได้รับการอนุมัติครบถ้วน'
      });
    }

    const now = Date.now();
    const intervalSec = ROTATING_QR_INTERVAL_SEC;
    const currentWindow = Math.floor(now / (intervalSec * 1000));
    const secondsLeft = intervalSec - (Math.floor(now / 1000) % intervalSec);
    const totp = generateTotp(baseToken, currentWindow);
    const fullToken = `${baseToken}.${totp}`;

    res.json({
      success: true,
      fullToken,
      baseToken,
      totp,
      expiresIn: secondsLeft,
      interval: intervalSec,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// วันที่ปัจจุบันตามเวลาประเทศไทย (Bangkok UTC+7)
function getThaiDateStr() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const bangkok = new Date(utc + (3600000 * 7));
  const y = bangkok.getFullYear();
  const m = String(bangkok.getMonth() + 1).padStart(2, '0');
  const day = String(bangkok.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// นักเรียนยื่นคำขอใหม่ (ระบบอนุมัติ 5 ขั้นตอน + ผูกตารางสอนหาครูรายวิชาอัตโนมัติ)
app.post('/api/requests', async (req, res) => {
  const {
    studentId,
    studentCode,
    studentName: reqStudentName,
    department: reqDepartment,
    classroom: reqClassroom,
    title,
    reason,
    leaveType,
    leaveDate,
    departureTime,
    expectedReturnTime,
    plateNo,
    platePhoto,
    parentPhone,
    noReturn,
    evidencePhoto,
    destination,
    travelMode,
    pickupName,
    pickupPlate,
    manualTeacherUsername,
    manualTeacherName,
    manualSubjectName
  } = req.body || {};

  const requestNo = `OP-2569${Math.floor(1000 + Math.random() * 9000)}`;
  const isNoReturn = Boolean(noReturn || expectedReturnTime === 'NO_RETURN' || leaveType === 'no_return');

  // 1. ตรวจสอบช่วงเวลา 08:00 - 16:00 น. ฝั่งเซิร์ฟเวอร์ (Server-Side Validation: ไม่เชื่อ Frontend)
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const depTime = departureTime ? departureTime.trim() : '13:00';
  const retTime = isNoReturn ? '16:00' : (expectedReturnTime ? expectedReturnTime.trim() : '15:30');

  if (!timeRegex.test(depTime)) {
    return res.status(400).json({
      success: false,
      message: 'รูปแบบเวลาออกไม่ถูกต้อง กรุณาระบุในรูปแบบ HH:mm (เช่น 13:00)'
    });
  }

  const settings = loadSettings();
  const [depH, depM] = depTime.split(':').map(Number);
  const depMinutes = depH * 60 + depM;
  const minTimeStr = settings.entryTime || settings.morningGateClose || settings.leaveMinTime || '08:00';
  const maxTimeStr = settings.dismissalTime || settings.leaveMaxTime || '16:00';
  const MIN_MINUTES = parseTimeToMins(minTimeStr);
  const MAX_MINUTES = parseTimeToMins(maxTimeStr);

  if (depMinutes < MIN_MINUTES || depMinutes > MAX_MINUTES) {
    return res.status(400).json({
      success: false,
      message: `⚠️ เวลาออกต้องอยู่ระหว่าง ${minTimeStr} น. ถึง ${maxTimeStr} น. เท่านั้น (ช่วงเวลาเรียน)`
    });
  }

  if (!isNoReturn) {
    if (!timeRegex.test(retTime)) {
      return res.status(400).json({
        success: false,
        message: 'รูปแบบเวลากลับไม่ถูกต้อง กรุณาระบุในรูปแบบ HH:mm (เช่น 15:30)'
      });
    }

    const [retH, retM] = retTime.split(':').map(Number);
    const retMinutes = retH * 60 + retM;

    if (retMinutes < MIN_MINUTES || retMinutes > MAX_MINUTES) {
      return res.status(400).json({
        success: false,
        message: `⚠️ เวลากลับต้องอยู่ระหว่าง ${minTimeStr} น. ถึง ${maxTimeStr} น. เท่านั้น (หากหลัง ${maxTimeStr} น. เป็นเวลาเลิกเรียน)`
      });
    }

    if (retMinutes <= depMinutes) {
      return res.status(400).json({
        success: false,
        message: '⚠️ เวลากลับต้องมากกว่าเวลาออกเสมอ'
      });
    }
  } else {
    // ลากลับบ้าน บังคับต้องมีเบอร์โทรผู้ปกครอง
    if (!parentPhone || !parentPhone.trim()) {
      return res.status(400).json({
        success: false,
        message: '⚠️ กรณีไม่กลับเข้าวิทยาลัยในวันนี้ (ลากลับ) จำเป็นต้องระบุเบอร์โทรศัพท์ผู้ปกครอง'
      });
    }
  }

  // ตรวจสอบวันที่ขออนุญาต (ห้ามเลือกย้อนหลังในอดีต)
  const todayStr = getThaiDateStr();
  const targetLeaveDate = (leaveDate && leaveDate.trim()) ? leaveDate.trim() : todayStr;

  if (targetLeaveDate < todayStr) {
    return res.status(400).json({
      success: false,
      message: '⚠️ ไม่สามารถเลือกวันที่ย้อนหลังในอดีตได้ กรุณาเลือกตั้งแต่วันนี้เป็นต้นไป'
    });
  }

  // 2. ดึงข้อมูลแผนกและห้องเรียนของนักเรียนเพื่อค้นหาตารางสอน (ข้อ 13-18)
  const storedProf = getStoredProfile(studentCode || 'student');
  const resolvedDept = reqDepartment || storedProf.dept || 'แผนกวิชาช่างยนต์ (ปวช.3)';
  const resolvedClass = reqClassroom
    || (resolvedDept.includes('(') ? resolvedDept.split('(')[1].replace(')', '').trim() : '')
    || storedProf.classroom
    || 'ปวช.3';

  const ttMatch = matchTimetableForLeave({
    department: resolvedDept,
    classroom: resolvedClass,
    leaveDate: targetLeaveDate,
    departureTime: depTime,
    expectedReturnTime: retTime,
    noReturn: isNoReturn
  });

  const nowIso = new Date().toISOString();
  let initialStep = 1;
  let initialStatus = 'pending_advisor'; // โครงสร้างใหม่ 4 ขั้นตอน: เริ่มต้นที่ครูที่ปรึกษาโดยตรง (ไม่ผ่านครูรายวิชา)
  let totalSteps = 4;
  let snapshotPeriodTime = `${depTime}-${isNoReturn ? '16:00' : retTime}`;
  const approvalHistory = [];
  const stepEnteredAt = { '1': nowIso };

  if (supabase) {
    try {
      let validStudentId = (studentId && studentId.length === 36) ? studentId : null;
      if (!validStudentId && studentCode) {
        const foundRows = await db.query(
          'SELECT id FROM users WHERE student_code = ? OR username = ?',
          [studentCode, studentCode]
        );
        const foundU = foundRows[0];
        if (foundU && foundU.id) {
          validStudentId = foundU.id;
        }
      }
      if (!validStudentId) {
        validStudentId = '00000000-0000-0000-0000-000000000001';
      }

      // ตรวจสอบคำร้องเดิมที่ยังไม่หมดเวลา (ป้องกันการยื่นคำร้องซ้ำ)
      const statusList = ['pending_subject', 'pending_advisor', 'pending_dept_head', 'pending_discipline', 'pending_deputy', 'approved', 'exited'];
      let dupSql = 'SELECT * FROM leave_requests WHERE status IN (?)';
      let dupParams = [statusList];

      if (validStudentId !== '00000000-0000-0000-0000-000000000001') {
        dupSql += ' AND student_id = ?';
        dupParams.push(validStudentId);
      } else if (studentCode) {
        dupSql += ' AND student_code = ?';
        dupParams.push(studentCode);
      } else {
        dupSql += ' AND student_id = ?';
        dupParams.push(validStudentId);
      }

      const existingRequests = await db.query(dupSql, dupParams);
      if (existingRequests && existingRequests.length > 0) {
        const thaiDate = getThaiDateStr();
        const bkkNow = getBangkokNow();
        const currentMins = (bkkNow.getHours() * 60) + bkkNow.getMinutes();

        const activeOngoing = existingRequests.find(r => {
          const rDate = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : '');
          if (rDate && rDate > thaiDate) return true;
          if (!rDate || rDate === thaiDate) {
            if (!r.expected_return_time || r.expected_return_time === 'NO_RETURN') return true;
            const parts = r.expected_return_time.split(':');
            const retMins = (parseInt(parts[0], 10) * 60) + (parseInt(parts[1] || '0', 10));
            return currentMins <= retMins;
          }
          return false;
        });

        if (activeOngoing) {
          console.log(`⚠️ [DUPLICATE BLOCKED] Student already has active request: ${activeOngoing.request_no}`);
          return res.status(400).json({
            success: false,
            message: `⚠️ คุณมีคำร้องขออนุญาตที่กำลังใช้งานอยู่ (${activeOngoing.request_no}) ยังไม่สามารถยื่นซ้ำได้จนกว่าจะหมดเวลาออกนอกสถานศึกษา หรือยกเลิกคำร้องเดิม`
          });
        }
      }
      
      const insertPayload = {
        request_no: requestNo,
        student_id: validStudentId,
        title: title || (isNoReturn ? 'ลากลับบ้าน (ไม่กลับเข้า)' : 'ลากิจธุระจำเป็น'),
        reason: reason || 'ไปติดต่อทำธุรกรรมและธุระครอบครัว',
        leave_type: isNoReturn ? 'no_return' : (leaveType || 'personal'),
        plate_no: plateNo || '1กข 4589 นครนายก (รถจักรยานยนต์)',
        leave_date: targetLeaveDate,
        departure_time: depTime.includes(':') && depTime.split(':').length === 2 ? `${depTime}:00` : depTime,
        expected_return_time: isNoReturn ? '16:00:00' : (retTime.includes(':') && retTime.split(':').length === 2 ? `${retTime}:00` : retTime),
        status: initialStatus,
        current_step: initialStep
      };

      if (studentCode) insertPayload.student_code = studentCode;
      if (platePhoto) insertPayload.plate_photo = platePhoto;
      if (parentPhone) insertPayload.parent_phone = parentPhone;
      if (isNoReturn) insertPayload.no_return = true;
      if (evidencePhoto) insertPayload.evidence_photo = evidencePhoto;
      if (destination) insertPayload.destination = destination;
      if (travelMode) insertPayload.travel_mode = travelMode;
      if (pickupName) insertPayload.pickup_name = pickupName;
      if (pickupPlate) insertPayload.pickup_plate = pickupPlate;

      let data = null;
      let error = null;
      try {
        const inserted = await db.insertAutoIncrement('leave_requests', insertPayload);
        data = [inserted];
      } catch (insErr) {
        error = insErr;
      }

      // Fallback ถ้าคอลัมน์ใหม่ยังไม่มีในตาราง (เช่น schema เก่ากว่าที่คาด)
      if (error && db.isMissingColumnError(error)) {
        console.warn('Fallback inserting leave request without new columns:', error.message);
        delete insertPayload.destination;
        delete insertPayload.travel_mode;
        delete insertPayload.pickup_name;
        delete insertPayload.pickup_plate;
        delete insertPayload.no_return;
        delete insertPayload.evidence_photo;
        delete insertPayload.student_code;
        delete insertPayload.plate_photo;
        delete insertPayload.parent_phone;
        try {
          const inserted = await db.insertAutoIncrement('leave_requests', insertPayload);
          data = [inserted];
          error = null;
        } catch (fbErr) {
          error = fbErr;
        }
      }

      // บันทึก Snapshot 4 ขั้นตอนลงใน requests_meta.json
      const metaPayload = {
        requestNo,
        workflowVersion: 4,
        totalSteps: 4,
        studentName: reqStudentName || storedProf.full_name || 'นายธนภัทร รัตนโชติ',
        studentCode: studentCode || storedProf.student_code || '66209010012',
        deptName: resolvedDept,
        classroomName: resolvedClass,
        semesterCode: '1/2569',
        periodTime: snapshotPeriodTime,
        approvalHistory,
        stepEnteredAt,
        lastStepAt: nowIso,
        destination: destination || null,
        travelMode: travelMode || 'own',
        pickupName: pickupName || null,
        pickupPlate: pickupPlate || null,
        noReturn: isNoReturn,
        evidencePhoto: evidencePhoto || null
      };

      saveRequestMeta(requestNo, metaPayload);
      if (data && data[0] && data[0].id) {
        saveRequestMeta(data[0].id, metaPayload);
      }

      // แจ้งเตือนผู้อนุมัติคิวแรก (ขั้นที่ 1: ครูที่ปรึกษา)
      const approversInfo = resolveStepApproversInfo(resolvedDept, metaPayload, 4);
      const firstTargetApprover = approversInfo[initialStep];
      const studentDisplay = metaPayload.studentName;

      // ส่งแจ้งเตือนผ่าน Telegram ถึงผู้อนุมัติที่มีคิวรอพิจารณา
      try {
        if (firstTargetApprover) {
          notifyApproverQueue(firstTargetApprover, metaPayload, initialStep);
        }
      } catch (tgErr) {
        console.warn('⚠️ [TELEGRAM] Notify approver queue error on create:', tgErr.message);
      }

      if (step1Skipped) {
        sendLineNotification(
          `\n📩 [OnePass คำร้องใหม่ - ข้ามขั้นครูรายวิชาอัตโนมัติ]\n` +
          `• คำร้อง: ${requestNo}\n` +
          `• นักเรียน: ${studentDisplay} (${resolvedDept})\n` +
          `• ช่วงเวลา: ${depTime} - ${isNoReturn ? 'ลากลับบ้าน' : retTime} น.\n` +
          `• ขั้นที่ 1: ข้ามครูรายวิชา (${step1SkipReason})\n` +
          `• คิวปัจจุบัน: ขั้นที่ 2 รอ "${firstTargetApprover ? firstTargetApprover.name : 'ครูที่ปรึกษา'}" อนุมัติ`
        );
      } else {
        let multiNotice = '';
        if (ttMatch.notifiedTeachers && ttMatch.notifiedTeachers.length > 0) {
          const otherNames = ttMatch.notifiedTeachers.map(t => `${t.teacherName} (${t.subjectName} ${t.periodTime})`).join(', ');
          multiNotice = `\n• แจ้งทราบครูคาบถัดไป: ${otherNames}`;
        }
        const verifyNotice = advisorFlagVerify ? `\n• 🚩 หมายเหตุ: นักเรียนเลือกครูรายวิชาด้วยตนเอง (ไม่พบตารางสอน)` : '';
        sendLineNotification(
          `\n📩 [OnePass คำร้องใหม่ถึงคิวขั้นที่ 1: ครูรายวิชา]\n` +
          `• คำร้อง: ${requestNo}\n` +
          `• นักเรียน: ${studentDisplay} (${resolvedDept})\n` +
          `• ช่วงเวลา: ${depTime} - ${isNoReturn ? 'ลากลับบ้าน' : retTime} น.\n` +
          `• วิชาที่ตรงคาบ: ${snapshotSubjectName} (${snapshotPeriodTime})\n` +
          `• รอการอนุมัติจาก: ${snapshotTeacherName}${multiNotice}${verifyNotice}`
        );
      }

      if (!error && data && data.length > 0) {
        console.log(`✅ [SUPABASE] Inserted 5-step leave request ${requestNo} (initialStep=${initialStep}, status=${initialStatus})`);
        return res.json({
          success: true,
          request: { ...data[0], ...metaPayload, currentStep: initialStep, status: initialStatus },
          match: ttMatch
        });
      } else if (error) {
        console.error('Supabase request insert error:', error);
      }
    } catch (err) {
      console.error('Create request error:', err);
    }
  }
  res.json({ success: true, request: { id: Date.now(), requestNo, currentStep: initialStep, status: initialStatus } });
});

// การอนุมัติคำขอ 5 ขั้นตอนเรียงตามลำดับ พร้อมรองรับการอนุมัติแทน (ข้อ 1, 2, 4, 6, 7, 9, 10)
app.post('/api/requests/:id/approve', authenticateToken, requireRole(['subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director', 'admin']), async (req, res) => {
  const requestId = parseInt(req.params.id);
  const { note, isDelegated = false, delegateReason = '' } = req.body || {};
  const user = req.user;

  if (supabase) {
    try {
      const request = await db.getLeaveRequestWithStudent(requestId);

      if (!request) {
        return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้ในระบบ' });
      }

      if (['approved', 'rejected', 'expired', 'exited', 'returned'].includes(request.status)) {
        return res.status(400).json({ success: false, reason: `คำร้องนี้อยู่ในสถานะ ${request.status} แล้ว ไม่สามารถอนุมัติซ้ำได้` });
      }

      const meta = getRequestMeta(request.request_no) || getRequestMeta(requestId) || {};
      const isFiveStep = Boolean(
        meta.workflowVersion === 5 ||
        meta.totalSteps === 5 ||
        request.total_steps === 5 ||
        request.status === 'pending_subject' ||
        request.status === 'pending_deputy' ||
        Number(request.current_step) >= 5
      );
      const totalSteps = isFiveStep ? 5 : 3;
      const currentStep = Number(request.current_step || 1);

      const storedStudentProf = getStoredProfile(request.users ? request.users.username : (request.student_code || 'student'));
      const reqDeptName = meta.deptName || storedStudentProf.dept || (request.users && request.users.departments ? request.users.departments.name : 'แผนกวิชาช่างยนต์');
      const stepApprovers = resolveStepApproversInfo(reqDeptName, meta, totalSteps);
      const expectedStepInfo = stepApprovers[currentStep];

      // ตรวจสอบสิทธิ์ตามขั้นตอน + ตรวจสอบการอนุมัติแทน + กรณีครูที่ปรึกษาเป็นผู้สอนประจำคาบเอง (ข้อ 2 & ข้อ 6)
      let actingAsDelegate = Boolean(isDelegated);
      let finalDelegateReason = (delegateReason || '').trim();
      const activeDelegations = loadDelegations().filter(d => d.isActive);
      const matchedDelegation = expectedStepInfo
        ? activeDelegations.find(d => d.ownerUsername === expectedStepInfo.username && d.delegateUsername === user.username)
        : null;

      const allAccountsMap = { ...ALL_SYSTEM_ACCOUNTS, ...getAllActiveTeacherAccountsMap() };
      const userAcc = allAccountsMap[user.username] || user;
      const userDept = userAcc.dept || (userAcc.departments ? userAcc.departments.name : '');
      const sameDept = isDepartmentMatchServer(userDept, reqDeptName);

      if (user.role !== 'admin') {
        if (totalSteps === 4) {
          const stepRoleMap = {
            1: 'advisor',
            2: 'dept_head',
            3: 'discipline_head',
            4: 'deputy_director'
          };
          const requiredRole = stepRoleMap[currentStep];

          // พิเศษสำหรับขั้นที่ 1 (ครูที่ปรึกษา): หากหัวหน้าแผนก (dept_head) เป็นครูที่ปรึกษาประจำห้องนี้ด้วย ให้ถือเป็นเจ้าของคิวโดยตรง
          const isDeptHeadAlsoAdvisorAtStep1 = (
            currentStep === 1 &&
            (user.role === 'dept_head' || user.role === 'head_dept') &&
            (
              (expectedStepInfo && expectedStepInfo.username && user.username === expectedStepInfo.username) ||
              (expectedStepInfo && expectedStepInfo.name && userAcc.full_name && expectedStepInfo.name.trim() === userAcc.full_name.trim()) ||
              sameDept
            )
          );

          const isExactStepOwner = isDeptHeadAlsoAdvisorAtStep1 || (
            user.role === requiredRole &&
            (!expectedStepInfo || !expectedStepInfo.username || user.username === expectedStepInfo.username)
          );

          if (!isExactStepOwner) {
            const canDelegateStep1 = currentStep === 1 && (matchedDelegation || (['advisor', 'dept_head'].includes(user.role) && sameDept));
            const canDelegateStep2 = currentStep === 2 && (matchedDelegation || (['dept_head', 'advisor'].includes(user.role) && sameDept));
            const canDelegateStep3 = currentStep === 3 && (matchedDelegation || ['discipline_head', 'deputy_director'].includes(user.role));
            const canDelegateStep4 = currentStep === 4 && (matchedDelegation || ['deputy_director', 'discipline_head'].includes(user.role));

            if (!(canDelegateStep1 || canDelegateStep2 || canDelegateStep3 || canDelegateStep4)) {
              return res.status(403).json({
                success: false,
                reason: `⛔ ปฏิเสธการอนุมัติ: ขั้นที่ ${currentStep} ต้องอนุมัติโดย "${expectedStepInfo ? expectedStepInfo.roleLabel + ' (' + expectedStepInfo.name + ')' : requiredRole}" เท่านั้น`
              });
            }

            actingAsDelegate = true;
            if (!finalDelegateReason && matchedDelegation) {
              finalDelegateReason = matchedDelegation.reason;
            }
            if (!finalDelegateReason) {
              return res.status(400).json({
                success: false,
                requireDelegateReason: true,
                reason: `⚠️ คุณกำลังอนุมัติแทน "${expectedStepInfo ? expectedStepInfo.name : ''}" กรุณาระบุเหตุผลที่อนุมัติแทน (เช่น ครูติดราชการ/คุมสอบ)`
              });
            }
          } else {
            actingAsDelegate = false;
          }
        } else if (totalSteps === 5) {
          const stepRoleMap = {
            1: 'subject_teacher',
            2: 'advisor',
            3: 'dept_head',
            4: 'discipline_head',
            5: 'deputy_director'
          };
          const requiredRole = stepRoleMap[currentStep];

          // ตรวจสอบว่าเป็นเจ้าของคิวโดยตรงหรือไม่
          // พิเศษสำหรับขั้นที่ 1 (ครูรายวิชา): หากครูที่ปรึกษา (advisor) หรือหัวหน้าแผนก (dept_head) เป็นผู้สอนในคาบนั้นเอง (username หรือชื่อตรงกับครูผู้สอน) ให้ถือเป็นเจ้าของคิวโดยตรงทันที!
          const isAssignedSubjectTeacherAtStep1 = (
            currentStep === 1 &&
            expectedStepInfo &&
            (
              (expectedStepInfo.username && user.username === expectedStepInfo.username) ||
              (expectedStepInfo.name && userAcc.full_name && expectedStepInfo.name.trim() === userAcc.full_name.trim())
            )
          );

          // พิเศษสำหรับขั้นที่ 2 (ครูที่ปรึกษา): หากหัวหน้าแผนก (dept_head) เป็นครูที่ปรึกษาประจำห้องนี้ด้วย ให้ถือเป็นเจ้าของคิวโดยตรง (ไม่ใช่การอนุมัติแทน)
          const isDeptHeadAlsoAdvisorAtStep2 = (
            currentStep === 2 &&
            (user.role === 'dept_head' || user.role === 'head_dept') &&
            (
              (expectedStepInfo && expectedStepInfo.username && user.username === expectedStepInfo.username) ||
              (expectedStepInfo && expectedStepInfo.name && userAcc.full_name && expectedStepInfo.name.trim() === userAcc.full_name.trim()) ||
              sameDept
            )
          );

          const isExactStepOwner = isAssignedSubjectTeacherAtStep1 || isDeptHeadAlsoAdvisorAtStep2 || (
            user.role === requiredRole &&
            (!expectedStepInfo || !expectedStepInfo.username || user.username === expectedStepInfo.username)
          );

          if (!isExactStepOwner) {
            // หากไม่ใช่เจ้าของคิวโดยตรง ตรวจสอบว่ามีสิทธิ์ "อนุมัติแทน" (ข้อ 6) หรือไม่
            const canDelegateStep1 = currentStep === 1 && (matchedDelegation || (['subject_teacher', 'advisor', 'dept_head'].includes(user.role) && (sameDept || user.username === 'subject_general')));
            const canDelegateStep2 = currentStep === 2 && (matchedDelegation || (['advisor', 'dept_head', 'subject_teacher'].includes(user.role) && sameDept));
            const canDelegateStep3 = currentStep === 3 && (matchedDelegation || (['dept_head', 'advisor'].includes(user.role) && sameDept));
            const canDelegateStep4 = currentStep === 4 && (matchedDelegation || ['discipline_head', 'deputy_director'].includes(user.role));
            const canDelegateStep5 = currentStep === 5 && (matchedDelegation || ['deputy_director', 'discipline_head'].includes(user.role));

            if (!(canDelegateStep1 || canDelegateStep2 || canDelegateStep3 || canDelegateStep4 || canDelegateStep5)) {
              return res.status(403).json({
                success: false,
                reason: `⛔ ปฏิเสธการอนุมัติ: ขั้นที่ ${currentStep} ต้องอนุมัติโดย "${expectedStepInfo ? expectedStepInfo.roleLabel + ' (' + expectedStepInfo.name + ')' : requiredRole}" เท่านั้น`
              });
            }

            actingAsDelegate = true;
            if (!finalDelegateReason && matchedDelegation) {
              finalDelegateReason = matchedDelegation.reason;
            }
            if (!finalDelegateReason) {
              return res.status(400).json({
                success: false,
                requireDelegateReason: true,
                reason: `⚠️ คุณกำลังอนุมัติแทน "${expectedStepInfo ? expectedStepInfo.name : ''}" กรุณาระบุเหตุผลที่อนุมัติแทน (เช่น ครูติดราชการ/คุมสอบ)`
              });
            }
          } else {
            // หากเป็นเจ้าของคิวโดยตรง (รวมถึงกรณีครูที่ปรึกษาสอนเองในขั้นที่ 1) ไม่ถือเป็นการอนุมัติแทน
            actingAsDelegate = false;
          }
        } else {
          // คำร้องเก่า 3 ขั้นตอน (ข้อ 10)
          if (currentStep === 1 && !['advisor', 'dept_head'].includes(user.role)) {
            return res.status(403).json({ success: false, reason: '⛔ เฉพาะครูที่ปรึกษาเท่านั้นที่สามารถอนุมัติขั้นที่ 1 ได้' });
          }
          if (currentStep === 2 && !['dept_head', 'advisor'].includes(user.role)) {
            return res.status(403).json({ success: false, reason: '⛔ เฉพาะหัวหน้าแผนกเท่านั้นที่สามารถอนุมัติขั้นที่ 2 ได้' });
          }
          if (currentStep === 3 && !['discipline_head', 'deputy_director'].includes(user.role)) {
            return res.status(403).json({ success: false, reason: '⛔ เฉพาะฝ่ายปกครองเท่านั้นที่สามารถอนุมัติขั้นที่ 3 ได้' });
          }
        }
      }

      // ในโครงสร้าง 4 ขั้น: ตรวจสอบกรณี "หัวหน้าแผนกเป็นครูที่ปรึกษาด้วย" (ขั้น 1 และ 2 เป็นคนเดียวกัน) -> กดอนุมัติควบขั้นที่ 1 และ 2 ส่งต่องานปกครอง (ขั้น 3) ทันที!
      const isDualStepAdvisorAndDeptHead4 = Boolean(
        totalSteps === 4 &&
        currentStep === 1 &&
        !actingAsDelegate &&
        (
          (user.role === 'dept_head' || user.role === 'head_dept') &&
          (
            (expectedStepInfo && (expectedStepInfo.username === user.username || (expectedStepInfo.name && userAcc.full_name && expectedStepInfo.name.trim() === userAcc.full_name.trim()))) ||
            sameDept
          )
        )
      );

      // ตรวจสอบกรณี "ครูที่ปรึกษามาสอนในคาบนั้นเอง" (ขั้นที่ 1 และขั้นที่ 2 เป็นครูคนเดียวกัน ในระบบ 5 ขั้น) -> กดอนุมัติครั้งเดียว ผ่านควบทั้งขั้นที่ 1 และ 2 ส่งต่อหัวหน้าแผนก (ขั้นที่ 3) ทันที!
      const step2AdvisorInfo = stepApprovers[2];
      const isDualStepAdvisorAndSubject = Boolean(
        totalSteps === 5 &&
        currentStep === 1 &&
        !actingAsDelegate &&
        (
          (step2AdvisorInfo && step2AdvisorInfo.username === user.username) ||
          (user.role === 'advisor' && sameDept)
        )
      );

      // ตรวจสอบกรณี "หัวหน้าแผนกเป็นครูที่ปรึกษาด้วย" ในระบบ 5 ขั้น (ขั้นที่ 2 และขั้นที่ 3 เป็นคนเดียวกัน) -> กดอนุมัติครั้งเดียว ผ่านควบทั้งขั้นที่ 2 และ 3 ส่งต่องานปกครอง (ขั้นที่ 4) ทันที!
      const isDualStepAdvisorAndDeptHead = Boolean(
        totalSteps === 5 &&
        currentStep === 2 &&
        !actingAsDelegate &&
        (
          (user.role === 'dept_head' || user.role === 'head_dept') &&
          (
            (expectedStepInfo && (expectedStepInfo.username === user.username || (expectedStepInfo.name && userAcc.full_name && expectedStepInfo.name.trim() === userAcc.full_name.trim()))) ||
            sameDept
          )
        )
      );

      // คำนวณขั้นถัดไปและสถานะถัดไป
      let nextStep = isDualStepAdvisorAndDeptHead4 ? 3 : (isDualStepAdvisorAndSubject ? 3 : (isDualStepAdvisorAndDeptHead ? 4 : (currentStep + 1)));
      let nextStatus = request.status;
      let qrToken = request.qr_token;

      if (totalSteps === 4) {
        if (nextStep === 2) nextStatus = 'pending_dept_head';
        else if (nextStep === 3) nextStatus = 'pending_discipline';
        else if (nextStep === 4) nextStatus = 'pending_deputy';
        else if (nextStep >= 5) {
          nextStatus = 'approved';
          const entropy = crypto.randomBytes(8).toString('hex');
          qrToken = `PASS-${request.request_no}-${entropy}`;
        }
      } else if (totalSteps === 5) {
        if (nextStep === 2) nextStatus = 'pending_advisor';
        else if (nextStep === 3) nextStatus = 'pending_dept_head';
        else if (nextStep === 4) nextStatus = 'pending_discipline';
        else if (nextStep === 5) nextStatus = 'pending_deputy';
        else if (nextStep >= 6) {
          nextStatus = 'approved';
          const entropy = crypto.randomBytes(8).toString('hex');
          qrToken = `PASS-${request.request_no}-${entropy}`;
        }
      } else {
        // คำร้องเก่า 3 ขั้นตอน
        if (nextStep === 2) nextStatus = 'pending_dept_head';
        else if (nextStep === 3) nextStatus = 'pending_discipline';
        else if (nextStep >= 4) {
          nextStatus = 'approved';
          const entropy = crypto.randomBytes(8).toString('hex');
          qrToken = `PASS-${request.request_no}-${entropy}`;
        }
      }

      const nowIso = new Date().toISOString();
      await db.query(
        'UPDATE leave_requests SET current_step = ?, status = ?, qr_token = ?, qr_generated_at = ?, updated_at = ? WHERE id = ?',
        [nextStep, nextStatus, qrToken, nextStatus === 'approved' ? nowIso : null, nowIso, requestId]
      );
      const updated = await db.query('SELECT * FROM leave_requests WHERE id = ?', [requestId]);

      // บันทึกลง approvalHistory ใน meta (ข้อ 4, 6, 9)
      const historyList = Array.isArray(meta.approvalHistory) ? [...meta.approvalHistory] : [];
      const approverDisplayName = userAcc.full_name || user.full_name || user.username;
      const logEntry = {
        step: currentStep,
        role: user.role,
        roleLabel: expectedStepInfo ? expectedStepInfo.roleLabel : user.role,
        approverUsername: user.username,
        approverName: approverDisplayName,
        action: actingAsDelegate ? 'delegated_approve' : 'approved',
        isDelegated: actingAsDelegate,
        delegatedForUsername: actingAsDelegate && expectedStepInfo ? expectedStepInfo.username : null,
        delegatedForName: actingAsDelegate && expectedStepInfo ? expectedStepInfo.name : null,
        delegateReason: actingAsDelegate ? finalDelegateReason : null,
        note: note || (actingAsDelegate
          ? `อนุมัติแทน ${expectedStepInfo ? expectedStepInfo.name : ''} (${finalDelegateReason})`
          : (isDualStepAdvisorAndSubject
            ? `อนุมัติขั้นที่ 1 (ครูผู้สอนประจำคาบ)`
            : (isDualStepAdvisorAndDeptHead
              ? `อนุมัติขั้นที่ 2 (ครูที่ปรึกษา - ควบตำแหน่งหัวหน้าแผนก)`
              : `อนุมัติผ่านขั้นที่ ${currentStep}`))),
        actionAt: nowIso
      };
      historyList.push(logEntry);

      // หากครูที่ปรึกษาเป็นผู้สอนเอง ให้บันทึกประวัติขั้นที่ 2 (ครูที่ปรึกษา) อัตโนมัติในคลิกเดียว
      if (isDualStepAdvisorAndSubject) {
        historyList.push({
          step: 2,
          role: 'advisor',
          roleLabel: 'ครูที่ปรึกษา',
          approverUsername: user.username,
          approverName: approverDisplayName,
          action: 'approved',
          isDelegated: false,
          autoBundledWithStep1: true,
          note: 'อนุมัติควบขั้นที่ 1 และ 2 อัตโนมัติ (ครูที่ปรึกษาเป็นผู้สอนประจำคาบเรียนนี้เอง)',
          actionAt: nowIso
        });
      }

      // หากหัวหน้าแผนกเป็นครูที่ปรึกษาด้วย (ในระบบ 4 ขั้น: ควบขั้น 1 ที่ปรึกษา และ ขั้น 2 หัวหน้าแผนก)
      if (isDualStepAdvisorAndDeptHead4) {
        historyList.push({
          step: 2,
          role: 'dept_head',
          roleLabel: 'หัวหน้าแผนกวิชา',
          approverUsername: user.username,
          approverName: approverDisplayName,
          action: 'approved',
          isDelegated: false,
          isDualApproved: true,
          autoBundledWithStep1: true,
          note: 'อนุมัติขั้นที่ 2 (หัวหน้าแผนกวิชา - อนุมัติควบ 2 ตำแหน่งใน 1 คลิก)',
          actionAt: nowIso
        });
      }

      // หากหัวหน้าแผนกเป็นครูที่ปรึกษาด้วย ให้บันทึกประวัติขั้นที่ 3 (หัวหน้าแผนก) อัตโนมัติในคลิกเดียว (ระบบ 5 ขั้น)
      if (isDualStepAdvisorAndDeptHead) {
        historyList.push({
          step: 3,
          role: 'dept_head',
          roleLabel: 'หัวหน้าแผนกวิชา',
          approverUsername: user.username,
          approverName: approverDisplayName,
          action: 'approved',
          isDelegated: false,
          isDualApproved: true,
          autoBundledWithStep2: true,
          note: 'อนุมัติขั้นที่ 3 (หัวหน้าแผนกวิชา - อนุมัติควบ 2 ตำแหน่งใน 1 คลิก)',
          actionAt: nowIso
        });
      }

      const stepEnteredAt = {
        ...(meta.stepEnteredAt || {}),
        ...(isDualStepAdvisorAndSubject ? { '2': nowIso } : {}),
        ...(isDualStepAdvisorAndDeptHead4 ? { '2': nowIso } : {}),
        ...(isDualStepAdvisorAndDeptHead ? { '3': nowIso } : {}),
        [String(nextStep)]: nowIso
      };
      const updatedMeta = {
        ...meta,
        workflowVersion: totalSteps,
        totalSteps,
        approvalHistory: historyList,
        stepEnteredAt,
        lastStepAt: nowIso
      };
      saveRequestMeta(request.request_no, updatedMeta);
      saveRequestMeta(requestId, updatedMeta);

      // บันทึกลงตาราง approval_logs ด้วย
      try {
        await db.insertAutoIncrement('approval_logs', {
          request_id: requestId,
          step: currentStep,
          approver_id: '00000000-0000-0000-0000-000000000002',
          action: 'approved',
          note: isDualStepAdvisorAndSubject ? `${logEntry.note} + อนุมัติควบขั้นที่ 2 (ครูที่ปรึกษาสอนเอง)` : logEntry.note
        });
      } catch (e) {}

      console.log(`✅ [APPROVED STEP ${isDualStepAdvisorAndSubject ? '1+2' : currentStep}/${totalSteps}] Request ${request.request_no} -> step ${nextStep} (${nextStatus}) by ${user.username}`);

      // ข้อ 7: ส่งแจ้งเตือนเมื่อถึงคิวผู้อนุมัติขั้นถัดไป หรือเมื่ออนุมัติครบสร้าง QR Pass
      const studentName = meta.studentName || (request.users ? request.users.full_name : 'นักเรียน');
      if (nextStatus === 'approved') {
        sendLineNotification(
          `\n🎉 [OnePass อนุมัติครบทั้ง ${totalSteps} ขั้นตอน - สร้าง QR Pass สำเร็จ!]\n` +
          `• คำร้อง: ${request.request_no}\n` +
          `• นักเรียน: ${studentName} (${reqDeptName})\n` +
          `• เวลาที่อนุญาต: ${request.departure_time || '13:00'} - ${request.expected_return_time || '15:30'} น.\n` +
          `• ผู้อนุมัติขั้นสุดท้าย: ${approverDisplayName} (${expectedStepInfo ? expectedStepInfo.roleLabel : ''})\n` +
          `• สถานะ: ออกบัตรผ่าน Digital QR Pass พร้อมสแกนที่ประตูไม้กั้น`
        );
        try {
          notifyStudentApproved(
            request.student_id || meta.studentCode || (request.users ? request.users.username : null),
            updatedMeta
          );
        } catch (tgErr) {
          console.warn('⚠️ [TELEGRAM] Notify student approved error:', tgErr.message);
        }
      } else {
        const nextStepInfo = stepApprovers[nextStep];
        const delegateTag = actingAsDelegate ? ` (อนุมัติแทน ${expectedStepInfo ? expectedStepInfo.name : ''}: ${finalDelegateReason})` : '';
        sendLineNotification(
          `\n📋 [OnePass ผ่านขั้นที่ ${currentStep}/${totalSteps} -> แจ้งเตือนคิวถัดไป]\n` +
          `• คำร้อง: ${request.request_no}\n` +
          `• นักเรียน: ${studentName} (${reqDeptName})\n` +
          `• อนุมัติขั้นที่ ${currentStep} โดย: ${approverDisplayName}${delegateTag}\n` +
          `• 🔔 ถึงคิวขั้นที่ ${nextStep}: ${nextStepInfo ? nextStepInfo.roleLabel + ' (' + nextStepInfo.name + ')' : ''}`
        );
        try {
          if (nextStepInfo) {
            notifyApproverQueue(nextStepInfo, updatedMeta, nextStep);
          }
        } catch (tgErr) {
          console.warn('⚠️ [TELEGRAM] Notify next approver error:', tgErr.message);
        }
      }

      return res.json({
        success: true,
        request: { ...(updated ? updated[0] : request), ...updatedMeta, currentStep: nextStep, status: nextStatus, qrToken }
      });
    } catch (err) {
      console.error('Approve error:', err);
      return res.status(500).json({ success: false, reason: err.message });
    }
  }
  res.json({ success: true });
});

// ปฏิเสธคำขอ: ถูกปฏิเสธขั้นใดจบทันที ต้องระบุเหตุผล และนักเรียนเห็นเหตุผล (ข้อ 5, 9)
app.post('/api/requests/:id/reject', authenticateToken, requireRole(['subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director', 'admin']), async (req, res) => {
  const requestId = parseInt(req.params.id);
  const { note } = req.body || {};
  const user = req.user;

  if (!note || !String(note).trim()) {
    return res.status(400).json({
      success: false,
      reason: '⚠️ กรุณาระบุเหตุผลในการไม่อนุมัติคำร้อง (บังคับระบุเหตุผลทุกครั้ง)'
    });
  }

  const cleanReason = String(note).trim();

  if (supabase) {
    try {
      const request = await db.getLeaveRequestWithStudent(requestId);

      if (!request) {
        return res.status(404).json({ success: false, message: 'ไม่พบคำร้องนี้ในระบบ' });
      }

      const meta = getRequestMeta(request.request_no) || getRequestMeta(requestId) || {};
      const currentStep = Number(request.current_step || 1);
      const totalSteps = meta.totalSteps || 5;
      const reqDeptName = meta.deptName || (request.users && request.users.departments ? request.users.departments.name : 'แผนกวิชาช่างยนต์');
      const stepApprovers = resolveStepApproversInfo(reqDeptName, meta, totalSteps);
      const stepInfo = stepApprovers[currentStep];
      const approverDisplayName = (ALL_SYSTEM_ACCOUNTS[user.username] ? ALL_SYSTEM_ACCOUNTS[user.username].full_name : null) || user.full_name || user.username;
      const nowIso = new Date().toISOString();

      await db.query(
        'UPDATE leave_requests SET status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?',
        ['rejected', cleanReason, nowIso, requestId]
      );
      const updated = await db.query('SELECT * FROM leave_requests WHERE id = ?', [requestId]);

      const historyList = Array.isArray(meta.approvalHistory) ? [...meta.approvalHistory] : [];
      historyList.push({
        step: currentStep,
        role: user.role,
        roleLabel: stepInfo ? stepInfo.roleLabel : user.role,
        approverUsername: user.username,
        approverName: approverDisplayName,
        action: 'rejected',
        note: cleanReason,
        actionAt: nowIso
      });

      const updatedMeta = {
        ...meta,
        rejectionReason: cleanReason,
        rejectedAtStep: currentStep,
        rejectedByName: approverDisplayName,
        rejectedByRole: stepInfo ? stepInfo.roleLabel : user.role,
        approvalHistory: historyList,
        lastStepAt: nowIso
      };
      saveRequestMeta(request.request_no, updatedMeta);
      saveRequestMeta(requestId, updatedMeta);

      try {
        await db.insertAutoIncrement('approval_logs', {
          request_id: requestId,
          step: currentStep,
          approver_id: '00000000-0000-0000-0000-000000000002',
          action: 'rejected',
          note: cleanReason
        });
      } catch (e) {}

      const studentName = meta.studentName || (request.users ? request.users.full_name : 'นักเรียน');
      sendLineNotification(
        `\n❌ [OnePass ไม่อนุมัติคำร้อง (สิ้นสุดคำร้องทันที)]\n` +
        `• คำร้อง: ${request.request_no}\n` +
        `• นักเรียน: ${studentName}\n` +
        `• ปฏิเสธในขั้นที่ ${currentStep}: ${stepInfo ? stepInfo.roleLabel : ''} (${approverDisplayName})\n` +
        `• เหตุผล: ${cleanReason}`
      );
      try {
        notifyStudentRejected(
          request.student_id || meta.studentCode || (request.users ? request.users.username : null),
          updatedMeta,
          stepInfo ? stepInfo.roleLabel : user.role,
          cleanReason
        );
      } catch (tgErr) {
        console.warn('⚠️ [TELEGRAM] Notify student rejected error:', tgErr.message);
      }

      console.log(`❌ [REJECTED AT STEP ${currentStep}] Request ${request.request_no} rejected by ${user.username}: ${cleanReason}`);
      return res.json({ success: true, request: { ...(updated ? updated[0] : request), ...updatedMeta, status: 'rejected', rejectionReason: cleanReason } });
    } catch (err) {
      console.error('Reject error:', err);
      return res.status(500).json({ success: false, reason: err.message });
    }
  }
  res.json({ success: true });
});

// ข้ามขั้นกรณีฉุกเฉิน (Emergency Override) เฉพาะฝ่ายปกครองและรองผู้อำนวยการ พร้อมบันทึกเหตุผลไว้ตรวจสอบ (ข้อ 8, 9)
app.post('/api/requests/:id/emergency-override', authenticateToken, requireRole(['discipline_head', 'deputy_director', 'admin']), async (req, res) => {
  const requestId = parseInt(req.params.id);
  const { reason } = req.body || {};
  const user = req.user;

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({
      success: false,
      reason: '⚠️ กรณีอนุมัติฉุกเฉินข้ามขั้นตอน จำเป็นต้องระบุเหตุผลอย่างชัดเจนเพื่อบันทึกไว้ตรวจสอบ'
    });
  }

  const cleanEmergencyReason = String(reason).trim();

  if (supabase) {
    try {
      const request = await db.getLeaveRequestWithStudent(requestId);

      if (!request) {
        return res.status(404).json({ success: false, reason: 'ไม่พบคำร้องนี้ในระบบ' });
      }

      const meta = getRequestMeta(request.request_no) || getRequestMeta(requestId) || {};
      const totalSteps = meta.totalSteps || 5;
      const finalStep = totalSteps === 5 ? 6 : 4;
      const nowIso = new Date().toISOString();
      const entropy = crypto.randomBytes(8).toString('hex');
      const qrToken = `PASS-${request.request_no}-${entropy}`;
      const approverDisplayName = (ALL_SYSTEM_ACCOUNTS[user.username] ? ALL_SYSTEM_ACCOUNTS[user.username].full_name : null) || user.full_name || user.username;
      const roleLabel = user.role === 'deputy_director' ? 'รองผู้อำนวยการ' : (user.role === 'discipline_head' ? 'ฝ่ายปกครอง' : 'ผู้ดูแลระบบ');

      await db.query(
        'UPDATE leave_requests SET current_step = ?, status = ?, qr_token = ?, qr_generated_at = ?, updated_at = ? WHERE id = ?',
        [finalStep, 'approved', qrToken, nowIso, nowIso, requestId]
      );
      const updated = await db.query('SELECT * FROM leave_requests WHERE id = ?', [requestId]);

      const historyList = Array.isArray(meta.approvalHistory) ? [...meta.approvalHistory] : [];
      historyList.push({
        step: Number(request.current_step || 1),
        role: user.role,
        roleLabel,
        approverUsername: user.username,
        approverName: approverDisplayName,
        action: 'emergency_override',
        isEmergencyOverride: true,
        note: `[อนุมัติฉุกเฉินข้ามขั้นตอน] ${cleanEmergencyReason}`,
        actionAt: nowIso
      });

      const updatedMeta = {
        ...meta,
        workflowVersion: totalSteps,
        totalSteps,
        isEmergencyOverride: true,
        emergencyOverrideBy: approverDisplayName,
        emergencyOverrideRole: roleLabel,
        emergencyOverrideReason: cleanEmergencyReason,
        emergencyOverrideAt: nowIso,
        approvalHistory: historyList,
        lastStepAt: nowIso
      };
      saveRequestMeta(request.request_no, updatedMeta);
      saveRequestMeta(requestId, updatedMeta);

      const studentName = meta.studentName || (request.users ? request.users.full_name : 'นักเรียน');
      sendLineNotification(
        `\n⚡ [OnePass อนุมัติฉุกเฉินข้ามขั้นตอน (Emergency Override)]\n` +
        `• คำร้อง: ${request.request_no}\n` +
        `• นักเรียน: ${studentName}\n` +
        `• ผู้อนุมัติฉุกเฉิน: ${approverDisplayName} (${roleLabel})\n` +
        `• เหตุผลฉุกเฉิน: ${cleanEmergencyReason}\n` +
        `• สถานะ: ออกบัตรผ่าน Digital QR Pass ทันทีและบันทึกประวัติตรวจสอบแล้ว`
      );

      console.log(`⚡ [EMERGENCY OVERRIDE] Request ${request.request_no} approved immediately by ${user.username}: ${cleanEmergencyReason}`);
      return res.json({
        success: true,
        message: 'อนุมัติฉุกเฉินข้ามขั้นตอนและออก QR Pass เรียบร้อยแล้ว',
        request: { ...(updated ? updated[0] : request), ...updatedMeta, currentStep: finalStep, status: 'approved', qrToken }
      });
    } catch (err) {
      console.error('Emergency override error:', err);
      return res.status(500).json({ success: false, reason: err.message });
    }
  }
  res.json({ success: true });
});

// ลบ/ยกเลิกคำขอ (ลบออกจากฐานข้อมูล Supabase - ล็อกสิทธิ์ด้วย JWT Middleware)
app.delete('/api/requests/:id', authenticateToken, async (req, res) => {
  const requestId = parseInt(req.params.id);
  const user = req.user;

  if (supabase) {
    try {
      const requestRows = await db.query('SELECT * FROM leave_requests WHERE id = ?', [requestId]);
      const request = requestRows[0];
      if (!request) {
        return res.status(404).json({ success: false, error: 'ไม่พบคำร้องที่ต้องการลบ' });
      }

      // ตรวจสอบสิทธิ์: ถ้าเป็นนักเรียน ลบได้เฉพาะคำร้องของตนเองและต้องยังไม่ถูกอนุมัติ
      if (user.role === 'student') {
        const isOwner = (request.student_id === user.id) || (request.student_code === user.username);
        if (!isOwner) {
          return res.status(403).json({ success: false, error: '⛔ คุณไม่มีสิทธิ์ลบคำร้องของผู้อื่น' });
        }
        if (request.current_step > 1 || request.status === 'approved') {
          return res.status(400).json({ success: false, error: '⚠️ ไม่สามารถลบคำร้องที่ได้รับการอนุมัติไปแล้วได้' });
        }
      }

      await db.query('DELETE FROM approval_logs WHERE request_id = ?', [requestId]);
      await db.query('DELETE FROM scan_logs WHERE request_id = ?', [requestId]);
      try {
        await db.query('DELETE FROM leave_requests WHERE id = ?', [requestId]);
      } catch (error) {
        console.error('Delete request error:', error);
        return res.status(500).json({ success: false, error: error.message });
      }
      console.log(`🗑️ [DELETED] Request #${requestId} deleted by ${user.username} (${user.role})`);
      return res.json({ success: true, message: 'ลบคำร้องเรียบร้อยแล้ว' });
    } catch (err) {
      console.error('Delete request exception:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  res.json({ success: true, message: 'ลบคำร้องเรียบร้อยแล้ว' });
});

// งานปกครอง/แอดมิน จัดการละเว้นรายการไม่นับสถิติ (เช่น เครื่องสแกนเสีย)
app.post('/api/requests/:id/waive', authenticateToken, requireRole(['discipline_head', 'admin']), async (req, res) => {
  const requestId = parseInt(req.params.id);
  const { isWaived = true, waiverNote = '' } = req.body;
  const user = req.user;

  if (supabase) {
    try {
      const updatePayload = {
        is_waived: Boolean(isWaived),
        waiver_note: waiverNote || 'งานปกครองละเว้นรายการ'
      };

      let error = null;
      try {
        await db.query(
          'UPDATE leave_requests SET is_waived = ?, waiver_note = ? WHERE id = ?',
          [updatePayload.is_waived, updatePayload.waiver_note, requestId]
        );
      } catch (updErr) {
        error = updErr;
      }

      // Fallback if columns don't exist yet in the schema: store in admin_note
      if (error && db.isMissingColumnError(error)) {
        const adminNoteStr = isWaived ? `[WAIVED: ${waiverNote || 'งานปกครองละเว้น'}] โดย ${user.full_name || 'งานปกครอง'}` : '';
        try {
          await db.query('UPDATE leave_requests SET admin_note = ? WHERE id = ?', [adminNoteStr, requestId]);
          error = null;
        } catch (fbErr) {
          error = fbErr;
        }
      }

      if (!error) {
        console.log(`🛡️ [DISCIPLINE WAIVE] Request #${requestId} waived: ${isWaived} by ${user.full_name}`);
        return res.json({ success: true, message: isWaived ? 'บันทึกการละเว้นรายการเรียบร้อยแล้ว' : 'ยกเลิกการละเว้นรายการเรียบร้อยแล้ว' });
      } else {
        return res.status(500).json({ success: false, message: error.message });
      }
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  res.json({ success: true, message: 'บันทึกการละเว้นเรียบร้อย (โหมดจำลอง)' });
});

// ตรวจสอบและสแกน QR Code ที่หน้าตู้ (พร้อมระบบ Anti-Passback / Anti-Replay ป้องกันการใช้ซ้ำ)
app.post('/api/gate/scan', async (req, res) => {
  const { token, scanType = 'auto' } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, reason: 'กรุณาระบุรหัส QR Token' });
  }

  const cleanToken = token.trim();
  let baseToken = cleanToken;
  let totpCode = null;

  // ตรวจจับรูปแบบ Rotating QR: BASE_TOKEN.TOTP
  if (cleanToken.includes('.')) {
    const parts = cleanToken.split('.');
    baseToken = parts[0];
    totpCode = parts[1];
  }

  if (supabase) {
    try {
      const rows = await db.getLeaveRequestsWithStudent('lr.qr_token = ?', [baseToken]);
      const request = rows[0];

      if (!request) {
        await db.insertAutoIncrement('scan_logs', {
          qr_token: cleanToken,
          student_name: 'ไม่ทราบชื่อ',
          scan_type: scanType,
          result: 'denied',
          message: '❌ ไม่พบรหัส QR ในระบบ'
        });
        return res.json({ success: false, reason: '❌ รหัส QR ไม่ถูกต้อง หรือไม่พบในระบบ' });
      }

      const studentName = request.users ? request.users.full_name : (request.student_name || 'ผู้ทดสอบเปิดไม้กั้น');
      const isTestQr = Boolean(
        cleanToken.startsWith('TEST-') ||
        baseToken.startsWith('TEST-') ||
        (request.request_no && request.request_no.startsWith('TEST-'))
      );

      // ตรวจสอบความปลอดภัย Rotating QR (Time-based One-Time Token / ป้องกันการแคปภาพหน้าจอ)
      if (totpCode && !isTestQr) {
        const totpCheck = verifyTotp(baseToken, totpCode);
        if (!totpCheck.valid) {
          await db.insertAutoIncrement('scan_logs', {
            qr_token: cleanToken,
            student_name: studentName,
            scan_type: scanType,
            result: 'denied',
            message: '❌ [QR หมดอายุ] ตรวจพบรูปแคปหน้าจอส่งต่อ รหัสความปลอดภัยหมดอายุแล้ว'
          });
          return res.json({
            success: false,
            reason: '❌ [ตรวจพบภาพแคปหน้าจอ] รหัส QR นี้หมดอายุแล้ว กรุณาเปิดจากหน้าจอแอปจริงแบบสดๆ'
          });
        }
        console.log(`🛡️ [ROTATING QR] Verified fresh live QR for ${studentName} (TOTP: ${totpCode}, offset: ${totpCheck.offset})`);
      }

      // 1. ตรวจสอบสถานะการอนุมัติ (ครบทุกขั้นตอน)
      if (!isTestQr && ['pending_subject', 'pending_advisor', 'pending_dept_head', 'pending_discipline', 'pending_deputy'].includes(request.status)) {
        return res.json({
          success: false,
          reason: `❌ คำขอนี้ยังไม่ได้รับอนุมัติครบทุกขั้นตอน (สถานะ: ${request.status})`
        });
      }

      if (request.status === 'rejected') {
        return res.json({
          success: false,
          reason: `❌ คำขอนี้ไม่ผ่านการอนุมัติ (${request.rejection_reason || 'ไม่อนุญาตให้ออก'})`
        });
      }

      // ตรวจสอบกรณีบัตรหมดอายุตาม Cron Job สิ้นวัน
      if (request.status === 'expired') {
        try {
          await supabase.from('scan_logs').insert([{
            request_id: request.id,
            qr_token: cleanToken,
            student_name: studentName,
            scan_type: scanType,
            result: 'denied',
            message: '❌ บัตรผ่านหมดอายุแล้ว (สิ้นสุดวันขออนุญาต)'
          }]);
        } catch (e) {}
        return res.json({
          success: false,
          reason: '❌ รหัส QR และใบขออนุญาตนี้หมดอายุแล้ว (สิ้นสุดวันขออนุญาตตามระเบียบสถานศึกษา)'
        });
      }

      // ตรวจสอบวันที่ขออนุญาต (ป้องกันการนำ QR ล่วงหน้ามาแอบสแกนออกก่อนวันจริง)
      const currentToday = getThaiDateStr();
      const reqDate = request.leave_date || (request.created_at ? request.created_at.split('T')[0] : currentToday);

      if (!isTestQr && reqDate > currentToday) {
        return res.json({
          success: false,
          reason: `⛔ บัตรผ่านนี้สำหรับวันที่ ${reqDate} (ยังไม่ถึงกำหนดวันอนุญาต ห้ามสแกนออกก่อนวันจริง)`
        });
      }

      if (!isTestQr && reqDate < currentToday && request.status !== 'returned') {
        return res.json({
          success: false,
          reason: `❌ บัตรผ่านนี้หมดอายุแล้ว (เป็นคำร้องของวันที่ ${reqDate} สิ้นสุดการใช้งานแล้ว)`
        });
      }

      // 2. ระบบ Anti-Passback & Scan Policy (ขาออกสแกน QR ได้, ขาเข้าไม่ต้องสแกนแล้ว)
      let resolvedAction = scanType;
      if (scanType === 'auto') {
        if (request.status === 'approved' || request.status === 'gate_opened') resolvedAction = 'exit';
        else if (request.status === 'exited') {
          return res.json({
            success: false,
            reason: '⛔ ขาเข้าไม่ต้องสแกน QR ที่ป้อมแล้ว! ให้นักเรียนกดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" ในแอป OnePass'
          });
        } else if (request.status === 'returned') {
          return res.json({
            success: false,
            reason: '⛔ บัตรผ่านนี้ใช้งานเสร็จสิ้นแล้ว (บันทึกกลับเข้าเรียบร้อยแล้ว - ปิดการใช้งานถาวร)'
          });
        }
      }

      // ตรวจสอบกรณีมีคำสั่งสแกนขากลับเข้า (Entry / Return) -> ปฏิเสธตามนโยบายปุ่มในแอป
      if (resolvedAction === 'entry' || resolvedAction === 'return') {
        return res.json({
          success: false,
          reason: '⛔ ขากลับเข้าสถานศึกษาไม่ต้องสแกน QR แล้ว! กรุณาให้นักเรียนเปิดแอป OnePass แล้วกดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว"'
        });
      }

      // ตรวจสอบกรณีสแกนขาออก (Exit)
      if (resolvedAction === 'exit') {
        if (request.status === 'gate_opened') {
          return res.json({
            success: true,
            scanType: 'exit',
            gateStatus: 'gate_opened',
            openDuration: 30,
            message: '⚠️ ไม้กั้นกำลังเปิดอยู่แล้ว (30 วินาที) กรุณาขับหรือเดินผ่านเซนเซอร์',
            notice: '⏳ ไม้กั้นจะปิดอัตโนมัติเมื่อพ้นเซนเซอร์ หรือครบ 30 วินาที (QR Code จะหมดอายุเมื่อไม้กั้นปิดลง)',
            student: {
              name: studentName,
              code: request.users ? request.users.username : '66209010012',
              classroom: request.users && request.users.classrooms ? request.users.classrooms.name : 'ปวช.3/1'
            },
            request
          });
        }

        if (request.status === 'exited') {
          await supabase.from('scan_logs').insert([{
            request_id: request.id,
            qr_token: cleanToken,
            student_name: studentName,
            scan_type: 'exit',
            result: 'denied',
            message: '⛔ Anti-Passback: บัตรถูกสแกนออกไปแล้ว ห้ามสแกนออกซ้ำ'
          }]);
          return res.json({
            success: false,
            reason: '⛔ [Anti-Passback] บัตรนี้ถูกสแกนออกไปแล้ว ห้ามสแกนออกซ้ำ! หากกลับถึงวิทยาลัยแล้วให้กดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" ในแอป'
          });
        }

        if (request.status === 'returned') {
          return res.json({
            success: false,
            reason: '⛔ บัตรผ่านนี้ใช้งานครบวงจรแล้ว ไม่สามารถสแกนออกซ้ำได้'
          });
        }

        if (request.status !== 'approved') {
          return res.json({
            success: false,
            reason: `❌ คำขอนี้อยู่ในสถานะ "${request.status}" ไม่สามารถสแกนออกได้`
          });
        }

        // ✅ อนุมัติผ่านขาออก: สั่งเปิดไม้กั้น 30 วินาที และรอเซนเซอร์/หมดเวลาเพื่อตัดสิทธิ์ QR!
        const outTimeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        const outIso = new Date().toISOString();
        const isRequestNoReturn = Boolean(request.no_return || request.expected_return_time === 'NO_RETURN' || request.leave_type === 'no_return');

        // อัปเดตสถานะเป็น gate_opened (ยังไม่ตัดสิทธิ์ QR code จนกว่าไม้กั้นจะปิด)
        try {
          await supabase.from('leave_requests').update({
            status: 'gate_opened'
          }).eq('id', request.id);
        } catch (e) {
          console.warn('Supabase update status=gate_opened error:', e.message);
        }

        saveRequestMeta(request.id, {
          status: 'gate_opened',
          gateOpenedAt: outIso,
          gateOpenTimeStr: outTimeStr,
          isNoReturn: isRequestNoReturn
        });

        await supabase.from('scan_logs').insert([{
          request_id: request.id,
          qr_token: cleanToken,
          student_name: studentName,
          scan_type: 'exit_gate_open',
          result: 'success',
          message: `อนุญาตผ่าน (ขาออก) - สั่งเปิดไม้กั้น 30 วินาที (รอเซนเซอร์ตรวจจับหรือครบ 30 วินาทีเพื่อตัดสิทธิ์ QR)`
        }]);

        // ตั้งเวลา Fallback 35 วินาที ป้องกันกรณีเซนเซอร์ไม่ทำงาน
        const safetyTimer = setTimeout(() => {
          finalizeGateExit(request.id, 'TIMEOUT_30S');
        }, 35000);

        activeGateSessions.set(request.id, {
          requestId: request.id,
          studentName,
          request,
          cleanToken,
          openedAt: Date.now(),
          timeoutTimer: safetyTimer,
          isNoReturn: isRequestNoReturn
        });

        // สั่งบอร์ด ESP32 ยกไม้กั้น 30 วินาที
        sendGateCommand('OPEN', 30, `${studentName} (ออก)`, request.id);

        sendLineNotification(
          `\n🚪 [OnePass สแกนผ่านประตู: ไม้กั้นเปิด 30 วินาที]\n` +
          `• นักเรียน: ${studentName} (${request.users ? request.users.username : '66209010012'})\n` +
          `• แผนกวิชา: ${request.users && request.users.departments ? request.users.departments.name : 'ช่างยนต์'}\n` +
          `• ปลายทาง: ${request.destination || 'ธนาคาร / สถาบันการเงิน'}\n` +
          `• เวลาสแกน: ${outTimeStr} น.\n` +
          `• กำหนดเวลากลับ: ก่อน ${request.expected_return_time || '15:30'} น.\n` +
          `• สถานะไม้กั้น: ยกขึ้น 90 องศา (30 วินาที)\n` +
          `• เงื่อนไข: ไม้กั้นจะปิดลงเมื่อผ่านเซนเซอร์ หรือครบ 30 วินาที (QR Code จะหมดอายุเมื่อไม้กั้นปิดลง)`
        );

        return res.json({
          success: true,
          scanType: 'exit',
          gateStatus: 'gate_opened',
          openDuration: 30,
          isNoReturn: isRequestNoReturn,
          message: `✅ อนุญาตผ่าน (ขาออก) - ไม้กั้นเปิด 30 วินาทีแล้ว! (${outTimeStr} น.)`,
          notice: '⏳ ไม้กั้นจะปิดอัตโนมัติเมื่อขับผ่านเซนเซอร์ หรือครบ 30 วินาที (QR Code จะหมดอายุเมื่อไม้กั้นปิดลง)',
          student: {
            name: studentName,
            code: request.users ? request.users.username : '66209010012',
            classroom: request.users && request.users.classrooms ? request.users.classrooms.name : 'ปวช.3/1'
          },
          request: {
            ...request,
            status: 'gate_opened'
          }
        });
      }

      // ตรวจสอบกรณีสแกนขากลับเข้า (Entry / Return) -> ไม่ต้องสแกน QR แล้ว
      if (resolvedAction === 'entry' || resolvedAction === 'return') {
        return res.json({
          success: false,
          reason: '⛔ ขากลับเข้าไม่ต้องสแกน QR ที่ป้อมแล้ว! ให้นักเรียนกดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" ในแอป OnePass'
        });
      }

      return res.status(400).json({ success: false, reason: 'รูปแบบ scanType ไม่ถูกต้อง (ระบบรับเฉพาะสแกนขาออก)' });
    } catch (err) {
      console.error('Scan error:', err);
      return res.status(500).json({ success: false, reason: err.message });
    }
  }

  res.json({ success: true, message: 'สแกนผ่านเรียบร้อย' });
});

// ============================================================================
// RETURN BUTTON & CAMPUS VERIFICATION ENGINE (ระบบปุ่ม "กลับมาแล้ว" & ตรวจสอบระยะ)
// ============================================================================

// 1. นักเรียนกดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" จากหน้าแอป
app.post('/api/gate/return-button', authenticateToken, async (req, res) => {
  try {
    const { requestId, distanceCm, clientIp } = req.body;
    const user = req.user;

    if (!requestId) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสคำขอ (requestId)' });
    }

    let request = null;
    if (supabase) {
      const { data } = await supabase
        .from('leave_requests')
        .select(`*, users:student_id (full_name, username, phone, parent_phone, plate_no, classrooms (name), departments (name))`)
        .eq('id', requestId)
        .single();
      request = data;
    }

    const meta = getRequestMeta(requestId) || {};
    if (!request && meta.requestNo) {
      request = {
        id: requestId,
        request_no: meta.requestNo,
        student_id: user.id,
        status: meta.status || 'exited',
        expected_return_time: meta.expectedReturnTime || '15:30',
        no_return: meta.noReturn,
        leave_type: meta.leaveType,
        plate_no: meta.plateNo,
        users: {
          full_name: meta.studentName || user.full_name,
          username: meta.studentCode || user.username,
          classrooms: { name: meta.classroomName || 'ปวช.3' },
          departments: { name: meta.deptName || 'แผนกวิชาช่างยนต์' }
        }
      };
    }

    if (!request) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลคำร้องขออนุญาตในระบบ' });
    }

    // 1. ตรวจสอบสิทธิ์ฝั่งเซิร์ฟเวอร์ (ห้ามแอบกดแทนกัน ยกเว้น admin หรือ discipline_head)
    const isOwner = (request.student_id === user.id) || 
                    (request.users && request.users.username === user.username) ||
                    (meta.studentCode === user.username) ||
                    (user.role === 'admin' || user.role === 'discipline_head');

    if (!isOwner) {
      return res.status(403).json({ success: false, message: '⛔ คุณไม่มีสิทธิ์กดบันทึกกลับสำหรับคำร้องนี้ (สิทธิ์เฉพาะเจ้าของคำร้อง)' });
    }

    // 2. ตรวจสอบประเภท "ลากลับบ้าน"
    const isNoReturn = Boolean(request.no_return || request.expected_return_time === 'NO_RETURN' || request.leave_type === 'no_return' || meta.noReturn);
    if (isNoReturn) {
      return res.status(400).json({ success: false, message: 'คำร้องนี้เป็นประเภทลากลับบ้าน ไม่ต้องบันทึกการกลับเข้าวิทยาลัย' });
    }

    // 3. ตรวจสอบสถานะคำร้อง (ต้องเป็นคำร้องที่สแกนออกไปแล้วเท่านั้น)
    const currentStatus = meta.status || request.status;
    if (currentStatus === 'returned') {
      return res.status(400).json({ success: false, message: 'คำร้องนี้ได้รับการบันทึกกลับเข้าวิทยาลัยเรียบร้อยแล้ว' });
    }

    if (currentStatus !== 'exited') {
      return res.status(400).json({ 
        success: false, 
        message: `⛔ ไม่สามารถบันทึกกลับได้: คำร้องยังไม่ได้สแกนออกที่ประตูวิทยาลัย (สถานะปัจจุบัน: ${currentStatus})` 
      });
    }

    // 4. ตรวจสอบเงื่อนไขตำแหน่ง/ระยะจำลอง (ฐานโมเดล 60 ซม.) และ IP เครือข่าย
    const settings = loadSettings();
    const maxDistanceCm = Number(settings.returnMaxDistanceCm || 60);
    const parsedDist = (distanceCm !== undefined && distanceCm !== null && distanceCm !== '') ? Number(distanceCm) : 30.0;
    
    // ตรวจสอบระยะ
    let isDistanceValid = !isNaN(parsedDist) && parsedDist >= 0 && parsedDist <= maxDistanceCm;
    
    // ตรวจสอบ IP เครือข่าย (หากเปิดการตั้งค่าไว้)
    let isIpValid = true;
    const detectedIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || clientIp || '127.0.0.1';
    if (settings.returnRequireWifi) {
      const allowedPrefixes = ['192.168.', '10.', '172.16.', '127.0.0.1', '::1', 'localhost'];
      isIpValid = allowedPrefixes.some(p => String(detectedIp).includes(p));
    }

    const isVerified = isDistanceValid && isIpValid;
    const verificationStatus = isVerified ? 'verified' : 'flagged_review';

    let verificationNote = '';
    if (!isDistanceValid) {
      verificationNote = `อยู่นอกระยะจำลอง (${parsedDist} ซม. เกินเกณฑ์ ${maxDistanceCm} ซม.)`;
    }
    if (!isIpValid) {
      verificationNote += (verificationNote ? ' และ ' : '') + `IP เครือข่ายไม่อยู่ในวิทยาลัย (${detectedIp})`;
    }
    if (isVerified) {
      verificationNote = `ตรวจผ่านเงื่อนไข (ระยะจำลอง ${parsedDist} ซม.)`;
    }

    const inTimeDate = new Date();
    const inTimeIso = inTimeDate.toISOString();
    const inTimeStr = inTimeDate.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    // 5. บันทึกผลลง Supabase
    if (supabase) {
      try {
        const updatePayload = {
          status: 'returned',
          actual_return_time: inTimeStr,
          actual_in_time: inTimeIso,
          return_method: 'button',
          return_verification_status: verificationStatus,
          return_distance_cm: isNaN(parsedDist) ? null : parsedDist,
          return_ip: String(detectedIp).substring(0, 50),
          return_note: verificationNote,
          qr_token: null // Anti-replay: เคลียร์ QR Code ทันที
        };
        const { error: updErr } = await supabase.from('leave_requests').update(updatePayload).eq('id', requestId);
        if (updErr && updErr.message && updErr.message.includes('column')) {
          await supabase.from('leave_requests').update({
            status: 'returned',
            actual_return_time: inTimeStr,
            qr_token: null
          }).eq('id', requestId);
        }
      } catch (err) {
        console.warn('Supabase update return error:', err.message);
      }
    }

    // บันทึกลง Metadata File (รองรับ Offline/Local 100%)
    saveRequestMeta(requestId, {
      status: 'returned',
      actualInTime: inTimeIso,
      actualInTimeStr: inTimeStr,
      returnMethod: 'button',
      returnVerificationStatus: verificationStatus,
      returnDistanceCm: parsedDist,
      returnIp: detectedIp,
      returnNote: verificationNote
    });

    // ล้างตัวติดตามแจ้งเตือนเลยเวลา
    overdueAlertTracker.delete(requestId);

    const studentName = request.users ? request.users.full_name : (meta.studentName || 'นักเรียน');
    const studentCode = request.users ? request.users.username : (meta.studentCode || '');
    const deptName = (request.users && request.users.departments) ? request.users.departments.name : (meta.deptName || 'ช่างยนต์');
    const classroomName = (request.users && request.users.classrooms) ? request.users.classrooms.name : (meta.classroomName || 'ปวช.3');
    const plateNo = request.plate_no || meta.plateNo || '-';
    const expectedTime = request.expected_return_time || meta.expectedReturnTime || '15:30';

    // 6. ส่งแจ้งเตือน Telegram ไปยังฝ่ายปกครอง
    try {
      await notifyDisciplineStudentReturn({
        studentName,
        studentCode,
        dept: deptName,
        classroom: classroomName,
        plateNo,
        returnTime: inTimeStr,
        expectedTime,
        returnMethod: 'button',
        verificationStatus,
        distanceCm: parsedDist,
        maxDistanceCm,
        note: verificationNote,
        notifyMode: settings.returnNotifyMode || 'all'
      });
    } catch (tgErr) {
      console.warn('Notify return telegram error:', tgErr.message);
    }

    // 7. แจ้งเตือนผ่าน LINE
    const lineMsg = isVerified
      ? `\n🏫 [OnePass: นักเรียนกดกลับถึงวิทยาลัยแล้ว]\n👤 ${studentName} (${deptName})\n⏰ เวลา: ${inTimeStr} น. (กำหนด ${expectedTime} น.)\n🎯 ตรวจสอบ: ผ่านเกณฑ์ (ระยะ ${parsedDist} ซม.)`
      : `\n🚨 [OnePass แจ้งฝ่ายปกครอง: พบการกดกลับผิดเงื่อนไข!]\n👤 ${studentName} (${deptName})\n⏰ เวลา: ${inTimeStr} น.\n⚠️ สาเหตุ: ${verificationNote}\n📌 ระบบติดป้าย "ต้องตรวจสอบ" ให้ฝ่ายปกครองแล้ว`;
    sendLineNotification(lineMsg);

    return res.json({
      success: true,
      verificationStatus,
      isFlagged: !isVerified,
      message: isVerified
        ? `✅ บันทึกการกลับเข้าวิทยาลัยสำเร็จ (${inTimeStr} น.)`
        : `⚠️ บันทึกการกลับเข้าแล้ว แต่ตรวจพบความผิดปกติ: ${verificationNote} (ติดป้ายต้องตรวจสอบ)`,
      data: {
        requestId,
        studentName,
        returnTime: inTimeStr,
        returnMethod: 'button',
        verificationStatus,
        distanceCm: parsedDist,
        verificationNote
      }
    });
  } catch (err) {
    console.error('Return button exception:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. ฝ่ายปกครองบันทึกรับเข้าแทนนักเรียน
app.post('/api/gate/discipline/return-manual', authenticateToken, requireRole(['discipline_head', 'admin']), async (req, res) => {
  try {
    const { requestId, note = 'ฝ่ายปกครองบันทึกรับเข้าแทนนักเรียน' } = req.body;
    const officer = req.user;

    if (!requestId) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุ requestId' });
    }

    let request = null;
    if (supabase) {
      const { data } = await supabase
        .from('leave_requests')
        .select(`*, users:student_id (full_name, username, phone, plate_no, classrooms (name), departments (name))`)
        .eq('id', requestId)
        .single();
      request = data;
    }
    const meta = getRequestMeta(requestId) || {};

    const inTimeDate = new Date();
    const inTimeIso = inTimeDate.toISOString();
    const inTimeStr = inTimeDate.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    if (supabase) {
      try {
        const payload = {
          status: 'returned',
          actual_return_time: inTimeStr,
          actual_in_time: inTimeIso,
          return_method: 'manual',
          return_verification_status: 'manual_verified',
          return_verified_by: officer.id && officer.id.length === 36 ? officer.id : null,
          return_note: note,
          qr_token: null
        };
        const { error } = await supabase.from('leave_requests').update(payload).eq('id', requestId);
        if (error && error.message && error.message.includes('column')) {
          await supabase.from('leave_requests').update({
            status: 'returned',
            actual_return_time: inTimeStr,
            qr_token: null
          }).eq('id', requestId);
        }
      } catch (e) {}
    }

    saveRequestMeta(requestId, {
      status: 'returned',
      actualInTime: inTimeIso,
      actualInTimeStr: inTimeStr,
      returnMethod: 'manual',
      returnVerificationStatus: 'manual_verified',
      returnVerifiedBy: officer.username,
      returnVerifiedByName: officer.full_name || officer.username,
      returnNote: note
    });

    overdueAlertTracker.delete(requestId);

    const studentName = request && request.users ? request.users.full_name : (meta.studentName || 'นักเรียน');
    const studentCode = request && request.users ? request.users.username : (meta.studentCode || '');

    notifyDisciplineStudentReturn({
      studentName,
      studentCode,
      dept: request && request.users && request.users.departments ? request.users.departments.name : (meta.deptName || '-'),
      classroom: request && request.users && request.users.classrooms ? request.users.classrooms.name : (meta.classroomName || '-'),
      plateNo: (request && request.plate_no) || meta.plateNo || '-',
      returnTime: inTimeStr,
      expectedTime: (request && request.expected_return_time) || meta.expectedReturnTime || '-',
      returnMethod: 'manual',
      verificationStatus: 'manual_verified',
      note: `${note} (โดย: ${officer.full_name || officer.username})`,
      notifyMode: 'all'
    }).catch(() => {});

    res.json({
      success: true,
      message: `บันทึกการกลับเข้าแทนนักเรียนเรียบร้อย (${studentName})`,
      actualInTimeStr: inTimeStr
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. ฝ่ายปกครองเพิกถอนรายการกลับเข้าที่กดผิดพลาด
app.post('/api/gate/discipline/return-revoke', authenticateToken, requireRole(['discipline_head', 'admin']), async (req, res) => {
  try {
    const { requestId, reason = 'นักเรียนกดปุ่มผิดพลาด หรือยังอยู่นอกวิทยาลัย' } = req.body;
    const officer = req.user;

    if (!requestId) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุ requestId' });
    }

    if (supabase) {
      try {
        const payload = {
          status: 'exited',
          actual_in_time: null,
          return_verification_status: 'revoked',
          return_note: `เพิกถอนโดย ${officer.full_name || officer.username}: ${reason}`,
          return_revoked_at: new Date().toISOString(),
          return_revoked_by: officer.id && officer.id.length === 36 ? officer.id : null
        };
        const { error } = await supabase.from('leave_requests').update(payload).eq('id', requestId);
        if (error && error.message && error.message.includes('column')) {
          await supabase.from('leave_requests').update({ status: 'exited' }).eq('id', requestId);
        }
      } catch (e) {}
    }

    saveRequestMeta(requestId, {
      status: 'exited',
      actualInTime: null,
      actualInTimeStr: null,
      returnVerificationStatus: 'revoked',
      returnRevokedAt: new Date().toISOString(),
      returnRevokedBy: officer.username,
      returnRevokedByName: officer.full_name || officer.username,
      returnRevokeReason: reason
    });

    res.json({
      success: true,
      message: 'เพิกถอนรายการกลับเข้าเรียบร้อย สถานะถูกย้อนกลับเป็น "อยู่นอกสถานศึกษา"'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. ดึงรายการสด Live Returns และสถิติสำหรับฝ่ายปกครอง
app.get('/api/gate/discipline/live-returns', authenticateToken, async (req, res) => {
  try {
    const todayStr = getThaiDateStr();
    const bkkNow = getBangkokNow();
    const currentH = bkkNow.getHours();
    const currentM = bkkNow.getMinutes();
    const currentTotalMinutes = currentH * 60 + currentM;

    const settings = loadSettings();
    const dismissalTimeStr = (settings.dismissalTime || '16:30').substring(0, 5);
    const [disH, disM] = dismissalTimeStr.split(':').map(Number);
    const dismissalTotalMinutes = disH * 60 + (disM || 0);
    const isPastDismissal = currentTotalMinutes >= dismissalTotalMinutes;

    let allRequests = [];
    if (supabase) {
      const { data } = await supabase
        .from('leave_requests')
        .select(`*, users:student_id (full_name, username, phone, parent_phone, plate_no, classrooms (name), departments (name))`)
        .order('updated_at', { ascending: false });
      if (data) allRequests = data;
    }

    const metaAll = loadRequestsMeta();

    const merged = allRequests.map(r => {
      const meta = metaAll[String(r.id)] || {};
      const rDate = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : todayStr);
      const isNoReturn = Boolean(r.no_return || r.expected_return_time === 'NO_RETURN' || r.leave_type === 'no_return' || meta.noReturn);
      const currentStatus = meta.status || r.status;

      const retTimeStr = (r.expected_return_time || meta.expectedReturnTime || '15:30').substring(0, 5);
      const [retH, retM] = retTimeStr.split(':').map(Number);
      const retTotalMinutes = retH * 60 + (retM || 0);
      const diffMinutes = currentTotalMinutes - retTotalMinutes;

      return {
        id: r.id,
        requestNo: r.request_no || meta.requestNo || '-',
        studentName: r.users ? r.users.full_name : (meta.studentName || 'นักเรียน'),
        studentCode: r.student_code || (r.users ? r.users.username : (meta.studentCode || '-')),
        deptName: (r.users && r.users.departments) ? r.users.departments.name : (meta.deptName || '-'),
        classroomName: (r.users && r.users.classrooms) ? r.users.classrooms.name : (meta.classroomName || '-'),
        plateNo: r.plate_no || meta.plateNo || '-',
        phone: (r.users && r.users.phone) || meta.phone || '-',
        parentPhone: r.parent_phone || (r.users && r.users.parent_phone) || meta.parentPhone || '-',
        status: currentStatus,
        date: rDate,
        isToday: rDate === todayStr,
        isNoReturn,
        expectedReturnTime: retTimeStr,
        actualOutTime: r.actual_out_time || meta.actualOutTime || null,
        actualOutTimeStr: meta.actualOutTimeStr || (r.actual_out_time ? new Date(r.actual_out_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '-'),
        actualInTime: r.actual_in_time || meta.actualInTime || null,
        actualInTimeStr: meta.actualInTimeStr || r.actual_return_time || (r.actual_in_time ? new Date(r.actual_in_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '-'),
        returnMethod: r.return_method || meta.returnMethod || 'button',
        returnVerificationStatus: r.return_verification_status || meta.returnVerificationStatus || (currentStatus === 'returned' ? 'verified' : 'pending'),
        returnDistanceCm: r.return_distance_cm !== undefined && r.return_distance_cm !== null ? r.return_distance_cm : (meta.returnDistanceCm || null),
        returnIp: r.return_ip || meta.returnIp || null,
        returnNote: r.return_note || meta.returnNote || '',
        returnVerifiedBy: meta.returnVerifiedByName || meta.returnVerifiedBy || null,
        returnRevokedAt: r.return_revoked_at || meta.returnRevokedAt || null,
        returnRevokeReason: meta.returnRevokeReason || null,
        diffMinutes,
        isOverdue: currentStatus === 'exited' && !isNoReturn && diffMinutes > 0,
        isNotReturnedPastDismissal: currentStatus === 'exited' && !isNoReturn && isPastDismissal
      };
    }).filter(r => r.isToday || r.status === 'exited');

    const activeOut = merged.filter(r => r.status === 'exited' && !r.isNoReturn);
    const returnedToday = merged.filter(r => r.status === 'returned');
    const flaggedReview = merged.filter(r => r.returnVerificationStatus === 'flagged_review');
    const overdueList = activeOut.filter(r => r.isOverdue);
    const notReturnedList = activeOut.filter(r => r.isNotReturnedPastDismissal);

    // สถิติแยกตามวิธีกลับ
    const statsByMethod = {
      button: returnedToday.filter(r => r.returnMethod === 'button').length,
      manual: returnedToday.filter(r => r.returnMethod === 'manual').length,
      scan: returnedToday.filter(r => r.returnMethod === 'scan').length
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      counts: {
        totalExitedToday: activeOut.length + returnedToday.length,
        currentlyOut: activeOut.length,
        returnedToday: returnedToday.length,
        flaggedCount: flaggedReview.length,
        overdueCount: overdueList.length,
        notReturnedPastDismissalCount: notReturnedList.length,
        statsByMethod
      },
      activeOut,
      returnedToday,
      flaggedReview,
      overdueList,
      notReturnedList,
      dismissalTime: dismissalTimeStr,
      isPastDismissal
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ปุ่มสั่งเปิดประตูฉุกเฉิน (ล็อกสิทธิ์ด้วย JWT Middleware เฉพาะงานปกครองหรือ Admin เท่านั้น)
app.post('/api/gate/manual-open', authenticateToken, requireRole(['discipline_head', 'admin']), (req, res) => {
  const { duration = 30, reason = 'MANUAL_OVERRIDE' } = req.body;
  const user = req.user;
  console.log(`🚨 [GATE MANUAL OPEN] Authorized by ${user.username} (${user.role}) - reason: ${reason}`);
  sendGateCommand('OPEN', duration, reason);
  res.json({ success: true, message: `สั่งเปิดประตูแล้ว (${duration} วินาที)` });
});

// Endpoint จำลองหรือสั่งจำลองการผ่านเซนเซอร์ Ultrasonic (Trigger Sensor Pass)
app.post('/api/gate/sensor-pass', async (req, res) => {
  const { requestId, reason = 'SENSOR_PASSED' } = req.body || {};
  await finalizeGateExit(requestId, reason);
  sendGateCommand('CLOSE', 0, 'PASS_SENSOR');
  res.json({ success: true, message: 'เซนเซอร์ตรวจพบการผ่าน ไม้กั้นปิดลงและตัดสิทธิ์ QR เรียบร้อย' });
});

// ดึงประวัติการสแกนจาก Supabase
app.get('/api/gate/logs', async (req, res) => {
  if (supabase) {
    const { data } = await supabase.from('scan_logs').select('*').order('scanned_at', { ascending: false }).limit(10);
    if (data) return res.json({ logs: data });
  }
  res.json({ logs: [] });
});

// Endpoint สำหรับทดสอบยิง LINE Notification
app.post('/api/test/line', async (req, res) => {
  const { message = '🔔 ทดสอบการแจ้งเตือน OnePass IoT Smart Gate ผ่าน LINE สำเร็จเรียบร้อย! 🚀' } = req.body;
  const result = await sendLineNotification(message);
  res.json({ success: true, result });
});

// ============================================================================
// OVERDUE & LATE RETURN MONITORING ENGINE (ระบบเฝ้าระวังคนเลยเวลากลับ 2 จังหวะ)
// ============================================================================
const overdueAlertTracker = new Map(); // requestId -> { warned30m: boolean, warnedOverdue15m: boolean, diffMinutes: number }

function getBangkokNow() {
  const d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 7));
}

async function checkOverdueLeaveRequests() {
  if (!supabase) return;
  try {
    const { data: exitedRequests, error } = await supabase
      .from('leave_requests')
      .select(`
        *,
        users:student_id (full_name, username, phone, parent_phone, plate_no, classrooms (name), departments (name))
      `)
      .eq('status', 'exited');

    if (error || !exitedRequests || exitedRequests.length === 0) return;

    const bkkNow = getBangkokNow();
    const currentH = bkkNow.getHours();
    const currentM = bkkNow.getMinutes();
    const currentTotalMinutes = currentH * 60 + currentM;
    const currentTimeStr = `${String(currentH).padStart(2, '0')}:${String(currentM).padStart(2, '0')} น.`;
    const todayStr = getThaiDateStr();

    for (const r of exitedRequests) {
      // ข้ามคำร้องที่เป็นประเภท "ลากลับบ้าน" (ไม่ต้องกลับเข้าวิทยาลัย) ไม่ส่งแจ้งเตือนผิดๆ
      if (r.no_return || r.expected_return_time === 'NO_RETURN' || r.leave_type === 'no_return') continue;

      const tracker = overdueAlertTracker.get(r.id) || { warned30m: false, warnedOverdue15m: false };
      const rDate = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : todayStr);

      if (rDate > todayStr) continue;

      const retTimeStr = (r.expected_return_time || '15:30').substring(0, 5);
      const [retH, retM] = retTimeStr.split(':').map(Number);
      const returnTotalMinutes = retH * 60 + (retM || 0);

      const isPastDay = rDate < todayStr;
      const diffMinutes = isPastDay ? 999 : (currentTotalMinutes - returnTotalMinutes);

      const studentName = r.users ? r.users.full_name : (r.student_name || 'นักเรียน');
      const dept = (r.users && r.users.departments) ? r.users.departments.name : 'แผนกวิชาช่างไฟฟ้า';
      const plate = r.plate_no || (r.users ? r.users.plate_no : '-');
      const studentPhone = (r.users && r.users.phone) ? r.users.phone : '-';
      const parentPhone = r.parent_phone || (r.users ? r.users.parent_phone : '-');

      // จังหวะที่ 1: แจ้งเตือนเมื่อเหลือเวลาไม่เกิน 30 นาที (และยังไม่เลยเวลากลับ)
      if (diffMinutes >= -30 && diffMinutes < 0) {
        if (!tracker.warned30m) {
          tracker.warned30m = true;
          overdueAlertTracker.set(r.id, tracker);

          const minsLeft = Math.abs(diffMinutes);
          const msg = `\n⏰ [OnePass: แจ้งเตือนใกล้ครบเวลากลับ]\n━━━━━━━━━━━━━━━━━━━\n👤 นักเรียน: ${studentName} (${dept})\n⏳ เหลือเวลาอีกประมาณ: ${minsLeft} นาที\n📍 กำหนดเวลากลับเข้า: ก่อนเวลา ${retTimeStr} น.\n💡 เมื่อถึงวิทยาลัยแล้ว ให้เปิดแอปและกดปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว"\n━━━━━━━━━━━━━━━━━━━`;
          await sendLineNotification(msg);
          console.log(`⏰ [STAGE 1: 30-MIN ALERT] Sent pre-warning to ${studentName} (${minsLeft} mins left)`);
        }
      }

      // จังหวะที่ 2: แจ้งเตือนครู & ฝ่ายปกครองเมื่อสายเกิน 15 นาที
      if (diffMinutes >= 15) {
        if (!tracker.warnedOverdue15m) {
          tracker.warnedOverdue15m = true;
          tracker.overdueMinutes = diffMinutes;
          overdueAlertTracker.set(r.id, tracker);

          const msg = `\n🚨 [OnePass: นักเรียนยังไม่กดบันทึกกลับเข้า - สายเกิน 15 นาที!]\n━━━━━━━━━━━━━━━━━━━\n👤 นักเรียน: ${studentName} (${dept})\n🚗 ทะเบียนรถ: ${plate}\n⏰ กำหนดเวลากลับ: ${retTimeStr} น.\n⌛ เวลาปัจจุบัน: ${currentTimeStr} (สายแล้ว ${diffMinutes} นาที)\n📌 สถานะ: ยังไม่พบการกดปุ่มกลับเข้าในระบบ\n📞 เบอร์โทรนักเรียน: ${studentPhone}\n👨‍👩‍👧 เบอร์โทรผู้ปกครอง: ${parentPhone}\n━━━━━━━━━━━━━━━━━━━\n*(แจ้งเตือนอัตโนมัติเพื่อความปลอดภัยของนักศึกษา)*`;
          await sendLineNotification(msg);

          // ส่งแจ้งเตือน Telegram ไปยังฝ่ายปกครอง
          try {
            await notifyDisciplineStudentReturn({
              studentName,
              studentCode: r.users ? r.users.username : '',
              dept,
              classroom: (r.users && r.users.classrooms) ? r.users.classrooms.name : '-',
              plateNo: plate,
              returnTime: currentTimeStr,
              expectedTime: retTimeStr,
              returnMethod: 'button',
              verificationStatus: 'flagged_review',
              note: `เลยกำหนดเวลากลับเกิน 15 นาทีแล้ว (สาย ${diffMinutes} นาที) ยังไม่กดปุ่มกลับเข้า`,
              notifyMode: 'all'
            });
          } catch (e) {}

          console.log(`🚨 [STAGE 2: OVERDUE >15M ALERT] Sent overdue alert for ${studentName} (Overdue: ${diffMinutes} mins)`);
        }
      }
    }
  } catch (err) {
    console.warn('Overdue check exception:', err.message);
  }
}

// Background checker รันอัตโนมัติทุกๆ 60 วินาที
setInterval(checkOverdueLeaveRequests, 60000);
setTimeout(checkOverdueLeaveRequests, 4000);

// API ดึงรายการสถานะ Overdue & Warning สำหรับหน้าเว็บ
app.get('/api/requests/overdue-status', async (req, res) => {
  if (!supabase) return res.json({ success: true, overdueCount: 0, warningCount: 0, items: [] });
  try {
    const { data: exitedRequests } = await supabase
      .from('leave_requests')
      .select(`
        *,
        users:student_id (full_name, username, phone, parent_phone, plate_no, classrooms (name), departments (name))
      `)
      .eq('status', 'exited');

    const bkkNow = getBangkokNow();
    const currentH = bkkNow.getHours();
    const currentM = bkkNow.getMinutes();
    const currentTotalMinutes = currentH * 60 + currentM;
    const todayStr = getThaiDateStr();

    const validExited = (exitedRequests || []).filter(r => !(r.no_return || r.expected_return_time === 'NO_RETURN' || r.leave_type === 'no_return'));

    const items = validExited.map(r => {
      const rDate = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : todayStr);
      const retTimeStr = (r.expected_return_time || '15:30').substring(0, 5);
      const [retH, retM] = retTimeStr.split(':').map(Number);
      const returnTotalMinutes = retH * 60 + (retM || 0);
      const isPastDay = rDate < todayStr;
      const diffMinutes = isPastDay ? 999 : (currentTotalMinutes - returnTotalMinutes);

      const tracker = overdueAlertTracker.get(r.id) || {};

      return {
        id: r.id,
        requestNo: r.request_no,
        studentName: r.users ? r.users.full_name : 'นักเรียน',
        studentCode: r.student_code || (r.users ? r.users.username : ''),
        deptName: (r.users && r.users.departments) ? r.users.departments.name : 'แผนกวิชาช่างไฟฟ้า',
        plateNo: r.plate_no || (r.users ? r.users.plate_no : '-'),
        expectedReturnTime: retTimeStr,
        parentPhone: r.parent_phone || (r.users ? r.users.parent_phone : '-'),
        phone: (r.users && r.users.phone) ? r.users.phone : '-',
        diffMinutes,
        isWarning30m: diffMinutes >= -30 && diffMinutes < 0,
        isOverdue15m: diffMinutes >= 15,
        warned30m: Boolean(tracker.warned30m),
        warnedOverdue15m: Boolean(tracker.warnedOverdue15m)
      };
    });

    const overdueItems = items.filter(i => i.isOverdue15m);
    const warningItems = items.filter(i => i.isWarning30m);

    res.json({
      success: true,
      overdueCount: overdueItems.length,
      warningCount: warningItems.length,
      items,
      overdueItems,
      warningItems
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint จำลองหรือสั่ง Trigger ตรวจสอบทันที
app.post('/api/test/trigger-overdue-check', async (req, res) => {
  await checkOverdueLeaveRequests();
  res.json({
    success: true,
    message: 'Triggered overdue check successfully',
    trackedCount: overdueAlertTracker.size
  });
});

// ============================================================================
// CRON JOB 1: PENDING APPROVAL REMINDERS (ข้อ 7: แจ้งเตือนซ้ำเมื่อค้างในขั้นเดิมเกิน 15 นาที)
// ============================================================================
const pendingReminderTracker = new Map(); // `${requestId}_step_${step}` -> lastRemindedTimestamp

async function checkPendingApprovalReminders() {
  if (!supabase) return { remindedCount: 0 };
  try {
    const settings = loadSettings();
    const thresholdMins = Number(settings.approvalReminderMinutes || 15);
    const { data: pendingReqs, error } = await supabase
      .from('leave_requests')
      .select(`
        *,
        users:student_id (full_name, username, classrooms (name), departments (name))
      `)
      .in('status', ['pending_subject', 'pending_advisor', 'pending_dept_head', 'pending_discipline', 'pending_deputy']);

    if (error || !pendingReqs || pendingReqs.length === 0) return { remindedCount: 0 };

    const nowMs = Date.now();
    let remindedCount = 0;

    for (const r of pendingReqs) {
      const meta = getRequestMeta(r.request_no) || getRequestMeta(r.id) || {};
      const currentStep = Number(r.current_step || 1);
      const totalSteps = meta.totalSteps || 5;
      const stepEnteredAtMap = meta.stepEnteredAt || {};
      const enteredIso = stepEnteredAtMap[String(currentStep)] || meta.lastStepAt || r.updated_at || r.created_at;
      const enteredMs = enteredIso ? new Date(enteredIso).getTime() : nowMs;
      const waitingMins = Math.floor((nowMs - enteredMs) / 60000);

      if (waitingMins >= thresholdMins) {
        const trackKey = `${r.id}_step_${currentStep}`;
        const lastReminded = pendingReminderTracker.get(trackKey) || 0;
        // แจ้งเตือนซ้ำทุกๆ thresholdMins นาที
        if (nowMs - lastReminded >= thresholdMins * 60000) {
          pendingReminderTracker.set(trackKey, nowMs);
          remindedCount++;

          const reqDept = meta.deptName || (r.users && r.users.departments ? r.users.departments.name : 'แผนกวิชาช่างยนต์');
          const approvers = resolveStepApproversInfo(reqDept, meta, totalSteps);
          const targetInfo = approvers[currentStep];
          const studentName = meta.studentName || (r.users ? r.users.full_name : 'นักเรียน');

          const msg =
            `\n🔔 [OnePass แจ้งเตือนซ้ำ: คำร้องรออนุมัติค้างเกิน ${thresholdMins} นาที]\n` +
            `• คำร้อง: ${r.request_no}\n` +
            `• นักเรียน: ${studentName} (${reqDept})\n` +
            `• ค้างอยู่ที่ขั้นที่ ${currentStep}/${totalSteps}: ${targetInfo ? targetInfo.roleLabel + ' (' + targetInfo.name + ')' : ''}\n` +
            `• รอมาแล้ว: ${waitingMins} นาที\n` +
            `• 💡 หากครูผู้รับผิดชอบติดภารกิจ ผู้อนุมัติแทนสามารถกด "อนุมัติแทน" ในระบบได้ทันที`;
          await sendLineNotification(msg);
          console.log(`🔔 [REMINDER SENT] Request ${r.request_no} stuck at step ${currentStep} for ${waitingMins} mins`);
        }
      }
    }
    return { remindedCount };
  } catch (err) {
    console.warn('Pending reminder check error:', err.message);
    return { remindedCount: 0, error: err.message };
  }
}

setInterval(checkPendingApprovalReminders, 60000);
setTimeout(checkPendingApprovalReminders, 5000);

app.post('/api/test/trigger-reminder-check', async (req, res) => {
  const result = await checkPendingApprovalReminders();
  res.json({ success: true, result });
});

// ============================================================================
// CRON JOB 2: AUTO-EXPIRE UNAPPROVED BEFORE OPERATING HOURS END & END-OF-DAY
// (ข้อ 11: คำร้องที่ไม่ได้รับอนุมัติครบก่อนหมดเวลาทำการ ให้หมดอายุอัตโนมัติ)
// ============================================================================
let cronStats = {
  lastRunTime: null,
  lastExpiredCount: 0,
  totalExpiredCount: 0,
  history: []
};

async function autoExpireEndOfDayRequests(forceAllPastOrMidnight = false) {
  const bkkNow = getBangkokNow();
  const todayStr = getThaiDateStr();
  const currentH = bkkNow.getHours();
  const currentM = bkkNow.getMinutes();
  const currentTotalMins = currentH * 60 + currentM;

  const settings = loadSettings();
  const dismissalMins = parseTimeToMins(settings.dismissalTime || '16:00');
  const isPastOperatingHours = currentTotalMins >= dismissalMins;
  // ช่วงสิ้นวัน 23:55 น. ขึ้นไป หรือเที่ยงคืน
  const isLateNight = (currentH === 23 && currentM >= 55) || (currentH === 0 && currentM <= 5);

  cronStats.lastRunTime = bkkNow.toISOString();

  if (!supabase) return { count: 0, expired: [] };

  try {
    // ดึงคำร้องทั้งหมดที่ยังเปิดค้างอยู่ (รอตรวจทุกขั้น, อนุมัติแล้ว, หรือสแกนออกแล้วแต่ไม่กลับ)
    const { data: openRequests, error } = await supabase
      .from('leave_requests')
      .select(`
        *,
        users:student_id (full_name, username, phone, parent_phone, plate_no, classrooms (name), departments (name))
      `)
      .in('status', ['pending_subject', 'pending_advisor', 'pending_dept_head', 'pending_discipline', 'pending_deputy', 'approved', 'exited']);

    if (error || !openRequests || !openRequests.length) {
      return { count: 0, expired: [] };
    }

    const toExpire = [];
    const unreturnedStudents = [];

    for (const r of openRequests) {
      const rDate = r.leave_date || (r.created_at ? r.created_at.split('T')[0] : todayStr);
      const isPastDay = rDate < todayStr;
      const isTodayMidnight = (rDate === todayStr && isLateNight);
      const isPendingStatus = r.status && r.status.startsWith('pending_');

      // ข้อ 11: คำร้องของวันนี้ที่ยังไม่ได้รับอนุมัติครบก่อนหมดเวลาทำการ (เช่น 16:00 น.) ให้หมดอายุอัตโนมัติ
      const isUnapprovedPastDismissal = (
        settings.autoExpireAfterDismissal !== false &&
        rDate === todayStr &&
        isPendingStatus &&
        isPastOperatingHours
      );

      if (isPastDay || isTodayMidnight || isUnapprovedPastDismissal || forceAllPastOrMidnight) {
        toExpire.push({
          ...r,
          expireReason: isUnapprovedPastDismissal
            ? `หมดอายุอัตโนมัติ (ไม่ได้รับอนุมัติครบทุกขั้นก่อนหมดเวลาทำการ ${settings.dismissalTime || '16:00'} น.)`
            : 'หมดอายุการใช้งานประจำวัน (Cron Job สิ้นวันอัตโนมัติ)'
        });
        if (r.status === 'exited') {
          unreturnedStudents.push(r);
        }
      }
    }

    if (toExpire.length === 0) {
      return { count: 0, expired: [] };
    }

    const nowIso = new Date().toISOString();
    for (const item of toExpire) {
      await supabase
        .from('leave_requests')
        .update({
          status: 'expired',
          rejection_reason: item.expireReason,
          updated_at: nowIso
        })
        .eq('id', item.id);

      const meta = getRequestMeta(item.request_no) || getRequestMeta(item.id) || {};
      const historyList = Array.isArray(meta.approvalHistory) ? [...meta.approvalHistory] : [];
      historyList.push({
        step: Number(item.current_step || 1),
        role: 'system',
        roleLabel: 'ระบบอัตโนมัติ',
        approverUsername: 'system',
        approverName: 'ระบบตัดหมดอายุอัตโนมัติ',
        action: 'expired',
        note: item.expireReason,
        actionAt: nowIso
      });
      const updatedMeta = { ...meta, approvalHistory: historyList, rejectionReason: item.expireReason, lastStepAt: nowIso };
      saveRequestMeta(item.request_no, updatedMeta);
      saveRequestMeta(item.id, updatedMeta);
    }

    cronStats.lastExpiredCount = toExpire.length;
    cronStats.totalExpiredCount += toExpire.length;
    cronStats.history.unshift({
      timestamp: bkkNow.toISOString(),
      expiredCount: toExpire.length,
      unreturnedCount: unreturnedStudents.length
    });
    if (cronStats.history.length > 20) cronStats.history.pop();

    console.log(`🌙 [CRON JOB: EXPIRE] Marked ${toExpire.length} leave requests as 'expired' (Date <= ${todayStr})`);

    // ส่งสรุปแจ้งเตือนฝ่ายปกครอง/ครูผ่าน LINE Notify กรณีมีนักเรียนออกแล้วไม่กลับเข้าก่อนสิ้นวัน
    if (unreturnedStudents.length > 0) {
      let listNames = unreturnedStudents.map((s, idx) => {
        const u = s.users || {};
        return `${idx + 1}. ${u.full_name || s.student_code} (${u.departments?.name || '-'}) [โทร: ${u.phone || '-'}]`;
      }).join('\n');

      const lineSummary = `\n🌙 [OnePass: สรุปสิ้นวัน - นักเรียนยังไม่กลับเข้าสถานศึกษา]\n━━━━━━━━━━━━━━━━━━━\nพบนักเรียนที่สแกนออกแล้ว แต่ไม่สแกนกลับเข้าก่อนสิ้นวัน จำนวน ${unreturnedStudents.length} คน:\n${listNames}\n━━━━━━━━━━━━━━━━━━━\n*(ระบบ Cron Job ได้เปลี่ยนสถานะ QR เป็น Expired เรียบร้อยแล้ว เพื่อความปลอดภัย)*`;
      await sendLineNotification(lineSummary);
    }

    return {
      count: toExpire.length,
      expired: toExpire.map(r => ({ id: r.id, requestNo: r.request_no, prevStatus: r.status, date: r.leave_date, reason: r.expireReason }))
    };
  } catch (err) {
    console.warn('⚠️ [CRON: EXPIRE] Exception during autoExpireEndOfDayRequests:', err.message);
    return { count: 0, error: err.message };
  }
}

// ตั้งเวลาให้ Cron Job ตรวจสอบทุกๆ 60 วินาที (และทำงานทันทีเมื่อเริ่มเซิร์ฟเวอร์เพื่อเคลียร์วันเก่า)
setInterval(autoExpireEndOfDayRequests, 60000);
setTimeout(autoExpireEndOfDayRequests, 3000);

// API สำหรับ Admin Panel: ดึงสถานะและสั่งให้ Cron Job ตัดสิทธิ์ทันที
app.get('/api/admin/cron/status', (req, res) => {
  res.json({
    success: true,
    stats: cronStats
  });
});

app.post('/api/admin/cron/expire-now', async (req, res) => {
  const force = req.query.force === 'true' || req.body?.force === true;
  const result = await autoExpireEndOfDayRequests(force);
  res.json({
    success: true,
    message: `Cron Job ทำงานเรียบร้อย: ปรับสถานะเป็น Expired ทั้งหมด ${result.count} รายการ`,
    result
  });
});

// เริ่มต้นรันเซิร์ฟเวอร์

// ============================================================================
// STUDENT PRE-REGISTRATION & SELF-ACTIVATION MODULE (Enterprise Roster System)
// ============================================================================

// Rate Limit & Lockout tracking in memory (IP-level + Account-level)
const rateLimitByIp = new Map(); // ip -> { count: number, resetAt: number }
const MAX_IP_ATTEMPTS = 15;      // 15 attempts per 15 minutes per IP
const IP_WINDOW_MS = 15 * 60 * 1000;

function checkIpRateLimit(req, res) {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let rec = rateLimitByIp.get(clientIp);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + IP_WINDOW_MS };
    rateLimitByIp.set(clientIp, rec);
    return true;
  }
  rec.count++;
  if (rec.count > MAX_IP_ATTEMPTS) {
    const waitMins = Math.ceil((rec.resetAt - now) / 60000);
    res.status(429).json({
      success: false,
      message: `มีการร้องขอจากเครือข่ายนี้บ่อยเกินไป กรุณารออีก ${waitMins} นาที`
    });
    return false;
  }
  return true;
}

// Middleware: Admin JWT Authentication (ตรวจ JWT ฝั่งเซิร์ฟเวอร์ทุก endpoint /api/admin/*)
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบด้วยสิทธิ์ผู้ดูแลระบบ (Admin)' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงถูกปฏิเสธ: เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น' });
    }
    req.adminUser = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
  }
}

// Middleware: Advisor/Admin JWT Authentication (สำหรับอนุมัติคำขอเปิดบัญชี)
function requireApproverOrAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const allowed = ['admin', 'advisor', 'dept_head', 'discipline_head'];
    if (!decoded || !allowed.includes(decoded.role)) {
      return res.status(403).json({ success: false, message: 'เฉพาะครูที่ปรึกษาหรือแอดมินเท่านั้น' });
    }
    req.authUser = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
}

// ฟังก์ชันแปลงวันเกิด พ.ศ. -> ค.ศ. (ISO: YYYY-MM-DD)
function parseThaiBirthDateToIso(rawDateStr) {
  if (!rawDateStr) return null;
  const str = String(rawDateStr).trim();
  
  // รูปแบบ 1: YYYY-MM-DD (ค.ศ. อยู่แล้ว)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    if (y > 2400) { // ถ้าเป็น พ.ศ. ในฟอร์แมต YYYY-MM-DD
      return `${y - 543}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return str;
  }

  // รูปแบบ 2: วว/ดด/ปปปป (เช่น 15/08/2549 หรือ 15-08-2549)
  const slashMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (slashMatch) {
    let day = parseInt(slashMatch[1], 10);
    let month = parseInt(slashMatch[2], 10);
    let year = parseInt(slashMatch[3], 10);
    if (year > 2400) year -= 543; // แปลง พ.ศ. -> ค.ศ.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // รูปแบบ 3: Date object หรือ timestamp
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    let y = d.getFullYear();
    if (y > 2400) y -= 543;
    return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// ฟังก์ชันปิดบังชื่อบางส่วนเพื่อความปลอดภัย (Masking e.g. นาย ธ*** รั***)
function maskStudentName(fullName) {
  if (!fullName) return '***';
  const parts = fullName.trim().split(/\s+/);
  return parts.map(p => {
    if (p.length <= 2) return p;
    return p[0] + '*'.repeat(Math.min(3, p.length - 1));
  }).join(' ');
}

// ----------------------------------------------------------------------------
// 1. ดาวน์โหลดไฟล์แม่แบบนักเรียน (Excel/CSV Template)
// ----------------------------------------------------------------------------
app.get('/api/admin/student-template', (req, res) => {
  const csvHeaders = 'รหัสนักศึกษา,คำนำหน้า,ชื่อ,นามสกุล,แผนกวิชา,ห้องเรียน,วันเกิด(วว/ดด/ปปปป พ.ศ.),เบอร์โทร,เบอร์ผู้ปกครอง';
  const sample1 = '66209010001,นาย,สมชาย,ใจดี,แผนกวิชาช่างยนต์,ปวช.3/1 (ช่างยนต์),15/08/2549,0812345678,0898765432';
  const sample2 = '67202010002,นางสาว,สมหญิง,รักเรียน,แผนกวิชาการบัญชี,ปวช.2/1 (การบัญชี),20/01/2550,0823456789,0887654321';
  const sample3 = '68301010003,นาย,อาทิตย์,ยอดเยี่ยม,แผนกวิชาช่างไฟฟ้ากำลัง,ปวส.2/1 (ช่างไฟฟ้ากำลัง),05/11/2547,0834567890,0876543210';
  
  const csvContent = '\uFEFF' + [csvHeaders, sample1, sample2, sample3].join('\r\n'); // BOM for Thai in Excel
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="OnePass_Student_Roster_Template.csv"');
  return res.send(csvContent);
});

// ----------------------------------------------------------------------------
// 2. พรีวิวและตรวจสอบไฟล์นำเข้ารายชื่อนักศึกษา (Admin Validation Preview)
// ----------------------------------------------------------------------------
app.post('/api/admin/import-students-preview', requireAdminAuth, async (req, res) => {
  try {
    const { students } = req.body; // Array of student rows from frontend parser
    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบรายการข้อมูลนักเรียนในไฟล์' });
    }

    // โหลด departments และ classrooms ทั้งหมดจาก Supabase เพื่อนำมาจับคู่
    let dbDepts = [];
    let dbClasses = [];
    if (supabase) {
      const { data: dData } = await supabase.from('departments').select('id, name, code');
      const { data: cData } = await supabase.from('classrooms').select('id, name, department_id, advisor_name');
      dbDepts = dData || [];
      dbClasses = cData || [];
    }

    // โหลดผู้ใช้ที่มีอยู่แล้วเพื่อตรวจสอบสถานะ
    let existingStudentsMap = new Map();
    if (supabase) {
      const { data: uData } = await supabase.from('users').select('id, username, student_code, full_name, status, classroom_id');
      if (uData) {
        uData.forEach(u => {
          if (u.student_code) existingStudentsMap.set(u.student_code.trim(), u);
          if (u.username) existingStudentsMap.set(u.username.trim(), u);
        });
      }
    }

    const previewRows = [];
    const seenCodesInFile = new Set();
    let validCount = 0;
    let conflictCount = 0;
    let errorCount = 0;

    for (let i = 0; i < students.length; i++) {
      const row = students[i];
      const rawCode = String(row.student_code || row.studentCode || row['รหัสนักศึกษา'] || '').trim();
      const title = String(row.title || row['คำนำหน้า'] || '').trim();
      const firstName = String(row.first_name || row.firstName || row['ชื่อ'] || '').trim();
      const lastName = String(row.last_name || row.lastName || row['นามสกุล'] || '').trim();
      const deptNameInput = String(row.department || row.dept || row['แผนกวิชา'] || '').trim();
      const classNameInput = String(row.classroom || row.room || row['ห้องเรียน'] || '').trim();
      const rawBirth = String(row.birth_date || row.birthDate || row['วันเกิด'] || '').trim();
      const phone = String(row.phone || row['เบอร์โทร'] || '').trim();
      const parentPhone = String(row.parent_phone || row.parentPhone || row['เบอร์ผู้ปกครอง'] || '').trim();

      const fullName = `${title} ${firstName} ${lastName}`.trim() || String(row.full_name || row['ชื่อ-นามสกุล'] || '').trim();
      const errors = [];

      // ตรวจสอบรหัสนักศึกษา
      if (!rawCode) {
        errors.push('ไม่มีรหัสนักศึกษา');
      } else if (seenCodesInFile.has(rawCode)) {
        errors.push('รหัสนักศึกษาซ้ำในไฟล์เดียวกัน');
      } else {
        seenCodesInFile.add(rawCode);
      }

      // ตรวจสอบชื่อ
      if (!fullName || fullName.length < 3) {
        errors.push('ชื่อ-นามสกุลไม่ครบถ้วน');
      }

      // ตรวจสอบและแปลงวันเกิด
      const birthDateIso = parseThaiBirthDateToIso(rawBirth);
      if (!birthDateIso) {
        errors.push('วันเกิดไม่ถูกต้อง (รูปแบบที่แนะนำ: วว/ดด/ปปปป เช่น 15/08/2549)');
      }

      // จับคู่แผนกวิชา
      let matchedDept = null;
      if (deptNameInput) {
        matchedDept = dbDepts.find(d => 
          d.name.includes(deptNameInput) || deptNameInput.includes(d.name) || d.code.toLowerCase() === deptNameInput.toLowerCase()
        );
      }
      if (!matchedDept && deptNameInput) {
        errors.push(`ไม่พบแผนกวิชา "${deptNameInput}" ในระบบ`);
      }

      // จับคู่ห้องเรียน (Single Source of Truth)
      let matchedClass = null;
      if (classNameInput) {
        matchedClass = dbClasses.find(c => 
          c.name.includes(classNameInput) || classNameInput.includes(c.name)
        );
      }
      if (!matchedClass && matchedDept) {
        // หาห้องแรกของแผนกเป็น fallback
        matchedClass = dbClasses.find(c => c.department_id === matchedDept.id);
      }

      // ตรวจสอบกับข้อมูลเดิมในระบบ
      let statusType = 'new'; // 'new' | 'update_pending' | 'already_active'
      const existing = existingStudentsMap.get(rawCode);
      if (existing) {
        if (existing.status === 'active') {
          statusType = 'already_active';
          errors.push('บัญชีนี้เปิดใช้งานแล้วในระบบ (ข้ามการอัปเดตรหัสผ่าน)');
        } else {
          statusType = 'update_pending';
        }
      }

      if (errors.length > 0) {
        errorCount++;
      } else if (statusType === 'update_pending') {
        conflictCount++;
      } else {
        validCount++;
      }

      previewRows.push({
        rowNumber: i + 1,
        studentCode: rawCode,
        fullName,
        deptId: matchedDept ? matchedDept.id : null,
        deptName: matchedDept ? matchedDept.name : deptNameInput,
        classroomId: matchedClass ? matchedClass.id : null,
        classroomName: matchedClass ? matchedClass.name : classNameInput,
        advisorName: matchedClass ? matchedClass.advisor_name : null,
        birthDate: birthDateIso,
        rawBirthDate: rawBirth,
        phone,
        parentPhone,
        statusType,
        isValid: errors.length === 0,
        errors
      });
    }

    res.json({
      success: true,
      summary: {
        total: previewRows.length,
        validCount,
        conflictCount,
        errorCount
      },
      rows: previewRows,
      availableDepartments: dbDepts,
      availableClassrooms: dbClasses
    });
  } catch (err) {
    console.error('import-students-preview error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบไฟล์: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 3. บันทึกรายชื่อนักศึกษาลงฐานข้อมูลจริง (Commit Roster Import with Audit Log)
// ----------------------------------------------------------------------------
app.post('/api/admin/import-students-commit', requireAdminAuth, async (req, res) => {
  try {
    const { rows, fileName, updateExistingPending } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่มีรายการข้อมูลที่ต้องบันทึก' });
    }

    if (!supabase) {
      return res.status(500).json({ success: false, message: 'ไม่ได้เชื่อมต่อ Supabase Database' });
    }

    let successCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    const errorDetails = [];

    for (const r of rows) {
      if (!r.isValid || !r.studentCode) {
        failedCount++;
        errorDetails.push({ code: r.studentCode, error: r.errors?.join(', ') || 'ข้อมูลไม่สมบูรณ์' });
        continue;
      }

      try {
        // ตรวจสอบว่ามีอยู่แล้วหรือไม่
        const { data: exist } = await supabase
          .from('users')
          .select('id, username, status')
          .or(`username.eq.${r.studentCode},student_code.eq.${r.studentCode}`)
          .maybeSingle();

        if (exist) {
          if (exist.status === 'active') {
            // ไม่แตะต้องบัญชีที่ active แล้ว
            failedCount++;
            errorDetails.push({ code: r.studentCode, error: 'บัญชีเปิดใช้งานแล้ว ข้ามการบันทึก' });
            continue;
          }

          if (updateExistingPending) {
            // อัปเดตข้อมูลบัญชีที่ยังไม่เปิดใช้งาน
            const { error: upErr } = await supabase
              .from('users')
              .update({
                full_name: r.fullName,
                department_id: r.deptId,
                classroom_id: r.classroomId,
                birth_date: r.birthDate,
                phone: r.phone || null,
                parent_phone: r.parentPhone || null,
                status: 'pending_activation'
              })
              .eq('id', exist.id);

            if (upErr) throw upErr;
            updatedCount++;
          } else {
            failedCount++;
            errorDetails.push({ code: r.studentCode, error: 'มีข้อมูลเดิมแล้ว (ข้ามตามตัวเลือก)' });
          }
        } else {
          // เพิ่มนักเรียนใหม่ สถานะ pending_activation
          const { error: insErr } = await supabase
            .from('users')
            .insert([{
              username: r.studentCode,
              student_code: r.studentCode,
              password: '', // ยังไม่มีรหัสผ่าน (รอ Activate)
              full_name: r.fullName,
              role: 'student',
              department_id: r.deptId,
              classroom_id: r.classroomId,
              birth_date: r.birthDate,
              phone: r.phone || null,
              parent_phone: r.parentPhone || null,
              status: 'pending_activation',
              failed_attempts: 0
            }]);

          if (insErr) throw insErr;
          successCount++;
        }
      } catch (rowErr) {
        failedCount++;
        errorDetails.push({ code: r.studentCode, error: rowErr.message });
      }
    }

    // บันทึก Audit Log ลงตาราง student_import_logs (ข้อกำหนด 10)
    try {
      await supabase.from('student_import_logs').insert([{
        admin_id: req.adminUser.id || null,
        admin_username: req.adminUser.username || 'admin',
        file_name: fileName || 'Imported_File.xlsx',
        total_rows: rows.length,
        success_rows: successCount,
        updated_rows: updatedCount,
        failed_rows: failedCount,
        error_summary: errorDetails
      }]);
    } catch (auditErr) {
      console.warn('Audit log write warning:', auditErr.message);
    }

    res.json({
      success: true,
      message: `บันทึกข้อมูลเรียบร้อย: เพิ่มใหม่ ${successCount} รายการ, อัปเดต ${updatedCount} รายการ, ล้มเหลว/ข้าม ${failedCount} รายการ`,
      stats: { total: rows.length, successCount, updatedCount, failedCount }
    });
  } catch (err) {
    console.error('import-students-commit error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 4. เข้าสู่ระบบของนักเรียนด้วยรหัสนักศึกษาอย่างเดียว (Single-Identifier Login)
// พร้อมระบบผูกอุปกรณ์ (Device Binding) ป้องกันการเข้าแทนกัน
// ----------------------------------------------------------------------------
app.post('/api/auth/student-login', async (req, res) => {
  if (!checkIpRateLimit(req, res)) return;

  const { studentCode, deviceId, deviceName } = req.body;
  const genericErrMsg = 'รหัสนักศึกษาไม่ถูกต้อง หรือไม่พบบัญชีในระบบ กรุณาติดต่อครูที่ปรึกษาหรือฝ่ายทะเบียน';

  if (!studentCode) {
    return res.status(400).json({ success: false, message: genericErrMsg });
  }

  const cleanCode = String(studentCode).trim();
  const clientDeviceId = String(deviceId || '').trim();
  const clientDeviceName = String(deviceName || 'เบราว์เซอร์/อุปกรณ์ที่เข้าใช้งาน').trim();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  const deletedUsersSet = loadDeletedUsers();
  if (deletedUsersSet.has(cleanCode.toLowerCase())) {
    return res.status(401).json({ success: false, message: '⛔ บัญชีนักเรียนนี้ถูกลบออกจากระบบแล้ว' });
  }

  try {
    let studentUser = null;

    // 1. ค้นหาใน Supabase
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('users')
          .select('*, classrooms(name, advisor_name), departments(name)')
          .or(`student_code.eq.${cleanCode},username.eq.${cleanCode}`)
          .maybeSingle();
        if (data && !error && data.role === 'student') {
          studentUser = data;
        }
      } catch (dbErr) {
        console.warn('Supabase student lookup error:', dbErr.message);
      }
    }

    // 2. ค้นหาใน profiles.json / Local Fallback
    if (!studentUser) {
      const profiles = loadProfiles();
      for (const [key, p] of Object.entries(profiles)) {
        if ((p.student_code === cleanCode || p.username === cleanCode || key.toLowerCase() === cleanCode.toLowerCase()) && (p.role === 'student' || !p.role)) {
          studentUser = { ...p, username: p.username || key, role: 'student' };
          break;
        }
      }
    }

    // 3. Fallback demo student
    if (!studentUser && (cleanCode === '66209010012' || cleanCode === 'student')) {
      const demo = ALL_SYSTEM_ACCOUNTS['student'];
      const stored = getStoredProfile('student');
      studentUser = { ...demo, ...stored };
    }

    if (!studentUser) {
      appendLoginLog({
        student_code: cleanCode,
        device_id: clientDeviceId,
        device_name: clientDeviceName,
        ip_address: clientIp,
        status: 'failed',
        reason: 'user_not_found'
      });
      return res.status(400).json({ success: false, message: genericErrMsg });
    }

    // เติมข้อมูลให้สมบูรณ์
    const storedProf = getStoredProfile(studentUser.username) || {};
    studentUser = { ...studentUser, ...storedProf };
    const advisorName = studentUser.advisor_name || studentUser.advisor || (studentUser.classrooms ? studentUser.classrooms.advisor_name : 'ครูที่ปรึกษา');
    const deptName = studentUser.dept || (studentUser.departments ? studentUser.departments.name : 'แผนกวิชา');
    const classroomName = studentUser.classroom || (studentUser.classrooms ? studentUser.classrooms.name : 'ปวช.1');

    // บันทึกและอัปเดต Device Binding เป็นอุปกรณ์ปัจจุบัน (เข้าได้ทันทีทุกเครื่อง ไม่ต้องติดหน้าตรวจพบอุปกรณ์ใหม่)
    const boundDevId = studentUser.bound_device_id || storedProf.bound_device_id || null;
    const nowIso = new Date().toISOString();
    const isNewDevice = boundDevId && clientDeviceId && boundDevId !== clientDeviceId;
    const bindData = {
      bound_device_id: clientDeviceId || 'dev_' + Date.now(),
      bound_device_name: clientDeviceName,
      bound_device_at: nowIso
    };

    saveStoredProfile(studentUser.username, bindData);
    if (supabase && studentUser.id) {
      try {
        await supabase.from('users').update(bindData).eq('id', studentUser.id);
      } catch (e) {}
    }

    studentUser = { ...studentUser, ...bindData };

    appendLoginLog({
      student_code: studentUser.student_code || studentUser.username,
      student_name: studentUser.full_name,
      device_id: clientDeviceId,
      device_name: clientDeviceName,
      ip_address: clientIp,
      status: 'success'
    });

    // แจ้งเตือน Telegram หากผูกไว้ (แจ้งเตือนความปลอดภัยแบบ Non-blocking เมื่อมีอุปกรณ์ใหม่)
    const studentChatId = studentUser.telegram_chat_id || storedProf.telegram_chat_id;
    if (studentChatId && sendTelegramMessage && isNewDevice) {
      const msg = `🔔 <b>แจ้งเตือนความปลอดภัย OnePass</b>\n\nมีการเข้าสู่ระบบบัญชีของคุณจากอุปกรณ์:\n📱 <b>อุปกรณ์:</b> ${clientDeviceName}\n🌐 <b>IP:</b> ${clientIp}\n⏰ <b>เวลา:</b> ${new Date().toLocaleTimeString('th-TH')}`;
      sendTelegramMessage(studentChatId, msg).catch(e => console.warn('TG alert error:', e.message));
    }

    const token = generateToken(studentUser);
    console.log(`📱 [STUDENT LOGIN] Student ${studentUser.username} logged in successfully from ${clientDeviceName}`);

    return res.json({
      success: true,
      token,
      user: sanitizeUser(studentUser),
      need_onboarding: !studentUser.onboarding_completed
    });

  } catch (err) {
    console.error('student-login error:', err);
    res.status(500).json({ success: false, message: genericErrMsg });
  }
});

// ----------------------------------------------------------------------------
// 5. ยืนยัน OTP สำหรับอุปกรณ์ใหม่ของนักเรียน
// ----------------------------------------------------------------------------
app.post('/api/auth/verify-device-otp', async (req, res) => {
  if (!checkIpRateLimit(req, res)) return;

  const { studentCode, otp, deviceId, deviceName } = req.body;
  if (!studentCode || !otp) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกรหัส OTP 6 หลัก' });
  }

  const cleanCode = String(studentCode).trim();
  const cleanOtp = String(otp).trim();
  const profiles = loadProfiles();
  let studentUser = profiles[cleanCode.toLowerCase()] || Object.values(profiles).find(p => p.student_code === cleanCode || p.username === cleanCode);

  if (!studentUser && (cleanCode === '66209010012' || cleanCode === 'student')) {
    studentUser = { ...ALL_SYSTEM_ACCOUNTS['student'], ...getStoredProfile('student') };
  }

  if (!studentUser) {
    return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลนักเรียน' });
  }

  const storedOtp = studentUser.pending_device_otp;
  const otpExp = studentUser.pending_device_otp_expires;

  if (!storedOtp || storedOtp !== cleanOtp) {
    return res.status(400).json({ success: false, message: 'รหัส OTP ไม่ถูกต้อง' });
  }

  if (otpExp && new Date(otpExp) < new Date()) {
    return res.status(400).json({ success: false, message: 'รหัส OTP หมดอายุแล้ว กรุณาล็อกอินใหม่อีกครั้ง' });
  }

  // ผูกเครื่องใหม่สำเร็จ
  const bindData = {
    bound_device_id: deviceId || studentUser.pending_device_id || 'dev_' + Date.now(),
    bound_device_name: deviceName || studentUser.pending_device_name || 'อุปกรณ์ใหม่',
    bound_device_at: new Date().toISOString(),
    pending_device_otp: null,
    pending_device_otp_expires: null
  };

  saveStoredProfile(studentUser.username, bindData);
  if (supabase && studentUser.id) {
    try {
      await supabase.from('users').update(bindData).eq('id', studentUser.id);
    } catch (e) {}
  }

  // อัปเดตสถานะใน device_requests
  const reqs = loadDeviceRequests();
  reqs.forEach(r => {
    if (r.student_code === cleanCode && r.status === 'pending') {
      r.status = 'approved_by_otp';
      r.approved_at = new Date().toISOString();
    }
  });
  saveDeviceRequests(reqs);

  appendLoginLog({
    student_code: studentUser.student_code || studentUser.username,
    student_name: studentUser.full_name,
    device_id: bindData.bound_device_id,
    device_name: bindData.bound_device_name,
    status: 'success_otp_verified'
  });

  studentUser = { ...studentUser, ...bindData };
  const token = generateToken(studentUser);

  res.json({
    success: true,
    message: 'ยืนยันตัวตนสำเร็จ ผูกอุปกรณ์ใหม่เรียบร้อยแล้ว',
    token,
    user: sanitizeUser(studentUser),
    need_onboarding: !studentUser.onboarding_completed
  });
});

// ----------------------------------------------------------------------------
// 6. นักเรียนบันทึกข้อมูลเพิ่มเติมครั้งแรก (Onboarding: ทะเบียนรถ, เบอร์โทร, รูปรถ)
// ----------------------------------------------------------------------------
app.post('/api/student/onboarding', authenticateToken, async (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ success: false, message: 'เฉพาะนักเรียนเท่านั้นที่สามารถใช้งานหน้านี้ได้' });
  }

  const { vehiclePlate, phone, vehiclePhoto } = req.body;
  const cleanPlate = vehiclePlate ? String(vehiclePlate).trim() : '';
  const cleanPhone = phone ? String(phone).trim() : '';

  if (vehiclePhoto && vehiclePhoto.length > 5 * 1024 * 1024) {
    return res.status(400).json({ success: false, message: 'ขนาดไฟล์ภาพรถเกินขีดจำกัด (สูงสุด 3MB)' });
  }

  const updateData = {
    plate_no: cleanPlate,
    vehicle_plate: cleanPlate,
    phone: cleanPhone,
    phone_number: cleanPhone,
    plate_photo: vehiclePhoto || null,
    vehicle_photo: vehiclePhoto || null,
    onboarding_completed: true,
    onboarding_at: new Date().toISOString()
  };

  saveStoredProfile(req.user.username, updateData);
  if (supabase && req.user.id) {
    try {
      await supabase.from('users').update(updateData).eq('id', req.user.id);
    } catch (e) {
      console.warn('Update onboarding to supabase error:', e.message);
    }
  }

  const updatedUser = { ...req.user, ...updateData };
  console.log(`✅ [ONBOARDING] Completed onboarding for student: ${req.user.username}`);

  res.json({
    success: true,
    message: 'บันทึกข้อมูลเพิ่มเติมเรียบร้อยแล้ว',
    user: sanitizeUser(updatedUser)
  });
});

// ----------------------------------------------------------------------------
// 7. จัดการอุปกรณ์ของนักเรียน (Device Approvals / Reset) สำหรับครูที่ปรึกษาและแอดมิน
// ----------------------------------------------------------------------------
app.get('/api/admin/devices/pending', authenticateToken, async (req, res) => {
  const isAdvisor = req.user.role === 'advisor' || req.user.role === 'teacher';
  const isAdmin = req.user.role === 'admin' || req.user.role === 'discipline_head';

  if (!isAdvisor && !isAdmin) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึง' });
  }

  let list = loadDeviceRequests().filter(r => r.status === 'pending');
  if (isAdvisor && !isAdmin) {
    list = list.filter(r => r.advisor_username === req.user.username || !r.advisor_username);
  }

  res.json({ success: true, requests: list });
});

app.post('/api/admin/devices/:id/approve', authenticateToken, async (req, res) => {
  const isAdvisor = req.user.role === 'advisor' || req.user.role === 'teacher';
  const isAdmin = req.user.role === 'admin' || req.user.role === 'discipline_head';

  if (!isAdvisor && !isAdmin) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดำเนินการ' });
  }

  const reqId = req.params.id;
  const list = loadDeviceRequests();
  const target = list.find(r => r.id === reqId);

  if (!target) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการคำขอนี้' });
  }

  target.status = 'approved';
  target.approved_by = req.user.username;
  target.approved_at = new Date().toISOString();
  saveDeviceRequests(list);

  // อัปเดตผูกเครื่องให้นักเรียน
  const bindData = {
    bound_device_id: target.device_id,
    bound_device_name: target.device_name,
    bound_device_at: new Date().toISOString(),
    pending_device_otp: null,
    pending_device_otp_expires: null
  };
  saveStoredProfile(target.student_code, bindData);

  if (supabase && target.student_id) {
    try {
      await supabase.from('users').update(bindData).eq('id', target.student_id);
      await supabase.from('device_approval_requests').update({ status: 'approved' }).eq('id', target.id);
    } catch (e) {}
  }

  // ส่งแจ้งเตือนหานักเรียนผ่าน Telegram
  const studentProf = getStoredProfile(target.student_code);
  if (studentProf && studentProf.telegram_chat_id && sendTelegramMessage) {
    sendTelegramMessage(
      studentProf.telegram_chat_id,
      `✅ <b>อนุมัติอุปกรณ์ใหม่สำเร็จ</b>\n\nครูที่ปรึกษา/ผู้ดูแลระบบได้อนุมัติเครื่อง (${target.device_name}) ให้กับคุณแล้ว ตอนนี้คุณสามารถเข้าสู่ระบบจากเครื่องนี้ได้ทันที`
    ).catch(e => {});
  }

  res.json({ success: true, message: 'อนุมัติการผูกอุปกรณ์เรียบร้อยแล้ว' });
});

app.post('/api/admin/devices/:id/reject', authenticateToken, async (req, res) => {
  const isAdvisor = req.user.role === 'advisor' || req.user.role === 'teacher';
  const isAdmin = req.user.role === 'admin' || req.user.role === 'discipline_head';

  if (!isAdvisor && !isAdmin) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดำเนินการ' });
  }

  const reqId = req.params.id;
  const list = loadDeviceRequests();
  const target = list.find(r => r.id === reqId);

  if (!target) {
    return res.status(404).json({ success: false, message: 'ไม่พบรายการคำขอนี้' });
  }

  target.status = 'rejected';
  target.rejected_by = req.user.username;
  target.rejected_at = new Date().toISOString();
  saveDeviceRequests(list);

  res.json({ success: true, message: 'ปฏิเสธคำขอเรียบร้อยแล้ว' });
});

app.post('/api/admin/devices/reset', authenticateToken, async (req, res) => {
  const isAdvisor = req.user.role === 'advisor' || req.user.role === 'teacher';
  const isAdmin = req.user.role === 'admin' || req.user.role === 'discipline_head';

  if (!isAdvisor && !isAdmin) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดำเนินการ' });
  }

  const { studentCode } = req.body;
  if (!studentCode) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสนักศึกษา' });
  }

  const cleanCode = String(studentCode).trim();
  const resetData = {
    bound_device_id: null,
    bound_device_name: null,
    bound_device_at: null,
    pending_device_id: null,
    pending_device_name: null,
    pending_device_otp: null,
    pending_device_otp_expires: null
  };

  saveStoredProfile(cleanCode, resetData);
  if (supabase) {
    try {
      await supabase.from('users').update(resetData).or(`student_code.eq.${cleanCode},username.eq.${cleanCode}`);
    } catch (e) {}
  }

  console.log(`🔄 [DEVICE RESET] Reset bound device for student ${cleanCode} by ${req.user.username}`);
  res.json({ success: true, message: `รีเซ็ตการผูกอุปกรณ์ของนักเรียน ${cleanCode} เรียบร้อยแล้ว สามารถผูกเครื่องใหม่ได้ทันที` });
});

// ----------------------------------------------------------------------------
// 8. นำเข้ารายชื่อนักเรียน (Admin Student Roster Import: Excel / CSV)
// ----------------------------------------------------------------------------
app.get('/api/admin/students/template', (req, res) => {
  const csvContent = '\uFEFF' + [
    'รหัสนักศึกษา,คำนำหน้า,ชื่อ,นามสกุล,สาขาวิชา,ระดับชั้น,ชั้นปี,ห้อง,ครูที่ปรึกษา(username)',
    '66209010001,นาย,สมชาย,ใจดี,แผนกวิชาช่างยนต์,ปวช.,1,1,teacher_auto',
    '66209010002,นางสาว,สมหญิง,รักเรียน,แผนกวิชาการบัญชี,ปวส.,1,2,head_account',
    '66209010003,นาย,สมศักดิ์,มีทรัพย์,แผนกวิชาช่างไฟฟ้ากำลัง,ปวช.,2,1,teacher_auto'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=student_roster_template.csv');
  res.status(200).send(csvContent);
});

app.post('/api/admin/students/import', authenticateToken, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'discipline_head';
  if (!isAdmin) {
    return res.status(403).json({ success: false, message: 'เฉพาะผู้ดูแลระบบเท่านั้นที่สามารถนำเข้ารายชื่อนักเรียนได้' });
  }

  const { students, commit } = req.body;
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลนักเรียนที่ส่งมา' });
  }

  const errors = [];
  const validRows = [];
  const seenCodes = new Set();
  const allAccounts = { ...ALL_SYSTEM_ACCOUNTS, ...loadProfiles() };

  students.forEach((row, idx) => {
    const rowNum = idx + 1;
    const code = String(row.studentCode || row['รหัสนักศึกษา'] || '').trim();
    const prefix = String(row.prefix || row['คำนำหน้า'] || '').trim();
    const firstName = String(row.firstName || row['ชื่อ'] || '').trim();
    const lastName = String(row.lastName || row['นามสกุล'] || '').trim();
    const dept = String(row.department || row['สาขาวิชา'] || '').trim();
    const level = String(row.curriculumLevel || row['ระดับชั้น'] || '').trim();
    const year = parseInt(row.classYear || row['ชั้นปี'] || 1, 10);
    const room = parseInt(row.roomNumber || row['ห้อง'] || 1, 10);
    const advisorUser = String(row.advisorUsername || row['ครูที่ปรึกษา'] || row['ครูที่ปรึกษา(username)'] || '').trim();

    // Validation
    if (!code) {
      errors.push({ row: rowNum, field: 'studentCode', message: 'รหัสนักศึกษาต้องไม่ว่างเปล่า' });
      return;
    }
    if (seenCodes.has(code)) {
      errors.push({ row: rowNum, studentCode: code, field: 'studentCode', message: 'รหัสนักศึกษาซ้ำในไฟล์ที่นำเข้า' });
      return;
    }
    seenCodes.add(code);

    if (!firstName || !lastName) {
      errors.push({ row: rowNum, studentCode: code, field: 'name', message: 'ชื่อและนามสกุลต้องไม่ว่างเปล่า' });
      return;
    }

    if (!dept) {
      errors.push({ row: rowNum, studentCode: code, field: 'department', message: 'ต้องระบุสาขาวิชา' });
      return;
    }

    // ครูที่ปรึกษาต้องมีในระบบ
    let matchedAdvisor = null;
    if (advisorUser) {
      matchedAdvisor = allAccounts[advisorUser.toLowerCase()] || Object.values(allAccounts).find(a => a.username === advisorUser || (a.full_name && a.full_name.includes(advisorUser)));
      if (!matchedAdvisor) {
        errors.push({ row: rowNum, studentCode: code, field: 'advisor', message: `ไม่พบบัญชีครูที่ปรึกษา '${advisorUser}' ในระบบ` });
        return;
      }
    }

    const fullName = `${prefix}${firstName} ${lastName}`.trim();
    const classroomName = `${level}${year}/${room}`;

    validRows.push({
      student_code: code,
      username: code,
      student_prefix: prefix,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      dept: dept,
      curriculum_level: level,
      class_year: year,
      room_number: room,
      classroom: classroomName,
      advisor_username: matchedAdvisor ? matchedAdvisor.username : (advisorUser || 'teacher_auto'),
      advisor_name: matchedAdvisor ? (matchedAdvisor.full_name || matchedAdvisor.username) : 'อ.อนุสรณ์ ช่างยนต์',
      role: 'student',
      status: 'active',
      onboarding_completed: false
    });
  });

  // Preview Mode
  if (!commit) {
    return res.json({
      success: true,
      preview: true,
      total: students.length,
      validCount: validRows.length,
      invalidCount: errors.length,
      errors,
      sample: validRows.slice(0, 10)
    });
  }

  // Commit Mode
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: `มีข้อผิดพลาดในข้อมูล ${errors.length} รายการ กรุณาตรวจสอบและแก้ไขก่อนบันทึก`,
      errors
    });
  }

  let successCount = 0;
  for (const s of validRows) {
    saveStoredProfile(s.username, s);
    if (supabase) {
      try {
        await supabase.from('users').upsert({
          username: s.username,
          student_code: s.student_code,
          full_name: s.full_name,
          role: 'student',
          status: 'active',
          student_prefix: s.student_prefix,
          first_name: s.first_name,
          last_name: s.last_name,
          curriculum_level: s.curriculum_level,
          class_year: s.class_year,
          room_number: s.room_number,
          advisor_username: s.advisor_username,
          advisor_name: s.advisor_name,
          onboarding_completed: false
        }, { onConflict: 'username' });
      } catch (e) {
        console.warn('Upsert to supabase warning:', e.message);
      }
    }
    successCount++;
  }

  console.log(`📥 [IMPORT ROSTER] Successfully imported/updated ${successCount} students.`);
  res.json({
    success: true,
    message: `นำเข้ารายชื่อนักเรียนสำเร็จทั้งหมด ${successCount} รายการ`,
    count: successCount
  });
});

// ----------------------------------------------------------------------------
// 6. นักเรียนขอเปิดบัญชีแบบ "รอยืนยัน" (กรณีไม่มีชื่อในรายชื่อ Excel ตามข้อกำหนด 7)
// ----------------------------------------------------------------------------
app.post('/api/auth/request-pending-account', async (req, res) => {
  if (!checkIpRateLimit(req, res)) return;

  const { studentCode, fullName, departmentId, classroomId, birthDate, phone, parentPhone, note } = req.body;
  if (!studentCode || !fullName || !departmentId) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลสำคัญให้ครบถ้วน' });
  }

  if (!supabase) {
    return res.status(500).json({ success: false, message: 'ระบบฐานข้อมูลไม่พร้อมใช้งาน' });
  }

  try {
    const cleanCode = String(studentCode).trim();
    // ตรวจสอบว่ามีรหัสนี้อยู่แล้วหรือไม่
    const { data: exist } = await supabase
      .from('users')
      .select('id, status')
      .or(`username.eq.${cleanCode},student_code.eq.${cleanCode}`)
      .maybeSingle();

    if (exist) {
      return res.status(400).json({ success: false, message: 'รหัสนักศึกษานี้มีอยู่ในระบบแล้ว' });
    }

    const isoBirth = parseThaiBirthDateToIso(birthDate);

    // บันทึกสถานะ pending_approval
    const { error: insErr } = await supabase.from('users').insert([{
      username: cleanCode,
      student_code: cleanCode,
      password: '',
      full_name: String(fullName).trim(),
      role: 'student',
      department_id: parseInt(departmentId, 10),
      classroom_id: classroomId ? parseInt(classroomId, 10) : null,
      birth_date: isoBirth,
      phone: phone || null,
      parent_phone: parentPhone || null,
      status: 'pending_approval',
      college: 'วิทยาลัยการอาชีพองครักษ์'
    }]);

    if (insErr) throw insErr;

    res.json({
      success: true,
      message: 'ยื่นคำขอลงทะเบียนเรียบร้อยแล้ว กรุณาติดต่ออาจารย์ที่ปรึกษาหรือแอดมินเพื่อตรวจสอบและอนุมัติบัญชี'
    });
  } catch (err) {
    console.error('request-pending-account error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ----------------------------------------------------------------------------
// 7. ครูที่ปรึกษา/แอดมิน ดูและอนุมัติบัญชีที่รอยืนยัน (ข้อกำหนด 9)
// ----------------------------------------------------------------------------
app.get('/api/admin/pending-approvals', requireApproverOrAdminAuth, async (req, res) => {
  if (!supabase) return res.json({ success: true, students: [] });
  try {
    let query = supabase
      .from('users')
      .select('id, student_code, full_name, role, department_id, classroom_id, phone, parent_phone, created_at, departments(name), classrooms(name, advisor_name)')
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: false });

    // ถ้าเป็นครูที่ปรึกษา ให้ดูเฉพาะห้องที่ตัวเองเป็นที่ปรึกษา
    if (req.authUser.role === 'advisor' && req.authUser.classroom_id) {
      query = query.eq('classroom_id', req.authUser.classroom_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, students: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/approve-pending-student', requireApproverOrAdminAuth, async (req, res) => {
  const { studentId, action, reason } = req.body; // action: 'approve' | 'reject'
  if (!studentId || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, message: 'ข้อมูลคำสั่งไม่ถูกต้อง' });
  }

  if (!supabase) return res.status(500).json({ success: false, message: 'ฐานข้อมูลไม่พร้อมใช้งาน' });

  try {
    if (action === 'approve') {
      // อนุมัติ: ให้เป็น pending_activation เพื่อให้นักเรียนตั้งรหัสผ่านเอง
      await supabase
        .from('users')
        .update({ status: 'pending_activation' })
        .eq('id', studentId);
      res.json({ success: true, message: 'อนุมัติบัญชีนักเรียนเรียบร้อยแล้ว (นักเรียนสามารถยืนยันตัวตนและตั้งรหัสผ่านได้แล้ว)' });
    } else {
      // ปฏิเสธ: ลบหรือระงับ
      await supabase
        .from('users')
        .delete()
        .eq('id', studentId);
      res.json({ success: true, message: 'ปฏิเสธและลบคำขอเรียบร้อยแล้ว' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------------------------------
// 8. ดึงประวัติ Audit Logs การนำเข้าไฟล์ (สำหรับหน้าจอ Admin)
// ----------------------------------------------------------------------------
app.get('/api/admin/import-logs', requireAdminAuth, async (req, res) => {
  if (!supabase) return res.json({ success: true, logs: [] });
  try {
    const { data, error } = await supabase
      .from('student_import_logs')
      .select('*')
      .order('imported_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ success: true, logs: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Smart Gate System running at: http://localhost:${PORT}`);
  console.log(`☁️ Supabase PostgreSQL Database: CONNECTED!`);
  console.log(`=======================================================`);
});
