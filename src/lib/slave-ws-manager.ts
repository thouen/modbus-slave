/**
 * ModBus Slave — WebSocket 连接单例管理器
 *
 * 设计要点（对应评审结论）：
 * 1. 单例：整个应用共享一条 WebSocket 连接，组件只订阅消息 / 调用动作，不各自建连。
 * 2. 归属校验：所有 socket 回调首先判断 `socket !== s` 即自我忽略，
 *    避免陈旧连接的 onclose 污染全局状态（React StrictMode 重挂载必现的竞态）。
 * 3. 引用计数：以监听器集合的 size 作为引用计数（Set 删除幂等，不会计数漂移）。
 * 4. 心跳 + pong 超时：发现半开连接（反代/NAT 静默断链）并主动重连。
 * 5. 退避重连：指数退避 + 抖动，连接成功后重置。
 * 6. 离线队列：未连接时入队（有上限），连接建立后按序补发。
 * 7. 延迟关闭：末位退订后进入宽限期再关闭，避免 StrictMode / HMR 造成的连接抖动。
 */

import type { LogEntry, RegisterArea, RegisterData, SlaveConfig, ValueSource } from '@/lib/modbus-types';

// ── 消息协议（服务端 → 客户端） ──────────────────────────────────

export type SlaveServerMessage =
  | { type: 'slave_started'; payload: { slaveId: string; config?: SlaveConfig } }
  | { type: 'slave_stopped'; payload: { slaveId: string } }
  | { type: 'slave_error'; payload: { slaveId: string; message: string } }
  | { type: 'slave_snapshot'; payload: { running: Array<{ slaveId: string; config: SlaveConfig }> } }
  | { type: 'log_entry'; payload: LogEntry }
  | {
      type: 'register_update';
      /**
       * ⚠️ `address` 是**地址单位**（位区 = 位地址、值 0/1）——
       * 换算/归行在 reducer 一处完成（Q19 的两套单位接缝）。
       */
      payload: {
        slaveId: string;
        changes: Array<{ area: RegisterArea; address: number; value: number; source: ValueSource }>;
      };
    }
  | { type: 'read_response'; payload: { tabId: string; data: RegisterData[] } }
  | { type: 'write_response'; payload: { slaveId: string; success: boolean; error?: string } }
  | { type: 'pong'; payload: null }
  | { type: 'error'; payload: { message: string } };

export type WsConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

type MessageListener = (msg: SlaveServerMessage) => void;
type ConnectionListener = (state: WsConnectionState) => void;

// ── 调优参数 ─────────────────────────────────────────────────────

const WS_PATH = '/ws/slave';
/** 心跳间隔 */
const HEARTBEAT_INTERVAL_MS = 15000;
/** 未收到 pong 的判定阈值（相对上次 pong 的时长） */
const PONG_TIMEOUT_MS = 6000;
/** 重连退避基数 / 上限 / 抖动 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_JITTER_MS = 500;
/** 离线队列上限（超出丢弃最旧的一条，防止内存无界增长） */
const QUEUE_LIMIT = 200;
/** 末位退订后的关闭宽限期 */
const IDLE_CLOSE_GRACE_MS = 1000;

// ── 单例状态（模块作用域，全应用唯一） ────────────────────────────

let socket: WebSocket | null = null;
let connectionState: WsConnectionState = 'idle';
let outgoing: string[] = [];
let reconnectAttempt = 0;
let lastPongAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

const messageListeners = new Set<MessageListener>();
const connectionListeners = new Set<ConnectionListener>();

// ── 内部工具 ─────────────────────────────────────────────────────

