# 画布主工作区与提示词交互实施报告

日期：2026-10-31。工作区：`/Users/zarkding/Documents/doubao-studio`。变更：`petstory-canvas-first-workspace`。

## 实际修改

- `PetStoryPanel` 在关键帧、镜头视频、全景模式不再渲染项目大标题、`journey-recommendation`、整个 `PetStoryCurrentTasks`、通知大卡及重复全局待处理入口。其他阶段保留原滚动和业务。
- `PetStoryCanvas` 删除第二层状态栏、更多提示词操作、`SubmissionDetails` 调用、原始请求与诊断入口；合为52px工具栏，项目名只出现一次。
- `App → workspace-content → page-fill → Panel → stage-content → storyboard-workspace → canvas-viewport` 使用剩余空间布局和 `min-height:0/min-width:0`；清除画布 `100vh - 430px` 等旧高度。外层不滚动，文本和弹窗内部独立滚动。
- 视口按当前镜头实际DOM边界计算水平中心、适应和定位；初始优先首镜主要横向节点，可平移回左侧故事素材。适应保持至少72%的可读比例，长项目不按总高度缩小。尺寸变化保持世界中心，保存视角附带视口尺寸，跨尺寸重开也按半差恢复中心；旧坐标兼容并补记尺寸，进度/revision不重置视角。
- 默认提示词改为只读完整正文、全文预览、确认使用和自然语言修改。修改固定具体版本快照；旧采用正文、手改和图片视频在确认前保持。全文进入修改时关闭原预览，取消/提交回原节点。
- 媒体“处理当前任务”直接定位原依赖文字节点，不再寻找已删除的待处理面板。原素材预览、候选采用和下载链保留。
- 修复真实macOS项目选择器同时声明文件／目录并附JSON过滤后无法正常选取的入口；现在从目录打开，原程序路径参数仍兼容project.json。

## 生成、确认、修改与恢复链

统一入口：`generateCanvasPrompts → 原promptStageTargets/持久化promptBatch → prepareRuntime → TaskService/原BrowserPanel → collectChat → 校验/有限自动修订 → 保存候选 → 下一目标`。

候选保存成功即计数，不再设置必须逐条采用的 `waitingCandidate`。批次保存ID、合法候选ID和失败目标；同批前序候选经 `petstoryTextContext` 临时文字快照供后续创作，记录来源，不写正式final或媒体引用。明确失败保留原回复，独立目标继续，依赖目标等待。

单项确认继续使用 `adoptPromptCandidate`；“确认本次结果”仅遍历本批合法候选，按镜头/首帧/尾帧/视频顺序校验采用，保留失败和历史。替换前正文保存在 `replacedPrompt`，手改替换有明确提示。

修改链：节点选定版本 → 自然语言窗口 → `revisePrompt → 原prepareRuntime`（原意见、基准版本、镜头/剧本/素材职责和适用drama规则）→ 完整新正文候选。用户主动新轮与单个原请求一次自动结构修订分开。

恢复链：`resumeCanvasPrompt → markCanvasChat` 保存后台关联 → 按原任务真实状态补收取/恢复未发送请求/只读观察。原账号、task/run和已提交事实不替换；不明提交不自动重发。

真实验收另发现并修复：失败项通过意见取得合格候选后，旧暂停批次未消费该目标；现按目标幂等结算，已完成项再次修改不重复计数。资格查询如果返回较新的项目快照，前端也必须同步，避免磁盘17/18、界面16/18及采用时版本冲突；未通过放宽revision保护绕过。

本批确认还暴露旧创作hash的假过期：请求实际优先选择前镜尾帧，hash却同时锁定未选视频。现在共用真实边界选择；旧合同保留原hash，仅在选中边界完整一致且排除唯一未选字段后能精确重现原hash时兼容。真实故事、镜头、手改或选用边界变化仍拒绝。诊断对照为 `candidate-dependency-diagnosis.json`，没有改用户JSON或补造原回复。

## 后台执行

扩展既有图片操作后台识别，覆盖明确标记的画布job、自动修订祖先和精确关联的旧镜头批次；自由聊天仍保持前台规则。App的注入、提交、恢复和新增等待状态不会自动展开这些后台任务。

继续使用同一常驻Webview和partition，保留非零尺寸、视口交集、合成及输入通道，不使用 `display:none` 或第二执行器。用户主动会话入口才展开，节点全文链接按实际显示版本定位来源；自由聊天草稿和不同账号交互受保护。

