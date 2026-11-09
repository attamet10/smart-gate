/*
  ============================================================================
  SMART GATE ESP32 - STATUS REPORTER (ส่งสถานะอุปกรณ์ไปที่เซิร์ฟเวอร์ onepass.ongkharak.ac.th)
  บอร์ด: ESP32 Dev Module

  ทำอะไร:
    - เชื่อม WiFi แล้วเช็คเซนเซอร์/ปุ่ม/QR ซ้ำทุก 3 วินาที (อ่านค่าเฉยๆ ไม่สั่งงานอะไร)
    - สั่งงาน Servo/LED/Relay/บัซเซอร์ "ครั้งเดียว" ตอนบูตเพื่อยืนยันว่าสายต่อถูก จากนั้นจะไม่ขยับเอง
      อีกจนกว่าแอดมินจะกดปุ่มทดสอบจากเว็บ (ทดสอบรวมหรือทีละชิ้นก็ได้)
    - ส่งผลเข้า POST https://onepass.ongkharak.ac.th/api/device/status (HTTPS)
    - แอดมินดูผลได้จากเว็บไซต์หลัก หน้า "สถานะฮาร์ดแวร์ประตู" ในเมนูแอดมิน

  การเชื่อมต่อขาพิน:
    - Servo ไม้กั้น            : GPIO 18 (0° = ยกขึ้นเปิด, 90° = ยกลงปิด)
    - LED เขียว                : GPIO 27 (อนุญาตผ่าน)
    - LED แดง                  : GPIO 33 (รอสแกน / ปิด)
    - Relay กลอน/ไม้กั้น        : GPIO 26
    - ปุ่มฉุกเฉิน                : GPIO 15 (Active LOW)
    - Ultrasonic Trig / Echo   : GPIO 5 / GPIO 19 (ตรวจจับคน 2 - 30 cm)
    - ลำโพง/บัซเซอร์            : GPIO 14
    - โมดูลสแกน QR (UART2)     : RX2=GPIO 16 / TX2=GPIO 17
      ปรับ QR_BAUD ด้านล่างให้ตรงกับสเปกโมดูลที่ใช้จริง (ค่าเริ่มต้น 9600 เป็นค่ายอดนิยม)

  ข้อจำกัดที่ควรรู้:
    - WiFi และเซนเซอร์ Ultrasonic ตรวจสอบการเชื่อมต่อได้แม่นยำจริง
    - Servo / LED / Relay / ลำโพง / ปุ่มฉุกเฉิน เป็นขาที่ไม่มีสายป้อนกลับ รายงานได้แค่ว่า
      "สั่งงานแล้ว" ไม่ยืนยันการต่อสาย 100% ต้องดูด้วยตา/หูเอง
    - โมดูล QR: ถ้าไม่เคยมีข้อมูลส่งมาจากโมดูลเลยตั้งแต่เปิดเครื่อง จะขึ้น "ไม่ได้เชื่อมต่อ"
      ลองสแกนบัตร/QR ใดๆ ผ่านโมดูลสักครั้งเพื่อยืนยันว่าสายต่อถูกและสื่อสารได้จริง

  ก่อนอัปโหลด:
    1. ใช้ secrets.h เดิมที่มี WIFI_SSID / WIFI_PASSWORD อยู่แล้วได้เลย
    2. ถ้าเซิร์ฟเวอร์ตั้งค่า DEVICE_STATUS_KEY ไว้ ให้ใส่ค่าเดียวกันใน DEVICE_STATUS_KEY
       ด้านล่างนี้ด้วย (ไม่บังคับ ถ้าเซิร์ฟเวอร์ไม่ได้ตั้งค่าไว้ ปล่อยว่างได้)
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "secrets.h"

#define PIN_SERVO        18
// กำหนดองศา Servo ไม้กั้น (Hardware LEDC PWM Native):
// 90° = ยกขึ้นเปิดทาง (แนวตั้ง), 0° = ลดลงปิดกั้นทาง (แนวนอน)
int servoAngleOpen  = 0;   // ยกไม้กั้นขึ้น (เปิดทาง / เขียว) = 0 องศา (แนวตั้ง)
int servoAngleClose = 90;  // ลดไม้กั้นลง (ปิดกั้นทาง / แดง) = 90 องศา (แนวนอน)

// การตั้งค่าระบบ Ultrasonic ตรวจจับคนเดินผ่าน & ป้องกันไม้กั้นตีคน
#define SENSOR_MIN_DISTANCE       2     // ระยะตรวจจับต่ำสุด (ซม.)
#define SENSOR_MAX_DISTANCE       30    // ระยะตรวจจับคนเดินผ่าน (ซม.) 2 - 30 ซม.
#define CLEAR_CONFIRM_DELAY_MS    3000  // หน่วงเวลารอให้พ้นตัว 3 วินาทีก่อนปิด (ป้องกันไม้กั้นเฉี่ยวหลัง)
#define GATE_MAX_TIMEOUT_MS       8000  // หมดเวลาเปิดทิ้งไว้ 8 วินาที (ถ้าสแกนแล้วไม่ยอมเดินผ่าน หรือทดสอบบนโต๊ะ)

#define PIN_LED_GREEN    27
#define PIN_LED_RED      33
#define PIN_RELAY        26
#define PIN_BUTTON       15
#define PIN_TRIG         5
#define PIN_ECHO         19
#define PIN_SPEAKER      14

#define QR_RX_PIN        16
#define QR_TX_PIN        17
#define QR_BAUD          9600

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
bool qrEverConnected = false; // true ถาวรตั้งแต่ครั้งแรกที่มีข้อมูลเข้ามาจากโมดูล QR
bool serverOk = false;        // true เมื่อส่งสถานะเข้าเว็บสำเร็จจริง (HTTP 200)
void updateLcd();

unsigned long lastCycle = 0;
const unsigned long CYCLE_MS = 8000; // ส่งสถานะทุก 8 วินาที
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

String qrBuffer = "";
unsigned long lastQrByteTime = 0;
String lastScannedToken = "";
String lastScanResult = "none";

void drainQrSerial() {
  while (QrSerial.available()) {
    char c = (char)QrSerial.read();
    Serial.write(c); // แสดงตัวอักษรที่กล้องส่งมาใน Serial Monitor ทันที
    qrEverConnected = true;
    lastQrByteTime = millis();

    if (c == '\r' || c == '\n') {
      qrBuffer.trim();
      if (qrBuffer.length() > 0) {
        String scanned = qrBuffer;
        qrBuffer = "";
        Serial.println("\n[QR RECEIVED] " + scanned);
        submitQrScan(scanned);
      }
    } else {
      qrBuffer += c;
      if (qrBuffer.length() > 200) qrBuffer = "";
    }
  }

  // รองรับโมดูล QR ทุกรุ่น แม้ไม่ส่ง \r หรือ \n ปิดท้าย:
  if (qrBuffer.length() >= 3 && millis() - lastQrByteTime > 100) {
    qrBuffer.trim();
    if (qrBuffer.length() > 0) {
      String scanned = qrBuffer;
      qrBuffer = "";
      Serial.println("\n[QR AUTO-SUBMIT] " + scanned);
      submitQrScan(scanned);
    }
  }
}

// ส่งรหัส QR ที่สแกนได้ไปตรวจสอบที่เซิร์ฟเวอร์จริง (สแกนผ่าน เปิดไม้กั้นอัตโนมัติ)
void submitQrScan(const String& rawToken) {
  // กรองเฉพาะตัวอักษรที่พิมพ์ได้ ตัดรหัสขยะ/ตัวควบคุม/เครื่องหมายคำพูดทิ้ง เพื่อให้ JSON ถูกต้อง 100%
  String token = "";
  for (int i = 0; i < rawToken.length(); i++) {
    char ch = rawToken.charAt(i);
    if (ch >= 32 && ch <= 126 && ch != '"' && ch != '\\') {
      token += ch;
    }
  }
  token.trim();

  Serial.print("[QR SCAN] Raw: ");
  Serial.print(rawToken);
  Serial.print(" -> Clean: ");
  Serial.println(token);

  // สกัดเอาเฉพาะ OP-XXXXX หากกล้องส่ง AIM code หรือข้อความอื่นแถมมา
  int opIdx = token.indexOf("OP-");
  if (opIdx >= 0) {
    int endIdx = opIdx + 3;
    while (endIdx < token.length() && (isalnum(token.charAt(endIdx)) || token.charAt(endIdx) == '-')) {
      endIdx++;
    }
    token = token.substring(opIdx, endIdx);
    Serial.println("[QR SCAN] Extracted OP token: " + token);
  }

  if (token.length() < 3) return;
  lastScannedToken = token;

  // ส่งเสียงติ๊ดสั้นทันทีที่บอร์ดรับรหัสจากกล้องได้ (ยืนยันว่ากล้องส่งข้อมูลถึงบอร์ดแล้ว)
  safeBeep( 1500, 80);

  lcd.setCursor(0, 1);
  lcd.print("Checking pass...");

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ ไม่สามารถส่งรหัสได้: WiFi ไม่ได้เชื่อมต่อ");
    lcd.setCursor(0, 1);
    lcd.print("WiFi not ready! ");
    lastScanResult = "wifi_err";
    safeBeep( 400, 300);
    return;
  }

  WiFiClientSecure secureClient;
  WiFiClient plainClient;
  WiFiClient* client = nullptr;

  if (SERVER_PORT == 443) {
    secureClient.setInsecure();
    secureClient.setTimeout(8000);
    // เชื่อมต่อด้วย IP ตรง 27.254.134.22 ก่อนเสมอ เพื่อข้ามปัญหา DNS ช้าบน Hotspot มือถือ
    if (!secureClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT) &&
        !secureClient.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (QR scan HTTPS)");
      lcd.setCursor(0, 1);
      lcd.print("HTTPS Conn Error");
      lastScanResult = "https_err";
      safeBeep( 400, 300);
      return;
    }
    client = &secureClient;
  } else {
    plainClient.setTimeout(8000);
    if (!plainClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT) &&
        !plainClient.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (QR scan HTTP)");
      lcd.setCursor(0, 1);
      lcd.print("HTTP Conn Error ");
      lastScanResult = "http_err";
      safeBeep( 400, 300);
      return;
    }
    client = &plainClient;
  }

  String body = "{\"token\":\"" + token + "\",\"scanType\":\"auto\"}";

  String request = "";
  request += "POST /api/gate/scan HTTP/1.1\r\n";
  request += "Host: " + String(SERVER_HOST) + "\r\n";
  request += "Content-Type: application/json\r\n";
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

  Serial.println("[SERVER RESPONSE] " + response);

  bool success = (response.indexOf("\"success\":true") >= 0 ||
                  response.indexOf("\"success\": true") >= 0 ||
                  response.indexOf("200 OK") >= 0);

  lcd.setCursor(0, 1);
  if (success) {
    lastScanResult = "ok";
    lcd.print("Scan: OK!       ");
    Serial.println("✅ สแกน QR สำเร็จ เปิดไม้กั้นทันที");
    testOpenSequence();
  } else {
    lastScanResult = "denied";
    lcd.print("Scan: DENIED    ");
    Serial.println("❌ สแกน QR ไม่ผ่าน: " + response);
    safeBeep( 400, 400);
  }
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

  drainQrSerial();
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
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    delay(300);
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
    secureClient.setTimeout(8000);
    // เชื่อมต่อด้วย IP ตรง 27.254.134.22 ก่อนเสมอ เพื่อไม่ให้บอร์ดค้างรอ DNS บน Hotspot
    if (!secureClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT)) {
      Serial.println("⚠️ ต่อด้วย IP ตรงไม่สำเร็จ ลองต่อด้วยโดเมน ...");
      if (!secureClient.connect(SERVER_HOST, SERVER_PORT)) {
        Serial.println("❌ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (Status HTTPS) ทั้ง IP และโดเมน");
        serverOk = false;
        updateLcd();
        return;
      }
    }
    client = &secureClient;
  } else {
    plainClient.setTimeout(8000);
    if (!plainClient.connect(IPAddress(27, 254, 134, 22), SERVER_PORT) &&
        !plainClient.connect(SERVER_HOST, SERVER_PORT)) {
      Serial.println("⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (Status HTTP)");
      serverOk = false;
      updateLcd();
      return;
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
  lcd.print("OnePass Gate");
  delay(50);
  lcd.setCursor(0, 1);
  delay(20);
  lcd.print("Starting...");

  QrSerial.begin(QR_BAUD, SERIAL_8N1, QR_RX_PIN, QR_TX_PIN);

  runStartupOutputCheck();
  connectWiFi();
  Serial.println("📡 เริ่มรายงานสถานะไปที่ " + String(SERVER_HOST) + " ทุก 3 วินาที");
}

void loop() {
  drainQrSerial();

  // รองรับการพิมพ์รหัสหรือสแกนผ่าน USB Serial Monitor เพื่อทดสอบทันที
  if (Serial.available()) {
    String usbInput = Serial.readStringUntil('\n');
    usbInput.trim();
    if (usbInput.length() > 0) {
      Serial.println("\n[USB SCAN TRIGGER] " + usbInput);
      submitQrScan(usbInput);
    }
  }

  // ตรวจจับปุ่มฉุกเฉิน (Active LOW) ถ้ากดให้ยกไม้กั้นทันที
  if (digitalRead(PIN_BUTTON) == LOW) {
    Serial.println("🚨 ตรวจพบการกดปุ่มฉุกเฉินหน้าตู้ (GPIO 15) สั่งยกไม้กั้นทันที!");
    lcd.setCursor(0, 1);
    lcd.print("EMERGENCY OPEN! ");
    testOpenSequence();
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastReconnectAttempt > 10000) {
      lastReconnectAttempt = millis();
      connectWiFi();
    }
    return;
  }

  if (millis() - lastCycle >= CYCLE_MS) {
    lastCycle = millis();
    runLocalTests();
    reportStatus();
  }
}
