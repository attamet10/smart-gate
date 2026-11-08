#ifndef SECRETS_H
#define SECRETS_H

// ============================================================================
// คัดลอกไฟล์นี้เป็น secrets.h แล้วแก้ไขค่าให้เป็นของจริง
// ============================================================================

// 1. WiFi (ต้องเป็น 2.4GHz เท่านั้น)
const char* WIFI_SSID     = "Neo3";
const char* WIFI_PASSWORD = "12345678";

// 2. Telegram Bot
// วิธีสร้าง: คุยกับ @BotFather ใน Telegram พิมพ์ /newbot จะได้ TOKEN
// วิธีหา Chat ID: คุยกับ @userinfobot หรือ @RawDataBot แล้วส่งข้อความไปหา
const char* TELEGRAM_BOT_TOKEN = "9171059639:AAFnCl0tqD356M2UsY6Q8tVO1vvlnruy4-c";
const char* TELEGRAM_CHAT_ID   = "8527824695";

// 3. Server Configuration (ตั้งค่าเซิร์ฟเวอร์ OnePass)
// สำหรับเชื่อมต่อกับเซิร์ฟเวอร์หลัก:
#define SERVER_HOST "onepass.ongkharak.ac.th"
#define SERVER_PORT 443
// สำหรับทดสอบในวง WiFi เดียวกับคอมพิวเตอร์ (Local Node.js):
// #define SERVER_HOST "192.168.1.100" // แก้เป็น IP เครื่องคอมฯ
// #define SERVER_PORT 3000

#endif