## 真实UI与布局

所有业务动作经可见按钮和原生目录选择器；未用store/service/IPC直接调用代替用户路径，未改项目JSON注入结果。CDP仅用于用户要求的只读DOM测量和截图；任务状态优先从正式本机只读接口回读。

使用桌面现存“测试项目”：实际6镜头、7项基础素材、18项镜头文字容器。开始时revision229、9条jobs、18项资产，原文字批次暂停在2/18；未套用历史五镜头。

改造前对照使用当前Git基线渲染构建，在同一真实Electron和原项目中只读打开。为了避免热更新重建Store而打断任务，生成验收使用固定构建和本机preview。

| 内容区 | 工作区高度 | 网格高度 | 网格占比 | 外层滚动 |
| --- | ---: | ---: | ---: | --- |
| 改造前1440×900 | 840px | 470px | 56.0% | scrollHeight1161px；网格起点y=711.5，需滚动 |
| 改造后1440×900 | 840px | 727px | 86.5% | scrollHeight=clientHeight=840px |
| 改造后1280×800 | 740px | 627px | 84.7% | scrollHeight=clientHeight=740px |

实际截图与测量保存在本机忽略目录 `artifacts/canvas-first-workspace/`：

- [改造前1440](../artifacts/canvas-first-workspace/screenshots/01-before-1440.png)、[改造后默认画布](../artifacts/canvas-first-workspace/screenshots/02-after-1440.png)。
- [生成中](../artifacts/canvas-first-workspace/screenshots/03-generating-1440.png)、[原任务执行](../artifacts/canvas-first-workspace/screenshots/04-original-task-active.png)、[候选保存后继续](../artifacts/canvas-first-workspace/screenshots/05-candidate-and-continuing.png)。
- [完整候选预览](../artifacts/canvas-first-workspace/screenshots/06-candidate-preview-1440.png)、[单项失败](../artifacts/canvas-first-workspace/screenshots/08-single-failure-1440.png)。
- [1280视频页定位](../artifacts/canvas-first-workspace/screenshots/12-video-focused-1280.png)、[1280全文预览](../artifacts/canvas-first-workspace/screenshots/13-failed-preview-1280.png)、[1280意见窗口](../artifacts/canvas-first-workspace/screenshots/14-feedback-1280.png)、[1280已有图片预览](../artifacts/canvas-first-workspace/screenshots/17-existing-image-preview-1280.png)。
- 最终：[本批确认后1440](../artifacts/canvas-first-workspace/screenshots/24-final-adopted-1440.png)、[已采用正文全文](../artifacts/canvas-first-workspace/screenshots/25-final-text-preview-1440.png)、[1440意见窗口](../artifacts/canvas-first-workspace/screenshots/26-final-feedback-1440.png)、[剩余失败节点](../artifacts/canvas-first-workspace/screenshots/27-final-failure-1440.png)、[共用画布全景](../artifacts/canvas-first-workspace/screenshots/28-final-panorama-1440.png)。
- 最终小窗口：[跨尺寸重开](../artifacts/canvas-first-workspace/screenshots/29-reopen-1280.png)、[全文预览](../artifacts/canvas-first-workspace/screenshots/30-final-text-preview-1280.png)、[意见窗口](../artifacts/canvas-first-workspace/screenshots/31-final-feedback-1280.png)。1440已有图片预览见[截图23](../artifacts/canvas-first-workspace/screenshots/23-existing-image-preview-1440.png)。

## 真实文字验证记录

点击一次“继续生成提示词”后，原镜头2首帧job/task被复用，由明确未发送的失败状态恢复到原任务第2次运行，真实取得完整回复并保存候选。无需确认该候选，下一镜头文字自动开始；进度连续2→3→5→8→10→11→14→15→16/18。全过程豆包收起，Webview数量保持1。

镜头3视频的台词格式在一次自动修订后仍未通过，原回复保留；镜头4尾帧编号错误经一次自动修订通过；镜头4视频格式仍需处理。软件未逐条中断，继续处理后续独立镜头。生成过程中可定位镜头、放大全文和查看结果；原故事、全部采用正文和18项资产的只读摘要保持一致。

两种尺寸定位后的镜头行横向中心误差均为0px。1280下全文窗口800×504.9px、意见窗口700×351.4px、已有图片预览1000×614px，均在内容区内。主动打开正确来源会话后收起，画布视角、结果与唯一Webview保持；实际会话匹配记录为 `source-conversation-match.json`。

