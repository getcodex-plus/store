# GetCodex Plus

getcodex.plus 的下游充值站：通过 Dujiao-Next 协议采购兑换码，映射到本地充值套餐后由 AICDK 执行兑换。支持游客购买、钱包抵扣和邀请返现；不销售订阅差价升级。

技术栈：Bun、Next.js App Router、React、Ant Design、PostgreSQL、Prisma 和 Better Auth。本项目尚未上线，按全新站点初始化。

## 本地运行

需要 Bun 1.4.4+、Node.js 22.12+ 和 PostgreSQL 18。

```sh
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d db
bun run db:init
bun run db:seed
bun run db:verify
bun run dev
```

已有 `.env` 时直接检查配置，不要覆盖。Compose 的数据库端口为 `55439`，使用其他数据库时修改 `DATABASE_URL`。

另开终端执行 `bun run worker`，处理兑换、通知、汇率与定期清理任务。访问 `http://localhost:3000`，保持访问地址与 `APP_URL` 一致。

默认 `APP_MODE=demo`，使用示例账号信息和模拟支付、兑换；验证码显示在页面，使用 `ADMIN_EMAIL` 登录可体验后台。演示密钥自动保存在 `.data/`。

## 数据库

- `prisma/schema.prisma` 定义 Prisma 模型；`prisma/init.sql` 创建当前完整结构，包括约束、索引和触发器。
- `db:init` 只接受空 schema，并在事务内完成初始化；已有表时直接拒绝，不清空数据。
- `db:seed` 补充商品、配置、角色等默认记录；`db:verify` 检查结构。
- 调整数据库结构时同步更新模型、初始化 SQL 和 `prisma/database-contract.json`，运行 `db:generate` 后在空的测试 schema 中验证。
- 已有数据库启用人工兑换处理功能前，在应用 schema 执行 `prisma/updates/add-fulfillment-resolution.sql`，再运行 `db:verify`；该脚本只补充处理记录字段，不清空订单。全新数据库已由 `db:init` 包含此字段。
- 从旧版迁移时，先备份数据库，在应用 schema 执行 `prisma/updates/add-downstream-procurement.sql`，再运行 `bun run db:verify`。迁移只新增进货表、下架升级商品并停用升级专用券，不删除历史订单、库存或报价。

## 站点配置

在 `/admin` 配置商品售价与库存、Dujiao-Next 进货、AICDK 兑换、收款渠道和邮件服务。

- 套餐使用独立的本地固定售价。先在「支付与服务」配置上游 `https://getcodex.plus` 的 API Key / Secret，再到「商品管理 → 上游进货与 SKU 映射」读取目录、绑定 SKU 并提交采购。进货默认未启用；演示环境不会扣款。
- 进货与兑换均由 `bun run worker` 主动轮询，不要求任何 Webhook。可选的 AICDK 通知默认关闭，只用于提前唤醒查询，不能确认履约或收款。
- 支付支持 XorPay、GMPay、易支付，以及登录用户的钱包抵扣。
- 邮件支持 Resend、Sendflare、SMTP；Turnstile 可分别保护登录和购买。
- 网站设置中填写支持邮箱、账号操作指引和可选的 Tawk.to 客服参数。
- 网站设置 → 邀请返现支持新增、删除返利等级，自定义名称、有效邀请门槛和比例（0–9%）。至少保留一级，首级门槛为 0，后续门槛递增、比例不下降；删除指定等级后用户恢复自动计算，新规则仅影响新订单。
- 密钥只写不回显；订单绑定服务配置版本，处理完成前需保持对应凭证可用。

## 部署

