-- ============================================================================
-- SQL MIGRATION SCRIPT FOR SUPABASE (OnePass V2: 5-Step Approval & Timetable)
-- อัปเกรดฐานข้อมูลเดิมเป็นระบบอนุมัติ 5 ขั้นตอน และระบบตารางสอนอัตโนมัติ (ไม่กระทบคำร้องเก่า 3 ขั้น)
-- ============================================================================

-- 1. ขยายสิทธิ์ Role ในตาราง public.users ให้รองรับ 'subject_teacher' และ 'deputy_director'
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN (
    'student',
    'subject_teacher',
    'advisor',
    'dept_head',
    'discipline_head',
    'deputy_director',
    'kiosk',
    'admin'
));

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS student_code VARCHAR(50),
ADD COLUMN IF NOT EXISTS college VARCHAR(150) DEFAULT 'วิทยาลัยการอาชีพองครักษ์',
ADD COLUMN IF NOT EXISTS advisor_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS profile_photo TEXT,
ADD COLUMN IF NOT EXISTS plate_photo TEXT,
ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- 2. สร้างตารางภาคเรียน (Semesters)
CREATE TABLE IF NOT EXISTS public.semesters (
    id SERIAL PRIMARY KEY,
    term_code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    start_date DATE,
    end_date DATE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. สร้างตารางสอนหลัก (Timetables)
CREATE TABLE IF NOT EXISTS public.timetables (
    id BIGSERIAL PRIMARY KEY,
    semester_code VARCHAR(20) NOT NULL DEFAULT '1/2569',
    department_name VARCHAR(100) NOT NULL,
    classroom VARCHAR(50) NOT NULL,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    subject_code VARCHAR(50),
    subject_name VARCHAR(150) NOT NULL,
    teacher_username VARCHAR(50),
    teacher_name VARCHAR(150),
    period_type VARCHAR(30) NOT NULL DEFAULT 'study' CHECK (period_type IN ('study', 'break', 'activity', 'free')),
    room_no VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. สร้างตารางสอนแทน / งดสอนรายวัน (Daily Timetable Overrides)
CREATE TABLE IF NOT EXISTS public.timetable_overrides (
    id BIGSERIAL PRIMARY KEY,
    timetable_id BIGINT REFERENCES public.timetables(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    override_type VARCHAR(30) NOT NULL CHECK (override_type IN ('substitute', 'cancelled')),
    substitute_teacher_username VARCHAR(50),
    substitute_teacher_name VARCHAR(150),
    reason TEXT,
    created_by VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. สร้างตารางการมอบหมายผู้อนุมัติแทน (Approval Delegations)
CREATE TABLE IF NOT EXISTS public.approval_delegations (
    id BIGSERIAL PRIMARY KEY,
    owner_username VARCHAR(50) NOT NULL,
    owner_name VARCHAR(150),
    owner_role VARCHAR(30) NOT NULL,
    delegate_username VARCHAR(50) NOT NULL,
    delegate_name VARCHAR(150),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. เพิ่มคอลัมน์ระบบอนุมัติ 5 ขั้นตอน และ Snapshot ตารางสอน ในตาราง public.leave_requests
-- คำร้องเก่าที่ค้างอยู่ในระบบให้มีค่าเริ่มต้น total_steps = 3 เพื่อไม่ให้เสียหาย
ALTER TABLE public.leave_requests 
ADD COLUMN IF NOT EXISTS student_code VARCHAR(50),
ADD COLUMN IF NOT EXISTS destination VARCHAR(255),
ADD COLUMN IF NOT EXISTS no_return BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS travel_mode VARCHAR(30) DEFAULT 'own',
ADD COLUMN IF NOT EXISTS pickup_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS pickup_plate VARCHAR(100),
ADD COLUMN IF NOT EXISTS plate_photo TEXT,
ADD COLUMN IF NOT EXISTS evidence_photo TEXT,
ADD COLUMN IF NOT EXISTS parent_phone VARCHAR(30),
ADD COLUMN IF NOT EXISTS actual_return_time VARCHAR(30),
ADD COLUMN IF NOT EXISTS total_steps INT DEFAULT 3,
ADD COLUMN IF NOT EXISTS step_entered_at TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS subject_teacher_username VARCHAR(50),
ADD COLUMN IF NOT EXISTS subject_teacher_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS subject_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS subject_code VARCHAR(50),
ADD COLUMN IF NOT EXISTS period_type VARCHAR(30) DEFAULT 'study',
ADD COLUMN IF NOT EXISTS step1_skipped BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS step1_skip_reason TEXT,
ADD COLUMN IF NOT EXISTS manual_teacher_selected BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS advisor_flag_verify BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS notified_teachers JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS is_emergency_override BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS emergency_override_by VARCHAR(150),
ADD COLUMN IF NOT EXISTS emergency_override_role VARCHAR(30),
ADD COLUMN IF NOT EXISTS emergency_override_reason TEXT,
ADD COLUMN IF NOT EXISTS is_waived BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS waiver_note TEXT,
ADD COLUMN IF NOT EXISTS rejected_by_step INT,
ADD COLUMN IF NOT EXISTS rejected_by_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS rejected_by_role VARCHAR(50);

-- ตั้งค่าคำร้องใหม่ที่จะสร้างต่อไปให้มีค่าเริ่มต้น total_steps = 5
ALTER TABLE public.leave_requests ALTER COLUMN total_steps SET DEFAULT 5;

-- 7. ขยายตารางประวัติการอนุมัติ (public.approval_logs) ให้รองรับการข้ามคาบว่าง อนุมัติแทน และข้ามขั้นฉุกเฉิน
ALTER TABLE public.approval_logs DROP CONSTRAINT IF EXISTS approval_logs_action_check;
ALTER TABLE public.approval_logs ADD CONSTRAINT approval_logs_action_check CHECK (action IN (
    'approved',
    'rejected',
    'skipped_no_class',
    'delegated_approve',
    'emergency_override'
));

ALTER TABLE public.approval_logs
ADD COLUMN IF NOT EXISTS step_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS approver_username VARCHAR(50),
ADD COLUMN IF NOT EXISTS approver_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS approver_role VARCHAR(30),
ADD COLUMN IF NOT EXISTS intended_approver_name VARCHAR(150),
ADD COLUMN IF NOT EXISTS is_delegated BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS delegate_reason TEXT,
ADD COLUMN IF NOT EXISTS is_emergency_override BOOLEAN DEFAULT FALSE;
