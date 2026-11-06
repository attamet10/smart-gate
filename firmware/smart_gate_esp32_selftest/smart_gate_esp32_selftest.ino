/*
  ============================================================================
  SMART GATE ESP32 - SELF-TEST FIRMWARE (ตรวจสอบการต่อฮาร์ดแวร์ + แจ้งผลผ่าน Telegram)
  บอร์ด: ESP32 Dev Module

  ทำอะไรบ้าง:
    1. เชื่อมต่อ WiFi
    2. ทดสอบอุปกรณ์แต่ละชิ้นทีละตัว (Servo, LED เขียว, LED แดง, Relay,
       ปุ่มฉุกเฉิน, เซนเซอร์ Ultrasonic)
    3. สรุปผลแล้วส่งแจ้งเตือนไปที่ Telegram ผ่าน Bot
    4. ขึ้นผลทาง Serial Monitor ด้วย (เผื่อเปิดดูสดๆ)

  ข้อจำกัดที่ควรรู้:
    - Servo / LED / Relay เป็นขา OUTPUT อย่างเดียว ไม่มีสายป้อนกลับ (feedback)
      เข้าบอร์ด ซอฟต์แวร์จึงบอกได้แค่ "สั่งงานแล้ว" ไม่สามารถยืนยัน 100% ว่า
      สายต่อถึงจริงหรือเปล่า ต้องดูด้วยตา (ไฟติด/ไม้กั้นขยับ/รีเลย์มีเสียงคลิก)
    - ปุ่มฉุกเฉินอ่านสถานะพิน ณ เวลาที่ทดสอบได้ แต่ไม่ยืนยันว่าสายต่อถูกขาไหม
    - มีแค่เซนเซอร์ Ultrasonic ที่ตรวจสอบการเชื่อมต่อจริงได้แม่นยำ เพราะถ้าไม่ต่อ
      พิน Echo จะไม่มีสัญญาณตอบกลับเลย (timeout ทุกครั้ง)

  ก่อนอัปโหลด:
    1. คัดลอก secrets.example.h เป็น secrets.h ในโฟลเดอร์เดียวกัน
    2. ใส่ค่า WiFi, (ถ้ามี) MQTT, และ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
    3. วิธีสร้าง Telegram Bot: คุยกับ @BotFather ใน Telegram พิมพ์ /newbot
       จะได้ Token มา ส่วน Chat ID หาได้จากคุยกับ @userinfobot หรือ
       @RawDataBot แล้วส่งข้อความอะไรก็ได้ไปหาบอทตัวเอง
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP32Servo.h>
#include "secrets.h"

#define PIN_SERVO        18
#define PIN_LED_GREEN    32
#define PIN_LED_RED      33
#define PIN_RELAY        26
#define PIN_BUTTON       15
#define PIN_TRIG         5
#define PIN_ECHO         19

Servo gateServo;
String report = "";

void appendLine(const String& line) {
  Serial.println(line);
  report += line + "\n";
}

long readUltrasonicCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duration == 0) return -1; // ไม่มีสัญญาณตอบกลับ = ไม่ได้ต่อ/เสีย
  return duration * 0.034 / 2;
}

// ====================== ทดสอบ WiFi ======================
bool testWiFi() {
  appendLine("— ทดสอบ WiFi —");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    delay(300);
  }

  if (WiFi.status() == WL_CONNECTED) {
    appendLine("✅ WiFi: เชื่อมต่อสำเร็จ (IP: " + WiFi.localIP().toString() + ", RSSI: " + String(WiFi.RSSI()) + " dBm)");
    return true;
  } else {
    appendLine("❌ WiFi: เชื่อมต่อไม่สำเร็จ (เช็ค SSID/PASSWORD ใน secrets.h)");
    return false;
  }
}

// ====================== ทดสอบ Servo (ไม้กั้น) ======================
void testServo() {
  appendLine("— ทดสอบ Servo ไม้กั้น (GPIO 18) —");
  gateServo.setPeriodHertz(50);
  gateServo.attach(PIN_SERVO, 500, 2400);
  gateServo.write(90);
  delay(1000);
  gateServo.write(0);
  delay(1000);
  appendLine("⚙️ Servo: สั่งงานแล้ว (ยก 90° แล้วลดกลับ 0°) — ดูด้วยตาว่าไม้กั้นขยับจริงไหม");
}

// ====================== ทดสอบ LED ======================
void testLed(int pin, const String& name) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, HIGH);
  delay(500);
  digitalWrite(pin, LOW);
  delay(300);
  digitalWrite(pin, HIGH);
  delay(500);
  digitalWrite(pin, LOW);
  appendLine("💡 " + name + ": สั่งกะพริบแล้ว — ดูด้วยตาว่าไฟติดจริงไหม");
}

// ====================== ทดสอบ Relay ======================
void testRelay() {
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, HIGH);
  delay(800);
  digitalWrite(PIN_RELAY, LOW);
  appendLine("🔌 Relay (GPIO 26): สั่งงานแล้ว — ฟังเสียงคลิกหรือดูไฟสถานะบนตัว Relay");
}

// ====================== ทดสอบปุ่มฉุกเฉิน ======================
void testButton() {
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  delay(50);
  int state = digitalRead(PIN_BUTTON);
  if (state == HIGH) {
    appendLine("🔘 ปุ่มฉุกเฉิน (GPIO 15): อ่านค่าได้ปกติ (ไม่ได้กดอยู่ = HIGH)");
  } else {
    appendLine("⚠️ ปุ่มฉุกเฉิน (GPIO 15): อ่านค่าเป็น LOW (กำลังถูกกดอยู่ หรือสายช็อตกับ GND)");
  }
}

// ====================== ทดสอบ Ultrasonic ======================
void testUltrasonic() {
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  int validReadings = 0;
  long lastDist = -1;
  for (int i = 0; i < 5; i++) {
    long d = readUltrasonicCm();
    if (d > 0) {
      validReadings++;
      lastDist = d;
    }
    delay(100);
  }

  if (validReadings > 0) {
    appendLine("✅ Ultrasonic (Trig 5 / Echo 19): เชื่อมต่อปกติ (ระยะล่าสุด ~" + String(lastDist) + " ซม.)");
  } else {
    appendLine("❌ Ultrasonic (Trig 5 / Echo 19): ไม่พบสัญญาณตอบกลับเลย — ไม่ได้ต่อสาย หรือเสีย");
  }
}

// ====================== ส่งข้อความไปที่ Telegram ======================
void sendTelegram(const String& text) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ ส่ง Telegram ไม่ได้ เพราะ WiFi ไม่เชื่อมต่อ");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect("api.telegram.org", 443)) {
    Serial.println("⚠️ เชื่อมต่อ api.telegram.org ไม่สำเร็จ");
    return;
  }

  String body = "{\"chat_id\":\"" + String(TELEGRAM_CHAT_ID) + "\",\"text\":\"" + text + "\"}";

  String request = "";
  request += "POST /bot" + String(TELEGRAM_BOT_TOKEN) + "/sendMessage HTTP/1.1\r\n";
  request += "Host: api.telegram.org\r\n";
  request += "Content-Type: application/json\r\n";
  request += "Content-Length: " + String(body.length()) + "\r\n";
  request += "Connection: close\r\n\r\n";
  request += body;

  client.print(request);

  unsigned long timeout = millis();
  while (client.connected() && millis() - timeout < 10000) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      if (line.indexOf("\"ok\":true") >= 0) {
        Serial.println("✅ ส่งแจ้งเตือน Telegram สำเร็จ");
      }
    }
  }
  client.stop();
}

// แปลงอักขระขึ้นบรรทัดใหม่และเครื่องหมายคำพูดให้ปลอดภัยสำหรับ JSON
String escapeForTelegram(const String& input) {
  String out = "";
  for (unsigned int i = 0; i < input.length(); i++) {
    char c = input.charAt(i);
    if (c == '\n') out += "\\n";
    else if (c == '"') out += "\\\"";
    else out += c;
  }
  return out;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  appendLine("============================================");
  appendLine("🔧 OnePass Smart Gate — ตรวจสอบระบบฮาร์ดแวร์");
  appendLine("============================================");

  bool wifiOk = testWiFi();
  testServo();
  testLed(PIN_LED_GREEN, "LED เขียว (GPIO 32)");
  testLed(PIN_LED_RED, "LED แดง (GPIO 33)");
  testRelay();
  testButton();
  testUltrasonic();

  appendLine("============================================");
  appendLine("ตรวจสอบเสร็จสิ้น");

  if (wifiOk) {
    sendTelegram(escapeForTelegram(report));
  } else {
    Serial.println("ข้ามการส่ง Telegram เพราะ WiFi ไม่เชื่อมต่อ");
  }
}

void loop() {
  // ทดสอบครั้งเดียวตอนบูต ไม่ต้องทำอะไรซ้ำใน loop
}
