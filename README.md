# GetCodex Plus

面向终端用户的 GPT 充值与升级网站，支持游客购买、钱包抵扣、邀请返现和后台管理。AICDK 负责兑换执行。

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

## 站点配置

在 `/admin` 配置商品售价与库存、AICDK、收款渠道、邮件服务和网站设置。

- 普通套餐使用固定售价；升级套餐按账号实时成本和后台利润规则报价。
- 支付支持 XorPay、GMPay、易支付，以及登录用户的钱包抵扣。
- 邮件支持 Resend、Sendflare、SMTP；Turnstile 可分别保护登录和购买。
- 网站设置中填写支持邮箱、账号操作指引和可选的 Tawk.to 客服参数。
- 密钥只写不回显；订单绑定服务配置版本，处理完成前需保持对应凭证可用。

## 部署

1. 使用独立 PostgreSQL 数据库；Compose 的本地 trust 配置不用于正式环境。
2. 配置 `APP_MODE=live`、`APP_URL=https://getcodex.plus`、`DATABASE_URL` 及 `.env.example` 中的加密与认证密钥。密钥需安全备份。
3. 对空库执行 `db:init`、`db:seed`、`db:verify`。
4. 设置 `ADMIN_EMAIL` 和 `BOOTSTRAP_PASSWORD_FILE`（权限 0600，密码 16–128 字符），执行 `bun run admin:bootstrap`。完成邮件与账号安全配置后删除密码文件。
5. 在后台配置实际商品、价格、库存和服务，完成真实渠道联调。
6. 执行 `bun run build`，分别启动 `bun run start` 和 `bun run worker`，通过 HTTPS 网关提供服务。登录、风控和支付统一使用 Better Auth 的解析规则读取网关提供的 `X-Forwarded-For`，无需单独配置代理信任开关。

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
