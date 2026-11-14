# GetCodex Plus

官网域名：`getcodex.plus`。正式部署时设置 `APP_URL=https://getcodex.plus`，本地开发继续使用 `http://localhost:3000`。

项目目录与包名统一为 `getcodex-plus`。

面向终端用户的 GPT 充值与升级网站。Bun + Next.js App Router + React + Ant Design + PostgreSQL，数据库访问统一使用 Prisma，账户基于 Better Auth；已有 AICDK 负责真实兑换执行。

商业内容、SEO 配置及购买阶段统计见 [增长与 SEO 说明](docs/growth-and-seo.md)。正式上线前需在后台填写支持邮箱及可用的账号操作指引；示例数据不会自动变成服务承诺。

## 本地运行

需要 Bun 1.4.4+、Node.js 22.12+（运行 Next.js 开发服务和测试工具）和 PostgreSQL 18。依赖已锁定，使用 `bun install --frozen-lockfile` 安装。

```sh
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d db
bun run db:migrate
bun run db:seed
bun run db:verify
bun run dev
```

另开终端运行后台任务：

```sh
bun run worker
```

访问 `http://localhost:3000`，不要混用 `127.0.0.1`，以免 Cookie、Origin 和 Passkey RP ID 不一致。演示环境与正式环境共用 Session 输入、获取指引和授权确认表单，默认预填示例 Session；支持修改示例邮箱，演示前后端仅接受 `accessToken` 和 `sessionToken` 均为 `demo` 的示例凭证，并清除额外字段。演示环境验证码显示在页面，不发送邮件、不联系真实收款渠道、不提交真实账号 Session。使用 `.env` 中的 `ADMIN_EMAIL` 登录即可体验后台。

当前工作区已有 `.env`，连接独立数据库 `127.0.0.1:55479/getgpt`，不是 Compose 示例的 55439。数据位于 `.data/postgres`，请勿覆盖现有 `.env`。演示加密密钥随机生成在 `.data/`，文件权限 0600。

以上初始化命令适用于空库。已有数据库首次切换 Prisma 时，先备份并按 [Prisma 数据库运行手册](docs/prisma-migration.md) 完成结构核验、必要的兼容升级和基线接管。`db:migrate` 仅管理结构版本，`db:seed` 显式补充缺失初始记录，不覆盖现有商品价格、设置或角色。Web 与 worker 统一使用 Prisma 客户端，Better Auth 不再运行独立 schema migration。

## 浏览器脚本与统计

仅保留本站的购买阶段统计。GA / GTM 全局脚本已移除，原有 `NEXT_PUBLIC_GA_ID` / `NEXT_PUBLIC_GTM_ID` 配置不再生效，避免第三方标签与卡密、Session、后台密钥输入共处一个页面。Cloudflare Turnstile 仍按后台开关使用。

页面通过 Next.js Proxy 生成每次请求独立的 CSP nonce，采用动态渲染；运行时脚本、结构化数据和 Turnstile 使用对应 nonce。禁止任意内联脚本、外部连接和嵌入，允许本站资源及 Turnstile 必要来源。Ant Design 所需的内联样式保留。页面与 API 不缓存，使用 `no-referrer`；正式站点启用 HSTS。反向代理须保留这些响应头。

## 用户流程

选择套餐 → 填写联系邮箱和充值账号 → 无卡密检查账号及报价 → 确认订单并绑定兑换库存 → 付款 → 跟踪充值。游客不必先注册；联系邮箱首次进入结算页即显示，默认留空并必填，与 Session 中的充值账号邮箱分开保存，不从 Session 自动填充。

