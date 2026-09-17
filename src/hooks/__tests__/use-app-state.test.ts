import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appReducer, type AppState } from '@/hooks/use-app-state';
import type { RegisterViewTab, SlaveConfig } from '@/lib/modbus-types';

// ── 测试数据 ─────────────────────────────────────────────────────

function makeSlave(id: string, overrides: Partial<SlaveConfig> = {}): SlaveConfig {
  return {
    id,
    name: id,
    protocol: 'tcp',
    mode: 'rtu',
    tcpConfig: { host: '127.0.0.1', port: 1502 },
    slaveId: 1,
    coilCount: 100,
    discreteInputCount: 100,
    holdingRegisterCount: 100,
    inputRegisterCount: 100,
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
    ...overrides,
  };
}

function makeTab(id: string, slaveId: string, overrides: Partial<RegisterViewTab> = {}): RegisterViewTab {
  return {
    id,
    name: id,
    slaveId,
    area: 'holdingRegisters',
    startAddress: 0,
    quantity: 10,
    displayFormat: 'hex',
    byteOrder32: 'ABCD',
    byteOrder64: 'ABCDEFGH',
    ...overrides,
  };
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    slaves: [],
    slaveStatus: {},
    runningConfigs: {},
    activeSlaveId: null,
    viewTabs: [],
    activeViewTabId: null,
    registerData: {},
    logs: [],
    ...overrides,
  };
}

// ── PATCH_REGISTER_DATA ──────────────────────────────────────────

describe('PATCH_REGISTER_DATA', () => {
  it('只更新窗口内且已缓存的地址', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1', { startAddress: 0, quantity: 4 })],
      registerData: {
        t1: [
          { address: 0, rawValue: 0 },
          { address: 1, rawValue: 0 },
          { address: 2, rawValue: 0 },
          { address: 3, rawValue: 0 },
        ],
      },
    });

    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: {
        slaveId: 's1',
        changes: [
          { area: 'holdingRegisters', address: 2, value: 42 },
          { area: 'holdingRegisters', address: 99, value: 1 }, // 窗口外
          { area: 'coils', address: 1, value: 1 }, // 区域不符
        ],
      },
    });

    assert.deepEqual(next.registerData.t1, [
      { address: 0, rawValue: 0 },
      { address: 1, rawValue: 0 },
      { address: 2, rawValue: 42 },
      { address: 3, rawValue: 0 },
    ]);
  });

  it('未读取过的标签页不做局部补丁（避免半真半假）', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1')],
      registerData: {},
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: { slaveId: 's1', changes: [{ area: 'holdingRegisters', address: 0, value: 7 }] },
    });
    assert.equal(next, state);
  });

  it('值未变化时不产生新状态', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1')],
      registerData: { t1: [{ address: 0, rawValue: 5 }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: { slaveId: 's1', changes: [{ area: 'holdingRegisters', address: 0, value: 5 }] },
    });
    assert.equal(next, state);
  });

  it('不修改其它从站的缓存', () => {
    const state = baseState({
      slaves: [makeSlave('s1'), makeSlave('s2')],
      viewTabs: [makeTab('t1', 's1'), makeTab('t2', 's2')],
      registerData: { t1: [{ address: 0, rawValue: 0 }], t2: [{ address: 0, rawValue: 0 }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: { slaveId: 's2', changes: [{ area: 'holdingRegisters', address: 0, value: 9 }] },
    });
    assert.equal(next.registerData.t1[0].rawValue, 0);
    assert.equal(next.registerData.t2[0].rawValue, 9);
  });
});

// ── APPLY_SERVER_SNAPSHOT ────────────────────────────────────────

