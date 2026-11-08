-- ==============================================================
-- OnePass - ระบบขออนุญาตออกนอกสถานศึกษา ด้วยระบบ QR Code
-- Database Schema Extension for `ongkharak_std`
-- ==============================================================

USE `ongkharak_std`;

-- 1. ตารางคำขออนุญาตออกนอกสถานศึกษา
CREATE TABLE IF NOT EXISTS `onepass_requests` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `request_no` VARCHAR(64) NOT NULL UNIQUE COMMENT 'รหัสคำขอ เช่น OP-20261108-001',
  `student_id` INT NOT NULL COMMENT 'รหัสอ้างอิงตาราง students.id',
  `user_id` INT NOT NULL COMMENT 'รหัสอ้างอิงตาราง users.id ของนักเรียน',
  
  -- ข้อมูลการขออนุญาต
  `leave_date` DATE NOT NULL COMMENT 'วันที่ขอออก',
  `leave_time` TIME NOT NULL COMMENT 'เวลาที่ขอออก',
  `expected_return_time` TIME DEFAULT NULL COMMENT 'เวลาที่คาดว่าจะกลับเข้าสถานศึกษา',
  `is_not_returning` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = ออกแล้วไม่กลับ (กลับบ้าน), 0 = ออกชั่วคราวแล้วจะกลับเข้ามา',
  `leave_type` VARCHAR(32) NOT NULL DEFAULT 'temporary' COMMENT 'temporary หรือ for_day',
  `reason` VARCHAR(255) NOT NULL COMMENT 'เหตุผลการขออนุญาต',
  `reason_detail` TEXT DEFAULT NULL COMMENT 'รายละเอียดเพิ่มเติม',
  `attachment_url` TEXT DEFAULT NULL COMMENT 'รูปถ่ายหรือเอกสารแนบ',

  -- ผู้เกี่ยวข้องในการอนุมัติ (อ้างอิง users.id)
  `subject_teacher_id` INT NOT NULL COMMENT 'ครูรายวิชา (ในคาบที่ขอออก)',
  `advisor_teacher_id` INT NOT NULL COMMENT 'ครูที่ปรึกษา',
  `head_major_teacher_id` INT NOT NULL COMMENT 'หัวหน้าแผนกวิชา',
  `head_discipline_user_id` INT NOT NULL COMMENT 'หัวหน้างานปกครอง',
  `deputy_director_user_id` INT NOT NULL COMMENT 'รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา',

  -- สถานะการอนุมัติแต่ละระดับ
  -- 1. ครูรายวิชา
  `subject_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `subject_comment` TEXT DEFAULT NULL,
  `subject_action_at` DATETIME DEFAULT NULL,

  -- 2. ครูที่ปรึกษา
  `advisor_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `advisor_comment` TEXT DEFAULT NULL,
  `advisor_action_at` DATETIME DEFAULT NULL,

  -- 3. หัวหน้าแผนกวิชา
  `head_major_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `head_major_comment` TEXT DEFAULT NULL,
  `head_major_action_at` DATETIME DEFAULT NULL,

  -- 4. หัวหน้างานปกครอง
  `head_discipline_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `head_discipline_comment` TEXT DEFAULT NULL,
  `head_discipline_action_at` DATETIME DEFAULT NULL,

  -- 5. รองผู้อำนวยการฝ่ายกิจการนักเรียน นักศึกษา
  `deputy_director_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `deputy_director_comment` TEXT DEFAULT NULL,
  `deputy_director_action_at` DATETIME DEFAULT NULL,

  -- สถานะโดยรวมของคำขอ
  -- pending_subject -> pending_advisor -> pending_head_major -> pending_head_discipline -> pending_deputy -> approved (หรือ rejected / completed / cancelled)
  `status` ENUM(
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

  -- ข้อมูล QR Code สำหรับผ่านประตู
  `qr_token` VARCHAR(128) UNIQUE DEFAULT NULL COMMENT 'รหัส Token เฉพาะสำหรับ QR Code',
  `qr_expires_at` DATETIME DEFAULT NULL COMMENT 'เวลาหมดอายุของบัตรผ่าน',

  -- บันทึกการผ่านประตู (รปภ. / ครูเวรประตู)
  `gate_out_by` INT DEFAULT NULL COMMENT 'users.id ของผู้บันทึกเวลาออก',
  `gate_out_at` DATETIME DEFAULT NULL COMMENT 'เวลาที่ออกจากประตูสถานศึกษาจริง',
  `gate_in_by` INT DEFAULT NULL COMMENT 'users.id ของผู้บันทึกเวลากลับเข้า',
  `gate_in_at` DATETIME DEFAULT NULL COMMENT 'เวลาที่กลับเข้าสถานศึกษาจริง',

  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX `idx_student` (`student_id`),
  INDEX `idx_user` (`user_id`),
  INDEX `idx_subject_teacher` (`subject_teacher_id`),
  INDEX `idx_advisor_teacher` (`advisor_teacher_id`),
  INDEX `idx_head_major` (`head_major_teacher_id`),
  INDEX `idx_head_discipline` (`head_discipline_user_id`),
  INDEX `idx_deputy_director` (`deputy_director_user_id`),
  INDEX `idx_status` (`status`),
  INDEX `idx_qr_token` (`qr_token`),
  INDEX `idx_leave_date` (`leave_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 2. ตารางประวัติการทำงานและบันทึกการอนุมัติ (Audit Logs)
CREATE TABLE IF NOT EXISTS `onepass_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `request_id` INT NOT NULL COMMENT 'อ้างอิง onepass_requests.id',
  `user_id` INT NOT NULL COMMENT 'users.id ของผู้ดำเนินการ',
  `role_acted` VARCHAR(64) NOT NULL COMMENT 'subject_teacher, advisor, head_major, head_discipline, deputy_director, gate, student',
  `action` ENUM('created', 'approved', 'rejected', 'gate_exit', 'gate_return', 'cancelled') NOT NULL,
  `comment` TEXT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_log_req` (`request_id`),
  INDEX `idx_log_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. อัปเดตรหัสผ่านเริ่มต้น '123456' สำหรับทุก User ที่ยังไม่เคยเปลี่ยนรหัสผ่าน
-- หมายเหตุ: หากต้องการรีเซ็ตรหัสผ่านของผู้ใช้งานทั้งหมดให้เป็น 123456 และบังคับเปลี่ยนครั้งแรก สามารถรันคำสั่งด้านล่างนี้ได้
-- UPDATE `users` SET `password_hash` = '$2y$10$dTPTH9DROpMWh0l1MnAbXuLOpeNoEyQrypx2Q.atMZqCTp6fXnM9u', `must_change_password` = 1;