- 游客订单使用 HttpOnly 浏览器 Cookie 对应的摘要授权。订单号、联系邮箱、付款跳转地址均不是查单凭证。
- 验证联系邮箱登录后，该邮箱的未认领订单归入账户，并撤销原匿名访问能力。存在 TOTP 时，必须先完成二步验证。
- 订单创建和状态变化会写入邮件 outbox，由 worker 发送。发信失败重试，不回滚收款或履约。演示环境只模拟处理。
- 钱包充值和余额抵扣需要登录。余额抵扣默认不勾选，只有用户主动勾选才使用。支持部分余额 + 支付宝 / 微信 / 加密货币组合付款，可调整抵扣金额；足额抵扣时无需外部渠道。订单保存总价、余额抵扣、渠道应付三项不可变快照；余额在下单事务中扣减，重复请求不重复扣款。充值余额与邀请收益分别记账，金额统一用整数分。
- 邀请链接在本浏览器保留 30 天。游客下单时保存邀请人快照，成功交付即可生成待结算佣金，无需注册；已有账户邀请关系优先。默认每笔符合条件的套餐订单都返现，复购也有奖励，但同一联系邮箱只计一位有效邀请。联系邮箱、充值邮箱或用户身份与邀请人相同不返现。若后台开启仅首单，则按充值邮箱、联系邮箱及已登录用户检查历史成功订单；并发完成通过事务锁串行化，邮箱认领不会重复奖励。钱包充值不返现。
- 提现由后台审核并登记实际打款，不自动代付。已确认失败的套餐订单可退回钱包；游客需先验证邮箱认领订单。暂不自动原路退款。
- 邀请等级默认按 0 / 5 / 20 / 50 位有效邀请对应 3% / 5% / 7% / 9%，后台可配置，最高 9%。有效邀请按已结算成功订单的联系邮箱去重，游客也计入；新订单锁定当前等级比例。提现额度只包含已结算邀请收益，扣除已提现及申请中冻结；充值、退款和待结算收益不可提现。表单与审核流程见 [邀请与提现设计](docs/invitations-and-withdrawals.md)。

## 套餐和升级报价

充值目录包含 Go、Plus、Pro 100、Pro 200、Pro 500，后台“商品与库存 → 编辑商品”逐项设置固定基础售价：人民币直接按填写金额收费；美元按后台缓存汇率转换为人民币，并可选择分、角、元、十元向上取整，默认向上取整到元。普通订阅不读取上游成本，不依赖 AICDK 的价格缓存接口。迁移保留现有固定售价；原先设为动态定价的商品会转为固定模式并下架，需管理员确认保存的固定金额后重新上架。初始化价格仅为演示数据，不是官方价格。首页只有一个升级入口，在结算页选择 Plus、Pro 100、Pro 200、Pro 500 目标；AICDK 当前不支持 Go 作为升级目标。

升级页面使用 AICDK v2 的 `POST /account-checks` 检查账号，按具体目标套餐读取 `eligible` 和参考 `quote`。检查不读取、解密、预留或发送卡密；未知结果（`eligible=null`）、账号不匹配或目标套餐不可用时拒绝报价。站内 Pro 100 / 200 / 500 对应上游 `pro_100` / `pro_200` / `pro_500`。

成本使用 `amount_minor`、`currency`、`currency_decimals`，按原币种精度与缓存汇率换算成人民币，再计算 `max(成本 × (1 + 加价比例) + 服务费, 成本 + 最低毛利, 最低售价)` 并向上取整。JPY 按零位小数处理；缺失精度时按 ISO 币种确定，显式精度冲突时拒绝。手动 USD/CNY 汇率仅用于 USD；其他币种使用各自的缓存汇率。未知币种或失效汇率不会回退成美元。上游参考成本仅保存在服务端，不作为用户售价直接输出。

确认创建订单时重新提交当前结算页内存中的 Session，在事务内分配一张库存，再调用 `/redemptions/previews` 和 `/redemptions/preflights`。仅 `ready` 授权可以入单；再次核对账号、业务、目标套餐及锁定的利润规则。实际成本对应售价超过原报价时拒绝创建订单，回滚库存及余额；订单成功后保持原售价。Session 不入本站数据库或浏览器持久存储，创建成功、报价失效或离开结算页后清除。

报价及定价参数、汇率快照保存在服务端，最长 9 分钟内可创建订单，且不超过所用汇率有效期；过期需重新验证。用户只看到当前/目标套餐、最终总价、有效时间、余额和渠道拆分。下单后不因后台调价改变应收金额；已付订单需要更新 Session 时仍保持原售价。演示模式使用模拟上游金额，不代表真实账号报价。

