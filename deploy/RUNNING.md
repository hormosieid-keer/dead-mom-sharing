# 本地邮件桥接与 Ubuntu 服务器运行

## Windows 本地

本地浏览器扩展手动安装到 Chrome/Edge 的专用账号配置；这个运行器不控制你日常的浏览器。
邮件桥接仅依赖 Python 3.10 或以上，不需要安装 Playwright。先在项目目录执行：

```powershell
Copy-Item .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

把生成的随机串填进 `.env` 的 `BOT_BRIDGE_TOKEN`，并把同一个值填到插件邮件桥接设置。
填写 SMTP_HOST、SMTP_PORT、SMTP_SECURITY、SMTP_USER、SMTP_PASSWORD、SMTP_FROM、ALERT_EMAIL_TO。
常见组合是 SSL + 465 或 STARTTLS + 587；密码通常是邮箱的 SMTP 授权码。配置文件按字面读取，不执行 shell 表达式；值不要额外加引号。

```powershell
.\start-mail.ps1
```

保持窗口开启。仅监听 `http://127.0.0.1:17321`；`GET /health` 返回 `{ "configured": true/false }`，不发送邮件，不验证邮箱密码是否正确。
插件启动检查使用 `GET /check` 并附带相同 Bearer token：验证 token 和必填 SMTP 配置，错误 token 返回 401。
脚本不会替用户解除暂停或启动发送。

## Ubuntu 服务器

需要安装 Docker Engine 和 Compose v2.30 或以上（使用 raw 环境文件，保留密码中的 `$` 等字符），推荐至少 2 核、4GB 内存。上传整个项目，进入项目目录：

```bash
cp .env.example .env
chmod 600 .env
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

按本地步骤配置 `.env`，额外设置 `BOT_VNC_PASSWORD`（至少 8 个字符；经典 VNC 仅使用前 8 个）。
不要同时运行本地和服务器任务；切换前先暂停旧位置，导出任务配置和发送记录，再导入新位置。

```bash
cd deploy
docker compose --env-file ../.env up --build -d
docker compose --env-file ../.env logs -f
```

镜像和 Python 依赖均锁为 Playwright 1.64.1，镜像为 `mcr.microsoft.com/playwright/python:v1.64.1-noble`。
使用 Playwright 自带的持久 Chromium，并启用浏览器 sandbox；不依赖服务器预装 Chrome。
无图形桌面的 Ubuntu 使用 Xvfb + Openbox + x11vnc + noVNC 显示浏览器。
容器使用非 root 的 pwuser 和上游 `seccomp_profile.json`，没有 `privileged` 或 `SYS_ADMIN` 权限。
如果宿主机禁用了非特权用户命名空间，Chromium 会拒绝启动；由服务器管理员按宿主机策略解决，不会自动降级关闭 sandbox。

从你的电脑建立 SSH 隧道（把 user 和 server 换成服务器账号及地址）：

```bash
ssh -N -L 6080:127.0.0.1:6080 user@server
```

在你的电脑访问 <http://127.0.0.1:6080/vnc.html>，输入 VNC 密码。
设置页会自动打开：先配置插件规则与邮件桥接 token，再打开抖音登录专用 bot 账号，完成好友选择和人工试运行。
登录过期和验证码必须由你在这个远程窗口完成；不会自动解决验证码。

仅发布服务器回环地址 `127.0.0.1:6080`，不会发布 VNC 5900、邮件 17321 或调试端口。
邮件桥接与服务器 Chromium 在同一容器，插件依旧请求 `http://127.0.0.1:17321`。
浏览器登录状态、扩展配置、发送记录、邮件去重记录保存在 Docker 的 `bot-data` 持久卷。
`docker compose down` 保留该卷；不要添加 `-v`，除非你明确要删除全部状态。

启动容器不会代替你点击插件中的启用按钮；扩展首次安装默认停止。重启后的行为由扩展自己的暂停/恢复规则决定。
容器异常退出后不会自动重启，需要人工检查并执行 `docker compose --env-file ../.env up -d`。
正常停止：

```bash
docker compose --env-file ../.env down
```

## 桥接协议

```http
POST /alert HTTP/1.1
Host: 127.0.0.1:17321
Content-Type: application/json
Authorization: Bearer <BOT_BRIDGE_TOKEN>

{"incidentId":"stable-unique-id","reason":"登录失效","at":"2026-10-23T12:00:00Z","accountName":"bot"}
```

`incidentId`、`reason`、`at` 是非空字符串；`accountName` 可省略。
请求体最多 8192 字节。字段长度分别最多 160、2000、80、200 个字符。收件人只取服务器环境变量，不接受请求地址。
扩展来源允许 CORS，其他网页来源拒绝；即便没有 Origin，仍必须验证 Bearer token。
`GET /check` 同样要求 Bearer token，返回 `200 {"configured":true/false}` 或 `401 {"error":"unauthorized"}`，不连接 SMTP、不发送邮件。
`GET /health` 保留无需 token 的纯配置状态检查；两者都不会返回凭证，`OPTIONS` 支持 `/alert`、`/check`、`/health`。
响应 `200 {"ok":true,"duplicate":false}` 表示成功交给 SMTP；重复事件返回 `duplicate:true`。
失败返回 `503 {"error":"email_delivery_failed","retryable":true}`，扩展应使用同一 incidentId 重试。
SMTP 失败不记录成功；成功事件在 SQLite 去重库中持久保存。
SMTP 已接受邮件但进程恰好在写入成功记录前崩溃时，重试仍可能产生重复通知；SMTP 没有可用的跨系统原子事务。
已交给 SMTP 也不代表对方一定收进收件箱，请检查垃圾邮件和邮箱服务状态。

离线测试（不会发真实邮件）：

```bash
python3 -m unittest discover -s tests -p test_mail_bridge.py -v
```

## 参考与验证边界

- [Playwright 扩展文档](https://playwright.dev/python/docs/chrome-extensions)：持久 Chromium 扩展加载；Chrome/Edge 已移除相关命令行 sideload 标志。
- [Playwright Docker 文档](https://playwright.dev/python/docs/docker)：镜像与库版本必须匹配、非 root 和 seccomp 配置。
- [锁定版本的 seccomp 原文件](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json)：此文件按上游原样保存。
- Playwright 上游许可是 Apache-2.0；原始 LICENSE 与 NOTICE 保存在 `deploy/licenses/`，随分发保留。
- [PyPI 版本记录](https://pypi.org/project/playwright/1.64.1/)：本次核对版本为 1.64.1，对应 MCR 镜像 manifest 已验证存在。

已在 Windows 用模拟 SMTP 验证桥接协议、认证、来源限制、失败重试、持久去重和并发去重。
当前开发环境无 Docker/Ubuntu，尚未实跑容器、远程桌面或抖音账号会话；部署后的登录与真实平台兼容性需要在用户服务器验收。
