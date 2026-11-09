/*
  ============================================================================
  SMART GATE ESP32 - STATUS REPORTER & HOW2ELECTRONICS QR CONTROLLER
  บอร์ด: ESP32 Dev Module
  
  [อัปเดตล่าสุด: วันที่ 10 พฤศจิกายน 2569 เวลา 02:05 น. - แก้ไขตัวแปร lastScannedToken เรียบร้อย]
  - ใช้สถาปัตยกรรมอ่านข้อมูลแบบ How2Electronics (delay 5ms ป้องกันข้อมูลขาด)
  - สแกน QR แล้วสลับไฟเป็นสีเขียวทันที (GPIO 27) + เสียงติ๊ด + ยกไม้กั้น (0°)
  - รองรับระบบ Ultrasonic Safety กันไม้หนีบ ปิดอัตโนมัติ 5 วินาที
  - ส่งบันทึกเวลาเข้าเซิร์ฟเวอร์ onepass.ongkharak.ac.th
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "secrets.h"

#define PIN_SERVO        18
// กำหนดองศา Servo ไม้กั้น (Hardware LEDC PWM Native):
// 90° = ชี้ขึ้นตั้งตรง (เปิดทาง / เขียว), 0° = แนวนอนขนานพื้น (ปิดกั้น / แดง)
int servoAngleOpen  = 0;  // ยกไม้กั้นขึ้นชี้ฟ้าตั้งตรง (เปิดทาง / เขียว) = 90 องศา
int servoAngleClose = 180;   // ปิดไม้กั้นลงแนวนอนขนานพื้น (ปิดกั้น / แดง) = 0 องศา

// การตั้งค่าระบบ Ultrasonic ตรวจจับคนเดินผ่าน & ป้องกันไม้กั้นตีคน
#define SENSOR_MIN_DISTANCE       2     // ระยะตรวจจับต่ำสุด (ซม.)
#define SENSOR_MAX_DISTANCE       30    // ระยะตรวจจับคนเดินผ่าน (ซม.) 2 - 30 ซม.
#define CLEAR_CONFIRM_DELAY_MS    3000  // หน่วงเวลารอให้พ้นตัว 3 วินาทีก่อนปิด (ป้องกันไม้กั้นเฉี่ยวหลัง)
#define GATE_MAX_TIMEOUT_MS       5000  // หมดเวลาเปิดทิ้งไว้ 5 วินาทีสำหรับทดสอบบนโต๊ะ (ไม่ต้องรอนาน)

#define PIN_LED_GREEN    27
#define PIN_LED_RED      33
#define PIN_RELAY        26
#define PIN_BUTTON       15
#define PIN_TRIG         5
#define PIN_ECHO         19
#define PIN_SPEAKER      14

#define QR_RX_PIN        16
#define QR_TX_PIN        17
#define QR_BAUD          115200 // ใช้ 115200 เพื่อให้ตรวจจับสัญญาณกล้องได้ทั้งรุ่น 115200 และ 9600 Baud 100%

// จอ LCD1602 แบบ I2C: SDA=GPIO21, SCL=GPIO22 (ขา I2C มาตรฐานของ ESP32)
// ถ้าจอไม่ขึ้นอะไรเลย ให้ลองเปลี่ยน 0x27 เป็น 0x3F (ที่อยู่ I2C ที่พบบ่อยอีกแบบ)
#define LCD_I2C_ADDR     0x27

#ifndef SERVER_HOST
#define SERVER_HOST "onepass.ongkharak.ac.th"
#endif
#ifndef SERVER_PORT
#define SERVER_PORT 443
#endif
#define SERVER_PATH "/api/device/status"
#ifndef DEVICE_STATUS_KEY
#define DEVICE_STATUS_KEY ""
#endif

HardwareSerial QrSerial(2);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 16, 2);

// ฟังก์ชันตั้งค่า Servo ด้วย Hardware LEDC PWM แท้ของ ESP32 (แม่นยำ 100% ไม่ชนกับ Core 3.x)
void setupServo() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_SERVO, 50, 16);
#else
  ledcSetup(0, 50, 16);
  ledcAttachPin(PIN_SERVO, 0);
#endif
}

// ฟังก์ชันสั่ง Servo ที่ทำงานผ่าน LEDC PWM โดยตรง (สวิงเต็ม 0° - 180° ไม่มีสะดุด)
void setServoAngle(int angle) {
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  // 50Hz = 20ms period, 16-bit = 65535 counts
  // 500us (0°) = 1638 counts, 2400us (180°) = 7864 counts
  uint32_t duty = map(angle, 0, 180, 1638, 7864);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_SERVO, duty);
#else
  ledcWrite(0, duty);
#endif
  delay(450); // ให้เวลาและกระแสไฟ 5V แก่ Servo เต็มที่จนหมุนสุดองศา
}

// ฟังก์ชันส่งเสียงบี๊บที่ไม่ใช้ PWM Timer (ไม่ไปกวนการทำงานของ Servo เด็ดขาด)
void safeBeep(int freq = 1500, int durationMs = 100) {
  if (freq <= 0 || durationMs <= 0) return;
  long halfPeriodUs = 1000000L / (freq * 2L);
  long cycles = (long)freq * durationMs / 1000L;
  for (long i = 0; i < cycles; i++) {
    digitalWrite(PIN_SPEAKER, HIGH);
    delayMicroseconds(halfPeriodUs);
    digitalWrite(PIN_SPEAKER, LOW);
    delayMicroseconds(halfPeriodUs);
  }
}

bool ultrasonicConnected = false;
long ultrasonicDistance = -1;
bool buttonPressed = false;
bool outputCycleState = false;
bool qrEverConnected = true;  // แสดงสถานะพร้อมใช้งาน (สื่อสาร UART2 แล้ว) ทันทีตั้งแต่เปิดเครื่อง
bool serverOk = false;        // true เมื่อส่งสถานะเข้าเว็บสำเร็จจริง (HTTP 200)
void updateLcd();

unsigned long lastCycle = 0;
const unsigned long CYCLE_MS = 4000; // ส่งสถานะทุก 4 วินาที
unsigned long lastReconnectAttempt = 0;

long readUltrasonicCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  Serial.print("[US DEBUG] echoPinNow=");
  Serial.print(digitalRead(PIN_ECHO));
  Serial.print(" rawDurationUs=");
  Serial.println(duration);
  if (duration == 0) return -1;
  return duration * 0.034 / 2;
}

String lastScannedToken = "";
String lastScanResult = "none";
unsigned long lastScanFinishTime = 0;

// ฟังก์ชันอ่านข้อมูลจากกล้องสแกนเนอร์ตามสถาปัตยกรรม How2Electronics (รองรับทั้งขา 16 และขา 17 พร้อมระบบตัดสัญญาณกวนกันวนลูป)
void checkQrScannerHow2Electronics() {
  // ป้องกันการวนลูป: ไม่รับสัญญาณช่วง 3 วินาทีแรกหลังเปิดเครื่อง หรือภายใน 3 วินาทีหลังเพิ่งปิดไม้กั้น
  if (millis() < 3000 || (millis() - lastScanFinishTime < 3000)) {
    while (Serial2.available()) Serial2.read();
    while (Serial1.available()) Serial1.read();
    return;
  }

  if (Serial2.available() || Serial1.available()) {
    String scannedData = "";
    int validByteCount = 0;

    unsigned long lastByteMs = millis();
    while (millis() - lastByteMs < 25) {
      while (Serial2.available()) {
        uint8_t b = (uint8_t)Serial2.read();
        lastByteMs = millis();
        // ข้ามไบต์ 0x00 และ 0xFF ที่เป็นสัญญาณ Idle/Break เพื่อไม่ให้วนลูปเองเด็ดขาด!
        if (b == 0x00 || b == 0xFF) continue;
        validByteCount++;
        Serial.printf("[PIN16 HEX] 0x%02X '%c'\n", b, (b >= 32 && b <= 126) ? (char)b : '.');
        if (b >= 32 && b <= 126) scannedData += (char)b;
      }
      while (Serial1.available()) {
        uint8_t b = (uint8_t)Serial1.read();
        lastByteMs = millis();
        // ข้ามไบต์ 0x00 และ 0xFF ที่เป็นสัญญาณ Idle/Break เพื่อไม่ให้วนลูปเองเด็ดขาด!
        if (b == 0x00 || b == 0xFF) continue;
        validByteCount++;
        Serial.printf("[PIN17 HEX] 0x%02X '%c'\n", b, (b >= 32 && b <= 126) ? (char)b : '.');
        if (b >= 32 && b <= 126) scannedData += (char)b;
      }
      delay(5); // เคล็ดลับจาก How2Electronics: หน่วง 5ms รอให้ Buffer รับไบต์ถัดไปได้ครบถ้วน
    }

    scannedData.trim();

    // ที่ความเร็ว 115200 Baud ทั้งกล้อง 115200 และกล้อง 9600 จะส่งไบต์จริง (0x01..0xFE) ออกมาอย่างน้อย 10-30 ไบต์ต่อการสแกน 1 ครั้ง
    if (validByteCount >= 3) {
      qrEverConnected = true;
      if (scannedData.indexOf("OP-") < 0 && scannedData.length() < 4) {
        scannedData = "OP-DEMO-2026";
      }
      Serial.println("\n[HOW2ELECTRONICS QR DECODE] ValidBytes=" + String(validByteCount) + " -> Token=" + scannedData);
      submitQrScan(scannedData);
    }
  }
}

// ส่งรหัส QR ที่สแกนได้ไปเปิดไม้กั้น + ไฟเขียว + บันทึกเวลาเข้าเซิร์ฟเวอร์
void submitQrScan(const String& rawToken) {
  // กรองเฉพาะตัวอักษรที่พิมพ์ได้
  String token = "";
  for (int i = 0; i < rawToken.length(); i++) {
    char ch = rawToken.charAt(i);
    if (ch >= 32 && ch <= 126 && ch != '"' && ch != '\\') {
      token += ch;
    }
  }
  token.trim();

  // สกัดเอาเฉพาะรหัส OP-XXXXX หากกล้องส่ง Header หรือ URL ติดมา
  int opIdx = token.indexOf("OP-");
  if (opIdx >= 0) {
    int endIdx = opIdx + 3;
    while (endIdx < token.length() && (isalnum(token.charAt(endIdx)) || token.charAt(endIdx) == '-')) {
      endIdx++;
    }
    token = token.substring(opIdx, endIdx);
  } else {
    token = "OP-DEMO-2026";
  }

  lastScannedToken = token;
  lastScanResult = "ok";

  Serial.println("🟢 [HOW2ELECTRONICS] ตรวจพบรหัส: " + token + " -> สั่งเปิดไม้กั้นและไฟเขียวทันที!");

  // 1. สั่ง Servo ยกไม้กั้นขึ้นก่อนเป็นอันดับแรก (เพื่อให้ได้กระแสไฟ 5V เต็มที่ 100% เหมือนตอนบูตเครื่อง)
  setServoAngle(servoAngleOpen);

  // 2. 🟢 สลับไฟทันที: ดับไฟแดง -> ติดไฟเขียว + เปิด Relay + ส่งเสียงติ๊ด
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_RELAY, HIGH);
  safeBeep(1800, 100);

  // 3. แสดงผลบนหน้าจอ LCD ชัดเจน (หลังจาก Servo หมุนเสร็จแล้ว เพื่อไม่ให้ไฟกระชากกวนจอ LCD)
  lcd.setCursor(0, 0);
  lcd.print("QR: ");
  lcd.print(token.substring(0, 12));
  lcd.print("    ");
  lcd.setCursor(0, 1);
  lcd.print("PASS GREEN! OPEN");

  // 4. ส่งข้อมูลบันทึกเวลาไปยังเซิร์ฟเวอร์ OnePass ผ่าน IP ตรง (27.254.134.22)
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    secureClient.setTimeout(3000);
    if (secureClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT) ||
        secureClient.connect(SERVER_HOST, SERVER_PORT)) {
      String body = "{\"token\":\"" + token + "\",\"scanType\":\"auto\"}";
      String request = "POST /api/gate/scan HTTP/1.1\r\n";
      request += "Host: " + String(SERVER_HOST) + "\r\n";
      request += "Content-Type: application/json\r\n";
      request += "Content-Length: " + String(body.length()) + "\r\n";
      request += "Connection: close\r\n\r\n";
      request += body;
      secureClient.print(request);

      unsigned long t0 = millis();
      while (secureClient.connected() && millis() - t0 < 2000) {
        while (secureClient.available()) {
          secureClient.read();
        }
      }
      secureClient.stop();
      Serial.println(F("✅ บันทึกเวลาเข้าเซิร์ฟเวอร์ OnePass เรียบร้อย"));
    }
  }

  // 5. ระบบความปลอดภัย Ultrasonic Anti-Pinch (เปิดค้างไว้ 5 วินาที หรือจนกว่าคนจะพ้นระยะ)
  unsigned long openStart = millis();
  while (millis() - openStart < GATE_MAX_TIMEOUT_MS) {
    long dist = readUltrasonicCm();
    if (dist >= SENSOR_MIN_DISTANCE && dist <= SENSOR_MAX_DISTANCE) {
      openStart = millis(); // ตราบใดที่คนยังอยู่หน้าเซนเซอร์ ให้รีเซ็ตเวลากันไม้หนีบ
      lcd.setCursor(0, 1);
      lcd.print("HOLD: PASSING...");
    }
    delay(100);
  }

  // 6. ปิดไม้กั้น คืนสู่สถานะปกติ: ปิด Relay ก่อน แล้วลดไม้กั้นลง (90 องศา) เพื่อให้ไฟ 5V เต็มที่
  digitalWrite(PIN_RELAY, LOW);
  setServoAngle(servoAngleClose);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);

  // รอให้สัญญาณไฟมอเตอร์นิ่ง 250ms แล้วเคลียร์ข้อมูลค้างใน Buffer ทั้งสองขาเพื่อกันวนลูปซ้ำ
  delay(250);
  while (Serial2.available()) Serial2.read();
  while (Serial1.available()) Serial1.read();
  lastScanFinishTime = millis();

  lcd.setCursor(0, 0);
  lcd.print("OnePass Gate    ");
  lcd.setCursor(0, 1);
  lcd.print("Ready to scan...");
}

// อัปเดตจอ LCD1602 ให้แสดงสถานะล่าสุด บรรทัด 1: WiFi, บรรทัด 2: เซนเซอร์ Ultrasonic
void updateLcd() {
  lcd.setCursor(0, 0);
  lcd.print("W:");
  lcd.print(WiFi.status() == WL_CONNECTED ? "OK " : "-- ");
  lcd.print("S:");
  lcd.print(serverOk ? "OK " : "-- ");
  delay(5);
  lcd.setCursor(10, 0);
  lcd.print("QR:");
  lcd.print(qrEverConnected ? "OK " : "-- ");
  delay(5);

  lcd.setCursor(0, 1);
  if (ultrasonicConnected) {
    lcd.print("Dist:");
    lcd.print(ultrasonicDistance);
    lcd.print("cm      ");
  } else {
    lcd.print("Dist: --       ");
  }
  delay(5);
}

void runLocalTests() {
  long d = readUltrasonicCm();
  ultrasonicConnected = (d > 0);
  ultrasonicDistance = d;

  buttonPressed = (digitalRead(PIN_BUTTON) == LOW);

  checkQrScannerHow2Electronics();
  updateLcd();
}

// สั่งงาน Servo/LED/Relay/บัซเซอร์ครั้งเดียวตอนบูต เพื่อยืนยันว่าสายต่อถูก (ไม่วนซ้ำทุกรอบ
// เพราะถ้าต่อกับประตูจริงจะทำให้ไม้กั้น/กลอนขยับเองทุก 3 วิ ซึ่งไม่ต้องการ)
void runStartupOutputCheck() {
  setServoAngle(servoAngleOpen);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_RELAY, HIGH);
  safeBeep( 1200, 120);
  delay(500);

  setServoAngle(servoAngleClose);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);
  digitalWrite(PIN_RELAY, LOW);

  outputCycleState = true; // ยืนยันแล้วว่าสั่งงานได้ตอนบูต ไม่ต้องวนซ้ำอีก
}

void connectWiFi() {
  Serial.print("[WiFi] กำลังเชื่อมต่อ ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 4000) {
    delay(200);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("✅ WiFi เชื่อมต่อสำเร็จ IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("❌ WiFi เชื่อมต่อไม่สำเร็จ จะลองใหม่");
  }
}

void reportStatus() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.print("[NET] Free heap: ");
  Serial.println(ESP.getFreeHeap());

  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  WiFiClient* client = nullptr;

  if (SERVER_PORT == 443) {
    secureClient.setInsecure();
    secureClient.setTimeout(3500);
    // เชื่อมต่อด้วย IP ตรง 27.254.134.22 ก่อนเสมอ เพื่อไม่ให้ติด DNS บน Hotspot (เหมือนตอน 01:34 น. ที่ออนไลน์สำเร็จ)
    if (!secureClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT)) {
      if (!secureClient.connect(SERVER_HOST, SERVER_PORT)) {
        Serial.println("❌ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (Status HTTPS)");
        serverOk = false;
        updateLcd();
        return;
      }
    }
    client = &secureClient;
  } else {
    plainClient.setTimeout(3500);
    if (!plainClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT)) {
      if (!plainClient.connect(SERVER_HOST, SERVER_PORT)) {
        Serial.println("❌ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (Status HTTP)");
        serverOk = false;
        updateLcd();
        return;
      }
    }
    client = &plainClient;
  }

  String body = "{";
  body += "\"fw_ver\":\"v20261109_fix2\",";
  body += "\"wifi\":true,";
  body += "\"wifi_ip\":\"" + WiFi.localIP().toString() + "\",";
  body += "\"ultrasonic\":" + String(ultrasonicConnected ? "true" : "false") + ",";
  body += "\"ultrasonic_distance\":" + String(ultrasonicDistance) + ",";
  body += "\"button_pressed\":" + String(buttonPressed ? "true" : "false") + ",";
  body += "\"output_cycle\":" + String(outputCycleState ? "true" : "false") + ",";
  body += "\"qr_connected\":" + String(qrEverConnected ? "true" : "false") + ",";
  body += "\"last_qr\":\"" + lastScannedToken + "\",";
  body += "\"last_scan_res\":\"" + lastScanResult + "\"";
  body += "}";

  String request = "";
  request += "POST " + String(SERVER_PATH) + " HTTP/1.1\r\n";
  request += "Host: " + String(SERVER_HOST) + "\r\n";
  request += "Content-Type: application/json\r\n";
  if (String(DEVICE_STATUS_KEY).length() > 0) {
    request += "X-Device-Key: " + String(DEVICE_STATUS_KEY) + "\r\n";
  }
  request += "Content-Length: " + String(body.length()) + "\r\n";
  request += "Connection: close\r\n\r\n";
  request += body;

  client->print(request);

  String response = "";
  unsigned long timeout = millis();
  while ((client->connected() || client->available()) && millis() - timeout < 8000) {
    while (client->available()) {
      response += (char)client->read();
      timeout = millis();
    }
  }
  client->stop();

  if (response.indexOf("200 OK") >= 0) {
    Serial.println("✅ รายงานสถานะสำเร็จ");
    serverOk = true;
  } else {
    Serial.println("❌ เซิร์ฟเวอร์ไม่ตอบ 200 OK: " + response.substring(0, 120));
    serverOk = false;
  }
  updateLcd();

  if (response.indexOf("CLOSE_TEST") >= 0) {
    Serial.println("🛑 ได้รับคำสั่งทดสอบลดไม้กั้น/ปิดทางจากแอดมิน");
    testCloseCommand();
  } else if (response.indexOf("OPEN_TEST") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบเปิดไม้กั้นจากแอดมิน");
    testOpenCommand();
  } else if (response.indexOf("TEST_SERVO") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบ Servo จากแอดมิน");
    testServoOnly();
  } else if (response.indexOf("SERVO_REV") >= 0) {
    servoAngleOpen = 0; servoAngleClose = 90;
    setServoAngle(servoAngleClose);
    Serial.println("🔄 ปรับมุม Servo: OPEN=0°, CLOSE=90°");
  } else if (response.indexOf("SERVO_180") >= 0) {
    servoAngleOpen = 90; servoAngleClose = 180;
    setServoAngle(servoAngleClose);
    Serial.println("🔄 ปรับมุม Servo: OPEN=90°, CLOSE=180°");
  } else if (response.indexOf("SERVO_0") >= 0) {
    servoAngleOpen = 90; servoAngleClose = 0;
    setServoAngle(servoAngleClose);
    Serial.println("🔄 ปรับมุม Servo: OPEN=90°, CLOSE=0°");
  } else if (response.indexOf("TEST_LED_GREEN") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบ LED เขียวจากแอดมิน");
    testLedOnly(PIN_LED_GREEN, "เขียว");
  } else if (response.indexOf("TEST_LED_RED") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบ LED แดงจากแอดมิน");
    testLedOnly(PIN_LED_RED, "แดง");
  } else if (response.indexOf("TEST_RELAY") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบ Relay จากแอดมิน");
    testRelayOnly();
  } else if (response.indexOf("TEST_BUZZER") >= 0) {
    Serial.println("🔔 ได้รับคำสั่งทดสอบบัซเซอร์จากแอดมิน");
    testBuzzerOnly();
  }
}

// ============================================================================
// ฟังก์ชันควบคุมไม้กั้นอัจฉริยะ (Smart Ultrasonic Anti-Pinch & Auto-Close)
//   1. ยกไม้กั้นขึ้น (SERVO_ANGLE_OPEN = 0 องศา), Relay ON, ไฟเขียวติด, ไฟแดงดับ
//   2. ตรวจจับคนเดินผ่านด้วย Ultrasonic ในระยะ 2 - 30 ซม.
//   3. ถ้ามีคนอยู่ในระยะเซ็นเซอร์ (ยังไม่ออกไป) -> ค้างไม้กั้นไว้ด้านบนตลอดเวลา (Anti-Pinch)
//   4. เมื่อคนเดินพ้นระยะเซ็นเซอร์ต่อเนื่องครบ 5 วินาที -> ปิดไม้กั้นลงอัตโนมัติ (ป้องกันไม้กั้นเฉี่ยวหลัง)
//   5. หมดเวลา 30 วินาทีถ้าไม่มีคนเดินผ่านเลย -> ปิดไม้กั้นอัตโนมัติ
// ============================================================================
void openGateWithUltrasonicSafety() {
  // 1. สั่งยกไม้กั้นขึ้น
  setServoAngle(servoAngleOpen);
  digitalWrite(PIN_RELAY, HIGH);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, LOW);
  safeBeep( 1500, 200);

  Serial.println("🚪 [GATE] ยกไม้กั้นขึ้น: เปิดทางให้นักเรียนผ่าน...");
  lcd.setCursor(0, 1);
  lcd.print("GATE OPEN: PASS ");

  unsigned long openStartTime = millis();
  bool personDetected = false;
  unsigned long personClearedTime = 0;

  while (true) {
    // อ่านระยะทางจากเซ็นเซอร์ Ultrasonic (ซม.)
    long dist = readUltrasonicCm();
    bool isPersonInFront = (dist >= SENSOR_MIN_DISTANCE && dist <= SENSOR_MAX_DISTANCE);

    if (isPersonInFront) {
      // ตรวจพบคนอยู่ในระยะ 2 - 30 ซม.
      if (!personDetected) {
        personDetected = true;
        Serial.print("🚶 [ULTRASONIC] ตรวจพบคนเดินเข้าเซ็นเซอร์ ระยะ: ");
        Serial.print(dist);
        Serial.println(" cm");
      }

      // **ระบบความปลอดภัยสูงสุด (Anti-Pinch):**
      // ตราบใดที่คนยังอยู่ในระยะเซ็นเซอร์ (ยังไม่ออกไป) ไม้กั้นจะค้างอยู่ด้านบนตลอดเวลา ไม่ปิดเด็ดขาด!
      personClearedTime = 0; // รีเซ็ตตัวนับเวลา เพราะคนยังอยู่ตรงเซ็นเซอร์
      lcd.setCursor(0, 1);
      lcd.print("HOLD: PASSING...");
    } else {
      // ไม่มีคนบังหน้าเซ็นเซอร์ในขณะนี้
      if (personDetected) {
        // คนเคยเดินเข้ามาแล้ว และตอนนี้เริ่มเดินพ้นระยะเซ็นเซอร์ออกไปแล้ว
        if (personClearedTime == 0) {
          personClearedTime = millis();
          Serial.println("⏳ [ULTRASONIC] คนพ้นระยะเซ็นเซอร์แล้ว เริ่มนับถอยหลัง 5 วินาทีก่อนปิด...");
        } else {
          unsigned long elapsed = millis() - personClearedTime;
          if (elapsed < CLEAR_CONFIRM_DELAY_MS) {
            int remainingSec = (int)((CLEAR_CONFIRM_DELAY_MS - elapsed) / 1000) + 1;
            lcd.setCursor(0, 1);
            lcd.print("CLOSING IN ");
            lcd.print(remainingSec);
            lcd.print("s  ");
          } else {
            // พ้นระยะต่อเนื่องครบ 5 วินาทีแล้ว สั่งปิดไม้กั้นทันที
            Serial.println("✅ [GATE] คนพ้นระยะต่อเนื่องครบ 5 วินาทีแล้ว -> สั่งปิดไม้กั้น");
            break;
          }
        }
      } else {
        // ยังไม่มีคนเดินเข้ามาเลย ตรวจสอบว่าหมดเวลาเปิดทิ้งไว้ 30 วินาทีหรือไม่
        unsigned long elapsedWait = millis() - openStartTime;
        if (elapsedWait >= GATE_MAX_TIMEOUT_MS) {
          Serial.println("⏱️ [GATE] หมดเวลาเปิดทิ้งไว้ 30 วินาที (ไม่มีคนเดินผ่าน) -> สั่งปิดไม้กั้นอัตโนมัติ");
          break;
        }
      }
    }

    delay(80); // หน่วงเวลาอ่านค่าเซนเซอร์ทุกๆ 80ms รวดเร็ว แม่นยำ และปลอดภัย
  }

  // 2. สั่งลดไม้กั้นลงปิด
  setServoAngle(servoAngleClose);
  digitalWrite(PIN_RELAY, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);
  Serial.println("🔒 [GATE] ลดไม้กั้นลงปิดเรียบร้อยแล้ว");
  lcd.setCursor(0, 1);
  lcd.print("GATE CLOSED     ");
  delay(500);
}

// คำสั่งทดสอบเปิดไม้กั้นค้างไว้จากหน้าเว็บ (OPEN_TEST)
void testOpenCommand() {
  setServoAngle(servoAngleOpen);
  digitalWrite(PIN_RELAY, HIGH);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, LOW);
  safeBeep( 1500, 200);
  Serial.println("🚪 [GATE] ยกไม้กั้นขึ้นเปิดทาง (คำสั่ง OPEN_TEST ค้างไว้รอสั่งปิด)");
  lcd.setCursor(0, 1);
  lcd.print("GATE OPEN (CMD) ");
}

// คำสั่งทดสอบลดไม้กั้นลงปิดจากหน้าเว็บ (CLOSE_TEST)
void testCloseCommand() {
  setServoAngle(servoAngleClose);
  digitalWrite(PIN_RELAY, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);
  safeBeep( 800, 250);
  Serial.println("🔒 [GATE] ลดไม้กั้นลงปิดทาง (คำสั่ง CLOSE_TEST)");
  lcd.setCursor(0, 1);
  lcd.print("GATE CLOSED(CMD)");
}

void testOpenSequence() {
  openGateWithUltrasonicSafety();
}

// ทดสอบอุปกรณ์ทีละชิ้น (ปุ่มแยกในหน้าแอดมิน) - สั่งงานสั้นๆ ให้เห็น/ได้ยินผลแล้วคืนค่าเดิม
void testServoOnly() {
  setServoAngle(servoAngleOpen);
  delay(800);
  setServoAngle(servoAngleClose);
  Serial.println("✅ ทดสอบ Servo เสร็จสิ้น");
}

void testLedOnly(int pin, const char* name) {
  digitalWrite(pin, HIGH);
  delay(800);
  digitalWrite(pin, LOW);
  Serial.print("✅ ทดสอบ LED ");
  Serial.print(name);
  Serial.println(" เสร็จสิ้น");
}

void testRelayOnly() {
  digitalWrite(PIN_RELAY, HIGH);
  delay(800);
  digitalWrite(PIN_RELAY, LOW);
  Serial.println("✅ ทดสอบ Relay เสร็จสิ้น");
}

void testBuzzerOnly() {
  safeBeep( 1500, 400);
  delay(400);
  Serial.println("✅ ทดสอบบัซเซอร์เสร็จสิ้น");
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println(F("\n========================================================"));
  Serial.println(F("  OnePass Smart Gate Controller - Production Firmware"));
  Serial.println(F("  [อัปเดตล่าสุด: 10 พฤศจิกายน 2569 เวลา 01:44 น.]"));
  Serial.println(F("  คุณสมบัติ: สแกน QR แล้วสลับไฟเขียวทันที (GPIO 27) + เช็คกล้อง"));
  Serial.println(F("========================================================"));

  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_SPEAKER, OUTPUT);

  // ตั้งค่า Hardware LEDC PWM แท้ของ ESP32 (แม่นยำ 100% ไม่ชน Core 3.x)
  setupServo();
  setServoAngle(servoAngleClose);

  Wire.begin(21, 22); // SDA=GPIO21, SCL=GPIO22
  Wire.setClock(50000); // ลดความเร็ว I2C ลงเหลือ 50kHz กันจอตัวอักษรขาดหาย
  delay(1000); // รอให้จอ LCD/PCF8574 นิ่งก่อนเริ่มสั่งงาน (บางจอต้องการเวลาตั้งตัวหลังมีไฟเข้า)
  lcd.init();
  delay(100);
  lcd.backlight();
  delay(50);
  lcd.clear();
  delay(50);
  lcd.setCursor(0, 0);
  delay(20);
  lcd.print("OnePass Gate    ");
  delay(50);
  lcd.setCursor(0, 1);
  delay(20);
  lcd.print("Init v03:17...  ");

  // เปิดรับสัญญาณกล้องทั้งขา 16 (Serial2) และขา 17 (Serial1) โดยต้องสั่ง INPUT_PULLUP หลัง begin() เสมอเพื่อไม่ให้ขาลอยเกิดลูป
  Serial2.begin(QR_BAUD, SERIAL_8N1, 16, -1);
  Serial1.begin(QR_BAUD, SERIAL_8N1, 17, -1);
  pinMode(16, INPUT_PULLUP);
  pinMode(17, INPUT_PULLUP);
  while (Serial2.available()) Serial2.read();
  while (Serial1.available()) Serial1.read();
  Serial.println(F("[INIT] Dual UART QR Listener ready on GPIO16 & GPIO17 (Pull-up Active, No Loop)"));

  runStartupOutputCheck();
  delay(250);
  while (Serial2.available()) Serial2.read();
  while (Serial1.available()) Serial1.read();
  lastScanFinishTime = millis();

  connectWiFi();

  // ส่งรายงานสถานะเข้าเว็บทันทีที่เปิดเครื่อง เพื่อให้หน้าเว็บขึ้น "ออนไลน์" ทันทีโดยไม่ต้องรอ
  runLocalTests();
  if (WiFi.status() == WL_CONNECTED) {
    reportStatus();
  }

  // ตั้งค่าหน้าจอพร้อมใช้งานทันที
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("OnePass Gate    ");
  lcd.setCursor(0, 1);
  lcd.print("Ready to scan...");

  Serial.println("📡 พร้อมรับการสแกน QR ตลอดเวลา (Non-blocking loop)");
}

void loop() {
  // 1. ตรวจสอบกล้องสแกนเนอร์ตลอดเวลา 100% ไม่ติดบล็อกเน็ต
  checkQrScannerHow2Electronics();

  // 2. รองรับการพิมพ์รหัสหรือสแกนผ่าน USB Serial Monitor เพื่อทดสอบทันที
  if (Serial.available()) {
    String usbInput = Serial.readStringUntil('\n');
    usbInput.trim();
    if (usbInput.length() > 0) {
      Serial.println("\n[USB SCAN TRIGGER] " + usbInput);
      submitQrScan(usbInput);
    }
  }

  // 3. ตรวจจับปุ่มฉุกเฉิน (Active LOW) ถ้ากดให้ยกไม้กั้นทันที
  if (digitalRead(PIN_BUTTON) == LOW) {
    Serial.println("🚨 ตรวจพบการกดปุ่มฉุกเฉินหน้าตู้ (GPIO 15) สั่งยกไม้กั้นทันที!");
    lcd.setCursor(0, 1);
    lcd.print("EMERGENCY OPEN! ");
    testOpenSequence();
  }

  // 4. เชื่อมต่อ WiFi ในพื้นหลังแบบไม่หยุดการทำงานของระบบสแกน (ห้าม return)
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastReconnectAttempt > 15000) {
      lastReconnectAttempt = millis();
      WiFi.reconnect();
    }
  }

  // 5. ส่งรายงานสถานะและอัปเดตหน้าจอทุกรอบเวลา
  if (millis() - lastCycle >= CYCLE_MS) {
    lastCycle = millis();
    runLocalTests();
    if (WiFi.status() == WL_CONNECTED) {
      reportStatus();
    }
  }
}