const db = require('../db.js');
const crypto = require('crypto');

async function createNewApprovedPass() {
  const token = 'OP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours from now

  // Check if OP-20261109-0004 exists, if so increment
  const [rows] = await db.query("SELECT request_no FROM onepass_requests ORDER BY id DESC LIMIT 1");
  let nextNo = 'OP-20261109-0004';
  if (rows.length > 0) {
    const cur = rows[0].request_no;
    const num = parseInt(cur.split('-')[2]) + 1;
    nextNo = `OP-20261109-${String(num).padStart(4, '0')}`;
  }

  const [res] = await db.query(`
    INSERT INTO onepass_requests (
      request_no, student_id, user_id, leave_date, leave_time, expected_return_time,
      is_not_returning, leave_type, reason, reason_detail,
      subject_teacher_id, advisor_teacher_id, head_major_teacher_id, head_discipline_user_id, deputy_director_user_id,
      subject_status, subject_comment, subject_action_at,
      advisor_status, advisor_comment, advisor_action_at,
      head_major_status, head_major_comment, head_major_action_at,
      head_discipline_status, head_discipline_comment, head_discipline_action_at,
      deputy_director_status, deputy_director_comment, deputy_director_action_at,
      status, qr_token, qr_expires_at, created_at, updated_at
    ) VALUES (
      ?, 119, 247, CURDATE(), '15:40:00', '17:30:00',
      0, 'temporary', 'ทดสอบระบบตู้ประตูอัจฉริยะ OnePass Smart Gate', 'สร้างรหัสทดสอบใหม่',
      408, 428, 411, 414, 438,
      'approved', 'อนุมัติผ่าน', NOW(),
      'approved', 'อนุมัติผ่าน', NOW(),
      'approved', 'อนุมัติผ่าน', NOW(),
      'approved', 'อนุมัติผ่าน', NOW(),
      'approved', 'อนุมัติผ่าน', NOW(),
      'approved', ?, ?, NOW(), NOW()
    )
  `, [nextNo, token, expiresAt]);

  console.log(JSON.stringify({
    success: true,
    id: res.insertId,
    request_no: nextNo,
    token: token,
    expires_at: expiresAt
  }, null, 2));

  process.exit(0);
}

createNewApprovedPass().catch(err => {
  console.error(err);
  process.exit(1);
});
