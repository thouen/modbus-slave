// ModBus Slave Protocol Types
// Reference: libmodbus (https://github.com/stephane/libmodbus)
//            Modicon Modbus Protocol Reference Guide (www.modbus.org)

export type Protocol = 'serial' | 'tcp';
export type Mode = 'ascii' | 'rtu';
export type FunctionCode = '01' | '02' | '03' | '04' | '05' | '06' | '15' | '16';

export type SlaveStatus = 'running' | 'stopped' | 'starting' | 'error';

export type ByteOrder32 = 'ABCD' | 'DCBA' | 'BADC' | 'CDAB';
export type ByteOrder64 = 'ABCDEFGH' | 'HGFEDCBA' | 'BADCFEHG' | 'GHEFCDAB';

export type DataDisplayFormat =
  | 'led'        // 1-bit LED
  | 'short'      // 16-bit signed
  | 'ushort'     // 16-bit unsigned
  | 'hex'        // 16-bit hexadecimal
  | 'binary'     // 16-bit binary
  | 'long'       // 32-bit signed integer
  | 'ulong'      // 32-bit unsigned integer
  | 'float'      // 32-bit float
  | 'double';    // 64-bit double

export type RegisterArea = 'coils' | 'discreteInputs' | 'holdingRegisters' | 'inputRegisters';

/** 位（1 bit）区域：线圈 / 离散输入 */
export function isBitArea(area: RegisterArea): boolean {
  return area === 'coils' || area === 'discreteInputs';
}

/** 字（16 bit）区域：保持寄存器 / 输入寄存器 */
export function isWordArea(area: RegisterArea): boolean {
  return area === 'holdingRegisters' || area === 'inputRegisters';
}

/** 可写区域：线圈（FC05/15）/ 保持寄存器（FC06/16） */
export function isWritableArea(area: RegisterArea): boolean {
  return area === 'coils' || area === 'holdingRegisters';
}

// ── ModBus Function Codes (from libmodbus modbus.h) ──

export const MODBUS_FC = {
  READ_COILS:                0x01,
  READ_DISCRETE_INPUTS:      0x02,
  READ_HOLDING_REGISTERS:    0x03,
  READ_INPUT_REGISTERS:      0x04,
  WRITE_SINGLE_COIL:         0x05,
  WRITE_SINGLE_REGISTER:     0x06,
  READ_EXCEPTION_STATUS:     0x07,
  WRITE_MULTIPLE_COILS:      0x0F,
  WRITE_MULTIPLE_REGISTERS:  0x10,
  REPORT_SLAVE_ID:           0x11,
  MASK_WRITE_REGISTER:       0x16,
  WRITE_AND_READ_REGISTERS:  0x17,
} as const;

// ── ModBus Protocol Limits (from Modicon Modbus Protocol Reference Guide) ──

export const MODBUS_MAX = {
  /** Max coils to read: 2000 (0x7D0) */
  READ_BITS: 2000,
  /** Max coils to write: 1968 (0x7B0) */
  WRITE_BITS: 1968,
  /** Max registers to read: 125 (0x7D) */
  READ_REGISTERS: 125,
  /** Max registers to write: 123 (0x7B) */
  WRITE_REGISTERS: 123,
  /** Max PDU length: 253 bytes (256 - slave(1) - CRC(2)) */
  PDU_LENGTH: 253,
  /** Max ADU length: 260 bytes (253 + MBAP(7)) */
  ADU_LENGTH: 260,
} as const;

// ── ModBus Exception Codes (from libmodbus modbus.h) ──

export const MODBUS_EXCEPTION = {
  ILLEGAL_FUNCTION:        0x01,
  ILLEGAL_DATA_ADDRESS:    0x02,
  ILLEGAL_DATA_VALUE:      0x03,
  SLAVE_OR_SERVER_FAILURE: 0x04,
  ACKNOWLEDGE:             0x05,
  SLAVE_OR_SERVER_BUSY:    0x06,
  NEGATIVE_ACKNOWLEDGE:    0x07,
  MEMORY_PARITY:           0x08,
  GATEWAY_PATH:            0x0A,
  GATEWAY_TARGET:          0x0B,
} as const;

/** Human-readable exception code descriptions */
export const MODBUS_EXCEPTION_MESSAGES: Record<number, string> = {
  [MODBUS_EXCEPTION.ILLEGAL_FUNCTION]:        'Illegal function (0x01)',
  [MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS]:    'Illegal data address (0x02)',
  [MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE]:      'Illegal data value (0x03)',
  [MODBUS_EXCEPTION.SLAVE_OR_SERVER_FAILURE]: 'Slave device failure (0x04)',
  [MODBUS_EXCEPTION.ACKNOWLEDGE]:             'Acknowledge (0x05)',
  [MODBUS_EXCEPTION.SLAVE_OR_SERVER_BUSY]:    'Slave device busy (0x06)',
  [MODBUS_EXCEPTION.NEGATIVE_ACKNOWLEDGE]:    'Negative acknowledge (0x07)',
  [MODBUS_EXCEPTION.MEMORY_PARITY]:           'Memory parity error (0x08)',
  [MODBUS_EXCEPTION.GATEWAY_PATH]:            'Gateway path unavailable (0x0A)',
  [MODBUS_EXCEPTION.GATEWAY_TARGET]:          'Gateway target failed to respond (0x0B)',
};

