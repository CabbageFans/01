# Design

## Context

见 proposal.md 与 docs/UI_REFACTOR_TASK.md。HEAD 6ee0c42；初始工作树仅有未跟踪任务书。BrowserPanel 的 effects 持有执行器、原会话恢复、事件监听、预热和租约；PetStoryPanel 保有未保存计划与故事表单。旧配置中“一个业务页”及六小时时限被本轮明确的独立 UI 改版取代，业务 P4 边界不变。

## Goals / Non-Goals

让当前功能完整可达、表单可继续、状态准确。无新执行链、数据迁移、统一短剧索引、P5 或平台生成测试。

## Decisions

- 190px 可折叠导航＋56px 上下文栏；浅灰画布、白色面板、14px 正文和少量紫色，使用现有 Ant Design 与 Tailwind。
- App 固定挂载唯一 BrowserPanel；全宽账号工作区和辅助面板只改变同一 wrapper CSS。收起保持可合成、非零宽高并 translate 到屏外；不 display:none、不改 key。延续 BrowserPanel 账号池与 partition。
- 创建表单与短剧表单常驻，页面切换只隐藏普通业务区，保留脏表单及选中镜头。执行或人工处理事件可展开正确宿主；不引发首页导航或发送。
- 通用创作复用 TaskConsole 的添加／附件／CSV／模板处理；任务视图改宽表格、详情沿用原组件。
- 短剧用四阶段导航；动态镜头为主从列表，提示词两层 Tabs；制作后沿用 production 锁，仅查看方案及已有素材。
- 项目总览只列真实 Studio 项目与当前打开短剧；切 Studio 不修改短剧绑定。所选目录末级名称仅随原 create/open 响应提供展示元数据，不写清单、不输出绝对路径或新增项目索引。
- 产物、下载复用原组件的嵌入显示；低频工具复用 Toolbar 原处理与维护弹窗。

### 入口映射

| 旧入口 | 新入口 | 复用组件／处理 |
| --- | --- | --- |
| ProjectSwitcher 创建／管理 | 总览与上下文项目选择 | ProjectSwitcher、ProjectManagementModal、useProjectStore |
| 项目概览／JSON 导出 | 总览工具 | ProjectOverviewModal |
| 添加任务对话框 | 创作工作台／通用创作 | TaskConsole.handleAddTasks／附件／视频参数 |
| 自动指派、CSV、变量、模板 | 通用创作／批量与模板 | TaskConsole 原导入、持久化与授权逻辑 |
| 窄任务卡片／批次／全局暂停 | 任务中心 | TaskConsole、TaskDetailModal、BatchManagerModal、batchPause／resumeAll |
| 故事、主演图、Chat 原文 | 短剧／故事输入 | PetStoryPanel、MobileStoryInput、原 store |
| 角色／分镜／提示词 | 短剧／角色与分镜 | edit／savePlan／optimize／draftFinal |
| P4 检查／备选／数量／确认 | 短剧／制作准备 | ProductionControls 原处理 |
| P4 暂停／继续／绑定素材 | 短剧／制作进度与素材 | 同一 ProductionControls、原会话观察 |
| 产物中心、批量下载、下载记录 | 素材与下载／两个子视图 | ArtifactCenterModal、BatchManagerModal、OutputPreviewModal、DownloadQueueModal |
| 账号卡片和菜单 | 账号与浏览器／紧凑列表 | AccountList 原 CRUD、检测、置顶、调度、冷却 |
| 浏览器导航／提取／分享／实验 | 同一浏览器／高级工具 | BrowserPanel 原处理；实验默认不变 |
| 设置、日志、统计、检查、备份、适配、更新 | 设置与诊断／分组入口 | Toolbar 原处理与 SettingsModal、LogCenterModal |
| 应用内窗口控制 | 非 Mac 保留，Mac 原生控制 | 原 system IPC；关闭／Dock 策略不变 |

## Risks / Trade-offs

- [屏外宿主恢复重绘] → 同一 DOM、非零尺寸、保留绘制，真实 Electron 身份与挂载次数回归。
- [旧 inline 深色值及低字号] → 统一 token 并逐页修正；1440、1280、1024 尺寸验证。
- [误认完成／额度] → 分开技术状态和人工质量、远程地址和本地校验；production 完成只表示镜头素材；音乐、Dola、原生槽位标记未验收。

## Migration Plan

无迁移；现有 mac-dev profile 继续使用。截图仅本地忽略目录；无提交、推送或归档。