/** 惰性解析 WS 地址：不在模块加载期求值，避免 SSR 阶段固化空串 */
function resolveUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${WS_PATH}`;
}

/** 是否仍有人在使用这条连接 */
function hasConsumers(): boolean {
  return messageListeners.size + connectionListeners.size > 0;
}

function setState(next: WsConnectionState) {
  if (connectionState === next) return;
  connectionState = next;
  for (const listener of [...connectionListeners]) {
    listener(next);
  }
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function cancelIdleClose() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * 断开当前 socket（若有）。
 * 先清空模块级引用，使该 socket 的 onclose 因归属校验失败而自我忽略。
 */
function dropSocket() {
  const current = socket;
  socket = null;
  stopHeartbeat();
  if (current) {
    try {
      current.close();
    } catch {
      /* 关闭失败无需处理 */
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !hasConsumers()) return;
  const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  const delay = backoff + Math.random() * RECONNECT_JITTER_MS;
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** 半开连接：主动丢弃并进入重连流程 */
function forceReconnect() {
  dropSocket();
  setState('closed');
  if (hasConsumers()) scheduleReconnect();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const current = socket;
    if (!current || current.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPongAt > HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS) {
      forceReconnect();
      return;
    }
    try {
      current.send(JSON.stringify({ type: 'ping', payload: null }));
    } catch {
      forceReconnect();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function flushQueue() {
  const current = socket;
  if (!current || current.readyState !== WebSocket.OPEN) return;
  const pending = outgoing;
  outgoing = [];
  for (const raw of pending) {
    try {
      current.send(raw);
    } catch {
      // 发送失败：放回队列等待下次重连
      outgoing.push(raw);
    }
  }
}

function handleOpen() {
  reconnectAttempt = 0;
  lastPongAt = Date.now();
  setState('open');
  flushQueue();
  startHeartbeat();
}

function handleMessage(event: MessageEvent<string>) {
  if (typeof event.data !== 'string') return;
  let msg: SlaveServerMessage;
  try {
    msg = JSON.parse(event.data) as SlaveServerMessage;
  } catch {
    return; // 忽略无法解析的帧
  }
  if (msg.type === 'pong') {
    lastPongAt = Date.now();
    return;
  }
  for (const listener of [...messageListeners]) {
    listener(msg);
  }
}

function handleClose() {
  socket = null;
  stopHeartbeat();
  setState('closed');
  if (hasConsumers()) scheduleReconnect();
}

/** 建立连接（若已有可用/正在建立的连接则直接返回） */
function connect() {
  const url = resolveUrl();
  if (!url) return;
  const current = socket;
  if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
    return;
  }

  cancelReconnect();
  cancelIdleClose();
  setState('connecting');

  let next: WebSocket;
  try {
    next = new WebSocket(url);
  } catch {
    setState('closed');
    scheduleReconnect();
    return;
  }
  socket = next;

  // ★ 归属校验：只有当前持有的 socket 才能改变单例状态
  next.onopen = () => {
    if (socket !== next) return;
    handleOpen();
  };
  next.onmessage = (event: MessageEvent<string>) => {
    if (socket !== next) return;
    handleMessage(event);
  };
  next.onerror = () => {
    // 浏览器 WebSocket 出错后必定跟随 onclose，此处不做处理以免重复重连
  };
  next.onclose = () => {
    if (socket !== next) return;
    handleClose();
  };
}

/** 末位退订：进入宽限期，期间若有新订阅者则取消关闭 */
function maybeCloseWhenIdle() {
  if (hasConsumers()) {
    cancelIdleClose();
    return;
  }
  if (idleCloseTimer) return;
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (hasConsumers()) return;
    cancelReconnect();
    dropSocket();
    outgoing = [];
    setState('idle');
  }, IDLE_CLOSE_GRACE_MS);
}

/** 发送消息：已连接直接发送，否则入队并确保连接在尝试建立 */
function send(type: string, payload: unknown) {
  const raw = JSON.stringify({ type, payload });
  const current = socket;
  if (current && current.readyState === WebSocket.OPEN) {
    current.send(raw);
    return;
  }
  if (outgoing.length >= QUEUE_LIMIT) outgoing.shift();
  outgoing.push(raw);
  if (hasConsumers()) connect();
}

// ── 对外接口 ─────────────────────────────────────────────────────

export interface SlaveWsManager {
  /** 订阅服务端消息，返回取消订阅函数 */
  subscribe: (listener: MessageListener) => () => void;
  /** 订阅连接状态变化，返回取消订阅函数 */
  subscribeConnection: (listener: ConnectionListener) => () => void;
  getConnectionState: () => WsConnectionState;
  isConnected: () => boolean;

  startSlave: (slaveId: string, config: SlaveConfig) => void;
  stopSlave: (slaveId: string) => void;
  /** 运行中改配置的唯一生效途径：服务端按"先停后起"串行执行 */
  restartSlave: (slaveId: string, config: SlaveConfig) => void;
  /** ⭐ 寄存器单位（Q19 / Q20） */
  readRegisters: (
    tabId: string,
    slaveId: string,
    area: RegisterArea,
    startRegister: number,
    registerCount: number,
  ) => void;
  /** 手动注入单个寄存器（R1：不受区域门控） */
  writeRegister: (slaveId: string, area: RegisterArea, registerIndex: number, value: number) => void;
  /** 手动注入一段寄存器 */
  writeRegisters: (slaveId: string, area: RegisterArea, startRegister: number, values: number[]) => void;
}

function subscribe(listener: MessageListener): () => void {
  messageListeners.add(listener);
  cancelIdleClose();
  connect();
  return () => {
    messageListeners.delete(listener);
    maybeCloseWhenIdle();
  };
}

function subscribeConnection(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  cancelIdleClose();
  // 立即回放当前状态，避免订阅者错过建连瞬间
  listener(connectionState);
  return () => {
    connectionListeners.delete(listener);
    maybeCloseWhenIdle();
  };
}

export const slaveWs: SlaveWsManager = {
  subscribe,
  subscribeConnection,
  getConnectionState: () => connectionState,
  isConnected: () => connectionState === 'open',

  startSlave: (slaveId, config) => send('start_slave', { slaveId, config }),
  stopSlave: (slaveId) => send('stop_slave', { slaveId }),
  restartSlave: (slaveId, config) => send('restart_slave', { slaveId, config }),
  readRegisters: (tabId, slaveId, area, startRegister, registerCount) =>
    send('read_registers', { tabId, slaveId, area, startRegister, registerCount }),
  writeRegister: (slaveId, area, registerIndex, value) =>
    send('write_register', { slaveId, area, registerIndex, value }),
  writeRegisters: (slaveId, area, startRegister, values) =>
    send('write_registers', { slaveId, area, startRegister, values }),
};
