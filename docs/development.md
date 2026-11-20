# 开发与测试

按 [README 快速开始](../README.md#快速开始) 安装依赖并启动 Web 和 Worker。页面与接口在 `src/app/`，业务逻辑在 `src/server/`。修改 Next.js 代码前先读 [AGENTS.md](../AGENTS.md)。

## 运行检查

数据库集成测试和 E2E 必须使用独立的 `_test` 库；测试会创建和清理临时 schema，不要连接业务库。本地 Compose 使用端口 `55439`。

```sh
docker compose up -d db
docker compose exec db createdb -U getgpt getgpt_test  # 仅首次
export TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test
bun run check
bun run test
bun run build
```

未设置 `TEST_DATABASE_URL` 时，本地会跳过数据库集成测试。生产构建完成后，可在同一终端运行 Playwright：

```sh
bunx playwright install chromium
E2E_PRODUCTION=true bun run test:e2e
```

单元测试和 E2E 分别报告通过、跳过和未运行的范围。文档变更运行 `scripts/ci/check-doc-consistency.sh`；演示环境不能替代真实渠道联调。