describe('APPLY_SERVER_SNAPSHOT', () => {
  it('运行中从站：状态置 running 且配置以服务端为准', () => {
    const local = makeSlave('s1', { tcpConfig: { host: '127.0.0.1', port: 1502 } });
    const authoritative = makeSlave('s1', { tcpConfig: { host: '127.0.0.1', port: 1503 } });
    const state = baseState({ slaves: [local], slaveStatus: { s1: 'stopped' } });

    const next = appReducer(state, {
      type: 'APPLY_SERVER_SNAPSHOT',
      payload: { running: [{ slaveId: 's1', config: authoritative }] },
    });

    assert.equal(next.slaveStatus.s1, 'running');
    assert.equal(next.slaves[0].tcpConfig?.port, 1503);
    assert.deepEqual(next.runningConfigs.s1, authoritative);
    assert.ok(next.logs.some((l) => /synced from server/i.test(l.message)));
  });

  it('服务端未运行的本地从站回落 stopped，但保留 error 提示', () => {
    const state = baseState({
      slaves: [makeSlave('s1'), makeSlave('s2')],
      slaveStatus: { s1: 'running', s2: 'error' },
    });
    const next = appReducer(state, { type: 'APPLY_SERVER_SNAPSHOT', payload: { running: [] } });
    assert.equal(next.slaveStatus.s1, 'stopped');
    assert.equal(next.slaveStatus.s2, 'error');
    assert.deepEqual(next.runningConfigs, {});
  });

  it('本地缺失的运行中从站会被补入列表（多标签页场景）', () => {
    const remote = makeSlave('remote', { slaveId: 7 });
    const state = baseState({ slaves: [] });
    const next = appReducer(state, {
      type: 'APPLY_SERVER_SNAPSHOT',
      payload: { running: [{ slaveId: 'remote', config: remote }] },
    });
    assert.equal(next.slaves.length, 1);
    assert.equal(next.slaves[0].slaveId, 7);
    assert.equal(next.slaveStatus.remote, 'running');
    assert.ok(next.logs.some((l) => /Adopted running slave/i.test(l.message)));
  });

  it('状态与配置均一致时返回原状态（避免多余渲染）', () => {
    const slave = makeSlave('s1');
    const state = baseState({
      slaves: [slave],
      slaveStatus: { s1: 'running' },
      runningConfigs: { s1: slave },
    });
    const next = appReducer(state, {
      type: 'APPLY_SERVER_SNAPSHOT',
      payload: { running: [{ slaveId: 's1', config: slave }] },
    });
    assert.equal(next, state);
  });
});

// ── SET_RUNNING_CONFIG / DELETE_SLAVE ────────────────────────────

describe('运行配置与删除', () => {
  it('SET_RUNNING_CONFIG 可写入与清除', () => {
    const slave = makeSlave('s1');
    const withConfig = appReducer(baseState(), {
      type: 'SET_RUNNING_CONFIG',
      payload: { id: 's1', config: slave },
    });
    assert.deepEqual(withConfig.runningConfigs.s1, slave);

    const cleared = appReducer(withConfig, {
      type: 'SET_RUNNING_CONFIG',
      payload: { id: 's1', config: null },
    });
    assert.equal(cleared.runningConfigs.s1, undefined);
  });

  it('DELETE_SLAVE 只清被删从站，保留其它从站缓存（回归用例）', () => {
    const state = baseState({
      slaves: [makeSlave('s1'), makeSlave('s2')],
      viewTabs: [makeTab('t1', 's1'), makeTab('t2', 's2')],
      registerData: { t1: [{ address: 0, rawValue: 1 }], t2: [{ address: 0, rawValue: 2 }] },
    });
    const next = appReducer(state, { type: 'DELETE_SLAVE', payload: 's1' });
    assert.equal(next.registerData.t1, undefined);
    assert.deepEqual(next.registerData.t2, [{ address: 0, rawValue: 2 }]);
    assert.deepEqual(next.viewTabs.map((t) => t.id), ['t2']);
  });

  it('DELETE_SLAVE 清理状态、运行配置与关联标签数据', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      slaveStatus: { s1: 'running' },
      runningConfigs: { s1: makeSlave('s1') },
      viewTabs: [makeTab('t1', 's1')],
      registerData: { t1: [{ address: 0, rawValue: 1 }] },
    });
    const next = appReducer(state, { type: 'DELETE_SLAVE', payload: 's1' });
    assert.deepEqual(next.slaves, []);
    assert.equal(next.slaveStatus.s1, undefined);
    assert.equal(next.runningConfigs.s1, undefined);
    assert.deepEqual(next.viewTabs, []);
    assert.deepEqual(next.registerData, {});
  });
});

// ── 日志环形缓冲 ─────────────────────────────────────────────────

describe('日志环形缓冲', () => {
  it('超过 500 条时丢弃最旧的记录', () => {
    let state = baseState();
    for (let i = 0; i < 520; i++) {
      state = appReducer(state, {
        type: 'ADD_LOG',
        payload: {
          id: `log-${i}`,
          timestamp: i,
          slaveId: 's1',
          direction: 'sys',
          type: 'info',
          message: `entry ${i}`,
        },
      });
    }
    assert.equal(state.logs.length, 500);
    assert.equal(state.logs[0].id, 'log-20');
    assert.equal(state.logs[499].id, 'log-519');
  });
});
