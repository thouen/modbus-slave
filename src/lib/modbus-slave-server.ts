import type { SlaveConfig, SlaveMemory, RegisterArea } from '@/lib/modbus-types';
import {
  MODBUS_FC,
  MODBUS_EXCEPTION,
  MODBUS_MAX,
  fcToArea,
  isBitFC,
  createSlaveMemory,
} from '@/lib/modbus-types';

/**
 * ModBus Slave Server - pure protocol handling
 * Handles RTU, ASCII, and TCP frame parsing and response generation.
 * Memory model is managed externally via SlaveMemory.
 */

/** 单次内存变更（area + address + 新值），用于向 UI 推送精确增量 */
export interface RegisterChange {
  area: RegisterArea;
  address: number;
  value: number;
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

  function checkAddress(area: RegisterArea, address: number, quantity: number): boolean {
    let max = 0;
    switch (area) {
      case 'coils': max = config.coilCount; break;
      case 'discreteInputs': max = config.discreteInputCount; break;
      case 'holdingRegisters': max = config.holdingRegisterCount; break;
      case 'inputRegisters': max = config.inputRegisterCount; break;
    }
    return address >= 0 && quantity > 0 && address + quantity <= max;
  }

  function readBit(area: RegisterArea, address: number): boolean {
    const arr = area === 'coils' ? memory.coils : memory.discreteInputs;
    return (arr[address] ?? 0) !== 0;
  }

  function writeBit(area: RegisterArea, address: number, value: boolean): boolean {
    if (area !== 'coils') return false; // discrete inputs are read-only
    const next = value ? 1 : 0;
    if (memory.coils[address] === next) return true; // 值未变化：不产生增量事件
    memory.coils[address] = next;
    notifyChange?.({ area, address, value: next });
    return true;
  }

  function readReg(area: RegisterArea, address: number): number {
    const arr = area === 'holdingRegisters' ? memory.holdingRegisters : memory.inputRegisters;
    return arr[address] ?? 0;
  }

  function writeReg(area: RegisterArea, address: number, value: number): boolean {
    if (area !== 'holdingRegisters') return false; // input registers are read-only
    const next = value & 0xffff;
    if (memory.holdingRegisters[address] === next) return true; // 值未变化：不产生增量事件
    memory.holdingRegisters[address] = next;
    notifyChange?.({ area, address, value: next });
    return true;
  }

  // ── PDU processing ──

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

        writeBit(area, addr, value === 0xff00);

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

        writeReg(area, addr, value);

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
          writeBit(area, startAddr + i, bitVal !== 0);
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
          writeReg(area, startAddr + i, val);
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

  // ── Public: direct memory access (for UI / WebSocket) ──

  function readRegister(area: RegisterArea, address: number): number {
    if (area === 'coils' || area === 'discreteInputs') {
      return readBit(area, address) ? 1 : 0;
    }
    return readReg(area, address);
  }

  function writeRegister(area: RegisterArea, address: number, value: number): boolean {
    // UI 写入同样必须过地址校验：否则越界写会被类型化数组静默丢弃，
    // 而变更检测会把"读回 undefined"误判成一次真实变更。
    if (!checkAddress(area, address, 1)) return false;
    if (area === 'coils') {
      return writeBit(area, address, value !== 0);
    }
    if (area === 'holdingRegisters') {
      return writeReg(area, address, value);
    }
    // discreteInputs and inputRegisters are read-only
    return false;
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
    readRegister,
    writeRegister,
    readRange,
    writeRange,
  };
}
