#ifndef SECRETS_H
#define SECRETS_H

// ============================================================================
// คัดลอกไฟล์นี้เป็น secrets.h แล้วแก้ไขค่าให้เป็นของจริง
// ============================================================================

// 1. WiFi (ต้องเป็น 2.4GHz เท่านั้น)
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// 2. Telegram Bot
// วิธีสร้าง: คุยกับ @BotFather ใน Telegram พิมพ์ /newbot จะได้ TOKEN
// วิธีหา Chat ID: คุยกับ @userinfobot หรือ @RawDataBot แล้วส่งข้อความไปหา
const char* TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN";
const char* TELEGRAM_CHAT_ID   = "YOUR_CHAT_ID";

// 3. Server Configuration (ตั้งค่าเซิร์ฟเวอร์ OnePass)
#define SERVER_HOST "onepass.ongkharak.ac.th"
#define SERVER_PORT 443
// #define SERVER_HOST "192.168.1.100"
// #define SERVER_PORT 3000

#endif