1440主动展开辅助浏览器时，网格宽1222→832px，收起恢复1222px；高度始终727px，缩放保持0.860704，镜头行横向中心误差保持0px。1280使用390px覆盖层，未挤压画布。后台生成期间宿主保留960px宽和视口交集，由工作区覆盖；生成结束后才移到屏外。

最终1440→1280重开保持原0.860704缩放且横向中心误差0px，点击“适应”变为0.752199，误差仍0px。最终全文预览分别800×504.9px（1440，镜头3视频）／800×479.7px（1280，镜头1首帧）；意见窗口均700×351.4px，只有一个弹层，不显示其他操作遗留错误。

首轮结束：14条本轮合法新候选、2项视频格式失败，加原2项为16/18；共19条新Chat任务（含有限修订和后续一次意见修改），0图片/视频任务。随后从镜头3失败正文提交一次自然语言反馈，真实取得完整新候选且校验通过，旧正文和18项媒体未变。主动第二轮意见修改仅做离线行为回归，未再消耗真实请求。

最终从节点单项确认镜头3新视频正文，再从工具栏确认本批；修复上述假过期后，其余3条原候选无需重发即成功确认。本批15条新候选全部采用，连原2条镜头正文共17/18；镜头4视频仍为待修订原回复，没有伪造第18条合格结果。项目revision360、28 jobs、18资产；批次保持17/18、剩余1、失败1，“确认本次结果”在本批候选全用完后消失。

只读核验 `adoption-input-verification.json` 通过：每条非手改final与对应原回复解析全文、来源ID和导出正文一致；镜头3只使用本次反馈候选。原2项镜头采用、4项素材采用、原故事、镜头／角色事实、制作绑定及18个资产文件SHA均保持。原项目没有非空手改镜头正文，手改替换保护由离线用例覆盖。

后续输入仅做现有纯compiler／export builder核对：17项计划编译全文一致，8项具备现存媒体依赖的正式编译通过，其余因缺实际首帧停止。**未创建或提交真实媒体任务，不能据此声称实际媒体控件与生成全链已验收。** 正式只读任务接口总数保持189＋4＋3；本轮19条新任务均为Chat。切页、重新打开和普通重启未新增任务。

## 工程验证

最终完整 `pnpm run validate` exit 0：141文件/2722测试，全部类型、工程/契约边界、主进程及渲染构建通过；ESLint为0 error/144 warning，上限149未改。OpenSpec全部12项strict通过，`git diff --check`通过。日志为本机 `validate-final.log`、`openspec.log`。构建仍有既有大chunk提示，未放宽检查。

初轮测试中20项本机HTTP测试因沙箱loopback监听EPERM未能运行，重新以所需权限运行后通过；过时逐条暂停、顶部推荐及专业文本编辑断言已按新产品行为更新，未删除无关测试或放宽门禁。

## 边界与启动

本轮不生成新图片或视频、不替用户采用正式图片素材、不执行付费或P5；Dola未完成真实端到端验收。未提交、推送、Tag、Release或归档其他变更。

未执行：第二次真实意见请求、实际登录／验证码、自由聊天草稿竞争及不明提交真实异常复现；这些分支仅离线回归。没有为补齐18/18再发第二次意见；镜头4当前节点保留“修改要求”。未以静态截图、只调用store/service或手改JSON代替上述真实生成和确认流程。

普通启动命令：

```bash
cd /Users/zarkding/Documents/doubao-studio
pnpm run dev:mac --dev-viewport-size=1440x900
```

最终已启动上述普通应用（Electron PID98644），从原生目录入口重开原项目，停留“制作关键帧”首镜可读视角，豆包收起。`ordinary-after.json` 证明项目及tasks文件跨普通重开SHA不变，revision360／28 jobs／18资产／196总任务不变；只有一个普通Electron，参数无local-control/local-cdp/remote-debugging/inspect。临时9333、4174、4175及动态控制端口57684全部关闭，控制info/token已移除；仅保留普通开发所需Vite5173。

## 后续修正：左下角镜头导航（2026-10-31）

用户截图指出导航随交互漂移。导航原本就在transform内容层之外，但viewport的`overflow:hidden`仍允许焦点／scrollIntoView滚动，绝对定位导航随滚动内容偏移。改为`overflow:clip`，画布仅通过transform平移；导航提高层级保持覆盖节点。跨页到画布镜头时只交给原viewport hook定位，不再额外scrollIntoView，素材页正常滚动保留。

