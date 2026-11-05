// ============================================================================
// OnePass Smart Gate: MySQL Database Access Layer (replaces @supabase/supabase-js)
// ============================================================================
// ออกแบบให้ใช้งานคล้ายกับ Supabase Client เดิมมากที่สุด เพื่อลด diff ในไฟล์ server.js/telegram.js:
//   - db.pool            : ใช้เช็คว่าตั้งค่า MySQL ไว้หรือยัง (เหมือนตัวแปร supabase เดิมที่เป็น null ถ้าไม่ได้ตั้งค่า)
//   - db.query(sql, params)              : รัน SQL พร้อม parameter แบบ parameterized แล้วคืนเฉพาะ rows
//   - db.insertWithUuid(table, data)     : ใช้กับตารางที่ PK เป็น UUID (users, telegram_link_tokens, device_approval_requests)
//   - db.insertAutoIncrement(table, data): ใช้กับตารางที่ PK เป็น AUTO_INCREMENT
//   - db.isMissingColumnError(err)       : แทนการเช็ค error.message.includes('column') แบบเดิม
//   - db.getUserWithClassroomAndDepartment / getUserByUsernameWithRelations / ฯลฯ : relation helper สำหรับ embed แบบเดิมของ Supabase
// ============================================================================

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306;
const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;

let rawPool = null;
if (DB_HOST && DB_USER) {
  try {
    rawPool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      dateStrings: true // คืนค่า DATE/DATETIME เป็น string ตรงๆ เหมือน Postgres TIMESTAMPTZ -> ISO string เดิม
    });
  } catch (err) {
    console.warn('⚠️ [MYSQL] Failed to create connection pool:', err.message);
    rawPool = null;
  }
}

// เหมือนตัวแปร `supabase` เดิมที่เป็น null ถ้ายังไม่ได้ตั้งค่า env - ใช้แพทเทิร์น if (db.pool) { ... } ได้เหมือนเดิม
const pool = rawPool;

