import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSlaveServer, type RegisterChange } from '@/lib/modbus-slave-server';
import { MODBUS_FC, MODBUS_EXCEPTION, type SlaveConfig } from '@/lib/modbus-types';

// ── 测试辅助 ─────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SlaveConfig> = {}): SlaveConfig {
  return {
    id: 'test-slave',
    name: 'Test',
    protocol: 'tcp',
    mode: 'rtu',
    tcpConfig: { host: '127.0.0.1', port: 1502 },
    slaveId: 1,
    coilCount: 16,
    discreteInputCount: 16,
    holdingRegisterCount: 16,
    inputRegisterCount: 16,
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
    ...overrides,
  };
}

function makeServer(overrides: Partial<SlaveConfig> = {}) {
  const changes: RegisterChange[] = [];
  const server = createSlaveServer(makeConfig(overrides), {
    onRegisterChange: (change) => changes.push(change),
  });
  return { server, changes };
}

/** 构造 TCP MBAP 帧 */
function tcpFrame(unitId: number, pdu: number[], txn = 1): Uint8Array {
  const frame = new Uint8Array(7 + pdu.length);
  frame[0] = (txn >> 8) & 0xff;
  frame[1] = txn & 0xff;
  frame[2] = 0;
  frame[3] = 0;
  const length = 1 + pdu.length;
  frame[4] = (length >> 8) & 0xff;
  frame[5] = length & 0xff;
  frame[6] = unitId;
  frame.set(pdu, 7);
  return frame;
}

/** 提取 TCP 响应中的 PDU（响应帧：txn2 + proto2 + len2 + unit1 + PDU） */
function responsePdu(frame: Uint8Array | null): number[] {
  assert.ok(frame, 'expected a response frame');
  return Array.from(frame.subarray(7));
}

/** 构造 RTU 帧（低字节在前的 CRC16） */
function rtuFrame(unitId: number, pdu: number[]): Uint8Array {
  const body = Uint8Array.from([unitId, ...pdu]);
  let crc = 0xffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  const out = new Uint8Array(body.length + 2);
  out.set(body, 0);
  out[body.length] = crc & 0xff;
  out[body.length + 1] = (crc >> 8) & 0xff;
  return out;
}

const fc03 = (addr: number, qty: number) => [MODBUS_FC.READ_HOLDING_REGISTERS, addr >> 8, addr & 0xff, qty >> 8, qty & 0xff];

// ── 读操作 ───────────────────────────────────────────────────────

describe('读操作 (FC01/02/03/04)', () => {
  it('FC03 读回先前写入的寄存器值', () => {
    const { server } = makeServer();
    server.writeRegister('holdingRegisters', 3, 0x1234);
    const pdu = responsePdu(server.handleRequest(tcpFrame(1, fc03(3, 2)), 'tcp'));
    assert.deepEqual(pdu, [0x03, 0x04, 0x12, 0x34, 0x00, 0x00]);
  });

  it('FC03 越界回异常码 0x02', () => {
    const { server } = makeServer();
    const pdu = responsePdu(server.handleRequest(tcpFrame(1, fc03(15, 2)), 'tcp'));
    assert.deepEqual(pdu, [0x83, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS]);
  });

  it('FC03 数量为 0 或超过 125 回异常码 0x03', () => {
    const { server } = makeServer();
    assert.deepEqual(responsePdu(server.handleRequest(tcpFrame(1, fc03(0, 0)), 'tcp')), [0x83, 0x03]);
    assert.deepEqual(responsePdu(server.handleRequest(tcpFrame(1, fc03(0, 126)), 'tcp')), [0x83, 0x03]);
  });

  it('FC01 按位打包返回线圈状态', () => {
    const { server } = makeServer();
    server.writeRegister('coils', 0, 1);
    server.writeRegister('coils', 3, 1);
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [MODBUS_FC.READ_COILS, 0, 0, 0, 8]), 'tcp'),
    );
    // bit0 与 bit3 置位 → 0b00001001
    assert.deepEqual(pdu, [0x01, 0x01, 0b00001001]);
  });

  it('FC02 离散输入默认为 0；主站无写功能码，但操作者可手动注入（R1）', () => {
    const { server, changes } = makeServer();
    const readDiscrete = () =>
      responsePdu(server.handleRequest(tcpFrame(1, [MODBUS_FC.READ_DISCRETE_INPUTS, 0, 0, 0, 1]), 'tcp'));

    assert.deepEqual(readDiscrete(), [0x02, 0x01, 0x00]);

    // ⭐ R1：协议可写性 ≠ 模拟器可编辑性。
    // 离散输入对主站只读（没有任何 FC 能写它），但操作者必须能注入值 ——
    // 否则主站读输入类区域永远是 0，这类主站逻辑根本没法测。
    assert.equal(server.writeRegister('discreteInputs', 0, 1), true);
    assert.deepEqual(changes, [
      { area: 'discreteInputs', address: 0, value: 1, source: 'manual' },
    ]);
    assert.deepEqual(readDiscrete(), [0x02, 0x01, 0x01]);
  });
});

