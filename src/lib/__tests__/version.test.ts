import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION, APP_VERSION_LABEL } from '@/lib/version';

describe('版本号（v0.6）', () => {
  it('APP_VERSION 与 package.json 的 version 一致 —— 防止版本号漂移', () => {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');
    assert.equal(JSON.parse(raw).version, APP_VERSION);
  });

  it('APP_VERSION 是完整 semver（npm 不接受 0.6 这种两位写法）', () => {
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('界面标签 = v + major.minor', () => {
    assert.equal(APP_VERSION_LABEL, `v${APP_VERSION.split('.').slice(0, 2).join('.')}`);
  });

  it('界面标签形如 v0.6', () => {
    assert.match(APP_VERSION_LABEL, /^v\d+\.\d+$/);
  });
});
