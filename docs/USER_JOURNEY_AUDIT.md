# PetStory 前端用户流程源码走查与修改清单

## 结论与范围

当前问题不是“所有功能都没有按钮”，而是**前端按模块堆放功能，没有把完成一件事情的顺序串成主流程**。旧四阶段、新画布、资产确认、当前入口检查、Chat恢复和高级编辑之间存在路径跳转与隐含前置条件。

本次读取的是仓库本次返回的最新main内容。检查时间点的最新提交为 `04c88030602ee69f3779392ae4920b6180b96f70`，只用于注明证据，开发不要求固定或回退至该提交。

本报告是**源码级用户路径走查**：核对真实组件、渲染条件、可见文案、点击处理、store及对应测试，不是声称已在用户Mac登录豆包并完成真实制作。当前无法连接用户桌面；没有把静态页面、旧截图或模拟数据冒充实机截图。后续修复须在实际Electron窗口从可见入口走查。

## 1. 关于“测试是否绕过前端”的事实

### 有明确证据的部分

`tests/unit/storyboardCanvas.test.ts`：
- 创建 `PetStoryProjects` / `PetStoryChatService` 并直接执行服务方法。
- 通过 `usePetStoryStore.setState` 放入项目和免费确认状态。
- 直接调用 `regenerateAllPrompts()` / `collect()`。
- 把夹具正文写为任务返回，检查保存和串行推进。

这类测试是有用的离线接线测试，但没有证明普通用户能找到可见按钮、理解禁用原因并顺着操作。

`tests/unit/petstoryBoundChatControls.test.tsx`：
- 使用 `renderToStaticMarkup`。
- mock `Collapse` 为全部展开的div。
- 用HTML包含按钮文本检验恢复入口。

这可以验证某些渲染条件，不代表真实折叠、CSS可见性、布局、滚动、状态更新和用户点击通过。

### 不能据此得出的结论

不能断言Codex所有验证都绕过UI、或者完全没有前端按钮。最新交付报告描述了原项目正常GUI重开、画布显示和原生目录选择器导出，但同时承认从零创建的完整链路没有完成。该报告中的私有证据没有在本次实机复验。

正确的修复方向是补充**真实用户路径验收**，不是删除原有单元测试或指责其无用。

## 2. 按新用户操作顺序走查

| 步骤 | 当前真实入口及行为 | 用户会遇到的断点 | 必须修改的前端内容 |
|---|---|---|---|
| 1. 新建短剧 | 总览“新建短剧目录”或短剧页“新建项目目录”；store读取全局selectedAccountId | 未选账号只能报错/提示先去账号页；同时面对Studio项目与本地目录 | 新建入口内显示账号、保存位置、关联项目；缺账号提供直接选择/登录并返回 |
| 2. 输入剧本 | 故事输入支持可选链接和原文保存，但MobileStoryInput先讲手机提取 | 有剧本的人仍需理解保存链接、复制手机提示词等不相关步骤 | 默认直接剧本模式；来源链接流程单独可选；保存并分析主操作 |
| 3. 启动分析 | 保存故事后勾选免费可用，再点“根据已保存故事生成制作方案” | 保存不是下一步；多项前置叠加在disabled里；未给就地解决方式 | 显示准备项及原因，保存成功后明确分析/等待反馈 |
| 4. 查看方案 | stage只在project ID变化时按有无plan设定；同一项目获得plan后不切换阶段 | 分析完成仍停留原页；用户要自己点击角色页或画布；打开旧项目则直接跳画布 | 完成后展示本次结果与“查看/确认方案”；恢复到真实未完成步骤 |
| 5. 采用并确认 | Runtime内“采用此分镜方案”；素材卡内“确认剧本与资产清单” | 采用、保存、确认分散；新旧方案历史占据故事卡 | 提供清楚的方案确认页/区域；来源、角色、分镜摘要和下一步集中 |
| 6. 写基础素材提示词 | 同页素材面板默认关闭；有单项/全部基础素材提示词按钮 | 顶部“生成全部提示词”实际只处理镜头正文；“继续/补齐”范围不透明 | 当前主动作直接说对象、数量、缺失项；全部重生成降为次级 |
| 7. 生成基础图片 | MaterialCard按钮依赖storyApproval、capability、capabilityCheckedInSession | 检查入口在另一个默认关闭的制作控制区；素材卡多处灰按钮 | 当前素材区域内给检查、确认、创作正文入口；图像能力不强绑全视频配置 |
| 8. 查看并接受图片 | 支持上传、选历史图、接受当前图片、批量接受 | 按钮已存在，但用户不知道全部确认后的下一步；已选/已接受概念混杂 | 计数清楚；真实确认后明确进入关键帧，不自动冒充用户接受 |
| 9. 制作关键帧 | 画布各镜头首帧/尾帧按钮，镜头高级编辑仍在旧角色分镜页 | 前置缺失常在服务报错后才知道；模式设置和动作编辑需要跨路径 | 同镜头预检、就地补前置入口；当前镜头可查看/编辑必要参数 |
| 10. 制作视频 | 节点生成视频、制作控制可启动批次 | 缺首/尾图、模式未适配时没有统一下一步；隐藏控制与节点含义不清 | 按真实条件显示“去生成首帧/尾帧”“适配视频提示词”“开始视频” |
| 11. 中断恢复 | collect/recover/endWaiting等藏于PromptProvenance的details内 | 用户得先展开技术来源、任务和运行ID，才发现继续动作 | 当前任务区直接显示等待谁、推荐操作；日志只作高级诊断 |
| 12. 查看成果 | Canvas内可预览；总览按production.state===complete提示完成 | 基础图批次或单节点完成可能被理解成整个短剧完成 | 从全项目实际所需素材/视频计数；缺项继续与文件位置可达；不伪称完整成片 |

