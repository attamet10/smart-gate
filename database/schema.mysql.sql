-- ============================================================================
-- SMART GATE (ONE-PASS) DATABASE SCHEMA FOR MYSQL 8 - V2 (5 STEPS + TIMETABLE)
-- ระบบขออนุญาตออกนอกสถานศึกษา วิทยาลัยการอาชีพองครักษ์ (รองรับสายอนุมัติ 5 ขั้นตอน & ตารางสอนอัตโนมัติ)
--
-- แปลงจาก database/schema.sql (PostgreSQL/Supabase) + database/migration_telegram.sql +
-- database/migration_student_device_login.sql ให้เป็น MySQL 8 DDL ตัวเดียวที่สร้างครบทุกตารางได้ในคำสั่งเดียว
-- (ไม่มีข้อมูลเดิมต้อง Migrate เพราะเป็นการ Deploy ใหม่ จึงรวม ALTER TABLE เดิมเข้าไปใน CREATE TABLE ให้หมดแล้ว)
--
-- หมายเหตุการแปลง:
--   SERIAL / BIGSERIAL              -> INT/BIGINT AUTO_INCREMENT PRIMARY KEY
--   UUID PRIMARY KEY DEFAULT gen_random_uuid() -> CHAR(36) PRIMARY KEY (ไม่มีค่า default จาก DB, แอปสร้าง UUID ด้วย crypto.randomUUID() ก่อน insert)
--   TIMESTAMPTZ DEFAULT NOW()       -> DATETIME DEFAULT CURRENT_TIMESTAMP
--   JSONB                           -> JSON
--   DROP TABLE ... CASCADE          -> DROP TABLE IF EXISTS ... (ลำดับ Drop เรียงลูกก่อนพ่อ ไม่ต้องใช้ CASCADE)
--   CHECK (col IN (...))            -> คงไว้เหมือนเดิม (MySQL 8.0.16+ รองรับ CHECK constraint)
--   ON DELETE CASCADE / SET NULL    -> คงไว้เหมือนเดิม (InnoDB รองรับทั้งสองแบบ)
--
-- หมายเหตุคอลัมน์เพิ่มเติมที่ไม่มีอยู่ใน schema.sql/migration ใดๆ แต่ถูกใช้งานจริงในโค้ด (reverse-engineered จาก server.js):
--   users: status, birth_date, failed_attempts (ใช้ในระบบนำเข้ารายชื่อนักเรียน/บัญชีรอยืนยัน)
--   leave_requests: actual_out_time, actual_in_time, return_method, return_verification_status,
--                   return_distance_cm, return_ip, return_note, return_verified_by,
--                   return_revoked_at, return_revoked_by, admin_note (ใช้ในระบบปุ่ม "กลับมาแล้ว" และ Anti-Passback)
--   student_import_logs: ไม่มี schema.sql เดิมเลย (Supabase-only/schema drift) -> reverse-engineered จาก
--                   server.js บรรทัด insert (~6202-6216) และ select (~6886-6899)
-- ============================================================================

SET NAMES utf8mb4;

-- ----------------------------------------------------------------------------
-- 1. ล้างตารางเก่าหากต้องการสร้างใหม่ (เรียงลูกก่อนพ่อ - ไม่ต้องใช้ CASCADE)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS scan_logs;
DROP TABLE IF EXISTS approval_logs;
DROP TABLE IF EXISTS leave_requests;
DROP TABLE IF EXISTS device_approval_requests;
DROP TABLE IF EXISTS telegram_link_tokens;
DROP TABLE IF EXISTS telegram_logs;
DROP TABLE IF EXISTS login_logs;
DROP TABLE IF EXISTS student_import_logs;
DROP TABLE IF EXISTS approval_delegations;
DROP TABLE IF EXISTS timetable_overrides;
DROP TABLE IF EXISTS timetables;
DROP TABLE IF EXISTS semesters;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS classrooms;
DROP TABLE IF EXISTS departments;

