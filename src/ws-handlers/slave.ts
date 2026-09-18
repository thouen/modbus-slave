import { WebSocket, type WebSocketServer } from 'ws';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'net';
import type { SlaveConfig, LogEntry, RegisterArea } from '@/lib/modbus-types';
import { createSlaveServer, type SlaveServer, type RegisterChange } from '@/lib/modbus-slave-server';
import { generateId, bytesToHex } from '@/lib/modbus-utils';

// SerialPort is optional - loaded dynamically for serial protocol support
import { MODBUS_MAX, isBitArea, bitAddressToRegister } from '@/lib/modbus-types';

/** 单个 TCP 端点允许的最大并发客户端连接数（超出直接拒绝，避免资源耗尽） */
const MAX_TCP_CONNECTIONS = 64;

let SerialPortCtor: typeof import('serialport').SerialPort | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SerialPortCtor = require('serialport').SerialPort;
} catch {
  // serialport not installed, serial mode unavailable
}

interface WsMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/** 带心跳标记的 WebSocket（协议层 ping/pong 巡检用） */
type AliveWebSocket = WebSocket & { isAlive?: boolean };

/** 运行中的从站服务器 */
interface RunningSlave {
  server: SlaveServer;
  config: SlaveConfig;
  /** TCP 端点 key（`host:port`）。一个端点上可挂载多个不同 Unit ID 的从站 */
  endpointKey?: string;
  serialPort?: any; // for Serial/RTU/ASCII (SerialPort instance)
  /** 寄存器变更收集器：协议层回调 → 缓冲 → flush 时广播 */
  changes: ChangeCollector;
}

/**
 * TCP 监听端点：**一个 host:port 只 listen 一次**，请求按 MBAP 的 Unit ID 路由到对应从站。
 * 这是 ModBus TCP 的标准形态（单端口多从站），也消除了"默认端口都是 502 → 第二个从站必然 EADDRINUSE"。
 */
interface TcpEndpoint {
  netServer: NetServer;
  /** 该端点上的全部客户端连接：netServer.close() 不会销毁它们，需显式 destroy */
  sockets: Set<Socket>;
  /** unitId → 从站内部 id */
  routes: Map<number, string>;
}

const runningSlaves = new Map<string, RunningSlave>();

/** 已监听的 TCP 端点：key = `host:port` */
const tcpEndpoints = new Map<string, TcpEndpoint>();

function endpointKeyOf(host: string, port: number): string {
  return `${host}:${port}`;
}

/** WebSocket 客户端存活巡检间隔 */
const WS_HEARTBEAT_INTERVAL_MS = 30000;

/** 已连接的 WebSocket 客户端（用于推送日志/状态） */
const wsClients = new Set<AliveWebSocket>();

/** 安全发送：连接已关闭时静默忽略，避免 sendAfterClose 抛出未捕获异常 */
function safeSend(client: WebSocket, payload: unknown) {
  if (client.readyState !== WebSocket.OPEN) return;
  try {
    client.send(JSON.stringify(payload));
  } catch {
    /* 连接已中断，忽略 */
  }
}

/** 广播给所有已连接客户端 */
function broadcast(payload: unknown) {
  for (const client of wsClients) {
    safeSend(client, payload);
  }
}

function broadcastLog(entry: LogEntry) {
  broadcast({ type: 'log_entry', payload: entry });
}

/** 状态变更与日志一样广播：多标签页/多客户端才能看到一致状态 */
function broadcastStatus(
  type: 'slave_started' | 'slave_stopped' | 'slave_error',
  payload: { slaveId: string; message?: string; config?: SlaveConfig },
) {
  broadcast({ type, payload });
}

/** 精确增量：一条消息携带本次实际发生变更的全部寄存器 */
function broadcastRegisterChanges(slaveId: string, changes: RegisterChange[]) {
  if (changes.length === 0) return;
  broadcast({ type: 'register_update', payload: { slaveId, changes } });
}

/**
 * 变更收集器：协议层回调写入缓冲，由调用方在合适时机 flush。
 *
 * 缓冲的意义：一次 FC16 写入 N 个寄存器只产生 1 条 WS 消息而非 N 条；
 * 且「无实际变化」的写入（写入相同值）不会产生任何消息。
 */
