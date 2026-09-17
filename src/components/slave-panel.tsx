'use client';

import { useState, useRef, useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useAppState, createDefaultSlave } from '@/hooks/use-app-state';
import { useModbusWs } from '@/hooks/use-modbus-ws';
import type { SlaveConfig, Protocol, Mode, ByteOrder32, ByteOrder64 } from '@/lib/modbus-types';
import { generateId } from '@/lib/modbus-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
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
  const { startSlave, stopSlave, restartSlave } = useModbusWs();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSlave, setEditingSlave] = useState<SlaveConfig | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<SlaveConfig[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlaveConfig | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleToggle = (slave: SlaveConfig) => {
    const status = state.slaveStatus[slave.id];
    if (status === 'running') {
      stopSlave(slave.id);
    } else {
      startSlave(slave.id, slave);
    }
  };

  const handleNew = () => {
    const draft = createDefaultSlave();
    // 单端口多从站按 Unit ID 区分：新建时自动取一个未占用的单元号，
    // 避免用户直接点"启动"就撞上 Unit ID 冲突
    const used = new Set(state.slaves.map((s) => s.slaveId));
    let unitId = draft.slaveId;
    while (used.has(unitId) && unitId < 247) unitId += 1;
    setEditingSlave({ ...draft, slaveId: unitId });
    setDialogOpen(true);
  };

  const handleEdit = (slave: SlaveConfig) => {
    setEditingSlave({ ...slave });
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!editingSlave) return;
    const existing = state.slaves.find(s => s.id === editingSlave.id);
    if (existing) {
      dispatch({ type: 'UPDATE_SLAVE', payload: editingSlave });
    } else {
      dispatch({ type: 'ADD_SLAVE', payload: editingSlave });
    }
    setDialogOpen(false);
    setEditingSlave(null);
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
    const data = JSON.stringify({ slaves: state.slaves }, null, 2);
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
        setPendingImport(slaves);
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
    dispatch({ type: 'IMPORT_CONFIG', payload: { slaves: pendingImport, strategy } });
    setPendingImport(null);
    setImportOpen(false);
  };

  const activeSlaveStatus = useMemo(() => {
    if (!state.activeSlaveId) return null;
    return state.slaveStatus[state.activeSlaveId];
  }, [state.activeSlaveId, state.slaveStatus]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
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

      {/* Slave list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1.5">
          {state.slaves.length === 0 && (
            <div className="text-center py-8 text-xs text-muted-foreground">
              {t('newSlave')}
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
                className={`group relative rounded-md border p-2.5 cursor-pointer transition-colors ${
                  isActive
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border bg-card hover:border-border/80 hover:bg-card/80'
                }`}
                onClick={() => dispatch({ type: 'SET_ACTIVE_SLAVE', payload: slave.id })}
              >
                <div className="flex items-start gap-2">
                  {/* Status LED */}
                  <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${statusColor(status)}`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground truncate">{slave.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {needsRestart && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded-sm font-medium bg-amber-500/15 text-amber-400"
                            title={t('restartRequired')}
                          >
                            {t('restart')}
                          </span>
                        )}
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-sm font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      <span className="truncate">{slaveTarget(slave)}</span>
                      <span>·</span>
                      <span>ID: {slave.slaveId}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                      <Gauge className="w-2.5 h-2.5" />
                      <span>{slave.holdingRegisterCount} regs</span>
                    </div>
                  </div>

                  {/* Hover actions */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={(e) => { e.stopPropagation(); handleToggle(slave); }}
                      title={status === 'running' ? t('stop') : t('start')}
                    >
                      {status === 'running'
                        ? <Square className="w-3 h-3" />
                        : <Play className="w-3 h-3" />}
                    </Button>
                    {needsRestart && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-amber-400 hover:text-amber-300"
                        onClick={(e) => { e.stopPropagation(); restartSlave(slave.id, slave); }}
                        title={t('restartSlave')}
                      >
                        <RefreshCw className="w-3 h-3" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={(e) => { e.stopPropagation(); handleEdit(slave); }}
                      title={t('editSlave')}
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive hover:text-destructive"
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

      {/* Edit Dialog */}
      {editingSlave && (
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            setEditingSlave(null);
          }
        }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {state.slaves.find(s => s.id === editingSlave.id) ? t('editSlave') : t('newSlave')}
              </DialogTitle>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label className="text-xs">{t('slaveName')}</Label>
                <Input
                  size="sm"
                  value={editingSlave.name}
                  onChange={(e) => setEditingSlave({ ...editingSlave, name: e.target.value })}
                  className="mt-1"
                />
              </div>

              <div>
                <Label className="text-xs">{t('protocol')}</Label>
                <Select
                  value={editingSlave.protocol}
                  onValueChange={(v: Protocol) => {
                    const newSlave = { ...editingSlave, protocol: v };
                    if (v === 'tcp' && !newSlave.tcpConfig) {
                      newSlave.tcpConfig = { host: '0.0.0.0', port: 502 };
                    }
                    if (v === 'serial' && !newSlave.serialConfig) {
                      newSlave.serialConfig = { port: '/dev/ttyUSB0', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' };
                    }
                    setEditingSlave(newSlave);
                  }}
                >
                  <SelectTrigger className="mt-1 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">{t('tcp')}</SelectItem>
                    <SelectItem value="serial">{t('serial')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editingSlave.protocol === 'serial' && (
                <div>
                  <Label className="text-xs">{t('mode')}</Label>
                  <Select
                    value={editingSlave.mode}
                    onValueChange={(v: Mode) => setEditingSlave({ ...editingSlave, mode: v })}
                  >
                    <SelectTrigger className="mt-1 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rtu">{t('rtu')}</SelectItem>
                      <SelectItem value="ascii">{t('ascii')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {editingSlave.protocol === 'tcp' ? (
                <>
                  <div>
                    <Label className="text-xs">{t('host')}</Label>
                    <Input
                      size="sm"
                      value={editingSlave.tcpConfig?.host ?? ''}
                      onChange={(e) => setEditingSlave({
                        ...editingSlave,
                        tcpConfig: { ...editingSlave.tcpConfig!, host: e.target.value },
                      })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('port')}</Label>
                    <Input
                      size="sm"
                      type="number"
                      value={editingSlave.tcpConfig?.port ?? 502}
                      onChange={(e) => setEditingSlave({
                        ...editingSlave,
                        tcpConfig: { ...editingSlave.tcpConfig!, port: parseInt(e.target.value) || 502 },
                      })}
                      className="mt-1"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <Label className="text-xs">{t('port')}</Label>
                    <Input
                      size="sm"
                      value={editingSlave.serialConfig?.port ?? ''}
                      onChange={(e) => setEditingSlave({
                        ...editingSlave,
                        serialConfig: { ...editingSlave.serialConfig!, port: e.target.value },
                      })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('baudRate')}</Label>
                    <Select
                      value={String(editingSlave.serialConfig?.baudRate ?? 9600)}
                      onValueChange={(v) => setEditingSlave({
                        ...editingSlave,
                        serialConfig: { ...editingSlave.serialConfig!, baudRate: parseInt(v) || 9600 },
                      })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400].map(br => (
                          <SelectItem key={br} value={String(br)}>{br}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{t('dataBits')}</Label>
                    <Select
                      value={String(editingSlave.serialConfig?.dataBits ?? 8)}
                      onValueChange={(v) => setEditingSlave({
                        ...editingSlave,
                        serialConfig: { ...editingSlave.serialConfig!, dataBits: (parseInt(v) || 8) as 7 | 8 },
                      })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7">7</SelectItem>
                        <SelectItem value="8">8</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{t('stopBits')}</Label>
                    <Select
                      value={String(editingSlave.serialConfig?.stopBits ?? 1)}
                      onValueChange={(v) => setEditingSlave({
                        ...editingSlave,
                        serialConfig: { ...editingSlave.serialConfig!, stopBits: (parseInt(v) || 1) as 1 | 2 },
                      })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1</SelectItem>
                        <SelectItem value="2">2</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{t('parity')}</Label>
                    <Select
                      value={editingSlave.serialConfig?.parity ?? 'none'}
                      onValueChange={(v: 'none' | 'even' | 'odd') => setEditingSlave({
                        ...editingSlave,
                        serialConfig: { ...editingSlave.serialConfig!, parity: v },
                      })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t('parityNone')}</SelectItem>
                        <SelectItem value="even">{t('parityEven')}</SelectItem>
                        <SelectItem value="odd">{t('parityOdd')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div>
                <Label className="text-xs">{t('slaveId')}</Label>
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={247}
                  value={editingSlave.slaveId}
                  onChange={(e) => setEditingSlave({ ...editingSlave, slaveId: Math.min(247, Math.max(1, parseInt(e.target.value) || 1)) })}
                  className="mt-1"
                />
              </div>

              <div className="col-span-2 border-t border-border pt-3 mt-1">
                <div className="text-xs font-medium text-foreground mb-2">Memory Configuration</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">{t('coilCount')}</Label>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      max={9999}
                      value={editingSlave.coilCount}
                      onChange={(e) => setEditingSlave({ ...editingSlave, coilCount: Math.max(0, parseInt(e.target.value) || 0) })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('discreteInputCount')}</Label>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      max={9999}
                      value={editingSlave.discreteInputCount}
                      onChange={(e) => setEditingSlave({ ...editingSlave, discreteInputCount: Math.max(0, parseInt(e.target.value) || 0) })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('holdingRegisterCount')}</Label>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      max={9999}
                      value={editingSlave.holdingRegisterCount}
                      onChange={(e) => setEditingSlave({ ...editingSlave, holdingRegisterCount: Math.max(0, parseInt(e.target.value) || 0) })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('inputRegisterCount')}</Label>
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      max={9999}
                      value={editingSlave.inputRegisterCount}
                      onChange={(e) => setEditingSlave({ ...editingSlave, inputRegisterCount: Math.max(0, parseInt(e.target.value) || 0) })}
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>

              <div className="col-span-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">{t('byteOrder32')}</Label>
                    <Select
                      value={editingSlave.byteOrder32}
                      onValueChange={(v: ByteOrder32) => setEditingSlave({ ...editingSlave, byteOrder32: v })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ABCD">ABCD (Big Endian)</SelectItem>
                        <SelectItem value="DCBA">DCBA (Little Endian)</SelectItem>
                        <SelectItem value="BADC">BADC (Mid Big)</SelectItem>
                        <SelectItem value="CDAB">CDAB (Mid Little)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{t('byteOrder64')}</Label>
                    <Select
                      value={editingSlave.byteOrder64}
                      onValueChange={(v: ByteOrder64) => setEditingSlave({ ...editingSlave, byteOrder64: v })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ABCDEFGH">ABCDEFGH (Big Endian)</SelectItem>
                        <SelectItem value="HGFEDCBA">HGFEDCBA (Little Endian)</SelectItem>
                        <SelectItem value="BADCFEHG">BADCFEHG (Mid Big)</SelectItem>
                        <SelectItem value="GHEFCDAB">GHEFCDAB (Mid Little)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => { setDialogOpen(false); setEditingSlave(null); }}>
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={handleSave}>{t('save')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{t('deleteSlave')}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {deleteTarget ? `Are you sure you want to delete "${deleteTarget.name}"?` : ''}
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
            <AlertDialogAction onClick={() => handleImport('merge')}>{t('merge')}</AlertDialogAction>
            <AlertDialogAction onClick={() => handleImport('overwrite')}>{t('overwrite')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
