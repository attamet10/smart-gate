// ============================================================================
// ONEPASS FRONTEND LOGIC (วิทยาลัยการอาชีพองครักษ์)
// ============================================================================

let currentView = 'home'; // เริ่มต้นที่หน้าหลัก (Home)
let currentToken = '';
let html5Scanner = null;
let activeRequest = null;
var currentTelegramToken = null;
var telegramPollTimer = null;
var telegramCountdownTimer = null;
var currentTelegramStatus = { connected: false };

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

// ====================== AUTHENTICATION LOGIC (WELCOME / LOGIN / REGISTER) ======================
let currentAuthView = 'welcome';

function getAuthToken() {
  return localStorage.getItem('onepass_auth_token') || '';
}

function getAuthHeaders(extraHeaders = {}) {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function ensureAuthToken(forceRefresh = false) {
  const existing = getAuthToken();
  const user = getCurrentUser();
  if (!user || !user.username) return '';

  // ตรวจสอบความถูกต้องของ Token ถ้าเป็น Token เก่าของบัญชีอื่น หรือ role ไม่ตรงกับผู้ใช้ปัจจุบัน ให้ขอใหม่ทันที
  if (existing && !forceRefresh) {
    try {
      const parts = existing.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        if (payload.username === user.username && payload.role === user.role) {
          return existing;
        }
      }
    } catch (e) {}
  }

  try {
    const res = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username })
    });
    const data = await res.json();
    if (data.success && data.token) {
      localStorage.setItem('onepass_auth_token', data.token);
      console.log('🔑 [JWT] Token synchronized successfully for', user.username, `(role: ${user.role})`);
      return data.token;
    }
  } catch (e) {
    console.warn('Sync token error:', e);
  }
  return getAuthToken();
}

// ====================== 5 แผนกวิชาและอาจารย์/หัวหน้าแผนก/ครูรายวิชา ======================
const DEPARTMENTS_DATA = {
  'แผนกวิชาช่างยนต์': {
    id: 'auto',
    name: 'แผนกวิชาช่างยนต์',
    icon: '🚗',
    subjectTeacher: { username: 'subject_auto', name: 'อ.วิชัย เครื่องยนต์' },
    teacher: { username: 'teacher_auto', name: 'อ.อนุสรณ์ ช่างยนต์' },
    head: { username: 'head_auto', name: 'อ.ประสิทธิ์ ยานยนต์' }
  },
  'แผนกวิชาช่างไฟฟ้า': {
    id: 'electric',
    name: 'แผนกวิชาช่างไฟฟ้า',
    icon: '⚡',
    subjectTeacher: { username: 'subject_electric', name: 'อ.ธีรพงษ์ วงจรไฟฟ้า' },
    teacher: { username: 'teacher_electric', name: 'อ.กิตติศักดิ์ ไฟฟ้า' },
    head: { username: 'head_electric', name: 'อ.สมศักดิ์ พลังงาน' }
  },
  'แผนกวิชาการบัญชี': {
    id: 'account',
    name: 'แผนกวิชาการบัญชี',
    icon: '📊',
    subjectTeacher: { username: 'subject_account', name: 'อ.กมลชนก การเงิน' },
    teacher: { username: 'teacher_account', name: 'อ.พิมพา บัญชี' },
    head: { username: 'head_account', name: 'อ.วรรณา ยอดเงิน' }
  },
  'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล': {
    id: 'digital',
    name: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    icon: '💻',
    subjectTeacher: { username: 'subject_digital', name: 'อ.ปิยะพงษ์ โปรแกรม' },
    teacher: { username: 'teacher_digital', name: 'อ.ธนากร ดิจิทัล' },
    head: { username: 'head_digital', name: 'อ.ณัฐพงษ์ เทคโนโลยี' }
  },
  'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล': {
    id: 'office',
    name: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    icon: '📁',
    subjectTeacher: { username: 'subject_office', name: 'อ.ศิริพร งานเอกสาร' },
    teacher: { username: 'teacher_office', name: 'อ.นภาวรรณ สำนักงาน' },
    head: { username: 'head_office', name: 'อ.สุพรรณี การจัดการ' }
  }
};

const KNOWN_USERS = {
  'student': {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'student',
    full_name: 'นายธนภัทร รัตนโชติ',
    role: 'student',
    role_label: 'นักเรียน/นักศึกษา',
    role_badge: 'นักเรียน (ปวช.3)',
    code: 'student',
    student_code: '66209010012',
    dept: 'แผนกวิชาช่างยนต์ (ปวช.3)',
    department: 'แผนกวิชาช่างยนต์',
    classroom: 'ปวช.3',
    plate: '',
    advisor: 'อ.อนุสรณ์ ช่างยนต์',
    phone: '081-234-5678',
    parent_phone: '089-876-5432',
    college: 'วิทยาลัยการอาชีพองครักษ์',
    profile_photo: '',
    plate_photo: '',
    icon: 'fa-user-graduate',
    avatar_bg: 'from-blue-600 to-indigo-700'
  },

  // ครูรายวิชาประจำแผนก (ขั้นที่ 1/5)
  'subject_auto': {
    id: '00000000-0000-0000-0000-000000000010',
    username: 'subject_auto',
    full_name: 'อ.วิชัย เครื่องยนต์',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชา (ช่างยนต์)',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_auto',
    dept: 'แผนกวิชาช่างยนต์',
    department: 'แผนกวิชาช่างยนต์',
    plate: 'กข 1010 นครนายก',
    advisor: '-',
    phone: '089-100-0001',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  'subject_electric': {
    id: '00000000-0000-0000-0000-000000000020',
    username: 'subject_electric',
    full_name: 'อ.ธีรพงษ์ วงจรไฟฟ้า',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชา (ช่างไฟฟ้า)',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_electric',
    dept: 'แผนกวิชาช่างไฟฟ้า',
    department: 'แผนกวิชาช่างไฟฟ้า',
    plate: 'กข 1020 นครนายก',
    advisor: '-',
    phone: '089-100-0002',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  'subject_account': {
    id: '00000000-0000-0000-0000-000000000030',
    username: 'subject_account',
    full_name: 'อ.กมลชนก การเงิน',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชา (การบัญชี)',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_account',
    dept: 'แผนกวิชาการบัญชี',
    department: 'แผนกวิชาการบัญชี',
    plate: 'กข 1030 นครนายก',
    advisor: '-',
    phone: '089-100-0003',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  'subject_digital': {
    id: '00000000-0000-0000-0000-000000000040',
    username: 'subject_digital',
    full_name: 'อ.ปิยะพงษ์ โปรแกรม',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชา (ธุรกิจดิจิทัล)',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_digital',
    dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    department: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    plate: 'กข 1040 นครนายก',
    advisor: '-',
    phone: '089-100-0004',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  'subject_office': {
    id: '00000000-0000-0000-0000-000000000050',
    username: 'subject_office',
    full_name: 'อ.ศิริพร งานเอกสาร',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชา (การจัดการสำนักงาน)',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_office',
    dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    department: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    plate: 'กข 1050 นครนายก',
    advisor: '-',
    phone: '089-100-0005',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  'subject_general': {
    id: '00000000-0000-0000-0000-000000000060',
    username: 'subject_general',
    full_name: 'อ.สายชล สามัญศึกษา',
    role: 'subject_teacher',
    role_label: 'ครูรายวิชาสามัญสัมพันธ์',
    role_badge: 'ครูรายวิชา (ขั้นที่ 1/5)',
    code: 'subject_general',
    dept: 'หมวดวิชาสามัญสัมพันธ์',
    department: 'หมวดวิชาสามัญสัมพันธ์',
    plate: 'กข 1060 นครนายก',
    advisor: '-',
    phone: '089-100-0006',
    parent_phone: '-',
    icon: 'fa-book-open-reader',
    avatar_bg: 'from-sky-600 to-blue-700'
  },
  
  // 1. แผนกวิชาช่างยนต์
  'teacher_auto': {
    id: '00000000-0000-0000-0000-000000000011',
    username: 'teacher_auto',
    full_name: 'อ.อนุสรณ์ ช่างยนต์',
    role: 'advisor',
    role_label: 'ครูที่ปรึกษา (ช่างยนต์)',
    role_badge: 'ครูที่ปรึกษา (ขั้นที่ 2/5)',
    code: 'teacher_auto',
    dept: 'แผนกวิชาช่างยนต์',
    department: 'แผนกวิชาช่างยนต์',
    plate: 'กข 1001 นครนายก',
    advisor: '-',
    phone: '089-111-0001',
    parent_phone: '-',
    icon: 'fa-chalkboard-user',
    avatar_bg: 'from-emerald-600 to-teal-700'
  },
  'head_auto': {
    id: '00000000-0000-0000-0000-000000000012',
    username: 'head_auto',
    full_name: 'อ.ประสิทธิ์ ยานยนต์',
    role: 'dept_head',
    role_label: 'หัวหน้าแผนกวิชาช่างยนต์',
    role_badge: 'หัวหน้าแผนก (ขั้นที่ 3/5)',
    code: 'head_auto',
    dept: 'แผนกวิชาช่างยนต์',
    department: 'แผนกวิชาช่างยนต์',
    plate: 'ขค 2001 นครนายก',
    advisor: '-',
    phone: '089-222-0001',
    parent_phone: '-',
    icon: 'fa-building-columns',
    avatar_bg: 'from-amber-600 to-orange-700'
  },

  // 2. แผนกวิชาช่างไฟฟ้า
  'teacher_electric': {
    id: '00000000-0000-0000-0000-000000000021',
    username: 'teacher_electric',
    full_name: 'อ.กิตติศักดิ์ ไฟฟ้า',
    role: 'advisor',
    role_label: 'ครูที่ปรึกษา (ช่างไฟฟ้า)',
    role_badge: 'ครูที่ปรึกษา (ขั้นที่ 2/5)',
    code: 'teacher_electric',
    dept: 'แผนกวิชาช่างไฟฟ้า',
    department: 'แผนกวิชาช่างไฟฟ้า',
    plate: 'กข 1002 นครนายก',
    advisor: '-',
    phone: '089-111-0002',
    parent_phone: '-',
    icon: 'fa-chalkboard-user',
    avatar_bg: 'from-emerald-600 to-teal-700'
  },
  'head_electric': {
    id: '00000000-0000-0000-0000-000000000022',
    username: 'head_electric',
    full_name: 'อ.สมศักดิ์ พลังงาน',
    role: 'dept_head',
    role_label: 'หัวหน้าแผนกวิชาช่างไฟฟ้า',
    role_badge: 'หัวหน้าแผนก (ขั้นที่ 3/5)',
    code: 'head_electric',
    dept: 'แผนกวิชาช่างไฟฟ้า',
    department: 'แผนกวิชาช่างไฟฟ้า',
    plate: 'ขค 2002 นครนายก',
    advisor: '-',
    phone: '089-222-0002',
    parent_phone: '-',
    icon: 'fa-building-columns',
    avatar_bg: 'from-amber-600 to-orange-700'
  },

  // 3. แผนกวิชาการบัญชี
  'teacher_account': {
    id: '00000000-0000-0000-0000-000000000031',
    username: 'teacher_account',
    full_name: 'อ.พิมพา บัญชี',
    role: 'advisor',
    role_label: 'ครูที่ปรึกษา (การบัญชี)',
    role_badge: 'ครูที่ปรึกษา (ขั้นที่ 2/5)',
    code: 'teacher_account',
    dept: 'แผนกวิชาการบัญชี',
    department: 'แผนกวิชาการบัญชี',
    plate: 'กข 1003 นครนายก',
    advisor: '-',
    phone: '089-111-0003',
    parent_phone: '-',
    icon: 'fa-chalkboard-user',
    avatar_bg: 'from-emerald-600 to-teal-700'
  },
  'head_account': {
    id: '00000000-0000-0000-0000-000000000032',
    username: 'head_account',
    full_name: 'อ.วรรณา ยอดเงิน',
    role: 'dept_head',
    role_label: 'หัวหน้าแผนกวิชาการบัญชี',
    role_badge: 'หัวหน้าแผนก (ขั้นที่ 3/5)',
    code: 'head_account',
    dept: 'แผนกวิชาการบัญชี',
    department: 'แผนกวิชาการบัญชี',
    plate: 'ขค 2003 นครนายก',
    advisor: '-',
    phone: '089-222-0003',
    parent_phone: '-',
    icon: 'fa-building-columns',
    avatar_bg: 'from-amber-600 to-orange-700'
  },

  // 4. แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล
  'teacher_digital': {
    id: '00000000-0000-0000-0000-000000000041',
    username: 'teacher_digital',
    full_name: 'อ.ธนากร ดิจิทัล',
    role: 'advisor',
    role_label: 'ครูที่ปรึกษา (ธุรกิจดิจิทัล)',
    role_badge: 'ครูที่ปรึกษา (ขั้นที่ 2/5)',
    code: 'teacher_digital',
    dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    department: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    plate: 'กข 1004 นครนายก',
    advisor: '-',
    phone: '089-111-0004',
    parent_phone: '-',
    icon: 'fa-chalkboard-user',
    avatar_bg: 'from-emerald-600 to-teal-700'
  },
  'head_digital': {
    id: '00000000-0000-0000-0000-000000000042',
    username: 'head_digital',
    full_name: 'อ.ณัฐพงษ์ เทคโนโลยี',
    role: 'dept_head',
    role_label: 'หัวหน้าแผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    role_badge: 'หัวหน้าแผนก (ขั้นที่ 3/5)',
    code: 'head_digital',
    dept: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    department: 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    plate: 'ขค 2004 นครนายก',
    advisor: '-',
    phone: '089-222-0004',
    parent_phone: '-',
    icon: 'fa-building-columns',
    avatar_bg: 'from-amber-600 to-orange-700'
  },

  // 5. แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล
  'teacher_office': {
    id: '00000000-0000-0000-0000-000000000051',
    username: 'teacher_office',
    full_name: 'อ.นภาวรรณ สำนักงาน',
    role: 'advisor',
    role_label: 'ครูที่ปรึกษา (การจัดการสำนักงาน)',
    role_badge: 'ครูที่ปรึกษา (ขั้นที่ 2/5)',
    code: 'teacher_office',
    dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    department: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    plate: 'กข 1005 นครนายก',
    advisor: '-',
    phone: '089-111-0005',
    parent_phone: '-',
    icon: 'fa-chalkboard-user',
    avatar_bg: 'from-emerald-600 to-teal-700'
  },
  'head_office': {
    id: '00000000-0000-0000-0000-000000000052',
    username: 'head_office',
    full_name: 'อ.สุพรรณี การจัดการ',
    role: 'dept_head',
    role_label: 'หัวหน้าแผนกการจัดการสำนักงานฯ',
    role_badge: 'หัวหน้าแผนก (ขั้นที่ 3/5)',
    code: 'head_office',
    dept: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    department: 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล',
    plate: 'ขค 2005 นครนายก',
    advisor: '-',
    phone: '089-222-0005',
    parent_phone: '-',
    icon: 'fa-building-columns',
    avatar_bg: 'from-amber-600 to-orange-700'
  },

  // ฝ่ายปกครอง (ตรวจอนุมัติขั้นตอนที่ 4/5)
  'discipline': {
    id: '00000000-0000-0000-0000-000000000004',
    username: 'discipline',
    full_name: 'อ.เกรียงไกร รักษาวินัย',
    role: 'discipline_head',
    role_label: 'ฝ่ายปกครอง / กิจการนักเรียน',
    role_badge: 'ฝ่ายปกครอง (ขั้นที่ 4/5)',
    code: 'discipline',
    dept: 'ฝ่ายพัฒนากิจการนักเรียนนักศึกษา (ฝ่ายปกครอง)',
    department: 'ฝ่ายปกครอง',
    plate: 'คง 9999 นครนายก',
    advisor: '-',
    phone: '089-555-6666',
    parent_phone: '-',
    icon: 'fa-shield-halved',
    avatar_bg: 'from-purple-600 to-indigo-800'
  },

  // รองผู้อำนวยการ (ตรวจอนุมัติขั้นตอนที่ 5/5 และสร้าง QR Pass)
  'deputy': {
    id: '00000000-0000-0000-0000-000000000005',
    username: 'deputy',
    full_name: 'ดร.เกียรติศักดิ์ พัฒนากิจ',
    role: 'deputy_director',
    role_label: 'รองผู้อำนวยการฝ่ายพัฒนากิจการนักเรียนนักศึกษา',
    role_badge: 'รองผู้อำนวยการ (ขั้นที่ 5/5)',
    code: 'deputy',
    dept: 'ฝ่ายบริหาร / รองผู้อำนวยการ',
    department: 'ฝ่ายบริหาร',
    plate: 'กท 5555 นครนายก',
    advisor: '-',
    phone: '089-777-8888',
    parent_phone: '-',
    icon: 'fa-user-tie',
    avatar_bg: 'from-indigo-800 to-blue-950'
  },

  // ผู้ดูแลระบบ (Admin Panel จัดการผู้ใช้/แผนก/ตารางสอน/เวลาทำการ)
  'admin': {
    id: '00000000-0000-0000-0000-000000000099',
    username: 'admin',
    full_name: 'ผู้ดูแลระบบ OnePass (Admin)',
    role: 'admin',
    role_label: 'ผู้ดูแลระบบ (System Admin)',
    role_badge: 'ผู้ดูแลระบบ (Admin)',
    code: 'admin',
    dept: 'งานศูนย์ข้อมูลและสารสนเทศ',
    department: 'งานศูนย์ข้อมูล',
    plate: 'อย 0001 นครนายก',
    advisor: '-',
    phone: '081-999-8888',
    parent_phone: '-',
    icon: 'fa-gears',
    avatar_bg: 'from-slate-700 to-slate-900'
  }
};

function fillRoleCredentials(roleKey) {
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorAlert = document.getElementById('login-error-alert');
  if (usernameInput) usernameInput.value = roleKey;
  if (passwordInput) passwordInput.value = '1234';
  if (errorAlert) errorAlert.classList.add('hidden');
}

// ====================== QUICK LOGIN DEPT MODAL ======================
function openQuickLoginDeptModal(roleType) {
  const modal = document.getElementById('modal-select-dept-login');
  const titleEl = document.getElementById('quick-dept-login-title');
  const listEl = document.getElementById('quick-dept-login-list');
  if (!modal || !listEl) return;
  
  const isSubject = roleType === 'subject';
  const isTeacher = roleType === 'teacher';
  if (isSubject) {
    titleEl.textContent = '📖 เลือกแผนกวิชา (ครูรายวิชา - ขั้นที่ 1)';
  } else if (isTeacher) {
    titleEl.textContent = '👨‍🏫 เลือกแผนกวิชา (ครูที่ปรึกษา - ขั้นที่ 2)';
  } else {
    titleEl.textContent = '🏢 เลือกแผนกวิชา (หัวหน้าแผนก - ขั้นที่ 3)';
  }
  
  let itemsHtml = Object.values(DEPARTMENTS_DATA).map(d => {
    const userObj = isSubject ? (d.subjectTeacher || d.teacher) : (isTeacher ? d.teacher : d.head);
    const roleLabel = isSubject ? 'ครูรายวิชา' : (isTeacher ? 'ครูที่ปรึกษา' : 'หัวหน้าแผนก');
    return `
      <button type="button" onclick="selectQuickDeptLogin('${userObj.username}')" class="w-full p-2.5 rounded-2xl bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 text-left transition flex items-center justify-between group">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="text-xl shrink-0">${d.icon}</span>
          <div class="truncate">
            <p class="font-bold text-xs text-slate-800 group-hover:text-blue-700">${d.name}</p>
            <p class="text-[11px] text-slate-500">${userObj.name} (${roleLabel})</p>
          </div>
        </div>
        <span class="text-[10px] bg-slate-200 group-hover:bg-blue-600 group-hover:text-white px-2 py-1 rounded-lg font-mono font-bold shrink-0 transition">
          ${userObj.username}
        </span>
      </button>
    `;
  }).join('');

  if (isSubject) {
    itemsHtml += `
      <button type="button" onclick="selectQuickDeptLogin('subject_general')" class="w-full p-2.5 rounded-2xl bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 text-left transition flex items-center justify-between group">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="text-xl shrink-0">📚</span>
          <div class="truncate">
            <p class="font-bold text-xs text-slate-800 group-hover:text-blue-700">หมวดวิชาสามัญสัมพันธ์</p>
            <p class="text-[11px] text-slate-500">อ.สายชล สามัญศึกษา (ครูรายวิชา)</p>
          </div>
        </div>
        <span class="text-[10px] bg-slate-200 group-hover:bg-blue-600 group-hover:text-white px-2 py-1 rounded-lg font-mono font-bold shrink-0 transition">
          subject_general
        </span>
      </button>
    `;
  }

  listEl.innerHTML = itemsHtml;
  modal.classList.remove('hidden');
}

function closeQuickLoginDeptModal() {
  const modal = document.getElementById('modal-select-dept-login');
  if (modal) modal.classList.add('hidden');
}

function selectQuickDeptLogin(username) {
  closeQuickLoginDeptModal();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorAlert = document.getElementById('login-error-alert');
  if (usernameInput) usernameInput.value = username;
  if (passwordInput) passwordInput.value = '1234';
  if (errorAlert) errorAlert.classList.add('hidden');
  
  const loginForm = document.getElementById('form-login');
  if (loginForm) {
    loginForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }
}

// เมื่อเลือกแผนกวิชาในหน้าต่างแก้ไขข้อมูลส่วนตัว -> ดึงชื่อครูที่ปรึกษาอัตโนมัติ
function onModalDeptChange() {
  const deptSelect = document.getElementById('modal-edit-dept-select');
  const advisorInput = document.getElementById('modal-edit-advisor');
  if (!deptSelect || !advisorInput) return;
  
  const deptName = deptSelect.value;
  const deptData = DEPARTMENTS_DATA[deptName];
  if (deptData && deptData.teacher) {
    advisorInput.value = deptData.teacher.name;
  }
}

function fillDemoCredentials() {
  fillRoleCredentials('admin');
}

function getCurrentUser() {
  const saved = localStorage.getItem('onepass_current_user');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.username === 'student') {
        if (!parsed.student_code) parsed.student_code = '66209010012';
        if (!parsed.college) parsed.college = 'วิทยาลัยการอาชีพองครักษ์';
      } else if (parsed.username === 'admin') {
        parsed.role = 'admin';
        parsed.role_badge = 'ผู้ดูแลระบบ (Admin)';
        parsed.role_label = 'ผู้ดูแลระบบ (System Admin)';
        parsed.icon = 'fa-gears';
        if (!parsed.full_name || parsed.full_name.includes('เกรียงไกร')) {
          parsed.full_name = 'ผู้ดูแลระบบ OnePass (Admin)';
        }
      } else if (parsed.username === 'discipline') {
        parsed.role = 'discipline_head';
        parsed.role_badge = 'ฝ่ายปกครอง (ขั้นที่ 4/5)';
        parsed.role_label = 'ฝ่ายปกครอง / กิจการนักเรียน';
        parsed.icon = 'fa-shield-halved';
      } else if (parsed.username === 'deputy') {
        parsed.role = 'deputy_director';
        parsed.role_badge = 'รองผู้อำนวยการ (ขั้นที่ 5/5)';
        parsed.role_label = 'รองผู้อำนวยการฝ่ายพัฒนากิจการนักเรียนนักศึกษา';
        parsed.icon = 'fa-user-tie';
      }
      return parsed;
    } catch (e) {}
  }
  return KNOWN_USERS['student'];
}

// ====================== 5-STEP ROLE & QUEUE HELPERS ======================
function getApproverStepForRole(role, totalSteps = 5) {
  if (totalSteps === 4) {
    if (role === 'advisor') return 1;
    if (role === 'dept_head') return 2;
    if (role === 'discipline_head') return 3;
    if (role === 'deputy_director' || role === 'admin') return 4;
    return 1;
  }
  if (totalSteps === 3) {
    if (role === 'advisor' || role === 'subject_teacher') return 1;
    if (role === 'dept_head') return 2;
    if (role === 'discipline_head' || role === 'deputy_director' || role === 'admin') return 3;
    return 1;
  }
  if (role === 'subject_teacher') return 1;
  if (role === 'advisor') return 2;
  if (role === 'dept_head') return 3;
  if (role === 'discipline_head') return 4;
  if (role === 'deputy_director' || role === 'admin') return 5;
  return 1;
}

function getStepPositionLabel(step, totalSteps = 4) {
  if (totalSteps === 4) {
    return {
      1: 'ครูที่ปรึกษา',
      2: 'หัวหน้าแผนกวิชา',
      3: 'ฝ่ายปกครอง / งานหลักสูตร',
      4: 'รองผู้อำนวยการ'
    }[step] || `ขั้นที่ ${step}`;
  }
  if (totalSteps === 3) {
    return { 1: 'ครูที่ปรึกษา', 2: 'หัวหน้าแผนกวิชา', 3: 'ฝ่ายปกครอง' }[step] || `ขั้นที่ ${step}`;
  }
  return {
    1: 'ครูรายวิชา',
    2: 'ครูที่ปรึกษา',
    3: 'หัวหน้าแผนกวิชา',
    4: 'ฝ่ายปกครอง',
    5: 'รองผู้อำนวยการ'
  }[step] || `ขั้นที่ ${step}`;
}

function getRequestWaitingTeacherName(r, stepNum) {
  if (!r) return '';
  const total = Number(r.totalSteps || 4);
  const deptName = (r.deptName || '').split('(')[0].trim();
  const deptObj = DEPARTMENTS_DATA[deptName] || Object.values(DEPARTMENTS_DATA).find(d => isDepartmentMatch(d.name, deptName));

  if (total === 4) {
    if (stepNum === 1) return r.advisorName || deptObj?.teacher?.name || 'ครูที่ปรึกษา';
    if (stepNum === 2) return deptObj?.head?.name || 'หัวหน้าแผนกวิชา';
    if (stepNum === 3) return 'อ.เกรียงไกร รักษา วินัย (ฝ่ายปกครอง)';
    if (stepNum === 4) return 'รองผอ.ดร.ภูมิพัฒน์ บริหารกิจ';
    return '';
  }

  if (total === 3) {
    if (stepNum === 1) return deptObj?.teacher?.name || 'ครูที่ปรึกษา';
    if (stepNum === 2) return deptObj?.head?.name || 'หัวหน้าแผนกวิชา';
    if (stepNum === 3) return 'อ.เกรียงไกร รักษาวินัย';
    return '';
  }

  if (stepNum === 1) {
    if (r.step1Skipped) return 'ไม่มีคาบเรียน';
    return r.subjectTeacherName || deptObj?.subjectTeacher?.name || 'ครูรายวิชา';
  }
  if (stepNum === 2) return deptObj?.teacher?.name || 'ครูที่ปรึกษา';
  if (stepNum === 3) return deptObj?.head?.name || 'หัวหน้าแผนกวิชา';
  if (stepNum === 4) return 'อ.เกรียงไกร รักษาวินัย';
  if (stepNum === 5) return 'ดร.เกียรติศักดิ์ พัฒนากิจ';
  return '';
}

// ตรวจสอบว่าคำร้องนี้อยู่ในคิวของครูคนนี้หรือไม่
function isRequestInApproverQueue(user, r, includeDelegateMode = false) {
  if (!user || !r) return false;
  if (r.status === 'rejected' || r.status === 'approved' || r.status === 'exited' || r.status === 'returned' || r.status === 'expired') return false;
  if (typeof isRequestExpired === 'function' && isRequestExpired(r)) return false;

  const totalSteps = Number(r.totalSteps || 4);
  const currentStep = Number(r.currentStep || 1);
  const userStep = getApproverStepForRole(user.role, totalSteps);

  const userDept = user.departments ? user.departments.name : (user.dept || user.department || '');
  const cleanUserDept = userDept.replace('แผนกวิชา', '').trim();

  // โครงสร้าง 4 ขั้น: หัวหน้าแผนกเป็นครูที่ปรึกษาด้วย -> แสดงคำร้องขั้นที่ 1 ในคิวด้วย
  if (totalSteps === 4 && currentStep === 1 && (user.role === 'dept_head' || user.role === 'head_dept')) {
    if (isDepartmentMatch(cleanUserDept, r.deptName)) {
      return true;
    }
  }

  // พิเศษสำหรับขั้นที่ 1 (ครูรายวิชา ในระบบ 5 ขั้น)
  if (totalSteps === 5 && currentStep === 1) {
    const assignedUser = (r.subjectTeacherUsername || '').toLowerCase().trim();
    const assignedName = (r.subjectTeacherName || '').trim();
    if (assignedUser && assignedUser === (user.username || '').toLowerCase().trim()) {
      return true;
    }
    if (assignedName && user.full_name && assignedName === user.full_name.trim()) {
      return true;
    }
  }

  // กรณีคิวปกติของตำแหน่งตนเอง
  if (currentStep === userStep) {
    if (totalSteps === 5 && currentStep === 1 && user.role === 'subject_teacher') {
      const assignedUser = (r.subjectTeacherUsername || '').toLowerCase();
      const assignedName = (r.subjectTeacherName || '').trim();
      if (!assignedUser && !assignedName) {
        return isDepartmentMatch(cleanUserDept, r.deptName);
      }
      if (assignedUser === (user.username || '').toLowerCase() || assignedName === (user.full_name || '').trim()) {
        return true;
      }
      if (includeDelegateMode && isDepartmentMatch(cleanUserDept, r.deptName)) {
        return true;
      }
      return false;
    }

    if (user.role === 'advisor' || user.role === 'dept_head') {
      return isDepartmentMatch(cleanUserDept, r.deptName);
    }
    return true; // discipline_head, deputy_director, admin
  }

  // กรณีพิเศษ: หัวหน้าแผนกเป็นครูที่ปรึกษาประจำห้องด้วยในระบบ 5 ขั้น
  if (totalSteps === 5 && currentStep === 2 && (user.role === 'dept_head' || user.role === 'head_dept')) {
    if (isDepartmentMatch(cleanUserDept, r.deptName)) {
      return true;
    }
  }

  // กรณีเปิดโหมด "อนุมัติแทนเมื่อครูไม่อยู่" (Requirement 6)
  if (includeDelegateMode) {
    // ครูในแผนกเดียวกัน หรือหัวหน้าแผนก อนุมัติแทนขั้น 1-3 ของแผนกตนเองได้
    if (currentStep <= 3 && (user.role === 'subject_teacher' || user.role === 'advisor' || user.role === 'dept_head')) {
      return isDepartmentMatch(cleanUserDept, r.deptName);
    }
    // ฝ่ายปกครอง หรือ รองผอ. อนุมัติแทนกันได้ หรืออนุมัติแทนขั้นก่อนหน้าได้
    if (user.role === 'discipline_head' || user.role === 'deputy_director' || user.role === 'admin') {
      return true;
    }
  }

  return false;
}

function checkProfileComplete(user) {
  if (!user) user = getCurrentUser();
  if (user.role !== 'student') return { complete: true, missing: [] };

  const missing = [];
  if (!user.phone || !user.phone.trim()) missing.push('เบอร์โทรศัพท์นักเรียน');
  if (!user.parent_phone || !user.parent_phone.trim()) missing.push('เบอร์โทรผู้ปกครอง');

  return {
    complete: missing.length === 0,
    missing: missing
  };
}

function updateBottomNavVisibility(user) {
  if (!user) user = getCurrentUser();
  const bottomNavHistory = document.getElementById('bottom-nav-history');
  const bottomNavStats = document.getElementById('bottom-nav-stats');
  const bottomNavAdmin = document.getElementById('bottom-nav-admin');
  const headerAdminBtn = document.getElementById('header-admin-btn');
  const adminPortalCard = document.getElementById('home-admin-portal-card');
  const middleIcon = document.getElementById('bottom-icon-history');
  const middleText = document.getElementById('bottom-text-history');

  if (!user) return;

  const isStudent = (user.role === 'student');
  const isAdmin = (user.role === 'admin');

  // ปรับไอคอนและข้อความปุ่มตรงกลางตามสิทธิ์เสมอ
  if (middleIcon && middleText) {
    if (isStudent) {
      middleIcon.className = 'fa-solid fa-clock-rotate-left text-[18px] transition-transform duration-200';
      middleText.textContent = 'ประวัติคำร้อง';
    } else {
      middleIcon.className = 'fa-solid fa-signature text-[18px] transition-transform duration-200';
      middleText.textContent = 'การอนุมัติ';
    }
  }

  // 1. แท็บสถิติ (Stats): แสดงเฉพาะ อาจารย์, หัวหน้าแผนก, ฝ่ายปกครอง, Admin (นักเรียนซ่อน 100%)
  if (bottomNavStats) {
    if (isStudent) {
      bottomNavStats.classList.add('hidden');
    } else {
      bottomNavStats.classList.remove('hidden');
    }
  }

  // 2. แท็บจัดการระบบ (Admin Panel): ซ่อนในแถบล่างเสมอ ให้ใช้ 4 เมนูเท่ากับครูตามข้อกำหนด (Admin เข้าผ่านปุ่มบนหัวเว็บ)
  if (bottomNavAdmin) {
    bottomNavAdmin.classList.add('hidden');
  }

  // อัปเดต Notification Badge รอพิจารณาของผู้อนุมัติ
  updateBottomApprovalBadge();

  if (headerAdminBtn) {
    headerAdminBtn.classList.add('hidden');
  }

  if (adminPortalCard) {
    if (isAdmin) adminPortalCard.classList.remove('hidden');
    else adminPortalCard.classList.add('hidden');
  }
}

// อัปเดตตัวเลขแจ้งเตือน Badge รออนุมัติที่มุมปุ่มการอนุมัติ
function updateBottomApprovalBadge(count) {
  const badge = document.getElementById('bottom-badge-approval');
  if (!badge) return;
  const user = getCurrentUser();
  if (!user || user.role === 'student') {
    badge.classList.add('hidden');
    return;
  }

  if (typeof count === 'undefined') {
    const pendingRequests = (typeof allRequestsList !== 'undefined' && Array.isArray(allRequestsList))
      ? allRequestsList.filter(r => isRequestInApproverQueue(user, r, typeof isDelegateApprovalMode !== 'undefined' && isDelegateApprovalMode))
      : [];
    count = pendingRequests.length;
  }

  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function applyCurrentUserUI(user) {
  if (!user) user = getCurrentUser();

  // ตั้งค่าตัวกรองระดับชั้นเริ่มต้นตามโปรไฟล์ของอาจารย์
  if (user && user.role !== 'student') {
    initTeacherGradeFilter(user);
  }

  // อัปเดตในฟอร์มยื่นคำร้อง
  populateFormWithUserProfile(user);

  // อัปเดตหน้าโปรไฟล์
  const profName = document.getElementById('prof-name');
  const profRoleBadge = document.getElementById('prof-role-badge');
  const profCode = document.getElementById('prof-code');
  const profStudentCodeHeader = document.getElementById('prof-student-code-header');
  const profStudentCodeHeaderRow = document.getElementById('prof-student-code-header-row');
  const profDept = document.getElementById('prof-dept');
  const profCollege = document.getElementById('prof-college');
  const profStudentCode = document.getElementById('prof-student-code');
  const profStudentCodeRow = document.getElementById('prof-student-code-row');
  const profAdvisor = document.getElementById('prof-advisor-name');
  const profVehicle = document.getElementById('prof-vehicle');
  const profVehicleRow = document.getElementById('prof-vehicle-row');
  const profPhone = document.getElementById('prof-phone');
  const profParentPhone = document.getElementById('prof-parent-phone');
  const profAvatarIcon = document.getElementById('prof-avatar-icon');
  const profPlatePreview = document.getElementById('prof-plate-photo-preview');
  const profPlateStatus = document.getElementById('prof-plate-photo-status');
  const profPlateBtnLabel = document.getElementById('prof-plate-btn-label');
  const profStatusBadge = document.getElementById('prof-status-badge');

  if (profName) profName.textContent = user.full_name || 'นายธนภัทร รัตนโชติ';

  // ป้ายสถานะบทบาท (Role Badge): นักเรียนต้องแสดงคำว่า "นักเรียน" เสมอ ไม่แสดงคำว่า "ผู้ใช้งาน"
  let roleBadgeText = 'นักเรียน';
  if (user.role === 'subject_teacher') roleBadgeText = user.role_badge || 'ครูรายวิชา (ขั้นที่ 1/5)';
  else if (user.role === 'advisor') roleBadgeText = user.role_badge || 'ครูที่ปรึกษา (ขั้นที่ 2/5)';
  else if (user.role === 'dept_head') roleBadgeText = user.role_badge || 'หัวหน้าแผนกวิชา (ขั้นที่ 3/5)';
  else if (user.role === 'discipline_head') roleBadgeText = user.role_badge || 'ฝ่ายปกครอง (ขั้นที่ 4/5)';
  else if (user.role === 'deputy_director') roleBadgeText = user.role_badge || 'รองผู้อำนวยการ (ขั้นที่ 5/5)';
  else if (user.role === 'admin') roleBadgeText = user.role_badge || 'ผู้ดูแลระบบ (Admin)';
  else roleBadgeText = 'นักเรียน';

  if (profRoleBadge) {
    profRoleBadge.textContent = roleBadgeText;
    profRoleBadge.className = 'px-2.5 py-0.5 rounded-full bg-emerald-500/30 text-emerald-200 border border-emerald-400/40 text-[10px] font-semibold';
  }

  if (profCode) profCode.textContent = user.code || user.username || 'student';
  if (profDept) profDept.textContent = user.dept || 'วิทยาลัยการอาชีพองครักษ์';
  if (profCollege) profCollege.textContent = user.college || 'วิทยาลัยการอาชีพองครักษ์';
  if (profAdvisor) profAdvisor.textContent = user.advisor || '-';
  if (profVehicle) profVehicle.textContent = user.plate || '-';
  if (profPhone) profPhone.textContent = user.phone || '-';
  if (profParentPhone) profParentPhone.textContent = user.parent_phone || '-';

  // รหัสนักศึกษา: ต้องเป็นรหัส นศ. จริง (ห้ามดึงอีเมลมาแสดงแทนเด็ดขาด)
  let studentCodeVal = (user.student_code && !user.student_code.includes('@')) ? user.student_code : '';
  if (!studentCodeVal) {
    studentCodeVal = (user.username === 'student') ? '66209010012' : 'ยังไม่ระบุรหัส นศ.';
  }

  if (profStudentCodeHeader) {
    profStudentCodeHeader.textContent = studentCodeVal;
    if (studentCodeVal === 'ยังไม่ระบุรหัส นศ.') {
      profStudentCodeHeader.className = 'font-sans text-amber-200 font-medium text-xs';
    } else {
      profStudentCodeHeader.className = 'font-mono font-bold tracking-wider';
    }
  }

  if (profStudentCode) {
    profStudentCode.textContent = studentCodeVal;
    if (studentCodeVal === 'ยังไม่ระบุรหัส นศ.') {
      profStudentCode.className = 'font-sans text-amber-600 font-medium text-xs';
    } else {
      profStudentCode.className = 'font-bold text-blue-700 font-mono text-sm';
    }
  }

  // ช่องแสดงอีเมลในหน้าโปรไฟล์
  const profEmail = document.getElementById('prof-email');
  if (profEmail) {
    profEmail.textContent = user.username || user.email || '-';
  }

  // รูปโปรไฟล์
  if (profAvatarIcon) {
    if (user.profile_photo) {
      profAvatarIcon.innerHTML = `<img src="${user.profile_photo}" class="w-full h-full object-cover" alt="โปรไฟล์">`;
    } else if (user.icon) {
      profAvatarIcon.innerHTML = `<i class="fa-solid ${user.icon}"></i>`;
    }
  }

  // รูปถ่ายป้ายทะเบียนรถ (แสดงรูปภาพตัวอย่างจริงเมื่อแนบรูปแล้ว สามารถแตะเพื่อดูขนาดเต็มได้)
  const profPlateIndicator = document.getElementById('prof-plate-photo-indicator');
  if (profPlateIndicator) {
    if (user.plate_photo) {
      profPlateIndicator.innerHTML = `
        <button type="button" onclick="viewPhotoFullscreen('${user.plate_photo}')" title="แตะเพื่อดูรูปป้ายทะเบียนขนาดเต็ม" class="relative group block rounded-xl overflow-hidden focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-xs border-2 border-emerald-400 bg-white">
          <img src="${user.plate_photo}" alt="ป้ายทะเบียน" class="w-12 h-12 object-cover transition group-hover:scale-105" />
          <span class="absolute -bottom-1 -right-1 bg-emerald-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[8px] shadow"><i class="fa-solid fa-expand"></i></span>
        </button>
      `;
    } else {
      profPlateIndicator.innerHTML = `<span class="inline-flex items-center gap-1 text-[11px] bg-slate-100 text-slate-400 border border-slate-200 px-2 py-1 rounded-lg"><i class="fa-regular fa-image"></i> ยังไม่แนบรูป</span>`;
    }
  }

  // สถานะความสมบูรณ์ของโปรไฟล์
  if (profStatusBadge) {
    const profileCheck = checkProfileComplete(user);
    if (profileCheck.complete) {
      profStatusBadge.className = 'px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold';
      profStatusBadge.textContent = '✓ พร้อมใช้งาน';
    } else {
      profStatusBadge.className = 'px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-bold';
      profStatusBadge.textContent = `⚠️ ข้อมูลไม่ครบ (${profileCheck.missing.length} รายการ)`;
    }
  }

  // ซ่อน/แสดงข้อมูลเฉพาะของนักเรียน
  const advisorRow = document.getElementById('prof-advisor-row');
  const parentRow = document.getElementById('prof-parent-phone-row');
  if (user.role !== 'student') {
    if (advisorRow) advisorRow.classList.add('hidden');
    if (parentRow) parentRow.classList.add('hidden');
    if (profStudentCodeRow) profStudentCodeRow.classList.add('hidden');
    if (profStudentCodeHeaderRow) profStudentCodeHeaderRow.classList.add('hidden');
  } else {
    if (advisorRow) advisorRow.classList.remove('hidden');
    if (parentRow) parentRow.classList.remove('hidden');
    if (profStudentCodeRow) profStudentCodeRow.classList.remove('hidden');
    if (profStudentCodeHeaderRow) profStudentCodeHeaderRow.classList.remove('hidden');
  }

  // อัปเดตตัวเลขสถิติในหน้าโปรไฟล์ตามบทบาท
  updateProfileStats();
    fetchTelegramStatus();

  // ปรับเปลี่ยนมุมมองหน้าหลัก และแท็บเมนูล่างอันกลางระหว่าง "นักเรียน" กับ "ผู้อนุมัติทั้ง 3 ท่าน"
  const homeStudent = document.getElementById('home-student-view');
  const homeApprover = document.getElementById('home-approver-view');
  const middleIcon = document.getElementById('bottom-icon-history');
  const middleText = document.getElementById('bottom-text-history');
  // ปรับการแสดง/ซ่อนเมนูล่างและปุ่ม Admin ให้ตรงกับบทบาท (Role) เสมอ
  updateBottomNavVisibility(user);

  if (user.role === 'student') {
    if (homeStudent) homeStudent.classList.remove('hidden');
    if (homeApprover) homeApprover.classList.add('hidden');
    if (middleIcon) middleIcon.className = 'fa-solid fa-clock-rotate-left text-lg';
    if (middleText) middleText.textContent = 'ประวัติคำร้อง';
  } else {
    if (homeStudent) homeStudent.classList.add('hidden');
    if (homeApprover) homeApprover.classList.remove('hidden');
    if (middleIcon) middleIcon.className = 'fa-solid fa-signature text-lg';
    if (middleText) middleText.textContent = 'การอนุมัติ';
    renderApproverHomeDashboard();
  }
}

function setAuthView(view) {
  currentAuthView = view;
  const viewWelcome = document.getElementById('auth-view-welcome');
  const viewLogin = document.getElementById('auth-view-login');
  const viewRegister = document.getElementById('auth-view-register');

  if (viewWelcome) viewWelcome.classList.add('hidden');
  if (viewLogin) viewLogin.classList.add('hidden');
  if (viewRegister) viewRegister.classList.add('hidden');

  if (view === 'welcome' && viewWelcome) viewWelcome.classList.remove('hidden');
  if (view === 'login' && viewLogin) viewLogin.classList.remove('hidden');
  if (view === 'register' && viewRegister) viewRegister.classList.remove('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchUserProfileFromDB(username) {
  if (!username) return;
  try {
    const res = await fetch('/api/profile/' + encodeURIComponent(username));
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.user) {
        const u = data.user;
        const current = getCurrentUser();
        if (current && (current.username === username || current.student_code === username)) {
          const merged = {
            ...current,
            full_name: u.full_name || current.full_name,
            student_code: u.student_code || current.student_code,
            plate: u.plate_no || u.plate || '',
            phone: u.phone || '',
            parent_phone: u.parent_phone || '',
            dept: u.dept || current.dept,
            advisor: u.advisor || current.advisor,
            profile_photo: u.profile_photo || current.profile_photo,
            plate_photo: u.plate_photo || current.plate_photo,
            college: u.college || current.college || 'วิทยาลัยการอาชีพองครักษ์'
          };
          localStorage.setItem('onepass_current_user', JSON.stringify(merged));
          applyCurrentUserUI(merged);
        }
      }
    }
  } catch (err) {
    console.warn('Sync profile from database warning:', err);
  }
}

function checkAuth() {
  const isLoggedIn = localStorage.getItem('onepass_logged_in') === 'true';
  const authScreen = document.getElementById('screen-auth');
  const appShell = document.getElementById('app-shell');

  if (isLoggedIn) {
    if (authScreen) authScreen.classList.add('hidden');
    if (appShell) appShell.classList.remove('hidden');
    const u = getCurrentUser();
    applyCurrentUserUI(u);
    if (u && u.username) {
      fetchUserProfileFromDB(u.username);
      ensureAuthToken();
    }
    setViewMode(u && u.role === 'admin' ? 'admin' : 'home');

    // บังคับโหมดเต็มจอทุกครั้งหลัง Login: พยายาม Fullscreen API ก่อน (ได้ผลดีบน Android)
    // ถ้าใช้ไม่ได้ (เช่น iOS Safari) ให้เลื่อนจอขึ้น 1px เพื่อซ่อน Address Bar แทน (รองรับทุกเบราว์เซอร์มือถือ)
    requestAppFullscreen();
    setTimeout(() => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        window.scrollTo(0, 1);
      }
    }, 300);
  } else {
    if (authScreen) authScreen.classList.remove('hidden');
    if (appShell) appShell.classList.add('hidden');
    setAuthView(currentAuthView || 'welcome');
  }
}

// ขอเข้าสู่โหมดเต็มจอ (ซ่อน Address Bar) ทันทีที่มีการแตะปุ่ม Login
// ต้องเรียกแบบ synchronous ภายใน event handler เดิม (ก่อน await ใดๆ) เบราว์เซอร์ถึงจะยอมให้ fullscreen
// ได้ผลดีบน Android Chrome; iOS Safari ไม่รองรับ Fullscreen API จึงจะไม่มีผล (เงียบๆ ไม่ error)
function requestAppFullscreen() {
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      req.call(el).catch(() => {});
    }
  } catch (e) {}
}
window.requestAppFullscreen = requestAppFullscreen;

async function handleLoginSubmit(e) {
  if (e) e.preventDefault();
  requestAppFullscreen();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorAlert = document.getElementById('login-error-alert');

  const username = usernameInput ? usernameInput.value.trim().toLowerCase() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!username || !password) {
    if (errorAlert) {
      errorAlert.classList.remove('hidden');
      const errText = errorAlert.querySelector('p:last-child');
      if (errText) errText.textContent = 'กรุณากรอก Username และ Password';
    }
    return;
  }

  // 1. ตรวจสอบผ่าน Backend API (Supabase)
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await res.json();
    if (result.success && result.user) {
      const u = result.user;
      if (result.token) {
        localStorage.setItem('onepass_auth_token', result.token);
      }
      const matchedKnown = KNOWN_USERS[u.username.toLowerCase()] || {};
      const fullUserObj = {
        ...matchedKnown,
        ...u,
        full_name: u.full_name || matchedKnown.full_name || 'ผู้ใช้งาน OnePass',
        username: u.username,
        role: u.role || matchedKnown.role || 'student',
        student_code: u.student_code || matchedKnown.student_code || '',
        dept: u.dept || (u.departments ? u.departments.name : 'แผนกวิชาช่างไฟฟ้ากำลัง (ปวส.2/1)'),
        advisor: u.advisor || u.advisor_name || (u.classrooms ? u.classrooms.advisor_name : 'อ.กิตติศักดิ์ ไฟฟ้า'),
        plate: u.plate || u.plate_no || '-',
        phone: u.phone || '-',
        parent_phone: u.parent_phone || '',
        college: u.college || 'วิทยาลัยการอาชีพองครักษ์',
        profile_photo: u.profile_photo || null,
        plate_photo: u.plate_photo || null
      };
      if (errorAlert) errorAlert.classList.add('hidden');
      localStorage.setItem('onepass_logged_in', 'true');
      localStorage.setItem('onepass_current_user', JSON.stringify(fullUserObj));
      applyCurrentUserUI(fullUserObj);
      checkAuth();
      return;
    }
  } catch (err) {
    console.warn('API login check fallback:', err);
  }

  // 2. Fallback ตรวจสอบกับบัญชีทั้ง 4 บทบาท (รหัสผ่าน 1234)
  const matched = KNOWN_USERS[username];
  if (matched && password === '1234') {
    if (errorAlert) errorAlert.classList.add('hidden');
    localStorage.setItem('onepass_logged_in', 'true');
    localStorage.setItem('onepass_current_user', JSON.stringify(matched));
    applyCurrentUserUI(matched);
    checkAuth();
    return;
  }

  // 3. ตรวจสอบผู้ใช้ที่ลงทะเบียนในเครื่อง (Local Registered)
  const registeredUsers = JSON.parse(localStorage.getItem('onepass_registered_users') || '[]');
  const matchedReg = registeredUsers.find(u => (u.email === username || u.name === username) && u.password === password);
  if (matchedReg) {
    const regUserObj = {
      id: 'reg-' + Date.now(),
      username: matchedReg.email,
      full_name: matchedReg.name,
      role: 'student',
      role_label: 'นักเรียน/นักศึกษา',
      role_badge: 'สมาชิกใหม่',
      code: 'student',
      dept: 'แผนกวิชาช่างไฟฟ้ากำลัง (ปวส.2/1)',
      icon: 'fa-user'
    };
    if (errorAlert) errorAlert.classList.add('hidden');
    localStorage.setItem('onepass_logged_in', 'true');
    localStorage.setItem('onepass_current_user', JSON.stringify(regUserObj));
    applyCurrentUserUI(regUserObj);
    checkAuth();
    return;
  }

  // แจ้งเตือนเมื่อผิดพลาด
  if (errorAlert) {
    errorAlert.classList.remove('hidden');
    const errText = errorAlert.querySelector('p:last-child');
    if (errText) errText.innerHTML = 'Username หรือ Password ไม่ถูกต้อง (เลือกรหัสทดสอบ student / teacher / head / admin รหัส: <strong>1234</strong>)';
  }
}

async function handleRegisterSubmit(e) {
  if (e) e.preventDefault();
  const codeInput = document.getElementById('reg-student-code');
  const nameInput = document.getElementById('reg-name');
  const deptInput = document.getElementById('reg-department');
  const emailInput = document.getElementById('reg-email');
  const passwordInput = document.getElementById('reg-password');
  const confirmInput = document.getElementById('reg-password-confirm');
  const successAlert = document.getElementById('register-success-alert');

  const studentCode = codeInput ? codeInput.value.trim() : '';
  const name = nameInput ? nameInput.value.trim() : '';
  const deptId = deptInput ? parseInt(deptInput.value, 10) : 2;
  const deptName = deptInput ? (deptInput.options[deptInput.selectedIndex]?.text || 'แผนกวิชาช่างไฟฟ้ากำลัง') : 'แผนกวิชาช่างไฟฟ้ากำลัง';
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';
  const confirmPassword = confirmInput ? confirmInput.value.trim() : '';

  // 1. ตรวจสอบความครบถ้วน
  if (!studentCode || !name || !email || !password || !confirmPassword) {
    alert('กรุณากรอกข้อมูลให้ครบถ้วนทั้ง 5 รายการ');
    return;
  }

  // 2. ตรวจสอบความยาวรหัสผ่านอย่างน้อย 8 ตัว
  if (password.length < 8) {
    alert('⚠️ รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
    if (passwordInput) passwordInput.focus();
    return;
  }

  // 3. ตรวจสอบรหัสผ่าน 2 รอบต้องตรงกัน
  if (password !== confirmPassword) {
    alert('⚠️ รหัสผ่านทั้ง 2 ช่องไม่ตรงกัน กรุณากรอกยืนยันรหัสผ่านใหม่อีกครั้ง');
    if (confirmInput) {
      confirmInput.value = '';
      confirmInput.focus();
    }
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentCode, name, deptId, deptName, email, password })
    });
    const result = await res.json();

    if (result.success) {
      // แคชไว้ใน LocalStorage ด้วย
      const registeredUsers = JSON.parse(localStorage.getItem('onepass_registered_users') || '[]');
      registeredUsers.push({ studentCode, name, email, password, dept: deptName });
      localStorage.setItem('onepass_registered_users', JSON.stringify(registeredUsers));

      if (successAlert) {
        successAlert.classList.remove('hidden');
        successAlert.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400 text-base shrink-0"></i><span>ลงทะเบียนสำเร็จ! ใช้รหัสนักศึกษา ${studentCode} เข้าสู่ระบบได้ทันที</span>`;
      }

      // ใส่รหัสนักศึกษาและรหัสผ่านลงในช่อง Login ให้อัตโนมัติ
      const loginUser = document.getElementById('login-username');
      const loginPass = document.getElementById('login-password');
      if (loginUser) loginUser.value = studentCode;
      if (loginPass) loginPass.value = password;

      setTimeout(() => {
        if (successAlert) successAlert.classList.add('hidden');
        setAuthView('login');
      }, 1500);
    } else {
      alert('ลงทะเบียนไม่สำเร็จ: ' + (result.message || 'เกิดข้อผิดพลาด'));
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  }
}

function handleLogout() {
  localStorage.removeItem('onepass_logged_in');
  localStorage.removeItem('onepass_current_user');
  localStorage.removeItem('onepass_auth_token');
  currentAuthView = 'welcome';
  checkAuth();
}

function togglePasswordVisibility(inputId = 'login-password', eyeId = 'login-password-eye') {
  const passInput = document.getElementById(inputId);
  const eyeIcon = document.getElementById(eyeId);
  if (!passInput || !eyeIcon) return;

  if (passInput.type === 'password') {
    passInput.type = 'text';
    eyeIcon.className = 'fa-regular fa-eye-slash';
  } else {
    passInput.type = 'password';
    eyeIcon.className = 'fa-regular fa-eye';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // 0. ตั้งค่าธีม ภาษา และ PWA ทันทีเมื่อเปิดเว็บ
  initAppTheme();
  initAppLanguage();
  initTelegramModule();
  initPwaServiceWorker();

  // ดึงและตั้งค่าเวลาทำการสถานศึกษา (เวลาเข้าแถว, พักเที่ยง, เลิกเรียน)
  await fetchAndApplySchoolSettings();

  // ตรวจสอบสถานะการเข้าสู่ระบบ
  checkAuth();

  // เริ่มต้นสร้าง QR Code (ถ้ามี)
  if (currentToken) {
    renderQrCode(currentToken);
  }

  // ดึงสถานะคำขอเริ่มต้น
  await fetchActiveRequest();

  // Polling สถานะฮาร์ดแวร์จำลอง ESP32
  setInterval(pollSimulator, 1000);

  // นาฬิกาบนจอ OLED
  setInterval(() => {
    const clockEl = document.getElementById('oled-clock');
    if (clockEl) {
      const now = new Date();
      clockEl.innerText = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  }, 1000);

  // Live Real-time Polling คำร้องและขั้นตอนการพิจารณาอนุมัติ (อัปเดตสถานะแบบเรียลไทม์ทุก 1.2 วินาที)
  setInterval(syncRealtimeRequests, 1200);
});

// ====================== REAL-TIME LIVE SYNC (แสดงผลเรียลไทม์) ======================
let isSyncingRealtime = false;
let previousRequestsDigest = '';

function getStudentRequests(user) {
  if (!user) user = getCurrentUser();
  if (!user) return [];
  return allRequestsList.filter(r => {
    if (user.id && r.studentId === user.id) return true;
    if (user.student_code && r.studentCode === user.student_code) return true;
    if (user.username && (r.studentCode === user.username || (r.users && r.users.username === user.username))) return true;
    if (user.full_name && r.studentName === user.full_name) return true;
    return false;
  });
}

// ตรวจสอบว่านักเรียนมีคำร้องเดิมที่ยังใช้งานอยู่หรือไม่ (ยังไม่หมดเวลา และยังไม่เสร็จสิ้น)
function getStudentActiveRequest(user) {
  if (!user) user = getCurrentUser();
  if (!user || user.role !== 'student') return null;
  const myRequests = getStudentRequests(user);
  for (const r of myRequests) {
    if (r.status === 'returned' || r.status === 'rejected') continue;
    if (!isRequestExpired(r)) {
      return r;
    }
  }
  return null;
}

async function manualRefreshStatus() {
  const refreshBtns = document.querySelectorAll('.btn-refresh-status-icon');
  refreshBtns.forEach(btn => btn.classList.add('animate-spin'));
  previousRequestsDigest = '';
  await syncRealtimeRequests();
  setTimeout(() => {
    refreshBtns.forEach(btn => btn.classList.remove('animate-spin'));
  }, 400);
}

async function syncRealtimeRequests() {
  if (isSyncingRealtime) return;
  
  // ตรวจสอบว่าผู้ใช้ล็อกอินอยู่หรือไม่
  const user = getCurrentUser();
  if (!user) return;

  // ไม่รีเฟรชถ้ากำลังเลื่อนปรับเวลา หรือเปิด modal แก้ไขข้อมูล เพื่อไม่ให้รบกวนผู้ใช้
  const timeModal = document.getElementById('modal-thai-time-picker');
  if (timeModal && !timeModal.classList.contains('hidden')) return;
  const editModal = document.getElementById('modal-edit-profile');
  if (editModal && !editModal.classList.contains('hidden')) return;

  isSyncingRealtime = true;
  try {
    const res = await fetch('/api/requests');
    if (!res.ok) throw new Error('Fetch failed');
    const data = await res.json();
    const newRequests = data.requests || [];

    // สร้าง Digest เพื่อเปรียบเทียบว่าข้อมูลคำร้องเปลี่ยนไปหรือไม่
    const newDigest = newRequests.map(x => `${x.id}_${x.status}_${x.currentStep}_${x.qrToken || ''}`).join('|');

    if (newDigest !== previousRequestsDigest) {
      previousRequestsDigest = newDigest;
      allRequestsList = newRequests;

      // อัปเดต activeRequest สำหรับนักเรียน (ดึงเฉพาะคำร้องของตนเองเท่านั้น ไม่ปะปนกับคนอื่น)
      if (user.role === 'student') {
        const myRequests = getStudentRequests(user);
        if (myRequests.length > 0) {
          const latest = myRequests[0];
          if (latest.status === 'returned' || isRequestExpired(latest)) {
            activeRequest = null;
            currentToken = '';
          } else if (latest.status === 'rejected') {
            const isDismissed = localStorage.getItem('ack_rejected_' + latest.id) === 'true';
            activeRequest = isDismissed ? null : latest;
          } else {
            activeRequest = latest;
            if (activeRequest.qrToken && (activeRequest.status === 'approved' || activeRequest.status === 'exited' || activeRequest.status === 'gate_opened')) {
              currentToken = activeRequest.qrToken;
            }
          }
        } else {
          activeRequest = null;
          currentToken = '';
        }
      } else {
        activeRequest = allRequestsList.length > 0 ? allRequestsList[0] : null;
      }

      // 1. ถ้ากำลังเปิดหน้าดูขั้นตอนคำร้องย้อนหลัง (screen-history-detail)
      if (currentView === 'history-detail' && currentViewingRequestId) {
        viewRequestDetail(currentViewingRequestId);
      }

      // 2. ถ้ากำลังเปิดหน้าสถานะปัจจุบัน (screen-status)
      if (currentView === 'status') {
        renderStatusPage();
      }

      // 3. ถ้าอยู่ในหน้าหลัก (screen-home)
      if (currentView === 'home') {
        if (user.role === 'student') {
          renderHomeStatusCard();
        } else {
          renderApproverHomeDashboard();
        }
      }

      // 4. ถ้าอยู่ในหน้ารายการพิจารณาอนุมัติ (screen-approval)
      if (currentView === 'approval') {
        renderApprovalCards();
      }

      // 5. ถ้าอยู่ในหน้าประวัติคำร้อง (screen-history)
      if (currentView === 'history') {
        renderStudentHistory();
      }
    }
  } catch (err) {
    // silent catch
  } finally {
    isSyncingRealtime = false;
  }
}

// ====================== 1. VIEW SWITCHER ======================
function handleMiddleTabClick() {
  const user = getCurrentUser();
  if (user && user.role !== 'student') {
    setViewMode('approval');
  } else {
    setViewMode('history');
  }
}

function setViewMode(mode) {
  const u = getCurrentUser();

  // 0. สำหรับบัญชี Admin ให้แสดงเฉพาะหน้า Admin Panel เท่านั้นตามที่กำหนด
  if (u && u.role === 'admin') {
    mode = 'admin';
  }

  // 1. ป้องกันนักเรียนเข้าถึงหน้าสถิติ
  if (mode === 'stats' && u && u.role === 'student') {
    setViewMode('home');
    return;
  }

  // 2. ป้องกันผู้ที่ไม่ใช่ Admin เข้าถึงหน้า Admin Panel
  if (mode === 'admin' && (!u || u.role !== 'admin')) {
    setViewMode('home');
    return;
  }

  // 3. ป้องกันนักเรียนเข้าถึงหน้าการอนุมัติ
  if (mode === 'approval' && u && u.role === 'student') {
    setViewMode('history');
    return;
  }

  currentView = mode;

  // ซ่อนทุกหน้า
  const screens = ['screen-home', 'screen-status', 'screen-workflow', 'screen-history', 'screen-history-detail', 'screen-approval', 'screen-form', 'screen-qr', 'screen-stats', 'screen-profile', 'screen-admin'];
  screens.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });

  // สลับแถบเมนูด้านล่าง (หน้าหลัก, ประวัติคำร้อง/การอนุมัติ, สถิติ, โปรไฟล์, จัดการระบบ)
  const bottomTabs = [
    { key: 'home', navId: 'bottom-nav-home', pillId: 'bottom-pill-home', matches: ['home'] },
    { key: 'history', navId: 'bottom-nav-history', pillId: 'bottom-pill-history', matches: ['history', 'history-detail', 'approval'] },
    { key: 'stats', navId: 'bottom-nav-stats', pillId: 'bottom-pill-stats', matches: ['stats'] },
    { key: 'profile', navId: 'bottom-nav-profile', pillId: 'bottom-pill-profile', matches: ['profile'] },
    { key: 'admin', navId: 'bottom-nav-admin', pillId: 'bottom-pill-admin', matches: ['admin'] }
  ];

  bottomTabs.forEach(tab => {
    const bNav = document.getElementById(tab.navId);
    const bPill = document.getElementById(tab.pillId);
    if (bNav && bPill) {
      const bText = bNav.querySelector('span');
      const bIcon = bPill.querySelector('i');
      const isActive = tab.matches.includes(mode);

      if (isActive) {
        bNav.classList.add('text-[#0d55cf]', 'font-bold');
        bNav.classList.remove('text-slate-400', 'hover:text-slate-600', 'font-medium');
        bPill.className = 'w-12 h-7 rounded-full bg-blue-50 text-[#0d55cf] flex items-center justify-center shadow-xs transition-all duration-200 relative';
        if (bText) {
          bText.classList.add('font-bold', 'text-[#0d55cf]');
          bText.classList.remove('font-medium', 'text-slate-400');
        }
        if (bIcon) {
          bIcon.classList.add('scale-105', 'text-[#0d55cf]');
          bIcon.classList.remove('scale-100', 'text-slate-400');
        }
      } else {
        bNav.classList.remove('text-[#0d55cf]', 'font-bold');
        bNav.classList.add('text-slate-400', 'hover:text-slate-600', 'font-medium');
        bPill.className = 'w-12 h-7 rounded-full bg-transparent flex items-center justify-center transition-all duration-200 relative';
        if (bText) {
          bText.classList.remove('font-bold', 'text-[#0d55cf]');
          bText.classList.add('font-medium', 'text-slate-400');
        }
        if (bIcon) {
          bIcon.classList.remove('scale-105', 'text-[#0d55cf]');
          bIcon.classList.add('scale-100', 'text-slate-400');
        }
      }
    }
  });

  // ล็อคและรักษาสิทธิ์การแสดง/ซ่อนแท็บเมนูล่างตาม Role เสมอ 100% ทุกครั้งที่มีการเปลี่ยนหน้า
  updateBottomNavVisibility(u);

  // แถบเมนูด้านล่างแสดงตลอดทุกหน้าหลัง Login (ตามคำขอ - ไม่ซ่อนแม้แต่หน้าฟอร์ม/Admin)
  const mobileBottomNav = document.getElementById('mobile-bottom-nav');
  if (mobileBottomNav) {
    mobileBottomNav.classList.remove('hidden');
  }

  // หยุด Timer หมุนเวียน QR เมื่อสลับไปหน้าอื่น
  if (mode !== 'qr') {
    stopRotatingQrTimer();
  }

  // แสดงหน้าจอที่เลือก
  if (mode === 'home') {
    const screenHome = document.getElementById('screen-home');
    if (screenHome) screenHome.classList.remove('hidden');
    applySchoolSettingsUI();
    const user = getCurrentUser();
    if (user && user.role !== 'student') {
      updateGradeFilterButtonsUI();
      renderApproverHomeDashboard();
    } else {
      renderHomeStatusCard();
    }
  } else if (mode === 'status' || mode === 'workflow') {
    const screenStatus = document.getElementById('screen-status') || document.getElementById('screen-workflow');
    if (screenStatus) screenStatus.classList.remove('hidden');
    renderStatusPage();
  } else if (mode === 'history') {
    const screenHistory = document.getElementById('screen-history');
    if (screenHistory) screenHistory.classList.remove('hidden');
    renderStudentHistory();
  } else if (mode === 'history-detail') {
    const screenHistoryDetail = document.getElementById('screen-history-detail');
    if (screenHistoryDetail) screenHistoryDetail.classList.remove('hidden');
  } else if (mode === 'approval') {
    const screenApproval = document.getElementById('screen-approval');
    if (screenApproval) screenApproval.classList.remove('hidden');
    updateGradeFilterButtonsUI();
    renderApprovalDashboard();
  } else if (mode === 'form') {
    const user = getCurrentUser();
    if (user && user.role === 'student') {
      const check = checkProfileComplete(user);
      if (!check.complete) {
        showProfileIncompleteNotice(check.missing);
        return;
      }
    }
    const screenForm = document.getElementById('screen-form');
    if (screenForm) screenForm.classList.remove('hidden');
    populateFormWithUserProfile(user);
    initLeaveDatePicker();
    restoreLeaveDraft();
    initLeaveDraftAutoSave();
    if (typeof checkStudentTimetablePreview === 'function') {
      checkStudentTimetablePreview();
    }
  } else if (mode === 'qr') {
    const screenQr = document.getElementById('screen-qr');
    if (screenQr) screenQr.classList.remove('hidden');
    renderQrPassScreen();
  } else if (mode === 'stats') {
    const screenStats = document.getElementById('screen-stats');
    if (screenStats) screenStats.classList.remove('hidden');
    loadAndRenderStatsDashboard();
  } else if (mode === 'profile') {
    const screenProfile = document.getElementById('screen-profile');
    if (screenProfile) screenProfile.classList.remove('hidden');
    updateProfileStats();
  } else if (mode === 'admin') {
    const screenAdmin = document.getElementById('screen-admin');
    if (screenAdmin) screenAdmin.classList.remove('hidden');
    initAdminPanel();
  }

  // ปรับความกว้างของหน้าจออัตโนมัติ: ถ้าเป็นหน้า Admin ให้ขยายกว้าง (max-w-6xl) เพื่อความสบายตาในการใช้งานแบบ Sidebar
  const mainContainer = document.getElementById('main-container') || document.querySelector('main');
  const headerInner = document.getElementById('header-inner');
  if (mainContainer) {
    if (mode === 'admin') {
      mainContainer.classList.remove('max-w-3xl');
      mainContainer.classList.add('max-w-6xl');
    } else {
      mainContainer.classList.remove('max-w-6xl');
      mainContainer.classList.add('max-w-3xl');
    }
  }
  if (headerInner) {
    if (mode === 'admin') {
      headerInner.classList.remove('max-w-4xl');
      headerInner.classList.add('max-w-6xl');
    } else {
      headerInner.classList.remove('max-w-6xl');
      headerInner.classList.add('max-w-4xl');
    }
  }

  // เลื่อนกลับขึ้นบนสุดอัตโนมัติเมื่อเปลี่ยนหน้า
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ====================== PROFILE EDITING & PHOTO UPLOAD ======================
let tempProfilePhoto = null;
let tempPlatePhoto = null;

function populateFormWithUserProfile(user) {
  if (!user) user = getCurrentUser();
  const formName = document.getElementById('form-name');
  const formCode = document.getElementById('form-code');
  const formDept = document.getElementById('form-dept');
  const formClassroom = document.getElementById('form-classroom');
  const formPlate = document.getElementById('form-plate');

  if (formName) formName.value = user.full_name || 'นายเอ';
  let cleanCode = (user.student_code && !user.student_code.includes('@')) 
    ? user.student_code 
    : (user.code || '68319100006');
  if (formCode) formCode.value = cleanCode;
  if (formPlate) formPlate.value = user.plate || user.plate_no || '';
  
  // ผูกแผนกวิชาและชั้นปีให้ตรงกับโปรไฟล์นักเรียนเสมอ 100%
  const currentDept = user.dept || (user.departments ? user.departments.name : 'แผนกวิชาช่างไฟฟ้า (ปวช.3)');
  let resolvedDept = currentDept;
  let resolvedClassroom = user.classroom || (user.classrooms ? user.classrooms.name : '');
  if (!resolvedClassroom && currentDept.includes('(')) {
    const parts = currentDept.split('(');
    resolvedDept = parts[0].trim();
    resolvedClassroom = parts[1].replace(')', '').trim();
  }
  if (!resolvedClassroom) resolvedClassroom = 'ปวช.3';

  if (formDept) formDept.value = resolvedDept;
  if (formClassroom) formClassroom.value = resolvedClassroom;

  const formParentPhone = document.getElementById('form-parent-phone');
  if (formParentPhone && user.parent_phone) {
    formParentPhone.value = user.parent_phone;
  }

  // รีเซ็ตค่าเวลาเริ่มต้นเป็น 00:00 น. ทุกครั้งที่เปิดฟอร์ม (บังคับให้นักเรียนต้องกดเลือกเวลาจริง)
  const depInput = document.getElementById('form-dep-time');
  const retInput = document.getElementById('form-ret-time');
  const depDisp = document.getElementById('display-dep-time');
  const retDisp = document.getElementById('display-ret-time');
  if (depInput) depInput.value = '00:00';
  if (retInput) retInput.value = '00:00';
  if (depDisp) {
    depDisp.textContent = '00:00 น.';
    depDisp.className = 'text-base font-bold text-slate-400';
  }
  if (retDisp) {
    retDisp.textContent = '00:00 น.';
    retDisp.className = 'text-base font-bold text-slate-400';
  }
}

function compressAndReadImage(file, maxDimension = 800, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('ไม่ได้เลือกไฟล์'));
    
    // ตรวจสอบว่าเป็นรูปภาพ (รองรับทั้ง MIME type และนามสกุลไฟล์บนมือถือ)
    const isImage = (file.type && file.type.startsWith('image/')) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name || '') || file.type === '';
    if (!isImage) return reject(new Error('กรุณาเลือกไฟล์รูปภาพ (JPG, PNG)'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('ไม่สามารถประมวลผลไฟล์รูปภาพนี้ได้'));
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleProfilePhotoSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const dataUrl = await compressAndReadImage(file, 600, 0.85);
    tempProfilePhoto = dataUrl;
    const preview = document.getElementById('preview-edit-profile-photo');
    if (preview) {
      preview.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover rounded-2xl" alt="Preview Profile">`;
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการโหลดรูปโปรไฟล์: ' + err.message);
  }
}

async function handlePlatePhotoSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const dataUrl = await compressAndReadImage(file, 800, 0.85);
    tempPlatePhoto = dataUrl;
    const preview = document.getElementById('preview-edit-plate-photo');
    if (preview) {
      preview.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover rounded-2xl" alt="Preview Plate">`;
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการโหลดรูปป้ายทะเบียน: ' + err.message);
  }
}

function openEditProfileModal(focusTab) {
  const user = getCurrentUser();
  const modal = document.getElementById('modal-edit-profile');
  if (!modal) return;

  // เติมข้อมูลลงในฟอร์ม
  const nameInput = document.getElementById('modal-edit-name');
  const codeInput = document.getElementById('modal-edit-student-code');
  const deptInput = document.getElementById('modal-edit-dept');
  const advisorInput = document.getElementById('modal-edit-advisor');
  const plateInput = document.getElementById('modal-edit-plate');
  const phoneInput = document.getElementById('modal-edit-phone');
  const parentPhoneInput = document.getElementById('modal-edit-parent-phone');
  const collegeInput = document.getElementById('modal-edit-college');

  if (nameInput) nameInput.value = user.full_name || '';
  if (codeInput) {
    const rawCode = user.student_code || '';
    if (rawCode && !rawCode.includes('@')) {
      codeInput.value = rawCode;
    } else if (user.username === 'student') {
      codeInput.value = '66209010012';
    } else {
      codeInput.value = '';
    }
  }
  if (deptInput) deptInput.value = user.dept || '';
  const deptDisplay = document.getElementById('modal-edit-dept-display');
  if (deptDisplay) deptDisplay.value = user.dept || (user.departments ? user.departments.name : '-');
  const classroomDisplay = document.getElementById('modal-edit-classroom-display');
  const classVal = user.classroom || (user.classrooms ? user.classrooms.name : (user.curriculum_level ? `${user.curriculum_level}${user.class_year || 1}/${user.room_number || 1}` : '-'));
  if (classroomDisplay) classroomDisplay.value = classVal || '-';
  if (advisorInput) advisorInput.value = user.advisor_name || user.advisor || (user.classrooms ? user.classrooms.advisor_name : '-');
  if (plateInput) plateInput.value = user.plate || '';
  if (phoneInput) phoneInput.value = user.phone || '';
  if (parentPhoneInput) parentPhoneInput.value = user.parent_phone || '';
  if (collegeInput) collegeInput.value = user.college || 'วิทยาลัยการอาชีพองครักษ์';

  // ตั้งค่า แผนกวิชา และ ระดับชั้น ใน Dropdown
  const deptSelect = document.getElementById('modal-edit-dept-select');
  const levelSelect = document.getElementById('modal-edit-level-select');
  
  let currentDept = user.department || '';
  let currentLevel = user.classroom || '';
  
  if (user.dept) {
    for (const key of Object.keys(DEPARTMENTS_DATA)) {
      const shortKey = key.replace('แผนกวิชา', '').trim();
      if (user.dept.includes(shortKey)) {
        currentDept = key;
        break;
      }
    }
    const levelMatch = user.dept.match(/(ปวช\.[1-3]|ปวส\.[1-2])/);
    if (levelMatch) {
      currentLevel = levelMatch[1];
    }
  }
  
  if (deptSelect) deptSelect.value = currentDept || 'แผนกวิชาช่างยนต์';
  if (levelSelect) levelSelect.value = currentLevel || 'ปวช.3';
  onModalDeptChange();

  // เตรียมรูป Preview
  tempProfilePhoto = user.profile_photo || null;
  tempPlatePhoto = user.plate_photo || null;

  const profPreview = document.getElementById('preview-edit-profile-photo');
  if (profPreview) {
    if (tempProfilePhoto) {
      profPreview.innerHTML = `<img src="${tempProfilePhoto}" class="w-full h-full object-cover rounded-2xl" alt="Profile">`;
    } else {
      profPreview.innerHTML = `<i class="fa-solid fa-user-graduate text-3xl text-blue-400"></i>`;
    }
  }

  const platePreview = document.getElementById('preview-edit-plate-photo');
  if (platePreview) {
    if (tempPlatePhoto) {
      platePreview.innerHTML = `<img src="${tempPlatePhoto}" class="w-full h-full object-cover rounded-2xl" alt="Plate">`;
    } else {
      platePreview.innerHTML = `<i class="fa-solid fa-camera text-3xl text-blue-400"></i>`;
    }
  }

  // ซ่อนฟิลด์ผู้ปกครอง/ครูที่ปรึกษา ถ้าไม่ใช่บทบาทนักเรียน
  const advisorGrp = document.getElementById('modal-edit-advisor-group');
  const parentGrp = document.getElementById('modal-edit-parent-phone-group');
  if (user.role !== 'student') {
    if (advisorGrp) advisorGrp.classList.add('hidden');
    if (parentGrp) parentGrp.classList.add('hidden');
  } else {
    if (advisorGrp) advisorGrp.classList.remove('hidden');
    if (parentGrp) parentGrp.classList.remove('hidden');
  }

  modal.classList.remove('hidden');

  if (focusTab === 'avatar') {
    const input = document.getElementById('input-edit-profile-photo');
    if (input) input.click();
  } else if (focusTab === 'plate') {
    const input = document.getElementById('input-edit-plate-photo');
    if (input) input.click();
  }
}

function closeEditProfileModal() {
  const modal = document.getElementById('modal-edit-profile');
  if (modal) modal.classList.add('hidden');
}

async function saveProfileChanges() {
  const user = getCurrentUser();
  const nameInput = document.getElementById('modal-edit-name');
  const codeInput = document.getElementById('modal-edit-student-code');
  const deptInput = document.getElementById('modal-edit-dept');
  const advisorInput = document.getElementById('modal-edit-advisor');
  const plateInput = document.getElementById('modal-edit-plate');
  const phoneInput = document.getElementById('modal-edit-phone');
  const parentPhoneInput = document.getElementById('modal-edit-parent-phone');
  const collegeInput = document.getElementById('modal-edit-college');

  const name = nameInput ? nameInput.value.trim() : '';
  const studentCode = codeInput ? codeInput.value.trim() : '';
  const dept = deptInput ? deptInput.value.trim() : '';
  const advisor = advisorInput ? advisorInput.value.trim() : '';
  const plate = plateInput ? plateInput.value.trim() : '';
  const phone = phoneInput ? phoneInput.value.trim() : '';
  const parentPhone = parentPhoneInput ? parentPhoneInput.value.trim() : '';
  const college = collegeInput ? collegeInput.value.trim() : 'วิทยาลัยการอาชีพองครักษ์';

  // อัปเดตข้อมูลผู้ใช้ (เฉพาะฟิลด์ที่ผู้เรียนกรอกเพิ่มเติม)
  user.plate = plate;
  user.phone = phone;
  user.parent_phone = parentPhone;
  user.college = college;

  if (tempProfilePhoto !== null) {
    user.profile_photo = tempProfilePhoto;
  }
  if (tempPlatePhoto !== null) {
    user.plate_photo = tempPlatePhoto;
  }

  // บันทึกลง LocalStorage
  localStorage.setItem('onepass_current_user', JSON.stringify(user));
  if (KNOWN_USERS[user.username]) {
    KNOWN_USERS[user.username] = { ...KNOWN_USERS[user.username], ...user };
  }

  // ปิด Modal และอัปเดตหน้าจอทันที
  closeEditProfileModal();
  applyCurrentUserUI(user);
  populateFormWithUserProfile(user);

  // ส่งข้อมูลไปบันทึกและอัปเดตลงฐานข้อมูล Supabase Cloud โดยตรง
  try {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: user.username,
        full_name: user.full_name,
        student_code: user.student_code,
        dept: user.dept,
        advisor: user.advisor,
        plate: user.plate,
        phone: user.phone,
        parent_phone: user.parent_phone,
        college: user.college,
        profile_photo: user.profile_photo || '',
        plate_photo: user.plate_photo || ''
      })
    });
    const result = await res.json();
    if (result && result.success) {
      alert('✅ บันทึกข้อมูลและซิงค์ลงฐานข้อมูล Supabase สำเร็จเรียบร้อย!');
    } else {
      alert('✅ บันทึกข้อมูลเรียบร้อยแล้ว');
    }
  } catch (e) {
    alert('✅ บันทึกข้อมูลเรียบร้อยแล้ว');
  }
}

// ====================== PROFILE GATE & DUPLICATE REQUEST CHECK ======================
function tryOpenLeaveForm() {
  const user = getCurrentUser();
  if (user && user.role === 'student') {
    // 1. ตรวจสอบว่ามีคำร้องเดิมที่ยังใช้งานอยู่หรือไม่ (ยังไม่หมดเวลา และยังไม่ได้สแกนกลับเข้า)
    const activeReq = getStudentActiveRequest(user);
    if (activeReq) {
      const reqNo = activeReq.requestNo || 'OP-2569XXXX';
      const timeRange = (activeReq.departureTime && activeReq.expectedReturnTime)
        ? ` (${activeReq.departureTime} - ${activeReq.expectedReturnTime} น.)`
        : '';
      alert(`⚠️ ไม่สามารถยื่นคำร้องซ้ำได้\n\nคุณมีคำร้องขออนุญาตที่กำลังใช้งานอยู่ (${reqNo})${timeRange}\nระบบจะอนุญาตให้ยื่นคำร้องใหม่ได้หลังจากหมดเวลาออกนอกสถานศึกษา หรือสแกนกลับเข้าสถานศึกษาเรียบร้อยแล้ว`);
      // ไม่อัตโนมัติสลับหน้า ให้นักเรียนอยู่หน้าเดิมตามต้องการ
      return;
    }

    // 2. ตรวจสอบความครบถ้วนของข้อมูลโปรไฟล์
    const check = checkProfileComplete(user);
    if (!check.complete) {
      showProfileIncompleteNotice(check.missing);
      return;
    }
  }
  populateFormWithUserProfile(user);
  setViewMode('form');
}

function showProfileIncompleteNotice(missingList) {
  const modal = document.getElementById('modal-profile-incomplete');
  const listEl = document.getElementById('incomplete-items-list');
  if (!modal || !listEl) {
    alert('กรุณากรอกข้อมูลส่วนตัวและแนบรูปถ่ายให้ครบถ้วนก่อนยื่นคำร้อง\nขาดข้อมูล: ' + missingList.join(', '));
    setViewMode('profile');
    openEditProfileModal();
    return;
  }

  listEl.innerHTML = missingList.map(item => `
    <li class="flex items-center gap-2">
      <span class="text-rose-500 font-bold">✕</span>
      <span>${item}</span>
    </li>
  `).join('');

  modal.classList.remove('hidden');
}

function closeProfileIncompleteModal() {
  const modal = document.getElementById('modal-profile-incomplete');
  if (modal) modal.classList.add('hidden');
}

function goToProfileToComplete() {
  closeProfileIncompleteModal();
  setViewMode('profile');
  setTimeout(() => {
    openEditProfileModal();
  }, 150);
}

// ====================== FULLSCREEN PHOTO MODAL ======================
function viewPhotoFullscreen(imgSrc) {
  if (!imgSrc) return;
  const modal = document.getElementById('modal-fullscreen-photo');
  const imgEl = document.getElementById('fullscreen-photo-img');
  if (modal && imgEl) {
    imgEl.src = imgSrc;
    modal.classList.remove('hidden');
  }
}

function closeFullscreenPhoto() {
  const modal = document.getElementById('modal-fullscreen-photo');
  if (modal) modal.classList.add('hidden');
}

// ====================== 1.1 APPROVAL DASHBOARD (สำหรับ อาจารย์, หัวหน้าแผนก, งานปกครอง) ======================
let currentApprovalTab = 'pending'; // 'pending' | 'history'
let selectedApprovalGrades = ['all']; // รองรับเลือกหลายชั้นปี เช่น ['ปวช.1', 'ปวส.1'] หรือ ['all']
let selectedApprovalGradeFilter = 'all'; // สำหรับ backward compatibility
let allRequestsList = [];

// ค้นหาชั้นปีที่อาจารย์เป็นที่ปรึกษาจากโปรไฟล์
function getTeacherProfileGrade(user) {
  if (!user) user = getCurrentUser();
  if (!user) return 'all';
  const validGrades = ['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'];
  let grade = user.classroom || '';
  if (!grade && user.dept && user.dept.includes('(')) {
    grade = user.dept.split('(')[1].replace(')', '').trim();
  }
  if (user.role === 'advisor' && validGrades.includes(grade)) {
    return grade;
  }
  return 'all';
}

// ตั้งค่าตัวกรองเริ่มต้นตามโปรไฟล์ของอาจารย์
function initTeacherGradeFilter(user) {
  const def = getTeacherProfileGrade(user);
  if (def && def !== 'all') {
    selectedApprovalGrades = [def];
    selectedApprovalGradeFilter = def;
  } else {
    selectedApprovalGrades = ['all'];
    selectedApprovalGradeFilter = 'all';
  }
}

// ตรวจสอบว่าคำร้องตรงกับชั้นปีที่เลือกไว้ (รองรับเลือกหลายชั้นปีพร้อมกัน)
function isClassroomMatch(reqClassroom, targetGrades) {
  if (!targetGrades) targetGrades = selectedApprovalGrades;
  if (typeof targetGrades === 'string') {
    if (targetGrades === 'all') return true;
    targetGrades = [targetGrades];
  }
  if (!Array.isArray(targetGrades) || targetGrades.length === 0 || targetGrades.includes('all')) {
    return true;
  }
  const cleanR = String(reqClassroom || 'ปวช.3').trim();
  return targetGrades.some(g => {
    const cleanG = String(g).trim();
    return cleanR.includes(cleanG) || cleanG.includes(cleanR);
  });
}

// สลับเลือก/ยกเลิกเลือกชั้นปี (Multi-Select)
function toggleGradeSelection(grade) {
  if (grade === 'all') {
    selectedApprovalGrades = ['all'];
  } else {
    // ถ้าเคยเลือกทั้งหมดไว้ ให้เริ่มนับเฉพาะชั้นที่จิ้ม
    if (selectedApprovalGrades.includes('all')) {
      selectedApprovalGrades = [grade];
    } else if (selectedApprovalGrades.includes(grade)) {
      // ยกเลิกเลือก
      selectedApprovalGrades = selectedApprovalGrades.filter(g => g !== grade);
      if (selectedApprovalGrades.length === 0) {
        selectedApprovalGrades = ['all'];
      }
    } else {
      // เลือกเพิ่ม
      selectedApprovalGrades.push(grade);
      const allFive = ['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'];
      if (allFive.every(g => selectedApprovalGrades.includes(g))) {
        selectedApprovalGrades = ['all'];
      }
    }
  }

  selectedApprovalGradeFilter = selectedApprovalGrades.includes('all') ? 'all' : (selectedApprovalGrades[0] || 'all');
  updateGradeFilterDropdownUI();
  renderApprovalCards();
  renderApproverHomeDashboard();
}

function selectAllGrades() {
  selectedApprovalGrades = ['all'];
  selectedApprovalGradeFilter = 'all';
  updateGradeFilterDropdownUI();
  renderApprovalCards();
  renderApproverHomeDashboard();
}

function resetToTeacherDefaultGrade() {
  const u = getCurrentUser();
  const def = getTeacherProfileGrade(u);
  selectedApprovalGrades = (def && def !== 'all') ? [def] : ['all'];
  selectedApprovalGradeFilter = selectedApprovalGrades[0];
  updateGradeFilterDropdownUI();
  renderApprovalCards();
  renderApproverHomeDashboard();
}

function toggleGradeDropdown(target) {
  const homeMenu = document.getElementById('home-grade-dropdown-menu');
  const appMenu = document.getElementById('approval-grade-dropdown-menu');
  const homeChev = document.getElementById('home-grade-filter-chevron');
  const appChev = document.getElementById('approval-grade-filter-chevron');

  if (target === 'home') {
    if (homeMenu) {
      const isHidden = homeMenu.classList.contains('hidden');
      closeGradeDropdowns();
      if (isHidden) {
        homeMenu.classList.remove('hidden');
        homeChev?.classList.add('rotate-180');
      }
    }
  } else {
    if (appMenu) {
      const isHidden = appMenu.classList.contains('hidden');
      closeGradeDropdowns();
      if (isHidden) {
        appMenu.classList.remove('hidden');
        appChev?.classList.add('rotate-180');
      }
    }
  }
}

function closeGradeDropdowns() {
  document.getElementById('home-grade-dropdown-menu')?.classList.add('hidden');
  document.getElementById('approval-grade-dropdown-menu')?.classList.add('hidden');
  document.getElementById('home-grade-filter-chevron')?.classList.remove('rotate-180');
  document.getElementById('approval-grade-filter-chevron')?.classList.remove('rotate-180');
}

// อัปเดตรายการตัวเลือกและป้ายแสดงใน Dropdown
function updateGradeFilterDropdownUI() {
  const user = getCurrentUser();
  if (!user) return;

  // ดึงรายการคำร้องที่รอการอนุมัติในขั้นตอนนี้
  const basePending = (typeof allRequestsList !== 'undefined' && Array.isArray(allRequestsList))
    ? allRequestsList.filter(r => isRequestInApproverQueue(user, r, typeof isDelegateApprovalMode !== 'undefined' && isDelegateApprovalMode))
    : [];

  const gradeList = ['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'];
  const gradeCounts = {};
  gradeCounts['all'] = basePending.length;
  gradeList.forEach(g => {
    gradeCounts[g] = basePending.filter(r => {
      const cleanR = String(r.classroomName || 'ปวช.3').trim();
      return cleanR.includes(g) || g.includes(cleanR);
    }).length;
  });

  const isAll = selectedApprovalGrades.includes('all') || selectedApprovalGrades.length === 0;

  // ข้อความแสดงบนปุ่ม Trigger
  let labelText = 'ทั้งหมด';
  if (!isAll) {
    if (selectedApprovalGrades.length <= 2) {
      labelText = selectedApprovalGrades.join(', ');
    } else {
      labelText = `${selectedApprovalGrades.slice(0, 2).join(', ')} +${selectedApprovalGrades.length - 2}`;
    }
  }

  // จำนวนคำร้องตามตัวกรองที่เลือก
  const matchedPending = isAll
    ? basePending.length
    : basePending.filter(r => isClassroomMatch(r.classroomName, selectedApprovalGrades)).length;

  const fullDisplayLabel = `${labelText} (${matchedPending})`;

  const homeLabel = document.getElementById('home-grade-filter-label');
  const appLabel = document.getElementById('approval-grade-filter-label');
  if (homeLabel) homeLabel.textContent = fullDisplayLabel;
  if (appLabel) appLabel.textContent = fullDisplayLabel;

  // สร้างเนื้อหาตัวเลือก Dropdown
  const optionsHtml = `
    <!-- ตัวเลือกทั้งหมด -->
    <label class="flex items-center justify-between px-2.5 py-1.5 rounded-xl hover:bg-slate-50 cursor-pointer select-none transition ${isAll ? 'bg-blue-50/70 font-bold text-[#0d55cf]' : 'text-slate-700 font-medium'}">
      <div class="flex items-center gap-2">
        <input type="checkbox" ${isAll ? 'checked' : ''} onchange="toggleGradeSelection('all')" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300">
        <span class="text-xs">ทั้งหมด</span>
      </div>
      <span class="text-[11px] font-mono px-1.5 py-0.5 rounded-md ${gradeCounts['all'] > 0 ? 'bg-amber-100 text-amber-800 font-bold' : 'text-slate-400 bg-slate-100'}">
        ${gradeCounts['all']}
      </span>
    </label>

    ${gradeList.map(g => {
      const isChecked = isAll || selectedApprovalGrades.includes(g);
      const count = gradeCounts[g] || 0;
      const isHighlighted = selectedApprovalGrades.includes(g) && !isAll;
      return `
        <label class="flex items-center justify-between px-2.5 py-1.5 rounded-xl hover:bg-slate-50 cursor-pointer select-none transition ${isHighlighted ? 'bg-blue-50/70 font-bold text-[#0d55cf]' : 'text-slate-700 font-medium'}">
          <div class="flex items-center gap-2">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleGradeSelection('${g}')" class="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300">
            <span class="text-xs">${g}</span>
          </div>
          <span class="text-[11px] font-mono px-1.5 py-0.5 rounded-md ${count > 0 ? 'bg-amber-100 text-amber-800 font-bold' : 'text-slate-400 bg-slate-100'}">
            ${count}
          </span>
        </label>
      `;
    }).join('')}
  `;

  const homeList = document.getElementById('home-grade-options-list');
  const appList = document.getElementById('approval-grade-options-list');
  if (homeList) homeList.innerHTML = optionsHtml;
  if (appList) appList.innerHTML = optionsHtml;
}

// ฟังก์ชันดั้งเดิมสำหรับ backward compatibility
function setApprovalGradeFilter(grade) {
  toggleGradeSelection(grade);
}

function updateGradeFilterButtonsUI() {
  updateGradeFilterDropdownUI();
}

let isDelegateApprovalMode = false;

function toggleDelegateApprovalMode() {
  isDelegateApprovalMode = !isDelegateApprovalMode;
  const btn = document.getElementById('btn-toggle-delegate-mode');
  if (btn) {
    if (isDelegateApprovalMode) {
      btn.className = 'px-3 py-1 rounded-xl bg-amber-400 text-slate-900 font-bold text-xs shadow-sm transition flex items-center gap-1.5';
      btn.innerHTML = '<i class="fa-solid fa-user-check"></i> โหมดอนุมัติแทน: เปิดอยู่';
    } else {
      btn.className = 'px-3 py-1 rounded-xl bg-white/15 hover:bg-white/25 text-white font-medium text-xs transition flex items-center gap-1.5 border border-white/20';
      btn.innerHTML = '<i class="fa-solid fa-user-clock"></i> อนุมัติแทนครูไม่อยู่';
    }
  }
  renderApprovalCards();
  renderApproverHomeDashboard();
}

function setApprovalTab(tab) {
  currentApprovalTab = tab;
  const tabPending = document.getElementById('tab-btn-pending');
  const tabHistory = document.getElementById('tab-btn-history');

  if (tab === 'pending') {
    if (tabPending) tabPending.className = 'px-3 py-1 rounded-xl bg-white text-blue-900 font-bold shadow-sm transition';
    if (tabHistory) tabHistory.className = 'px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium transition';
  } else {
    if (tabPending) tabPending.className = 'px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium transition';
    if (tabHistory) tabHistory.className = 'px-3 py-1 rounded-xl bg-white text-blue-900 font-bold shadow-sm transition';
  }
  renderApprovalCards();
}

async function refreshApprovalList() {
  await fetchActiveRequest();
  await renderApprovalDashboard();
}

async function renderApprovalDashboard() {
  const user = getCurrentUser();
  const roleIcon = document.getElementById('approval-role-icon');
  const pageTitle = document.getElementById('approval-page-title');
  const pageSubtitle = document.getElementById('approval-page-subtitle');
  const roleChip = document.getElementById('approval-role-chip');
  const headerCard = document.getElementById('approval-header-card');

  // ปรับแต่ง Header ตาม Role ของผู้อนุมัติทั้ง 5 ขั้น
  if (user.role === 'subject_teacher') {
    if (headerCard) headerCard.className = 'bg-gradient-to-r from-sky-700 via-blue-700 to-sky-800 text-white rounded-3xl p-5 shadow-sm space-y-2';
    if (roleIcon) roleIcon.innerHTML = '<i class="fa-solid fa-book-open-reader"></i>';
    if (pageTitle) pageTitle.textContent = 'รายการคำร้องรอครูรายวิชาอนุมัติ';
    if (pageSubtitle) pageSubtitle.textContent = `ครูรายวิชา (${user.full_name}): อนุญาตให้นักเรียนออกระหว่างคาบเรียน`;
    if (roleChip) {
      roleChip.textContent = 'ขั้นตอนที่ 1/5 (ครูรายวิชา)';
      roleChip.className = 'text-[10px] bg-sky-500/30 px-2.5 py-0.5 rounded-full border border-sky-300/40 font-semibold text-sky-100';
    }
  } else if (user.role === 'advisor') {
    if (headerCard) headerCard.className = 'bg-gradient-to-r from-emerald-700 via-teal-700 to-emerald-800 text-white rounded-3xl p-5 shadow-sm space-y-2';
    if (roleIcon) roleIcon.innerHTML = '<i class="fa-solid fa-chalkboard-user"></i>';
    if (pageTitle) pageTitle.textContent = 'รายการคำร้องรอครูที่ปรึกษาพิจารณา';
    if (pageSubtitle) pageSubtitle.textContent = `ครูที่ปรึกษา (${user.full_name}): ตรวจสอบความถูกต้องและลงนามเห็นชอบ`;
    if (roleChip) {
      roleChip.textContent = 'ขั้นตอนที่ 2/5 (ครูที่ปรึกษา)';
      roleChip.className = 'text-[10px] bg-emerald-500/30 px-2.5 py-0.5 rounded-full border border-emerald-400/40 font-semibold text-emerald-100';
    }
  } else if (user.role === 'dept_head') {
    if (headerCard) headerCard.className = 'bg-gradient-to-r from-amber-700 via-orange-700 to-amber-800 text-white rounded-3xl p-5 shadow-sm space-y-2';
    if (roleIcon) roleIcon.innerHTML = '<i class="fa-solid fa-building-columns"></i>';
    if (pageTitle) pageTitle.textContent = 'รายการคำร้องรอหัวหน้าแผนกพิจารณา';
    if (pageSubtitle) pageSubtitle.textContent = `หัวหน้าแผนกวิชา (${user.full_name}): พิจารณาอนุมัติคำร้องในแผนก`;
    if (roleChip) {
      roleChip.textContent = 'ขั้นตอนที่ 3/5 (หัวหน้าแผนกวิชา)';
      roleChip.className = 'text-[10px] bg-amber-500/30 px-2.5 py-0.5 rounded-full border border-amber-400/40 font-semibold text-amber-100';
    }
  } else if (user.role === 'discipline_head') {
    if (headerCard) headerCard.className = 'bg-gradient-to-r from-purple-800 via-indigo-800 to-purple-900 text-white rounded-3xl p-5 shadow-sm space-y-2';
    if (roleIcon) roleIcon.innerHTML = '<i class="fa-solid fa-shield-halved"></i>';
    if (pageTitle) pageTitle.textContent = 'รายการคำร้องรอฝ่ายปกครองอนุมัติ';
    if (pageSubtitle) pageSubtitle.textContent = `ฝ่ายปกครอง (${user.full_name}): ตรวจสอบระเบียบวินัย (สามารถข้ามขั้นฉุกเฉินได้)`;
    if (roleChip) {
      roleChip.textContent = 'ขั้นตอนที่ 4/5 (ฝ่ายปกครอง)';
      roleChip.className = 'text-[10px] bg-purple-500/30 px-2.5 py-0.5 rounded-full border border-purple-400/40 font-semibold text-purple-100';
    }
  } else {
    // deputy_director หรือ admin
    if (headerCard) headerCard.className = 'bg-gradient-to-r from-indigo-900 via-blue-900 to-slate-900 text-white rounded-3xl p-5 shadow-sm space-y-2';
    if (roleIcon) roleIcon.innerHTML = '<i class="fa-solid fa-user-tie"></i>';
    if (pageTitle) pageTitle.textContent = 'รายการคำร้องรอรองผู้อำนวยการอนุมัติ';
    if (pageSubtitle) pageSubtitle.textContent = `รองผู้อำนวยการ (${user.full_name}): อนุมัติขั้นสุดท้ายและออก OnePass QR Pass`;
    if (roleChip) {
      roleChip.textContent = 'ขั้นตอนที่ 5/5 (รองผู้อำนวยการ)';
      roleChip.className = 'text-[10px] bg-indigo-500/30 px-2.5 py-0.5 rounded-full border border-indigo-400/40 font-semibold text-indigo-100';
    }
  }

  // ดึงรายการคำร้องล่าสุดจากเซิร์ฟเวอร์
  try {
    const res = await fetch('/api/requests');
    const data = await res.json();
    allRequestsList = data.requests || [];
  } catch (e) {
    console.error('Fetch requests for approval error:', e);
  }

  renderApprovalCards();
}

function isDepartmentMatch(userDeptStr, reqDeptStr) {
  if (!userDeptStr || !reqDeptStr) return true;
  const cleanU = userDeptStr.replace('แผนกวิชา', '').trim();
  const cleanR = reqDeptStr.replace('แผนกวิชา', '').trim();
  if (cleanR.includes(cleanU) || cleanU.includes(cleanR)) return true;
  if (cleanU.includes('ไฟฟ้า') && cleanR.includes('ไฟฟ้า')) return true;
  if (cleanU.includes('ยนต์') && cleanR.includes('ยนต์')) return true;
  if (cleanU.includes('บัญชี') && cleanR.includes('บัญชี')) return true;
  if (cleanU.includes('ดิจิทัล') && cleanR.includes('ดิจิทัล')) return true;
  if ((cleanU.includes('สำนักงาน') || cleanU.includes('จัดการ')) && 
      (cleanR.includes('สำนักงาน') || cleanR.includes('จัดการ'))) return true;
  return false;
}

function formatStudentCode(code) {
  if (!code || code.includes('@')) {
    const u = getCurrentUser();
    if (u && u.student_code && !u.student_code.includes('@')) return u.student_code;
    return '22222222';
  }
  return code;
}

// ====================== SEMESTER & STUDENT EXIT STATS ======================
// คำนวณช่วงภาคเรียนปัจจุบัน (ภาค 1: พ.ค. - ต.ค. / ภาค 2: พ.ย. - เม.ย.)
function getSemesterInfo(dateObj = new Date()) {
  const month = dateObj.getMonth() + 1;
  const fullYear = dateObj.getFullYear();
  const thaiYear = fullYear + 543;

  let semester = 1;
  let academicYear = thaiYear;
  let startDate = '';
  let endDate = '';

  if (month >= 5 && month <= 10) {
    semester = 1;
    academicYear = thaiYear;
    startDate = `${fullYear}-05-01`;
    endDate = `${fullYear}-10-31`;
  } else if (month >= 11) {
    semester = 2;
    academicYear = thaiYear;
    startDate = `${fullYear}-11-01`;
    endDate = `${fullYear + 1}-04-30`;
  } else {
    semester = 2;
    academicYear = thaiYear - 1;
    startDate = `${fullYear - 1}-11-01`;
    endDate = `${fullYear}-04-30`;
  }

  return {
    semester,
    academicYear,
    label: `ภาคเรียนที่ ${semester}/${academicYear}`,
    startDate,
    endDate
  };
}

function calculateStudentSemesterStats(studentIdentifier, targetRequests = null) {
  const semester = getSemesterInfo();
  const all = targetRequests || allRequestsList || [];

  const cleanIdent = String(studentIdentifier || '').trim().toLowerCase();

  const studentRequests = all.filter(r => {
    const rCode = String(r.studentCode || (r.users ? r.users.student_code || r.users.username : '') || '').toLowerCase();
    const rId = String(r.studentId || '').toLowerCase();
    const rName = String(r.studentName || (r.users ? r.users.full_name : '') || '').toLowerCase();

    const isMatch = (
      (cleanIdent && rCode === cleanIdent) ||
      (cleanIdent && rId === cleanIdent) ||
      (cleanIdent && rName === cleanIdent)
    );
    if (!isMatch) return false;

    // กรองให้อยู่ในภาคเรียนปัจจุบัน (เริ่มนับใหม่เมื่อเปิดเทอม)
    const rDate = r.leaveDate || (r.created_at ? r.created_at.split('T')[0] : '');
    if (!rDate) return true;
    return rDate >= semester.startDate && rDate <= semester.endDate;
  });

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const currentMinutes = (now.getHours() * 60) + now.getMinutes();
  const GATE_CLOSING_MINUTES = 17 * 60; // 17:00 น. หมดเวลาทำการประตูประจำวัน

  let totalLeaves = 0;
  let onTimeCount = 0;
  let lateCount = 0;
  let noReturnCount = 0;
  const detailedList = [];

  studentRequests.forEach(r => {
    // ไม่นับคำร้องที่ถูกปฏิเสธ หรือยังรอการอนุมัติอยู่
    if (r.status === 'rejected' || String(r.status || '').startsWith('pending_')) {
      return;
    }

    const isNoReturn = Boolean(r.no_return || r.expectedReturnTime === 'NO_RETURN' || r.leaveType === 'no_return');
    const isWaived = Boolean(r.is_waived || r.isWaived || r.waived || (r.admin_note && r.admin_note.includes('[WAIVED]')));
    const rDate = r.leaveDate || (r.created_at ? r.created_at.split('T')[0] : todayStr);
    const hasExited = r.status === 'exited' || r.status === 'returned' || r.is_qr_used || r.isQrUsed || r.qrUsedAt || r.status === 'completed';

    // ถ้ายังไม่ได้สแกนออก และสถานะยังเป็น approved ข้ามไป
    if (!hasExited && r.status === 'approved') {
      return;
    }

    totalLeaves++;

    let category = 'on_time';
    let categoryLabel = 'กลับตามเวลา';
    let badgeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200';

    if (isWaived) {
      category = 'waived';
      categoryLabel = 'ยกเว้นการนับ (งานปกครองละเว้น)';
      badgeColor = 'text-slate-600 bg-slate-100 border-slate-200';
    } else if (isNoReturn) {
      category = 'home_leave';
      categoryLabel = 'ลากลับบ้าน (ไม่ต้องกลับเข้า)';
      badgeColor = 'text-blue-700 bg-blue-50 border-blue-200';
    } else if (r.status === 'returned' || r.status === 'completed') {
      let isLate = false;
      const expectedTimeStr = r.expectedReturnTime || '15:30';
      const actualTimeStr = r.actualReturnTime || r.actual_return_time || '';

      if (actualTimeStr && expectedTimeStr && expectedTimeStr !== 'NO_RETURN') {
        const [expH, expM] = expectedTimeStr.split(':').map(Number);
        const [actH, actM] = actualTimeStr.split(':').map(Number);
        if (!isNaN(expH) && !isNaN(actH) && (actH * 60 + actM) > (expH * 60 + expM)) {
          isLate = true;
        }
      }

      if (isLate) {
        lateCount++;
        category = 'late';
        categoryLabel = 'กลับเกินเวลา';
        badgeColor = 'text-amber-700 bg-amber-50 border-amber-200';
      } else {
        onTimeCount++;
        category = 'on_time';
        categoryLabel = 'กลับตามเวลา';
        badgeColor = 'text-emerald-700 bg-emerald-50 border-emerald-200';
      }
    } else if (r.status === 'exited' || r.status === 'expired') {
      const isPastCutoff = (rDate < todayStr) || (rDate === todayStr && currentMinutes >= GATE_CLOSING_MINUTES);

      if (isPastCutoff) {
        noReturnCount++;
        category = 'no_scan_return';
        categoryLabel = 'ไม่พบการสแกนกลับเข้า';
        badgeColor = 'text-rose-700 bg-rose-50 border-rose-300 font-bold';
      } else {
        category = 'currently_out';
        categoryLabel = 'อยู่ระหว่างออกนอกสถานศึกษา';
        badgeColor = 'text-indigo-700 bg-indigo-50 border-indigo-200';
      }
    }

    detailedList.push({
      id: r.id,
      requestNo: r.requestNo || r.request_no,
      date: rDate,
      departureTime: r.departureTime || '13:00',
      expectedReturnTime: r.expectedReturnTime || '15:30',
      actualReturnTime: r.actualReturnTime || r.actual_return_time || '-',
      title: r.title,
      destination: r.destination || '-',
      reason: r.reason,
      isNoReturn,
      isWaived,
      waiverNote: r.waiverNote || r.waiver_note || (r.admin_note && r.admin_note.includes('[WAIVED]') ? r.admin_note.replace(/^\[WAIVED:\s*/, '').replace(/\].*$/, '') : ''),
      category,
      categoryLabel,
      badgeColor
    });
  });

  return {
    semester,
    totalLeaves,
    onTimeCount,
    lateCount,
    noReturnCount,
    detailedList: detailedList.sort((a, b) => (b.date > a.date ? 1 : -1))
  };
}

function openStudentSemesterHistory(studentIdentifier, studentName) {
  const stats = calculateStudentSemesterStats(studentIdentifier);
  const user = getCurrentUser();
  const isDisciplineOrAdmin = user && (user.role === 'discipline_head' || user.role === 'admin');

  const modal = document.getElementById('modal-student-history');
  const subtitle = document.getElementById('hist-modal-student-subtitle');
  const semesterLabel = document.getElementById('hist-modal-semester-label');
  const kpiTotal = document.getElementById('hist-modal-kpi-total');
  const kpiOnTime = document.getElementById('hist-modal-kpi-ontime');
  const kpiLate = document.getElementById('hist-modal-kpi-late');
  const kpiNoReturn = document.getElementById('hist-modal-kpi-noreturn');
  const listContainer = document.getElementById('hist-modal-list-container');

  if (subtitle) subtitle.textContent = `${studentName || 'นักเรียน'} • รหัส ${formatStudentCode(studentIdentifier)}`;
  if (semesterLabel) semesterLabel.textContent = stats.semester.label;
  if (kpiTotal) kpiTotal.textContent = stats.totalLeaves;
  if (kpiOnTime) kpiOnTime.textContent = stats.onTimeCount;
  if (kpiLate) kpiLate.textContent = stats.lateCount;
  if (kpiNoReturn) kpiNoReturn.textContent = stats.noReturnCount;

  if (listContainer) {
    if (stats.detailedList.length === 0) {
      listContainer.innerHTML = `
        <div class="text-center py-8 text-slate-400 text-xs">
          <i class="fa-regular fa-folder-open text-3xl mb-2 text-slate-300 block"></i>
          ยังไม่มีประวัติการขอออกนอกสถานศึกษาใน${stats.semester.label}
        </div>
      `;
    } else {
      listContainer.innerHTML = stats.detailedList.map(item => `
        <div class="pt-2.5 pb-2.5 space-y-1.5 text-xs">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <span class="font-bold text-slate-800">${item.requestNo} • ${formatThaiDateDisplay(item.date)}</span>
            <span class="text-[10px] px-2.5 py-0.5 rounded-full border ${item.badgeColor}">
              ${item.categoryLabel}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-1 text-[11px] text-slate-600 bg-slate-50 p-2 rounded-xl">
            <div><span class="text-slate-400">ปลายทาง:</span> <strong>${item.destination}</strong></div>
            <div><span class="text-slate-400">เวลาที่ขอ:</span> ${item.departureTime} - ${item.expectedReturnTime} น.</div>
            <div class="col-span-2 text-slate-500">
              <span class="text-slate-400">เวลากลับจริง:</span> 
              ${item.actualReturnTime !== '-' ? `<span class="font-bold text-slate-700">${item.actualReturnTime} น.</span>` : (item.isNoReturn ? '<span class="text-blue-600 font-medium">ลากลับบ้าน (ไม่ต้องกลับ)</span>' : '<span class="text-rose-600 font-bold">ไม่พบการสแกนกลับเข้า</span>')}
            </div>
            ${item.waiverNote ? `
              <div class="col-span-2 text-[10px] text-purple-700 bg-purple-50 p-1.5 rounded-lg border border-purple-200">
                <i class="fa-solid fa-shield-halved mr-1"></i>หมายเหตุงานปกครอง: ${item.waiverNote}
              </div>
            ` : ''}
          </div>

          ${isDisciplineOrAdmin ? `
            <div class="flex items-center justify-end pt-1">
              <button type="button" onclick="openDisciplineWaiveModal(${item.id}, '${item.requestNo}', ${item.isWaived}, '${escapeHtml(item.waiverNote || '')}')" class="text-[10px] text-purple-700 hover:text-purple-900 font-bold px-2.5 py-1 bg-purple-50 hover:bg-purple-100 rounded-lg border border-purple-200 transition flex items-center gap-1 shadow-2xs">
                <i class="fa-solid fa-shield-halved"></i> ${item.isWaived ? 'แก้ไขการละเว้น' : 'ละเว้นรายการนี้'}
              </button>
            </div>
          ` : ''}
        </div>
      `).join('');
    }
  }

  if (modal) modal.classList.remove('hidden');
}

function closeStudentHistoryModal() {
  const modal = document.getElementById('modal-student-history');
  if (modal) modal.classList.add('hidden');
}

function openMySemesterHistoryModal() {
  const user = getCurrentUser();
  if (!user) return;
  openStudentSemesterHistory(user.student_code || user.username || user.id, user.full_name);
}

// ====================== DISCIPLINE WAIVER (งานปกครองละเว้นรายการ) ======================
let currentWaiveModalRequestId = null;

function openDisciplineWaiveModal(requestId, requestNo, isWaived, note) {
  currentWaiveModalRequestId = requestId;
  const modal = document.getElementById('modal-discipline-waive');
  const reqNoEl = document.getElementById('waive-modal-request-no');
  const reqIdEl = document.getElementById('waive-modal-request-id');
  const noteEl = document.getElementById('waive-modal-note');

  if (reqNoEl) reqNoEl.textContent = `คำร้อง ${requestNo}`;
  if (reqIdEl) reqIdEl.value = requestId;
  if (noteEl) noteEl.value = note || '';

  selectWaiveToggle(Boolean(isWaived));

  if (modal) modal.classList.remove('hidden');
}

function selectWaiveToggle(isWaived) {
  const isWaivedEl = document.getElementById('waive-modal-is-waived');
  const btnNormal = document.getElementById('btn-waive-status-normal');
  const btnWaived = document.getElementById('btn-waive-status-waived');

  if (isWaivedEl) isWaivedEl.value = isWaived ? 'true' : 'false';

  const activeWaived = 'py-2 px-2.5 rounded-xl border-2 border-purple-600 bg-purple-50 text-purple-700 font-bold text-xs flex items-center justify-center gap-1 transition';
  const inactive = 'py-2 px-2.5 rounded-xl border border-slate-200 bg-slate-50 text-slate-700 font-medium text-xs flex items-center justify-center gap-1 transition';
  const activeNormal = 'py-2 px-2.5 rounded-xl border-2 border-blue-600 bg-blue-50 text-blue-700 font-bold text-xs flex items-center justify-center gap-1 transition';

  if (isWaived) {
    if (btnWaived) btnWaived.className = activeWaived;
    if (btnNormal) btnNormal.className = inactive;
  } else {
    if (btnNormal) btnNormal.className = activeNormal;
    if (btnWaived) btnWaived.className = inactive;
  }
}

function closeDisciplineWaiveModal() {
  const modal = document.getElementById('modal-discipline-waive');
  if (modal) modal.classList.add('hidden');
}

async function saveDisciplineWaiveAction() {
  if (!currentWaiveModalRequestId) return;
  const isWaived = document.getElementById('waive-modal-is-waived')?.value === 'true';
  const note = document.getElementById('waive-modal-note')?.value?.trim() || '';

  const btn = document.getElementById('btn-save-waive');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> กำลังบันทึก...';
  }

  try {
    const res = await fetch(`/api/requests/${currentWaiveModalRequestId}/waive`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ isWaived, waiverNote: note })
    });
    const data = await res.json();
    if (data.success) {
      closeDisciplineWaiveModal();
      await fetchActiveRequest();
      // รีเฟรชข้อมูลใน modal ที่เปิดค้างอยู่
      const subtitle = document.getElementById('hist-modal-student-subtitle')?.textContent || '';
      const parts = subtitle.split('•');
      const studentName = parts[0]?.trim();
      const code = parts[1]?.replace('รหัส', '').trim();
      if (code) {
        openStudentSemesterHistory(code, studentName);
      }
      renderApprovalCards();
      alert('✅ ' + data.message);
    } else {
      alert(data.message || 'บันทึกล้มเหลว');
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

// ====================== UNIFIED 5-STEP & 3-STEP STEPPER (Requirement 3, 9, 10, 15) ======================
// ใช้สัญลักษณ์ชุดเดียวกันทั้งหมดในหน้าสถานะนักเรียน, หน้าประวัติ, และหน้าอนุมัติของครู
function renderUnifiedStepper(r, compact = false) {
  if (!r) return '';
  const totalSteps = Number(r.totalSteps || 5);
  const currentStep = Number(r.currentStep || 1);
  const isApproved = r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
  const isRejected = r.status === 'rejected';
  const isExpired = r.status === 'expired' || (typeof isRequestExpired === 'function' && isRequestExpired(r) && !isApproved && !isRejected);
  const step1Skipped = Boolean(r.step1Skipped);
  const emergencyOverride = Boolean(r.emergencyOverride);
  const history = Array.isArray(r.approvalHistory) ? r.approvalHistory : [];

  const stepsDef = totalSteps === 4
    ? [
        { num: 1, title: 'ครูที่ปรึกษา', shortTitle: 'ที่ปรึกษา' },
        { num: 2, title: 'หัวหน้าแผนกวิชา', shortTitle: 'หน.แผนก' },
        { num: 3, title: 'ฝ่ายปกครอง/หลักสูตร', shortTitle: 'ปกครอง' },
        { num: 4, title: 'รองผู้อำนวยการ', shortTitle: 'รอง ผอ.' }
      ]
    : (totalSteps === 3
      ? [
          { num: 1, title: 'ครูที่ปรึกษา', shortTitle: 'ที่ปรึกษา' },
          { num: 2, title: 'หัวหน้าแผนก', shortTitle: 'หน.แผนก' },
          { num: 3, title: 'ฝ่ายปกครอง', shortTitle: 'ปกครอง' }
        ]
      : [
          { num: 1, title: 'ครูรายวิชา', shortTitle: 'ครูวิชา' },
          { num: 2, title: 'ครูที่ปรึกษา', shortTitle: 'ที่ปรึกษา' },
          { num: 3, title: 'หัวหน้าแผนกวิชา', shortTitle: 'หน.แผนก' },
          { num: 4, title: 'ฝ่ายปกครอง', shortTitle: 'ปกครอง' },
          { num: 5, title: 'รองผู้อำนวยการ', shortTitle: 'รอง ผอ.' }
        ]);

  let nodesHtml = '';
  stepsDef.forEach((s, idx) => {
    const stepNum = s.num;
    const histEntry = history.find(h => Number(h.step) === stepNum);
    const teacherName = histEntry?.approverName && histEntry.action !== 'skipped_no_class'
      ? histEntry.approverName
      : getRequestWaitingTeacherName(r, stepNum);

    let circleHtml = '';
    let labelTitleHtml = '';
    let subTextHtml = '';
    let rightConnectorClass = 'border-t-2 border-slate-200';

    // กรณีพิเศษ: ขั้นที่ 1 ไม่มีคาบเรียน (Requirement 15: เครื่องหมาย ✕ สีเทา วงกลมเส้นประ + เส้นเชื่อมประ + ข้อความ "ไม่มีคาบเรียน")
    if (totalSteps === 5 && stepNum === 1 && step1Skipped) {
      circleHtml = `
        <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-slate-100 text-slate-500 border-2 border-dashed border-slate-400 flex items-center justify-center font-bold shrink-0" title="ข้ามอัตโนมัติ: ไม่มีคาบเรียน">
          <span class="leading-none font-bold">✕</span>
        </div>
      `;
      labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-bold text-slate-500 mt-1 leading-tight">${compact ? s.shortTitle : s.title}</span>`;
      subTextHtml = `<span class="text-[8px] sm:text-[10px] text-slate-500 bg-slate-100 border border-dashed border-slate-300 px-1.5 py-0.2 rounded mt-0.5 font-semibold leading-tight">ไม่มีคาบเรียน</span>`;
      rightConnectorClass = 'border-t-2 border-dashed border-slate-400';
    } else if (isRejected && currentStep === stepNum) {
      // ถูกปฏิเสธในขั้นนี้ (Requirement 5 & 15: ✕ สีแดงทึบ วงกลมทึบ ข้อความ "ไม่อนุมัติ" แยกจากสีเทาชัดเจน)
      circleHtml = `
        <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-rose-600 text-white border-2 border-rose-700 flex items-center justify-center font-bold shadow-md shrink-0" title="ไม่อนุมัติ">
          <i class="fa-solid fa-xmark"></i>
        </div>
      `;
      labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-bold text-rose-600 mt-1 leading-tight">ไม่อนุมัติ</span>`;
      subTextHtml = `<span class="text-[8px] sm:text-[10px] text-rose-500 truncate max-w-[68px] sm:max-w-[90px] leading-tight">${teacherName}</span>`;
    } else if (stepNum < currentStep || isApproved) {
      // ผ่านขั้นนี้แล้ว (หรือข้ามฉุกเฉิน)
      const isEmergSkipped = emergencyOverride && !histEntry && stepNum >= currentStep;
      if (isEmergSkipped) {
        circleHtml = `
          <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-amber-500 text-white flex items-center justify-center font-bold shadow-xs shrink-0" title="อนุมัติฉุกเฉิน">
            <i class="fa-solid fa-bolt"></i>
          </div>
        `;
        labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-bold text-amber-700 mt-1 leading-tight">${compact ? s.shortTitle : s.title}</span>`;
        subTextHtml = `<span class="text-[8px] sm:text-[10px] text-amber-600 font-semibold leading-tight">ข้ามฉุกเฉิน</span>`;
        rightConnectorClass = 'border-t-2 border-dashed border-amber-400';
      } else {
        circleHtml = `
          <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold shadow-xs shrink-0">
            <i class="fa-solid fa-check"></i>
          </div>
        `;
        labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-bold text-emerald-700 mt-1 leading-tight">${compact ? s.shortTitle : s.title}</span>`;
        const delegatedBadge = histEntry?.isDelegated ? ' (แทน)' : '';
        const isDualStep = histEntry?.autoBundledWithStep1 || histEntry?.autoBundledWithStep2 || histEntry?.isDualApproved || histEntry?.isDualRole;
        const dualBadge = isDualStep ? ' (ควบ)' : '';
        subTextHtml = `
          <span class="text-[8px] sm:text-[10px] text-emerald-600 truncate max-w-[68px] sm:max-w-[90px] leading-tight">${teacherName}${delegatedBadge}${dualBadge}</span>
          ${isDualStep ? '<span class="text-[7px] sm:text-[8px] bg-purple-100 text-purple-700 border border-purple-200 px-1 rounded font-bold mt-0.5 leading-none">🔗 ควบ 2 ขั้น</span>' : ''}
        `;
        rightConnectorClass = 'border-t-2 border-emerald-400';
      }
    } else if (stepNum === currentStep && !isRejected && !isExpired) {
      // กำลังรอคิวอยู่ที่ขั้นนี้ (Requirement 3: แสดงชื่อตำแหน่ง + ชื่อครู + เวลาที่รอในขั้นนั้น)
      const waitMins = Number(r.waitingMinutes || 0);
      const waitLabel = waitMins > 0 ? `รอ ${waitMins} นาที` : 'เพิ่งถึงคิว';
      circleHtml = `
        <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-blue-600 text-white ring-4 ring-blue-100 flex items-center justify-center font-bold shadow-md animate-pulse shrink-0">
          <i class="fa-solid fa-clock"></i>
        </div>
      `;
      labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-extrabold text-blue-700 mt-1 leading-tight">${compact ? s.shortTitle : s.title}</span>`;
      subTextHtml = `
        <span class="text-[8px] sm:text-[10px] text-blue-600 font-semibold truncate max-w-[70px] sm:max-w-[95px] leading-tight">${teacherName}</span>
        <span class="text-[8px] sm:text-[9px] bg-amber-100 text-amber-800 border border-amber-200 px-1 py-0.2 rounded font-bold mt-0.5 leading-tight">${waitLabel}</span>
      `;
    } else {
      // ยังไม่ถึงคิว (หรือคำร้องหมดอายุก่อนถึง)
      circleHtml = `
        <div class="${compact ? 'w-6 h-6 text-[10px]' : 'w-7 h-7 sm:w-8 sm:h-8 text-xs'} rounded-full bg-slate-100 text-slate-400 border border-slate-200 flex items-center justify-center font-semibold shrink-0">
          ${stepNum}
        </div>
      `;
      labelTitleHtml = `<span class="text-[9px] sm:text-[11px] font-medium text-slate-400 mt-1 leading-tight">${compact ? s.shortTitle : s.title}</span>`;
      subTextHtml = `<span class="text-[8px] sm:text-[10px] text-slate-400 truncate max-w-[68px] sm:max-w-[90px] leading-tight">${teacherName}</span>`;
    }

    const isLast = idx === stepsDef.length - 1;
    nodesHtml += `
      <div class="flex-1 flex flex-col items-center text-center relative min-w-0 px-0.5">
        ${!isLast ? `<div class="
          absolute top-3 sm:top-4 left-1/2 w-full -z-0 ${rightConnectorClass}
        "></div>` : ''}
        <div class="relative z-10 flex flex-col items-center">
          ${circleHtml}
          ${labelTitleHtml}
          ${subTextHtml}
        </div>
      </div>
    `;
  });

  return `
    <div class="w-full py-2 overflow-x-auto">
      <div class="flex items-start justify-between min-w-[290px] w-full">
        ${nodesHtml}
      </div>
    </div>
  `;
}

// แสดงรายการประวัติการอนุมัติย้อนหลังทุกขั้น (Requirement 4, 9, 15)
function renderApprovalHistoryTimeline(r) {
  if (!r) return '';
  const history = Array.isArray(r.approvalHistory) ? r.approvalHistory : [];
  if (history.length === 0) return '';

  const items = history.map(h => {
    const timeStr = h.timestamp
      ? new Date(h.timestamp).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.'
      : '';
    if (h.action === 'skipped_no_class') {
      return `
        <div class="flex items-start gap-2 text-[11px] text-slate-600 bg-slate-100/80 px-2.5 py-1.5 rounded-xl border border-dashed border-slate-300">
          <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-600 border border-dashed border-slate-400 flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">✕</span>
          <div class="flex-1 min-w-0">
            <span class="font-bold text-slate-700">ขั้นที่ 1 (ครูรายวิชา): ไม่มีคาบเรียน</span>
            <p class="text-[10px] text-slate-500">${h.note || 'ข้ามขั้นครูรายวิชาอัตโนมัติ'}</p>
          </div>
          <span class="text-[10px] text-slate-400 shrink-0">${timeStr}</span>
        </div>
      `;
    }
    if (h.action === 'rejected') {
      return `
        <div class="flex items-start gap-2 text-[11px] text-rose-800 bg-rose-50 px-2.5 py-1.5 rounded-xl border border-rose-200">
          <span class="w-4 h-4 rounded-full bg-rose-600 text-white flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"><i class="fa-solid fa-xmark"></i></span>
          <div class="flex-1 min-w-0">
            <span class="font-bold">ขั้นที่ ${h.step}: ไม่อนุมัติ โดย ${h.approverName || '-'}</span>
            <p class="text-[10px] text-rose-700">เหตุผล: ${h.note || '-'}</p>
          </div>
          <span class="text-[10px] text-rose-400 shrink-0">${timeStr}</span>
        </div>
      `;
    }
    if (h.action === 'emergency_override') {
      return `
        <div class="flex items-start gap-2 text-[11px] text-amber-900 bg-amber-50 px-2.5 py-1.5 rounded-xl border border-amber-300">
          <span class="w-4 h-4 rounded-full bg-amber-500 text-white flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"><i class="fa-solid fa-bolt"></i></span>
          <div class="flex-1 min-w-0">
            <span class="font-bold">อนุมัติฉุกเฉินข้ามขั้น โดย ${h.approverName || '-'}</span>
            <p class="text-[10px] text-amber-800">เหตุผลฉุกเฉิน: ${h.note || '-'}</p>
          </div>
          <span class="text-[10px] text-amber-600 shrink-0">${timeStr}</span>
        </div>
      `;
    }
    if (h.action === 'auto_expired') {
      return `
        <div class="flex items-start gap-2 text-[11px] text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded-xl border border-slate-200">
          <span class="w-4 h-4 rounded-full bg-slate-400 text-white flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"><i class="fa-solid fa-clock"></i></span>
          <div class="flex-1 min-w-0">
            <span class="font-bold">หมดอายุอัตโนมัติ</span>
            <p class="text-[10px] text-slate-500">${h.note || 'ไม่ได้รับการอนุมัติครบก่อนหมดเวลาทำการ'}</p>
          </div>
          <span class="text-[10px] text-slate-400 shrink-0">${timeStr}</span>
        </div>
      `;
    }
    return `
      <div class="flex items-start gap-2 text-[11px] text-emerald-800 bg-emerald-50/70 px-2.5 py-1.5 rounded-xl border border-emerald-200/80">
        <span class="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5"><i class="fa-solid fa-check"></i></span>
        <div class="flex-1 min-w-0">
          <span class="font-bold">ขั้นที่ ${h.step}: อนุมัติแล้ว โดย ${h.approverName || '-'}</span>
          ${h.isDelegated ? `<span class="ml-1 px-1.5 py-0.2 bg-amber-100 text-amber-800 border border-amber-300 rounded text-[9px] font-bold">อนุมัติแทน (${h.delegateReason || 'ครูไม่อยู่'})</span>` : ''}
          ${h.note ? `<p class="text-[10px] text-emerald-700">${h.note}</p>` : ''}
        </div>
        <span class="text-[10px] text-emerald-600 shrink-0">${timeStr}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="space-y-1.5 pt-2 border-t border-slate-100">
      <div class="text-[10px] font-bold text-slate-500 flex items-center gap-1">
        <i class="fa-solid fa-list-check text-blue-500"></i> ประวัติการอนุมัติในสายงาน:
      </div>
      <div class="space-y-1">
        ${items}
      </div>
    </div>
  `;
}

function renderApprovalCards() {
  const container = document.getElementById('approval-list-container');
  const countPending = document.getElementById('count-pending');
  if (!container) return;

  const user = getCurrentUser();
  const userStep5 = getApproverStepForRole(user.role, 5);
  const stepName = getStepPositionLabel(userStep5, 5);

  const userDept = user.departments ? user.departments.name : (user.dept || user.department || '');
  const cleanUserDept = userDept.replace('แผนกวิชา', '').trim();

  // 1. กรองคำร้องแท็บ "รอฉัน" (Pending Queue ของตนเอง หรือโหมดอนุมัติแทน)
  const pendingRequests = allRequestsList.filter(r => isRequestInApproverQueue(user, r, isDelegateApprovalMode));

  // 2. กรองคำร้องแท็บ "ผ่านแล้ว" (History - คำร้องที่ผ่านขั้นของครูไปแล้ว หรือครูเคยอนุมัติ/ปฏิเสธไปแล้ว)
  const historyRequests = allRequestsList.filter(r => {
    const rTotal = Number(r.totalSteps || 5);
    const rTargetStep = getApproverStepForRole(user.role, rTotal);

    if (user.role === 'advisor' || user.role === 'dept_head' || user.role === 'subject_teacher') {
      if (!isDepartmentMatch(cleanUserDept, r.deptName)) {
        // ยกเว้นครูรายวิชาสามัญที่เป็นผู้สอนคาบนั้น
        const isAssignedSubject = (r.subjectTeacherUsername || '').toLowerCase() === (user.username || '').toLowerCase();
        if (!isAssignedSubject) return false;
      }
    }

    const actedByMe = Array.isArray(r.approvalHistory) && r.approvalHistory.some(h => h.approverUsername === user.username || Number(h.step) === rTargetStep);
    if (actedByMe) return true;

    if (r.status === 'rejected' || r.status === 'expired') {
      return Number(r.currentStep || 1) >= rTargetStep;
    }
    if (Number(r.currentStep || 1) === rTargetStep && isRequestExpired(r)) {
      return true;
    }
    return Number(r.currentStep || 1) > rTargetStep || r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
  });

  if (countPending) countPending.textContent = pendingRequests.length;
  updateBottomApprovalBadge(pendingRequests.length);
  updateGradeFilterDropdownUI();

  let displayList = currentApprovalTab === 'pending' ? pendingRequests : historyRequests;
  if (!selectedApprovalGrades.includes('all')) {
    displayList = displayList.filter(r => isClassroomMatch(r.classroomName, selectedApprovalGrades));
  }

  if (displayList.length === 0) {
    const isAll = selectedApprovalGrades.includes('all');
    const gradeHint = isAll ? '' : `ชั้น ${selectedApprovalGrades.join(', ')}`;
    if (currentApprovalTab === 'pending') {
      container.innerHTML = `
        <div class="bg-white rounded-3xl p-6 sm:p-8 text-center space-y-3 border border-slate-200 shadow-sm">
          <div class="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center text-2xl">
            <i class="fa-solid fa-clipboard-check"></i>
          </div>
          <div>
            <h4 class="font-bold text-slate-800 text-base">ไม่มีคำร้อง${gradeHint}ในคิว "รอฉัน" (${stepName})</h4>
            <p class="text-xs text-slate-400 mt-0.5">ท่านได้ตรวจสอบคำร้องในคิวครบถ้วนแล้ว หรือกดปุ่ม <strong>"อนุมัติแทนครูไม่อยู่"</strong> ด้านบนหากต้องการอนุมัติแทนครูท่านอื่น</p>
          </div>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="bg-white rounded-3xl p-6 text-center text-slate-400 text-xs border border-slate-200 shadow-sm">
          <i class="fa-solid fa-clock-rotate-left text-2xl text-slate-300 mb-2 block"></i>
          ยังไม่มีรายการคำร้อง${gradeHint}ในแท็บ "ผ่านแล้ว"
        </div>
      `;
    }
    return;
  }

  let html = '';
  try {
    displayList.forEach(r => {
      try {
        const rTotal = Number(r.totalSteps || 5);
        const rCurrentStep = Number(r.currentStep || 1);
        const rUserStep = getApproverStepForRole(user.role, rTotal);
        const isExpired = r.status === 'expired' || isRequestExpired(r);
        const isApproved = r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
        const isRejected = r.status === 'rejected';
        const isPendingInQueue = isRequestInApproverQueue(user, r, isDelegateApprovalMode);
        const isDirectSubjectOwnerAtStep1 = Boolean(
          rTotal === 5 &&
          rCurrentStep === 1 &&
          (
            (r.subjectTeacherUsername && r.subjectTeacherUsername.toLowerCase() === (user.username || '').toLowerCase()) ||
            (r.subjectTeacherName && user.full_name && r.subjectTeacherName.trim() === user.full_name.trim())
          )
        );
        const isAdvisorAlsoSubjectTeacher = Boolean(
          isDirectSubjectOwnerAtStep1 &&
          user.role === 'advisor' &&
          isDepartmentMatch(cleanUserDept, r.deptName)
        );

        // ตรวจสอบกรณีหัวหน้าแผนกเป็นครูที่ปรึกษาด้วย (ขั้นที่ 2 & 3 ควบตำแหน่งในคลิกเดียว)
        const isDeptHeadAlsoAdvisor = Boolean(
          rTotal === 5 &&
          rCurrentStep === 2 &&
          (user.role === 'dept_head' || user.role === 'head_dept') &&
          isDepartmentMatch(cleanUserDept, r.deptName)
        );

        const isDelegatingThisCard = isPendingInQueue && !isDirectSubjectOwnerAtStep1 && !isDeptHeadAlsoAdvisor && (
          rCurrentStep !== rUserStep ||
          (rTotal === 5 && rCurrentStep === 1 && user.role === 'subject_teacher' && r.subjectTeacherUsername && r.subjectTeacherUsername !== user.username)
        );

        const currentStepTitle = getStepPositionLabel(rCurrentStep, rTotal);
        const waitingTeacher = getRequestWaitingTeacherName(r, rCurrentStep);

        let approveBtnText = `อนุมัติ (ส่งต่อขั้นที่ ${rCurrentStep + 1}/${rTotal})`;
        if (isAdvisorAlsoSubjectTeacher) {
          approveBtnText = 'อนุมัติควบขั้น 1+2 (ส่งต่อหัวหน้าแผนก)';
        } else if (isDeptHeadAlsoAdvisor) {
          approveBtnText = '✓ อนุมัติควบ 2 ตำแหน่ง (ที่ปรึกษา & หน.แผนก)';
        } else if (rCurrentStep >= rTotal) {
          approveBtnText = 'อนุมัติขั้นสุดท้าย & ออก QR Pass';
        } else {
          const nextTitle = getStepPositionLabel(rCurrentStep + 1, rTotal);
          approveBtnText = `อนุมัติ (ส่งต่อ${nextTitle})`;
        }
        if (isDelegatingThisCard) {
          approveBtnText = `อนุมัติแทน (${currentStepTitle})`;
        }

        let badgeClass = 'bg-amber-50 text-amber-700 border-amber-200';
        let badgeText = `รอ${currentStepTitle} (${rCurrentStep}/${rTotal})`;
        if (isExpired && !isApproved && !isRejected) {
          badgeClass = 'bg-slate-100 text-slate-600 border-slate-300';
          badgeText = 'หมดอายุอัตโนมัติ (เกินเวลาทำการ)';
        } else if (isApproved) {
          badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-200';
          badgeText = r.emergencyOverride ? 'อนุมัติฉุกเฉิน (มี QR Pass)' : `อนุมัติครบ ${rTotal} ขั้น (มี QR)`;
        } else if (isRejected) {
          badgeClass = 'bg-rose-50 text-rose-700 border-rose-200';
          badgeText = 'ไม่อนุมัติ';
        } else if (rCurrentStep > rUserStep) {
          badgeClass = 'bg-blue-50 text-blue-700 border-blue-200';
          badgeText = `ผ่านแล้ว -> รอ${currentStepTitle} (${rCurrentStep}/${rTotal})`;
        }

        const studentStats = calculateStudentSemesterStats(r.studentCode || r.studentId || r.studentName);
        const canEmergencyOverride = !isApproved && !isRejected && !isExpired && (user.role === 'discipline_head' || user.role === 'deputy_director' || user.role === 'admin');

        html += `
          <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border ${isPendingInQueue ? 'border-amber-300 ring-2 ring-amber-100' : 'border-slate-200'} space-y-3 transition">
            <!-- Top row: ID + Status + Waiting Timer -->
            <div class="flex items-center justify-between pb-2 border-b border-slate-100 flex-wrap gap-1.5">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-slate-800 text-sm sm:text-base font-mono">${r.requestNo}</span>
                <span class="text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${badgeClass}">
                  ${badgeText}
                </span>
                ${!isApproved && !isRejected && !isExpired ? `
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 inline-flex items-center gap-1">
                    <i class="fa-regular fa-hourglass-half text-[9px]"></i> รอในขั้นนี้ ${r.waitingMinutes || 0} นาที
                  </span>
                ` : ''}
                ${(r.no_return || r.expectedReturnTime === 'NO_RETURN' || r.leaveType === 'no_return') ? `
                  <span class="px-2.5 py-0.5 rounded-full bg-amber-500 text-white font-bold text-[10px] inline-flex items-center gap-1 shadow-xs">
                    <i class="fa-solid fa-house-chimney-user text-[9px]"></i> ลากลับบ้าน
                  </span>
                ` : ''}
              </div>
              <span class="text-[11px] text-slate-400">
                <i class="fa-regular fa-calendar mr-1"></i>${r.leaveDate || 'วันนี้'}
              </span>
            </div>

            <!-- ธงแจ้งเตือนให้ครูที่ปรึกษาตรวจสอบ กรณีไม่พบตารางสอนและนักเรียนเลือกครูรายวิชาเอง (Requirement 15 & 16) -->
            ${r.advisorFlagVerify ? `
              <div class="p-2.5 rounded-2xl bg-amber-50 border border-amber-300 text-amber-900 text-xs flex items-start gap-2 shadow-2xs">
                <i class="fa-solid fa-flag text-amber-600 mt-0.5 shrink-0"></i>
                <div>
                  <strong class="font-bold block">🚩 นักเรียนเลือกครูรายวิชาเอง (ไม่พบข้อมูลในตารางสอน)</strong>
                  <span class="text-[11px] text-amber-800">ครูรายวิชาที่นักเรียนระบุ: <strong>${escapeHtml(r.subjectTeacherName || '-')}</strong> (${escapeHtml(r.subjectName || 'ระบุเอง')}) — กรุณาครูที่ปรึกษาตรวจสอบความถูกต้อง</span>
                </div>
              </div>
            ` : ''}

            <!-- ข้อมูลวิชาและครูรายวิชาจากตารางสอน (Requirement 13, 14, 15, 18) -->
            ${r.subjectName || r.step1Skipped ? `
              <div class="px-3 py-2 rounded-2xl ${r.step1Skipped ? 'bg-slate-100 border border-dashed border-slate-300 text-slate-600' : 'bg-sky-50/70 border border-sky-200 text-sky-900'} text-xs flex items-center justify-between flex-wrap gap-2">
                <div class="flex items-center gap-2">
                  <i class="fa-solid ${r.step1Skipped ? 'fa-calendar-xmark text-slate-500' : 'fa-book-open text-sky-600'}"></i>
                  <span>
                    ${r.step1Skipped
                      ? `<strong>ไม่มีคาบเรียน:</strong> ${escapeHtml(r.step1SkipReason || 'ช่วงเวลาว่าง/พักเที่ยง (ข้ามขั้นครูรายวิชาอัตโนมัติ)')}`
                      : `<strong>วิชาในตารางสอน:</strong> ${escapeHtml(r.subjectName)} • <strong>ครูผู้สอน:</strong> ${escapeHtml(r.subjectTeacherName || '-')}`
                    }
                  </span>
                </div>
                ${Array.isArray(r.notifiedTeachers) && r.notifiedTeachers.length > 0 ? `
                  <span class="text-[10px] bg-white px-2 py-0.5 rounded-lg border border-sky-200 text-sky-700 font-semibold">
                    แจ้งครูคาบถัดไป: ${r.notifiedTeachers.map(t => escapeHtml(t.teacherName)).join(', ')}
                  </span>
                ` : ''}
              </div>
            ` : ''}

            <!-- Student Profile Box -->
            <div class="bg-slate-50 rounded-2xl p-3 border border-slate-100 flex items-start gap-3">
              <div class="w-10 h-10 rounded-xl bg-blue-100 text-[#0d55cf] flex items-center justify-center text-lg font-bold shrink-0 mt-0.5">
                <i class="fa-solid fa-graduation-cap"></i>
              </div>
              <div class="text-xs space-y-1 flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <p class="font-bold text-slate-800 text-sm truncate">${escapeHtml(r.studentName)}</p>
                  <span class="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-blue-100 text-blue-800 border border-blue-200 shrink-0">
                    <i class="fa-solid fa-graduation-cap text-[9px] mr-1"></i>${escapeHtml(r.classroomName || 'ปวช.3')}
                  </span>
                </div>
                <p class="text-slate-500">รหัสนักศึกษา: <strong>${formatStudentCode(r.studentCode)}</strong> • ${escapeHtml(r.deptName)}</p>

                <div class="pt-1.5 mt-1 border-t border-slate-200/70 flex items-center justify-between flex-wrap gap-1.5">
                  <div class="flex items-center gap-1.5 flex-wrap text-[11px]">
                    <span class="text-slate-500 font-medium">สถิติเทอมนี้:</span>
                    <span class="font-bold text-slate-700 bg-white border border-slate-200 px-2 py-0.5 rounded-md shadow-2xs">
                      ขอออก ${studentStats.totalLeaves} ครั้ง
                    </span>
                    ${studentStats.lateCount > 0 ? `
                      <span class="font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md">
                        กลับช้า ${studentStats.lateCount}
                      </span>
                    ` : ''}
                    ${studentStats.noReturnCount > 0 ? `
                      <span class="font-black text-rose-700 bg-rose-50 border border-rose-300 px-2.5 py-0.5 rounded-md inline-flex items-center gap-1 shadow-2xs">
                        <i class="fa-solid fa-triangle-exclamation text-rose-600 text-[10px]"></i> ไม่สแกนกลับ ${studentStats.noReturnCount} ครั้ง
                      </span>
                    ` : `
                      <span class="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md font-semibold text-[10px]">
                        <i class="fa-solid fa-check text-[9px]"></i> ปกติ
                      </span>
                    `}
                  </div>
                  <button type="button" onclick="openStudentSemesterHistory('${escapeHtml(r.studentCode || r.studentId)}', '${escapeHtml(r.studentName)}')" class="text-[11px] text-blue-600 hover:text-blue-800 font-bold hover:underline inline-flex items-center gap-1 shrink-0 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg border border-blue-200 shadow-2xs transition">
                    <i class="fa-regular fa-clock"></i> ดูประวัติ
                  </button>
                </div>
              </div>
            </div>

            <!-- Details Grid -->
            <div class="grid grid-cols-2 gap-2 text-xs text-slate-600 bg-white">
              <div><span class="text-slate-400">ประเภท:</span> <strong class="text-slate-800">${escapeHtml(r.title)}</strong></div>
              <div><span class="text-slate-400">ช่วงเวลา:</span> ${(r.no_return || r.expectedReturnTime === 'NO_RETURN' || r.leaveType === 'no_return') ? `<strong class="text-amber-600 font-bold">ออก ${escapeHtml(r.departureTime || '13:00')} น. (ลากลับบ้าน)</strong>` : `<strong class="text-blue-700 font-bold">${escapeHtml(r.departureTime || '13:00')} - ${escapeHtml(r.expectedReturnTime || '15:30')} น.</strong>`}</div>
              <div class="col-span-2"><span class="text-slate-400">เหตุผลความจำเป็น:</span> <span class="text-slate-800 font-medium">${escapeHtml(r.reason)}</span></div>
              <div class="col-span-2 flex items-center justify-between flex-wrap gap-1">
                <div><span class="text-slate-400">ยานพาหนะ:</span> <span class="text-slate-700 font-medium">${escapeHtml(r.plateNo || '-')}</span></div>
                ${r.parentPhone ? `<div><span class="text-slate-400">เบอร์ผู้ปกครอง:</span> <a href="tel:${escapeHtml(r.parentPhone)}" class="text-blue-600 font-bold hover:underline inline-flex items-center gap-1"><i class="fa-solid fa-phone text-[10px]"></i>${escapeHtml(r.parentPhone)}</a></div>` : ''}
              </div>
              <div class="col-span-2 flex items-center gap-1.5 text-xs">
                <span class="text-slate-400">ปลายทาง:</span>
                <span class="font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md text-[11px] inline-flex items-center gap-1">
                  <i class="fa-solid fa-location-dot text-indigo-500 text-[10px]"></i> ${escapeHtml(r.destination || 'ธนาคาร / สถาบันการเงิน')}
                </span>
              </div>
              ${(r.evidencePhoto || r.evidence_photo) ? `
                <div class="col-span-2 pt-1">
                  <button type="button" onclick="openEvidenceModal('${escapeHtml(r.evidencePhoto || r.evidence_photo)}')" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-bold transition">
                    <i class="fa-solid fa-paperclip text-xs"></i> ดูรูปภาพหลักฐานแนบ
                  </button>
                </div>
              ` : ''}
            </div>

            <!-- Unified 5-Step Stepper (ใช้สัญลักษณ์ชุดเดียวกันทุกหน้า) -->
            <div class="pt-2 border-t border-slate-100">
              ${renderUnifiedStepper(r, true)}
            </div>

            <!-- ประวัติการอนุมัติก่อนหน้า (Requirement 4 & 9) -->
            ${renderApprovalHistoryTimeline(r)}

            <!-- Action Buttons -->
            ${isPendingInQueue ? `
              <div class="space-y-2 pt-2 border-t border-slate-100">
                ${isDeptHeadAlsoAdvisor ? `
                  <div class="p-2.5 rounded-2xl bg-purple-50 border border-purple-200 text-purple-900 text-xs flex items-center gap-2 font-medium">
                    <i class="fa-solid fa-link text-purple-600 shrink-0"></i>
                    <span>คุณเป็นทั้ง <strong>ครูที่ปรึกษา</strong> และ <strong>หัวหน้าแผนก</strong> การกดอนุมัติจะผ่านทั้งขั้นที่ 2 และ 3 ในคลิกเดียว พร้อมส่งต่องานปกครอง</span>
                  </div>
                ` : ''}
                <div class="grid grid-cols-2 gap-2">
                  <button onclick="rejectFromList(${r.id}, ${isDelegatingThisCard})" class="py-2.5 px-3 rounded-2xl border border-rose-200 bg-rose-50/70 hover:bg-rose-100 text-rose-700 font-bold text-xs transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-xmark"></i> ไม่อนุมัติ (ระบุเหตุผล)
                  </button>
                  <button onclick="approveFromList(${r.id}, ${rCurrentStep}, ${isDelegatingThisCard}, '${escapeHtml(waitingTeacher)}')" class="py-2.5 px-3 rounded-2xl ${isDeptHeadAlsoAdvisor ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700' : (isDelegatingThisCard ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700')} text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-1.5 hover:scale-[1.01]">
                    <i class="fa-solid ${isDeptHeadAlsoAdvisor ? 'fa-wand-magic-sparkles' : (isDelegatingThisCard ? 'fa-user-check' : 'fa-check')}"></i> ${approveBtnText}
                  </button>
                </div>
                ${canEmergencyOverride && rCurrentStep < rTotal ? `
                  <button onclick="emergencyOverrideRequest(${r.id}, '${escapeHtml(r.requestNo)}')" class="w-full py-2 px-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-bold text-xs transition flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-bolt text-amber-600"></i> ข้ามขั้นกรณีฉุกเฉิน & ออก QR Pass ทันที (ต้องระบุเหตุผล)
                  </button>
                ` : ''}
              </div>
            ` : `
              <div class="pt-2 border-t border-slate-100 flex items-center justify-between flex-wrap gap-2 text-xs">
                <div class="flex items-center gap-2">
                  ${isApproved && r.qrToken ? `
                    <button onclick="currentToken='${escapeHtml(r.qrToken)}'; setViewMode('qr')" class="px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl font-bold flex items-center gap-1 hover:bg-emerald-100 transition">
                      <i class="fa-solid fa-qrcode"></i> ดู QR Pass
                    </button>
                  ` : ''}
                  ${canEmergencyOverride ? `
                    <button onclick="emergencyOverrideRequest(${r.id}, '${escapeHtml(r.requestNo)}')" class="px-3 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-bold text-xs transition flex items-center gap-1">
                      <i class="fa-solid fa-bolt text-amber-600"></i> ข้ามขั้นฉุกเฉิน
                    </button>
                  ` : ''}
                </div>
                <span class="text-[11px] ${isExpired && !isApproved && !isRejected ? 'text-amber-600 font-bold' : 'text-slate-400 font-medium'}">
                  ${isExpired && !isApproved && !isRejected ? '<i class="fa-solid fa-clock mr-1"></i>หมดอายุอัตโนมัติ' : 'บันทึกผลการพิจารณาแล้ว'}
                </span>
              </div>
            `}
          </div>
        `;
      } catch (cardErr) {
        console.error('Error rendering approval card for request:', r, cardErr);
      }
    });
  } catch (err) {
    console.error('Error in renderApprovalCards loop:', err);
  }

  container.innerHTML = html;
}

async function approveFromList(requestId, step, isDelegated = false, originalTeacherName = '') {
  const user = getCurrentUser();
  let delegateReason = '';
  if (isDelegated) {
    delegateReason = prompt(`เป็นการอนุมัติแทน (${originalTeacherName || 'ครูประจำขั้นนี้ไม่อยู่'})\nกรุณาระบุเหตุผลที่อนุมัติแทน:`, 'ครูติดราชการ / สอนปฏิบัติงานในโรงฝึกงาน');
    if (delegateReason === null) return;
    if (!delegateReason.trim()) {
      alert('⚠️ กรุณาระบุเหตุผลในการอนุมัติแทน');
      return;
    }
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/requests/${requestId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        approverId: user.id,
        approverUsername: user.username,
        isDelegated: Boolean(isDelegated),
        delegateReason: delegateReason.trim(),
        note: isDelegated
          ? `อนุมัติแทนโดย ${user.full_name} (${delegateReason.trim()})`
          : `อนุมัติโดย ${user.full_name} (${user.role_badge || user.role_label || user.role})`
      })
    });
    const result = await res.json();
    if (result.success) {
      alert(`✅ ${result.message || 'อนุมัติคำร้องเรียบร้อยแล้ว!'}`);
      await fetchActiveRequest();
      await renderApprovalDashboard();
    } else {
      alert('เกิดข้อผิดพลาด: ' + (result.reason || result.message || 'ไม่สามารถอนุมัติได้'));
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ผิดพลาด: ' + err.message);
  }
}

async function rejectFromList(requestId, isDelegated = false) {
  const reason = prompt('กรุณาระบุเหตุผลที่ไม่อนุมัติคำร้องนี้ (บังคับระบุ):', 'เหตุผลไม่เพียงพอ / ติดภารกิจการเรียนสำคัญ');
  if (reason === null) return;
  if (!reason.trim()) {
    alert('⚠️ กรุณาระบุเหตุผลที่ไม่อนุมัติ เพื่อให้นักเรียนรับทราบเหตุผล');
    return;
  }

  const user = getCurrentUser();
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/requests/${requestId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        approverId: user.id,
        approverUsername: user.username,
        isDelegated: Boolean(isDelegated),
        note: reason.trim()
      })
    });
    const result = await res.json();
    if (result.success) {
      alert('บันทึกสถานะ "ไม่อนุมัติ" เรียบร้อยแล้ว คำร้องสิ้นสุดทันที');
      await fetchActiveRequest();
      await renderApprovalDashboard();
    } else {
      alert('เกิดข้อผิดพลาด: ' + (result.reason || result.message || 'ไม่สามารถปฏิเสธคำร้องได้'));
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ผิดพลาด: ' + err.message);
  }
}

// อนุมัติข้ามขั้นกรณีฉุกเฉิน สำหรับ ฝ่ายปกครอง และ รองผู้อำนวยการ (Requirement 8)
async function emergencyOverrideRequest(requestId, requestNo) {
  const reason = prompt(`⚡ ยืนยันการอนุมัติข้ามขั้นกรณีฉุกเฉิน สำหรับคำร้อง ${requestNo || ''}\nระบบจะข้ามขั้นตอนที่เหลือและสร้าง QR Pass ทันที\n\nกรุณาระบุเหตุผลความจำเป็นเร่งด่วน (บันทึกไว้ตรวจสอบย้อนหลัง):`, 'นักเรียนป่วยกะทันหัน / เหตุฉุกเฉินเร่งด่วนผู้ปกครองมารับหน้าวิทยาลัย');
  if (reason === null) return;
  if (!reason.trim()) {
    alert('⚠️ การข้ามขั้นกรณีฉุกเฉินต้องระบุเหตุผลทุกครั้ง');
    return;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/requests/${requestId}/emergency-override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ reason: reason.trim() })
    });
    const result = await res.json();
    if (result.success) {
      alert(`⚡ ${result.message}`);
      await fetchActiveRequest();
      await renderApprovalDashboard();
    } else {
      alert('❌ ไม่สามารถข้ามขั้นฉุกเฉินได้: ' + (result.message || 'ไม่มีสิทธิ์'));
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  }
}

async function createDemoRequestForTesting() {
  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: '00000000-0000-0000-0000-000000000001',
        title: 'ลากิจธุระจำเป็น',
        reason: 'ไปติดต่อทำธุรกรรมที่ธนาคารและรับเอกสารสำคัญกับผู้ปกครอง',
        leaveType: 'personal',
        plateNo: '',
        departureTime: '13:00',
        expectedReturnTime: '15:30'
      })
    });
    const result = await res.json();
    if (result.success) {
      alert('✅ จำลองส่งคำร้องใหม่ของ นายธนภัทร รัตนโชติ (ปวช.3) เรียบร้อยแล้ว!');
      await fetchActiveRequest();
      await renderApprovalDashboard();
    }
  } catch (err) {
    alert('สร้างคำร้องจำลองล้มเหลว: ' + err.message);
  }
}

// ====================== 2. ROTATING QR CODE GENERATION ======================
let rotatingQrInterval = null;
let rotatingSecondsLeft = 30;
let currentRotatingToken = null;

function renderQrCode(token, totp = null) {
  const container = document.getElementById('onepass-qr-box');
  const codeEl = document.getElementById('qr-ref-code');
  const totpBadge = document.getElementById('qr-totp-badge');
  if (!container) return;

  container.innerHTML = '';
  if (!token) return;

  new QRCode(container, {
    text: token,
    width: 180,
    height: 180,
    colorDark: "#0b56d0",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  if (codeEl) codeEl.innerText = token;
  if (totpBadge) {
    if (totp) {
      totpBadge.innerHTML = `<i class="fa-solid fa-shield-halved text-[10px]"></i> OTP: ${totp}`;
      totpBadge.className = 'px-2.5 py-0.5 rounded-lg bg-indigo-600 text-white font-mono font-bold text-[11px] tracking-wider animate-pulse';
    } else {
      totpBadge.innerHTML = '<i class="fa-solid fa-lock text-[10px]"></i> STATIC';
      totpBadge.className = 'px-2.5 py-0.5 rounded-lg bg-slate-500 text-white font-mono font-bold text-[11px]';
    }
  }
}

function updateRotatingCountdownUI(seconds, total = 30) {
  const textEl = document.getElementById('rotating-countdown-text');
  const barEl = document.getElementById('rotating-progress-bar');
  if (textEl) textEl.innerText = seconds;
  if (barEl) {
    const pct = Math.max(0, Math.min(100, (seconds / total) * 100));
    barEl.style.width = `${pct}%`;
    if (seconds <= 5) {
      barEl.className = 'h-full bg-rose-500 transition-all duration-1000';
      if (textEl) textEl.className = 'font-bold text-rose-600 font-mono text-sm animate-pulse';
    } else {
      barEl.className = 'h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-1000';
      if (textEl) textEl.className = 'font-bold text-indigo-600 font-mono text-sm';
    }
  }
}

async function fetchAndUpdateRotatingQr(requestId, fallbackToken) {
  try {
    const res = await fetch(`/api/requests/${requestId}/rotating-token`);
    const data = await res.json();
    if (data.success && data.fullToken) {
      currentRotatingToken = data.fullToken;
      rotatingSecondsLeft = data.expiresIn || 30;
      renderQrCode(data.fullToken, data.totp);
      updateRotatingCountdownUI(rotatingSecondsLeft, data.interval || 30);
      return;
    }
  } catch (e) {
    console.warn('Rotating QR fetch warning:', e);
  }
  if (fallbackToken) renderQrCode(fallbackToken);
}

function startRotatingQrTimer(requestId, fallbackToken) {
  stopRotatingQrTimer();
  fetchAndUpdateRotatingQr(requestId, fallbackToken);

  rotatingQrInterval = setInterval(() => {
    rotatingSecondsLeft--;
    if (rotatingSecondsLeft <= 0) {
      fetchAndUpdateRotatingQr(requestId, fallbackToken);
    } else {
      updateRotatingCountdownUI(rotatingSecondsLeft, 30);
    }
  }, 1000);
}

function stopRotatingQrTimer() {
  if (rotatingQrInterval) {
    clearInterval(rotatingQrInterval);
    rotatingQrInterval = null;
  }
}

function renderQrPassScreen() {
  const container = document.getElementById('screen-qr-content');
  if (!container) return;

  if (!activeRequest || (activeRequest.status !== 'approved' && activeRequest.status !== 'exited' && activeRequest.status !== 'gate_opened')) {
    container.innerHTML = `
      <div class="bg-white rounded-3xl p-8 text-center space-y-3 border border-slate-200 shadow-sm">
        <div class="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 mx-auto flex items-center justify-center text-2xl">
          <i class="fa-solid fa-qrcode"></i>
        </div>
        <div>
          <h4 class="font-bold text-slate-800 text-base">ยังไม่พร้อมเปิด QR Pass</h4>
          <p class="text-xs text-slate-400 mt-0.5">คำร้องต้องผ่านการอนุมัติครบทั้ง 3 ขั้นตอนจากครูที่ปรึกษา, หัวหน้าแผนก และงานปกครองก่อน</p>
        </div>
        <div class="pt-2">
          <button onclick="setViewMode('status')" class="px-5 py-2.5 bg-blue-50 text-[#0d55cf] border border-blue-200 rounded-2xl text-xs font-bold shadow-sm transition inline-flex items-center gap-1.5 hover:scale-[1.01]">
            <i class="fa-solid fa-clipboard-check text-[10px]"></i> ตรวจสอบสถานะคำร้อง
          </button>
        </div>
      </div>
    `;
    return;
  }

  const r = activeRequest;
  const token = r.qrToken || r.requestNo;

  container.innerHTML = `
    <!-- 1. Top Banner (Gate Opened 30s vs Approved) -->
    ${r.status === 'gate_opened' ? `
      <div class="bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white rounded-3xl p-4 flex items-center justify-between shadow-md mb-3 border border-amber-300 animate-pulse">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center text-2xl shrink-0">
            <i class="fa-solid fa-road-barrier"></i>
          </div>
          <div>
            <h4 class="font-black text-sm sm:text-base leading-tight">🚪 ไม้กั้นกำลังเปิดอยู่ (30 วินาที)</h4>
            <p class="text-xs text-amber-100 mt-0.5">กรุณาเดินหรือขับผ่านเซนเซอร์ ไม้กั้นจะปิดลงอัตโนมัติ</p>
          </div>
        </div>
        <span class="px-3 py-1 bg-white text-orange-600 rounded-full font-black text-xs shrink-0 shadow-sm">
          OPEN 30s
        </span>
      </div>
    ` : `
      <div class="bg-emerald-50 border border-emerald-300 rounded-3xl p-4 flex items-center gap-3.5 shadow-sm">
        <div class="w-10 h-10 rounded-full bg-emerald-500 text-white flex items-center justify-center text-lg shadow shrink-0">
          <i class="fa-solid fa-check"></i>
        </div>
        <div>
          <h4 class="font-bold text-emerald-900 text-sm sm:text-base">คำร้องได้รับการอนุมัติสมบูรณ์แล้ว</h4>
          <p class="text-xs text-emerald-700">แสดง QR Code นี้ที่กล้องหน้าป้อมยามเพื่อสแกนเปิดประตู</p>
        </div>
      </div>
    `}

    <!-- 2. Big QR Card Container -->
    <div class="bg-white rounded-3xl overflow-hidden shadow-sm border border-slate-200 text-center">
      <div class="bg-[#0b56d0] text-white py-3 px-6 font-bold text-sm tracking-wide flex items-center justify-between">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-qrcode"></i>
          <span>OnePass QR Code สำหรับสแกนผ่านประตู</span>
        </div>
        <span class="text-[10px] bg-white/20 border border-white/30 px-2.5 py-0.5 rounded-full font-semibold">Dynamic Pass</span>
      </div>

      <div class="p-6 sm:p-8 flex flex-col items-center justify-center bg-white">
        <!-- Rotating QR Security Badge -->
        <div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-bold mb-3 shadow-xs">
          <span class="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span>
          <i class="fa-solid fa-arrows-rotate text-indigo-600"></i>
          <span>Rotating QR • ป้องกันการแคปภาพหน้าจอ</span>
        </div>

        <!-- Animated Countdown Progress Bar -->
        <div class="w-full max-w-xs mx-auto mb-4">
          <div class="flex items-center justify-between text-xs text-slate-500 font-medium mb-1.5">
            <span class="flex items-center gap-1"><i class="fa-regular fa-clock text-indigo-500"></i> รหัสจะเปลี่ยนใหม่ใน:</span>
            <span class="font-bold text-indigo-600 font-mono text-sm"><span id="rotating-countdown-text">30</span> วินาที</span>
          </div>
          <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
            <div id="rotating-progress-bar" class="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-1000" style="width: 100%;"></div>
          </div>
        </div>

        <!-- QR Box -->
        <div id="onepass-qr-box" class="p-3.5 bg-white rounded-2xl border border-slate-200 shadow-md"></div>
        
        <!-- Reference Code & TOTP Badge -->
        <div class="mt-4 px-4 py-2 rounded-2xl bg-slate-50 border border-slate-200 text-slate-700 font-mono text-xs inline-flex flex-wrap items-center justify-center gap-2 shadow-xs">
          <span class="text-slate-400">#</span> รหัสอ้างอิง: <span id="qr-ref-code" class="font-bold text-slate-800">${token}</span>
          <span id="qr-totp-badge" class="px-2.5 py-0.5 rounded-lg bg-indigo-600 text-white font-mono font-bold text-[11px] tracking-wider animate-pulse">LIVE</span>
        </div>

        <!-- Anti-Screenshot Warning Box -->
        <div class="mt-3.5 w-full max-w-md bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2 text-amber-800 text-[11px] flex items-center justify-center gap-2 font-medium">
          <i class="fa-solid fa-triangle-exclamation text-amber-600 text-xs shrink-0"></i>
          <span>ห้ามแคปภาพหน้าจอส่งต่อ รหัสจะหมดอายุอัตโนมัติทุก 30 วินาที</span>
        </div>

        <!-- Approved Time Window Box -->
        <div class="mt-3 w-full max-w-md bg-emerald-50/70 border border-emerald-300 rounded-2xl p-3 text-center text-emerald-900 text-xs sm:text-sm">
          <div class="font-bold flex items-center justify-center gap-2 text-emerald-700">
            <i class="fa-regular fa-clock"></i> เวลาที่ได้รับอนุญาต: ${r.departureTime || '13:00'} - ${r.expectedReturnTime || '15:30'} น.
          </div>
          <div class="text-xs text-emerald-600 mt-1">
            วันที่: ${r.leaveDate || '-'}
          </div>
        </div>
      </div>
    </div>

    <!-- 3. Student Profile Info Card -->
    <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border border-slate-200 flex items-center gap-4">
      <div class="w-14 h-14 rounded-2xl bg-blue-100 text-blue-600 flex items-center justify-center text-2xl shrink-0">
        <i class="fa-solid fa-graduation-cap"></i>
      </div>
      <div class="text-xs sm:text-sm space-y-0.5">
        <h4 class="font-bold text-slate-800 text-base">${r.studentName}</h4>
        <p class="text-slate-500">รหัสนักศึกษา: <strong>${formatStudentCode(r.studentCode)}</strong> (${r.classroomName || 'ปวช.3'})</p>
        <p class="text-slate-500">ยานพาหนะ: <strong>${r.plateNo || '-'}</strong></p>
      </div>
    </div>

    <!-- 4. Location & Approver Pills -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs sm:text-sm">
      <div class="bg-blue-50/70 border border-blue-200 text-blue-900 rounded-2xl px-4 py-2.5 flex items-center gap-2 font-medium">
        <i class="fa-solid fa-location-dot text-blue-600"></i> จุดสแกน: ป้อมยามประตูหน้าวิทยาลัยการอาชีพองครักษ์
      </div>
      <div class="bg-emerald-50/70 border border-emerald-200 text-emerald-900 rounded-2xl px-4 py-2.5 flex items-center gap-2 font-medium">
        <i class="fa-solid fa-circle-check text-emerald-500"></i> อนุมัติครบถ้วน 3 ขั้นตอน
      </div>
    </div>
  `;

  setTimeout(() => {
    startRotatingQrTimer(r.id, token);
  }, 100);
}

// ====================== 3. WORKFLOW APPROVALS ======================
async function approveStep(step) {
  if (!activeRequest) await fetchActiveRequest();
  const requestId = activeRequest ? activeRequest.id : 1;

  try {
    const res = await fetch(`/api/requests/${requestId}/approve`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        approverId: step === 2 ? 'u-3' : 'u-4', // u-3 = หัวหน้าแผนก, u-4 = งานปกครอง
        note: `อนุมัติขั้นตอนที่ ${step} เรียบร้อย`
      })
    });
    const data = await res.json();

    if (data.success) {
      activeRequest = data.request;
      if (step === 2) {
        // อัปเดตเช็กลิสต์ในหน้าประวัติคำร้อง
        const step2Check = document.getElementById('step2-status-check');
        if (step2Check) {
          step2Check.className = 'flex items-center gap-2 text-emerald-700 font-medium';
          step2Check.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-500 text-sm"></i> 2. หัวหน้าแผนก อนุมัติแล้ว';
        }

        // อัปเดต Stepper ด้านบน
        const stepNodeDept = document.getElementById('step-node-dept');
        const stepLabelDept = document.getElementById('step-label-dept');
        if (stepNodeDept) {
          stepNodeDept.className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center text-xs font-bold shadow-md';
          stepNodeDept.innerHTML = '<i class="fa-solid fa-check text-xs"></i>';
        }
        if (stepLabelDept) {
          stepLabelDept.className = 'text-xs font-bold text-emerald-600 mt-1.5';
        }

        // อัปเดตปุ่มในหน้ารายละเอียด
        const btnQuick = document.getElementById('btn-quick-approve');
        if (btnQuick) {
          btnQuick.setAttribute('onclick', 'approveStep(3)');
          btnQuick.innerHTML = '<i class="fa-solid fa-check-double mr-1"></i> อนุมัติขั้นที่ 3 (ฝ่ายปกครอง)';
        }

        // ถ้ามีการ์ดขั้นที่ 2 ให้คงความเข้ากันได้
        const cardStep2 = document.getElementById('card-step2');
        const step2Badge = document.getElementById('step2-badge');
        const step2Actions = document.getElementById('step2-actions');
        if (cardStep2) cardStep2.className = 'relative bg-white rounded-2xl p-3 border-2 border-emerald-400 shadow-sm space-y-2.5';
        if (step2Badge) {
          step2Badge.className = 'px-2 py-0.5 rounded-full border border-emerald-400 text-emerald-600 bg-emerald-50 text-[10px] font-bold';
          step2Badge.innerHTML = '<i class="fa-solid fa-check mr-0.5"></i> อนุมัติแล้ว';
        }
        if (step2Actions) step2Actions.innerHTML = '<span class="col-span-2 text-center text-[10px] bg-emerald-50 text-emerald-700 py-1 rounded-lg font-bold">✓ อนุมัติส่งต่องานปกครองแล้ว</span>';

        const cardStep3 = document.getElementById('card-step3');
        const step3Badge = document.getElementById('step3-badge');
        const step3Actions = document.getElementById('step3-actions');
        if (cardStep3) cardStep3.className = 'relative bg-white rounded-2xl p-3 border-2 border-blue-500 shadow-sm space-y-2.5';
        if (step3Badge) {
          step3Badge.className = 'px-2 py-0.5 rounded-full border border-blue-400 text-blue-600 bg-blue-50 text-[10px] font-bold';
          step3Badge.innerHTML = '<i class="fa-regular fa-clock mr-0.5"></i> รออนุมัติ';
        }
        if (step3Actions) step3Actions.className = 'grid grid-cols-2 gap-2 pt-1';
      } else if (step === 3) {
        // ขั้นที่ 3 อนุมัติสมบูรณ์ -> ไปหน้า QR Code อัตโนมัติ!
        const stepNodeQr = document.getElementById('step-node-qr');
        const stepLabelQr = document.getElementById('step-label-qr');
        if (stepNodeQr) {
          stepNodeQr.className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center text-xs font-bold shadow-md';
          stepNodeQr.innerHTML = '<i class="fa-solid fa-check text-xs"></i>';
        }
        if (stepLabelQr) {
          stepLabelQr.className = 'text-xs font-bold text-emerald-600 mt-1.5';
        }

        alert('🎉 อนุมัติครบทุกขั้นตอนเรียบร้อย! ระบบสร้าง QR Code สำหรับผ่านประตูแล้ว');
        currentToken = activeRequest.qrToken || activeRequest.requestNo;
        setViewMode('qr');
      }
    } else {
      alert('ข้อผิดพลาด: ' + (data.error || 'ไม่สามารถอนุมัติได้'));
    }
  } catch (err) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ผิดพลาด: ' + err.message);
  }
}

async function rejectStep(step) {
  const reason = prompt('กรุณาระบุเหตุผลที่ไม่อนุมัติ:', 'ไม่ได้รับอนุญาต');
  if (!reason) return;

  const requestId = activeRequest ? activeRequest.id : 1;
  try {
    const res = await fetch(`/api/requests/${requestId}/reject`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ approverId: step === 2 ? 'u-3' : 'u-4', note: reason })
    });
    const data = await res.json();
    if (data.success) {
      alert('บันทึกสถานะไม่อนุมัติเรียบร้อย');
      location.reload();
    }
  } catch (err) {
    alert(err.message);
  }
}

// ====================== SCHOOL OPERATING HOURS & SETTINGS STATE ======================
let currentSchoolSettings = {
  entryTime: '08:00',
  lunchStart: '12:00',
  lunchEnd: '13:00',
  dismissalTime: '16:00',
  morningGateOpen: '06:30',
  morningGateClose: '08:00',
  nightGateClose: '18:00',
  leaveMinTime: '08:00',
  leaveMaxTime: '16:00'
};

async function fetchAndApplySchoolSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      currentSchoolSettings = { ...currentSchoolSettings, ...data.settings };
      applySchoolSettingsUI(currentSchoolSettings);
    }
  } catch (err) {
    console.warn('Failed to fetch school settings:', err);
  }
}

function applySchoolSettingsUI(settings) {
  if (!settings) settings = currentSchoolSettings;
  const entryStr = settings.entryTime || settings.morningGateClose || '08:00';
  const lunchStr = `${settings.lunchStart || '12:00'}-${settings.lunchEnd || '13:00'}`;
  const dismissStr = settings.dismissalTime || settings.leaveMaxTime || '16:00';

  const stuEntry = document.getElementById('home-student-entry-time');
  const stuLunch = document.getElementById('home-student-lunch-time');
  const stuDismiss = document.getElementById('home-student-dismissal-time');
  if (stuEntry) stuEntry.textContent = `ก่อน ${entryStr}`;
  if (stuLunch) stuLunch.textContent = lunchStr;
  if (stuDismiss) stuDismiss.textContent = `ตั้งแต่ ${dismissStr}`;

  const appEntry = document.getElementById('home-approver-entry-time');
  const appLunch = document.getElementById('home-approver-lunch-time');
  const appDismiss = document.getElementById('home-approver-dismissal-time');
  if (appEntry) appEntry.textContent = `ก่อน ${entryStr}`;
  if (appLunch) appLunch.textContent = lunchStr;
  if (appDismiss) appDismiss.textContent = `ตั้งแต่ ${dismissStr}`;
}

function getSchoolHoursRange() {
  const minStr = currentSchoolSettings.leaveMinTime || currentSchoolSettings.entryTime || currentSchoolSettings.morningGateClose || '08:00';
  const maxStr = currentSchoolSettings.leaveMaxTime || currentSchoolSettings.dismissalTime || '16:00';
  const minH = parseInt(minStr.split(':')[0], 10) || 8;
  const maxH = parseInt(maxStr.split(':')[0], 10) || 16;
  return { minH, maxH, minStr, maxStr };
}

// ====================== 24-HOUR TIME FORMATTING HELPERS (ระบบเวลา 24 ชม. ไม่ใช้ AM/PM) ======================
function format24HourInput(input) {
  if (!input) return;
  let v = input.value.replace(/[^0-9]/g, '');
  if (v.length > 4) v = v.slice(0, 4);
  if (v.length >= 3) {
    let h = parseInt(v.slice(0, 2), 10);
    if (h > 23) h = 23;
    let m = v.slice(2);
    if (m.length === 2 && parseInt(m, 10) > 59) m = '59';
    input.value = `${String(h).padStart(2, '0')}:${m}`;
  } else {
    input.value = v;
  }
}

function validate24HourInput(input, defaultVal = '08:00') {
  if (!input) return;
  let val = input.value.trim().replace('.', ':');
  if (!val) {
    input.value = defaultVal;
    return;
  }
  const match = val.match(/^(\d{1,2}):?(\d{0,2})$/);
  if (match) {
    let h = parseInt(match[1], 10);
    let m = parseInt(match[2] || '0', 10);
    if (isNaN(h) || h < 0) h = 0;
    if (h > 23) h = 23;
    if (isNaN(m) || m < 0) m = 0;
    if (m > 59) m = 59;
    input.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  } else {
    input.value = defaultVal;
  }
}

const ALL_24_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

function getPickerHours() {
  return ALL_24_HOURS;
}

// ====================== 24-HOUR TIME WHEEL PICKER (ลูกกลิ้งนาฬิกาปลุก 24 ชม.) ======================
let currentTimePickerTarget = 'dep'; // 'dep' | 'ret'
let pickerSelectedHour = '13';
let pickerSelectedMinute = '00';

// นาที 00 ถึง 59 ครบทุกนาที
const PICKER_MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

let isProgrammaticScrollingHours = false;
let isProgrammaticScrollingMinutes = false;
let hourScrollTimer = null;
let minScrollTimer = null;

function openThaiTimePicker(target) {
  currentTimePickerTarget = target;
  const modal = document.getElementById('modal-thai-time-picker');
  const title = document.getElementById('time-picker-title');
  if (!modal) return;

  const defaultDepH = '08:00';

  const isDep = target === 'dep';
  if (title) title.textContent = isDep ? 'เลือกเวลาออก (24 ชม.)' : 'เลือกเวลากลับ (24 ชม.)';

  const depInput = document.getElementById('form-dep-time');
  const depTime = (depInput && depInput.value && depInput.value !== '00:00') ? depInput.value : defaultDepH;

  // ค่าเวลาปัจจุบัน (หากยังเป็น 00:00 ให้ลูกกลิ้งเริ่มที่ 08:00 สำหรับเวลาออก หรือถัดจากเวลาออก 1 ชม. สำหรับเวลากลับ)
  const hiddenInput = document.getElementById(isDep ? 'form-dep-time' : 'form-ret-time');
  let val = (hiddenInput && hiddenInput.value && hiddenInput.value !== '00:00')
    ? hiddenInput.value
    : (isDep ? defaultDepH : depTime);

  // ถ้าเป็นเวลากลับ แต่ค่าน้อยกว่าหรือเท่ากับเวลาออก ให้ปรับล่วงหน้าทันที
  if (!isDep && val <= depTime) {
    const [dH, dM] = depTime.split(':').map(Number);
    let autoH = dH + 1;
    let autoM = dM;
    if (autoH > 23) {
      autoH = 23;
      autoM = 59;
    }
    val = `${String(autoH).padStart(2, '0')}:${String(autoM).padStart(2, '0')}`;
  }
  
  const parts = val.split(':');
  let hNum = parseInt(parts[0], 10);
  if (isNaN(hNum) || hNum < 0) hNum = 8;
  if (hNum > 23) hNum = 23;
  pickerSelectedHour = String(hNum).padStart(2, '0');
  pickerSelectedMinute = String(parseInt(parts[1] || '00', 10)).padStart(2, '0');

  renderThaiWheelPickers();
  updateThaiTimePickerPreview();
  modal.classList.remove('hidden');

  // เซ็ตตำแหน่งและผูก Event Listener สำหรับตรวจจับการเลื่อนอัตโนมัติ
  setTimeout(() => {
    setupWheelScrollListeners();
    isProgrammaticScrollingHours = true;
    isProgrammaticScrollingMinutes = true;

    const elH = document.getElementById(`wheel-hour-${pickerSelectedHour}`);
    const elM = document.getElementById(`wheel-min-${pickerSelectedMinute}`);
    const wH = document.getElementById('wheel-hours');
    const wM = document.getElementById('wheel-minutes');

    if (wH && elH) {
      const topH = elH.offsetTop - (wH.clientHeight / 2) + (elH.clientHeight / 2);
      wH.scrollTop = topH;
    }
    if (wM && elM) {
      const topM = elM.offsetTop - (wM.clientHeight / 2) + (elM.clientHeight / 2);
      wM.scrollTop = topM;
    }

    setTimeout(() => {
      isProgrammaticScrollingHours = false;
      isProgrammaticScrollingMinutes = false;
    }, 200);
  }, 60);
}

function closeThaiTimePicker() {
  const modal = document.getElementById('modal-thai-time-picker');
  if (modal) modal.classList.add('hidden');
}

function setupWheelScrollListeners() {
  const wheelHours = document.getElementById('wheel-hours');
  const wheelMinutes = document.getElementById('wheel-minutes');

  if (wheelHours && !wheelHours.dataset.scrollBound) {
    wheelHours.dataset.scrollBound = 'true';
    wheelHours.addEventListener('scroll', () => {
      if (isProgrammaticScrollingHours) return;
      handleWheelScroll('wheel-hours', 'hour');
      clearTimeout(hourScrollTimer);
      hourScrollTimer = setTimeout(() => {
        snapWheelToCenter('wheel-hours', `wheel-hour-${pickerSelectedHour}`, 'hour');
      }, 150);
    }, { passive: true });
  }

  if (wheelMinutes && !wheelMinutes.dataset.scrollBound) {
    wheelMinutes.dataset.scrollBound = 'true';
    wheelMinutes.addEventListener('scroll', () => {
      if (isProgrammaticScrollingMinutes) return;
      handleWheelScroll('wheel-minutes', 'min');
      clearTimeout(minScrollTimer);
      minScrollTimer = setTimeout(() => {
        snapWheelToCenter('wheel-minutes', `wheel-min-${pickerSelectedMinute}`, 'min');
      }, 150);
    }, { passive: true });
  }
}

function handleWheelScroll(containerId, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const centerY = containerRect.top + (containerRect.height / 2);

  const items = container.querySelectorAll('.wheel-item');
  let closestItem = null;
  let minDiff = Infinity;

  items.forEach(item => {
    const rect = item.getBoundingClientRect();
    const itemCenter = rect.top + (rect.height / 2);
    const diff = Math.abs(itemCenter - centerY);
    if (diff < minDiff) {
      minDiff = diff;
      closestItem = item;
    }
  });

  if (closestItem) {
    const val = closestItem.getAttribute('data-val');
    if (type === 'hour') {
      if (pickerSelectedHour !== val) {
        pickerSelectedHour = val;
        highlightActiveWheelItem(container, closestItem);
        updateThaiTimePickerPreview();
      }
    } else if (type === 'min') {
      if (pickerSelectedMinute !== val) {
        pickerSelectedMinute = val;
        highlightActiveWheelItem(container, closestItem);
        updateThaiTimePickerPreview();
      }
    }
  }
}

function highlightActiveWheelItem(container, activeItem) {
  const items = container.querySelectorAll('.wheel-item');
  items.forEach(item => {
    if (item === activeItem) {
      item.className = 'wheel-item h-11 flex items-center justify-center snap-center cursor-pointer font-bold text-xl rounded-xl transition text-blue-400 font-extrabold bg-blue-500/20 shadow-sm scale-110';
    } else {
      item.className = 'wheel-item h-11 flex items-center justify-center snap-center cursor-pointer font-bold text-xl rounded-xl transition text-slate-400 hover:text-white';
    }
  });
}

function snapWheelToCenter(containerId, elementId, type) {
  const container = document.getElementById(containerId);
  const element = document.getElementById(elementId);
  if (container && element) {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const currentDiff = (elementRect.top + elementRect.height / 2) - (containerRect.top + containerRect.height / 2);
    
    if (Math.abs(currentDiff) > 2) {
      if (type === 'hour') isProgrammaticScrollingHours = true;
      if (type === 'min') isProgrammaticScrollingMinutes = true;

      container.scrollBy({ top: currentDiff, behavior: 'smooth' });

      setTimeout(() => {
        if (type === 'hour') isProgrammaticScrollingHours = false;
        if (type === 'min') isProgrammaticScrollingMinutes = false;
      }, 250);
    }
  }
}

function renderThaiWheelPickers() {
  const wheelHours = document.getElementById('wheel-hours');
  const wheelMinutes = document.getElementById('wheel-minutes');
  const isDep = currentTimePickerTarget === 'dep';

  const pickerHours = getPickerHours();
  // ถ้าเลือกเวลากลับ ให้แสดงเฉพาะชั่วโมงที่ >= เวลาออก
  const depTime = (document.getElementById('form-dep-time')?.value) || '08:00';
  const depH = parseInt(depTime.split(':')[0], 10);
  const hoursToRender = (!isDep) 
    ? pickerHours.filter(h => parseInt(h, 10) >= depH)
    : pickerHours;

  // 1. ชั่วโมงตามเวลาเปิดให้ขออนุญาต
  if (wheelHours) {
    wheelHours.innerHTML = hoursToRender.map(h => {
      const active = h === pickerSelectedHour;
      return `
        <div id="wheel-hour-${h}" data-val="${h}" onclick="selectPickerHour('${h}')" class="wheel-item h-11 flex items-center justify-center snap-center cursor-pointer font-bold text-xl rounded-xl transition ${active ? 'text-blue-400 font-extrabold bg-blue-500/20 shadow-sm scale-110' : 'text-slate-400 hover:text-white'}">
          ${h}
        </div>
      `;
    }).join('');
  }

  // 2. นาที (00 ถึง 59 น.)
  if (wheelMinutes) {
    wheelMinutes.innerHTML = PICKER_MINUTES.map(m => {
      const active = m === pickerSelectedMinute;
      return `
        <div id="wheel-min-${m}" data-val="${m}" onclick="selectPickerMinute('${m}')" class="wheel-item h-11 flex items-center justify-center snap-center cursor-pointer font-mono font-bold text-xl rounded-xl transition ${active ? 'text-blue-400 font-extrabold bg-blue-500/20 shadow-sm scale-110' : 'text-slate-400 hover:text-white'}">
          ${m}
        </div>
      `;
    }).join('');
  }
}

function selectPickerHour(h) {
  pickerSelectedHour = h;
  const container = document.getElementById('wheel-hours');
  const targetEl = document.getElementById(`wheel-hour-${h}`);
  if (container && targetEl) {
    highlightActiveWheelItem(container, targetEl);
    updateThaiTimePickerPreview();
    isProgrammaticScrollingHours = true;
    const containerRect = container.getBoundingClientRect();
    const elementRect = targetEl.getBoundingClientRect();
    const diff = (elementRect.top + elementRect.height / 2) - (containerRect.top + containerRect.height / 2);
    container.scrollBy({ top: diff, behavior: 'smooth' });
    setTimeout(() => { isProgrammaticScrollingHours = false; }, 300);
  }
}

function selectPickerMinute(m) {
  pickerSelectedMinute = m;
  const container = document.getElementById('wheel-minutes');
  const targetEl = document.getElementById(`wheel-min-${m}`);
  if (container && targetEl) {
    highlightActiveWheelItem(container, targetEl);
    updateThaiTimePickerPreview();
    isProgrammaticScrollingMinutes = true;
    const containerRect = container.getBoundingClientRect();
    const elementRect = targetEl.getBoundingClientRect();
    const diff = (elementRect.top + elementRect.height / 2) - (containerRect.top + containerRect.height / 2);
    container.scrollBy({ top: diff, behavior: 'smooth' });
    setTimeout(() => { isProgrammaticScrollingMinutes = false; }, 300);
  }
}

function updateThaiTimePickerPreview() {
  const preview = document.getElementById('time-picker-preview');
  if (!preview) return;
  preview.textContent = `${pickerSelectedHour}:${pickerSelectedMinute} น.`;
}

function confirmThaiTimePicker() {
  const time24 = `${pickerSelectedHour}:${pickerSelectedMinute}`;
  const isDep = currentTimePickerTarget === 'dep';

  const depInput = document.getElementById('form-dep-time');
  const retInput = document.getElementById('form-ret-time');
  const depDisplay = document.getElementById('display-dep-time');
  const retDisplay = document.getElementById('display-ret-time');

    if ( isDep ) {
      // 1. ตั้งเวลาออก
      if (depInput) depInput.value = time24;
      if (depDisplay) {
        depDisplay.textContent = `${time24} น.`;
        depDisplay.classList.remove('text-slate-400');
        depDisplay.classList.add('text-slate-800');
      }

      // ถ้าเวลากลับถูกเลือกไว้แล้ว (ไม่ใช่ 00:00) แต่น้อยกว่าหรือเท่ากับเวลาออกใหม่ ให้ปรับเวลากลับตามไปข้างหน้าทันที
      if (retInput && retInput.value && retInput.value !== '00:00' && retInput.value !== 'NO_RETURN') {
        if (retInput.value <= time24) {
          const [hStr, mStr] = time24.split(':');
          let newRetH = parseInt(hStr, 10);
          let newRetM = parseInt(mStr, 10) + 30;
          if (newRetM >= 60) {
            newRetH += 1;
            newRetM -= 60;
          }
          if (newRetH > 23) {
            newRetH = 23;
            newRetM = 59;
          }
          const adjustedRet = `${String(newRetH).padStart(2, '0')}:${String(newRetM).padStart(2, '0')}`;
          retInput.value = adjustedRet;
          if (retDisplay) {
            retDisplay.textContent = `${adjustedRet} น.`;
            retDisplay.classList.remove('text-slate-400');
            retDisplay.classList.add('text-slate-800');
          }
        }
      }
    } else {
      // 2. ตั้งเวลากลับ: ตรวจสอบไม่ให้เวลากลับก่อนหรือเท่ากับเวลาออก (ถ้าเลือกเวลาออกไว้แล้ว)
      const depVal = (depInput && depInput.value && depInput.value !== '00:00') ? depInput.value : '';
      if (depVal && time24 <= depVal) {
        alert(`⚠️ เวลากลับ (${time24} น.) ต้องอยู่หลังเวลาออก (${depVal} น.) เสมอ กรุณาเลือกเวลาใหม่`);
        return;
      }

      if (retInput) retInput.value = time24;
      if (retDisplay) {
        retDisplay.textContent = `${time24} น.`;
        retDisplay.classList.remove('text-slate-400');
        retDisplay.classList.add('text-slate-800');
      }
    }

  closeThaiTimePicker();
  if (typeof checkStudentTimetablePreview === 'function') {
    checkStudentTimetablePreview();
  }
}

// ฟังก์ชันเลือกคาบเรียนด่วนตามโครงสร้างตารางวิทยาลัย (Periods 1-9)
function selectPeriodPreset(start, end, label) {
  const depInput = document.getElementById('form-dep-time');
  const retInput = document.getElementById('form-ret-time');
  const depDisplay = document.getElementById('display-dep-time');
  const retDisplay = document.getElementById('display-ret-time');

  if (depInput) depInput.value = start;
  if (depDisplay) {
    depDisplay.textContent = `${start} น.`;
    depDisplay.classList.remove('text-slate-400');
    depDisplay.classList.add('text-slate-800');
  }

  const noReturnBox = document.getElementById('form-no-return');
  if (!noReturnBox || !noReturnBox.checked) {
    if (retInput) retInput.value = end;
    if (retDisplay) {
      retDisplay.textContent = `${end} น.`;
      retDisplay.classList.remove('text-slate-400');
      retDisplay.classList.add('text-slate-800');
    }
  }

  document.querySelectorAll('.period-preset-chip').forEach(btn => {
    btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
    btn.classList.add('bg-white', 'text-slate-700', 'border-slate-200');
  });
  if (window.event && window.event.currentTarget) {
    const target = window.event.currentTarget;
    target.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
    target.classList.add('bg-blue-600', 'text-white', 'border-blue-600');
  }
}

// ====================== LEAVE DATE PICKER (วันนี้ / พรุ่งนี้ / ล่วงหน้า) ======================
const THAI_DAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const THAI_SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function getBkkDateString(offsetDays = 0) {
  const d = new Date();
  if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatThaiDateDisplay(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dayName = THAI_DAY_NAMES[dateObj.getDay()];
  const monthName = THAI_SHORT_MONTHS[m - 1];
  const thaiYear = y + 543;
  return `${dayName}ที่ ${d} ${monthName} ${thaiYear}`;
}

let currentLeaveDatePreset = 'today';

function initLeaveDatePicker() {
  const todayStr = getBkkDateString(0);
  const tomorrowStr = getBkkDateString(1);
  const maxDateStr = getBkkDateString(14); // ล่วงหน้าไม่เกิน 14 วัน

  const customInput = document.getElementById('form-custom-date-input');
  if (customInput) {
    customInput.min = todayStr;
    customInput.max = maxDateStr;
    customInput.value = todayStr;
  }

  selectLeaveDatePreset('today');
}

function selectLeaveDatePreset(preset) {
  currentLeaveDatePreset = preset;
  const todayStr = getBkkDateString(0);
  const tomorrowStr = getBkkDateString(1);

  const btnToday = document.getElementById('btn-date-today');
  const btnTomorrow = document.getElementById('btn-date-tomorrow');
  const btnCustom = document.getElementById('btn-date-custom');
  const wrapperCustom = document.getElementById('wrapper-custom-date');
  const customInput = document.getElementById('form-custom-date-input');
  const badge = document.getElementById('display-leave-date-badge');
  const displayFormatted = document.getElementById('display-formatted-leave-date');
  const hiddenInput = document.getElementById('form-selected-date');
  const noticeAdvance = document.getElementById('notice-advance-leave');

  const activeClass = 'py-2.5 px-2 rounded-2xl border-2 border-blue-600 bg-blue-50 text-blue-700 font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs transition';
  const inactiveClass = 'py-2.5 px-2 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-medium text-xs flex items-center justify-center gap-1.5 transition';

  let selectedDate = todayStr;

  if (preset === 'today') {
    selectedDate = todayStr;
    if (btnToday) btnToday.className = activeClass;
    if (btnTomorrow) btnTomorrow.className = inactiveClass;
    if (btnCustom) btnCustom.className = inactiveClass;
    if (wrapperCustom) wrapperCustom.classList.add('hidden');
    if (badge) {
      badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200';
      badge.textContent = 'วันนี้';
    }
    if (noticeAdvance) noticeAdvance.classList.add('hidden');
  } else if (preset === 'tomorrow') {
    selectedDate = tomorrowStr;
    if (btnToday) btnToday.className = inactiveClass;
    if (btnTomorrow) btnTomorrow.className = activeClass;
    if (btnCustom) btnCustom.className = inactiveClass;
    if (wrapperCustom) wrapperCustom.classList.add('hidden');
    if (badge) {
      badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200';
      badge.textContent = 'พรุ่งนี้';
    }
    if (noticeAdvance) noticeAdvance.classList.remove('hidden');
  } else if (preset === 'custom') {
    if (customInput && customInput.value) {
      selectedDate = customInput.value;
    } else {
      selectedDate = tomorrowStr;
      if (customInput) customInput.value = tomorrowStr;
    }
    if (btnToday) btnToday.className = inactiveClass;
    if (btnTomorrow) btnTomorrow.className = inactiveClass;
    if (btnCustom) btnCustom.className = activeClass;
    if (wrapperCustom) wrapperCustom.classList.remove('hidden');
    if (badge) {
      badge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200';
      badge.textContent = selectedDate === todayStr ? 'วันนี้' : 'ล่วงหน้า';
    }
    if (noticeAdvance) {
      if (selectedDate > todayStr) noticeAdvance.classList.remove('hidden');
      else noticeAdvance.classList.add('hidden');
    }
  }

  if (hiddenInput) hiddenInput.value = selectedDate;
  if (displayFormatted) {
    displayFormatted.textContent = formatThaiDateDisplay(selectedDate);
  }
  triggerAutoSaveDraft();
  if (typeof checkStudentTimetablePreview === 'function') {
    checkStudentTimetablePreview();
  }
}

function onCustomDateChange(val) {
  if (!val) return;
  const todayStr = getBkkDateString(0);
  if (val < todayStr) {
    alert('⚠️ ไม่สามารถเลือกวันที่ย้อนหลังในอดีตได้ กรุณาเลือกตั้งแต่วันนี้เป็นต้นไป');
    const customInput = document.getElementById('form-custom-date-input');
    if (customInput) customInput.value = todayStr;
    val = todayStr;
  }
  selectLeaveDatePreset('custom');
}

// ====================== AUTO-SAVE DRAFT (ระบบบันทึกร่างอัตโนมัติ) ======================
function getLeaveDraftStorageKey() {
  const u = getCurrentUser();
  const id = u ? (u.student_code || u.id || u.username || 'student') : 'student';
  return `onepass_leave_draft_${id}`;
}

let isRestoringLeaveDraft = false;
let autoSaveDraftDebounceTimer = null;

function saveLeaveDraft() {
  if (isRestoringLeaveDraft) return;
  const screenForm = document.getElementById('screen-form');
  if (!screenForm || screenForm.classList.contains('hidden')) return;

  const key = getLeaveDraftStorageKey();
  const reason = document.getElementById('form-reason')?.value || '';
  const destination = document.getElementById('form-destination')?.value || '';
  const destinationOther = document.getElementById('form-destination-other')?.value || '';
  const travelMode = document.getElementById('form-travel-mode')?.value || 'own';
  const plate = document.getElementById('form-plate')?.value || '';
  const pickupName = document.getElementById('form-pickup-name')?.value || '';
  const pickupPlate = document.getElementById('form-pickup-plate')?.value || '';
  const leaveType = document.getElementById('form-type')?.value || 'personal';
  const depTime = document.getElementById('form-dep-time')?.value || '';
  const retTime = document.getElementById('form-ret-time')?.value || '';
  const noReturn = document.getElementById('form-no-return')?.checked || false;
  const parentPhone = document.getElementById('form-parent-phone')?.value || '';
  const selectedDate = document.getElementById('form-selected-date')?.value || '';
  const customDateInput = document.getElementById('form-custom-date-input')?.value || '';
  const datePreset = typeof currentLeaveDatePreset !== 'undefined' ? currentLeaveDatePreset : 'today';

  // ตรวจสอบว่ามีการกรอกข้อมูลที่ควรบันทึกหรือไม่
  const hasSubstantialData = reason.trim() || destinationOther.trim() || pickupName.trim() || (travelMode === 'pickup') || noReturn || parentPhone.trim();
  if (!hasSubstantialData && destination === 'ธนาคาร / สถาบันการเงิน') {
    return;
  }

  const draftData = {
    reason,
    destination,
    destinationOther,
    travelMode,
    plate,
    pickupName,
    pickupPlate,
    leaveType,
    depTime,
    retTime,
    noReturn,
    parentPhone,
    selectedDate,
    customDateInput,
    datePreset,
    updatedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(key, JSON.stringify(draftData));
  } catch (e) {
    console.warn('Auto-save draft error:', e);
  }
}

function triggerAutoSaveDraft() {
  if (autoSaveDraftDebounceTimer) clearTimeout(autoSaveDraftDebounceTimer);
  autoSaveDraftDebounceTimer = setTimeout(saveLeaveDraft, 250);
}

function restoreLeaveDraft() {
  const key = getLeaveDraftStorageKey();
  let draft = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) draft = JSON.parse(raw);
  } catch (e) {
    draft = null;
  }
  if (!draft) return;

  isRestoringLeaveDraft = true;
  try {
    // 1. เหตุผล
    if (draft.reason !== undefined && draft.reason.trim()) {
      const el = document.getElementById('form-reason');
      if (el) el.value = draft.reason;
    }

    // 2. ปลายทาง
    if (draft.destination) {
      const destSelect = document.getElementById('form-destination');
      if (destSelect) {
        destSelect.value = draft.destination;
        if (typeof onDestinationChange === 'function') onDestinationChange(draft.destination);
      }
      if (draft.destination === 'other' && draft.destinationOther) {
        const otherEl = document.getElementById('form-destination-other');
        if (otherEl) otherEl.value = draft.destinationOther;
      }
    }

    // 3. รูปแบบการเดินทาง (ยานพาหนะส่วนตัว VS มีผู้มารับ)
    if (draft.travelMode && typeof selectTravelMode === 'function') {
      selectTravelMode(draft.travelMode);
      if (draft.travelMode === 'own' && draft.plate) {
        const plateEl = document.getElementById('form-plate');
        if (plateEl) plateEl.value = draft.plate;
      } else if (draft.travelMode === 'pickup') {
        const pName = document.getElementById('form-pickup-name');
        if (pName && draft.pickupName) pName.value = draft.pickupName;
        const pPlate = document.getElementById('form-pickup-plate');
        if (pPlate && draft.pickupPlate) pPlate.value = draft.pickupPlate;
      }
    }

    // 4. ประเภทคำร้อง
    if (draft.leaveType) {
      const el = document.getElementById('form-type');
      if (el) el.value = draft.leaveType;
    }

    // 5. ลากลับบ้าน (ไม่กลับเข้า)
    if (draft.noReturn) {
      const chk = document.getElementById('form-no-return');
      if (chk) {
        chk.checked = true;
        if (typeof toggleNoReturn === 'function') toggleNoReturn(true);
      }
    }

    // 6. เบอร์ผู้ปกครอง
    if (draft.parentPhone) {
      const el = document.getElementById('form-parent-phone');
      if (el) el.value = draft.parentPhone;
    }

    // 7. เวลา (หากเป็น 00:00 หรือค่าเดิม 13:00 / 15:30 จะไม่คืนค่า ให้เป็น 00:00 น. เสมอเพื่อให้นักเรียนกดเลือกเอง)
    if (draft.depTime && draft.depTime !== '00:00' && draft.depTime !== '13:00') {
      const el = document.getElementById('form-dep-time');
      const disp = document.getElementById('display-dep-time');
      if (el) el.value = draft.depTime;
      if (disp) {
        disp.textContent = `${draft.depTime} น.`;
        disp.classList.remove('text-slate-400');
        disp.classList.add('text-slate-800');
      }
    }
    if (draft.retTime && draft.retTime !== '00:00' && draft.retTime !== '15:30' && !draft.noReturn) {
      const el = document.getElementById('form-ret-time');
      const disp = document.getElementById('display-ret-time');
      if (el) el.value = draft.retTime;
      if (disp) {
        disp.textContent = `${draft.retTime} น.`;
        disp.classList.remove('text-slate-400');
        disp.classList.add('text-slate-800');
      }
    }

    // 8. วันที่
    const todayStr = getBkkDateString(0);
    if (draft.selectedDate && draft.selectedDate >= todayStr) {
      if (draft.datePreset === 'tomorrow') {
        if (typeof selectLeaveDatePreset === 'function') selectLeaveDatePreset('tomorrow');
      } else if (draft.datePreset === 'custom' && draft.customDateInput) {
        if (typeof selectLeaveDatePreset === 'function') {
          selectLeaveDatePreset('custom');
          const customIn = document.getElementById('form-custom-date-input');
          if (customIn) {
            customIn.value = draft.customDateInput;
            if (typeof onCustomDateChange === 'function') onCustomDateChange(draft.customDateInput);
          }
        }
      } else {
        if (typeof selectLeaveDatePreset === 'function') selectLeaveDatePreset('today');
      }
    }
    // คืนค่าร่างแบบเงียบ ไม่มีการแจ้งเตือนตามคำสั่งของผู้ใช้
  } catch (err) {
    console.warn('Error restoring draft:', err);
  } finally {
    isRestoringLeaveDraft = false;
  }
}

function clearLeaveDraft() {
  const key = getLeaveDraftStorageKey();
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

let isDraftListenersAttached = false;
function initLeaveDraftAutoSave() {
  if (isDraftListenersAttached) return;
  isDraftListenersAttached = true;

  const formSection = document.getElementById('screen-form');
  if (formSection) {
    formSection.addEventListener('input', triggerAutoSaveDraft);
    formSection.addEventListener('change', triggerAutoSaveDraft);
  }
}

// ====================== TRAVEL MODE (ขับรถเอง vs มีคนมารับ) ======================
let currentTravelMode = 'own';

function selectTravelMode(mode) {
  currentTravelMode = mode;
  const btnOwn = document.getElementById('btn-travel-own');
  const btnPickup = document.getElementById('btn-travel-pickup');
  const wrapperOwn = document.getElementById('wrapper-travel-own');
  const wrapperPickup = document.getElementById('wrapper-travel-pickup');
  const hiddenMode = document.getElementById('form-travel-mode');

  const activeClass = 'py-2.5 px-3 rounded-2xl border-2 border-blue-600 bg-blue-50 text-blue-700 font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs transition';
  const inactiveClass = 'py-2.5 px-3 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-medium text-xs flex items-center justify-center gap-1.5 transition';

  if (mode === 'own') {
    if (btnOwn) btnOwn.className = activeClass;
    if (btnPickup) btnPickup.className = inactiveClass;
    if (wrapperOwn) wrapperOwn.classList.remove('hidden');
    if (wrapperPickup) wrapperPickup.classList.add('hidden');
  } else if (mode === 'pickup') {
    if (btnOwn) btnOwn.className = inactiveClass;
    if (btnPickup) btnPickup.className = activeClass;
    if (wrapperOwn) wrapperOwn.classList.add('hidden');
    if (wrapperPickup) wrapperPickup.classList.remove('hidden');
    const pickupNameInput = document.getElementById('form-pickup-name');
    if (pickupNameInput) pickupNameInput.focus();
  }

  if (hiddenMode) hiddenMode.value = mode;
  triggerAutoSaveDraft();
}

// ====================== NO-RETURN (ลากลับบ้าน) & EVIDENCE PHOTO HELPERS ======================
window.uploadedEvidencePhoto = null;

function onDestinationChange(val) {
  const otherWrapper = document.getElementById('wrapper-destination-other');
  const otherInput = document.getElementById('form-destination-other');
  if (val === 'other') {
    if (otherWrapper) otherWrapper.classList.remove('hidden');
    if (otherInput) otherInput.focus();
  } else {
    if (otherWrapper) otherWrapper.classList.add('hidden');
  }
  triggerAutoSaveDraft();
}

function toggleNoReturn(isChecked) {
  const btn = document.getElementById('btn-ret-time');
  const disp = document.getElementById('display-ret-time');
  const retInput = document.getElementById('form-ret-time');
  const star = document.getElementById('star-parent-phone');
  const phoneInput = document.getElementById('form-parent-phone');
  const box = document.getElementById('box-no-return');
  const destSelect = document.getElementById('form-destination');
  const otherWrapper = document.getElementById('wrapper-destination-other');

  if (isChecked) {
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'bg-slate-200/60', 'cursor-not-allowed');
    }
    if (disp) disp.textContent = 'ไม่ต้องกลับเข้า (ลากลับ)';
    if (retInput) retInput.value = 'NO_RETURN';
    if (star) star.classList.remove('hidden');
    if (phoneInput) {
      phoneInput.classList.add('ring-2', 'ring-amber-400', 'bg-amber-50/50');
      phoneInput.placeholder = 'กรุณาระบุเบอร์โทรศัพท์ผู้ปกครอง (จำเป็นสำหรับการลากลับ)';
    }
    if (box) box.classList.add('ring-2', 'ring-amber-400');
    if (destSelect) {
      destSelect.value = 'บ้าน / ที่พักอาศัย';
      if (otherWrapper) otherWrapper.classList.add('hidden');
    }
  } else {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'bg-slate-200/60', 'cursor-not-allowed');
    }
    if (disp) {
      disp.textContent = '00:00 น.';
      disp.classList.remove('text-slate-800');
      disp.classList.add('text-slate-400');
    }
    if (retInput) retInput.value = '00:00';
    if (star) star.classList.add('hidden');
    if (phoneInput) {
      phoneInput.classList.remove('ring-2', 'ring-amber-400', 'bg-amber-50/50');
      phoneInput.placeholder = 'เช่น 081-234-5678 (สำหรับครูติดต่อยืนยัน)';
    }
    if (box) box.classList.remove('ring-2', 'ring-amber-400');
  }
  triggerAutoSaveDraft();
  if (typeof checkStudentTimetablePreview === 'function') {
    checkStudentTimetablePreview();
  }
}

// ====================== TIMETABLE MATCHING PREVIEW FOR STUDENT LEAVE FORM (Requirement 13, 14, 15, 16, 18) ======================
let currentTimetableMatchResult = null;
let cachedTeachersList = [];

async function ensureTeachersListLoaded() {
  if (cachedTeachersList.length > 0) return cachedTeachersList;
  try {
    const res = await fetch('/api/teachers');
    const data = await res.json();
    if (data.success && Array.isArray(data.teachers)) {
      cachedTeachersList = data.teachers;
    }
  } catch (e) {}
  return cachedTeachersList;
}

async function checkStudentTimetablePreview() {
  const previewBox = document.getElementById('form-timetable-preview-box');
  const manualWrapper = document.getElementById('form-manual-teacher-wrapper');
  const manualSelect = document.getElementById('form-manual-teacher-select');

  const user = getCurrentUser();
  const dept = document.getElementById('form-dept')?.value?.trim() || user?.dept || 'แผนกวิชาช่างยนต์';
  const classroom = document.getElementById('form-classroom')?.value?.trim() || user?.classroom || 'ปวช.3';
  const leaveDate = document.getElementById('form-selected-date')?.value || getBkkDateString(0);
  const departureTime = document.getElementById('form-dep-time')?.value || '00:00';
  const isNoReturn = Boolean(document.getElementById('form-no-return')?.checked);
  const expectedReturnTime = isNoReturn ? 'NO_RETURN' : (document.getElementById('form-ret-time')?.value || '00:00');

  // หากยังไม่ได้เลือกเวลาออก หรือเวลากลับยังเป็น 00:00 (และไม่ได้ติ๊กลากลับ) ให้แจ้งเตือนให้เลือกเวลาก่อน
  if (!departureTime || departureTime === '00:00' || (!isNoReturn && (!expectedReturnTime || expectedReturnTime === '00:00'))) {
    currentTimetableMatchResult = null;
    if (manualWrapper) manualWrapper.classList.add('hidden');
    if (previewBox) {
      previewBox.innerHTML = `
        <div class="p-3 rounded-2xl bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500 flex items-center gap-2">
          <i class="fa-regular fa-clock text-blue-500"></i>
          <span>กรุณากดเลือก <strong>"เวลาออก"</strong> และ <strong>"เวลากลับ"</strong> ด้านบน เพื่อให้ระบบค้นหาวิชาและครูผู้สอนอัตโนมัติ</span>
        </div>
      `;
    }
    return null;
  }

  if (previewBox) {
    previewBox.innerHTML = `
      <div class="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-500 flex items-center gap-2">
        <i class="fa-solid fa-circle-notch fa-spin text-blue-500"></i>
        <span>กำลังค้นหาตารางสอนและครูผู้สอนในคาบเรียน...</span>
      </div>
    `;
  }

  try {
    const res = await fetch('/api/timetable/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deptName: dept,
        classroom: classroom,
        leaveDate,
        departureTime,
        expectedReturnTime,
        noReturn: isNoReturn
      })
    });
    const rawData = await res.json();
    if (!rawData.success) return null;
    const m = rawData.match || rawData;
    const data = {
      ...m,
      previewMessage: m.message || m.previewMessage,
      primaryTeacher: m.primaryPeriod
        ? { username: m.primaryPeriod.teacherUsername, name: m.primaryPeriod.teacherName }
        : (m.primaryTeacher || null)
    };
    currentTimetableMatchResult = data;

    // เติมรายชื่อครูลงใน Dropdown กรณีไม่พบข้อมูลในตารางสอน (Requirement 16)
    if (data.manualTeacherRequired) {
      const teachers = await ensureTeachersListLoaded();
      if (manualSelect && teachers.length > 0) {
        const currentVal = manualSelect.value;
        manualSelect.innerHTML = `<option value="">-- กรุณาเลือกครูรายวิชาที่สอนในคาบนี้ --</option>` +
          teachers.map(t => `<option value="${t.username}" data-name="${t.full_name}">${t.full_name} (${t.dept || t.role_label})</option>`).join('');
        if (currentVal) manualSelect.value = currentVal;
      }
      if (manualWrapper) manualWrapper.classList.remove('hidden');
    } else {
      if (manualWrapper) manualWrapper.classList.add('hidden');
    }

    if (previewBox) {
      if (data.step1Skipped) {
        // ช่วงเวลาไม่มีคาบเรียน (พักเที่ยง / คาบว่าง / กิจกรรม / งดสอน) -> ข้ามขั้นครูรายวิชาอัตโนมัติ (Requirement 15)
        previewBox.innerHTML = `
          <div class="p-3.5 rounded-2xl bg-slate-100 border-2 border-dashed border-slate-300 text-slate-700 text-xs space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 font-bold text-slate-800">
                <span class="w-5 h-5 rounded-full bg-slate-200 text-slate-600 border border-dashed border-slate-400 flex items-center justify-center text-[10px]">✕</span>
                <span>ไม่มีคาบเรียนในช่วงเวลานี้ (ข้ามขั้นที่ 1 อัตโนมัติ)</span>
              </div>
              <span class="px-2 py-0.5 rounded-full bg-white border border-slate-300 text-[10px] font-bold text-slate-600">ไม่ต้องผ่านครูรายวิชา</span>
            </div>
            <p class="text-[11px] text-slate-600 pl-7">${data.previewMessage || 'คำร้องนี้ไม่ต้องผ่านครูรายวิชา ระบบจะส่งตรงไปยังครูที่ปรึกษา (ขั้นที่ 2/5) ทันที'}</p>
          </div>
        `;
      } else if (data.manualTeacherRequired) {
        // ไม่พบข้อมูลตารางสอน -> ให้นักเรียนเลือกครูเอง + ติดธงให้ครูที่ปรึกษาตรวจสอบ (Requirement 15 & 16)
        previewBox.innerHTML = `
          <div class="p-3.5 rounded-2xl bg-amber-50 border border-amber-300 text-amber-900 text-xs space-y-1">
            <div class="flex items-center gap-2 font-bold text-amber-800">
              <i class="fa-solid fa-triangle-exclamation text-amber-600"></i>
              <span>ไม่พบข้อมูลตารางสอน (${dept} ${classroom})</span>
            </div>
            <p class="text-[11px] text-amber-800 pl-6">กรุณาเลือกครูรายวิชาด้านล่างด้วยตนเอง ระบบจะติดเครื่องหมาย 🚩 ให้ครูที่ปรึกษาช่วยตรวจสอบความถูกต้อง</p>
          </div>
        `;
      } else {
        // พบคาบเรียนปกติ (ออกคาบเดียว หรือ ออกคร่อมหลายคาบ) (Requirement 13 & 14)
        const notifiedHtml = Array.isArray(data.notifiedTeachers) && data.notifiedTeachers.length > 0
          ? `<div class="mt-1.5 pt-1.5 border-t border-sky-200/70 text-[11px] text-sky-800 flex items-center gap-1.5 flex-wrap">
               <i class="fa-solid fa-bell text-sky-600 text-[10px]"></i>
               <span><strong>ออกคร่อมหลายคาบ:</strong> ส่งให้ครูคาบแรกอนุมัติ และแจ้งให้ทราบไปยัง: ${data.notifiedTeachers.map(t => `${t.teacherName} (${t.subjectName})`).join(', ')}</span>
             </div>`
          : '';
        previewBox.innerHTML = `
          <div class="p-3.5 rounded-2xl bg-sky-50 border border-sky-200 text-sky-900 text-xs space-y-1">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2 font-bold text-sky-900">
                <i class="fa-solid fa-book-open-reader text-sky-600"></i>
                <span>ระบบจับคู่ตารางสอนอัตโนมัติ (ขั้นที่ 1/5)</span>
              </div>
              <span class="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 border border-sky-200 text-[10px] font-bold">ภาคเรียน ${data.semester || '1/2569'}</span>
            </div>
            <p class="text-xs font-semibold text-slate-800 pl-6">${data.previewMessage || `ตรงกับวิชา ${data.primaryPeriod?.subjectName || '-'} • ครูผู้สอน: ${data.primaryTeacher?.name || '-'}`}</p>
            ${notifiedHtml}
          </div>
        `;
      }
    }
    return data;
  } catch (err) {
    console.warn('Timetable preview error:', err);
    return null;
  }
}

window.uploadedEvidencePhoto = null;
window.uploadedEvidenceFileName = '';
window.uploadedEvidenceFileSize = '';

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function handleEvidenceUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const originalSizeStr = formatFileSize(file.size);
    const fileNameStr = file.name || 'evidence_image.jpg';

    // บีบอัดรูปภาพ
    const base64 = await compressAndReadImage(file, 1000, 0.75);
    window.uploadedEvidencePhoto = base64;
    window.uploadedEvidenceFileName = fileNameStr;
    window.uploadedEvidenceFileSize = originalSizeStr;

    const preview = document.getElementById('evidence-preview-img');
    const uploadZone = document.getElementById('evidence-upload-zone');
    const previewCard = document.getElementById('evidence-preview-card');
    const nameEl = document.getElementById('evidence-filename');
    const sizeEl = document.getElementById('evidence-filesize');

    if (preview) preview.src = base64;
    if (nameEl) nameEl.textContent = fileNameStr;
    if (sizeEl) sizeEl.textContent = `ขนาด: ${originalSizeStr}`;

    if (uploadZone) uploadZone.classList.add('hidden');
    if (previewCard) previewCard.classList.remove('hidden');
  } catch (err) {
    alert('⚠️ ไม่สามารถอัปโหลดรูปภาพได้: ' + err.message);
  }
}

function removeEvidenceUpload() {
  window.uploadedEvidencePhoto = null;
  window.uploadedEvidenceFileName = '';
  window.uploadedEvidenceFileSize = '';

  const input = document.getElementById('form-evidence-file');
  const preview = document.getElementById('evidence-preview-img');
  const uploadZone = document.getElementById('evidence-upload-zone');
  const previewCard = document.getElementById('evidence-preview-card');
  const nameEl = document.getElementById('evidence-filename');
  const sizeEl = document.getElementById('evidence-filesize');

  if (input) input.value = '';
  if (preview) preview.src = '';
  if (nameEl) nameEl.textContent = '';
  if (sizeEl) sizeEl.textContent = '';

  if (uploadZone) uploadZone.classList.remove('hidden');
  if (previewCard) previewCard.classList.add('hidden');
}

function openEvidenceModal(src) {
  if (!src) return;
  const modal = document.getElementById('modal-evidence-viewer');
  const img = document.getElementById('modal-evidence-img');
  if (modal && img) {
    img.src = src;
    modal.classList.remove('hidden');
  }
}

function closeEvidenceModal() {
  const modal = document.getElementById('modal-evidence-viewer');
  if (modal) modal.classList.add('hidden');
}

// ====================== 4. FORM SUBMISSION (WITH CONFIRM DIALOG) ======================
let currentPendingRequestData = null;

function closeConfirmModal() {
  const modal = document.getElementById('modal-confirm-request');
  if (modal) modal.classList.add('hidden');
}

async function submitOnePassForm() {
  const btnForm = document.getElementById('btn-submit-form');
  if (btnForm && btnForm.disabled) return;
  const originalBtnHtml = btnForm ? btnForm.innerHTML : '';

  const resetBtn = () => {
    if (btnForm) {
      btnForm.disabled = false;
      btnForm.innerHTML = originalBtnHtml;
    }
  };

  if (btnForm) {
    btnForm.disabled = true;
    btnForm.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> <span>กำลังตรวจสอบข้อมูล...</span>';
  }

  const user = getCurrentUser();
  if (user && user.role === 'student') {
    const check = checkProfileComplete(user);
    if (!check.complete) {
      resetBtn();
      showProfileIncompleteNotice(check.missing);
      return;
    }
  }

  const name = document.getElementById('form-name')?.value?.trim() || user?.full_name || 'นักเรียน';
  const code = document.getElementById('form-code')?.value?.trim() || user?.student_code || '66209010012';
  const dept = document.getElementById('form-dept')?.value?.trim() || user?.dept || 'แผนกวิชาช่างยนต์';
  const classroom = document.getElementById('form-classroom')?.value?.trim() || user?.classroom || 'ปวช.3';
  const type = document.getElementById('form-type')?.value || 'personal';
  
  // รูปแบบการเดินทาง (ยานพาหนะส่วนตัว VS มีผู้ปกครอง/คนมารับ) - ไม่เอาเดินเท้า
  const travelMode = document.getElementById('form-travel-mode')?.value || 'own';
  let pickupName = '';
  let pickupPlate = '';
  let resolvedPlate = document.getElementById('form-plate')?.value?.trim() || user?.plate || 'ไม่มีรถ / เดินทางโดยสาร';

  if (travelMode === 'pickup') {
    pickupName = document.getElementById('form-pickup-name')?.value?.trim() || '';
    pickupPlate = document.getElementById('form-pickup-plate')?.value?.trim() || '';
    if (!pickupName) {
      resetBtn();
      alert('⚠️ กรณีมีผู้มารับ จำเป็นต้องระบุ "ชื่อ-นามสกุล ผู้มารับ" เพื่อความปลอดภัยของนักศึกษา');
      const pickupInput = document.getElementById('form-pickup-name');
      if (pickupInput) {
        pickupInput.focus();
        pickupInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    resolvedPlate = pickupPlate ? `มีผู้มารับ: ${pickupName} (ทะเบียน: ${pickupPlate})` : `มีผู้มารับ: ${pickupName}`;
  }

  const plate = resolvedPlate;
  const reason = document.getElementById('form-reason')?.value?.trim() || 'ไปติดต่อทำธุรกรรมและธุระครอบครัว';

  const depTimeInput = document.getElementById('form-dep-time');
  const retTimeInput = document.getElementById('form-ret-time');
  const departureTime = depTimeInput ? depTimeInput.value : '00:00';
  const expectedReturnTime = retTimeInput ? retTimeInput.value : '00:00';

  const noReturnCheckbox = document.getElementById('form-no-return');
  const isNoReturn = noReturnCheckbox ? Boolean(noReturnCheckbox.checked) : false;

  // บังคับให้นักเรียนต้องกดเลือกเวลาออก และเวลากลับ (ห้ามปล่อยเป็น 00:00)
  if (!departureTime || departureTime === '00:00') {
    resetBtn();
    alert('⚠️ กรุณากดเลือก "เวลาออก" ก่อนส่งคำร้องขออนุญาต');
    const btnDep = document.getElementById('btn-dep-time');
    if (btnDep) btnDep.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (!isNoReturn && (!expectedReturnTime || expectedReturnTime === '00:00')) {
    resetBtn();
    alert('⚠️ กรุณากดเลือก "เวลากลับ" ก่อนส่งคำร้องขออนุญาต (หรือติ๊กเลือกไม่กลับเข้าวิทยาลัย)');
    const btnRet = document.getElementById('btn-ret-time');
    if (btnRet) btnRet.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const parentPhoneInput = document.getElementById('form-parent-phone');
  const parentPhone = parentPhoneInput ? parentPhoneInput.value.trim() : (user.parent_phone || '');

  // ตรวจสอบเงื่อนไข: หากติ๊กลากลับบ้าน บังคับต้องระบุเบอร์โทรผู้ปกครอง
  if (isNoReturn && !parentPhone) {
    resetBtn();
    alert('⚠️ กรณีไม่กลับเข้าวิทยาลัย (ลากลับบ้าน)\nจำเป็นต้องระบุ "เบอร์โทรศัพท์ผู้ปกครอง" เพื่อให้ครูที่ปรึกษาติดต่อยืนยันก่อนพิจารณาอนุมัติ');
    if (parentPhoneInput) {
      parentPhoneInput.focus();
      parentPhoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  // วันที่ที่เลือก (วันนี้ / พรุ่งนี้ / ล่วงหน้า)
  const todayStr = getBkkDateString(0);
  const selectedDateInput = document.getElementById('form-selected-date');
  const leaveDate = (selectedDateInput && selectedDateInput.value) ? selectedDateInput.value : todayStr;

  if (leaveDate < todayStr) {
    resetBtn();
    alert('⚠️ วันที่ขออนุญาตไม่ถูกต้อง (ห้ามเลือกวันที่ย้อนหลังในอดีต)');
    selectLeaveDatePreset('today');
    return;
  }

  // ต้องมี user.id จริงจากฐานข้อมูล (UUID 36 ตัวอักษร) เท่านั้น - ห้าม fallback ไปใช้ ID บัญชีสาธิตที่ตายแล้ว
  // เพราะจะทำให้บันทึกคำร้องลง MySQL ไม่ได้ (Foreign Key ไม่มีแถวอ้างอิงจริง) แต่ UI จะไม่รู้ตัวเพราะ error ถูกปิดบังไว้
  if (!user || !user.id || user.id.length !== 36) {
    resetBtn();
    alert('⚠️ ไม่พบข้อมูลบัญชีผู้ใช้ที่ถูกต้อง กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่อีกครั้งก่อนยื่นคำร้อง');
    return;
  }
  const studentId = user.id;

  // ตรวจสอบความปลอดภัยฝั่ง Client ป้องกันการกดยื่นซ้ำ
  if (user && user.role === 'student') {
    const activeReq = getStudentActiveRequest(user);
    if (activeReq) {
      resetBtn();
      alert(`⚠️ ไม่สามารถยื่นคำร้องซ้ำได้\n\nคุณมีคำร้องขออนุญาตที่กำลังใช้งานอยู่แล้ว (${activeReq.requestNo || 'OP-2569XXXX'})`);
      return;
    }
  }

  // อ่านสถานที่ปลายทางที่ต้องไป
  const destSelect = document.getElementById('form-destination');
  let destination = destSelect ? destSelect.value : 'ธนาคาร / สถาบันการเงิน';
  if (destination === 'other') {
    const destOther = document.getElementById('form-destination-other')?.value?.trim();
    if (!destOther) {
      resetBtn();
      alert('⚠️ กรุณาระบุชื่อสถานที่ปลายทางที่ต้องการไป');
      const otherInput = document.getElementById('form-destination-other');
      if (otherInput) otherInput.focus();
      return;
    }
    destination = destOther;
  }

  // โครงสร้าง 4 ขั้นตอน: คำร้องส่งตรงไปยังครูที่ปรึกษา ไม่ต้องเลือกวิชาหรือครูรายวิชา
  let manualTeacherUsername = '';
  let manualTeacherName = '';
  let manualSubjectName = '';

  // เตรียมข้อมูลสรุปสำหรับ Confirm Dialog
  const requestTitle = isNoReturn ? 'ลากลับบ้าน (ไม่กลับเข้า)' : (type === 'medical' ? 'พบแพทย์ตามนัด' : 'ลากิจธุระจำเป็น');

  currentPendingRequestData = {
    studentId,
    studentCode: code,
    title: requestTitle,
    reason,
    destination: destination,
    leaveType: isNoReturn ? 'no_return' : type,
    noReturn: isNoReturn,
    evidencePhoto: window.uploadedEvidencePhoto || '',
    evidenceFileName: window.uploadedEvidenceFileName || '',
    evidenceFileSize: window.uploadedEvidenceFileSize || '',
    deptName: user.dept || dept || 'แผนกวิชาช่างยนต์ (ปวช.3)',
    classroomName: classroom,
    travelMode: travelMode,
    pickupName: pickupName,
    pickupPlate: pickupPlate,
    plateNo: plate,
    platePhoto: user.plate_photo || '',
    parentPhone: parentPhone,
    leaveDate: leaveDate,
    departureTime: departureTime,
    expectedReturnTime: isNoReturn ? 'NO_RETURN' : expectedReturnTime,
    studentName: name,
    totalSteps: 4,
    workflowVersion: 4,
    manualTeacherUsername,
    manualTeacherName,
    manualSubjectName
  };

  // แสดงข้อมูลสายอนุมัติ 4 ขั้นใน Confirm Modal
  const modalSubjectPreview = document.getElementById('confirm-modal-subject-preview');
  if (modalSubjectPreview) {
    modalSubjectPreview.innerHTML = `
      <div class="p-2.5 rounded-xl bg-blue-50 border border-blue-200 text-blue-950 text-xs flex items-center gap-2">
        <i class="fa-solid fa-clipboard-check text-blue-600 text-sm"></i>
        <span>สายอนุมัติ 4 ขั้น: <strong>1. ครูที่ปรึกษา → 2. หัวหน้าแผนก → 3. ฝ่ายปกครอง/หลักสูตร → 4. รองผู้อำนวยการ</strong></span>
      </div>
    `;
  }

  // แสดงข้อมูลใน Modal ยืนยัน
  const modalName = document.getElementById('confirm-modal-name');
  const modalCode = document.getElementById('confirm-modal-code');
  const modalDept = document.getElementById('confirm-modal-dept');
  const modalClassroom = document.getElementById('confirm-modal-classroom');
  const modalType = document.getElementById('confirm-modal-type');
  const modalBadgeNoReturn = document.getElementById('confirm-modal-badge-noreturn');
  const modalDate = document.getElementById('confirm-modal-date');
  const modalDestination = document.getElementById('confirm-modal-destination');
  const modalTime = document.getElementById('confirm-modal-time');
  const modalPlate = document.getElementById('confirm-modal-plate');
  const modalParentPhone = document.getElementById('confirm-modal-parent-phone');
  const modalReason = document.getElementById('confirm-modal-reason');
  const modalEvidenceBox = document.getElementById('confirm-modal-evidence-box');

  if (modalName) modalName.textContent = name;
  if (modalCode) modalCode.textContent = code;
  if (modalDept) modalDept.textContent = currentPendingRequestData.deptName;
  if (modalClassroom) modalClassroom.textContent = classroom;
  if (modalType) modalType.textContent = requestTitle;

  if (modalDate) {
    const isToday = leaveDate === todayStr;
    const isTomorrow = leaveDate === getBkkDateString(1);
    const suffix = isToday ? '(วันนี้)' : (isTomorrow ? '(พรุ่งนี้)' : '(ล่วงหน้า)');
    modalDate.textContent = `${formatThaiDateDisplay(leaveDate)} ${suffix}`;
  }

  if (modalDestination) {
    modalDestination.innerHTML = `<i class="fa-solid fa-location-dot text-indigo-500 text-[10px]"></i> ${destination}`;
  }

  if (modalBadgeNoReturn) {
    if (isNoReturn) modalBadgeNoReturn.classList.remove('hidden');
    else modalBadgeNoReturn.classList.add('hidden');
  }

  if (modalTime) {
    modalTime.textContent = isNoReturn 
      ? `ออกเวลา ${departureTime} น. (ลากลับบ้าน)` 
      : `${departureTime} น. - ${expectedReturnTime} น.`;
  }

  if (modalPlate) {
    if (travelMode === 'pickup') {
      modalPlate.innerHTML = `<span class="inline-flex items-center gap-1.5 text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-xl font-bold text-xs"><i class="fa-solid fa-user-check text-emerald-600"></i> มีผู้มารับ: ${pickupName}</span>${pickupPlate ? `<span class="text-xs text-slate-500 ml-1.5 font-mono">(${pickupPlate})</span>` : ''}`;
    } else {
      modalPlate.innerHTML = `<span class="inline-flex items-center gap-1.5 text-blue-800 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-xl font-bold text-xs font-mono"><i class="fa-solid fa-motorcycle text-blue-600"></i> ${plate || '-'}</span>`;
    }
  }
  if (modalParentPhone) {
    modalParentPhone.innerHTML = parentPhone 
      ? `<i class="fa-solid fa-phone text-[10px]"></i> ${parentPhone}` 
      : '<span class="text-slate-400 font-normal">ไม่ได้ระบุ</span>';
  }

  if (modalReason) modalReason.textContent = reason;

  if (modalEvidenceBox) {
    if (window.uploadedEvidencePhoto) {
      modalEvidenceBox.innerHTML = `
        <div class="flex items-center gap-3 bg-white p-2 rounded-xl border border-emerald-200">
          <img src="${window.uploadedEvidencePhoto}" class="w-12 h-12 rounded-lg object-cover border border-slate-200 shrink-0">
          <div class="truncate flex-1">
            <p class="font-bold text-slate-800 text-xs truncate">${window.uploadedEvidenceFileName || 'รูปภาพหลักฐานแนบ'}</p>
            <p class="text-[10px] text-emerald-600 font-medium">${window.uploadedEvidenceFileSize ? `ขนาด: ${window.uploadedEvidenceFileSize} • ` : ''}แนบเรียบร้อย</p>
          </div>
          <button type="button" onclick="openEvidenceModal(window.uploadedEvidencePhoto)" class="text-xs text-blue-600 font-bold px-2 py-1 bg-blue-50 rounded-lg hover:bg-blue-100 shrink-0">
            ดูรูป
          </button>
        </div>
      `;
    } else {
      modalEvidenceBox.innerHTML = `
        <div class="text-slate-400 text-[11px] py-1 flex items-center gap-1.5">
          <i class="fa-regular fa-image text-slate-300"></i> ไม่ได้แนบรูปหลักฐาน (รูปภาพไม่บังคับ)
        </div>
      `;
    }
  }

  // เปิด Confirm Modal
  resetBtn();
  const modal = document.getElementById('modal-confirm-request');
  if (modal) modal.classList.remove('hidden');
}

async function executeSubmitRequest() {
  if (!currentPendingRequestData) return;

  const btn = document.getElementById('btn-confirm-submit');
  const btnCancel = document.getElementById('btn-confirm-cancel');
  if (btn && btn.disabled) return; // ป้องกันการกดเบิ้ลซ้ำ (Double Submission Prevention)

  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-sm mr-1.5"></i> <span>กำลังส่งคำร้อง กรุณารอสักครู่...</span>';
  }
  if (btnCancel) {
    btnCancel.disabled = true;
  }

  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentPendingRequestData)
    });
    const data = await res.json();
    if (data.success) {
      closeConfirmModal();
      alert('✅ ' + (data.message || 'ส่งคำร้องขออนุญาตสำเร็จ!') + (currentPendingRequestData.noReturn ? '\n(คำร้องประเภท: ลากลับบ้าน)' : ''));
      
      // ล้างข้อมูลหลักฐานที่แนบไว้ และฟอร์ม
      removeEvidenceUpload();
      const noReturnCheckbox = document.getElementById('form-no-return');
      if (noReturnCheckbox) noReturnCheckbox.checked = false;
      toggleNoReturn(false);
      selectTravelMode('own');
      const pickupNameInput = document.getElementById('form-pickup-name');
      if (pickupNameInput) pickupNameInput.value = '';
      const pickupPlateInput = document.getElementById('form-pickup-plate');
      if (pickupPlateInput) pickupPlateInput.value = '';
      clearLeaveDraft();
      currentPendingRequestData = null;

      await fetchActiveRequest();
      setViewMode('status');
    } else {
      alert(data.message || '⚠️ ไม่สามารถยื่นคำร้องได้');
    }
  } catch (err) {
    alert('ส่งคำร้องล้มเหลว: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    if (btnCancel) {
      btnCancel.disabled = false;
    }
  }
}

// ====================== REQUEST EXPIRATION CHECK ======================
// ตรวจสอบว่าคำร้องหมดอายุตามวันและเวลาหรือไม่ (เป็นคำร้องแบบวันเดียว Single-Day Permit)
function isRequestExpired(req) {
  if (!req) return false;
  
  // วันที่ปัจจุบัน (Local Time Format: YYYY-MM-DD)
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;
  
  // วันที่ของคำร้อง (leaveDate หรือ createdAt)
  let reqDate = req.leaveDate;
  if (!reqDate && req.createdAt) {
    reqDate = req.createdAt.split('T')[0];
  }
  
  // 1. ถ้ามีวันที่ระบุ และวันที่ของคำร้องน้อยกว่าวันนี้ (ข้ามวันแล้ว) -> ถือว่าหมดอายุทันที
  if (reqDate && reqDate < todayStr) {
    return true;
  }
  
  // 2. ถ้าเป็นวันเดียวกัน หรือไม่ได้ระบุวันที่: ตรวจสอบเวลาที่ขออนุญาตกลับเข้า (expectedReturnTime)
  // หากเวลาปัจจุบันเลยเวลาที่ขออนุญาตกลับเข้าแล้ว -> ถือว่าหมดเวลาใช้งาน (ทั้งรอตรวจและอนุมัติแล้ว)
  if (!reqDate || reqDate === todayStr) {
    const targetTimeStr = req.expectedReturnTime || '15:30';
    if (targetTimeStr) {
      const parts = targetTimeStr.split(':');
      if (parts.length >= 2) {
        const returnHours = parseInt(parts[0], 10);
        const returnMinutes = parseInt(parts[1], 10);
        
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();
        
        const currentTotalMin = (currentHours * 60) + currentMinutes;
        const returnTotalMin = (returnHours * 60) + returnMinutes;
        
        // ถ้าเวลาปัจจุบันเลยเวลาที่ขออนุญาตกลับเข้าแล้ว -> หมดเวลา
        if (currentTotalMin > returnTotalMin) {
          return true;
        }
      }
    }
  }
  
  return false;
}

async function fetchActiveRequest() {
  try {
    const res = await fetch('/api/requests');
    const data = await res.json();
    allRequestsList = data.requests || [];
    
    const user = getCurrentUser();
    const myRequests = (user && user.role === 'student') ? getStudentRequests(user) : allRequestsList;

    if (myRequests.length > 0) {
      // ดึงคำร้องล่าสุดของนักเรียนคนนี้เสมอ
      const latest = myRequests[0];

      if (latest.status === 'returned') {
        // สแกนกลับเข้าสถานศึกษาแล้ว -> เสร็จสิ้น
        activeRequest = null;
        currentToken = '';
      } else if (latest.status === 'rejected') {
        // ตรวจสอบว่ากดรับทราบแล้วหรือยัง
        const isDismissed = localStorage.getItem('ack_rejected_' + latest.id) === 'true';
        if (isDismissed) {
          activeRequest = null;
          currentToken = '';
        } else {
          activeRequest = latest;
          currentToken = '';
        }
      } else if (isRequestExpired(latest)) {
        // คำร้องหมดอายุตามวันและเวลา (Single-Day Permit) -> หายไปจากหน้าหลัก ย้ายไปเก็บในประวัติคำร้อง
        activeRequest = null;
        currentToken = '';
      } else {
        // คำร้องอยู่ระหว่างรออนุมัติ หรืออนุมัติแล้ว และยังไม่หมดเวลา
        activeRequest = latest;
        if (activeRequest.qrToken && (activeRequest.status === 'approved' || activeRequest.status === 'exited' || activeRequest.status === 'gate_opened')) {
          currentToken = activeRequest.qrToken;
          renderQrCode(currentToken);
        } else {
          currentToken = '';
        }
      }
    } else {
      activeRequest = null;
      currentToken = '';
    }

    // อัปเดตการ์ดสถานะคำขอในหน้าหลัก (นักเรียน) และแดชบอร์ดหน้าหลัก (ผู้อนุมัติ)
    renderHomeStatusCard();
    renderApproverHomeDashboard();
    // อัปเดตรายการประวัติคำร้องของนักเรียน
    renderStudentHistory();
    // อัปเดตหน้าสถานะและขั้นตอนคำร้อง
    renderStatusPage();
    // อัปเดตตัวเลขสถิติในหน้าโปรไฟล์แยกตามบทบาทจริง
    updateProfileStats();
  } catch (err) {
    console.error('Fetch requests failed:', err);
  }
}

// ฟังก์ชันอัปเดตตัวเลขสถิติในหน้าโปรไฟล์แยกตามบทบาท 100%
function updateProfileStats() {
  const user = getCurrentUser();
  if (!user) return;

  const profTotal = document.getElementById('prof-stat-total');
  const profApproved = document.getElementById('prof-stat-approved');
  const semesterLabelEl = document.getElementById('prof-semester-label');
  const profTotalLeaves = document.getElementById('prof-stat-total-leaves');
  const profOnTime = document.getElementById('prof-stat-on-time');
  const profLate = document.getElementById('prof-stat-late');
  const profNoReturn = document.getElementById('prof-stat-no-return');

  const semesterInfo = getSemesterInfo();
  if (semesterLabelEl) semesterLabelEl.textContent = semesterInfo.label;

  if (user.role === 'student') {
    // นักเรียน: คำนวณสถิติ 4 ตัวชี้วัดประจำภาคเรียนปัจจุบัน (ขอออก / ตามเวลา / กลับช้า / ไม่พบสแกนกลับ)
    const stats = calculateStudentSemesterStats(user.student_code || user.username || user.id);
    if (profTotalLeaves) profTotalLeaves.textContent = stats.totalLeaves;
    if (profOnTime) profOnTime.textContent = stats.onTimeCount;
    if (profLate) profLate.textContent = stats.lateCount;
    if (profNoReturn) profNoReturn.textContent = stats.noReturnCount;

    if (profTotal) profTotal.textContent = stats.totalLeaves;
    if (profApproved) profApproved.textContent = stats.onTimeCount;
  } else {
    // ครูรายวิชา / ครูที่ปรึกษา / หัวหน้าแผนก / ฝ่ายปกครอง / รองผู้อำนวยการ / admin
    const pendingForMe = allRequestsList.filter(r => isRequestInApproverQueue(user, r, false));
    const passedOrApproved = allRequestsList.filter(r => {
      const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
      const myStep = getApproverStepForRole(user.role, totalSteps);
      const isFinalApproved = r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
      return (r.currentStep > myStep) || isFinalApproved;
    });
    if (profTotal) profTotal.textContent = allRequestsList.length;
    if (profApproved) profApproved.textContent = passedOrApproved.length;
    if (profTotalLeaves) profTotalLeaves.textContent = allRequestsList.length;
    if (profOnTime) profOnTime.textContent = passedOrApproved.length;
    if (profLate) profLate.textContent = pendingForMe.length;
    if (profNoReturn) profNoReturn.textContent = '0';
  }
}

function dismissRejectedRequest(requestId) {
  if (requestId) {
    localStorage.setItem('ack_rejected_' + requestId, 'true');
  }
  activeRequest = null;
  currentToken = '';
  renderHomeStatusCard();
  renderStatusPage();
}

function renderStudentHistory() {
  const container = document.getElementById('student-history-container');
  const countEl = document.getElementById('history-total-count');
  if (!container) return;

  const user = getCurrentUser();
  const myRequests = (user && user.role === 'student') ? getStudentRequests(user) : allRequestsList;
  const count = myRequests.length;
  if (countEl) {
    countEl.innerText = count === 0 ? 'ยังไม่มีรายการคำร้องย้อนหลัง' : `รายการคำร้องย้อนหลังทั้งหมด ${count} รายการ`;
  }

  if (count === 0) {
    container.innerHTML = `
      <div class="bg-white rounded-3xl p-8 text-center space-y-3 border border-slate-200 shadow-sm">
        <div class="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 mx-auto flex items-center justify-center text-2xl">
          <i class="fa-solid fa-clock-rotate-left"></i>
        </div>
        <div>
          <h4 class="font-bold text-slate-800 text-base">ยังไม่มีประวัติคำร้องขออนุญาต</h4>
          <p class="text-xs text-slate-400 mt-0.5">ท่านยังไม่มีรายการคำร้องที่ยื่นในระบบ</p>
        </div>
        <div class="pt-2">
          <button onclick="tryOpenLeaveForm()" class="px-5 py-2.5 bg-[#0d55cf] hover:bg-blue-700 text-white rounded-2xl text-xs font-bold shadow-md transition inline-flex items-center gap-1.5 hover:scale-[1.01]">
            <i class="fa-solid fa-plus text-[10px]"></i> ยื่นคำร้องใหม่
          </button>
        </div>
      </div>
    `;
    return;
  }

  let html = '';
  myRequests.forEach((r, idx) => {
    const isCurrentActive = Boolean(activeRequest && activeRequest.id === r.id);
    const isExpired = isRequestExpired(r) || r.status === 'expired';
    const clickAction = (isCurrentActive && !isExpired) ? `setViewMode('status')` : `viewRequestDetail(${r.id})`;
    const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
    const stepPos = getStepPositionLabel(r.currentStep || 1, totalSteps);

    let statusBadge = '';
    if (r.status === 'approved') {
      if (isExpired) {
        statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-clock-rotate-left text-[10px]"></i> หมดเวลาใช้งาน</span>`;
      } else {
        statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-circle-check text-[10px]"></i> อนุมัติแล้ว</span>`;
      }
    } else if (r.status === 'rejected') {
      statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-xmark text-[10px]"></i> ไม่อนุมัติ</span>`;
    } else if (r.status === 'returned') {
      statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-person-walking-arrow-loop text-[10px]"></i> เข้าสถานศึกษาแล้ว</span>`;
    } else if (isExpired) {
      statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-clock-rotate-left text-[10px]"></i> หมดอายุอัตโนมัติ</span>`;
    } else {
      statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-bold flex items-center gap-1"><i class="fa-solid fa-clock text-[10px]"></i> รอ${stepPos.short} (${r.currentStep || 1}/${totalSteps})</span>`;
    }

    const currentPill = (isCurrentActive && !isExpired) 
      ? `<span class="text-[10px] bg-blue-100 text-[#0d55cf] border border-blue-200 px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1"><i class="fa-solid fa-bolt text-[9px] text-blue-500"></i> คำขอปัจจุบัน</span>` 
      : '';

    const subjectInfoHtml = totalSteps === 5 ? (
      r.step1Skipped
        ? `<div class="col-span-2 text-[11px] text-slate-500 bg-slate-50 px-2.5 py-1.5 rounded-xl border border-dashed border-slate-300 flex items-center gap-1.5"><span class="font-bold text-slate-600">✕ ไม่มีคาบเรียน:</span> <span>${r.step1SkipReason || 'ไม่ต้องผ่านครูรายวิชา'}</span></div>`
        : `<div class="col-span-2 text-[11px] text-sky-800 bg-sky-50/70 px-2.5 py-1.5 rounded-xl border border-sky-200 flex items-center gap-1.5 flex-wrap"><i class="fa-solid fa-book-open text-sky-600 text-[10px]"></i> <span>วิชา: <strong>${r.subjectName || '-'}</strong> • ครูรายวิชา: <strong>${r.subjectTeacherName || '-'}</strong></span></div>`
    ) : '';

    html += `
      <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border ${isCurrentActive ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-200'} transition space-y-3 relative overflow-hidden">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-sm font-bold">${idx + 1}</div>
            <span class="font-bold text-slate-800 text-sm font-mono">${r.requestNo}</span>
            ${currentPill}
          </div>
          ${statusBadge}
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs text-slate-600">
          <div><span class="text-slate-400">ประเภท:</span> <strong class="text-slate-800">${r.title || r.reason || 'ลากิจธุระ'}</strong></div>
          <div><span class="text-slate-400">วันที่:</span> <strong class="text-slate-800">${r.leaveDate || '-'}</strong></div>
          <div><span class="text-slate-400">ช่วงเวลา:</span> ${r.departureTime || '-'} - ${r.expectedReturnTime || '-'} น.</div>
          <div><span class="text-slate-400">ยานพาหนะ:</span> ${r.plateNo || '-'}</div>
          ${subjectInfoHtml}
        </div>
        <!-- Compact Unified Stepper (Requirement 15: หน้าสถานะ หน้าประวัติ และหน้าอนุมัติใช้สัญลักษณ์ชุดเดียวกัน) -->
        ${renderUnifiedStepper(r, true)}
        <div class="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
          <button onclick="${clickAction}" class="px-3.5 py-1.5 ${isCurrentActive ? 'bg-[#0d55cf] text-white hover:bg-blue-700' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'} rounded-xl text-xs font-semibold transition flex items-center gap-1 shadow-sm">
            <i class="fa-solid fa-eye"></i> ${isCurrentActive ? 'ดูสถานะปัจจุบัน' : 'ดูรายละเอียด & ประวัติอนุมัติ'}
          </button>
          ${(r.status === 'approved' && r.qrToken) ? `
            <button onclick="${isCurrentActive ? `setViewMode('qr')` : `viewHistoricalQrPass('${r.qrToken}')`}" class="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-sm transition flex items-center gap-1">
              <i class="fa-solid fa-qrcode"></i> เปิด QR Pass
            </button>
          ` : ''}
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

// ====================== 4.1 VIEW SPECIFIC REQUEST DETAILS ======================
let currentViewingRequestId = null;

function viewRequestDetail(requestId) {
  currentViewingRequestId = requestId;
  const r = allRequestsList.find(x => x.id === requestId);
  if (!r) {
    alert('ไม่พบข้อมูลคำร้องนี้');
    return;
  }

  const container = document.getElementById('history-detail-content');
  if (!container) return;

  const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
  const step = r.currentStep || 1;
  const isApproved = r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
  const isRejected = r.status === 'rejected';
  const isExpired = r.status === 'expired' || isRequestExpired(r);
  const isReturned = r.status === 'returned';
  const stepPos = getStepPositionLabel(step, totalSteps);

  // Top Badge
  let topBadge = '';
  if (isReturned) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-person-walking-arrow-loop text-[10px]"></i> เข้าสถานศึกษาแล้ว</span>`;
  } else if (isApproved) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-circle-check text-[10px]"></i> อนุมัติสมบูรณ์แล้ว</span>`;
  } else if (isRejected) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-rose-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-circle-xmark text-[10px]"></i> ไม่อนุมัติ</span>`;
  } else if (isExpired) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-slate-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-clock-rotate-left text-[10px]"></i> หมดอายุอัตโนมัติ</span>`;
  } else {
    topBadge = `<span class="px-3 py-1 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-clock text-[10px]"></i> รอ${stepPos.short} (${step}/${totalSteps})</span>`;
  }

  container.innerHTML = `
    <!-- 1. Unified 5-Step Stepper Card -->
    <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border border-slate-200 space-y-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg shrink-0">
            <i class="fa-solid fa-clock-rotate-left"></i>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-base leading-tight">ขั้นตอนผลการพิจารณาคำร้อง (${totalSteps} ขั้น)</h3>
            <p class="text-xs text-slate-400">${totalSteps === 4 ? 'ครูที่ปรึกษา → หัวหน้าแผนก → ฝ่ายปกครอง/หลักสูตร → รองผู้อำนวยการ' : (totalSteps === 5 ? 'ครูรายวิชา → ครูที่ปรึกษา → หัวหน้าแผนก → ฝ่ายปกครอง → รองผู้อำนวยการ' : 'ครูที่ปรึกษา → หัวหน้าแผนก → ฝ่ายปกครอง')}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="manualRefreshStatus()" title="อัปเดตสถานะทันที" class="px-2.5 py-1 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center gap-1 text-xs font-bold transition shadow-xs active:scale-95">
            <i class="fa-solid fa-rotate btn-refresh-status-icon"></i> รีเฟรช
          </button>
          <span class="text-xs font-mono font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-xl border border-slate-200">${r.requestNo}</span>
        </div>
      </div>

      ${renderUnifiedStepper(r, false)}
    </div>

    <!-- 2. Details & Approval History Card -->
    <div class="bg-white rounded-3xl p-5 shadow-sm border border-slate-200 space-y-4">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-file-lines text-blue-600 text-lg"></i>
          <span class="font-bold text-slate-800 text-sm">ข้อมูลคำร้องและประวัติการอนุมัติทุกขั้น</span>
        </div>
        ${topBadge}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 text-xs sm:text-sm">
        <div class="sm:col-span-6 space-y-2 text-slate-600">
          <p><span class="text-slate-400">เลขที่คำร้อง:</span> <strong class="text-slate-800 font-mono">${r.requestNo}</strong></p>
          <p><span class="text-slate-400">ชื่อ-สกุล:</span> <strong class="text-slate-800">${r.studentName}</strong></p>
          <p><span class="text-slate-400">รหัสนักศึกษา:</span> ${formatStudentCode(r.studentCode)} (${r.classroomName || 'ปวช.3'})</p>
          <p><span class="text-slate-400">แผนกวิชา:</span> ${r.deptName || '-'}</p>
          <p><span class="text-slate-400">ประเภทลา:</span> <span class="text-blue-600 font-bold">${r.title || r.reason || 'ลากิจธุระจำเป็น'}</span></p>
          <p><span class="text-slate-400">เวลาออก:</span> ${r.leaveDate || '-'} (${r.departureTime || '-'} - ${r.expectedReturnTime || '-'} น.)</p>
          <p><span class="text-slate-400">ช่วงเวลาคาบเรียน:</span> <strong class="text-sky-700">${r.periodTime || (r.departureTime + ' - ' + r.expectedReturnTime + ' น.')}</strong></p>
          <p><span class="text-slate-400">ยานพาหนะ:</span> ${r.plateNo || '-'}</p>
          <p><span class="text-slate-400">เหตุผลที่ระบุ:</span> ${r.reason || '-'}</p>
        </div>

        <div class="sm:col-span-6">
          ${renderApprovalHistoryTimeline(r)}
        </div>
      </div>

      ${isRejected ? `
        <div class="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-800 space-y-1">
          <div class="font-bold flex items-center gap-1.5">
            <i class="fa-solid fa-circle-exclamation text-rose-500"></i> เหตุผลที่ไม่อนุมัติ (${r.rejectedByRoleLabel || 'ผู้อนุมัติ'}):
          </div>
          <p class="pl-5 text-rose-900 font-medium">${r.rejectionReason || 'ไม่ผ่านเกณฑ์การพิจารณาอนุญาต'}</p>
        </div>
      ` : ''}

      <div class="pt-3 border-t border-slate-100 flex flex-col sm:flex-row items-center gap-2">
        <button onclick="setViewMode('history')" class="w-full sm:flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-2xl text-xs transition flex items-center justify-center gap-2">
          <i class="fa-solid fa-arrow-left"></i> กลับไปหน้ารายการประวัติ
        </button>
        ${(isApproved && r.qrToken) ? `
          <button onclick="viewHistoricalQrPass('${r.qrToken}')" class="w-full sm:flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-2xl text-xs shadow-md transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-qrcode"></i> เปิดดู QR Pass ใบนี้
          </button>
        ` : ''}
      </div>
    </div>
  `;

  setViewMode('history-detail');
}

function viewHistoricalQrPass(qrToken) {
  currentToken = qrToken;
  setViewMode('qr');
  renderQrCode(currentToken);
}

// ====================== 4.2 RENDER APPROVER HOME DASHBOARD (สำหรับทุกบทบาทผู้อนุมัติ 5 ขั้น) ======================
function renderApproverHomeDashboard() {
  const user = getCurrentUser();
  if (!user || user.role === 'student') return;

  const targetStep5 = getApproverStepForRole(user.role, 5);
  const stepPos = getStepPositionLabel(targetStep5, 5);
  const stepTitle = stepPos.title;

  const userDept = user.departments ? user.departments.name : (user.dept || user.department || '');
  const cleanUserDept = userDept.replace('แผนกวิชา', '').trim();

  // กรองคำร้องรอพิจารณาที่ถึงคิวของตนเอง
  const pending = allRequestsList.filter(r => isRequestInApproverQueue(user, r, false));

  // ยอดอนุมัติแล้ว: คำร้องที่ผ่านขั้นของบทบาทนี้ไปแล้ว
  const approved = allRequestsList.filter(r => {
    const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
    const myStep = getApproverStepForRole(user.role, totalSteps);
    const isFinalApproved = r.status === 'approved' || r.status === 'exited' || r.status === 'returned';
    if (!((r.currentStep > myStep) || isFinalApproved)) return false;

    if (user.role === 'subject_teacher') {
      const historyHasMe = Array.isArray(r.approvalHistory) && r.approvalHistory.some(h => h.approverUsername === user.username);
      if (r.subjectTeacherUsername && r.subjectTeacherUsername !== user.username && !historyHasMe) {
        if (cleanUserDept && !isDepartmentMatch(cleanUserDept, r.deptName)) return false;
      }
    } else if (user.role === 'advisor' || user.role === 'dept_head') {
      if (cleanUserDept && !isDepartmentMatch(cleanUserDept, r.deptName)) return false;
    }
    return true;
  });

  // ยอดไม่อนุมัติในขั้นของบทบาทนี้
  const rejected = allRequestsList.filter(r => {
    const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
    const myStep = getApproverStepForRole(user.role, totalSteps);
    if (r.status !== 'rejected' || r.currentStep !== myStep) return false;
    if (user.role === 'advisor' || user.role === 'dept_head' || user.role === 'subject_teacher') {
      if (cleanUserDept && r.deptName && !isDepartmentMatch(cleanUserDept, r.deptName)) return false;
    }
    return true;
  });

  // กรองตามชั้นปีถ้ามีการเลือกเฉพาะชั้นปี (รองรับ Multi-Select)
  const isAllGrades = selectedApprovalGrades.includes('all');
  const filteredPending = isAllGrades 
    ? pending 
    : pending.filter(r => isClassroomMatch(r.classroomName, selectedApprovalGrades));
  const filteredApproved = isAllGrades
    ? approved
    : approved.filter(r => isClassroomMatch(r.classroomName, selectedApprovalGrades));
  const filteredRejected = isAllGrades
    ? rejected
    : rejected.filter(r => isClassroomMatch(r.classroomName, selectedApprovalGrades));

  // อัปเดตตัวเลขสถิติ 3 ช่อง
  const elPending = document.getElementById('approver-stat-pending');
  const elApproved = document.getElementById('approver-stat-approved');
  const elRejected = document.getElementById('approver-stat-rejected');
  if (elPending) elPending.textContent = filteredPending.length;
  if (elApproved) elApproved.textContent = filteredApproved.length;
  if (elRejected) elRejected.textContent = filteredRejected.length;
  updateBottomApprovalBadge(pending.length);

  // อัปเดต Dropdown เลือกชั้นปี
  updateGradeFilterDropdownUI();

  // อัปเดตข้อความปุ่มล่าง (มีระบุจำนวนรายการรอตรวจชัดเจน)
  const elBtnText = document.getElementById('home-approver-btn-text');
  if (elBtnText) {
    const gradeHint = isAllGrades ? '' : ` [${selectedApprovalGrades.join(', ')}]`;
    elBtnText.textContent = filteredPending.length > 0 
      ? `ไปยังหน้ารายการพิจารณาอนุมัติ (${filteredPending.length} รายการรอฉัน${gradeHint})`
      : `ไปยังหน้ารายการพิจารณาอนุมัติ (ไม่มีรายการรอฉัน${gradeHint})`;
  }

  // อัปเดตการ์ดย่อของคำร้องล่าสุดที่กำลังรอคิวอนุมัติ
  const container = document.getElementById('home-pending-preview-container');
  if (!container) return;

  if (filteredPending.length > 0) {
    const p = filteredPending[0];
    const totalSteps = Number(p.totalSteps) === 3 ? 3 : 5;
    container.innerHTML = `
      <div onclick="setViewMode('approval'); setApprovalTab('pending');" class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border border-amber-300 ring-2 ring-amber-100/80 hover:border-amber-400 hover:shadow-md transition cursor-pointer space-y-3 group">
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></span>
            <span class="font-bold text-slate-800 text-sm sm:text-base font-mono">${p.requestNo}</span>
            <span class="text-[9px] bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full font-bold">รอ${stepTitle} (ขั้น ${p.currentStep || 1}/${totalSteps})</span>
            ${(p.no_return || p.expectedReturnTime === 'NO_RETURN' || p.leaveType === 'no_return') ? `
              <span class="px-2 py-0.5 rounded-full bg-amber-500 text-white font-bold text-[9px] inline-flex items-center gap-1 shadow-2xs">
                <i class="fa-solid fa-house-chimney-user text-[8px]"></i> ลากลับ
              </span>
            ` : ''}
          </div>
          <span class="text-[10px] text-slate-400 font-medium">รอมาแล้ว ${p.waitingMinutes || 0} นาที</span>
        </div>

        <div class="space-y-1 text-xs text-slate-600">
          <div class="flex items-center justify-between">
            <span class="text-slate-800 font-bold text-sm">${p.studentName}</span>
            <span class="text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-md font-bold text-[11px]">
              <i class="fa-solid fa-graduation-cap text-[10px] mr-1"></i>${p.classroomName || 'ปวช.3'}
            </span>
          </div>
          <p><span class="text-slate-400">รหัสนักศึกษา:</span> <span class="font-mono">${p.studentCode}</span> • <span class="text-slate-500">${p.deptName || '-'}</span></p>
          <p><span class="text-slate-400">ประเภทการลา:</span> <strong class="text-blue-600">${p.title || p.reason || 'ลากิจธุระ'}</strong></p>
          <p><span class="text-slate-400">คาบเรียน:</span> ${p.step1Skipped ? `<span class="text-slate-500">✕ ไม่มีคาบเรียน (${p.step1SkipReason || '-'})</span>` : `<strong class="text-sky-700">${p.subjectName || '-'} (${p.subjectTeacherName || '-'})</strong>`}</p>
          <p><span class="text-slate-400">ช่วงเวลาที่ออก:</span> ${(p.no_return || p.expectedReturnTime === 'NO_RETURN' || p.leaveType === 'no_return') ? `<strong class="text-amber-600">ออก ${p.departureTime || '-'} น. (ลากลับบ้าน)</strong>` : `${p.leaveDate || '-'} (${p.departureTime || '-'} - ${p.expectedReturnTime || '-'} น.)`}</p>
        </div>

        <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-xs font-bold">
          <span class="text-[11px] text-slate-400 font-normal">แตะการ์ดนี้เพื่อเข้าสู่คิว "รอฉัน"</span>
          <span class="flex items-center gap-1 group-hover:translate-x-1 transition text-blue-600">
            เปิดพิจารณาคำร้องนี้ <i class="fa-solid fa-arrow-right text-[10px]"></i>
          </span>
        </div>
      </div>
    `;
  } else {
    const isAllGrades = selectedApprovalGrades.includes('all');
    const gradeHint = isAllGrades ? '' : `ชั้น ${selectedApprovalGrades.join(', ')} `;
    container.innerHTML = `
      <div onclick="setViewMode('approval');" class="bg-white rounded-3xl p-6 sm:p-7 text-center space-y-2 border border-slate-200 shadow-sm cursor-pointer hover:border-blue-200 transition">
        <div class="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center text-xl shadow-sm">
          <i class="fa-solid fa-clipboard-check"></i>
        </div>
        <div>
          <h4 class="font-bold text-slate-800 text-sm sm:text-base">ไม่มีคำร้อง${gradeHint}ในคิว "รอฉัน" ขณะนี้</h4>
          <p class="text-xs text-slate-400 mt-0.5">ท่านได้ตรวจสอบคำร้องที่ถึงคิวของท่านครบถ้วนแล้ว หรือแตะเพื่อดูประวัติ/อนุมัติแทนครูท่านอื่น</p>
        </div>
      </div>
    `;
  }

  // ตรวจสอบและแสดงป้ายแจ้งเตือนนักเรียนเลยเวลากลับเกิน 15 นาที
  checkAndRenderApproverOverdueBanner();

  // โหลดรายการสดการกลับเข้าวิทยาลัยสำหรับฝ่ายปกครอง & ผู้บริหาร
  if (user && ['discipline_head', 'admin', 'deputy_director', 'advisor', 'dept_head'].includes(user.role)) {
    loadDisciplineLiveReturns();
  }
}

async function checkAndRenderApproverOverdueBanner() {
  const banner = document.getElementById('approver-overdue-banner');
  const countEl = document.getElementById('approver-overdue-count');
  const listEl = document.getElementById('approver-overdue-list');
  if (!banner) return;

  try {
    const res = await fetch('/api/requests/overdue-status');
    const data = await res.json();

    if (data.success && data.overdueCount > 0) {
      banner.classList.remove('hidden');
      if (countEl) countEl.innerText = `${data.overdueCount} คน`;

      if (listEl) {
        listEl.innerHTML = data.overdueItems.map(item => `
          <div class="p-2.5 rounded-xl bg-white/90 border border-rose-300 flex flex-wrap items-center justify-between gap-2 shadow-xs">
            <div>
              <div class="font-bold text-slate-800 text-xs">${item.studentName} (${item.deptName})</div>
              <div class="text-[11px] text-rose-700">
                กำหนดกลับ: ${item.expectedReturnTime} น. • <span class="font-bold">สายแล้ว ${item.diffMinutes} นาที</span> (รถ: ${item.plateNo})
              </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <a href="tel:${item.parentPhone}" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold inline-flex items-center gap-1 transition shadow-xs">
                <i class="fa-solid fa-phone"></i> โทรหาผู้ปกครอง
              </a>
            </div>
          </div>
        `).join('');
      }
    } else {
      banner.classList.add('hidden');
    }
  } catch (err) {
    console.warn('Failed to fetch overdue status:', err);
  }
}

// ====================== 5. RENDER HOME STATUS CARD ======================
function renderHomeStatusCard() {
  const container = document.getElementById('home-current-status-box');
  if (!container) return;

  // 1. ถ้าไม่มีคำร้อง หรือสแกนกลับเข้าสถานศึกษาแล้ว (returned) -> แสดง "ไม่มีคำขอ" (สูงครึ่งนึง กะทัดรัด)
  if (!activeRequest || activeRequest.status === 'returned') {
    container.className = 'bg-white text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border border-slate-200 space-y-2 transition';
    container.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center text-sm shrink-0">
            <i class="fa-solid fa-clipboard-check"></i>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-sm leading-tight">สถานะคำขอปัจจุบัน</h3>
            <p class="text-[10px] text-slate-400">ระบบขออนุญาต OnePass</p>
          </div>
        </div>
        <span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-bold text-[10px] border border-slate-200 shrink-0">
          <i class="fa-solid fa-circle-minus mr-0.5 text-slate-400"></i> ไม่มีคำขอ
        </span>
      </div>
      <div class="bg-slate-50 rounded-xl px-3 py-2 border border-slate-100 text-[11px] text-slate-500 flex items-center gap-2">
        <i class="fa-solid fa-circle-info text-blue-500 text-xs shrink-0"></i>
        <span>ยังไม่มีคำร้องที่เปิดใช้งาน หรือกลับเข้าสถานศึกษาเรียบร้อยแล้ว</span>
      </div>
    `;
    return;
  }

  // 2. ถ้าคำร้องล่าสุดถูกไม่อนุมัติ (rejected) และยังไม่ได้กดรับทราบ
  if (activeRequest.status === 'rejected') {
    container.className = 'bg-white text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border border-rose-200 ring-1 ring-rose-100 space-y-2.5 transition';
    container.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl bg-rose-50 text-rose-600 border border-rose-200/60 flex items-center justify-center text-sm shrink-0">
            <i class="fa-solid fa-circle-xmark"></i>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-sm leading-tight">คำร้องไม่ได้รับการอนุมัติ</h3>
            <p class="text-[10px] text-rose-600 font-medium">รายการล่าสุดของคุณถูกปฏิเสธ</p>
          </div>
        </div>
        <span class="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold text-[10px] shrink-0">
          <i class="fa-solid fa-xmark mr-0.5 text-rose-500"></i> ไม่อนุมัติ
        </span>
      </div>

      <div class="bg-rose-50/60 rounded-xl px-3 py-2 border border-rose-100 text-xs text-slate-700 space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-800">${activeRequest.requestNo}</span>
          <span class="text-[11px] text-slate-500">${activeRequest.title || 'ลากิจธุระ'}</span>
        </div>
        <p class="text-[11px] text-rose-700 font-medium">
          <strong>เหตุผล:</strong> ${activeRequest.rejectionReason || 'ไม่ผ่านเกณฑ์การพิจารณาอนุญาต'}
        </p>
      </div>

      <div class="grid grid-cols-2 gap-2 pt-0.5">
        <button onclick="dismissRejectedRequest(${activeRequest.id})" class="py-2.5 px-3 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 shadow-sm">
          <i class="fa-solid fa-check"></i> รับทราบ
        </button>
        <button onclick="dismissRejectedRequest(${activeRequest.id}); tryOpenLeaveForm();" class="py-2.5 px-3 bg-[#0d55cf] hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 shadow-sm">
          <i class="fa-solid fa-file-pen"></i> ยื่นใหม่
        </button>
      </div>
    `;
    return;
  }

  // ถ้าอนุมัติแล้ว พร้อม QR (status === 'approved' หรือ 'exited') (ลดความสูงลงมาครึ่งนึง ตามสั่ง)
  if (activeRequest.status === 'approved' || activeRequest.status === 'exited') {
    const isExited = activeRequest.status === 'exited';
    
    // ตรวจสอบสถานะเตือน 30 นาที และสายเกิน 15 นาที
    let alertHtml = '';
    let containerStyle = 'bg-white text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border border-emerald-200/90 space-y-2.5 transition';

    if (isExited && activeRequest.expectedReturnTime) {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const [rH, rM] = activeRequest.expectedReturnTime.split(':').map(Number);
      const returnMinutes = rH * 60 + (rM || 0);
      const diffMins = currentMinutes - returnMinutes;

      if (diffMins >= 15) {
        containerStyle = 'bg-rose-50/30 text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border-2 border-rose-400 ring-2 ring-rose-200/60 space-y-2.5 transition';
        alertHtml = `
          <div class="p-3 rounded-xl bg-rose-100 border border-rose-300 text-rose-900 text-xs font-bold space-y-1 animate-pulse">
            <div class="flex items-center gap-2 text-rose-700">
              <i class="fa-solid fa-triangle-exclamation text-base"></i>
              <span>เลยเวลากลับเกิน 15 นาทีแล้ว! (สายแล้ว ${diffMins} นาที)</span>
            </div>
            <p class="text-[11px] font-normal text-rose-700 pl-6">
              ระบบได้ส่งแจ้งเตือนเข้า LINE ครูที่ปรึกษาและฝ่ายปกครองแล้ว กรุณารีบเดินทางกลับและสแกนเข้าประตูทันที
            </p>
          </div>
        `;
      } else if (diffMins >= -30 && diffMins < 0) {
        containerStyle = 'bg-amber-50/30 text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border-2 border-amber-400 ring-2 ring-amber-100 space-y-2.5 transition';
        alertHtml = `
          <div class="p-2.5 rounded-xl bg-amber-100/90 border border-amber-300 text-amber-900 text-xs font-bold flex items-center gap-2 animate-pulse">
            <i class="fa-solid fa-bell text-amber-600 text-sm"></i>
            <span>ใกล้ครบเวลากลับแล้ว! เหลือเวลาอีก ${Math.abs(diffMins)} นาที (กำหนดเข้า: ${activeRequest.expectedReturnTime} น.)</span>
          </div>
        `;
      }
    }

    container.className = containerStyle;
    container.innerHTML = `
      ${alertHtml}
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl ${isExited ? 'bg-indigo-50 text-indigo-600 border border-indigo-200/60' : 'bg-emerald-50 text-emerald-600 border border-emerald-200/60'} flex items-center justify-center text-sm shrink-0">
            <i class="fa-solid ${isExited ? 'fa-person-walking-arrow-right' : 'fa-circle-check'}"></i>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-sm leading-tight">สถานะคำขอปัจจุบัน</h3>
            <p class="text-[10px] ${isExited ? 'text-indigo-600' : 'text-emerald-600'} font-medium">${isExited ? 'กำลังอยู่นอกสถานศึกษา' : 'คำร้องได้รับการอนุมัติแล้ว'}</p>
          </div>
        </div>
        <span class="px-2 py-0.5 rounded-full ${isExited ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'} font-bold text-[10px] shrink-0">
          <i class="fa-solid ${isExited ? 'fa-person-walking-arrow-right' : 'fa-check'} mr-0.5"></i>
          ${isExited ? 'สแกนออกแล้ว' : 'พร้อมสแกนประตู'}
        </span>
      </div>

      <div class="bg-gradient-to-r from-emerald-50/60 to-slate-50/60 rounded-xl px-3 py-2 border border-emerald-100 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-1">
        <div class="flex items-center gap-1.5">
          <span class="font-bold text-slate-800">${activeRequest.requestNo || '-'}</span>
          <span class="text-slate-300">•</span>
          <span class="text-slate-600">${activeRequest.title || 'ลากิจธุระจำเป็น'}</span>
        </div>
        <div class="font-semibold text-emerald-700 text-[11px]">
          <i class="fa-regular fa-clock mr-0.5"></i> ${activeRequest.departureTime || '13:00'} - ${activeRequest.expectedReturnTime || '15:30'} น.
        </div>
      </div>

      ${isExited ? `
        <!-- ส่วนสำหรับนักเรียนที่สแกนออกแล้ว: ปุ่ม "กลับมาแล้ว" พร้อมตัวจำลองระยะโมเดล 60 ซม. -->
        <div class="bg-gradient-to-br from-blue-50/90 to-indigo-50/90 rounded-2xl p-3 border-2 border-blue-400 space-y-2.5 shadow-xs">
          <div class="flex items-center justify-between text-xs">
            <span class="font-bold text-slate-800 flex items-center gap-1.5">
              <i class="fa-solid fa-ruler-horizontal text-blue-600"></i>
              <span>ตรวจระยะโมเดล (ฐานยาว 60 ซม.)</span>
            </span>
            <span id="student-sim-dist-badge" class="px-2 py-0.5 rounded-full text-[10.5px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
              25 ซม. (ในระยะ ✅)
            </span>
          </div>

          <!-- Presets จำลองระยะโมเดลฐาน 60 ซม. -->
          <div class="grid grid-cols-3 gap-1 text-center">
            <button type="button" onclick="setSimDistance(25)" id="sim-btn-25" class="py-1.5 px-1 rounded-lg border text-[11px] font-bold bg-blue-100 border-blue-500 text-blue-900 shadow-2xs transition">
              🎯 25 ซม. (ในฐาน)
            </button>
            <button type="button" onclick="setSimDistance(55)" id="sim-btn-55" class="py-1.5 px-1 rounded-lg border text-[11px] font-bold bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 transition">
              📍 55 ซม. (ขอบฐาน)
            </button>
            <button type="button" onclick="setSimDistance(95)" id="sim-btn-95" class="py-1.5 px-1 rounded-lg border text-[11px] font-bold bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 transition">
              ⚠️ 95 ซม. (นอกระยะ)
            </button>
          </div>

          <!-- Slider 0 - 150 cm -->
          <div class="px-1 pt-0.5 space-y-0.5">
            <div class="flex justify-between text-[9.5px] text-slate-400 font-mono">
              <span>0 ซม.</span>
              <span class="text-blue-700 font-bold">| เกณฑ์จำลอง 60 ซม. |</span>
              <span>150 ซม.</span>
            </div>
            <input type="range" id="student-sim-slider" min="5" max="150" value="25" step="1" oninput="onSimSliderChange(this.value)" class="w-full accent-blue-600 cursor-pointer">
          </div>

          <!-- ปุ่ม "ฉันกลับถึงวิทยาลัยแล้ว" -->
          <button type="button" id="btn-student-return" onclick="submitStudentReturn()" class="w-full py-3 bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] text-white rounded-xl font-bold text-xs sm:text-sm shadow-md flex items-center justify-center gap-2 transition">
            <i class="fa-solid fa-person-walking-arrow-loop-left text-base"></i>
            <span>📍 ฉันกลับถึงวิทยาลัยแล้ว</span>
          </button>
          <p class="text-[10px] text-center text-blue-600 font-medium">ขาเข้าไม่ต้องสแกน QR ที่ป้อมยาม ให้กดปุ่มนี้เพื่อบันทึกเวลากลับทันที</p>
        </div>
      ` : `
        <button onclick="setViewMode('qr')" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs sm:text-sm shadow-sm flex items-center justify-center gap-2 transition hover:scale-[1.005]">
          <i class="fa-solid fa-qrcode text-sm"></i> เปิดดู QR Code สแกนผ่านประตู (ขาออก)
        </button>
      `}
    `;
    return;
  }

  // ถ้าอยู่ระหว่างรออนุมัติ (pending_...) (รองรับทั้ง 5 ขั้นตอน และ 3 ขั้นตอนเดิม)
  const totalSteps = Number(activeRequest.totalSteps) === 3 ? 3 : 5;
  const curStep = activeRequest.currentStep || 1;
  const posInfo = getStepPositionLabel(curStep, totalSteps);
  const waitingTeacher = getRequestWaitingTeacherName(activeRequest, curStep);
  const stepLabel = `รอ${posInfo.short} (${curStep}/${totalSteps})`;

  container.className = 'bg-white text-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-sm border border-blue-200 space-y-2.5 transition';
  container.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 border border-blue-200/60 flex items-center justify-center text-sm shrink-0">
          <i class="fa-solid fa-clock-rotate-left"></i>
        </div>
        <div>
          <h3 class="font-bold text-slate-800 text-sm leading-tight">สถานะคำขอปัจจุบัน</h3>
          <p class="text-[10px] text-blue-600 font-medium">รอ: ${waitingTeacher} (${posInfo.title})</p>
        </div>
      </div>
      <span class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-bold text-[10px] shrink-0">
        <i class="fa-solid fa-hourglass-half mr-0.5 text-blue-500 text-[9px]"></i> ${stepLabel}
      </span>
    </div>

    <div class="bg-blue-50/40 rounded-xl px-3 py-2 border border-blue-100 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-1">
      <div class="flex items-center gap-1.5">
        <span class="font-bold text-slate-800">${activeRequest.requestNo}</span>
        <span class="text-slate-300">•</span>
        <span class="text-slate-600">${activeRequest.title}</span>
      </div>
      <span class="text-[11px] text-blue-600 font-medium"><i class="fa-regular fa-clock mr-0.5"></i> รอมาแล้ว ${activeRequest.waitingMinutes || 0} นาที</span>
    </div>

    ${renderUnifiedStepper(activeRequest, true)}

    <button onclick="setViewMode('status')" class="w-full py-2.5 bg-[#0d55cf] hover:bg-blue-700 text-white rounded-xl font-bold text-xs sm:text-sm shadow-sm flex items-center justify-center gap-2 transition hover:scale-[1.005]">
      <i class="fa-solid fa-clipboard-check text-xs"></i> ติดตามขั้นตอนการอนุมัติ (${totalSteps} ขั้น)
    </button>
  `;
}

// ====================== 6. RENDER DYNAMIC STATUS & WORKFLOW PAGE ======================
function renderStatusPage() {
  const container = document.getElementById('status-page-content');
  if (!container) return;

  if (!activeRequest || activeRequest.status === 'returned') {
    container.innerHTML = `
      <div class="bg-white rounded-3xl p-8 text-center space-y-3 border border-slate-200 shadow-sm">
        <div class="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 mx-auto flex items-center justify-center text-2xl">
          <i class="fa-solid fa-clipboard-question"></i>
        </div>
        <div>
          <h4 class="font-bold text-slate-800 text-base">ยังไม่มีคำร้องที่กำลังดำเนินการ</h4>
          <p class="text-xs text-slate-400 mt-0.5">คุณยังไม่ได้ยื่นคำร้องขออนุญาต หรือคำร้องเดิมเสร็จสิ้นเรียบร้อยแล้ว</p>
        </div>
        <div class="pt-2">
          <button onclick="tryOpenLeaveForm()" class="px-5 py-2.5 bg-[#0d55cf] hover:bg-blue-700 text-white rounded-2xl text-xs font-bold shadow-md transition inline-flex items-center gap-1.5 hover:scale-[1.01]">
            <i class="fa-solid fa-plus text-[10px]"></i> ยื่นคำร้องใหม่
          </button>
        </div>
      </div>
    `;
    return;
  }

  // ถ้าคำร้องล่าสุดถูกไม่อนุมัติ (rejected) และยังไม่ได้กดรับทราบ (Requirement 5: นักเรียนเห็นเหตุผล + Stepper ชัดเจน)
  if (activeRequest.status === 'rejected') {
    container.innerHTML = `
      <div class="bg-white rounded-3xl p-6 sm:p-8 text-center space-y-4 border border-rose-200 shadow-sm">
        <div class="w-16 h-16 rounded-3xl bg-rose-50 text-rose-500 mx-auto flex items-center justify-center text-3xl shadow-sm border border-rose-100">
          <i class="fa-solid fa-circle-xmark"></i>
        </div>
        <div>
          <span class="px-3 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold text-xs">คำร้องไม่ได้รับการอนุมัติ (สิ้นสุดทันที)</span>
          <h4 class="font-bold text-slate-800 text-lg mt-2">${activeRequest.requestNo}</h4>
          <p class="text-xs text-slate-500 mt-1">ประเภท: <strong>${activeRequest.title || 'ลากิจธุระ'}</strong></p>
        </div>

        <div class="max-w-xl mx-auto text-left">
          ${renderUnifiedStepper(activeRequest, false)}
        </div>

        <div class="max-w-md mx-auto bg-rose-50/70 border border-rose-200 rounded-2xl p-4 text-xs text-slate-700 text-left space-y-1">
          <div class="text-rose-800 font-bold flex items-center gap-1.5">
            <i class="fa-solid fa-circle-info text-rose-500"></i> เหตุผลที่ไม่อนุมัติ (${activeRequest.rejectedByRoleLabel || 'ผู้อนุมัติ'}):
          </div>
          <p class="text-rose-900 font-medium pl-5">${activeRequest.rejectionReason || 'ไม่ผ่านเกณฑ์การพิจารณาอนุญาต'}</p>
        </div>

        <div class="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2 max-w-sm mx-auto">
          <button onclick="dismissRejectedRequest(${activeRequest.id})" class="w-full sm:w-auto px-6 py-2.5 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 shadow-sm">
            <i class="fa-solid fa-check"></i> รับทราบ
          </button>
          <button onclick="dismissRejectedRequest(${activeRequest.id}); tryOpenLeaveForm();" class="w-full sm:w-auto px-6 py-2.5 bg-[#0d55cf] hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 shadow-sm">
            <i class="fa-solid fa-file-pen"></i> ยื่นคำร้องใหม่
          </button>
        </div>
      </div>
    `;
    return;
  }

  const r = activeRequest;
  const totalSteps = Number(r.totalSteps) === 3 ? 3 : 5;
  const step = r.currentStep || 1;
  const isApproved = r.status === 'approved' || r.status === 'exited';
  const isRejected = r.status === 'rejected';
  const isExpired = r.status === 'expired';
  // แสดงปุ่มยกเลิกเฉพาะเมื่อยังไม่มีผู้อนุมัติคนใดกดอนุมัติ (ขั้นที่ 1 หรือขั้นที่ 2 กรณีข้ามขั้นที่ 1)
  const canDelete = (!isApproved && !isRejected && !isExpired && (step === 1 || (step === 2 && r.step1Skipped)));
  const stepPos = getStepPositionLabel(step, totalSteps);
  const waitingTeacher = getRequestWaitingTeacherName(r, step);

  // ป้ายสถานะด้านบน
  let topBadge = '';
  if (isApproved) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-circle-check text-[10px]"></i> อนุมัติสมบูรณ์แล้ว</span>`;
  } else if (isRejected) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-rose-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-circle-xmark text-[10px]"></i> ไม่อนุมัติ</span>`;
  } else if (isExpired) {
    topBadge = `<span class="px-3 py-1 rounded-full bg-slate-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-clock-rotate-left text-[10px]"></i> หมดอายุอัตโนมัติ</span>`;
  } else {
    topBadge = `<span class="px-3 py-1 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-clock text-[10px]"></i> รอ${stepPos.short} (ขั้นที่ ${step}/${totalSteps})</span>`;
  }

  container.innerHTML = `
    <!-- 1. Top Card with Unified 5-Step Progress (Requirement 3 & 15) -->
    <div class="bg-white rounded-3xl p-4 sm:p-5 shadow-sm border border-slate-200 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
            <i class="fa-solid fa-clipboard-list"></i>
          </div>
          <div>
            <h3 class="font-bold text-slate-800 text-base">ลำดับขั้นตอนการอนุมัติ (${totalSteps} ขั้น)</h3>
            <p class="text-xs text-slate-500">${!isApproved && !isRejected ? `กำลังรอ: <strong class="text-blue-700">${waitingTeacher}</strong> (${stepPos.title}) • รอมาแล้ว <strong>${r.waitingMinutes || 0} นาที</strong>` : 'ผ่านการอนุมัติครบทุกขั้นตอนแล้ว'}</p>
          </div>
        </div>
        <button onclick="manualRefreshStatus()" title="อัปเดตสถานะทันที" class="px-3 py-1.5 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 flex items-center gap-1.5 text-xs font-bold transition shadow-xs active:scale-95 shrink-0">
          <i class="fa-solid fa-rotate btn-refresh-status-icon"></i> อัปเดตสด
        </button>
      </div>

      ${renderUnifiedStepper(r, false)}
    </div>

    <!-- 2. Card: รายละเอียดคำร้องขออนุญาตและไทม์ไลน์ประวัติอนุมัติ -->
    <div class="bg-white rounded-3xl p-5 shadow-sm border border-slate-200">
      <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-base">
            <i class="fa-solid fa-file-lines"></i>
          </div>
          <span class="font-bold text-slate-800 text-sm">รายละเอียดคำร้องขออนุญาต</span>
        </div>
        ${topBadge}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 text-xs sm:text-sm">
        <!-- Left Details -->
        <div class="sm:col-span-6 space-y-1.5 text-slate-600">
          <p><span class="text-slate-400">เลขที่คำร้อง:</span> <strong class="text-slate-800 font-mono">${r.requestNo}</strong></p>
          <p><span class="text-slate-400">ชื่อ-สกุล:</span> <strong class="text-slate-800">${r.studentName}</strong></p>
          <p><span class="text-slate-400">รหัสนักศึกษา:</span> ${formatStudentCode(r.studentCode)} (${r.classroomName || 'ปวช.3'})</p>
          <p><span class="text-slate-400">แผนกวิชา:</span> ${r.deptName || '-'}</p>
          <p><span class="text-slate-400">ประเภทลา:</span> <span class="text-blue-600 font-bold">${r.title || r.reason || 'ลากิจธุระจำเป็น'}</span></p>
          <p><span class="text-slate-400">เวลาออก:</span> ${r.leaveDate || '-'} (${r.departureTime || '-'} - ${r.expectedReturnTime || '-'} น.)</p>
          <p><span class="text-slate-400">คาบเรียนที่ตรง:</span> ${r.step1Skipped ? `<span class="text-slate-500 font-semibold">✕ ไม่มีคาบเรียน (${r.step1SkipReason || 'ไม่ต้องผ่านครูรายวิชา'})</span>` : `<strong class="text-sky-700">${r.subjectName || '-'} (${r.subjectTeacherName || '-'})</strong>`}</p>
          <p><span class="text-slate-400">ยานพาหนะ:</span> ${r.plateNo || '-'}</p>
        </div>
        <!-- Right Approval History Timeline -->
        <div class="sm:col-span-6">
          ${renderApprovalHistoryTimeline(r)}
        </div>
      </div>

      <!-- Action Button -->
      <div class="mt-4 pt-3 border-t border-slate-100 space-y-2">
        ${r.status === 'exited' ? `
          <div class="space-y-2">
            <button onclick="setViewMode('home'); setTimeout(() => { const el = document.getElementById('btn-student-return'); if (el) el.scrollIntoView({behavior: 'smooth'}); }, 200);" class="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold rounded-2xl shadow-md transition flex items-center justify-center gap-2 hover:scale-[1.01]">
              <i class="fa-solid fa-person-walking-arrow-loop-left text-base"></i> 📍 ฉันกลับถึงวิทยาลัยแล้ว (กดบันทึกกลับ)
            </button>
            <p class="text-[11px] text-center text-blue-600 font-medium">สแกนขาออกเรียบร้อยแล้ว ขาเข้าไม่ต้องสแกน QR ให้กดปุ่มนี้</p>
          </div>
        ` : (isApproved ? `
          <button onclick="setViewMode('qr')" class="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-2xl shadow-md transition flex items-center justify-center gap-2 hover:scale-[1.01]">
            <i class="fa-solid fa-qrcode text-base"></i> เปิดดู QR Pass สำหรับสแกนผ่านประตู (ขาออก)
          </button>
        ` : `
          <div class="w-full py-3 bg-slate-100 text-slate-600 font-medium rounded-2xl text-xs text-center flex items-center justify-center gap-2 border border-slate-200 px-3">
            <i class="fa-solid fa-clock text-blue-500"></i> รอการอนุมัติครบทุกขั้น (${step}/${totalSteps}: รอ ${waitingTeacher}) จึงจะสร้าง QR Pass ได้
          </div>
        `)}
        ${canDelete ? `
          <button onclick="deleteLeaveRequest(${r.id}, '${r.requestNo}')" class="w-full py-2.5 bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-600 border border-rose-200 rounded-2xl text-xs font-bold transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-trash-can"></i> ยกเลิก / ลบคำร้องนี้
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

// ฟังก์ชันลบ / ยกเลิกคำร้องขออนุญาต
async function deleteLeaveRequest(requestId, requestNo) {
  if (!requestId) return;
  const isConfirm = confirm(`คุณต้องการยกเลิกและลบคำร้อง ${requestNo || ''} ใช่หรือไม่?\nคำร้องจะถูกลบออกจากระบบทันที`);
  if (!isConfirm) return;

  try {
    const res = await fetch(`/api/requests/${requestId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    const result = await res.json();
    if (result.success) {
      alert(`ลบคำร้อง ${requestNo || ''} สำเร็จเรียบร้อย`);
      await fetchActiveRequest();
      setViewMode('home');
    } else {
      alert('เกิดข้อผิดพลาดในการลบคำร้อง: ' + (result.error || 'โปรดลองใหม่อีกครั้ง'));
    }
  } catch (err) {
    console.error('Delete request error:', err);
    alert('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อลบคำร้องได้');
  }
}

// ====================== 5. KIOSK SCANNER ======================
function initKioskScanner() {
  if (html5Scanner) return;

  try {
    html5Scanner = new Html5QrcodeScanner("kiosk-camera-view", {
      fps: 10,
      qrbox: { width: 180, height: 180 }
    });
    html5Scanner.render(onScanSuccess, () => {});
  } catch (err) {
    console.log('Camera init info:', err);
  }
}

async function onScanSuccess(decodedText) {
  await processScan(decodedText);
}

async function scanCurrentToken() {
  const input = document.getElementById('kiosk-token-input');
  const token = input ? input.value.trim() : currentToken;
  await processScan(token);
}

async function processScan(token, scanType = 'auto') {
  const resultEl = document.getElementById('kiosk-scan-result');
  if (resultEl) resultEl.classList.remove('hidden');

  try {
    const res = await fetch('/api/gate/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, scanType })
    });
    const data = await res.json();

    if (resultEl) {
      if (data.success) {
        resultEl.className = 'p-3.5 rounded-2xl text-xs bg-emerald-950/90 border border-emerald-500 text-emerald-200 block shadow-lg animate-pulse';
        resultEl.innerHTML = `
          <div class="flex items-start gap-2.5">
            <i class="fa-solid fa-circle-check text-emerald-400 text-2xl mt-0.5 shrink-0"></i>
            <div class="space-y-1">
              <strong class="text-white text-sm block leading-snug">${data.message}</strong>
              <p class="text-[11px] text-emerald-300 font-medium">${data.student.name} (${data.student.code})</p>
              ${data.notice ? `<p class="text-[10px] text-amber-300 bg-amber-950/50 p-1.5 rounded-lg border border-amber-500/40">${data.notice}</p>` : ''}
            </div>
          </div>
        `;
      } else {
        resultEl.className = 'p-3.5 rounded-2xl text-xs bg-rose-950/90 border border-rose-500 text-rose-200 block shadow-lg';
        resultEl.innerHTML = `
          <div class="flex items-start gap-2.5">
            <i class="fa-solid fa-triangle-exclamation text-rose-400 text-2xl mt-0.5 shrink-0"></i>
            <div class="space-y-1">
              <strong class="text-white text-sm block leading-snug">ไม่อนุญาตผ่าน</strong>
              <p class="text-[11px] text-rose-300 leading-relaxed">${data.reason}</p>
            </div>
          </div>
        `;
      }
    }
  } catch (err) {
    if (resultEl) {
      resultEl.className = 'p-3 rounded-xl text-xs bg-rose-950 text-white block';
      resultEl.innerText = 'เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว';
    }
  }
}

// ====================== 6. HARDWARE SIMULATOR POLLING ======================
async function pollSimulator() {
  try {
    const res = await fetch('/api/gate/status');
    const data = await res.json();
    const sim = data.simulator;

    // อัปเดตสถานะ "ไม้กั้น ออนไลน์/ออฟไลน์" ในการ์ดประกาศ
    const allGateDots = document.querySelectorAll('#header-gate-dot');
    const allGateTexts = document.querySelectorAll('#header-gate-text');
    const allGateBadges = document.querySelectorAll('#header-gate-badge');

    if (data.gate) {
      if (data.gate.online) {
        allGateDots.forEach(dot => {
          dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_#10b981]';
        });
        allGateTexts.forEach(txt => {
          txt.innerText = 'ไม้กั้นออนไลน์';
          txt.className = 'text-emerald-700 text-[10px] sm:text-[11px] font-bold';
        });
        allGateBadges.forEach(b => {
          b.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-300 text-xs font-semibold shadow-2xs';
          b.title = `เชื่อมต่อผ่าน: ${data.gate.connectionType || 'MQTT/Serial'}`;
        });
      } else {
        allGateDots.forEach(dot => {
          dot.className = 'w-2 h-2 rounded-full bg-rose-500';
        });
        allGateTexts.forEach(txt => {
          txt.innerText = 'ไม้กั้นออฟไลน์';
          txt.className = 'text-rose-700 text-[10px] sm:text-[11px] font-bold';
        });
        allGateBadges.forEach(b => {
          b.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-50 border border-rose-200 text-xs font-semibold shadow-2xs';
          b.title = 'ยังไม่พบสัญญาณ Heartbeat จากบอร์ด ESP32';
        });
      }
    }

    const oledStatus = document.getElementById('sim-oled-status');
    const oledSubtext = document.getElementById('sim-oled-subtext');
    const relayIcon = document.getElementById('sim-relay-icon');
    const relayText = document.getElementById('sim-relay-text');
    const ledGreen = document.getElementById('sim-led-green');
    const ledRed = document.getElementById('sim-led-red');
    const ledText = document.getElementById('sim-led-text');

    if (sim.door === 'OPEN') {
      oledStatus.innerText = '>> OPEN <<';
      oledStatus.className = 'text-xl font-bold tracking-wider text-emerald-300 animate-pulse';
      oledSubtext.innerText = sim.studentName ? `PASS: ${sim.studentName}` : 'DOOR OPEN (5s)';

      relayIcon.className = 'w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center mx-auto my-1 shadow-[0_0_10px_#10b981]';
      relayIcon.innerHTML = '<i class="fa-solid fa-lock-open text-sm"></i>';
      relayText.innerText = 'ปลดล็อก (OPEN)';
      relayText.className = 'text-xs font-bold text-emerald-400';

      ledGreen.className = 'w-3.5 h-3.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981] border border-emerald-300';
      ledRed.className = 'w-3.5 h-3.5 rounded-full bg-rose-950 border border-rose-900';
      ledText.innerText = 'ไฟเขียวติด (ผ่าน)';
      ledText.className = 'text-xs font-bold text-emerald-400';
    } else {
      oledStatus.innerText = '== CLOSED ==';
      oledStatus.className = 'text-xl font-bold tracking-wider text-white';
      oledSubtext.innerText = 'Ready to scan QR';

      relayIcon.className = 'w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center mx-auto my-1';
      relayIcon.innerHTML = '<i class="fa-solid fa-lock text-sm"></i>';
      relayText.innerText = 'ล็อกอยู่';
      relayText.className = 'text-xs font-bold text-slate-400';

      ledGreen.className = 'w-3.5 h-3.5 rounded-full bg-emerald-950 border border-emerald-900';
      ledRed.className = 'w-3.5 h-3.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e] border border-rose-400';
      ledText.innerText = 'ไฟแดงติด';
      ledText.className = 'text-xs font-bold text-rose-400';
    }
  } catch (err) {}
}

async function triggerGateOpen(seconds = 5) {
  try {
    const res = await fetch('/api/gate/manual-open', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ duration: seconds, reason: 'MANUAL_BUTTON' })
    });
    const result = await res.json();
    if (!result.success) {
      alert('ไม่สามารถเปิดประตูได้: ' + (result.message || 'ไม่มีสิทธิ์'));
    }
  } catch (err) {
    alert(err.message);
  }
}

// ====================== PHONE CAMERA SCANNER ======================
let phoneQrScanner = null;

function openPhoneScanner() {
  const modal = document.getElementById('phone-camera-modal');
  if (modal) modal.classList.remove('hidden');

  const statusEl = document.getElementById('phone-scan-status');
  if (statusEl) {
    statusEl.classList.remove('hidden');
    statusEl.innerText = 'กำลังเปิดกล้อง...';
  }

  setTimeout(() => {
    try {
      if (phoneQrScanner) {
        phoneQrScanner.clear();
      }
      phoneQrScanner = new Html5Qrcode("phone-camera-reader");
      const config = { fps: 15, qrbox: { width: 220, height: 220 } };

      phoneQrScanner.start(
        { facingMode: "environment" },
        config,
        async (decodedText) => {
          if (statusEl) statusEl.innerText = '✅ สแกนสำเร็จ! กำลังตรวจสอบ...';
          await onPhoneScanSuccess(decodedText);
        },
        () => {}
      ).then(() => {
        if (statusEl) statusEl.innerText = '📷 นำกล้องส่องไปที่หน้าจอ OLED 0.96" ที่บอร์ด';
      }).catch(err => {
        console.warn('Environment camera failed, trying default camera:', err);
        phoneQrScanner.start(
          { facingMode: "user" },
          config,
          async (decodedText) => {
            if (statusEl) statusEl.innerText = '✅ สแกนสำเร็จ! กำลังตรวจสอบ...';
            await onPhoneScanSuccess(decodedText);
          },
          () => {}
        ).catch(e => {
          if (statusEl) statusEl.innerText = '❌ ไม่สามารถเปิดกล้องได้: ' + e;
        });
      });
    } catch (e) {
      if (statusEl) statusEl.innerText = '❌ เกิดข้อผิดพลาด: ' + e.message;
    }
  }, 200);
}

function closePhoneScanner() {
  const modal = document.getElementById('phone-camera-modal');
  if (modal) modal.classList.add('hidden');
  if (phoneQrScanner) {
    try {
      phoneQrScanner.stop().then(() => {
        phoneQrScanner.clear();
        phoneQrScanner = null;
      }).catch(() => {
        phoneQrScanner = null;
      });
    } catch (e) {
      phoneQrScanner = null;
    }
  }
}

async function onPhoneScanSuccess(decodedText) {
  closePhoneScanner();
  let token = decodedText.trim();
  // ถ้า QR เป็น URL เช่น http://.../?token=OP-1234 หรือ PIN:OP-1234
  if (token.includes('token=')) {
    token = token.split('token=')[1].split('&')[0];
  } else if (token.includes('PIN:')) {
    token = token.split('PIN:')[1].trim();
  } else if (token.includes('#')) {
    token = token.split('#')[1].trim();
  }

  // เรียกฟังก์ชันตรวจสอบและสั่งเปิดประตู
  await processScan(token);
  alert('🎉 สแกน QR Code สำเร็จ!\nระบบได้ส่งคำสั่งเปิดประตูตู้ IoT แล้ว (ไม้กั้นเปิด)');
}

// ====================== 7. ANALYTICS & STATS DASHBOARD (Chart.js & Export) ======================
let dailyExitsChart = null;
let reasonsChart = null;
let departmentsChart = null;

async function loadAndRenderStatsDashboard() {
  const user = getCurrentUser();
  if (user && user.role === 'student') {
    setViewMode('home');
    return;
  }
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (!data.success) return;

    // 1. Update KPI Counters
    const kpiTotal = document.getElementById('stats-kpi-total');
    const kpiApproved = document.getElementById('stats-kpi-approved');
    const kpiExited = document.getElementById('stats-kpi-exited');
    const kpiRejected = document.getElementById('stats-kpi-rejected');

    if (kpiTotal) kpiTotal.innerText = data.summary.total || 0;
    if (kpiApproved) kpiApproved.innerText = data.summary.approved || 0;
    if (kpiExited) kpiExited.innerText = data.summary.currentlyExited || 0;
    if (kpiRejected) kpiRejected.innerText = data.summary.rejected || 0;

    // Apply Sarabun font to all Chart.js instances
    if (typeof Chart !== 'undefined' && Chart.defaults && Chart.defaults.font) {
      Chart.defaults.font.family = "'TH Sarabun New', 'TH Sarabun PSK', 'Sarabun', sans-serif";
    }

    // 2. Render Chart 1: Daily Exits (Bar Chart)
    renderDailyExitsChart(data.daily);

    // 3. Render Chart 2: Reasons Breakdown (Doughnut Chart)
    renderReasonsChart(data.reasons);

    // 4. Render Chart 3: Departments Ranking (Horizontal Bar Chart)
    renderDepartmentsChart(data.departments);
  } catch (err) {
    console.warn('Failed to load stats dashboard:', err);
  }
}

function renderDailyExitsChart(dailyData) {
  const canvas = document.getElementById('chart-daily-exits');
  if (!canvas || typeof Chart === 'undefined') return;

  if (dailyExitsChart) {
    dailyExitsChart.destroy();
    dailyExitsChart = null;
  }

  const labels = Object.keys(dailyData || {}).slice(-7);
  const values = labels.map(l => dailyData[l] || 0);

  const finalLabels = labels.length ? labels : ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์'];
  const finalValues = values.length ? values : [3, 5, 4, 8, 12];

  dailyExitsChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: finalLabels,
      datasets: [{
        label: 'จำนวนคนขอออก (คน)',
        data: finalValues,
        backgroundColor: '#3b82f6',
        borderRadius: 8,
        barThickness: 24
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 }
        }
      }
    }
  });
}

function renderReasonsChart(reasonsData) {
  const canvas = document.getElementById('chart-reasons');
  if (!canvas || typeof Chart === 'undefined') return;

  if (reasonsChart) {
    reasonsChart.destroy();
    reasonsChart = null;
  }

  const labels = Object.keys(reasonsData || {});
  const values = labels.map(l => reasonsData[l] || 0);

  const finalLabels = labels.length ? labels : ['พบแพทย์ / ป่วย', 'ธุระครอบครัว', 'ติดต่อราชการ', 'อื่นๆ'];
  const finalValues = values.length ? values : [45, 30, 15, 10];

  reasonsChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: finalLabels,
      datasets: [{
        data: finalValues,
        backgroundColor: [
          '#1e3a8a', // Blue 900
          '#1d4ed8', // Blue 700
          '#2563eb', // Blue 600
          '#3b82f6', // Blue 500
          '#60a5fa', // Blue 400
          '#93c5fd'  // Blue 300
        ],
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 12, font: { size: 12, family: "'TH Sarabun New', 'TH Sarabun PSK', 'Sarabun', sans-serif" } }
        }
      },
      cutout: '65%'
    }
  });
}

function renderDepartmentsChart(deptsData) {
  const canvas = document.getElementById('chart-departments');
  if (!canvas || typeof Chart === 'undefined') return;

  if (departmentsChart) {
    departmentsChart.destroy();
    departmentsChart = null;
  }

  const labels = Object.keys(deptsData || {});
  const values = labels.map(l => deptsData[l] || 0);

  const finalLabels = labels.length ? labels : [
    'แผนกวิชาช่างยนต์',
    'แผนกวิชาช่างไฟฟ้า',
    'แผนกวิชาการบัญชี',
    'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
    'แผนกวิชาช่างกลโรงงาน'
  ];
  const finalValues = values.length ? values : [12, 10, 6, 4, 3];

  departmentsChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: finalLabels,
      datasets: [{
        label: 'จำนวนคำขอ (ใบ)',
        data: finalValues,
        backgroundColor: '#2563eb',
        borderRadius: 8,
        barThickness: 18
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 }
        }
      }
    }
  });
}

async function exportRequestsToExcel() {
  try {
    const res = await fetch('/api/requests');
    const data = await res.json();
    const requests = data.requests || [];

    if (!requests.length) {
      alert('ยังไม่มีข้อมูลคำร้องสำหรับส่งออก');
      return;
    }

    // CSV Header ภาษาไทย
    const headers = [
      'เลขที่คำขอ',
      'รหัสนักศึกษา',
      'ชื่อ-นามสกุล',
      'แผนกวิชา',
      'ระดับชั้น',
      'วันที่ขอออก',
      'เวลาออก',
      'เวลากลับ',
      'รายวิชาที่ตรงคาบ',
      'ครูรายวิชา',
      'ทะเบียนรถ',
      'เหตุผลที่ขอออก',
      'สถานะคำร้อง'
    ];

    const statusMap = {
      'pending_advisor': 'รอครูที่ปรึกษา (ขั้น 1/4)',
      'pending_dept_head': 'รอหัวหน้าแผนกวิชา (ขั้น 2/4)',
      'pending_discipline': 'รอฝ่ายปกครอง/หลักสูตร (ขั้น 3/4)',
      'pending_deputy': 'รอรองผู้อำนวยการ (ขั้น 4/4)',
      'pending_deputy_director': 'รอรองผู้อำนวยการ (ขั้น 4/4)',
      'pending_subject_teacher': 'รอครูรายวิชา (ระบบเดิม)',
      'approved': 'อนุมัติแล้ว (ได้รับ QR Pass)',
      'exited': 'สแกนออกแล้ว',
      'returned': 'กลับเข้าแล้ว',
      'rejected': 'ไม่อนุมัติ',
      'expired': 'หมดอายุอัตโนมัติ'
    };

    const rows = requests.map(r => [
      `"${r.requestNo || ''}"`,
      `"\t${r.studentCode || ''}"`, // \t ป้องกัน Excel แสดงเป็นเลขยกกำลัง
      `"${r.studentName || ''}"`,
      `"${r.deptName || ''}"`,
      `"${r.classroomName || ''}"`,
      `"${r.leaveDate || ''}"`,
      `"${r.departureTime || ''}"`,
      `"${r.expectedReturnTime || ''}"`,
      `"${r.step1Skipped ? 'ไม่มีคาบเรียน (' + (r.step1SkipReason || '') + ')' : (r.subjectName || '-')}"`,
      `"${r.step1Skipped ? 'ข้ามขั้นครูรายวิชา' : (r.subjectTeacherName || '-')}"`,
      `"${r.plateNo || '-'}"`,
      `"${(r.reason || r.title || '').replace(/"/g, '""')}"`,
      `"${statusMap[r.status] || r.status}"`
    ]);

    // ใส่ UTF-8 BOM (\uFEFF) เพื่อให้ Microsoft Excel เปิดภาษาไทยได้คมชัด 100% ไม่เป็นภาษาต่างดาว
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().split('T')[0];
    link.setAttribute('href', url);
    link.setAttribute('download', `OnePass_Leave_Report_${today}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    alert('ส่งออกไฟล์ล้มเหลว: ' + err.message);
  }
}


// ============================================================================
// ADMIN PANEL CONTROLLER (ระบบจัดการผู้ใช้, แผนกวิชา, ตารางสอน/สอนแทน, และตั้งเวลาสถานศึกษา)
// ============================================================================
let adminUsersCache = [];
let currentAdminTab = 'users';

let gateStatusPollInterval = null;

function switchAdminTab(tabName) {
  currentAdminTab = tabName;
  const tabs = ['users', 'depts', 'timetables', 'settings', 'import_students', 'devices', 'gate_status'];
  tabs.forEach(t => {
    const btn = document.getElementById(`admin-tab-btn-${t}`);
    const panel = document.getElementById(`admin-panel-${t}`);
    if (btn) {
      const chevron = btn.querySelector('.fa-chevron-right');
      if (t === tabName) {
        btn.className = 'w-full px-3.5 py-2.5 rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-bold shadow-md shadow-cyan-950/40 transition flex items-center justify-between gap-2.5 text-left group';
        if (chevron) {
          chevron.className = 'fa-solid fa-chevron-right text-[10px] opacity-90 hidden lg:inline';
        }
      } else {
        btn.className = 'w-full px-3.5 py-2.5 rounded-2xl text-slate-400 hover:text-white hover:bg-slate-800/60 font-medium transition flex items-center justify-between gap-2.5 text-left group';
        if (chevron) {
          chevron.className = 'fa-solid fa-chevron-right text-[10px] opacity-0 group-hover:opacity-70 hidden lg:inline';
        }
      }
    }
    if (panel) {
      if (t === tabName) panel.classList.remove('hidden');
      else panel.classList.add('hidden');
    }
  });

  if (gateStatusPollInterval) {
    clearInterval(gateStatusPollInterval);
    gateStatusPollInterval = null;
  }

  if (tabName === 'users') loadAdminUsers();
  else if (tabName === 'depts') loadAdminDepartments();
  else if (tabName === 'timetables') loadAdminTimetables();
  else if (tabName === 'import_students') fetchAdminImportLogs();
  else if (tabName === 'settings') loadAdminSettings();
  else if (tabName === 'devices') fetchPendingDeviceRequests();
  else if (tabName === 'gate_status') {
    fetchGateDeviceStatus();
    gateStatusPollInterval = setInterval(fetchGateDeviceStatus, 3000);
  }
}

async function fetchGateDeviceStatus() {
  const box = document.getElementById('gate-status-list');
  if (!box) return;
  try {
    const res = await fetch('/api/device/status', {
      headers: { 'Authorization': 'Bearer ' + getAuthToken() }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'โหลดสถานะไม่สำเร็จ');

    const items = [
      {
        label: 'บอร์ด ESP32 (ออนไลน์)',
        icon: 'fa-microchip',
        ok: data.board_online,
        detail: data.board_online ? ('อัปเดตล่าสุด: ' + new Date(data.last_update).toLocaleTimeString('th-TH')) : 'ไม่มีรายงานเข้ามาเกิน 15 วินาที'
      },
      {
        label: 'WiFi',
        icon: 'fa-wifi',
        ok: data.board_online && data.wifi,
        detail: (data.board_online && data.wifi) ? ('IP: ' + data.wifi_ip) : 'ไม่พบสัญญาณ'
      },
      {
        label: 'เซนเซอร์ Ultrasonic',
        icon: 'fa-ruler',
        ok: data.board_online && data.ultrasonic,
        detail: (data.board_online && data.ultrasonic) ? ('ระยะ ~' + data.ultrasonic_distance + ' ซม.') : 'ไม่มีสัญญาณตอบกลับ'
      },
      {
        label: 'ปุ่มฉุกเฉิน',
        icon: 'fa-circle-dot',
        ok: data.board_online,
        detail: !data.board_online ? '-' : (data.button_pressed ? 'กำลังกดอยู่' : 'ว่าง (ปกติ)')
      },
      {
        label: 'สัญญาณไฟเขียว',
        icon: 'fa-circle',
        ok: data.board_online,
        detail: data.board_online ? 'สั่งงานทุกรอบ (ดูด้วยตา)' : '-'
      },
      {
        label: 'สัญญาณไฟเหลือง',
        icon: 'fa-circle',
        ok: data.board_online,
        detail: data.board_online ? 'สั่งงานทุกรอบ (ดูด้วยตา)' : '-'
      },
      {
        label: 'สัญญาณไฟแดง',
        icon: 'fa-circle',
        ok: data.board_online,
        detail: data.board_online ? 'สั่งงานทุกรอบ (ดูด้วยตา)' : '-'
      },
      {
        label: 'ไม้กั้น (Servo)',
        icon: 'fa-road-barrier',
        ok: data.board_online,
        detail: data.board_online ? 'สั่งงานทุกรอบ (ดูด้วยตาว่าขยับจริง)' : '-'
      },
      {
        label: 'โมดูลสแกน QR',
        icon: 'fa-qrcode',
        ok: data.board_online && data.qr_connected,
        detail: !data.board_online ? '-' : (data.qr_connected ? 'เคยรับข้อมูลจากโมดูลแล้ว' : 'ยังไม่เคยมีข้อมูลเข้ามา ลองสแกนทดสอบ')
      },
      {
        label: 'ลำโพง',
        icon: 'fa-volume-high',
        ok: data.board_online,
        detail: data.board_online ? 'ส่งเสียงทดสอบทุกรอบ (ฟังด้วยหู)' : '-'
      }
    ];

    box.innerHTML = items.map(it => `
      <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-3.5 py-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <i class="fa-solid ${it.icon} text-blue-600 text-sm shrink-0"></i>
          <div class="min-w-0">
            <div class="text-xs font-bold text-slate-800 truncate">${it.label}</div>
            <div class="text-[11px] text-slate-500 truncate">${it.detail}</div>
          </div>
        </div>
        <span class="px-2.5 py-1 rounded-full text-[11px] font-bold text-white shrink-0 ${it.ok ? 'bg-emerald-500' : 'bg-rose-500'}">
          ${it.ok ? 'เชื่อมต่อสำเร็จ' : 'ไม่ได้เชื่อมต่อ'}
        </span>
      </div>
    `).join('');
  } catch (err) {
    box.innerHTML = `<p class="text-rose-500 text-xs">โหลดสถานะไม่สำเร็จ: ${err.message}</p>`;
  }
}

async function handleGateTestOpen() {
  const btn = document.getElementById('btn-gate-test-open');
  if (!btn) return;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่งคำสั่ง...';

  try {
    const res = await fetch('/api/device/test-open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken()
      }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'ส่งคำสั่งไม่สำเร็จ');
    alert('✅ ' + (data.message || 'ส่งคำสั่งทดสอบเปิดไม้กั้นแล้ว'));
  } catch (err) {
    alert('❌ ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

async function handleGateTestComponent(component, btnEl) {
  if (!btnEl) return;
  const originalHtml = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  try {
    const res = await fetch('/api/device/test-component', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAuthToken()
      },
      body: JSON.stringify({ component })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'ส่งคำสั่งไม่สำเร็จ');
    alert('✅ ' + (data.message || 'ส่งคำสั่งทดสอบแล้ว'));
  } catch (err) {
    alert('❌ ' + err.message);
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML = originalHtml;
  }
}

async function initAdminPanel() {
  const user = getCurrentUser();
  if (!user || user.role !== 'admin') {
    alert('คุณไม่มีสิทธิ์เข้าถึงหน้านี้ (เฉพาะบัญชี admin)');
    setViewMode('home');
    return;
  }
  switchAdminTab(currentAdminTab || 'users');
}

// ---------------- 1. จัดการผู้ใช้ (User Management) ----------------
let currentAdminRoleFilter = 'all';

function setAdminRoleFilter(roleGroup) {
  currentAdminRoleFilter = roleGroup;
  const groups = ['all', 'student', 'subject_teacher', 'advisor', 'dept_head', 'discipline_head', 'deputy_director', 'admin'];
  groups.forEach(g => {
    const btn = document.getElementById(`admin-rf-${g}`);
    const countSpan = document.getElementById(`admin-count-${g}`);
    if (btn) {
      if (g === roleGroup) {
        btn.className = 'px-3 py-1.5 rounded-xl bg-cyan-600 text-white shadow-xs transition shrink-0 flex items-center gap-1.5';
        if (countSpan) countSpan.className = 'text-[10px] px-1.5 py-0.2 rounded-full bg-white/20 font-mono';
      } else {
        btn.className = 'px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition shrink-0 flex items-center gap-1.5';
        if (countSpan) countSpan.className = 'text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200 text-slate-700 font-mono';
      }
    }
  });

  // ซิงค์ค่าไปยัง Role Dropdown Selector (สะดวกสำหรับจอโทรศัพท์มือถือ)
  const roleDropdown = document.getElementById('admin-filter-role');
  if (roleDropdown && roleDropdown.value !== roleGroup) {
    roleDropdown.value = roleGroup;
  }

  // ตัวกรองระดับชั้น (เปิดให้เลือกได้ตลอดเวลา เพื่อกรองตามระดับชั้น ปวช.1 - ปวส.2 ได้อย่างยืดหยุ่น)
  const levelSelect = document.getElementById('admin-filter-level');
  if (levelSelect) {
    levelSelect.disabled = false;
    levelSelect.classList.remove('opacity-50', 'cursor-not-allowed');
  }

  filterAdminUsers();
}

function handleAdminRoleSelectChange(role) {
  setAdminRoleFilter(role || 'all');
}

function updateAdminCategoryCounts(users) {
  const allCount = users.length;
  const studentCount = users.filter(u => u.role === 'student').length;
  const subjectCount = users.filter(u => u.role === 'subject_teacher').length;
  const advisorCount = users.filter(u => u.role === 'advisor').length;
  const deptHeadCount = users.filter(u => u.role === 'dept_head').length;
  const disciplineCount = users.filter(u => u.role === 'discipline_head').length;
  const deputyCount = users.filter(u => u.role === 'deputy_director').length;
  const adminCount = users.filter(u => u.role === 'admin').length;

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl('admin-count-all', allCount);
  setEl('admin-count-student', studentCount);
  setEl('admin-count-subject_teacher', subjectCount);
  setEl('admin-count-advisor', advisorCount);
  setEl('admin-count-dept_head', deptHeadCount);
  setEl('admin-count-discipline_head', disciplineCount);
  setEl('admin-count-deputy_director', deputyCount);
  setEl('admin-count-admin', adminCount);

  // Backward-compatible for legacy elements if present
  setEl('admin-count-teacher', subjectCount + advisorCount + deptHeadCount);
  setEl('admin-count-executive', disciplineCount + deputyCount + adminCount);
}

async function loadAdminUsers() {
  const container = document.getElementById('admin-users-list');
  if (!container) return;
  container.innerHTML = `
    <div class="text-center py-8 text-slate-400 text-xs">
      <i class="fa-solid fa-spinner fa-spin text-lg mb-2 block"></i> กำลังโหลดรายชื่อผู้ใช้...
    </div>
  `;

  try {
    let token = await ensureAuthToken();
    let res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 401) {
      token = await ensureAuthToken(true);
      res = await fetch('/api/admin/users', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }
    const data = await res.json();
    if (data.success && Array.isArray(data.users)) {
      adminUsersCache = data.users;
      updateAdminCategoryCounts(adminUsersCache);
      filterAdminUsers();
    } else {
      container.innerHTML = `<div class="p-4 text-center text-xs text-rose-500 font-bold">${data.message || 'โหลดข้อมูลไม่สำเร็จ'}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="p-4 text-center text-xs text-rose-500 font-bold">เกิดข้อผิดพลาด: ${err.message}</div>`;
  }
}

function filterAdminUsers() {
  const query = (document.getElementById('admin-user-search')?.value || '').trim().toLowerCase();
  const deptFilter = document.getElementById('admin-filter-dept')?.value || 'all';
  const levelFilter = document.getElementById('admin-filter-level')?.value || 'all';
  const statusFilter = document.getElementById('admin-filter-status')?.value || 'all';

  const filtered = adminUsersCache.filter(u => {
    // 1. กรองตามบทบาท (Role)
    if (currentAdminRoleFilter !== 'all') {
      if (currentAdminRoleFilter === 'teacher') {
        if (!['subject_teacher', 'advisor', 'dept_head'].includes(u.role)) return false;
      } else if (currentAdminRoleFilter === 'executive') {
        if (!['discipline_head', 'deputy_director', 'admin'].includes(u.role)) return false;
      } else {
        if (u.role !== currentAdminRoleFilter) return false;
      }
    }

    // 2. กรองตามแผนกวิชา (Department)
    if (deptFilter !== 'all') {
      const uDept = (u.dept || u.departments?.name || '').toLowerCase();
      if (!uDept.includes(deptFilter.toLowerCase())) return false;
    }

    // 3. กรองตามระดับชั้น (Level/Classroom)
    if (levelFilter !== 'all') {
      if (u.role === 'student' || u.role === 'advisor') {
        const uClass = (u.classroom || u.classrooms?.name || '').toLowerCase();
        if (!uClass.includes(levelFilter.toLowerCase())) return false;
      }
    }

    // 4. กรองตามสถานะการเปิดใช้งาน (Status)
    if (statusFilter !== 'all') {
      const uStatus = u.status || 'active';
      if (statusFilter === 'pending_activation') {
        if (uStatus !== 'pending_activation') return false;
      } else if (statusFilter === 'active') {
        if (uStatus === 'pending_activation') return false;
      }
    }

    // 5. ค้นหาข้อความ (Search Query)
    if (query) {
      const match = (u.username && u.username.toLowerCase().includes(query)) ||
                    (u.full_name && u.full_name.toLowerCase().includes(query)) ||
                    (u.student_code && u.student_code.toLowerCase().includes(query)) ||
                    (u.role && u.role.toLowerCase().includes(query)) ||
                    (u.dept && u.dept.toLowerCase().includes(query)) ||
                    (u.classroom && u.classroom.toLowerCase().includes(query));
      if (!match) return false;
    }

    return true;
  });

  // อัปเดตตัวนับจำนวนที่กำลังแสดง
  const showingCount = document.getElementById('admin-users-showing-count');
  if (showingCount) showingCount.textContent = filtered.length;

  const summaryTag = document.getElementById('admin-filter-summary-tag');
  if (summaryTag) {
    const roleLabels = {
      all: 'ทั้งหมด',
      student: 'นักเรียน',
      subject_teacher: 'ครูรายวิชา (ขั้น 1)',
      advisor: 'ครูที่ปรึกษา (ขั้น 2)',
      dept_head: 'หัวหน้าแผนก (ขั้น 3)',
      discipline_head: 'ฝ่ายปกครอง (ขั้น 4)',
      deputy_director: 'รองผู้อำนวยการ (ขั้น 5)',
      admin: 'ผู้ดูแลระบบ (Admin)',
      teacher: 'ครู/อาจารย์',
      executive: 'ผู้บริหาร & ฝ่ายปกครอง'
    };
    const parts = [roleLabels[currentAdminRoleFilter] || ''];
    if (deptFilter !== 'all') parts.push(deptFilter);
    if (levelFilter !== 'all') parts.push(levelFilter);
    if (statusFilter === 'active') parts.push('ใช้งานแล้ว');
    else if (statusFilter === 'pending_activation') parts.push('รอยืนยัน');
    summaryTag.textContent = parts.filter(Boolean).join(' • ');
  }

  renderAdminUsers(filtered);
}

function renderAdminUsers(users) {
  const container = document.getElementById('admin-users-list');
  if (!container) return;

  if (!users || users.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center text-slate-400 text-xs bg-slate-50 rounded-2xl border border-slate-100">
        <i class="fa-solid fa-user-slash text-2xl mb-1 text-slate-300 block"></i>
        ไม่พบรายชื่อผู้ใช้ที่ตรงกับเงื่อนไขการค้นหา
      </div>
    `;
    return;
  }

  const roleMeta = {
    'student': { label: 'นักเรียน', bg: 'bg-blue-50 text-blue-700 border-blue-200', icon: 'fa-user-graduate', iconBg: 'bg-blue-100 text-blue-600' },
    'subject_teacher': { label: 'ครูรายวิชา (ขั้น 1)', bg: 'bg-sky-50 text-sky-700 border-sky-200', icon: 'fa-book-open-reader', iconBg: 'bg-sky-100 text-sky-600' },
    'advisor': { label: 'ครูที่ปรึกษา (ขั้น 2)', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'fa-chalkboard-user', iconBg: 'bg-emerald-100 text-emerald-600' },
    'dept_head': { label: 'หัวหน้าแผนก (ขั้น 3)', bg: 'bg-amber-50 text-amber-700 border-amber-200', icon: 'fa-building-columns', iconBg: 'bg-amber-100 text-amber-600' },
    'discipline_head': { label: 'ฝ่ายปกครอง (ขั้น 4)', bg: 'bg-purple-50 text-purple-700 border-purple-200', icon: 'fa-shield-halved', iconBg: 'bg-purple-100 text-purple-600' },
    'deputy_director': { label: 'รองผู้อำนวยการ (ขั้น 5)', bg: 'bg-rose-50 text-rose-700 border-rose-200', icon: 'fa-user-tie', iconBg: 'bg-rose-100 text-rose-600' },
    'admin': { label: 'ผู้ดูแลระบบ', bg: 'bg-slate-900 text-cyan-300 border-cyan-500/40', icon: 'fa-gears', iconBg: 'bg-slate-900 text-cyan-400' }
  };

  container.innerHTML = users.map(u => {
    const meta = roleMeta[u.role] || { label: u.role || 'ผู้ใช้', bg: 'bg-slate-100 text-slate-700 border-slate-200', icon: 'fa-user', iconBg: 'bg-slate-100 text-slate-600' };
    const isSpecialAdmin = u.username === 'admin';

    // Status Badge แสดงตามการผูกอุปกรณ์
    let statusBadge = '';
    if (u.role === 'student') {
      if (u.bound_device_id) {
        statusBadge = `<span class="px-2 py-0.5 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700 text-[10px] font-bold inline-flex items-center gap-1" title="ผูกกับ: ${u.bound_device_name || 'อุปกรณ์ประจำตัว'}"><i class="fa-solid fa-mobile-screen-button text-[9px] text-emerald-600"></i> ผูกเครื่องแล้ว</span>`;
      } else if (u.pending_device_id) {
        statusBadge = `<span class="px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-700 text-[10px] font-bold inline-flex items-center gap-1" title="ขอเข้าจาก: ${u.pending_device_name || 'เครื่องใหม่'}"><i class="fa-solid fa-hourglass-half text-[9px]"></i> รออนุมัติเครื่องใหม่</span>`;
      } else {
        statusBadge = `<span class="px-2 py-0.5 rounded-full border border-blue-300 bg-blue-50 text-blue-700 text-[10px] font-bold inline-flex items-center gap-1"><i class="fa-solid fa-circle-check text-[9px]"></i> พร้อมใช้งาน</span>`;
      }
    }

    const deptName = u.dept || (u.departments ? u.departments.name : '');
    const className = u.classroom || (u.classrooms ? u.classrooms.name : '');
    let academicInfo = deptName;
    if (u.role === 'advisor') {
      const classLabel = className ? `ครูที่ปรึกษา ${className}` : 'ครูที่ปรึกษา (ดูแล ปวช.1 - ปวส.2)';
      academicInfo = deptName ? `${deptName} • ${classLabel}` : classLabel;
    } else if (u.role === 'subject_teacher') {
      const classLabel = className ? `ผู้สอน ${className}` : 'ครูผู้สอน (ปวช.1 - ปวส.2)';
      academicInfo = deptName ? `${deptName} • ${classLabel}` : classLabel;
    } else if (className) {
      academicInfo = deptName ? `${deptName} • ${className}` : className;
    }
    if (!academicInfo) academicInfo = '-';

    const codeText = u.student_code ? `<span class="font-mono text-slate-600 font-bold mr-1.5">#${u.student_code}</span>` : '';

    const actionBtn = (u.role === 'student')
      ? `<button type="button" onclick="adminResetPassword('${u.id}', '${u.student_code || u.username}')" class="px-2.5 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" title="รีเซ็ตรหัสผ่านเป็น 1234">
          <i class="fa-solid fa-key"></i> รีเซ็ตรหัส (1234)
        </button>
        <button type="button" onclick="handleAdminResetDeviceFromCard('${u.student_code || u.username}')" class="px-2.5 py-1.5 rounded-xl bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" title="ปลดล็อก/รีเซ็ตอุปกรณ์ที่ผูกไว้ (ให้นักเรียนเข้าเครื่องใหม่ได้)">
          <i class="fa-solid fa-mobile-screen-button"></i> รีเซ็ตเครื่อง
        </button>`
      : `<button type="button" onclick="adminResetPassword('${u.id}', '${u.username}')" class="px-2.5 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" title="รีเซ็ตรหัสผ่านเป็น 1234">
          <i class="fa-solid fa-key"></i> รีเซ็ตรหัส (1234)
        </button>`;

    return `
      <div class="p-3 bg-white hover:bg-slate-50/80 rounded-2xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-xl ${meta.iconBg} border border-slate-200 flex items-center justify-center shrink-0 text-sm shadow-2xs">
            <i class="fa-solid ${meta.icon}"></i>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              <span class="font-bold text-slate-800 text-xs sm:text-sm truncate">${u.full_name || u.username}</span>
              <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold ${meta.bg}">${meta.label}</span>
              ${u.role === 'student' ? statusBadge : ''}
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">
              ${codeText}
              <span class="font-mono font-semibold text-slate-700">@${u.username}</span>
              <span class="text-slate-300 mx-1">•</span>
              <span class="text-slate-600 font-medium">${academicInfo}</span>
            </p>
          </div>
        </div>

        <div class="flex items-center gap-1.5 self-end sm:self-auto shrink-0 flex-wrap">
          ${actionBtn}
          ${!isSpecialAdmin ? `
            <button type="button" onclick="adminDeleteUser('${u.id}', '${u.username || u.student_code}')" class="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" title="ลบผู้ใช้นี้">
              <i class="fa-solid fa-trash-can"></i> ลบ
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function handleAdminResetDeviceFromCard(studentCode) {
  if (!confirm(`ยืนยันการปลดล็อก/รีเซ็ตอุปกรณ์ที่ผูกไว้ของรหัส "${studentCode}" หรือไม่?\n(หลังจากรีเซ็ต นักเรียนจะสามารถเข้าสู่ระบบจากเครื่องใหม่และผูกเครื่องได้ทันที)`)) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/admin/devices/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ studentCode })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ ปลดล็อกอุปกรณ์ของ ${studentCode} เรียบร้อยแล้ว`);
      await loadAdminUsers();
    } else {
      alert('❌ ไม่สามารถรีเซ็ตได้: ' + (data.message || 'เกิดข้อผิดพลาด'));
    }
  } catch (err) {
    alert('❌ เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  }
}

async function adminResetPassword(userId, username) {
  if (!confirm(`ยืนยันการรีเซ็ตรหัสผ่านของ "${username}" กลับเป็น "1234" หรือไม่?`)) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/reset-password?username=${encodeURIComponent(username)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ newPassword: '1234', username })
    });
    const data = await res.json();
    if (data.success) {
      alert(`🎉 ${data.message || `รีเซ็ตรหัสผ่านของ @${username} เป็น "1234" เรียบร้อยแล้ว`}`);
    } else {
      alert('❌ เกิดข้อผิดพลาด: ' + (data.message || 'ไม่สามารถรีเซ็ตได้'));
    }
  } catch (err) {
    alert('❌ เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  }
}

async function adminDeleteUser(userId, username) {
  if (!confirm(`⚠️ ยืนยันการลบผู้ใช้ "@${username}" หรือไม่?\n(ข้อมูลผู้ใช้จะถูกลบออกจากระบบและไม่สามารถกู้คืนได้)`)) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}?username=${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      alert(`🗑️ ${data.message || `ลบผู้ใช้ @${username} เรียบร้อยแล้ว`}`);
      await loadAdminUsers();
    } else {
      alert('❌ ลบล้มเหลว: ' + (data.message || 'ไม่สามารถลบได้'));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

function handleAdminAddUserRoleChange() {
  const role = document.getElementById('admin-new-role')?.value || 'student';
  const studentFields = document.getElementById('admin-add-student-fields');
  const staffFields = document.getElementById('admin-add-staff-fields');
  const advClassBox = document.getElementById('admin-add-advisor-classroom-box');
  const subjClassBox = document.getElementById('admin-add-subject-classroom-box');

  if (role === 'student') {
    if (studentFields) studentFields.classList.remove('hidden');
    if (staffFields) staffFields.classList.add('hidden');
    if (advClassBox) advClassBox.classList.add('hidden');
    if (subjClassBox) subjClassBox.classList.add('hidden');
  } else {
    if (studentFields) studentFields.classList.add('hidden');
    if (staffFields) staffFields.classList.remove('hidden');
    if (advClassBox) advClassBox.classList.toggle('hidden', role !== 'advisor');
    if (subjClassBox) subjClassBox.classList.toggle('hidden', role !== 'subject_teacher');
  }
}

function openAddUserModal() {
  const modal = document.getElementById('modal-admin-add-user');
  if (modal) {
    modal.classList.remove('hidden');
    handleAdminAddUserRoleChange();
  }
  document.querySelectorAll('.admin-new-subject-classroom-cb').forEach(cb => { cb.checked = false; });
  updateSubjectClassroomSummary();
  document.getElementById('admin-new-subject-classroom-panel')?.classList.add('hidden');
}

function closeAddUserModal() {
  const modal = document.getElementById('modal-admin-add-user');
  if (modal) modal.classList.add('hidden');
}

function toggleSubjectClassroomDropdown(e) {
  if (e) e.stopPropagation();
  document.getElementById('admin-new-subject-classroom-panel')?.classList.toggle('hidden');
}

function updateSubjectClassroomSummary() {
  const summaryEl = document.getElementById('admin-new-subject-classroom-summary');
  if (!summaryEl) return;
  const selected = Array.from(document.querySelectorAll('.admin-new-subject-classroom-cb:checked')).map(cb => cb.value);
  summaryEl.textContent = selected.length ? selected.join(', ') : 'เลือกชั้นที่สอน';
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('admin-new-subject-classroom-panel');
  const trigger = document.getElementById('admin-new-subject-classroom-trigger');
  if (!panel || panel.classList.contains('hidden')) return;
  if (!panel.contains(e.target) && e.target !== trigger && !trigger?.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

async function handleAdminCreateUser(e) {
  if (e) e.preventDefault();
  const role = document.getElementById('admin-new-role')?.value || 'student';
  const btnSave = document.getElementById('btn-save-new-user');

  let payload = { role };

  if (role === 'student') {
    const student_code = document.getElementById('admin-new-student-code')?.value.trim();
    const prefix = document.getElementById('admin-new-prefix')?.value || 'นาย';
    const first_name = document.getElementById('admin-new-firstname')?.value.trim();
    const last_name = document.getElementById('admin-new-lastname')?.value.trim();
    const dept = document.getElementById('admin-new-dept-select')?.value || 'แผนกวิชาช่างยนต์';
    const curriculum_level = document.getElementById('admin-new-level')?.value || 'ปวช.';
    const class_year = document.getElementById('admin-new-year')?.value || '1';
    const room_number = document.getElementById('admin-new-room')?.value || '1';
    const advisor_username = document.getElementById('admin-new-advisor-select')?.value || 'teacher_auto';

    if (!student_code) {
      alert('กรุณากรอกรหัสนักศึกษา (11 หลัก)');
      return;
    }
    if (!first_name || !last_name) {
      alert('กรุณากรอกชื่อและนามสกุลนักเรียน');
      return;
    }

    payload = {
      ...payload,
      username: student_code,
      student_code,
      prefix,
      first_name,
      last_name,
      dept,
      curriculum_level,
      class_year,
      room_number,
      advisor_username
    };
  } else {
    const username = document.getElementById('admin-new-username')?.value.trim();
    const password = document.getElementById('admin-new-password')?.value.trim() || '1234';
    const full_name = document.getElementById('admin-new-fullname')?.value.trim();
    const dept = document.getElementById('admin-new-dept')?.value.trim() || '';

    if (!username || !full_name) {
      alert('กรุณากรอก Username และ ชื่อ-นามสกุล ให้ครบถ้วน');
      return;
    }

    payload = {
      ...payload,
      username,
      password,
      full_name,
      dept
    };

    if (role === 'advisor') {
      const advClass = document.getElementById('admin-new-advisor-classroom')?.value || 'ปวช.1';
      payload.classroom = advClass;
    } else if (role === 'subject_teacher') {
      const selectedClassrooms = Array.from(document.querySelectorAll('.admin-new-subject-classroom-cb:checked')).map(cb => cb.value);
      if (selectedClassrooms.length) payload.classroom = selectedClassrooms.join(',');
    }
  }

  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ ${data.message || 'สร้างผู้ใช้งานสำเร็จแล้ว'}`);
      closeAddUserModal();
      loadAdminUsers();
    } else {
      alert('❌ ไม่สามารถสร้างผู้ใช้ได้: ' + (data.message || 'เกิดข้อผิดพลาด'));
    }
  } catch (err) {
    alert('❌ เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว: ' + err.message);
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = '<i class="fa-solid fa-user-plus"></i> <span>บันทึกสร้างผู้ใช้</span>';
    }
  }
}

// ---------------- 2. จัดการแผนกวิชา (Department Management) ----------------
async function loadAdminDepartments() {
  const container = document.getElementById('admin-depts-list');
  if (!container) return;
  container.innerHTML = `
    <div class="text-center py-8 text-slate-400 text-xs">
      <i class="fa-solid fa-spinner fa-spin text-lg mb-2 block"></i> กำลังโหลดข้อมูลแผนกวิชา...
    </div>
  `;

  try {
    const res = await fetch('/api/departments');
    const data = await res.json();
    if (Array.isArray(data.departments)) {
      renderAdminDepartments(data.departments);
    } else {
      container.innerHTML = `<div class="p-4 text-center text-xs text-rose-500 font-bold">ไม่พบข้อมูลแผนกวิชา</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="p-4 text-center text-xs text-rose-500 font-bold">เกิดข้อผิดพลาด: ${err.message}</div>`;
  }
}

function renderAdminDepartments(depts) {
  const container = document.getElementById('admin-depts-list');
  if (!container) return;

  if (!depts || depts.length === 0) {
    container.innerHTML = `<div class="p-6 text-center text-slate-400 text-xs bg-slate-50 rounded-2xl">ยังไม่มีแผนกวิชาในระบบ</div>`;
    return;
  }

  container.innerHTML = depts.map(d => {
    return `
      <div class="p-3.5 bg-white hover:bg-slate-50/80 rounded-2xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="w-7 h-7 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center text-xs font-bold shrink-0">
              <i class="fa-solid fa-graduation-cap"></i>
            </span>
            <h5 class="font-bold text-slate-800 text-xs sm:text-sm">${d.name}</h5>
          </div>
          <div class="flex items-center gap-3 text-[11px] text-slate-500 pl-9 flex-wrap">
            <span>👨‍🏫 ครูที่ปรึกษา: <strong class="text-slate-700">${d.teacher?.name || '-'}</strong> (${d.teacher?.username || '-'})</span>
            <span>🏢 หัวหน้าแผนก: <strong class="text-slate-700">${d.head?.name || '-'}</strong> (${d.head?.username || '-'})</span>
          </div>
        </div>

        <button type="button" onclick="adminDeleteDept('${d.id}', '${d.name}')" class="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-[11px] font-bold transition flex items-center gap-1 self-end sm:self-auto shadow-2xs">
          <i class="fa-solid fa-trash-can"></i> ลบแผนก
        </button>
      </div>
    `;
  }).join('');
}

async function handleAdminCreateDept(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('admin-new-dept-name')?.value.trim();
  const teacherName = document.getElementById('admin-new-dept-teacher')?.value.trim();
  const headName = document.getElementById('admin-new-dept-head')?.value.trim();

  if (!name) {
    alert('กรุณากรอกชื่อแผนกวิชา');
    return;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/admin/departments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, teacherName, headName })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ เพิ่มแผนกวิชา "${name}" สำเร็จ`);
      document.getElementById('admin-new-dept-name').value = '';
      document.getElementById('admin-new-dept-teacher').value = '';
      document.getElementById('admin-new-dept-head').value = '';
      loadAdminDepartments();
    } else {
      alert('❌ เพิ่มแผนกวิชาล้มเหลว: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function adminDeleteDept(deptId, deptName) {
  if (!confirm(`⚠️ ยืนยันการลบแผนกวิชา "${deptName}" หรือไม่?`)) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/admin/departments/${deptId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      alert(`ลบแผนกวิชา "${deptName}" เรียบร้อยแล้ว`);
      loadAdminDepartments();
    } else {
      alert('❌ ลบล้มเหลว: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ---------------- 3. ตั้งเวลาสถานศึกษา (Operating Hours & Rules) ----------------
async function loadAdminSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      if (document.getElementById('admin-setting-morning-open')) document.getElementById('admin-setting-morning-open').value = s.morningGateOpen || '06:30';
      if (document.getElementById('admin-setting-morning-close')) document.getElementById('admin-setting-morning-close').value = s.morningGateClose || '08:00';
      if (document.getElementById('admin-setting-lunch-start')) document.getElementById('admin-setting-lunch-start').value = s.lunchStart || '12:00';
      if (document.getElementById('admin-setting-lunch-end')) document.getElementById('admin-setting-lunch-end').value = s.lunchEnd || '13:00';
      if (document.getElementById('admin-setting-dismissal')) document.getElementById('admin-setting-dismissal').value = s.dismissalTime || '16:30';
      if (document.getElementById('admin-setting-night-close')) document.getElementById('admin-setting-night-close').value = s.nightGateClose || '18:00';
      if (document.getElementById('admin-setting-prewarn-min')) document.getElementById('admin-setting-prewarn-min').value = s.prewarnMinutes || 30;
      if (document.getElementById('admin-setting-overdue-min')) document.getElementById('admin-setting-overdue-min').value = s.overdueAlertMinutes || 15;
      if (document.getElementById('admin-setting-min-mins')) document.getElementById('admin-setting-min-mins').value = s.minRequestMinutes || 30;
      if (document.getElementById('admin-setting-max-mins')) document.getElementById('admin-setting-max-mins').value = s.maxRequestMinutes || 480;
      if (document.getElementById('admin-setting-return-max-dist')) document.getElementById('admin-setting-return-max-dist').value = s.returnMaxDistanceCm || 60;
      if (document.getElementById('admin-setting-return-notify-mode')) document.getElementById('admin-setting-return-notify-mode').value = s.returnNotifyMode || 'all';
    }
    loadAdminCronStatus();
  } catch (err) {
    console.warn('Load settings error:', err);
  }
}

async function loadAdminCronStatus() {
  try {
    const res = await fetch('/api/admin/cron/status');
    const data = await res.json();
    if (data.success && data.stats) {
      const elRun = document.getElementById('admin-cron-last-run');
      const elCount = document.getElementById('admin-cron-expired-count');
      if (elRun && data.stats.lastRunTime) {
        const d = new Date(data.stats.lastRunTime);
        elRun.textContent = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' น.';
      } else if (elRun) {
        elRun.textContent = 'พร้อมทำงาน (ทุก 60 วิ)';
      }
      if (elCount) {
        elCount.textContent = data.stats.totalExpiredCount || 0;
      }
    }
  } catch (e) {}
}

async function triggerAdminCronExpireNow() {
  const btn = document.getElementById('admin-cron-trigger-btn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังรัน Cron Job...`;
  }
  try {
    const res = await fetch('/api/admin/cron/expire-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ ${data.message}`);
      loadAdminCronStatus();
    } else {
      alert('❌ รัน Cron Job ล้มเหลว: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }
}

async function handleAdminSaveSettings(e) {
  if (e) e.preventDefault();
  const btn = document.getElementById('admin-save-settings-btn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...`;
  }

  const payload = {
    morningGateOpen: document.getElementById('admin-setting-morning-open')?.value || '06:30',
    morningGateClose: document.getElementById('admin-setting-morning-close')?.value || '08:00',
    lunchStart: document.getElementById('admin-setting-lunch-start')?.value || '12:00',
    lunchEnd: document.getElementById('admin-setting-lunch-end')?.value || '13:00',
    dismissalTime: document.getElementById('admin-setting-dismissal')?.value || '16:30',
    nightGateClose: document.getElementById('admin-setting-night-close')?.value || '18:00',
    prewarnMinutes: parseInt(document.getElementById('admin-setting-prewarn-min')?.value || 30, 10),
    overdueAlertMinutes: parseInt(document.getElementById('admin-setting-overdue-min')?.value || 15, 10),
    minRequestMinutes: parseInt(document.getElementById('admin-setting-min-mins')?.value || 30, 10),
    maxRequestMinutes: parseInt(document.getElementById('admin-setting-max-mins')?.value || 480, 10),
    returnMaxDistanceCm: parseFloat(document.getElementById('admin-setting-return-max-dist')?.value || 60),
    returnNotifyMode: document.getElementById('admin-setting-return-notify-mode')?.value || 'all'
  };

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('💾 บันทึกการตั้งค่าเวลาสถานศึกษาเรียบร้อยแล้ว! (มีผลต่อระบบและ Background Checker ทันที)');
      await fetchAndApplySchoolSettings();
    } else {
      alert('❌ บันทึกล้มเหลว: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

// ---------------- 4. จัดการตารางสอน, ภาคเรียน, สอนแทน/งดสอนรายวัน และตั้งค่าอนุมัติแทน (Requirement 6, 12, 17, 19) ----------------
let adminTimetableData = { activeSemester: '1/2569', semesters: [], entries: [], overrides: [] };
let currentAdminTimetableView = 'grid'; // 'grid' | 'list'
let currentAdminTimetableGrade = 'ปวช.3'; // 'ปวช.1' | 'ปวช.2' | 'ปวช.3' | 'ปวส.1' | 'ปวส.2' | ''
let adminSmartPreviewRows = [];
let adminSelectedTimetableImages = [];

const DAY_LABELS_TH = {
  1: 'จันทร์',
  2: 'อังคาร',
  3: 'พุธ',
  4: 'พฤหัสบดี',
  5: 'ศุกร์',
  6: 'เสาร์',
  0: 'อาทิตย์'
};

const PERIOD_TYPE_LABELS = {
  study: { label: 'คาบเรียนปกติ', bg: 'bg-sky-50 text-sky-700 border-sky-200', cellBg: 'bg-sky-50/90 hover:bg-sky-100/80 border-sky-200 text-sky-950' },
  self_study: { label: 'เรียนรู้ด้วยตนเอง', bg: 'bg-teal-50 text-teal-700 border-teal-300', cellBg: 'bg-teal-50/90 hover:bg-teal-100/80 border-teal-300 text-teal-950 border-dashed' },
  break: { label: 'พักเที่ยง', bg: 'bg-slate-100 text-slate-600 border-slate-300', cellBg: 'bg-slate-100/90 hover:bg-slate-200/70 border-slate-300 text-slate-700' },
  activity: { label: 'กิจกรรม', bg: 'bg-purple-50 text-purple-700 border-purple-200', cellBg: 'bg-purple-50/90 hover:bg-purple-100/80 border-purple-200 text-purple-950' },
  free: { label: 'คาบว่าง', bg: 'bg-amber-50 text-amber-700 border-amber-200', cellBg: 'bg-amber-50/80 hover:bg-amber-100/70 border-amber-200 text-amber-900 border-dashed' }
};

const ALL_VOCATIONAL_GRADES = ['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'];
const ALL_VOCATIONAL_DEPTS = [
  'แผนกวิชาช่างยนต์',
  'แผนกวิชาช่างไฟฟ้า',
  'แผนกวิชาการบัญชี',
  'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล',
  'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล'
];

let adminTeachersList = [];

const TEACHER_ROLE_LABELS_TH = {
  subject_teacher: 'ครูรายวิชา',
  advisor: 'ครูที่ปรึกษา',
  dept_head: 'หัวหน้าแผนกวิชา',
  discipline_head: 'หัวหน้างานปกครอง',
  deputy_director: 'รองผู้อำนวยการ'
};

async function loadAdminTeachersList() {
  try {
    const res = await fetch('/api/teachers');
    const data = await res.json();
    if (data.success && Array.isArray(data.teachers)) {
      adminTeachersList = data.teachers;
      populateAdminTeacherPickers();
    }
  } catch (err) {
    console.warn('Load admin teachers list error:', err);
  }
}

function populateAdminTeacherPickers() {
  const buildOptionsHtml = (firstLabel) => {
    const opts = adminTeachersList.map(t => {
      const roleTh = TEACHER_ROLE_LABELS_TH[t.role] || t.role;
      const autoTag = t.isAutoCreated ? ' [สร้างอัตโนมัติ]' : '';
      return `<option value="${t.username}" data-name="${t.fullName}">@${t.username} — ${t.fullName} (${roleTh} • ${t.dept || 'ทุกแผนก'})${autoTag}</option>`;
    }).join('');
    return `
      <option value="">${firstLabel}</option>
      <option value="__NEW_TEACHER__">➕ พิมพ์ชื่อครูใหม่ด้านล่าง (ระบบสร้าง Username + รหัส 1234 ให้อัตโนมัติ)</option>
      ${opts}
    `;
  };

  const formPicker = document.getElementById('admin-tt-teacher-picker');
  if (formPicker) {
    const prev = formPicker.value;
    formPicker.innerHTML = buildOptionsHtml('-- 👨‍🏫 กดเลือกครูผู้สอนที่มี Username ในระบบ (หรือเลือกครูที่ปรึกษามาสอน) --');
    if (prev) formPicker.value = prev;
  }

  const slotPicker = document.getElementById('slot-edit-teacher-picker');
  if (slotPicker) {
    const prev = slotPicker.value;
    slotPicker.innerHTML = buildOptionsHtml('-- 👨‍🏫 เลือกครูจากรายชื่อในระบบ หรือพิมพ์ชื่อครูใหม่ด้านล่าง --');
    if (prev) slotPicker.value = prev;
  }

  const ovPicker = document.getElementById('admin-ov-teacher-picker');
  if (ovPicker) {
    const prev = ovPicker.value;
    ovPicker.innerHTML = buildOptionsHtml('-- 👨‍🏫 เลือกครูสอนแทนที่มี Username ในระบบ --');
    if (prev) ovPicker.value = prev;
  }
}

function handleAdminSelectTeacherForForm(val) {
  const userEl = document.getElementById('admin-tt-teacher-user');
  const nameEl = document.getElementById('admin-tt-teacher-name');
  if (!val) return;
  if (val === '__NEW_TEACHER__') {
    if (userEl) userEl.value = '';
    if (nameEl) {
      nameEl.value = '';
      nameEl.focus();
    }
    return;
  }
  const found = adminTeachersList.find(t => t.username === val);
  if (found) {
    if (userEl) userEl.value = found.username;
    if (nameEl) nameEl.value = found.fullName;
  }
}

function handleSlotEditorSelectTeacher(val) {
  const userEl = document.getElementById('slot-edit-teacher-user');
  const nameEl = document.getElementById('slot-edit-teacher-name');
  if (!val) return;
  if (val === '__NEW_TEACHER__') {
    if (userEl) userEl.value = '';
    if (nameEl) {
      nameEl.value = '';
      nameEl.focus();
    }
    return;
  }
  const found = adminTeachersList.find(t => t.username === val);
  if (found) {
    if (userEl) userEl.value = found.username;
    if (nameEl) nameEl.value = found.fullName;
  }
}

function handleOverrideSelectTeacher(val) {
  const userEl = document.getElementById('admin-ov-sub-user');
  const nameEl = document.getElementById('admin-ov-sub-name');
  if (!val || val === '__NEW_TEACHER__') return;
  const found = adminTeachersList.find(t => t.username === val);
  if (found) {
    if (userEl) userEl.value = found.username;
    if (nameEl) nameEl.value = found.fullName;
  }
}

async function loadAdminTimetables() {
  const selSemester = document.getElementById('admin-tt-semester-select');
  const filterSemester = selSemester ? selSemester.value : '';
  try {
    loadAdminTeachersList();
    const url = filterSemester ? `/api/timetables?semester=${encodeURIComponent(filterSemester)}` : '/api/timetables';
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) return;
    adminTimetableData = data;

    // อัปเดตตัวเลือกภาคเรียน (Requirement 19)
    if (selSemester && Array.isArray(data.semesters)) {
      const currentSelected = filterSemester || data.activeSemester || '1/2569';
      selSemester.innerHTML = data.semesters.map(s =>
        `<option value="${s.code}" ${s.code === currentSelected ? 'selected' : ''}>${s.name || s.label || ('ภาคเรียนที่ ' + s.code)} ${s.isActive ? '(ใช้งานปัจจุบัน)' : '(เทอมเก่า)'}</option>`
      ).join('');
    }

    const activeSemBadge = document.getElementById('admin-active-semester-badge');
    if (activeSemBadge) {
      activeSemBadge.textContent = `ภาคเรียนปัจจุบัน: ${data.activeSemester || '1/2569'}`;
    }

    const totalCounter = document.getElementById('admin-tt-total-counter');
    if (totalCounter) {
      totalCounter.textContent = `รวมในเทอมนี้: ${(data.entries || []).length} คาบเรียน`;
    }

    updateAdminTimetableGradeCounts();
    renderAdminTimetableGrid();
    renderAdminTimetableEntries();
    renderAdminTimetableOverrides();
    loadAdminDelegations();
  } catch (err) {
    console.warn('Load admin timetables error:', err);
  }
}

function updateAdminTimetableGradeCounts() {
  const deptFilter = document.getElementById('admin-tt-filter-dept')?.value || '';
  const entries = Array.isArray(adminTimetableData.entries) ? adminTimetableData.entries : [];
  const deptEntries = deptFilter
    ? entries.filter(e => isDepartmentMatch(deptFilter, e.deptName || e.department))
    : entries;

  const gradeIdMap = {
    'ปวช.1': 'tt-count-pvc1',
    'ปวช.2': 'tt-count-pvc2',
    'ปวช.3': 'tt-count-pvc3',
    'ปวส.1': 'tt-count-pvs1',
    'ปวส.2': 'tt-count-pvs2'
  };

  Object.entries(gradeIdMap).forEach(([grade, elId]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const count = deptEntries.filter(e => String(e.classroom || '').trim() === grade).length;
    el.textContent = `(${count})`;
  });
}

function handleAdminTimetableFilterChange() {
  const deptVal = document.getElementById('admin-tt-filter-dept')?.value || '';
  const formDept = document.getElementById('admin-tt-dept');
  if (formDept && deptVal) {
    formDept.value = deptVal;
  }
  updateAdminTimetableGradeCounts();
  renderAdminTimetableGrid();
  renderAdminTimetableEntries();
}

function selectAdminTimetableGrade(grade) {
  currentAdminTimetableGrade = grade;
  const pills = document.querySelectorAll('#admin-tt-grade-pills .tt-grade-pill');
  pills.forEach(btn => {
    const g = btn.getAttribute('data-grade') || '';
    if (g === grade) {
      btn.className = 'tt-grade-pill px-3 py-1 rounded-xl border text-xs font-bold transition bg-cyan-600 text-white border-cyan-600 shadow-2xs';
    } else {
      btn.className = 'tt-grade-pill px-3 py-1 rounded-xl border text-xs font-bold transition bg-white text-slate-700 border-slate-300 hover:bg-cyan-50';
    }
  });

  const formGrade = document.getElementById('admin-tt-classroom');
  if (formGrade && grade) {
    formGrade.value = grade;
  }

  renderAdminTimetableGrid();
  renderAdminTimetableEntries();
}

function switchAdminTimetableView(viewMode) {
  currentAdminTimetableView = viewMode === 'list' ? 'list' : 'grid';
  const gridWrapper = document.getElementById('admin-tt-grid-wrapper');
  const listWrapper = document.getElementById('admin-tt-list-wrapper');
  const btnGrid = document.getElementById('btn-tt-view-grid');
  const btnList = document.getElementById('btn-tt-view-list');

  if (currentAdminTimetableView === 'grid') {
    gridWrapper?.classList.remove('hidden');
    listWrapper?.classList.add('hidden');
    if (btnGrid) btnGrid.className = 'px-3 py-1 rounded-lg bg-white text-cyan-700 shadow-2xs font-bold text-[11px] transition flex items-center gap-1';
    if (btnList) btnList.className = 'px-3 py-1 rounded-lg text-slate-600 hover:text-slate-800 font-bold text-[11px] transition flex items-center gap-1';
    renderAdminTimetableGrid();
  } else {
    gridWrapper?.classList.add('hidden');
    listWrapper?.classList.remove('hidden');
    if (btnList) btnList.className = 'px-3 py-1 rounded-lg bg-white text-cyan-700 shadow-2xs font-bold text-[11px] transition flex items-center gap-1';
    if (btnGrid) btnGrid.className = 'px-3 py-1 rounded-lg text-slate-600 hover:text-slate-800 font-bold text-[11px] transition flex items-center gap-1';
    renderAdminTimetableEntries();
  }
}

// วาดตารางเรียนจริง (Interactive Weekly Grid View: วันจันทร์-ศุกร์ × 5 ช่วงเวลา)
function renderAdminTimetableGrid() {
  const tbody = document.getElementById('admin-tt-grid-body');
  if (!tbody) return;

  const deptFilter = document.getElementById('admin-tt-filter-dept')?.value || 'แผนกวิชาช่างยนต์';
  const gradeFilter = currentAdminTimetableGrade || 'ปวช.3';

  const titleEl = document.getElementById('admin-tt-grid-title');
  if (titleEl) {
    const deptText = deptFilter || 'ทุกแผนกวิชา';
    const gradeText = currentAdminTimetableGrade ? `ชั้นปี ${currentAdminTimetableGrade}` : 'ทุกชั้นปี';
    titleEl.textContent = `ตารางเรียน: ${deptText} • ${gradeText}`;
  }

  let entries = Array.isArray(adminTimetableData.entries) ? [...adminTimetableData.entries] : [];
  if (deptFilter) {
    entries = entries.filter(e => isDepartmentMatch(deptFilter, e.deptName || e.department));
  }
  if (currentAdminTimetableGrade) {
    entries = entries.filter(e => String(e.classroom || '').trim() === currentAdminTimetableGrade);
  }

  const timeSlots = [
    { start: '08:00', end: '10:00', label: '08:00-10:00', isBreakSlot: false },
    { start: '10:00', end: '12:00', label: '10:00-12:00', isBreakSlot: false },
    { start: '12:00', end: '13:00', label: '12:00-13:00', isBreakSlot: true },
    { start: '13:00', end: '15:00', label: '13:00-15:00', isBreakSlot: false },
    { start: '15:00', end: '16:00', label: '15:00-16:00', isBreakSlot: false }
  ];

  const days = [
    { day: 1, name: 'วันจันทร์', badge: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    { day: 2, name: 'วันอังคาร', badge: 'bg-pink-100 text-pink-800 border-pink-300' },
    { day: 3, name: 'วันพุธ', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
    { day: 4, name: 'วันพฤหัสบดี', badge: 'bg-orange-100 text-orange-800 border-orange-300' },
    { day: 5, name: 'วันศุกร์', badge: 'bg-sky-100 text-sky-800 border-sky-300' }
  ];

  const toMins = (t) => {
    const [h, m] = String(t || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  tbody.innerHTML = days.map(dObj => {
    const cellsHtml = timeSlots.map(slot => {
      const slotStart = toMins(slot.start);
      const slotEnd = toMins(slot.end);

      // หาคาบเรียนที่ตรงวัน (หรือ dayOfWeek === 0 คือทุกวัน) และเวลาทับซ้อนกับช่องนี้
      const matched = entries.find(e => {
        const eDay = Number(e.dayOfWeek);
        if (eDay !== dObj.day && eDay !== 0) return false;
        const eStart = toMins(e.startTime);
        const eEnd = toMins(e.endTime);
        return eStart < slotEnd && eEnd > slotStart;
      });

      if (!matched) {
        if (slot.isBreakSlot) {
          return `
            <td class="p-1.5 border-r border-slate-200 align-top bg-slate-50/70">
              <button type="button" onclick="adminPrefillSlotForm('${deptFilter}', '${gradeFilter}', ${dObj.day}, '${slot.start}', '${slot.end}', 'break')" class="w-full min-h-[68px] p-2 rounded-xl border border-dashed border-slate-300 hover:border-cyan-400 hover:bg-cyan-50/40 text-slate-400 hover:text-cyan-700 transition flex flex-col items-center justify-center text-center">
                <span class="text-[10px] font-bold">🍱 พักเที่ยง</span>
                <span class="text-[9px] opacity-80">+ ตั้งค่าคาบพัก</span>
              </button>
            </td>
          `;
        }
        return `
          <td class="p-1.5 border-r border-slate-200 align-top">
            <button type="button" onclick="adminPrefillSlotForm('${deptFilter}', '${gradeFilter}', ${dObj.day}, '${slot.start}', '${slot.end}', 'study')" class="w-full min-h-[68px] p-2 rounded-xl border border-dashed border-slate-200 hover:border-cyan-400 hover:bg-cyan-50/40 text-slate-400 hover:text-cyan-700 transition flex flex-col items-center justify-center gap-0.5">
              <i class="fa-solid fa-plus text-xs"></i>
              <span class="text-[10px] font-semibold">เพิ่มคาบเรียน</span>
            </button>
          </td>
        `;
      }

      const pMeta = PERIOD_TYPE_LABELS[matched.periodType] || PERIOD_TYPE_LABELS.study;
      const isStudy = matched.periodType === 'study';
      return `
        <td class="p-1.5 border-r border-slate-200 align-top">
          <div onclick="adminEditTimetableEntry('${matched.id}')" class="cursor-pointer w-full min-h-[68px] p-2 rounded-xl border ${pMeta.cellBg} transition flex flex-col justify-between shadow-2xs relative group">
            <div>
              <div class="flex items-center justify-between gap-1">
                <span class="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-white/80 text-slate-600 border border-slate-200/80">${matched.subjectCode || pMeta.label}</span>
                <span class="text-[9px] font-bold opacity-75">${matched.startTime}-${matched.endTime}</span>
              </div>
              <p class="font-bold text-[11px] leading-snug mt-1 line-clamp-2">${matched.subjectName}</p>
            </div>
            <div class="mt-1.5 pt-1 border-t border-black/5 flex items-center justify-between gap-1 text-[10px]">
              <span class="truncate font-semibold ${isStudy ? 'text-sky-800' : 'text-slate-500'}">
                ${isStudy ? `<i class="fa-solid fa-chalkboard-user mr-0.5"></i>${matched.teacherName || matched.teacherUsername || '-'}` : `✕ ข้ามขั้น 1 (${pMeta.label})`}
              </span>
              <span class="opacity-0 group-hover:opacity-100 transition text-[9px] px-1.5 py-0.2 rounded bg-white/90 text-slate-700 font-bold shadow-2xs">แก้ไข</span>
            </div>
          </div>
        </td>
      `;
    }).join('');

    return `
      <tr class="hover:bg-slate-50/40">
        <td class="py-2.5 px-3 border-r border-slate-200 align-middle bg-slate-50/60">
          <span class="inline-block px-2.5 py-1 rounded-xl border text-[11px] font-bold ${dObj.badge}">${dObj.name}</span>
        </td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');
}

function adminPrefillSlotForm(dept, grade, day, startTime, endTime, periodType = 'study') {
  const detailsEl = document.getElementById('admin-tt-manual-form-details');
  if (detailsEl) detailsEl.open = true;

  const deptEl = document.getElementById('admin-tt-dept');
  if (deptEl && dept) deptEl.value = dept;

  const gradeEl = document.getElementById('admin-tt-classroom');
  if (gradeEl && grade) gradeEl.value = grade;

  const dayEl = document.getElementById('admin-tt-day');
  if (dayEl) dayEl.value = String(day);

  const startEl = document.getElementById('admin-tt-start');
  if (startEl) startEl.value = startTime;

  const endEl = document.getElementById('admin-tt-end');
  if (endEl) endEl.value = endTime;

  const typeEl = document.getElementById('admin-tt-type');
  if (typeEl) typeEl.value = periodType;

  handleAdminPeriodTypeChange(periodType);

  const subjNameEl = document.getElementById('admin-tt-subj-name');
  if (subjNameEl) {
    if (periodType === 'break') {
      subjNameEl.value = 'พักรับประทานอาหารกลางวัน';
    } else if (periodType === 'self_study') {
      subjNameEl.value = 'คาบเรียนรู้ด้วยตนเอง (ไม่มีอาจารย์ผู้สอน)';
    } else if (periodType === 'free') {
      subjNameEl.value = 'คาบว่าง';
    } else {
      subjNameEl.value = '';
    }
    subjNameEl.focus();
  }
  detailsEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleAdminPeriodTypeChange(periodType) {
  const pickerWrap = document.getElementById('admin-tt-teacher-picker-wrap');
  const userWrap = document.getElementById('admin-tt-teacher-user-wrap');
  const nameWrap = document.getElementById('admin-tt-teacher-name-wrap');
  const codeEl = document.getElementById('admin-tt-subj-code');
  const nameEl = document.getElementById('admin-tt-subj-name');
  const tUserEl = document.getElementById('admin-tt-teacher-user');
  const tNameEl = document.getElementById('admin-tt-teacher-name');

  if (periodType === 'study') {
    pickerWrap?.classList.remove('opacity-50', 'pointer-events-none');
    userWrap?.classList.remove('opacity-50');
    nameWrap?.classList.remove('opacity-50');
    if (tUserEl && !tUserEl.value) tUserEl.value = 'subject_auto';
    if (tNameEl && (!tNameEl.value || tNameEl.value === '-')) tNameEl.value = 'อ.ธีรพงศ์ เครื่องยนต์';
  } else {
    pickerWrap?.classList.add('opacity-50', 'pointer-events-none');
    userWrap?.classList.add('opacity-50');
    nameWrap?.classList.add('opacity-50');
    if (tUserEl) tUserEl.value = '';
    if (tNameEl) tNameEl.value = '-';
    if (periodType === 'self_study') {
      if (codeEl && !codeEl.value) codeEl.value = 'SELF-01';
      if (nameEl && !nameEl.value) nameEl.value = 'คาบเรียนรู้ด้วยตนเอง (ไม่มีอาจารย์ผู้สอน)';
    } else if (periodType === 'free') {
      if (codeEl && !codeEl.value) codeEl.value = 'FREE';
      if (nameEl && !nameEl.value) nameEl.value = 'คาบว่าง / ค้นคว้าอิสระ';
    } else if (periodType === 'break') {
      if (codeEl && !codeEl.value) codeEl.value = 'BREAK';
      if (nameEl && !nameEl.value) nameEl.value = 'พักรับประทานอาหารกลางวัน';
    } else if (periodType === 'activity') {
      if (codeEl && !codeEl.value) codeEl.value = 'ACT-01';
      if (nameEl && !nameEl.value) nameEl.value = 'กิจกรรมพัฒนาผู้เรียน';
    }
  }
}

function quickFillSelfStudyForm() {
  const typeEl = document.getElementById('admin-tt-type');
  const codeEl = document.getElementById('admin-tt-subj-code');
  const nameEl = document.getElementById('admin-tt-subj-name');
  if (typeEl) typeEl.value = 'self_study';
  if (codeEl) codeEl.value = 'SELF-01';
  if (nameEl) nameEl.value = 'คาบเรียนรู้ด้วยตนเอง (ไม่มีอาจารย์ผู้สอน)';
  handleAdminPeriodTypeChange('self_study');
}

function quickFillFreePeriodForm() {
  const typeEl = document.getElementById('admin-tt-type');
  const codeEl = document.getElementById('admin-tt-subj-code');
  const nameEl = document.getElementById('admin-tt-subj-name');
  if (typeEl) typeEl.value = 'free';
  if (codeEl) codeEl.value = 'FREE';
  if (nameEl) nameEl.value = 'คาบว่าง (ไม่มีเรียน)';
  handleAdminPeriodTypeChange('free');
}

function renderAdminTimetableEntries() {
  const container = document.getElementById('admin-tt-entries-list');
  if (!container) return;

  const deptFilter = document.getElementById('admin-tt-filter-dept')?.value || '';
  const dayFilter = document.getElementById('admin-tt-filter-day')?.value || '';
  let entries = Array.isArray(adminTimetableData.entries) ? [...adminTimetableData.entries] : [];

  if (deptFilter) {
    entries = entries.filter(e => isDepartmentMatch(deptFilter, e.deptName || e.department));
  }
  if (currentAdminTimetableGrade) {
    entries = entries.filter(e => String(e.classroom || '').trim() === currentAdminTimetableGrade);
  }
  if (dayFilter !== '') {
    entries = entries.filter(e => Number(e.dayOfWeek) === Number(dayFilter) || Number(e.dayOfWeek) === 0);
  }

  entries.sort((a, b) => {
    const da = a.deptName || a.department || '';
    const db = b.deptName || b.department || '';
    if (da !== db) return da.localeCompare(db);
    if (a.classroom !== b.classroom) return (a.classroom || '').localeCompare(b.classroom || '');
    if (Number(a.dayOfWeek) !== Number(b.dayOfWeek)) return Number(a.dayOfWeek) - Number(b.dayOfWeek);
    return (a.startTime || '').localeCompare(b.startTime || '');
  });

  const listCountEl = document.getElementById('admin-tt-list-count');
  if (listCountEl) {
    listCountEl.textContent = `แสดง ${entries.length} คาบเรียน`;
  }

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center text-xs text-slate-500 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
        <p class="font-bold text-slate-700">ยังไม่มีรายการตารางสอนในชั้นปี/แผนกที่เลือก</p>
        <p class="text-[11px] text-slate-400">คุณสามารถกดปุ่ม "ดึงตารางชั้นปีที่เลือกอัตโนมัติ" หรือ "สแกนจากรูปภาพ" ด้านบนเพื่อดึงตารางสอนเข้าสู่ระบบได้ทันที</p>
      </div>
    `;
    return;
  }

  container.innerHTML = entries.map(e => {
    const pMeta = PERIOD_TYPE_LABELS[e.periodType] || PERIOD_TYPE_LABELS.study;
    const dayName = Number(e.dayOfWeek) === 0 ? 'ทุกวัน (จ.-ศ.)' : ('วัน' + (DAY_LABELS_TH[Number(e.dayOfWeek)] || e.dayOfWeek));
    const deptLabel = e.deptName || e.department || 'ทุกแผนก';
    return `
      <div class="p-3 bg-white hover:bg-slate-50/80 rounded-2xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs transition">
        <div class="space-y-0.5">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 font-bold text-[10px]">${deptLabel} • ${e.classroom}</span>
            <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px]">${dayName} (${e.startTime} - ${e.endTime})</span>
            <span class="px-2 py-0.5 rounded-full border text-[10px] font-bold ${pMeta.bg}">${pMeta.label}</span>
          </div>
          <div class="text-slate-700 font-semibold pt-0.5">
            ${e.subjectCode ? `<span class="font-mono text-slate-500 mr-1">[${e.subjectCode}]</span>` : ''}
            <span>${e.subjectName}</span>
            ${e.teacherName && e.periodType === 'study' ? ` • <span class="text-sky-700 font-bold">👨‍🏫 ${e.teacherName}</span> <span class="text-slate-400 font-normal">(@${e.teacherUsername || '-'})</span>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
          <button type="button" onclick="adminEditTimetableEntry('${e.id}')" class="px-2.5 py-1 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold transition">
            <i class="fa-solid fa-pen"></i> แก้ไข
          </button>
          <button type="button" onclick="adminDeleteTimetableEntry('${e.id}')" class="px-2.5 py-1 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-[11px] font-bold transition">
            <i class="fa-solid fa-trash-can"></i> ลบ
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleAdminCreateTimetableEntry(e) {
  if (e) e.preventDefault();
  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  const department = document.getElementById('admin-tt-dept')?.value || 'แผนกวิชาช่างยนต์';
  const classroom = document.getElementById('admin-tt-classroom')?.value.trim() || 'ปวช.3';
  const dayOfWeek = Number(document.getElementById('admin-tt-day')?.value || 1);
  const startTime = document.getElementById('admin-tt-start')?.value || '08:00';
  const endTime = document.getElementById('admin-tt-end')?.value || '10:00';
  const subjectCode = document.getElementById('admin-tt-subj-code')?.value.trim() || '';
  const subjectName = document.getElementById('admin-tt-subj-name')?.value.trim() || '';
  const teacherUsername = document.getElementById('admin-tt-teacher-user')?.value.trim() || '';
  const teacherName = document.getElementById('admin-tt-teacher-name')?.value.trim() || '';
  const periodType = document.getElementById('admin-tt-type')?.value || 'study';

  if (!subjectName) {
    alert('กรุณาระบุชื่อรายวิชา (หรือ พักเที่ยง / คาบว่าง)');
    return;
  }

  try {
    const token = await ensureAuthToken();
    const sendReq = async (forceSave = false) => {
      const res = await fetch('/api/timetables', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          semester, department, classroom, dayOfWeek, startTime, endTime,
          subjectCode, subjectName, teacherUsername, teacherName, periodType, forceSave
        })
      });
      return res.json();
    };

    let data = await sendReq(false);
    if (!data.success && (data.hasConflicts || data.conflict)) {
      const confirmForce = confirm(`${data.message}\n\nต้องการยืนยันบันทึกคาบเรียนนี้ทับลงในตารางหรือไม่?`);
      if (!confirmForce) return;
      data = await sendReq(true);
    }

    if (!data.success) {
      alert('❌ บันทึกไม่สำเร็จ: ' + (data.message || ''));
      return;
    }
    alert('✅ ' + (data.message || 'เพิ่มคาบเรียนลงตารางสอนสำเร็จ'));
    loadAdminTimetables();
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function adminEditTimetableEntry(entryId) {
  const entry = (adminTimetableData.entries || []).find(x => String(x.id) === String(entryId));
  if (!entry) return;

  const modal = document.getElementById('modal-admin-tt-slot-editor');
  if (!modal) return;

  await loadAdminTeachersList();

  document.getElementById('slot-edit-id').value = entry.id;
  const subEl = document.getElementById('slot-editor-subtitle');
  const dayLabel = Number(entry.dayOfWeek) === 0 ? 'ทุกวัน (จ.-ศ.)' : ('วัน' + (DAY_LABELS_TH[Number(entry.dayOfWeek)] || entry.dayOfWeek));
  if (subEl) {
    subEl.textContent = `${entry.department || entry.deptName} • ชั้นปี ${entry.classroom} • ${dayLabel} (${entry.startTime}-${entry.endTime})`;
  }

  const typeEl = document.getElementById('slot-edit-type');
  if (typeEl) typeEl.value = entry.periodType || 'study';

  const startEl = document.getElementById('slot-edit-start');
  if (startEl) startEl.value = entry.startTime || '08:00';

  const endEl = document.getElementById('slot-edit-end');
  if (endEl) endEl.value = entry.endTime || '10:00';

  const codeEl = document.getElementById('slot-edit-code');
  if (codeEl) codeEl.value = entry.subjectCode || '';

  const nameEl = document.getElementById('slot-edit-name');
  if (nameEl) nameEl.value = entry.subjectName || '';

  const tUserEl = document.getElementById('slot-edit-teacher-user');
  if (tUserEl) tUserEl.value = entry.teacherUsername || '';

  const tNameEl = document.getElementById('slot-edit-teacher-name');
  if (tNameEl) tNameEl.value = entry.teacherName || '';

  const slotPicker = document.getElementById('slot-edit-teacher-picker');
  if (slotPicker) {
    slotPicker.value = entry.teacherUsername || '';
  }

  handleSlotEditorTypeChange(entry.periodType || 'study');

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeAdminSlotEditorModal() {
  const modal = document.getElementById('modal-admin-tt-slot-editor');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function handleSlotEditorTypeChange(typeVal) {
  const pickerBox = document.getElementById('slot-edit-teacher-picker-box');
  const userBox = document.getElementById('slot-edit-teacher-user-box');
  const nameBox = document.getElementById('slot-edit-teacher-name-box');
  if (typeVal === 'study') {
    pickerBox?.classList.remove('opacity-40', 'pointer-events-none');
    userBox?.classList.remove('opacity-40');
    nameBox?.classList.remove('opacity-40');
  } else {
    pickerBox?.classList.add('opacity-40', 'pointer-events-none');
    userBox?.classList.add('opacity-40');
    nameBox?.classList.add('opacity-40');
  }
}

function applySlotQuickPreset(presetType) {
  const typeEl = document.getElementById('slot-edit-type');
  const codeEl = document.getElementById('slot-edit-code');
  const nameEl = document.getElementById('slot-edit-name');
  const tUserEl = document.getElementById('slot-edit-teacher-user');
  const tNameEl = document.getElementById('slot-edit-teacher-name');

  if (typeEl) typeEl.value = presetType;
  if (tUserEl) tUserEl.value = '';
  if (tNameEl) tNameEl.value = '-';

  if (presetType === 'self_study') {
    if (codeEl) codeEl.value = 'SELF-01';
    if (nameEl) nameEl.value = 'คาบเรียนรู้ด้วยตนเอง (ไม่มีอาจารย์ผู้สอน)';
  } else if (presetType === 'free') {
    if (codeEl) codeEl.value = 'FREE';
    if (nameEl) nameEl.value = 'คาบว่าง (ไม่มีเรียน)';
  }
  handleSlotEditorTypeChange(presetType);
  // บันทึกให้อัตโนมัติทันทีในคลิกเดียว
  handleSlotEditorSave();
}

async function handleSlotEditorSave() {
  const entryId = document.getElementById('slot-edit-id')?.value;
  if (!entryId) return;

  const periodType = document.getElementById('slot-edit-type')?.value || 'study';
  const startTime = document.getElementById('slot-edit-start')?.value || '08:00';
  const endTime = document.getElementById('slot-edit-end')?.value || '10:00';
  const subjectCode = document.getElementById('slot-edit-code')?.value.trim() || '-';
  const subjectName = document.getElementById('slot-edit-name')?.value.trim() || 'คาบเรียนรู้ด้วยตนเอง';
  const teacherUsername = periodType === 'study' ? (document.getElementById('slot-edit-teacher-user')?.value.trim() || '') : '';
  const teacherName = periodType === 'study' ? (document.getElementById('slot-edit-teacher-name')?.value.trim() || '') : '-';

  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/timetables/${entryId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        subjectCode,
        subjectName,
        teacherName,
        teacherUsername,
        startTime,
        endTime,
        periodType,
        forceSave: true
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert(`⚠️ ${data.message || 'แก้ไขไม่สำเร็จ'}`);
      return;
    }
    if (data.provisionedTeacher && data.provisionedTeacher.createdNew) {
      alert(`✅ ${data.message}`);
    }
    closeAdminSlotEditorModal();
    loadAdminTimetables();
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleSlotEditorDelete() {
  const entryId = document.getElementById('slot-edit-id')?.value;
  if (!entryId) return;
  closeAdminSlotEditorModal();
  await adminDeleteTimetableEntry(entryId);
}

async function adminDeleteTimetableEntry(entryId) {
  if (!confirm('ยืนยันการลบคาบเรียนนี้ออกจากตารางสอนหรือไม่?')) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/timetables/${entryId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      loadAdminTimetables();
    } else {
      alert('❌ ลบไม่สำเร็จ: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ==================== ศูนย์ดึงข้อมูลและนำเข้าตารางสอนอัตโนมัติ 4 ช่องทาง (Smart Timetable Pull Hub) ====================

function openAdminSmartImportModalBase(mode) {
  const modal = document.getElementById('modal-admin-tt-smart-import');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  const secImages = document.getElementById('modal-tt-section-images');
  const secGsheet = document.getElementById('modal-tt-section-gsheet');
  const secStd = document.getElementById('modal-tt-section-standard');
  const iconEl = document.getElementById('modal-tt-smart-icon');
  const titleEl = document.getElementById('modal-tt-smart-title');
  const subEl = document.getElementById('modal-tt-smart-subtitle');

  secImages?.classList.add('hidden');
  secGsheet?.classList.add('hidden');
  secStd?.classList.add('hidden');

  if (mode === 'images') {
    secImages?.classList.remove('hidden');
    if (iconEl) iconEl.className = 'fa-solid fa-camera-retro';
    if (titleEl) titleEl.textContent = 'สแกนตารางสอนจากรูปภาพ (อัปโหลดได้หลายรูป • แยกแผนกและชั้นปี ปวช.1–ปวส.2)';
    if (subEl) subEl.textContent = 'เลือกรูปภาพตารางสอนของแต่ละแผนก/ชั้นปี ระบบจะแปลงเป็นตารางให้ตรวจสอบและแก้ไขได้ก่อนบันทึกจริง';
  } else if (mode === 'gsheet') {
    secGsheet?.classList.remove('hidden');
    if (iconEl) iconEl.className = 'fa-solid fa-cloud-arrow-down';
    if (titleEl) titleEl.textContent = 'ดึงข้อมูลตารางสอนจาก Google Sheets / ลิงก์ออนไลน์';
    if (subEl) subEl.textContent = 'วางลิงก์ Google Sheets ของฝ่ายวิชาการ ระบบจะดึงข้อมูลทุกแผนกและทุกชั้นปีมาแสดงให้ตรวจสอบก่อนบันทึก';
  } else if (mode === 'standard') {
    secStd?.classList.remove('hidden');
    if (iconEl) iconEl.className = 'fa-solid fa-bolt';
    if (titleEl) titleEl.textContent = 'ดึงตารางสอนมาตรฐานครบทุกแผนกวิชา & ทุกชั้นปี (ปวช.1–ปวส.2)';
    if (subEl) subEl.textContent = 'เลือกแผนกวิชาและชั้นปีที่ต้องการสร้างตารางสอนอัตโนมัติ (วันจันทร์–ศุกร์ ครบทุกคาบ)';
  } else if (mode === 'excel_preview') {
    if (iconEl) iconEl.className = 'fa-solid fa-file-excel';
    if (titleEl) titleEl.textContent = 'ตรวจสอบข้อมูลตารางสอนจากไฟล์ Excel / CSV ก่อนบันทึก';
    if (subEl) subEl.textContent = 'ตรวจสอบและแก้ไขรายการคาบเรียนที่อ่านได้จากไฟล์ก่อนกดยืนยันบันทึกลงระบบ';
  }
}

function closeAdminSmartImportModal() {
  const modal = document.getElementById('modal-admin-tt-smart-import');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function openAdminTimetableImageScannerModal() {
  adminSelectedTimetableImages = [];
  adminSmartPreviewRows = [];
  document.getElementById('admin-tt-selected-images-list')?.classList.add('hidden');
  document.getElementById('modal-tt-preview-container')?.classList.add('hidden');
  openAdminSmartImportModalBase('images');
}

function openAdminGoogleSheetFetchModal() {
  adminSmartPreviewRows = [];
  document.getElementById('modal-tt-preview-container')?.classList.add('hidden');
  openAdminSmartImportModalBase('gsheet');
}

function openAdminPullStandardTimetableModal() {
  adminSmartPreviewRows = [];
  document.getElementById('modal-tt-preview-container')?.classList.add('hidden');
  openAdminSmartImportModalBase('standard');
}

function toggleAllStandardCheckboxes(selector, checked) {
  document.querySelectorAll(selector).forEach(cb => { cb.checked = checked; });
}

// เดาแผนกและชั้นปีอัตโนมัติจากชื่อไฟล์รูปภาพ (ถ้ามีคำว่า ปวช.1, ช่างไฟฟ้า ฯลฯ)
function guessDeptAndGradeFromFileName(fileName = '', index = 0) {
  const name = String(fileName).toLowerCase();
  const currentDept = document.getElementById('admin-tt-filter-dept')?.value || 'แผนกวิชาช่างยนต์';
  let dept = currentDept;
  if (name.includes('ไฟฟ้า') || name.includes('elec')) dept = 'แผนกวิชาช่างไฟฟ้า';
  else if (name.includes('บัญชี') || name.includes('acc')) dept = 'แผนกวิชาการบัญชี';
  else if (name.includes('ดิจิทัล') || name.includes('คอม') || name.includes('it')) dept = 'แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล';
  else if (name.includes('จัดการ') || name.includes('สำนักงาน') || name.includes('mgmt')) dept = 'แผนกวิชาการจัดการสำนักงาน/การจัดการธุรกิจดิจิทัล';
  else if (name.includes('ยนต์') || name.includes('auto')) dept = 'แผนกวิชาช่างยนต์';

  let grade = ALL_VOCATIONAL_GRADES[index % ALL_VOCATIONAL_GRADES.length] || currentAdminTimetableGrade || 'ปวช.3';
  if (name.includes('ปวช.1') || name.includes('ปวช1') || name.includes('pvc1')) grade = 'ปวช.1';
  else if (name.includes('ปวช.2') || name.includes('ปวช2') || name.includes('pvc2')) grade = 'ปวช.2';
  else if (name.includes('ปวช.3') || name.includes('ปวช3') || name.includes('pvc3')) grade = 'ปวช.3';
  else if (name.includes('ปวส.1') || name.includes('ปวส1') || name.includes('pvs1')) grade = 'ปวส.1';
  else if (name.includes('ปวส.2') || name.includes('ปวส2') || name.includes('pvs2')) grade = 'ปวส.2';

  return { dept, grade };
}

function handleAdminSelectTimetableImages(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) return;

  adminSelectedTimetableImages = [];
  let loaded = 0;

  files.forEach((file, idx) => {
    const reader = new FileReader();
    const guessed = guessDeptAndGradeFromFileName(file.name, idx);
    reader.onload = (e) => {
      adminSelectedTimetableImages.push({
        id: 'img-' + Date.now() + '-' + idx,
        fileName: file.name,
        mimeType: file.type || 'image/jpeg',
        base64Data: e.target.result,
        department: guessed.dept,
        classroom: guessed.grade
      });
      loaded++;
      if (loaded === files.length) {
        renderAdminSelectedTimetableImages();
      }
    };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

// ปุ่มจำลองรูปตารางสอนครบทั้ง 5 ชั้นปี (ปวช.1-ปวส.2) เพื่อทดสอบการสแกนหลายรูปพร้อมกันทันที
function handleAdminAddDemoTimetableImages() {
  const targetDept = document.getElementById('admin-tt-filter-dept')?.value || 'แผนกวิชาช่างยนต์';
  adminSelectedTimetableImages = ALL_VOCATIONAL_GRADES.map((grade, idx) => ({
    id: `demo-img-${idx}`,
    fileName: `ตารางสอน_${targetDept}_${grade}.png`,
    mimeType: 'image/png',
    base64Data: '',
    department: targetDept,
    classroom: grade
  }));
  renderAdminSelectedTimetableImages();
  handleAdminScanSelectedImages();
}

function renderAdminSelectedTimetableImages() {
  const listEl = document.getElementById('admin-tt-selected-images-list');
  if (!listEl) return;

  if (adminSelectedTimetableImages.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  listEl.classList.remove('hidden');
  const cardsHtml = adminSelectedTimetableImages.map((img, idx) => {
    const deptOptions = ALL_VOCATIONAL_DEPTS.map(d =>
      `<option value="${d}" ${d === img.department ? 'selected' : ''}>${d}</option>`
    ).join('');
    const gradeOptions = ALL_VOCATIONAL_GRADES.map(g =>
      `<option value="${g}" ${g === img.classroom ? 'selected' : ''}>ชั้นปี ${g}</option>`
    ).join('');

    const thumbHtml = img.base64Data
      ? `<img src="${img.base64Data}" class="w-14 h-14 rounded-xl object-cover border border-slate-200 shrink-0" alt="timetable">`
      : `<div class="w-14 h-14 rounded-xl bg-violet-100 text-violet-700 border border-violet-200 flex flex-col items-center justify-center shrink-0 text-[10px] font-bold"><i class="fa-solid fa-table text-sm"></i><span>${img.classroom}</span></div>`;

    return `
      <div class="p-2.5 rounded-2xl bg-white border border-violet-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-2xs">
        <div class="flex items-center gap-2.5 min-w-0">
          ${thumbHtml}
          <div class="min-w-0">
            <p class="font-bold text-slate-800 text-xs truncate">รูปที่ ${idx + 1}: ${img.fileName}</p>
            <p class="text-[10px] text-slate-500">เลือกแผนกวิชาและชั้นปีของตารางสอนในรูปนี้:</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <select onchange="updateSelectedImageMeta(${idx}, 'department', this.value)" class="px-2.5 py-1.5 rounded-xl bg-slate-50 border border-slate-300 text-xs font-bold text-slate-700">
            ${deptOptions}
          </select>
          <select onchange="updateSelectedImageMeta(${idx}, 'classroom', this.value)" class="px-2.5 py-1.5 rounded-xl bg-violet-50 border border-violet-300 text-xs font-bold text-violet-800">
            ${gradeOptions}
          </select>
          <button type="button" onclick="removeSelectedTimetableImage(${idx})" class="px-2 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-bold">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = `
    <div class="flex items-center justify-between px-1">
      <span class="font-bold text-violet-900 text-xs"><i class="fa-solid fa-layer-group mr-1"></i> รูปภาพที่เตรียมสแกน (${adminSelectedTimetableImages.length} รูป):</span>
      <button type="button" onclick="handleAdminScanSelectedImages()" class="px-4 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs transition flex items-center gap-1.5 shadow-sm">
        <i class="fa-solid fa-wand-magic-sparkles"></i> เริ่มสแกนตารางสอนจากรูปทั้งหมด (${adminSelectedTimetableImages.length} รูป)
      </button>
    </div>
    <div class="space-y-2 max-h-[210px] overflow-y-auto pr-1">${cardsHtml}</div>
  `;
}

function updateSelectedImageMeta(idx, key, val) {
  if (adminSelectedTimetableImages[idx]) {
    adminSelectedTimetableImages[idx][key] = val;
  }
}

function removeSelectedTimetableImage(idx) {
  adminSelectedTimetableImages.splice(idx, 1);
  renderAdminSelectedTimetableImages();
}

async function handleAdminScanSelectedImages() {
  if (adminSelectedTimetableImages.length === 0) {
    alert('กรุณาเลือกรูปภาพตารางสอนอย่างน้อย 1 รูป');
    return;
  }

  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/parse-images', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        semester,
        images: adminSelectedTimetableImages
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert('❌ สแกนรูปภาพไม่สำเร็จ: ' + (data.message || ''));
      return;
    }
    adminSmartPreviewRows = Array.isArray(data.rows) ? data.rows : [];
    renderAdminSmartPreviewTable(data.message);
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาดในการสแกนรูปภาพ: ' + err.message);
  }
}

// นำเข้าไฟล์ Excel (.xlsx / .xls) หรือ CSV พร้อมแสดงตารางตรวจสอบก่อนบันทึก
async function handleAdminImportTimetablesFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const dayMap = {
    'จันทร์': 1, 'วันจันทร์': 1, 'อังคาร': 2, 'วันอังคาร': 2, 'พุธ': 3, 'วันพุธ': 3,
    'พฤหัสบดี': 4, 'วันพฤหัสบดี': 4, 'พฤหัส': 4, 'ศุกร์': 5, 'วันศุกร์': 5, 'เสาร์': 6, 'อาทิตย์': 0,
    '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '0': 0
  };
  const typeMap = {
    'เรียน': 'study', 'คาบเรียน': 'study', 'คาบเรียนปกติ': 'study', 'study': 'study',
    'เรียนรู้ด้วยตนเอง': 'self_study', 'ค้นคว้าด้วยตนเอง': 'self_study', 'ไม่มีครูสอน': 'self_study', 'self_study': 'self_study',
    'พัก': 'break', 'พักเที่ยง': 'break', 'break': 'break',
    'กิจกรรม': 'activity', 'activity': 'activity',
    'ว่าง': 'free', 'คาบว่าง': 'free', 'free': 'free'
  };

  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';

  if (isExcel && typeof XLSX !== 'undefined') {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const rows = [];

        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          jsonRows.forEach(r => {
            const dept = r['แผนกวิชา'] || r['department'] || r['แผนก'] || 'แผนกวิชาช่างยนต์';
            const cls = r['ห้องเรียน'] || r['ชั้นปี'] || r['ระดับชั้น'] || r['classroom'] || 'ปวช.3';
            const dayRaw = String(r['วันในสัปดาห์'] || r['วัน'] || r['dayOfWeek'] || 'จันทร์').trim();
            const startTime = String(r['เวลาเริ่ม'] || r['startTime'] || '08:00').trim();
            const endTime = String(r['เวลาสิ้นสุด'] || r['endTime'] || '10:00').trim();
            const subjectCode = String(r['รหัสวิชา'] || r['subjectCode'] || '-').trim();
            const subjectName = String(r['ชื่อวิชา'] || r['รายวิชา'] || r['subjectName'] || 'รายวิชาเรียน').trim();
            const teacherUsername = String(r['usernameครู'] || r['teacherUsername'] || 'subject_auto').trim();
            const teacherName = String(r['ชื่อครูผู้สอน'] || r['ครูผู้สอน'] || r['teacherName'] || 'อาจารย์ผู้สอน').trim();
            const typeRaw = String(r['ประเภทคาบ'] || r['periodType'] || 'เรียน').trim().toLowerCase();

            rows.push({
              semester,
              department: dept,
              deptName: dept,
              classroom: cls,
              dayOfWeek: dayMap[dayRaw] !== undefined ? dayMap[dayRaw] : Number(dayRaw || 1),
              startTime,
              endTime,
              subjectCode,
              subjectName,
              teacherUsername,
              teacherName,
              periodType: typeMap[typeRaw] || 'study'
            });
          });
        });

        if (rows.length === 0) {
          alert('ไม่พบข้อมูลแถวตารางสอนในไฟล์ Excel ที่เลือก');
          return;
        }
        adminSmartPreviewRows = rows;
        openAdminSmartImportModalBase('excel_preview');
        renderAdminSmartPreviewTable(`อ่านไฟล์ Excel "${file.name}" สำเร็จ (${rows.length} คาบเรียน)`);
      } catch (err) {
        alert('❌ อ่านไฟล์ Excel ไม่สำเร็จ: ' + err.message);
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
    return;
  }

  // กรณีไฟล์ CSV
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        alert('ไฟล์ CSV ไม่มีข้อมูลเพียงพอ');
        return;
      }
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
        if (cols.length < 5) continue;
        const [deptName, classroom, dayRaw, startTime, endTime, subjectCode, subjectName, teacherUsername, teacherName, periodTypeRaw] = cols;
        rows.push({
          semester,
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
          periodType: typeMap[(periodTypeRaw || '').toLowerCase()] || 'study'
        });
      }
      adminSmartPreviewRows = rows;
      openAdminSmartImportModalBase('excel_preview');
      renderAdminSmartPreviewTable(`อ่านไฟล์ CSV "${file.name}" สำเร็จ (${rows.length} คาบเรียน)`);
    } catch (err) {
      alert('❌ อ่านไฟล์ CSV ไม่สำเร็จ: ' + err.message);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
}

// ดึงตารางสอนจาก Google Sheets URL
async function handleAdminFetchGoogleSheetRows() {
  const urlInput = document.getElementById('admin-tt-gsheet-url');
  const sheetUrl = urlInput ? urlInput.value.trim() : '';
  if (!sheetUrl) {
    alert('กรุณาวางลิงก์ Google Sheets หรือ URL ของไฟล์ CSV');
    return;
  }
  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/fetch-sheet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ sheetUrl, semester })
    });
    const data = await res.json();
    if (!data.success) {
      alert('❌ ' + (data.message || 'ดึงข้อมูลจากลิงก์ไม่สำเร็จ'));
      return;
    }
    adminSmartPreviewRows = Array.isArray(data.rows) ? data.rows : [];
    renderAdminSmartPreviewTable(data.message);
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ดึงตารางสอนมาตรฐานครบทุกแผนกและทุกชั้นปี (ปวช.1-ปวส.2)
async function handleAdminGenerateStandardPreview(selectAll = false) {
  if (selectAll) {
    toggleAllStandardCheckboxes('.std-dept-cb', true);
    toggleAllStandardCheckboxes('.std-grade-cb', true);
  }
  const departments = Array.from(document.querySelectorAll('.std-dept-cb:checked')).map(cb => cb.value);
  const classrooms = Array.from(document.querySelectorAll('.std-grade-cb:checked')).map(cb => cb.value);

  if (departments.length === 0 || classrooms.length === 0) {
    alert('กรุณาเลือกอย่างน้อย 1 แผนกวิชา และ 1 ชั้นปี');
    return;
  }

  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/pull-standard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        semester,
        mode: 'standard_filtered',
        departments,
        classrooms,
        previewOnly: true
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert('❌ ดึงตารางมาตรฐานไม่สำเร็จ: ' + (data.message || ''));
      return;
    }
    adminSmartPreviewRows = Array.isArray(data.rows) ? data.rows : [];
    renderAdminSmartPreviewTable(`เตรียมตารางสอนมาตรฐานสำหรับ ${departments.length} แผนก × ${classrooms.length} ชั้นปี สำเร็จ (${adminSmartPreviewRows.length} คาบเรียน)`);
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ปุ่มด่วนบนหน้าตาราง: ดึงตารางสอนเฉพาะแผนกและชั้นปีที่กำลังเลือกอยู่ทันที
async function handleQuickPullCurrentClassTimetable() {
  const dept = document.getElementById('admin-tt-filter-dept')?.value || 'แผนกวิชาช่างยนต์';
  const grade = currentAdminTimetableGrade || 'ปวช.3';
  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/pull-standard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        semester,
        mode: 'standard_filtered',
        departments: [dept],
        classrooms: [grade],
        previewOnly: true
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert('❌ ' + (data.message || 'ไม่สามารถดึงตารางสอนได้'));
      return;
    }
    adminSmartPreviewRows = Array.isArray(data.rows) ? data.rows : [];
    openAdminSmartImportModalBase('standard');
    renderAdminSmartPreviewTable(`เตรียมตารางสอน [${dept} • ชั้นปี ${grade}] สำเร็จ (${adminSmartPreviewRows.length} คาบเรียน)`);
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// คัดลอกตารางสอนจากภาคเรียนเก่า
async function handleAdminCopyPreviousSemester() {
  const currentSem = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  const sourceSem = prompt(`ระบุรหัสภาคเรียนต้นทางที่ต้องการคัดลอกตารางสอนมายังเทอม "${currentSem}":`, '2/2568');
  if (!sourceSem || !sourceSem.trim()) return;

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/pull-standard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        semester: currentSem,
        mode: 'copy_semester',
        sourceSemester: sourceSem.trim(),
        previewOnly: true
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert('⚠️ ' + (data.message || 'ไม่พบข้อมูลในเทอมต้นทาง'));
      return;
    }
    adminSmartPreviewRows = Array.isArray(data.rows) ? data.rows : [];
    openAdminSmartImportModalBase('excel_preview');
    renderAdminSmartPreviewTable(`ดึงข้อมูลจากภาคเรียน ${sourceSem.trim()} สำเร็จ (${adminSmartPreviewRows.length} คาบเรียน)`);
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// วาดตารางตัวอย่างที่แก้ไขได้ทุกช่องก่อนกดยืนยันบันทึกจริง
function renderAdminSmartPreviewTable(summaryText = '') {
  const container = document.getElementById('modal-tt-preview-container');
  const tbody = document.getElementById('modal-tt-preview-tbody');
  const summaryEl = document.getElementById('modal-tt-preview-summary');
  if (!container || !tbody) return;

  container.classList.remove('hidden');
  if (summaryEl) {
    summaryEl.textContent = summaryText || `พร้อมนำเข้าตารางสอนทั้งหมด ${adminSmartPreviewRows.length} คาบเรียน`;
  }

  tbody.innerHTML = adminSmartPreviewRows.map((r, idx) => {
    const gradeOpts = ALL_VOCATIONAL_GRADES.map(g =>
      `<option value="${g}" ${g === r.classroom ? 'selected' : ''}>${g}</option>`
    ).join('');
    const dayOpts = [1, 2, 3, 4, 5, 0].map(d =>
      `<option value="${d}" ${Number(r.dayOfWeek) === d ? 'selected' : ''}>${d === 0 ? 'ทุกวัน' : DAY_LABELS_TH[d]}</option>`
    ).join('');
    const typeOpts = [
      { v: 'study', l: 'เรียนปกติ' },
      { v: 'self_study', l: 'เรียนรู้ด้วยตนเอง (ไม่มีครู)' },
      { v: 'free', l: 'คาบว่าง' },
      { v: 'break', l: 'พักเที่ยง' },
      { v: 'activity', l: 'กิจกรรม' }
    ].map(t => `<option value="${t.v}" ${r.periodType === t.v ? 'selected' : ''}>${t.l}</option>`).join('');

    const teacherSelectOpts = [
      `<option value="">-- เลือกครูที่มี Username --</option>`,
      `<option value="__NEW__">➕ สร้าง Username ครูใหม่อัตโนมัติ (รหัส 1234)</option>`,
      ...adminTeachersList.map(t =>
        `<option value="${t.username}" ${t.username === r.teacherUsername ? 'selected' : ''}>@${t.username} (${t.fullName})</option>`
      )
    ].join('');

    return `
      <tr class="hover:bg-slate-50">
        <td class="py-1.5 px-2 font-mono text-slate-400">${idx + 1}</td>
        <td class="py-1.5 px-1.5">
          <input type="text" value="${r.department || r.deptName || ''}" onchange="updateAdminPreviewCell(${idx}, 'department', this.value)" class="w-full px-2 py-1 rounded-lg border border-slate-200 text-[11px]">
        </td>
        <td class="py-1.5 px-1.5">
          <select onchange="updateAdminPreviewCell(${idx}, 'classroom', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-bold">
            ${gradeOpts}
          </select>
        </td>
        <td class="py-1.5 px-1.5">
          <select onchange="updateAdminPreviewCell(${idx}, 'dayOfWeek', Number(this.value))" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px]">
            ${dayOpts}
          </select>
        </td>
        <td class="py-1.5 px-1.5">
          <input type="text" maxlength="5" placeholder="08:00" value="${r.startTime || '08:00'}" oninput="format24HourInput(this)" onchange="updateAdminPreviewCell(${idx}, 'startTime', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-mono font-bold text-center">
        </td>
        <td class="py-1.5 px-1.5">
          <input type="text" maxlength="5" placeholder="10:00" value="${r.endTime || '10:00'}" oninput="format24HourInput(this)" onchange="updateAdminPreviewCell(${idx}, 'endTime', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-mono font-bold text-center">
        </td>
        <td class="py-1.5 px-1.5">
          <input type="text" value="${r.subjectCode || ''}" onchange="updateAdminPreviewCell(${idx}, 'subjectCode', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-mono">
        </td>
        <td class="py-1.5 px-1.5">
          <input type="text" value="${r.subjectName || ''}" onchange="updateAdminPreviewCell(${idx}, 'subjectName', this.value)" class="w-full px-2 py-1 rounded-lg border border-slate-200 text-[11px] font-semibold">
        </td>
        <td class="py-1.5 px-1.5 space-y-1">
          <select onchange="handlePreviewRowSelectTeacher(${idx}, this.value)" class="w-full px-1 py-0.5 rounded bg-cyan-50 border border-cyan-200 text-[10px] font-bold text-cyan-900">
            ${teacherSelectOpts}
          </select>
          <input type="text" id="preview-tuser-${idx}" value="${r.teacherUsername || ''}" placeholder="เว้นว่าง=สร้างอัตโนมัติ" onchange="updateAdminPreviewCell(${idx}, 'teacherUsername', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-mono">
        </td>
        <td class="py-1.5 px-1.5">
          <input type="text" id="preview-tname-${idx}" value="${r.teacherName || ''}" placeholder="ชื่อครูผู้สอน" onchange="updateAdminPreviewCell(${idx}, 'teacherName', this.value)" class="w-full px-2 py-1 rounded-lg border border-slate-200 text-[11px]">
        </td>
        <td class="py-1.5 px-1.5">
          <select onchange="updateAdminPreviewCell(${idx}, 'periodType', this.value)" class="w-full px-1.5 py-1 rounded-lg border border-slate-200 text-[11px]">
            ${typeOpts}
          </select>
        </td>
        <td class="py-1.5 px-1.5 text-center">
          <button type="button" onclick="removeAdminPreviewRow(${idx})" class="text-rose-500 hover:text-rose-700 p-1">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function handlePreviewRowSelectTeacher(idx, val) {
  if (!adminSmartPreviewRows[idx]) return;
  if (val === '__NEW__') {
    adminSmartPreviewRows[idx].teacherUsername = '';
    const userInp = document.getElementById(`preview-tuser-${idx}`);
    if (userInp) userInp.value = '';
    const nameInp = document.getElementById(`preview-tname-${idx}`);
    if (nameInp) nameInp.focus();
    return;
  }
  const found = adminTeachersList.find(t => t.username === val);
  if (found) {
    adminSmartPreviewRows[idx].teacherUsername = found.username;
    adminSmartPreviewRows[idx].teacherName = found.fullName;
    const userInp = document.getElementById(`preview-tuser-${idx}`);
    const nameInp = document.getElementById(`preview-tname-${idx}`);
    if (userInp) userInp.value = found.username;
    if (nameInp) nameInp.value = found.fullName;
  }
}

function updateAdminPreviewCell(idx, key, val) {
  if (!adminSmartPreviewRows[idx]) return;
  adminSmartPreviewRows[idx][key] = val;
  if (key === 'department') {
    adminSmartPreviewRows[idx].deptName = val;
  }
}

function removeAdminPreviewRow(idx) {
  adminSmartPreviewRows.splice(idx, 1);
  renderAdminSmartPreviewTable();
}

function addAdminPreviewRow() {
  const dept = document.getElementById('admin-tt-filter-dept')?.value || 'แผนกวิชาช่างยนต์';
  const grade = currentAdminTimetableGrade || 'ปวช.3';
  adminSmartPreviewRows.unshift({
    department: dept,
    deptName: dept,
    classroom: grade,
    dayOfWeek: 1,
    startTime: '08:00',
    endTime: '10:00',
    subjectCode: '20101-2001',
    subjectName: 'รายวิชาเพิ่มเติม',
    teacherUsername: 'subject_auto',
    teacherName: 'อ.ธีรพงศ์ เครื่องยนต์',
    periodType: 'study'
  });
  renderAdminSmartPreviewTable();
}

async function handleAdminConfirmSmartImportSave() {
  if (!Array.isArray(adminSmartPreviewRows) || adminSmartPreviewRows.length === 0) {
    alert('ยังไม่มีข้อมูลตารางสอนในรายการตัวอย่าง กรุณาสแกนรูปภาพ เลือกไฟล์ หรือกดดึงตารางสอนก่อน');
    return;
  }

  const btn = document.getElementById('btn-confirm-smart-tt-save');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึกตารางสอน...`;
  }

  const semester = document.getElementById('admin-tt-semester-select')?.value || adminTimetableData.activeSemester || '1/2569';
  const replaceTargetClasses = Boolean(document.getElementById('modal-tt-replace-classes')?.checked);

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        semester,
        replaceTargetClasses,
        rows: adminSmartPreviewRows
      })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ ${data.message}`);
      closeAdminSmartImportModal();
      loadAdminTimetables();
    } else {
      alert('❌ บันทึกไม่สำเร็จ: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

function downloadSampleTimetableExcel() {
  const sampleRows = [
    { 'แผนกวิชา': 'แผนกวิชาช่างยนต์', 'ชั้นปี': 'ปวช.1', 'วันในสัปดาห์': 'จันทร์', 'เวลาเริ่ม': '08:00', 'เวลาสิ้นสุด': '10:00', 'รหัสวิชา': '20101-2001', 'ชื่อวิชา': 'งานเครื่องยนต์แก๊สโซลีน', 'usernameครู': 'subject_auto', 'ชื่อครูผู้สอน': 'อ.ธีรพงศ์ เครื่องยนต์', 'ประเภทคาบ': 'เรียน' },
    { 'แผนกวิชา': 'แผนกวิชาช่างยนต์', 'ชั้นปี': 'ปวช.2', 'วันในสัปดาห์': 'จันทร์', 'เวลาเริ่ม': '08:00', 'เวลาสิ้นสุด': '10:00', 'รหัสวิชา': '20101-2004', 'ชื่อวิชา': 'งานเครื่องยนต์ดีเซล', 'usernameครู': 'subject_auto', 'ชื่อครูผู้สอน': 'อ.ธีรพงศ์ เครื่องยนต์', 'ประเภทคาบ': 'เรียน' },
    { 'แผนกวิชา': 'แผนกวิชาช่างยนต์', 'ชั้นปี': 'ปวช.3', 'วันในสัปดาห์': 'จันทร์', 'เวลาเริ่ม': '08:00', 'เวลาสิ้นสุด': '10:00', 'รหัสวิชา': '20101-2007', 'ชื่อวิชา': 'งานปรับอากาศรถยนต์', 'usernameครู': 'subject_auto', 'ชื่อครูผู้สอน': 'อ.ธีรพงศ์ เครื่องยนต์', 'ประเภทคาบ': 'เรียน' },
    { 'แผนกวิชา': 'แผนกวิชาช่างไฟฟ้า', 'ชั้นปี': 'ปวส.1', 'วันในสัปดาห์': 'จันทร์', 'เวลาเริ่ม': '08:00', 'เวลาสิ้นสุด': '10:00', 'รหัสวิชา': '30104-2001', 'ชื่อวิชา': 'การออกแบบระบบไฟฟ้า', 'usernameครู': 'subject_elec', 'ชื่อครูผู้สอน': 'อ.ธนากร วงจรไฟฟ้า', 'ประเภทคาบ': 'เรียน' },
    { 'แผนกวิชา': 'แผนกวิชาการบัญชี', 'ชั้นปี': 'ปวส.2', 'วันในสัปดาห์': 'จันทร์', 'เวลาเริ่ม': '12:00', 'เวลาสิ้นสุด': '13:00', 'รหัสวิชา': 'BREAK', 'ชื่อวิชา': 'พักรับประทานอาหารกลางวัน', 'usernameครู': '', 'ชื่อครูผู้สอน': '-', 'ประเภทคาบ': 'พัก' }
  ];

  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Timetable_Template');
    XLSX.writeFile(wb, 'OnePass_Timetable_Template_AllGrades.xlsx');
  } else {
    downloadSampleTimetableCsv();
  }
}

function downloadSampleTimetableCsv() {
  const sampleRows = [
    ['แผนกวิชา', 'ห้องเรียน', 'วันในสัปดาห์', 'เวลาเริ่ม', 'เวลาสิ้นสุด', 'รหัสวิชา', 'ชื่อวิชา', 'usernameครู', 'ชื่อครูผู้สอน', 'ประเภทคาบ'],
    ['แผนกวิชาช่างยนต์', 'ปวช.1', 'จันทร์', '08:00', '10:00', '20101-2001', 'งานเครื่องยนต์แก๊สโซลีน', 'subject_auto', 'อ.ธีรพงศ์ เครื่องยนต์', 'เรียน'],
    ['แผนกวิชาช่างยนต์', 'ปวช.2', 'จันทร์', '08:00', '10:00', '20101-2004', 'งานเครื่องยนต์ดีเซล', 'subject_auto', 'อ.ธีรพงศ์ เครื่องยนต์', 'เรียน'],
    ['แผนกวิชาช่างยนต์', 'ปวช.3', 'จันทร์', '08:00', '10:00', '20101-2007', 'งานปรับอากาศรถยนต์', 'subject_auto', 'อ.ธีรพงศ์ เครื่องยนต์', 'เรียน'],
    ['แผนกวิชาช่างยนต์', 'ปวส.1', 'จันทร์', '12:00', '13:00', 'BREAK', 'พักรับประทานอาหารกลางวัน', '', '', 'พัก'],
    ['แผนกวิชาช่างยนต์', 'ปวส.2', 'จันทร์', '13:00', '15:00', '30101-2005', 'งานซ่อมบำรุงยานยนต์ไฟฟ้า', 'subject_auto', 'อ.ธีรพงศ์ เครื่องยนต์', 'เรียน']
  ];
  const csv = '\uFEFF' + sampleRows.map(r => r.map(c => `"${c}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'OnePass_Timetable_Template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// สลับภาคเรียน หรือสร้างภาคเรียนใหม่ โดยข้อมูลเทอมเก่าไม่หาย (Requirement 19)
async function handleAdminSwitchActiveSemester() {
  const semesterCode = document.getElementById('admin-tt-semester-select')?.value;
  if (!semesterCode) return;
  if (!confirm(`ต้องการตั้งค่าให้ภาคเรียน "${semesterCode}" เป็นภาคเรียนปัจจุบันของระบบใช่หรือไม่?\n(ข้อมูลตารางสอนของภาคเรียนเก่าจะยังคงถูกเก็บไว้ครบถ้วน)`)) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/semesters', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ code: semesterCode, setActive: true })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ เปลี่ยนภาคเรียนปัจจุบันเป็น ${semesterCode} เรียบร้อยแล้ว`);
      loadAdminTimetables();
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleAdminCreateNewSemester() {
  const code = prompt('ระบุรหัสภาคเรียนใหม่ (เช่น 2/2569):', '2/2569');
  if (!code || !code.trim()) return;
  const label = prompt('ระบุชื่อภาคเรียน:', `ภาคเรียนที่ ${code.trim()}`);
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/semesters', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ code: code.trim(), label: label || `ภาคเรียนที่ ${code.trim()}`, setActive: true })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ สร้างและเปิดใช้งานภาคเรียน ${code.trim()} เรียบร้อยแล้ว (ข้อมูลภาคเรียนเก่ายังอยู่ครบ)`);
      loadAdminTimetables();
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

// รองรับสอนแทนและงดสอนเป็นรายวัน โดยไม่ต้องแก้ตารางหลัก (Requirement 17)
function renderAdminTimetableOverrides() {
  const container = document.getElementById('admin-tt-overrides-list');
  if (!container) return;

  const overrides = Array.isArray(adminTimetableData.overrides) ? adminTimetableData.overrides : [];
  if (overrides.length === 0) {
    container.innerHTML = `<div class="p-4 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl border border-slate-100">ยังไม่มีรายการแจ้งสอนแทนหรืองดสอนรายวัน</div>`;
    return;
  }

  container.innerHTML = overrides.map(ov => {
    const isCancel = ov.overrideType === 'cancelled';
    return `
      <div class="p-3 bg-white rounded-2xl border ${isCancel ? 'border-rose-200' : 'border-amber-200'} flex items-center justify-between gap-2 text-xs">
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isCancel ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-800'}">
              ${isCancel ? '✕ งดสอนรายวัน (ข้ามขั้น 1 อัตโนมัติ)' : '🔄 สอนแทนรายวัน'}
            </span>
            <span class="font-bold text-slate-800">${ov.date} (${ov.startTime} - ${ov.endTime})</span>
            <span class="text-slate-500">${ov.deptName} • ${ov.classroom}</span>
          </div>
          <p class="text-[11px] text-slate-600 mt-0.5">
            ${!isCancel ? `ครูสอนแทน: <strong class="text-amber-700">${ov.substituteTeacherName || '-'} (@${ov.substituteTeacherUsername || '-'})</strong> • ` : ''}
            หมายเหตุ: ${ov.reason || '-'}
          </p>
        </div>
        <button type="button" onclick="adminDeleteTimetableOverride('${ov.id}')" class="px-2.5 py-1 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-[11px] font-bold shrink-0">
          <i class="fa-solid fa-trash-can"></i> ลบ
        </button>
      </div>
    `;
  }).join('');
}

async function handleAdminCreateOverride(e) {
  if (e) e.preventDefault();
  const date = document.getElementById('admin-ov-date')?.value || getBkkDateString(0);
  const deptName = document.getElementById('admin-ov-dept')?.value || 'แผนกวิชาช่างยนต์';
  const classroom = document.getElementById('admin-ov-classroom')?.value.trim() || 'ปวช.3';
  const startTime = document.getElementById('admin-ov-start')?.value || '08:00';
  const endTime = document.getElementById('admin-ov-end')?.value || '10:00';
  const overrideType = document.getElementById('admin-ov-type')?.value || 'substitute';
  const substituteTeacherUsername = document.getElementById('admin-ov-sub-user')?.value.trim() || '';
  const substituteTeacherName = document.getElementById('admin-ov-sub-name')?.value.trim() || '';
  const reason = document.getElementById('admin-ov-reason')?.value.trim() || 'ครูติดราชการ';

  if (overrideType === 'substitute' && !substituteTeacherName) {
    alert('กรณีสอนแทน กรุณาระบุชื่อครูผู้สอนแทน');
    return;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/timetables/overrides', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        date, deptName, classroom, startTime, endTime, overrideType,
        substituteTeacherUsername, substituteTeacherName, reason
      })
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ บันทึกรายการสอนแทน/งดสอนรายวันเรียบร้อยแล้ว (ไม่กระทบตารางหลัก)');
      loadAdminTimetables();
    } else {
      alert('❌ บันทึกไม่สำเร็จ: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function adminDeleteTimetableOverride(ovId) {
  if (!confirm('ต้องการลบรายการสอนแทน/งดสอนรายวันนี้ใช่หรือไม่?')) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/timetables/overrides/${ovId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) loadAdminTimetables();
  } catch (err) {}
}

// จัดการการมอบหมายผู้อนุมัติแทนล่วงหน้า (Requirement 6)
async function loadAdminDelegations() {
  const container = document.getElementById('admin-delegations-list');
  if (!container) return;
  try {
    const res = await fetch('/api/delegations');
    const data = await res.json();
    const list = data.delegations || [];
    if (list.length === 0) {
      container.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl">ยังไม่มีรายการตั้งค่าผู้อนุมัติแทนล่วงหน้า (ครูในแผนกสามารถกดปุ่ม "อนุมัติแทนครูที่ไม่อยู่" ที่หน้าอนุมัติได้โดยตรงเช่นกัน)</div>`;
      return;
    }
    container.innerHTML = list.map(d => `
      <div class="p-3 bg-white rounded-2xl border border-indigo-200 flex items-center justify-between gap-2 text-xs">
        <div>
          <span class="font-bold text-indigo-900">ขั้นที่ ${d.stepNumber}: @${d.delegateUsername} (${d.delegateName || '-'})</span>
          <span class="text-slate-600"> อนุมัติแทน </span>
          <span class="font-bold text-slate-800">@${d.fromUsername || 'ทุกคนในแผนก'} (${d.fromName || d.deptName || 'ทุกแผนก'})</span>
          <p class="text-[11px] text-slate-500">วันที่: ${d.startDate} ถึง ${d.endDate} • เหตุผล: ${d.reason || '-'}</p>
        </div>
        <button type="button" onclick="adminDeleteDelegation('${d.id}')" class="px-2.5 py-1 rounded-xl bg-rose-50 text-rose-600 border border-rose-200 text-[11px] font-bold shrink-0">ลบ</button>
      </div>
    `).join('');
  } catch (e) {}
}

async function handleAdminCreateDelegation(e) {
  if (e) e.preventDefault();
  const stepNumber = Number(document.getElementById('admin-del-step')?.value || 1);
  const fromUsername = document.getElementById('admin-del-from-user')?.value.trim() || '';
  const fromName = document.getElementById('admin-del-from-name')?.value.trim() || '';
  const delegateUsername = document.getElementById('admin-del-to-user')?.value.trim() || '';
  const delegateName = document.getElementById('admin-del-to-name')?.value.trim() || '';
  const deptName = document.getElementById('admin-del-dept')?.value || '';
  const startDate = document.getElementById('admin-del-start')?.value || getBkkDateString(0);
  const endDate = document.getElementById('admin-del-end')?.value || getBkkDateString(7);
  const reason = document.getElementById('admin-del-reason')?.value.trim() || 'ไปราชการ / ลาพักผ่อน';

  if (!delegateUsername) {
    alert('กรุณาระบุ Username ผู้รับมอบอำนาจอนุมัติแทน');
    return;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/delegations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        stepNumber, fromUsername, fromName, delegateUsername, delegateName, deptName, startDate, endDate, reason
      })
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ บันทึกการตั้งค่าผู้อนุมัติแทนสำเร็จ');
      loadAdminDelegations();
    } else {
      alert('❌ บันทึกไม่สำเร็จ: ' + (data.message || ''));
    }
  } catch (err) {
    alert('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function adminDeleteDelegation(delId) {
  if (!confirm('ยืนยันการลบการตั้งค่าอนุมัติแทนนี้หรือไม่?')) return;
  try {
    const token = await ensureAuthToken();
    const res = await fetch(`/api/delegations/${delId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) loadAdminDelegations();
  } catch (e) {}
}




// ============================================================================
// SETTINGS, THEME, LANGUAGE & PWA MODULE
// ============================================================================

let deferredPwaPrompt = null;

// 1. PWA Service Worker & Install Flow
function initPwaServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          console.log('✅ [PWA] ServiceWorker registered with scope:', reg.scope);
        })
        .catch(err => {
          console.warn('⚠️ [PWA] ServiceWorker registration failed:', err);
        });
    });
  }

  // Capture install prompt for Chrome/Edge/Android
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    console.log('📲 [PWA] beforeinstallprompt captured and ready');
    const pwaBtn = document.getElementById('btn-install-pwa');
    if (pwaBtn) {
      pwaBtn.classList.remove('opacity-60');
    }
  });

  window.addEventListener('appinstalled', () => {
    console.log('🎉 [PWA] OnePass app was installed successfully');
    deferredPwaPrompt = null;
    const pwaBtnText = document.getElementById('btn-install-pwa-text');
    if (pwaBtnText) {
      const lang = getAppLanguage();
      pwaBtnText.textContent = lang === 'en' ? '✅ App Installed' : '✅ ติดตั้งแอปเรียบร้อยแล้ว';
    }
  });

  // Check if already in standalone display mode
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) {
    const pwaBtn = document.getElementById('btn-install-pwa');
    const pwaBtnText = document.getElementById('btn-install-pwa-text');
    if (pwaBtnText) {
      const lang = getAppLanguage();
      pwaBtnText.textContent = lang === 'en' ? '✅ Running in App Mode' : '✅ เปิดใช้งานในโหมดแอปแล้ว';
    }
    if (pwaBtn) {
      pwaBtn.disabled = true;
      pwaBtn.classList.add('opacity-75', 'cursor-default');
    }
  }
}

async function triggerPwaInstall() {
  if (deferredPwaPrompt) {
    try {
      deferredPwaPrompt.prompt();
      const choiceResult = await deferredPwaPrompt.userChoice;
      console.log('📲 [PWA] User response:', choiceResult.outcome);
      if (choiceResult.outcome === 'accepted') {
        const pwaBtnText = document.getElementById('btn-install-pwa-text');
        if (pwaBtnText) {
          const lang = getAppLanguage();
          pwaBtnText.textContent = lang === 'en' ? '⏳ Installing...' : '⏳ กำลังติดตั้ง...';
        }
      }
      deferredPwaPrompt = null;
    } catch (err) {
      console.warn('⚠️ [PWA] Error in prompt:', err);
    }
  } else {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      alert(getAppLanguage() === 'en' 
        ? "📱 To install OnePass on iPhone/iPad:\n1. Tap the Share button (bottom of Safari)\n2. Select 'Add to Home Screen'"
        : "📱 วิธีติดตั้ง OnePass บน iPhone/iPad:\n1. กดปุ่มแชร์ (Share) ด้านล่าง Safari\n2. เลือก 'เพิ่มไปยังหน้าจอโฮม' (Add to Home Screen)");
    } else {
      alert(getAppLanguage() === 'en'
        ? "💡 To install OnePass on your device:\nOpen browser menu (⋮) and tap 'Install app' or 'Add to Home screen'."
        : "💡 วิธีติดตั้ง OnePass บนมือถือ:\nกดเมนูของเบราว์เซอร์ (จุดสามจุด ⋮) แล้วเลือก 'ติดตั้งแอป' หรือ 'เพิ่มลงในหน้าจอหลัก'");
    }
  }
}

// 2. Settings Modal Control
function openSettingsModal() {
  const modal = document.getElementById('modal-settings');
  if (modal) {
    modal.classList.remove('hidden');
    syncSettingsModalUI();
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('modal-settings');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// Close on backdrop click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('modal-settings');
  if (modal && !modal.classList.contains('hidden') && e.target === modal) {
    closeSettingsModal();
  }
});

// 3. Theme Toggle (Light / Dark)
function getAppTheme() {
  return localStorage.getItem('onepass_theme') || 'light';
}

function setAppTheme(theme) {
  const currentTheme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem('onepass_theme', currentTheme);
  applyAppTheme(currentTheme);
}

function applyAppTheme(theme) {
  const root = document.documentElement;
  const body = document.body;
  if (theme === 'dark') {
    root.classList.add('dark');
    if (body) body.classList.add('dark');
  } else {
    root.classList.remove('dark');
    if (body) body.classList.remove('dark');
  }
  const headerIcon = document.getElementById('header-theme-toggle-icon');
  if (headerIcon) {
    headerIcon.className = theme === 'dark' ? 'fa-solid fa-sun text-sm' : 'fa-solid fa-moon text-sm';
  }
  syncSettingsModalUI();
}

function initAppTheme() {
  const savedTheme = getAppTheme();
  applyAppTheme(savedTheme);
}

// ปุ่มสลับธีมด่วนที่ header (เข้าถึงได้ทันทีทุกหน้า ไม่ต้องเปิดเมนูตั้งค่า)
function toggleAppTheme() {
  const next = getAppTheme() === 'dark' ? 'light' : 'dark';
  setAppTheme(next);
}

// 4. Language Toggle (Thai / English)
const I18N_DICTIONARY = {
  th: {
    settings_btn: "ตั้งค่า",
    settings_modal_title: "การตั้งค่า (Settings)",
    settings_modal_sub: "ปรับแต่งธีม ภาษา และติดตั้งแอป OnePass",
    settings_theme_label: "ชุดรูปแบบ (Theme)",
    settings_theme_light: "โหมดสว่าง (Light)",
    settings_theme_dark: "โหมดมืด (Dark)",
    settings_lang_label: "ภาษา (Language)",
    settings_pwa_desc: "ติดตั้งลงหน้าจอมือถือหรือแท็บเล็ต ใช้งานได้รวดเร็วเหมือนแอปจริง",
    settings_pwa_btn: "📲 ติดตั้งแอป OnePass ลงหน้าจอมือถือ",
    settings_pwa_ios_title: "สำหรับ iPhone / iPad (Safari):",
    settings_close: "ปิดหน้าต่าง",
    nav_home: "หน้าหลัก",
    nav_history: "ประวัติคำร้อง",
    nav_approval: "การอนุมัติ",
    nav_stats: "สถิติ",
    nav_profile: "โปรไฟล์",
    nav_admin: "จัดการระบบ",
    home_gate_mgmt: "การจัดการเข้า-ออก",
    btn_current_status: "สถานะปัจจุบัน",
    btn_new_request: "ยื่นคำร้อง",
    stats_title: "สถิติการออกนอกสถานศึกษา",
    stats_history_btn: "ดูประวัติรายการ",
    stats_total_exit: "ขอออกทั้งหมด",
    stats_ontime: "กลับตามเวลา",
    stats_late: "กลับช้า",
    stats_no_scan: "ไม่พบการสแกนกลับ",
    profile_info_title: "ข้อมูลส่วนตัวและการติดต่อ",
    profile_edit_btn: "แก้ไขข้อมูล",
    status_card_title: "สถานะคำขอปัจจุบัน",
    status_card_sub: "ระบบขออนุญาต OnePass",
    status_no_request: "ไม่มีคำขอ",
    status_no_request_desc: "ยังไม่มีคำร้องที่เปิดใช้งาน หรือกลับเข้าสถานศึกษาเรียบร้อยแล้ว",

    auth_welcome_subtitle: "ระบบขออนุญาตออกนอกสถานศึกษา",
    auth_welcome_college: "วิทยาลัยการอาชีพองครักษ์",
    auth_welcome_login_btn: "เข้าสู่ระบบ OnePass IoT Gate",
    auth_welcome_hint_title: "นักเรียนเข้าสู่ระบบด้วยรหัสนักศึกษาอย่างเดียว",
    auth_welcome_hint_sub: "ระบบผูกเครื่องอัตโนมัติ ปลอดภัย ไม่ต้องใช้รหัสผ่าน",
    auth_welcome_footer: "OnePass IoT Smart Gate System • วิทยาลัยการอาชีพองครักษ์",
    auth_login_title: "เข้าสู่ระบบ",
    auth_login_subtitle: "OnePass Secure Smart Gate Access",
    auth_tab_student: "นักเรียน",
    auth_tab_staff: "ครู / เจ้าหน้าที่",
    auth_student_error: "รหัสนักศึกษาไม่ถูกต้อง หรือไม่พบบัญชีในระบบ กรุณาติดต่อครูที่ปรึกษาหรือฝ่ายทะเบียน",
    auth_student_code_label: "รหัสนักศึกษา (11 หลัก)",
    auth_student_code_badge: "ผูกอุปกรณ์อัตโนมัติ",
    auth_student_code_placeholder: "เช่น 66209010012",
    auth_student_code_hint: "ไม่ต้องใช้รหัสผ่าน เข้าครั้งแรกระบบจะผูกกับเครื่องนี้ทันที",
    auth_student_submit: "เข้าสู่ระบบ OnePass",
    auth_staff_error_title: "เข้าสู่ระบบไม่สำเร็จ",
    auth_staff_error_sub: "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง",
    auth_staff_username_label: "ชื่อผู้ใช้งาน (USERNAME)",
    auth_staff_username_placeholder: "เช่น teacher_auto หรือ admin",
    auth_staff_password_label: "รหัสผ่าน (PASSWORD)",
    auth_staff_submit: "เข้าสู่ระบบเจ้าหน้าที่"
  },
  en: {
    settings_btn: "Settings",
    settings_modal_title: "Settings",
    settings_modal_sub: "Customize theme, language & install OnePass",
    settings_theme_label: "Theme",
    settings_theme_light: "Light Mode",
    settings_theme_dark: "Dark Mode",
    settings_lang_label: "Language",
    settings_pwa_desc: "Install on mobile or tablet home screen for instant native app feel",
    settings_pwa_btn: "📲 Install OnePass App to Home Screen",
    settings_pwa_ios_title: "For iPhone / iPad (Safari):",
    settings_close: "Close",
    nav_home: "Home",
    nav_history: "History",
    nav_approval: "Approvals",
    nav_stats: "Statistics",
    nav_profile: "Profile",
    nav_admin: "Admin",
    home_gate_mgmt: "Gate Pass Management",
    btn_current_status: "Current Status",
    btn_new_request: "New Request",
    stats_title: "Exit Pass Statistics",
    stats_history_btn: "View History",
    stats_total_exit: "Total Exits",
    stats_ontime: "Returned On Time",
    stats_late: "Returned Late",
    stats_no_scan: "Missing Return Scan",
    profile_info_title: "Personal & Contact Information",
    profile_edit_btn: "Edit Profile",
    status_card_title: "Current Request Status",
    status_card_sub: "OnePass Authorization System",
    status_no_request: "No Active Request",
    status_no_request_desc: "No pending or active request found, or student already returned to campus.",

    auth_welcome_subtitle: "Campus Exit Authorization System",
    auth_welcome_college: "Ongkharak Industrial and Community Education College",
    auth_welcome_login_btn: "Sign in to OnePass IoT Gate",
    auth_welcome_hint_title: "Students sign in with their student ID only",
    auth_welcome_hint_sub: "Automatic device binding, secure, no password needed",
    auth_welcome_footer: "OnePass IoT Smart Gate System • Ongkharak College",
    auth_login_title: "Sign In",
    auth_login_subtitle: "OnePass Secure Smart Gate Access",
    auth_tab_student: "Student",
    auth_tab_staff: "Teacher / Staff",
    auth_student_error: "Invalid student ID or account not found. Please contact your advisor or the registrar office.",
    auth_student_code_label: "Student ID (11 digits)",
    auth_student_code_badge: "Auto device binding",
    auth_student_code_placeholder: "e.g. 66209010012",
    auth_student_code_hint: "No password needed — your first login binds this device automatically",
    auth_student_submit: "Sign in to OnePass",
    auth_staff_error_title: "Sign In Failed",
    auth_staff_error_sub: "Incorrect username or password",
    auth_staff_username_label: "USERNAME",
    auth_staff_username_placeholder: "e.g. teacher_auto or admin",
    auth_staff_password_label: "PASSWORD",
    auth_staff_submit: "Sign In as Staff"
  }
};

function getAppLanguage() {
  return localStorage.getItem('onepass_lang') || 'th';
}

function setAppLanguage(lang) {
  const currentLang = lang === 'en' ? 'en' : 'th';
  localStorage.setItem('onepass_lang', currentLang);
  applyAppLanguage(currentLang);
}

function applyAppLanguage(lang) {
  const dict = I18N_DICTIONARY[lang] || I18N_DICTIONARY.th;
  
  // 1. Translate all [data-i18n] elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      el.textContent = dict[key];
    }
  });

  // 1.1 Translate placeholder text ([data-i18n-placeholder])
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key]) {
      el.setAttribute('placeholder', dict[key]);
    }
  });

  // 2. Translate bottom nav items
  const homeNavSpan = document.querySelector('#bottom-nav-home span');
  if (homeNavSpan) homeNavSpan.textContent = dict.nav_home;

  const historyNavSpan = document.querySelector('#bottom-nav-history span');
  if (historyNavSpan) {
    const user = getCurrentUser();
    const isStaff = user && (user.role === 'teacher' || user.role === 'head_dept' || user.role === 'discipline_head' || user.role === 'deputy' || user.role === 'director' || user.role === 'admin' || user.role === 'staff' || user.role === 'security');
    historyNavSpan.textContent = isStaff ? dict.nav_approval : dict.nav_history;
  }

  const statsNavSpan = document.querySelector('#bottom-nav-stats span');
  if (statsNavSpan) statsNavSpan.textContent = dict.nav_stats;

  const profileNavSpan = document.querySelector('#bottom-nav-profile span');
  if (profileNavSpan) profileNavSpan.textContent = dict.nav_profile;

  const adminNavSpan = document.querySelector('#bottom-nav-admin span');
  if (adminNavSpan) adminNavSpan.textContent = dict.nav_admin;

  // 3. Re-render dynamic cards if rendered
  if (typeof renderHomeStatusCard === 'function') {
    try { renderHomeStatusCard(); } catch (e) {}
  }

  syncSettingsModalUI();
}

function initAppLanguage() {
  const savedLang = getAppLanguage();
  applyAppLanguage(savedLang);
}

// 5. Sync Settings Modal UI state (active buttons & badges)
function syncSettingsModalUI() {
  const theme = getAppTheme();
  const lang = getAppLanguage();

  // Theme buttons
  const btnThemeLight = document.getElementById('btn-theme-light');
  const btnThemeDark = document.getElementById('btn-theme-dark');
  const themeBadge = document.getElementById('settings-theme-current-badge');

  if (btnThemeLight && btnThemeDark) {
    if (theme === 'dark') {
      btnThemeDark.className = 'py-2.5 px-3 rounded-xl border-2 border-indigo-500 bg-indigo-950/60 text-indigo-300 font-bold flex items-center justify-center gap-2 transition shadow-xs';
      btnThemeLight.className = 'py-2.5 px-3 rounded-xl border border-slate-700 bg-slate-800 text-slate-400 font-bold flex items-center justify-center gap-2 transition hover:bg-slate-700';
      if (themeBadge) {
        themeBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-700';
        themeBadge.textContent = lang === 'en' ? 'Dark Mode' : 'โหมดมืด (Dark)';
      }
    } else {
      btnThemeLight.className = 'py-2.5 px-3 rounded-xl border-2 border-blue-600 bg-white text-blue-700 font-bold flex items-center justify-center gap-2 transition shadow-xs';
      btnThemeDark.className = 'py-2.5 px-3 rounded-xl border border-slate-300 bg-slate-100 text-slate-700 font-bold flex items-center justify-center gap-2 transition hover:bg-slate-200';
      if (themeBadge) {
        themeBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200';
        themeBadge.textContent = lang === 'en' ? 'Light Mode' : 'โหมดสว่าง (Light)';
      }
    }
  }

  // Language buttons
  const btnLangTh = document.getElementById('btn-lang-th');
  const btnLangEn = document.getElementById('btn-lang-en');
  const langBadge = document.getElementById('settings-lang-current-badge');

  if (btnLangTh && btnLangEn) {
    if (lang === 'en') {
      btnLangEn.className = 'py-2.5 px-3 rounded-xl border-2 border-blue-600 bg-white dark:bg-slate-800 text-blue-700 dark:text-blue-300 font-bold flex items-center justify-center gap-2 transition shadow-xs';
      btnLangTh.className = 'py-2.5 px-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-400 font-bold flex items-center justify-center gap-2 transition hover:bg-slate-200';
      if (langBadge) {
        langBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200';
        langBadge.textContent = 'English 🇬🇧';
      }
    } else {
      btnLangTh.className = 'py-2.5 px-3 rounded-xl border-2 border-blue-600 bg-white dark:bg-slate-800 text-blue-700 dark:text-blue-300 font-bold flex items-center justify-center gap-2 transition shadow-xs';
      btnLangEn.className = 'py-2.5 px-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-400 font-bold flex items-center justify-center gap-2 transition hover:bg-slate-200';
      if (langBadge) {
        langBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
        langBadge.textContent = 'ภาษาไทย 🇹🇭';
      }
    }
  }

  // ปุ่มสลับภาษาด่วนที่หน้า Login/Welcome
  const authBtnLangTh = document.getElementById('auth-btn-lang-th');
  const authBtnLangEn = document.getElementById('auth-btn-lang-en');
  if (authBtnLangTh && authBtnLangEn) {
    if (lang === 'en') {
      authBtnLangEn.className = 'px-3 py-1.5 rounded-full text-xs font-bold transition bg-white text-blue-700';
      authBtnLangTh.className = 'px-3 py-1.5 rounded-full text-xs font-bold transition text-white/70 hover:text-white';
    } else {
      authBtnLangTh.className = 'px-3 py-1.5 rounded-full text-xs font-bold transition bg-white text-blue-700';
      authBtnLangEn.className = 'px-3 py-1.5 rounded-full text-xs font-bold transition text-white/70 hover:text-white';
    }
  }
}

// Expose Settings functions globally for inline onclick handlers
window.setAppTheme = setAppTheme;
window.setAppLanguage = setAppLanguage;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.triggerPwaInstall = triggerPwaInstall;

window.setAuthView = setAuthView;


// ============================================================================
// STUDENT DEVICE LOGIN, ONBOARDING & ROSTER IMPORT LOGIC (FRONTEND)
// ============================================================================

let currentPreviewRows = [];
let currentImportFileName = '';
let pendingUnrecogCode = '';
let currentOnboardUser = null;
let currentOnboardPhotoBase64 = null;
let currentLoginRole = 'student';

function getOrCreateDeviceId() {
  let devId = localStorage.getItem('onepass_device_id');
  if (!devId) {
    devId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('onepass_device_id', devId);
  }
  return devId;
}

function getDeviceName() {
  const ua = navigator.userAgent;
  let dev = 'เบราว์เซอร์ไม่ทราบชื่อ';
  if (/iPad|iPhone|iPod/.test(ua)) dev = 'Apple iOS (iPhone/iPad)';
  else if (/Android/.test(ua)) dev = 'Android Device';
  else if (/Windows/.test(ua)) dev = 'Windows PC';
  else if (/Macintosh/.test(ua)) dev = 'Mac Computer';
  else if (/Linux/.test(ua)) dev = 'Linux PC';
  return dev;
}

function switchLoginRoleTab(role) {
  currentLoginRole = role;
  const tabStudent = document.getElementById('tab-auth-student');
  const tabStaff = document.getElementById('tab-auth-staff');
  const secStudent = document.getElementById('section-login-student');
  const secStaff = document.getElementById('section-login-staff');

  if (role === 'student') {
    if (tabStudent) {
      tabStudent.className = 'py-2.5 rounded-xl font-bold text-xs transition flex items-center justify-center gap-2 bg-[#2563eb] text-white shadow-md';
    }
    if (tabStaff) {
      tabStaff.className = 'py-2.5 rounded-xl font-medium text-xs text-slate-400 hover:text-white transition flex items-center justify-center gap-2';
    }
    if (secStudent) secStudent.classList.remove('hidden');
    if (secStaff) secStaff.classList.add('hidden');
  } else {
    if (tabStudent) {
      tabStudent.className = 'py-2.5 rounded-xl font-medium text-xs text-slate-400 hover:text-white transition flex items-center justify-center gap-2';
    }
    if (tabStaff) {
      tabStaff.className = 'py-2.5 rounded-xl font-bold text-xs transition flex items-center justify-center gap-2 bg-[#2563eb] text-white shadow-md';
    }
    if (secStudent) secStudent.classList.add('hidden');
    if (secStaff) secStaff.classList.remove('hidden');
  }
}

function fillStudentCode(code) {
  const inp = document.getElementById('login-student-code');
  if (inp) inp.value = code;
}

// 1. เข้าสู่ระบบของนักเรียนด้วยรหัสนักศึกษาอย่างเดียว
async function handleStudentLogin(e) {
  if (e) e.preventDefault();
  requestAppFullscreen();
  const codeInput = document.getElementById('login-student-code');
  const errBox = document.getElementById('student-login-error');
  const errMsg = document.getElementById('student-login-error-msg');
  const btnSubmit = document.getElementById('btn-student-login');

  if (errBox) errBox.classList.add('hidden');
  const studentCode = codeInput ? codeInput.value.trim() : '';

  if (!studentCode) {
    if (errBox && errMsg) {
      errMsg.textContent = 'กรุณากรอกรหัสนักศึกษา 11 หลัก';
      errBox.classList.remove('hidden');
    }
    return;
  }

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบสิทธิ์...';
  }

  try {
    const res = await fetch('/api/auth/student-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentCode,
        deviceId: getOrCreateDeviceId(),
        deviceName: getDeviceName()
      })
    });

    const data = await res.json();

    // ตรวจสอบความถูกต้องของการเข้าสู่ระบบ
    if (!res.ok || !data.success) {
      if (errBox && errMsg) {
        errMsg.textContent = data.message || 'รหัสนักศึกษาไม่ถูกต้อง หรือไม่พบบัญชีในระบบ กรุณาติดต่อครูที่ปรึกษาหรือฝ่ายทะเบียน';
        errBox.classList.remove('hidden');
      }
      return;
    }

    // Direct Login สำเร็จ -> บันทึก Token และเข้าสู่ระบบทันที (ไม่ต้องติดหน้าตรวจพบอุปกรณ์ใหม่)

    // เข้าสู่ระบบสำเร็จ
    if (data.token) localStorage.setItem('onepass_auth_token', data.token);
    localStorage.setItem('onepass_logged_in', 'true');
    localStorage.setItem('onepass_current_user', JSON.stringify(data.user));
    localStorage.setItem('onepass_user', JSON.stringify(data.user));

    if (data.need_onboarding) {
      openOnboardingScreen(data.user);
    } else {
      applyCurrentUserUI(data.user);
      checkAuth();
    }
  } catch (err) {
    if (errBox && errMsg) {
      errMsg.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
      errBox.classList.remove('hidden');
    }
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> <span>เข้าสู่ระบบ OnePass</span>';
    }
  }
}

// 2. จัดการ Modal อุปกรณ์ใหม่ & ยืนยัน OTP
function openUnrecognizedDeviceModal(data) {
  const modal = document.getElementById('modal-unrecognized-device');
  const advEl = document.getElementById('unrecog-advisor-name');
  const otpSec = document.getElementById('unrecog-otp-section');
  const otpInp = document.getElementById('device-otp-input');

  if (advEl) advEl.textContent = data.advisor_name || 'ครูที่ปรึกษา';
  if (otpSec) {
    if (data.has_telegram) otpSec.classList.remove('hidden');
    else otpSec.classList.add('hidden');
  }
  if (otpInp) otpInp.value = '';
  if (modal) modal.classList.remove('hidden');
}

function closeUnrecognizedDeviceModal() {
  const modal = document.getElementById('modal-unrecognized-device');
  if (modal) modal.classList.add('hidden');
}

async function handleVerifyDeviceOtp() {
  const otpInp = document.getElementById('device-otp-input');
  const otp = otpInp ? otpInp.value.trim() : '';
  if (!otp || otp.length < 4) {
    alert('กรุณากรอกรหัส OTP ที่ได้รับจาก Telegram');
    return;
  }

  try {
    const res = await fetch('/api/auth/verify-device-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentCode: pendingUnrecogCode,
        otp,
        deviceId: getOrCreateDeviceId(),
        deviceName: getDeviceName()
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || 'รหัส OTP ไม่ถูกต้องหรือหมดอายุ');
      return;
    }

    alert('🎉 ' + data.message);
    closeUnrecognizedDeviceModal();

    if (data.token) localStorage.setItem('onepass_auth_token', data.token);
    localStorage.setItem('onepass_logged_in', 'true');
    localStorage.setItem('onepass_current_user', JSON.stringify(data.user));
    localStorage.setItem('onepass_user', JSON.stringify(data.user));

    if (data.need_onboarding) {
      openOnboardingScreen(data.user);
    } else {
      applyCurrentUserUI(data.user);
      checkAuth();
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการตรวจสอบ OTP: ' + err.message);
  }
}

// 3. จัดการ Onboarding Screen สำหรับนักเรียนเข้าใช้งานครั้งแรก
function openOnboardingScreen(user) {
  currentOnboardUser = user;
  const screenAuth = document.getElementById('screen-auth');
  const screenOnboard = document.getElementById('screen-onboarding');
  const appShell = document.getElementById('app-shell');

  if (screenAuth) screenAuth.classList.add('hidden');
  if (appShell) appShell.classList.add('hidden');
  if (screenOnboard) screenOnboard.classList.remove('hidden');

  const codeEl = document.getElementById('onboard-student-code');
  const nameEl = document.getElementById('onboard-full-name');
  const deptEl = document.getElementById('onboard-dept');
  const classEl = document.getElementById('onboard-classroom');
  const advEl = document.getElementById('onboard-advisor');

  if (codeEl) codeEl.textContent = user.student_code || user.username || '-';
  if (nameEl) nameEl.textContent = user.full_name || '-';
  if (deptEl) deptEl.textContent = user.dept || user.departments?.name || '-';
  if (classEl) classEl.textContent = user.classroom || user.classrooms?.name || '-';
  if (advEl) advEl.textContent = user.advisor_name || user.advisor || '-';

  const plateInp = document.getElementById('onboard-vehicle-plate');
  const phoneInp = document.getElementById('onboard-phone');
  if (plateInp) plateInp.value = user.plate_no || user.vehicle_plate || '';
  if (phoneInp) phoneInp.value = user.phone || user.phone_number || '';
}

async function handleOnboardPhotoChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const compressed = await compressImageFile(file, 1280, 0.8);
    currentOnboardPhotoBase64 = compressed;

    const previewImg = document.getElementById('onboard-photo-preview');
    const previewWrap = document.getElementById('onboard-photo-preview-wrap');
    const placeholder = document.getElementById('onboard-photo-placeholder');

    if (previewImg) previewImg.src = compressed;
    if (previewWrap) previewWrap.classList.remove('hidden');
    if (placeholder) placeholder.classList.add('hidden');
  } catch (err) {
    alert('บีบอัดรูปภาพไม่สำเร็จ: ' + err.message);
  }
}

async function compressImageFile(file, maxWidth = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

async function handleOnboardingSubmit(e) {
  if (e) e.preventDefault();
  const plateInp = document.getElementById('onboard-vehicle-plate');
  const phoneInp = document.getElementById('onboard-phone');
  const btnSubmit = document.getElementById('btn-submit-onboard');

  const vehiclePlate = plateInp ? plateInp.value.trim() : '';
  const phone = phoneInp ? phoneInp.value.trim() : '';

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';
  }

  try {
    const token = getAuthToken();
    const res = await fetch('/api/student/onboarding', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        vehiclePlate,
        phone,
        vehiclePhoto: currentOnboardPhotoBase64
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.message || 'บันทึกข้อมูลไม่สำเร็จ');
      return;
    }

    alert('🎉 บันทึกข้อมูลสำเร็จ ยินดีต้อนรับเข้าสู่ระบบ OnePass');
    const screenOnboard = document.getElementById('screen-onboarding');
    if (screenOnboard) screenOnboard.classList.add('hidden');

    const updatedUser = { ...getCurrentUser(), ...(data.user || {}), onboarding_completed: true };
    localStorage.setItem('onepass_current_user', JSON.stringify(updatedUser));
    localStorage.setItem('onepass_user', JSON.stringify(updatedUser));
    applyCurrentUserUI(updatedUser);
    checkAuth();
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการบันทึกข้อมูล: ' + err.message);
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<i class="fa-solid fa-check-circle"></i> <span>บันทึกข้อมูลและเริ่มใช้งาน</span>';
    }
  }
}

// 4. จัดการอุปกรณ์ของนักเรียนสำหรับครู/แอดมิน (Device Approvals & Reset)
async function fetchPendingDeviceRequests() {
  const container = document.getElementById('admin-devices-pending-list');
  if (!container) return;
  container.innerHTML = '<p class="text-slate-400 italic py-2"><i class="fa-solid fa-spinner fa-spin mr-1"></i> กำลังดึงรายการคำขออุปกรณ์...</p>';

  try {
    const token = getAuthToken();
    const res = await fetch('/api/admin/devices/pending', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      container.innerHTML = `<p class="text-rose-500 py-2">${data.message || 'โหลดข้อมูลไม่สำเร็จ'}</p>`;
      return;
    }

    const list = data.requests || [];
    if (list.length === 0) {
      container.innerHTML = '<div class="p-4 rounded-2xl bg-emerald-50 text-emerald-700 text-center font-medium"><i class="fa-solid fa-check-circle mr-1"></i> ไม่มีคำขออนุมัติอุปกรณ์ที่รอดำเนินการ</div>';
      return;
    }

    container.innerHTML = '';
    list.forEach(req => {
      const item = document.createElement('div');
      item.className = 'p-3 rounded-2xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5';
      item.innerHTML = `
        <div class="space-y-0.5">
          <div class="flex items-center gap-2">
            <span class="font-bold text-slate-800">${req.student_name || req.student_code}</span>
            <span class="font-mono text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-bold">${req.student_code}</span>
          </div>
          <p class="text-[11px] text-slate-500">
            <i class="fa-solid fa-mobile-screen mr-1"></i> ${req.device_name || 'อุปกรณ์ใหม่'} • IP: ${req.ip_address || '-'}
          </p>
          <p class="text-[10px] text-slate-400">
            ขอเมื่อ: ${new Date(req.created_at).toLocaleString('th-TH')}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" onclick="approveDeviceRequest('${req.id}')" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1">
            <i class="fa-solid fa-check"></i> อนุมัติเครื่องนี้
          </button>
          <button type="button" onclick="rejectDeviceRequest('${req.id}')" class="px-3 py-1.5 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs transition">
            ปฏิเสธ
          </button>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    container.innerHTML = `<p class="text-rose-500 py-2">เกิดข้อผิดพลาด: ${err.message}</p>`;
  }
}

async function approveDeviceRequest(id) {
  if (!confirm('ยืนยันอนุมัติให้อุปกรณ์นี้ใช้งานได้?')) return;
  try {
    const token = getAuthToken();
    const res = await fetch(`/api/admin/devices/${id}/approve`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    alert(data.message || (data.success ? 'อนุมัติเรียบร้อยแล้ว' : 'เกิดข้อผิดพลาด'));
    fetchPendingDeviceRequests();
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  }
}

async function rejectDeviceRequest(id) {
  if (!confirm('ยืนยันปฏิเสธคำขอนี้?')) return;
  try {
    const token = getAuthToken();
    const res = await fetch(`/api/admin/devices/${id}/reject`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    alert(data.message || 'ปฏิเสธเรียบร้อย');
    fetchPendingDeviceRequests();
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  }
}

async function handleAdminResetDevice() {
  const inp = document.getElementById('admin-reset-device-student-code');
  const code = inp ? inp.value.trim() : '';
  if (!code) {
    alert('กรุณากรอกรหัสนักศึกษาที่ต้องการปลดล็อก');
    return;
  }
  if (!confirm(`ยืนยันการปลดล็อก/รีเซ็ตอุปกรณ์ที่ผูกไว้ของรหัส ${code} หรือไม่? (นักเรียนจะสามารถเข้าด้วยเครื่องใหม่และผูกเครื่องได้ทันที)`)) {
    return;
  }

  try {
    const token = getAuthToken();
    const res = await fetch('/api/admin/devices/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ studentCode: code })
    });
    const data = await res.json();
    alert(data.message || (data.success ? 'รีเซ็ตสำเร็จ' : 'เกิดข้อผิดพลาด'));
    if (inp) inp.value = '';
    fetchPendingDeviceRequests();
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  }
}

// 5. ฝั่งแอดมิน: เลือกไฟล์ Excel/CSV และแสดงตารางพรีวิว
function handleRosterFileSelect(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  currentImportFileName = file.name;
  const reader = new FileReader();

  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      if (typeof XLSX === 'undefined') {
        alert('ไลบรารีอ่านไฟล์ Excel ยังไม่พร้อมใช้งาน กรุณารีเฟรชหน้าเว็บ');
        return;
      }

      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (!jsonRows || jsonRows.length === 0) {
        alert('ไม่พบข้อมูลในไฟล์ที่เลือก');
        return;
      }

      // ส่งให้ Backend ตรวจสอบ Preview
      const token = getAuthToken();
      const res = await fetch('/api/admin/students/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ students: jsonRows, commit: false })
      });

      const resData = await res.json();
      if (!res.ok || !resData.success) {
        alert('ตรวจสอบไฟล์ไม่สำเร็จ: ' + (resData.message || 'เกิดข้อผิดพลาด'));
        return;
      }

      currentPreviewRows = jsonRows;
      renderImportPreviewTable(resData);
    } catch (err) {
      alert('เกิดข้อผิดพลาดในการอ่านไฟล์: ' + err.message);
    }
  };

  reader.readAsArrayBuffer(file);
}

// 6. แสดงผลตาราง Preview ในหน้า Admin
function renderImportPreviewTable(previewData) {
  const container = document.getElementById('import-preview-container');
  const tbody = document.getElementById('import-preview-tbody');
  const totalCountEl = document.getElementById('preview-total-count');
  const validCountEl = document.getElementById('preview-valid-count');
  const errorCountEl = document.getElementById('preview-error-count');

  if (!container || !tbody) return;

  if (totalCountEl) totalCountEl.textContent = previewData.total || 0;
  if (validCountEl) validCountEl.textContent = previewData.validCount || 0;
  if (errorCountEl) errorCountEl.textContent = previewData.invalidCount || 0;

  tbody.innerHTML = '';
  const samples = previewData.sample || [];
  const errors = previewData.errors || [];
  const errMap = {};
  errors.forEach(e => {
    if (e.row) errMap[e.row] = e.message;
    if (e.studentCode) errMap[e.studentCode] = e.message;
  });

  samples.forEach((r, idx) => {
    const rowNum = idx + 1;
    const tr = document.createElement('tr');
    const hasErr = !!(errMap[rowNum] || errMap[r.student_code]);
    tr.className = hasErr ? 'bg-rose-50/70' : 'hover:bg-slate-50';

    let statusBadge = hasErr
      ? `<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-[10px] font-bold">❌ ${errMap[rowNum] || errMap[r.student_code]}</span>`
      : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">พร้อมนำเข้า</span>';

    tr.innerHTML = `
      <td class="p-2.5 font-bold">${rowNum}</td>
      <td class="p-2.5 font-mono font-bold text-blue-600">${r.student_code || '-'}</td>
      <td class="p-2.5 font-semibold text-slate-800">${r.full_name || '-'}</td>
      <td class="p-2.5">${r.dept || '-'}</td>
      <td class="p-2.5"><span class="px-2 py-0.5 rounded-md bg-slate-100 font-bold">${r.classroom || '-'}</span></td>
      <td class="p-2.5 text-slate-600">${r.advisor_name || r.advisor_username || '-'}</td>
      <td class="p-2.5">${statusBadge}</td>
    `;
    tbody.appendChild(tr);
  });

  container.classList.remove('hidden');
}

// 7. แอดมินกดยืนยันบันทึกรายชื่อลงระบบจริง
async function commitRosterImport() {
  if (!currentPreviewRows || currentPreviewRows.length === 0) {
    alert('ไม่มีข้อมูลที่พร้อมบันทึก');
    return;
  }

  if (!confirm(`ยืนยันการนำเข้ารายชื่อนักเรียนจำนวน ${currentPreviewRows.length} รายการลงระบบจริง?`)) {
    return;
  }

  const btnCommit = document.getElementById('btn-commit-import');
  if (btnCommit) {
    btnCommit.disabled = true;
    btnCommit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';
  }

  try {
    const token = getAuthToken();
    const res = await fetch('/api/admin/students/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ students: currentPreviewRows, commit: true })
    });

    const resData = await res.json();
    if (!res.ok || !resData.success) {
      alert('บันทึกข้อมูลไม่สำเร็จ: ' + (resData.message || 'เกิดข้อผิดพลาด'));
      return;
    }

    alert('✅ ' + resData.message);
    currentPreviewRows = [];
    const container = document.getElementById('import-preview-container');
    if (container) container.classList.add('hidden');
    fetchAdminImportLogs();
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการบันทึกข้อมูล: ' + err.message);
  } finally {
    if (btnCommit) {
      btnCommit.disabled = false;
      btnCommit.innerHTML = '<i class="fa-solid fa-check"></i> บันทึกลงระบบจริง';
    }
  }
}

// Expose globals for HTML inline events
window.switchLoginRoleTab = switchLoginRoleTab;
window.fillStudentCode = fillStudentCode;
window.handleStudentLogin = handleStudentLogin;
window.handleVerifyDeviceOtp = handleVerifyDeviceOtp;
window.closeUnrecognizedDeviceModal = closeUnrecognizedDeviceModal;
window.openOnboardingScreen = openOnboardingScreen;
window.handleOnboardingSubmit = handleOnboardingSubmit;
window.handleOnboardPhotoChange = handleOnboardPhotoChange;
window.fetchPendingDeviceRequests = fetchPendingDeviceRequests;
window.approveDeviceRequest = approveDeviceRequest;
window.rejectDeviceRequest = rejectDeviceRequest;
window.handleAdminResetDevice = handleAdminResetDevice;
window.handleRosterFileSelect = handleRosterFileSelect;
window.commitRosterImport = commitRosterImport;

// 6. ดึงรายการ Audit Logs การนำเข้าไฟล์ล่าสุด
async function fetchAdminImportLogs() {
  const container = document.getElementById('import-logs-list');
  if (!container) return;

  try {
    const token = getAuthToken();
    const res = await fetch('/api/admin/import-logs', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data && data.success && Array.isArray(data.logs)) {
      if (data.logs.length === 0) {
        container.innerHTML = '<p class="text-slate-400 italic">ยังไม่มีประวัติการนำเข้าไฟล์</p>';
        return;
      }
      container.innerHTML = data.logs.map(l => {
        const time = new Date(l.imported_at).toLocaleString('th-TH', { hour12: false });
        return `
          <div class="flex items-center justify-between p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div>
              <span class="font-bold text-slate-700 dark:text-slate-200">${l.file_name}</span>
              <span class="text-[10px] text-slate-400 ml-2">${time} (โดย ${l.admin_username})</span>
            </div>
            <div class="flex items-center gap-2 text-[10px] font-bold">
              <span class="text-emerald-600">สำเร็จ: ${l.success_rows}</span>
              <span class="text-amber-600">อัปเดต: ${l.updated_rows}</span>
              <span class="text-rose-600">ข้าม: ${l.failed_rows}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.warn('fetchAdminImportLogs err:', err);
  }
}

// Expose globally
window.handleActivationStep1 = handleActivationStep1;
window.handleActivationStep2 = handleActivationStep2;
window.handleRosterFileSelect = handleRosterFileSelect;
window.commitRosterImport = commitRosterImport;
window.setAdminRoleFilter = setAdminRoleFilter;
window.filterAdminUsers = filterAdminUsers;
window.fetchAdminImportLogs = fetchAdminImportLogs;
window.fetchAndApplySchoolSettings = fetchAndApplySchoolSettings;
window.applySchoolSettingsUI = applySchoolSettingsUI;
window.format24HourInput = format24HourInput;
window.validate24HourInput = validate24HourInput;
window.handleAdminAddUserRoleChange = handleAdminAddUserRoleChange;
window.handleAdminResetDeviceFromCard = handleAdminResetDeviceFromCard;
window.handleAdminCreateUser = handleAdminCreateUser;
window.openAddUserModal = openAddUserModal;
window.closeAddUserModal = closeAddUserModal;
// ============================================================================
// TELEGRAM BOT FRONTEND CLIENT MODULE
// ============================================================================

var telegramPollTimer = null;
var telegramCountdownTimer = null;
var currentTelegramToken = null;
var currentTelegramStatus = { connected: false };

async function initTelegramModule() {
  const user = getCurrentUser();
  if (!user) return;
  await fetchTelegramStatus();
  updateHomeTelegramBanner(user);
}

async function fetchTelegramStatus() {
  const user = getCurrentUser();
  if (!user) return;

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/telegram/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    currentTelegramStatus = data;
    renderTelegramProfileCard(data, user);
    updateHomeTelegramBanner(user);
  } catch (err) {
    console.warn('⚠️ Fetch telegram status error:', err);
  }
}

function renderTelegramProfileCard(data, user) {
  const statusBadge = document.getElementById('prof-telegram-status-badge');
  const notConnectedView = document.getElementById('prof-telegram-not-connected');
  const connectedView = document.getElementById('prof-telegram-connected');
  const usernameLabel = document.getElementById('prof-telegram-username');
  const adminRow = document.getElementById('tg-pref-admin-row');

  if (!statusBadge) return;

  if (adminRow) {
    if (user && user.role === 'admin') adminRow.classList.remove('hidden');
    else adminRow.classList.add('hidden');
  }

  if (data && data.connected) {
    statusBadge.innerHTML = `
      <span class="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold flex items-center gap-1.5 shadow-2xs">
        <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> เชื่อมต่อแล้ว
      </span>
    `;
    if (notConnectedView) notConnectedView.classList.add('hidden');
    if (connectedView) connectedView.classList.remove('hidden');
    if (usernameLabel) usernameLabel.textContent = data.username ? data.username : `Chat ID: ${data.chatId}`;

    // Populate toggles
    const s = data.settings || {};
    if (document.getElementById('tg-pref-pending')) document.getElementById('tg-pref-pending').checked = (s.pending_approval !== false);
    if (document.getElementById('tg-pref-result')) document.getElementById('tg-pref-result').checked = (s.request_result !== false);
    if (document.getElementById('tg-pref-qr')) document.getElementById('tg-pref-qr').checked = (s.qr_ready !== false);
    if (document.getElementById('tg-pref-scan')) document.getElementById('tg-pref-scan').checked = (s.parent_scan !== false);
    if (document.getElementById('tg-pref-admin')) document.getElementById('tg-pref-admin').checked = (s.gate_alert !== false);
  } else {
    statusBadge.innerHTML = `
      <span class="px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 text-xs font-semibold">
        <i class="fa-solid fa-circle text-[8px] mr-1 text-slate-400"></i> ยังไม่ได้เชื่อมต่อ
      </span>
    `;
    if (notConnectedView) notConnectedView.classList.remove('hidden');
    if (connectedView) connectedView.classList.add('hidden');
  }
}

function updateHomeTelegramBanner(user) {
  const banner = document.getElementById('home-telegram-banner');
  if (!banner) return;

  const isDismissed = sessionStorage.getItem('tg_banner_dismissed') === 'true';
  if (!user || currentTelegramStatus.connected || isDismissed) {
    banner.classList.add('hidden');
    return;
  }

  const isTeacher = user.role === 'teacher' || user.role === 'subject_teacher' || user.role === 'advisor' || user.role === 'head_dept' || user.role === 'discipline_head' || user.role === 'deputy' || user.role === 'director';
  const titleEl = document.getElementById('home-telegram-banner-title');
  const descEl = document.getElementById('home-telegram-banner-desc');

  if (isTeacher) {
    if (titleEl) titleEl.textContent = '🔔 แจ้งเตือนด่วน: ท่านยังไม่ได้เชื่อมต่อ Telegram';
    if (descEl) descEl.textContent = 'เชื่อมต่อเพื่อรับการแจ้งเตือนทันทีเมื่อมีคำร้องใหม่รอการอนุมัติ ตัดสินใจได้รวดเร็วผ่านมือถือ';
  } else {
    if (titleEl) titleEl.textContent = '📲 เชื่อมต่อ Telegram แจ้งเตือนคำร้อง';
    if (descEl) descEl.textContent = 'รับผลการอนุมัติคำร้องและเปิดบัตรผ่านดิจิทัล (QR Pass) ได้สะดวกรวดเร็วบนมือถือ';
  }

  banner.classList.remove('hidden');
}

function dismissHomeTelegramBanner() {
  sessionStorage.setItem('tg_banner_dismissed', 'true');
  const banner = document.getElementById('home-telegram-banner');
  if (banner) banner.classList.add('hidden');
}

async function openTelegramConnectModal() {
  const modal = document.getElementById('modal-telegram-connect');
  if (!modal) return;

  modal.classList.remove('hidden');
  const qrContainer = document.getElementById('telegram-qr-code');
  if (qrContainer) qrContainer.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-2xl text-sky-500"></i>';

  const codeBox = document.getElementById('telegram-pairing-code');
  if (codeBox) codeBox.textContent = '------';

  const linkBtn = document.getElementById('btn-open-telegram-link');
  if (linkBtn) {
    linkBtn.href = '#';
    const textSpan = document.getElementById('btn-open-telegram-text');
    if (textSpan) textSpan.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> กำลังเตรียมลิงก์...';
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/telegram/generate-link', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.success) {
      currentTelegramToken = data.token;
      window.currentTelegramToken = data.token;
      window.currentTelegramLink = data.link;
      window.currentTelegramNativeLink = data.nativeLink;
      window.currentTelegramShortCode = data.shortCode;

      // Update 6-digit code box
      if (codeBox) codeBox.textContent = data.shortCode || '------';
      
      // Update deep-link button
      if (linkBtn) {
        linkBtn.href = data.link;
        const textSpan = document.getElementById('btn-open-telegram-text');
        if (textSpan) textSpan.textContent = '🚀 เปิดแอป Telegram เพื่อเชื่อมต่อทันที';
      }

      // Render QR Code
      if (qrContainer && typeof QRCode !== 'undefined') {
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, {
          text: data.link,
          width: 150,
          height: 150,
          colorDark: "#0284c7",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      }

      // Start 10-minute timer
      startTelegramCountdown(new Date(data.expiresAt));

      // Start real-time polling to auto-close upon successful pairing
      startTelegramPairingPoll();
    } else {
      alert('ไม่สามารถสร้างรหัสเชื่อมต่อได้: ' + (data.message || ''));
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + err.message);
  }
}

function handleOpenTelegramApp(event) {
  if (event) event.preventDefault();
  const link = window.currentTelegramLink;
  const nativeLink = window.currentTelegramNativeLink;
  if (!link) {
    alert('กำลังสร้างรหัสเชื่อมต่อ กรุณารอสักครู่ครับ');
    return;
  }

  // พยายามเปิดผ่าน Protocol tg:// ก่อน ถ้าไม่เปิดให้ fallback ไปที่ https://t.me
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile && nativeLink) {
    window.location.href = nativeLink;
    setTimeout(() => {
      window.open(link, '_blank');
    }, 1500);
  } else {
    window.open(link, '_blank');
  }
}

function copyTelegramPairingCode() {
  const code = window.currentTelegramShortCode;
  const label = document.getElementById('btn-copy-code-label');
  if (!code) {
    alert('ยังไม่มีรหัสเชื่อมต่อ');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => {
      if (label) {
        label.textContent = 'คัดลอกแล้ว! ✓';
        setTimeout(() => { label.textContent = 'คัดลอก'; }, 2000);
      }
    }).catch(() => {
      prompt('คัดลอกรหัส 6 หลักนี้:', code);
    });
  } else {
    prompt('คัดลอกรหัส 6 หลักนี้:', code);
  }
}

async function connectTelegramByChatId() {
  const input = document.getElementById('input-manual-telegram-chat-id');
  const btn = document.getElementById('btn-submit-manual-chat-id');
  if (!input || !input.value.trim()) {
    alert('กรุณากรอก Chat ID ให้ถูกต้อง (ดูได้จากการทักบอท @onepass_student_bot)');
    return;
  }
  const chatId = input.value.trim();
  const origBtnText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> เชื่อมต่อ...';
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/telegram/manual-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ chatId })
    });
    const data = await res.json();
    if (data.success) {
      alert('🎉 เชื่อมต่อบัญชี Telegram สำเร็จเรียบร้อยแล้ว!\nระบบได้ส่งข้อความยืนยันเข้า Telegram ของคุณแล้ว');
      closeTelegramConnectModal();
      fetchTelegramStatus();
    } else {
      alert('⚠️ เกิดข้อผิดพลาด: ' + (data.message || 'ไม่สามารถเชื่อมต่อได้'));
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origBtnText;
    }
  }
}

function closeTelegramConnectModal() {
  const modal = document.getElementById('modal-telegram-connect');
  if (modal) modal.classList.add('hidden');
  stopTelegramTimers();
}

function startTelegramCountdown(expiresAtDate) {
  clearInterval(telegramCountdownTimer);
  const timerLabel = document.getElementById('telegram-timer-label');

  telegramCountdownTimer = setInterval(() => {
    const remainSec = Math.max(0, Math.floor((expiresAtDate.getTime() - Date.now()) / 1000));
    if (timerLabel) {
      const mins = String(Math.floor(remainSec / 60)).padStart(2, '0');
      const secs = String(remainSec % 60).padStart(2, '0');
      timerLabel.textContent = `${mins}:${secs}`;
    }

    if (remainSec <= 0) {
      clearInterval(telegramCountdownTimer);
      if (timerLabel) timerLabel.textContent = 'หมดอายุแล้ว';
      alert('⚠️ รหัสเชื่อมต่อหมดอายุแล้ว (เกิน 10 นาที) กรุณากดขอรหัสใหม่อีกครั้ง');
      closeTelegramConnectModal();
    }
  }, 1000);
}

function startTelegramPairingPoll() {
  clearInterval(telegramPollTimer);
  telegramPollTimer = setInterval(async () => {
    try {
      const token = await ensureAuthToken();
      const res = await fetch('/api/telegram/status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data && data.connected) {
        stopTelegramTimers();
        const statusBox = document.getElementById('telegram-waiting-status');
        if (statusBox) {
          statusBox.className = 'py-3 px-4 rounded-xl bg-emerald-50 text-emerald-700 text-xs font-bold flex items-center justify-center gap-2 border border-emerald-200';
          statusBox.innerHTML = '<i class="fa-solid fa-circle-check text-base text-emerald-600"></i> เชื่อมต่อสำเร็จเรียบร้อยแล้ว!';
        }
        setTimeout(() => {
          closeTelegramConnectModal();
          fetchTelegramStatus();
        }, 1200);
      }
    } catch (e) {}
  }, 2000);
}

function stopTelegramTimers() {
  clearInterval(telegramCountdownTimer);
  clearInterval(telegramPollTimer);
}

async function disconnectTelegramAccount() {
  if (!confirm('คุณต้องการยกเลิกการเชื่อมต่อ Telegram ใช่หรือไม่?\n(หลังจากยกเลิก จะไม่ได้รับแจ้งเตือนผ่าน Telegram อีกต่อไป)')) {
    return;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/telegram/disconnect', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ ยกเลิกการเชื่อมต่อ Telegram เรียบร้อยแล้ว');
      fetchTelegramStatus();
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function saveTelegramPreferences() {
  const newSettings = {
    pending_approval: document.getElementById('tg-pref-pending')?.checked ?? true,
    request_result: document.getElementById('tg-pref-result')?.checked ?? true,
    qr_ready: document.getElementById('tg-pref-qr')?.checked ?? true,
    parent_scan: document.getElementById('tg-pref-scan')?.checked ?? true,
    gate_alert: document.getElementById('tg-pref-admin')?.checked ?? true
  };

  try {
    const token = await ensureAuthToken();
    await fetch('/api/telegram/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ settings: newSettings })
    });
  } catch (err) {
    console.warn('Save preferences error:', err);
  }
}

async function testSimulateTelegramPairing() {
  const tgToken = currentTelegramToken || window.currentTelegramToken;
  if (!tgToken) {
    alert('ไม่พบ Token สำหรับจำลอง');
    return;
  }
  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/telegram/simulate-pairing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ token: tgToken })
    });
    const data = await res.json();
    if (data.success) {
      alert('🎉 จำลองการกด START ใน Telegram สำเร็จ!');
    }
  } catch (e) {
    alert('เกิดข้อผิดพลาดในการจำลอง: ' + e.message);
  }
}

// Global window exposure
window.initTelegramModule = initTelegramModule;
window.fetchTelegramStatus = fetchTelegramStatus;
window.openTelegramConnectModal = openTelegramConnectModal;
window.closeTelegramConnectModal = closeTelegramConnectModal;
window.disconnectTelegramAccount = disconnectTelegramAccount;
window.saveTelegramPreferences = saveTelegramPreferences;
window.testSimulateTelegramPairing = testSimulateTelegramPairing;
window.dismissHomeTelegramBanner = dismissHomeTelegramBanner;
window.handleOpenTelegramApp = handleOpenTelegramApp;
window.copyTelegramPairingCode = copyTelegramPairingCode;
window.connectTelegramByChatId = connectTelegramByChatId;
window.handleAdminRoleSelectChange = handleAdminRoleSelectChange;
window.setAdminRoleFilter = setAdminRoleFilter;
window.filterAdminUsers = filterAdminUsers;

// ============================================================================
// CLIENT RETURN ENGINE: SIMULATOR & DISCIPLINE LIVE RETURNS
// ============================================================================
let currentSimDistanceCm = 25;
let currentLiveFilter = 'all';
let cachedLiveReturns = null;

function setSimDistance(val) {
  currentSimDistanceCm = Number(val);
  const slider = document.getElementById('student-sim-slider');
  if (slider) slider.value = currentSimDistanceCm;
  updateSimDistUI();
}

function onSimSliderChange(val) {
  currentSimDistanceCm = Number(val);
  updateSimDistUI();
}

function updateSimDistUI() {
  const badge = document.getElementById('student-sim-dist-badge');
  const d = currentSimDistanceCm;
  const isPass = d <= 60;
  if (badge) {
    badge.textContent = `${d.toFixed(0)} ซม. (${isPass ? 'ในระยะ ✅' : 'นอกระยะจำลอง ⚠️'})`;
    badge.className = isPass 
      ? 'px-2 py-0.5 rounded-full text-[10.5px] font-mono font-bold bg-emerald-100 text-emerald-800 border border-emerald-300'
      : 'px-2 py-0.5 rounded-full text-[10.5px] font-mono font-bold bg-rose-100 text-rose-800 border border-rose-300';
  }

  ['25', '55', '95'].forEach(btnVal => {
    const btn = document.getElementById(`sim-btn-${btnVal}`);
    if (btn) {
      if (Math.abs(Number(btnVal) - d) <= 3) {
        btn.className = 'py-1.5 px-1 rounded-lg border text-[11px] font-bold bg-blue-100 border-blue-500 text-blue-900 shadow-2xs transition';
      } else {
        btn.className = 'py-1.5 px-1 rounded-lg border text-[11px] font-bold bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 transition';
      }
    }
  });
}

async function submitStudentReturn() {
  if (!activeRequest || !activeRequest.id) return;
  const dist = currentSimDistanceCm || 25;

  const btn = document.getElementById('btn-student-return');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> กำลังตรวจพิกัดและส่งบันทึก...`;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/gate/return-button', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        requestId: activeRequest.id,
        distanceCm: dist
      })
    });
    const data = await res.json();
    if (data.success) {
      if (data.isFlagged) {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            icon: 'warning',
            title: 'บันทึกการกลับแล้ว (ต้องตรวจสอบ)',
            html: `<div class="text-left text-xs space-y-1.5">
                     <p>⚠️ ตรวจพบว่าระยะห่างขณะกดคือ <b>${dist} ซม.</b> ซึ่งเกินเกณฑ์จำลอง 60 ซม.</p>
                     <p class="text-slate-600">ระบบได้บันทึกเวลากลับเข้าวิทยาลัยเรียบร้อยแล้ว แต่ติดป้าย <b>"ต้องตรวจสอบ"</b> และแจ้งฝ่ายปกครองเพื่อยืนยันตัวตนต่อไป</p>
                   </div>`,
            confirmButtonColor: '#f59e0b',
            confirmButtonText: 'รับทราบ'
          });
        } else {
          alert(`⚠️ บันทึกการกลับเข้าแล้ว (ติดป้ายต้องตรวจสอบ: ระยะ ${dist} ซม. เกินเกณฑ์ 60 ซม.) แจ้งฝ่ายปกครองเรียบร้อย`);
        }
      } else {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            icon: 'success',
            title: 'กลับถึงวิทยาลัยเรียบร้อย!',
            html: `<div class="text-xs text-slate-600 space-y-1">
                     <p>เวลากลับเข้า: <b>${data.data ? data.data.returnTime : ''} น.</b></p>
                     <p class="text-emerald-700 font-bold">✓ ตรวจผ่านระยะโมเดล ${dist} ซม. เรียบร้อย</p>
                     <p class="text-slate-400 text-[10px]">บัตรผ่าน QR Pass ถูกปิดการใช้งานเรียบร้อยแล้ว</p>
                   </div>`,
            confirmButtonColor: '#0d55cf',
            confirmButtonText: 'ตกลง'
          });
        } else {
          alert(`✅ บันทึกการกลับเข้าวิทยาลัยเรียบร้อย (${data.data ? data.data.returnTime : ''} น.)`);
        }
      }
      await fetchActiveRequest();
      if (typeof loadHistoryRequests === 'function') loadHistoryRequests();
      if (typeof loadDisciplineLiveReturns === 'function') loadDisciplineLiveReturns();
    } else {
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          icon: 'error',
          title: 'ไม่สามารถบันทึกกลับได้',
          text: data.message || 'เกิดข้อผิดพลาดในการตรวจสอบ',
          confirmButtonColor: '#0d55cf'
        });
      } else {
        alert('❌ ' + (data.message || 'บันทึกกลับไม่สำเร็จ'));
      }
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || `<i class="fa-solid fa-person-walking-arrow-loop-left text-base"></i><span>📍 ฉันกลับถึงวิทยาลัยแล้ว</span>`;
    }
  }
}

function setLiveFilter(type) {
  currentLiveFilter = type;
  ['all', 'out', 'returned', 'flagged', 'overdue'].forEach(t => {
    const b = document.getElementById(`live-filter-btn-${t}`);
    if (b) {
      if (t === type) {
        b.className = 'px-2.5 py-1 rounded-lg bg-[#0d55cf] text-white font-bold shrink-0';
      } else {
        b.className = 'px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-medium shrink-0';
      }
    }
  });
  renderLiveReturnsList();
}

async function loadDisciplineLiveReturns() {
  const panel = document.getElementById('discipline-live-returns-panel');
  const user = getCurrentUser();
  if (!panel) return;
  if (!user || (!['discipline_head', 'admin', 'deputy_director', 'advisor', 'dept_head'].includes(user.role))) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/gate/discipline/live-returns', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      cachedLiveReturns = data;
      const c = data.counts || {};
      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${val} คน`;
      };
      setTxt('live-count-out', c.currentlyOut || 0);
      setTxt('live-count-returned', c.returnedToday || 0);
      setTxt('live-count-flagged', c.flaggedCount || 0);
      setTxt('live-count-overdue', (c.overdueCount || 0) + (c.notReturnedPastDismissalCount || 0));

      renderLiveReturnsList();
    }
  } catch (err) {
    console.warn('Load live returns error:', err);
  }
}

function renderLiveReturnsList() {
  const container = document.getElementById('discipline-live-returns-list');
  if (!container || !cachedLiveReturns) return;

  const data = cachedLiveReturns;
  let items = [];

  if (currentLiveFilter === 'out') {
    items = data.activeOut || [];
  } else if (currentLiveFilter === 'returned') {
    items = data.returnedToday || [];
  } else if (currentLiveFilter === 'flagged') {
    items = data.flaggedReview || [];
  } else if (currentLiveFilter === 'overdue') {
    items = [...(data.overdueList || []), ...(data.notReturnedList || [])];
  } else {
    items = [...(data.activeOut || []), ...(data.returnedToday || [])];
  }

  const seen = new Set();
  items = items.filter(i => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });

  if (items.length === 0) {
    container.innerHTML = `
      <div class="py-8 text-center text-xs text-slate-400 space-y-1">
        <i class="fa-solid fa-clipboard-check text-2xl text-slate-300"></i>
        <p>ไม่มีรายการนักเรียนในหมวดนี้</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(r => {
    const isReturned = r.status === 'returned';
    const isFlagged = r.returnVerificationStatus === 'flagged_review';
    const isManual = r.returnMethod === 'manual';

    let badge = '';
    if (isReturned) {
      if (isFlagged) {
        badge = `<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300 font-bold text-[10px]">🚨 ต้องตรวจสอบ (${r.returnDistanceCm ? r.returnDistanceCm + ' ซม.' : 'ผิดเงื่อนไข'})</span>`;
      } else if (isManual) {
        badge = `<span class="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-300 font-bold text-[10px]">✍️ ฝ่ายปกครองบันทึกแทน</span>`;
      } else {
        badge = `<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold text-[10px]">✅ กลับแล้ว (${r.returnDistanceCm ? r.returnDistanceCm + ' ซม.' : 'ตรวจผ่าน'})</span>`;
      }
    } else {
      if (r.isNotReturnedPastDismissal) {
        badge = `<span class="px-2 py-0.5 rounded-full bg-purple-100 text-purple-900 border border-purple-300 font-bold text-[10px] animate-pulse">⛔ ไม่พบการกลับเข้า (เลยเวลาเลิกเรียน)</span>`;
      } else if (r.isOverdue) {
        badge = `<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold text-[10px]">⏰ สายเกินกำหนด (${r.diffMinutes} นาที)</span>`;
      } else {
        badge = `<span class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-bold text-[10px]">🚶 กำลังอยู่นอกวิทยาลัย</span>`;
      }
    }

    return `
      <div class="p-3 rounded-2xl border ${isFlagged ? 'border-rose-300 bg-rose-50/40 ring-1 ring-rose-200' : 'border-slate-200 bg-white'} shadow-xs space-y-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-1.5">
            <span class="font-bold text-slate-800 text-xs">${r.studentName}</span>
            <span class="text-[10px] text-slate-400">(${r.studentCode})</span>
          </div>
          <div>${badge}</div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-[11px] text-slate-600 bg-slate-50/70 p-2 rounded-xl">
          <div><span class="text-slate-400">แผนก:</span> ${r.deptName} (${r.classroomName})</div>
          <div><span class="text-slate-400">เวลาออก:</span> ${r.actualOutTimeStr || '-'} น.</div>
          <div><span class="text-slate-400">กำหนดกลับ:</span> ${r.expectedReturnTime || '-'} น.</div>
          ${isReturned ? `
            <div><span class="text-slate-400">เวลากลับจริง:</span> <strong class="text-emerald-700">${r.actualInTimeStr || '-'} น.</strong></div>
            <div><span class="text-slate-400">วิธีกลับ:</span> ${r.returnMethod === 'button' ? 'ปุ่มกดในแอป' : (r.returnMethod === 'manual' ? 'บันทึกแทน' : 'สแกน QR')}</div>
            <div><span class="text-slate-400">ระยะโมเดล:</span> ${r.returnDistanceCm ? r.returnDistanceCm + ' ซม.' : '-'}</div>
          ` : `
            <div><span class="text-slate-400">ยานพาหนะ:</span> ${r.plateNo || '-'}</div>
            <div><span class="text-slate-400">โทร นศ.:</span> <a href="tel:${r.phone}" class="text-blue-600 font-bold">${r.phone || '-'}</a></div>
            <div><span class="text-slate-400">โทร ผปค.:</span> <a href="tel:${r.parentPhone}" class="text-blue-600 font-bold">${r.parentPhone || '-'}</a></div>
          `}
        </div>

        ${r.returnNote ? `
          <div class="text-[10.5px] p-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
            <strong>หมายเหตุ/เหตุผล:</strong> ${r.returnNote}
          </div>
        ` : ''}

        <!-- Action Buttons -->
        <div class="flex items-center justify-end gap-1.5 pt-1 border-t border-slate-100 text-xs">
          ${!isReturned ? `
            <button type="button" onclick="openManualReturnModal('${r.id}', '${r.studentName}')" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-[11px] shadow-2xs flex items-center gap-1 transition">
              <i class="fa-solid fa-user-check text-[10px]"></i> บันทึกกลับแทน
            </button>
          ` : `
            <button type="button" onclick="openRevokeReturnModal('${r.id}', '${r.studentName}')" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl font-semibold text-[11px] flex items-center gap-1 transition">
              <i class="fa-solid fa-rotate-left text-[10px]"></i> เพิกถอนการกด
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

async function openManualReturnModal(requestId, studentName) {
  let note = 'ฝ่ายปกครองตรวจสอบพบตัวนักเรียนในวิทยาลัยแล้ว';
  if (typeof Swal !== 'undefined') {
    const { value: text, isConfirmed } = await Swal.fire({
      title: 'บันทึกรับเข้าแทนนักเรียน',
      html: `<p class="text-xs text-slate-500 mb-2">นักเรียน: <b>${studentName}</b></p>`,
      input: 'text',
      inputValue: note,
      inputLabel: 'หมายเหตุการรับเข้าแทน:',
      showCancelButton: true,
      confirmButtonText: 'ยืนยันบันทึก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#0d55cf'
    });
    if (!isConfirmed) return;
    note = text || note;
  } else {
    const input = prompt(`บันทึกรับเข้าแทน ${studentName}\nกรุณาระบุหมายเหตุ:`, note);
    if (input === null) return;
    note = input || note;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/gate/discipline/return-manual', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ requestId, note })
    });
    const d = await res.json();
    if (d.success) {
      alert(`✅ ${d.message}`);
      loadDisciplineLiveReturns();
    } else {
      alert('❌ ' + (d.message || 'เกิดข้อผิดพลาด'));
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function openRevokeReturnModal(requestId, studentName) {
  let reason = 'นักเรียนกดปุ่มผิดพลาด หรือยังอยู่นอกวิทยาลัยจริง';
  if (typeof Swal !== 'undefined') {
    const { value: text, isConfirmed } = await Swal.fire({
      title: 'เพิกถอนรายการกลับเข้า',
      html: `<p class="text-xs text-rose-600 mb-2">คำร้องของ <b>${studentName}</b> จะถูกเปลี่ยนสถานะกลับเป็น <b>"อยู่นอกวิทยาลัย"</b></p>`,
      input: 'text',
      inputValue: reason,
      inputLabel: 'เหตุผลการเพิกถอน:',
      showCancelButton: true,
      confirmButtonText: 'ยืนยันเพิกถอน',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#e11d48'
    });
    if (!isConfirmed) return;
    reason = text || reason;
  } else {
    const input = prompt(`เพิกถอนการกลับเข้าของ ${studentName}\nกรุณาระบุเหตุผล:`, reason);
    if (input === null) return;
    reason = input || reason;
  }

  try {
    const token = await ensureAuthToken();
    const res = await fetch('/api/gate/discipline/return-revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ requestId, reason })
    });
    const d = await res.json();
    if (d.success) {
      alert(`✅ ${d.message}`);
      loadDisciplineLiveReturns();
    } else {
      alert('❌ ' + (d.message || 'เกิดข้อผิดพลาด'));
    }
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// Window global bindings
window.setSimDistance = setSimDistance;
window.onSimSliderChange = onSimSliderChange;
window.submitStudentReturn = submitStudentReturn;
window.setLiveFilter = setLiveFilter;
window.loadDisciplineLiveReturns = loadDisciplineLiveReturns;
window.openManualReturnModal = openManualReturnModal;
window.openRevokeReturnModal = openRevokeReturnModal;
