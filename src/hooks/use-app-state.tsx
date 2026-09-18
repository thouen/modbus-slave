'use client';

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  isBitArea,
  type SlaveConfig,
  type RegisterArea,
  type RegisterData,
  type LogEntry,
  type RegisterViewTab,
  type SlaveStatus,
} from '@/lib/modbus-types';
import { generateId } from '@/lib/modbus-utils';

/** localStorage 存储键 */
const STORAGE_KEY = 'modbus-slave-config';
/** 全局日志环形缓冲上限 */
const MAX_LOG_ENTRIES = 500;

export interface AppState {
  slaves: SlaveConfig[];
  slaveStatus: Record<string, SlaveStatus>;
  /**
   * 服务端**当前实际生效**的运行配置（仅运行中从站有值，不持久化）。
   * 用于判断"本地已改配置但需重启才生效"，避免界面显示一个从未生效的配置。
   */
  runningConfigs: Record<string, SlaveConfig>;
  /** 当前选中的从站 */
  activeSlaveId: string | null;
  /** 寄存器查看标签页 */
  viewTabs: RegisterViewTab[];
  activeViewTabId: string | null;
  /** 各从站的寄存器数据缓存（用于UI展示） */
  registerData: Record<string, RegisterData[]>; // viewTabId -> data
  logs: LogEntry[]; // 全局日志（按 slaveId 筛选展示）
}

export type Action =
  | { type: 'ADD_SLAVE'; payload: SlaveConfig }
  | { type: 'UPDATE_SLAVE'; payload: SlaveConfig }
  | { type: 'DELETE_SLAVE'; payload: string }
  | { type: 'SET_SLAVE_STATUS'; payload: { id: string; status: SlaveStatus } }
  | { type: 'SET_ACTIVE_SLAVE'; payload: string | null }
  | { type: 'ADD_VIEW_TAB'; payload: RegisterViewTab }
  | { type: 'UPDATE_VIEW_TAB'; payload: RegisterViewTab }
  | { type: 'DELETE_VIEW_TAB'; payload: string }
  | { type: 'SET_ACTIVE_VIEW_TAB'; payload: string }
  | { type: 'SET_REGISTER_DATA'; payload: { tabId: string; data: RegisterData[] } }
  | {
      type: 'PATCH_REGISTER_DATA';
      payload: { slaveId: string; changes: Array<{ area: RegisterArea; address: number; value: number }> };
    }
  | {
      type: 'APPLY_SERVER_SNAPSHOT';
      payload: { running: Array<{ slaveId: string; config: SlaveConfig }> };
    }
  | { type: 'SET_RUNNING_CONFIG'; payload: { id: string; config: SlaveConfig | null } }
  | { type: 'ADD_LOG'; payload: LogEntry }
  | { type: 'CLEAR_LOGS'; payload?: string } // slaveId，缺省清全部
  | { type: 'IMPORT_CONFIG'; payload: { slaves: SlaveConfig[]; strategy: 'overwrite' | 'merge' } }
  | { type: 'HYDRATE'; payload: AppState };

const initialState: AppState = {
  slaves: [],
  slaveStatus: {},
  runningConfigs: {},
  activeSlaveId: null,
  viewTabs: [],
  activeViewTabId: null,
  registerData: {},
  logs: [],
};

/**
 * 兼容旧版持久化视图标签：补齐新增字段（formatOverrides / 字节序 / 数量）。
 *
 * 返回值是显式构造的完整对象，因此旧数据里已经废弃的字段（如 `writeMode`）
 * 会被自然丢弃，无需额外清理。
 */
export function migrateViewTab(tab: Partial<RegisterViewTab>): RegisterViewTab {
  const area: RegisterArea = tab.area ?? 'holdingRegisters';
  const overrides = tab.formatOverrides;
  return {
    id: tab.id ?? generateId(),
    name: tab.name ?? '',
    slaveId: tab.slaveId ?? '',
    area,
    startAddress: tab.startAddress ?? 0,
    quantity: tab.quantity ?? 20,
    displayFormat: tab.displayFormat ?? (isBitArea(area) ? 'led' : 'hex'),
    formatOverrides:
      overrides && Object.keys(overrides).length > 0 ? overrides : undefined,
    byteOrder32: tab.byteOrder32 ?? 'ABCD',
    byteOrder64: tab.byteOrder64 ?? 'ABCDEFGH',
  };
}

/** 从 localStorage 恢复持久化配置 */
function loadPersistedState(): AppState {
  if (typeof window === 'undefined') return initialState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const slaves = parsed.slaves ?? [];
    const viewTabs = (parsed.viewTabs ?? []).map(migrateViewTab);
    return {
      ...initialState,
      slaves,
      viewTabs,
      /** 运行时状态不持久化：一律从 stopped 开始，等待服务端快照校正 */
      slaveStatus: Object.fromEntries(slaves.map(s => [s.id, 'stopped' as SlaveStatus])),
      activeSlaveId: parsed.activeSlaveId ?? null,
      activeViewTabId: parsed.activeViewTabId ?? null,
    };
  } catch {
    return initialState;
  }
}

