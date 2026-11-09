const fs = require('fs');
const sql = fs.readFileSync('database/ongkharak_std.sql', 'utf8');

const majorMap = {
  1: 'ช่างยนต์',
  2: 'ช่างไฟฟ้ากำลัง',
  3: 'การบัญชี',
  4: 'การจัดการ',
  5: 'เทคโนโลยีธุรกิจดิจิทัล',
  6: 'สามัญสัมพันธ์',
  7: 'เทคนิคพื้นฐาน'
};

const headMajors = {
  413: 'ช่างยนต์',
  410: 'ช่างไฟฟ้ากำลัง',
  415: 'การบัญชี',
  412: 'การจัดการ',
  411: 'เทคโนโลยีธุรกิจดิจิทัล',
  419: 'สามัญสัมพันธ์',
  422: 'เทคนิคพื้นฐาน'
};

// Advisor assignments
const advisorMatches = sql.matchAll(/\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g);
const teacherMajorMap = {};
for (const m of advisorMatches) {
  const majorId = parseInt(m[3]);
  const teacherId = parseInt(m[4]);
  if (majorMap[majorId]) {
    if (!teacherMajorMap[teacherId]) teacherMajorMap[teacherId] = new Set();
    teacherMajorMap[teacherId].add(majorMap[majorId]);
  }
}

// Find all users with role 'teacher' or 'tc%'
const lines = sql.split(/\r?\n/);
const userRows = [];
for (const l of lines) {
  if (l.includes("'teacher'") || l.includes("'tc")) {
    const m = l.match(/\((\d+),\s*'([^']+)',\s*(NULL|'[^']*'),\s*'([^']+)',\s*'([^']+)'/);
    if (m) {
      const [_, id, username, email, role, full_name] = m;
      let dept = headMajors[id] ? `${headMajors[id]} (หัวหน้าแผนก)` : '';
      if (!dept && teacherMajorMap[id]) {
        dept = Array.from(teacherMajorMap[id]).join(', ');
      }
      userRows.push({ id, username, role, full_name, dept: dept || '-' });
    }
  }
}

console.log('Total teachers/staff found:', userRows.length);
userRows.forEach(u => {
  console.log(`${u.id.padEnd(5)} | ${u.username.padEnd(6)} | ${u.full_name.padEnd(30)} | ${u.dept}`);
});
