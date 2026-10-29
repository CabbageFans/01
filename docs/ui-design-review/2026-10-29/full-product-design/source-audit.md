# 短剧工作室：当前源码核查与设计承接边界

核查日期：2026-10-29。工作副本：`/Users/dingzhenyu/Documents/01`。

本报告只记录本次读取实际源码得出的事实、与用户要求的差距和后续设计约束。未修改生产源码、生产 CSS、业务数据，未启动应用，未执行豆包发送、图片或视频生成，也未完成真实界面全流程验收。历史报告不作为已实现能力的依据。

所有源码链接都相对于本报告目录；行号以本次核查时的文件为准。本文的“后续”均指设计获用户明确批准后才可能实施的工作，不表示已经开发完成。

## 1. 当前已具备的流程与调用关系

| 对象 | 当前事实与源码证据 | 设计承接要求 |
| --- | --- | --- |
| 六阶段 | 已有输入剧本、确认方案、基础素材、关键帧、镜头视频、查看成果六阶段。见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L147) 的标签与第 261 行的导航。阶段建议由项目事实只读推导，见 [petstoryJourney.ts](../../../../src/utils/petstoryJourney.ts#L73)。 | 接续既有工程，不新增另一套项目或阶段系统。导航和展开面板不触发创作。 |
| 剧本输入 | 默认直接输入剧本，抖音链接为可选辅助。见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L271)。 | 输入页以完整剧本为核心，链接提取放到次级入口。 |
| 先保存后分析 | `analyze()` 在第 223 行先保存原文并检查回读，失败即返回；成功后才分析。结果就绪后展示方案入口。见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L221)。 | 明确显示保存失败、分析中、结果就绪和待采用；不能只刷新后台。 |
| 方案采用与确认 | 方案结果有“采用此分镜方案”，见 [PetStoryRuntime.tsx](../../../../src/components/PetStoryRuntime.tsx#L74)。确认制作依据调用 `confirmStory()`，成功后只切换至素材阶段，见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L233)。 | 方案采用与用于制作的确认可清楚区分；不自动生图或生成视频。 |
| 提示词编辑 | 已有完整编辑弹窗、局部保存、复制、候选采用、重新生成、审查和原回复来源。见 [PetStoryCanvasPrompt.tsx](../../../../src/components/PetStoryCanvasPrompt.tsx#L80)。候选采用前保护手改正文。 | 保留能力，默认突出查看与编辑；重新生成、复制、审查及来源按层级收纳。 |
| 主进程边界 | UI 经 store 调用 `window.electronAPI.petstory`，IPC 分别使用项目、Chat、生产和历史媒体服务。见 [petstory.ts](../../../../main/ipc/petstory.ts#L19)。 | 不另建执行器或数据库；设计成果只作为未来界面契约。 |

## 2. 必须保留的画布资产与现有冲突

当前全景仍保留 ai_story 画布的主要对应关系：左侧故事与基础素材，右侧每个镜头一行，横向四节点为分镜及生图提示词、首帧／尾帧图片、视频提示词／运镜、镜头视频。见 [PetStoryCanvas.tsx](../../../../src/components/PetStoryCanvas.tsx#L48)、第 50–53 行和第 62–65 行。

现有全景 CSS 使用浅色网格、白色节点、绝对定位故事列及动态镜头行。见 [storyboard-canvas.css](../../../../src/styles/storyboard-canvas.css#L16) 的第 16–24 行。视角按项目独立保存，已有空白拖动平移、普通滚轮平移、Ctrl/Cmd + 滚轮缩放、适应与聚焦。见 [usePetStoryCanvasViewport.ts](../../../../src/components/usePetStoryCanvasViewport.ts#L43) 的第 43–76 行。全文编辑见 [PetStoryCanvasPrompt.tsx](../../../../src/components/PetStoryCanvasPrompt.tsx#L134)。

**需要明确纠正的现状：** 当前关键帧和视频阶段把同一画布渲染成裁列列表：隐藏故事列、列标题和一半节点，去掉网格，隐藏缩放，改为两列。见 [storyboard-canvas.css](../../../../src/styles/storyboard-canvas.css#L148) 的第 148–158 行；选择该视图的调用在 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L285)。这与用户本轮“保留主要画布布局”要求冲突。

后续设计应让阶段切换导航、聚焦或提示同一画布中的对象，保留故事列和各横向节点的对应关系；不得把上述裁列实现当作已批准的视觉资产。允许调整字体、间距、按钮、节点状态和颜色，不改变信息映射。

## 3. 图片确认：已有基础能力与尚未满足的强制要求

### 当前基础图确认能力

基础素材已有图片预览、上传、生成、历史图选择和逐张／检查后批量确认。见 [PetStoryMaterials.tsx](../../../../src/components/PetStoryMaterials.tsx#L100) 的第 100–125 行。确认服务校验具体图片、文件摘要，人物图还绑定当时身份外观，见 [petstoryProject.ts](../../../../main/utils/petstoryProject.ts#L406) 的第 406–418 行。

这能证明“存在基础图确认记录”，不能证明已经满足本轮完整的候选与正式采用分离。

### 当前差距

| 差距 | 源码事实 | 待批准后实施的目标行为 |
| --- | --- | --- |
| 基础图新候选立即替换当前选择 | 上传保存直接设置 `m.selectedAssetId` 并清除 `approved`，见 [petstoryProject.ts](../../../../main/utils/petstoryProject.ts#L389) 的第 401–403 行。生成下载也这样做，见 [petstoryProduction.ts](../../../../main/utils/petstoryProduction.ts#L647) 的第 650–654 行。历史图选择亦立即切换指针，见 [petstoryProject.ts](../../../../main/utils/petstoryProject.ts#L378)。 | 新候选独立进入预览；未采用前保留原已采用图与确认事实。用户确认替换后再切换正式图，旧图保留历史。 |
| 关键帧没有逐图采用门 | `collectMedia()` 将产物写入 assets、标记步骤 complete，再直接写 `firstFrameId` / `plannedEndImageId`。见 [petstoryProduction.ts](../../../../main/utils/petstoryProduction.ts#L647) 的第 649–660 行。UI 明示“生成并下载后自动回填”，见 [PetStoryCanvasMedia.tsx](../../../../src/components/PetStoryCanvasMedia.tsx#L178)。 | 人物、道具、场景、首帧和尾帧都先预览并“采用这张”，之后才正式回填且可供下游引用。 |
| 多图默认选择第一份有效文件 | 当前固定按 outputs 顺序，挑第一份下载且可解码产物，见 [petstoryProduction.ts](../../../../main/utils/petstoryProduction.ts#L622)。换图要求暂停且未被下游使用，见第 602–615 行。 | 下载候选不等于质量采用，多图交由用户明确选择，不能默认首张合格。 |
| 首帧／尾帧缺本地上传入口 | 画布媒体动作只有生成、文件夹定位、原产物重下及关联已有豆包产物。见 [PetStoryCanvasMedia.tsx](../../../../src/components/PetStoryCanvasMedia.tsx#L185)。 | 在对象位置提供上传；选择文件后展示用途和目标对象，预览确认后回填，不要求先经豆包重生成。 |
| 已有产物关联缺视觉预览 | 历史产物弹窗主要用时间与任务短标识选择，没有图片预览，见 [PetStoryExistingMediaPicker.tsx](../../../../src/components/PetStoryExistingMediaPicker.tsx#L27)。关联服务验证归属并保存资产，见 [petstoryExistingMedia.ts](../../../../main/utils/petstoryExistingMedia.ts#L109)。 | 图片关联同样进入待确认预览，用户看图后再采用。 |

设计需同时展示“当前采用”和“新候选待确认”，并表现替换基础图后下游待复核、旧成果保留。不要把待确认图放进正式节点以暗示已采用。

## 4. 豆包 Chat 的真实发送模式与自由交流缺口

**本次核实的当前模式是自动发送。** `startPrepared()` 准备完成后直接调用 `startBound()`，后者启动 `startAutomation`，见 [usePetStoryStore.ts](../../../../src/store/usePetStoryStore.ts#L208) 与第 237–250 行。浏览器执行链在第 1452–1453 行先创建新对话，见 [BrowserPanel.tsx](../../../../src/components/BrowserPanel.tsx#L1452)，再在第 1874–1884 行调用单次原生发送点击，见 [BrowserPanel.tsx](../../../../src/components/BrowserPanel.tsx#L1874)。当前剧本页文案也如实标注自动发送，见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L277)。

不能只改成“请在豆包点击发送”就宣称实现人工发送。设计若展示人工发送，需要明确它是待开发目标，并在未来接通“准备完整内容和附件 → 用户在豆包单次发送 → 自动观察和读取”的真实链路。不得要求额外点击“我已发送”或“开始监听”。

目前已有打开对应原会话、原任务回读和受控候选采用，见 [PetStoryTaskRecovery.tsx](../../../../src/components/PetStoryTaskRecovery.tsx#L74)、[PetStoryCanvasPrompt.tsx](../../../../src/components/PetStoryCanvasPrompt.tsx#L129)。但本次没有发现完整的对象级自由 Chat 流程入口或契约：从当前对象进入调整、保留当前目标、用户多轮自由交流、明确选择具体回复、预览将应用内容与目标、确认采用并仅更新该对象。

后续需为上述流程设计关联目标固定区、对话中状态、回复选择、应用预览、采用成功和归属不确定状态。不能默认最后一条助手消息。用户聊天期间应暂停后续自动注入，保护输入框草稿和当前关联会话；旧回复迟到不得覆盖新版本。网页选中回复若不可靠，应提供明确回复列表，边界如实写清。

## 5. 现有 drama-skills 接线

当前已从迁入资源 `main/resources/drama/runtime.json` 读取规则，按任务选择方法，将实际规则正文、项目事实、附件、目标模式和输出约定组装为 Chat 请求，见 [petstoryRuntimeRequest.ts](../../../../main/utils/petstoryRuntimeRequest.ts#L41) 的第 49–77 行，而不是只传 Skill 名称或本机路径。

Seedream 与 Seedance 引用规则有区别，首帧起态、尾帧编辑和视频动作也分别组织，见 [petstoryRuntimeRequest.ts](../../../../main/utils/petstoryRuntimeRequest.ts#L108) 与第 129–133 行。应继续承接这些资源，不重新移植规则框架。

普通界面不展示长规则、JSON、内部目标 ID。现有提示词来源展开区会暴露任务／运行／规则及实际请求，见 [PetStoryCanvasPrompt.tsx](../../../../src/components/PetStoryCanvasPrompt.tsx#L35) 的第 35–43 行；需要在设计中收进诊断详情。展示给用户的创作正文不能由程序补写冒充豆包结果。

## 6. 任务、成果与辅助页面

| 页面 | 当前事实与证据 | 设计方向 |
| --- | --- | --- |
| 当前任务与恢复 | 已区分尚未发送、已发送待核对、已收到待保存、候选待选、过期和缺项。见 [PetStoryTaskRecovery.tsx](../../../../src/components/PetStoryTaskRecovery.tsx#L42)。发送过的任务只读检查，未发送的才允许继续；原制作暂停后有原产物收取／下载恢复入口。见第 74–124 行。 | 正常等待保持克制；登录／验证、结果不确定、下载失败分别给一个推荐处理动作，不能统一“重新生成”。 |
| 任务中心 | 已有当前项目任务表、搜索、全部／待处理／待执行／已生成筛选。见 [TaskConsole.tsx](../../../../src/components/TaskConsole.tsx#L601) 与第 704 行。PetStory 任务执行账号不可随意改。 | 按剧本、镜头、用途表述任务归属；内部 ID 和状态码收进详情。 |
| 逐镜成果 | 已有首帧、必要尾帧与视频，区分当前提示词对应产物、文件校验、人工质量。见 [PetStoryResults.tsx](../../../../src/components/PetStoryResults.tsx#L55) 的第 55–83 行。 | 将九个并列统计标签收为清楚的逐镜事实；生成批次、产物、下载、文件有效、人工质量分开，不能出现不存在的完整成片。 |
| 素材与下载 | 分产物和下载记录；批量下载先选当前项目的具体批次。见 [Toolbar.tsx](../../../../src/components/Toolbar.tsx#L132)、第 303–307 行。失败重试只调用下载原 URL，见第 167–177 行。 | 保留这些边界，素材查看、下载和生成不要混成同一动作。 |
| 账号与浏览器 | 单一浏览器宿主靠 CSS 改辅助／全宽／屏外布局，不改 partition 和 key。见 [App.tsx](../../../../src/App.tsx#L181)。注入和提交时保护前台账号，见 [AccountList.tsx](../../../../src/components/AccountList.tsx#L60)。 | 仅改变呈现；账号会话、项目绑定和执行租约仍归现有实现。 |
| 设置与诊断 | 已有偏好、数据完整性、备份／恢复、更新、日志、诊断包、适配规则与统计。见 [Toolbar.tsx](../../../../src/components/Toolbar.tsx#L309)。偏好实际配置见 [SettingsModal.tsx](../../../../src/components/SettingsModal.tsx#L26)。 | 常用偏好简洁呈现，维护和诊断低频折叠；不得删掉业务能力。 |

## 7. 名称、主题和入口统一的当前差距

- 产品品牌仍为“豆包工作室 / Doubao Studio”，见 [App.tsx](../../../../src/App.tsx#L159)。部分页面仍称“萌宠短剧”“Studio 项目”“PetStory”。后续统一为用户指定的“短剧工作室 / 创作工作台 / 短剧创作”。
- 通用创作仍是默认 `creationMode`，并有显式模式切换，见 [App.tsx](../../../../src/App.tsx#L27) 和第 172 行。总览还有通用创作板块与快捷入口，见 [WorkspaceOverview.tsx](../../../../src/components/WorkspaceOverview.tsx#L24) 和第 29 行。设计须取消这些用户入口，而不是只把标签隐藏在某一页。
- 全局已经是浅色主题，但主色仍为紫色 `#6c5ce7`，见 [index.tsx](../../../../src/index.tsx#L15) 的第 19、20、40 行；画布局部才是青绿 `#0caa9a`，见 [PetStoryCanvas.tsx](../../../../src/components/PetStoryCanvas.tsx#L57)。全产品应统一深青绿、按钮高度、字体、间距、边框、圆角和语义状态。
- 当前阶段推荐区、画布工具栏、单节点和高级区都有相似重复入口，见 [PetStoryPanel.tsx](../../../../src/components/PetStoryPanel.tsx#L261)、[PetStoryCanvas.tsx](../../../../src/components/PetStoryCanvas.tsx#L55) 和 [PetStoryMaterials.tsx](../../../../src/components/PetStoryMaterials.tsx#L139)。设计应保留单一主操作，将低频重生成、历史、审查及技术记录收进更多或详情。

## 8. 本阶段验收边界

本阶段只交付独立目录中的高保真设计／交互原型、页面与状态覆盖、统一规范、按钮整理和关键流程。不修改正式产品 UI 源码、生产 CSS 或业务组件视觉，不因需求确认推定视觉批准。

设计验收至少覆盖：

1. 剧本保存、分析等待、方案结果、方案采用及确认。
2. 基础图无图、生成多候选、上传预览、采用、旧采用图与新候选并存。
3. 保留完整画布布局的关键帧预览采用、上传、缺素材定位和视频生成。
4. 豆包调整目标、自由对话中、具体回复选择、应用预览和确认采用。
5. 任务等待、登录／验证、发送结果不确定、原任务恢复、下载失败仅重下。
6. 逐镜成果的产物、下载、文件校验与人工质量分别呈现。
7. 素材下载、账号浏览器、设置诊断采用同一设计语言。

本报告不能作为已完成实机用户流程的证据。设计评审后必须停止，等待用户对最终视觉设计的明确批准。后续开发阶段仍需真实界面完整走查，并用实际平台、文件与人工确认结果验收；不能用后台函数调用代替。Dola 仍不得表述为生产可用；本次没有执行其全链验证。
