**Prisma 完整迁移计划**

编制及实施日期：2026-11-14。状态：已实施并完成本地验收。规划时的 Better Auth / OPAQUE 改动已在实施前进入仓库基线；本次在此基础上迁移数据库访问层。具体运行和升级步骤见 [Prisma 数据库运行手册](prisma-migration.md)。

**实施结果**

- Prisma Client、CLI 和 PostgreSQL adapter 锁定为 7.10.1；27 个活跃模型保留物理表名和字段映射。Web、worker、Better Auth、维护脚本及测试统一经过 Prisma。
- 空库迁移与 schema diff 通过，catalog 核对 233 个列、268 个约束、57 个索引、6 个函数、6 个触发器；CHECK 和特殊索引保存在版本化 SQL 中。
- 默认事务预算 10 秒；含上游请求的路径显式使用 100 秒，并加入超过 10 秒的慢预检回归。所有连接固定 UTC，覆盖数据库默认 Asia/Shanghai 时的时间读写。
- 测试从迁移前 113 项扩充为 119 项，20 个 Vitest 文件全部通过；生产构建、类型检查及 23 项 Playwright E2E 全部通过。E2E 自动迁移独立 schema 并准备确定性汇率 fixture。
- 管理员 OPAQUE 初始化与重复初始化拒绝、worker 领取任务/处理邮件/清理过期数据和 SIGTERM 正常退出均完成冒烟验证。
- 已有数据库完整备份副本完成兼容升级、基线接管、重复迁移及旧应用版本只读查询回退演练，33 张原有表的原字段值核验一致。
- 当前本地数据库已另做新备份并完成相同接管流程；33 张原表的原字段值再次逐表核验一致，六张历史认证表保留。未重置价格、配置或资金记录，未更换密钥。
- 本地备份：`.data/prisma-migration/source-before-prisma-1794606282127.dump`（0600，忽略提交）。数据摘要、演练记录和验证日志保存在同目录；备份包含业务数据，应按原数据库的访问要求保管。

以下保留实施时的范围、设计与验收依据。

目标是让 Web、worker、Better Auth、管理脚本和测试统一通过 Prisma 访问 PostgreSQL，并由 Prisma Migrate 统一管理数据库版本。常规查询、关联和写入使用 Prisma 模型 API；数据库锁、原子任务领取等必要的 PostgreSQL SQL 通过 Prisma 的参数化接口执行，数据库函数和触发器进入 migration SQL。

`pg` 可以作为 `@prisma/adapter-pg` 的底层驱动依赖保留。业务代码、脚本和测试不再直接创建 `pg.Pool`、调用 `pool.query` / `client.query`，也不再使用旧的 `rows<T>` 类型断言封装。每个保留的原生查询都需要明确用途和对应测试。

**现状与迁移范围**

源码定义了 21 张业务表：`users`、`rate_limits`、`products`、`settings`、`integrations`、`inventory`、`quotes`、`orders`、`commissions`、`withdrawals`、`audit`、`jobs`、`payment_events`、`wallets`、`wallet_ledger`、`roles`、`user_roles`、`demo_mailbox`、`email_outbox`、`exchange_rates`、`funnel_events`。

Better Auth 另外配置了 `auth_session`、`auth_account`、`auth_verification`、`auth_rate_limit`、`auth_passkey`、`twoFactor`，并向 `users` 添加认证字段；OPAQUE 在 account 中使用 `registrationRecord`。这些是源码预期的活跃表，实际数据库可能还有旧版本遗留对象，不能据此直接删除未列出的表。

