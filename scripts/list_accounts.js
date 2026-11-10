const db = require('../db');

async function main() {
  const [counts] = await db.query('SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY count DESC');
  console.log('=== สรุปยอดผู้ใช้ตามบทบาท (Role Summary) ===');
  console.table(counts);

  const [staff] = await db.query("SELECT id, username, full_name, role, telegram_chat_id FROM users WHERE role NOT IN ('student', 'parent') ORDER BY role, id ASC");
  console.log('\n=== รายชื่อผู้บริหาร ครู และเจ้าหน้าที่ (Admins, Teachers, Directors, Staff) ===');
  console.table(staff);

  const [bound] = await db.query("SELECT id, username, full_name, role, telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''");
  console.log('\n=== บัญชีที่เชื่อมต่อ Telegram แล้ว ณ ขณะนี้ ===');
  console.table(bound);

  const [students] = await db.query("SELECT u.id, u.username, u.full_name, s.department, l.name AS level_name, u.telegram_chat_id FROM users u JOIN students s ON u.id = s.user_id LEFT JOIN levels l ON s.level_id = l.id ORDER BY u.id ASC LIMIT 25");
  console.log('\n=== ตัวอย่างบัญชีนักเรียน (25 คนแรก) ===');
  console.table(students);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
