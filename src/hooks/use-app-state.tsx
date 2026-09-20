'use client';

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  MAX_READ_REGISTERS_PER_FRAME,
  bitAddressToBitIndex,
  bitAddressToRegister,
  isBitArea,
  registerSpanToAddressSpan,
  rowNotesKey,
  withBitSet,
  type SlaveConfig,
  type RegisterArea,
  type RegisterData,
  type LogEntry,
  type RegisterViewTab,
  type RowNotes,
  type SlaveStatus,
  type ValueSource,
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
  /**
   * **行备注**（R4）：`key = slaveId:area` -> `寄存器序号 -> 备注文本`。
   *
   * ⭐ 归属是**从站实例**（= 那台"设备"），不是标签：同一台从站的同一个点，
   * 在引用它的所有标签窗口里看到的都是**同一条**备注。
   * ⚠️ 要**持久化** —— 备注是用户手录的资料，重启后必须还在。
   */
  rowNotes: RowNotes;
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
      payload: {
        slaveId: string;
        /** ⚠️ `address` 是**地址单位**（位区 = 位地址，值 0/1），见 reducer 内的接缝说明 */
        changes: Array<{ area: RegisterArea; address: number; value: number; source: ValueSource }>;
      };
    }
  | {
      type: 'APPLY_SERVER_SNAPSHOT';
      payload: { running: Array<{ slaveId: string; config: SlaveConfig }> };
    }
  | { type: 'SET_RUNNING_CONFIG'; payload: { id: string; config: SlaveConfig | null } }
  | {
      /**
       * 写一条**行备注**（R4）。
       *
       * ⚠️ `ownerId` 是**从站实例 id**（应用内部 id，**不是** ModBus 单元号）；
       * `address` 是**寄存器序号**（Q20）。`note` 去空白后为空串 ⇒ 等价于删除该条备注。
       */
      type: 'SET_ROW_NOTE';
      payload: { ownerId: string; area: RegisterArea; address: number; note: string };
    }
  | {
      /** 删除一条**行备注**（R4） */
      type: 'DELETE_ROW_NOTE';
      payload: { ownerId: string; area: RegisterArea; address: number };
    }
  | { type: 'ADD_LOG'; payload: LogEntry }
  | { type: 'CLEAR_LOGS'; payload?: string } // slaveId，缺省清全部
  | {
      type: 'IMPORT_CONFIG';
      payload: { slaves: SlaveConfig[]; rowNotes?: RowNotes; strategy: 'overwrite' | 'merge' };
    }
  | { type: 'HYDRATE'; payload: AppState };

const initialState: AppState = {
  slaves: [],
  slaveStatus: {},
  runningConfigs: {},
  activeSlaveId: null,
  viewTabs: [],
  activeViewTabId: null,
  registerData: {},
  rowNotes: {},
  logs: [],
};

/**
 * 兼容旧版持久化视图标签：补齐新增字段（formatOverrides / 数量）。
 *
 * 返回值是显式构造的完整对象，因此旧数据里已经废弃的字段（如 `writeMode`）会被自然丢弃。
 *
 * ⚠️ 旧版本标签上还带 `byteOrder32` / `byteOrder64`。字节序已改归**从站**（见 `SlaveConfig`），
 * 这两个字段随本函数**显式构造返回值而自然丢弃** —— 与 `writeMode` 同一先例。
 * **绝不要把它们上推回从站**：那会用旧标签里的值覆盖从站上的新值。
 *
 * ⚠️ **单位变更（Q19）**：数量字段由 `quantity` 改名 `registerCount`，单位也从
 * "地址个数"改为"**寄存器个数**"。旧值直接沿用 —— 字区两者等价；位区旧值按位数计，
 * 沿用后覆盖范围按寄存器解释（可能不足或多出），因此统一**夹到单帧上限 125**以内，
 * 避免旧标签带着一个 UI 上限都超出窗口的值打开。
 */
