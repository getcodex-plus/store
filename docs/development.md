# 开发与测试

[返回 README](../README.md)

先按 [快速开始](../README.md#快速开始) 安装依赖并启动本地数据库。使用 Bun 锁文件安装，不混用其他包管理器生成锁文件。

## 目录结构

| 路径                       | 职责                                         |
| -------------------------- | -------------------------------------------- |
| `src/app/`                 | Next.js 页面、布局与 API 路由                |
| `src/components/`          | 商城、账户与管理界面                         |
| `src/server/`              | 认证、订单、支付、库存、采购、兑换与后台任务 |
| `src/server/integrations/` | 外部服务适配                                 |
| `prisma/`                  | 数据模型、初始化 SQL、结构契约与增量更新     |
| `scripts/`                 | 数据库初始化、管理员创建与测试入口           |
| `tests/`                   | Playwright 端到端用例                        |
| `.github/workflows/`       | 检查、Release 与容器发布                     |
| `docs/`                    | 部署、使用及维护说明                         |

修改 Next.js 相关代码前，阅读安装版本的 `node_modules/next/dist/docs/` 中对应指南；具体要求见根目录 [AGENTS.md](../AGENTS.md)。

## 常用命令

| 命令               | 用途                                     |
| ------------------ | ---------------------------------------- |
| `bun run dev`      | 生成 Prisma Client，启动本地 Web         |
| `bun run worker`   | 启动独立 Worker                          |
| `bun run check`    | 生成 Prisma Client，运行 TypeScript 检查 |
| `bun run test`     | Vitest 单元与数据库集成测试              |
| `bun run test:e2e` | 初始化独立测试 schema，运行 Playwright   |
| `bun run build`    | 生成 Prisma Client，构建生产版本         |
| `bun run start`    | 启动已构建的 Web                         |

数据库命令和升级约定见 [数据库维护](database.md)。

## 测试数据库

测试需要独立数据库，名称必须以 `_test` 结尾；本地 Compose 启动后可创建：

```sh
docker compose exec db createdb -U getgpt getgpt_test
```

只需创建一次，已有同名测试库时跳过。测试会创建和清理各自的临时 schema，不应连接含业务数据的数据库。

```sh
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run build
```

未设置 `TEST_DATABASE_URL` 时，本地会跳过数据库集成测试；CI 会直接报错。因此仅运行不带测试数据库的测试不能作为完整发布验证。

## 端到端测试

```sh
bunx playwright install chromium
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test E2E_PRODUCTION=true bun run test:e2e
```

生产 E2E 要先执行 `bun run build`。测试默认启动 `http://localhost:3100` 的独立演示服务，端口必须可用；运行结束后清理临时 schema。使用 `bun run test:e2e` 入口，不直接调用 Playwright 跳过数据库准备。

可向命令追加用例路径来缩小验证范围。GA4 条件用例的构建和执行配置见 [SEO 与统计](growth-and-seo.md)。

演示模式不会验证真实支付、邮件或上游兑换；这些需在目标环境另行联调。测试日志、截图和 `.data/` 中的临时证据均不提交到 Git。
