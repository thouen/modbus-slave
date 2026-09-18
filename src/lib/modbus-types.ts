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

/** 一个寄存器 = 16 个位地址（Q19：全系统统一以「寄存器」为单位） */
export const BITS_PER_REGISTER = 16;

/**
 * **协议**可写区域：线圈（FC05/15）/ 保持寄存器（FC06/16）。
 *
 * ⚠️ 这个谓词只描述"**主站能不能通过功能码改它**" —— 它**不等于**"界面上能不能改"。
 * 模拟器语境下四个区都必须能被操作者注入值（否则主站读输入寄存器永远是 0，
 * 这类主站逻辑根本没法测）。界面 / WS 注入路径**不做区域门控**，
 * 由 `isWritableArea` 只管协议语义（见 ROADMAP §1-R1 / §3.2）。
 */
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

/**
 * 单帧上限的「**寄存器**」口径（Q19 / Q20）。
 *
 * ⭐ 由**位区**上限除以 16 推导 ⇒ 与字区上限天然一致，永不会漂移：
 * - `2000 / 16 = 125 = MODBUS_MAX.READ_REGISTERS`
 * - `1968 / 16 = 123 = MODBUS_MAX.WRITE_REGISTERS`
 *
 * 四个区因此共用同一套读 / 写上限（这也说明"单位选对了"）。
 */
export const MAX_READ_REGISTERS_PER_FRAME = MODBUS_MAX.READ_BITS / BITS_PER_REGISTER;
export const MAX_WRITE_REGISTERS_PER_FRAME = MODBUS_MAX.WRITE_BITS / BITS_PER_REGISTER;

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
  /**
   * 线圈区**总寄存器数量**（= 文档/讨论用语里的该区 `areaTotalRegisters`）。
   * 位区按寄存器计量 ⇒ 有效位地址范围 `[0, coilCount × 16 − 1]`。
   * 字段名保持历史名称不变（Q17：只改语义与文案，不改名、不需要迁移）。
   */
  coilCount: number;
  /** 离散输入区总寄存器数量（FC02）⇒ 有效位地址范围 `[0, discreteInputCount × 16 − 1]` */
  discreteInputCount: number;
  /** 保持寄存器区总寄存器数量（FC03/06/16）⇒ 有效地址范围 `[0, holdingRegisterCount − 1]` */
  holdingRegisterCount: number;
  /** 输入寄存器区总寄存器数量（FC04）⇒ 有效地址范围 `[0, inputRegisterCount − 1]` */
  inputRegisterCount: number;
  /** Per-slave default byte order for 32-bit values */
  byteOrder32: ByteOrder32;
  /** Per-slave default byte order for 64-bit values */
  byteOrder64: ByteOrder64;
}

// ── Register Data ──

/** 值的来源（Q7）：主站功能码写入 / 界面手动注入 / 值生成器（R2 预留） */
export type ValueSource = 'master' | 'manual' | 'generator';

/** 值来源的内部编码（每寄存器 1 byte；0 = 从未写入，即初值） */
export const SOURCE_CODE: Record<ValueSource, number> = {
  master: 1,
  manual: 2,
  generator: 3,
};

/** 编码 → 来源名；`0` / 未知编码 → `null`（= 初值，界面不显示角标） */
export function decodeSource(code: number): ValueSource | null {
  switch (code) {
    case SOURCE_CODE.master:
      return 'master';
    case SOURCE_CODE.manual:
      return 'manual';
    case SOURCE_CODE.generator:
      return 'generator';
    default:
      return null;
  }
}