-- ----------------------------------------------------------------------------
-- 2. แผนกวิชา (Departments)
-- ----------------------------------------------------------------------------
CREATE TABLE departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 3. ห้องเรียน / ชั้นเรียน (Classrooms)
-- ----------------------------------------------------------------------------
CREATE TABLE classrooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL, -- เช่น ปวช.1, ปวช.2, ปวช.3, ปวส.1, ปวส.2
    department_id INT NULL,
    advisor_name VARCHAR(100),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_classrooms_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 4. ภาคเรียน (Semesters - รองรับการเปลี่ยนตารางสอนทุกเทอมโดยข้อมูลเทอมเก่าไม่หาย)
-- ----------------------------------------------------------------------------
CREATE TABLE semesters (
    id INT AUTO_INCREMENT PRIMARY KEY,
    term_code VARCHAR(20) UNIQUE NOT NULL, -- เช่น '1/2569', '2/2569'
    name VARCHAR(100) NOT NULL,            -- เช่น 'ภาคเรียนที่ 1 ปีการศึกษา 2569'
    start_date DATE,
    end_date DATE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 5. ตารางสอนหลัก (Timetables)
-- ----------------------------------------------------------------------------
CREATE TABLE timetables (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    semester_code VARCHAR(20) NOT NULL DEFAULT '1/2569',
    department_name VARCHAR(100) NOT NULL, -- เช่น 'แผนกวิชาช่างยนต์'
    classroom VARCHAR(50) NOT NULL,        -- เช่น 'ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'
    day_of_week INT NOT NULL,              -- 1=จันทร์ ... 5=ศุกร์, 6=เสาร์, 7=อาทิตย์
    start_time TIME NOT NULL,              -- เช่น '08:00'
    end_time TIME NOT NULL,                -- เช่น '10:00'
    subject_code VARCHAR(50),              -- เช่น '20101-2001'
    subject_name VARCHAR(150) NOT NULL,    -- เช่น 'งานเครื่องยนต์เบื้องต้น'
    teacher_username VARCHAR(50),          -- username ครูผู้สอน
    teacher_name VARCHAR(150),             -- ชื่อ-สกุล ครูผู้สอน
    period_type VARCHAR(30) NOT NULL DEFAULT 'study',
    room_no VARCHAR(50),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_timetables_day CHECK (day_of_week BETWEEN 1 AND 7),
    CONSTRAINT chk_timetables_period_type CHECK (period_type IN ('study', 'break', 'activity', 'free'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 6. ตารางสอนแทน / งดสอนรายวัน (Daily Timetable Overrides - ไม่กระทบตารางหลัก)
-- ----------------------------------------------------------------------------
CREATE TABLE timetable_overrides (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    timetable_id BIGINT NULL,
    override_date DATE NOT NULL,           -- วันที่สอนแทนหรืองดสอน
    override_type VARCHAR(30) NOT NULL,
    substitute_teacher_username VARCHAR(50),
    substitute_teacher_name VARCHAR(150),
    reason TEXT,
    created_by VARCHAR(50),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_overrides_timetable FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE,
    CONSTRAINT chk_overrides_type CHECK (override_type IN ('substitute', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 7. ตารางการมอบหมายผู้อนุมัติแทนเมื่อครูไม่อยู่ (Approval Delegations)
-- ----------------------------------------------------------------------------
CREATE TABLE approval_delegations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    owner_username VARCHAR(50) NOT NULL,       -- ครูเจ้าของสิทธิ์ที่ไม่อยู่
    owner_name VARCHAR(150),
    owner_role VARCHAR(30) NOT NULL,
    delegate_username VARCHAR(50) NOT NULL,    -- ผู้รับมอบหมายให้อนุมัติแทน
    delegate_name VARCHAR(150),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 8. ผู้ใช้งานในระบบ (Users: รองรับ 5 ขั้นตอนอนุมัติ + Telegram + ผูกอุปกรณ์นักเรียน)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
    id CHAR(36) PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    password_hash TEXT,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL,
    student_code VARCHAR(50),
    department_id INT NULL,
    classroom_id INT NULL,
    advisor_name VARCHAR(150),
    college VARCHAR(150) DEFAULT 'วิทยาลัยการอาชีพองครักษ์',
    plate_no VARCHAR(100),
    phone VARCHAR(30),
    parent_phone VARCHAR(30),
    profile_photo TEXT,
    plate_photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- จาก migration_telegram.sql: เชื่อมต่อบอท Telegram
    telegram_chat_id BIGINT UNIQUE,
    telegram_username TEXT,
    telegram_connected_at DATETIME,
    telegram_notify_settings JSON,

    -- จาก migration_student_device_login.sql: ผูกอุปกรณ์ + ข้อมูลเสริมนักเรียน
    student_prefix VARCHAR(20),
    first_name TEXT,
    last_name TEXT,
    curriculum_level VARCHAR(10),
    class_year SMALLINT,
    room_number VARCHAR(10),
    advisor_username TEXT,
    onboarding_completed BOOLEAN DEFAULT FALSE,
    bound_device_id TEXT,
    bound_device_name TEXT,
    bound_device_at DATETIME,
    pending_device_id TEXT,
    pending_device_name TEXT,
    pending_device_otp VARCHAR(6),
    pending_device_otp_expires DATETIME,
    vehicle_plate TEXT,
    vehicle_photo TEXT,
    phone_number VARCHAR(20),

    -- Reverse-engineered จากระบบนำเข้ารายชื่อ/บัญชีรอยืนยัน (ไม่มีอยู่ใน schema.sql เดิม)
    status VARCHAR(30) DEFAULT 'active',
    birth_date DATE NULL,
    failed_attempts INT DEFAULT 0,

    CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_users_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL,
    CONSTRAINT chk_users_role CHECK (role IN (
        'student', 'subject_teacher', 'advisor', 'dept_head',
        'discipline_head', 'deputy_director', 'kiosk', 'admin'
    ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_users_telegram_chat_id ON users(telegram_chat_id);

-- ----------------------------------------------------------------------------
-- 9. Token ลิงก์ชั่วคราวสำหรับเชื่อมต่อ Telegram (ใช้ได้ครั้งเดียว หมดอายุใน 10 นาที)
-- ----------------------------------------------------------------------------
CREATE TABLE telegram_link_tokens (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_telegram_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_telegram_tokens_lookup ON telegram_link_tokens(token, used, expires_at);

-- ----------------------------------------------------------------------------
-- 10. ประวัติการส่งแจ้งเตือน Telegram (ตรวจจับการบล็อกบอท และ Retry)
-- ----------------------------------------------------------------------------
CREATE TABLE telegram_logs (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  chat_id BIGINT,
  notify_type VARCHAR(50),
  message_preview TEXT,
  status VARCHAR(20) DEFAULT 'success', -- 'success', 'failed', 'blocked'
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_telegram_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_telegram_logs_user_id ON telegram_logs(user_id);

-- ----------------------------------------------------------------------------
-- 11. คำขออนุมัติเครื่องใหม่ (Device Approval Requests)
-- ----------------------------------------------------------------------------
CREATE TABLE device_approval_requests (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  student_code VARCHAR(50) NOT NULL,
  student_name TEXT NOT NULL,
  department_name TEXT,
  advisor_username VARCHAR(100),
  device_id TEXT NOT NULL,
  device_name TEXT,
  ip_address TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME,
  CONSTRAINT fk_device_approvals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_device_approvals_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_device_approvals_lookup ON device_approval_requests(advisor_username, status, created_at);

-- ----------------------------------------------------------------------------
-- 12. ประวัติการเข้าสู่ระบบ (Login Audit Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE login_logs (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NULL,
  identifier VARCHAR(100) NOT NULL,     -- รหัสนักศึกษา หรือ username ที่ใช้ล็อกอิน
  role VARCHAR(30) NOT NULL,            -- student, teacher, admin, etc.
  ip_address VARCHAR(100),
  device_id VARCHAR(255),
  device_info TEXT,
  status VARCHAR(30) NOT NULL,          -- 'success', 'new_device_pending', 'blocked_rate_limit', 'failed_not_found', 'failed_password'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_login_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_login_logs_security ON login_logs(identifier, ip_address, created_at);

-- ----------------------------------------------------------------------------
-- 13. คำขออนุญาตออกนอกสถานศึกษา (Leave Requests - รองรับทั้ง 3 ขั้นเดิม และ 5 ขั้นใหม่)
-- ----------------------------------------------------------------------------
CREATE TABLE leave_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_no VARCHAR(50) UNIQUE NOT NULL,
    student_id CHAR(36) NOT NULL,
    student_code VARCHAR(50),
    title VARCHAR(150) NOT NULL,
    reason TEXT NOT NULL,
    leave_type VARCHAR(50) DEFAULT 'personal',
    destination VARCHAR(255),
    no_return BOOLEAN DEFAULT FALSE,
    travel_mode VARCHAR(30) DEFAULT 'own',
    pickup_name VARCHAR(150),
    pickup_plate VARCHAR(100),
    plate_no VARCHAR(100),
    plate_photo TEXT,
    evidence_photo TEXT,
    parent_phone VARCHAR(30),
    attachment_url TEXT,

    -- ช่วงเวลาที่ขออนุญาต
    leave_date DATE NOT NULL,
    departure_time TIME NOT NULL,
    expected_return_time VARCHAR(30) NOT NULL,
    actual_return_time VARCHAR(30),

    -- สถานะขั้นตอนการอนุมัติ 5 ขั้นตอน
    -- (pending_subject, pending_advisor, pending_dept_head, pending_discipline, pending_deputy, approved, rejected, exited, returned, expired, gate_opened)
    status VARCHAR(30) NOT NULL DEFAULT 'pending_subject',
    current_step INT NOT NULL DEFAULT 1,      -- 1=ครูรายวิชา, 2=ครูที่ปรึกษา, 3=หน.แผนก, 4=ปกครอง, 5=รองผอ., 6=อนุมัติครบ
    total_steps INT NOT NULL DEFAULT 5,       -- 5 สำหรับระบบใหม่, 3/4 สำหรับคำร้องเก่าที่ค้างอยู่
    step_entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- ข้อมูล Snapshot ครูรายวิชาและตารางสอน ณ ตอนยื่นคำร้อง (ไม่เปลี่ยนตามตารางภายหลัง)
    subject_teacher_username VARCHAR(50),
    subject_teacher_name VARCHAR(150),
    subject_name VARCHAR(150),
    subject_code VARCHAR(50),
    period_type VARCHAR(30) DEFAULT 'study',
    step1_skipped BOOLEAN DEFAULT FALSE,
    step1_skip_reason TEXT,
    manual_teacher_selected BOOLEAN DEFAULT FALSE,
    advisor_flag_verify BOOLEAN DEFAULT FALSE,
    notified_teachers JSON,

    -- ข้อมูลการข้ามขั้นฉุกเฉิน (Emergency Override โดยฝ่ายปกครอง/รองผอ.)
    is_emergency_override BOOLEAN DEFAULT FALSE,
    emergency_override_by VARCHAR(150),
    emergency_override_role VARCHAR(30),
    emergency_override_reason TEXT,

    -- ข้อมูล QR Code และความปลอดภัย
    qr_token VARCHAR(100) UNIQUE,
    qr_generated_at DATETIME,
    is_qr_used BOOLEAN NOT NULL DEFAULT FALSE,
    qr_used_at DATETIME,

    is_waived BOOLEAN DEFAULT FALSE,
    waiver_note TEXT,
    rejection_reason TEXT,
    rejected_by_step INT,
    rejected_by_name VARCHAR(150),
    rejected_by_role VARCHAR(50),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Reverse-engineered จากระบบปุ่ม "กลับมาแล้ว" / Anti-Passback ที่หน้าตู้สแกน (ไม่มีอยู่ใน schema.sql เดิม)
    actual_out_time DATETIME NULL,
    actual_in_time DATETIME NULL,
    return_method VARCHAR(20) NULL,
    return_verification_status VARCHAR(30) NULL,
    return_distance_cm DECIMAL(6,2) NULL,
    return_ip VARCHAR(50) NULL,
    return_note TEXT NULL,
    return_verified_by CHAR(36) NULL,
    return_revoked_at DATETIME NULL,
    return_revoked_by CHAR(36) NULL,
    admin_note TEXT NULL,

    CONSTRAINT fk_leave_requests_student FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 14. ประวัติการลงนามอนุมัติทุกขั้นย้อนหลัง (Approval Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE approval_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT NOT NULL,
    step INT NOT NULL,                        -- 1 ถึง 5
    step_name VARCHAR(100),                   -- เช่น 'ครูรายวิชา', 'ครูที่ปรึกษา', 'หัวหน้าแผนกวิชา', 'ฝ่ายปกครอง', 'รองผู้อำนวยการ'
    approver_id CHAR(36) NULL,
    approver_username VARCHAR(50),
    approver_name VARCHAR(150),
    approver_role VARCHAR(30),
    intended_approver_name VARCHAR(150),      -- ชื่อครูตัวจริง (กรณีอนุมัติแทน)
    is_delegated BOOLEAN DEFAULT FALSE,       -- true เมื่อเป็นการอนุมัติแทน
    delegate_reason TEXT,                     -- เหตุผลที่อนุมัติแทน
    is_emergency_override BOOLEAN DEFAULT FALSE, -- true เมื่อเป็นการข้ามขั้นฉุกเฉิน
    action VARCHAR(30) NOT NULL,
    note TEXT,
    action_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_approval_logs_request FOREIGN KEY (request_id) REFERENCES leave_requests(id) ON DELETE CASCADE,
    CONSTRAINT fk_approval_logs_approver FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT chk_approval_logs_action CHECK (action IN (
        'approved', 'rejected', 'skipped_no_class', 'delegated_approve', 'emergency_override'
    ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 15. ประวัติการสแกนผ่านประตูที่หน้าตู้ (Scan Logs)
-- ----------------------------------------------------------------------------
CREATE TABLE scan_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT NULL,
    qr_token VARCHAR(100),
    student_name VARCHAR(150),
    scan_type VARCHAR(20) NOT NULL DEFAULT 'exit',
    result VARCHAR(20) NOT NULL,
    message TEXT,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_scan_logs_request FOREIGN KEY (request_id) REFERENCES leave_requests(id) ON DELETE SET NULL,
    CONSTRAINT chk_scan_logs_result CHECK (result IN ('success', 'denied'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 16. ประวัติการนำเข้ารายชื่อนักเรียน (Student Import Audit Log)
-- ไม่มี schema.sql เดิมเลย (Supabase-only, schema drift) - reverse-engineered จาก
-- server.js การ insert (~6202-6216) และการ select (~6886-6899, order by imported_at desc limit 20)
-- ----------------------------------------------------------------------------
CREATE TABLE student_import_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id CHAR(36) NULL,
  admin_username VARCHAR(100) NOT NULL DEFAULT 'admin',
  file_name VARCHAR(255) NOT NULL DEFAULT 'Imported_File.xlsx',
  total_rows INT NOT NULL DEFAULT 0,
  success_rows INT NOT NULL DEFAULT 0,
  updated_rows INT NOT NULL DEFAULT 0,
  failed_rows INT NOT NULL DEFAULT 0,
  error_summary JSON NULL,
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_student_import_logs_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
