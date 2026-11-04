# 交互与真实服务源码映射（2026-11-02）

本文件的“现状”为当前工作树源码事实；“去向”为本轮设计建议，尚未实现、未批准。相对路径均为仓库内源码位置。此文件不包含账号、会话、项目绝对路径、任务私密内容或平台下载地址。

## 可保留的结构事实

- `src/App.tsx:177` 产品名“短剧工作室”，`:183` 主界面名“创作工作台”。六入口在 `src/utils/workspace.ts:5`–`:11`，业务是“短剧创作”。
- `src/components/PetStoryPanel.tsx:243` 渲染阶段导航；`:261` 素材、`:262` 三个画布阶段共用同一个 `PetStoryCanvas`、`:263` 成果。画布 stages 3/4/6 共享骨架，不能拆成一套新表单。
- `src/components/PetStoryCanvas.tsx:105` 左侧故事与基础素材；`:106`–`:110` 每镜四列；`:129` 列标题；`:131`、`:132` 数据驱动镜头行与全部导航。
- 画布缩放/平移用 transform（`PetStoryCanvas.tsx:127`–`:128`）；真实行边界适应 `usePetStoryCanvasViewport.ts:60`–`:74`；用户视角按项目保存（`:102`–`:104`），滚轮/拖动（`:114`–`:141`）。

## 操作去留表

仅使用用户要求的四类。删除一个旧入口不是删除安全能力；必要能力在“最终去向”中明确接到内容对象或真实异常。表中位置均是当前事实，不是新原型已经完成。