interface ChangeCollector {
  /** 与协议层 onRegisterChange 同签名，可直接透传 */
  onChange: (change: RegisterChange) => void;
  /** 广播并清空缓冲，**返回本次实际广播的变更**（供日志按来源区分措辞）；缓冲为空时不做任何事 */
  flush: () => RegisterChange[];
}

function createChangeCollector(slaveId: string): ChangeCollector {
  let pending: RegisterChange[] = [];
  return {
    onChange: (change) => {
      pending.push(change);
    },
    flush: () => {
      if (pending.length === 0) return [];
      const changes = pending;
      pending = [];
      broadcastRegisterChanges(slaveId, changes);
      return changes;
    },
  };
}

/**
 * 变更摘要（日志用）。
 *
 * ⚠️ 位区按「**位地址 → 0/1**」呈现（打包细节不外泄，见 ROADMAP §3.6），
 * 同时带上它所属的**寄存器序号** —— 与界面"地址一律按寄存器编号"的口径对齐（Q20）。
 */
function summarizeChanges(changes: RegisterChange[]): string {
  const shown = changes.slice(0, 4).map((c) => {
    if (isBitArea(c.area)) {
      return `${c.area}[bit ${c.address} = reg ${bitAddressToRegister(c.address)}] = ${c.value}`;
    }
    return `${c.area}[${c.address}] = ${c.value}`;
  });
  const rest = changes.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` …(+${rest})` : '');
}

function createLogEntry(slaveId: string, direction: 'rx' | 'tx' | 'sys', type: 'info' | 'data' | 'error', message: string, rawData?: string, functionCode?: number): LogEntry {
  return {
    id: generateId(),
    timestamp: Date.now(),
    slaveId,
    direction,
    type,
    message,
    rawData,
    functionCode,
  };
}

/** 等待 TCP 监听就绪；失败时 reject，避免 'error' 事件变成未捕获异常 */
function listenTcp(netServer: NetServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      netServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      netServer.off('error', onError);
      resolve();
    };
    netServer.once('error', onError);
    netServer.once('listening', onListening);
    netServer.listen(port, host);
  });
}

/**
 * 获取（必要时创建并监听）TCP 端点。
 *
 * 监听失败（端口占用等）通过 Promise 抛给调用方回执 UI；
 * 否则 Node 的 'error' 事件会成为未捕获异常，直接打崩服务进程。
 */
