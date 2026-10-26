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
  browser-alerts.js   告警声音去重与工具栏标记
  alert-player.*     仅播放本地提示音的隐藏扩展页面
  audio/             原创提示音和来源说明
  icons/             普通与告警标签图标
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
| `node tests/search-challenge-smoke.mjs` | 真实适配器与 Chromium 可见性；虚构图片验证提示、等待期间中断、内嵌页检查；阻断外部网络 |
| `node tests/browser-alert-smoke.mjs` | 真实 MV3／隐藏音频页、关闭设置页播放、图标与徽标、恢复清除；音频输出静音，无外网及 SMTP |
| `node tests/pointer-hover-smoke.mjs` | 真实指针，本地悬停 fixture；无 SMTP |
| `node tests/work-window-smoke.mjs` | 真实扩展与窗口 API，stub 页面适配器，随机模拟健康检查端口 |
| `node tests/search-continuation-smoke.mjs` | 真实扩展、存储、导航和续段闹钟；模拟预算耗尽，随机健康检查端口，无真实发送 |
| `node tests/unavailable-video-smoke.mjs` | 真实失效检测适配器、实际扩展跳过失效队列后续发；页面及发送均为模拟，随机健康检查端口 |
| `node tests/diagnostic-ui-smoke.mjs` | 真实设置页与模拟后台，阻断外部请求 |
| `npm run test:extension` | 完整扩展模拟站点联调，**需要空闲 17321**，与真实邮件服务不能并行 |

发送准备刷新恢复专项（PowerShell）：

```powershell
$env:BOT_TEST_SEND_REFRESH = '1'
node tests/work-window-smoke.mjs
Remove-Item Env:BOT_TEST_SEND_REFRESH
```

该模式用三个独立加载的本地文档检查：前两次缺入口，实际刷新两次后第三次成功；后台单元测试另覆盖中途好友各自的两次机会、发送预留不重复，以及点击后不重试。

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

脚本从真实 options HTML／CSS／JS 渲染十一张 PNG；使用固定演示账号、好友、视频和时间。所有外部请求被拦截，发消息及发邮件的 API 没有模拟实现，误调用会失败。图片说明见 [images/README.md](images/README.md)。`install-flow.svg` 是单独绘制的流程图。

生成后检查截图文字是否可读、未截掉关键按钮；新增或改名的图片要同时更新 README 引用。

## 后台协议与隔离

设置页通过 `chrome.runtime.sendMessage` 调用后台，返回 `{ok:true,data}` 或 `{ok:false,error}`。后台只接受本扩展页面的消息，不是公开的网页 HTTP API。

| 消息 | 行为 |
| --- | --- |
| `STATUS` | 只读：config、state、busy、workerBuild |
| `BROWSER_ALERT_TEST` | 显式试听内置叮咚；不建立事故、不发卡片或邮件 |
| `FRIENDS` / `DIAGNOSE` | 读取好友／分享面板，会操作页面和指针，不发送卡片 |
| `SCAN` | 一轮查询，不发送卡片 |
| `START` | 开启监控，可能立即向规则好友发送 |
| `SEND_PENDING` | 不查询，已有队列和有效缓存全部发完后停；限速自动等待续发 |
| `AUTO_LOOP` | 循环抓取 → 发完队列 → 下一轮抓取，直到暂停或报错 |
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
- 每个当前待发记录在尚未调用发送时，明确缺入口／面板／好友行／发送控件、可恢复的点击前移位或刷新加载超时，最多刷新两次（共三次页面尝试）。验证码、账号变化、歧义不得加入重试名单；一旦可能已发送，保持 unknown，不得刷新重试。
- 同一视频后续好友正常使用同一文档，出错时仅重试当前接收人；保留视频限速、去重和暂停取消。时间预算限制开始下一条；已经开始的当前记录允许完成上述有限恢复，不因临近预算提前少试一次。
- 不使用主动置前 API，不添加验证码绕过、隐藏真实失败或跳过邮件门槛的路径。

## 浏览器声音与红点

浏览器声光告警由 `browser-alerts.js` 维护，与邮件配置独立。真实事故的 id 在原子 `change` 中声明一次 `state.browserAlert`，重复轮询、多设置页和后台重启不重复播放。结果标记 played／blocked；失败不取消原暂停、不影响邮件通知。恢复清除 incident 后清空工具栏徽标，设置页按状态恢复标题和 favicon。

设置页标题使用纯文本 `告警：incident.reason`，合并多余空白，空原因使用“需要人工处理”；每次有效状态刷新更新原因，不受已有闪烁计时器影响。解除真实告警后还原页面原标题，不把标题变化当作声音重播或发送确认。

