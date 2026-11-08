#ifndef SECRETS_H
#define SECRETS_H

// ============================================================================
// การตั้งค่า Wi-Fi และ MQTT สำหรับ ESP32
// ไฟล์นี้ไม่ถูกเก็บขึ้น git (อยู่ใน .gitignore แล้ว) แก้ไขค่าด้านล่างให้เป็นค่าจริง
// ============================================================================

// 1. การเชื่อมต่อ Wi-Fi (ต้องเป็น Wi-Fi 2.4 GHz เท่านั้น)
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// 2. การเชื่อมต่อ HiveMQ Cloud (MQTT Broker ฟรี)
// สามารถดูค่าพวกนี้ได้จากหน้า Dashboard ของ HiveMQ Cloud
const char* MQTT_BROKER   = "your-cluster-url.s1.eu.hivemq.cloud";
const int   MQTT_PORT     = 8883; // หรือ 1883 หากไม่ใช้ SSL
const char* MQTT_USER     = "your_mqtt_username";
const char* MQTT_PASSWORD = "your_mqtt_password";

// 3. MQTT Topics ที่ใช้คุยกับระบบเว็บ
const char* TOPIC_COMMAND = "school/gate/cmd";      // รับคำสั่งจากเว็บ: {"cmd": "OPEN", "duration": 5}
const char* TOPIC_STATUS  = "school/gate/status";   // ส่งสถานะกลับไปเว็บ: {"door": "CLOSED", "status": "ONLINE"}

#endif
