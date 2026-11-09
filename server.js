/**
 * OnePass Server - Node.js Express Application
 * Database: MySQL (Local XAMPP & Production Plesk)
 * No PHP used - Pure JavaScript Backend & Frontend
 */

process.on('uncaughtException', (err) => {
  console.error('[Process Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Unhandled Rejection]:', reason);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const telegram = require('./telegram');
const { pool, initDatabase, query } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to build full user profile with their specific duties
async function buildUserProfile(user) {
  const uid = user.id;
  const role = user.role;

  const isStudent = (role === 'student');
  const isTeacherRole = ['teacher', 'advisor', 'subject_teacher', 'head_major', 'head_discipline'].includes(role);
  const isDeputy = (role === 'deputy_director');
  const isAdmin = ['admin', 'super_admin'].includes(role);

  const profile = {
    id: uid,
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    role: role,
    position: user.position,
    photo_url: user.photo_url,
    is_student: isStudent,
    is_teacher: isTeacherRole,
    is_deputy_director: isDeputy,
    is_director: role === 'director',
    is_admin: isAdmin,
    roles_held: []
  };

  if (isStudent) {
    try {
      const [students] = await query(`
        SELECT s.*, l.name AS level_name, m.name AS major_name
        FROM students s
        LEFT JOIN levels l ON s.level_id = l.id
        LEFT JOIN majors m ON s.major_id = m.id
        WHERE s.user_id = ?
        LIMIT 1
      `, [uid]);

      if (students && students.length > 0) {
        const student = students[0];
        profile.student_id = student.id;
        profile.student_code = student.student_code;
        profile.level_id = student.level_id;
        profile.major_id = student.major_id;
        profile.level_name = student.level_name;
        profile.major_name = student.major_name;
        profile.room = student.room;
      }
    } catch (e) {
      console.warn('[Profile Warning] student query:', e.message);
    }
    profile.roles_held.push('student');
  }

  if (isTeacherRole) {
    profile.roles_held.push('subject_teacher'); // All teachers can act as subject teacher

    // 1. Advisor check
    try {
      const [advised] = await query(`
        SELECT aa.id, aa.level_id, aa.major_id, l.name AS level_name, m.name AS major_name
        FROM advisor_assignments aa
        JOIN levels l ON aa.level_id = l.id
        JOIN majors m ON aa.major_id = m.id
        WHERE aa.teacher_id = ?
      `, [uid]);
      profile.is_advisor = (advised && advised.length > 0) || (role === 'advisor');
      profile.advised_classes = advised || [];
      if (profile.is_advisor) profile.roles_held.push('advisor');
    } catch (e) {
      if (role === 'advisor') {
        profile.is_advisor = true;
        profile.roles_held.push('advisor');
      }
    }

    // 2. Head of Major check
    try {
      const [majors] = await query(`
        SELECT id, name FROM majors WHERE head_teacher_id = ?
      `, [uid]);
      profile.is_head_major = majors && majors.length > 0;
      profile.managed_majors = majors || [];
      if (profile.is_head_major) profile.roles_held.push('head_major');
    } catch (e) {}

    // 3. Head of Discipline check
    try {
      const [discipline] = await query(`
        SELECT head_of_discipline_user_id FROM gate_duty_assignments WHERE head_of_discipline_user_id = ? LIMIT 1
      `, [uid]);
      profile.is_head_discipline = discipline && discipline.length > 0;
      if (profile.is_head_discipline) profile.roles_held.push('head_discipline');
    } catch (e) {}

    // 4. Deputy Director check
    try {
      const [deputy] = await query(`
        SELECT deputy_director_user_id FROM gate_duty_assignments WHERE deputy_director_user_id = ? LIMIT 1
      `, [uid]);
      if (deputy && deputy.length > 0) {
        profile.is_deputy_director = true;
        profile.roles_held.push('deputy_director');
      }
    } catch (e) {}
  }

  if (isDeputy) {
    profile.is_deputy_director = true;
    profile.roles_held.push('deputy_director');
  }

  if (isAdmin) {
    profile.roles_held = ['student', 'subject_teacher', 'advisor', 'head_major', 'head_discipline', 'deputy_director', 'gate_staff', 'admin'];
    profile.is_advisor = true;
    profile.is_head_major = true;
    profile.is_head_discipline = true;
    profile.is_deputy_director = true;
  }

  return profile;
}

// ==========================================
// 1. AUTH ROUTES
// ==========================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    const [users] = await query('SELECT * FROM users WHERE username = ? LIMIT 1', [username.trim()]);
    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบบัญชีผู้ใช้นี้ในระบบ' });
    }

    const user = users[0];
    const isDefaultPassword = (password === '123456');
    let isHashMatch = false;

    try {
      if (user.password_hash) {
        isHashMatch = bcrypt.compareSync(password, user.password_hash);
      }
    } catch (e) {
      isHashMatch = false;
    }

    // Support fallback plaintext match if password column exists in legacy schemas
    const isPlainMatch = (user.password && user.password === password) || (user.password_hash && user.password_hash === password);

    if (!isDefaultPassword && !isHashMatch && !isPlainMatch) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    // Only force password change if the column must_change_password explicitly equals 1
    // (Does NOT block users when logging in with 123456)
    if (user.must_change_password === 1) {
      return res.json({
        success: true,
        must_change_password: true,
        user_id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
        message: 'กรุณาเปลี่ยนรหัสผ่านใหม่ก่อนเริ่มใช้งาน'
      });
    }

    // Normal direct login
    const fullProfile = await buildUserProfile(user);
    res.json({
      success: true,
      must_change_password: false,
      message: 'เข้าสู่ระบบสำเร็จ',
      user: fullProfile
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// Mandatory First-time Password Change
app.post('/api/auth/change-password-first-time', async (req, res) => {
  try {
    const { user_id, new_password, confirm_password } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'ข้อมูลผู้ใช้ไม่ถูกต้อง' });
    }
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร' });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่และการยืนยันไม่ตรงกัน' });
    }
    if (new_password === '123456') {
      return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเริ่มต้น (123456)' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(new_password, salt);

    try {
      await query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hash, user_id]);
    } catch (colErr) {
      // Fallback if must_change_password column does not exist
      await query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user_id]);
    }

    const [users] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [user_id]);
    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้' });
    }
    const fullProfile = await buildUserProfile(users[0]);

    res.json({
      success: true,
      must_change_password: false,
      message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว ยินดีต้อนรับเข้าสู่ระบบ OnePass',
      user: fullProfile
    });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// Helper endpoint: Get sample test accounts for each role