/**
 * 导出为纯函数以便单元测试（无 DOM、无副作用，仅做状态变换）。
 */
export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_SLAVE': {
      return {
        ...state,
        slaves: [...state.slaves, action.payload],
        slaveStatus: { ...state.slaveStatus, [action.payload.id]: 'stopped' },
      };
    }
    case 'UPDATE_SLAVE': {
      return {
        ...state,
        slaves: state.slaves.map(s => s.id === action.payload.id ? action.payload : s),
      };
    }
    case 'DELETE_SLAVE': {
      const newStatus = { ...state.slaveStatus };
      delete newStatus[action.payload];
      const newRunningConfigs = { ...state.runningConfigs };
      delete newRunningConfigs[action.payload];
      // 注意方向：被删从站的标签要被移除，**其它从站**的缓存必须保留。
      // （此前这里把"剩余标签"当成"被删标签"，导致删一个从站清空别人的缓存。）
      const removedTabs = state.viewTabs.filter(t => t.slaveId === action.payload);
      const remainingTabs = state.viewTabs.filter(t => t.slaveId !== action.payload);
      const newRegisterData = { ...state.registerData };
      removedTabs.forEach(t => { delete newRegisterData[t.id]; });
      return {
        ...state,
        slaves: state.slaves.filter(s => s.id !== action.payload),
        slaveStatus: newStatus,
        runningConfigs: newRunningConfigs,
        activeSlaveId: state.activeSlaveId === action.payload ? null : state.activeSlaveId,
        viewTabs: remainingTabs,
        registerData: newRegisterData,
        activeViewTabId: remainingTabs.find(t => t.id === state.activeViewTabId)?.id ?? null,
      };
    }
    case 'SET_SLAVE_STATUS': {
      return {
        ...state,
        slaveStatus: {
          ...state.slaveStatus,
          [action.payload.id]: action.payload.status,
        },
      };
    }
    case 'SET_RUNNING_CONFIG': {
      // 记录/清除"服务端当前实际生效的运行配置"
      const runningConfigs = { ...state.runningConfigs };
      if (action.payload.config) {
        runningConfigs[action.payload.id] = action.payload.config;
      } else {
        delete runningConfigs[action.payload.id];
      }
      return { ...state, runningConfigs };
    }
    case 'APPLY_SERVER_SNAPSHOT': {
      // 服务端快照 = "运行中从站"的权威事实源，一次性完成三类校准：
      // 1) 运行中：状态置 running，配置以服务端为准（修正运行中改配置导致的两端分叉）
      // 2) 不在运行列表：状态回落 stopped（修正刷新页面后残留的 running），但保留 error 提示
      // 3) 本地不存在：补入列表（多标签页/多浏览器时能看到并停止别的客户端启动的从站）
      const { running } = action.payload;
      const runningIds = new Set(running.map((r) => r.slaveId));
      const slaves = [...state.slaves];
      const indexById = new Map<string, number>(slaves.map((s, i): [string, number] => [s.id, i]));
      const notes: LogEntry[] = [];

      for (const entry of running) {
        const idx = indexById.get(entry.slaveId);
        if (idx === undefined) {
          slaves.push(entry.config);
          indexById.set(entry.slaveId, slaves.length - 1);
          notes.push({
            id: generateId(),
            timestamp: Date.now(),
            slaveId: entry.slaveId,
            direction: 'sys',
            type: 'info',
            message: `Adopted running slave from server: ${entry.config.name}`,
          });
          continue;
        }
        if (JSON.stringify(slaves[idx]) !== JSON.stringify(entry.config)) {
          slaves[idx] = entry.config;
          notes.push({
            id: generateId(),
            timestamp: Date.now(),
            slaveId: entry.slaveId,
            direction: 'sys',
            type: 'info',
            message: 'Running config differs from local copy — synced from server',
          });
        }
      }

      let changed = notes.length > 0;
      const slaveStatus: Record<string, SlaveStatus> = { ...state.slaveStatus };
      const runningConfigs: Record<string, SlaveConfig> = {};
      for (const entry of running) {
        runningConfigs[entry.slaveId] = entry.config;
      }
      if (JSON.stringify(state.runningConfigs) !== JSON.stringify(runningConfigs)) {
        changed = true;
      }
      for (const s of slaves) {
        const nextStatus: SlaveStatus = runningIds.has(s.id)
          ? 'running'
          : slaveStatus[s.id] === 'error'
            ? 'error'
            : 'stopped';
        if (slaveStatus[s.id] !== nextStatus) {
          slaveStatus[s.id] = nextStatus;
          changed = true;
        }
      }

      if (!changed) return state;

      let logs = state.logs;
      if (notes.length > 0) {
        const merged = [...logs, ...notes];
        if (merged.length > MAX_LOG_ENTRIES) {
          merged.splice(0, merged.length - MAX_LOG_ENTRIES);
        }
        logs = merged;
      }

      return { ...state, slaves, slaveStatus, runningConfigs, logs };
    }
    case 'SET_ACTIVE_SLAVE': {
      return { ...state, activeSlaveId: action.payload };
    }
    case 'ADD_VIEW_TAB': {
      // 新建标签即绑定其从站：同步选中该从站，与 master 的 ADD_TAB 行为一致
      return {
        ...state,
        viewTabs: [...state.viewTabs, action.payload],
        activeViewTabId: action.payload.id,
        activeSlaveId: action.payload.slaveId,
      };
    }
    case 'UPDATE_VIEW_TAB': {
      return {
        ...state,
        viewTabs: state.viewTabs.map(t => t.id === action.payload.id ? action.payload : t),
      };
    }
    case 'DELETE_VIEW_TAB': {
      const newRegisterData = { ...state.registerData };
      delete newRegisterData[action.payload];
      const remaining = state.viewTabs.filter(t => t.id !== action.payload);
      return {
        ...state,
        viewTabs: remaining,
        registerData: newRegisterData,
        activeViewTabId: remaining.find(t => t.id === state.activeViewTabId)?.id
          ?? remaining[remaining.length - 1]?.id
          ?? null,
      };
    }
    case 'SET_ACTIVE_VIEW_TAB': {
      return { ...state, activeViewTabId: action.payload };
    }
    case 'SET_REGISTER_DATA': {
      return {
        ...state,
        registerData: {
          ...state.registerData,
          [action.payload.tabId]: action.payload.data,
        },
      };
    }
    case 'PATCH_REGISTER_DATA': {
      // 服务端精确增量 → 只更新"已缓存且在窗口内"的视图标签页。
      // 未读取过的标签页不做局部补丁：局部数据会让界面呈现"半真半假"的状态。
      const { slaveId, changes } = action.payload;
      if (changes.length === 0) return state;

      const registerData = { ...state.registerData };
      let mutated = false;

      for (const tab of state.viewTabs) {
        if (tab.slaveId !== slaveId) continue;
        const data = registerData[tab.id];
        if (!data || data.length === 0) continue;

        const relevant = changes.filter(
          (c) => c.area === tab.area && c.address >= tab.startAddress && c.address < tab.startAddress + tab.quantity,
        );
        if (relevant.length === 0) continue;

        let tabData = data;
        let tabMutated = false;
        for (const change of relevant) {
          const idx = tabData.findIndex((d) => d.address === change.address);
          if (idx < 0 || tabData[idx].rawValue === change.value) continue;
          if (!tabMutated) {
            tabData = [...data];
            tabMutated = true;
          }
          tabData[idx] = { address: change.address, rawValue: change.value };
        }
        if (tabMutated) {
          registerData[tab.id] = tabData;
          mutated = true;
        }
      }

      return mutated ? { ...state, registerData } : state;
    }
    case 'ADD_LOG': {
      const newLogs = [...state.logs, action.payload];
      if (newLogs.length > MAX_LOG_ENTRIES) {
        newLogs.splice(0, newLogs.length - MAX_LOG_ENTRIES);
      }
      return { ...state, logs: newLogs };
    }
    case 'CLEAR_LOGS': {
      if (!action.payload) {
        return { ...state, logs: [] };
      }
      return {
        ...state,
        logs: state.logs.filter(l => l.slaveId !== action.payload),
      };
    }
    case 'IMPORT_CONFIG': {
      if (action.payload.strategy === 'overwrite') {
        return {
          ...state,
          slaves: action.payload.slaves,
        };
      }
      // merge: by id
      const existing = new Map(state.slaves.map(s => [s.id, s]));
      for (const s of action.payload.slaves) {
        existing.set(s.id, s);
      }
      return {
        ...state,
        slaves: Array.from(existing.values()),
      };
    }
    case 'HYDRATE': {
      return action.payload;
    }
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const persisted = loadPersistedState();
    dispatch({ type: 'HYDRATE', payload: persisted });
  }, []);

  // Persist to localStorage on change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const toPersist = {
      slaves: state.slaves,
      viewTabs: state.viewTabs,
      activeSlaveId: state.activeSlaveId,
      activeViewTabId: state.activeViewTabId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
  }, [state.slaves, state.viewTabs, state.activeSlaveId, state.activeViewTabId]);

  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}

/** Helper: create default slave config */
export function createDefaultSlave(): SlaveConfig {
  return {
    id: generateId(),
    name: 'New Slave',
    protocol: 'tcp',
    mode: 'rtu',
    tcpConfig: {
      host: '0.0.0.0',
      port: 502,
    },
    slaveId: 1,
    coilCount: 100,
    discreteInputCount: 100,
    holdingRegisterCount: 100,
    inputRegisterCount: 100,
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
  };
}