## 3. 具体实现缺陷与依据

### 3.1 两条主导航没有统一

`PetStoryPanel.tsx`：
- `stage`初始0。
- effect仅当 `p.id !== stageProjectId.current` 时执行 `setStage(p.plan ? 4 : 0)`。
- 主导航同时存在“分镜生产画布”和四个旧阶段，按钮仅设置stage。
- 同一项目首次分析生成plan不会靠这段effect进入结果区；打开任何有plan项目会直接进入画布，不判断素材/提示词是否缺失。

建议：使用当前业务状态推导推荐阶段，而不是plan存在性。页面不必强制向导，但需要始终有下一步主操作。

### 3.2 空画布存在可能无效的保存入口

`PetStoryCanvas.tsx`：
- 所有项目均能进入画布。
- “当前故事”可编辑；按钮由 `storyEdited` 等控制。
- `saveStory()` 在没有 `latest.plan` 时直接return。

因此，无plan的用户在画布当前故事框输入内容，保存可能没有效果。应在空态限定为原剧本输入/分析，不能留下无反馈按钮。此为源码可达路径判断，需实际点击复现。

### 3.3 按钮名称与工作范围不一致

`PetStoryCanvas.tsx`同时显示“继续／补齐当前阶段提示词”“生成全部提示词”。

`usePetStoryStore.ts::regenerateAllPrompts()`只遍历 `p.plan.shots` 的 `firstFrame/lastFrame/video`；基础素材需要 `regenerateAllMaterialPrompts()`。

建议按当前阶段命名和计数，明确“基础素材提示词”和“镜头提示词”，不让用户猜两套批次。

### 3.4 基础图操作依赖被藏起来

`PetStoryCanvas.tsx`的 `materialOpen`、`controlOpen` 默认false，使用display:none隐藏两块面板。

`PetStoryMaterials.tsx`的 `materialMediaReady` 和单卡生图按钮依赖本次capability检查；检查按钮在 `PetStoryPanel.tsx::ProductionControls` 中。

`PetStoryCanvasMedia.tsx`虽然有“到顶部制作控制核对”的文字提示，但没有一个直接完成前置的入口。建议从阻断位置直接定位/执行，而非只让用户找按钮。

### 3.5 相同动作在不同页面有不同可达性

`PetStoryPanel.tsx::canAnalyzeStory()`会因同一故事已有任一analysis记录禁用原故事页的分析按钮；画布Runtime有另一套分析条件和“重新分析”按钮。

用户在一次失败后可能需要切到另一页面才能找到可执行入口。这是流程分裂，不应通过修改故事制造新ID绕开。

### 3.6 技术恢复与业务处理混在一起

`PetStoryCanvasPrompt.tsx::PromptProvenance`把任务/运行ID、规则文件、原请求、原回复与恢复按钮放入同一details。基本操作如“结束等待”不应以查看开发诊断为前提。

建议当前任务卡展示操作和中文含义，详情保留全部事实。

