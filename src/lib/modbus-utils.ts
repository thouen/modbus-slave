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
 * Format a register value according to display format.
 *
 * 语义与 modbus-master 保持一致：`hex` 不带 0x 前缀、`led` 输出 16 位串、
 * `float` 保留 6 位小数、`double` 保留 10 位小数；宽类型需要后续寄存器存在，否则返回 `-`。
 */
export function formatRegisterValue(
  registers: RegisterData[],
  startIndex: number,
  format: DataDisplayFormat,
  byteOrder32: ByteOrder32,
  byteOrder64: ByteOrder64,
): string {
  if (startIndex >= registers.length) return '-';

  const reg = registers[startIndex];

  switch (format) {
    case 'led': {
      const bits: string[] = [];
      for (let i = 15; i >= 0; i--) {
        bits.push((reg.rawValue >> i) & 1 ? '1' : '0');
      }
      return bits.join('');
    }
    case 'short':
      return String(bytesToShort(shortToBytes(reg.rawValue)));
    case 'ushort':
      return String(reg.rawValue);
    case 'hex':
      return reg.rawValue.toString(16).toUpperCase().padStart(4, '0');
    case 'binary': {
      const bits = reg.rawValue.toString(2).padStart(16, '0');
      return bits.match(/.{4}/g)?.join(' ') ?? bits;
    }
    case 'long':
    case 'ulong':
    case 'float': {
      if (startIndex + 1 >= registers.length) return '-';
      const rawBytes = registersToBytes([
        registers[startIndex].rawValue,
        registers[startIndex + 1].rawValue,
      ]);
      const orderedBytes = reorderBytes(rawBytes, byteOrder32);
      if (format === 'long') return String(bytesToLong(orderedBytes));
      if (format === 'ulong') return String(bytesToULong(orderedBytes));
      return bytesToFloat(orderedBytes).toFixed(6);
    }
    case 'double': {
      if (startIndex + 3 >= registers.length) return '-';
      const rawBytes = registersToBytes([
        registers[startIndex].rawValue,
        registers[startIndex + 1].rawValue,
        registers[startIndex + 2].rawValue,
        registers[startIndex + 3].rawValue,
      ]);
      const orderedBytes = reorderBytes(rawBytes, byteOrder64);
      return bytesToDouble(orderedBytes).toFixed(10);
    }
    default:
      return String(reg.rawValue);
  }
}

/**
 * 数值 → 大端逻辑字节序列（IEEE754 float32/float64）
 */
function numericToBigEndianBytes(value: number, double: boolean): number[] {
  const buf = new ArrayBuffer(double ? 8 : 4);
  const view = new DataView(buf);
  if (double) view.setFloat64(0, value, false);
  else view.setFloat32(0, value, false);
  return Array.from({ length: buf.byteLength }, (_, i) => view.getUint8(i));
}

/**
 * 将「格式化后的值」编码回一组 16 位寄存器原始值（用于宽类型行内编辑写入）。
 * long/ulong/float 返回 2 个寄存器，double 返回 4 个；16 位及位类型返回 1 个。
 */