// ── 写操作 ───────────────────────────────────────────────────────

describe('写操作 (FC05/06/15/16)', () => {
  it('FC05 写线圈 0xFF00 置位并回显请求', () => {
    const { server, changes } = makeServer();
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [MODBUS_FC.WRITE_SINGLE_COIL, 0, 1, 0xff, 0x00]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x05, 0x00, 0x01, 0xff, 0x00]);
    assert.equal(server.readRegister('coils', 1), 1);
    assert.deepEqual(changes, [{ area: 'coils', address: 1, value: 1, source: 'master' }]);
  });

  it('FC05 非法值回异常码 0x03', () => {
    const { server } = makeServer();
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [MODBUS_FC.WRITE_SINGLE_COIL, 0, 1, 0x12, 0x34]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x85, 0x03]);
  });

  it('FC06 写单个寄存器', () => {
    const { server } = makeServer();
    const pdu = responsePdu(server.handleRequest(tcpFrame(1, [MODBUS_FC.WRITE_SINGLE_REGISTER, 0, 5, 0xab, 0xcd]), 'tcp'));
    assert.deepEqual(pdu, [0x06, 0x00, 0x05, 0xab, 0xcd]);
    assert.equal(server.readRegister('holdingRegisters', 5), 0xabcd);
  });

  it('FC16 写 3 个寄存器：响应为回显，并产生 3 条精确变更', () => {
    const { server, changes } = makeServer();
    const pdu = responsePdu(
      server.handleRequest(
        tcpFrame(1, [0x10, 0x00, 0x02, 0x00, 0x03, 0x06, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03]),
        'tcp',
      ),
    );
    assert.deepEqual(pdu, [0x10, 0x00, 0x02, 0x00, 0x03]);
    assert.deepEqual(changes, [
      { area: 'holdingRegisters', address: 2, value: 1, source: 'master' },
      { area: 'holdingRegisters', address: 3, value: 2, source: 'master' },
      { area: 'holdingRegisters', address: 4, value: 3, source: 'master' },
    ]);
  });

  it('FC15 跨字节写线圈', () => {
    const { server } = makeServer({ coilCount: 20 });
    // quantity=9, byteCount=2, 位 0..8 → 0b11111111, 0b00000001
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [0x0f, 0x00, 0x00, 0x00, 0x09, 0x02, 0xff, 0x01]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x0f, 0x00, 0x00, 0x00, 0x09]);
    assert.equal(server.readRegister('coils', 8), 1);
    assert.equal(server.readRegister('coils', 9), 0);
  });

  it('FC16 byteCount 不匹配回异常码 0x03', () => {
    const { server } = makeServer();
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [0x10, 0x00, 0x00, 0x00, 0x02, 0x02, 0x00, 0x01]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x90, 0x03]);
  });

  it('FC16 数据长度不足回异常码 0x03，且不写入内存', () => {
    const { server } = makeServer();
    // quantity=2 + byteCount=4，但只带 2 字节数据
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [0x10, 0x00, 0x00, 0x00, 0x02, 0x04, 0x00, 0x11]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x90, 0x03]);
    assert.equal(server.readRegister('holdingRegisters', 0), 0);
  });

  it('FC16 数量超过 123 回异常码 0x03', () => {
    const { server } = makeServer({ holdingRegisterCount: 200 });
    const pdu = responsePdu(
      server.handleRequest(tcpFrame(1, [0x10, 0x00, 0x00, 0x00, 0x7c, 0x00]), 'tcp'),
    );
    assert.deepEqual(pdu, [0x90, 0x03]);
  });

  it('写入相同值不产生变更事件', () => {
    const { server, changes } = makeServer();
    server.writeRegister('holdingRegisters', 0, 42);
    changes.length = 0;
    server.handleRequest(tcpFrame(1, [MODBUS_FC.WRITE_SINGLE_REGISTER, 0, 0, 0x00, 0x2a]), 'tcp');
    assert.deepEqual(changes, []);
  });

  it('未知功能码回异常码 0x01', () => {
    const { server } = makeServer();
    const pdu = responsePdu(server.handleRequest(tcpFrame(1, [MODBUS_FC.READ_EXCEPTION_STATUS, 0, 0]), 'tcp'));
    assert.deepEqual(pdu, [0x87, MODBUS_EXCEPTION.ILLEGAL_FUNCTION]);
  });
});

