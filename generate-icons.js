const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation for PNG chunks
function makeCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}
const crcTable = makeCrcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

function createOnePassIconPng(size, isMaskable = false) {
  const width = size;
  const height = size;

  // Raw RGBA pixel buffer: (width * 4 + 1) per row for filter byte (0)
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const cx = width / 2;
  const cy = height / 2;
  const outerRadius = isMaskable ? width * 0.5 : width * 0.46;
  const cornerR = width * 0.22;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Base rounded rectangle check
      let inCard = false;
      if (isMaskable) {
        inCard = true;
      } else {
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);
        const halfBox = width * 0.44;
        const cornerDist = halfBox - cornerR;
        if (dx <= halfBox && dy <= halfBox) {
          if (dx <= cornerDist || dy <= cornerDist) {
            inCard = true;
          } else {
            const rx = dx - cornerDist;
            const ry = dy - cornerDist;
            if (rx * rx + ry * ry <= cornerR * cornerR) {
              inCard = true;
            }
          }
        }
      }

      if (!inCard) {
        rawData[pxOffset] = 0;
        rawData[pxOffset + 1] = 0;
        rawData[pxOffset + 2] = 0;
        rawData[pxOffset + 3] = 0;
        continue;
      }

      // Gradient background from Royal Blue #0d55cf to Navy Indigo #082f7c
      const gradRatio = (x + y) / (width + height);
      let r = Math.round(13 * (1 - gradRatio) + 8 * gradRatio);
      let g = Math.round(85 * (1 - gradRatio) + 47 * gradRatio);
      let b = Math.round(207 * (1 - gradRatio) + 124 * gradRatio);

      // Draw Door Icon / Arch Gate in white
      // Door outer frame: center x in [cx - 0.22*width, cx + 0.22*width], y in [cy - 0.25*height, cy + 0.28*height]
      const doorLeft = cx - width * 0.20;
      const doorRight = cx + width * 0.20;
      const doorTop = cy - height * 0.24;
      const doorBottom = cy + height * 0.25;
      const frameThick = width * 0.055;

      // Outer arch
      const isArch = (x >= doorLeft && x <= doorRight && y >= doorTop && y <= doorBottom);
      // Inner arch cutout
      const isInner = (x >= doorLeft + frameThick && x <= doorRight - frameThick && y >= doorTop + frameThick && y <= doorBottom);

      // Door panel swung open (3D perspective slant)
      // Slanted quad from (doorLeft + frameThick, doorTop + frameThick) to swinging out
      const swingX1 = doorLeft + frameThick * 0.8;
      const swingX2 = cx + width * 0.06;
      const swingY1 = doorTop + frameThick * 0.8;
      const swingY2 = doorBottom;

      const inDoorSwing = (x >= swingX1 && x <= swingX2 && y >= swingY1 && y <= swingY2);

      // Handle dot on swinging door
      const knobX = swingX2 - width * 0.035;
      const knobY = cy + height * 0.04;
      const inKnob = ((x - knobX) * (x - knobX) + (y - knobY) * (y - knobY) <= (width * 0.02) * (width * 0.02));

      if (inKnob) {
        r = 250; g = 204; b = 21; // Golden yellow knob
      } else if (inDoorSwing) {
        r = 240; g = 246; b = 255; // White door
      } else if (isArch && !isInner) {
        r = 255; g = 255; b = 255; // White frame
      } else if (isInner) {
        // Dark door opening inside
        r = 8; g = 38; b = 100;
      }

      // Add a subtle white inner glow near top edge
      if (y < height * 0.15 && inCard) {
        r = Math.min(255, r + 30);
        g = Math.min(255, g + 30);
        b = Math.min(255, b + 30);
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = 255;
    }
  }

  // PNG Signature
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate compression
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace: None
  const ihdrChunk = makePngChunk('IHDR', ihdr);

  // IDAT chunk
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makePngChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngSig, ihdrChunk, idatChunk, iendChunk]);
}

const pubDir = path.join(__dirname, 'public');
fs.writeFileSync(path.join(pubDir, 'icon-192.png'), createOnePassIconPng(192, false));
fs.writeFileSync(path.join(pubDir, 'icon-512.png'), createOnePassIconPng(512, false));
fs.writeFileSync(path.join(pubDir, 'icon-maskable.png'), createOnePassIconPng(512, true));
fs.writeFileSync(path.join(pubDir, 'apple-touch-icon.png'), createOnePassIconPng(180, false));
fs.writeFileSync(path.join(pubDir, 'favicon.ico'), createOnePassIconPng(64, false));

console.log('✅ Generated crisp PWA PNG icons in public/ successfully!');
