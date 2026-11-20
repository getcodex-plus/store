# 版本发布

1. 在目标提交上完成[开发与测试](development.md)中的检查；涉及数据库时，在空库验证初始化，并在存量库副本上验证迁移。
2. 推送目标提交，在 **GitHub Actions → Release → Run workflow** 选择分支，填写不带 `v` 的版本。预发布版本需勾选 `prerelease`。
3. [Release 工作流](../.github/workflows/release.yaml)通过测试后，为已验证的提交创建 `v<version>` 标签和 Draft Release。在草稿中写明变更、迁移步骤和未验证范围，核对标签后在 GitHub 页面发布。
4. [Docker 工作流](../.github/workflows/docker.yaml)将多架构镜像推送到 `ghcr.io/getcodex-plus/store`。确认构建成功，记录镜像摘要，再按[生产部署](deployment.md)更新。

正式版更新 `latest`；预发布版不更新它。生产部署固定具体版本或摘要，不跟随可变标签。CI 不代替目标环境的支付、邮件与上游联调。
