'use client';

import { useCallback, useEffect, type Dispatch } from 'react';
import { useAppState, type Action } from '@/hooks/use-app-state';
import { slaveWs, type SlaveServerMessage, type WsConnectionState } from '@/lib/slave-ws-manager';
import type { LogEntry, RegisterArea, SlaveConfig } from '@/lib/modbus-types';
import { generateId } from '@/lib/modbus-utils';

/**
 * ── 单一 dispatch sink ────────────────────────────────────────────
 *
 * 全应用只注册「一个」消息处理器。组件只是 acquire/release 这个 sink
 * （引用计数），因此服务端每条消息只会被派发到 store 一次。
 *
 * 这修复了此前每个 useModbusWs() 实例各注册一个 handler 导致的问题：
 * 两个组件都会收到同一份 log_entry 并各自 dispatch ADD_LOG，
 * 使同一条日志（相同 id）在 store 中出现两次 —— 日志列表翻倍 +
 * React 重复 key 警告 + 顶部计数翻倍。
 */

let storeDispatch: Dispatch<Action> | null = null;
let sinkRefCount = 0;
let unsubscribeMessage: (() => void) | null = null;
let unsubscribeConnection: (() => void) | null = null;

/** 已发出但尚未获得服务端确认的启动请求（用于断线时回滚乐观状态） */
const pendingStarts = new Set<string>();

function dispatch(action: Action) {
  storeDispatch?.(action);
}

function makeLog(
  slaveId: string,
  direction: LogEntry['direction'],
  type: LogEntry['type'],
  message: string,
): LogEntry {
  return { id: generateId(), timestamp: Date.now(), slaveId, direction, type, message };
}

/** 全局错误没有 slaveId 归属，落到唯一等待中的启动请求上以保证日志可见 */
function resolveGlobalErrorTarget(): string | null {
  if (pendingStarts.size !== 1) return null;
  return [...pendingStarts][0] ?? null;
}

/** 全局唯一：服务端消息 → store action */
function handleServerMessage(msg: SlaveServerMessage) {
  switch (msg.type) {
    case 'slave_started': {
      pendingStarts.delete(msg.payload.slaveId);
      dispatch({
        type: 'SET_SLAVE_STATUS',
        payload: { id: msg.payload.slaveId, status: 'running' },
      });
      // 服务端回执的 config 才是"实际生效"的配置：本地被改过才能提示"需重启生效"
      if (msg.payload.config) {
        dispatch({
          type: 'SET_RUNNING_CONFIG',
          payload: { id: msg.payload.slaveId, config: msg.payload.config },
        });
      }
      break;
    }
    case 'slave_stopped': {
      pendingStarts.delete(msg.payload.slaveId);
      dispatch({
        type: 'SET_SLAVE_STATUS',
        payload: { id: msg.payload.slaveId, status: 'stopped' },
      });
      dispatch({
        type: 'SET_RUNNING_CONFIG',
        payload: { id: msg.payload.slaveId, config: null },
      });
      break;
    }
    case 'slave_error': {
      pendingStarts.delete(msg.payload.slaveId);
      dispatch({
        type: 'SET_SLAVE_STATUS',
        payload: { id: msg.payload.slaveId, status: 'error' },
      });
      dispatch({
        type: 'ADD_LOG',
        payload: makeLog(msg.payload.slaveId, 'sys', 'error', msg.payload.message),
      });
      break;
    }
    case 'slave_snapshot': {
      // 服务端是"运行中从站"的唯一事实源：连接/重连时用完整快照全量校准，
      // 同时修复刷新页面后的陈旧 running 状态与运行中改配置导致的两端分叉。
      for (const entry of msg.payload.running) {
        pendingStarts.delete(entry.slaveId);
      }
      dispatch({ type: 'APPLY_SERVER_SNAPSHOT', payload: { running: msg.payload.running } });
      break;
    }
    case 'log_entry': {
      dispatch({ type: 'ADD_LOG', payload: msg.payload });
      break;
    }
    case 'read_response': {
      dispatch({
        type: 'SET_REGISTER_DATA',
        payload: { tabId: msg.payload.tabId, data: msg.payload.data },
      });
      break;
    }
    case 'register_update': {
      // 服务端推送的精确增量（仅含实际变更），按地址补丁到已缓存的视图窗口。
      // 主站写入、UI 写入、广播写入都会走这条通道，不再依赖手动 Refresh。
      dispatch({
        type: 'PATCH_REGISTER_DATA',
        payload: { slaveId: msg.payload.slaveId, changes: msg.payload.changes },
      });
      break;
    }
    case 'write_response': {
      // 无 slaveId 归属，无法写入按从站筛选的日志；失败详情由日志通道反映
      if (!msg.payload.success && msg.payload.error) {
        console.error('WS write failed:', msg.payload.error);
      }
      break;
    }
    case 'error': {
      const target = resolveGlobalErrorTarget();
      if (target) {
        dispatch({ type: 'ADD_LOG', payload: makeLog(target, 'sys', 'error', msg.payload.message) });
      } else {
        console.error('WS error:', msg.payload.message);
      }
      break;
    }
  }
}

