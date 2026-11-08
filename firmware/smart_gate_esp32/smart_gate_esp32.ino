/*
  ============================================================================
  SMART GATE ESP32 FIRMWARE (OnePass Official USB-Serial Controller)
  ระบบควบคุมประตูไม้กั้นอัจฉริยะ OnePass IoT
  บอร์ด: ESP32 Dev Module
  Baud Rate: 115200

  การเชื่อมต่อขาพิน:
    - Servo SG90 ไม้กั้น     : GPIO 18 (สายสัญญาณสีส้ม/เหลือง)
    - LED สีเขียว (อนุญาตผ่าน) : GPIO 32
    - LED สีแดง (รอสแกน/ปิด)  : GPIO 33
    - Relay กลอน/ไม้กั้น (ถ้ามี): GPIO 26
    - ปุ่มกดฉุกเฉิน (ถ้ามี)     : GPIO 15 (Active LOW)
    - Ultrasonic Trig (ถ้ามี) : GPIO 5
    - Ultrasonic Echo (ถ้ามี) : GPIO 19
  ============================================================================
*/

#include <Wire.h>
#include <ESP32Servo.h>

// ====================== กำหนดขาพิน ======================
#define PIN_SERVO        18    // มอเตอร์ Servo ไม้กั้น
#define PIN_LED_GREEN    32    // LED สีเขียว: อนุญาตผ่าน / ไม้กั้นเปิด
#define PIN_LED_RED      33    // LED สีแดง: รอสแกน / ไม้กั้นปิด
#define PIN_RELAY        26    // Relay กลอนไฟฟ้า/ไม้กั้น (HIGH = ทำงาน)
#define PIN_BUTTON       15    // ปุ่มเปิดฉุกเฉินแบบปุ่มกด (Active LOW)

// กำหนดองศา Servo ไม้กั้น (ปรับทิศทางตามการติดตั้งจริง: 0° = ยกขึ้นเปิดทาง, 90° = ยกลงปิดทาง)
#define SERVO_ANGLE_OPEN    0     // ยกไม้กั้นขึ้น (เปิดทาง)
#define SERVO_ANGLE_CLOSE   90    // ลดไม้กั้นลง (ปิดกั้นทาง)

// Ultrasonic HC-SR04 (เซนเซอร์ตรวจจับคน/รถผ่าน)
#define PIN_TRIG         5
#define PIN_ECHO         19

// อ็อบเจกต์ Servo
Servo gateServo;

// ตัวแปรสถานะ
bool isGateOpen = false;
unsigned long gateOpenTime = 0;
unsigned long gateHoldDuration = 30000; // ค่าเริ่มต้นเปิดค้าง 30 วินาที
String currentRequestId = "";

// ตรวจจับ Ultrasonic
bool objectPassed = false;
unsigned long objectDetectTime = 0;

// ฟังก์ชันวัดระยะ Ultrasonic (cm)
long readUltrasonicCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 25000); // timeout 25ms (~4 เมตร)
  if (duration == 0) return 999;
  return duration * 0.034 / 2;
}

// ฟังก์ชันสั่งเปิดไม้กั้น
void openGate(int durationSec = 30, String reqId = "") {
  isGateOpen = true;
  gateOpenTime = millis();
  gateHoldDuration = (unsigned long)durationSec * 1000UL;
  currentRequestId = reqId;
  objectPassed = false;
  objectDetectTime = 0;

  // ควบคุมฮาร์ดแวร์
  gateServo.write(SERVO_ANGLE_OPEN);  // ยกไม้กั้นขึ้น
  digitalWrite(PIN_RELAY, HIGH);      // ทำงาน Relay
  digitalWrite(PIN_LED_GREEN, HIGH);  // ไฟเขียวติด
  digitalWrite(PIN_LED_RED, LOW);     // ไฟแดงดับ

  // ส่ง ACK ยืนยันกลับไปยังเซิร์ฟเวอร์
  Serial.print("[GATE_OPENED] requestId=");
  Serial.print(currentRequestId);
  Serial.print(" duration=");
  Serial.println(durationSec);
}