1. 使用独立 PostgreSQL 数据库；`compose.yaml` 中的本地 `trust` 配置仅用于开发，不用于正式环境。
2. 配置 `APP_MODE=live`、`APP_URL`（下游自己的 HTTPS 域名，不是供货站域名）、`DATABASE_URL` 及 `.env.example` 中的加密与认证密钥。密钥需安全备份。
3. 对空库执行 `db:init`、`db:seed`、`db:verify`。
4. 设置 `ADMIN_EMAIL` 和 `BOOTSTRAP_PASSWORD_FILE`（权限 0600，密码 16–128 字符），执行 `bun run admin:bootstrap`。完成邮件与账号安全配置后删除密码文件。
5. 在后台配置实际商品、价格、库存和服务，完成真实渠道联调。
6. 执行 `bun run build`，分别启动 `bun run start` 和 `bun run worker`，通过 HTTPS 网关提供服务。登录、风控和支付统一使用 Better Auth 的解析规则读取网关提供的 `X-Forwarded-For`，无需单独配置代理信任开关。

## Docker 部署

项目根 `Dockerfile` 提供多阶段生产镜像，默认以非 root 用户 `bun` 启动 `web`（`0.0.0.0:3000`），也支持通过参数运行 `worker`、`db:init`、`db:seed`、`db:verify`、`admin:bootstrap` 与 `healthcheck`。

```sh
# 本地构建镜像（如需启用 GA4，构建与运行时均需传入 NEXT_PUBLIC_GA_ID）
docker build -t getcodex-plus:local .
```

生产环境使用 `compose.prod.yaml`（带强密码 PostgreSQL 18、只读根文件系统与最小权限），可叠加 `compose.ghcr.yaml` 与 `compose.traefik.yaml`，外部数据库可使用 `compose.external.yaml`：

```sh
# 1. 初始化并校验空数据库
docker compose -f compose.prod.yaml up -d postgres
docker compose -f compose.prod.yaml run --rm web db:init
docker compose -f compose.prod.yaml run --rm web db:seed
docker compose -f compose.prod.yaml run --rm web db:verify

# 2. 启动 web 与 worker（或叠加 -f compose.ghcr.yaml -f compose.traefik.yaml）
docker compose -f compose.prod.yaml up -d --build
```

创建初始管理员时，可将受保护的密码文件挂载进容器执行 `admin:bootstrap`：

```sh
docker compose -f compose.prod.yaml run --rm \
  -v /path/to/bootstrap-password:/run/secrets/bootstrap-password:ro \
  -e BOOTSTRAP_PASSWORD_FILE=/run/secrets/bootstrap-password \
  web admin:bootstrap
```

## 发布流程

- `.github/workflows/test.yaml`：在 `push`、`pull_request` 或手动触发时运行类型检查、单元测试与 PostgreSQL 集成测试、`next build` 及容器健康冒烟测试。
- `.github/workflows/release.yaml`：手动触发，输入不带 `v` 前缀的版本号（如 `1.0.0` 或 `1.0.0-rc.1`）与 `prerelease` 标记，校验版本格式、验证构建并创建带 `v` 前缀的 Tag 与 Draft Release。
- `.github/workflows/docker.yaml`：在 Release 发布或转正时触发，校验版本号后构建并推送 `linux/amd64` 与 `linux/arm64` 多架构镜像至 GHCR（含 `version`、`prereleased`、`latest`（仅正式版）及 `sha` 标签，并附带 Provenance 与 SBOM）。

## 开发验证

```sh
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bunx playwright install chromium
bun run build
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test E2E_PRODUCTION=true bun run test:e2e
```

先创建名称以 `_test` 结尾的独立测试数据库。集成测试和 E2E 自动创建、初始化并清理各自的临时 schema；E2E 默认启动本地 3100 端口服务。未设置 `TEST_DATABASE_URL` 时本地跳过数据库测试，CI 会报错。

## 使用说明

- [订单与服务配置](docs/orders-and-services.md)
- [兑换码与导入批次](docs/inventory-batches.md)
- [邀请返现与提现](docs/invitations-and-withdrawals.md)
- [风控](docs/risk-control.md)
- [SEO 与统计](docs/growth-and-seo.md)
- [发布前验收记录](docs/release-acceptance.md)
