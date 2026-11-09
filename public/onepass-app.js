/**
 * OnePass - ระบบขออนุญาตออกนอกสถานศึกษา ด้วยระบบ QR Code
 * Frontend Logic: Pure Vanilla JavaScript (JS ธรรมดา)
 */

// Application State
const state = {
  currentUser: null,
  studentInfo: null,
  activeTeacherTab: 'subject',
  activeAdminTab: 'tracker',
  currentReviewReq: null,
  currentGatePass: null
};

// DOM Content Loaded Entry Point
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  initBottomNav();
  checkSavedSession();
});

/**
 * Initialize all Event Listeners
 */
function initEventListeners() {
  // Mobile Login Toggle
  const btnToggleLoginForm = document.getElementById('btn-toggle-login-form');
  if (btnToggleLoginForm) {
    btnToggleLoginForm.addEventListener('click', () => {
      const container = document.getElementById('login-form-container');
      const input = document.getElementById('login-username');
      if (container) {
        container.scrollIntoView({ behavior: 'smooth' });
      }
      if (input) input.focus();
    });
  }

  // Login Form
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }

  // Quick Test Buttons
  document.querySelectorAll('.btn-test').forEach(btn => {
    btn.addEventListener('click', () => {
      const username = btn.dataset.user;
      document.getElementById('login-username').value = username;
      document.getElementById('login-password').value = '123456';
      handleLoginSubmit(new Event('submit'));
    });
  });

  // First-time Password Change Form
  const firstTimeForm = document.getElementById('first-time-form');
  if (firstTimeForm) {
    firstTimeForm.addEventListener('submit', handleFirstTimePasswordSubmit);
  }

  // Logout Button
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', handleLogout);
  }

  // Gate View Toggle Buttons
  const btnOpenGate = document.getElementById('btn-open-gate');
  if (btnOpenGate) {
    btnOpenGate.addEventListener('click', () => switchView('gate'));
  }
  const btnBackFromGate = document.getElementById('btn-back-from-gate');
  if (btnBackFromGate) {
    btnBackFromGate.addEventListener('click', () => {
      if (state.currentUser) {
        if (state.currentUser.is_admin && state.currentUser.role === 'admin') switchView('admin');
        else switchView(state.currentUser.is_student ? 'student' : 'teacher');
      } else {
        switchView('login');
      }
    });
  }

  // Admin View Toggle Buttons
  const btnOpenAdmin = document.getElementById('btn-open-admin');
  if (btnOpenAdmin) {
    btnOpenAdmin.addEventListener('click', () => switchView('admin'));
  }
  const btnBackFromAdmin = document.getElementById('btn-back-from-admin');
  if (btnBackFromAdmin) {
    btnBackFromAdmin.addEventListener('click', () => {
      if (state.currentUser) {
        switchView(state.currentUser.is_student ? 'student' : 'teacher');
      } else {
        switchView('login');
      }
    });
  }

  // Admin Tabs
  document.querySelectorAll('#admin-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#admin-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      const targetBtn = e.target.closest('.tab-btn');
      targetBtn.classList.add('active');
      const tabName = targetBtn.dataset.adminTab;
      state.activeAdminTab = tabName;
      switchAdminTab(tabName);
    });
  });

  // Admin Tracker Filters
  const btnRefreshAdminTracker = document.getElementById('btn-refresh-admin-tracker');
  if (btnRefreshAdminTracker) btnRefreshAdminTracker.addEventListener('click', loadAdminTracker);
  const adminTrackerSearch = document.getElementById('admin-tracker-search');
  if (adminTrackerSearch) adminTrackerSearch.addEventListener('keyup', (e) => { if (e.key === 'Enter') loadAdminTracker(); });
  const adminTrackerStatus = document.getElementById('admin-tracker-status');
  if (adminTrackerStatus) adminTrackerStatus.addEventListener('change', loadAdminTracker);

  // Admin Users Search & Filter
  const btnSearchUsers = document.getElementById('btn-search-users');
  if (btnSearchUsers) btnSearchUsers.addEventListener('click', loadAdminUsers);
  const adminUserSearch = document.getElementById('admin-user-search');
  if (adminUserSearch) adminUserSearch.addEventListener('keyup', (e) => { if (e.key === 'Enter') loadAdminUsers(); });
  const adminUserRoleFilter = document.getElementById('admin-user-role-filter');
  if (adminUserRoleFilter) adminUserRoleFilter.addEventListener('change', loadAdminUsers);

  // Admin User CRUD Modal
  const btnOpenCreateUser = document.getElementById('btn-open-create-user');
  if (btnOpenCreateUser) btnOpenCreateUser.addEventListener('click', openCreateUserModal);
  const btnCloseUserModal = document.getElementById('btn-close-user-modal');
  if (btnCloseUserModal) btnCloseUserModal.addEventListener('click', closeUserModal);
  const btnCancelUserModal = document.getElementById('btn-cancel-user-modal');
  if (btnCancelUserModal) btnCancelUserModal.addEventListener('click', closeUserModal);
  const userCrudForm = document.getElementById('user-crud-form');
  if (userCrudForm) userCrudForm.addEventListener('submit', handleUserCrudSubmit);

  const crudRole = document.getElementById('crud-role');
  if (crudRole) {
    crudRole.addEventListener('change', (e) => {
      toggleStudentCrudSection(e.target.value === 'student');
    });
  }

  // Admin Add Advisor Form
  const adminAddAdvisorForm = document.getElementById('admin-add-advisor-form');
  if (adminAddAdvisorForm) adminAddAdvisorForm.addEventListener('submit', handleAddAdvisorSubmit);

  // Admin Forms (Term, Duty, Telegram)
  const adminTermForm = document.getElementById('admin-term-form');
  if (adminTermForm) adminTermForm.addEventListener('submit', handleAdminTermSubmit);
  const adminDutyForm = document.getElementById('admin-duty-form');
  if (adminDutyForm) adminDutyForm.addEventListener('submit', handleAdminDutySubmit);
  const adminTelegramForm = document.getElementById('admin-telegram-form');
  if (adminTelegramForm) adminTelegramForm.addEventListener('submit', handleAdminTelegramSubmit);

  // Student Request Modal
  const btnOpenReqModal = document.getElementById('btn-open-request-modal');
  if (btnOpenReqModal) {
    btnOpenReqModal.addEventListener('click', openRequestModal);
  }
  const btnCloseReqModal = document.getElementById('btn-close-request-modal');
  if (btnCloseReqModal) {
    btnCloseReqModal.addEventListener('click', closeRequestModal);
  }
  const btnCancelReqModal = document.getElementById('btn-cancel-request-modal');
  if (btnCancelReqModal) {
    btnCancelReqModal.addEventListener('click', closeRequestModal);
  }

  // Leave Type Radio Change
  document.querySelectorAll('input[name="req-leave-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const returnGroup = document.getElementById('expected-return-group');
      if (e.target.value === 'for_day') {
        returnGroup.style.display = 'none';
      } else {
        returnGroup.style.display = 'block';
      }
    });
  });

  // Submit Request Form
  const createReqForm = document.getElementById('create-request-form');
  if (createReqForm) {
    createReqForm.addEventListener('submit', handleCreateRequestSubmit);
  }

  // Teacher Tabs
  document.querySelectorAll('#role-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#role-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      const targetBtn = e.target.closest('.tab-btn');
      targetBtn.classList.add('active');
      state.activeTeacherTab = targetBtn.dataset.tab;
      loadTeacherRequests();
    });
  });

  // Teacher Refresh Button
  const btnRefreshTeacher = document.getElementById('btn-refresh-teacher');
  if (btnRefreshTeacher) {
    btnRefreshTeacher.addEventListener('click', () => {
      loadTeacherRequests();
      updateTeacherBadges();
    });
  }

  // Approval Modal Actions
  const btnCloseAppr = document.getElementById('btn-close-approval-modal');
  if (btnCloseAppr) btnCloseAppr.addEventListener('click', closeApprovalModal);
  const btnCancelAppr = document.getElementById('btn-cancel-approval');
  if (btnCancelAppr) btnCancelAppr.addEventListener('click', closeApprovalModal);

  const btnApprove = document.getElementById('btn-approve-request');
  if (btnApprove) {
    btnApprove.addEventListener('click', () => submitApprovalDecision('approve'));
  }
  const btnReject = document.getElementById('btn-reject-request');
  if (btnReject) {
    btnReject.addEventListener('click', () => submitApprovalDecision('reject'));
  }

  // Pass Modal Close
  const btnClosePass = document.getElementById('btn-close-pass-modal');
  if (btnClosePass) btnClosePass.addEventListener('click', closePassModal);
  const btnClosePassBtn = document.getElementById('btn-close-pass-btn');
  if (btnClosePassBtn) btnClosePassBtn.addEventListener('click', closePassModal);

  // Gate Verification Button
  const btnVerifyToken = document.getElementById('btn-verify-token');
  if (btnVerifyToken) {
    btnVerifyToken.addEventListener('click', handleVerifyGateToken);
  }
  const tokenInput = document.getElementById('gate-token-input');
  if (tokenInput) {
    tokenInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleVerifyGateToken();
    });
  }

  // Gate Exit / Return Action Buttons
  const btnGateOut = document.getElementById('btn-record-gate-out');
  if (btnGateOut) btnGateOut.addEventListener('click', handleGateCheckOut);
  const btnGateIn = document.getElementById('btn-record-gate-in');
  if (btnGateIn) btnGateIn.addEventListener('click', handleGateCheckIn);

  // ESP32 Remote Gate Control Buttons
  const btnTriggerOpen = document.getElementById('btn-trigger-open-gate');
  if (btnTriggerOpen) btnTriggerOpen.addEventListener('click', handleTriggerOpenGate);
  const btnRefreshEsp = document.getElementById('btn-refresh-esp32-status');
  if (btnRefreshEsp) btnRefreshEsp.addEventListener('click', loadEsp32Status);
}

/**
 * Check if a user session was saved in sessionStorage
 */
