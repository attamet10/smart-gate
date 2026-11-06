import serial, time, sys
ser = serial.Serial("COM3", 115200, timeout=1)
end = time.time() + 12
buf = b""
while time.time() < end:
    chunk = ser.read(256)
    if chunk:
        buf += chunk
ser.close()
sys.stdout.buffer.write(buf)
