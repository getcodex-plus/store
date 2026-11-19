# 安全说明

## 报告漏洞

请勿在公开 Issue、Pull Request 或日志附件中披露漏洞利用细节、真实凭证或客户数据。

仓库启用私密漏洞报告后，使用 [GitHub 私密漏洞报告入口](https://github.com/getcodex-plus/store/security/advisories/new)。如果入口不可用，请先通过仓库维护者公开提供的联系方式请求私下报告渠道；本项目尚未公布独立安全邮箱。

报告应包含受影响版本、复现条件、最小复现步骤、预期影响及可选修复建议。使用测试账号、模拟卡密和脱敏日志，不附真实客户 Session、支付密钥或数据库备份。

## 版本与修复

当前尚未建立多个版本分支的安全维护周期。报告时请注明具体提交或镜像摘要；修复后的适用版本和部署步骤应在对应 Release 中说明。

## 部署边界

- `APP_MODE=demo` 仅用于本地演示，正式站点使用 `live` 和 HTTPS。
- 由网关处理代理链与来源信任，覆盖 `X-Forwarded-For` 为单个客户端 IP；应用端口仅对网关开放。
- 保护数据库及 `ENCRYPTION_KEY`、`BETTER_AUTH_SECRET`、OPAQUE setup，并单独备份密钥。
- 不在客户 Session、支付结果或上游兑换结果不确定时直接重放真实操作；先核对记录，避免重复扣款或交付。

完整配置与运行要求见 [生产部署](docs/deployment.md)。
