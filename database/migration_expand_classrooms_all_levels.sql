-- ==============================================================================
-- ONEPASS MIGRATION: ขยายห้องเรียนให้ครบทุกแผนก (5 แผนก) และครบทุกระดับชั้น (25 ห้อง)
-- วันที่: 2026-11-04
-- แก้ไข: เพิ่มการ Sync ลำดับ Sequence (Auto-Increment) ก่อน เพื่อแก้ปัญหา Key (id)=(1) already exists
-- ==============================================================================

-- 0. รีเซ็ตลำดับ Auto-Increment Sequence ของตาราง classrooms ให้ตรงกับ id สูงสุดเดิม
SELECT setval(pg_get_serial_sequence('classrooms', 'id'), COALESCE((SELECT MAX(id) FROM classrooms), 1));

-- 1. แผนกวิชาช่างยนต์ (Department ID: 1)
INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.1/1 (ช่างยนต์)', 1, 'อ.สมคิด ช่างยนต์'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.1/1 (ช่างยนต์)' AND department_id = 1);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.2/1 (ช่างยนต์)', 1, 'อ.วิชัย ช่างยนต์'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.2/1 (ช่างยนต์)' AND department_id = 1);

-- ปวช.3/1 (ช่างยนต์) มีอยู่แล้ว (ID: 1, อ.อนุสรณ์ ช่างยนต์)

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.1/1 (ช่างยนต์)', 1, 'อ.ประเสริฐ ยานยนต์'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.1/1 (ช่างยนต์)' AND department_id = 1);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.2/1 (ช่างยนต์)', 1, 'อ.ชาญชัย เทคนิคยานยนต์'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.2/1 (ช่างยนต์)' AND department_id = 1);


-- 2. แผนกวิชาช่างไฟฟ้ากำลัง (Department ID: 2)
INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.1/1 (ช่างไฟฟ้ากำลัง)', 2, 'อ.สุรศักดิ์ ไฟฟ้า'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.1/1 (ช่างไฟฟ้ากำลัง)' AND department_id = 2);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.2/1 (ช่างไฟฟ้ากำลัง)', 2, 'อ.ธีรเดช ไฟฟ้า'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.2/1 (ช่างไฟฟ้ากำลัง)' AND department_id = 2);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.3/1 (ช่างไฟฟ้ากำลัง)', 2, 'อ.มนตรี ไฟฟ้า'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.3/1 (ช่างไฟฟ้ากำลัง)' AND department_id = 2);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.1/1 (ช่างไฟฟ้ากำลัง)', 2, 'อ.วรวิทย์ พลังงานไฟฟ้า'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.1/1 (ช่างไฟฟ้ากำลัง)' AND department_id = 2);

-- ปวส.2/1 (ช่างไฟฟ้ากำลัง) มีอยู่แล้ว (ID: 2, อ.กิตติศักดิ์ ไฟฟ้า)


-- 3. แผนกวิชาการบัญชี (Department ID: 3)
INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.1/1 (การบัญชี)', 3, 'อ.ศิริพร บัญชี'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.1/1 (การบัญชี)' AND department_id = 3);

-- ปวช.2/1 (การบัญชี) มีอยู่แล้ว (ID: 3, อ.พิมพา บัญชี)

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.3/1 (การบัญชี)', 3, 'อ.กรรณิการ์ บัญชี'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.3/1 (การบัญชี)' AND department_id = 3);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.1/1 (การบัญชี)', 3, 'อ.วรรณา การเงินและการบัญชี'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.1/1 (การบัญชี)' AND department_id = 3);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.2/1 (การบัญชี)', 3, 'อ.อรทัย สอบบัญชี'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.2/1 (การบัญชี)' AND department_id = 3);


-- 4. แผนกวิชาเทคโนโลยีธุรกิจดิจิทัล (Department ID: 4)
INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.1/1 (เทคโนโลยีธุรกิจดิจิทัล)', 4, 'อ.ปรเมษฐ์ ดิจิทัล'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.1/1 (เทคโนโลยีธุรกิจดิจิทัล)' AND department_id = 4);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.2/1 (เทคโนโลยีธุรกิจดิจิทัล)', 4, 'อ.ชลธิชา สารสนเทศ'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.2/1 (เทคโนโลยีธุรกิจดิจิทัล)' AND department_id = 4);

-- ปวช.3/1 (เทคโนโลยีธุรกิจดิจิทัล) มีอยู่แล้ว (ID: 4, อ.ธนากร ดิจิทัล)

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.1/1 (เทคโนโลยีธุรกิจดิจิทัล)', 4, 'อ.อัครพล พัฒนาซอฟต์แวร์'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.1/1 (เทคโนโลยีธุรกิจดิจิทัล)' AND department_id = 4);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.2/1 (เทคโนโลยีธุรกิจดิจิทัล)', 4, 'อ.ภัทรดนัย นวัตกรรมดิจิทัล'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.2/1 (เทคโนโลยีธุรกิจดิจิทัล)' AND department_id = 4);


-- 5. แผนกวิชาการจัดการสำนักงาน (Department ID: 5)
INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.1/1 (การจัดการสำนักงาน)', 5, 'อ.รุ่งทิพย์ สำนักงาน'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.1/1 (การจัดการสำนักงาน)' AND department_id = 5);

-- ปวช.2/1 (การจัดการสำนักงาน) มีอยู่แล้ว (ID: 5, อ.นภาวรรณ สำนักงาน)

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวช.3/1 (การจัดการสำนักงาน)', 5, 'อ.จุฑารัตน์ ธุรการ'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวช.3/1 (การจัดการสำนักงาน)' AND department_id = 5);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.1/1 (การจัดการสำนักงาน)', 5, 'อ.ทิพวรรณ บริหารงานทั่วไป'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.1/1 (การจัดการสำนักงาน)' AND department_id = 5);

INSERT INTO classrooms (name, department_id, advisor_name)
SELECT 'ปวส.2/1 (การจัดการสำนักงาน)', 5, 'อ.เบญจมาศ องค์กร'
WHERE NOT EXISTS (SELECT 1 FROM classrooms WHERE name = 'ปวส.2/1 (การจัดการสำนักงาน)' AND department_id = 5);


-- ตรวจสอบผลลัพธ์ห้องเรียนทั้งหมด 25 ห้อง
SELECT c.id, c.name AS classroom_name, d.name AS department_name, c.advisor_name
FROM classrooms c
JOIN departments d ON c.department_id = d.id
ORDER BY c.department_id, c.name;
