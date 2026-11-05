// ============================================================================
// KIOSK PAGE JAVASCRIPT (ตู้สแกนป้อมยามหน้าประตู)
// ============================================================================

let html5Scanner = null;

document.addEventListener('DOMContentLoaded', () => {
  // เริ่มต้นกล้อง
  initScanner();

  // Polling สถานะฮาร์ดแวร์ ESP32 ทุก 1 วินาที
  setInterval(pollHardware, 1000);

  // โหลดประวัติสแกน
  loadKioskLogs();

  // นาฬิกา
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const clockEl = document.getElementById('kiosk-clock');
    const oledTime = document.getElementById('oled-live-time');
    if (clockEl) clockEl.innerText = timeStr;
    if (oledTime) oledTime.innerText = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }, 1000);
});

function initScanner() {
  if (html5Scanner) return;
  try {
    html5Scanner = new Html5QrcodeScanner("kiosk-full-scanner", {
      fps: 15,
      qrbox: { width: 220, height: 220 }
    });
    html5Scanner.render(onScanSuccess, () => {});
  } catch (err) {
    console.warn('Scanner init:', err);
  }
}

async function onScanSuccess(decodedText) {
  await processScan(decodedText);
}

async function submitKioskScan() {
  const input = document.getElementById('manual-kiosk-token');
  const token = input ? input.value.trim() : '';
  if (!token) return alert('กรุณาระบุรหัส QR');
  await processScan(token);
}

async function processScan(token) {
  const feedback = document.getElementById('kiosk-feedback-box');
  feedback.classList.remove('hidden');

  try {
    const res = await fetch('/api/gate/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, scanType: 'exit' })
    });
    const data = await res.json();

    if (data.success) {
      feedback.className = 'p-5 rounded-2xl bg-emerald-950 border-2 border-emerald-500 text-emerald-200 block animate-bounce shadow-xl';
      feedback.innerHTML = `
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-full ${data.isNoReturn ? 'bg-amber-500' : 'bg-emerald-500'} text-white flex items-center justify-center text-2xl shadow-lg shrink-0">
            <i class="fa-solid ${data.isNoReturn ? 'fa-house-chimney-user' : 'fa-circle-check'}"></i>
          </div>
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-bold text-lg text-white">${data.message}</h3>
              ${data.isNoReturn ? '<span class="px-2 py-0.5 rounded-md bg-amber-500 text-white text-xs font-bold">ลากลับบ้าน</span>' : ''}
            </div>
            <p class="text-sm text-emerald-300">นักเรียน: <strong>${data.student.name}</strong> (${data.student.code}) • ${data.student.classroom}</p>
            <p class="text-xs text-emerald-400 mt-1">${data.notice || 'กลอนปลดล็อกแล้ว 5 วินาที • เชิญผ่านประตูได้'}</p>
          </div>
        </div>
      `;
    } else {
      feedback.className = 'p-5 rounded-2xl bg-rose-950 border-2 border-rose-500 text-rose-200 block shadow-xl';
      feedback.innerHTML = `
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-full bg-rose-500 text-white flex items-center justify-center text-2xl shadow-lg shrink-0">
            <i class="fa-solid fa-circle-xmark"></i>
          </div>
          <div>
            <h3 class="font-bold text-lg text-white">ไม่อนุญาตให้ผ่านประตู</h3>
            <p class="text-sm text-rose-300">${data.reason}</p>
          </div>
        </div>
      `;
    }

    await loadKioskLogs();
  } catch (err) {
    feedback.className = 'p-4 rounded-xl bg-rose-950 text-white block';
    feedback.innerText = 'เชื่อมต่อเซิร์ฟเวอร์ล้มเหลว';
  }
}