后台“网站设置”支持支付宝、微信、加密货币的最低/最高单笔金额，单位 CNY，支付宝与微信默认最高 ¥2,000，同时用于钱包充值；组合付款按抵扣后渠道实收校验，纯余额付款无需满足外部渠道限额。上线前必须配置真实定价和渠道额度。后台“升级利润定价”按目标设置加价比例、服务费、最低毛利、售价取整，成本加价默认 25%、服务费默认 ¥0、默认向上取整到元；“已确认利润规则，允许真实升级报价”默认关闭，正式环境未开启或缺少目标规则时拒绝升级报价。

固定订阅在首页、详情页和结算页展示后台基础售价对应的人民币价格，账号预检只负责适用性检查和兑换授权，不使用上游成本改写售价。升级仍按账号实时成本、加价比例和取整规则报价。报价保存服务端定价快照，后续后台调价不会改写既有报价或订单金额。首页将 Pro 合并为一个卡片，内部选择 100 / 200 / 500，价格、详情和购买链接随所选档位切换。

USD 自动汇率由独立 worker 循环每小时获取 `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json` 的 `usd.cny`；失败尝试项目官方备用地址 `https://latest.currency-api.pages.dev/v1/currencies/usd.json`。汇率和源数据日期持久化在 PostgreSQL `exchange_rates`，使用原子租约防止多个 worker 重复刷新；失败每 5 分钟重试。用户浏览和报价只读取缓存，后台“网站设置 → 自动汇率”可查看汇率、日期、有效期和错误状态，并请求刷新。演示环境也获取公开汇率，但账户预检及付款仍为模拟。

缓存最多保留 48 小时，且不晚于源数据日期 UTC 零点后的 72 小时，重复获取旧数据不会无限延长有效期。无效、过期或日期倒退的数据不覆盖有效汇率；失去有效汇率后仅暂停需要自动换算的新报价，人民币固定价和手动汇率升级仍可使用。金额与汇率使用整数计算，汇率保留 8 位小数。确认后的报价及订单锁定人民币金额，不随后续汇率或定价变动。新版报价遇到其他 ISO 币种时，会登记对应的 `<币种>_CNY` 缓存任务，worker 从同一来源的币种文件读取人民币汇率；缓存就绪前提示重试。无需 Valkey，也无需修改 AICDK。

## 账户与安全

业务风控统一使用内嵌 GoRules ZEN 引擎，全部规则默认执行。频率超限和未支付订单累积会阻止新请求，共用提现账户与新账号提现进入人工审核。IP 关联依赖可信代理配置，Turnstile 依赖真实站点密钥及后台开关。后台“风控记录”展示命中原因和规则版本，需 `audit:read` 权限。已有环境升级需执行 `db:migrate` 和 `db:risk-backfill`，具体规则、保留期限及迁移步骤见 [统一风控说明](docs/risk-control.md)。

认证使用 Better Auth、`better-auth-opaque`、`@serenity-kit/opaque`、`@better-auth/passkey` 和官方 emailOTP/twoFactor 插件。Resend 使用官方 SDK，SMTP 使用 Nodemailer，Turnstile 组件使用 `@marsidev/react-turnstile`。

密码通过 OPAQUE 协议验证。浏览器本地完成密码计算，接口只接收协议消息；数据库在 `auth_account.registrationRecord` 保存 OPAQUE 注册记录（`providerId=opaque`），不保存密码明文或 scrypt 哈希。用户先通过邮箱验证码注册，再在账号安全页面设置密码；改密在浏览器验证当前密码并生成新记录，完成后注销其他会话。密码长度 12–128 字符由客户端检查，服务端校验协议消息和登录权限。普通明文密码注册、登录、验证和重置接口已关闭。

OPAQUE 挑战有效期为 5 分钟，只能消费一次，绑定操作用途、账号、凭据版本及敏感操作会话；密码更改后的旧挑战不能继续登录。密码登录复用官方 MFA 挑战。`better-auth-opaque` 2.1.0 的 Node ESM 导入扩展名修复保存在 `patches/`，随 `bun install --frozen-lockfile` 自动应用。

