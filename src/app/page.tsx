'use client';

import { I18nProvider, useI18n } from '@/hooks/use-i18n';
import { AppProvider, useAppState } from '@/hooks/use-app-state';
import { SlavePanel } from '@/components/slave-panel';
import { RegisterViewer } from '@/components/register-viewer';
import { LogViewer } from '@/components/log-viewer';
import { Button } from '@/components/ui/button';
import { Server } from 'lucide-react';

function AppContent() {
  const { t, locale, setLocale } = useI18n();
  const { state } = useAppState();

  const runningCount = Object.values(state.slaveStatus).filter(s => s === 'running').length;
  const totalLogs = state.logs.length;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-primary/15 flex items-center justify-center">
              <Server className="w-3.5 h-3.5 text-primary" />
            </div>
            <h1 className="text-sm font-bold text-foreground tracking-wide">{t('appTitle')}</h1>
          </div>
          <span className="text-[10px] text-muted-foreground hidden sm:inline">{t('appSubtitle')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-4 bg-border mx-1" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[10px] px-2"
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
          >
            {locale === 'zh' ? 'EN' : '中'}
          </Button>
        </div>
      </header>

      {/* Main content area: left slaves + right (viewer + logs) */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Left: slave panel (always visible) */}
        <div className="w-70 shrink-0 bg-surface border-r border-border overflow-hidden">
          <SlavePanel />
        </div>

        {/* Right: register viewer + logs */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="flex-1 min-h-0 overflow-hidden">
            <RegisterViewer />
          </div>
          <div className="h-56 min-h-[140px] max-h-[40vh] border-t border-border overflow-hidden shrink-0">
            <LogViewer />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar runningCount={runningCount} totalSlaves={state.slaves.length} totalLogs={totalLogs} />
    </div>
  );
}

function StatusBar({ runningCount, totalSlaves, totalLogs }: { runningCount: number; totalSlaves: number; totalLogs: number }) {
  const { t } = useI18n();

  return (
    <footer className="flex items-center justify-between px-4 py-1 border-t border-border bg-surface text-[10px] text-muted-foreground shrink-0">
      <div className="flex items-center gap-4">
        <span>
          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${
            runningCount > 0 ? 'bg-green-500' : 'bg-zinc-600'
          }`} />
          {runningCount} {t('runningSlaves')}
        </span>
        <span>{totalSlaves} {t('totalSlaves')}</span>
        <span>{totalLogs} log entries</span>
      </div>
      <div className="flex items-center gap-2">
        <span>ModBus TCP/Serial</span>
        <span>RTU/ASCII</span>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <I18nProvider>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </I18nProvider>
  );
}
