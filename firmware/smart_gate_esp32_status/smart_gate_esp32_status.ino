/*
  ============================================================================
  SMART GATE ESP32 - LIVE STATUS DASHBOARD (หน้าเว็บแสดงสถานะการเชื่อมต่ออุปกรณ์)
  บอร์ด: ESP32 Dev Module

  ทำอะไร:
    - เชื่อม WiFi แล้วเปิดเว็บเซิร์ฟเวอร์เล็กๆ ในตัวบอร์ดเอง (ไม่ต้องพึ่งเซิร์ฟเวอร์อื่น)
    - ทดสอบอุปกรณ์แต่ละชิ้นซ้ำทุก 3 วินาทีอัตโนมัติ
    - เปิดเบราว์เซอร์ไปที่ IP ของบอร์ด (ดูได้จาก Serial Monitor ตอนบูต) จะเห็นหน้าเว็บ
      แสดงสถานะ อัปเดตเองทุก 3 วินาทีโดยไม่ต้องรีเฟรชหน้าเอง

  ข้อจำกัดที่ควรรู้ (สำคัญ อ่านก่อนเชื่อผลตรงๆ):
    - WiFi และ เซนเซอร์ Ultrasonic ตรวจสอบการเชื่อมต่อได้แม่นยำจริง (มีสัญญาณยืนยัน)
    - Servo / LED / Relay / ปุ่มฉุกเฉิน เป็นขาที่ไม่มีสายป้อนกลับเข้าบอร์ด ซอฟต์แวร์
      ยืนยัน "ต่อจริงไหม" ไม่ได้ 100% จะขึ้นเป็น "สั่งงานแล้ว" แทน ต้องดูด้วยตา/หูเอง

  ก่อนอัปโหลด:
    1. ใช้ secrets.h เดิมที่มี WIFI_SSID / WIFI_PASSWORD อยู่แล้วได้เลย
    2. เปิด Serial Monitor (115200) หลังอัปโหลดเสร็จ จะเห็น IP Address ของบอร์ด
       เอา IP นั้นไปเปิดในเบราว์เซอร์ (มือถือ/คอมที่ต่อ WiFi วงเดียวกัน)
  ============================================================================
*/

#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include "secrets.h"

#define PIN_SERVO        18
// กำหนดองศา Servo ไม้กั้น (ปรับทิศทางตามการติดตั้งจริง: 0° = ยกขึ้นเปิดทาง, 90° = ยกลงปิดทาง)
#define SERVO_ANGLE_OPEN    0     // ยกไม้กั้นขึ้น (เปิดทาง)
#define SERVO_ANGLE_CLOSE   90    // ลดไม้กั้นลง (ปิดกั้นทาง)
#define PIN_LED_GREEN    32
#define PIN_LED_RED      33
#define PIN_RELAY        26
#define PIN_BUTTON       15
#define PIN_TRIG         5
#define PIN_ECHO         19

Servo gateServo;
WebServer server(80);

bool wifiConnected = false;
bool ultrasonicConnected = false;
long ultrasonicDistance = -1;
bool buttonPressed = false;
bool outputCycleState = false; // สลับ true/false ทุกรอบเพื่อสั่งงาน Servo/LED/Relay ให้เห็นการขยับ

unsigned long lastTestCycle = 0;
const unsigned long TEST_INTERVAL_MS = 3000;

long readUltrasonicCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duration == 0) return -1;
  return duration * 0.034 / 2;
}

void runTestCycle() {
  wifiConnected = (WiFi.status() == WL_CONNECTED);

  long d = readUltrasonicCm();
  ultrasonicConnected = (d > 0);
  ultrasonicDistance = d;

  buttonPressed = (digitalRead(PIN_BUTTON) == LOW);

  outputCycleState = !outputCycleState;
  gateServo.write(outputCycleState ? SERVO_ANGLE_OPEN : SERVO_ANGLE_CLOSE);
  digitalWrite(PIN_LED_GREEN, outputCycleState ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, outputCycleState ? LOW : HIGH);
  digitalWrite(PIN_RELAY, outputCycleState ? HIGH : LOW);
}

String statusBadge(bool ok) {
  return ok ? "เชื่อมต่อสำเร็จ" : "ไม่ได้เชื่อมต่อ";
}

void handleStatusJson() {
  String json = "{";
  json += "\"wifi\":" + String(wifiConnected ? "true" : "false") + ",";
  json += "\"wifi_ip\":\"" + (wifiConnected ? WiFi.localIP().toString() : String("-")) + "\",";
  json += "\"ultrasonic\":" + String(ultrasonicConnected ? "true" : "false") + ",";
  json += "\"ultrasonic_distance\":" + String(ultrasonicDistance) + ",";
  json += "\"button_pressed\":" + String(buttonPressed ? "true" : "false") + ",";
  json += "\"output_cycle\":" + String(outputCycleState ? "true" : "false") + ",";
  json += "\"uptime_ms\":" + String(millis());
  json += "}";

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", json);
}

