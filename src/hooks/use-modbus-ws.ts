'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAppState, type Action } from '@/hooks/use-app-state';
import type { SlaveConfig, LogEntry, RegisterData, SlaveStatus } from '@/lib/modbus-types';
import { generateId, bytesToHex } from '@/lib/modbus-utils';

type WsMessage =
  | { type: 'slave_started'; payload: { slaveId: string } }
  | { type: 'slave_stopped'; payload: { slaveId: string } }
  | { type: 'slave_error'; payload: { slaveId: string; message: string } }
  | { type: 'log_entry'; payload: LogEntry }
  | { type: 'register_update'; payload: { slaveId: string; area: string; address: number; value: number } }
  | { type: 'read_response'; payload: { tabId: string; data: RegisterData[] } }
  | { type: 'write_response'; payload: { success: boolean; error?: string } }
  | { type: 'pong'; payload: null }
  | { type: 'error'; payload: { message: string } };

interface UseModbusWsReturn {
  startSlave: (slaveId: string, config: SlaveConfig) => void;
  stopSlave: (slaveId: string) => void;
  readRegisters: (tabId: string, slaveId: string, area: string, startAddress: number, quantity: number) => void;
  writeRegister: (slaveId: string, area: string, address: number, value: number) => void;
  writeRegisters: (slaveId: string, area: string, startAddress: number, values: number[]) => void;
}

export function useModbusWs(): UseModbusWsReturn {
  const { dispatch } = useAppState();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageQueueRef = useRef<string[]>([]);
  const connectedRef = useRef(false);

  const sendMessage = useCallback((type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload });
    if (connectedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(msg);
    } else {
      messageQueueRef.current.push(msg);
    }
  }, []);

  const flushQueue = useCallback(() => {
    if (!connectedRef.current || !wsRef.current) return;
    while (messageQueueRef.current.length > 0) {
      const msg = messageQueueRef.current.shift();
      if (msg) wsRef.current.send(msg);
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'slave_started': {
        dispatch({
          type: 'SET_SLAVE_STATUS',
          payload: { id: msg.payload.slaveId, status: 'running' as SlaveStatus },
        });
        const logEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          slaveId: msg.payload.slaveId,
          direction: 'sys',
          type: 'info',
          message: 'Slave started successfully',
        };
        dispatch({ type: 'ADD_LOG', payload: logEntry });
        break;
      }
      case 'slave_stopped': {
        dispatch({
          type: 'SET_SLAVE_STATUS',
          payload: { id: msg.payload.slaveId, status: 'stopped' as SlaveStatus },
        });
        const logEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          slaveId: msg.payload.slaveId,
          direction: 'sys',
          type: 'info',
          message: 'Slave stopped',
        };
        dispatch({ type: 'ADD_LOG', payload: logEntry });
        break;
      }
      case 'slave_error': {
        dispatch({
          type: 'SET_SLAVE_STATUS',
          payload: { id: msg.payload.slaveId, status: 'error' as SlaveStatus },
        });
        const logEntry: LogEntry = {
          id: generateId(),
          timestamp: Date.now(),
          slaveId: msg.payload.slaveId,
          direction: 'sys',
          type: 'error',
          message: msg.payload.message,
        };
        dispatch({ type: 'ADD_LOG', payload: logEntry });
        break;
      }
      case 'log_entry': {
        dispatch({ type: 'ADD_LOG', payload: msg.payload });
        break;
      }
      case 'register_update': {
        // UI state update handled via read_response on polling
        break;
      }
      case 'read_response': {
        dispatch({
          type: 'SET_REGISTER_DATA',
          payload: { tabId: msg.payload.tabId, data: msg.payload.data },
        });
        break;
      }
      case 'write_response': {
        // handled per-request
        break;
      }
      case 'error': {
        console.error('WS error:', msg.payload.message);
        break;
      }
    }
  }, [dispatch]);

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/slave`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      connectedRef.current = true;
      flushQueue();
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      connectedRef.current = false;
      // Auto-reconnect after delay (via ref to avoid circular self-reference)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        connectRef.current();
      }, 2000);
    };

    ws.onerror = () => {
      // Error handled by onclose
    };
  }, [handleMessage, flushQueue]);

  // Keep latest connect callback in a ref for the reconnect loop.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const startSlave = useCallback((slaveId: string, config: SlaveConfig) => {
    dispatch({
      type: 'SET_SLAVE_STATUS',
      payload: { id: slaveId, status: 'starting' },
    });
    sendMessage('start_slave', { slaveId, config });
  }, [dispatch, sendMessage]);

  const stopSlave = useCallback((slaveId: string) => {
    sendMessage('stop_slave', { slaveId });
  }, [sendMessage]);

  const readRegisters = useCallback((tabId: string, slaveId: string, area: string, startAddress: number, quantity: number) => {
    sendMessage('read_registers', { tabId, slaveId, area, startAddress, quantity });
  }, [sendMessage]);

  const writeRegister = useCallback((slaveId: string, area: string, address: number, value: number) => {
    sendMessage('write_register', { slaveId, area, address, value });
  }, [sendMessage]);

  const writeRegisters = useCallback((slaveId: string, area: string, startAddress: number, values: number[]) => {
    sendMessage('write_registers', { slaveId, area, startAddress, values });
  }, [sendMessage]);

  return { startSlave, stopSlave, readRegisters, writeRegister, writeRegisters };
}
