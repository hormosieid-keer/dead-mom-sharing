# 开源来源与许可证

## 项目原创声音和图标

浏览器告警音 `extension/audio/alert-ding-dong.wav` 为数学振荡器合成的原创声音，未使用第三方录音、其他软件的通知音或他人旋律；详见 [音频说明](extension/audio/CREDITS.md)。标签图标由项目代码绘制。二者随项目按 MIT 许可证分发，先前试听但未选用的外部素材不进入发行包。

## dy-cli

- 项目：https://github.com/Youhai020616/douyin
- 调研提交：5267065ed29f3959d4011d32293d8e520f7d6388
- 用途：核对视频搜索路径、`sort_type=2`（最新）、`publish_time=1`（一天）、分页和结构化数据格式。本扩展没有打包其签名算法或 Python 客户端。
- 许可证：MIT，原始文本保留在 extension/licenses/dy-cli-MIT.txt。

## Playwright

- 项目：https://github.com/microsoft/playwright
- 版本：运行器和镜像锁定 1.64.1；开发依赖以 package-lock.json 为准。
- 用途：持久 Chromium 运行扩展、自动化测试。服务器使用官方 `mcr.microsoft.com/playwright/python:v1.64.1-noble` 镜像。
- 许可证：Apache-2.0。部署中的 seccomp_profile.json 原样来自上游 v1.64.1；许可证和 NOTICE 保留在 deploy/licenses/。

## jsdom

- 项目：https://github.com/jsdom/jsdom
- 用途：仅开发测试 DOM fixture，不打包到扩展。
- 许可证：MIT。安装依赖中的许可证随 npm 包保留；准确版本和完整依赖清单见 package-lock.json。

## Ubuntu 图形环境组件

Dockerfile 通过 Ubuntu 软件仓库安装 Xvfb、Openbox、x11vnc、noVNC、websockify、tini 等组件。它们的许可证由对应发行包在镜像中保留；请按各软件包的许可分发派生镜像。

## 仅调查，未复制源码

- NanmiCoder/MediaCrawler：https://github.com/NanmiCoder/MediaCrawler
- wydddddcool/douyin-spark：https://github.com/wydddddcool/douyin-spark ，提交 09aa3de96d86bf44f297ab99a3a1c0b3f76867b3。所检查 checkout 无根目录 LICENSE，未直接复制其源码。

它们说明了搜索、评论、好友和会话的现有实现边界，不能据此宣称本项目的真实账号端到端功能已通过验证。
