-- ============================================================================
-- OnePass IoT Smart Gate: Student Single-Identifier Login & Device Binding
-- ============================================================================

-- 1. เพิ่มฟิลด์ข้อมูลการผูกอุปกรณ์ และสถานะ Onboarding ในตาราง users
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS student_prefix VARCHAR(20),                -- คำนำหน้า (นาย/นางสาว)
ADD COLUMN IF NOT EXISTS first_name TEXT,                           -- ชื่อจริง
ADD COLUMN IF NOT EXISTS last_name TEXT,                            -- นามสกุล
ADD COLUMN IF NOT EXISTS curriculum_level VARCHAR(10),              -- ระดับชั้น (ปวช. / ปวส.)
ADD COLUMN IF NOT EXISTS class_year SMALLINT,                       -- ชั้นปี (1, 2, 3)
ADD COLUMN IF NOT EXISTS room_number VARCHAR(10),                   -- ห้อง (1, 2, ...)
ADD COLUMN IF NOT EXISTS advisor_username TEXT,                     -- Username ครูที่ปรึกษา
ADD COLUMN IF NOT EXISTS advisor_name TEXT,                         -- ชื่อ-สกุล ครูที่ปรึกษา
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE,-- เข้าครั้งแรกกรอกข้อมูลเสริมแล้วหรือยัง
ADD COLUMN IF NOT EXISTS bound_device_id TEXT,                      -- รหัสอุปกรณ์ที่ผูกไว้ (Device Fingerprint)
ADD COLUMN IF NOT EXISTS bound_device_name TEXT,                    -- ชื่อเครื่อง/เบราว์เซอร์
ADD COLUMN IF NOT EXISTS bound_device_at TIMESTAMPTZ,               -- วันเวลาที่ผูกเครื่องสำเร็จ
ADD COLUMN IF NOT EXISTS pending_device_id TEXT,                    -- อุปกรณ์ใหม่ที่กำลังรออนุมัติ
ADD COLUMN IF NOT EXISTS pending_device_name TEXT,
ADD COLUMN IF NOT EXISTS pending_device_otp VARCHAR(6),             -- OTP 6 หลักสำหรับยืนยันผ่าน Telegram
ADD COLUMN IF NOT EXISTS pending_device_otp_expires TIMESTAMPTZ,    -- เวลาหมดอายุของ OTP (5 นาที)
ADD COLUMN IF NOT EXISTS vehicle_plate TEXT,                        -- ทะเบียนรถ
ADD COLUMN IF NOT EXISTS vehicle_photo TEXT,                        -- รูปรถ
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);                  -- เบอร์โทรศัพท์

-- 2. สร้างตารางคำขออนุมัติเครื่องใหม่ (Device Approval Requests)
CREATE TABLE IF NOT EXISTS device_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_code VARCHAR(50) NOT NULL,
  student_name TEXT NOT NULL,
  department_name TEXT,
  advisor_username TEXT,
  device_id TEXT NOT NULL,
  device_name TEXT,
  ip_address TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_approvals_lookup 
ON device_approval_requests(advisor_username, status, created_at);

-- 3. ตารางบันทึกประวัติการเข้าสู่ระบบ (Login Audit Logs)
CREATE TABLE IF NOT EXISTS login_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  identifier TEXT NOT NULL,             -- รหัสนักศึกษา หรือ username ที่ใช้ล็อกอิน
  role VARCHAR(30) NOT NULL,            -- student, teacher, admin, etc.
  ip_address TEXT,
  device_id TEXT,
  device_info TEXT,
  status VARCHAR(30) NOT NULL,          -- 'success', 'new_device_pending', 'blocked_rate_limit', 'failed_not_found', 'failed_password'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_logs_security 
ON login_logs(identifier, ip_address, created_at);