function checkSavedSession() {
  const saved = sessionStorage.getItem('onepass_user');
  if (saved) {
    try {
      state.currentUser = JSON.parse(saved);
      onLoginSuccess(state.currentUser);
    } catch (e) {
      sessionStorage.removeItem('onepass_user');
      switchView('login');
    }
  } else {
    switchView('login');
  }
}

/**
 * Alert Box Notification
 */
function showAlert(message, type = 'info') {
  // Show in login alert box if present
  const loginBox = document.getElementById('login-alert-box');
  if (loginBox) {
    loginBox.className = `alert alert-${type}`;
    loginBox.textContent = message;
    loginBox.style.display = 'block';
    setTimeout(() => {
      loginBox.style.display = 'none';
    }, 6000);
  }

  const box = document.getElementById('alert-box');
  if (!box) return;
  box.className = `alert alert-${type}`;
  box.textContent = message;
  box.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => {
    box.style.display = 'none';
  }, 6000);
}

/**
 * View Switcher
 */
function switchView(viewName) {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('student-view').style.display = 'none';
  document.getElementById('teacher-view').style.display = 'none';
  document.getElementById('gate-view').style.display = 'none';
  document.getElementById('admin-view').style.display = 'none';

  const appHeader = document.querySelector('.app-header');
  const userNav = document.getElementById('user-nav');

  if (viewName === 'login') {
    if (appHeader) appHeader.style.display = 'none';
    if (userNav) userNav.style.display = 'none';
    document.getElementById('login-section').style.display = 'flex';
    updateBottomNav('login');
  } else {
    if (appHeader) appHeader.style.display = 'block';
    if (userNav) userNav.style.display = 'flex';
    updateBottomNav(viewName);

    if (viewName === 'student') {
      document.getElementById('student-view').style.display = 'block';
      loadStudentDashboard();
    } else if (viewName === 'teacher') {
      document.getElementById('teacher-view').style.display = 'block';
      loadTeacherDashboard();
    } else if (viewName === 'gate') {
      document.getElementById('gate-view').style.display = 'block';
      document.getElementById('gate-token-input').focus();
      loadEsp32Status();
    } else if (viewName === 'admin') {
      document.getElementById('admin-view').style.display = 'block';
      loadAdminDashboard();
    }
  }
}

/**
 * Bottom Navigation Bar Controller
 */
function updateBottomNav(viewName) {
  const nav = document.getElementById('bottom-nav-bar');
  if (!nav) return;

  if (viewName === 'login' || !state.currentUser) {
    nav.style.display = 'none';
    document.body.classList.remove('has-bottom-nav');
    return;
  }

  nav.style.display = 'flex';
  document.body.classList.add('has-bottom-nav');

  // Hide all bottom groups first
  ['bnav-student', 'bnav-teacher', 'bnav-deputy', 'bnav-admin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  const user = state.currentUser;
  let activeGroupId = 'bnav-teacher';

  if (user.role === 'admin' || user.role === 'super_admin') {
    activeGroupId = 'bnav-admin';
  } else if (user.role === 'deputy_director') {
    activeGroupId = 'bnav-deputy';
  } else if (user.is_student) {
    activeGroupId = 'bnav-student';
  } else {
    activeGroupId = 'bnav-teacher';
  }

  const activeGroup = document.getElementById(activeGroupId);
  if (activeGroup) activeGroup.style.display = 'flex';

  updateActiveBottomNavItem(viewName);
}

function updateActiveBottomNavItem(viewName) {
  document.querySelectorAll('.bnav-item').forEach(btn => btn.classList.remove('active'));

  let action = '';
  if (viewName === 'student') {
    action = 'student-home';
  } else if (viewName === 'teacher') {
    if (state.activeTeacherTab === 'all') {
      action = 'teacher-history';
    } else if (state.currentUser && state.currentUser.role === 'deputy_director') {
      action = 'deputy-pending';
    } else {
      action = 'teacher-pending';
    }
  } else if (viewName === 'gate') {
    action = 'open-gate';
  } else if (viewName === 'admin') {
    action = (state.activeAdminTab === 'users') ? 'admin-users' : 'admin-dashboard';
  }

  if (action) {
    const target = document.querySelector(`.bnav-item[data-action="${action}"]`);
    if (target) target.classList.add('active');
  }
}

function initBottomNav() {
  document.querySelectorAll('.bnav-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const targetBtn = e.target.closest('.bnav-item');
      if (!targetBtn) return;
      const action = targetBtn.dataset.action;

      document.querySelectorAll('.bnav-item').forEach(b => b.classList.remove('active'));
      targetBtn.classList.add('active');

      if (action === 'student-home') {
        switchView('student');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (action === 'student-request') {
        const btn = document.getElementById('btn-open-request-modal');
        if (btn) btn.click();
      } else if (action === 'student-pass') {
        await handleOpenLatestStudentPass();
      } else if (action === 'student-history') {
        switchView('student');
        const tbl = document.getElementById('student-requests-table');
        if (tbl) tbl.scrollIntoView({ behavior: 'smooth' });
      } else if (action === 'teacher-pending') {
        switchView('teacher');
        const user = state.currentUser;
        if (user) {
          if (user.is_deputy_director || user.role === 'deputy_director') setTeacherActiveTab('deputy');
          else if (user.is_head_discipline) setTeacherActiveTab('head_discipline');
          else if (user.is_head_major) setTeacherActiveTab('head_major');
          else if (user.is_advisor) setTeacherActiveTab('advisor');
          else setTeacherActiveTab('subject');
        }
      } else if (action === 'deputy-pending') {
        switchView('teacher');
        setTeacherActiveTab('deputy');
      } else if (action === 'teacher-history') {
        switchView('teacher');
        setTeacherActiveTab('all');
      } else if (action === 'open-gate') {
        switchView('gate');
      } else if (action === 'admin-dashboard') {
        switchView('admin');
        switchAdminTab('tracker');
      } else if (action === 'admin-users') {
        switchView('admin');
        switchAdminTab('users');
      } else if (action === 'logout') {
        if (confirm('คุณต้องการออกจากระบบ OnePass หรือไม่?')) {
          handleLogout();
        }
      }
    });
  });
}

async function handleOpenLatestStudentPass() {
  if (!state.currentUser) return;
  const uid = state.currentUser.id;
  try {
    const res = await fetch(`/api/requests?userId=${uid}&role=student`);
    const data = await res.json();
    if (data.success && data.requests && data.requests.length > 0) {
      // Find the first approved or completed request
      const approvedReq = data.requests.find(r => r.status === 'approved' || r.status === 'completed');
      if (approvedReq) {
        openPassModal(approvedReq.id);
        return;
      }
    }
    showAlert('ยังไม่มีบัตรผ่านที่ได้รับการอนุมัติในขณะนี้ หรือบัตรผ่านหมดอายุแล้ว', 'info');
  } catch (err) {
    showAlert('เกิดข้อผิดพลาดในการโหลดบัตรผ่าน: ' + err.message, 'danger');
  }
}

// ========================================================
// 1. AUTHENTICATION & FIRST-TIME CHANGE PASSWORD
// ========================================================

async function handleLoginSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();

  if (!username || !password) {
    showAlert('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', 'danger');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!data.success) {
      showAlert(data.message || 'เข้าสู่ระบบไม่สำเร็จ', 'danger');
      return;
    }

    // Force change password on first login
    if (data.must_change_password) {
      document.getElementById('first-time-user-id').value = data.user_id;
      document.getElementById('first-time-user-name').textContent = `${data.full_name} (${data.username})`;
      document.getElementById('first-time-new-pass').value = '';
      document.getElementById('first-time-confirm-pass').value = '';
      document.getElementById('first-time-modal').style.display = 'flex';
      return;
    }

    // Normal login
    state.currentUser = data.user;
    sessionStorage.setItem('onepass_user', JSON.stringify(data.user));
    onLoginSuccess(data.user);
  } catch (err) {
    showAlert('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์: ' + err.message, 'danger');
  }
}

async function handleFirstTimePasswordSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('first-time-user-id').value;
  const newPassword = document.getElementById('first-time-new-pass').value.trim();
  const confirmPassword = document.getElementById('first-time-confirm-pass').value.trim();

  if (newPassword.length < 6) {
    alert('รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
    return;
  }
  if (newPassword !== confirmPassword) {
    alert('รหัสผ่านใหม่และการยืนยันรหัสผ่านไม่ตรงกัน');
    return;
  }
  if (newPassword === '123456') {
    alert('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเริ่มต้น (123456)');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password-first-time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        new_password: newPassword,
        confirm_password: confirmPassword
      })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ');
      return;
    }

    document.getElementById('first-time-modal').style.display = 'none';
    state.currentUser = data.user;
    sessionStorage.setItem('onepass_user', JSON.stringify(data.user));
    showAlert(data.message, 'success');
    onLoginSuccess(data.user);
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

function onLoginSuccess(user) {
  const roleLabels = {
    student: 'ผู้เรียน',
    teacher: 'ครูอาจารย์',
    advisor: 'ครูที่ปรึกษา',
    deputy_director: 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา',
    director: 'ผู้อำนวยการ',
    admin: 'ผู้ดูแลระบบ',
    super_admin: 'ผู้ดูแลระบบสูงสุด'
  };
  const roleText = roleLabels[user.role] || user.role;
  document.getElementById('nav-user-info').textContent = `👤 ${user.full_name} (${roleText})`;

  // Admin button in top navbar
  const btnAdmin = document.getElementById('btn-open-admin');
  if (btnAdmin) {
    btnAdmin.style.display = user.is_admin ? 'inline-block' : 'none';
  }

  if (user.role === 'admin' || user.role === 'super_admin') {
    switchView('admin');
  } else if (user.is_student) {
    switchView('student');
  } else {
    switchView('teacher');
  }
}

function handleLogout() {
  state.currentUser = null;
  state.studentInfo = null;
  sessionStorage.removeItem('onepass_user');
  switchView('login');
  showAlert('ออกจากระบบเรียบร้อยแล้ว', 'info');
}

