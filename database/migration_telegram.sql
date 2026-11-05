-- ============================================================================
-- OnePass IoT Smart Gate: Telegram Bot Integration & Notification Migration
-- ============================================================================

-- 1. เพิ่มคอลัมน์ในตาราง users สำหรับจัดเก็บ Chat ID, Username, วันที่เชื่อมต่อ และการตั้งค่าเปิด-ปิดแจ้งเตือน
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE,
ADD COLUMN IF NOT EXISTS telegram_username TEXT,
ADD COLUMN IF NOT EXISTS telegram_connected_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS telegram_notify_settings JSONB DEFAULT '{
  "pending_approval": true,
  "request_result": true,
  "qr_ready": true,
  "parent_scan": true,
  "gate_alert": true
}'::jsonb;

-- ดัชนีช่วยค้นหาผู้ใช้ด้วย chat_id เวลาผู้ใช้ทักบอทมา
CREATE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id);

-- 2. สร้างตาราง telegram_link_tokens สำหรับเก็บ Token ลิงก์ชั่วคราว
-- รหัสสุ่มเดาไม่ได้ ใช้ได้ครั้งเดียว และหมดอายุใน 10 นาที
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(64) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_tokens_lookup ON telegram_link_tokens(token, used, expires_at);

-- 3. ตาราง telegram_logs สำหรับบันทึกประวัติการส่งแจ้งเตือน, ตรวจจับการบล็อกบอท และ Retry
CREATE TABLE IF NOT EXISTS telegram_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  chat_id BIGINT,
  notify_type VARCHAR(50),
  message_preview TEXT,
  status VARCHAR(20) DEFAULT 'success', -- 'success', 'failed', 'blocked'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_logs_user_id ON telegram_logs(user_id);
