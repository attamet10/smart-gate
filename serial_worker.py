import sys
import time
import serial
import serial.tools.list_ports
import threading

def find_esp32_port():
    for p in serial.tools.list_ports.comports():
        desc = (p.description or '').lower()
        hwid = (p.hwid or '').lower()
        if any(k in desc or k in hwid for k in ['cp210', 'ch340', 'ftdi', 'usb-serial', 'silicon labs']):
            return p.device
    # Check default COM5
    for p in serial.tools.list_ports.comports():
        if p.device.upper() == 'COM5':
            return 'COM5'
    return None

ser = None

def serial_reader():
    global ser
    while True:
        if ser and ser.is_open:
            try:
                line = ser.readline().decode('utf-8', errors='ignore').strip()
                if line:
                    sys.stdout.write(f"[SERIAL] {line}\n")
                    sys.stdout.flush()
            except Exception as e:
                sys.stdout.write(f"[SERIAL_ERR] {e}\n")
                sys.stdout.flush()
                try:
                    ser.close()
                except:
                    pass
                ser = None
        else:
            port = find_esp32_port()
            if port:
                try:
                    ser = serial.Serial(port, 115200, timeout=1)
                    time.sleep(1.5)
                    sys.stdout.write(f"[SERIAL_CONNECTED] {port}\n")
                    sys.stdout.flush()
                except Exception as e:
                    time.sleep(2)
            else:
                time.sleep(2)

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')

    t = threading.Thread(target=serial_reader, daemon=True)
    t.start()

    sys.stdout.write("[WORKER_READY]\n")
    sys.stdout.flush()

    for line in sys.stdin:
        cmd = line.strip()
        if not cmd:
            continue
        if ser and ser.is_open:
            try:
                ser.write((cmd + '\n').encode('utf-8'))
                ser.flush()
                sys.stdout.write(f"[SENT] {cmd}\n")
                sys.stdout.flush()
            except Exception as e:
                sys.stdout.write(f"[SEND_ERR] {e}\n")
                sys.stdout.flush()
        else:
            sys.stdout.write(f"[NOT_CONNECTED] Cannot send: {cmd}\n")
            sys.stdout.flush()

if __name__ == '__main__':
    main()
