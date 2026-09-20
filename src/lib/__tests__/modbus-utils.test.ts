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
  encodeValueToRegisters,
  floatToBytes,
  formatFitsAt,
  formatRegisterValue,
  generateId,
  getBitsPerValue,
  getSpanForFormat,
  hexToBytes,
  parseDisplayValue,
  registersToBytes,
  registerWindowKey,
  reorderBytes,
  reorderBytesInv,
  resolveRegisterLayout,
  verifyCrc16,
} from '@/lib/modbus-utils';
import type { ByteOrder32, ByteOrder64, RegisterData } from '@/lib/modbus-types';

/** 把字节数组按大端两两合成 16 位寄存器 */
function toRegisters(bytes: number[]): number[] {
  const regs: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    regs.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) & 0xffff);
  }
  return regs;
}

/** 原始值数组 → 表格行（formatRegisterValue 的新入参形态） */
function rows(values: number[], startAddress = 0): RegisterData[] {
  return values.map((rawValue, i) => ({ address: startAddress + i, rawValue }));
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
  it('16 位格式（hex 不带 0x 前缀、binary 每 4 位分组、bits 为 16 位串）', () => {
    assert.equal(formatRegisterValue(rows([0x1234]), 0, 'hex', 'ABCD', 'ABCDEFGH'), '1234');
    assert.equal(formatRegisterValue(rows([0xfffe]), 0, 'ushort', 'ABCD', 'ABCDEFGH'), '65534');
    assert.equal(formatRegisterValue(rows([0xfffe]), 0, 'short', 'ABCD', 'ABCDEFGH'), '-2');
    assert.equal(
      formatRegisterValue(rows([0x0001]), 0, 'binary', 'ABCD', 'ABCDEFGH'),
      '0000 0000 0000 0001',
    );
    assert.equal(
      formatRegisterValue(rows([1]), 0, 'bits', 'ABCD', 'ABCDEFGH'),
      '0000000000000001',
    );
    assert.equal(
      formatRegisterValue(rows([0]), 0, 'bits', 'ABCD', 'ABCDEFGH'),
      '0000000000000000',
    );
  });

  it('从指定行索引起格式化（宽类型分组）', () => {
    const regs = rows([0x0000, 0x1234, 0xabcd]);
    assert.equal(formatRegisterValue(regs, 1, 'hex', 'ABCD', 'ABCDEFGH'), '1234');
    assert.equal(formatRegisterValue(regs, 0, 'long', 'ABCD', 'ABCDEFGH'), '4660');
    assert.equal(formatRegisterValue(regs, 1, 'long', 'ABCD', 'ABCDEFGH'), '305441741');
  });

  it('宽类型在寄存器不足时返回 -', () => {
    assert.equal(formatRegisterValue(rows([0x1234]), 0, 'float', 'ABCD', 'ABCDEFGH'), '-');
    assert.equal(formatRegisterValue(rows([1, 2]), 0, 'double', 'ABCD', 'ABCDEFGH'), '-');
    assert.equal(formatRegisterValue(rows([]), 0, 'hex', 'ABCD', 'ABCDEFGH'), '-');
  });

  it('float 往返一致（6 位小数）', () => {
    const registers = toRegisters(floatToBytes(1.5));
    assert.equal(
      formatRegisterValue(rows(registers), 0, 'float', 'ABCD', 'ABCDEFGH'),
      '1.500000',
    );
    assert.equal(bytesToFloat(floatToBytes(1.5)), 1.5);
  });

  it('double 往返一致（10 位小数）', () => {
    const registers = toRegisters(doubleToBytes(2.5));
    assert.equal(
      formatRegisterValue(rows(registers), 0, 'double', 'ABCD', 'ABCDEFGH'),
      '2.5000000000',
    );
    assert.equal(bytesToDouble(doubleToBytes(2.5)), 2.5);
  });

  it('encodeValueToRegisters 与 formatRegisterValue 往返一致（含字节序）', () => {
    // float：ABCD 与 DCBA 应各自往返一致
    const floatAbcd = encodeValueToRegisters(1.5, 'float', 'ABCD', 'ABCDEFGH');
    assert.equal(formatRegisterValue(rows(floatAbcd), 0, 'float', 'ABCD', 'ABCDEFGH'), '1.500000');
    const floatDcba = encodeValueToRegisters(1.5, 'float', 'DCBA', 'ABCDEFGH');
    assert.equal(formatRegisterValue(rows(floatDcba), 0, 'float', 'DCBA', 'ABCDEFGH'), '1.500000');

    // ulong：0x12345678 → [0x1234, 0x5678]
    assert.deepEqual(encodeValueToRegisters(0x12345678, 'ulong', 'ABCD', 'ABCDEFGH'), [0x1234, 0x5678]);

    // long：负数往返
    const negLong = encodeValueToRegisters(-2, 'long', 'ABCD', 'ABCDEFGH');
    assert.equal(formatRegisterValue(rows(negLong), 0, 'long', 'ABCD', 'ABCDEFGH'), '-2');

    // double：需要 4 个寄存器
    const dbl = encodeValueToRegisters(2.5, 'double', 'ABCD', 'GHEFCDAB');
    assert.equal(dbl.length, 4);
    assert.equal(formatRegisterValue(rows(dbl), 0, 'double', 'ABCD', 'GHEFCDAB'), '2.5000000000');

    // 16 位类型只产生一个寄存器
    assert.deepEqual(encodeValueToRegisters(0x1234, 'hex', 'ABCD', 'ABCDEFGH'), [0x1234]);
  });

  it('parseDisplayValue 按格式解析输入', () => {
    assert.equal(parseDisplayValue('0x1F', 'hex'), 31);
    assert.equal(parseDisplayValue('FF', 'hex'), 255);
    assert.equal(parseDisplayValue('0000 0100', 'binary'), 4);
    assert.equal(parseDisplayValue('1.5', 'float'), 1.5);
    assert.equal(parseDisplayValue('-2.25', 'double'), -2.25);
    assert.equal(parseDisplayValue('65535', 'ushort'), 65535);
    assert.equal(parseDisplayValue('', 'hex'), 0);
  });
});

