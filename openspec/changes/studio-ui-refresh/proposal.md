# Proposal

## Why

现有浏览器主导的布局挤压创作、任务和维护入口。按本轮任务书在当前 P4 与既有 Studio 边界内，改为清爽的 Mac 创作工作台，保留真实服务和账号会话。

## What Changes

- 六入口导航：项目总览、创作工作台、任务中心、素材与下载、账号与浏览器、设置与诊断。
- 浅色主题、通用创作表单、短剧四阶段、紧凑任务与账号、统一维护入口。
- 同一个常驻浏览器宿主切换全宽、辅助和屏外展示，不改变任务授权与提交语义。
- 不实现 P5、不改变旧 change 状态，不增加平台、执行器、协议、数据库或媒体合成。

## Capabilities

### New Capabilities

- `studio-workspace`: 创作导向的信息架构、入口保留、页面状态及浏览器常驻呈现。

### Modified Capabilities

无；旧 petstory-mvp 业务规格和未完成验收保留。

## Impact

主要修改 src/App.tsx、页面组件、主题与布局样式；复用 stores、TaskService、Repository、IPC、BrowserPanel 执行器及下载链。无数据迁移和新依赖。
