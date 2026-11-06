/*
  โค้ดทดสอบง่ายที่สุด: สั่งให้ LED สีแดง (GPIO 33) ติดสว่างค้างตลอดเวลา
  ไม่มี WiFi ไม่มีอย่างอื่นปนเลย เพื่อแยกปัญหาเฉพาะจุดเดียว
*/

#define PIN_LED_RED 33

void setup() {
  pinMode(PIN_LED_RED, OUTPUT);
  digitalWrite(PIN_LED_RED, HIGH);
}

void loop() {
  // ไม่ต้องทำอะไร ปล่อยให้ไฟติดค้างตลอด
}
