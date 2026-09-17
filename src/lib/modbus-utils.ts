import type {
  ByteOrder32,
  ByteOrder64,
  DataDisplayFormat,
  RegisterData,
} from './modbus-types';

/**
 * Reorder bytes according to byte order specification
 * For 32-bit: 4 bytes (2 registers)
 * For 64-bit: 8 bytes (4 registers)
 */
export function reorderBytes(bytes: number[], order: ByteOrder32 | ByteOrder64): number[] {
  const orderMap: Record<string, number[]> = {
    'ABCD': [0, 1, 2, 3],
    'DCBA': [3, 2, 1, 0],
    'BADC': [1, 0, 3, 2],
    'CDAB': [2, 3, 0, 1],
    'ABCDEFGH': [0, 1, 2, 3, 4, 5, 6, 7],
    'HGFEDCBA': [7, 6, 5, 4, 3, 2, 1, 0],
    'BADCFEHG': [1, 0, 3, 2, 5, 4, 7, 6],
    'GHEFCDAB': [6, 7, 4, 5, 2, 3, 0, 1],
  };

  const indices = orderMap[order];
  if (!indices) return bytes;
  return indices.map(i => bytes[i] ?? 0);
}

/**
 * 逆字节序重排：将「逻辑顺序」字节恢复为「原始寄存器顺序」字节。
 * 是 reorderBytes 的逆变换。
 */
export function reorderBytesInv(bytes: number[], order: ByteOrder32 | ByteOrder64): number[] {
  const orderMap: Record<string, number[]> = {
    'ABCD': [0, 1, 2, 3],
    'DCBA': [3, 2, 1, 0],
    'BADC': [1, 0, 3, 2],
    'CDAB': [2, 3, 0, 1],
    'ABCDEFGH': [0, 1, 2, 3, 4, 5, 6, 7],
    'HGFEDCBA': [7, 6, 5, 4, 3, 2, 1, 0],
    'BADCFEHG': [1, 0, 3, 2, 5, 4, 7, 6],
    'GHEFCDAB': [6, 7, 4, 5, 2, 3, 0, 1],
  };
  const indices = orderMap[order] ?? [];
  const out = new Array<number>(bytes.length).fill(0);
  indices.forEach((src, i) => {
    out[src] = bytes[i] ?? 0;
  });
  return out;
}

/**
 * Convert register values to bytes array
 */
export function registersToBytes(registers: number[]): number[] {
  const bytes: number[] = [];
  for (const reg of registers) {
    bytes.push((reg >> 8) & 0xff); // high byte
    bytes.push(reg & 0xff);         // low byte
  }
  return bytes;
}

/**
 * Convert bytes to 16-bit unsigned integer
 */
export function bytesToUShort(bytes: number[]): number {
  return ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
}

/**
 * Convert bytes to 16-bit signed integer
 */
export function bytesToShort(bytes: number[]): number {
  const val = bytesToUShort(bytes);
  return val > 0x7fff ? val - 0x10000 : val;
}

/**
 * Convert bytes to 32-bit unsigned integer
 */
export function bytesToULong(bytes: number[]): number {
  return (
    ((bytes[0] ?? 0) << 24) |
    ((bytes[1] ?? 0) << 16) |
    ((bytes[2] ?? 0) << 8) |
    ((bytes[3] ?? 0) >>> 0)
  ) >>> 0;
}

/**
 * Convert bytes to 32-bit signed integer
 */
export function bytesToLong(bytes: number[]): number {
  const val = bytesToULong(bytes);
  return val > 0x7fffffff ? val - 0x100000000 : val;
}

/**
 * Convert bytes to 32-bit float
 */
export function bytesToFloat(bytes: number[]): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) {
    view.setUint8(i, bytes[i] ?? 0);
  }
  return view.getFloat32(0, false);
}

/**
 * Convert bytes to 64-bit double
 */
export function bytesToDouble(bytes: number[]): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint8(i, bytes[i] ?? 0);
  }
  return view.getFloat64(0, false);
}

/**
 * Convert short value to bytes
 */
export function shortToBytes(value: number): number[] {
  const clamped = value & 0xffff;
  return [(clamped >> 8) & 0xff, clamped & 0xff];
}

/**
 * Convert long value to bytes
 */