忘记密码时，从登录窗口的“忘记密码”或账号安全页的“验证身份并重置密码”进入恢复流程。复用 Better Auth 的邮箱验证码或 Passkey 登录；账号要求二步验证时，必须先完成验证，再输入新密码，无需旧密码。恢复入口不会自动注册未知邮箱。重置接口只接受最近 10 分钟内的邮箱、Passkey 或完成 MFA 的会话，拒绝仅凭密码登录的会话；一次性挑战仍绑定账号、会话和凭据版本。新密码在浏览器生成 OPAQUE 注册记录，服务端在同一事务中更新记录并撤销全部会话（包括当前设备），之后需要重新登录。原密码和此前未完成的密码登录挑战失效，Passkey 与二步验证设置保留。

新账号默认关闭二步验证。用户可主动开启，开启后邮箱验证码固定可用，身份验证器（TOTP）为可选项；配置 TOTP 后默认使用动态码，也可切换邮箱验证码。

添加任意 Passkey 自动开启二步验证；保留任意一个 Passkey 时不能关闭，页面与服务端均强制执行。删除全部 Passkey 不会自动关闭二步验证或删除 TOTP，用户可以随后自行关闭。关闭二步验证会移除 TOTP 绑定。

| 账户状态                 | Passkey      | 邮箱验证码登录 | 密码登录                 |
| ------------------------ | ------------ | -------------- | ------------------------ |
| 二步验证关闭，无 Passkey | 不可用       | 可用           | 已设密码即可用           |
| 二步验证开启，无 TOTP    | 已绑定时可用 | 可用           | 密码后必须验证邮箱验证码 |
| 二步验证开启，有 TOTP    | 已绑定时可用 | 需要二步验证   | 需要二步验证             |

密码登录需要二步验证时，未绑定 TOTP 自动发送邮箱验证码；已绑定 TOTP 默认使用动态码，可切换邮箱验证码。邮箱验证码直接登录在未绑定 TOTP 时不重复要求同一邮箱验证码。Passkey 登录不额外要求动态码。删除最后一个 Passkey 保留二步验证设置，并撤销现有会话以要求重新登录。

恢复码功能已移除：不再生成、显示或接受恢复码，相关 SDK 端点不注册，迁移清空已有恢复码材料。敏感操作要求最近 10 分钟内登录并完成账号要求的二步验证；修改密码还通过 OPAQUE 验证原密码。管理二步验证无需向服务器提交密码。二步验证登录不允许“信任设备”绕过。新用户先通过邮箱验证码注册；所有者通过专用 bootstrap 创建 OPAQUE 凭据。

二步验证复用 Better Auth 的挑战、哈希邮箱验证码与 TOTP 实现。数据库将 SDK 的 `two_factor_enabled` 视为“需要 MFA”，TOTP 的实际绑定状态从已验证的 `twoFactor` 记录判断。绑定 Passkey 时强制开启 MFA，删除时保留二步验证状态和 TOTP 密钥。业务接口独立检查当前认证方式，拒绝仅完成密码验证的会话。升级 Better Auth 后必须运行认证 E2E。

登录验证码哈希保存；TOTP 由 Better Auth 加密。业务配置、兑换码、提现账号与短期兑换凭据使用 AES-256-GCM。卡密和短期兑换授权使用 `v2:` 密文格式，AAD 分别绑定用途及库存 / 报价 ID；库存去重使用带密钥的 HMAC，按 AICDK 的大小写、前缀和分隔符规则识别同一卡密。完整 Session 不入本站数据库或浏览器持久存储；经服务端转发给 AICDK，上游受理订单后即清除短期兑换凭据。

RBAC 在服务端检查，内置客服、运营、财务角色，支持自定义角色。所有者身份不能通过注册参数或普通角色分配获得；管理员不能授予自己没有的权限。后台重要写操作保留审计记录。

## 后台配置

在 `/admin` 的“支付与服务”中配置：

