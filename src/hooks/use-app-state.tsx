'use client';

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import type {
  SlaveConfig,
  RegisterData,
  LogEntry,
  RegisterViewTab,
  SlaveStatus,
} from '@/lib/modbus-types';
import { generateId } from '@/lib/modbus-utils';

/** localStorage 存储键 */
const STORAGE_KEY = 'modbus-slave-config';
/** 全局日志环形缓冲上限 */
const MAX_LOG_ENTRIES = 500;

interface AppState {
  slaves: SlaveConfig[];
  slaveStatus: Record<string, SlaveStatus>;
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
  | { type: 'ADD_LOG'; payload: LogEntry }
  | { type: 'CLEAR_LOGS'; payload?: string } // slaveId，缺省清全部
  | { type: 'IMPORT_CONFIG'; payload: { slaves: SlaveConfig[]; strategy: 'overwrite' | 'merge' } }
  | { type: 'HYDRATE'; payload: AppState };

const initialState: AppState = {
  slaves: [],
  slaveStatus: {},
  activeSlaveId: null,
  viewTabs: [],
  activeViewTabId: null,
  registerData: {},
  logs: [],
};

/** 从 localStorage 恢复持久化配置 */
function loadPersistedState(): AppState {
  if (typeof window === 'undefined') return initialState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const slaves = parsed.slaves ?? [];
    const viewTabs = parsed.viewTabs ?? [];
    return {
      ...initialState,
      slaves,
      viewTabs,
      activeSlaveId: parsed.activeSlaveId ?? null,
      activeViewTabId: parsed.activeViewTabId ?? null,
    };
  } catch {
    return initialState;
  }
}

function reducer(state: AppState, action: Action): AppState {
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
      const deletedTabs = state.viewTabs.filter(t => t.slaveId !== action.payload);
      const newRegisterData = { ...state.registerData };
      deletedTabs.forEach(t => { delete newRegisterData[t.id]; });
      return {
        ...state,
        slaves: state.slaves.filter(s => s.id !== action.payload),
        slaveStatus: newStatus,
        activeSlaveId: state.activeSlaveId === action.payload ? null : state.activeSlaveId,
        viewTabs: deletedTabs,
        registerData: newRegisterData,
        activeViewTabId: deletedTabs.find(t => t.id === state.activeViewTabId)?.id ?? null,
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
    case 'SET_ACTIVE_SLAVE': {
      return { ...state, activeSlaveId: action.payload };
    }
    case 'ADD_VIEW_TAB': {
      return {
        ...state,
        viewTabs: [...state.viewTabs, action.payload],
        activeViewTabId: action.payload.id,
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
  const [state, dispatch] = useReducer(reducer, initialState);

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
