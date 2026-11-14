# Prisma 数据库运行手册

2026-11-14。Web、worker、Better Auth、脚本和测试已统一使用 Prisma。依赖锁定为 Prisma Client、CLI、PostgreSQL adapter 7.10.1；配置入口为 `prisma7.config.ts`，生成代码位于忽略提交的 `src/generated/prisma/`。

## 全新数据库

保留项目现有 `.env` 和密钥。全新环境按 `.env.example` 配置 PostgreSQL 18 后执行：

```sh
bun install --frozen-lockfile
bun run db:migrate
bun run db:seed
bun run db:verify
bun run dev
```

另开进程运行 `bun run worker`。`db:migrate` 只应用版本化迁移；`db:seed` 显式补充缺失商品、默认设置、角色和汇率任务，重复执行保留已有价格、设置及角色修改。seed 不填充虚构汇率，普通运行的汇率缓存由 worker 获取。

安装、开发、构建、类型检查和测试入口均生成客户端。生产发布使用 `bun run build` 后运行 `bun run start`，worker 单独运行。Better Auth 不再负责创建或升级数据库表。

## 已有数据库首次接管

先在数据库备份副本演练，再停止 Web 写入和 worker，等待在途请求结束。备份数据库以及原有 `ENCRYPTION_KEY`、`BETTER_AUTH_SECRET`、OPAQUE server setup，并保留上一应用版本。不要更换这些密钥。

1. `bun run db:verify --baseline` 检查基线的列、默认值、约束、索引、函数、触发器和认证/密文前置条件；此时不要求尚未应用的后续迁移。
2. 如果数据库仅缺少已识别的 AICDK v2 / OPAQUE 结构增量，运行 `bun run db:upgrade-legacy`。它只接受白名单中的结构差异，先检查数据前置条件，再在事务中补齐字段、索引和约束，最后重新核验。
3. `bun run db:baseline` 再次完整核验，然后把 `00000000000000_baseline` 标记为已应用。已记录基线时重复执行只验证状态。
4. `bun run db:migrate` 应用后续迁移，执行 `bun run db:risk-backfill` 补齐历史提现的风控关联摘要，接着运行 `bun run db:verify`。
5. 启动应用和 worker，核对登录、已有会话、订单、钱包、提现和任务状态。

兼容桥保留全部既有表和记录。旧报价标记为流程版本 1，新报价默认版本 2；已有短期授权补齐过期时间，新增提交标记时将处理中及待补 Session 订单保守视为可能已提交。它不重置商品、业务配置或资金数据。

出现其他结构差异、旧版密文、恢复码材料或 Passkey/MFA 不一致时，脚本会拒绝接管。先使用对应旧版本完成其历史升级并再次演练。`prisma/legacy/schema.sql` 和 `auth-invariants.sql` 仅作历史资料，不能当作当前迁移入口。

`bun run db:credentials` 是当前完整 schema 上的独立凭据维护操作：事务内升级旧密文并校验 HMAC；已正确迁移的数据不会无意义重写。它不由 deploy、seed 或 baseline 自动触发。需要该操作时使用原有加密密钥、先停写并备份。

接管不使用 `db push`、`migrate reset`，也不删除旧认证表。除新增 `_prisma_migrations` 外，Prisma 模型保持原物理表名、列名和 ID 规则。

后续 ZEN 风控迁移增加 `risk_events`、提现关联摘要及索引；不修改基线对象。`db:baseline` 始终按原基线核验，普通 `db:verify` 还检查风控迁移是否完成。升级与规则说明见 [统一风控](risk-control.md)。

## 查询和事务约定

- `src/server/db.ts` 提供客户端和事务工厂。每个进程最多 10 个连接，建连超时 5 秒，空闲超时 30 秒；开发热更新复用单例，脚本和 worker 退出时调用 `$disconnect()`。
- PostgreSQL 连接固定为 UTC；URL 的 `schema` 同时配置 adapter 和 `search_path`，防止模型查询、原生 SQL 和函数访问不同 schema。
- 普通事务等待连接上限 10 秒、运行上限 10 秒。含 AICDK 调用的下单及 Session 恢复路径显式使用 100 秒预算，覆盖最多三次各 30 秒的请求。
- 常规 CRUD 使用模型 API。`database-sql.ts` 保留行锁、advisory lock、数据库时钟、库存分配、原子限流、统计聚合、任务租约等必要 PostgreSQL 操作，统一经 Prisma 参数绑定执行。
- Better Auth 使用 Prisma adapter 并显式开启事务；依赖事务的用户/会话 hooks 通过当前认证 adapter 查询。认证数据的物理映射由 Prisma schema 维护。
- `data.ts` 负责公开 DTO：日期转 ISO，金额保持整数分，Decimal 保留六位小数字符串，JSON 经相应边界解析。内部凭据和 ORM 类型不直接作为接口响应。

## 创建后续迁移

在独立开发数据库或 schema 中运行 `bun run db:dev --name <name>`。先审查生成的 SQL，再提交 `schema.prisma`、迁移目录和经核对的 `database-contract.json`。当前本地库保留额外历史认证表，不应用它直接生成带删除操作的迁移。

基线还管理 schema 文件不能完整表达的 CHECK、部分/表达式索引、六个函数和六个触发器。新增迁移必须保留这些对象；`prisma migrate diff` 不能代替 catalog 核验。`db:verify` 对受管理对象执行逐项比较，允许额外历史表继续存在。

## 自动化验证

`TEST_DATABASE_URL` 必须指向名称以 `_test` 结尾的专用 PostgreSQL 数据库，测试账户需要创建/删除 schema 的权限。

```sh
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55479/getgpt_test bun run test
bunx playwright install chromium
bun run build
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55479/getgpt_test E2E_PRODUCTION=true bun run test:e2e
```

单元和集成测试默认由 Vitest 执行；每个数据库测试 suite 独立创建随机 `test_*` schema，使用同一套 Prisma migrations，并在结束时清理。未提供测试库时本地数据库 suite 会跳过，CI 会直接报错；迁移验收必须配置测试库。

E2E 入口自动创建独立 schema、迁移、seed，并写入确定性的 USD/USDT 汇率 fixture；结束后清理该 schema。启动自己的演示 Web 服务，默认 `http://localhost:3100`，管理员测试账号为 `admin@example.com`，不复用正在运行的开发服务。可用 `E2E_BASE_URL` 指定其他本地 HTTP 端口，并向命令追加 Playwright 参数。直接执行 `playwright test` 会提示改用准备数据库的项目入口。

客户端生成会重写生成目录，避免在正在导入客户端的测试或进程旁并行运行 `db:generate`。

## 回退

首个 Prisma 版本保留原有业务数据和物理结构。经过副本验证的上一应用版本可以在停写、停止 worker 后切回，保留 `_prisma_migrations`；不要重新运行旧版的自动升级入口。与本次 ORM 迁移之前的密文格式升级不同，Prisma 接管本身不重加密业务数据。

如果需要恢复数据库备份，先核对切换之后新增的订单、收款和钱包流水，安排补账或补偿，再决定恢复范围。不能用旧备份直接覆盖已经恢复写入后的新交易。
