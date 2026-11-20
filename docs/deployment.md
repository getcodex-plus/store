# 生产部署

生产环境需要 Web、Worker 和 PostgreSQL 18。Web 与 Worker 必须使用同一数据库和同一组密钥。

## 准备配置

首次部署从 [`.env.example`](../.env.example) 复制 `.env` 并限制读取权限；已有配置不要覆盖。

- 设置 `APP_MODE=live`、`ADMIN_EMAIL` 和 `APP_URL`。`APP_URL` 是本站可从公网访问的 HTTPS 地址，支付网关需要回调到这个域名。
- 分别运行 `openssl rand -hex 32` 生成独立的 `ENCRYPTION_KEY` 和 `BETTER_AUTH_SECRET`。用 `bunx @serenity-kit/opaque@0.9.0 create-server-setup` 生成 `OPAQUE_SERVER_KEY`。密钥与数据库分开备份，升级时保持原值。
- 内置数据库需要 `POSTGRES_PASSWORD`，并应移除示例中的开发用 `DATABASE_URL`。使用外部数据库则填写可从容器访问的完整连接串。

## 从源码首次启动

```sh
docker compose -f compose.prod.yaml build
docker compose -f compose.prod.yaml up -d postgres
docker compose -f compose.prod.yaml run --rm web db:init
docker compose -f compose.prod.yaml run --rm web db:seed
docker compose -f compose.prod.yaml run --rm web db:verify
```

`db:init` 只用于空 schema。已有库走[数据库更新流程](database.md#更新已有数据库)。

将初始管理员密码（16–128 字符）放进仅自己可读的临时文件；把下面的输入路径替换为该文件。密码不会出现在命令行，容器退出后会删除。

```sh
docker compose -f compose.prod.yaml run --rm -T web sh -c \
  'umask 077; cat > /tmp/admin-password; BOOTSTRAP_PASSWORD_FILE=/tmp/admin-password bun scripts/bootstrap-admin.ts' \
  < /protected/path/admin-password
docker compose -f compose.prod.yaml up -d web worker
```

登录 `/admin` 确认所有者身份后，删除宿主机临时密码文件。

## 其他部署方式

| 方式 | 与源码部署的区别 |
| --- | --- |
| GHCR 镜像 | 将 `GETCODEX_IMAGE` 固定为发布版本或摘要，所有 Compose 命令叠加 `-f compose.ghcr.yaml`。用 `pull web worker` 替代 `build`，启动时加 `--no-build`。 |
| 外部数据库 | 用 `-f compose.external.yaml` **替代** `-f compose.prod.yaml`，跳过启动 `postgres`。 |
| Traefik | 预先配置网关网络、证书解析器及 `APP_DOMAIN`，在 Compose 命令中叠加 `-f compose.traefik.yaml`。 |
| 本机 Bun | 按 [README](../README.md#快速开始) 安装依赖，使用正式配置初始化数据库，用 `BOOTSTRAP_PASSWORD_FILE` 运行 `bun run admin:bootstrap`。构建后分别托管 `bun run start` 和 `bun run worker`。 |

## 开放购买前

1. 配置 HTTPS 网关，只让网关访问 Web 端口。网关须将 `X-Forwarded-For` **覆盖**为单个客户端 IP。
2. 在「网站设置」填写站名和支持邮箱，在「支付与服务」配置上游、支付和邮件。核对[套餐售价与 SKU 映射](inventory-batches.md)后，再启用对应渠道。
3. 确认支付回调可达、服务器时钟同步、Worker 能处理订单。用目标环境验证支付、交付和邮件；`/robots.txt` 健康检查只证明 Web 可响应。

后续更新、备份和异常订单处理见[运维手册](ops-runbook.md)。