export function longToBytes(value: number): number[] {
  const clamped = value >>> 0;
  return [
    (clamped >> 24) & 0xff,
    (clamped >> 16) & 0xff,
    (clamped >> 8) & 0xff,
    clamped & 0xff,
  ];
}

/**
 * Convert float value to bytes
 */
export function floatToBytes(value: number): number[] {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  return [
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  ];
}

/**
 * Convert double value to bytes
 */
export function doubleToBytes(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    bytes.push(view.getUint8(i));
  }
  return bytes;
}

/**
 * Format register value according to display format
 */
export function formatRegisterValue(
  registers: number[],
  format: DataDisplayFormat,
  byteOrder32: ByteOrder32,
  byteOrder64: ByteOrder64,
): string {
  switch (format) {
    case 'led':
      return (registers[0] ?? 0) !== 0 ? 'ON' : 'OFF';
    case 'short':
      return String(bytesToShort(registersToBytes(registers.slice(0, 1))));
    case 'ushort':
      return String(bytesToUShort(registersToBytes(registers.slice(0, 1))));
    case 'hex':
      return `0x${(bytesToUShort(registersToBytes(registers.slice(0, 1)))).toString(16).toUpperCase().padStart(4, '0')}`;
    case 'binary': {
      const val = bytesToUShort(registersToBytes(registers.slice(0, 1)));
      return val.toString(2).padStart(16, '0');
    }
    case 'long': {
      const bytes = registersToBytes(registers.slice(0, 2));
      const reordered = reorderBytes(bytes, byteOrder32);
      return String(bytesToLong(reordered));
    }
    case 'ulong': {
      const bytes = registersToBytes(registers.slice(0, 2));
      const reordered = reorderBytes(bytes, byteOrder32);
      return String(bytesToULong(reordered));
    }
    case 'float': {
      const bytes = registersToBytes(registers.slice(0, 2));
      const reordered = reorderBytes(bytes, byteOrder32);
      return bytesToFloat(reordered).toFixed(4);
    }
    case 'double': {
      const bytes = registersToBytes(registers.slice(0, 4));
      const reordered = reorderBytes(bytes, byteOrder64);
      return bytesToDouble(reordered).toFixed(6);
    }
    default:
      return String(registers[0] ?? 0);
  }
}

/**
 * Get the number of registers occupied by a display format
 */
export function getFormatRegisterCount(format: DataDisplayFormat): number {
  switch (format) {
    case 'led':
    case 'short':
    case 'ushort':
    case 'hex':
    case 'binary':
      return 1;
    case 'long':
    case 'ulong':
    case 'float':
      return 2;
    case 'double':
      return 4;
    default:
      return 1;
  }
}

/**
 * Generate a random ID string
 */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

/**
 * Convert bytes array to hex string
 */
export function bytesToHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * Convert hex string to bytes array
 */
export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/\s/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

// ── CRC-16 (Modbus RTU) ──

const CRC16_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x0001 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    table.push(crc & 0xffff);
  }
  return table;
})();

/**
 * Calculate Modbus CRC16 (RTU checksum)
 * Returns two bytes: [lowByte, highByte] (little-endian)
 */
export function crc16(bytes: number[]): [number, number] {
  let crc = 0xffff;
  for (const b of bytes) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ b) & 0xff];
  }
  crc = crc & 0xffff;
  return [crc & 0xff, (crc >>> 8) & 0xff]; // low byte first
}

/**
 * Verify CRC16 checksum at end of buffer
 */
export function verifyCrc16(bytes: number[]): boolean {
  if (bytes.length < 3) return false;
  const data = bytes.slice(0, -2);
  const expected = bytes.slice(-2);
  const actual = crc16(data);
  return actual[0] === expected[0] && actual[1] === expected[1];
}

// ── LRC (Modbus ASCII) ──

/**
 * Calculate Modbus LRC (ASCII checksum)
 */
export function lrc(bytes: number[]): number {
  let sum = 0;
  for (const b of bytes) {
    sum += b;
  }
  return ((-sum) & 0xff);
}

/**
 * Verify LRC checksum at end of buffer
 */
export function verifyLrc(bytes: number[]): boolean {
  if (bytes.length < 3) return false;
  const data = bytes.slice(0, -1);
  const expected = bytes[bytes.length - 1];
  return lrc(data) === expected;
}
