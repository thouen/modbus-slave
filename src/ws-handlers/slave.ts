import { WebSocket, type WebSocketServer } from 'ws';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'net';
import type { SlaveConfig, LogEntry, RegisterData, RegisterArea } from '@/lib/modbus-types';
import { createSlaveServer, type SlaveServer } from '@/lib/modbus-slave-server';
import { generateId, bytesToHex } from '@/lib/modbus-utils';

// SerialPort is optional - loaded dynamically for serial protocol support
let SerialPortCtor: typeof import('serialport').SerialPort | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SerialPortCtor = require('serialport').SerialPort;
} catch {
  // serialport not installed, serial mode unavailable
}

interface WsMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/** 运行中的从站服务器 */
const runningSlaves = new Map<string, {
  server: SlaveServer;
  config: SlaveConfig;
  netServer?: NetServer; // for TCP
  serialPort?: any; // for Serial/RTU/ASCII (SerialPort instance)
  serialBuffer: Uint8Array;
}>();

/** 已连接的 WebSocket 客户端（用于推送日志） */
const wsClients = new Set<WebSocket>();

function broadcastLog(entry: LogEntry) {
  const msg = JSON.stringify({ type: 'log_entry', payload: entry });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastRegisterUpdate(slaveId: string, area: string, address: number, value: number) {
  const msg = JSON.stringify({
    type: 'register_update',
    payload: { slaveId, area, address, value },
  });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
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

/**
 * 启动 TCP 从站
 */
function startTcpSlave(slaveId: string, config: SlaveConfig): { server: SlaveServer; netServer: NetServer } {
  const slaveServer = createSlaveServer(config);
  const netServer = createNetServer();

  netServer.on('connection', (socket: Socket) => {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    const log1 = createLogEntry(slaveId, 'sys', 'info', `TCP client connected: ${clientAddr}`);
    broadcastLog(log1);

    let buffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // TCP MBAP header is 7 bytes, length field at offset 4-5
      while (buffer.length >= 8) {
        const length = buffer.readUInt16BE(4);
        const totalLen = 6 + length; // MBAP(6) + length-field-contents

        if (buffer.length < totalLen) break; // wait for more data

        const request = buffer.subarray(0, totalLen);
        buffer = buffer.subarray(totalLen);

        // Log request
        const fc = request[7]; // after MBAP(7) + unitId(1)? Actually MBAP=7: txn(2)+proto(2)+len(2)+unitId(1), fc at index 7
        const actualFc = request[7];
        const reqLog = createLogEntry(
          slaveId,
          'rx',
          'data',
          `FC${String(actualFc).padStart(2, '0')} from ${clientAddr}`,
          bytesToHex(Array.from(request)),
          actualFc,
        );
        broadcastLog(reqLog);

        // Handle request
        const response = slaveServer.handleRequest(new Uint8Array(request), 'tcp');

        if (response) {
          socket.write(Buffer.from(response));
          const respLog = createLogEntry(
            slaveId,
            'tx',
            'data',
            `Response to ${clientAddr}`,
            bytesToHex(Array.from(response)),
          );
          broadcastLog(respLog);

          // Notify UI of register changes
          notifyRegisterChanges(slaveId, actualFc);
        } else {
          // No response (broadcast or unmatched slave)
          const noRespLog = createLogEntry(
            slaveId,
            'sys',
            'info',
            `No response (broadcast or unmatched slave ID) from ${clientAddr}`,
          );
          broadcastLog(noRespLog);
        }
      }
    });

    socket.on('close', () => {
      const logClose = createLogEntry(slaveId, 'sys', 'info', `TCP client disconnected: ${clientAddr}`);
      broadcastLog(logClose);
    });

    socket.on('error', (err) => {
      const logErr = createLogEntry(slaveId, 'sys', 'error', `TCP socket error: ${err.message}`);
      broadcastLog(logErr);
    });
  });

  const port = config.tcpConfig?.port ?? 502;
  const host = config.tcpConfig?.host ?? '0.0.0.0';
  netServer.listen(port, host, () => {
    const logStart = createLogEntry(slaveId, 'sys', 'info', `TCP slave listening on ${host}:${port}`);
    broadcastLog(logStart);
  });

  return { server: slaveServer, netServer };
}

/**
 * 启动串口从站（RTU/ASCII）
 */
function startSerialSlave(slaveId: string, config: SlaveConfig): { server: SlaveServer; serialPort: any } {
  if (!SerialPortCtor) {
    throw new Error('SerialPort not available — install "serialport" package for serial protocol support');
  }
  const slaveServer = createSlaveServer(config);
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

  serialPort.open((err?: Error) => {
    if (err) {
      const logErr = createLogEntry(slaveId, 'sys', 'error', `Failed to open serial port: ${err.message}`);
      broadcastLog(logErr);
      throw err;
    }
  });

  return { server: slaveServer, serialPort };
}

/**
 * 通知 UI 寄存器值的变化（写操作后）
 * 简化实现：发生写操作时，通知相关区域的变化
 */
