# 文档图片来源

- `install-flow.svg`：本项目绘制的安装流程示意图，不是浏览器扩展管理页截图。
- 十张 PNG：运行 [generate-doc-images.mjs](../../scripts/generate-doc-images.mjs)，从真实 `extension/options.html`、CSS 和 JavaScript 渲染。
- 账号、UID、好友、视频、状态和时间均为虚构演示数据；图片不证明真实平台投递成功。未使用真实用户截图、头像或邮箱。
- 截图脚本拦截所有网络请求，只允许读取本地界面资源，不加载实际扩展、不访问抖音、不连接本地邮件服务。
- 图片随项目使用 MIT 许可证。改 UI 后请重新生成；命令见 [开发指南](../DEVELOPMENT.md)。

- `unavailable-video.png`：失效视频单独显示跳过任务数，不计入已发送；全部为演示数据。

- `region-help.png`：悬停运行控制区域的圆圈问号，展示按钮详细说明；使用演示数据。

- `optional-mail.png`：关闭邮件告警后，令牌及检查／测试按钮停用；使用演示数据。
