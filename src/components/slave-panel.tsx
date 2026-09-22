'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useAppState, createDefaultSlave } from '@/hooks/use-app-state';
import { useModbusWs } from '@/hooks/use-modbus-ws';
import {
  BITS_PER_REGISTER,
  DEFAULT_AREA_TOTAL_REGISTERS,
  type SlaveConfig,
  type Protocol,
  type Mode,
  type ByteOrder32,
  type ByteOrder64,
  type RowNotes,
} from '@/lib/modbus-types';
import { generateId } from '@/lib/modbus-utils';
import { createDefaultViewTab } from '@/lib/view-tab';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Plus, Upload, Download, Pencil, Trash2, Play, Square, Server, Radio, Cable, Gauge, RefreshCw } from 'lucide-react';

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]';
    case 'starting':
      return 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)] animate-pulse';
    case 'error':
      return 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]';
    default:
      return 'bg-zinc-600';
  }
}

function protocolBadge(protocol: Protocol, mode: Mode): { label: string; cls: string } {
  if (protocol === 'tcp') return { label: 'TCP', cls: 'bg-blue-500/15 text-blue-400' };
  if (mode === 'ascii') return { label: 'ASCII', cls: 'bg-amber-500/15 text-amber-400' };
  return { label: 'RTU', cls: 'bg-zinc-500/15 text-zinc-400' };
}

/**
 * 需要重启才能生效的字段指纹。
 * 监听器（端口/串口）与内存容量都在启动时固定，改这些字段必须"先停后起"。
 */
function restartKey(cfg: SlaveConfig): string {
  return [
    cfg.protocol,
    cfg.mode,
    cfg.tcpConfig?.host ?? '',
    cfg.tcpConfig?.port ?? '',
    cfg.serialConfig?.port ?? '',
    cfg.serialConfig?.baudRate ?? '',
    cfg.serialConfig?.dataBits ?? '',
    cfg.serialConfig?.stopBits ?? '',
    cfg.serialConfig?.parity ?? '',
    cfg.slaveId,
    cfg.coilCount,
    cfg.discreteInputCount,
    cfg.holdingRegisterCount,
    cfg.inputRegisterCount,
  ].join('|');
}

function slaveTarget(slave: SlaveConfig): string {
  if (slave.protocol === 'tcp') {
    return `${slave.tcpConfig?.host ?? '-'}:${slave.tcpConfig?.port ?? '-'}`;
  }
  return `${slave.serialConfig?.port ?? '-'}@${slave.serialConfig?.baudRate ?? '-'}`;
}