// ----------------------------------------------------------------------------
// Self-bootstrap schema: สร้างตารางทั้งหมดอัตโนมัติตอนแอปสตาร์ทครั้งแรก (ถ้ายังไม่มี)
// ----------------------------------------------------------------------------
// เซิร์ฟเวอร์ production (Plesk shared hosting) ไม่มี SSH/shell ให้รัน `mysql < schema.mysql.sql` เอง
// จึงให้แอปอ่านไฟล์ database/schema.mysql.sql แล้วรันเฉพาะคำสั่ง CREATE TABLE/CREATE INDEX เองตอนบูท
// (ข้าม DROP TABLE เสมอ - ไม่ลบข้อมูลที่มีอยู่แล้วเด็ดขาด, แปลง CREATE TABLE ให้เป็น IF NOT EXISTS, และ
//  ignore error "duplicate key name" ของ CREATE INDEX เพราะ MySQL ไม่รองรับ CREATE INDEX IF NOT EXISTS)
async function bootstrapSchema() {
  if (!rawPool) return;
  const schemaPath = path.join(__dirname, 'database', 'schema.mysql.sql');
  let sql;
  try {
    sql = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    console.warn('⚠️ [MYSQL] Skip schema bootstrap: cannot read', schemaPath, err.message);
    return;
  }

  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    const upper = stmt.toUpperCase();
    if (upper.startsWith('DROP TABLE')) continue; // ไม่ลบข้อมูลที่มีอยู่แล้วเด็ดขาด
    try {
      if (upper.startsWith('CREATE TABLE') && !upper.includes('IF NOT EXISTS')) {
        await rawPool.query(stmt.replace(/CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS'));
      } else {
        await rawPool.query(stmt);
      }
    } catch (err) {
      // CREATE INDEX ไม่มี IF NOT EXISTS ใน MySQL - ถ้ามี index ชื่อนี้อยู่แล้วให้ข้ามไปเงียบๆ
      if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_TABLE_EXISTS_ERROR') continue;
      console.warn('⚠️ [MYSQL] Schema bootstrap statement failed:', err.message, '\n  SQL:', stmt.slice(0, 100));
    }
  }
  console.log('✅ [MYSQL] Schema bootstrap complete (ตรวจสอบ/สร้างตารางที่ยังไม่มีเรียบร้อย)');
}

if (rawPool) {
  bootstrapSchema().catch((err) => console.warn('⚠️ [MYSQL] Schema bootstrap error:', err.message));
}

// ----------------------------------------------------------------------------
// Core query helper: คืนเฉพาะ rows (mysql2 คืน [rows, fields])
// ----------------------------------------------------------------------------
// รองรับ WHERE col IN (?) โดยส่ง array เป็น param ตัวเดียว (เช่น .in('status', [...]) เดิมของ Supabase)
// ขยาย placeholder ให้ตรงกับจำนวนสมาชิกใน array เองก่อนส่งเข้า pool.execute() (prepared statement) เพื่อไม่พึ่งพา
// behavior เฉพาะเวอร์ชันของ mysql2 ในการขยาย IN (?) อัตโนมัติ
function expandArrayParams(sql, params) {
  if (!params.some((p) => Array.isArray(p))) return { sql, params };
  let paramIndex = 0;
  const flatParams = [];
  const expandedSql = sql.replace(/\?/g, () => {
    const p = params[paramIndex++];
    if (Array.isArray(p)) {
      flatParams.push(...p);
      return p.map(() => '?').join(', ');
    }
    flatParams.push(p);
    return '?';
  });
  return { sql: expandedSql, params: flatParams };
}

// Postgres/Supabase เดิมรับค่า ISO-8601 (เช่น new Date().toISOString() -> "2026-11-05T14:23:20.217Z")
// ใส่ลงคอลัมน์ TIMESTAMPTZ ได้ตรงๆ แต่ MySQL DATETIME ไม่รับรูปแบบที่มี "T"/"Z"/มิลลิวินาที
// แปลงทุก param ที่เป็น Date object หรือ string รูปแบบ ISO-8601 ให้เป็น "YYYY-MM-DD HH:MM:SS" ก่อนส่งเข้า query เสมอ
// เพื่อไม่ต้องแก้ไขทุกจุดใน server.js/telegram.js ที่เคยสร้างค่าด้วย .toISOString()
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/;
function toMysqlDateTime(value) {
  if (value instanceof Date) {
    return value.toISOString().replace('T', ' ').replace(/\.\d+Z?$/, '');
  }
  if (typeof value === 'string') {
    const m = value.match(ISO_DATETIME_RE);
    if (m) return `${m[1]} ${m[2]}`;
  }
  return value;
}
function normalizeParams(params) {
  return params.map((p) => (Array.isArray(p) ? p.map(toMysqlDateTime) : toMysqlDateTime(p)));
}

async function query(sql, params = []) {
  if (!pool) throw new Error('MySQL pool is not configured (missing DB_HOST/DB_USER env vars)');
  const { sql: finalSql, params: finalParams } = expandArrayParams(sql, normalizeParams(params));
  const [rows] = await pool.execute(finalSql, finalParams);
  return rows;
}

// ----------------------------------------------------------------------------
// Insert helpers
// ----------------------------------------------------------------------------

// สำหรับตารางที่ Primary Key เป็น UUID (users, telegram_link_tokens, device_approval_requests)
// Postgres เดิมใช้ gen_random_uuid() เป็น default ของ DB, MySQL ไม่มีฟังก์ชันนี้ -> สร้าง UUID ฝั่ง JS ก่อน insert
async function insertWithUuid(table, data) {
  const id = data && data.id ? data.id : crypto.randomUUID();
  const fullData = { ...data, id };
  const columns = Object.keys(fullData);
  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map((c) => fullData[c]);
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  await query(sql, values);
  return fullData;
}

// สำหรับตารางที่ Primary Key เป็น AUTO_INCREMENT (leave_requests, approval_logs, scan_logs, departments, classrooms, student_import_logs)
async function insertAutoIncrement(table, data) {
  const columns = Object.keys(data);
  const placeholders = columns.map(() => '?').join(', ');
  const values = normalizeParams(columns.map((c) => data[c]));
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  const [result] = await pool.execute(sql, values);
  const rows = await query(`SELECT * FROM ${table} WHERE id = ?`, [result.insertId]);
  return rows[0] || { id: result.insertId, ...data };
}

// ----------------------------------------------------------------------------
// แทนการเช็ค error.message.includes('column') แบบเดิมของ Supabase/Postgres
// ----------------------------------------------------------------------------
function isMissingColumnError(err) {
  if (!err) return false;
  return err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE';
}

// ============================================================================
// RELATION HELPERS
// แทนที่ Nested/Embedded PostgREST selects ของ Supabase เช่น
//   .select('*, classrooms (name, advisor_name), departments (name)')
//   .select('*, users:student_id (full_name, username, ..., classrooms(name), departments(name))')
// ด้วย explicit SQL JOIN แล้ว reshape กลับให้เป็น object รูปร่างเดิมที่ server.js/telegram.js คาดหวัง
// (เก็บ superset ของคอลัมน์ที่ทุก call site ต้องใช้ไว้ในที่เดียว เพราะทุก call site join ตารางเดียวกันแค่ขอคอลัมน์
//  ไม่เท่ากัน - การคืนคอลัมน์เกินมาไม่กระทบ behavior เดิมเพราะโค้ดเดิมก็แค่หยิบ field ที่ต้องใช้จาก object เท่านั้น)
// ============================================================================

// ---- users + classrooms + departments -------------------------------------
async function queryUsersWithRelations(whereClause = '', params = [], orderBy = '') {
  const sql = `
    SELECT u.*,
           c.id AS classroom_id_joined, c.name AS classroom_name, c.advisor_name AS classroom_advisor_name,
           d.id AS department_id_joined, d.name AS department_name
    FROM users u
    LEFT JOIN classrooms c ON u.classroom_id = c.id
    LEFT JOIN departments d ON u.department_id = d.id
    ${whereClause ? `WHERE ${whereClause}` : ''}
    ${orderBy ? `ORDER BY ${orderBy}` : ''}
  `;
  const rows = await query(sql, params);
  return rows.map(reshapeUserRow);
}

function reshapeUserRow(row) {
  const {
    classroom_id_joined, classroom_name, classroom_advisor_name,
    department_id_joined, department_name,
    ...rest
  } = row;
  return {
    ...rest,
    classrooms: (classroom_name !== null && classroom_name !== undefined)
      ? { id: classroom_id_joined, name: classroom_name, advisor_name: classroom_advisor_name }
      : null,
    departments: (department_name !== null && department_name !== undefined)
      ? { id: department_id_joined, name: department_name }
      : null
  };
}

async function getUserWithClassroomAndDepartment(userId) {
  const rows = await queryUsersWithRelations('u.id = ?', [userId]);
  return rows[0];
}

async function getUserByUsernameWithRelations(username) {
  const rows = await queryUsersWithRelations('u.username = ?', [username]);
  return rows[0];
}

async function getUserByFullNameWithRelations(fullName) {
  const rows = await queryUsersWithRelations('u.full_name = ?', [fullName]);
  return rows[0];
}

// แทนที่ .or(`student_code.eq.${code},username.eq.${code}`) แบบ parameterized
async function getUserByCodeOrUsernameWithRelations(code) {
  const rows = await queryUsersWithRelations('u.student_code = ? OR u.username = ?', [code, code]);
  return rows[0];
}

// ---- leave_requests + users(+classrooms+departments) ----------------------
async function queryLeaveRequestsWithStudent(whereClause = '', params = [], orderBy = '') {
  const sql = `
    SELECT lr.*,
           u.full_name AS student_full_name, u.username AS student_username,
           u.plate_no AS student_plate_no, u.phone AS student_phone, u.parent_phone AS student_parent_phone,
           u.profile_photo AS student_profile_photo, u.plate_photo AS student_plate_photo,
           c.name AS student_classroom_name, c.advisor_name AS student_classroom_advisor_name,
           d.name AS student_department_name
    FROM leave_requests lr
    LEFT JOIN users u ON lr.student_id = u.id
    LEFT JOIN classrooms c ON u.classroom_id = c.id
    LEFT JOIN departments d ON u.department_id = d.id
    ${whereClause ? `WHERE ${whereClause}` : ''}
    ${orderBy ? `ORDER BY ${orderBy}` : ''}
  `;
  const rows = await query(sql, params);
  return rows.map(reshapeLeaveRequestRow);
}

function reshapeLeaveRequestRow(row) {
  const {
    student_full_name, student_username, student_plate_no, student_phone, student_parent_phone,
    student_profile_photo, student_plate_photo, student_classroom_name, student_classroom_advisor_name,
    student_department_name,
    ...rest
  } = row;
  const hasStudent = student_username !== null && student_username !== undefined;
  return {
    ...rest,
    users: hasStudent ? {
      full_name: student_full_name,
      username: student_username,
      plate_no: student_plate_no,
      phone: student_phone,
      parent_phone: student_parent_phone,
      profile_photo: student_profile_photo,
      plate_photo: student_plate_photo,
      classrooms: (student_classroom_name !== null && student_classroom_name !== undefined)
        ? { name: student_classroom_name, advisor_name: student_classroom_advisor_name }
        : null,
      departments: (student_department_name !== null && student_department_name !== undefined)
        ? { name: student_department_name }
        : null
    } : null
  };
}

async function getLeaveRequestWithStudent(id) {
  const rows = await queryLeaveRequestsWithStudent('lr.id = ?', [id]);
  return rows[0];
}

async function getLeaveRequestsWithStudent(whereClause = '', params = [], orderBy = '') {
  return queryLeaveRequestsWithStudent(whereClause, params, orderBy);
}

module.exports = {
  pool,
  query,
  insertWithUuid,
  insertAutoIncrement,
  isMissingColumnError,
  queryUsersWithRelations,
  getUserWithClassroomAndDepartment,
  getUserByUsernameWithRelations,
  getUserByFullNameWithRelations,
  getUserByCodeOrUsernameWithRelations,
  queryLeaveRequestsWithStudent,
  getLeaveRequestWithStudent,
  getLeaveRequestsWithStudent
};