| 分类 | 用户目标 → 现有入口 | 最终去向（建议） | 真实调用/服务位置 | 出现条件 |
| --- | --- | --- | --- | --- |
| 1 保留为创作决策 | 由完整剧本生成方案 → 输入阶段“分析剧本” | 一个开始动作，先保存原剧本再分析 | `PetStoryPanel.tsx:200`–`:209` → store `analyze`；`usePetStoryStore.ts:1282` 原文保存 → preload `:32`；请求经 `prepareRuntime`、IPC `petstory.ts:78` → Chat service | 非空剧本、无真实忙碌/制作锁；不加免费或人工入口检查 |
| 1 保留为创作决策 | 决定制作方案 → “确认并采用方案” | 在完整方案旁保留一个明确确认 | `PetStoryPlanReview.tsx:67`–`:76` → `adoptPlanCandidate` 后 `confirmStory`；store `:1304`、`:1390`；IPC `:79`、`:108` | 合法候选/待确认方案；问题或等待时先恢复；确认不启动媒体 |
| 1 保留为创作决策 | 主动改变故事/镜头方案 → “在豆包中调整” | 方案全文内的内容反馈；短期保留真实“去对应会话调整”流程，后台反馈是实现差距 | `PetStoryPlanReview.tsx:78` → store `openChatAdjustment:1124`；`PetStoryChatAdjustmentPanel.tsx:158`–`:172` 选择具体回复→预览→采用；IPC `:51`、`:54` | 用户主动提出创作变化；保护草稿和原方案；不得自动选择具体自由 Chat 回复 |
| 1 保留为创作决策 | 获得人物/道具/场景图 → 素材“生成图片” | 保留，内部准备文字与生图，结果先候选 | `PetStoryMaterials.tsx:48`–`:52` → store `generateMaterialImage:1056` → `beginImageOperation`/tick；IPC `petstory.ts:47`–`:49` → `PetStoryImageOperationService.begin:87`、production `generateMaterials:556` | 方案已确认、目标有效；等待原任务/真实忙碌期间不新建重复任务 |
| 1 保留为创作决策 | 自有图片作为素材/关键帧 → “上传图片/上传替代图片” | 保留；读取文件后直接进预览，采用另行决定 | `PetStoryImageReview.tsx:157`–`:167`；store `addMaterialImage:1392` / `uploadShotImage:1173`；IPC `:56`–`:59`、`:114`–`:117` | 可编辑对象且无真实忙碌；取消不请求、不采用；不要求旧基础提示词 |
| 1 保留为创作决策 | 比较当前/候选/历史图片 → 点击图片/查看图片 | 同一预览，完整图片、用途、候选/历史选择 | `PetStoryImageReview.tsx:69`–`:81`、`:132`–`:148`；`readReference` 经 preload `:60` | 对象有可读图片/候选/历史；不能仅显示缩略图便等于已采用 |
| 1 保留为创作决策 | 正式使用所选图片 → “满意，采用图片” | 保留，明确到具体选图；更换后旧媒体保留 | `PetStoryImageReview.tsx:168`–`:173`；素材 `approveMaterials:1394`/关键帧 `adoptShotImage:1176`；IPC `:61`、`:111` → project `adoptImage:636` / `approveMaterials:642` | 选定图已读、未锁；当前已采用图无重复采用；历史关键帧不强制重复复核 |
| 1 保留为创作决策 | 修改具体图片 → “不满意，修改图片”→反馈窗 | 保留一个自然语言反馈输入，绑定预览选图 | `PetStoryImageReview.tsx:174`–`:188`、`:99`–`:104` → store `modifyImage:1060` → image operation；不是旧 `onAdjust` 自由文字入口 | 选图可读、意见非空；支持上传/未采用/历史候选/上一轮结果；取消零请求 |
| 1 保留为创作决策 | 用当前正式依据再生一组图 → 预览“重新生成” | 保留，文案区分“重生”与基图修改 | `PetStoryImageReview.tsx:91`、`:150`–`:155` → 同一 `onGenerate`；底层 image operation/production | 无进行中或待恢复原任务、正文与参考有效；不把预览选图误作修改基图 |
| 1 保留为创作决策 | 生成镜头文字 → 顶部生成/补齐提示词（N项） | 唯一清楚入口，范围按数据计算；无目标隐藏 | `PetStoryCanvas.tsx:89`–`:94`、`:115`–`:118` → store `generateCanvasPrompts:1234`，恢复保存的批次或 `stageTargets('shots')` | 缺正文/已有未完镜头批次，且无待节点处理候选或原任务；非真实忙碌/草稿 |
| 1 保留为创作决策 | 采用文字候选 → 节点“确认使用”/工具栏“确认本次结果” | 保留单项及本批明确采用，批量不掩盖合法性/手改替换 | `PetStoryCanvasPrompt.tsx:221`、`:235`；Canvas `:101`–`:104`、`:117`、`:124`；store `adoptPromptCandidate:1306` / `adoptPromptBatchCandidates:1241` | 合格且未被后续请求取代候选；手改替换明确确认；只采用文字，不发媒体 |
| 1 保留为创作决策 | 调整文字内容 → 常驻“修改要求” | 节点或全文提供“提出修改”，以自然语言创建新完整候选 | `PetStoryCanvasPrompt.tsx:217`–`:232`、`:254`–`:259` → store `revisePrompt:1266` → `prepareRuntime('optimize', promptFeedback)` | 有明确基准正文；版本仍匹配；非空反馈；真实等待/后台修订时禁重复 |
| 1 保留为创作决策 | 精确直接改正文 → 常驻“手动修改” | 从节点移入全文内按需“直接编辑正文”；保存是用户创作决定，不自动改为 AI 意见 | `PetStoryCanvasPrompt.tsx:146`–`:181`、`:213`–`:216`、`:236` → store `saveShotPrompt:1324` → IPC `:85` → project `saveShotPrompt:470` | 当前正式正文或可用候选；保存前验证 expectedFinal/baseJobId；失败保留草稿、取消不保存 |
| 1 保留为创作决策 | 决定时长/模式等具体制作 → “本镜制作设置” | 将与作品有实际关系的设置放具体视频内容内按需；不常驻技术模式解释 | `PetStoryCanvasMedia.tsx:317` → `CanvasVideoSettings`；draft 合并保存；执行 `generateShotMedia:1327` | 无未保存设置才生成；改设置不撤销已采用首尾图；必要实际平台控件由执行器读取回读 |
| 1 保留为创作决策 | 生成镜头视频 → 视频节点“生成视频” | 保留单入口，直接用当前正文与采用首尾图 | `PetStoryCanvasMedia.tsx:251`–`:259`、`:329` → store `generateShotMedia:1327`–`:1344`；IPC `:86` → production `generateShotMedia:349` | 无本项草稿、真实忙碌/原任务等待；只读预检失败不能静默置灰；真实执行错误节点显示 |
| 2 合并重复入口 | 阅读全文 → 节点全文、展开当前正文、成果提示词详情 | 相同对象/version 一个全文查看层，保留候选与当前对比，不复制正文进多块区域 | `PetStoryCanvasPrompt.tsx:240`–`:251`；`PetStoryResults.tsx:65`；媒体历史正文 `PetStoryCanvasMedia.tsx:98` | 有正文；不同版本需清楚标“当前/候选/历史”，不能把历史截断为假摘要 |
| 2 合并重复入口 | 定位镜头 → 工具栏百分比/适应/定位＋镜头头部/底部导航 | 合并工具栏三个完全相同动作：比例读数＋-/+，一个“定位当前镜头”；保留全部镜头导航 | `PetStoryCanvas.tsx:83`、`:107`、`:120`、`:132` 全用 `focus`；viewport `:128` → `frame(id)` | 有实际镜头；当前实现“适应”不是全画布 overview；若设计新“全景适应”需新增明确行为，不冒充已有 |
| 2 合并重复入口 | 播放视频 → 内置播放器 controls 与“查看视频” | 以视频画面/播放器为一个播放入口；成果可复用相同播放器 | `PetStoryCanvasMedia.tsx:80`、`:304`–`:310`、`:329`；Results `:63` | 视频本地可读；保留加载/解码/播放失败；真实时长与原请求差异仍提示 |
| 2 合并重复入口 | 知道当前进展 → 顶部全局错误/批次、节点状态/错误、阶段任务、成果多套状态 | 生成中只在所属节点/批次必要摘要；删除重复错误段、状态标签及常驻待处理面板 | Canvas `:118`；Prompt `:241`–`:244`；Media `:313`、`:325`、`:327`、`:331`–`:332`；Panel `:244`、`:248`；Results `:60`、`:94`–`:101` | 同一事实合并呈现；生成/本地保存/人工采用/人工质量不能合并成一个虚假“完成” |
| 3 自动完成 | 读取/保存豆包合法回复 → 历史重新保存回复等执行按钮 | 日常后台自动；仅本轮真实失败在对象旁显示“继续保存” | store `collectResult:876`–`:889`、`observePetStoryTasks:1627`–`:1652` → `collectChat`；IPC `:203` → Chat `collect:787` | 必须原请求/运行精确匹配、有已授权操作；旧历史未授权任务不能盲目扫全部自动处理 |
| 3 自动完成 | 格式/契约修订 → 校验记录/修复等内部步骤 | 连续后台修订并回完整候选；移除生成记录/诊断常驻 UI，不要转成新菜单 | store `repairResult:848`–`:874` → `prepareRuntime('repair')`，每父回复唯一后续；Prompt `:62`–`:92` | 可修复且授权仍有效；登录/平台拒绝/不明受理/归属异常/依据变更/用户停止应停；不让用户写格式错误 |
| 3 自动完成 | 材料匹配、编译、下载/解码 → 原制作/下载执行步骤 | 自动执行，成果显示可用媒体；不要每一步按钮化 | store media `:1327`–`:1344` → production；ImageOperation `:139`–`:140`、`:180`；IPC `:113` 真实绑定；读媒体 `:87`–`:94` | 必须已采用对应资产、真实文件/引用/顺序/正文可回读；下载失败只补原下载，不能新发生成 |
| 3 自动完成 | 普通内容保存 → 原剧本分析前显式保存/计划“校验并保存所有修改” | 后台持久化已确认结果；用户编辑需要保留实际保存语义，尚无全对象自动保存不能直接藏入口 | Panel `:184`–`:192`、`:202`、`:285`；store `saveOriginalStory:1282`、`saveShotPrompt:1324` | 当前原文分析前已自动保存；计划/手改仍显式保存并有冲突保护，自动草稿属实现差距 |
| 4 只在真实异常时出现 | 登录/验证 → 节点“去处理/去豆包处理验证” | 原对象局部提示＋进入原账号会话 | Prompt `:85`–`:87`；Media `:201`–`:215`、`:271`–`:301` → account `requestAvailabilityCheck`、`resumeProduction` | 真实 waiting_verification/authentication_unconfirmed；检测需要本次 fresh ready，不能自动求解或用旧 ready |
| 4 只在真实异常时出现 | 提交前视频准备失败 → “继续生成视频” | 原视频节点一个恢复动作，沿原 task/run | Media `:261`–`:269`、`:329`–`:330` → store `resumeUnsubmittedVideo:1346` → IPC resume `:137` → production `resume:389` | 原视频明确未发、无观察/回复/产物/活动锁、原输入未变；不另建任务、不重生图 |
| 4 只在真实异常时出现 | 已发视频结果未读/平台参数待确认 → 原会话确认/检查 | 保留真实平台人工步骤与只读检查，不隐藏为自动完成 | Media `:206`–`:212`、`:280`–`:301`；store `resumeProduction:1438`；原会话 `openPetStoryOriginalTask` | 原任务/运行/submittedAt/账号仍匹配；参数确认是平台实际要求时才出现 |
| 4 只在真实异常时出现 | 不明受理需要自主重发 → “确认重发一次” | 原节点风险确认；检查原结果入口同时保留 | `PetStoryTaskRecovery.tsx:166`–`:186` → store `resubmitProduction:1455`；IPC `:139` → production | `submission_uncertain` 且只读核对后仍未知；先原账号登录/验证；一次关联 hold 防重，不能自动循环 |
| 4 只在真实异常时出现 | 图片失败/下载失败 → “继续本次任务/重新下载图片” | 仅实际错误/可恢复操作显示 | ImageReview `:41`–`:47`、`:192`–`:200` → store `recoverImageOperation:1065` → IPC `:49` → image service `resume:197` | 原 operationId 存在且真实可恢复；outputs 已存在只补下载；不以“重试”隐式新增生成 |

