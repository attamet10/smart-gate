-- ============================================================================
-- SMART GATE (ONE-PASS) DATABASE SCHEMA FOR SUPABASE (PostgreSQL) - V2 (5 STEPS + TIMETABLE)
-- ระบบขออนุญาตออกนอกสถานศึกษา วิทยาลัยการอาชีพองครักษ์ (รองรับสายอนุมัติ 5 ขั้นตอน & ตารางสอนอัตโนมัติ)
-- ============================================================================

-- 1. ล้างตารางเก่าหากต้องการสร้างใหม่ (เรียงตามลำดับ Foreign Key)
DROP TABLE IF EXISTS public.scan_logs CASCADE;
DROP TABLE IF EXISTS public.approval_logs CASCADE;
DROP TABLE IF EXISTS public.leave_requests CASCADE;
DROP TABLE IF EXISTS public.approval_delegations CASCADE;
DROP TABLE IF EXISTS public.timetable_overrides CASCADE;
DROP TABLE IF EXISTS public.timetables CASCADE;
DROP TABLE IF EXISTS public.semesters CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.classrooms CASCADE;
DROP TABLE IF EXISTS public.departments CASCADE;

-- 2. แผนกวิชา (Departments)
CREATE TABLE public.departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ห้องเรียน / ชั้นเรียน (Classrooms)
CREATE TABLE public.classrooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL, -- เช่น ปวช.1, ปวช.2, ปวช.3, ปวส.1, ปวส.2
    department_id INT REFERENCES public.departments(id) ON DELETE SET NULL,
    advisor_name VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ผู้ใช้งานในระบบ (Users: รองรับ 5 ขั้นตอนอนุมัติ)
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    password_hash TEXT,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN (
        'student',          -- นักเรียน/นักศึกษา
        'subject_teacher',  -- ครูรายวิชา (อนุมัติขั้นที่ 1)
        'advisor',          -- ครูที่ปรึกษา (อนุมัติขั้นที่ 2)
        'dept_head',        -- หัวหน้าแผนกวิชา (อนุมัติขั้นที่ 3)
        'discipline_head',  -- ฝ่ายปกครอง (อนุมัติขั้นที่ 4)
        'deputy_director',  -- รองผู้อำนวยการ (อนุมัติขั้นที่ 5 - ออก QR Pass)
        'kiosk',            -- คอมพิวเตอร์หน้าตู้สแกน
        'admin'             -- ผู้ดูแลระบบ
    )),
    student_code VARCHAR(50),
    department_id INT REFERENCES public.departments(id) ON DELETE SET NULL,
    classroom_id INT REFERENCES public.classrooms(id) ON DELETE SET NULL,
    advisor_name VARCHAR(150),
    college VARCHAR(150) DEFAULT 'วิทยาลัยการอาชีพองครักษ์',
    plate_no VARCHAR(100),
    phone VARCHAR(30),
    parent_phone VARCHAR(30),
    profile_photo TEXT,
    plate_photo TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. ภาคเรียน (Semesters - รองรับการเปลี่ยนตารางสอนทุกเทอมโดยข้อมูลเทอมเก่าไม่หาย)