export interface RegisterData {
  /** ⭐ **寄存器序号**（Q20：地址一律按寄存器编号显示；位区 1 = 16 个位地址） */
  address: number;
  /** 16 位无符号原始值；位区为**按位打包的 16 位字**（1 字 = 16 个位地址） */
  rawValue: number;
  /** 值来源（Q7）；`null` / 缺省 = 从未写入（初值） */
  source?: ValueSource | null;
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

/**
 * 从站内存：**4 条 `Uint16Array`，长度一律 = 该区的 `areaTotalRegisters`**（Q18）。
 *
 * ⭐ 位区**不单独建位数组**，位打包在字里（1 字 = 16 个位地址）——
 * 与线协议"FC01/02 响应、FC15 请求本来就按位打包"一致，可成字拷贝，且省 8 倍内存。
 *
 * ⚠️ 位序：**字内 bit 0（LSB）= 该字中编号最小的位地址**。
 * 这是隐蔽 bug 的高发点，读写一律走 {@link readPackedBit} / {@link writePackedBit}，
 * **打包细节不得越过这一层边界**（对外一律仍按"位地址 → 0/1"呈现）。
 */
export interface SlaveMemory {
  /** 按位打包：`coils[address >> 4]` 的 bit `address & 0xf` = 位地址 `address` */
  coils: Uint16Array;
  discreteInputs: Uint16Array;
  holdingRegisters: Uint16Array;
  inputRegisters: Uint16Array;
  /**
   * 逐**寄存器**的值来源（Q7）。索引与上面四条数组一一对应；
   * 位区按寄存器记一个来源（= 该寄存器覆盖的 16 个位地址）。
   */
  sources: Record<RegisterArea, Uint8Array>;
}

/** 取某区的存储数组（位区即按位打包的字数组） */
export function areaWords(memory: SlaveMemory, area: RegisterArea): Uint16Array {
  return memory[area];
}

/** 取某区的值来源数组（按寄存器索引） */
export function areaSources(memory: SlaveMemory, area: RegisterArea): Uint8Array {
  return memory.sources[area];
}

/**
 * 从按位打包的字数组中读一个**位地址**。
 * ⚠️ 位序：字内 bit 0（LSB）= 编号最小的位地址（与协议"首线圈在字节最低位"一致）。
 */
export function readPackedBit(words: Uint16Array, address: number): boolean {
  const word = words[address >> 4] ?? 0;
  return ((word >> (address & 0xf)) & 1) !== 0;
}

/**
 * 把 16 位字里**字内第 `bit` 位**设为 `value` 后的新字（位序同 {@link readPackedBit}）。
 * 纯函数，供 reducer 做位级增量补丁时复用 —— 位运算细节只此一处。
 */
export function withBitSet(word: number, bit: number, value: boolean): number {
  const mask = 1 << (bit & (BITS_PER_REGISTER - 1));
  return value ? word | mask : word & ~mask;
}

/**
 * 写一个**位地址**（位序同上）。返回是否**真的发生变化**（未变化时不产生增量事件）。
 * 越界地址必须由调用方先经 `checkAddress` 拦下 —— 类型化数组的越界写会被静默丢弃。
 */
export function writePackedBit(words: Uint16Array, address: number, value: boolean): boolean {
  const index = address >> 4;
  const current = words[index] ?? 0;
  const next = withBitSet(current, address, value);
  if (current === next) return false;
  words[index] = next;
  return true;
}

/** 位地址 → 所属的寄存器序号（Q20 的显示单位） */
export function bitAddressToRegister(address: number): number {
  return address >> 4;
}

/** 位地址 → 它在该寄存器内的位序号（0..15） */
export function bitAddressToBitIndex(address: number): number {
  return address & (BITS_PER_REGISTER - 1);
}

/**
 * 「寄存器」单位 → ModBus「地址」单位（Q19 / Q20）。
 *
 * ⭐ 这是全项目**唯一**一处 ×16 换算：
 * - 字区（保持 / 输入寄存器）：1 寄存器 = 1 地址，原样返回；
 * - 位区（线圈 / 离散输入）：1 寄存器 = 16 个位地址。
 *
 * UI / 状态 / WS 一律用**寄存器**单位；只有落到协议解析与内存寻址时才经此换算。
 */
export function registerSpanToAddressSpan(
  area: RegisterArea,
  registerStart: number,
  registerCount: number,
): { start: number; count: number } {
  if (!isBitArea(area)) return { start: registerStart, count: registerCount };
  return {
    start: registerStart * BITS_PER_REGISTER,
    count: registerCount * BITS_PER_REGISTER,
  };
}

/**
 * 区域总寄存器数量的下界为 **1**（零长数组会让"数组越界"不再等价于"声明范围越界"）。
 * 非法值（NaN / 负数 / 小数）一律收敛回 1，避免运行时炸在分配处。
 */
function normalizeAreaTotal(areaTotalRegisters: number): number {
  const n = Math.floor(areaTotalRegisters);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Create empty slave memory: 4 条 `Uint16Array`，长度一律 = 该区的 `areaTotalRegisters` */
export function createSlaveMemory(config: SlaveConfig): SlaveMemory {
  const sizes: Record<RegisterArea, number> = {
    coils: normalizeAreaTotal(config.coilCount),
    discreteInputs: normalizeAreaTotal(config.discreteInputCount),
    holdingRegisters: normalizeAreaTotal(config.holdingRegisterCount),
    inputRegisters: normalizeAreaTotal(config.inputRegisterCount),
  };
  return {
    coils: new Uint16Array(sizes.coils),
    discreteInputs: new Uint16Array(sizes.discreteInputs),
    holdingRegisters: new Uint16Array(sizes.holdingRegisters),
    inputRegisters: new Uint16Array(sizes.inputRegisters),
    sources: {
      coils: new Uint8Array(sizes.coils),
      discreteInputs: new Uint8Array(sizes.discreteInputs),
      holdingRegisters: new Uint8Array(sizes.holdingRegisters),
      inputRegisters: new Uint8Array(sizes.inputRegisters),
    },
  };
}

// ── View Tab (for register viewer tabs) ──

/**
 * 视图标签：绑定一个从站 + 一块寄存器区域的读取窗口。
 *
 * 注意：**没有写入模式字段**。从站是"被写"的一方，界面上的写入是本地
 * 直接改内存（见 modbus-slave-server.ts 的 writeRegister / writeRange），
 * 不经过 FC 解析路径，因此"单点写 / 区间写"这类功能码选择在从站侧没有意义，
 * 由提交时的值数量自动决定。
 *
 * ⚠️ **可写性不由区域决定**（R1）：四个区都能被操作者注入值。
 * `isWritableArea()` 只描述"主站能不能通过 FC 改它"，与界面无关。
 */
export interface RegisterViewTab {
  id: string;
  name: string;
  /** 应用内部从站 id（非 ModBus 单元号） */
  slaveId: string;
  area: RegisterArea;
  /** ⭐ 「寄存器」单位（Q19）：从第几个寄存器开始看 */
  startAddress: number;
  /**
   * ⭐ 「寄存器」单位（Q19，原字段名 `quantity`）：覆盖几个寄存器。
   * 四个区同一含义 —— 位区 1 个寄存器 = 16 个位地址；
   * 落到线协议时位区才 `× 16`（见 `registerSpanToAddressSpan`）。
   */
  registerCount: number;
  displayFormat: DataDisplayFormat;
  /** 逐行类型映射：分组起始地址 -> 该行的显示格式（覆盖标签默认 displayFormat）。
   *  仅记录分组起始地址；32/64 位类型占用的后续地址不在此表中。 */
  formatOverrides?: Record<number, DataDisplayFormat>;
  byteOrder32: ByteOrder32;
  byteOrder64: ByteOrder64;
}