describe('逐行类型映射', () => {
  it('位数为 1/16/32/64', () => {
    assert.equal(getBitsPerValue('bits'), 1);
    assert.equal(getBitsPerValue('hex'), 16);
    assert.equal(getBitsPerValue('float'), 32);
    assert.equal(getBitsPerValue('double'), 64);
  });

  it('寄存器视图下宽类型占 2/4 个寄存器，位视图恒为 1', () => {
    assert.equal(getSpanForFormat('hex', true), 1);
    assert.equal(getSpanForFormat('float', true), 2);
    assert.equal(getSpanForFormat('double', true), 4);
    assert.equal(getSpanForFormat('double', false), 1);
  });

  it('formatFitsAt 判断剩余空间是否够用', () => {
    assert.equal(formatFitsAt('hex', 0, 1, true), true);
    assert.equal(formatFitsAt('float', 0, 2, true), true);
    assert.equal(formatFitsAt('float', 1, 2, true), false);
    assert.equal(formatFitsAt('double', 0, 3, true), false);
    assert.equal(formatFitsAt('double', 0, 4, true), true);
  });

  it('resolveRegisterLayout 标记分组起点与被占用行', () => {
    const layout = resolveRegisterLayout({
      startAddress: 10,
      quantity: 6,
      isWordType: true,
      defaultFormat: 'hex',
      formatOverrides: { 11: 'float' },
    });

    assert.equal(layout.size, 6);
    assert.deepEqual(layout.get(10), {
      role: 'start', groupStart: 10, format: 'hex', span: 1, fits: true, overridden: false,
    });
    assert.deepEqual(layout.get(11), {
      role: 'start', groupStart: 11, format: 'float', span: 2, fits: true, overridden: true,
    });
    assert.deepEqual(layout.get(12), {
      role: 'consumed', groupStart: 11, format: 'float', span: 2, fits: true, overridden: false,
    });
    assert.equal(layout.get(13)?.role, 'start');
    assert.equal(layout.get(13)?.format, 'hex');
    assert.equal(layout.get(15)?.role, 'start');
  });

  it('resolveRegisterLayout 对越界分组标 fits=false 且不越出窗口', () => {
    const layout = resolveRegisterLayout({
      startAddress: 0,
      quantity: 3,
      isWordType: true,
      defaultFormat: 'ushort',
      formatOverrides: { 2: 'double' },
    });

    assert.equal(layout.size, 3);
    assert.equal(layout.get(2)?.fits, false);
    assert.equal(layout.get(2)?.span, 4);
    assert.equal(layout.get(0)?.format, 'ushort');
    assert.equal(layout.get(1)?.format, 'ushort');
  });

  it('resolveRegisterLayout 在位区域忽略宽类型跨度', () => {
    const layout = resolveRegisterLayout({
      startAddress: 0,
      quantity: 3,
      isWordType: false,
      defaultFormat: 'bits',
    });

    assert.equal(layout.size, 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(layout.get(i)?.role, 'start');
      assert.equal(layout.get(i)?.span, 1);
      assert.equal(layout.get(i)?.format, 'bits');
    }
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

describe('registerWindowKey（窗口身份）', () => {
  const tab = {
    id: 't1',
    name: 't1',
    slaveId: 's1',
    area: 'coils',
    startAddress: 0,
    registerCount: 20,
    displayFormat: 'bits',
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
  } as const;

  it('同一个窗口恒定得到同一个键（切走再切回来能找到自己的草稿）', () => {
    assert.equal(registerWindowKey({ ...tab }), registerWindowKey({ ...tab }));
  });

  // ⚠️ 下面每一条都是"窗口身份"的组成部分，缺一条就会把草稿泄漏到别的窗口/区域。
  it('换区域即换键（防跨区串值 —— R1 实测 bug 的那条）', () => {
    assert.notEqual(registerWindowKey({ ...tab }), registerWindowKey({ ...tab, area: 'discreteInputs' }));
  });

  it('改起始地址即换键', () => {
    assert.notEqual(registerWindowKey({ ...tab }), registerWindowKey({ ...tab, startAddress: 10 }));
  });

  it('改数量即换键', () => {
    assert.notEqual(registerWindowKey({ ...tab }), registerWindowKey({ ...tab, registerCount: 8 }));
  });

  it('换标签即换键（防跨标签串值）', () => {
    assert.notEqual(registerWindowKey({ ...tab }), registerWindowKey({ ...tab, id: 't2' }));
  });

  it('不因显示格式变化换键（换格式不该丢草稿）', () => {
    assert.equal(registerWindowKey({ ...tab }), registerWindowKey({ ...tab, displayFormat: 'hex' }));
  });
});