| 范围       | 当前入口                                                                      | 迁移重点                                           |
| ---------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| 连接与事务 | `src/server/db.ts`                                                            | Prisma 客户端、事务客户端传递、连接池、进程关闭    |
| 数据库升级 | `scripts/migrate.ts`、`schema.sql`、`auth-invariants.sql`                     | 基线、迁移历史、初始化数据与历史数据升级拆分       |
| 认证       | `better-auth.ts`、`opaque.ts`、`auth.ts`、`security.ts`、`bootstrap-admin.ts` | Prisma adapter、字段映射、真实事务、凭据与会话兼容 |
| 订单与资金 | `services.ts`、支付回调入口                                                   | 幂等、行锁、余额拆分、返佣、提现、取消和退款       |
| 库存与履约 | `credential-storage.ts`、`fulfillment.ts`、AICDK 调用                         | 库存独占、密文关联 ID、未知上游结果恢复            |
| 后台任务   | `worker.ts`、`notifications.ts`、`exchange-rates.ts`                          | `SKIP LOCKED`、租约、条件更新、时间语义            |
| 配置与管理 | API route、`integrations/config.ts`、`rbac.ts`                                | 配置版本切换、权限、审计与 JSON 更新               |
| 统计与限流 | `funnel.ts`、`rate-limit.ts`、`turnstile.ts`                                  | 聚合、原子计数、触发器去重                         |
| 测试       | `business.test.ts`、`aicdk-flow.test.ts`、`tests/*.spec.ts`                   | 统一迁移建库、隔离、并发与认证回归                 |

**1. 固定兼容基线**

- 以 Prisma 7 的 `prisma-client` generator、`@prisma/client` 和 `@prisma/adapter-pg` 为实施基础。Better Auth 当前官方文档明确尚不支持 Prisma 8 的新客户端 API，因此依赖必须显式限定 7 系列。先验证本项目 Bun、Node、Next.js、TypeScript 组合，再锁定三者兼容的具体版本及 lockfile。
- 当前项目同时使用 Node 运行开发与测试工具、Bun 运行生产服务和 worker。共享客户端优先使用 Node 兼容的生成目标，先完成两种运行时的加载、查询、事务和关闭连接冒烟验证。
- 在独立副本上取得实际数据库定义，包括列类型、默认值、可空性、外键动作、索引、CHECK、函数和触发器；与当前源码预期逐项比较。该清单只保存结构，不输出凭据或业务行内容。
- 确认副本已达到当前认证和凭据存储版本。未完成旧版升级的库先通过经过验证的旧版升级流程达到基线状态，不能直接标记新的基线已应用。
- 记录现有业务测试、认证 E2E 和构建的实际结果，区分迁移引入的问题与已有失败。

交付物：兼容版本锁定方案、数据库结构清单、旧版本升级前置条件、基准测试结果。

**2. 建立 Prisma schema 和可重放的基线**

- 新增 `prisma/schema.prisma` 和版本对应的 Prisma 配置文件：按当前 7.10+ 初始化约定使用 `prisma7.config.ts`，如兼容验证最终选择更早的 7.x，则使用该版本的 `prisma.config.ts`。从独立数据库副本 introspect，再整理模型、关系和映射，所有 CLI 脚本统一指定配置入口。
- 用 `@map` / `@@map` 保留现有物理表名、列名，模型与字段在应用侧采用清晰的一致命名。Better Auth 配置必须使用对应的 Prisma 模型和字段名，不能继续假设它们等于物理数据库名称。
- 保留现有 text ID 与生成规则、text 状态列及 CHECK、外键动作和默认值。模型整理不得顺带引入 ID 格式变化、状态 enum 转换或新的级联删除。
- 类型精确对应：金额仍为整数分；汇率对应 `BigInt`；提现实付金额对应 `Decimal(20,6)`；JSON 对应 `Json`；时间按实际数据库定义映射，包括 `timestamptz` 精度。
- 生成 `prisma/migrations/00000000000000_baseline/migration.sql`，人工补全 Prisma schema 未覆盖的数据库对象，确保从空库执行即可恢复最终结构。
- 基线必须保留邮件与购买统计触发器、四个 Passkey/MFA 触发器，以及全部 CHECK、部分索引和表达式索引，尤其是有效配置唯一性、提现打款参考号唯一性及 OPAQUE 账户唯一性。
- 基线按“最终结构”编写，历史数据回填与业务初始化单独处理。现有 `schema.sql` 中的历史 UPDATE、DROP、商品下架和配置改写不能整体复制成每次运行的初始化逻辑。
- 既有库通过结构核对后使用 `prisma migrate resolve --applied 00000000000000_baseline` 接管；空库完整执行迁移。两条路径分别测试。
- 对 Prisma 未建模的对象建立 catalog 验证，后续生成迁移时人工检查，避免未经审核的 DROP 或约束丢失。普通 schema diff 不能代替触发器、函数和特殊索引核验。