- **AICDK**：开放 API 地址及 Key。允许内网 HTTP，禁止跳转。使用新版 `/api/v1/account-checks` 检查账号，随后使用复数 `/redemptions/previews`、`/redemptions/preflights` 取得兑换授权，收款后创建兑换并轮询结果。完整权限建议使用专用应用的 `redeem:*`，包括读取、提交与 PUT 更新 Session。
- **XorPay**：App ID 与 Secret。
- **GMPay**：采用 `GMWalletApp/gmpay-edge` Merchant API 协议，配置网关 URL、PID 和 Secret。若实际供应商是同名的另一产品，需先核对协议。该协议在原地轮换 Secret 后会用新密钥重签历史回调；存在未付款订单时，应保留旧凭证、创建新 PID 切换收款，避免旧回调失效。
- **易支付**：统一配置入口，在配置内选择 v1（MD5）或 v2（RSA-SHA256）；按版本显示商户密钥或商户私钥、平台公钥。网站默认渠道只选择“易支付”，使用配置内保存的版本。切换版本时清空未保存的密钥输入，各版本保存的密钥独立加密保留；历史订单继续使用原协议和配置版本验签。
- **Resend / SMTP**：先配置发件服务，再到“网站设置”选择邮件服务。Resend 需可用的发信域名；SMTP 强制 TLS。
- **Cloudflare Turnstile**：默认关闭，配置 Site Key 和 Secret Key 后，可独立开启登录/验证码、购买/钱包充值两个场景。站点域名必须与 `APP_URL` 对应。

密钥不回显，留空保留原值。每次保存生成新的配置版本；订单绑定收款配置版本，以便密钥轮换后仍能验证旧订单回调。账号检查、兑换预检和履约还绑定同一个 AICDK 配置版本，切换服务地址不会把在途订单发给其他实例。轮换后需保留旧凭证可用，直到相关订单处理完成。

Turnstile 在服务端调用 Cloudflare Siteverify，必须同时匹配 `success=true`、场景 action（`login` 或 `purchase`）、`APP_URL` 的 hostname。令牌缺失、过期/重放、验证超时或域名不符均拒绝操作。登录弹窗采用 Managed 组件，使用 `execution: 'render'` 提前执行、`appearance: 'interaction-only'` 仅在需要交互时显示，位置在登录按钮上方。邮箱发码或登录提交时若验证尚未完成，会等待验证结果后继续；关闭弹窗取消等待。Passkey 直接进行 WebAuthn 登录，不等待或要求 Turnstile。邮箱和密码共用本轮验证结果：服务端首次验证成功后签发五分钟有效的 HttpOnly 签名 Cookie，并将凭据摘要保存在验证表中；有效期内发码、提交邮箱验证码或切换到密码登录无需再次消费 Turnstile 令牌，主认证成功后凭据即作废。MFA 继续校验自身的签名挑战和验证码，不重复要求人机验证。凭据过期或新一轮登录需要重新验证，原有发码限流及验证码尝试次数限制仍生效。购买场景覆盖账号检查、套餐下单、钱包充值，提交后重置组件，不接受登录验证凭据；支付回调不使用浏览器验证码。关闭开关即可恢复常规流程。真实组件验证和重放联调需要实际站点配置；模拟响应测试不代表 Cloudflare 线上联调完成。

## 支付与后台任务

回调地址是 `/api/payments/notify/{provider}/{configRevision}`，服务端创建支付订单时传给网关。

服务端拒绝重复回调参数、验证签名，并核对订单、配置版本、商户、渠道应付金额（组合付款时不含已抵扣余额）、交易号以及协议可提供的渠道信息。GMPay 收到通知后再向服务端查询币种、金额和已支付状态。付款跳转页不能修改付款状态。

收款事件、状态推进、钱包流水与任务入队使用数据库事务；交易号和流水有唯一约束。重复通知不会重复入账，余额与提现使用行锁防止并发超支。

worker 使用 PostgreSQL 持久化任务、`SKIP LOCKED` 和租约，支持多进程领取。提交前持久化 `submission_attempted`，使用稳定的 `client_request_id` 与幂等键；超时后先按请求 ID 查询，再用完全相同的请求体与幂等键恢复，授权过期也不擅自更换。只有明确拒绝且查不到已受理订单时才允许重新取得授权；原客户请求 ID 始终保持不变。`needs_session` 通过 `PUT /redemptions/{id}/account-session` 恢复原订单；`requires_action` / `uncertain` 持续保留原订单和库存，只提示人工核对。只有校验过身份、目标和版本的 `completed` 可以发放完成状态。没有硬性 Valkey 依赖。

