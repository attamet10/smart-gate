/**
 * OnePass - Database Connection & Table Initialization
 * Using mysql2/promise for XAMPP MySQL (ongkharak_std)
 * Supports dynamic auto-detection for both 3307 and 3306
 */

const fs = require('fs');
const net = require('net');
const mysql = require('mysql2/promise');

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function detectDefaultPort() {
  if (process.env.DB_PORT) return parseInt(process.env.DB_PORT, 10);
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
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ongkharak_std',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });
}

pool = createPool(activePort);

async function getConnectedPool() {
  // If current pool works, use it
  try {
    const conn = await pool.getConnection();
    conn.release();
    return pool;
  } catch (err) {
    // If port failed, test alternative ports
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
    throw new Error(`ไม่สามารถเชื่อมต่อ MySQL ได้ (พอร์ต 3307/3306) กรุณาเปิดโปรแกรม XAMPP แล้วกดปุ่ม "Start" ที่ MySQL`);
  }
}

/**
 * Initialize OnePass tables if they don't exist
 */
async function initDatabase() {
  try {
    const p = await getConnectedPool();
    const connection = await p.getConnection();
    console.log(`[DB] Connected successfully to MySQL (ongkharak_std on port ${activePort})`);

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
        \`qr_token\` VARCHAR(128) UNIQUE DEFAULT NULL,
        \`qr_expires_at\` DATETIME DEFAULT NULL,
        \`gate_out_by\` INT DEFAULT NULL,
        \`gate_out_at\` DATETIME DEFAULT NULL,
        \`gate_in_by\` INT DEFAULT NULL,
        \`gate_in_at\` DATETIME DEFAULT NULL,
        \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (\`student_id\`),
        INDEX (\`user_id\`),
        INDEX (\`subject_teacher_id\`),
        INDEX (\`advisor_teacher_id\`),
        INDEX (\`head_major_teacher_id\`),
        INDEX (\`head_discipline_user_id\`),
        INDEX (\`deputy_director_user_id\`),
        INDEX (\`status\`),
        INDEX (\`qr_token\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Create onepass_logs table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS \`onepass_logs\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`request_id\` INT NOT NULL,
        \`user_id\` INT NOT NULL,
        \`role_acted\` VARCHAR(64) NOT NULL,
        \`action\` ENUM('created', 'approved', 'rejected', 'gate_exit', 'gate_return', 'cancelled') NOT NULL,
        \`comment\` TEXT DEFAULT NULL,
        \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (\`request_id\`),
        INDEX (\`user_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    connection.release();
    console.log('[DB] OnePass tables verified/initialized.');
  } catch (err) {
    console.error(`[DB] Database initialization error:`, err.message);
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