/**
 * 连接断开时回滚「启动中」的乐观状态。
 * 否则 WS 未送达时 UI 会永久停留在 starting。
 */
function handleConnectionChange(state: WsConnectionState) {
  if (state !== 'closed' || pendingStarts.size === 0) return;
  for (const slaveId of [...pendingStarts]) {
    pendingStarts.delete(slaveId);
    dispatch({ type: 'SET_SLAVE_STATUS', payload: { id: slaveId, status: 'error' } });
    dispatch({
      type: 'ADD_LOG',
      payload: makeLog(
        slaveId,
        'sys',
        'error',
        'WebSocket disconnected: start command was not delivered',
      ),
    });
  }
}

function acquireSink(dispatchFn: Dispatch<Action>) {
  sinkRefCount += 1;
  storeDispatch = dispatchFn;
  if (unsubscribeMessage) return;
  unsubscribeMessage = slaveWs.subscribe(handleServerMessage);
  unsubscribeConnection = slaveWs.subscribeConnection(handleConnectionChange);
}

function releaseSink() {
  sinkRefCount = Math.max(0, sinkRefCount - 1);
  if (sinkRefCount > 0) return;
  unsubscribeMessage?.();
  unsubscribeMessage = null;
  unsubscribeConnection?.();
  unsubscribeConnection = null;
  storeDispatch = null;
  pendingStarts.clear();
}

// ── React Hook ───────────────────────────────────────────────────

interface UseModbusWsReturn {
  startSlave: (slaveId: string, config: SlaveConfig) => void;
  stopSlave: (slaveId: string) => void;
  restartSlave: (slaveId: string, config: SlaveConfig) => void;
  readRegisters: (tabId: string, slaveId: string, area: RegisterArea, startAddress: number, quantity: number) => void;
  writeRegister: (slaveId: string, area: RegisterArea, address: number, value: number) => void;
  writeRegisters: (slaveId: string, area: RegisterArea, startAddress: number, values: number[]) => void;
}

export function useModbusWs(): UseModbusWsReturn {
  const { dispatch: appDispatch } = useAppState();

  // 引用计数式注册：多少个组件调用本 Hook 都只订阅一次。
  // dispatch 来自 useReducer，引用稳定，因此该 effect 不会反复执行。
  useEffect(() => {
    acquireSink(appDispatch);
    return releaseSink;
  }, [appDispatch]);

  const startSlave = useCallback(
    (slaveId: string, config: SlaveConfig) => {
      pendingStarts.add(slaveId);
      appDispatch({ type: 'SET_SLAVE_STATUS', payload: { id: slaveId, status: 'starting' } });
      slaveWs.startSlave(slaveId, config);
    },
    [appDispatch],
  );

  const stopSlave = useCallback((slaveId: string) => {
    pendingStarts.delete(slaveId);
    slaveWs.stopSlave(slaveId);
  }, []);

  // 运行中改配置的唯一生效途径：由服务端按"先停后起"串行执行
  const restartSlave = useCallback(
    (slaveId: string, config: SlaveConfig) => {
      pendingStarts.add(slaveId);
      appDispatch({ type: 'SET_SLAVE_STATUS', payload: { id: slaveId, status: 'starting' } });
      slaveWs.restartSlave(slaveId, config);
    },
    [appDispatch],
  );

  const readRegisters = useCallback(
    (tabId: string, slaveId: string, area: RegisterArea, startAddress: number, quantity: number) => {
      slaveWs.readRegisters(tabId, slaveId, area, startAddress, quantity);
    },
    [],
  );

  const writeRegister = useCallback(
    (slaveId: string, area: RegisterArea, address: number, value: number) => {
      slaveWs.writeRegister(slaveId, area, address, value);
    },
    [],
  );

  const writeRegisters = useCallback(
    (slaveId: string, area: RegisterArea, startAddress: number, values: number[]) => {
      slaveWs.writeRegisters(slaveId, area, startAddress, values);
    },
    [],
  );

  return { startSlave, stopSlave, restartSlave, readRegisters, writeRegister, writeRegisters };
}