app.get('/api/auth/test-accounts', async (req, res) => {
  try {
    // 1. Student
    const [students] = await query(`
      SELECT u.id, u.username, u.full_name, 'student' AS test_role, 'ผู้เรียน' AS role_label,
             l.name AS level_name, m.name AS major_name
      FROM users u
      JOIN students s ON u.id = s.user_id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      LIMIT 2
    `);

    // 2. Teachers / Roles
    // Subject teacher
    const [subjectTeachers] = await query(`
      SELECT id, username, full_name, 'subject_teacher' AS test_role, 'ครูรายวิชา' AS role_label
      FROM users WHERE role = 'teacher' LIMIT 2
    `);

    // Advisor
    const [advisors] = await query(`
      SELECT DISTINCT u.id, u.username, u.full_name, 'advisor' AS test_role, 'ครูที่ปรึกษา' AS role_label,
             l.name AS level_name, m.name AS major_name
      FROM advisor_assignments aa
      JOIN users u ON aa.teacher_id = u.id
      LEFT JOIN levels l ON aa.level_id = l.id
      LEFT JOIN majors m ON aa.major_id = m.id
      LIMIT 2
    `);

    // Head of Major
    const [heads] = await query(`
      SELECT u.id, u.username, u.full_name, 'head_major' AS test_role, 'หัวหน้าแผนก' AS role_label,
             m.name AS major_name
      FROM majors m
      JOIN users u ON m.head_teacher_id = u.id
      LIMIT 2
    `);

    // Head of Discipline
    const [discipline] = await query(`
      SELECT u.id, u.username, u.full_name, 'head_discipline' AS test_role, 'หัวหน้างานปกครอง' AS role_label
      FROM gate_duty_assignments g
      JOIN users u ON g.head_of_discipline_user_id = u.id
      LIMIT 1
    `);

    // Deputy Director
    const [deputy] = await query(`
      SELECT u.id, u.username, u.full_name, 'deputy_director' AS test_role, 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา' AS role_label
      FROM users u
      WHERE u.role = 'deputy_director' OR u.id IN (SELECT deputy_director_user_id FROM gate_duty_assignments)
      LIMIT 2
    `);

    res.json({
      success: true,
      default_password: '123456',
      accounts: {
        student: students,
        subject_teacher: subjectTeachers,
        advisor: advisors,
        head_major: heads,
        head_discipline: discipline,
        deputy_director: deputy
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. STUDENT ROUTES
// ==========================================

// Get student info and assigned approvers
app.get('/api/student/info/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const [students] = await query(`
      SELECT s.*, l.name AS level_name, m.name AS major_name,
             sp.photo_url AS student_photo, sp.prefix_th, sp.first_name_th, sp.last_name_th,
             u.full_name, u.username AS student_code
      FROM students s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      LEFT JOIN student_profiles sp ON s.id = sp.student_id
      WHERE s.user_id = ?
      LIMIT 1
    `, [userId]);

    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบข้อมูลผู้เรียน' });
    }

    const student = students[0];
    const levelId = student.level_id;
    const majorId = student.major_id;

    // 1. Advisor
    let advisor = null;
    if (levelId && majorId) {
      const [advRows] = await query(`
        SELECT aa.teacher_id, u.full_name, u.username
        FROM advisor_assignments aa
        JOIN users u ON aa.teacher_id = u.id
        WHERE aa.level_id = ? AND aa.major_id = ?
        LIMIT 1
      `, [levelId, majorId]);
      if (advRows.length > 0) advisor = advRows[0];
    }

    // 2. Head of Major
    let headMajor = null;
    if (majorId) {
      const [hmRows] = await query(`
        SELECT m.head_teacher_id, u.full_name, u.username
        FROM majors m
        JOIN users u ON m.head_teacher_id = u.id
        WHERE m.id = ?
        LIMIT 1
      `, [majorId]);
      if (hmRows.length > 0) headMajor = hmRows[0];
    }

    // 3. Head of Discipline & Deputy Director
    let headDiscipline = null;
    let deputyDirector = null;
    const [gdRows] = await query(`
      SELECT g.head_of_discipline_user_id, g.deputy_director_user_id,
             u1.full_name AS discipline_name, u1.username AS discipline_username,
             u2.full_name AS deputy_name, u2.username AS deputy_username
      FROM gate_duty_assignments g
      LEFT JOIN users u1 ON g.head_of_discipline_user_id = u1.id
      LEFT JOIN users u2 ON g.deputy_director_user_id = u2.id
      WHERE g.id = 1
      LIMIT 1
    `);

    if (gdRows.length > 0) {
      const row = gdRows[0];
      if (row.head_of_discipline_user_id) {
        headDiscipline = { teacher_id: row.head_of_discipline_user_id, full_name: row.discipline_name, username: row.discipline_username };
      }
      if (row.deputy_director_user_id) {
        deputyDirector = { teacher_id: row.deputy_director_user_id, full_name: row.deputy_name, username: row.deputy_username };
      }
    }

    res.json({
      success: true,
      student,
      approvers: {
        advisor,
        head_major: headMajor,
        head_discipline: headDiscipline,
        deputy_director: deputyDirector
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get teachers list
app.get('/api/student/teachers', async (req, res) => {
  try {
    const [teachers] = await query(`
      SELECT id, username, full_name, position
      FROM users
      WHERE role = 'teacher'
      ORDER BY full_name ASC
    `);
    res.json({ success: true, teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. LEAVE REQUESTS ROUTES
// ==========================================

// Create request
app.post('/api/requests', async (req, res) => {
  try {
    const {
      user_id,
      leave_date,
      leave_time,
      expected_return_time,
      is_not_returning,
      reason,
      reason_detail,
      attachment_url,
      subject_teacher_id
    } = req.body;

    if (!user_id || !reason || !subject_teacher_id) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลและเลือกครูรายวิชาให้ครบถ้วน' });
    }

    // Get student details
    const [students] = await query('SELECT * FROM students WHERE user_id = ? LIMIT 1', [user_id]);
    if (students.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่พบข้อมูลนักเรียน' });
    }
    const student = students[0];

    // Auto-detect approvers
    let advisorId = subject_teacher_id;
    let headMajorId = subject_teacher_id;
    let headDisciplineId = subject_teacher_id;
    let deputyDirectorId = subject_teacher_id;

    // Advisor
    const [adv] = await query('SELECT teacher_id FROM advisor_assignments WHERE level_id = ? AND major_id = ? LIMIT 1', [student.level_id, student.major_id]);
    if (adv.length > 0) advisorId = adv[0].teacher_id;

    // Head of Major
    const [hm] = await query('SELECT head_teacher_id FROM majors WHERE id = ? LIMIT 1', [student.major_id]);
    if (hm.length > 0) headMajorId = hm[0].head_teacher_id;

    // Gate duty assignments
    const [gd] = await query('SELECT head_of_discipline_user_id, deputy_director_user_id FROM gate_duty_assignments WHERE id = 1 LIMIT 1');
    if (gd.length > 0) {
      if (gd[0].head_of_discipline_user_id) headDisciplineId = gd[0].head_of_discipline_user_id;
      if (gd[0].deputy_director_user_id) deputyDirectorId = gd[0].deputy_director_user_id;
    }

    // Generate Request No
    const datePrefix = (leave_date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
    const [seq] = await query("SELECT COUNT(*) AS total FROM onepass_requests WHERE request_no LIKE ?", [`OP-${datePrefix}-%`]);
    const seqNum = (seq[0].total || 0) + 1;
    const requestNo = `OP-${datePrefix}-${String(seqNum).padStart(4, '0')}`;

    const [result] = await query(`
      INSERT INTO onepass_requests (
        request_no, student_id, user_id, leave_date, leave_time, expected_return_time,
        is_not_returning, leave_type, reason, reason_detail, attachment_url,
        subject_teacher_id, advisor_teacher_id, head_major_teacher_id, head_discipline_user_id, deputy_director_user_id,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_subject')
    `, [
      requestNo,
      student.id,
      user_id,
      leave_date || new Date().toISOString().slice(0, 10),
      leave_time || '09:00',
      expected_return_time || null,
      is_not_returning ? 1 : 0,
      is_not_returning ? 'leave_school' : 'temporary',
      reason,
      reason_detail || '',
      attachment_url || null,
      subject_teacher_id,
      advisorId,
      headMajorId,
      headDisciplineId,
      deputyDirectorId
    ]);

    const requestId = result.insertId;

    // Log creation
    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, 'student', 'created', ?)
    `, [requestId, user_id, `ยื่นคำขออนุญาตออกนอกสถานศึกษา รหัส ${requestNo}`]);

    // Send Telegram Notifications (Student + Subject Teacher)
    (async () => {
      try {
        const [studentRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [user_id]);
        const [teacherRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [subject_teacher_id]);
        if (studentRows.length > 0 && teacherRows.length > 0) {
          const reqData = {
            id: requestId,
            request_no: requestNo,
            leave_date: leave_date || new Date().toISOString().slice(0, 10),
            leave_time: leave_time || '09:00',
            is_not_returning: is_not_returning ? 1 : 0,
            reason: reason,
            reason_detail: reason_detail
          };
          await telegram.notifyRequestCreated(reqData, studentRows[0], teacherRows[0]);
        }
      } catch (err) {
        console.error('[Telegram] notifyRequestCreated error:', err.message);
      }
    })();

    res.json({
      success: true,
      message: `ยื่นคำขอเรียบร้อยแล้ว (รหัส: ${requestNo}) รอครูรายวิชาพิจารณาอนุมัติ`,
      request_id: requestId,
      request_no: requestNo
    });
  } catch (err) {
    console.error('Create request error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// List requests
app.get('/api/requests', async (req, res) => {
  try {
    const { userId, role, tab, status } = req.query;
    const uid = parseInt(userId, 10);

    let sql = `
      SELECT r.*,
             u_std.full_name AS student_name, u_std.username AS student_code, u_std.photo_url AS student_photo,
             l.name AS level_name, m.name AS major_name, s.room,
             u_sub.full_name AS subject_teacher_name,
             u_adv.full_name AS advisor_teacher_name,
             u_hm.full_name AS head_major_teacher_name,
             u_hd.full_name AS head_discipline_name,
             u_dep.full_name AS deputy_director_name
      FROM onepass_requests r
      JOIN users u_std ON r.user_id = u_std.id
      JOIN students s ON r.student_id = s.id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      LEFT JOIN users u_sub ON r.subject_teacher_id = u_sub.id
      LEFT JOIN users u_adv ON r.advisor_teacher_id = u_adv.id
      LEFT JOIN users u_hm ON r.head_major_teacher_id = u_hm.id
      LEFT JOIN users u_hd ON r.head_discipline_user_id = u_hd.id
      LEFT JOIN users u_dep ON r.deputy_director_user_id = u_dep.id
    `;

    const conditions = [];
    const params = [];

    if (role === 'student' || tab === 'my') {
      conditions.push('r.user_id = ?');
      params.push(uid);
    } else if (!['admin', 'super_admin'].includes(role)) {
      if (tab === 'subject') {
        conditions.push("r.subject_teacher_id = ? AND r.status = 'pending_subject'");
        params.push(uid);
      } else if (tab === 'advisor') {
        conditions.push("r.advisor_teacher_id = ? AND r.status = 'pending_advisor'");
        params.push(uid);
      } else if (tab === 'head_major') {
        conditions.push("r.head_major_teacher_id = ? AND r.status = 'pending_head_major'");
        params.push(uid);
      } else if (tab === 'head_discipline') {
        conditions.push("r.head_discipline_user_id = ? AND r.status = 'pending_head_discipline'");
        params.push(uid);
      } else if (tab === 'deputy') {
        conditions.push("(r.deputy_director_user_id = ? OR ? = 'deputy_director') AND r.status = 'pending_deputy'");
        params.push(uid, role);
      } else {
        conditions.push(`(
          r.subject_teacher_id = ? OR
          r.advisor_teacher_id = ? OR
          r.head_major_teacher_id = ? OR
          r.head_discipline_user_id = ? OR
          r.deputy_director_user_id = ?
        )`);
        params.push(uid, uid, uid, uid, uid);
      }
    }

    if (status) {
      conditions.push('r.status = ?');
      params.push(status);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY r.id DESC LIMIT 100';

    const [rows] = await query(sql, params);
    res.json({ success: true, count: rows.length, requests: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Single request detail
app.get('/api/requests/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await query(`
      SELECT r.*,
             u_std.full_name AS student_name, u_std.username AS student_code, u_std.photo_url AS student_photo,
             l.name AS level_name, m.name AS major_name, s.room, s.phone AS student_phone,
             u_sub.full_name AS subject_teacher_name,
             u_adv.full_name AS advisor_teacher_name,
             u_hm.full_name AS head_major_teacher_name,
             u_hd.full_name AS head_discipline_name,
             u_dep.full_name AS deputy_director_name,
             u_g_out.full_name AS gate_out_staff_name,
             u_g_in.full_name AS gate_in_staff_name
      FROM onepass_requests r
      JOIN users u_std ON r.user_id = u_std.id
      JOIN students s ON r.student_id = s.id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      LEFT JOIN users u_sub ON r.subject_teacher_id = u_sub.id
      LEFT JOIN users u_adv ON r.advisor_teacher_id = u_adv.id
      LEFT JOIN users u_hm ON r.head_major_teacher_id = u_hm.id
      LEFT JOIN users u_hd ON r.head_discipline_user_id = u_hd.id
      LEFT JOIN users u_dep ON r.deputy_director_user_id = u_dep.id
      LEFT JOIN users u_g_out ON r.gate_out_by = u_g_out.id
      LEFT JOIN users u_g_in ON r.gate_in_by = u_g_in.id
      WHERE r.id = ?
      LIMIT 1
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบคำขอนี้' });
    }

    const request = rows[0];

    // Generate QR Data URL if qr_token exists
    let qrDataUrl = null;
    if (request.qr_token) {
      try {
        qrDataUrl = await QRCode.toDataURL(request.qr_token, { width: 300, margin: 2 });
      } catch (e) {
        console.error('QR generate error:', e);
      }
    }
    request.qr_data_url = qrDataUrl;

    const [logs] = await query(`
      SELECT l.*, u.full_name AS user_name, u.username
      FROM onepass_logs l
      LEFT JOIN users u ON l.user_id = u.id
      WHERE l.request_id = ?
      ORDER BY l.id ASC
    `, [id]);

    res.json({ success: true, request, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cancel request
app.post('/api/requests/:id/cancel', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { userId } = req.body;

    const [rows] = await query('SELECT * FROM onepass_requests WHERE id = ? LIMIT 1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบคำขอนี้' });
    }
    const reqData = rows[0];
    if (reqData.status === 'approved' || reqData.status === 'completed') {
      return res.status(400).json({ success: false, message: 'ไม่สามารถยกเลิกคำขอที่ได้รับการอนุมัติแล้ว' });
    }

    await query("UPDATE onepass_requests SET status = 'cancelled' WHERE id = ?", [id]);
    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, 'student', 'cancelled', 'ผู้ขอยกเลิกคำขอ')
    `, [id, userId || reqData.user_id]);

    res.json({ success: true, message: 'ยกเลิกคำขอเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. APPROVAL WORKFLOW ROUTES (5 Roles)
// ==========================================

app.post('/api/approvals/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { userId, roleActed, decision, comment } = req.body;

    if (!id || !userId || !roleActed || !decision) {
      return res.status(400).json({ success: false, message: 'ข้อมูลการอนุมัติไม่ครบถ้วน' });
    }

    const [rows] = await query('SELECT * FROM onepass_requests WHERE id = ? LIMIT 1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบคำขอนี้' });
    }
    const current = rows[0];

    // Security Check: Student CANNOT approve any request!
    const [actingUsers] = await query('SELECT id, username, role, full_name FROM users WHERE id = ? LIMIT 1', [userId]);
    if (actingUsers.length === 0) {
      return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้งานที่ดำเนินการ' });
    }
    const actor = actingUsers[0];

    if (actor.role === 'student' || current.user_id === actor.id) {
      return res.status(403).json({ success: false, message: '⛔ นักเรียนไม่สามารถอนุมัติคำขอของตนเองหรือผู้อื่นได้' });
    }

    let newStatus = current.status;
    const now = new Date();
    const updateFields = [];
    const updateParams = [];

    // Role-specific fields
    const roleMap = {
      subject_teacher: { prefix: 'subject', nextStatus: 'pending_advisor', label: 'ครูรายวิชา' },
      advisor: { prefix: 'advisor', nextStatus: 'pending_head_major', label: 'ครูที่ปรึกษา' },
      head_major: { prefix: 'head_major', nextStatus: 'pending_head_discipline', label: 'หัวหน้าแผนก' },
      head_discipline: { prefix: 'head_discipline', nextStatus: 'pending_deputy', label: 'หัวหน้างานปกครอง' },
      deputy_director: { prefix: 'deputy_director', nextStatus: 'approved', label: 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา' }
    };

    const config = roleMap[roleActed];
    if (!config) {
      return res.status(400).json({ success: false, message: 'บทบาทผู้ลงนามไม่ถูกต้อง' });
    }

    // Strict Authorization Check: Only the designated approver for this step (or admin) can approve!
    const isAdmin = ['admin', 'super_admin'].includes(actor.role);
    if (!isAdmin) {
      let isAuthorized = false;
      if (roleActed === 'subject_teacher' && current.subject_teacher_id === actor.id) isAuthorized = true;
      else if (roleActed === 'advisor' && current.advisor_teacher_id === actor.id) isAuthorized = true;
      else if (roleActed === 'head_major' && current.head_major_teacher_id === actor.id) isAuthorized = true;
      else if (roleActed === 'head_discipline' && current.head_discipline_user_id === actor.id) isAuthorized = true;
      else if (roleActed === 'deputy_director' && current.deputy_director_user_id === actor.id) isAuthorized = true;

      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: `⛔ ท่านไม่มีสิทธิ์ในการพิจารณาในฐานะ "${config.label}" สำหรับคำขอนี้ เนื่องจากเป็นหน้าที่ของผู้ได้รับมอบหมายในขั้นตอนนี้เท่านั้น`
        });
      }
    }

    const decisionStatus = decision === 'approve' ? 'approved' : 'rejected';
    updateFields.push(`\`${config.prefix}_status\` = ?`);
    updateParams.push(decisionStatus);

    updateFields.push(`\`${config.prefix}_comment\` = ?`);
    updateParams.push(comment || (decision === 'approve' ? 'อนุมัติ' : 'ไม่อนุมัติ'));

    updateFields.push(`\`${config.prefix}_action_at\` = ?`);
    updateParams.push(now);

    let qrToken = current.qr_token;
    let qrExpiresAt = current.qr_expires_at;

    if (decision === 'reject') {
      newStatus = 'rejected';
    } else {
      // Advance to next status
      newStatus = config.nextStatus;
      // If final level approved, generate QR Code!
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

    updateParams.push(id);
    await query(`UPDATE onepass_requests SET ${updateFields.join(', ')} WHERE id = ?`, updateParams);

    // Audit Log
    const actionLabel = decision === 'approve' ? 'approved' : 'rejected';
    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, ?, ?, ?)
    `, [id, userId, roleActed, actionLabel, `[${config.label}] ${decision === 'approve' ? 'อนุมัติคำขอ' : 'ไม่อนุมัติคำขอ'}: ${comment || '-'}`]);

    // Send Telegram Notifications (Student + Next Approver)
    (async () => {
      try {
        const [studentRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [current.user_id]);
        const [actorRows] = await query('SELECT full_name FROM users WHERE id = ? LIMIT 1', [userId]);
        const actorName = actorRows.length > 0 ? actorRows[0].full_name : config.label;

        let nextApproverUser = null;
        if (decision === 'approve' && newStatus !== 'approved') {
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
          await telegram.notifyApprovalAction({
            request: { ...current, qr_token: qrToken || current.qr_token },
            actorRole: roleActed,
            actorName: actorName,
            decision: decision,
            comment: comment,
            studentUser: studentRows[0],
            nextApproverUser: nextApproverUser,
            isFullyApproved: (newStatus === 'approved')
          });
        }
      } catch (err) {
        console.error('[Telegram] notifyApprovalAction error:', err.message);
      }
    })();

    res.json({
      success: true,
      message: `${config.label}ได้ทำการบันทึก${decision === 'approve' ? 'อนุมัติ' : 'ไม่อนุมัติ'}เรียบร้อยแล้ว`,
      new_status: newStatus,
      qr_token: qrToken
    });
  } catch (err) {
    console.error('Approval error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5. GATE DUTY & SCANNER ROUTES
// ==========================================

// Verify pass by QR token or Request No
app.get('/api/gate/verify/:token', async (req, res) => {
  try {
    const token = req.params.token.trim();
    const [rows] = await query(`
      SELECT r.*,
             u_std.full_name AS student_name, u_std.username AS student_code, u_std.photo_url AS student_photo,
             l.name AS level_name, m.name AS major_name, s.room, s.phone AS student_phone,
             u_sub.full_name AS subject_teacher_name,
             u_adv.full_name AS advisor_teacher_name,
             u_dep.full_name AS deputy_director_name
      FROM onepass_requests r
      JOIN users u_std ON r.user_id = u_std.id
      JOIN students s ON r.student_id = s.id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      LEFT JOIN users u_sub ON r.subject_teacher_id = u_sub.id
      LEFT JOIN users u_adv ON r.advisor_teacher_id = u_adv.id
      LEFT JOIN users u_dep ON r.deputy_director_user_id = u_dep.id
      WHERE r.qr_token = ? OR r.request_no = ?
      LIMIT 1
    `, [token, token]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, valid: false, message: 'ไม่พบบัตรผ่านหรือรหัส QR Code นี้ในระบบ' });
    }

    const pass = rows[0];
    const now = new Date();
    const isExpired = (pass.status === 'expired') || (pass.qr_expires_at && (new Date(pass.qr_expires_at) < now) && !pass.gate_out_at);

    if (isExpired) {
      return res.json({
        success: true,
        valid: false,
        is_expired: true,
        pass,
        status_label: '❌ บัตรผ่านหมดอายุแล้ว (เกิน 30 นาที) ระบบทำลายรหัส QR อัตโนมัติแล้ว ต้องยื่นขออนุญาตใหม่'
      });
    }

    const isApproved = pass.status === 'approved' || pass.status === 'completed';

    let qrDataUrl = null;
    if (pass.qr_token) {
      try {
        qrDataUrl = await QRCode.toDataURL(pass.qr_token, { width: 300, margin: 2 });
      } catch (e) {
        console.error('QR generate error:', e);
      }
    }
    pass.qr_data_url = qrDataUrl;

    res.json({
      success: true,
      valid: isApproved,
      pass,
      status_label: isApproved ? 'บัตรผ่านได้รับอนุมัติถูกต้อง' : `คำขอยังไม่ได้รับการอนุมัติ (สถานะ: ${pass.status})`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Generate QR Code image directly
app.get('/api/qrcode', async (req, res) => {
  try {
    const text = req.query.text || 'ONEPASS';
    const dataUrl = await QRCode.toDataURL(text, { width: 250, margin: 2 });
    res.json({ success: true, text, data_url: dataUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Record Gate Exit (ออกจากสถานศึกษา)
app.post('/api/gate/check-out', async (req, res) => {
  try {
    const { requestId, guardUserId, notes } = req.body;
    const now = new Date();

    const [checkRows] = await query('SELECT * FROM onepass_requests WHERE id = ?', [requestId]);
    if (checkRows.length > 0) {
      const pass = checkRows[0];
      if ((pass.status === 'expired') || (pass.qr_expires_at && new Date(pass.qr_expires_at) < now && !pass.gate_out_at)) {
        return res.status(400).json({
          success: false,
          message: '❌ บัตรผ่านหมดอายุแล้ว (เกิน 30 นาที) ระบบทำลายรหัสอัตโนมัติแล้ว ไม่สามารถบันทึกเวลาออกได้ ต้องยื่นขออนุญาตใหม่'
        });
      }
    }

    await query(`
      UPDATE onepass_requests
      SET gate_out_at = ?, gate_out_by = ?
      WHERE id = ?
    `, [now, guardUserId || null, requestId]);

    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, 'gate_staff', 'gate_exit', ?)
    `, [requestId, guardUserId || 1, `บันทึกเวลาออกนอกสถานศึกษา: ${now.toLocaleTimeString('th-TH')} ${notes ? '(' + notes + ')' : ''}`]);

    // สั่งยกไม้กั้นอัตโนมัติไปยังบอร์ด ESP32 เมื่อเวรประตูบันทึกเวลาออก
    pendingDeviceCommand = 'OPEN_TEST';
    console.log(`[Gate Check-Out] Queued OPEN_TEST command to ESP32 for request #${requestId}`);

    // Send Telegram Notification to Student
    (async () => {
      try {
        const [reqRows] = await query('SELECT * FROM onepass_requests WHERE id = ? LIMIT 1', [requestId]);
        if (reqRows.length > 0) {
          const [stdRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [reqRows[0].user_id]);
          if (stdRows.length > 0) {
            await telegram.notifyGateRecord(reqRows[0], stdRows[0], 'exit', now);
          }
        }
      } catch (err) {
        console.error('[Telegram] notifyGateRecord exit error:', err.message);
      }
    })();

    res.json({ success: true, message: 'บันทึกเวลาออกนอกสถานศึกษาสำเร็จ', gate_out_at: now });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Record Gate Return (กลับเข้าสถานศึกษา)
app.post('/api/gate/check-in', async (req, res) => {
  try {
    const { requestId, guardUserId, notes } = req.body;
    const now = new Date();

    await query(`
      UPDATE onepass_requests
      SET gate_in_at = ?, gate_in_by = ?, status = 'completed'
      WHERE id = ?
    `, [now, guardUserId || null, requestId]);

    await query(`
      INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
      VALUES (?, ?, 'gate_staff', 'gate_return', ?)
    `, [requestId, guardUserId || 1, `บันทึกเวลากลับเข้าสถานศึกษา: ${now.toLocaleTimeString('th-TH')} ${notes ? '(' + notes + ')' : ''}`]);

    // สั่งยกไม้กั้นอัตโนมัติไปยังบอร์ด ESP32 เมื่อเวรประตูบันทึกเวลากลับ
    pendingDeviceCommand = 'OPEN_TEST';
    console.log(`[Gate Check-In] Queued OPEN_TEST command to ESP32 for request #${requestId}`);

    // Send Telegram Notification to Student
    (async () => {
      try {
        const [reqRows] = await query('SELECT * FROM onepass_requests WHERE id = ? LIMIT 1', [requestId]);
        if (reqRows.length > 0) {
          const [stdRows] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [reqRows[0].user_id]);
          if (stdRows.length > 0) {
            await telegram.notifyGateRecord(reqRows[0], stdRows[0], 'return', now);
          }
        }
      } catch (err) {
        console.error('[Telegram] notifyGateRecord return error:', err.message);
      }
    })();

    res.json({ success: true, message: 'บันทึกเวลากลับเข้าสถานศึกษาสำเร็จ (สถานะ: สิ้นสุด/สมบูรณ์)', gate_in_at: now });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5.5 ESP32 SMART GATE HARDWARE ENDPOINTS
// ==========================================

const espStateFile = path.join(__dirname, 'tmp', 'esp32_state.json');
let deviceHardwareState = {
  online: false,
  lastSeen: null,
  wifi: false,
  wifi_ip: null,
  ultrasonic: false,
  ultrasonic_distance: null,
  button_pressed: false,
  output_cycle: false,
  qr_connected: false
};
try {
  if (fs.existsSync(espStateFile)) {
    deviceHardwareState = JSON.parse(fs.readFileSync(espStateFile, 'utf8'));
  }
} catch (e) {}
let pendingDeviceCommand = null;

// ESP32 Hardware Status Report (Called by smart_gate_esp32_report.ino every 3 seconds)
app.post('/api/device/status', (req, res) => {
  const { fw_ver, wifi, wifi_ip, ultrasonic, ultrasonic_distance, button_pressed, output_cycle, qr_connected, last_qr, last_scan_res } = req.body;

  deviceHardwareState = {
    online: true,
    lastSeen: new Date(),
    fw_ver: fw_ver || 'legacy',
    wifi: Boolean(wifi),
    wifi_ip: wifi_ip || null,
    ultrasonic: Boolean(ultrasonic),
    ultrasonic_distance: ultrasonic_distance != null ? ultrasonic_distance : -1,
    button_pressed: Boolean(button_pressed),
    output_cycle: Boolean(output_cycle),
    qr_connected: Boolean(qr_connected),
    last_qr: last_qr || null,
    last_scan_res: last_scan_res || null
  };
  try {
    fs.writeFileSync(espStateFile, JSON.stringify(deviceHardwareState));
  } catch (e) {}

  const responseObj = { success: true };
  if (pendingDeviceCommand) {
    responseObj.command = pendingDeviceCommand;
    console.log(`[ESP32 Device] Dispatched command to board: ${pendingDeviceCommand}`);
    pendingDeviceCommand = null; // Clear command after sending
  }

  res.json(responseObj);
});

// Get Hardware Status (For Web UI / Admin / Gate Duty)
app.get('/api/device/status', (req, res) => {
  try {
    if (fs.existsSync(espStateFile)) {
      deviceHardwareState = JSON.parse(fs.readFileSync(espStateFile, 'utf8'));
    }
  } catch (e) {}
  // ขยาย timeout เป็น 45 วินาที เพื่อรองรับรอบส่ง 15 วิ และความหน่วงเน็ตมือถือ
  const isOnline = Boolean(deviceHardwareState.lastSeen && (Date.now() - new Date(deviceHardwareState.lastSeen).getTime() < 45000));
  res.json({
    success: true,
    device: {
      ...deviceHardwareState,
      online: isOnline,
      lastSeenThai: deviceHardwareState.lastSeen ? telegram.formatThaiDateTime(deviceHardwareState.lastSeen) : 'ยังไม่มีการเชื่อมต่อ'
    }
  });
});

// Send Command to ESP32 (e.g. OPEN_TEST, TEST_SERVO from Web UI)
app.post('/api/device/command', (req, res) => {
  const { command } = req.body;
  const validCommands = ['OPEN_TEST', 'CLOSE_TEST', 'TEST_SERVO', 'TEST_LED_GREEN', 'TEST_LED_RED', 'TEST_LED_YELLOW', 'TEST_RELAY', 'TEST_BUZZER'];
  if (!validCommands.includes(command)) {
    return res.status(400).json({ success: false, message: 'คำสั่งไม่ถูกต้อง' });
  }
  pendingDeviceCommand = command;
  console.log(`[ESP32 Device] Admin queued command: ${command}`);
  res.json({ success: true, message: `ส่งคำสั่ง ${command} ไปยังบอร์ด ESP32 เรียบร้อยแล้ว (บอร์ดจะดำเนินการภายใน 3 วินาที)` });
});

// ESP32 Gate Scan API (Called by smart_gate_esp32_report.ino when QR scanner reads a token)
app.post('/api/gate/scan', async (req, res) => {
  try {
    const { token, scanType = 'auto' } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุรหัส QR Token' });
    }

    // Sanitize token: remove non-printable characters and extract OP-... token pattern if present
    const cleanToken = token.trim();
    const tokenMatch = cleanToken.match(/OP-[A-Z0-9\-]+/i);
    const candidateToken = tokenMatch ? tokenMatch[0].toUpperCase() : cleanToken.replace(/[^a-zA-Z0-9\-_.]/g, '');
    const baseToken = candidateToken.includes('.') ? candidateToken.split('.')[0] : candidateToken;

    console.log(`[Gate Scan] Incoming token: "${token}" -> parsed: "${baseToken}"`);

    // Look up leave request in MySQL (match qr_token, request_no, or substring)
    const [rows] = await query(`
      SELECT r.*, u.full_name AS student_name, u.username AS student_code,
             l.name AS level_name, m.name AS major_name, s.room
      FROM onepass_requests r
      JOIN users u ON r.user_id = u.id
      JOIN students s ON r.student_id = s.id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
      WHERE r.qr_token = ? 
         OR r.request_no = ?
         OR ? LIKE CONCAT('%', r.qr_token, '%')
         OR ? LIKE CONCAT('%', r.request_no, '%')
      LIMIT 1
    `, [baseToken, baseToken, cleanToken, cleanToken]);

    if (rows.length === 0) {
      console.warn(`[Gate Scan] QR Token not found: ${cleanToken}`);
      return res.json({
        success: false,
        message: '❌ ไม่พบรหัส QR ในระบบ หรือบัตรผ่านไม่ถูกต้อง'
      });
    }

    const pass = rows[0];

    const now = new Date();

    // Check 30-minute expiration if not yet exited:
    if (!pass.gate_out_at && pass.qr_expires_at) {
      const expTime = new Date(pass.qr_expires_at);
      if (now > expTime || pass.status === 'expired') {
        // Automatically destroy QR code and mark status as 'expired'
        await query(`
          UPDATE onepass_requests
          SET status = 'expired', qr_token = NULL
          WHERE id = ?
        `, [pass.id]);

        await query(`
          INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
          VALUES (?, 1, 'system', 'expired', 'QR Code หมดอายุ 30 นาที (ระบบทำลายรหัส QR อัตโนมัติ ต้องยื่นขออนุญาตใหม่)')
        `, [pass.id]);

        console.warn(`[Gate Scan] QR EXPIRED: ${pass.request_no} expired at ${pass.qr_expires_at}`);
        return res.json({
          success: false,
          message: '❌ บัตรผ่านหมดอายุแล้ว (เกิน 30 นาที) ระบบทำลายรหัส QR อัตโนมัติ ไม่สามารถสแกนได้ ต้องยื่นขออนุญาตใหม่'
        });
      }
    }

    // Check approval status
    if (pass.status !== 'approved' && pass.status !== 'completed') {
      return res.json({
        success: false,
        message: `❌ คำขอนี้ยังไม่ได้รับอนุมัติครบสาย (สถานะ: ${pass.status})`
      });
    }

    let actionRecorded = '';

    // Logic: First scan = check-out (gate_out), Second scan = check-in (gate_in)
    if (!pass.gate_out_at) {
      // Record exit (ขาออก)
      await query(`
        UPDATE onepass_requests
        SET gate_out_at = NOW(), gate_out_by = COALESCE(gate_out_by, 1)
        WHERE id = ?
      `, [pass.id]);

      // If "leave_school" (not returning), mark completed right away
      if (pass.is_not_returning) {
        await query(`UPDATE onepass_requests SET status = 'completed' WHERE id = ?`, [pass.id]);
      }

      actionRecorded = 'exit';

      // Log
      await query(`
        INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
        VALUES (?, 1, 'gate_scanner', 'gate_out', ?)
      `, [pass.id, `ตู้สแกน ESP32 บันทึกเวลาออก: ${pass.student_name} (${pass.student_code})`]);

      // Notify Student via Telegram
      const [stdUser] = await query('SELECT * FROM users WHERE id = ?', [pass.user_id]);
      if (stdUser.length > 0) {
        telegram.notifyGateRecord(pass, stdUser[0], 'exit', now);
      }
    } else if (!pass.gate_in_at && !pass.is_not_returning) {
      // Record return (ขากลับเข้า)
      await query(`
        UPDATE onepass_requests
        SET gate_in_at = NOW(), gate_in_by = COALESCE(gate_in_by, 1), status = 'completed'
        WHERE id = ?
      `, [pass.id]);

      actionRecorded = 'return';

      // Log
      await query(`
        INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
        VALUES (?, 1, 'gate_scanner', 'gate_in', ?)
      `, [pass.id, `ตู้สแกน ESP32 บันทึกเวลากลับเข้า: ${pass.student_name} (${pass.student_code})`]);

      // Notify Student via Telegram
      const [stdUser] = await query('SELECT * FROM users WHERE id = ?', [pass.user_id]);
      if (stdUser.length > 0) {
        telegram.notifyGateRecord(pass, stdUser[0], 'return', now);
      }
    } else {
      // Already exited and returned
      return res.json({
        success: false,
        message: '⛔ บัตรผ่านนี้ได้ใช้งานบันทึกเวลาออกและกลับเข้าเรียบร้อยแล้ว (สถานะเสร็จสิ้น)'
      });
    }

    console.log(`[Gate Scan] SUCCESS: ${pass.request_no} - ${pass.student_name} (${actionRecorded})`);

    // Return success to ESP32 so it executes testOpenSequence() to lift barrier!
    res.json({
      success: true,
      action: actionRecorded,
      message: `✅ สแกนสำเร็จ (${actionRecorded === 'exit' ? 'บันทึกเวลาออก' : 'บันทึกเวลากลับ'}) เปิดไม้กั้น`,
      openDuration: 4,
      student: {
        name: pass.student_name,
        code: pass.student_code,
        level: pass.level_name,
        major: pass.major_name,
        room: pass.room
      }
    });
  } catch (err) {
    console.error('[Gate Scan] Error:', err);
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
});

// ==========================================
// 6. ADMIN ROUTES (จัดการผู้ใช้, ติดตามสถานะ, กำหนดภาคเรียน)
// ==========================================

// Dashboard Statistics
app.get('/api/admin/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [reqStats] = await query(`
      SELECT 
        COUNT(*) AS total_all,
        SUM(CASE WHEN leave_date = ? THEN 1 ELSE 0 END) AS total_today,
        SUM(CASE WHEN status LIKE 'pending_%' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN gate_out_at IS NOT NULL AND gate_in_at IS NULL THEN 1 ELSE 0 END) AS currently_out_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
      FROM onepass_requests
    `, [today]);

    const [userStats] = await query(`
      SELECT 
        COUNT(*) AS total_users,
        SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS total_students,
        SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) AS total_teachers,
        SUM(CASE WHEN role = 'deputy_director' THEN 1 ELSE 0 END) AS total_deputies,
        SUM(CASE WHEN role IN ('admin', 'super_admin') THEN 1 ELSE 0 END) AS total_admins
      FROM users
    `);

    const [termInfo] = await query('SELECT academic_year, semester FROM academic_term WHERE id = 1 LIMIT 1');

    res.json({
      success: true,
      stats: {
        ...reqStats[0],
        ...userStats[0],
        academic_year: termInfo.length > 0 ? termInfo[0].academic_year : '2569',
        semester: termInfo.length > 0 ? termInfo[0].semester : '2'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: List Users
app.get('/api/admin/users', async (req, res) => {
  try {
    const { search, role, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    let sql = `
      SELECT u.id, u.username, u.full_name, u.role, u.position, u.email, u.telegram_chat_id,
             u.must_change_password, u.created_at,
             s.student_code, l.name AS level_name, m.name AS major_name, s.room
      FROM users u
      LEFT JOIN students s ON u.id = s.user_id
      LEFT JOIN levels l ON s.level_id = l.id
      LEFT JOIN majors m ON s.major_id = m.id
    `;
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(u.username LIKE ? OR u.full_name LIKE ? OR s.student_code LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (role && role !== 'all') {
      conditions.push('u.role = ?');
      params.push(role);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY u.id DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit, 10), offset);

    const [users] = await query(sql, params);
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: Create User
app.post('/api/admin/users', async (req, res) => {
  try {
    const { username, full_name, role, position, email, telegram_chat_id } = req.body;

    if (!username || !full_name || !role) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสผู้ใช้ ชื่อ-สกุล และบทบาท' });
    }

    const [existing] = await query('SELECT id FROM users WHERE username = ? LIMIT 1', [username.trim()]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: `รหัสผู้ใช้ ${username} มีอยู่ในระบบแล้ว` });
    }

    // Default password '123456'
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('123456', salt);

    const [result] = await query(`
      INSERT INTO users (username, full_name, role, position, email, telegram_chat_id, password_hash, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `, [username.trim(), full_name.trim(), role, position || null, email || null, telegram_chat_id || null, hash]);

    res.json({
      success: true,
      message: `เพิ่มผู้ใช้ ${full_name} เรียบร้อยแล้ว (รหัสผ่านเริ่มต้น: 123456)`,
      user_id: result.insertId
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: Get Single User Details (with Student Profile if student)
app.get('/api/admin/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [users] = await query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });
    }
    const user = users[0];

    let studentData = null;
    let profileData = null;

    if (user.role === 'student') {
      const [students] = await query('SELECT * FROM students WHERE user_id = ? LIMIT 1', [id]);
      if (students.length > 0) {
        studentData = students[0];
        const [profiles] = await query('SELECT * FROM student_profiles WHERE student_id = ? LIMIT 1', [studentData.id]);
        if (profiles.length > 0) profileData = profiles[0];
      }
    }

    res.json({
      success: true,
      user,
      student: studentData,
      profile: profileData
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: Edit User (Supports Full Student/Teacher Profile Updates)
app.put('/api/admin/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const {
      full_name, role, position, email, telegram_chat_id,
      // Student specific fields
      student_code, phone, level_id, major_id, room, student_status,
      prefix_th, first_name_th, last_name_th, father_phone, mother_phone
    } = req.body;

    // 1. Update users table
    await query(`
      UPDATE users
      SET full_name = ?, role = ?, position = ?, email = ?, telegram_chat_id = ?
      WHERE id = ?
    `, [full_name.trim(), role, position || null, email || null, telegram_chat_id || null, id]);

    // 2. If student or student fields provided, update students & student_profiles
    if (role === 'student' || level_id || major_id || student_status) {
      const [existingStudents] = await query('SELECT id FROM students WHERE user_id = ? LIMIT 1', [id]);
      let studentId = null;

      // Get major department name
      let deptName = null;
      if (major_id) {
        const [m] = await query('SELECT name FROM majors WHERE id = ? LIMIT 1', [major_id]);
        if (m.length > 0) deptName = m[0].name;
      }

      // Get education level name
      let eduLevel = null;
      if (level_id) {
        const [l] = await query('SELECT name FROM levels WHERE id = ? LIMIT 1', [level_id]);
        if (l.length > 0) eduLevel = l[0].name;
      }

      if (existingStudents.length > 0) {
        studentId = existingStudents[0].id;
        await query(`
          UPDATE students
          SET student_code = COALESCE(?, student_code),
              phone = ?,
              level_id = ?,
              major_id = ?,
              department = COALESCE(?, department),
              education_level = COALESCE(?, education_level),
              room = ?,
              student_status = COALESCE(?, student_status)
          WHERE id = ?
        `, [
          student_code || null,
          phone || null,
          level_id || null,
          major_id || null,
          deptName,
          eduLevel,
          room || null,
          student_status || 'studying',
          studentId
        ]);
      } else {
        // Insert student record if didn't exist
        const [ins] = await query(`
          INSERT INTO students (user_id, student_code, department, education_level, room, phone, level_id, major_id, student_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          student_code || req.body.username || '',
          deptName,
          eduLevel,
          room || null,
          phone || null,
          level_id || null,
          major_id || null,
          student_status || 'studying'
        ]);
        studentId = ins.insertId;
      }

      // 3. Update student_profiles if present
      if (studentId) {
        const [existingProfiles] = await query('SELECT student_id FROM student_profiles WHERE student_id = ? LIMIT 1', [studentId]);
        if (existingProfiles.length > 0) {
          await query(`
            UPDATE student_profiles
            SET prefix_th = COALESCE(?, prefix_th),
                first_name_th = COALESCE(?, first_name_th),
                last_name_th = COALESCE(?, last_name_th),
                father_phone = COALESCE(?, father_phone),
                mother_phone = COALESCE(?, mother_phone)
            WHERE student_id = ?
          `, [
            prefix_th || null,
            first_name_th || null,
            last_name_th || null,
            father_phone || null,
            mother_phone || null,
            studentId
          ]);
        } else if (prefix_th || first_name_th || last_name_th) {
          await query(`
            INSERT INTO student_profiles (student_id, prefix_th, first_name_th, last_name_th, father_phone, mother_phone)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            studentId,
            prefix_th || null,
            first_name_th || null,
            last_name_th || null,
            father_phone || null,
            mother_phone || null
          ]);
        }
      }
    }

    res.json({ success: true, message: 'อัปเดตข้อมูลผู้ใช้งานและข้อมูลการเรียนเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: 1-Click Reset Password to 123456
app.post('/api/admin/users/:id/reset-password', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('123456', salt);

    await query(`
      UPDATE users 
      SET password_hash = ?, must_change_password = 1 
      WHERE id = ?
    `, [hash, id]);

    const [u] = await query('SELECT username, full_name FROM users WHERE id = ? LIMIT 1', [id]);
    const name = u.length > 0 ? u[0].full_name : '';

    res.json({
      success: true,
      message: `รีเซ็ตรหัสผ่านของ ${name} เป็น 123456 สำเร็จ (บังคับเปลี่ยนเมื่อใช้งานครั้งต่อไป)`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Management: Delete User
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'ลบผู้ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Metadata: Levels, Majors, Teachers for dropdowns
app.get('/api/admin/metadata', async (req, res) => {
  try {
    const [levels] = await query('SELECT id, name FROM levels ORDER BY id ASC');
    const [majors] = await query('SELECT id, name, head_teacher_id FROM majors ORDER BY id ASC');
    const [teachers] = await query("SELECT id, username, full_name, position, role FROM users WHERE role IN ('teacher', 'deputy_director', 'director', 'admin') ORDER BY full_name ASC");

    res.json({ success: true, levels, majors, teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Majors Management: List Majors & Assign Head of Department
app.get('/api/admin/majors', async (req, res) => {
  try {
    const [majors] = await query(`
      SELECT m.id, m.name, m.head_teacher_id,
             u.full_name AS head_teacher_name, u.username AS head_teacher_code, u.position AS head_teacher_position
      FROM majors m
      LEFT JOIN users u ON m.head_teacher_id = u.id
      ORDER BY m.id ASC
    `);
    const [teachers] = await query("SELECT id, username, full_name, position FROM users WHERE role IN ('teacher', 'deputy_director', 'director') ORDER BY full_name ASC");

    res.json({ success: true, majors, teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Majors Management: Update Head Teacher for Major
app.put('/api/admin/majors/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { head_teacher_id, name } = req.body;

    const fields = [];
    const params = [];

    if (head_teacher_id !== undefined) {
      fields.push('head_teacher_id = ?');
      params.push(head_teacher_id ? parseInt(head_teacher_id, 10) : null);
    }
    if (name) {
      fields.push('name = ?');
      params.push(name.trim());
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ต้องอัปเดต' });
    }

    params.push(id);
    await query(`UPDATE majors SET ${fields.join(', ')} WHERE id = ?`, params);

    res.json({ success: true, message: 'บันทึกหัวหน้าแผนกวิชาเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Advisor Assignments: List All Assignments
app.get('/api/admin/advisors', async (req, res) => {
  try {
    const [advisors] = await query(`
      SELECT aa.id, aa.level_id, aa.major_id, aa.teacher_id,
             l.name AS level_name,
             m.name AS major_name,
             u.full_name AS teacher_name, u.username AS teacher_code, u.position AS teacher_position
      FROM advisor_assignments aa
      JOIN levels l ON aa.level_id = l.id
      JOIN majors m ON aa.major_id = m.id
      JOIN users u ON aa.teacher_id = u.id
      ORDER BY aa.level_id ASC, aa.major_id ASC
    `);

    const [levels] = await query('SELECT id, name FROM levels ORDER BY id ASC');
    const [majors] = await query('SELECT id, name FROM majors ORDER BY id ASC');
    const [teachers] = await query("SELECT id, username, full_name, position FROM users WHERE role IN ('teacher', 'deputy_director', 'director') ORDER BY full_name ASC");

    res.json({ success: true, advisors, levels, majors, teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Advisor Assignments: Add New Assignment
app.post('/api/admin/advisors', async (req, res) => {
  try {
    const { level_id, major_id, teacher_id } = req.body;
    if (!level_id || !major_id || !teacher_id) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุระดับชั้น แผนกวิชา และครูที่ปรึกษา' });
    }

    const [result] = await query(`
      INSERT INTO advisor_assignments (level_id, major_id, teacher_id)
      VALUES (?, ?, ?)
    `, [parseInt(level_id, 10), parseInt(major_id, 10), parseInt(teacher_id, 10)]);

    res.json({ success: true, message: 'เพิ่มครูที่ปรึกษาประจำชั้นเรียนเรียบร้อยแล้ว', id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Advisor Assignments: Update Assignment Teacher
app.put('/api/admin/advisors/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { teacher_id } = req.body;
    if (!teacher_id) {
      return res.status(400).json({ success: false, message: 'กรุณาเลือกครูที่ปรึกษา' });
    }

    await query('UPDATE advisor_assignments SET teacher_id = ? WHERE id = ?', [parseInt(teacher_id, 10), id]);
    res.json({ success: true, message: 'อัปเดตครูที่ปรึกษาเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Advisor Assignments: Delete Assignment
app.delete('/api/admin/advisors/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await query('DELETE FROM advisor_assignments WHERE id = ?', [id]);
    res.json({ success: true, message: 'ลบรายการครูที่ปรึกษาเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Settings: Get All Settings (Term, Gate Duty, Telegram)
app.get('/api/admin/settings', async (req, res) => {
  try {
    const [term] = await query('SELECT * FROM academic_term WHERE id = 1 LIMIT 1');
    const [duty] = await query(`
      SELECT g.*, 
             u1.full_name AS discipline_name, u1.username AS discipline_username,
             u2.full_name AS deputy_name, u2.username AS deputy_username
      FROM gate_duty_assignments g
      LEFT JOIN users u1 ON g.head_of_discipline_user_id = u1.id
      LEFT JOIN users u2 ON g.deputy_director_user_id = u2.id
      WHERE g.id = 1 LIMIT 1
    `);
    const [telegramRows] = await query('SELECT * FROM telegram_settings WHERE id = 1 LIMIT 1');
    const [teachers] = await query("SELECT id, username, full_name, position, role FROM users WHERE role IN ('teacher', 'deputy_director', 'director') ORDER BY full_name ASC");

    res.json({
      success: true,
      term: term.length > 0 ? term[0] : { academic_year: '2569', semester: '2' },
      gate_duty: duty.length > 0 ? duty[0] : null,
      telegram: telegramRows.length > 0 ? telegramRows[0] : { bot_token: '', chat_id: '' },
      teachers
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Settings: Update Academic Term
app.post('/api/admin/settings/term', async (req, res) => {
  try {
    const { academic_year, semester } = req.body;
    if (!academic_year || !semester) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุปีการศึกษาและภาคเรียน' });
    }

    await query(`
      UPDATE academic_term
      SET academic_year = ?, semester = ?, updated_at = NOW()
      WHERE id = 1
    `, [academic_year.trim(), String(semester).trim()]);

    // Also log in academic_terms
    await query(`
      INSERT INTO academic_terms (academic_year, semester, opened_at, opened_by)
      VALUES (?, ?, NOW(), 1)
    `, [academic_year.trim(), String(semester).trim()]);

    res.json({
      success: true,
      message: `บันทึกกำหนดปีการศึกษา ${academic_year} ภาคเรียนที่ ${semester} เรียบร้อยแล้ว`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Settings: Update Gate Duty (Head of Discipline & Deputy Director)
app.post('/api/admin/settings/gate-duty', async (req, res) => {
  try {
    const { head_of_discipline_user_id, deputy_director_user_id } = req.body;

    await query(`
      UPDATE gate_duty_assignments
      SET head_of_discipline_user_id = ?, deputy_director_user_id = ?, updated_at = NOW()
      WHERE id = 1
    `, [head_of_discipline_user_id, deputy_director_user_id]);

    res.json({ success: true, message: 'บันทึกผู้รับผิดชอบงานปกครองและรองผู้อำนวยการเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Settings: Update Telegram Settings & Test Send
app.get('/api/db-check', async (req, res) => {
  try {
    const [dbInfo] = await query('SELECT DATABASE() AS current_db, USER() AS current_user, VERSION() AS db_version');
    const [tables] = await query('SHOW TABLES');
    res.json({
      success: true,
      info: dbInfo[0],
      table_count: tables.length,
      tables: tables.map(t => Object.values(t)[0])
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/admin/settings/telegram', async (req, res) => {
  try {
    const { bot_token, chat_id, test_send } = req.body;

    await query(`
      UPDATE telegram_settings
      SET bot_token = ?, chat_id = ?, updated_at = NOW()
      WHERE id = 1
    `, [bot_token ? bot_token.trim() : null, chat_id ? chat_id.trim() : null]);

    let testResult = null;
    if (test_send && bot_token && chat_id) {
      try {
        await telegram.sendTelegramMessage(chat_id.trim(), '🔔 <b>[OnePass ทดสอบการแจ้งเตือน]</b>\nการตั้งค่า Telegram Bot ของระบบ OnePass ถูกต้องและเชื่อมต่อสำเร็จแล้ว!');
        testResult = 'ส่งข้อความทดสอบสำเร็จแล้ว กรุณาตรวจสอบใน Telegram';
      } catch (te) {
        testResult = 'ทดสอบส่งไม่สำเร็จ: ' + te.message;
      }
    }

    res.json({
      success: true,
      message: 'บันทึกการตั้งค่า Telegram เรียบร้อยแล้ว' + (testResult ? ` (${testResult})` : '')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// BACKGROUND TASK: 30-MINUTE QR AUTO-DESTROY
// ==========================================
setInterval(async () => {
  try {
    const [expiredList] = await query(`
      SELECT id, request_no, user_id, qr_expires_at FROM onepass_requests
      WHERE status = 'approved' AND qr_expires_at IS NOT NULL AND qr_expires_at < NOW() AND gate_out_at IS NULL
    `);

    if (expiredList.length > 0) {
      console.log(`[QR Auto-Destroy] Destroying ${expiredList.length} expired QR code(s) older than 30 mins...`);
      for (const req of expiredList) {
        // Destroy QR Token and mark status as 'expired'
        await query(`
          UPDATE onepass_requests
          SET status = 'expired', qr_token = NULL
          WHERE id = ?
        `, [req.id]);

        await query(`
          INSERT INTO onepass_logs (request_id, user_id, role_acted, action, comment)
          VALUES (?, 1, 'system', 'expired', 'QR Code หมดอายุ 30 นาที (ระบบทำลายรหัส QR อัตโนมัติ ต้องยื่นขออนุญาตใหม่)')
        `, [req.id]);

        // Send Telegram notification to Student
        const [std] = await query('SELECT * FROM users WHERE id = ?', [req.user_id]);
        if (std.length > 0) {
          const studentChatId = await telegram.getUserChatId(std[0].id);
          const msg = 
`⚠️ <b>[OnePass] บัตรผ่านและ QR Code หมดอายุแล้ว</b>
━━━━━━━━━━━━━━━━━━━━
📌 <b>เลขที่คำขอ:</b> <code>${req.request_no}</code>
👤 <b>ผู้เรียน:</b> ${std[0].full_name} (${std[0].username})
⏳ <b>เหตุผล:</b> บัตรผ่านมีอายุใช้งานเพียง 30 นาทีหลังได้รับอนุมัติ และเกินกำหนดเวลาแล้ว
🗑️ <b>สถานะ:</b> ระบบได้ทำการทำลายรหัส QR Code อัตโนมัติเรียบร้อยแล้ว
❌ ไม่สามารถนำไปสแกนที่ตู้ประตูได้ หากมีความประสงค์จะออกนอกสถานศึกษา กรุณายื่นขออนุญาตใหม่อีกครั้ง`;
          await telegram.sendTelegramMessage(studentChatId, msg);
        }
      }
    }
  } catch (err) {
    console.error('[QR Auto-Destroy] Error checking expired QR codes:', err.message);
  }
}, 60000);

// Catch-all route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`OnePass Web Application (Node.js + Vanilla JS)`);
  console.log(`Server is running at: http://localhost:${PORT}`);
  console.log(`=================================================`);

  // Non-blocking initialization so the HTTP web server never crashes on startup
  initDatabase().catch(err => {
    console.error('[DB Startup Warning]:', err.message);
  });

  try {
    telegram.startTelegramPolling();
  } catch (tgErr) {
    console.error('[Telegram Startup Warning]:', tgErr.message);
  }
});