CREATE TABLE public.semesters (
    id SERIAL PRIMARY KEY,
    term_code VARCHAR(20) UNIQUE NOT NULL, -- เช่น '1/2569', '2/2569'
    name VARCHAR(100) NOT NULL,            -- เช่น 'ภาคเรียนที่ 1 ปีการศึกษา 2569'
    start_date DATE,
    end_date DATE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. ตารางสอนหลัก (Timetables)
CREATE TABLE public.timetables (
    id BIGSERIAL PRIMARY KEY,
    semester_code VARCHAR(20) NOT NULL DEFAULT '1/2569',
    department_name VARCHAR(100) NOT NULL, -- เช่น 'แผนกวิชาช่างยนต์'
    classroom VARCHAR(50) NOT NULL,        -- เช่น 'ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2'
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- 1=จันทร์ ... 5=ศุกร์, 6=เสาร์, 7=อาทิตย์
    start_time TIME NOT NULL,              -- เช่น '08:00'
    end_time TIME NOT NULL,                -- เช่น '10:00'
    subject_code VARCHAR(50),              -- เช่น '20101-2001'
    subject_name VARCHAR(150) NOT NULL,    -- เช่น 'งานเครื่องยนต์เบื้องต้น'
    teacher_username VARCHAR(50),          -- username ครูผู้สอน
    teacher_name VARCHAR(150),             -- ชื่อ-สกุล ครูผู้สอน
    period_type VARCHAR(30) NOT NULL DEFAULT 'study' CHECK (period_type IN (
        'study',     -- คาบเรียนปกติ (ต้องผ่านครูรายวิชาอนุมัติ)
        'break',     -- พักกลางวัน (ข้ามขั้นครูรายวิชาอัตโนมัติ)
        'activity',  -- คาบกิจกรรม (ข้ามขั้นครูรายวิชาอัตโนมัติ)
        'free'       -- คาบว่าง (ข้ามขั้นครูรายวิชาอัตโนมัติ)
    )),
    room_no VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. ตารางสอนแทน / งดสอนรายวัน (Daily Timetable Overrides - ไม่กระทบตารางหลัก)
CREATE TABLE public.timetable_overrides (
    id BIGSERIAL PRIMARY KEY,
    timetable_id BIGINT REFERENCES public.timetables(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,           -- วันที่สอนแทนหรืองดสอน
    override_type VARCHAR(30) NOT NULL CHECK (override_type IN (
        'substitute', -- สอนแทน (ส่งให้ครูสอนแทนอนุมัติขั้นที่ 1)
        'cancelled'   -- งดสอนรายวัน (ถือเป็นคาบว่าง ข้ามขั้นที่ 1 อัตโนมัติ)
    )),
    substitute_teacher_username VARCHAR(50),
    substitute_teacher_name VARCHAR(150),
    reason TEXT,
    created_by VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ตารางการมอบหมายผู้อนุมัติแทนเมื่อครูไม่อยู่ (Approval Delegations)
CREATE TABLE public.approval_delegations (
    id BIGSERIAL PRIMARY KEY,
    owner_username VARCHAR(50) NOT NULL,       -- ครูเจ้าของสิทธิ์ที่ไม่อยู่
    owner_name VARCHAR(150),
    owner_role VARCHAR(30) NOT NULL,
    delegate_username VARCHAR(50) NOT NULL,    -- ผู้รับมอบหมายให้อนุมัติแทน
    delegate_name VARCHAR(150),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. คำขออนุญาตออกนอกสถานศึกษา (Leave Requests - รองรับทั้ง 3 ขั้นเดิม และ 5 ขั้นใหม่)
CREATE TABLE public.leave_requests (
    id BIGSERIAL PRIMARY KEY,
    request_no VARCHAR(50) UNIQUE NOT NULL,
    student_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
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
    -- (pending_subject, pending_advisor, pending_dept_head, pending_discipline, pending_deputy, approved, rejected, exited, returned, expired)
    status VARCHAR(30) NOT NULL DEFAULT 'pending_subject',
    current_step INT NOT NULL DEFAULT 1,      -- 1=ครูรายวิชา, 2=ครูที่ปรึกษา, 3=หน.แผนก, 4=ปกครอง, 5=รองผอ., 6=อนุมัติครบ
    total_steps INT NOT NULL DEFAULT 5,       -- 5 สำหรับระบบใหม่, 3 สำหรับคำร้องเก่าที่ค้างอยู่
    step_entered_at TIMESTAMPTZ DEFAULT NOW(),-- เวลาที่เข้าสู่ขั้นตอนปัจจุบัน (ใช้นับเวลารอและแจ้งเตือนซ้ำ)

    -- ข้อมูล Snapshot ครูรายวิชาและตารางสอน ณ ตอนยื่นคำร้อง (ไม่เปลี่ยนตามตารางภายหลัง)
    subject_teacher_username VARCHAR(50),
    subject_teacher_name VARCHAR(150),
    subject_name VARCHAR(150),
    subject_code VARCHAR(50),
    period_type VARCHAR(30) DEFAULT 'study',  -- study, break, activity, free, manual, no_timetable
    step1_skipped BOOLEAN DEFAULT FALSE,      -- true เมื่อไม่มีคาบเรียนและข้ามขั้นที่ 1 อัตโนมัติ
    step1_skip_reason TEXT,                   -- เช่น 'ไม่มีคาบเรียน (พักกลางวัน)'
    manual_teacher_selected BOOLEAN DEFAULT FALSE, -- true เมื่อไม่พบตารางสอนและนักเรียนเลือกครูเอง
    advisor_flag_verify BOOLEAN DEFAULT FALSE,-- ธงแจ้งเตือนให้ครูที่ปรึกษาตรวจสอบกรณีเลือกครูเอง
    notified_teachers JSONB DEFAULT '[]'::jsonb,   -- รายชื่อครูคาบอื่นๆ ที่ได้รับแจ้งทราบกรณีลาคร่อมหลายคาบ

    -- ข้อมูลการข้ามขั้นฉุกเฉิน (Emergency Override โดยฝ่ายปกครอง/รองผอ.)
    is_emergency_override BOOLEAN DEFAULT FALSE,
    emergency_override_by VARCHAR(150),
    emergency_override_role VARCHAR(30),
    emergency_override_reason TEXT,

    -- ข้อมูล QR Code และความปลอดภัย
    qr_token VARCHAR(100) UNIQUE,
    qr_generated_at TIMESTAMPTZ,
    is_qr_used BOOLEAN NOT NULL DEFAULT FALSE,
    qr_used_at TIMESTAMPTZ,

    is_waived BOOLEAN DEFAULT FALSE,
    waiver_note TEXT,
    rejection_reason TEXT,
    rejected_by_step INT,
    rejected_by_name VARCHAR(150),
    rejected_by_role VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. ประวัติการลงนามอนุมัติทุกขั้นย้อนหลัง (Approval Logs)
CREATE TABLE public.approval_logs (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT NOT NULL REFERENCES public.leave_requests(id) ON DELETE CASCADE,
    step INT NOT NULL,                        -- 1 ถึง 5
    step_name VARCHAR(100),                   -- เช่น 'ครูรายวิชา', 'ครูที่ปรึกษา', 'หัวหน้าแผนกวิชา', 'ฝ่ายปกครอง', 'รองผู้อำนวยการ'
    approver_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approver_username VARCHAR(50),
    approver_name VARCHAR(150),
    approver_role VARCHAR(30),
    intended_approver_name VARCHAR(150),      -- ชื่อครูตัวจริง (กรณีอนุมัติแทน)
    is_delegated BOOLEAN DEFAULT FALSE,       -- true เมื่อเป็นการอนุมัติแทน
    delegate_reason TEXT,                     -- เหตุผลที่อนุมัติแทน
    is_emergency_override BOOLEAN DEFAULT FALSE, -- true เมื่อเป็นการข้ามขั้นฉุกเฉิน
    action VARCHAR(30) NOT NULL CHECK (action IN (
        'approved',           -- อนุมัติปกติ
        'rejected',           -- ปฏิเสธคำร้อง
        'skipped_no_class',   -- ข้ามอัตโนมัติ (ไม่มีคาบเรียน/คาบว่าง/พักเที่ยง/กิจกรรม)
        'delegated_approve',  -- อนุมัติแทนครูที่ไม่อยู่
        'emergency_override'  -- ข้ามขั้นกรณีฉุกเฉินโดยฝ่ายปกครอง/รองผอ.
    )),
    note TEXT,
    action_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. ประวัติการสแกนผ่านประตูที่หน้าตู้ (Scan Logs)
CREATE TABLE public.scan_logs (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT REFERENCES public.leave_requests(id) ON DELETE SET NULL,
    qr_token VARCHAR(100),
    student_name VARCHAR(150),
    scan_type VARCHAR(20) NOT NULL DEFAULT 'exit',
    result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'denied')),
    message TEXT,
    scanned_at TIMESTAMPTZ DEFAULT NOW()
);
