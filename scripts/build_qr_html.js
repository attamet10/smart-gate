const fs = require('fs');
const QRCode = require('qrcode');

async function build() {
  const demoDataUrl = await QRCode.toDataURL('OP-DEMO-2026', {
    width: 380,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M'
  });

  const passDataUrl = await QRCode.toDataURL('OP-6823EF982309', {
    width: 380,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M'
  });

  const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OnePass QR - สำหรับกล้องสแกนเนอร์</title>
  <style>
    * { box-sizing: border-box; }
    body {
      background: #ffffff;
      color: #000000;
      font-family: Arial, Tahoma, sans-serif;
      margin: 0;
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    h1 {
      margin: 0 0 4px 0;
      font-size: 24px;
      color: #0f172a;
      text-align: center;
    }
    p.sub {
      margin: 0 0 20px 0;
      color: #475569;
      font-size: 15px;
      text-align: center;
    }
    .grid {
      display: flex;
      flex-wrap: wrap;
      gap: 30px;
      justify-content: center;
      width: 100%;
      max-width: 900px;
    }
    .card {
      background: #ffffff;
      border: 3px solid #0284c7;
      border-radius: 16px;
      padding: 20px;
      text-align: center;
      width: 420px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.08);
    }
    .badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 15px;
      margin-bottom: 10px;
      background: #0284c7;
      color: #ffffff;
    }
    .badge-pass {
      background: #16a34a;
      color: #ffffff;
    }
    .token-text {
      font-family: monospace;
      font-size: 20px;
      font-weight: bold;
      color: #0f172a;
      background: #f1f5f9;
      padding: 8px 12px;
      border-radius: 8px;
      margin: 10px 0;
      letter-spacing: 2px;
    }
    .qr-container {
      background: #ffffff;
      padding: 10px;
      display: inline-block;
      margin: 8px 0;
    }
    img.qr-img {
      display: block;
      width: 320px;
      height: 320px;
      image-rendering: pixelated;
    }
    .instructions {
      color: #334155;
      font-size: 14px;
      line-height: 1.5;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>OnePass Smart Gate - บัตรผ่านสำหรับแข่งขัน</h1>
  <p class="sub">จ่อกล้องสแกนเนอร์ที่ QR Code ด้านล่างนี้ (ระยะ 10 - 20 ซม.)</p>

  <div class="grid">
    <!-- DEMO PASS -->
    <div class="card">
      <div class="badge">⭐ บัตรสาธิต / แข่งขัน (แนะนำ)</div>
      <div class="token-text">OP-DEMO-2026</div>
      <div class="qr-container">
        <img class="qr-img" src="${demoDataUrl}" alt="QR OP-DEMO-2026">
      </div>
      <div class="instructions">
        ✅ สแกนผ่าน 100% ตลอดเวลา<br>
        ✅ ไม่หมดอายุ สแกนได้ไม่จำกัดรอบ
      </div>
    </div>

    <!-- STUDENT PASS -->
    <div class="card" style="border-color: #16a34a;">
      <div class="badge badge-pass">คำขอนักเรียนจริง #8</div>
      <div class="token-text">OP-6823EF982309</div>
      <div class="qr-container">
        <img class="qr-img" src="${passDataUrl}" alt="QR OP-6823EF982309">
      </div>
      <div class="instructions">
        คำขอ OP-20261109-0008 (อนุมัติแล้ว)<br>
        บันทึกเวลาจริง และออโต้รีเซ็ตทุกรอบ
      </div>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync('test_qr.html', html, 'utf8');
  fs.writeFileSync('public/test-qr.html', html, 'utf8');
  console.log('Successfully generated offline test_qr.html');
}

build().catch(err => console.error(err));
