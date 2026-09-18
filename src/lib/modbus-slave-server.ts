import type {
  SlaveConfig,
  SlaveMemory,
  RegisterArea,
  RegisterData,
  ValueSource,
} from '@/lib/modbus-types';
import {
  MODBUS_FC,
  MODBUS_EXCEPTION,
  MODBUS_MAX,
  BITS_PER_REGISTER,
  SOURCE_CODE,
  decodeSource,
  fcToArea,
  isBitArea,
  createSlaveMemory,
  areaWords,
  areaSources,
  readPackedBit,
  writePackedBit,
  bitAddressToRegister,
} from '@/lib/modbus-types';

/**
 * ModBus Slave Server - pure protocol handling
 * Handles RTU, ASCII, and TCP frame parsing and response generation.
 * Memory model is managed externally via SlaveMemory.
 *
 * ── 两套单位，别混（Q19 / Q20）──────────────────────────────────
 * · **地址单位**（ModBus 原生）：位区 = 位地址。用于协议解析、`checkAddress`、`readRegister`。
 * · **寄存器单位**：视图 / 状态 / WS 一律用它。`readSnapshot` / `injectRegister` 收口于此，
 *   内部经 `BITS_PER_REGISTER` 换算，**打包细节不出这一层**。
 */

/** 单次内存变更（用于向 UI 推送精确增量） */
export interface RegisterChange {
  area: RegisterArea;
  /**
   * ⚠️ **ModBus 地址单位**：
   * - 字区 = 寄存器序号；
   * - 位区 = **位地址**（值 `0 / 1`）。
   *
   * 界面表格按寄存器分行（Q20），由 reducer 用 `bitAddressToRegister()` 归行 ——
   * 打包/换算细节不越过本层（见 ROADMAP §3.6「位读写必须收口到 helper」）。
   */
  address: number;
  /** 字区 = 寄存器值；位区 = `0 / 1` */
  value: number;
  /** 值来源（Q7）：主站功能码 / 界面手动注入 / 生成器 */
  source: ValueSource;
}

export interface SlaveServerOptions {
  /**
   * 内存值**实际发生变化**时回调（新旧值相同则不触发）。
   * 协议层保持纯粹：不在此做任何 IO，由调用方决定如何广播。
   */
  onRegisterChange?: (change: RegisterChange) => void;
}

export interface SlaveServer {
  memory: SlaveMemory;
  config: SlaveConfig;
  /** Handle a raw ModBus request frame (ADU), return response ADU bytes */
  handleRequest: (request: Uint8Array, mode: 'rtu' | 'ascii' | 'tcp') => Uint8Array | null;

  // ── 视图层（⭐ 寄存器单位，Q19 / Q20）───────────────────────────
  /** 读取窗口快照：行 `address` = 寄存器序号；位区 `rawValue` = 按位打包的 16 位字 */
  readSnapshot: (area: RegisterArea, startRegister: number, registerCount: number) => RegisterData[];
  /** 手动注入单个寄存器（R1：四个区都可注入，不受区域门控） */
  injectRegister: (area: RegisterArea, registerIndex: number, value: number) => boolean;
  /** 手动注入一段寄存器 */
  injectRange: (area: RegisterArea, startRegister: number, values: number[]) => boolean;

  // ── 内存层（ModBus 地址单位：位区 = 位地址）────────────────────
  /** Read register value from memory (for UI) */
  readRegister: (area: RegisterArea, address: number) => number;
  /** Write register value to memory (for UI) */
  writeRegister: (area: RegisterArea, address: number, value: number) => boolean;
  /** Read range of registers (for UI / bulk read) */
  readRange: (area: RegisterArea, startAddress: number, quantity: number) => number[];
  /** Write range of values */
  writeRange: (area: RegisterArea, startAddress: number, values: number[]) => boolean;
}

