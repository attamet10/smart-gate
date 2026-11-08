-- ==============================================================
-- OnePass - รีเซ็ตรหัสผ่านเป็น 123456 และบังคับเปลี่ยนครั้งแรก
-- สำหรับฐานข้อมูล ongkharak_std
-- ==============================================================

USE `ongkharak_std`;

-- รีเซ็ตรหัสผ่านของผู้ใช้งานทั้งหมดเป็น 123456
-- ค่า hash: $2y$10$dTPTH9DROpMWh0l1MnAbXuLOpeNoEyQrypx2Q.atMZqCTp6fXnM9u
-- และตั้งค่า must_change_password = 1 (บังคับเปลี่ยนรหัสผ่านเมื่อเข้าใช้งานครั้งแรก)
UPDATE `users`
SET 
  `password_hash` = '$2y$10$dTPTH9DROpMWh0l1MnAbXuLOpeNoEyQrypx2Q.atMZqCTp6fXnM9u',
  `must_change_password` = 1
WHERE `role` IN ('student', 'teacher', 'deputy_director', 'director', 'admin', 'super_admin');
