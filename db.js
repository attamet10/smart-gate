/**
 * OnePass - Database Connection & Table Initialization
 * Using mysql2/promise for MySQL (Local XAMPP 3307/3306 & Production Plesk 3306)
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const mysql = require('mysql2/promise');

// Auto-load .env if file exists without needing external dotenv
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    });
  }
} catch (e) {}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, process.env.DB_HOST || '127.0.0.1');
  });
}

function detectDefaultPort() {
  if (process.env.DB_PORT) return parseInt(process.env.DB_PORT, 10);
  if (process.platform !== 'win32') return 3306; // Linux / Plesk standard
  try {
    const iniPath = 'C:\\xampp\\mysql\\bin\\my.ini';
    if (fs.existsSync(iniPath)) {
      const content = fs.readFileSync(iniPath, 'utf8');
      const match = content.match(/^port\s*=\s*(\d+)/m);
      if (match) return parseInt(match[1], 10);
    }
  } catch (e) {}
  return 3307;
}

let activePort = detectDefaultPort();
let pool = null;

function createPool(port) {
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: port,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : '',
    database: process.env.DB_NAME || 'ongkharak_std',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });
}

pool = createPool(activePort);

async function getConnectedPool() {
  try {
    const conn = await pool.getConnection();
    conn.release();
    return pool;
  } catch (err) {
    // If port failed, try alternative ports
    if (process.platform === 'win32') {
      if (await checkPort(3307)) {
        activePort = 3307;
        pool = createPool(3307);
        return pool;
      }
      if (await checkPort(3306)) {
        activePort = 3306;
        pool = createPool(3306);
        return pool;
      }
    } else {
      if (await checkPort(3306)) {
        activePort = 3306;
        pool = createPool(3306);
        return pool;
      }
    }
    throw new Error(`ไม่สามารถเชื่อมต่อ MySQL ได้ (${err.message}) กรุณาตรวจสอบการตั้งค่าฐานข้อมูล`);
  }
}

/**
 * Initialize OnePass tables if they don't exist
 */
async function initDatabase() {
  try {
    const connection = await getConnectedPool();
    console.log(`[DB] Connected successfully to MySQL (${process.env.DB_NAME || 'ongkharak_std'} on port ${activePort})`);

    // 0. Ensure must_change_password column exists on users table
    try {
      await connection.query("ALTER TABLE `users` ADD COLUMN `must_change_password` TINYINT(1) DEFAULT 0");
    } catch (e) {
      // Column already exists or no ALTER permission - perfectly safe to ignore
    }

    // 1. Create onepass_requests table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`onepass_requests\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`request_no\` VARCHAR(64) NOT NULL UNIQUE,
        \`student_id\` INT NOT NULL,
        \`user_id\` INT NOT NULL,
        \`leave_date\` DATE NOT NULL,
        \`leave_time\` TIME NOT NULL,
        \`expected_return_time\` TIME DEFAULT NULL,
        \`is_not_returning\` TINYINT(1) NOT NULL DEFAULT 0,
        \`leave_type\` VARCHAR(32) NOT NULL DEFAULT 'temporary',
        \`reason\` VARCHAR(255) NOT NULL,
        \`reason_detail\` TEXT DEFAULT NULL,
        \`attachment_url\` TEXT DEFAULT NULL,
        \`subject_teacher_id\` INT NOT NULL,
        \`advisor_teacher_id\` INT NOT NULL,
        \`head_major_teacher_id\` INT NOT NULL,
        \`head_discipline_user_id\` INT NOT NULL,
        \`deputy_director_user_id\` INT NOT NULL,
        \`subject_status\` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`subject_comment\` TEXT DEFAULT NULL,
        \`subject_action_at\` DATETIME DEFAULT NULL,
        \`advisor_status\` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`advisor_comment\` TEXT DEFAULT NULL,
        \`advisor_action_at\` DATETIME DEFAULT NULL,
        \`head_major_status\` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`head_major_comment\` TEXT DEFAULT NULL,
        \`head_major_action_at\` DATETIME DEFAULT NULL,
        \`head_discipline_status\` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`head_discipline_comment\` TEXT DEFAULT NULL,
        \`head_discipline_action_at\` DATETIME DEFAULT NULL,
        \`deputy_director_status\` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`deputy_director_comment\` TEXT DEFAULT NULL,
        \`deputy_director_action_at\` DATETIME DEFAULT NULL,
        \`status\` ENUM(
          'pending_subject',
          'pending_advisor',
          'pending_head_major',
          'pending_head_discipline',
          'pending_deputy',
          'approved',
          'rejected',
          'cancelled',
          'completed',
          'expired'
        ) NOT NULL DEFAULT 'pending_subject',
        \`qr_token\` VARCHAR(64) DEFAULT NULL,
        \`qr_expires_at\` DATETIME DEFAULT NULL,
        \`gate_out_by\` INT DEFAULT NULL,
        \`gate_out_at\` DATETIME DEFAULT NULL,
        \`gate_in_by\` INT DEFAULT NULL,
        \`gate_in_at\` DATETIME DEFAULT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`idx_student_id\` (\`student_id\`),
        INDEX \`idx_user_id\` (\`user_id\`),
        INDEX \`idx_status\` (\`status\`),
        INDEX \`idx_qr_token\` (\`qr_token\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Create advisor_assignments table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`advisor_assignments\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`level_id\` INT NOT NULL,
        \`major_id\` INT NOT NULL,
        \`teacher_id\` INT NOT NULL,
        \`academic_year\` VARCHAR(10) NOT NULL DEFAULT '2569',
        \`term\` VARCHAR(5) NOT NULL DEFAULT '2',
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`uk_advisor_assignment\` (\`level_id\`, \`major_id\`, \`teacher_id\`, \`academic_year\`, \`term\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Create gate_duty_assignments table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`gate_duty_assignments\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`head_of_discipline_user_id\` INT DEFAULT NULL,
        \`deputy_director_user_id\` INT DEFAULT NULL,
        \`updated_by\` INT DEFAULT NULL,
        \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('[DB] OnePass tables verified/initialized.');
  } catch (err) {
    console.error(`[DB Warning] Database connection/initialization error:`, err.message);
  }
}

async function executeQuery(sql, params) {
  const p = await getConnectedPool();
  return p.query(sql, params);
}

module.exports = {
  pool,
  initDatabase,
  query: executeQuery
};