void handleRoot() {
  String html = R"HTML(
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OnePass Smart Gate - สถานะอุปกรณ์</title>
<style>
  :root { --navy:#1e3a8a; --navy-dark:#172554; --ok:#16a34a; --bad:#dc2626; --bg:#f1f5f9; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, 'Segoe UI', Tahoma, sans-serif; background:var(--bg); color:#0f172a; }
  header { background:linear-gradient(135deg, var(--navy), var(--navy-dark)); color:#fff; padding:20px 16px; text-align:center; }
  header h1 { margin:0; font-size:1.3rem; }
  header p { margin:4px 0 0; font-size:0.85rem; opacity:0.85; }
  .wrap { max-width:520px; margin:0 auto; padding:16px; }
  .card { background:#fff; border-radius:12px; padding:14px 16px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .card .name { font-weight:600; font-size:1rem; }
  .card .detail { font-size:0.78rem; color:#64748b; margin-top:2px; }
  .badge { padding:6px 14px; border-radius:999px; font-size:0.85rem; font-weight:700; color:#fff; white-space:nowrap; }
  .badge.ok { background:var(--ok); }
  .badge.bad { background:var(--bad); }
  .meta { text-align:center; font-size:0.78rem; color:#64748b; margin-top:10px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ok); margin-right:6px; animation:pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
</style>
</head>
<body>
<header>
  <h1>🔧 OnePass Smart Gate</h1>
  <p>สถานะการเชื่อมต่ออุปกรณ์แบบเรียลไทม์ · อัปเดตทุก 3 วินาที</p>
</header>
<div class="wrap">
  <div class="card">
    <div><div class="name">📶 WiFi</div><div class="detail" id="wifi-detail">-</div></div>
    <div class="badge" id="wifi-badge">...</div>
  </div>
  <div class="card">
    <div><div class="name">📏 เซนเซอร์ Ultrasonic</div><div class="detail" id="us-detail">-</div></div>
    <div class="badge" id="us-badge">...</div>
  </div>
  <div class="card">
    <div><div class="name">⚙️ Servo ไม้กั้น</div><div class="detail">สั่งงานทุกรอบ (ดูด้วยตา)</div></div>
    <div class="badge ok" id="servo-badge">สั่งงานแล้ว</div>
  </div>
  <div class="card">
    <div><div class="name">💡 LED เขียว/แดง</div><div class="detail">สลับไฟทุกรอบ (ดูด้วยตา)</div></div>
    <div class="badge ok">สั่งงานแล้ว</div>
  </div>
  <div class="card">
    <div><div class="name">🔌 Relay</div><div class="detail">สั่งงานทุกรอบ (ฟังเสียงคลิก)</div></div>
    <div class="badge ok">สั่งงานแล้ว</div>
  </div>
  <div class="card">
    <div><div class="name">🔘 ปุ่มฉุกเฉิน</div><div class="detail" id="btn-detail">-</div></div>
    <div class="badge" id="btn-badge">...</div>
  </div>
  <div class="meta"><span class="dot"></span>เชื่อมต่อกับบอร์ดอยู่ · อัปเดตล่าสุดเมื่อ <span id="last-update">-</span></div>
</div>

<script>
function badge(el, ok) {
  el.textContent = ok ? "เชื่อมต่อสำเร็จ" : "ไม่ได้เชื่อมต่อ";
  el.className = "badge " + (ok ? "ok" : "bad");
}

function refresh() {
  fetch("/status").then(r => r.json()).then(d => {
    badge(document.getElementById("wifi-badge"), d.wifi);
    document.getElementById("wifi-detail").textContent = d.wifi ? ("IP: " + d.wifi_ip) : "ไม่พบสัญญาณ WiFi";

    badge(document.getElementById("us-badge"), d.ultrasonic);
    document.getElementById("us-detail").textContent = d.ultrasonic ? ("ระยะ ~" + d.ultrasonic_distance + " ซม.") : "ไม่มีสัญญาณตอบกลับ";

    document.getElementById("btn-badge").textContent = d.button_pressed ? "กำลังกดอยู่" : "ว่าง (ปกติ)";
    document.getElementById("btn-badge").className = "badge ok";
    document.getElementById("btn-detail").textContent = d.button_pressed ? "ตรวจพบการกดปุ่ม" : "ไม่ได้กดอยู่ (สถานะปกติ)";

    document.getElementById("last-update").textContent = new Date().toLocaleTimeString("th-TH");
  }).catch(() => {
    document.getElementById("last-update").textContent = "เชื่อมต่อบอร์ดไม่ได้";
  });
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
)HTML";

  server.send(200, "text/html", html);
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
  gateServo.write(SERVO_ANGLE_CLOSE);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] กำลังเชื่อมต่อ ");
  Serial.println(WIFI_SSID);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 20000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("✅ WiFi เชื่อมต่อสำเร็จ! เปิดเบราว์เซอร์ไปที่: http://");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("❌ WiFi เชื่อมต่อไม่สำเร็จ (เช็ค secrets.h) จะลองใหม่เรื่อยๆ");
  }

  server.on("/", handleRoot);
  server.on("/status", handleStatusJson);
  server.begin();
  Serial.println("🌐 เว็บเซิร์ฟเวอร์พร้อมใช้งานที่พอร์ต 80");
}

void loop() {
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
  }

  if (millis() - lastTestCycle >= TEST_INTERVAL_MS) {
    lastTestCycle = millis();
    runTestCycle();
  }
}