export function encodeValueToRegisters(
  value: number,
  format: DataDisplayFormat,
  byteOrder32: ByteOrder32 = 'ABCD',
  byteOrder64: ByteOrder64 = 'ABCDEFGH',
): number[] {
  let logical: number[];
  let order: ByteOrder32 | ByteOrder64 = byteOrder32;
  switch (format) {
    case 'long': {
      const u = value | 0;
      logical = [(u >> 24) & 0xff, (u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff];
      break;
    }
    case 'ulong': {
      const u = value >>> 0;
      logical = [(u >> 24) & 0xff, (u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff];
      break;
    }
    case 'float':
      logical = numericToBigEndianBytes(value, false);
      break;
    case 'double':
      logical = numericToBigEndianBytes(value, true);
      order = byteOrder64;
      break;
    default:
      return [value & 0xffff];
  }
  const raw = reorderBytesInv(logical, order);
  const regs: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    regs.push(((raw[i] ?? 0) << 8) | (raw[i + 1] ?? 0));
  }
  return regs;
}

/**
 * Get bits per value for a given display format
 * led: 1 bit, 16-bit formats: 16 bits, 32-bit formats: 32 bits, 64-bit: 64 bits
 */
export function getBitsPerValue(format: DataDisplayFormat): number {
  switch (format) {
    case 'led':
      return 1;
    case 'binary':
    case 'short':
    case 'ushort':
    case 'hex':
      return 16;
    case 'long':
    case 'ulong':
    case 'float':
      return 32;
    case 'double':
      return 64;
    default:
      return 16;
  }
}

/** 32 位 / 64 位（跨寄存器）类型集合 */
const WIDE_FORMATS: ReadonlySet<DataDisplayFormat> = new Set<DataDisplayFormat>([
  'long', 'ulong', 'float', 'double',
]);

/**
 * 某格式在「寄存器（word）」视图下占用的寄存器数量；位（bit）视图恒为 1。
 */
export function getSpanForFormat(format: DataDisplayFormat, isWordType: boolean): number {
  if (!isWordType || !WIDE_FORMATS.has(format)) return 1;
  return getBitsPerValue(format) / 16;
}

/**
 * 某地址（相对 index，从 0 起）是否有足够空间切换为指定格式
 */
export function formatFitsAt(
  format: DataDisplayFormat,
  index: number,
  quantity: number,
  isWordType: boolean,
): boolean {
  const span = getSpanForFormat(format, isWordType);
  return index + span <= quantity;
}

/** 单个地址在逐行类型映射中的角色 */
export interface AddressResolution {
  /** 'start' = 分组起始地址（可设置类型）；'consumed' = 被前一宽类型占用 */
  role: 'start' | 'consumed';
  /** 所属分组的起始地址 */
  groupStart: number;
  /** 该分组实际使用的显示格式 */
  format: DataDisplayFormat;
  /** 占用的寄存器数（1 / 2 / 4） */
  span: number;
  /** 该分组是否在可用地址范围内完整放下（越界为 false） */
  fits: boolean;
  /** 该地址的类型是否为用户逐行 override（仅 start 有意义） */
  overridden: boolean;
}

/**
 * 逐行类型映射解析：从 startAddress 起按 quantity 个地址推进，
 * 依据默认格式与逐行 override 计算每个地址的角色（起点 / 被占用）。
 * 32 位类型占用后续 1 个地址，64 位占用后续 3 个地址；空间不足时 fits=false。
 */
export function resolveRegisterLayout(opts: {
  startAddress: number;
  quantity: number;
  isWordType: boolean;
  defaultFormat: DataDisplayFormat;
  formatOverrides?: Record<number, DataDisplayFormat>;
}): Map<number, AddressResolution> {
  const { startAddress, quantity, isWordType, defaultFormat, formatOverrides } = opts;
  const end = startAddress + quantity;
  const map = new Map<number, AddressResolution>();
  let cursor = startAddress;

  while (cursor < end) {
    const overridden = Object.prototype.hasOwnProperty.call(formatOverrides ?? {}, cursor);
    const format = formatOverrides?.[cursor] ?? defaultFormat;
    const span = getSpanForFormat(format, isWordType);
    const fits = cursor + span <= end;

    for (let s = 0; s < span && cursor + s < end; s++) {
      map.set(cursor + s, {
        role: s === 0 ? 'start' : 'consumed',
        groupStart: cursor,
        format,
        span,
        fits,
        overridden: s === 0 ? overridden : false,
      });
    }
    cursor += span;
  }

  return map;
}

/**
 * 解析行内编辑输入文本为数值（按显示格式决定进制）
 */
export function parseDisplayValue(value: string, format: DataDisplayFormat): number {
  const trimmed = value.trim();
  switch (format) {
    case 'hex': {
      const hexStr = trimmed.replace(/^0x"?|"?$/g, '');
      return parseInt(hexStr, 16) || 0;
    }
    case 'binary': {
      const binStr = trimmed.replace(/^0b"?|"?\s*$/g, '').replace(/\s+/g, '');
      return parseInt(binStr, 2) || 0;
    }
    case 'float':
    case 'double':
      return parseFloat(trimmed) || 0;
    default:
      return parseInt(trimmed, 10) || 0;
  }
}

/**
 * Generate a random ID string
 */
export function generateId(): string {
  return crypto.randomUUID();
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
