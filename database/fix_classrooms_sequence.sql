-- รีเซ็ตค่า Auto-Increment Sequence ของตาราง classrooms ให้ตรงกับค่า id สูงสุดปัจจุบัน
SELECT setval(pg_get_serial_sequence('classrooms', 'id'), COALESCE((SELECT MAX(id) FROM classrooms), 1));