// ── 单元号与广播 ─────────────────────────────────────────────────

describe('单元号与广播', () => {
  it('单元号不匹配时不应答', () => {
    const { server } = makeServer({ slaveId: 1 });
    assert.equal(server.handleRequest(tcpFrame(2, fc03(0, 1)), 'tcp'), null);
  });

  it('广播写入：不回响应但必须写入内存并产生变更', () => {
    const { server, changes } = makeServer();
    const response = server.handleRequest(tcpFrame(0, [MODBUS_FC.WRITE_SINGLE_REGISTER, 0, 7, 0x00, 0x63]), 'tcp');
    assert.equal(response, null);
    assert.equal(server.readRegister('holdingRegisters', 7), 0x63);
    assert.deepEqual(changes, [
      { area: 'holdingRegisters', address: 7, value: 0x63, source: 'master' },
    ]);
  });

  it('广播读操作不应答且不改动内存', () => {
    const { server, changes } = makeServer();
    assert.equal(server.handleRequest(tcpFrame(0, fc03(0, 1)), 'tcp'), null);
    assert.deepEqual(changes, []);
  });
});

// ── 组帧防御 ─────────────────────────────────────────────────────

describe('组帧防御', () => {
  it('protocolId != 0 的 TCP 帧被拒绝', () => {
    const { server } = makeServer();
    const frame = tcpFrame(1, fc03(0, 1));
    frame[2] = 0x00;
    frame[3] = 0x01;
    assert.equal(server.handleRequest(frame, 'tcp'), null);
  });

  it('MBAP length 与实际帧长不符时被拒绝', () => {
    const { server } = makeServer();
    const frame = tcpFrame(1, fc03(0, 1));
    frame[4] = 0xff;
    frame[5] = 0xff;
    assert.equal(server.handleRequest(frame, 'tcp'), null);
  });

  it('MBAP length 小于下界时被拒绝', () => {
    const { server } = makeServer();
    const frame = tcpFrame(1, [0x03]);
    frame[4] = 0x00;
    frame[5] = 0x01;
    assert.equal(server.handleRequest(frame, 'tcp'), null);
  });

  it('RTU CRC 错误时被拒绝', () => {
    const { server } = makeServer();
    const frame = rtuFrame(1, fc03(0, 1));
    frame[frame.length - 1] ^= 0xff;
    assert.equal(server.handleRequest(frame, 'rtu'), null);
  });

  it('RTU 合法帧正常应答', () => {
    const { server } = makeServer();
    const response = server.handleRequest(rtuFrame(1, fc03(0, 1)), 'rtu');
    assert.ok(response, 'expected RTU response');
    assert.equal(response[0], 1);
    assert.equal(response[1], 0x03);
    assert.equal(response[2], 0x02);
  });

  it('RTU 超长帧被拒绝', () => {
    const { server } = makeServer();
    assert.equal(server.handleRequest(new Uint8Array(300), 'rtu'), null);
  });
});

// ── 内存直访（UI 路径） ───────────────────────────────────────────

describe('内存直访（UI 路径）', () => {
  it('越界写入被拒绝（位区上限 = areaTotalRegisters × 16，Q18）', () => {
    const { server } = makeServer(); // coilCount = 16 ⇒ 256 个位地址
    assert.equal(server.writeRegister('holdingRegisters', 16, 1), false);
    assert.equal(server.writeRegister('holdingRegisters', -1, 1), false);
    assert.equal(server.writeRegister('coils', 256, 1), false); // 越界第一个位地址
    assert.equal(server.writeRegister('coils', 255, 1), true); // 最后一个合法位地址
  });

  it('四个区都能被手动注入（R1）；越界仍然整体拒绝', () => {
    const { server } = makeServer();
    assert.equal(server.writeRange('inputRegisters', 0, [1, 2]), true);
    assert.deepEqual(server.readRange('inputRegisters', 0, 2), [1, 2]);
    assert.equal(server.writeRegister('discreteInputs', 3, 1), true);
    assert.equal(server.readRegister('discreteInputs', 3), 1);
    // 越界：整体拒绝，不做部分写入
    assert.equal(server.writeRange('inputRegisters', 15, [1, 2]), false);
    assert.equal(server.readRegister('inputRegisters', 15), 0);
  });

  it('区间写入越界时整体拒绝，不做部分写入', () => {
    const { server } = makeServer({ holdingRegisterCount: 4 });
    assert.equal(server.writeRange('holdingRegisters', 2, [1, 2, 3]), false);
    assert.equal(server.readRegister('holdingRegisters', 2), 0);
    assert.equal(server.readRegister('holdingRegisters', 3), 0);
  });

  it('readRange 返回窗口内全部值', () => {
    const { server } = makeServer();
    server.writeRange('holdingRegisters', 1, [10, 20, 30]);
    assert.deepEqual(server.readRange('holdingRegisters', 1, 3), [10, 20, 30]);
  });
});