// ========================================================
// 2. STUDENT DASHBOARD & REQUEST SUBMISSION
// ========================================================

async function loadStudentDashboard() {
  if (!state.currentUser) return;
  const uid = state.currentUser.id;

  try {
    // 1. Fetch Student Info & Approvers
    const res = await fetch(`/api/student/info/${uid}`);
    const data = await res.json();

    if (data.success) {
      state.studentInfo = data;
      const std = data.student;
      document.getElementById('student-profile-text').innerHTML = `
        <strong>ชื่อ-สกุล:</strong> ${std.full_name} | 
        <strong>รหัสประจำตัว:</strong> ${std.student_code} | 
        <strong>ระดับชั้น:</strong> ${std.level_name || '-'} | 
        <strong>แผนกวิชา:</strong> ${std.major_name || '-'} ${std.room ? '(' + std.room + ')' : ''}
      `;

      // Approvers Info Banner
      const app = data.approvers;
      const advName = app.advisor ? app.advisor.full_name : 'ยังไม่ระบุในระบบ';
      const hmName = app.head_major ? app.head_major.full_name : 'ยังไม่ระบุในระบบ';
      const hdName = app.head_discipline ? app.head_discipline.full_name : 'งานปกครอง';
      const depName = app.deputy_director ? app.deputy_director.full_name : 'ฝ่ายกิจการนักเรียนฯ';

      document.getElementById('student-approvers-info').innerHTML = `
        <strong>สายการพิจารณาอนุมัติของคุณ:</strong>
        <span style="margin-left: 8px;">1. ครูรายวิชา (เลือกตามคาบเรียน) &rarr;</span>
        <span>2. ครูที่ปรึกษา: <u>${advName}</u> &rarr;</span>
        <span>3. หัวหน้าแผนก: <u>${hmName}</u> &rarr;</span>
        <span>4. หัวหน้างานปกครอง: <u>${hdName}</u> &rarr;</span>
        <span>5. รอง ผอ. ฝ่ายกิจการฯ: <u>${depName}</u></span>
      `;
    }

    // 2. Load Teachers for Request Form Dropdown
    loadTeachersDropdown();

    // 3. Load Student Requests Table
    loadStudentRequests();
  } catch (err) {
    console.error('Error loading student dashboard:', err);
  }
}

async function loadTeachersDropdown() {
  const select = document.getElementById('req-subject-teacher');
  if (!select) return;

  try {
    const res = await fetch('/api/student/teachers');
    const data = await res.json();
    if (data.success) {
      select.innerHTML = '<option value="">-- กรุณาเลือกครูผู้สอนประจำวิชา --</option>';
      data.teachers.forEach(t => {
        const pos = t.position ? ` (${t.position})` : '';
        select.innerHTML += `<option value="${t.id}">${t.full_name} [${t.username}]${pos}</option>`;
      });
    }
  } catch (err) {
    console.error('Error loading teachers:', err);
  }
}

