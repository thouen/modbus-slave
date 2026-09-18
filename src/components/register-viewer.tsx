'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Upload, Radio, X } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { useAppState } from '@/hooks/use-app-state';
import { useModbusWs } from '@/hooks/use-modbus-ws';
import {
  MAX_READ_REGISTERS_PER_FRAME,
  MAX_WRITE_REGISTERS_PER_FRAME,
  isBitArea,
  isWritableArea,
  isWordArea,
  type ByteOrder32,
  type ByteOrder64,
  type DataDisplayFormat,
  type RegisterArea,
  type RegisterData,
  type RegisterViewTab,
  type ValueSource,
} from '@/lib/modbus-types';
import {
  encodeValueToRegisters,
  formatFitsAt,
  formatRegisterValue,
  generateId,
  parseDisplayValue,
  registerWindowKey,
  resolveRegisterLayout,
} from '@/lib/modbus-utils';
import type { TranslationKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** 区域选项：标签走 i18n，FC 提示为协议固定文案 */
const AREA_OPTIONS: { value: RegisterArea; labelKey: TranslationKey; fcHint: string }[] = [
  { value: 'coils', labelKey: 'coils', fcHint: 'FC01/05/15' },
  { value: 'discreteInputs', labelKey: 'discreteInputs', fcHint: 'FC02' },
  { value: 'holdingRegisters', labelKey: 'holdingRegisters', fcHint: 'FC03/06/16' },
  { value: 'inputRegisters', labelKey: 'inputRegisters', fcHint: 'FC04' },
];

/** 显示格式选项 */
const FORMAT_OPTIONS: { value: DataDisplayFormat; labelKey: TranslationKey }[] = [
  { value: 'led', labelKey: 'formatLed' },
  { value: 'short', labelKey: 'formatShort' },
  { value: 'ushort', labelKey: 'formatUShort' },
  { value: 'hex', labelKey: 'formatHex' },
  { value: 'binary', labelKey: 'formatBinary' },
  { value: 'long', labelKey: 'formatLong' },
  { value: 'ulong', labelKey: 'formatULong' },
  { value: 'float', labelKey: 'formatFloat' },
  { value: 'double', labelKey: 'formatDouble' },
];

/** Map display format to i18n key */
const FORMAT_KEY_MAP: Record<DataDisplayFormat, TranslationKey> = {
  led: 'formatLed',
  short: 'formatShort',
  ushort: 'formatUShort',
  hex: 'formatHex',
  binary: 'formatBinary',
  long: 'formatLong',
  ulong: 'formatULong',
  float: 'formatFloat',
  double: 'formatDouble',
};

/** 32 位字节序 */
const BYTE_ORDER_32: ByteOrder32[] = ['ABCD', 'BADC', 'CDAB', 'DCBA'];
/** 64 位字节序 */
const BYTE_ORDER_64: ByteOrder64[] = ['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'];

/** 按区域校验默认格式是否可用（位区域只能用 led） */
function defaultFormatForArea(area: RegisterArea, current: DataDisplayFormat): DataDisplayFormat {
  if (isBitArea(area)) return 'led';
  return current === 'led' ? 'hex' : current;
}

/**
 * 读窗口上限（Q19：**四个区统一**）。
 *
 * 由位区上限 ÷16 推导：`2000 / 16 = 125` ⇒ 位区不再单独放宽（旧代码这里是 2000，
 * 那是"地址个数"口径；单位统一为寄存器后位区也是 125）。
 */
const quantityMax = MAX_READ_REGISTERS_PER_FRAME;

/** 来源角标：颜色区分写方（Q7），文案走 i18n */
const SOURCE_STYLE: Record<ValueSource, { key: 'sourceMaster' | 'sourceManual' | 'sourceGenerator'; cls: string }> = {
  master: { key: 'sourceMaster', cls: 'bg-sky-500/15 text-sky-400' },
  manual: { key: 'sourceManual', cls: 'bg-amber-500/15 text-amber-400' },
  generator: { key: 'sourceGenerator', cls: 'bg-fuchsia-500/15 text-fuchsia-400' },
};

/** 生成默认标签名称：区域 @起始地址 */
function generateTabName(areaLabel: string, startAddress: number): string {
  return `${areaLabel} @${startAddress}`;
}

/** 格式化单个待写草稿值（16 位 / 位视图） */
function formatDraftValue(value: number, format: DataDisplayFormat): string {
  switch (format) {
    case 'hex':
      return value.toString(16).toUpperCase().padStart(4, '0');
    case 'binary':
      return value.toString(2).padStart(16, '0');
    case 'short': {
      const s = value & 0xffff;
      return String(s <= 0x7fff ? s : s - 0x10000);
    }
    case 'led':
      return Array.from({ length: 16 }, (_, i) => ((value & (1 << (15 - i))) ? '1' : '0')).join('');
    default:
      return String(value);
  }
}

/**
 * 寄存器查看器：标签栏（绑定从站）+ 配置条（内联可编辑）+ 数据表（逐行类型 + 行内编辑写入）。
 * 交互语义对齐 modbus-master：可写区域的数据格可直接编辑，暂存草稿后由「写入」整段提交。
 *
 * 与 master 的关键差异：这里没有"写功能码 / 写模式"选择。从站是被写的一方，
 * 界面写入是本地直接改内存，不经过协议栈的 FC 解析路径（详见 modbus-slave-server.ts）。
 */
export function RegisterViewer() {
  const { t } = useI18n();
  const { state, dispatch } = useAppState();
  const { readRegisters, writeRegister, writeRegisters } = useModbusWs();

  const { viewTabs, activeViewTabId, registerData, slaves, slaveStatus, activeSlaveId } = state;

  const activeTab = viewTabs.find((tab) => tab.id === activeViewTabId) ?? null;
  const boundSlave = activeTab ? slaves.find((s) => s.id === activeTab.slaveId) : undefined;
  const isRunning = activeTab ? slaveStatus[activeTab.slaveId] === 'running' : false;

  // 标签重命名编辑态
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // 行内编辑态
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [cellValue, setCellValue] = useState('');
  const [editingFormatRow, setEditingFormatRow] = useState<string | null>(null);
  // 写入草稿：**窗口身份 -> (寄存器序号 -> 待写入值)**。
  // ⚠️ 按窗口分桶，而不是一张全局表：草稿不带区域，混在一起会把上一个区的待写入值
  // 显示、甚至提交到别的区（见 ROADMAP §3.2「R1 后续修复：跨区串值」）。
  const [writeDrafts, setWriteDrafts] = useState<Record<string, Map<number, number>>>({});
  const [refreshing, setRefreshing] = useState(false);

  /** 当前窗口的草稿桶（渲染用；提交时按各自标签的窗口键取，不依赖"当前选中"） */
  //
  // ⚠️ `registerWindowKey()` **必须包在 useMemo 里，不要在渲染期直接调用**。
  // 实测：渲染期调用一个编译器无法证明纯度的模块级函数，会让 React Compiler **跳过整个组件**
  // 的编译，报 `react-hooks/preserve-manual-memoization` —— 而且报错会落在 `startRename` /
  // `commitCellEdit` / `handleRead` 等**与本次改动完全无关**的回调上（提示"推断依赖是 setEditingTabId"），
  // 极难定位。包进 useMemo 即恢复通过，同时保证"窗口身份"的格式只在 `registerWindowKey` 一处定义，
  // 不会出现两处格式串漂移。
  const writeDraft: Map<number, number> = useMemo(
    () =>
      (activeTab ? writeDrafts[registerWindowKey(activeTab)] : undefined) ??
      new Map<number, number>(),
    [activeTab, writeDrafts],
  );

  /** 读取标签窗口（⭐ 寄存器单位，Q19 / Q20） */
  const doRead = useCallback(
    (tab: RegisterViewTab) => {
      readRegisters(tab.id, tab.slaveId, tab.area, tab.startAddress, tab.registerCount);
    },
    [readRegisters],
  );

  /** 更新标签配置 */
  const updateTab = useCallback(
    (tabId: string, updates: Partial<RegisterViewTab>) => {
      const existing = viewTabs.find((tab) => tab.id === tabId);
      if (!existing) return;
      dispatch({ type: 'UPDATE_VIEW_TAB', payload: { ...existing, ...updates } });
    },
    [dispatch, viewTabs],
  );

  /** 切换标签：同时把活动从站切到该标签绑定的从站 */
  const selectTab = useCallback(
    (tab: RegisterViewTab) => {
      dispatch({ type: 'SET_ACTIVE_VIEW_TAB', payload: tab.id });
      dispatch({ type: 'SET_ACTIVE_SLAVE', payload: tab.slaveId });
    },
    [dispatch],
  );

  /** 新建标签（绑定当前选中的从站） */
  const addTab = useCallback(() => {
    const slaveId = activeSlaveId ?? slaves[0]?.id;
    const slave = slaves.find((s) => s.id === slaveId);
    if (!slave) return;
    const area: RegisterArea = 'holdingRegisters';
    const startAddress = 0;
    const tab: RegisterViewTab = {
      id: generateId(),
      name: generateTabName(t('holdingRegisters'), startAddress),
      slaveId: slave.id,
      area,
      startAddress,
      registerCount: 20,
      displayFormat: 'hex',
      byteOrder32: slave.byteOrder32,
      byteOrder64: slave.byteOrder64,
    };
    dispatch({ type: 'ADD_VIEW_TAB', payload: tab });
    // 新标签尚未进入 state，直接用其配置发起一次读取
    readRegisters(tab.id, tab.slaveId, tab.area, tab.startAddress, tab.registerCount);
  }, [activeSlaveId, slaves, dispatch, readRegisters, t]);

  /** 关闭标签 */
  const closeTab = useCallback(
    (tabId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      dispatch({ type: 'DELETE_VIEW_TAB', payload: tabId });
    },
    [dispatch],
  );

  /** 开始重命名 */
  const startRename = useCallback((tab: RegisterViewTab) => {
    setEditingTabId(tab.id);
    setEditingName(tab.name);
  }, []);

  /** 确认重命名 */
  const commitRename = useCallback(
    (tabId: string) => {
      const name = editingName.trim();
      if (name) updateTab(tabId, { name });
      setEditingTabId(null);
    },
    [editingName, updateTab],
  );

  /**
   * 行内编辑提交：暂存为草稿，不立即发送。
   * ⚠️ `registerIndex` 是**寄存器序号**（Q20）；位区一行 = 1 寄存器 = 打包后的 16 位字。
   */
  const commitCellEdit = useCallback(
    (tab: RegisterViewTab, registerIndex: number, raw: string, format: DataDisplayFormat, span: number) => {
      if (span > 1) {
        // 宽类型（32/64 位）：解析为格式化值后拆分回 span 个 16 位原始值（仅字区）
        const regs = encodeValueToRegisters(
          parseDisplayValue(raw, format),
          format,
          tab.byteOrder32,
          tab.byteOrder64,
        );
        if (regs.length !== span) {
          setEditingCell(null);
          return;
        }
        setWriteDrafts((prev) => {
          const key = registerWindowKey(tab);
          const next = new Map<number, number>(prev[key] ?? []);
          for (let i = 0; i < span; i++) next.set(registerIndex + i, regs[i]);
          return { ...prev, [key]: next };
        });
      } else {
        const num = parseDisplayValue(raw, format);
        setWriteDrafts((prev) => {
          const key = registerWindowKey(tab);
          const next = new Map<number, number>(prev[key] ?? []);
          next.set(registerIndex, num);
          return { ...prev, [key]: next };
        });
      }
      setEditingCell(null);
    },
    [],
  );

  /**
   * 缓存是否**恰好覆盖当前窗口**（行数一致 + 逐行地址对得上）。
   *
   * ⚠️ 用来挡住"串区写入"：切换区域后新数据还没回来时，`registerData[tab.id]`
   * 里可能还躺着上一个区域的整段值，而"未编辑行回填"会拿它去凑整段提交
   * ⇒ 旧区的值被写进新区。宁可拒绝提交，也不能写错地方。
   */
  const windowMatches = useCallback(
    (tab: RegisterViewTab): boolean => {
      const data = registerData[tab.id];
      if (!data || data.length !== tab.registerCount) return false;
      return data.every((d, i) => d.address === tab.startAddress + i);
    },
    [registerData],
  );

  /**
   * 整段批量提交：草稿覆盖 + 未编辑行回填原值。
   *
   * 单点写 / 区间写无需用户选择——按本次提交的值数量自动决定：1 个值用
   * `writeRegister`，多个值用 `writeRegisters`。这与真实主站的行为一致
   * （写一个点、写一段分别用对应的写功能码），而在从站侧两者最终都落到同一个内存写入。
   *
   * ⭐ **不再按区域门控**（R1）：四个区都能被操作者注入值 ——
   * 从站是被写的一方，输入寄存器这类"对主站只读"的区域，其值总得有人产生。
   * `isWritableArea()` 只用于提示"主站能不能通过 FC 改它"，与这里的可编辑性无关。
   */
  const submitWrite = useCallback(
    (tab: RegisterViewTab) => {
      if (!isRunning) return;
      // 窗口一致性守卫（见 windowMatches）：数据没到位就不提交，别拿旧窗口的值凑整段
      if (!windowMatches(tab)) return;
      const data = registerData[tab.id] ?? [];
      const count = Math.max(1, tab.registerCount);
      const key = registerWindowKey(tab);
      const draft = writeDrafts[key] ?? new Map<number, number>();
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        const registerIndex = tab.startAddress + i;
        const edited = draft.get(registerIndex);
        if (edited !== undefined) {
          values.push(edited);
        } else {
          const row = data.find((d) => d.address === registerIndex);
          values.push(row ? row.rawValue : 0);
        }
      }
      if (values.length === 1) {
        writeRegister(tab.slaveId, tab.area, tab.startAddress, values[0]);
      } else {
        writeRegisters(tab.slaveId, tab.area, tab.startAddress, values);
      }
      // 本次提交覆盖了该窗口的**全部**行，整桶清掉即可；其它窗口的草稿不受影响
      setWriteDrafts((prev) => {
        if (prev[key] === undefined) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [isRunning, registerData, writeDrafts, windowMatches, writeRegister, writeRegisters],
  );

  /** 手动读取（带短暂 loading 态） */
  const handleRead = useCallback(() => {
    if (!activeTab || !isRunning) return;
    setRefreshing(true);
    doRead(activeTab);
    setTimeout(() => setRefreshing(false), 300);
  }, [activeTab, isRunning, doRead]);

  // 切换标签 / 修改窗口配置 / 从站启动 → 自动重读。
  // 依赖按原始值拆开，避免因标签对象本身变化（如重命名）而触发多余读取。
  const activeTabItemId = activeTab?.id ?? null;
  const activeTabSlaveId = activeTab?.slaveId ?? null;
  const activeTabArea = activeTab?.area ?? null;
  const activeTabStart = activeTab?.startAddress ?? 0;
  const activeTabRegisterCount = activeTab?.registerCount ?? 0;
  useEffect(() => {
    if (!activeTabItemId || !activeTabSlaveId || !activeTabArea) return;
    if (slaveStatus[activeTabSlaveId] !== 'running') return;
    readRegisters(activeTabItemId, activeTabSlaveId, activeTabArea, activeTabStart, activeTabRegisterCount);
  }, [
    activeTabItemId,
    activeTabSlaveId,
    activeTabArea,
    activeTabStart,
    activeTabRegisterCount,
    slaveStatus,
    readRegisters,
  ]);

  // 切换标签 / 换区域 / 改窗口范围时，只清理**编辑态** —— 那几行已经不属于当前窗口了
  // （`editingCell` 的 key 是 `${地址}:${行号}`，换窗口后可能误命中别的行）。
  //
  // ⚠️ 草稿**不在这里清**。早先的写法是"换窗口即清空草稿"，虽然挡住了串区，
  // 但把"切走再切回来"的草稿也一起清掉了。现在改为草稿按**窗口身份**分桶保存
  // （见 `registerWindowKey`）：「线圈改 → 切离散 → 切回线圈」草稿原样还在，
  // 同时离散区也看不到线圈区的草稿 —— **"不串"和"不丢"是同一套机制的两面**。
  useEffect(() => {
    setEditingCell(null);
    setEditingFormatRow(null);
    setEditingTabId(null);
  }, [activeTabItemId, activeTabArea, activeTabStart, activeTabRegisterCount]);

  // 可写性只由"从站是否运行"决定：四个区对操作者一律可注入（R1）
  const canWrite = activeTab ? isRunning : false;
  // 主站能否通过功能码改这个区 —— 只用于提示，不参与界面门控（R1 的概念拆分）
  const masterCanWriteArea = activeTab ? isWritableArea(activeTab.area) : false;

  /** 该区总寄存器数量（用于窗口越界判据，四区同一套） */
  const boundSlaveAreaTotal = (() => {
    if (!activeTab || !boundSlave) return Number.POSITIVE_INFINITY;
    switch (activeTab.area) {
      case 'coils': return boundSlave.coilCount;
      case 'discreteInputs': return boundSlave.discreteInputCount;
      case 'holdingRegisters': return boundSlave.holdingRegisterCount;
      case 'inputRegisters': return boundSlave.inputRegisterCount;
    }
  })();

  // 越界判据（Q19：四区统一）：startAddress + registerCount > 该区 areaTotalRegisters
  const windowOutOfRange =
    !!activeTab && activeTab.startAddress + activeTab.registerCount > boundSlaveAreaTotal;
  // 写上限（Q19：四区统一 123 寄存器）；读上限恒为 125，输入框已 clamp
  const writeTooMany = !!activeTab && activeTab.registerCount > MAX_WRITE_REGISTERS_PER_FRAME;

  /** 只读提示：该寄存器窗口覆盖的**位范围**（Q20 的"辅助只读"） */
  const windowBitRange = activeTab
    ? `${t('bits')} ${activeTab.startAddress * 16} ~ ${(activeTab.startAddress + activeTab.registerCount) * 16 - 1}`
    : '';

  // ⭐ Q7：值来源筛选（dim 非匹配行，不改动表格结构 —— 行恒等于窗口内的寄存器）
  const [sourceFilter, setSourceFilter] = useState<'all' | ValueSource | 'none'>('all');
  const matchesSourceFilter = (row: RegisterData) => {
    if (sourceFilter === 'all') return true;
    if (sourceFilter === 'none') return !row.source;
    return row.source === sourceFilter;
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 标签栏 */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-surface px-1.5 pt-1">
        {viewTabs.length === 0 && (
          <span className="px-2 py-1 text-[10px] text-muted-foreground">{t('empty')}</span>
        )}
        {viewTabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          const isEditing = tab.id === editingTabId;
          const slaveName = slaves.find((s) => s.id === tab.slaveId)?.name ?? '—';
          return (
            <div
              key={tab.id}
              className={`group flex shrink-0 cursor-pointer items-center gap-1 rounded-t px-2 py-1 text-[10px] transition-colors ${
                isActive
                  ? 'border border-b-transparent border-border bg-card text-foreground -mb-px'
                  : 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
              }`}
              onClick={() => !isEditing && selectTab(tab)}
              onDoubleClick={() => startRename(tab)}
              title={t('renameTab')}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(tab.id);
                    if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-20 rounded border border-primary/40 bg-background px-1 py-0.5 text-[10px] text-foreground outline-none"
                />
              ) : (
                <>
                  <span className="max-w-32 truncate">{tab.name || '—'}</span>
                  <span
                    className={`max-w-24 truncate rounded px-1 py-0.5 text-[9px] leading-none ${
                      isActive ? 'bg-primary/15 text-primary' : 'bg-foreground/5 text-muted-foreground'
                    }`}
                    title={slaveName}
                  >
                    {slaveName}
                  </span>
                </>
              )}
              {!isEditing && (
                <button
                  onClick={(e) => closeTab(tab.id, e)}
                  className="rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={addTab}
          disabled={slaves.length === 0}
          className="ml-1 flex shrink-0 items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-container hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title={t('addTab')}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 配置条 */}
      {activeTab && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface px-3 py-2">
          {/* 绑定从站 */}
          <span className="inline-flex max-w-40 items-center gap-1.5 rounded border border-primary/30 bg-primary/[0.08] px-2 py-0.5 text-[11px] text-primary">
            <Radio className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium">{boundSlave?.name ?? '—'}</span>
            <span className="text-[10px] text-muted-foreground">#{boundSlave?.slaveId ?? '—'}</span>
          </span>

          {/* 区域 */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t('registerArea')}
            <Select
              value={activeTab.area}
              onValueChange={(v: RegisterArea) =>
                updateTab(activeTab.id, {
                  area: v,
                  displayFormat: defaultFormatForArea(v, activeTab.displayFormat),
                  formatOverrides: undefined,
                })
              }
            >
              <SelectTrigger className="h-6 w-44 border-border/40 bg-background px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AREA_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {`${t(opt.labelKey)} (${opt.fcHint})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {/* ⭐ R1：把"协议可写"与"界面可编辑"两个概念在界面上说清楚 */}
          {!masterCanWriteArea && (
            <span
              className="rounded border border-border/40 bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={t('masterReadOnlyHint')}
            >
              {t('masterReadOnlyHint')}
            </span>
          )}

          <span className="h-4 w-px bg-border/30" />

          {/* 起始地址（⭐ 寄存器单位；旁挂只读"起始位"提示，Q20） */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t('startAddress')}
            <Input
              type="number"
              min={0}
              max={65535}
              value={activeTab.startAddress}
              onChange={(e) => updateTab(activeTab.id, { startAddress: Number(e.target.value) || 0 })}
              className="h-6 w-20 border-border/40 bg-background px-2 text-xs"
            />
            <span className="text-[10px] text-muted-foreground/80">
              {t('startBit')} {activeTab.startAddress * 16}
            </span>
          </label>

          <span className="h-4 w-px bg-border/30" />

          {/* 寄存器数量（⭐ 寄存器单位，四区同一标签；旁挂位范围提示） */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t('registerCount')}
            <Input
              type="number"
              min={1}
              max={quantityMax}
              value={activeTab.registerCount}
              onChange={(e) =>
                updateTab(activeTab.id, {
                  registerCount: Math.min(quantityMax, Math.max(1, Number(e.target.value) || 1)),
                })
              }
              className="h-6 w-16 border-border/40 bg-background px-2 text-xs"
            />
            <span className="font-mono text-[10px] text-muted-foreground/80">{windowBitRange}</span>
          </label>

          {/* 窗口越界 / 超单帧写上限 —— 都是"提示 + 禁用提交"，不是静默截断 */}
          {windowOutOfRange && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
              {t('windowOutOfRange')}
            </span>
          )}
          {writeTooMany && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
              {t('writeTooMany')}
            </span>
          )}

          {/* 默认显示格式（可被表格逐行覆盖） */}
          <span className="hidden h-4 w-px bg-border/30 md:inline-block" />
          <label
            className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex"
            title={t('defaultFormatHint')}
          >
            {t('defaultFormat')}
            <Select
              value={activeTab.displayFormat}
              onValueChange={(v) => {
                const next = v as DataDisplayFormat;
                updateTab(activeTab.id, {
                  displayFormat: next,
                  // 默认格式变更后逐行覆盖已无意义，一并清理
                  formatOverrides: undefined,
                });
              }}
            >
              <SelectTrigger className="h-6 w-40 border-border/40 bg-background px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.filter((opt) => isWordArea(activeTab.area) || opt.value === 'led').map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} className="text-xs">
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {/* 32 位字节序 */}
          {(activeTab.displayFormat === 'long' ||
            activeTab.displayFormat === 'ulong' ||
            activeTab.displayFormat === 'float') && (
            <label className="hidden items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
              {t('byteOrder32')}
              <Select
                value={activeTab.byteOrder32}
                onValueChange={(v) => updateTab(activeTab.id, { byteOrder32: v as ByteOrder32 })}
              >
                <SelectTrigger className="h-6 w-20 border-border/40 bg-background px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BYTE_ORDER_32.map((order) => (
                    <SelectItem key={order} value={order} className="text-xs">
                      {order}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {/* 64 位字节序 */}
          {activeTab.displayFormat === 'double' && (
            <label className="hidden items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
              {t('byteOrder64')}
              <Select
                value={activeTab.byteOrder64}
                onValueChange={(v) => updateTab(activeTab.id, { byteOrder64: v as ByteOrder64 })}
              >
                <SelectTrigger className="h-6 w-24 border-border/40 bg-background px-2 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BYTE_ORDER_64.map((order) => (
                    <SelectItem key={order} value={order} className="text-xs">
                      {order}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {/* 值来源筛选（Q7）：dim 非匹配行 —— 不改变行结构（行恒等于窗口内的寄存器） */}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t('source')}
            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}
            >
              <SelectTrigger className="h-6 w-24 border-border/40 bg-background px-2 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">{t('sourceAll')}</SelectItem>
                <SelectItem value="master" className="text-xs">{t('sourceMaster')}</SelectItem>
                <SelectItem value="manual" className="text-xs">{t('sourceManual')}</SelectItem>
                <SelectItem value="generator" className="text-xs">{t('sourceGenerator')}</SelectItem>
                <SelectItem value="none" className="text-xs">{t('sourceNone')}</SelectItem>
              </SelectContent>
            </Select>
          </label>

          {/* 操作按钮 */}
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={!isRunning || windowOutOfRange}
              onClick={handleRead}
              className="h-7 border-primary/30 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/20 hover:text-primary"
            >
              <RefreshCw className={`mr-1 h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              {t('read')}
            </Button>
            {/* ⭐ R1：不再按区域门控 —— 四个区都可手动注入 */}
            <Button
              variant="outline"
              size="sm"
              disabled={!canWrite || windowOutOfRange || writeTooMany || !windowMatches(activeTab)}
              onClick={() => submitWrite(activeTab)}
              className={`h-7 border-success/40 px-2.5 text-xs ${
                writeDraft.size > 0
                  ? 'bg-success/15 text-success hover:bg-success/25'
                  : 'border-border/40 bg-surface-container text-muted-foreground hover:bg-surface-container/80'
              }`}
            >
              <Upload className="mr-1 h-3 w-3" />
              {t('write')}
            </Button>
            {!isRunning && (
              <Badge variant="outline" className="border-border/40 px-2 py-0.5 text-[10px]">
                {t('stopped')}
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* 数据表格 */}
      {activeTab ? (
        <DataTable
          tab={activeTab}
          data={registerData[activeTab.id] ?? []}
          writeDraft={writeDraft}
          onUpdate={updateTab}
          editingCell={editingCell}
          setEditingCell={setEditingCell}
          cellValue={cellValue}
          setCellValue={setCellValue}
          onCommitCellEdit={commitCellEdit}
          editingFormatRow={editingFormatRow}
          setEditingFormatRow={setEditingFormatRow}
          matchesSourceFilter={matchesSourceFilter}
          emptyHint={
            slaveStatus[activeTab.slaveId] === 'running' ? t('noDataHint') : t('slaveStoppedHint')
          }
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {slaves.length > 0 ? t('selectTabHint') : t('noSlaveSelected')}
        </div>
      )}
    </div>
  );
}

/* ========== 数据表格 ========== */

/** 16 个可点击位开关（寄存器视图的 led 格式） */
function LedBits({
  value,
  editable,
  drafted,
  onChange,
}: {
  value: number;
  editable: boolean;
  drafted: boolean;
  onChange: (raw: number) => void;
}) {
  const groups: number[][] = [
    [15, 14, 13, 12],
    [11, 10, 9, 8],
    [7, 6, 5, 4],
    [3, 2, 1, 0],
  ];
  return (
    <div className="flex items-center gap-1.5">
      {groups.map((g, gi) => (
        <div key={gi} className="flex items-center gap-0.5">
          {g.map((bit) => {
            const on = (value >> bit) & 1;
            return (
              <button
                key={bit}
                type="button"
                disabled={!editable}
                onClick={() => onChange(value ^ (1 << bit))}
                title={`bit${bit}`}
                className={`flex h-4 w-4 items-center justify-center rounded-[2px] font-mono text-[9px] leading-none transition-colors ${
                  drafted ? 'ring-1 ring-amber-400/60' : ''
                } ${
                  on ? 'bg-success text-background' : 'bg-foreground/10 text-muted-foreground'
                } ${editable ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
              >
                {on ? '1' : '0'}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DataTable({
  tab,
  data,
  writeDraft,
  onUpdate,
  editingCell,
  setEditingCell,
  cellValue,
  setCellValue,
  onCommitCellEdit,
  editingFormatRow,
  setEditingFormatRow,
  emptyHint,
  matchesSourceFilter,
}: {
  tab: RegisterViewTab;
  data: RegisterData[];
  /** ⚠️ key = **寄存器序号**（Q20） */
  writeDraft: Map<number, number>;
  onUpdate: (tabId: string, updates: Partial<RegisterViewTab>) => void;
  editingCell: string | null;
  setEditingCell: (key: string | null) => void;
  cellValue: string;
  setCellValue: (value: string) => void;
  onCommitCellEdit: (
    tab: RegisterViewTab,
    registerIndex: number,
    raw: string,
    format: DataDisplayFormat,
    span: number,
  ) => void;
  editingFormatRow: string | null;
  setEditingFormatRow: (address: string | null) => void;
  emptyHint: string;
  matchesSourceFilter: (row: RegisterData) => boolean;
}) {
  const { t } = useI18n();
  const bitArea = isBitArea(tab.area);
  const wordArea = isWordArea(tab.area);
  // ⭐ 行 = 寄存器（Q20）：四个区视图同构 —— 位区 1 行 = 1 寄存器 = 16 个位地址。
  // 可编辑性**不再看区域**（R1）：四个区都能被操作者注入值。
  const rowCount = Math.max(1, tab.registerCount);

  const rows: RegisterData[] = Array.from({ length: rowCount }, (_, i) => {
    const address = tab.startAddress + i;
    return data.find((d) => d.address === address) ?? { address, rawValue: 0 };
  });

  // 逐行类型映射：计算每个地址是分组起点还是被宽类型占用
  const layout = useMemo(
    () =>
      resolveRegisterLayout({
        startAddress: tab.startAddress,
        quantity: rowCount,
        isWordType: wordArea,
        defaultFormat: tab.displayFormat,
        formatOverrides: tab.formatOverrides,
      }),
    [tab.startAddress, rowCount, wordArea, tab.displayFormat, tab.formatOverrides],
  );

  const hasWideGroup = Array.from(layout.values()).some((r) => r.role === 'start' && r.span > 1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data.length === 0 && (
        <div className="shrink-0 border-b border-border/20 px-3 py-1 text-[10px] text-muted-foreground/60">
          {emptyHint}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border/30 bg-surface-container/90 backdrop-blur">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('address')}</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('rawHex')}</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('rawDec')}</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('dataType')}</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                {t('formattedValue')}
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('source')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, index) => {
              const cellKey = `${item.address}:${index}`;
              const isEditingThis = editingCell === cellKey;
              const formatEditing = editingFormatRow === String(item.address);
              const res = layout.get(item.address);
              const isGroupStart = res?.role === 'start' || !res;
              const groupFits = res?.fits ?? true;
              const groupSpan = res?.span ?? 1;
              const format = res?.format ?? tab.displayFormat;
              // 仅分组起点可编辑；**不看区域**（R1）。纯展示草稿不依赖从站是否运行，提交时才要求运行中
              const canEdit = isGroupStart;
              const isDrafted = writeDraft.has(item.address);
              const draftValue = writeDraft.get(item.address);
              // Q7：来源筛选只 dim 行，不隐藏 —— 行恒等于窗口内的寄存器
              const dimmed = !matchesSourceFilter(item);
              const displayValue =
                isGroupStart && groupFits
                  ? formatRegisterValue(rows, index, format, tab.byteOrder32, tab.byteOrder64)
                  : '—';
              // 宽类型整组草稿展示：整组地址均已编辑时按草稿重算格式化值
              let groupDisplay = displayValue;
              if (isGroupStart && groupSpan > 1) {
                const addrs = Array.from({ length: groupSpan }, (_, k) => rows[index + k]?.address ?? 0);
                const drafted = addrs.map((a) => writeDraft.get(a));
                if (drafted.every((v) => v !== undefined)) {
                  const eff: RegisterData[] = addrs.map((a, k) => ({
                    address: a,
                    rawValue: drafted[k] as number,
                  }));
                  groupDisplay = formatRegisterValue(eff, 0, format, tab.byteOrder32, tab.byteOrder64);
                }
              }
              const formatDisabled = !isGroupStart || !wordArea;
              return (
                <tr
                  key={cellKey}
                  className={`h-12 border-b border-border/20 transition-colors ${
                    isDrafted
                      ? 'bg-amber-500/[0.07]'
                      : 'odd:bg-surface/40 even:bg-transparent hover:bg-surface-container/50'
                  } ${dimmed ? 'opacity-30' : ''}`}
                >
                  {/* 地址：⭐ 寄存器序号（Q20）；位区旁挂对应的位范围作"辅助只读"显示 */}
                  <td className="w-24 px-3 py-1.5 font-mono text-[11px] font-semibold">
                    {isDrafted && (
                      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" />
                    )}
                    {item.address}
                    {bitArea && (
                      <span className="mt-0.5 block w-fit rounded bg-foreground/10 px-1 py-px text-[10px] font-normal leading-none text-muted-foreground">
                        {t('bits')} {item.address * 16}~{item.address * 16 + 15}
                      </span>
                    )}
                  </td>
                  {/* 原始 HEX（位区 = 该寄存器**按位打包后的 16 位字**） */}
                  <td className="w-24 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {item.rawValue.toString(16).toUpperCase().padStart(4, '0')}
                  </td>
                  {/* 原始 DEC */}
                  <td className="w-24 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {item.rawValue}
                  </td>
                  {/* 数据类型（逐行格式切换，写入 formatOverrides） */}
                  <td className="w-48 px-3 py-1.5">
                    {!isGroupStart ? (
                      <span className="px-2 font-mono text-[10px] text-muted-foreground/40">—</span>
                    ) : formatEditing ? (
                      <Select
                        value={format}
                        onValueChange={(v) => {
                          const next = v as DataDisplayFormat;
                          const overrides = { ...(tab.formatOverrides ?? {}) };
                          if (next === tab.displayFormat) {
                            // 选回默认格式 → 移除 override
                            delete overrides[item.address];
                          } else {
                            overrides[item.address] = next;
                          }
                          onUpdate(tab.id, {
                            formatOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
                          });
                          setEditingFormatRow(null);
                        }}
                      >
                        <SelectTrigger className="h-6 w-42 border-border/40 bg-background px-2 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FORMAT_OPTIONS.filter((opt) => wordArea || opt.value === 'led').map((opt) => {
                            // 空间不足 / 非寄存器区域：禁用无法应用的宽类型
                            const fits = formatFitsAt(opt.value, index, rowCount, wordArea);
                            return (
                              <SelectItem
                                key={opt.value}
                                value={opt.value}
                                disabled={!fits}
                                className="text-xs"
                              >
                                {t(opt.labelKey)}
                                {!fits ? ` (${t('notEnoughRegisters')})` : ''}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge
                        variant="outline"
                        className={`cursor-pointer border-transparent px-2 py-0.5 font-mono text-[10px] ${
                          formatDisabled
                            ? 'cursor-not-allowed bg-foreground/5 text-muted-foreground/40'
                            : 'bg-foreground/5 ' +
                              (format === 'float' || format === 'double'
                                ? 'text-primary'
                                : format === 'led'
                                  ? 'text-success'
                                  : 'text-amber-500')
                        } ${res?.overridden ? 'ring-1 ring-primary/40' : ''}`}
                        onClick={() => {
                          if (formatDisabled) return;
                          setEditingFormatRow(String(item.address));
                        }}
                        title={wordArea ? undefined : t('wideTypeRequiresRegisters')}
                      >
                        {t(FORMAT_KEY_MAP[format])}
                        {res?.overridden ? ' *' : ''}
                      </Badge>
                    )}
                  </td>
                  {/* 格式化值（行内编辑）。
                      ⭐ 位区与字区同一套：一行 = 一个寄存器；`led` 格式渲染该寄存器的 16 个位，
                      不再有"单个 0/1 按钮"的位-行特例（Q20：四区视图同构）。 */}
                  <td className="w-48 px-3 py-1.5">
                    {format === 'led' ? (
                      <LedBits
                        value={draftValue ?? item.rawValue}
                        editable={canEdit}
                        drafted={isDrafted}
                        onChange={(raw) => onCommitCellEdit(tab, item.address, String(raw), 'led', 1)}
                      />
                    ) : isEditingThis ? (
                      <input
                        autoFocus
                        value={cellValue}
                        onChange={(e) => setCellValue(e.target.value)}
                        onBlur={() => onCommitCellEdit(tab, item.address, cellValue, format, groupSpan)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            onCommitCellEdit(tab, item.address, cellValue, format, groupSpan);
                          }
                          if (e.key === 'Escape') setEditingCell(null);
                        }}
                        disabled={!canEdit}
                        className="w-42 rounded border border-primary/40 bg-background px-1.5 py-0.5 font-mono text-xs text-foreground outline-none"
                      />
                    ) : (
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono ${
                          canEdit ? 'cursor-pointer text-cyan-400 hover:bg-primary/10' : 'text-foreground'
                        } ${isDrafted ? 'text-amber-400' : ''}`}
                        onClick={() => {
                          if (!canEdit) return;
                          setEditingCell(cellKey);
                          setCellValue(
                            formatRegisterValue(rows, index, format, tab.byteOrder32, tab.byteOrder64),
                          );
                        }}
                      >
                        {groupSpan > 1
                          ? groupDisplay
                          : isDrafted && draftValue !== undefined
                            ? formatDraftValue(draftValue, format)
                            : displayValue}
                      </span>
                    )}
                  </td>
                  {/* 值来源（Q7）：角标 + 颜色区分写方；从未写入过显示 — */}
                  <td className="w-20 px-3 py-1.5">
                    {item.source ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_STYLE[item.source].cls}`}
                      >
                        {t(SOURCE_STYLE[item.source].key)}
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground/40">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > 0 && hasWideGroup && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground/50">
            {t('perRowFormatHint')}
          </div>
        )}
      </div>
    </div>
  );
}