export function migrateViewTab(
  tab: Partial<RegisterViewTab> & { quantity?: number },
): RegisterViewTab {
  const area: RegisterArea = tab.area ?? 'holdingRegisters';
  const overrides = tab.formatOverrides;
  const rawCount = tab.registerCount ?? tab.quantity ?? 20;
  // ⚠️ 旧版本把 16 位位视图的类型名写作 `'led'`，现统一更名为 `'bits'`（类型名 + i18n key 同步）。
  // 旧持久化配置里存的就是 `'led'`，必须在此改写 —— 否则会带一个**已废止的联合成员**进入运行时。
  const legacyFormat: string | undefined = tab.displayFormat;
  return {
    id: tab.id ?? generateId(),
    name: tab.name ?? '',
    slaveId: tab.slaveId ?? '',
    area,
    startAddress: tab.startAddress ?? 0,
    registerCount: Math.min(MAX_READ_REGISTERS_PER_FRAME, Math.max(1, rawCount)),
    displayFormat:
      (legacyFormat === 'led' ? 'bits' : tab.displayFormat) ?? (isBitArea(area) ? 'bits' : 'hex'),
    formatOverrides:
      overrides && Object.keys(overrides).length > 0 ? overrides : undefined,
  };
}

/**
 * **纯函数**：把 localStorage 里的原始字符串解析成 `AppState`。
 *
 * 抽成纯函数是为了**可单测**：持久化往返是"静默丢数据"的高发点 ——
 * 少读一个字段在运行时完全无感（`undefined` 默默地变成默认值），只有重启后
 * 才发现用户录的资料没了。所以这一层必须有测试盯着。
 */
export function parsePersistedState(raw: string | null): AppState {
  if (!raw) return initialState;
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const slaves = parsed.slaves ?? [];
    const viewTabs = (parsed.viewTabs ?? []).map(migrateViewTab);
    return {
      ...initialState,
      slaves,
      viewTabs,
      // 行备注（R4）是用户手录的资料，必须随配置一起恢复
      rowNotes: parsed.rowNotes ?? {},
      /** 运行时状态不持久化：一律从 stopped 开始，等待服务端快照校正 */
      slaveStatus: Object.fromEntries(slaves.map(s => [s.id, 'stopped' as SlaveStatus])),
      activeSlaveId: parsed.activeSlaveId ?? null,
      activeViewTabId: parsed.activeViewTabId ?? null,
    };
  } catch {
    return initialState;
  }
}