## 删除入口前必须接通的差距

1. **方案的自然语言调整尚未统一成后台反馈。** 现有 `openChatAdjustment` 需要进入豆包自由交流，然后用户选择具体回复（`PetStoryChatAdjustmentPanel.tsx:158`–`:172`）。新原型可画方案全文反馈，但需标“待接通”；实现时复用 Chat runtime 的结构校验/候选机制，并保存 parentJobId 与当前方案基准，不能借用镜头 `revisePrompt` 无条件生成方案，也不能隐藏旧路造成死路。自由 Chat 的具体回复选择仍保留。
2. **方案页删诊断前先安置恢复。** PlanReview 的 `PlanRecovery:58`–`:62` 已有 compact 恢复；但历史原回复/待保存/结束等待能力还在 `PetStoryChatRecoveryActions` 与 `PetStoryCurrentTasks`（`PetStoryTaskRecovery.tsx:103`–`:147`、`:254` 起）。删常驻面板后按最新关联 job 的真实异常在方案卡内接回已有恢复 handler；不另造任务中心要求用户来回找。
3. **自动保存不是全局能力。** 原文分析前自动保存、任务结果后台保存已存在；计划编辑/手改正文/视频设置仍有草稿与显式保存。若原型用“已自动保存”，要新增去抖保存、revision 冲突、失败重试和导航保护，复用已有 `savePlan`/`saveShotPrompt`，完成前不可移除真正保存动作。采用本身始终是独立创作决定。
4. **成果人工质量仍跨页。** `PetStoryResults.tsx:115` 仅提供跳任务中心“查看原任务与质量确认”；如新原型希望成果就地确认，复用 `TaskDetailModal.tsx:156`–`:167` → `useTaskStore.setQualityVerdict:418` → `main/preload.ts:152`–`:153` 的既有服务，并保留 task/run/asset 归属。文件下载/解码通过不能自动判人工质量合格。
5. **设置诊断不是新 UI 保留依据。** `Toolbar.tsx:368` 目前有诊断详情/日志/适配/统计。用户本轮禁止恢复诊断常驻入口；内部日志/维护可继续，真实兼容性错误在发生的对象提示原因与恢复。不要用“专业工具”“高级功能”重新包一个更多菜单。账号新增/删除/改名属于用户主动管理，可留在账号具体详情；不把自动检测、冷却等内部状态全部按钮化。
6. **当前已有视频时缺少明显重生入口。** Media `:329` 只在 `!asset` 显示生成按钮，`buttonText` 虽计算“重新生成视频”，有 asset 时未渲染这个按钮。若新原型在视频全文内按需提供“重新生成视频”，底层 `generateShotMedia` 可复用，但必须明确新一次创作决定、保留旧视频、遵守原任务防重；不能把未暴露 UI 写成当前已交付。
7. **平台真实链仍有未验收分支。** 最新角色报告明确视频文字在上传识别阶段失败、没有新媒体生产；原型成功/进度/失败态需标设计模拟，不能写成实机验收。Dola 未验证。

