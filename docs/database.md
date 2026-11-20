# 数据库维护

## 新数据库

创建 PostgreSQL 18 数据库和空 schema，设置 `DATABASE_URL`，依次运行：

```sh
bun run db:init
bun run db:seed
bun run db:verify
```

`db:init` 只接受已存在的空 schema；`db:seed` 补齐默认记录，不覆盖现有售价。不要用 `prisma db push` 替代初始化或迁移，它不会安装全部数据库约束和触发器。

## 更新已有数据库

1. 备份数据库，在副本上验证更新。早于迁移账本的旧库，先核对是否缺少 [`prisma/updates/`](../prisma/updates/) 中的历史更新。
2. 用**新版本**运行 `bun run db:migrate`，再运行 `bun run db:verify`。使用生产 Compose 时：

   ```sh
   docker compose -f compose.prod.yaml run --rm --no-deps web migrate
   docker compose -f compose.prod.yaml run --rm --no-deps web db:verify
   ```

3. 校验通过后再更新 Web 和 Worker。发布时先增加兼容字段，等旧进程退出后再单独发布删除字段的版本。

迁移按编号执行，每个文件独立提交，`schema_version` 记录校验和。不要修改已执行的迁移；没有反向迁移，需要还原数据时使用迁移前的备份。

## 开发时改表

同步更新 [`schema.prisma`](../prisma/schema.prisma)、[`init.sql`](../prisma/init.sql)，并在 [`prisma/migrations/`](../prisma/migrations/) 新增 `NNNN_名称.sql`（名称仅用小写英文字母、数字、下划线）。在验证库应用迁移后运行 `bun scripts/ops/gen-contract.ts` 更新结构契约，再运行 `bun run db:verify`。