### 3.7 全局未保存锁没有指明来源

`PetStoryPanel.tsx`组合 `dirty/profileDirty/sourceDirty/canvasDirty`；Canvas又组合legacyDirty、materialDirty、dirtyFields和故事编辑状态。

保护草稿本身正确。但主按钮被隐藏页的草稿禁用时，需要显示具体对象、定位及保存/放弃动作，避免用户只看到“有未保存内容”。

### 3.8 仅看批次完成导致错误的项目级标签

`WorkspaceOverview.tsx`：
`pet.project.production?.state === 'complete' ? '镜头素材已完成' : ...`

没有核对phase或实际覆盖。已有生产流程包含基础素材phase与单节点任务，所以该标签的依据不足以证明全项目完成。应聚合当前方案和有效产物状态。

### 3.9 测试专用提醒进入真实产品

`PetStoryRuntime.tsx`可见提示含“原五镜头回归应保留候选并继续使用当前方案”。这是特定测试背景，不属于通用用户说明，应该移到测试文档。

### 3.10 画布全景不适合承载唯一主操作

CSS明确规定canvas-content宽1744px，故事列340px，关键操作和大量记录在可缩放区内。这里不作未经实机确认的视觉结论；但流程导航、当前任务、下一步主操作应置于画布缩放之外，避免关键操作依赖拖拽和缩放寻找。

## 4. 推荐目标：一条流程，现有画布继续使用

`输入剧本 → 确认方案 → 准备基础素材 → 制作关键帧 → 制作镜头视频 → 查看成果`

顶部固定呈现：当前阶段、真实完成数量、阻断对象、一个推荐主操作。

主体根据阶段聚焦工作：前期是剧本和素材，进入镜头后复用现有画布。全景仍可看，不另做第二套数据。

按钮禁用必须能够回答：缺什么、在哪里、点击哪里可处理。不是每项都加Tooltip，而是提供真实处理入口。

采用、批准、实际生成、下载和文件校验是不同状态；前端表达要清楚，但不用把内部英文状态全部暴露给普通用户。

## 5. 发送方式与本轮边界

本次不把流程修复重新扩大成自动点击/网络/VPN专项。先核对当前真实实现，显示当前是在自动执行、等待用户发送、等待回复，还是需要处理。

此前讨论的人工发送若已接入，就在当前步骤明确等待用户并自动收取；尚未实现不能靠文案假装。发送策略不是缺少清晰导航和按钮的理由。

不开发P5，不新增其他模型或API，不重做整个UI，不重新移植drama-skills。

## 6. 前端验收要求

单元/集成测试保留；另增加从真实可见入口点击的用户流程验收：
- 同一个原故事新建项目，从零输入、分析、确认、素材、关键帧、视频、成果。
- 原五镜头项目作为已有成果/候选/恢复/局部操作回归。
- 新项目动态镜头数不必为五，不另编故事，不硬编码样例。
- 不通过store action、IPC写入、service调用、改JSON/approved、mock展开折叠区等方式替代界面点击。
- 只读核对源数据和请求允许，但不用于推进状态。
- 每一步留当前窗口截图、实际点击控件、反馈、下一步、通过/阻断状态。
- 真实Chat可验证；需用户确认素材和授权生成媒体时，显示正确人工交接点。没有真实媒体结果就不得宣称全流程媒体通过。

完整实施指令见同目录交付文件 `PetStory_Frontend_User_Journey_Repair_Codex.md`。

## 7. 本次核对源码索引

- https://github.com/CabbageFans/01/blob/main/src/App.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/WorkspaceOverview.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryPanel.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryCanvas.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryRuntime.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryMaterials.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryCanvasPrompt.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/PetStoryCanvasMedia.tsx
- https://github.com/CabbageFans/01/blob/main/src/components/petStoryCanvasShared.ts
- https://github.com/CabbageFans/01/blob/main/src/store/usePetStoryStore.ts
- https://github.com/CabbageFans/01/blob/main/src/styles/storyboard-canvas.css
- https://github.com/CabbageFans/01/blob/main/tests/unit/storyboardCanvas.test.ts
- https://github.com/CabbageFans/01/blob/main/tests/unit/petstoryBoundChatControls.test.tsx
- https://github.com/CabbageFans/01/blob/main/docs/PROMPT_PIPELINE_COMPLETION_REPORT.md