## 已验证的重复与应保留的差别

- **百分比/适应/定位是真的重复。** 三个 `onClick` 均为 `focus(activeShot)`（Canvas `:120`）；hook 有独立 `fit()` 但当前工具栏未使用。“- / +”是真的缩放，底部镜头导航是真的切镜，均应保留。
- **手动修改/修改要求是认知重复、业务不同。** 前者直接改正式 final，后者自然语言新候选。默认保留内容反馈，在全文内按需保留直接编辑，不能简单合成同一个 callback。
- **状态文字重复但关键事实不能抹平。** 顶部批次/节点/卡片/成果都渲染任务事实；新设计只在所属内容呈现当前状态，历史和真实失败仍可查。候选≠已采用，平台生成≠本地保存，解码≠人工合格。
- **正常路径不需在工作室/豆包往返。** App `:93`–`:104` 对短剧后台任务不自动展开；正式图/镜头文字/媒体后台运行。仍需要往返的是主动自由交流、真实参数确认、登录/验证及缺失会话归属，这些不能被视觉隐藏。

## 技术边界

前端 → `window.electronAPI.petstory`（`main/preload.ts:13`–`:77`）→ 主进程 IPC（`main/ipc/petstory.ts`），通过 `projects.serial` 与既有 Chat/ImageOperation/Production/Project 服务。TaskService 与 Repository 管理任务；新视觉只能复用正式链。保留唯一常驻 BrowserPanel/账号 partition（`App.tsx:199`–`:203`），不因收起浏览器销毁 Webview。以上都是只读源码结论，本轮未调用任何写入服务。