隐藏音频页使用 [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 的 `AUDIO_PLAYBACK` 理由，播放打包在扩展内的 WAV，不打开或聚焦窗口；由浏览器管理无音频后的生命周期。消息限定自己的扩展 id、目标与动作。设置页仅绘制闪烁图标，不自行播放，从而避免多开页面重复声响。工具栏徽标使用 [action API](https://developer.chrome.com/docs/extensions/reference/api/action)。原始音频说明见 [CREDITS](../extension/audio/CREDITS.md)。

## 版本和打包

安装包版本来自 `package.json` 与 `manifest.json` 的 `version`。当前修复标识来自 manifest 的 `version_name`、后台 `BUILD` 和设置页 `UI_BUILD`，三处要一致；行为修改时同步相关断言和文档。

```sh
npm run package
npm run package:github
npm run release:verify
```

公开文件由 [release-files.mjs](../scripts/release-files.mjs) 明确列出。打包拒绝运行数据、凭证文件和符号链接，生成校验和。发布指南解释完整包、扩展包、公开源码包和干净上传目录的区别。

GitHub Actions 自动运行离线 JS／Python、文档和分发检查，不启动真实浏览器或 SMTP。工作流采用 [GitHub 官方 Node.js CI 指南](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs) 的 setup-node 方式；实际支持与权限见 [ci.yml](../.github/workflows/ci.yml)。本地通过不代表 GitHub 托管运行器已执行过。

## 本轮展示状态

`state.round` 保存唯一 id、开始／更新时间、结束状态、来源、查询进度、完整命中数量及前 100 个视频。搜索每个查询词完成后发布进度；`state.preview` 仍作为待发直发的检索缓存，不能把界面换轮等同于清空发送账本。

发送预留时把当前运行轮次写入 `delivery.attemptRoundId`。界面只统计状态为 sent 且轮次相同的记录；unknown 不计入，人工确认 sent 后可计入其原轮次。刷新页面不创建新轮次；后台重载把未结束的轮次标为 interrupted，保留已确认统计；导入时清除展示轮次，发送账本仍保留。

每次持久状态写入递增 `statusRevision`，IMPORT 保持本机序号不回退。UI 同时检查请求顺序与状态序号，拒绝迟到的旧 STATUS；监听 storage.onChanged 触发刷新，保留四秒轮询兜底。上述序号与好友诊断 seq 各自负责不同的数据。


## 查询与发送的分段调度

`state.searchCheckpoint` 保存版本、配置签名、查询词序列、下一个未完成词的 `nextIndex`、规范化视频、分页截断标志、逻辑 roundId 和 query／drain 阶段。每个查询词完成后原子保存结果、进度和去重后的队列；预算检查发生在词之间，不改变单个词的既有分页逻辑。

225 秒工作片段预留约 45 秒用于发送。到达查询预算时不抛故障：先发已有 pending；整个队列未清空前后续片段只发送（受既有限速约束）。队列清空后续段从 nextIndex 继续。发送恢复时间由滑动窗口的真实到期时间计算；时间／数量片段和剩余查询尽快唤醒；Chrome 可能延迟闹钟，周期检查是兜底，不承诺精确秒数。

`douyin-continue` 是浏览器持久的一次性闹钟，复用同一工作循环；busy、enabled／paused 和命令序号继续守门。自动分段共用一个 running round，直到全部查询和发送完成；用户暂停结束旧展示轮次；有合法等待计划且无 sending／unknown 时，后台重启安全恢复原轮次与本轮计数，否则仍按中断处理。lastScanAt 仅在所有词完成后更新。

`state.scanCheckpoint` 独立保存只读试检索的进度，预算不足返回 partial 和查询进度，下次 SCAN 继续；不会定时发消息。SEND_PENDING 始终不查询，等限速并续发直到全部队列清空后停。修改检索配置或绑定账号清除旧游标，导入／导出不携带调度进度，发送账本保持。

复现真实浏览器调度（只使用匿名适配器，无真实发信）：

```sh
node tests/search-continuation-smoke.mjs
```


## 发送时段的结束原因

后台在实际退出点记录 `queue-empty`、`rate-limit`、`time-budget`、`card-budget`、`manual-pause`，正常停止的结构化原因写入 round.stopReason／stopReasonText 和 friendReadReport.stopReason／runMode，并在诊断消息与运行记录中显示。真正失败仍保留原错误报告，不被正常结束提示覆盖。

SEND_PENDING 不再在限速或片段预算用完后结束任务：这些情况创建恢复计划，保持 enabled 和 round.running；待发清空、手动暂停或报错才结束。真实失败仍保留错误和 unknown，不被正常等待提示覆盖。

## 全自动循环与持久等待

`AUTO_LOOP` 设置 runMode=auto-loop，复用原有检索、匹配、预留与回执流程。批内先完成所有查询词／预算分段及队列，队列未清空时不查下一批。整批完成后创建下一轮计划：有本轮新发送就尽快继续，否则按 checkIntervalSeconds 等待，防止零结果／全已发送时空转。

`resumePlan={mode,roundId,reason,at}` 使用持久浏览器闹钟与周期闹钟兜底；reason 为 rate-limit／send-segment／query-segment／next-round。周期检查早于 at 时不开始新工作；过期闹钟必须仍对应当前运行模式的有效计划。PAUSE 清空计划并取消唤醒，导入／导出不携带计划。配置签名变化清除检索游标和计划。

core.nextDeliveryAt 以每个不同视频的最后一次活动为准，计算滑动60秒窗口释放足够名额的时刻；同视频其它好友可立即继续。调度加少量余量，不提高发送上限，不睡眠阻塞整个后台。后台回收时，只有明确在等待且不存在 sending／unknown 的轮次可以恢复为 running；真实发送中断继续变为 unknown，禁止自动重发。

全自动浏览器模拟联调（独立 Chromium、匿名适配器、随机健康端口）：

```powershell
$env:BOT_TEST_AUTO_LOOP = '1'
node tests/search-continuation-smoke.mjs
Remove-Item Env:BOT_TEST_AUTO_LOOP
```

## 失效视频边界

`videoStatus` 只读检测当前队列视频的明确可见错误提示。它及 openShare／share probe／arm 均核对视频身份；不读评论、文案或分享内容作为失效证据。后台仅在实际发送按下前接受 VIDEO_UNAVAILABLE 与同视频的结构化证据，撤销本次预留后用 skipUnavailableVideo 跳过 pending，保留 sent／unknown 与 rate。确认阶段错误始终 unknown。

`unavailableVideos` 按账号和视频 ID 持久防止失效内容重新入队；兼容旧备份，recoverState 丢弃无效标记。跳过任务有 skipReason、unavailableReason、skippedRoundId，诊断按本轮汇总；不能清空历史记录来实现统计。明确失效不消耗两次刷新恢复，也不创建邮件告警。

## 区域悬浮说明

options.html 用 data-help 标记区域，options.js 的 REGION_HELP 提供本地静态说明；attachHelp 同时用于静态区域和动态规则卡片。单例 role=tooltip 浮窗使用文本节点，按视口定位并限制高度，避免被嵌套卡片或屏幕边缘裁切；只读说明不调用后台。鼠标离开有120毫秒过桥时间以便进入浮窗滚动，离开浮窗、失焦、Esc或外部点击时关闭；页面滚动时跟随定位，问号离开视口后关闭。

文档渲染脚本同时验证12个问号（11个静态区域加演示规则）在桌面及390px视口内的悬停／移开、键盘关闭、长说明滚动和无后台动作。新增按钮或更改模式时，同步更新对应说明及文档截图。

## 后台最大化与静音

查询和发送统一经过 taskTab。createWorkWindow 以 focused:false 创建窗口，再仅更新 state:maximized，保留原焦点。Chrome 不允许在同次 update 中组合 focused:false 和最大化状态，见 [Chrome windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)。不请求 focused:true、active:true 或 bringToFront。

新窗口先打开 about:blank；muteWorkTab 设置 muted:true 并确认 mutedInfo.muted 后才导航抖音。旧工作标签迁移前先静音，复用同视频时重新确认静音；尺寸改变后等待布局稳定。同视频不因最大化或静音而刷新。失败沿用暂停告警流程，不退回小窗口继续发送，也不修改其他标签页。

work-window-smoke 使用 viewport:null 验证原生窗口，避免 Playwright 对新页模拟视口时主动还原窗口。匿名联调覆盖旧标签隔离、恢复缩小／取消静音状态、关闭后新建空白窗口和导航前已静音；设置页保持选中，无真实账号、发送或邮件。

## 手动暂停与可选邮件

lastPauseEpoch只由显式PAUSE更新。当前轮次被手动停止且attemptedClick仍为false时，晚到的查询、悬停或arm异常作为正常取消：撤销发送预留，保留pending，不创建事故或邮件；回执不明和已有真实事故不清除。脚本回退发送前也重新检查暂停。

mailAlertsEnabled为布尔配置：新安装false，旧配置缺字段时按是否已有连接令牌兼容迁移。false跳过所有启动健康检查、告警发送/重试和测试邮件，但不解除页面暂停或unknown。启用时仍校验令牌与服务；导入导出保留开关，导出继续剥离令牌。

独立联调可设置BOT_TEST_MANUAL_PAUSE=1与BOT_TEST_NO_MAIL=1运行work-window-smoke.mjs，分别覆盖arm回调期间真实PAUSE和无邮件请求的队列续发，均使用虚构页面和随机测试端口。
