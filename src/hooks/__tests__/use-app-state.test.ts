import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appReducer, migrateViewTab, type AppState } from '@/hooks/use-app-state';
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
    registerCount: 10,
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
  it('只更新窗口内且已缓存的地址，并写入值来源（Q7）', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1', { startAddress: 0, registerCount: 4 })],
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
          { area: 'holdingRegisters', address: 2, value: 42, source: 'master' },
          { area: 'holdingRegisters', address: 99, value: 1, source: 'master' }, // 窗口外
          { area: 'coils', address: 1, value: 1, source: 'master' }, // 区域不符
        ],
      },
    });

    assert.deepEqual(next.registerData.t1, [
      { address: 0, rawValue: 0 },
      { address: 1, rawValue: 0 },
      { address: 2, rawValue: 42, source: 'master' },
      { address: 3, rawValue: 0 },
    ]);
  });

  it('位区增量按「位地址 → 寄存器行」归位（Q19 两套单位的接缝）', () => {
    // 位区：1 行 = 1 寄存器 = 16 个位地址；startAddress 也是寄存器单位
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1', { area: 'coils', startAddress: 1, registerCount: 2 })],
      registerData: {
        t1: [
          { address: 1, rawValue: 0b0000 },
          { address: 2, rawValue: 0b0000 },
        ],
      },
    });

    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: {
        slaveId: 's1',
        // 寄存器 1 覆盖位地址 16~31；写 bit 17（= 寄存器 1 的位序号 1）
        changes: [
          { area: 'coils', address: 17, value: 1, source: 'master' },
          { area: 'coils', address: 33, value: 1, source: 'manual' }, // 寄存器 2 的 bit 1
        ],
      },
    });

    assert.equal(next.registerData.t1[0].rawValue, 0b10);
    assert.equal(next.registerData.t1[0].source, 'master');
    assert.equal(next.registerData.t1[1].rawValue, 0b10);
    assert.equal(next.registerData.t1[1].source, 'manual');
  });

  it('位区：窗口外的位地址不落行', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1', { area: 'coils', startAddress: 0, registerCount: 1 })],
      registerData: { t1: [{ address: 0, rawValue: 0 }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: {
        slaveId: 's1',
        // 寄存器 1 的行不在窗口内（窗口只有寄存器 0 = 位 0~15）
        changes: [{ area: 'coils', address: 16, value: 1, source: 'master' }],
      },
    });
    assert.equal(next, state);
  });

  it('未读取过的标签页不做局部补丁（避免半真半假）', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1')],
      registerData: {},
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: { slaveId: 's1', changes: [{ area: 'holdingRegisters', address: 0, value: 7, source: 'master' }] },
    });
    assert.equal(next, state);
  });

  it('值未变化时不产生新状态', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1')],
      registerData: { t1: [{ address: 0, rawValue: 5, source: 'master' }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: {
        slaveId: 's1',
        changes: [{ area: 'holdingRegisters', address: 0, value: 5, source: 'master' }],
      },
    });
    assert.equal(next, state);
  });

  it('只有来源变化时也要更新（值相同但写方不同）', () => {
    const state = baseState({
      slaves: [makeSlave('s1')],
      viewTabs: [makeTab('t1', 's1')],
      registerData: { t1: [{ address: 0, rawValue: 5, source: 'manual' }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: {
        slaveId: 's1',
        changes: [{ area: 'holdingRegisters', address: 0, value: 5, source: 'master' }],
      },
    });
    assert.equal(next.registerData.t1[0].source, 'master');
    assert.equal(next.registerData.t1[0].rawValue, 5);
  });

  it('不修改其它从站的缓存', () => {
    const state = baseState({
      slaves: [makeSlave('s1'), makeSlave('s2')],
      viewTabs: [makeTab('t1', 's1'), makeTab('t2', 's2')],
      registerData: { t1: [{ address: 0, rawValue: 0 }], t2: [{ address: 0, rawValue: 0 }] },
    });
    const next = appReducer(state, {
      type: 'PATCH_REGISTER_DATA',
      payload: { slaveId: 's2', changes: [{ area: 'holdingRegisters', address: 0, value: 9, source: 'master' }] },
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

// ── 视图标签迁移与绑定 ───────────────────────────────────────────

describe('视图标签迁移与绑定', () => {
  it('migrateViewTab 为旧数据补齐 formatOverrides / 字节序 / 数量', () => {
    const migrated = migrateViewTab({ id: 't1', slaveId: 's1' });
    assert.equal(migrated.id, 't1');
    assert.equal(migrated.area, 'holdingRegisters');
    assert.equal(migrated.formatOverrides, undefined);
    assert.equal(migrated.registerCount, 20);
    assert.equal(migrated.byteOrder32, 'ABCD');
    assert.equal(migrated.byteOrder64, 'ABCDEFGH');
  });

  it('migrateViewTab 把旧 quantity 迁到 registerCount，并夹进 [1, 125]（Q19 单位变更）', () => {
    assert.equal(migrateViewTab({ id: 't1', quantity: 8 }).registerCount, 8);
    // 旧位区标签的数量按"地址个数"计，可能远超寄存器口径的单帧上限 125
    assert.equal(migrateViewTab({ id: 't2', area: 'coils', quantity: 2000 }).registerCount, 125);
    assert.equal(migrateViewTab({ id: 't3', quantity: 0 }).registerCount, 1);
    // 已按新字段写过的值优先，不受旧 quantity 干扰
    assert.equal(
      migrateViewTab({ id: 't4', quantity: 2000, registerCount: 30 }).registerCount,
      30,
    );
  });

  it('migrateViewTab 位区域默认 led，并保留已有字段', () => {
    const bitsTab = migrateViewTab({ id: 't3', area: 'coils' });
    assert.equal(bitsTab.displayFormat, 'led');

    const explicit = migrateViewTab({
      id: 't4',
      area: 'holdingRegisters',
      displayFormat: 'float',
      formatOverrides: { 4: 'double' },
    });
    assert.equal(explicit.displayFormat, 'float');
    assert.deepEqual(explicit.formatOverrides, { 4: 'double' });
  });

  it('migrateViewTab 丢弃旧数据里已废弃的 writeMode 字段', () => {
    // 老版本持久化标签带着 writeMode；迁移后标签上不应再出现该字段
    const legacy = {
      id: 't6',
      area: 'holdingRegisters',
      writeMode: 'single',
    } as unknown as Partial<RegisterViewTab>;
    const migrated = migrateViewTab(legacy);
    assert.equal('writeMode' in migrated, false);
    assert.equal(migrated.area, 'holdingRegisters');
  });

  it('migrateViewTab 丢弃空的 formatOverrides', () => {
    assert.equal(migrateViewTab({ id: 't5', formatOverrides: {} }).formatOverrides, undefined);
  });

  it('ADD_VIEW_TAB 会把活动从站切换到标签绑定的从站', () => {
    const state = baseState({ slaves: [makeSlave('s1'), makeSlave('s2')], activeSlaveId: 's1' });
    const next = appReducer(state, {
      type: 'ADD_VIEW_TAB',
      payload: makeTab('t2', 's2', { startAddress: 5 }),
    });
    assert.equal(next.activeSlaveId, 's2');
    assert.equal(next.activeViewTabId, 't2');
    assert.equal(next.viewTabs.length, 1);
    assert.equal(next.viewTabs[0].startAddress, 5);
  });

  it('同从站附件写入 UPDATE_VIEW_TAB 会覆盖 formatOverrides 且不影响其它标签', () => {
    const state = baseState({
      viewTabs: [
        makeTab('t1', 's1'),
        makeTab('t2', 's1', { startAddress: 100 }),
      ],
    });
    const updated: RegisterViewTab = {
      ...makeTab('t1', 's1'),
      formatOverrides: { 0: 'float' },
    };
    const next = appReducer(state, { type: 'UPDATE_VIEW_TAB', payload: updated });
    assert.deepEqual(next.viewTabs[0].formatOverrides, { 0: 'float' });
    assert.deepEqual(next.viewTabs[1].formatOverrides, undefined);
    assert.equal(next.viewTabs[1].startAddress, 100);
  });

  // ⚠️ 回归用例：窗口身份 = 区域 + 起始地址 + 数量。
  // 切区后缓存若不清，界面会短暂显示上一个区域的值，而"未编辑行回填"会把旧区的值写进新区。
  it('UPDATE_VIEW_TAB 改区域会丢弃该标签的缓存（防跨区串值）', () => {
    const tab = makeTab('t1', 's1', {
      area: 'discreteInputs',
      startAddress: 0,
      registerCount: 4,
    });
    const state = baseState({
      viewTabs: [tab],
      registerData: {
        t1: [
          { address: 0, rawValue: 11 },
          { address: 1, rawValue: 22 },
        ],
      },
    });
    const next = appReducer(state, {
      type: 'UPDATE_VIEW_TAB',
      payload: { ...tab, area: 'holdingRegisters' },
    });
    assert.equal(next.registerData.t1, undefined);
  });

  it('UPDATE_VIEW_TAB 改起始地址或数量同样丢弃缓存', () => {
    const tab = makeTab('t1', 's1', { startAddress: 0, registerCount: 4 });
    const cached = { t1: [{ address: 0, rawValue: 11 }] };

    const moved = appReducer(baseState({ viewTabs: [tab], registerData: cached }), {
      type: 'UPDATE_VIEW_TAB',
      payload: { ...tab, startAddress: 10 },
    });
    assert.equal(moved.registerData.t1, undefined);

    const resized = appReducer(baseState({ viewTabs: [tab], registerData: cached }), {
      type: 'UPDATE_VIEW_TAB',
      payload: { ...tab, registerCount: 8 },
    });
    assert.equal(resized.registerData.t1, undefined);
  });

  it('UPDATE_VIEW_TAB 只改窗口之外的字段时保留缓存（不误伤）', () => {
    const tab = makeTab('t1', 's1', { startAddress: 0, registerCount: 4 });
    const state = baseState({
      viewTabs: [tab],
      registerData: { t1: [{ address: 0, rawValue: 11 }] },
    });
    const next = appReducer(state, {
      type: 'UPDATE_VIEW_TAB',
      payload: { ...tab, formatOverrides: { 0: 'float' } },
    });
    assert.deepEqual(next.registerData.t1, [{ address: 0, rawValue: 11 }]);
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
