'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useAppState } from '@/hooks/use-app-state';
import { useModbusWs } from '@/hooks/use-modbus-ws';
import type { RegisterArea, DataDisplayFormat, ByteOrder32, ByteOrder64, RegisterData, RegisterViewTab } from '@/lib/modbus-types';
import { formatRegisterValue, getFormatRegisterCount, generateId } from '@/lib/modbus-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, X, Pencil, Play, Square, RefreshCw } from 'lucide-react';

const AREA_OPTIONS: { value: RegisterArea; label: string; tKey: string }[] = [
  { value: 'coils', label: 'Coils (FC01/05/15)', tKey: 'coils' },
  { value: 'discreteInputs', label: 'Discrete Inputs (FC02)', tKey: 'discreteInputs' },
  { value: 'holdingRegisters', label: 'Holding Registers (FC03/06/16)', tKey: 'holdingRegisters' },
  { value: 'inputRegisters', label: 'Input Registers (FC04)', tKey: 'inputRegisters' },
];

const FORMAT_OPTIONS: { value: DataDisplayFormat; label: string }[] = [
  { value: 'hex', label: 'HEX (16-bit)' },
  { value: 'ushort', label: 'Unsigned Short' },
  { value: 'short', label: 'Signed Short' },
  { value: 'binary', label: 'Binary' },
  { value: 'ulong', label: 'Unsigned Long (32-bit)' },
  { value: 'long', label: 'Signed Long (32-bit)' },
  { value: 'float', label: 'Float (32-bit)' },
  { value: 'double', label: 'Double (64-bit)' },
  { value: 'led', label: 'LED (bit)' },
];

function isBitArea(area: RegisterArea): boolean {
  return area === 'coils' || area === 'discreteInputs';
}

function isWritableArea(area: RegisterArea): boolean {
  return area === 'coils' || area === 'holdingRegisters';
}

