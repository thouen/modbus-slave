/**
 * 视图标签（RegisterViewTab）的**默认值**收口。
 *
 * ⚠️ 抽出来的理由：新建标签有两个入口 ——
 *   ① 用户点标签栏的「+」（register-viewer）
 *   ② **启动从站实例时自动打开绑定该实例的标签**（slave-panel）
 * 两处若各写一份默认值，迟早会漂（一边改成 50 个寄存器、另一边还是 20）。
 */

import { generateId } from '@/lib/modbus-utils';
import type { RegisterViewTab } from '@/lib/modbus-types';

/** 新标签默认覆盖的寄存器数量（寄存器单位） */
export const DEFAULT_VIEW_TAB_REGISTER_COUNT = 20;

/** 生成默认标签名称：`区域 @起始地址` */
export function generateViewTabName(areaLabel: string, startAddress: number): string {
  return `${areaLabel} @${startAddress}`;
}

/**
 * 造一个绑定指定从站实例的默认标签。
 *
 * ⭐ 默认落在**保持寄存器区**（FC03/06/16）—— 那是调试时最常看的区。
 *
 * @param slaveId  从站实例 id（应用内部 id，**不是** ModBus 单元号）
 * @param areaLabel 区域名的**已翻译**文案，由调用方 `t('holdingRegisters')` 提供
 */
export function createDefaultViewTab(slaveId: string, areaLabel: string): RegisterViewTab {
  const startAddress = 0;
  return {
    id: generateId(),
    name: generateViewTabName(areaLabel, startAddress),
    slaveId,
    area: 'holdingRegisters',
    startAddress,
    registerCount: DEFAULT_VIEW_TAB_REGISTER_COUNT,
    displayFormat: 'hex',
  };
}