交付物：完整 schema、基线 migration、结构校验方式；空库与既有库副本的目标结构一致。

**3. 建立客户端、数据边界与认证适配**

- 新增 Prisma 客户端入口和可用于脚本、测试的客户端工厂。Web 开发热更新复用进程内单例；Web 与 worker 分别拥有自己的连接池。
- 显式设置连接池参数，先保持当前每进程最多 10 个连接、30 秒空闲超时、5 秒建连超时的行为，再根据验证结果调整。进程退出使用 Prisma 的关闭流程。
- 明确 CLI、Web、worker 和测试的环境变量加载方式；生成客户端不依赖认证模块初始化，也不能要求构建时连接正式数据库。
- Better Auth 切换到 `prismaAdapter(prisma, { provider: 'postgresql', transaction: true })`。本地安装版本的适配器默认关闭事务，必须显式开启。
- 核对所有认证字段映射，包括用户时间和邮箱验证字段、`twoFactorEnabled`、session 的 `method`、Passkey、rate limit、OPAQUE 的 `registrationRecord`。
- 认证 schema 的生成结果只用于核对和维护 Prisma schema。撤除运行时 `getMigrations(auth.options).runMigrations()`，避免两个系统分别管理数据库结构。
- 检查 OPAQUE 的 `runWithTransaction`、`getCurrentAdapter`、一次性票据消费和用户行锁，确认整个原子操作使用同一个事务客户端。依赖事务的 hooks 不能意外调用全局客户端另开连接。
- 保留已有用户 ID、会话、Passkey、TOTP 密文、OPAQUE 注册记录，以及 `BETTER_AUTH_SECRET`、`ENCRYPTION_KEY` 和 OPAQUE server setup。迁移测试应验证已有账户和会话的兼容性。
- 建立显式 DTO 转换：日期输出仍为 ISO 字符串；Decimal 按现有接口输出字符串；BigInt 在明确范围校验后转换或输出约定字符串；处理 JSON null 与数据库 NULL 的区别。
- 数据库模型类型只在服务端使用，前端继续使用明确的接口类型。查询使用必要的 `select`，返回 DTO 前显式去除凭据和内部字段。

交付物：客户端工厂、事务类型、DTO/错误转换、Better Auth Prisma 集成及认证回归结果。

**4. 分模块迁移常规查询**

执行顺序为：商品与配置读取 → 角色权限与管理功能 → 用户与认证辅助查询 → 账户明细与报表 → 订单与资金写入 → worker 和脚本。

- 用 `findUnique`、`findMany`、`create`、`update`、`updateMany`、`deleteMany`、关联查询及聚合替换普通 SQL，保持现有业务函数及 HTTP 接口契约。
- 替换 `PoolClient` 参数为明确的 Prisma 事务客户端类型。必须在事务内执行的函数不提供隐式回退到全局客户端的默认值。
- 将旧 `row<T>` 的命名与日期转换改为模型映射及 DTO 转换。清除“任意 SQL 结果直接断言成业务类型”的路径。
- 对 JSON 配置、定价快照、商品 features 和权限字段做明确验证。需要合并更新的配置必须保留原有原子性，避免读取整块 JSON 后覆盖其他并发修改。
- 显式保持查询排序、空结果、可空字段与聚合结果格式，防止 Prisma 的 Date、Decimal、BigInt、Json 类型渗入既有 API。
- 统一数据库错误转换：唯一冲突、外键冲突、目标不存在、事务冲突分别映射到现有业务结果；覆盖原先检查 PostgreSQL `23505` 的路径，并区分 Prisma 模型查询错误和原生查询错误。
- 拆出范围有限的原生查询模块，按用途组织锁、任务领取、原子限流和必要聚合。统一使用 Prisma 参数绑定，不拼接不可信 SQL。
- 原生查询结果仍需显式类型和必要的校验；仅写 `$queryRaw<T>` 不等于 Prisma 已验证返回类型。