/** Get exception message from exception code */
export function getExceptionMessage(code: number): string {
  return MODBUS_EXCEPTION_MESSAGES[code] ?? `Unknown exception (0x${code.toString(16).toUpperCase().padStart(2, '0')})`;
}

/** Check if a function code is a bit/coil type */
export function isBitFC(fc: number | string): boolean {
  const code = typeof fc === 'string' ? parseInt(fc, 16) : fc;
  return code === MODBUS_FC.READ_COILS ||
         code === MODBUS_FC.READ_DISCRETE_INPUTS ||
         code === MODBUS_FC.WRITE_SINGLE_COIL ||
         code === MODBUS_FC.WRITE_MULTIPLE_COILS;
}

/** Check if a function code is a write type */
export function isWriteFC(fc: number | string): boolean {
  const code = typeof fc === 'string' ? parseInt(fc, 16) : fc;
  return code === MODBUS_FC.WRITE_SINGLE_COIL ||
         code === MODBUS_FC.WRITE_SINGLE_REGISTER ||
         code === MODBUS_FC.WRITE_MULTIPLE_COILS ||
         code === MODBUS_FC.WRITE_MULTIPLE_REGISTERS;
}

/** Check if a function code is a read type */
export function isReadFC(fc: number | string): boolean {
  return !isWriteFC(fc);
}

/** Map function code to register area */
export function fcToArea(fc: number): RegisterArea | null {
  switch (fc) {
    case MODBUS_FC.READ_COILS:
    case MODBUS_FC.WRITE_SINGLE_COIL:
    case MODBUS_FC.WRITE_MULTIPLE_COILS:
      return 'coils';
    case MODBUS_FC.READ_DISCRETE_INPUTS:
      return 'discreteInputs';
    case MODBUS_FC.READ_HOLDING_REGISTERS:
    case MODBUS_FC.WRITE_SINGLE_REGISTER:
    case MODBUS_FC.WRITE_MULTIPLE_REGISTERS:
      return 'holdingRegisters';
    case MODBUS_FC.READ_INPUT_REGISTERS:
      return 'inputRegisters';
    default:
      return null;
  }
}

// ── Slave Configuration ──

export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
}

export interface TcpConfig {
  host: string;
  port: number;
}

export interface SlaveConfig {
  id: string;
  name: string;
  protocol: Protocol;
  mode: Mode;
  serialConfig?: SerialConfig;
  tcpConfig?: TcpConfig;
  slaveId: number;
  /** 线圈数量（FC01/05/15） */
  coilCount: number;
  /** 离散输入数量（FC02） */
  discreteInputCount: number;
  /** 保持寄存器数量（FC03/06/16） */
  holdingRegisterCount: number;
  /** 输入寄存器数量（FC04） */
  inputRegisterCount: number;
  /** Per-slave default byte order for 32-bit values */
  byteOrder32: ByteOrder32;
  /** Per-slave default byte order for 64-bit values */
  byteOrder64: ByteOrder64;
}

// ── Register Data ──

export interface RegisterData {
  address: number;
  rawValue: number; // 16-bit unsigned for registers, 0/1 for coils/inputs
}

// ── Log Entry ──

export interface LogEntry {
  id: string;
  timestamp: number;
  slaveId: string;
  direction: 'rx' | 'tx' | 'sys';
  type: 'info' | 'data' | 'error';
  message: string;
  rawData?: string;
  functionCode?: number;
}

// ── Slave Memory Model (in-server representation) ──

export interface SlaveMemory {
  coils: Uint8Array;
  discreteInputs: Uint8Array;
  holdingRegisters: Uint16Array;
  inputRegisters: Uint16Array;
}

/** Create empty slave memory with given sizes */
export function createSlaveMemory(config: SlaveConfig): SlaveMemory {
  return {
    coils: new Uint8Array(Math.max(config.coilCount, 0)),
    discreteInputs: new Uint8Array(Math.max(config.discreteInputCount, 0)),
    holdingRegisters: new Uint16Array(Math.max(config.holdingRegisterCount, 0)),
    inputRegisters: new Uint16Array(Math.max(config.inputRegisterCount, 0)),
  };
}

// ── View Tab (for register viewer tabs) ──

/**
 * 视图标签：绑定一个从站 + 一块寄存器区域的读取窗口。
 *
 * 注意：**没有写入模式字段**。从站是"被写"的一方，界面上的写入是本地
 * 直接改内存（见 modbus-slave-server.ts 的 writeRegister / writeRange），
 * 不经过 FC 解析路径，因此"单点写 / 区间写"这类功能码选择在从站侧没有意义，
 * 由提交时的值数量自动决定。可写性只由区域决定（见 isWritableArea）。
 */
export interface RegisterViewTab {
  id: string;
  name: string;
  /** 应用内部从站 id（非 ModBus 单元号） */
  slaveId: string;
  area: RegisterArea;
  startAddress: number;
  quantity: number;
  displayFormat: DataDisplayFormat;
  /** 逐行类型映射：分组起始地址 -> 该行的显示格式（覆盖标签默认 displayFormat）。
   *  仅记录分组起始地址；32/64 位类型占用的后续地址不在此表中。 */
  formatOverrides?: Record<number, DataDisplayFormat>;
  byteOrder32: ByteOrder32;
  byteOrder64: ByteOrder64;
}
