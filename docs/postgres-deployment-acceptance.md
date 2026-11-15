# 真实 PostgreSQL 部署验收

验收日期：2026-11-15（Asia/Shanghai）。
代码基线：`4dc02b6`。

**结论：本次真实数据库 + 生产构建部署验收通过。** 应用通过 `next build`、`next start` 运行，连接真实 PostgreSQL 18 数据库，独立 worker 处理订单任务。浏览器操作产生的账户、订单、余额、流水和任务实际写入 PostgreSQL，重启 web 与 worker 后保留。

本次范围是应用部署后的页面、功能和数据库持久化。`APP_MODE=demo` 用于演示支付、邮箱验证码和上游兑换；没有执行真实扣款。本次不以真实商户渠道接入作为该部署验收的前提。

## 验收环境

| 项目 | 配置 |
| --- | --- |
| 页面入口 | `http://localhost:3200` |
| 后台入口 | `http://localhost:3200/admin` |
| PostgreSQL | 本机 PostgreSQL 18，端口 `55479` |
| 持久化验收数据库 | `getcodex_acceptance_20261115`，独立数据库、`public` schema |
| 自动回归数据库 | `getcodex_acceptance_20261115_test`，各测试使用独立临时 schema |
| web | Next.js 16.4.6 生产构建，`next start` |
| worker | `src/server/worker.ts` 独立进程 |
| 专用配置 | `.data/acceptance-deployment.env`，权限 `0600`，不纳入 Git |
| 浏览器验收用户 | `deployment-acceptance@example.com` |
| 后台用户 | `admin@example.com`，通过页面显示的本地验证码登录 |

保留了原 `.env` 和原数据库，未修改原库结构或业务数据。验收库和服务保留供继续查看。

## 部署与自动回归

| 检查 | 结果 |
| --- | --- |
| 新数据库初始化、默认数据初始化 | 通过；初始化 9 个商品及默认设置、角色等记录 |
| 数据库结构校验 | 通过：276 列、315 约束、68 索引、6 触发器、6 函数；浏览器验收后再次通过 |
| `bun run check` | 通过 |
| 生产构建 | 通过 |
| 单元与真实数据库集成测试 | 35 个文件、277 项通过，无跳过 |
| 生产构建 E2E | 50 项通过、4 项 GA 条件用例跳过，约 2 分钟 |
| web / worker 启动及重启 | 通过 |

E2E 包含账户与安全、钱包与购买、游客订单认领、权限、后台、库存、退款、推荐返现及响应式等已有用例。部分外部依赖由演示逻辑或测试替身处理；测试结果只适用于具体用例覆盖的范围。未配置 GA ID，因此不包含 GA 实际采集验证。

日志仍有上游初始化和 `pg` 并发调用的弃用提示；本轮未引发测试或运行失败。

## 共享浏览器与数据库对照

本节操作在持续运行的 `3200` 端口验收部署中完成，未通过测试夹具预写账户、订单或余额。

1. 打开首页，确认套餐与价格正常展示。
2. 使用 `deployment-acceptance@example.com` 走邮箱验证码注册、登录，打开钱包，初始余额为 `¥0.00`。
3. 从钱包创建 `¥300.00` 充值订单，获取支付信息，点击演示付款，订单页面显示“充值余额已到账”。
4. 打开 Plus 结算页，确认账号授权，验证账号与报价。页面显示可用余额 `¥300.00`；选中余额抵扣，提交 `¥135.00` 订单。
5. 订单先显示处理中，再由轮询更新为“充值完成，开始使用吧”。数据库确认 worker 任务完成，执行次数 1、无 `lastError`。
6. 停止并重新启动 web 与 worker，重新打开钱包。浏览器登录仍有效，余额保持 `¥165.00`，两条流水为 `+¥300.00` 和 `−¥135.00`。
7. 退出用户，登录管理员，进入后台。运营概览显示套餐成交 `¥135.00`、成功交付 1 笔、用户数 2；最近订单展示同一笔充值和购买，金额、抵扣、状态和下单 IP 与数据库一致。
8. 共享浏览器窄视口下检查钱包、结算、订单和后台，未出现整页横向溢出。已有完整 E2E 另外覆盖 320、375、768、1440 CSS px 等布局用例。

重启后的数据库证据（金额以分存储）：

| 记录 | ID | 状态 / 金额 |
| --- | --- | --- |
| 钱包充值 | `o_85e4d92a42afdb54915cb8c747d453f1` | `completed`，总额 `30000`，渠道金额 `30000` |
| Plus 购买 | `o_09954c878d73f1b03d2e4ef17582f83c` | `completed`，总额 `13500`，余额抵扣 `13500`，渠道金额 `0` |
| 用户钱包 | 对应浏览器验收用户 | `balance=16500` |
| 购买处理任务 | 对应 Plus 购买订单 | `done=true`、`attempts=1`、`lastError=null` |

本地证据文件：

- `.data/acceptance-persistence.json`：重启后数据库查询摘要。
- `.data/acceptance-unit.log`：单元与数据库回归日志。
- `.data/acceptance-e2e.log`：生产构建 E2E 日志。
- `.data/acceptance-web.log`、`.data/acceptance-worker.log`：重启后的运行日志。

## 原开发库发现的问题

原 `.env` 指向的 `getgpt` 数据库未通过当前结构校验：缺少 `orders.ip_address`，多出旧 `quotes.flow_version` 列及对应非空约束。此问题属于原开发库结构漂移；本次从当前初始化 SQL 新建的验收数据库通过了相同校验。

如果后续复用原开发库，需要先备份并对齐结构。当前通过结论针对上述独立验收部署，不应把原库直接当作已通过验收的数据库。

## 再次启动

当前服务已启动；只有停止后才需要执行下列启动命令。使用专用配置，避免误连原 `.env` 数据库：

```sh
# 数据库结构检查
bun --env-file=.data/acceptance-deployment.env scripts/verify-database.ts

# 如修改源码，先重新构建
bun --env-file=.data/acceptance-deployment.env run build

# 终端一：生产 web
bun --env-file=.data/acceptance-deployment.env --bun node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3200

# 终端二：worker
bun --env-file=.data/acceptance-deployment.env src/server/worker.ts
```

本次没有验证 PostgreSQL 进程重启、主机重启自动拉起、远端部署或备份恢复；“重启持久化通过”专指 web 与 worker 重启后的查询结果。
