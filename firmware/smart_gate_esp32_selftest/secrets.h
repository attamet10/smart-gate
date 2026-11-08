#ifndef SECRETS_H
#define SECRETS_H

// ============================================================================
// คัดลอกไฟล์นี้เป็น secrets.h แล้วแก้ไขค่าให้เป็นของจริง
// ============================================================================

// 1. WiFi (ต้องเป็น 2.4GHz เท่านั้น)
const char* WIFI_SSID     = "iPhone";
const char* WIFI_PASSWORD = "12345678kruta";

// 2. Telegram Bot
// วิธีสร้าง: คุยกับ @BotFather ใน Telegram พิมพ์ /newbot จะได้ TOKEN
// วิธีหา Chat ID: คุยกับ @userinfobot หรือ @RawDataBot แล้วส่งข้อความไปหา
const char* TELEGRAM_BOT_TOKEN = "9171059639:AAFnCl0tqD356M2UsY6Q8tVO1vvlnruy4-c";
const char* TELEGRAM_CHAT_ID   = "8527824695";

#endif
