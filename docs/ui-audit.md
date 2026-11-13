# UI 审查与优化记录

日期：2026-11-13。按 `ui-audit` 及其五个领域技能完成检查并实施修复。

**范围与约定**

本轮覆盖首页选套餐、结算填写、报价确认、支付入口和订单结果，以及共享导航和新手指南。技术栈沿用 Bun、Next.js App Router、React、Ant Design；样式沿用全局 CSS 与黑白灰语义颜色。仓库约定文件为 `AGENTS.md`、`README.md`，未发现独立设计系统或文案规范文件。

不把本轮结论扩展到后台全部业务页面、账号安全设置或真实支付渠道。上轮的颜色检查脚本额外抽查了这些页面的文本颜色，但不构成它们的完整 UI 审查。

| 领域 | 检查证据 | 结果 |
| --- | --- | --- |
| Clarity | 结算信息、步骤、七种订单状态的源码与实际渲染 | 修正错误流程提示和重复层级 |
| make-layout-better | 320 / 375 / 768 / 1440 / 1920px、长邮箱、套餐详情展开 | 修复摘要隐藏、导航缺失、平板横向溢出 |
| write-usable-copy | 表单标签、占位符、指南顺序、取消确认与恢复说明 | 修正文案和动作标签 |
| make-typography-clean | 浏览器计算字号、价格、手机输入框、长字段换行 | 放大辅助文字及输入框，价格使用等宽数字 |
| color-system | 既有语义色、25 个页面/交互快照的文字与合成背景测量 | 所检查文本无失败；保留上轮高对比度主题 |
| ui-polish | 禁用、加载、焦点、悬停、展开、弹窗关闭、减少动态效果 | 修正焦点覆盖，简化按钮悬停效果 |

**发现与处理**

以下严重度描述修复前影响；列出的修改均已实施。

| 严重度 | 领域 | 位置 | 修改前 | 修改后 | 原因 |
| --- | --- | --- | --- | --- | --- |
| HIGH | make-layout-better | `src/app/globals.css:1893`、`src/components/Checkout.tsx:461` | 手机端套餐摘要 `display: none`，未提供查看入口 | 显示套餐名称与价格，提供更换入口和可展开的服务内容 | 用户付款前必须能核对商品；隐藏信息应有明确入口 |
| HIGH | Clarity | `src/components/OrderPage.tsx:142` | 取消、失败、退款仍沿用“正在充值”的步骤位置 | 终止状态移除进度条；需更新账号时明确显示等待状态 | 进度必须与订单实际结果一致 |
| MEDIUM | make-layout-better | `src/app/globals.css:1749`、`src/components/Site.tsx:308` | 窄屏主导航消失，账号菜单依赖默认触发方式 | 主导航在第二行完整显示；账号菜单点击打开 | 让触屏用户能稳定到达套餐、指南及账号入口 |
| MEDIUM | make-layout-better | `src/app/globals.css:1649` | 768px 时装饰圆环超出右边界，页面可横向滚动 | 在装饰容器内裁切圆环 | 装饰不应改变内容滚动范围 |
| MEDIUM | make-layout-better | `src/app/globals.css:1776` | 手机横排操作继承平板的顶部对齐，主按钮与指南链接中心相差 15px；首次审查遗漏 | 手机断点显式恢复居中对齐；复查 320–1440px 共九种宽度，同排中心差为 0px，分行时左边缘差为 0px | 改变排列方向时必须同步核对交叉轴对齐，不能只检查是否溢出 |
| MEDIUM | make-layout-better | `src/components/Checkout.tsx:210`、`src/app/globals.css:813` | 手机端步骤纵向排列，摘要与表单层级分散 | 紧凑横向步骤、独立间距容器、紧凑套餐摘要 | 保留完整流程信息并减少重复层级 |
| MEDIUM | make-typography-clean | `src/app/globals.css:28`、`:554`、`:578`、`:608`、`:1950` | 价格说明与详情入口为 10px，手机输入框为 14px | 使用 12 / 14 / 16px 语义字号，扩大详情入口，金额使用等宽数字 | 提高阅读与触摸操作的稳定性；手机输入框达到 16px |
| MEDIUM | ui-polish | `src/components/Checkout.tsx:114`、`src/app/globals.css:64` | 长表单报错可能位于屏幕上方；链接焦点框被组件样式覆盖 | 错误出现后聚焦提示；链接使用深灰、外扩的可见焦点框 | 错误和键盘位置需要可发现的反馈 |
| MEDIUM | write-usable-copy | `src/app/guide/page.tsx:25`、`src/components/OrderPage.tsx:200`、`:240`、`src/components/PlanCard.tsx:57` | 指南与填写顺序不一致，取消按钮泛化，恢复字段仅有占位符，详情链接名称重复 | 对齐联系邮箱优先流程，明确“取消订单 / 保留订单”，添加恢复字段标签与说明，详情链接包含套餐名 | 操作名称应说明结果，字段需要持续可见的标签 |
| LOW | ui-polish | `src/app/globals.css:238` | 主按钮悬停有 200ms 位移，次按钮边框没有相同过渡 | 统一为 150ms 颜色与边框过渡，移除位移 | 高频操作反馈保持安静一致 |

