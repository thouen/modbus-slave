'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useAppState } from '@/hooks/use-app-state';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowRight, ArrowLeft, Info, Trash2, Download } from 'lucide-react';

function directionIcon(direction: string) {
  switch (direction) {
    case 'rx': return <ArrowLeft className="w-3 h-3 text-cyan-400" />;
    case 'tx': return <ArrowRight className="w-3 h-3 text-green-400" />;
    default: return <Info className="w-3 h-3 text-amber-400" />;
  }
}

function typeColor(type: string): string {
  switch (type) {
    case 'error': return 'text-red-400';
    case 'data': return 'text-cyan-400';
    default: return 'text-muted-foreground';
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3 as any,
  });
}

export function LogViewer() {
  const { t } = useI18n();
  const { state, dispatch } = useAppState();
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedSlaveId, setSelectedSlaveId] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const logViewerRef = useRef<HTMLDivElement>(null);
  const prevLogsLengthRef = useRef(0);

  const activeSlave = state.slaves.find(s => s.id === state.activeSlaveId);
  const effectiveSlaveId = selectedSlaveId
    ?? activeSlave?.id
    ?? state.slaves[0]?.id
    ?? null;

  // logs 是全局数组，按 slaveId 筛选
  const logs = useMemo(
    () => effectiveSlaveId
      ? state.logs.filter(l => l.slaveId === effectiveSlaveId)
      : state.logs,
    [effectiveSlaveId, state.logs],
  );

  const slaveLogCount = useCallback(
    (slaveId: string) => state.logs.filter(l => l.slaveId === slaveId).length,
    [state.logs],
  );

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (!autoScroll) return;

    const viewport = logViewerRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;

    if (logs.length > prevLogsLengthRef.current) {
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    }
    prevLogsLengthRef.current = logs.length;
  }, [logs.length, autoScroll]);

  const handleClear = () => {
    dispatch({ type: 'CLEAR_LOGS', payload: effectiveSlaveId ?? undefined });
  };

  const handleExport = () => {
    const lines = logs.map(l => {
      const time = formatTime(l.timestamp);
      const dir = l.direction.toUpperCase().padEnd(3, ' ');
      return `[${time}] [${dir}] ${l.message}${l.rawData ? ` | ${l.rawData}` : ''}`;
    });
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modbus-slave-logs.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleExpand = (id: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">{t('logs')}</span>
          <span className="text-[10px] text-muted-foreground">
            ({logs.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Select
              value={effectiveSlaveId ?? 'all'}
              onValueChange={(v) => setSelectedSlaveId(v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-6 w-32 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allSlaves')}</SelectItem>
                {state.slaves.map(slave => (
                  <SelectItem key={slave.id} value={slave.id}>
                    {slave.name} ({slaveLogCount(slave.id)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            <Switch
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              className="scale-75 data-[state=checked]:bg-primary"
            />
            <Label className="text-[10px] text-muted-foreground cursor-pointer">{t('autoScroll')}</Label>
          </div>

          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleExport} title={t('exportLogs')}>
            <Download className="w-3 h-3" />
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={handleClear} title={t('clearLogs')}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Log content */}
      <ScrollArea className="flex-1" ref={logViewerRef}>
        <div className="p-2 font-mono-data text-[10px] leading-relaxed space-y-0.5">
          {logs.length === 0 && (
            <div className="text-center py-4 text-muted-foreground">
              {t('noLogs')}
            </div>
          )}
          {logs.map((log) => {
            const isExpanded = expandedLogs.has(log.id);
            const hasRawData = !!log.rawData;
            return (
              <div
                key={log.id}
                className={`flex gap-2 px-1 py-0.5 rounded-sm hover:bg-card/50 ${hasRawData ? 'cursor-pointer' : ''}`}
                onClick={() => hasRawData && toggleExpand(log.id)}
              >
                <span className="text-muted-foreground shrink-0 w-[78px]">
                  {formatTime(log.timestamp)}
                </span>
                <span className="shrink-0 w-4 flex items-center justify-center">
                  {directionIcon(log.direction)}
                </span>
                <span className={`flex-1 truncate ${typeColor(log.type)}`}>
                  {log.message}
                </span>
                {hasRawData && !isExpanded && (
                  <span className="text-[9px] text-muted-foreground shrink-0">···</span>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
