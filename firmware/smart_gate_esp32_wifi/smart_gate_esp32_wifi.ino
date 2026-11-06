/*
  ============================================================================
  SMART GATE ESP32 FIRMWARE (OnePass WiFi + MQTT Controller)
  ระบบควบคุมประตูไม้กั้นอัจฉริยะ OnePass IoT - รุ่นเชื่อมต่อไร้สาย
  บอร์ด: ESP32 Dev Module

  ใช้รุ่นนี้เมื่อ:
    - บอร์ด ESP32 ติดตั้งอยู่ที่ประตูจริงในโรงเรียน
    - เซิร์ฟเวอร์ (server.js) รันอยู่บน Plesk ของ hostatom (onepass.ongkharak.ac.th)
      ซึ่งอยู่คนละที่กับบอร์ด ต้องคุยกันผ่านอินเทอร์เน็ต (WiFi + MQTT)
    - ถ้าต้องการต่อ USB กับคอมโดยตรง ให้ใช้ smart_gate_esp32.ino (รุ่น Serial) แทน

  ไลบรารีที่ต้องติดตั้งก่อน (Arduino IDE > Tools > Manage Libraries):
    1. "ESP32Servo"   by Kevin Harrington
    2. "PubSubClient" by Nick O'Leary
    (WiFi.h และ WiFiClientSecure.h มีมาพร้อม ESP32 board package อยู่แล้ว)

  ก่อนอัปโหลด:
    1. คัดลอกไฟล์ secrets.example.h เป็น secrets.h (ไฟล์เดียวกัน โฟลเดอร์เดียวกัน)
    2. แก้ไขค่า WIFI_SSID / WIFI_PASSWORD / MQTT_BROKER / MQTT_USER / MQTT_PASSWORD
       ให้เป็นค่าจริงจาก HiveMQ Cloud ของโรงเรียน
    3. ตั้งค่าเซิร์ฟเวอร์ (.env บน Plesk) ให้มีตัวแปร MQTT_BROKER, MQTT_PORT,
       MQTT_USER, MQTT_PASSWORD, MQTT_TOPIC_COMMAND, MQTT_TOPIC_STATUS
       ตรงกับค่าเดียวกันที่ใส่ใน secrets.h ของบอร์ด

  การเชื่อมต่อขาพิน (เหมือนรุ่น Serial ทุกประการ):
    - Servo SG90 ไม้กั้น     : GPIO 18 (สายสัญญาณสีส้ม/เหลือง)
    - LED สีเขียว (อนุญาตผ่าน) : GPIO 32
    - LED สีแดง (รอสแกน/ปิด)  : GPIO 33
    - Relay กลอน/ไม้กั้น (ถ้ามี): GPIO 26
    - ปุ่มกดฉุกเฉิน (ถ้ามี)     : GPIO 15 (Active LOW)
    - Ultrasonic Trig (ถ้ามี) : GPIO 5
    - Ultrasonic Echo (ถ้ามี) : GPIO 19
  ============================================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>
#include "secrets.h"

// ====================== กำหนดขาพิน ======================
#define PIN_SERVO        18
#define PIN_LED_GREEN    32
#define PIN_LED_RED      33
#define PIN_RELAY        26
#define PIN_BUTTON       15

#define PIN_TRIG         5
#define PIN_ECHO         19

Servo gateServo;
WiFiClientSecure secureClient;
WiFiClient plainClient;
PubSubClient mqttClient(MQTT_PORT == 8883 ? (Client&)secureClient : (Client&)plainClient);

// ตัวแปรสถานะ
bool isGateOpen = false;
unsigned long gateOpenTime = 0;
unsigned long gateHoldDuration = 30000;
String currentRequestId = "";

bool objectPassed = false;
unsigned long objectDetectTime = 0;

unsigned long lastReconnectAttempt = 0;
unsigned long lastHeartbeat = 0;

// ====================== ฟังก์ชันช่วยอ่านค่าจาก JSON แบบง่าย ======================
// (ไม่ใช้ไลบรารี ArduinoJson เพื่อลดภาระการติดตั้ง รองรับ JSON แบบ flat ตามที่เซิร์ฟเวอร์ส่งมา)
String extractJsonString(const String& json, const String& key) {
  String pattern = "\"" + key + "\"";
  int keyIdx = json.indexOf(pattern);
  if (keyIdx < 0) return "";
  int colonIdx = json.indexOf(':', keyIdx + pattern.length());
  if (colonIdx < 0) return "";
  int firstQuote = json.indexOf('"', colonIdx + 1);
  if (firstQuote < 0) return "";
  int secondQuote = json.indexOf('"', firstQuote + 1);
  if (secondQuote < 0) return "";
  return json.substring(firstQuote + 1, secondQuote);
}

long extractJsonInt(const String& json, const String& key, long defaultVal) {
  String pattern = "\"" + key + "\"";
  int keyIdx = json.indexOf(pattern);
  if (keyIdx < 0) return defaultVal;
  int colonIdx = json.indexOf(':', keyIdx + pattern.length());
  if (colonIdx < 0) return defaultVal;
  int start = colonIdx + 1;
  while (start < (int)json.length() && (json[start] == ' ')) start++;
  int end = start;
  while (end < (int)json.length() && (isDigit(json[end]) || json[end] == '-')) end++;
  if (end == start) return defaultVal;
  return json.substring(start, end).toInt();
}

// ====================== ฟังก์ชันวัดระยะ Ultrasonic (cm) ======================
long readUltrasonicCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duration == 0) return 999;
  return duration * 0.034 / 2;
}

// ====================== ส่งสถานะกลับไปเซิร์ฟเวอร์ผ่าน MQTT ======================
void publishStatus(const String& json) {
  if (mqttClient.connected()) {
    mqttClient.publish(TOPIC_STATUS, json.c_str());
    Serial.print("[MQTT OUT] ");
    Serial.println(json);
  }
}

// ====================== เปิด / ปิด ไม้กั้น ======================
void openGate(int durationSec, String reqId) {
  isGateOpen = true;
  gateOpenTime = millis();
  gateHoldDuration = (unsigned long)durationSec * 1000UL;
  currentRequestId = reqId;
  objectPassed = false;
  objectDetectTime = 0;

  gateServo.write(90);
  digitalWrite(PIN_RELAY, HIGH);
  digitalWrite(PIN_LED_GREEN, HIGH);
  digitalWrite(PIN_LED_RED, LOW);

  String payload = "{\"door\":\"OPEN\",\"status\":\"OK\",\"requestId\":\"" + currentRequestId + "\"}";
  publishStatus(payload);
}

void closeGate(const String& reason) {
  isGateOpen = false;

  gateServo.write(0);
  digitalWrite(PIN_RELAY, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);

  String payload = "{\"door\":\"CLOSED\",\"status\":\"OK\",\"reason\":\"" + reason + "\",\"requestId\":\"" + currentRequestId + "\"}";
  publishStatus(payload);

  currentRequestId = "";
}

// ====================== รับคำสั่งจากเซิร์ฟเวอร์ผ่าน MQTT ======================
void mqttCallback(char* topic, byte* payloadBytes, unsigned int length) {
  String payload;
  payload.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) payload += (char)payloadBytes[i];

  Serial.print("[MQTT IN] ");
  Serial.println(payload);

  String cmd = extractJsonString(payload, "cmd");
  if (cmd == "OPEN") {
    long duration = extractJsonInt(payload, "duration", 30);
    if (duration <= 0) duration = 30;
    String reqId = extractJsonString(payload, "requestId");
    openGate((int)duration, reqId);
  } else if (cmd == "CLOSE") {
    closeGate("MANUAL_CLOSE");
  }
}

// ====================== เชื่อมต่อ WiFi ======================
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
    Serial.print("[WiFi] เชื่อมต่อสำเร็จ IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("[WiFi] เชื่อมต่อไม่สำเร็จ จะลองใหม่ใน loop()");
  }
}

// ====================== เชื่อมต่อ MQTT Broker ======================
bool connectMqtt() {
  if (MQTT_PORT == 8883) {
    secureClient.setInsecure(); // ข้ามการตรวจสอบใบรับรอง (เหมาะกับ HiveMQ Cloud ฟรี)
  }

  String clientId = "ESP32Gate-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.print("[MQTT] กำลังเชื่อมต่อ ");
  Serial.println(MQTT_BROKER);

  if (mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD)) {
    Serial.println("[MQTT] เชื่อมต่อสำเร็จ!");
    mqttClient.subscribe(TOPIC_COMMAND);
    Serial.print("[MQTT] Subscribe: ");
    Serial.println(TOPIC_COMMAND);
    publishStatus("{\"status\":\"ONLINE\",\"device\":\"ESP32_GATE\"}");
    return true;
  }
  Serial.print("[MQTT] เชื่อมต่อไม่สำเร็จ rc=");
  Serial.println(mqttClient.state());
  return false;
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

  gateServo.setPeriodHertz(50);
  gateServo.attach(PIN_SERVO, 500, 2400);

  // เริ่มต้นที่สถานะปิด (ไม่ publish เพราะยังไม่เชื่อมต่อ MQTT)
  isGateOpen = false;
  gateServo.write(0);
  digitalWrite(PIN_RELAY, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, HIGH);

  connectWiFi();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  if (WiFi.status() == WL_CONNECTED) {
    connectMqtt();
  }

  Serial.println("[ESP32_READY] OnePass Gate Controller Ready (WiFi/MQTT)");
}

void loop() {
  // 1. รักษาการเชื่อมต่อ WiFi
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastReconnectAttempt > 10000) {
      lastReconnectAttempt = millis();
      connectWiFi();
    }
    return;
  }

  // 2. รักษาการเชื่อมต่อ MQTT
  if (!mqttClient.connected()) {
    if (millis() - lastReconnectAttempt > 5000) {
      lastReconnectAttempt = millis();
      connectMqtt();
    }
  } else {
    mqttClient.loop();

    // ส่ง heartbeat ทุก 30 วินาที ให้เว็บรู้ว่าบอร์ดยังออนไลน์
    if (millis() - lastHeartbeat > 30000) {
      lastHeartbeat = millis();
      publishStatus("{\"status\":\"ONLINE\",\"device\":\"ESP32_GATE\"}");
    }
  }

  // 3. ตรวจสอบปุ่มเปิดฉุกเฉิน (GPIO 15)
  if (digitalRead(PIN_BUTTON) == LOW) {
    delay(50);
    if (digitalRead(PIN_BUTTON) == LOW) {
      openGate(30, "EMERGENCY_BTN");
      while (digitalRead(PIN_BUTTON) == LOW);
    }
  }

  // 4. จัดการขณะไม้กั้นกำลังเปิดอยู่
  if (isGateOpen) {
    unsigned long elapsed = millis() - gateOpenTime;

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

    if (elapsed >= gateHoldDuration) {
      closeGate("TIMEOUT_30S");
      return;
    }
  }
}