// ฟังก์ชันสั่งปิดไม้กั้น
void closeGate(const char* reason = "TIMEOUT_30S") {
  isGateOpen = false;

  // ควบคุมฮาร์ดแวร์
  gateServo.write(SERVO_ANGLE_CLOSE); // ลดไม้กั้นลงปิดกั้นทาง
  digitalWrite(PIN_RELAY, LOW);       // ตัด Relay
  digitalWrite(PIN_LED_GREEN, LOW);   // ไฟเขียวดับ
  digitalWrite(PIN_LED_RED, HIGH);    // ไฟแดงติด

  // ส่งสัญญาณให้เซิร์ฟเวอร์ตัดสิทธิ์ QR Code และลบคำขอทดสอบ
  Serial.print("[GATE_CLOSED] requestId=");
  Serial.print(currentRequestId);
  Serial.print(" reason=");
  Serial.println(reason);

  currentRequestId = "";
}

// ฟังก์ชันประมวลผลคำสั่ง Serial
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.startsWith("OPEN")) {
    // รองรับคำสั่ง: OPEN <seconds> <requestId>
    int duration = 30;
    String reqId = "";

    int firstSpace = cmd.indexOf(' ');
    if (firstSpace > 0) {
      int secondSpace = cmd.indexOf(' ', firstSpace + 1);
      if (secondSpace > 0) {
        duration = cmd.substring(firstSpace + 1, secondSpace).toInt();
        reqId = cmd.substring(secondSpace + 1);
      } else {
        duration = cmd.substring(firstSpace + 1).toInt();
      }
    }
    if (duration <= 0) duration = 30;
    openGate(duration, reqId);
  } else if (cmd == "CLOSE" || cmd == "CLOSE_GATE") {
    closeGate("MANUAL_CLOSE");
  } else if (cmd == "PING") {
    Serial.println("[PONG] ESP32_ONLINE");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  // กำหนดโหมดขาพิน
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  // ตั้งค่า Servo บน GPIO 18
  gateServo.setPeriodHertz(50);
  gateServo.attach(PIN_SERVO, 500, 2400);

  // เริ่มต้นที่สถานะปิด
  closeGate("BOOT_INIT");

  Serial.println("[ESP32_READY] OnePass Gate Controller Ready on COM5");
}

void loop() {
  // 1. รับคำสั่งจากคอมพิวเตอร์ผ่าน USB Serial
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    handleCommand(cmd);
  }

  // 2. ตรวจสอบปุ่มเปิดฉุกเฉิน (GPIO 15)
  if (digitalRead(PIN_BUTTON) == LOW) {
    delay(50); // Debounce
    if (digitalRead(PIN_BUTTON) == LOW) {
      openGate(30, "EMERGENCY_BTN");
      while (digitalRead(PIN_BUTTON) == LOW);
    }
  }

  // 3. จัดการขณะไม้กั้นกำลังเปิดอยู่
  if (isGateOpen) {
    unsigned long elapsed = millis() - gateOpenTime;

    // ตรวจจับ Ultrasonic (ถ้ารถ/คนเข้ามาใกล้ 5-30cm แล้วพ้นออกไป > 40cm จะปิดทันที)
    long dist = readUltrasonicCm();
    if (dist >= 5 && dist <= 30) {
      objectPassed = true;
      objectDetectTime = millis();
    }
    if (objectPassed && (millis() - objectDetectTime >= 800)) {
      if (dist > 45 || dist == 999) {
        closeGate("SENSOR_PASSED");
        return;
      }
    }

    // ครบกำหนดเวลา 30 วินาที ปิดอัตโนมัติ
    if (elapsed >= gateHoldDuration) {
      closeGate("TIMEOUT_30S");
      return;
    }
  }
}
