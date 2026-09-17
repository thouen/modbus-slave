import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToDouble,
  bytesToFloat,
  bytesToHex,
  bytesToLong,
  bytesToShort,
  bytesToULong,
  bytesToUShort,
  crc16,
  doubleToBytes,
  floatToBytes,
  formatRegisterValue,
  generateId,
  getFormatRegisterCount,
  hexToBytes,
  registersToBytes,
  reorderBytes,
  reorderBytesInv,
  verifyCrc16,
} from '@/lib/modbus-utils';
import type { ByteOrder32, ByteOrder64 } from '@/lib/modbus-types';

/** 把字节数组按大端两两合成 16 位寄存器 */
function toRegisters(bytes: number[]): number[] {
  const regs: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    regs.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) & 0xffff);
  }
  return regs;
}

describe('字节序换算', () => {
  const orders: Array<ByteOrder32 | ByteOrder64> = [
    'ABCD',
    'DCBA',
    'BADC',
    'CDAB',
    'ABCDEFGH',
    'HGFEDCBA',
    'BADCFEHG',
    'GHEFCDAB',
  ];

  it('reorderBytesInv 是 reorderBytes 的逆变换', () => {
    const bytes32 = [0x12, 0x34, 0x56, 0x78];
    const bytes64 = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
    for (const order of orders) {
      const source = order.length === 4 ? bytes32 : bytes64;
      const roundTrip = reorderBytesInv(reorderBytes(source, order), order);
      assert.deepEqual(roundTrip, source, `order=${order}`);
    }
  });

  it('DCBA 会翻转 32 位字节序', () => {
    const bytes = registersToBytes([0x1234, 0x5678]); // [12 34 56 78]
    assert.equal(bytesToULong(reorderBytes(bytes, 'DCBA')), 0x78563412);
    assert.equal(bytesToULong(reorderBytes(bytes, 'ABCD')), 0x12345678);
  });

  it('registersToBytes / bytesToUShort 大端往返一致', () => {
    assert.deepEqual(registersToBytes([0x1234, 0xabcd]), [0x12, 0x34, 0xab, 0xcd]);
    assert.equal(bytesToUShort([0x12, 0x34]), 0x1234);
    assert.equal(bytesToShort([0xff, 0xfe]), -2);
    assert.equal(bytesToLong([0xff, 0xff, 0xff, 0xff]), -1);
  });
});

describe('数据格式化', () => {
  it('16 位格式', () => {
    assert.equal(formatRegisterValue([0x1234], 'hex', 'ABCD', 'ABCDEFGH'), '0x1234');
    assert.equal(formatRegisterValue([0xfffe], 'ushort', 'ABCD', 'ABCDEFGH'), '65534');
    assert.equal(formatRegisterValue([0xfffe], 'short', 'ABCD', 'ABCDEFGH'), '-2');
    assert.equal(formatRegisterValue([0x0001], 'binary', 'ABCD', 'ABCDEFGH'), '0000000000000001');
    assert.equal(formatRegisterValue([1], 'led', 'ABCD', 'ABCDEFGH'), 'ON');
    assert.equal(formatRegisterValue([0], 'led', 'ABCD', 'ABCDEFGH'), 'OFF');
  });

  it('float 往返一致', () => {
    const registers = toRegisters(floatToBytes(1.5));
    assert.equal(formatRegisterValue(registers, 'float', 'ABCD', 'ABCDEFGH'), '1.5000');
    assert.equal(bytesToFloat(floatToBytes(1.5)), 1.5);
  });

  it('double 往返一致', () => {
    const registers = toRegisters(doubleToBytes(2.5));
    assert.equal(formatRegisterValue(registers, 'double', 'ABCD', 'ABCDEFGH'), '2.500000');
    assert.equal(bytesToDouble(doubleToBytes(2.5)), 2.5);
  });

  it('每个格式占用的寄存器数量', () => {
    assert.equal(getFormatRegisterCount('hex'), 1);
    assert.equal(getFormatRegisterCount('float'), 2);
    assert.equal(getFormatRegisterCount('double'), 4);
  });
});

describe('校验与工具函数', () => {
  it('crc16 初始值为 0xFFFF（空输入）', () => {
    assert.deepEqual(crc16([]), [0xff, 0xff]);
  });

  it('verifyCrc16 能识别正确与错误的校验和', () => {
    const data = [0x01, 0x03, 0x00, 0x00, 0x00, 0x0a];
    const [low, high] = crc16(data);
    assert.equal(verifyCrc16([...data, low, high]), true);
    assert.equal(verifyCrc16([...data, low, high ^ 0xff]), false);
    assert.equal(verifyCrc16([0x01, 0x02]), false);
  });

  it('bytesToHex / hexToBytes 往返一致', () => {
    assert.equal(bytesToHex([0x0a, 0xff, 0x00]), '0A FF 00');
    assert.deepEqual(hexToBytes('0A FF 00'), [0x0a, 0xff, 0x00]);
  });

  it('generateId 生成唯一 UUID', () => {
    const a = generateId();
    const b = generateId();
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
