# 司凤转发 · 发布到 GitHub

这份指南用于准备公开仓库与 Release。普通用户安装见 [README](../README.md)。项目当前不内置自动创建仓库、push、发 Release 或 npm publish 的步骤。

## 1. 先生成可公开的文件

在原项目根目录完成文档和测试检查后执行：

```sh
npm run docs:check
npm run package
npm run package:github
npm run release:verify
```

公开内容由 [release-files.mjs](../scripts/release-files.mjs) 的明确清单决定，包括源码、文档图片、测试、许可证、GitHub 工作流和 Issue 模板。

| 产物 | 用途 |
| --- | --- |
| `dist/dead-mom-sharing-0.2.1.zip` | 给普通用户的完整安装包：扩展 + 本地邮件服务 + 文档等 |
| `dist/dead-mom-sharing-extension-0.2.1.zip` | 仅扩展，适合不使用邮件或已有邮件服务的用户 |
| `dist/dead-mom-sharing-github-0.2.1.zip` | 公开源码包，内有统一的 `dead-mom-sharing/` 顶层目录 |
| `dist/github-ready/dead-mom-sharing-0.2.1-时间戳/` | 可直接作为 Git 仓库根目录的干净文件夹 |
| `dist/SHA256SUMS.txt` | 两个安装包的 SHA-256 |
| `dist/GITHUB-SHA256SUMS.txt` | 公开源码包的 SHA-256 |
| `dist/github-export.json` | 仅本机使用的最新导出路径与校验信息，不上传 |

脚本每次生成新的时间戳文件夹，不覆盖旧导出；ZIP 文件名保持版本号形式。重新生成前如需保留旧 ZIP，先备份。

## 2. 什么不会公开

`.env` 及其私密变体、`data/`、日志、数据库、日常浏览器配置、`node_modules/`、`test-results/`、`research/`、旧交接记录和本机需求／调研笔记不进入公开包。它们在原项目中保留，不会被导出脚本删除。

`release:verify` 检查 ZIP 文件集合、源文件字节、校验和、干净目录和 SVG；如果原目录有 `.env`，会在内存中用实际令牌、SMTP 密码和邮箱字段检查公开文件是否意外含有这些值，**不会打印值**。这能发现已知值泄漏，但不能替代人工查看新加入的文件。

`.gitignore` 只能防止未跟踪文件被新增，不能从已有 Git 历史移除秘密。若目标仓库已有真实凭证，先撤销／轮换并单独处理历史；不要认为这次导出已经修复旧仓库历史。

## 3. 创建仓库并上传

推荐在 GitHub 新建一个空仓库，例如命名为 `dead-mom-sharing`，再从**干净导出文件夹**上传。不要把正在运行、有个人配置的原目录整体拖到 GitHub。

可使用 GitHub Desktop 添加该干净文件夹并发布仓库；也可在干净文件夹里使用 Git。下面的 URL 是占位符，先换成你实际创建的仓库地址：

```sh
git init
git add .
git status --short
git commit -m "Prepare initial public release"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

提交前查看 `git status`：应该有 README、docs/images、extension、runner、tests、scripts、许可证、`.github/` 和配置模板；不应有真实 `.env`、日志、数据库或交接聊天。

如使用网页上传，不要只上传 ZIP 文件：将干净目录的内容作为源码提交，让根目录直接有 `README.md`，GitHub 才能显示图文首页。注意不要漏掉 `.github`、`.gitignore` 和 `.env.example` 这些点开头的文件；对隐藏文件不熟悉时优先用 GitHub Desktop 或 Git。

## 4. 创建 Release

源码提交并完成检查后，创建对应的 `v0.2.1` Release，附上完整包、独立扩展包、公开源码包以及两份校验和。Release 文案可使用 [更新日志](../CHANGELOG.md) 中对应版本的内容，并应说明：

- 需要开发者模式加载 `extension/`，未通过商店分发。
- 邮件告警可选；只有启用时需要 Python 邮件服务。不使用邮件时可单独安装扩展。
- 当前版本为 `0.2.1（邮件可选与暂停修复）`，实际使用仍有偶发适配问题。
- 已有离线测试和本地 Chromium fixture 联调；没有把未完成的 Ubuntu 或长期无人值守验收写成通过。

仓库尚未发布 Release 时，README 中的 Code → Download ZIP 路径仍能提供源码安装。不要在 README 中放一个并不存在的 Release 下载链接或假 CI 徽章。

## 5. 发布后维护

GitHub Actions 会在 push／PR 时运行离线检查；首次托管运行结果以仓库 Actions 页面为准，本地通过不代表托管运行已完成。CI 不需要 SMTP secrets、真实账号或浏览器 cookie。

后续行为修改同步版本标识、测试、截图和文档；安装用户还需要在扩展管理页重新加载。发布新版本前再次运行上述打包与校验命令。