// ── 位打包存储（Q18）与寄存器单位视图层（Q19 / Q20） ──────────────

describe('位区按位打包存储 + 寄存器单位视图', () => {
  it('写位只置位该字内的对应位，其余位不受影响', () => {
    const { server } = makeServer();
    server.writeRegister('coils', 5, 1);
    assert.equal(server.readRegister('coils', 5), 1);
    assert.equal(server.readRegister('coils', 4), 0);
    assert.equal(server.readRegister('coils', 6), 0);
    // ⚠️ 位序：字内 bit 0（LSB）= 编号最小的线圈地址
    assert.equal(server.memory.coils[0], 0b100000);
    // ⭐ 数组长度 = coilCount（**不是** ×16 —— ×16 只是容量结果）
    assert.equal(server.memory.coils.length, 16);
    assert.equal(server.memory.coils instanceof Uint16Array, true);
  });

  it('位区容量 = areaTotalRegisters × 16 个位地址', () => {
    const { server } = makeServer({ coilCount: 2 });
    assert.equal(server.writeRegister('coils', 31, 1), true); // 第 2 个寄存器的最后一位
    assert.equal(server.writeRegister('coils', 32, 1), false); // 越界
  });

  it('readSnapshot 行 = 寄存器：address 为寄存器序号、位区 rawValue 为打包字、带来源', () => {
    const { server } = makeServer();
    server.writeRegister('coils', 1, 1); // 落在寄存器 0
    assert.deepEqual(server.readSnapshot('coils', 0, 2), [
      { address: 0, rawValue: 0b10, source: 'manual' },
      { address: 1, rawValue: 0, source: null },
    ]);
  });

  it('injectRegister 位区写满该寄存器的 16 个位地址，只对变化的位发增量', () => {
    const { server, changes } = makeServer();
    assert.equal(server.injectRegister('coils', 1, 0b1010), true);
    // 寄存器 1 覆盖位地址 16~31；置位的是字内 bit 1、bit 3 ⇒ 位地址 17、19
    assert.deepEqual(changes, [
      { area: 'coils', address: 17, value: 1, source: 'manual' },
      { area: 'coils', address: 19, value: 1, source: 'manual' },
    ]);
    assert.equal(server.readSnapshot('coils', 1, 1)[0].rawValue, 0b1010);
  });

  it('injectRange 越界整体拒绝，不做部分写入', () => {
    const { server } = makeServer({ holdingRegisterCount: 4 });
    assert.equal(server.injectRange('holdingRegisters', 2, [1, 2, 3]), false);
    assert.equal(server.readSnapshot('holdingRegisters', 2, 1)[0].rawValue, 0);
  });

  it('手动注入四个区都成功（R1），来源记为 manual', () => {
    const { server } = makeServer();
    for (const area of ['coils', 'discreteInputs', 'holdingRegisters', 'inputRegisters'] as const) {
      assert.equal(server.injectRegister(area, 0, 0x1234), true, area);
      assert.equal(server.readSnapshot(area, 0, 1)[0].source, 'manual', area);
    }
  });

  it('主站 FC 写入把来源记为 master，不影响其它寄存器的来源', () => {
    const { server } = makeServer();
    server.injectRegister('holdingRegisters', 1, 0xaaaa);
    server.handleRequest(tcpFrame(1, [MODBUS_FC.WRITE_SINGLE_REGISTER, 0, 0, 0x00, 0x2a]), 'tcp');
    const rows = server.readSnapshot('holdingRegisters', 0, 2);
    assert.deepEqual(rows, [
      { address: 0, rawValue: 0x2a, source: 'master' },
      { address: 1, rawValue: 0xaaaa, source: 'manual' },
    ]);
  });

  it('四个区共用同一套读上限：125 寄存器（位区 = 2000 位）', () => {
    const { server } = makeServer({ coilCount: 200 });
    // 2000 位 = 125 寄存器 ✓ 放行；byteCount = 2000 / 8 = 250
    const ok = responsePdu(server.handleRequest(tcpFrame(1, [0x01, 0, 0, 0x07, 0xd0]), 'tcp'));
    assert.deepEqual(ok.slice(0, 2), [0x01, 250]);
    // 2001 位 = 超上限 ⇒ 0x03
    assert.deepEqual(responsePdu(server.handleRequest(tcpFrame(1, [0x01, 0, 0, 0x07, 0xd1]), 'tcp')), [
      0x81, 0x03,
    ]);
  });
});