export function createSlaveServer(config: SlaveConfig, options: SlaveServerOptions = {}): SlaveServer {
  const memory = createSlaveMemory(config);
  const notifyChange = options.onRegisterChange;

  // ── CRC16 (ModBus RTU) ──

  function crc16(data: Uint8Array, length: number): number {
    let crc = 0xffff;
    for (let i = 0; i < length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        if (crc & 0x0001) {
          crc = (crc >> 1) ^ 0xa001;
        } else {
          crc >>= 1;
        }
      }
    }
    return crc;
  }

  // ── LRC (ModBus ASCII) ──

  function lrc(data: Uint8Array, length: number): number {
    let lrc = 0;
    for (let i = 0; i < length; i++) {
      lrc += data[i];
    }
    return ((-lrc) & 0xff) >>> 0;
  }

  // ── ASCII frame helpers ──

  function asciiDecode(frame: Uint8Array): Uint8Array | null {
    // ASCII frame: :[addr(2)][fc(2)][data...][lrc(2)]\r\n
    if (frame.length < 9 || frame[0] !== 0x3a /* ':' */) return null;
    const endIdx = frame.indexOf(0x0d); // '\r'
    if (endIdx < 7) return null;
    const hexLen = endIdx - 1;
    if (hexLen % 2 !== 0) return null;

    const out = new Uint8Array(hexLen / 2);
    for (let i = 0; i < hexLen; i += 2) {
      const hi = hexCharToNibble(frame[1 + i]);
      const lo = hexCharToNibble(frame[2 + i]);
      if (hi < 0 || lo < 0) return null;
      out[i / 2] = (hi << 4) | lo;
    }

    // Check LRC
    const calculatedLrc = lrc(out.subarray(0, out.length - 1), out.length - 1);
    if (calculatedLrc !== out[out.length - 1]) {
      return null;
    }

    return out.subarray(0, out.length - 1); // return PDU (slaveId + fc + data)
  }

  function asciiEncode(slaveId: number, pdu: Uint8Array): Uint8Array {
    const data = new Uint8Array(pdu.length + 1);
    data[0] = slaveId;
    data.set(pdu, 1);
    const lr = lrc(data, data.length);

    const frame = new Uint8Array(1 + data.length * 2 + 2 + 2); // : + hex + LRC + \r\n
    frame[0] = 0x3a; // ':'
    let pos = 1;
    for (let i = 0; i < data.length; i++) {
      frame[pos++] = nibbleToHexChar((data[i] >> 4) & 0x0f);
      frame[pos++] = nibbleToHexChar(data[i] & 0x0f);
    }
    frame[pos++] = nibbleToHexChar((lr >> 4) & 0x0f);
    frame[pos++] = nibbleToHexChar(lr & 0x0f);
    frame[pos++] = 0x0d; // '\r'
    frame[pos++] = 0x0a; // '\n'
    return frame;
  }

  function hexCharToNibble(c: number): number {
    if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
    if (c >= 0x41 && c <= 0x46) return c - 0x37; // A-F
    if (c >= 0x61 && c <= 0x66) return c - 0x57; // a-f
    return -1;
  }

  function nibbleToHexChar(n: number): number {
    return n < 10 ? 0x30 + n : 0x37 + n; // 0-9, A-F
  }

  // ── TCP MBAP header helpers ──

  function tcpDecode(frame: Uint8Array): {
    transactionId: number;
    protocolId: number;
    slaveId: number;
    pdu: Uint8Array;
  } | null {
    // 畸形帧防御：长度下界/上界 + protocolId 必须为 0（ModBus TCP 规范）
    if (frame.length < 8 || frame.length > MODBUS_MAX.ADU_LENGTH) return null;
    const transactionId = (frame[0] << 8) | frame[1];
    const protocolId = (frame[2] << 8) | frame[3];
    if (protocolId !== 0) return null;
    const length = (frame[4] << 8) | frame[5];
    // length 覆盖 unitId(1) + PDU，且必须与实际帧长一致（不一致说明组帧出错，直接丢弃）
    if (length < 2 || 6 + length !== frame.length) return null;
    const slaveId = frame[6];
    const pdu = frame.subarray(7, 6 + length); // length includes slaveId
    return { transactionId, protocolId, slaveId, pdu };
  }

  function tcpEncode(transactionId: number, slaveId: number, pdu: Uint8Array): Uint8Array {
    const length = 1 + pdu.length; // slaveId + PDU
    const frame = new Uint8Array(7 + pdu.length);
    frame[0] = (transactionId >> 8) & 0xff;
    frame[1] = transactionId & 0xff;
    frame[2] = 0;
    frame[3] = 0; // protocolId = 0
    frame[4] = (length >> 8) & 0xff;
    frame[5] = length & 0xff;
    frame[6] = slaveId;
    frame.set(pdu, 7);
    return frame;
  }

  // ── Memory access helpers ──

  /** 该区的寄存器总数量（= 数组长度，因为"数组长度 = 该区 areaTotalRegisters"） */
  function areaTotalRegisters(area: RegisterArea): number {
    return areaWords(memory, area).length;
  }

  /**
   * 越界判断（⚠️ **地址单位**：位区传入的是位地址）。
   *
   * 上界**直接取自数组长度** —— 这样"数组越界"与"声明范围越界"永远等价，
   * 不会出现"配置改了但数组还是旧长度"这类不一致。
   * 位区容量 = `areaTotalRegisters × 16`（Q18：位打包在字里）。
   */
  function checkAddress(area: RegisterArea, address: number, quantity: number): boolean {
    const words = areaTotalRegisters(area);
    const max = isBitArea(area) ? words * BITS_PER_REGISTER : words;
    return address >= 0 && quantity > 0 && address + quantity <= max;
  }

  /** 记录一次写入的来源（⚠️ 按**寄存器**索引；位区 = 位地址 / 16） */
  function markSource(area: RegisterArea, registerIndex: number, source: ValueSource): void {
    const sources = areaSources(memory, area);
    const code = SOURCE_CODE[source];
    if (sources[registerIndex] !== code) sources[registerIndex] = code;
  }

  /** 读某寄存器的值来源（Q7）；未写入过 → `null` */
  function readSource(area: RegisterArea, registerIndex: number): ValueSource | null {
    return decodeSource(areaSources(memory, area)[registerIndex] ?? 0);
  }

  /** 读一个位地址（位打包：字内 bit 0 = 编号最小的位地址） */
  function readBit(area: RegisterArea, address: number): boolean {
    return readPackedBit(areaWords(memory, area), address);
  }

  /**
   * 写一个位地址。返回 `true` 表示调用成功（值未变化时也算成功，但不产生增量事件）。
   *
   * ⚠️ 这里**不再按区域门控**：可写性已上移到调用路径 ——
   * 协议路径由功能码决定区域（FC05/15 只会落到 `coils`），
   * 界面注入路径则允许四个区（R1）。
   */
  function writeBit(area: RegisterArea, address: number, value: boolean, source: ValueSource): boolean {
    const words = areaWords(memory, area);
    if (!writePackedBit(words, address, value)) return true; // 值未变化：不产生增量事件
    markSource(area, bitAddressToRegister(address), source);
    notifyChange?.({ area, address, value: value ? 1 : 0, source });
    return true;
  }

  /** 读一个寄存器（字区 = 寄存器序号；位区 = 位地址，返回 0/1） */
  function readReg(area: RegisterArea, address: number): number {
    return areaWords(memory, area)[address] ?? 0;
  }

  /** 写一个寄存器（字区）。返回 `true` 表示调用成功（值未变化时不产生增量事件）。 */
  function writeReg(area: RegisterArea, address: number, value: number, source: ValueSource): boolean {
    const words = areaWords(memory, area);
    const next = value & 0xffff;
    if (words[address] === next) return true; // 值未变化：不产生增量事件
    words[address] = next;
    markSource(area, address, source);
    notifyChange?.({ area, address, value: next, source });
    return true;
  }

  // ── PDU processing ──

  /**
   * ⚠️ 这里的 `quantity` 是**线协议单位**：位区 = 位数，字区 = 寄存器数。
   *
   * 上限因此仍用 `MODBUS_MAX` 的原始数字；但换成「寄存器」单位后四区自动同一套
   * （读 `2000 / 125 = 125 寄存器`、写 `1968 / 123 = 123 寄存器`，见 ROADMAP §3.7）。
   */
  function processPDU(fc: number, data: Uint8Array): Uint8Array | null {
    switch (fc) {
      case MODBUS_FC.READ_COILS:
      case MODBUS_FC.READ_DISCRETE_INPUTS: {
        // data: startAddr(2) + quantity(2)
        if (data.length < 4) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const startAddr = (data[0] << 8) | data[1];
        const quantity = (data[2] << 8) | data[3];
        const area = fcToArea(fc)!;

        if (quantity < 1 || quantity > MODBUS_MAX.READ_BITS) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (!checkAddress(area, startAddr, quantity)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        const byteCount = Math.ceil(quantity / 8);
        const response = new Uint8Array(2 + byteCount); // fc + byteCount + data
        response[0] = fc;
        response[1] = byteCount;

        for (let i = 0; i < quantity; i++) {
          if (readBit(area, startAddr + i)) {
            response[2 + Math.floor(i / 8)] |= (1 << (i % 8));
          }
        }
        return response;
      }

      case MODBUS_FC.READ_HOLDING_REGISTERS:
      case MODBUS_FC.READ_INPUT_REGISTERS: {
        // data: startAddr(2) + quantity(2)
        if (data.length < 4) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const startAddr = (data[0] << 8) | data[1];
        const quantity = (data[2] << 8) | data[3];
        const area = fcToArea(fc)!;

        if (quantity < 1 || quantity > MODBUS_MAX.READ_REGISTERS) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (!checkAddress(area, startAddr, quantity)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        const response = new Uint8Array(2 + quantity * 2); // fc + byteCount + data
        response[0] = fc;
        response[1] = quantity * 2;

        for (let i = 0; i < quantity; i++) {
          const val = readReg(area, startAddr + i);
          response[2 + i * 2] = (val >> 8) & 0xff;
          response[3 + i * 2] = val & 0xff;
        }
        return response;
      }

      case MODBUS_FC.WRITE_SINGLE_COIL: {
        // data: addr(2) + value(2)
        if (data.length < 4) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const addr = (data[0] << 8) | data[1];
        const value = (data[2] << 8) | data[3];
        const area = fcToArea(fc)!;

        if (value !== 0x0000 && value !== 0xff00) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (!checkAddress(area, addr, 1)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        writeBit(area, addr, value === 0xff00, 'master');

        // Echo request
        const response = new Uint8Array(5);
        response[0] = fc;
        response[1] = data[0];
        response[2] = data[1];
        response[3] = data[2];
        response[4] = data[3];
        return response;
      }

      case MODBUS_FC.WRITE_SINGLE_REGISTER: {
        // data: addr(2) + value(2)
        if (data.length < 4) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const addr = (data[0] << 8) | data[1];
        const value = (data[2] << 8) | data[3];
        const area = fcToArea(fc)!;

        if (!checkAddress(area, addr, 1)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        writeReg(area, addr, value, 'master');

        // Echo request
        const response = new Uint8Array(5);
        response[0] = fc;
        response[1] = data[0];
        response[2] = data[1];
        response[3] = data[2];
        response[4] = data[3];
        return response;
      }

      case MODBUS_FC.WRITE_MULTIPLE_COILS: {
        // data: startAddr(2) + quantity(2) + byteCount(1) + data
        if (data.length < 5) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const startAddr = (data[0] << 8) | data[1];
        const quantity = (data[2] << 8) | data[3];
        const byteCount = data[4];
        const area = fcToArea(fc)!;

        if (quantity < 1 || quantity > MODBUS_MAX.WRITE_BITS) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (byteCount !== Math.ceil(quantity / 8)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        // 数据长度充分性：不足时报异常码，绝不靠 `?? 0` 静默补零写入内存
        if (data.length < 5 + byteCount) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (!checkAddress(area, startAddr, quantity)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        for (let i = 0; i < quantity; i++) {
          const byteIdx = Math.floor(i / 8);
          const bitIdx = i % 8;
          const bitVal = ((data[5 + byteIdx] ?? 0) >> bitIdx) & 0x01;
          writeBit(area, startAddr + i, bitVal !== 0, 'master');
        }

        // Response: fc + startAddr + quantity
        const response = new Uint8Array(5);
        response[0] = fc;
        response[1] = data[0];
        response[2] = data[1];
        response[3] = data[2];
        response[4] = data[3];
        return response;
      }

      case MODBUS_FC.WRITE_MULTIPLE_REGISTERS: {
        // data: startAddr(2) + quantity(2) + byteCount(1) + data
        if (data.length < 5) return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        const startAddr = (data[0] << 8) | data[1];
        const quantity = (data[2] << 8) | data[3];
        const byteCount = data[4];
        const area = fcToArea(fc)!;

        if (quantity < 1 || quantity > MODBUS_MAX.WRITE_REGISTERS) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (byteCount !== quantity * 2) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        // 数据长度充分性：不足时报异常码，绝不靠 `?? 0` 静默补零写入内存
        if (data.length < 5 + byteCount) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);
        }
        if (!checkAddress(area, startAddr, quantity)) {
          return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
        }

        for (let i = 0; i < quantity; i++) {
          const val = ((data[5 + i * 2] ?? 0) << 8) | (data[6 + i * 2] ?? 0);
          writeReg(area, startAddr + i, val, 'master');
        }

        // Response: fc + startAddr + quantity
        const response = new Uint8Array(5);
        response[0] = fc;
        response[1] = data[0];
        response[2] = data[1];
        response[3] = data[2];
        response[4] = data[3];
        return response;
      }

      default:
        return buildException(fc, MODBUS_EXCEPTION.ILLEGAL_FUNCTION);
    }
  }

  function buildException(fc: number, exceptionCode: number): Uint8Array {
    const response = new Uint8Array(2);
    response[0] = fc | 0x80;
    response[1] = exceptionCode;
    return response;
  }

  // ── Public: handle full request frame ──

  function handleRequest(request: Uint8Array, mode: 'rtu' | 'ascii' | 'tcp'): Uint8Array | null {
    let slaveId: number;
    let fc: number;
    let pdu: Uint8Array;
    let transactionId = 0;

    if (mode === 'tcp') {
      const decoded = tcpDecode(request);
      if (!decoded) return null;
      slaveId = decoded.slaveId;
      transactionId = decoded.transactionId;
      if (decoded.pdu.length < 1) return null;
      fc = decoded.pdu[0];
      pdu = decoded.pdu.subarray(1);
    } else if (mode === 'ascii') {
      const decoded = asciiDecode(request);
      if (!decoded || decoded.length < 2) return null;
      slaveId = decoded[0];
      fc = decoded[1];
      pdu = decoded.subarray(2);
    } else {
      // RTU：长度必须落在合法 ADU 区间内
      if (request.length < 4 || request.length > MODBUS_MAX.ADU_LENGTH) return null;
      // Check CRC
      const msgLen = request.length - 2;
      const calculatedCrc = crc16(request, msgLen);
      const receivedCrc = (request[msgLen + 1] << 8) | request[msgLen];
      if (calculatedCrc !== receivedCrc) return null;

      slaveId = request[0];
      fc = request[1];
      pdu = request.subarray(2, msgLen);
    }

    // Check slave ID - accept configured slave ID and broadcast (0)
    // For broadcast, we process but return null (no response)
    const isBroadcast = slaveId === 0;
    const matchesSlave = slaveId === config.slaveId || isBroadcast;
    if (!matchesSlave) return null;

    const responsePDU = processPDU(fc, pdu);

    if (isBroadcast) return null; // Broadcast: no response
    if (!responsePDU) return null;

    // Build response frame
    if (mode === 'tcp') {
      return tcpEncode(transactionId, slaveId, responsePDU);
    } else if (mode === 'ascii') {
      return asciiEncode(slaveId, responsePDU);
    } else {
      // RTU
      const responseLen = 1 + responsePDU.length; // slaveId + PDU
      const response = new Uint8Array(responseLen + 2); // + CRC
      response[0] = slaveId;
      response.set(responsePDU, 1);
      const crc = crc16(response, responseLen);
      response[responseLen] = crc & 0xff; // low byte first
      response[responseLen + 1] = (crc >> 8) & 0xff;
      return response;
    }
  }

  // ── Public: 视图层（⭐ 寄存器单位，Q19 / Q20）──────────────────

  /**
   * 读取窗口快照。行 `address` = **寄存器序号**；位区 `rawValue` = 按位打包的 16 位字
   * （1 字 = 16 个位地址），四个区的视图因此完全同构。
   */
  function readSnapshot(area: RegisterArea, startRegister: number, registerCount: number): RegisterData[] {
    const words = areaWords(memory, area);
    const rows: RegisterData[] = [];
    for (let i = 0; i < registerCount; i++) {
      const registerIndex = startRegister + i;
      rows.push({
        address: registerIndex,
        rawValue: words[registerIndex] ?? 0,
        source: readSource(area, registerIndex),
      });
    }
    return rows;
  }

  /**
   * 手动注入一个寄存器（R1：**不受 `isWritableArea` 门控** —— 那是协议语义）。
   *
   * 位区把 `value` 当 16 位字写入该寄存器覆盖的 16 个位地址
   * （低位 bit 0 ↔ 编号最小的位地址）。
   */
  function injectRegister(area: RegisterArea, registerIndex: number, value: number): boolean {
    return injectRange(area, registerIndex, [value]);
  }

  /**
   * 手动注入一段寄存器。先整体校验，避免"写一半才发现越界"的部分写入。
   *
   * 位区**只对真正变化的位**发增量（一个寄存器 = 16 条位地址级事件）。
   */
  function injectRange(area: RegisterArea, startRegister: number, values: number[]): boolean {
    if (values.length === 0) return false;
    if (startRegister < 0 || startRegister + values.length > areaTotalRegisters(area)) return false;

    const words = areaWords(memory, area);
    for (let i = 0; i < values.length; i++) {
      const registerIndex = startRegister + i;
      const previous = words[registerIndex] ?? 0;
      const next = values[i] & 0xffff;
      if (previous === next) continue; // 值未变化：不产生增量事件

      words[registerIndex] = next;
      markSource(area, registerIndex, 'manual');

      if (isBitArea(area)) {
        const diff = previous ^ next;
        const base = registerIndex * BITS_PER_REGISTER;
        for (let b = 0; b < BITS_PER_REGISTER; b++) {
          if (diff & (1 << b)) {
            notifyChange?.({ area, address: base + b, value: (next >> b) & 1, source: 'manual' });
          }
        }
      } else {
        notifyChange?.({ area, address: registerIndex, value: next, source: 'manual' });
      }
    }
    return true;
  }

  // ── Public: 内存层（ModBus 地址单位）───────────────────────────

  function readRegister(area: RegisterArea, address: number): number {
    if (isBitArea(area)) return readBit(area, address) ? 1 : 0;
    return readReg(area, address);
  }

  /**
   * 按**地址**写单个值（手动注入路径，R1：四个区都不受门控）。
   *
   * ⚠️ 地址校验不可省：否则越界写会被类型化数组静默丢弃，
   * 而变更检测会把"读回 undefined"误判成一次真实变更。
   */
  function writeRegister(area: RegisterArea, address: number, value: number): boolean {
    if (!checkAddress(area, address, 1)) return false;
    if (isBitArea(area)) return writeBit(area, address, value !== 0, 'manual');
    return writeReg(area, address, value, 'manual');
  }

  function readRange(area: RegisterArea, startAddress: number, quantity: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < quantity; i++) {
      result.push(readRegister(area, startAddress + i));
    }
    return result;
  }

  function writeRange(area: RegisterArea, startAddress: number, values: number[]): boolean {
    if (values.length === 0) return false;
    // 先整体校验范围，避免"写一半才发现越界"的部分写入
    if (!checkAddress(area, startAddress, values.length)) return false;
    for (let i = 0; i < values.length; i++) {
      if (!writeRegister(area, startAddress + i, values[i])) {
        return false;
      }
    }
    return true;
  }

  return {
    memory,
    config,
    handleRequest,
    readSnapshot,
    injectRegister,
    injectRange,
    readRegister,
    writeRegister,
    readRange,
    writeRange,
  };
}
