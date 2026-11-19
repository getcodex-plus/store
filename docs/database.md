# 数据库维护

[返回 README](../README.md)

## 新数据库

项目使用 PostgreSQL 18。先创建数据库和应用 schema，再配置 `DATABASE_URL`；默认 schema 为 `public`，自定义 schema 通过连接串的 `schema` 查询参数指定。

```sh
bun run db:init
bun run db:seed
bun run db:verify
```

- `db:init` 在事务内执行 `prisma/init.sql`；只接受已有且为空的 schema，发现已有表或函数时拒绝执行，不清空数据。
- `db:seed` 补齐缺失的商品、设置和角色记录，不覆盖现有商业配置。
- `db:verify` 按 `prisma/database-contract.json` 检查列、约束、索引、触发器和函数。
- `db:generate` 根据 `prisma/schema.prisma` 生成 Prisma Client，不修改数据库。

本项目以初始化 SQL 和增量 SQL 管理数据库结构。不要用 `prisma db push` 替代这些脚本，否则可能遗漏约束、触发器等数据库行为。

## 已有数据库

更新前备份数据库并记录当前版本。先在备份副本中验证所需 SQL，再安排维护窗口、停止 Web 与 Worker，执行对应更新。

以下脚本按功能引入顺序列出；只执行当前数据库缺少的更新，并在**应用实际使用的 schema** 下运行：

| 更新脚本                                                                             | 用途                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`add-fulfillment-resolution.sql`](../prisma/updates/add-fulfillment-resolution.sql) | 人工确认兑换结果及处理记录                                                  |
| [`add-coupons.sql`](../prisma/updates/add-coupons.sql)                               | 优惠码与使用记录                                                            |
| [`add-downstream-procurement.sql`](../prisma/updates/add-downstream-procurement.sql) | 上游采购与 SKU 映射；下架升级商品并停用升级专用券，保留历史订单、库存和报价 |
| [`add-order-refills.sql`](../prisma/updates/add-order-refills.sql)                   | 原单免费补充记录及手动退款锁定约束；旧订单默认无补充记录                    |

使用 `psql` 时启用 `ON_ERROR_STOP`；自定义 schema 必须先设置正确的 `search_path`。不要直接把带 Prisma `?schema=` 参数的连接串传给 `psql`。

更新完成后运行：

```sh
bun run db:generate
bun run db:verify
bun run db:seed
```

然后以相同代码版本启动 Web 与 Worker。新增优惠码功能后，`db:seed` 也用于补齐内置运营、客服角色的权限。

`bun run db:update-commercial-policy` 会更新已有商品的默认售价和默认返佣比例，仅在明确需要应用仓库的商业配置时使用，不是每次升级的必需步骤。

## 修改数据库结构

同时维护以下文件：

1. `prisma/schema.prisma`：应用模型。
2. `prisma/init.sql`：全新数据库的完整结构。
3. `prisma/database-contract.json`：结构验证契约。
4. `prisma/updates/`：已有数据库需要的增量更新。

在独立空 schema 验证初始化、种子数据与结构检查，并在旧版本的测试数据库副本中验证升级。不要对开发或生产业务库执行测试清理。
