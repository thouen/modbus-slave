/**
 * 与 modbus-master 保持一致的 stylelint 规则集。
 *
 * 注意：此处曾声明 `declaration-block-trailing-semicolon`，该规则在当前 stylelint 主版本中已不存在，
 * 会导致 `pnpm run lint:style` 直接报 "Unknown rule" 退出；同时缺少 Tailwind v4 必需的豁免项。
 *
 * @type {import('stylelint').Config}
 */
export default {
  extends: 'stylelint-config-standard',
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: [
          'tailwind',
          'apply',
          'layer',
          'theme',
          'custom-variant',
          'variants',
          'responsive',
          'screen',
        ],
      },
    ],
    'hue-degree-notation': null,
    'import-notation': null,
    'lightness-notation': null,
    'no-descending-specificity': null,
    'rule-empty-line-before': null,
    'value-keyword-case': null,
  },
};