function notifyRegisterChanges(slaveId: string, fc: number) {
  const MODBUS_FC = {
    WRITE_SINGLE_COIL: 0x05,
    WRITE_SINGLE_REGISTER: 0x06,
    WRITE_MULTIPLE_COILS: 0x0f,
    WRITE_MULTIPLE_REGISTERS: 0x10,
  };

  if (fc === MODBUS_FC.WRITE_SINGLE_COIL || fc === MODBUS_FC.WRITE_MULTIPLE_COILS) {
    broadcastRegisterUpdate(slaveId, 'coils', 0, 0); // signal refresh needed
  } else if (fc === MODBUS_FC.WRITE_SINGLE_REGISTER || fc === MODBUS_FC.WRITE_MULTIPLE_REGISTERS) {
    broadcastRegisterUpdate(slaveId, 'holdingRegisters', 0, 0);
  }
}

export function setupSlaveHandler(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket) => {
    wsClients.add(ws);

    ws.on('message', async (raw) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON' } }));
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', payload: null }));
        return;
      }

      try {
        switch (msg.type) {
          case 'start_slave': {
            const { slaveId, config } = msg.payload as { slaveId: string; config: SlaveConfig };

            if (runningSlaves.has(slaveId)) {
              ws.send(JSON.stringify({ type: 'error', payload: { message: 'Slave already running' } }));
              return;
            }

            try {
              if (config.protocol === 'tcp') {
                const { server, netServer } = startTcpSlave(slaveId, config);
                runningSlaves.set(slaveId, { server, config, netServer, serialBuffer: new Uint8Array() });
              } else {
                const { server, serialPort } = startSerialSlave(slaveId, config);
                runningSlaves.set(slaveId, { server, config, serialPort, serialBuffer: new Uint8Array() });
              }

              const entry = createLogEntry(slaveId, 'sys', 'info', `Slave started (${config.protocol.toUpperCase()})`);
              broadcastLog(entry);
              ws.send(JSON.stringify({ type: 'slave_started', payload: { slaveId } }));
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: 'slave_error', payload: { slaveId, message: errorMsg } }));
            }
            break;
          }

          case 'stop_slave': {
            const { slaveId } = msg.payload as { slaveId: string };
            const entry = runningSlaves.get(slaveId);
            if (entry) {
              if (entry.netServer) {
                entry.netServer.close();
              }
              if (entry.serialPort) {
                entry.serialPort.close();
              }
              runningSlaves.delete(slaveId);

              const logEntry = createLogEntry(slaveId, 'sys', 'info', 'Slave stopped');
              broadcastLog(logEntry);
            }
            ws.send(JSON.stringify({ type: 'slave_stopped', payload: { slaveId } }));
            break;
          }

          case 'read_registers': {
            const { tabId, slaveId, area, startAddress, quantity } = msg.payload as {
              tabId: string;
              slaveId: string;
              area: RegisterArea;
              startAddress: number;
              quantity: number;
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              ws.send(JSON.stringify({ type: 'read_response', payload: { tabId, data: [] } }));
              break;
            }

            const values = entry.server.readRange(area, startAddress, quantity);
            const data: RegisterData[] = values.map((v, i) => ({
              address: startAddress + i,
              rawValue: v,
            }));

            ws.send(JSON.stringify({ type: 'read_response', payload: { tabId, data } }));
            break;
          }

          case 'write_register': {
            const { slaveId, area, address, value } = msg.payload as {
              slaveId: string;
              area: RegisterArea;
              address: number;
              value: number;
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              ws.send(JSON.stringify({ type: 'write_response', payload: { success: false, error: 'Slave not running' } }));
              break;
            }

            const success = entry.server.writeRegister(area, address, value);
            if (success) {
              broadcastRegisterUpdate(slaveId, area, address, value);
              const logEntry = createLogEntry(
                slaveId,
                'sys',
                'data',
                `UI write: ${area}[${address}] = ${value}`,
              );
              broadcastLog(logEntry);
            }
            ws.send(JSON.stringify({ type: 'write_response', payload: { success } }));
            break;
          }

          case 'write_registers': {
            const { slaveId, area, startAddress, values } = msg.payload as {
              slaveId: string;
              area: RegisterArea;
              startAddress: number;
              values: number[];
            };

            const entry = runningSlaves.get(slaveId);
            if (!entry) {
              ws.send(JSON.stringify({ type: 'write_response', payload: { success: false, error: 'Slave not running' } }));
              break;
            }

            const success = entry.server.writeRange(area, startAddress, values);
            if (success) {
              broadcastRegisterUpdate(slaveId, area, startAddress, values[0] ?? 0);
              const logEntry = createLogEntry(
                slaveId,
                'sys',
                'data',
                `UI write: ${area}[${startAddress}..${startAddress + values.length - 1}]`,
              );
              broadcastLog(logEntry);
            }
            ws.send(JSON.stringify({ type: 'write_response', payload: { success } }));
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', payload: { message: `Unknown message type: ${msg.type}` } }));
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: 'error', payload: { message: errorMsg } }));
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });
}