当前保守处理：未发起渠道支付的待付订单可取消，原子退回余额抵扣并释放库存。支付创建一旦发起或结果不确定，禁止直接取消或重复创建，保留抵扣余额和库存供人工对账，避免晚到回调与库存重用冲突。已确认履约失败的已付订单退回全部订单金额到钱包，不自动原路退回渠道。上线运营需要配置告警和定期核对未付款/异常订单。SMTP 通知采用至少一次投递，极端网络超时可能重复；Resend 重试使用稳定幂等键。

## 正式环境

1. 使用独立 PostgreSQL 数据库、受控数据库账户和备份，勿使用演示 Compose 的 trust 配置作为生产数据库。
2. 配置 `APP_MODE=live`、HTTPS 的 `APP_URL`、`DATABASE_URL`、独立随机的 `ENCRYPTION_KEY`、`BETTER_AUTH_SECRET` 和 `OPAQUE_SERVER_KEY`。OPAQUE 密钥使用 `bunx @serenity-kit/opaque@0.9.0 create-server-setup` 生成，也可放在权限为 0600 的文件中并配置 `OPAQUE_SERVER_KEY_FILE`。三份密钥均需安全备份，OPAQUE setup 应与数据库备份分开存放；丢失或替换会使已有密码无法登录。演示环境自动生成并持久化至 `.data/opaque.key`，重启时复用。
3. 升级已有站点时先停止 Web 和 worker，备份数据库及现有密钥。首次采用 Prisma 按 [数据库运行手册](docs/prisma-migration.md) 执行 `db:verify`、必要的 `db:upgrade-legacy`、`db:baseline` 和 `db:migrate`，后续发布使用 `db:migrate`。Prisma 接管保留用户 ID、订单、钱包、邀请关系、兑换标识及密文，不自动执行 seed 或重加密。更早的密文格式升级须先完成其历史前置步骤；当前完整 schema 上的凭据维护使用独立 `db:credentials`，勿更换现有 `ENCRYPTION_KEY`。详见 [AICDK v2 迁移与安全审查](docs/aicdk-v2-and-security.md)。
4. 设置 `ADMIN_EMAIL` 和 `BOOTSTRAP_PASSWORD_FILE`（0600 文件，16–128 字符），执行 `bun run admin:bootstrap`。脚本拒绝覆盖已有所有者。初次用密码登录，配置邮件、添加 Passkey 与 TOTP 后删除密码文件。
5. 在后台配置真实商品/价格、兑换库存、收款和邮件。示例价格不构成实际服务承诺。所有外部渠道需逐个完成真实小额订单、回调与异常恢复联调。
6. `bun run build`，通过进程管理器分别运行 `bun run start`、`bun run worker`。使用 HTTPS 反向代理；只有可信代理覆写 `X-Real-IP` 时才设置 `TRUST_PROXY=true`。

若曾运行早期自制认证版本，旧 Cookie 不再有效，可通过邮箱验证码重新登录；旧 Passkey/TOTP 需重新绑定。迁移不会自动删除旧认证表，确认迁移及备份后再由运维清理。

## 验证

```sh
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55479/getgpt_test bun run test
bunx playwright install chromium
bun run build
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55479/getgpt_test E2E_PRODUCTION=true bun run test:e2e
```

数据库集成测试必须使用名称以 `_test` 结尾的独立数据库；各 suite 通过 Prisma migrations 创建独立随机 schema，测试后清理。未设置 `TEST_DATABASE_URL` 时本地跳过数据库 suite，CI 直接报错，验收必须配置测试库。E2E 也要求该变量，自动迁移、seed、写入确定性汇率 fixture 并启动自己的本地演示服务（默认 3100 端口），结束后清理测试 schema。覆盖 SSR 和移动端溢出、钱包收支、游客邮箱认领、密钥只写、RBAC、虚拟 WebAuthn、TOTP/邮箱二步验证、恢复码接口关闭、CSRF、回调拒绝和 Turnstile 服务端开关，以及升级定价、组合付款、限额、取消退款和游客返现幂等。其他入口与并行运行约定见 [Prisma 数据库运行手册](docs/prisma-migration.md)。