async function ensureTcpEndpoint(host: string, port: number): Promise<TcpEndpoint> {
  const key = endpointKeyOf(host, port);
  const existing = tcpEndpoints.get(key);
  if (existing) return existing;

  const netServer = createNetServer();
  const endpoint: TcpEndpoint = {
    netServer,
    sockets: new Set<Socket>(),
    routes: new Map<number, string>(),
  };

  netServer.on('connection', (socket: Socket) => {
    if (endpoint.sockets.size >= MAX_TCP_CONNECTIONS) {
      // 连接数上限：拒绝而不是无界接受，避免被大量连接拖垮进程
      socket.destroy();
      broadcastLog(
        createLogEntry(key, 'sys', 'error', `Connection rejected: ${MAX_TCP_CONNECTIONS} clients already connected`),
      );
      return;
    }

    endpoint.sockets.add(socket);
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    // 连接不属于任何单个从站：以端点 key 作为日志归属，便于按端口排查
    broadcastLog(createLogEntry(key, 'sys', 'info', `TCP client connected: ${clientAddr}`));

    let buffer = Buffer.alloc(0);

    /** 处理一帧：按 Unit ID 找到目标从站；Unit 0 为广播，作用于该端点全部从站 */
    const handleFrame = (request: Buffer) => {
      const unitId = request[6];
      const actualFc = request[7];

      const targets: Array<{ id: string; entry: RunningSlave }> = [];
      if (unitId === 0) {
        for (const id of endpoint.routes.values()) {
          const entry = runningSlaves.get(id);
          if (entry) targets.push({ id, entry });
        }
      } else {
        const id = endpoint.routes.get(unitId);
        const entry = id !== undefined ? runningSlaves.get(id) : undefined;
        if (id !== undefined && entry) targets.push({ id, entry });
      }

      if (targets.length === 0) {
        // 未配置该 Unit ID：忽略请求（不回异常帧），与网关行为一致
        broadcastLog(
          createLogEntry(key, 'sys', 'info', `Unit ${unitId} has no running slave on ${key} — request ignored`),
        );
        return;
      }

      for (const { id, entry } of targets) {
        // Log request：MBAP 共 7 字节，FC 位于索引 7
        broadcastLog(
          createLogEntry(
            id,
            'rx',
            'data',
            `FC${String(actualFc).padStart(2, '0')} from ${clientAddr} (unit ${unitId})`,
            bytesToHex(Array.from(request)),
            actualFc,
          ),
        );

        const response = entry.server.handleRequest(new Uint8Array(request), 'tcp');

        if (response) {
          socket.write(Buffer.from(response));
          broadcastLog(
            createLogEntry(id, 'tx', 'data', `Response to ${clientAddr}`, bytesToHex(Array.from(response))),
          );
        } else {
          // 广播写入不回响应，但内存已变更
          broadcastLog(
            createLogEntry(id, 'sys', 'info', `No response for unit ${unitId} (broadcast or unmatched slave ID)`),
          );
        }

        // 无论是否回响应（广播写入不回响应）都必须推送实际变更。
        // 顺带回执"实际改了什么" —— 措辞与界面手动注入区分开（Q7）。
        const applied = entry.changes.flush();
        if (applied.length > 0) {
          broadcastLog(
            createLogEntry(id, 'sys', 'data', `Master write: ${summarizeChanges(applied)}`),
          );
        }
      }
    };

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // TCP MBAP header is 7 bytes: txn(2) proto(2) len(2) unit(1)
      while (buffer.length >= 8) {
        const protocolId = buffer.readUInt16BE(2);
        const length = buffer.readUInt16BE(4);
        const totalLen = 6 + length; // MBAP(6) + length-field-contents

        // 畸形头防御：protocolId 必须为 0；length 必须覆盖 unitId+FC 且不超过 ADU 上限。
        // 不能直接照 trust length 累积缓冲，否则伪造的 length 会让 buffer 无界增长。
        if (protocolId !== 0 || length < 2 || totalLen > MODBUS_MAX.ADU_LENGTH) {
          broadcastLog(
            createLogEntry(
              key,
              'sys',
              'error',
              `Malformed MBAP header from ${clientAddr} (proto ${protocolId}, length ${length}) — connection closed`,
            ),
          );
          socket.destroy();
          return;
        }

        if (buffer.length < totalLen) break; // wait for more data

        const request = buffer.subarray(0, totalLen);
        buffer = buffer.subarray(totalLen);
        handleFrame(request);
      }
    });

    socket.on('close', () => {
      endpoint.sockets.delete(socket);
      broadcastLog(createLogEntry(key, 'sys', 'info', `TCP client disconnected: ${clientAddr}`));
    });

    socket.on('error', (err) => {
      broadcastLog(createLogEntry(key, 'sys', 'error', `TCP socket error: ${err.message}`));
    });
  });

  try {
    await listenTcp(netServer, port, host);
  } catch (err) {
    // 监听失败：释放半开资源后把错误交给调用方回执给 UI
    try {
      netServer.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  broadcastLog(createLogEntry(key, 'sys', 'info', `TCP endpoint listening on ${key}`));

  // 运行期错误（初始监听期的错误已由 listenTcp reject）：仅记录日志
  netServer.on('error', (err: Error) => {
    broadcastLog(createLogEntry(key, 'sys', 'error', `TCP server error: ${err.message}`));
  });

  tcpEndpoints.set(key, endpoint);
  return endpoint;
}

/** 释放端点：销毁残留连接并关闭监听器（仅当该端点已无任何从站挂载） */
function releaseTcpEndpoint(key: string): void {
  const endpoint = tcpEndpoints.get(key);
  if (!endpoint) return;
  // netServer.close() 只停止接受新连接，已连接的主站仍会继续被应答，必须显式 destroy
  for (const socket of endpoint.sockets) {
    socket.destroy();
  }
  endpoint.sockets.clear();
  endpoint.netServer.close();
  tcpEndpoints.delete(key);
  broadcastLog(createLogEntry(key, 'sys', 'info', `TCP endpoint stopped on ${key}`));
}

/**
 * 启动 TCP 从站：复用（必要时新建）host:port 端点，并把 Unit ID 路由到该从站。
 * 同一端点同一 Unit ID 已归属别的从站时直接抛错，由调用方回执 UI。
 */
async function startTcpSlave(
  slaveId: string,
  config: SlaveConfig,
  changes: ChangeCollector,
): Promise<{ server: SlaveServer; endpointKey: string }> {
  const host = config.tcpConfig?.host ?? '0.0.0.0';
  const port = config.tcpConfig?.port ?? 502;
  const unitId = config.slaveId;

  const endpoint = await ensureTcpEndpoint(host, port);
  const existingRoute = endpoint.routes.get(unitId);
  if (existingRoute !== undefined && existingRoute !== slaveId) {
    throw new Error(
      `Unit ID ${unitId} is already served on ${host}:${port} by another slave — change Unit ID or port`,
    );
  }

  const slaveServer = createSlaveServer(config, { onRegisterChange: changes.onChange });
  endpoint.routes.set(unitId, slaveId);

  return { server: slaveServer, endpointKey: endpointKeyOf(host, port) };
}

/**
 * 启动串口从站（RTU/ASCII）
 */
async function startSerialSlave(
  slaveId: string,
  config: SlaveConfig,
  changes: ChangeCollector,
): Promise<{ server: SlaveServer; serialPort: any }> {
  if (!SerialPortCtor) {
    throw new Error('SerialPort not available — install "serialport" package for serial protocol support');
  }
  const slaveServer = createSlaveServer(config, { onRegisterChange: changes.onChange });
  const serialConfig = config.serialConfig!;

  const serialPort = new SerialPortCtor({
    path: serialConfig.port,
    baudRate: serialConfig.baudRate,
    dataBits: serialConfig.dataBits,
    stopBits: serialConfig.stopBits,
    parity: serialConfig.parity,
    autoOpen: false,
  });

  let buffer: number[] = [];
  let lastByteTime = 0;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;

  serialPort.on('data', (data: Buffer) => {
    const now = Date.now();

    // For RTU: inter-character timeout > 1.5 char times indicates end of frame
    // For ASCII: frame ends with \r\n
    const mode = config.mode;

    if (mode === 'ascii') {
      // ASCII mode
      for (const byte of data) {
        buffer.push(byte);
        // Check for end of frame (\r\n)
        if (buffer.length >= 2 && buffer[buffer.length - 2] === 0x0d && buffer[buffer.length - 1] === 0x0a) {
          processFrame();
        }
      }
    } else {
      // RTU mode: use timeout-based framing
      buffer.push(...data);
      lastByteTime = now;

      if (frameTimer) clearTimeout(frameTimer);
      // Calculate char time in ms: ~11 bits per char
      const charTime = (11 * 1000) / serialConfig.baudRate;
      const frameGap = Math.max(charTime * 3.5, 1.75); // minimum 1.75ms

      frameTimer = setTimeout(() => {
        if (buffer.length > 0) {
          processFrame();
        }
      }, frameGap);
    }

    function processFrame() {
      const frameBytes = new Uint8Array(buffer);
      buffer = [];

      const reqLog = createLogEntry(
        slaveId,
        'rx',
        'data',
        `RTU frame received (${frameBytes.length} bytes)`,
        bytesToHex(Array.from(frameBytes)),
      );
      broadcastLog(reqLog);

      const response = slaveServer.handleRequest(frameBytes, mode);

      if (response) {
        serialPort.write(Buffer.from(response), (err?: Error) => {
          if (err) {
            const errLog = createLogEntry(slaveId, 'sys', 'error', `Serial write error: ${err.message}`);
            broadcastLog(errLog);
          } else {
            const respLog = createLogEntry(
              slaveId,
              'tx',
              'data',
              `Response sent (${response.length} bytes)`,
              bytesToHex(Array.from(response)),
            );
            broadcastLog(respLog);
          }
        });
      }

      // 串口路径同样在整帧处理完成后推送实际变更
      const serialApplied = changes.flush();
      if (serialApplied.length > 0) {
        broadcastLog(
          createLogEntry(slaveId, 'sys', 'data', `Master write: ${summarizeChanges(serialApplied)}`),
        );
      }
    }
  });

  serialPort.on('open', () => {
    const logOpen = createLogEntry(slaveId, 'sys', 'info', `Serial slave opened on ${serialConfig.port} @ ${serialConfig.baudRate}`);
    broadcastLog(logOpen);
  });

  serialPort.on('error', (err: Error) => {
    const logErr = createLogEntry(slaveId, 'sys', 'error', `Serial error: ${err.message}`);
    broadcastLog(logErr);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      serialPort.open((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    // 不能在异步回调里 throw：那会逃逸出请求处理链并打崩进程。
    // 释放半开端口后交给调用方回执给 UI。
    try {
      serialPort.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  return { server: slaveServer, serialPort };
}

/**
 * 同一从站的启停操作串行化。
 *
 * 必要性：客户端"停止 → 改配置 → 启动"是两条独立消息，
 * 若 start 的 listen 还在进行时 stop 到达，会出现"监听器已释放但条目又被写回"的泄漏。
 */
const slaveOpChains = new Map<string, Promise<void>>();

function enqueueSlaveOp(slaveId: string, op: () => Promise<void> | void): Promise<void> {
  const prev = slaveOpChains.get(slaveId) ?? Promise.resolve();
  const run = async () => {
    await op();
  };
  const next = prev.then(run, run);
  slaveOpChains.set(
    slaveId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 启动从站实例。
 *
 * 已在运行时**不会**用请求里的 config 覆盖运行态，而是回执服务端实际生效的配置：
 * 端口、单元号、内存容量都在 listen 时固定，覆盖只会让界面显示一个从未生效的值。
 */
async function startSlaveInstance(slaveId: string, config: SlaveConfig): Promise<void> {
  const running = runningSlaves.get(slaveId);
  if (running) {
    broadcastLog(
      createLogEntry(slaveId, 'sys', 'info', 'Already running — restart required to apply config changes'),
    );
    broadcastStatus('slave_started', { slaveId, config: running.config });
    return;
  }

  const changes = createChangeCollector(slaveId);
  try {
    if (config.protocol === 'tcp') {
      const started = await startTcpSlave(slaveId, config, changes);
      runningSlaves.set(slaveId, {
        server: started.server,
        config,
        endpointKey: started.endpointKey,
        changes,
      });
    } else {
      const started = await startSerialSlave(slaveId, config, changes);
      runningSlaves.set(slaveId, {
        server: started.server,
        config,
        serialPort: started.serialPort,
        changes,
      });
    }

    broadcastLog(
      createLogEntry(slaveId, 'sys', 'info', `Slave started (${config.protocol.toUpperCase()})`),
    );
    broadcastStatus('slave_started', { slaveId, config });
  } catch (err) {
    // 端口占用 / 串口打开失败等：回执给所有客户端，且不影响服务进程
    const errorMsg = err instanceof Error ? err.message : String(err);
    broadcastLog(createLogEntry(slaveId, 'sys', 'error', `Failed to start slave: ${errorMsg}`));
    broadcastStatus('slave_error', { slaveId, message: errorMsg });
  }
}

/** 停止从站实例：解除 Unit ID 路由；端点已无任何从站时才释放监听器 */
function stopSlaveInstance(slaveId: string): void {
  const entry = runningSlaves.get(slaveId);
  if (entry) {
    if (entry.endpointKey) {
      const endpoint = tcpEndpoints.get(entry.endpointKey);
      if (endpoint) {
        // 只解除本从站的路由：同一端点上其它 Unit ID 的从站必须继续被应答
        endpoint.routes.delete(entry.config.slaveId);
        if (endpoint.routes.size === 0) {
          releaseTcpEndpoint(entry.endpointKey);
        }
      }
    }
    if (entry.serialPort) {
      entry.serialPort.close();
    }
    runningSlaves.delete(slaveId);

    broadcastLog(createLogEntry(slaveId, 'sys', 'info', 'Slave stopped'));
  }
  broadcastStatus('slave_stopped', { slaveId });
}

export function setupSlaveHandler(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket) => {
    const client = ws as AliveWebSocket;
    client.isAlive = true;
    wsClients.add(client);

    // 连接建立即回放运行中的从站及其**权威配置**：
    // 只用 id 列表无法修复"运行中改配置导致两端永久分叉"，必须带上服务端实际生效的 config。
    safeSend(client, {
      type: 'slave_snapshot',
      payload: {
        running: [...runningSlaves.entries()].map(([slaveId, entry]) => ({
          slaveId,
          config: entry.config,
        })),
      },
    });

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('error', (err: Error) => {
      console.error('WS client error:', err.message);
    });

    ws.on('message', async (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend(ws, { type: 'error', payload: { message: 'Invalid JSON' } });
        return;
      }

      if (msg.type === 'ping') {
        safeSend(ws, { type: 'pong', payload: null });
        return;
      }

      try {
        switch (msg.type) {
          case 'start_slave': {
            const { slaveId, config } = msg.payload as { slaveId: string; config: SlaveConfig };
            // 串行化：避免与同一从站的 stop/restart 交错
            await enqueueSlaveOp(slaveId, () => startSlaveInstance(slaveId, config));
            break;
          }

          case 'stop_slave': {
            const { slaveId } = msg.payload as { slaveId: string };
            await enqueueSlaveOp(slaveId, () => stopSlaveInstance(slaveId));
            break;
          }

          case 'restart_slave': {
            // 运行中改配置的唯一生效途径：先停后起，且与同一从站的其它启停操作串行
            const { slaveId, config } = msg.payload as { slaveId: string; config: SlaveConfig };
            await enqueueSlaveOp(slaveId, async () => {
              stopSlaveInstance(slaveId);
              await startSlaveInstance(slaveId, config);
            });
            break;
          }

          case 'read_registers': {
            // ⭐ WS 一律用**寄存器单位**（Q19 / Q20）：`startRegister` + `registerCount`。
            // 位区的 ×16 换算收口在协议层 readSnapshot 内部，前端不感知。
            const { tabId, slaveId, area, startRegister, registerCount } = msg.payload as {
              tabId: string;
              slaveId: string;
              area: RegisterArea;
              startRegister: number;
              registerCount: number;
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              safeSend(ws, { type: 'read_response', payload: { tabId, data: [] } });
              break;
            }

            const data = entry.server.readSnapshot(area, startRegister, registerCount);

            safeSend(ws, { type: 'read_response', payload: { tabId, data } });
            break;
          }

          case 'write_register': {
            // ⭐ 寄存器单位；**不受区域门控**（R1）：四个区都能被操作者注入
            const { slaveId, area, registerIndex, value } = msg.payload as {
              slaveId: string;
              area: RegisterArea;
              registerIndex: number;
              value: number;
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              safeSend(ws, {
                type: 'write_response',
                payload: { slaveId, success: false, error: 'Slave not running' },
              });
              break;
            }

            const success = entry.server.injectRegister(area, registerIndex, value);
            if (success) {
              const applied = entry.changes.flush();
              if (applied.length > 0) {
                broadcastLog(
                  createLogEntry(slaveId, 'sys', 'data', `Manual inject: ${summarizeChanges(applied)}`),
                );
              }
            }
            safeSend(ws, {
              type: 'write_response',
              payload: success
                ? { slaveId, success }
                : {
                    slaveId,
                    success,
                    error: `Write rejected: ${area}[${registerIndex}] out of range`,
                  },
            });
            break;
          }

          case 'write_registers': {
            // ⭐ 寄存器单位区间（R1：四个区都可注入）
            const { slaveId, area, startRegister, values } = msg.payload as {
              slaveId: string;
              area: RegisterArea;
              startRegister: number;
              values: number[];
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              safeSend(ws, {
                type: 'write_response',
                payload: { slaveId, success: false, error: 'Slave not running' },
              });
              break;
            }

            const success = entry.server.injectRange(area, startRegister, values);
            if (success) {
              // 区间写入的每个变更点都由协议层逐个收集，一次 flush 全部推送
              const applied = entry.changes.flush();
              if (applied.length > 0) {
                broadcastLog(
                  createLogEntry(slaveId, 'sys', 'data', `Manual inject: ${summarizeChanges(applied)}`),
                );
              }
            }
            safeSend(ws, {
              type: 'write_response',
              payload: success
                ? { slaveId, success }
                : {
                    slaveId,
                    success,
                    error: `Write rejected: ${area}[${startRegister}..${startRegister + values.length - 1}] out of range`,
                  },
            });
            break;
          }

          default:
            safeSend(ws, { type: 'error', payload: { message: `Unknown message type: ${msg.type}` } });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        safeSend(ws, { type: 'error', payload: { message: errorMsg } });
      }
    });

    ws.on('close', () => {
      // 从站是进程级职责：客户端断开不停止从站，仅移除日志推送资格
      wsClients.delete(client);
    });
  });

  // 半开连接巡检：一个周期内未响应协议层 ping 的客户端直接断开
  const sweep = setInterval(() => {
    for (const client of [...wsClients]) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  if (typeof sweep.unref === 'function') sweep.unref();
  wss.on('close', () => clearInterval(sweep));
}
