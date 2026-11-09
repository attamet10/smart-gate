const fs = require('fs');
const path = require('path');
const db = require('../db.js');

async function exportAccounts() {
  const [users] = await db.query(`
    SELECT 
      u.id, u.username, u.role, u.full_name, u.position,
      s.student_code, s.department, s.education_level, s.phone,
      m.name as major_name, l.name as level_name
    FROM users u
    LEFT JOIN students s ON s.user_id = u.id
    LEFT JOIN majors m ON s.major_id = m.id
    LEFT JOIN levels l ON s.level_id = l.id
    ORDER BY 
      CASE 
        WHEN u.role = 'super_admin' THEN 1
        WHEN u.role = 'admin' THEN 2
        WHEN u.role = 'director' THEN 3
        WHEN u.role = 'deputy_director' THEN 4
        WHEN u.role = 'teacher' THEN 5
        WHEN u.role = 'staff' THEN 6
        WHEN u.role = 'student' THEN 7
        WHEN u.role = 'parent' THEN 8
        ELSE 9 
      END,
      u.username ASC
  `);

  console.log('Total users fetched:', users.length);

  // 1. Build CSV with UTF-8 BOM for Excel
  const bom = '\uFEFF';
  let csv = bom + 'ลำดับ,Username (รหัสผู้ใช้),Password (รหัสผ่าน),Role (บทบาท),ชื่อ-นามสกุล,ตำแหน่ง/ระดับชั้น,แผนกวิชา,เบอร์โทรศัพท์\n';

  users.forEach((u, i) => {
    const roleMap = {
      super_admin: 'ผู้ดูแลระบบสูงสุด',
      admin: 'ผู้ดูแลระบบ',
      director: 'ผู้อำนวยการ',
      deputy_director: 'รองผู้อำนวยการ',
      teacher: 'ครูผู้สอน / ครูที่ปรึกษา',
      staff: 'เจ้าหน้าที่ / บุคลากร',
      student: 'นักเรียน / นักศึกษา',
      parent: 'ผู้ปกครอง'
    };
    const roleTh = roleMap[u.role] || u.role;
    const pos = (u.position || u.education_level || u.level_name || '-').replace(/,/g, ' ');
    const dept = (u.department || u.major_name || '-').replace(/,/g, ' ');
    const name = (u.full_name || '-').replace(/,/g, ' ');
    const phone = (u.phone || '-').replace(/,/g, ' ');
    const pass = '123456';

    csv += `${i + 1},${u.username},${pass},${roleTh},"${name}","${pos}","${dept}","${phone}"\n`;
  });

  const csvPath = path.join(__dirname, '..', 'onepass_user_accounts.csv');
  fs.writeFileSync(csvPath, csv, 'utf8');
  console.log(`Saved: ${csvPath}`);

  // 2. Build Markdown
  let md = '# 📋 บัญชีผู้ใช้งานระบบ OnePass - วิทยาลัยการอาชีพองครักษ์\n\n';
  md += '> 🔑 **รหัสผ่านเริ่มต้นสำหรับทุกบัญชี:** `123456`\n';
  md += '> 🌐 **เว็บไซต์เข้าสู่ระบบ:** [https://onepass.ongkharak.ac.th/](https://onepass.ongkharak.ac.th/)\n';
  md += '> 📊 **จำนวนผู้ใช้งานทั้งหมดในระบบ:** ' + users.length + ' บัญชี\n\n';
  md += '---\n\n';

  // Group by role
  const superAdmins = users.filter(u => u.role === 'super_admin' || u.role === 'admin');
  const executives = users.filter(u => u.role === 'director' || u.role === 'deputy_director');
  const teachers = users.filter(u => u.role === 'teacher');
  const staff = users.filter(u => u.role === 'staff');
  const students = users.filter(u => u.role === 'student');
  const parents = users.filter(u => u.role === 'parent');

  md += '## 1. 👑 ผู้ดูแลระบบ (Admins)\n\n';
  md += '| ลำดับ | Username | รหัสผ่าน | ชื่อ-นามสกุล | ตำแหน่ง | สิทธิ์ในระบบ |\n';
  md += '|:---:|---|:---:|---|---|---|\n';
  superAdmins.forEach((u, i) => {
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | **${u.full_name || '-'}** | ${u.position || '-'} | \`${u.role}\` |\n`;
  });

  md += '\n## 2. 🏛️ ผู้บริหารสถานศึกษา (Executives)\n\n';
  md += '| ลำดับ | Username | รหัสผ่าน | ชื่อ-นามสกุล | ตำแหน่ง | บทบาทในการอนุมัติบัตรผ่าน |\n';
  md += '|:---:|---|:---:|---|---|---|\n';
  executives.forEach((u, i) => {
    const note = u.role === 'deputy_director' ? 'ผู้อนุมัติขั้นสุดท้าย (รอง ผอ. ฝ่ายพัฒนากิจการฯ)' : 'ผู้อำนวยการสถานศึกษา';
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | **${u.full_name || '-'}** | ${u.position || '-'} | ${note} |\n`;
  });

  md += `\n## 3. 👨‍🏫 คณะครูและอาจารย์ (Teachers - ${teachers.length} ท่าน)\n\n`;
  md += '| ลำดับ | Username | รหัสผ่าน | ชื่อ-นามสกุล | ตำแหน่ง |\n';
  md += '|:---:|---|:---:|---|---|\n';
  teachers.forEach((u, i) => {
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | **${u.full_name || '-'}** | ${u.position || '-'} |\n`;
  });

  md += `\n## 4. 🏢 เจ้าหน้าที่และบุคลากร (Staff - ${staff.length} ท่าน)\n\n`;
  md += '| ลำดับ | Username | รหัสผ่าน | ชื่อ-นามสกุล | ตำแหน่ง |\n';
  md += '|:---:|---|:---:|---|---|\n';
  staff.forEach((u, i) => {
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | **${u.full_name || '-'}** | ${u.position || '-'} |\n`;
  });

  md += `\n## 5. 🎓 นักเรียน / นักศึกษา (Students - ${students.length} คน)\n\n`;
  md += '| ลำดับ | รหัสนักเรียน (Username) | รหัสผ่าน | ชื่อ-นามสกุล | ระดับชั้น | แผนกวิชา | เบอร์โทรศัพท์ |\n';
  md += '|:---:|---|:---:|---|---|---|:---:|\n';
  students.forEach((u, i) => {
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | **${u.full_name || '-'}** | ${u.education_level || u.level_name || '-'} | ${u.department || u.major_name || '-'} | ${u.phone || '-'} |\n`;
  });

  md += `\n## 6. 👨‍👩‍👧 ผู้ปกครอง (Parents - ${parents.length} บัญชี)\n\n`;
  md += '> 💡 **หมายเหตุ:** Username ผู้ปกครองคือตัว `p` นำหน้ารหัสนักเรียน เช่น `p69201010001` โดยมีรหัสผ่านเริ่มต้นคือ `123456`\n\n';
  md += '| ลำดับ | Username ผู้ปกครอง | รหัสผ่าน | ชื่อผู้ปกครอง / นักเรียนในปกครอง |\n';
  md += '|:---:|---|:---:|---|\n';
  parents.slice(0, 30).forEach((u, i) => {
    md += `| ${i + 1} | \`${u.username}\` | \`123456\` | ${u.full_name || '-'} |\n`;
  });
  if (parents.length > 30) {
    md += `| ... | *(ดูรายการครบทั้งหมด ${parents.length} บัญชีในไฟล์ \`onepass_user_accounts.csv\`)* | \`123456\` | - |\n`;
  }

  const mdPath = path.join(__dirname, '..', 'ONEPASS_USER_ACCOUNTS.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`Saved: ${mdPath}`);
  process.exit(0);
}

exportAccounts().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