交付物：全部常规访问使用模型 API，原生查询清单可审查，API 返回行为保持兼容。

**5. 验证资金、库存与后台任务的并发行为**

| 场景          | 必须保留的语义                                            |
| ------------- | --------------------------------------------------------- |
| 下单与钱包    | 用户/钱包行锁、请求参数摘要、余额与外部付款拆分、事务回滚 |
| 库存分配      | `FOR UPDATE SKIP LOCKED`、报价绑定、同一卡密只分配一次    |
| 支付回调      | 交易号唯一、金额和渠道核对、状态推进与流水原子提交        |
| 返佣与提现    | advisory lock 和行锁顺序、首单去重、可提现金额冻结        |
| 取消和退款    | 每单每种流水只写一次、迟到回调不复用已释放库存            |
| 履约恢复      | 原订单和稳定幂等标识、未知上游结果、版本检查与提交标记    |
| worker / 邮件 | 原子领取、租约与重试、过期任务回收、触发器产生事件        |
| 汇率与限流    | 条件更新、来源日期不倒退、原子计数和窗口重置              |

- 普通读取不能替代 `FOR UPDATE`。这些锁查询通过当前事务的 `$queryRaw` / `$executeRaw` 执行；锁顺序按既有流程保持一致。
- 对能够通过带条件的 `updateMany` 实现的状态竞争，检查受影响行数后再推进流程；无法等价表达的操作保留原子 SQL。
- 事务内处理重复记录优先采用数据库层去重，例如经过验证的 `skipDuplicates` 或 `ON CONFLICT`。不能假设捕获唯一冲突后，原 PostgreSQL 事务仍可继续执行。
- 保留数据库时间语义，特别是租约、限流、到期和结算；需要数据库 `now()` 的原子操作不机械改成客户端时钟。
- 当前下单和 Session 恢复事务内存在 AICDK 请求，单次请求超时为 30 秒，部分路径串行请求多次。逐路径制定上游总时限、获取连接/锁等待和 Prisma 事务超时预算，不能直接使用默认 5 秒交互事务超时。
- 为慢响应、超时、回滚和后续重试补充测试。只对可安全重放的纯数据库事务做有界冲突重试；包含上游操作的流程遵循原有幂等和未知结果恢复规则。
- 邮件和购买统计继续由数据库触发器产生，不同时再由应用插入相同事件。触发器须在 Prisma 写入和 Better Auth 写入后都保持生效。

交付物：资金、库存、认证和任务的并发不变量全部通过迁移后的数据库集成测试。

**6. 统一迁移、初始化、脚本和测试**

- `db:migrate` 改为 Prisma Migrate 的部署入口；增加明确的客户端生成、开发迁移和 seed 入口。正式环境使用 `migrate deploy`，开发迁移只针对独立开发数据库。
- 从 `scripts/migrate.ts` 拆出 seed，采用幂等且不覆盖管理员配置的初始化策略。商品演示价格、角色与默认设置不得随每次部署被重置；生产 seed 单独显式运行。
- `bootstrap-admin.ts` 迁移到 Prisma，保留所有者唯一初始化锁、拒绝覆盖和 OPAQUE 建号逻辑。
- 历史密文转换与业务数据回填有独立的版本和执行记录。已完成的 `v2:` 数据只核验，避免无意义地重写卡密、HMAC 或短期授权。
- `business.test.ts` 与 `aicdk-flow.test.ts` 使用同一套 Prisma migrations 建立测试结构，移除直接执行 `schema.sql` 的路径。fixture 和断言查询通过 Prisma。
- 客户端和迁移明确指向每个测试的隔离数据库/schema；验证 adapter 的 schema 配置与实际 SQL 所在 schema，不能仅沿用 `search_path` 并假设 Prisma 会遵循。
- 保留 `_test` 数据库名称检查。迁移验收和 CI 必须配置测试数据库，不能把集成测试全部 skipped 当作通过。
- 测试清理关闭各自客户端，不共享被其他 suite 提前关闭的全局连接池。E2E 使用同版本迁移过的独立演示环境。
- 构建和部署显式生成客户端。验证 Node 下的开发/测试和 Bun 下的生产服务、worker 均正常，并覆盖 worker 启动、领取任务与优雅退出。
- 完成后移除旧连接层、旧 schema 执行入口及 Better Auth 自动迁移调用，更新 README。历史 SQL 如需保留，只作明确标记的历史资料。

