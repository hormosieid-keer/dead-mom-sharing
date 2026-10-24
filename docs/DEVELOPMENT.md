# 司凤转发 · 开发指南

普通用户从 [README](../README.md) 安装即可，无需构建。开发需要 Node.js 22+、npm、Python 3.10+；浏览器联调另外需要独立 Chromium。

## 目录和职责

```text
extension/
  manifest.json       MV3 清单、版本名和权限
  background.js       后台调度、队列生命周期、窗口、邮件、诊断
  core.js             配置校验、匹配、去重、限速、状态转换
  adapter.js          可序列化注入的账号／搜索／好友／分享适配器
  pointer.js          debugger 指针移动、按下、释放和会话
  network-tap.js      原生查询响应的被动监听
  options.*          设置界面
runner/
  config.py          本地 .env 读取
  mail_bridge.py     loopback HTTP → SMTP，持久告警去重
  server.py          可选服务器持久浏览器运行器
tests/               DOM、后台、界面、邮件与独立浏览器 fixture
scripts/             打包、公开源码导出、文档检查、截图生成
docs/                用户／开发／AI／发布文档与演示图片
deploy/              可选 Docker、远程桌面与上游许可证
.github/             离线 CI 和 Issue 模板
```

## 安装开发依赖

在项目根目录执行：

```sh
npm ci
npm test
python -m unittest discover -s tests -p "test_*.py" -v
npm run docs:check
```

这些测试不读取真实 `.env`，不访问真实抖音、SMTP 或日常浏览器。Python 邮件测试使用标准库，无需先安装服务器的 Playwright 依赖。最新结果和边界见 [TESTING.md](../TESTING.md)。

## 独立浏览器联调

先为开发环境安装与锁文件匹配的 Chromium：

```sh
npx playwright install chromium
```

Linux 缺系统依赖时按 Playwright 环境说明配置；这些操作仅影响开发测试，不是普通用户安装步骤。

| 命令 | 使用的适配与端口 |
| --- | --- |
| `node tests/send-receipt-smoke.mjs` | 真实适配器 + CDP，本地匿名页面；无 SMTP |
| `node tests/pointer-hover-smoke.mjs` | 真实指针，本地悬停 fixture；无 SMTP |
| `node tests/work-window-smoke.mjs` | 真实扩展与窗口 API，stub 页面适配器，随机模拟健康检查端口 |
| `node tests/diagnostic-ui-smoke.mjs` | 真实设置页与模拟后台，阻断外部请求 |
| `npm run test:extension` | 完整扩展模拟站点联调，**需要空闲 17321**，与真实邮件服务不能并行 |

首条刷新恢复专项（PowerShell）：

```powershell
$env:BOT_TEST_FIRST_REFRESH = '1'
node tests/work-window-smoke.mjs
Remove-Item Env:BOT_TEST_FIRST_REFRESH
```

若测试使用已有的独立 Chromium，可设置 `BOT_TEST_CHROMIUM` 为该浏览器可执行文件的绝对路径。它是**可执行文件路径，不是用户配置目录**。示例中的路径要换成自己的测试浏览器：

```powershell
$env:BOT_TEST_CHROMIUM = 'D:\tools\test-chromium\chrome.exe'
node tests/work-window-smoke.mjs
```

不要让测试连接日常 Edge 用户目录。17321 已有服务时，不为运行联调擅自停掉用户服务；选择不占用该端口的测试，或在用户明确安排的独立环境中运行完整联调。

## 重新生成文档图片

```sh
npm run docs:images
npm run docs:check
```

脚本从真实 options HTML／CSS／JS 渲染六张 PNG；使用固定演示账号、好友、视频和时间。所有外部请求被拦截，发消息及发邮件的 API 没有模拟实现，误调用会失败。图片说明见 [images/README.md](images/README.md)。`install-flow.svg` 是单独绘制的流程图。

生成后检查截图文字是否可读、未截掉关键按钮；新增或改名的图片要同时更新 README 引用。

## 后台协议与隔离

设置页通过 `chrome.runtime.sendMessage` 调用后台，返回 `{ok:true,data}` 或 `{ok:false,error}`。后台只接受本扩展页面的消息，不是公开的网页 HTTP API。

| 消息 | 行为 |
| --- | --- |
| `STATUS` | 只读：config、state、busy、workerBuild |
| `FRIENDS` / `DIAGNOSE` | 读取好友／分享面板，会操作页面和指针，不发送卡片 |
| `SCAN` | 一轮查询，不发送卡片 |
| `START` | 开启监控，可能立即向规则好友发送 |
| `SEND_PENDING` | 不查询，发送已有待发与有效缓存；一轮后停 |
| `PAUSE` | 取消后续任务；当前可能已发生的发送需按结果处理 |
| `MAIL_HEALTH` / `MAIL_TEST` | 前者不发邮件；后者实际发测试邮件 |
| `RESOLVE` | 人工处理 unknown，操作为 sent／retry／skip |
| `EXPORT` / `IMPORT` | 备份与恢复；不携带 cookie、SMTP 凭证或连接令牌 |

`browserTask` 本身必须可序列化执行，不能依赖未随函数注入的模块变量。账号／查询在 MAIN world，其它分享适配在 ISOLATED world；跨边界错误用明确代码和可序列化的脱敏详情。

邮件服务的 `/health` 是无需令牌的配置布尔检查；`/check` 需要 Bearer token，但也不连接 SMTP。`POST /alert` 才会投递，收件人只来自本地配置。完整协议见 [部署文档](../deploy/RUNNING.md)。

## 修改发送逻辑必须保留

- UID、视频 ID 使用字符串，避免数字精度丢失。
- 逐好友预留状态必须在真实发送前持久保存；重新加载页面时不能重复预留和丢失当前接收人。
- arm 本条回执监听 → 再次核对命中同一控件 → 实际按下 → confirm。旧提示、评论及其它任务的 token 不可作回执。
- 按下／松开回执丢失时不能重发该输入；点击后失败进入 unknown，必须由用户核对。
- 自动刷新只用于本轮首条、未调用发送、明确缺入口／面板的错误，最多一次；验证码、账号变化、歧义不得加入重试名单。
- 同一视频后续好友使用同一文档；保留视频限速、时间预算、去重和暂停取消。
- 不使用主动置前 API，不添加验证码绕过、隐藏真实失败或跳过邮件门槛的路径。

## 版本和打包

安装包版本来自 `package.json` 与 `manifest.json` 的 `version`。当前修复标识来自 manifest 的 `version_name`、后台 `BUILD` 和设置页 `UI_BUILD`，三处要一致；行为修改时同步相关断言和文档。

```sh
npm run package
npm run package:github
npm run release:verify
```

公开文件由 [release-files.mjs](../scripts/release-files.mjs) 明确列出。打包拒绝运行数据、凭证文件和符号链接，生成校验和。发布指南解释完整包、扩展包、公开源码包和干净上传目录的区别。

GitHub Actions 自动运行离线 JS／Python、文档和分发检查，不启动真实浏览器或 SMTP。工作流采用 [GitHub 官方 Node.js CI 指南](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs) 的 setup-node 方式；实际支持与权限见 [ci.yml](../.github/workflows/ci.yml)。本地通过不代表 GitHub 托管运行器已执行过。