/** 从 localStorage 恢复持久化配置 */
function loadPersistedState(): AppState {
  if (typeof window === 'undefined') return initialState;
  return parsePersistedState(localStorage.getItem(STORAGE_KEY));
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
      // 级联清理该从站的全部行备注（R4）：备注的归属是"设备"，
      // 从站都没了，`slaveId:area` 这些键就再没有主人 —— 留着只是垃圾。
      const rowNotes = Object.fromEntries(
        Object.entries(state.rowNotes).filter(([k]) => !k.startsWith(`${action.payload}:`)),
      );
      return {
        ...state,
        slaves: state.slaves.filter(s => s.id !== action.payload),
        slaveStatus: newStatus,
        runningConfigs: newRunningConfigs,
        activeSlaveId: state.activeSlaveId === action.payload ? null : state.activeSlaveId,
        viewTabs: remainingTabs,
        registerData: newRegisterData,
        rowNotes,
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
      const next = action.payload;
      const prev = state.viewTabs.find(t => t.id === next.id);
      // ⚠️ **窗口身份 = 区域 + 起始地址 + 数量**。三者任一变化，已缓存的那段数据
      // 就不再对应当前窗口，必须立即丢弃 —— 否则在新数据到达前，
      // ① 界面会把上一个区域的值当成当前区域显示；
      // ② 更危险：`submitWrite` 的"未编辑行回填"会拿旧区的值凑整段提交，
      //    把旧区的数据真写进新区（R1 后实测到的串区 bug）。
      const windowChanged =
        !prev ||
        prev.area !== next.area ||
        prev.startAddress !== next.startAddress ||
        prev.registerCount !== next.registerCount;
      const registerData = { ...state.registerData };
      if (windowChanged) delete registerData[next.id];
      return {
        ...state,
        viewTabs: state.viewTabs.map(t => (t.id === next.id ? next : t)),
        registerData,
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
      //
      // ⚠️ **两套单位的接缝就在这一处**（Q19 / Q20）：
      // · 增量 `change.address` 是**地址单位**（位区 = 位地址，值 0/1）；
      // · 标签窗口 `startAddress` / `registerCount` 是**寄存器单位**。
      // ⇒ 先用 registerSpanToAddressSpan 把窗口换算成地址段再比对；
      //    命中后，位区增量用 bitAddressToRegister 归到所在行、用 withBitSet 落位。
      const { slaveId, changes } = action.payload;
      if (changes.length === 0) return state;

      const registerData = { ...state.registerData };
      let mutated = false;

      for (const tab of state.viewTabs) {
        if (tab.slaveId !== slaveId) continue;
        const data = registerData[tab.id];
        if (!data || data.length === 0) continue;

        const span = registerSpanToAddressSpan(tab.area, tab.startAddress, tab.registerCount);
        const spanEnd = span.start + span.count;
        const relevant = changes.filter(
          (c) => c.area === tab.area && c.address >= span.start && c.address < spanEnd,
        );
        if (relevant.length === 0) continue;

        let tabData = data;
        let tabMutated = false;
        for (const change of relevant) {
          // 行按**寄存器序号**索引（位区 1 行 = 16 个位地址）
          const registerIndex = isBitArea(tab.area)
            ? bitAddressToRegister(change.address)
            : change.address;
          const idx = tabData.findIndex((d) => d.address === registerIndex);
          if (idx < 0) continue;

          const row = tabData[idx];
          const nextValue = isBitArea(tab.area)
            ? withBitSet(row.rawValue, bitAddressToBitIndex(change.address), change.value !== 0)
            : change.value;
          if (row.rawValue === nextValue && row.source === change.source) continue;

          if (!tabMutated) {
            tabData = [...data];
            tabMutated = true;
          }
          tabData[idx] = { ...row, rawValue: nextValue, source: change.source };
        }
        if (tabMutated) {
          registerData[tab.id] = tabData;
          mutated = true;
        }
      }

      return mutated ? { ...state, registerData } : state;
    }
    case 'SET_ROW_NOTE': {
      const { ownerId, area, address, note } = action.payload;
      const key = rowNotesKey(ownerId, area);
      const trimmed = note.trim();
      const bucket = state.rowNotes[key];
      const existing = bucket?.[address];

      // 去空白后为空串 ⇒ 等价于清除该条备注（不留一条"看着有、其实是空白"的备注）
      if (trimmed === '') {
        if (!bucket || existing === undefined) return state;
        const rest = { ...bucket };
        delete rest[address];
        const rowNotes = { ...state.rowNotes };
        if (Object.keys(rest).length === 0) delete rowNotes[key]; // 空桶不留在状态里
        else rowNotes[key] = rest;
        return { ...state, rowNotes };
      }

      // 无变化就直接返回原 state：避免无谓的重渲染与一次 localStorage 写入
      if (existing === trimmed) return state;

      return {
        ...state,
        rowNotes: { ...state.rowNotes, [key]: { ...(bucket ?? {}), [address]: trimmed } },
      };
    }
    case 'DELETE_ROW_NOTE': {
      const { ownerId, area, address } = action.payload;
      const key = rowNotesKey(ownerId, area);
      const bucket = state.rowNotes[key];
      if (!bucket || bucket[address] === undefined) return state;
      const rest = { ...bucket };
      delete rest[address];
      const rowNotes = { ...state.rowNotes };
      if (Object.keys(rest).length === 0) delete rowNotes[key];
      else rowNotes[key] = rest;
      return { ...state, rowNotes };
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
      const importedNotes = action.payload.rowNotes ?? {};
      if (action.payload.strategy === 'overwrite') {
        return {
          ...state,
          slaves: action.payload.slaves,
          // 覆盖：备注整块替换（导出里没有备注字段 ⇒ 视为空）
          rowNotes: importedNotes,
        };
      }
      // merge: by id（从站 id 就是备注 key 里的 ownerId ⇒ 不需要重映射）
      const existing = new Map(state.slaves.map(s => [s.id, s]));
      for (const s of action.payload.slaves) {
        existing.set(s.id, s);
      }
      return {
        ...state,
        slaves: Array.from(existing.values()),
        rowNotes: { ...state.rowNotes, ...importedNotes },
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
      rowNotes: state.rowNotes,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist));
  }, [state.slaves, state.viewTabs, state.activeSlaveId, state.activeViewTabId, state.rowNotes]);

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
    coilCount: 1000,
    discreteInputCount: 1000,
    holdingRegisterCount: 1000,
    inputRegisterCount: 1000,
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
  };
}
