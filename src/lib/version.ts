/**
 * 应用版本号 —— **唯一数据源**。
 *
 * ⚠️ 升版本时下面三处必须同时改（②③ 有 `src/lib/__tests__/version.test.ts` 守着 ②）：
 *   ① 本文件 `APP_VERSION`
 *   ② `package.json` 的 `version`
 *   ③ git tag：`v0.6.0`
 *
 * ⚠️ `package.json` 里**必须写完整 semver**（`0.6.0`）—— npm 不接受 `0.6`。
 * 界面按「发布线」只显示 `major.minor`（见 `APP_VERSION_LABEL`）。
 */
export const APP_VERSION = '0.6.0';

/**
 * 界面展示用的版本标签：`v` + `major.minor` ⇒ **`v0.6`**。
 *
 * ⚠️ 这**刻意不是 i18n key** —— 版本号在任何语言下都是同一个串，
 * 做成 i18n 只会多一个永远两端同值、却要参与全量对账的键。
 */
export const APP_VERSION_LABEL = `v${APP_VERSION.split('.').slice(0, 2).join('.')}`;
