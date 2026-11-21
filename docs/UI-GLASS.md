# 透明玻璃界面 + 拨片开关（v0.0.4）

## 玻璃层级

| 层级 | 用法 | 关键 token |
|---|---|---|
| 底 | 极光 + 24px 细网格（`body::before/after`），Earth 3D 地球在真实 WebGL 环境作为主背景 | `--glass-*` |
| 面板 | 顶栏 / 左右栏 / 命令台 / 最终答案卡 / 设置弹窗 / 团队抽屉 | `rgba(20,32,31,.20~.34)` + `backdrop-filter: blur(12~16px) saturate(165%) brightness(1.04)` |
| 反射 | 弹窗顶部 1px 高光、面板 1px 内描边、按钮/卡片 hover 微亮 | `inset 0 1px 0 rgba(255,255,255,.1)` |
| 回退 | 不支持 `backdrop-filter` 时自动加深为不透明底 | `@supports not` |

- 文字对比度优先：正文使用 `--ink`，玻璃只是底；所有玻璃面板仍有 1px 边框保证边界。
- 玻璃透明度随场景：左栏 0.16、右栏 0.14、顶栏 0.20、命令台 0.34、弹窗 0.34。

## 拨片开关（PaddleSwitch）

组件：`apps/web/src/components/PaddleSwitch.tsx`，样式：`styles/paddle.css`。

- **结构**：玻璃凹槽（rail）+ 金属拨片（lever）+ 防滑纹（grip）+ 高光（shine）+ 开启油光（rail::after）。
- **阻尼感**：
  - 位移 `480ms cubic-bezier(.16,1.32,.28,1)`（轻微过冲后回稳）；
  - 按下 `scale(.93,.9)` + 凹槽更深阴影，指针抬起后弹回；
  - 切换后 440ms 光晕脉冲（只动 box-shadow，不和位移冲突）；
  - 支持 `prefers-reduced-motion` 降级。
- **可访问性**：`button + role=switch + aria-checked`，键盘 Space/Enter 可切换，focus-visible 有描边。
- **覆盖范围**：插件中心、中转站启停、关键词规则、省钱模式（工具条 + 预算面板）、使用记忆、角色启停、记忆条目启停、互评开关、本机凭证复用、跳过网络校验。
- 尺寸：表格/行内 `sm` 38×21，设置面板 `md` 48×26。

## 验证

- `pnpm build:web` 通过；`pnpm test` 通过；
- 拨片交互实测：插件 36 项启停往返、省钱模式 true/false、角色启停不触发展开、⌘V/键盘焦点可用；
- 截图：`docs/screenshots/44-v4-glass-home.png`、`45-v4-paddle.png`、`46-v4-plugin-paddles.png`。