export function SlavePanel() {
  const { t } = useI18n();
  const { state, dispatch } = useAppState();
  const { startSlave, stopSlave, restartSlave, readRegisters } = useModbusWs();
  /**
   * 登记「本次由用户点启动、成功后要自动打开标签」的从站 id。
   *
   * ⚠️ 必须由**点击**登记，不能写成"看到 status 是 running 就开标签" ——
   * 刷新页面时服务端快照（`slave_snapshot`）也会把 running 补回来，
   * 那种情况下不该凭空刷出一堆标签。
   */
  const pendingAutoTabRef = useRef<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  /** ⭐ `null` = 新建（与 master 的 `editingConn` 同义）；非 null = 编辑该实例 */
  const [editingSlave, setEditingSlave] = useState<SlaveConfig | null>(null);
  /** 弹窗「打开次数」计数器 —— 专供 `SlaveDialog` 的 `key` 用，语义见 `ConnectionDialog` 同名注释 */
  const [dialogSeq, setDialogSeq] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ slaves: SlaveConfig[]; rowNotes: RowNotes } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlaveConfig | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * 启动 / 停止。
   * ⭐ 启动会登记「成功后自动开标签」：从站真正起来后再切到绑定它的标签。
   */
  const handleToggle = (slave: SlaveConfig) => {
    const status = state.slaveStatus[slave.id];
    if (status === 'running') {
      stopSlave(slave.id);
    } else {
      pendingAutoTabRef.current.add(slave.id);
      startSlave(slave.id, slave);
    }
  };

  /**
   * 从站启动成功（status 转 `running`）→ 打开一个**绑定该实例**的标签。
   *
   * ⭐ 触发时机选在 running 之后、而不是点击瞬间：从站要先 listen 成功才算真的起来，
   *   点击那一刻读会撞上还没起来的从站。
   * ⭐ 已有绑定该从站的标签 ⇒ 切过去并刷新一次；一个都没有 ⇒ 新建（默认保持寄存器区）。
   */
  useEffect(() => {
    const pending = pendingAutoTabRef.current;
    if (pending.size === 0) return;

    for (const slaveId of [...pending]) {
      if (state.slaveStatus[slaveId] !== 'running') continue;
      pending.delete(slaveId);

      const existing = state.viewTabs.find((tab) => tab.slaveId === slaveId);
      if (existing) {
        dispatch({ type: 'SET_ACTIVE_VIEW_TAB', payload: existing.id });
        dispatch({ type: 'SET_ACTIVE_SLAVE', payload: slaveId });
        readRegisters(
          existing.id, existing.slaveId, existing.area, existing.startAddress, existing.registerCount,
        );
        continue;
      }
      if (!state.slaves.some((s) => s.id === slaveId)) continue;

      const tab = createDefaultViewTab(slaveId, t('holdingRegisters'));
      dispatch({ type: 'ADD_VIEW_TAB', payload: tab });
      // 新标签尚未进入 state，直接用其配置发起一次读取
      readRegisters(tab.id, tab.slaveId, tab.area, tab.startAddress, tab.registerCount);
    }
  }, [state.slaveStatus, state.viewTabs, state.slaves, dispatch, readRegisters, t]);

  const handleNew = () => {
    setEditingSlave(null);
    setDialogSeq(s => s + 1);
    setDialogOpen(true);
  };

  const handleEdit = (slave: SlaveConfig) => {
    setEditingSlave({ ...slave });
    setDialogSeq(s => s + 1);
    setDialogOpen(true);
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    // Stop if running
    if (state.slaveStatus[deleteTarget.id] === 'running') {
      stopSlave(deleteTarget.id);
    }
    dispatch({ type: 'DELETE_SLAVE', payload: deleteTarget.id });
    setDeleteTarget(null);
  };

  const handleExport = () => {
    // R4：行备注一并导出，否则"导出 → 再导入"会静默丢掉用户手录的备注
    const data = JSON.stringify({ slaves: state.slaves, rowNotes: state.rowNotes }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modbus-slave-config.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const slaves: SlaveConfig[] = data.slaves ?? [];
        setPendingImport({ slaves, rowNotes: data.rowNotes ?? {} });
        setImportOpen(true);
      } catch {
        // silently ignore
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = (strategy: 'overwrite' | 'merge') => {
    if (!pendingImport) return;
    dispatch({
      type: 'IMPORT_CONFIG',
      payload: { slaves: pendingImport.slaves, rowNotes: pendingImport.rowNotes, strategy },
    });
    setPendingImport(null);
    setImportOpen(false);
  };

  const activeSlaveStatus = useMemo(() => {
    if (!state.activeSlaveId) return null;
    return state.slaveStatus[state.activeSlaveId];
  }, [state.activeSlaveId, state.slaveStatus]);

  /**
   * 只读提示：该输入对应的**位范围**（Q19 / Q20）。
   *
   * 把 "1 寄存器 = 16 位" 的换算**显式展示出来** —— 这样"单位统一"就不是静默换算。
   * 四个区用同一套措辞（含字区），这是 Q20 里那个"辅助只读"位地址。
   */
  const bitRange = (areaTotalRegisters: number) =>
    `${t('bitLabel')} 0 ~ ${Math.max(0, areaTotalRegisters * 16 - 1)}`;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold text-foreground">{t('slaves_management')}</span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleNew} title={t('newSlave')}>
            <Plus className="w-3.5 h-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => fileInputRef.current?.click()} title={t('importConfig')}>
            <Upload className="w-3.5 h-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleExport} title={t('exportConfig')}>
            <Download className="w-3.5 h-3.5" />
          </Button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      {/* Slave list —— ⭐ 显示风格对齐 master 的 ConnectionList：
          「状态点 + 名称 + 徽章」一行 → 「目标 · ID」一行 → 「元信息 + 悬停操作」一行，
          后两行用 pl-4 缩进到名称列（状态点 w-2 + gap-2 = 16px = pl-4）。 */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {state.slaves.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground/50">
              <Radio className="w-6 h-6" />
              <p className="text-[11px]">{t('newSlave')}</p>
            </div>
          )}
          {state.slaves.map((slave) => {
            const status = state.slaveStatus[slave.id] ?? 'stopped';
            const badge = protocolBadge(slave.protocol, slave.mode);
            const isActive = state.activeSlaveId === slave.id;
            // 服务端实际生效的配置 vs 本地已改配置：不一致即"需重启生效"
            const runningConfig = state.runningConfigs[slave.id];
            const needsRestart =
              status === 'running' &&
              runningConfig !== undefined &&
              restartKey(runningConfig) !== restartKey(slave);

            return (
              <div
                key={slave.id}
                className={`group rounded-md border p-2 cursor-pointer transition-all ${
                  isActive
                    ? 'border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30'
                    : 'border-border/60 hover:border-border bg-surface-list hover:bg-surface-list-hover'
                }`}
                onClick={() => dispatch({ type: 'SET_ACTIVE_SLAVE', payload: slave.id })}
              >
                {/* 第 1 行：状态点 + 名称 + 徽章 */}
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor(status)}`} />
                  <span className="flex-1 truncate text-xs font-medium text-foreground/90">{slave.name}</span>
                  {needsRestart && (
                    <span
                      className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400"
                      title={t('restartRequired')}
                    >
                      {t('restart')}
                    </span>
                  )}
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>

                {/* 第 2 行：单元号 · 目标地址（与 master 列表**同形同序**） */}
                <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground pl-4">
                  <span>{t('slave')}:{slave.slaveId}</span>
                  <span className="truncate font-mono text-muted-foreground/80">{slaveTarget(slave)}</span>
                </div>

                {/* 第 3 行：元信息（左） + 悬停操作（右） */}
                <div className="mt-1.5 flex items-center justify-between pl-4">
                  <span className="flex items-center gap-1 text-[9px] text-muted-foreground/60">
                    <Gauge className="w-2.5 h-2.5" />
                    {slave.holdingRegisterCount} regs
                  </span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`h-5 px-1.5 text-[9px] ${status === 'running' ? 'text-red-400' : 'text-green-400'}`}
                      onClick={(e) => { e.stopPropagation(); handleToggle(slave); }}
                      title={status === 'running' ? t('stop') : t('start')}
                    >
                      {status === 'running'
                        ? <Square className="w-3 h-3 mr-0.5" />
                        : <Play className="w-3 h-3 mr-0.5" />}
                    </Button>
                    {needsRestart && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1.5 text-[9px] text-amber-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          // 重启也是"启动从站实例"，同样登记自动开标签
                          pendingAutoTabRef.current.add(slave.id);
                          restartSlave(slave.id, slave);
                        }}
                        title={t('restartSlave')}
                      >
                        <RefreshCw className="w-3 h-3" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[9px] text-blue-400"
                      onClick={(e) => { e.stopPropagation(); handleEdit(slave); }}
                      title={t('editSlave')}
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[9px] text-red-400"
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(slave); }}
                      title={t('deleteSlave')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Edit Dialog —— ⭐ 已抽成独立函数组件 `SlaveDialog`（定义在本文件末尾），
          与 master 的 `ConnectionDialog` 同形：同样的 props、同样的字段顺序、同样的控件样式。
          ⚠️ `key={dialogSeq}` 不能省：per-field useState 只在挂载时取初值。 */}
      <SlaveDialog
        key={dialogSeq}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editingSlave}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('deleteSlave')}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {deleteTarget ? `${t('deleteSlave')} "${deleteTarget.name}"？` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import Strategy Dialog */}
      <AlertDialog open={importOpen} onOpenChange={(open) => { if (!open) { setImportOpen(false); setPendingImport(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('importConfig')}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {t('importStrategyDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setImportOpen(false); setPendingImport(null); }}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => handleImport('merge')}>{t('importMerge')}</AlertDialogAction>
            <AlertDialogAction onClick={() => handleImport('overwrite')}>{t('importOverwrite')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * 从站编辑弹窗。
 *
 * ⭐ 与 master 的 `ConnectionDialog`（`modbus-master/src/components/connection-panel.tsx`）
 *    **刻意保持同形**，目标是"改一边就知道另一边怎么改"：
 *    - 独立函数组件，props 固定为 `open` / `onOpenChange` / `editing`；
 *    - `editing === null` 表示**新建** —— 标题与保存分支都只看这一个判据
 *      （旧实现靠"去 state.slaves 里找有没有同 id"来判断，那是另一种写法）；
 *    - 每个字段一个 `useState`，初值取自 `editing?.xxx ?? 默认值`；
 *    - 字段顺序：名称 → 协议 / 模式 / 单元号 → 连接参数 → 内存配置 → 字节序；
 *    - 标签一律原生 `<label className="text-xs text-muted-foreground">`，
 *      控件一律 `<Input className="h-8 text-xs bg-background border-border">`
 *      / `<SelectTrigger className="h-8 w-full text-xs bg-background border-border">`。
 *
 * ⚠️ per-field `useState` **只在挂载时取一次初值** ⇒ 调用方必须传 `key`（见 `dialogSeq`），
 *    否则第二次打开会留着上一次的表单内容。master 侧同理，两边规则一致。
 *
 * ⚠️ 与 master 的两处**有意保留**的差异（不是遗漏）：
 *    1. 串口参数多 3 项（数据位 / 停止位 / 校验）—— 从站是"模拟真实设备"，
 *       7E1 / 8N1 这类差异必须能在模拟器上调；master 侧固定 8N1。
 *       影响范围见 `restartKey()`：这些字段改动都要求"先停后起"。
 *    2. 没有"广播地址"提示 —— 本弹窗单元号下界是 1，从站不存在 FC 广播。
 */
function SlaveDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SlaveConfig | null;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useAppState();

  /**
   * 表单默认值。
   * - 编辑：用 `createDefaultSlave()` 的字段结构打底（下面每个字段仍各自
   *   `editing?.xxx ?? defaults.xxx` 兜一层，与 master 同款写法）；
   * - 新建：再补一个**未被占用**的单元号 —— 单端口多从站靠 Unit ID 区分，
   *   不自动避让的话用户一点"启动"就撞上 Unit ID 冲突。
   *
   * ⚠️ 必须包在 `useMemo` 里：渲染期直接调模块级函数会让 React Compiler 跳过整个组件
   *    （报 `react-hooks/preserve-manual-memoization`，且错误会落在无关的 useCallback 上）。
   */
  const defaults = useMemo(() => {
    const draft = createDefaultSlave();
    if (editing) return draft;
    const used = new Set(state.slaves.map((s) => s.slaveId));
    let unitId = draft.slaveId;
    while (used.has(unitId) && unitId < 247) unitId += 1;
    return { ...draft, slaveId: unitId };
  }, [editing, state.slaves]);

  const [name, setName] = useState(editing?.name ?? '');
  const [protocol, setProtocol] = useState<Protocol>(editing?.protocol ?? defaults.protocol);
  const [mode, setMode] = useState<Mode>(editing?.mode ?? defaults.mode);
  const [slaveId, setSlaveId] = useState(editing?.slaveId ?? defaults.slaveId);
  const [host, setHost] = useState(editing?.tcpConfig?.host ?? defaults.tcpConfig?.host ?? '0.0.0.0');
  const [port, setPort] = useState(editing?.tcpConfig?.port ?? defaults.tcpConfig?.port ?? 502);
  const [serialPort, setSerialPort] = useState(
    editing?.serialConfig?.port ?? defaults.serialConfig?.port ?? '/dev/ttyUSB0',
  );
  const [baudRate, setBaudRate] = useState(
    editing?.serialConfig?.baudRate ?? defaults.serialConfig?.baudRate ?? 9600,
  );
  const [dataBits, setDataBits] = useState<7 | 8>(
    editing?.serialConfig?.dataBits ?? defaults.serialConfig?.dataBits ?? 8,
  );
  const [stopBits, setStopBits] = useState<1 | 2>(
    editing?.serialConfig?.stopBits ?? defaults.serialConfig?.stopBits ?? 1,
  );
  const [parity, setParity] = useState<'none' | 'even' | 'odd'>(
    editing?.serialConfig?.parity ?? defaults.serialConfig?.parity ?? 'none',
  );
  const [byteOrder32, setByteOrder32] = useState<ByteOrder32>(editing?.byteOrder32 ?? defaults.byteOrder32);
  const [byteOrder64, setByteOrder64] = useState<ByteOrder64>(editing?.byteOrder64 ?? defaults.byteOrder64);

  // 4 个区的「总寄存器数量」（概念名 areaTotalRegisters）：
  // 从站侧它就是**该区真实内存的长度**（`Uint16Array` 的长度），越界读写回异常码 `0x02`。
  // ⚠️ 字段名沿用历史名称，不改名、不需要迁移（Q17）。
  const [coilCount, setCoilCount] = useState(editing?.coilCount ?? DEFAULT_AREA_TOTAL_REGISTERS);
  const [discreteInputCount, setDiscreteInputCount] = useState(
    editing?.discreteInputCount ?? DEFAULT_AREA_TOTAL_REGISTERS,
  );
  const [holdingRegisterCount, setHoldingRegisterCount] = useState(
    editing?.holdingRegisterCount ?? DEFAULT_AREA_TOTAL_REGISTERS,
  );
  const [inputRegisterCount, setInputRegisterCount] = useState(
    editing?.inputRegisterCount ?? DEFAULT_AREA_TOTAL_REGISTERS,
  );

  /** 位区的只读位范围提示（Q20：主显示是寄存器编号，位范围挂旁边作参考） */
  const bitRange = (registers: number) => `0 ~ ${Math.max(1, registers) * BITS_PER_REGISTER - 1}`;

  const handleSave = () => {
    const config: SlaveConfig = {
      id: editing?.id ?? generateId(),
      name: name || `${t('slave')} ${state.slaves.length + 1}`,
      protocol,
      mode,
      slaveId,
      byteOrder32,
      byteOrder64,
      coilCount: Math.max(1, coilCount),
      discreteInputCount: Math.max(1, discreteInputCount),
      holdingRegisterCount: Math.max(1, holdingRegisterCount),
      inputRegisterCount: Math.max(1, inputRegisterCount),
      ...(protocol === 'serial'
        ? {
            serialConfig: { port: serialPort, baudRate, dataBits, stopBits, parity },
          }
        : {
            tcpConfig: { host, port },
          }),
    };

    if (editing) {
      dispatch({ type: 'UPDATE_SLAVE', payload: config });
    } else {
      dispatch({ type: 'ADD_SLAVE', payload: config });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editing ? t('editSlave') : t('newSlave')}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('name')}</label>
            <Input
              className="h-8 text-xs bg-background border-border"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('slaveName')}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('protocol')}</label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as Protocol)}>
                <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">{t('tcp')}</SelectItem>
                  <SelectItem value="serial">{t('serial')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              {/* ⚠️ 模式与 master 一样**恒显示**（不按协议隐藏）：TCP 下它不影响成帧
                  （TCP 恒按 MBAP 解析，见 AGENTS.md §6），保留是为了两端表单结构一致。 */}
              <label className="text-xs text-muted-foreground">{t('mode')}</label>
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rtu">{t('rtu')}</SelectItem>
                  <SelectItem value="ascii">{t('ascii')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('slaveId')}</label>
              <Input
                type="number"
                min={1}
                max={247}
                className="h-8 text-xs bg-background border-border"
                value={slaveId}
                onChange={(e) => setSlaveId(Math.min(247, Math.max(1, Number(e.target.value) || 1)))}
              />
            </div>
          </div>

          {protocol === 'tcp' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('host')}</label>
                <Input
                  className="h-8 text-xs bg-background border-border"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('port')}</label>
                <Input
                  type="number"
                  className="h-8 text-xs bg-background border-border"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 502)}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('port')}</label>
                <Input
                  className="h-8 text-xs bg-background border-border"
                  value={serialPort}
                  onChange={(e) => setSerialPort(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('baudRate')}</label>
                <Select value={String(baudRate)} onValueChange={(v) => setBaudRate(Number(v))}>
                  <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400].map((br) => (
                      <SelectItem key={br} value={String(br)}>{br}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('dataBits')}</label>
                <Select value={String(dataBits)} onValueChange={(v) => setDataBits((Number(v) || 8) as 7 | 8)}>
                  <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7</SelectItem>
                    <SelectItem value="8">8</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('stopBits')}</label>
                <Select value={String(stopBits)} onValueChange={(v) => setStopBits((Number(v) || 1) as 1 | 2)}>
                  <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('parity')}</label>
                <Select value={parity} onValueChange={(v) => setParity(v as 'none' | 'even' | 'odd')}>
                  <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('parityNone')}</SelectItem>
                    <SelectItem value="even">{t('parityEven')}</SelectItem>
                    <SelectItem value="odd">{t('parityOdd')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* 设备内存：4 个区的总寄存器数量（= 该区真实内存的长度） */}
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-xs font-medium text-foreground">
              {t('memoryConfiguration')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('coilCount')}</label>
                <Input
                  type="number"
                  min={1}
                  className="h-8 text-xs bg-background border-border"
                  value={coilCount}
                  onChange={(e) => setCoilCount(Math.max(1, parseInt(e.target.value) || 1))}
                />
                <span className="block text-[9px] text-muted-foreground/60">
                  {t('bitLabel')} {bitRange(coilCount)}
                </span>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('discreteInputCount')}</label>
                <Input
                  type="number"
                  min={1}
                  className="h-8 text-xs bg-background border-border"
                  value={discreteInputCount}
                  onChange={(e) => setDiscreteInputCount(Math.max(1, parseInt(e.target.value) || 1))}
                />
                <span className="block text-[9px] text-muted-foreground/60">
                  {t('bitLabel')} {bitRange(discreteInputCount)}
                </span>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('holdingRegisterCount')}</label>
                <Input
                  type="number"
                  min={1}
                  className="h-8 text-xs bg-background border-border"
                  value={holdingRegisterCount}
                  onChange={(e) => setHoldingRegisterCount(Math.max(1, parseInt(e.target.value) || 1))}
                />
                <span className="block text-[9px] text-muted-foreground/60">
                  {t('bitLabel')} {bitRange(holdingRegisterCount)}
                </span>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t('inputRegisterCount')}</label>
                <Input
                  type="number"
                  min={1}
                  className="h-8 text-xs bg-background border-border"
                  value={inputRegisterCount}
                  onChange={(e) => setInputRegisterCount(Math.max(1, parseInt(e.target.value) || 1))}
                />
                <span className="block text-[9px] text-muted-foreground/60">
                  {t('bitLabel')} {bitRange(inputRegisterCount)}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('byteOrder32')}</label>
              <Select value={byteOrder32} onValueChange={(v) => setByteOrder32(v as ByteOrder32)}>
                <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['ABCD', 'DCBA', 'BADC', 'CDAB'].map((o) => (
                    <SelectItem key={o} value={o}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t('byteOrder64')}</label>
              <Select value={byteOrder64} onValueChange={(v) => setByteOrder64(v as ByteOrder64)}>
                <SelectTrigger className="h-8 w-full text-xs bg-background border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['ABCDEFGH', 'HGFEDCBA', 'BADCFEHG', 'GHEFCDAB'].map((o) => (
                    <SelectItem key={o} value={o}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* 作用范围：16 位固定大端，不受这两种字节序影响（ModBus 规范） */}
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            {t('byteOrderScopeHint')}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button size="sm" className="text-xs h-8" onClick={handleSave}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