**验证**

- `bun run build`：生产构建与 TypeScript 检查通过。
- `bun run test:e2e --grep 'demo checkout shares|all tiers|guest checkout requires|SSR storefront'`：前三项通过；游客用例最初因占位符文案变化失配，改为使用字段标签定位。
- `bun run test:e2e --grep 'guest checkout requires|guest referral'`：两项通过。总计覆盖五项既有流程，包括游客邮箱、游客邀请、组合付款与套餐档位。
- `bun .data/ui-audit-verify.mjs`：五个宽度无整页横向溢出；手机摘要和导航可见、邮箱输入计算字号 16px；长邮箱、错误定位、套餐内容展开、无效商品返回入口通过。
- 同一脚本检查七种订单状态。除未付款与取消走真实本地演示流程外，其余结果使用浏览器响应夹具验证展示；没有调用真实支付或兑换服务。
- 同一脚本验证订单加载失败后重试、取消确认、200% CSS zoom、RTL 几何布局及减少动态效果设置。
- `bun .data/ui-audit-states.mjs`：加载骨架、提交中按钮、Escape 关闭登录弹窗、键盘导航与焦点、悬停状态通过。
- `bun .data/audit-contrast.mjs`：25 个检查快照中，所检查的可见文本未出现对比度失败。此脚本不能替代完整无障碍认证。
- `bunx prettier --check src/components/Checkout.tsx src/components/OrderPage.tsx src/components/PlanCard.tsx src/components/Site.tsx src/app/guide/page.tsx src/app/globals.css tests/flows.spec.ts`：格式检查通过。

**未验证**

真实 iPhone Safari 的自动缩放行为、浏览器原生 200% 页面缩放、完整 RTL 翻译及伪本地化、屏幕阅读器、动画面板 10% 慢放、真实支付与兑换回调均未在本轮验证。CSS zoom 与 RTL 几何检查仅覆盖布局，不代替这些验证。

**结论：Approve。** 本轮已检查范围内的 HIGH 问题均已修复；该结论不覆盖上述排除项。

**账号安全页后续调整（2026-11-13）**

- 将二步验证总开关、固定开启的邮箱方式、可选 TOTP 放在同一卡片；Passkey 和密码分别展示。删除恢复码入口与相关流程。
- 绑定 Passkey 自动开启并锁定二步验证开关；删除最后一个 Passkey 保留二步验证与 TOTP。服务端同时限制关闭操作。
- 核对 375px 和 1440px 实际页面截图：卡片间距 24px、手机控件换行、开关与标题对齐，页面无横向溢出。截图等待确认弹窗完全关闭后再采集。
- 浏览器验证新账号默认关闭、开启后邮箱固定可用、未绑定 TOTP 时密码登录自动发邮箱验证码、绑定后默认 TOTP 且可切换邮箱、Passkey 锁定开关、删除后保留 TOTP。恢复码端点返回 404，信任设备不能跳过验证。