交付物：统一迁移与测试入口、更新的运行文档、旧访问路径清零。

**验收条件**

- [x] 空数据库仅通过 Prisma migrations 和显式 seed 即可启动 Web、worker 和认证。
- [x] 已有数据库副本完成基线接管后，原业务数据和数据库约束保持一致。
- [x] schema diff 与额外 catalog 核验通过，全部函数、触发器、CHECK、特殊索引仍存在并生效。
- [x] 迁移和 seed 的重复执行不会重置配置、重复初始化或改变资金记录。
- [x] 应用、脚本和测试无直接 `pg` 查询，无旧 `rows<T>` / `PoolClient`，所有数据库访问进入 Prisma。
- [x] 常规 CRUD 使用模型 API；原生 SQL 限于已列明的场景，参数化且有行为测试。
- [x] 既有邮箱登录、OPAQUE 登录/设密/改密、Passkey、TOTP、会话撤销和一次性票据行为通过测试。
- [x] 并发回调只入账一次，并发余额消费和提现不超支，库存不重复分配，worker 不重复领取有效租约。
- [x] 慢上游、失败回滚、未知结果恢复、失效报价、取消退款、访客订单认领和返佣回归通过。
- [x] 时间、金额、Decimal、BigInt、JSON、空值与前端接口格式兼容。
- [x] 类型检查、配置独立 `TEST_DATABASE_URL` 的测试、生产 E2E 与生产构建通过。
- [x] 在数据库副本上演练升级和应用回退，检查订单、钱包流水、提现和任务状态。

**上线与回退**

开发按上述阶段完成，正式切换安排一次维护窗口。首个 Prisma 版本保持原有物理结构与数据语义，避免将数据库重设计混入访问层迁移。

1. 在正式数据库副本上演练完整流程，固定通过验证的应用版本、schema 和 migration 校验值。
2. 停止 Web 写入并等待在途请求结束；停止 worker 并等待其当前任务退出。记录在途支付、履约和任务状态。
3. 备份数据库和现有应用版本；确认认证、业务加密及 OPAQUE setup 的备份可用。
4. 检查数据库已满足基线前置条件；对既有库标记基线已应用，再执行待部署迁移。全新库执行完整迁移。该流程不使用 `db push` 或 `migrate reset`。
5. 启动新版本，验证认证、读写、任务领取、支付回调及金额流水，再恢复正常流量。
6. 出现问题时先停写、停止 worker。若结构和数据保持兼容，回退到先前经过验证的应用版本，保留迁移历史。
7. 只有实际需要恢复数据时才使用备份恢复；开放写入后先核对新增支付和订单，制定补账/补偿方案，不能直接覆盖新产生的数据。

本次完成代码迁移、本地数据库接管及上述验收。正式环境发布仍按本节维护窗口和备份流程执行；本次未部署远程环境。

**依据**

- 当前仓库的数据库层、两份 SQL、认证与 OPAQUE 实现、worker、业务服务和测试。
- 本地 `@better-auth/prisma-adapter` 的类型和实现：`transaction` 默认值为 `false`。
- 当前安装 Next.js 的 `node_modules/next/dist/docs/` 中 Data Security 与 `serverExternalPackages` 指南。
- Prisma ORM v7 官方文档：Generators、Upgrade to Prisma ORM 7、Baselining、Unsupported database features、Transactions、Raw queries、Database features。
- Better Auth 官方 Prisma adapter 文档及与本项目安装版本的实现核对。