async function loadStudentRequests() {
  if (!state.currentUser) return;
  const tbody = document.querySelector('#student-requests-table tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">กำลังโหลดข้อมูล...</td></tr>';

  try {
    const res = await fetch(`/api/requests?userId=${state.currentUser.id}&role=student`);
    const data = await res.json();

    if (!data.success || data.requests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">ยังไม่มีประวัติการขออนุญาตออกนอกสถานศึกษา</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.requests.forEach(r => {
      const statusBadge = getStatusBadge(r.status);
      const leaveTypeLabel = r.is_not_returning ? '<span style="color: #e74c3c;">ออกแล้วไม่กลับ</span>' : 'ออกชั่วคราว';
      const qrBtn = (r.status === 'approved' || r.status === 'completed')
        ? `<button type="button" class="btn btn-sm btn-success" onclick="openPassModal(${r.id})">🎫 ดูบัตรผ่าน QR</button>`
        : '<span class="text-muted text-sm">รออนุมัติครบสาย</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.request_no}</strong></td>
        <td>${formatDate(r.leave_date)} เวลา ${r.leave_time.slice(0, 5)} น.</td>
        <td>${leaveTypeLabel}</td>
        <td>${r.reason}</td>
        <td>${r.subject_teacher_name || '-'}</td>
        <td>${statusBadge}</td>
        <td>${qrBtn}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

function openRequestModal() {
  const today = new Date().toISOString().slice(0, 10);
  const nowTime = new Date().toTimeString().slice(0, 5);
  document.getElementById('req-leave-date').value = today;
  document.getElementById('req-leave-time').value = nowTime;
  document.getElementById('req-return-time').value = '15:30';
  document.getElementById('expected-return-group').style.display = 'block';
  document.getElementById('request-modal').style.display = 'flex';
}

function closeRequestModal() {
  document.getElementById('request-modal').style.display = 'none';
}

async function handleCreateRequestSubmit(e) {
  e.preventDefault();
  if (!state.currentUser) return;

  const leaveDate = document.getElementById('req-leave-date').value;
  const leaveTime = document.getElementById('req-leave-time').value;
  const leaveType = document.querySelector('input[name="req-leave-type"]:checked').value;
  const expectedReturnTime = document.getElementById('req-return-time').value;
  const subjectTeacherId = document.getElementById('req-subject-teacher').value;
  const reasonSelect = document.getElementById('req-reason-select').value;
  const reasonDetail = document.getElementById('req-reason-detail').value.trim();

  if (!subjectTeacherId) {
    alert('กรุณาเลือกครูผู้สอนประจำวิชาในคาบที่ขออนุญาตออก');
    return;
  }

  const payload = {
    user_id: state.currentUser.id,
    leave_date: leaveDate,
    leave_time: leaveTime,
    is_not_returning: leaveType === 'for_day' ? 1 : 0,
    expected_return_time: leaveType === 'for_day' ? null : expectedReturnTime,
    subject_teacher_id: parseInt(subjectTeacherId, 10),
    reason: reasonSelect,
    reason_detail: reasonDetail
  };

  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'ส่งคำขอไม่สำเร็จ');
      return;
    }

    closeRequestModal();
    showAlert(data.message, 'success');
    loadStudentRequests();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ========================================================
// 3. TEACHER & APPROVER DASHBOARD (Multi-tier Workflow)
// ========================================================

async function loadTeacherDashboard() {
  if (!state.currentUser) return;
  const user = state.currentUser;
  const isAdmin = ['admin', 'super_admin'].includes(user.role);

  const title = document.getElementById('teacher-panel-title');
  const infoText = document.getElementById('teacher-info-text');

  title.textContent = `ระบบพิจารณาอนุมัติคำขอออกนอกสถานศึกษา (${user.full_name})`;
  const rolesList = [];
  if (user.roles_held.includes('subject_teacher') || user.role === 'teacher') rolesList.push('ครูรายวิชา');
  if (user.is_advisor) rolesList.push('ครูที่ปรึกษา');
  if (user.is_head_major) rolesList.push('หัวหน้าแผนก');
  if (user.is_head_discipline) rolesList.push('หัวหน้างานปกครอง');
  if (user.is_deputy_director || user.role === 'deputy_director') rolesList.push('รอง ผอ. ฝ่ายกิจการฯ');

  infoText.innerHTML = `หน้าที่ของคุณในระบบ: <strong>${rolesList.join(', ') || 'ครูผู้สอน'}</strong>`;

  // Dynamically show/hide approval tabs based on actual authorized roles
  const tabSubject = document.querySelector('#role-tabs [data-tab="subject"]');
  const tabAdvisor = document.querySelector('#role-tabs [data-tab="advisor"]');
  const tabHeadMajor = document.querySelector('#role-tabs [data-tab="head_major"]');
  const tabHeadDiscipline = document.querySelector('#role-tabs [data-tab="head_discipline"]');
  const tabDeputy = document.querySelector('#role-tabs [data-tab="deputy"]');
  const tabAll = document.querySelector('#role-tabs [data-tab="all"]');

  if (tabSubject) tabSubject.style.display = (user.role === 'teacher' || isAdmin) ? 'inline-flex' : 'none';
  if (tabAdvisor) tabAdvisor.style.display = (user.is_advisor || isAdmin) ? 'inline-flex' : 'none';
  if (tabHeadMajor) tabHeadMajor.style.display = (user.is_head_major || isAdmin) ? 'inline-flex' : 'none';
  if (tabHeadDiscipline) tabHeadDiscipline.style.display = (user.is_head_discipline || isAdmin) ? 'inline-flex' : 'none';
  if (tabDeputy) tabDeputy.style.display = (user.is_deputy_director || user.role === 'deputy_director' || isAdmin) ? 'inline-flex' : 'none';
  if (tabAll) tabAll.style.display = 'inline-flex';

  // Auto-select initial tab based on highest primary authorized role
  if (user.role === 'deputy_director' || (user.is_deputy_director && !user.is_advisor && !user.is_head_major)) {
    setTeacherActiveTab('deputy');
  } else if (user.is_head_discipline && !user.is_advisor && !user.is_head_major) {
    setTeacherActiveTab('head_discipline');
  } else if (user.is_head_major && !user.is_advisor) {
    setTeacherActiveTab('head_major');
  } else if (user.is_advisor) {
    setTeacherActiveTab('advisor');
  } else {
    setTeacherActiveTab('subject');
  }

  updateTeacherBadges();
}

function setTeacherActiveTab(tabName) {
  state.activeTeacherTab = tabName;
  document.querySelectorAll('#role-tabs .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  updateActiveBottomNavItem('teacher');
  loadTeacherRequests();
}

async function updateTeacherBadges() {
  if (!state.currentUser) return;
  const user = state.currentUser;
  const uid = user.id;
  const role = user.role;
  const isAdmin = ['admin', 'super_admin'].includes(role);

  const tabsToCheck = [];
  if (role === 'teacher' || isAdmin) tabsToCheck.push('subject');
  if (user.is_advisor || isAdmin) tabsToCheck.push('advisor');
  if (user.is_head_major || isAdmin) tabsToCheck.push('head_major');
  if (user.is_head_discipline || isAdmin) tabsToCheck.push('head_discipline');
  if (user.is_deputy_director || role === 'deputy_director' || isAdmin) tabsToCheck.push('deputy');

  let totalPending = 0;
  let deputyPending = 0;

  for (const t of ['subject', 'advisor', 'head_major', 'head_discipline', 'deputy']) {
    const badge = document.getElementById(`badge-${t}`);
    if (!tabsToCheck.includes(t)) {
      if (badge) badge.style.display = 'none';
      continue;
    }
    try {
      const res = await fetch(`/api/requests?userId=${uid}&role=${role}&tab=${t}`);
      const data = await res.json();
      const count = data.success ? data.count : 0;
      if (t === 'deputy') deputyPending += count;
      totalPending += count;

      if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
      }
    } catch (e) {
      // Ignore count errors
    }
  }

  // Update bottom navigation live badges
  const bnavTeacher = document.getElementById('bnav-badge-teacher');
  if (bnavTeacher) {
    bnavTeacher.textContent = totalPending;
    bnavTeacher.style.display = totalPending > 0 ? 'inline-block' : 'none';
  }
  const bnavDeputy = document.getElementById('bnav-badge-deputy');
  if (bnavDeputy) {
    bnavDeputy.textContent = deputyPending;
    bnavDeputy.style.display = deputyPending > 0 ? 'inline-block' : 'none';
  }
  const bnavAdmin = document.getElementById('bnav-badge-admin');
  if (bnavAdmin) {
    bnavAdmin.textContent = totalPending;
    bnavAdmin.style.display = totalPending > 0 ? 'inline-block' : 'none';
  }
}

async function loadTeacherRequests() {
  if (!state.currentUser) return;
  const tbody = document.querySelector('#teacher-requests-table tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="text-center">กำลังโหลดรายการ...</td></tr>';

  const uid = state.currentUser.id;
  const role = state.currentUser.role;
  const tab = state.activeTeacherTab;
  const isAdmin = ['admin', 'super_admin'].includes(role);

  try {
    const res = await fetch(`/api/requests?userId=${uid}&role=${role}&tab=${tab}`);
    const data = await res.json();

    if (!data.success || data.requests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">ไม่มีรายการคำขอในแท็บนี้</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.requests.forEach(r => {
      const leaveType = r.is_not_returning ? '(ออกแล้วไม่กลับ)' : '(ออกชั่วคราว)';
      const timelineHtml = renderMiniWorkflow(r);

      // Check whether this specific user can approve this request right now:
      let canApproveThis = false;
      if (tab !== 'all') {
        if (r.status === 'pending_subject' && (r.subject_teacher_id === uid || isAdmin)) canApproveThis = true;
        else if (r.status === 'pending_advisor' && (r.advisor_teacher_id === uid || isAdmin)) canApproveThis = true;
        else if (r.status === 'pending_head_major' && (r.head_major_teacher_id === uid || isAdmin)) canApproveThis = true;
        else if (r.status === 'pending_head_discipline' && (r.head_discipline_user_id === uid || state.currentUser.is_head_discipline || isAdmin)) canApproveThis = true;
        else if (r.status === 'pending_deputy' && (r.deputy_director_user_id === uid || state.currentUser.is_deputy_director || role === 'deputy_director' || isAdmin)) canApproveThis = true;
      }

      let actionBtns = '';
      if (canApproveThis) {
        actionBtns = `<button type="button" class="btn btn-sm btn-primary" onclick="openApprovalModal(${r.id}, false)">🔍 พิจารณาอนุมัติ</button>`;
      } else {
        // Strictly Read-Only for history tab and unauthorized requests
        actionBtns = `<button type="button" class="btn btn-sm btn-outline-primary" onclick="openApprovalModal(${r.id}, true)">👁️ ดูรายละเอียด</button>`;
      }

      if (r.status === 'approved' || r.status === 'completed') {
        actionBtns += ` <button type="button" class="btn btn-sm btn-success" onclick="openPassModal(${r.id})" style="margin-left:5px;">🎫 ดูบัตรผ่าน QR</button>`;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.request_no}</strong></td>
        <td>
          <strong>${r.student_name}</strong> (${r.student_code})<br>
          <span class="text-muted text-sm">${r.level_name || ''} ${r.major_name || ''} ${r.room ? 'ห้อง ' + r.room : ''}</span>
        </td>
        <td>${formatDate(r.leave_date)}<br>เวลา <strong>${r.leave_time.slice(0, 5)} น.</strong> ${leaveType}</td>
        <td><strong>${r.reason}</strong>${r.reason_detail ? '<br><span class="text-muted text-sm">' + r.reason_detail + '</span>' : ''}</td>
        <td>${timelineHtml}</td>
        <td>${actionBtns}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

function renderMiniWorkflow(r) {
  const steps = [
    { name: '1.ครูรายวิชา', status: r.subject_status },
    { name: '2.ครูที่ปรึกษา', status: r.advisor_status },
    { name: '3.หน.แผนก', status: r.head_major_status },
    { name: '4.หน.ปกครอง', status: r.head_discipline_status },
    { name: '5.รอง ผอ.', status: r.deputy_director_status }
  ];

  return steps.map(s => {
    let color = '#95a5a6';
    let icon = '⏳';
    if (s.status === 'approved') { color = '#27ae60'; icon = '✅'; }
    if (s.status === 'rejected') { color = '#c0392b'; icon = '❌'; }
    return `<span style="font-size:0.75rem; color:${color}; margin-right:4px;" title="${s.name}: ${s.status}">${icon}${s.name}</span>`;
  }).join(' ');
}

// ========================================================
// 4. APPROVAL MODAL & DECISION HANDLING
// ========================================================

async function openApprovalModal(requestId, forceReadOnly = false) {
  try {
    const res = await fetch(`/api/requests/${requestId}`);
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'ไม่สามารถโหลดข้อมูลคำขอได้');
      return;
    }

    const r = data.request;
    state.currentReviewReq = r;

    // Determine if the user is authorized to approve this request right now:
    // Tab "all" (ประวัติคำขอทั้งหมด) is ALWAYS strictly read-only for everyone!
    const isHistoryTab = (state.activeTeacherTab === 'all') || forceReadOnly;
    let canApprove = false;
    let roleActed = null;

    if (!isHistoryTab && state.currentUser) {
      const myId = state.currentUser.id;
      const myRole = state.currentUser.role;
      const isAdmin = ['admin', 'super_admin'].includes(myRole);

      if (r.status === 'pending_subject' && (r.subject_teacher_id === myId || isAdmin)) {
        canApprove = true;
        roleActed = 'subject_teacher';
      } else if (r.status === 'pending_advisor' && (r.advisor_teacher_id === myId || isAdmin)) {
        canApprove = true;
        roleActed = 'advisor';
      } else if (r.status === 'pending_head_major' && (r.head_major_teacher_id === myId || isAdmin)) {
        canApprove = true;
        roleActed = 'head_major';
      } else if (r.status === 'pending_head_discipline' && (r.head_discipline_user_id === myId || state.currentUser.is_head_discipline || isAdmin)) {
        canApprove = true;
        roleActed = 'head_discipline';
      } else if (r.status === 'pending_deputy' && (r.deputy_director_user_id === myId || myRole === 'deputy_director' || isAdmin)) {
        canApprove = true;
        roleActed = 'deputy_director';
      }
    }

    const commentGroup = document.getElementById('approval-comment-group');
    const decisionButtons = document.getElementById('approval-decision-buttons');
    const readonlyNotice = document.getElementById('approval-readonly-notice');

    if (canApprove && roleActed) {
      document.getElementById('approval-request-id').value = r.id;
      document.getElementById('approval-role-acted').value = roleActed;
      document.getElementById('approval-comment').value = '';

      const roleThaiNames = {
        subject_teacher: 'ครูรายวิชา',
        advisor: 'ครูที่ปรึกษา',
        head_major: 'หัวหน้าแผนก',
        head_discipline: 'หัวหน้างานปกครอง',
        deputy_director: 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา'
      };

      document.getElementById('approval-modal-title').textContent = `พิจารณาคำขอในบทบาท: ${roleThaiNames[roleActed] || roleActed}`;
      if (commentGroup) commentGroup.style.display = 'block';
      if (decisionButtons) decisionButtons.style.display = 'flex';
      if (readonlyNotice) readonlyNotice.style.display = 'none';
    } else {
      document.getElementById('approval-modal-title').textContent = `รายละเอียดคำขอ: ${r.request_no} (ดูข้อมูลประวัติคำขอ)`;
      if (commentGroup) commentGroup.style.display = 'none';
      if (decisionButtons) decisionButtons.style.display = 'none';
      if (readonlyNotice) readonlyNotice.style.display = 'block';
    }

    // Request Summary
    document.getElementById('approval-request-summary').innerHTML = `
      <h4>เลขที่คำขอ: ${r.request_no} (สถานะ: ${getStatusBadge(r.status)})</h4>
      <p><strong>ผู้ขอ:</strong> ${r.student_name} (${r.student_code}) | <strong>ระดับชั้น:</strong> ${r.level_name || '-'} แผนก ${r.major_name || '-'} ${r.room ? 'ห้อง ' + r.room : ''}</p>
      <p><strong>วัน-เวลาที่ขอออก:</strong> ${formatDate(r.leave_date)} เวลา ${r.leave_time.slice(0, 5)} น. 
         <strong>เวลากลับ:</strong> ${r.is_not_returning ? 'ออกแล้วไม่กลับ (กลับบ้าน)' : (r.expected_return_time ? r.expected_return_time.slice(0, 5) + ' น.' : '-')}</p>
      <p><strong>เหตุผล:</strong> ${r.reason} ${r.reason_detail ? ' (' + r.reason_detail + ')' : ''}</p>
    `;

    // 5-Step Workflow Cards
    renderDetailedWorkflow(r);

    document.getElementById('approval-modal').style.display = 'flex';
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

function renderDetailedWorkflow(r) {
  const steps = [
    { label: '1. ครูรายวิชา', name: r.subject_teacher_name, status: r.subject_status, comment: r.subject_comment, time: r.subject_action_at },
    { label: '2. ครูที่ปรึกษา', name: r.advisor_teacher_name, status: r.advisor_status, comment: r.advisor_comment, time: r.advisor_action_at },
    { label: '3. หัวหน้าแผนก', name: r.head_major_teacher_name, status: r.head_major_status, comment: r.head_major_comment, time: r.head_major_action_at },
    { label: '4. หัวหน้างานปกครอง', name: r.head_discipline_name, status: r.head_discipline_status, comment: r.head_discipline_comment, time: r.head_discipline_action_at },
    { label: '5. รอง ผอ. ฝ่ายกิจการฯ', name: r.deputy_director_name, status: r.deputy_director_status, comment: r.deputy_director_comment, time: r.deputy_director_action_at }
  ];

  const container = document.getElementById('approval-workflow-steps');
  container.innerHTML = steps.map(s => {
    let cls = 'step-item';
    let statusText = '⏳ รอพิจารณา';
    if (s.status === 'approved') { cls += ' done'; statusText = '✅ อนุมัติแล้ว'; }
    else if (s.status === 'rejected') { cls += ' rejected'; statusText = '❌ ไม่อนุมัติ'; }

    return `
      <div class="${cls}">
        <strong>${s.label}</strong><br>
        <span class="text-sm">${s.name || '-'}</span><br>
        <span style="font-weight: 600;">${statusText}</span>
        ${s.comment ? '<br><small class="text-muted">' + s.comment + '</small>' : ''}
      </div>
    `;
  }).join('');
}

function closeApprovalModal() {
  document.getElementById('approval-modal').style.display = 'none';
}

async function submitApprovalDecision(decision) {
  if (!state.currentUser || !state.currentReviewReq) return;

  const id = document.getElementById('approval-request-id').value;
  const roleActed = document.getElementById('approval-role-acted').value;
  const comment = document.getElementById('approval-comment').value.trim();

  const confirmMsg = decision === 'approve'
    ? 'คุณต้องการ "อนุมัติ" คำขอนี้ใช่หรือไม่?'
    : 'คุณต้องการ "ไม่อนุมัติ" คำขอนี้ใช่หรือไม่?';

  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/approvals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.currentUser.id,
        roleActed: roleActed,
        decision: decision,
        comment: comment
      })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'บันทึกการพิจารณาไม่สำเร็จ');
      return;
    }

    closeApprovalModal();
    showAlert(data.message, 'success');
    loadTeacherRequests();
    updateTeacherBadges();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ========================================================
// 5. DIGITAL PASS MODAL (QR Code)
// ========================================================

async function openPassModal(requestId) {
  try {
    const res = await fetch(`/api/requests/${requestId}`);
    const data = await res.json();

    if (!data.success) {
      alert('ไม่สามารถโหลดข้อมูลบัตรผ่านได้');
      return;
    }

    const r = data.request;
    state.currentPassData = r;

    document.getElementById('pass-no-text').textContent = r.request_no;
    document.getElementById('pass-token-text').textContent = `TOKEN: ${r.qr_token || r.request_no}`;

    // QR Image & Expiration Check (30 Minutes Rule)
    const now = new Date();
    const isExpired = (r.status === 'expired') || (r.qr_expires_at && new Date(r.qr_expires_at) < now && !r.gate_out_at);

    const qrImg = document.getElementById('pass-qr-image');
    const validTimeEl = document.getElementById('pass-valid-time');

    if (isExpired) {
      if (qrImg) qrImg.style.display = 'none';
      if (validTimeEl) {
        validTimeEl.innerHTML = `
          <div style="background:#fde8e8; border:1px solid #f8b4b4; border-radius:6px; padding:12px; margin-top:10px;">
            <span style="color:#c81e1e; font-weight:700; font-size:1.05rem;">❌ บัตรผ่านและ QR Code นี้หมดอายุแล้ว</span><br>
            <span style="color:#771d1d; font-size:0.9rem;">(เนื่องจากมีอายุใช้งาน 30 นาทีหลังได้รับอนุมัติ และเกินกำหนดเวลาแล้ว)<br>ระบบได้ทำการทำลายรหัส QR Code อัตโนมัติแล้ว ไม่สามารถสแกนได้ นักเรียนต้องยื่นขออนุญาตใหม่</span>
          </div>
        `;
      }
    } else {
      if (qrImg) {
        qrImg.style.display = 'block';
        if (r.qr_data_url) {
          qrImg.src = r.qr_data_url;
        } else {
          qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(r.qr_token || r.request_no)}`;
        }
      }
      const expTimeStr = r.qr_expires_at ? formatDateTime(r.qr_expires_at) : `${formatDate(r.leave_date)} ภายใน 30 นาที`;
      if (validTimeEl) {
        validTimeEl.innerHTML = `
          <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:6px; padding:10px; margin-top:10px;">
            ⏳ <strong>อายุการใช้งาน QR Code: 30 นาที</strong><br>
            <span style="color:#92400e; font-weight:600;">หมดอายุเวลา: ${expTimeStr}</span><br>
            <small class="text-muted">* หากไม่สแกนออกภายใน 30 นาที ระบบจะทำลาย QR Code อัตโนมัติและต้องขอใหม่</small>
          </div>
        `;
      }
    }

    const leaveTypeStr = r.is_not_returning ? 'ออกแล้วไม่กลับ (กลับบ้าน)' : 'ออกชั่วคราวแล้วจะกลับเข้ามา';

    document.getElementById('pass-student-info').innerHTML = `
      <p><strong>ชื่อ-สกุล:</strong> ${r.student_name} (รหัส: ${r.student_code})</p>
      <p><strong>ชั้น/แผนก:</strong> ${r.level_name || '-'} แผนก ${r.major_name || '-'} ${r.room ? 'ห้อง ' + r.room : ''}</p>
      <p><strong>วันที่ได้รับอนุญาต:</strong> ${formatDate(r.leave_date)} เวลา ${r.leave_time.slice(0, 5)} น.</p>
      <p><strong>ประเภท:</strong> ${leaveTypeStr}</p>
      <p><strong>เหตุผล:</strong> ${r.reason} ${r.reason_detail ? '(' + r.reason_detail + ')' : ''}</p>
      ${r.gate_out_at ? '<p style="color:#d35400;"><strong>เวลาออกจริง:</strong> ' + formatDateTime(r.gate_out_at) + '</p>' : ''}
      ${r.gate_in_at ? '<p style="color:#27ae60;"><strong>เวลากลับจริง:</strong> ' + formatDateTime(r.gate_in_at) + '</p>' : ''}
    `;

    document.getElementById('pass-approver-names').innerHTML = `
      <small>ได้รับการอนุมัติถูกต้องครบ 5 ระดับ (ครูรายวิชา, ครูที่ปรึกษา, หัวหน้าแผนก, หัวหน้างานปกครอง, รองผู้อำนวยการ)</small>
    `;

    document.getElementById('pass-modal').style.display = 'flex';
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

function closePassModal() {
  document.getElementById('pass-modal').style.display = 'none';
}

// ========================================================
// 6. GATE DUTY & SCANNER (หน้าประตูสถานศึกษา)
// ========================================================

async function handleVerifyGateToken() {
  const token = document.getElementById('gate-token-input').value.trim();
  if (!token) {
    alert('กรุณากรอกรหัส Token หรือเลขที่คำขอ เช่น OP-20261108-0001');
    return;
  }

  const resultBox = document.getElementById('gate-result-box');
  const banner = document.getElementById('gate-status-banner');
  const content = document.getElementById('gate-pass-content');

  try {
    const res = await fetch(`/api/gate/verify/${encodeURIComponent(token)}`);
    const data = await res.json();

    resultBox.style.display = 'block';

    if (!data.success) {
      banner.className = 'gate-banner invalid';
      banner.textContent = '❌ ' + (data.message || 'ไม่พบบัตรผ่านนี้');
      content.innerHTML = '<p class="text-center text-muted">กรุณาตรวจสอบรหัสบัตรผ่าน หรือให้นักเรียนแสดงคำขอที่ได้รับการอนุมัติแล้ว</p>';
      document.getElementById('gate-actions-bar').style.display = 'none';
      return;
    }

    const pass = data.pass;
    state.currentGatePass = pass;

    if (data.valid) {
      banner.className = 'gate-banner valid';
      banner.textContent = `✅ บัตรผ่านถูกต้อง ได้รับอนุมัติเรียบร้อย (สถานะ: ${pass.status === 'completed' ? 'สิ้นสุดแล้ว' : 'อนุญาตให้ออกได้'})`;
    } else {
      banner.className = 'gate-banner invalid';
      banner.textContent = `⚠️ บัตรผ่านยังไม่ได้รับอนุมัติสมบูรณ์ (สถานะ: ${pass.status})`;
    }

    const leaveTypeStr = pass.is_not_returning ? '<span style="color:#c0392b; font-weight:700;">ออกแล้วไม่กลับ</span>' : 'ออกชั่วคราว';

    content.innerHTML = `
      <div style="background:#fff; border:1px solid #dcdde1; border-radius:6px; padding:15px; margin-top:10px;">
        <h3 style="margin-bottom:10px;">ข้อมูลผู้ขออนุญาต: ${pass.student_name} (${pass.student_code})</h3>
        <p><strong>แผนกวิชา:</strong> ${pass.major_name || '-'} | <strong>ระดับชั้น:</strong> ${pass.level_name || '-'} ${pass.room ? 'ห้อง ' + pass.room : ''}</p>
        <p><strong>เบอร์โทรศัพท์ผู้เรียน:</strong> ${pass.student_phone || '-'}</p>
        <hr style="margin:10px 0; border:none; border-top:1px dashed #eee;">
        <p><strong>เลขที่คำขอ:</strong> <code>${pass.request_no}</code> | <strong>QR Token:</strong> <code>${pass.qr_token || '-'}</code></p>
        <p><strong>วัน-เวลาที่ขอออก:</strong> ${formatDate(pass.leave_date)} เวลา ${pass.leave_time.slice(0, 5)} น. (${leaveTypeStr})</p>
        <p><strong>เหตุผล:</strong> ${pass.reason} ${pass.reason_detail ? '(' + pass.reason_detail + ')' : ''}</p>
        <hr style="margin:10px 0; border:none; border-top:1px dashed #eee;">
        <p><strong>บันทึกเวลาออกจริง:</strong> ${pass.gate_out_at ? '<span style="color:#e67e22; font-weight:700;">' + formatDateTime(pass.gate_out_at) + '</span>' : '<span class="text-muted">ยังไม่ได้บันทึกเวลาออก</span>'}</p>
        <p><strong>บันทึกเวลากลับจริง:</strong> ${pass.gate_in_at ? '<span style="color:#27ae60; font-weight:700;">' + formatDateTime(pass.gate_in_at) + '</span>' : '<span class="text-muted">ยังไม่ได้บันทึกเวลากลับ</span>'}</p>
      </div>
    `;

    document.getElementById('gate-actions-bar').style.display = data.valid ? 'flex' : 'none';
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการตรวจสอบบัตรผ่าน: ' + err.message);
  }
}

async function handleGateCheckOut() {
  if (!state.currentGatePass) return;
  const requestId = state.currentGatePass.id;

  if (!confirm('ยืนยันบันทึกเวลา "ออกจากสถานศึกษา" สำหรับนักเรียนคนนี้?')) return;

  try {
    const res = await fetch('/api/gate/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requestId,
        guardUserId: state.currentUser ? state.currentUser.id : 1
      })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'บันทึกเวลาออกไม่สำเร็จ');
      return;
    }

    alert('บันทึกเวลาออกเรียบร้อยแล้ว: ' + formatDateTime(data.gate_out_at));
    handleVerifyGateToken(); // Refresh verification screen
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleGateCheckIn() {
  if (!state.currentGatePass) return;
  const requestId = state.currentGatePass.id;

  if (!confirm('ยืนยันบันทึกเวลา "กลับเข้าสถานศึกษา" (สิ้นสุดคำขอ)?')) return;

  try {
    const res = await fetch('/api/gate/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requestId,
        guardUserId: state.currentUser ? state.currentUser.id : 1
      })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'บันทึกเวลากลับไม่สำเร็จ');
      return;
    }

    alert('บันทึกเวลากลับเรียบร้อยแล้ว: ' + formatDateTime(data.gate_in_at));
    handleVerifyGateToken(); // Refresh verification screen
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ========================================================
// 5.5 ESP32 SMART GATE HARDWARE MONITOR & REMOTE CONTROL
// ========================================================

async function loadEsp32Status() {
  const badge = document.getElementById('esp32-status-badge');
  const ipEl = document.getElementById('esp32-wifi-ip');
  const usEl = document.getElementById('esp32-ultrasonic-dist');
  const qrEl = document.getElementById('esp32-qr-state');
  const seenEl = document.getElementById('esp32-last-seen');

  if (!badge) return;

  try {
    const res = await fetch('/api/device/status');
    const data = await res.json();
    if (!data.success) return;

    const dev = data.device;
    if (dev.online) {
      badge.textContent = '🟢 ออนไลน์ (เชื่อมต่อปกติ)';
      badge.style.background = '#27ae60';
    } else {
      badge.textContent = '🔴 ออฟไลน์ (รอเชื่อมต่อ)';
      badge.style.background = '#e74c3c';
    }

    if (ipEl) ipEl.textContent = dev.wifi ? `เชื่อมต่อแล้ว (${dev.wifi_ip || '-'})` : 'ไม่ได้เชื่อมต่อ WiFi';
    if (usEl) usEl.textContent = dev.ultrasonic ? `${dev.ultrasonic_distance} ซม. (ตรวจพบวัตถุ)` : (dev.ultrasonic_distance === -1 ? 'ไม่พบวัตถุ / นอกระยะ' : 'ยังไม่มีข้อมูล');
    if (qrEl) qrEl.textContent = dev.qr_connected ? 'พร้อมใช้งาน (สื่อสาร UART2 แล้ว)' : 'รอสแกนบัตรครั้งแรก';
    if (seenEl) seenEl.textContent = dev.lastSeenThai || '-';
  } catch (e) {
    if (badge) {
      badge.textContent = '⚠️ เกิดข้อผิดพลาดในการโหลดสถานะ';
      badge.style.background = '#e67e22';
    }
  }
}

async function handleTriggerOpenGate() {
  if (!confirm('ยืนยันส่งคำสั่ง "ยกไม้กั้น" (OPEN_TEST) ไปยังบอร์ด ESP32 ที่ตู้ประตู?')) return;
  try {
    const res = await fetch('/api/device/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'OPEN_TEST' })
    });
    const data = await res.json();
    alert(data.message || 'ส่งคำสั่งเปิดไม้กั้นเรียบร้อยแล้ว');
    loadEsp32Status();
  } catch (err) {
    alert('เกิดข้อผิดพลาดในการส่งคำสั่ง: ' + err.message);
  }
}

// ========================================================
// 7. UTILITY HELPERS
// ========================================================

function getStatusBadge(status) {
  const map = {
    pending_subject: { label: '1. รอครูรายวิชา', cls: 'status-pending' },
    pending_advisor: { label: '2. รอครูที่ปรึกษา', cls: 'status-pending' },
    pending_head_major: { label: '3. รอหัวหน้าแผนก', cls: 'status-pending' },
    pending_head_discipline: { label: '4. รอหัวหน้างานปกครอง', cls: 'status-pending' },
    pending_deputy: { label: '5. รอรอง ผอ.', cls: 'status-pending' },
    approved: { label: 'อนุมัติแล้ว (มีบัตรผ่าน)', cls: 'status-approved' },
    rejected: { label: 'ไม่อนุมัติ', cls: 'status-rejected' },
    completed: { label: 'เสร็จสิ้น (กลับเข้าแล้ว)', cls: 'status-completed' },
    expired: { label: 'หมดอายุ (เกิน 30 นาที)', cls: 'status-rejected' },
    cancelled: { label: 'ยกเลิกแล้ว', cls: 'status-cancelled' }
  };
  const item = map[status] || { label: status, cls: 'status-pending' };
  return `<span class="status-badge ${item.cls}">${item.label}</span>`;
}

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const parts = String(dateStr).split('T')[0].split(' ')[0].split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d) && m >= 0 && m < 12) {
      return `${d} ${THAI_MONTHS_SHORT[m]} ${y + 543}`;
    }
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()} ${THAI_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + 543}`;
}

function formatDateTime(dateTimeStr) {
  if (!dateTimeStr) return '-';
  const d = new Date(dateTimeStr);
  if (isNaN(d.getTime())) return dateTimeStr;
  const datePart = formatDate(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${datePart} เวลา ${hours}:${minutes} น.`;
}

// ========================================================
// 8. ADMIN DASHBOARD & MANAGEMENT (จัดการผู้ใช้, กำหนดภาคเรียน, กำหนดหัวหน้าแผนก, ครูที่ปรึกษา)
// ========================================================

let adminMetadata = null;

async function loadAdminMetadata() {
  try {
    const res = await fetch('/api/admin/metadata');
    const data = await res.json();
    if (data.success) {
      adminMetadata = data;

      // Populate Dropdowns for User CRUD (Level & Major)
      const crudLevel = document.getElementById('crud-level');
      const crudMajor = document.getElementById('crud-major');
      if (crudLevel && crudMajor) {
        crudLevel.innerHTML = '<option value="">-- เลือกระดับชั้น --</option>';
        data.levels.forEach(l => {
          crudLevel.innerHTML += `<option value="${l.id}">${l.name}</option>`;
        });

        crudMajor.innerHTML = '<option value="">-- เลือกแผนกวิชา --</option>';
        data.majors.forEach(m => {
          crudMajor.innerHTML += `<option value="${m.id}">${m.name}</option>`;
        });
      }

      // Populate Dropdowns for Add Advisor Form
      const advLvl = document.getElementById('adv-select-level');
      const advMaj = document.getElementById('adv-select-major');
      const advTch = document.getElementById('adv-select-teacher');
      if (advLvl && advMaj && advTch) {
        advLvl.innerHTML = '<option value="">-- เลือกระดับชั้น --</option>';
        data.levels.forEach(l => { advLvl.innerHTML += `<option value="${l.id}">${l.name}</option>`; });

        advMaj.innerHTML = '<option value="">-- เลือกแผนกวิชา --</option>';
        data.majors.forEach(m => { advMaj.innerHTML += `<option value="${m.id}">${m.name}</option>`; });

        advTch.innerHTML = '<option value="">-- เลือกครูที่ปรึกษา --</option>';
        data.teachers.forEach(t => { advTch.innerHTML += `<option value="${t.id}">${t.full_name} (${t.position || t.role})</option>`; });
      }
    }
  } catch (err) {
    console.error('Error loading admin metadata:', err);
  }
}

function toggleStudentCrudSection(isStudent) {
  const stdSec = document.getElementById('crud-student-section');
  const tchSec = document.getElementById('crud-teacher-section');
  if (stdSec) stdSec.style.display = isStudent ? 'block' : 'none';
  if (tchSec) tchSec.style.display = isStudent ? 'none' : 'block';
}

function switchAdminTab(tabName) {
  state.activeAdminTab = tabName;
  const tabs = ['tracker', 'users', 'majors', 'advisors', 'term', 'duty', 'telegram'];
  tabs.forEach(t => {
    const el = document.getElementById(`admin-tab-${t}`);
    if (el) el.style.display = (t === tabName) ? 'block' : 'none';
  });

  if (tabName === 'tracker') loadAdminTracker();
  else if (tabName === 'users') loadAdminUsers();
  else if (tabName === 'majors') loadAdminMajors();
  else if (tabName === 'advisors') loadAdminAdvisors();
  else if (tabName === 'term' || tabName === 'duty' || tabName === 'telegram') loadAdminSettings();
}

async function loadAdminDashboard() {
  await loadAdminMetadata();
  await loadAdminStats();
  switchAdminTab(state.activeAdminTab || 'tracker');
}

async function loadAdminStats() {
  try {
    const res = await fetch('/api/admin/stats');
    const data = await res.json();
    if (!data.success) return;

    const s = data.stats;
    document.getElementById('stat-total-today').textContent = s.total_today || 0;
    document.getElementById('stat-pending').textContent = s.pending_count || 0;
    document.getElementById('stat-approved').textContent = s.approved_count || 0;
    document.getElementById('stat-out').textContent = s.currently_out_count || 0;
    document.getElementById('stat-completed').textContent = s.completed_count || 0;
    document.getElementById('stat-total-users').textContent = s.total_users || 0;
  } catch (err) {
    console.error('Error loading admin stats:', err);
  }
}

// -------------------------------------------------------------
// TAB 1: Live Status Tracker
// -------------------------------------------------------------
async function loadAdminTracker() {
  const tbody = document.querySelector('#admin-tracker-table tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">กำลังโหลดรายการ...</td></tr>';

  const search = document.getElementById('admin-tracker-search') ? document.getElementById('admin-tracker-search').value.trim() : '';
  const status = document.getElementById('admin-tracker-status') ? document.getElementById('admin-tracker-status').value : '';

  try {
    let url = '/api/requests?role=admin';
    if (status) url += `&status=${status}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.success || data.requests.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">ไม่พบรายการคำขอตามเงื่อนไขที่เลือก</td></tr>';
      return;
    }

    let filtered = data.requests;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(r => 
        (r.student_name && r.student_name.toLowerCase().includes(q)) ||
        (r.student_code && r.student_code.toLowerCase().includes(q)) ||
        (r.request_no && r.request_no.toLowerCase().includes(q))
      );
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">ไม่พบรายการคำขอที่ค้นหา</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach(r => {
      const statusBadge = getStatusBadge(r.status);
      let gateStatus = '<span class="text-muted text-sm">ยังไม่ออก</span>';
      if (r.gate_out_at && !r.gate_in_at) {
        gateStatus = `<span style="color:#e67e22; font-weight:700;">อยู่นอก (ออก ${formatDateTime(r.gate_out_at)})</span>`;
      } else if (r.gate_in_at) {
        gateStatus = `<span style="color:#27ae60; font-weight:700;">กลับเข้าแล้ว (${formatDateTime(r.gate_in_at)})</span>`;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.request_no}</strong></td>
        <td>
          <strong>${r.student_name}</strong> (${r.student_code})<br>
          <span class="text-muted text-sm">${r.level_name || ''} ${r.major_name || ''} ${r.room ? 'ห้อง ' + r.room : ''}</span>
        </td>
        <td>${formatDate(r.leave_date)} ${r.leave_time.slice(0, 5)} น.</td>
        <td>${r.reason}</td>
        <td>${statusBadge}</td>
        <td>${gateStatus}</td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-primary" onclick="openApprovalModal(${r.id}, true)">👁️ ดูรายละเอียด</button>
          ${r.status === 'approved' || r.status === 'completed' ? `<button type="button" class="btn btn-sm btn-success" onclick="openPassModal(${r.id})" style="margin-left:5px;">🎫 บัตรผ่าน</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

// -------------------------------------------------------------
// TAB 2: User Management (Detailed Edit & Create)
// -------------------------------------------------------------
async function loadAdminUsers() {
  const tbody = document.querySelector('#admin-users-table tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">กำลังโหลดรายชื่อผู้ใช้...</td></tr>';

  const search = document.getElementById('admin-user-search') ? document.getElementById('admin-user-search').value.trim() : '';
  const role = document.getElementById('admin-user-role-filter') ? document.getElementById('admin-user-role-filter').value : 'all';

  try {
    let url = `/api/admin/users?role=${role}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data.success || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">ไม่พบผู้ใช้งานตามเงื่อนไข</td></tr>';
      return;
    }

    const roleBadges = {
      student: '<span class="status-badge" style="background:#e8f4fd; color:#1976d2;">ผู้เรียน</span>',
      teacher: '<span class="status-badge" style="background:#fef9e7; color:#f39c12;">ครู</span>',
      deputy_director: '<span class="status-badge" style="background:#f4fbf7; color:#27ae60;">รอง ผอ.</span>',
      admin: '<span class="status-badge" style="background:#fdf2e9; color:#d35400;">แอดมิน</span>',
      super_admin: '<span class="status-badge" style="background:#f5eef8; color:#8e44ad;">แอดมินสูงสุด</span>'
    };

    const statusLabels = {
      studying: '<span style="color:#27ae60;">กำลังศึกษา</span>',
      on_leave: '<span style="color:#f39c12;">ลาพักการเรียน</span>',
      withdrawn: '<span style="color:#c0392b;">พ้นสภาพ</span>',
      graduated: '<span style="color:#2980b9;">สำเร็จการศึกษา</span>'
    };

    tbody.innerHTML = '';
    data.users.forEach(u => {
      const roleBadge = roleBadges[u.role] || u.role;
      let extraInfo = '';
      if (u.role === 'student') {
        const stdStatus = statusLabels[u.student_status] || 'กำลังศึกษา';
        extraInfo = `${u.level_name || ''} ${u.major_name || ''} ${u.room ? '(' + u.room + ')' : ''} | ${stdStatus}`;
      } else {
        extraInfo = u.position || '-';
      }

      const passStatus = u.must_change_password === 1
        ? '<span style="color:#e74c3c; font-size:0.8rem;">⚠️ ต้องเปลี่ยนรหัส</span>'
        : '<span style="color:#27ae60; font-size:0.8rem;">เปลี่ยนแล้ว</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${u.username}</code></td>
        <td><strong>${u.full_name}</strong></td>
        <td>${roleBadge}</td>
        <td><small class="text-muted">${extraInfo}</small></td>
        <td><code>${u.telegram_chat_id || '-'}</code></td>
        <td>${passStatus}</td>
        <td>
          <button type="button" class="btn btn-sm btn-warning" onclick="handleAdminResetPassword(${u.id}, '${escapeQuotes(u.full_name)}')" title="รีเซ็ตเป็น 123456">🔑 รีเซ็ตรหัส</button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="openEditUserModal(${u.id})" style="margin-left:4px;">✏️ แก้ไขข้อมูล</button>
          <button type="button" class="btn btn-sm btn-danger" onclick="handleAdminDeleteUser(${u.id}, '${escapeQuotes(u.full_name)}')" style="margin-left:4px;">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

function escapeQuotes(str) {
  return (str || '').replace(/'/g, "\\'");
}

// User CRUD Modal
function openCreateUserModal() {
  document.getElementById('user-modal-title').textContent = 'เพิ่มผู้ใช้งานใหม่';
  document.getElementById('crud-user-id').value = '';
  document.getElementById('crud-username').value = '';
  document.getElementById('crud-username').readOnly = false;
  document.getElementById('crud-fullname').value = '';
  document.getElementById('crud-role').value = 'student';
  document.getElementById('crud-prefix').value = '';
  document.getElementById('crud-firstname').value = '';
  document.getElementById('crud-lastname').value = '';
  document.getElementById('crud-phone').value = '';
  document.getElementById('crud-status').value = 'studying';
  document.getElementById('crud-level').value = '';
  document.getElementById('crud-major').value = '';
  document.getElementById('crud-room').value = '';
  document.getElementById('crud-father-phone').value = '';
  document.getElementById('crud-mother-phone').value = '';
  document.getElementById('crud-position').value = '';
  document.getElementById('crud-email').value = '';
  document.getElementById('crud-telegram').value = '';
  document.getElementById('crud-pass-hint').style.display = 'block';

  toggleStudentCrudSection(true);
  document.getElementById('user-modal').style.display = 'flex';
}

async function openEditUserModal(userId) {
  try {
    const res = await fetch(`/api/admin/users/${userId}`);
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'ไม่สามารถโหลดข้อมูลผู้ใช้ได้');
      return;
    }

    const u = data.user;
    const s = data.student || {};
    const p = data.profile || {};

    document.getElementById('user-modal-title').textContent = `แก้ไขข้อมูลผู้ใช้: ${u.full_name} (${u.username})`;
    document.getElementById('crud-user-id').value = u.id;
    document.getElementById('crud-username').value = u.username;
    document.getElementById('crud-username').readOnly = true;
    document.getElementById('crud-fullname').value = u.full_name;
    document.getElementById('crud-role').value = u.role;
    document.getElementById('crud-position').value = u.position || '';
    document.getElementById('crud-email').value = u.email || '';
    document.getElementById('crud-telegram').value = u.telegram_chat_id || '';
    document.getElementById('crud-pass-hint').style.display = 'none';

    // Student fields
    const isStudent = (u.role === 'student');
    toggleStudentCrudSection(isStudent);

    document.getElementById('crud-prefix').value = p.prefix_th || '';
    document.getElementById('crud-firstname').value = p.first_name_th || '';
    document.getElementById('crud-lastname').value = p.last_name_th || '';
    document.getElementById('crud-phone').value = s.phone || '';
    document.getElementById('crud-status').value = s.student_status || 'studying';
    document.getElementById('crud-level').value = s.level_id || '';
    document.getElementById('crud-major').value = s.major_id || '';
    document.getElementById('crud-room').value = s.room || '';
    document.getElementById('crud-father-phone').value = p.father_phone || '';
    document.getElementById('crud-mother-phone').value = p.mother_phone || '';

    document.getElementById('user-modal').style.display = 'flex';
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

function closeUserModal() {
  document.getElementById('user-modal').style.display = 'none';
}

async function handleUserCrudSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('crud-user-id').value;
  const username = document.getElementById('crud-username').value.trim();
  const fullName = document.getElementById('crud-fullname').value.trim();
  const role = document.getElementById('crud-role').value;
  const position = document.getElementById('crud-position').value.trim();
  const email = document.getElementById('crud-email').value.trim();
  const telegramChatId = document.getElementById('crud-telegram').value.trim();

  // Student specific
  const prefix_th = document.getElementById('crud-prefix').value.trim();
  const first_name_th = document.getElementById('crud-firstname').value.trim();
  const last_name_th = document.getElementById('crud-lastname').value.trim();
  const phone = document.getElementById('crud-phone').value.trim();
  const student_status = document.getElementById('crud-status').value;
  const level_id = document.getElementById('crud-level').value;
  const major_id = document.getElementById('crud-major').value;
  const room = document.getElementById('crud-room').value.trim();
  const father_phone = document.getElementById('crud-father-phone').value.trim();
  const mother_phone = document.getElementById('crud-mother-phone').value.trim();

  const payload = {
    username,
    full_name: fullName,
    role,
    position,
    email,
    telegram_chat_id: telegramChatId,
    prefix_th,
    first_name_th,
    last_name_th,
    phone,
    student_status,
    level_id: level_id ? parseInt(level_id, 10) : null,
    major_id: major_id ? parseInt(major_id, 10) : null,
    room,
    father_phone,
    mother_phone
  };

  try {
    const isEdit = Boolean(userId);
    const url = isEdit ? `/api/admin/users/${userId}` : '/api/admin/users';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'บันทึกไม่สำเร็จ');
      return;
    }

    closeUserModal();
    showAlert(data.message, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleAdminResetPassword(userId, name) {
  if (!confirm(`ยืนยันการรีเซ็ตรหัสผ่านของ "${name}" ให้กลับเป็น "123456" และบังคับเปลี่ยนรหัสผ่านเมื่อใช้งานครั้งต่อไป?`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}/reset-password`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'รีเซ็ตรหัสผ่านไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminUsers();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleAdminDeleteUser(userId, name) {
  if (!confirm(`⚠️ ยืนยันการลบผู้ใช้ "${name}" ออกจากระบบ? (การกระทำนี้ไม่สามารถย้อนกลับได้)`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'ลบไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// -------------------------------------------------------------
// TAB 3: Assign Head of Department (กำหนดหัวหน้าแผนก)
// -------------------------------------------------------------
async function loadAdminMajors() {
  const tbody = document.querySelector('#admin-majors-table tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center">กำลังโหลดข้อมูลแผนกวิชา...</td></tr>';

  try {
    const res = await fetch('/api/admin/majors');
    const data = await res.json();
    if (!data.success || data.majors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">ไม่พบข้อมูลแผนกวิชา</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.majors.forEach(m => {
      let teacherOptions = '<option value="">-- ยังไม่มีหัวหน้าแผนก --</option>';
      data.teachers.forEach(t => {
        const isSel = (t.id == m.head_teacher_id) ? 'selected' : '';
        teacherOptions += `<option value="${t.id}" ${isSel}>${t.full_name} (${t.position || 'ครู'})</option>`;
      });

      const currentHead = m.head_teacher_name
        ? `<strong style="color:#27ae60;">${m.head_teacher_name}</strong> (${m.head_teacher_position || 'ครู'})`
        : '<span class="text-muted">ยังไม่ได้กำหนด</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>#${m.id}</strong></td>
        <td><strong>${m.name}</strong></td>
        <td>${currentHead}</td>
        <td>
          <select id="select-major-head-${m.id}" class="form-control" style="max-width:320px;">
            ${teacherOptions}
          </select>
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-success" onclick="handleSaveMajorHead(${m.id})">💾 บันทึกหัวหน้าแผนก</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

async function handleSaveMajorHead(majorId) {
  const select = document.getElementById(`select-major-head-${majorId}`);
  const headTeacherId = select ? select.value : null;

  try {
    const res = await fetch(`/api/admin/majors/${majorId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ head_teacher_id: headTeacherId })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'บันทึกไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminMajors();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// -------------------------------------------------------------
// TAB 4: Assign Advisor Teachers (กำหนดครูที่ปรึกษา)
// -------------------------------------------------------------
async function loadAdminAdvisors() {
  const tbody = document.querySelector('#admin-advisors-table tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center">กำลังโหลดรายการครูที่ปรึกษา...</td></tr>';

  try {
    const res = await fetch('/api/admin/advisors');
    const data = await res.json();
    if (!data.success || data.advisors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">ยังไม่มีการกำหนดครูที่ปรึกษา</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.advisors.forEach(a => {
      let teacherOptions = '';
      data.teachers.forEach(t => {
        const isSel = (t.id == a.teacher_id) ? 'selected' : '';
        teacherOptions += `<option value="${t.id}" ${isSel}>${t.full_name} (${t.position || 'ครู'})</option>`;
      });

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="status-badge" style="background:#e8f4fd; color:#1976d2;">${a.level_name}</span></td>
        <td><strong>${a.major_name}</strong></td>
        <td><strong>${a.teacher_name}</strong> (${a.teacher_position || 'ครู'})</td>
        <td>
          <select id="select-advisor-teacher-${a.id}" class="form-control" style="max-width:320px;">
            ${teacherOptions}
          </select>
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-primary" onclick="handleUpdateAdvisor(${a.id})">💾 อัปเดต</button>
          <button type="button" class="btn btn-sm btn-danger" onclick="handleDeleteAdvisor(${a.id})" style="margin-left:4px;">🗑️ ลบ</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
  }
}

async function handleAddAdvisorSubmit(e) {
  e.preventDefault();
  const level_id = document.getElementById('adv-select-level').value;
  const major_id = document.getElementById('adv-select-major').value;
  const teacher_id = document.getElementById('adv-select-teacher').value;

  if (!level_id || !major_id || !teacher_id) {
    alert('กรุณาเลือกระดับชั้น แผนกวิชา และครูที่ปรึกษาให้ครบถ้วน');
    return;
  }

  try {
    const res = await fetch('/api/admin/advisors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level_id, major_id, teacher_id })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'เพิ่มไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminAdvisors();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleUpdateAdvisor(assignmentId) {
  const select = document.getElementById(`select-advisor-teacher-${assignmentId}`);
  const teacherId = select ? select.value : null;

  try {
    const res = await fetch(`/api/admin/advisors/${assignmentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teacher_id: teacherId })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'อัปเดตไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminAdvisors();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleDeleteAdvisor(assignmentId) {
  if (!confirm('ยืนยันลบการมอบหมายครูที่ปรึกษารายการนี้?')) return;

  try {
    const res = await fetch(`/api/admin/advisors/${assignmentId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'ลบไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminAdvisors();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// -------------------------------------------------------------
// TAB 5, 6, 7: Settings (Term, Gate Duty, Telegram)
// -------------------------------------------------------------
async function loadAdminSettings() {
  try {
    const res = await fetch('/api/admin/settings');
    const data = await res.json();
    if (!data.success) return;

    // 1. Term
    if (data.term) {
      document.getElementById('admin-academic-year').value = data.term.academic_year || '2569';
      document.getElementById('admin-semester').value = data.term.semester || '2';
    }

    // 2. Gate Duty dropdowns
    const discSelect = document.getElementById('admin-select-discipline');
    const depSelect = document.getElementById('admin-select-deputy');

    if (discSelect && depSelect && data.teachers) {
      discSelect.innerHTML = '<option value="">-- เลือกครูผู้รับผิดชอบงานปกครอง --</option>';
      depSelect.innerHTML = '<option value="">-- เลือกรองผู้อำนวยการ --</option>';

      data.teachers.forEach(t => {
        discSelect.innerHTML += `<option value="${t.id}">${t.full_name} [${t.username}] (${t.position || t.role})</option>`;
        depSelect.innerHTML += `<option value="${t.id}">${t.full_name} [${t.username}] (${t.position || t.role})</option>`;
      });

      if (data.gate_duty) {
        if (data.gate_duty.head_of_discipline_user_id) {
          discSelect.value = data.gate_duty.head_of_discipline_user_id;
        }
        if (data.gate_duty.deputy_director_user_id) {
          depSelect.value = data.gate_duty.deputy_director_user_id;
        }
      }
    }

    // 3. Telegram Settings
    if (data.telegram) {
      document.getElementById('admin-telegram-token').value = data.telegram.bot_token || '';
      document.getElementById('admin-telegram-chatid').value = data.telegram.chat_id || '';
    }
  } catch (err) {
    console.error('Error loading admin settings:', err);
  }
}

async function handleAdminTermSubmit(e) {
  e.preventDefault();
  const year = document.getElementById('admin-academic-year').value.trim();
  const semester = document.getElementById('admin-semester').value;

  try {
    const res = await fetch('/api/admin/settings/term', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ academic_year: year, semester: semester })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'บันทึกไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
    loadAdminStats();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleAdminDutySubmit(e) {
  e.preventDefault();
  const discId = document.getElementById('admin-select-discipline').value;
  const depId = document.getElementById('admin-select-deputy').value;

  if (!discId || !depId) {
    alert('กรุณาเลือกทั้งหัวหน้างานปกครองและรองผู้อำนวยการ');
    return;
  }

  try {
    const res = await fetch('/api/admin/settings/gate-duty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        head_of_discipline_user_id: parseInt(discId, 10),
        deputy_director_user_id: parseInt(depId, 10)
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'บันทึกไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

async function handleAdminTelegramSubmit(e) {
  e.preventDefault();
  const botToken = document.getElementById('admin-telegram-token').value.trim();
  const chatId = document.getElementById('admin-telegram-chatid').value.trim();
  const testSend = document.getElementById('admin-telegram-test-send').checked;

  try {
    const res = await fetch('/api/admin/settings/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_token: botToken,
        chat_id: chatId,
        test_send: testSend
      })
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || 'บันทึกไม่สำเร็จ');
      return;
    }
    showAlert(data.message, 'success');
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// Expose modal openers & admin actions to global window for inline onclick handlers
window.openApprovalModal = openApprovalModal;
window.openPassModal = openPassModal;
window.openEditUserModal = openEditUserModal;
window.handleAdminResetPassword = handleAdminResetPassword;
window.handleAdminDeleteUser = handleAdminDeleteUser;
window.handleSaveMajorHead = handleSaveMajorHead;
window.handleUpdateAdvisor = handleUpdateAdvisor;
window.handleDeleteAdvisor = handleDeleteAdvisor;