async function pollHardware() {
  try {
    const res = await fetch('/api/gate/status');
    const data = await res.json();
    const sim = data.simulator;

    // อัปเดตสถานะบอร์ด ESP32 บน Kiosk (Online/Offline + ACK)
    const kioskGateBadge = document.getElementById('kiosk-gate-badge');
    const kioskGateDot = document.getElementById('kiosk-gate-dot');
    const kioskGateText = document.getElementById('kiosk-gate-text');
    const kioskLastAckText = document.getElementById('kiosk-last-ack-text');

    if (data.gate) {
      if (data.gate.online) {
        if (kioskGateBadge) kioskGateBadge.className = 'text-xs font-semibold px-3 py-1 rounded-xl border bg-emerald-950/80 text-emerald-300 border-emerald-800 flex items-center gap-2';
        if (kioskGateDot) kioskGateDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399]';
        if (kioskGateText) kioskGateText.innerText = `ไม้กั้นออนไลน์ (${data.gate.connectionType || 'ESP32'})`;
      } else {
        if (kioskGateBadge) kioskGateBadge.className = 'text-xs font-semibold px-3 py-1 rounded-xl border bg-rose-950/80 text-rose-300 border-rose-800 flex items-center gap-2';
        if (kioskGateDot) kioskGateDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        if (kioskGateText) kioskGateText.innerText = 'ไม้กั้นออฟไลน์';
      }

      if (kioskLastAckText) {
        if (data.gate.lastAck) {
          const t = new Date(data.gate.lastAck.timestamp).toLocaleTimeString('th-TH');
          kioskLastAckText.innerText = `✅ [ACK ${t}] ${data.gate.lastAck.status}`;
          kioskLastAckText.className = 'text-emerald-400 font-mono bg-emerald-950/50 px-2.5 py-1 rounded-lg border border-emerald-800 text-[11px] truncate max-w-[210px]';
          kioskLastAckText.title = data.gate.lastAck.details || '';
        } else {
          kioskLastAckText.innerText = 'รอรับสัญญาณ...';
          kioskLastAckText.className = 'text-slate-300 font-mono bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 text-[11px] truncate max-w-[210px]';
        }
      }
    }

    const oledStatus = document.getElementById('kiosk-oled-status');
    const oledSub = document.getElementById('kiosk-oled-subtext');
    const relayIcon = document.getElementById('kiosk-relay-icon');
    const relayText = document.getElementById('kiosk-relay-text');
    const ledGreen = document.getElementById('kiosk-led-green');
    const ledRed = document.getElementById('kiosk-led-red');
    const ledText = document.getElementById('kiosk-led-text');

    if (sim.door === 'OPEN') {
      oledStatus.innerText = '>> OPEN <<';
      oledStatus.className = 'text-2xl font-bold tracking-widest text-emerald-300 animate-pulse';
      oledSub.innerText = sim.studentName ? `PASS: ${sim.studentName}` : 'DOOR OPEN (5s)';

      relayIcon.className = 'w-10 h-10 rounded-full bg-emerald-600 text-white flex items-center justify-center mx-auto my-1.5 shadow-[0_0_15px_#10b981]';
      relayIcon.innerHTML = '<i class="fa-solid fa-lock-open text-base"></i>';
      relayText.innerText = 'ปลดล็อก (OPEN)';
      relayText.className = 'text-xs font-bold text-emerald-400';

      ledGreen.className = 'w-4 h-4 rounded-full bg-emerald-400 shadow-[0_0_12px_#10b981] border border-emerald-300';
      ledRed.className = 'w-4 h-4 rounded-full bg-rose-950 border border-rose-900';
      ledText.innerText = 'ไฟเขียวติด (ผ่าน)';
      ledText.className = 'text-xs text-emerald-400 font-bold';
    } else {
      oledStatus.innerText = '== CLOSED ==';
      oledStatus.className = 'text-2xl font-bold tracking-widest text-white';
      oledSub.innerText = 'Ready to scan QR';

      relayIcon.className = 'w-10 h-10 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center mx-auto my-1.5';
      relayIcon.innerHTML = '<i class="fa-solid fa-lock text-base"></i>';
      relayText.innerText = 'ล็อกอยู่ (LOCKED)';
      relayText.className = 'text-xs font-bold text-slate-400';

      ledGreen.className = 'w-4 h-4 rounded-full bg-emerald-950 border border-emerald-900';
      ledRed.className = 'w-4 h-4 rounded-full bg-rose-500 shadow-[0_0_10px_#f43f5e] border border-rose-400';
      ledText.innerText = 'ไฟแดงติด (ประตูปิด)';
      ledText.className = 'text-xs text-rose-400 font-bold';
    }
  } catch (err) {}
}

async function triggerManualGate(seconds = 5) {
  try {
    await fetch('/api/gate/manual-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: seconds, reason: 'MANUAL_BUTTON' })
    });
    await loadKioskLogs();
  } catch (err) {
    alert(err.message);
  }
}

async function loadKioskLogs() {
  try {
    const res = await fetch('/api/gate/logs');
    const data = await res.json();
    const container = document.getElementById('kiosk-logs-container');

    if (!data.logs || data.logs.length === 0) {
      container.innerHTML = '<div class="text-slate-500 text-center py-2">ยังไม่มีประวัติการสแกน</div>';
      return;
    }

    container.innerHTML = data.logs.slice(0, 5).map(l => `
      <div class="flex items-center justify-between p-2.5 rounded-xl ${l.result === 'success' ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800' : 'bg-rose-950/60 text-rose-300 border border-rose-800'}">
        <div>
          <span class="font-bold text-white">${l.student_name || l.studentName || 'นักเรียน'}</span>
          <p class="text-[10px] text-slate-400">${l.message}</p>
        </div>
        <span class="text-[10px] font-mono text-slate-400">${new Date(l.scanned_at || l.scannedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    `).join('');
  } catch (err) {}
}