当前普通实例已热更新；真实UI切换镜头2→6并缩放86%→72%，导航始终保持视口左下角及原尺寸，随后返回镜头2。4文件66项相关回归、定向Lint及renderer构建通过；日志`navigation-tests.log`、`navigation-lint.log`、`navigation-build.log`。本次未重跑全部2722项，未触发生成或采用。原生坐标拖动／滚轮工具返回noWindowsAvailable，故不把实际拖动记为验收通过；镜头定位及缩放可见流程已验证。未新增调试监听。

## 后续修正：移除画布前置提醒（2026-10-31）

按用户红框反馈，删除画布内全部生成前资格黄条及“去制作／去补齐／处理当前任务”等预提示跳转，删除无引用的`PetStoryGenerationBlockers`和对应跳转解析。资格查询失败不再提前占据提醒卡；正式执行错误、实际图片操作恢复、登录／结果未明和文件读取错误继续沿原节点显示。后台资格查询、按钮ready控制和主进程生成校验保持。

参考条取消缺图统计、缺图说明及补齐按钮，只显示真实已采用素材，空则不渲染；同时删除视频节点重复的自动下载与查看说明。此节替代上文旧的媒体前置“处理当前任务”跳转呈现，原提示词任务恢复和实际媒体操作恢复继续保留。

普通应用已热更新并可见定位镜头3，原红框两处黄条和相关按钮均不存在；未点击生成或采用。4文件84项相关测试、完整ts-check、改动源文件Lint及renderer构建通过，日志`hints-tests.log`、`hints-types.log`、`hints-lint.log`、`hints-build.log`；未重跑全量测试。当前仍为普通实例，未新增调试监听、提交或发布。

## 后续修正：首尾帧图片后台生成（2026-10-31）

用户指出画布“生成图片”仍展开豆包。原因是首次首尾帧生图沿旧`generateShotMedia → tickPetStoryProduction`推进，没有进入已有图片操作台账；图片修改虽已后台执行，首次生成没有同样的关联和节点进度。

`usePetStoryStore.generateShotMedia`的首帧／尾帧分支现在经过原`beginImageOperation → tickPetStoryImageOperation`。`PetStoryImageOperationService`允许精确shot/kind的首次生成，直接调用原`PetStoryProductionService.generateShotMedia`，不新建文字请求或改写已采用／手改正文。生产计划与imageOperationId同次保存，Task关联先保存再派发；App及BrowserPanel由现有精确图片操作识别，复用同一常驻Webview的上传、输入、单次提交、读取及下载。视频、自由聊天和无关图片任务不因mode获得后台权限。

节点复用已有准备／生成／保存动态进度，不捏造平台百分比。失败停止动态条，沿原操作继续；初次计划尚未创建的失败可在事实未变且没有孤立任务时恢复同一授权，已创建但关联写盘失败仍停止核对，禁止补建重发。完成只产生候选、打开本节点图片预览，用户明确采用前正式图和其他节点不变。

验证：10文件276项相关测试通过，包含主进程真实Projects／TaskService／Production的离线集成、Store接线、画布可见按钮和进度、App显隐及现有媒体制作。最终微调后服务30项再次通过。完整ts-check、主／渲染构建、专项OpenSpec strict及diff检查通过。改动文件ESLint为0 error、1条已有resubmit复杂度warning；未放宽规则。日志`shot-images-tests.log`、`shot-images-service-final.log`、`shot-images-types.log`、`shot-images-lint.log`、`shot-images-main-build.log`、`shot-images-renderer-build.log`及`shot-images-openspec.log`均在本机ignored证据目录。未重跑全量validate。

本次没有发送新图片／视频、采用素材或直接修改用户项目JSON。真实媒体全过程未执行，不能把上述离线UI／服务结果称为豆包生图实测。普通1440×900应用已重新构建并启动；原生目录选择器自动操作到正确项目目录后“打开”持续disabled，未绕过界面调用store／IPC伪造打开成功，已取消选择器，最终普通应用停留工作台可供用户操作。因此本次没有新增真实生成进度截图，原任务书已记录的真实文字及布局截图仍为先前验收证据。未开启额外控制／调试监听；启动命令仍为`pnpm run dev:mac --dev-viewport-size=1440x900`，未提交、推送或发布。