export function RegisterViewer() {
  const { t } = useI18n();
  const { state, dispatch } = useAppState();
  const { readRegisters, writeRegister } = useModbusWs();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTab, setEditingTab] = useState<RegisterViewTab | null>(null);
  const [writeDialog, setWriteDialog] = useState<{ tabId: string; address: number; currentValue: number } | null>(null);
  const [writeValue, setWriteValue] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const activeSlave = state.slaves.find(s => s.id === state.activeSlaveId);
  const activeTabs = useMemo(
    () => state.viewTabs.filter(tab => tab.slaveId === state.activeSlaveId),
    [state.viewTabs, state.activeSlaveId],
  );
  const activeTab = state.viewTabs.find(tab => tab.id === state.activeViewTabId);
  const registerData = activeTab ? state.registerData[activeTab.id] ?? [] : [];

  // ── Tab management ──

  const handleNewTab = () => {
    if (!activeSlave) return;
    setEditingTab({
      id: generateId(),
      name: 'Coils @ 0',
      slaveId: activeSlave.id,
      area: 'holdingRegisters',
      startAddress: 0,
      quantity: 20,
      displayFormat: 'hex',
      byteOrder32: activeSlave.byteOrder32,
      byteOrder64: activeSlave.byteOrder64,
    });
    setDialogOpen(true);
  };

  const handleSaveTab = () => {
    if (!editingTab) return;
    const existing = state.viewTabs.find(t => t.id === editingTab.id);
    if (existing) {
      dispatch({ type: 'UPDATE_VIEW_TAB', payload: editingTab as any });
    } else {
      dispatch({ type: 'ADD_VIEW_TAB', payload: editingTab as any });
    }
    setDialogOpen(false);
    setEditingTab(null);
    // Trigger initial read
    setTimeout(() => doRead(editingTab.id), 100);
  };

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'DELETE_VIEW_TAB', payload: tabId });
  };

  // ── Data reading ──

  const doRead = useCallback((tabId: string) => {
    const tab = state.viewTabs.find(t => t.id === tabId);
    if (!tab) return;
    readRegisters(tabId, tab.slaveId, tab.area, tab.startAddress, tab.quantity);
  }, [state.viewTabs, readRegisters]);

  const handleRefresh = () => {
    if (!activeTab) return;
    setRefreshing(true);
    doRead(activeTab.id);
    setTimeout(() => setRefreshing(false), 300);
  };

  // Auto-read when active tab changes or when active slave starts
  useEffect(() => {
    if (!activeTab) return;
    const status = state.slaveStatus[activeTab.slaveId];
    if (status === 'running') {
      doRead(activeTab.id);
    }
  }, [activeTab?.id, activeTab?.area, activeTab?.startAddress, activeTab?.quantity]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Write ──

  const handleWriteClick = (address: number, currentValue: number) => {
    if (!activeTab) return;
    setWriteDialog({ tabId: activeTab.id, address, currentValue });
    if (isBitArea(activeTab.area)) {
      setWriteValue(currentValue ? '1' : '0');
    } else {
      setWriteValue(String(currentValue));
    }
  };

  const handleWriteConfirm = () => {
    if (!writeDialog || !activeTab) return;
    const val = parseInt(writeValue, activeTab.displayFormat === 'hex' ? 16 : 10) || 0;
    writeRegister(activeTab.slaveId, activeTab.area, writeDialog.address, val);
    setWriteDialog(null);
    // Refresh after a short delay
    setTimeout(() => doRead(activeTab.id), 100);
  };

  // ── Render ──

  if (!activeSlave) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        Select a slave to view register data
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-surface shrink-0 overflow-x-auto">
        {activeTabs.length === 0 && (
          <span className="text-[10px] text-muted-foreground px-2 py-1">
            No view tabs — create one to inspect registers
          </span>
        )}
        {activeTabs.map((tab) => {
          const isActive = tab.id === state.activeViewTabId;
          return (
            <div
              key={tab.id}
              className={`flex items-center gap-1 px-2 py-1 rounded-t text-[10px] cursor-pointer whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-card text-foreground border border-border border-b-transparent -mb-px'
                  : 'text-muted-foreground hover:text-foreground hover:bg-card/50'
              }`}
              onClick={() => dispatch({ type: 'SET_ACTIVE_VIEW_TAB', payload: tab.id })}
            >
              <span>{tab.name}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-3.5 w-3.5 ml-1 opacity-60 hover:opacity-100"
                onClick={(e) => handleCloseTab(tab.id, e)}
              >
                <X className="w-2.5 h-2.5" />
              </Button>
            </div>
          );
        })}
        <Button size="icon" variant="ghost" className="h-5 w-5 ml-auto shrink-0" onClick={handleNewTab} title={t('newTab')}>
          <Plus className="w-3 h-3" />
        </Button>
      </div>

      {/* Config bar */}
      {activeTab && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-surface/50 shrink-0 text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('registerArea')}:</span>
            <span className="font-medium">{AREA_OPTIONS.find(a => a.value === activeTab.area)?.label ?? activeTab.area}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('startAddress')}:</span>
            <span className="font-mono-data font-medium">{activeTab.startAddress}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('registerCount')}:</span>
            <span className="font-mono-data font-medium">{activeTab.quantity}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('displayFormat')}:</span>
            <span className="font-medium">{FORMAT_OPTIONS.find(f => f.value === activeTab.displayFormat)?.label ?? activeTab.displayFormat}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={handleRefresh}>
              <RefreshCw className={`w-3 h-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      )}

      {/* Data table */}
      <ScrollArea className="flex-1">
        {activeTab ? (
          <Table>
            <TableHeader className="sticky top-0 bg-surface z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-16 text-[10px] font-semibold">{t('address')}</TableHead>
                <TableHead className="w-28 text-[10px] font-semibold">{t('rawHex')}</TableHead>
                <TableHead className="w-28 text-[10px] font-semibold">{t('rawDec')}</TableHead>
                <TableHead className="text-[10px] font-semibold">{t('formattedValue')}</TableHead>
                <TableHead className="w-20 text-[10px] font-semibold">{t('type')}</TableHead>
                {isWritableArea(activeTab.area) && (
                  <TableHead className="w-16 text-[10px] font-semibold text-right">Action</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {registerData.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isWritableArea(activeTab.area) ? 6 : 5} className="text-center py-8 text-xs text-muted-foreground">
                    {state.slaveStatus[activeTab.slaveId] === 'running'
                      ? 'Click Refresh to load data'
                      : 'Start the slave to view register data'}
                  </TableCell>
                </TableRow>
              )}
              {registerData.map((row) => (
                <TableRow key={row.address} className="h-7 hover:bg-card/50">
                  <TableCell className="py-0 font-mono-data text-[11px] text-muted-foreground">
                    {row.address.toString().padStart(5, '0')}
                  </TableCell>
                  <TableCell className="py-0 font-mono-data text-[11px] text-data">
                    {isBitArea(activeTab.area)
                      ? (row.rawValue ? '1' : '0')
                      : `0x${row.rawValue.toString(16).toUpperCase().padStart(4, '0')}`}
                  </TableCell>
                  <TableCell className="py-0 font-mono-data text-[11px]">
                    {row.rawValue}
                  </TableCell>
                  <TableCell className="py-0 font-mono-data text-[11px] text-foreground">
                    {formatRegisterValue(
                      [row.rawValue],
                      isBitArea(activeTab.area) ? 'led' : activeTab.displayFormat,
                      activeTab.byteOrder32,
                      activeTab.byteOrder64,
                    )}
                  </TableCell>
                  <TableCell className="py-0 text-[10px] text-muted-foreground">
                    {isWritableArea(activeTab.area) ? t('writable') : t('readOnly')}
                  </TableCell>
                  {isWritableArea(activeTab.area) && (
                    <TableCell className="py-0 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => handleWriteClick(row.address, row.rawValue)}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            {activeTabs.length > 0 ? 'Select a tab to view data' : 'Create a view tab to start'}
          </div>
        )}
      </ScrollArea>

      {/* New/Edit Tab Dialog */}
      {editingTab && (
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { setDialogOpen(false); setEditingTab(null); } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {state.viewTabs.find(t => t.id === editingTab.id) ? 'Edit View' : 'New View'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-3">
              <div>
                <label className="text-xs">{t('tabName')}</label>
                <Input
                  size="sm"
                  value={editingTab.name}
                  onChange={(e) => setEditingTab({ ...editingTab, name: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs">{t('registerArea')}</label>
                <Select
                  value={editingTab.area}
                  onValueChange={(v: RegisterArea) => {
                    const isBit = isBitArea(v);
                    setEditingTab({
                      ...editingTab,
                      area: v,
                      displayFormat: isBit ? 'led' : 'hex',
                    });
                  }}
                >
                  <SelectTrigger className="mt-1 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AREA_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs">{t('startAddress')}</label>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    value={editingTab.startAddress}
                    onChange={(e) => setEditingTab({ ...editingTab, startAddress: Math.max(0, parseInt(e.target.value) || 0) })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs">{t('registerCount')}</label>
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    max={1000}
                    value={editingTab.quantity}
                    onChange={(e) => setEditingTab({ ...editingTab, quantity: Math.min(1000, Math.max(1, parseInt(e.target.value) || 1)) })}
                    className="mt-1"
                  />
                </div>
              </div>
              {!isBitArea(editingTab.area) && (
                <div>
                  <label className="text-xs">{t('displayFormat')}</label>
                  <Select
                    value={editingTab.displayFormat}
                    onValueChange={(v: DataDisplayFormat) => setEditingTab({ ...editingTab, displayFormat: v })}
                  >
                    <SelectTrigger className="mt-1 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMAT_OPTIONS.filter(f => f.value !== 'led').map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {!isBitArea(editingTab.area) && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs">{t('byteOrder32')}</label>
                    <Select
                      value={editingTab.byteOrder32}
                      onValueChange={(v: ByteOrder32) => setEditingTab({ ...editingTab, byteOrder32: v })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ABCD">ABCD</SelectItem>
                        <SelectItem value="DCBA">DCBA</SelectItem>
                        <SelectItem value="BADC">BADC</SelectItem>
                        <SelectItem value="CDAB">CDAB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs">{t('byteOrder64')}</label>
                    <Select
                      value={editingTab.byteOrder64}
                      onValueChange={(v: ByteOrder64) => setEditingTab({ ...editingTab, byteOrder64: v })}
                    >
                      <SelectTrigger className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ABCDEFGH">ABCDEFGH</SelectItem>
                        <SelectItem value="HGFEDCBA">HGFEDCBA</SelectItem>
                        <SelectItem value="BADCFEHG">BADCFEHG</SelectItem>
                        <SelectItem value="GHEFCDAB">GHEFCDAB</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => { setDialogOpen(false); setEditingTab(null); }}>
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={handleSaveTab}>{t('save')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Write Dialog */}
      {writeDialog && activeTab && (
        <Dialog open={!!writeDialog} onOpenChange={(open) => { if (!open) setWriteDialog(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {t('writeValue')} — {activeTab.area}[{writeDialog.address}]
              </DialogTitle>
            </DialogHeader>
            <div>
              <label className="text-xs">Value (base: {activeTab.displayFormat === 'hex' ? 'hex' : 'decimal'})</label>
              <Input
                size="sm"
                value={writeValue}
                onChange={(e) => setWriteValue(e.target.value)}
                className="mt-1 font-mono-data"
                autoFocus
              />
              {isBitArea(activeTab.area) && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Enter 0 for OFF, 1 for ON
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setWriteDialog(null)}>
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={handleWriteConfirm}>{t('write')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
