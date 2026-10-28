# 前端用户流程修复报告

日期：2026-10-28；指定视口续验：2026-10-29（Asia/Shanghai）
工作区：`/Users/zarkding/Documents/doubao-studio`
任务书：`docs/USER_JOURNEY_REPAIR_TASK.md`
本轮 OpenSpec：`petstory-user-journey-repair`

## 1. 交付结论与验收边界

已把正常入口组织为“输入剧本 → 确认方案 → 准备基础素材 → 制作关键帧 → 制作镜头视频 → 查看成果”，保留原 ai_story 式画布全景。原有演员预设、资产编辑、提示词候选、审查与修订、旧任务恢复、批量制作、原任务多图选择和导出功能仍有入口。最终 `pnpm run validate` 通过：106 个文件／2060 项测试，类型、Lint、工程规则、契约边界及双端构建通过。

本轮在真实 Electron 窗口中，使用用户原故事正常创建隔离新项目，完成了真实普通 Chat 分析、查看四镜头方案、确认制作依据，以及一项基础素材提示词的真实生成和采用。随后从实际关键帧、视频卡点击了缺失素材／首帧的处理入口。新项目尚无图片，未进行图片美术接受、媒体生成或视频下载；这些步骤仍为**待人工媒体验收**，不能据此宣称完整制作流程已经端到端通过。

原五镜头项目已从用户恢复的真实目录打开。核对了五个镜头、十三项镜头提示词、首帧手改与新候选、完整正文编辑、已有图片成果和原任务只读恢复入口。未采用原项目的新候选，未改写其手改正文，未重新生成其已有图片。原项目没有本地视频，未把八张关键帧或最后一个完成批次当成全项目视频完成。

最终工程门禁结果见第 7 节。离线测试和真实界面观察在后文分列；离线服务替身不计作真实豆包验收。10 月 29 日已补验精确的 1440×900／1280×800 内容区，并修复小窗口全文弹窗页脚不可见的问题，详见 6.4。原任务恢复仍仅验证到未唯一匹配时安全停止及后续交接，旧回复未找回；真实媒体边界不变，不能称完整制作流程端到端通过。

未自动 Git 提交、推送、发布或归档其他变更，未进入 P5。未新增模型 API、提示词框架、生产调度或项目数据库。

## 2. 实施依据与实际调用映射

本轮先读取了 `AGENTS.md`、完整任务书、`docs/PETSTORY_PROGRESS.md`、最近交付报告、相关在途 OpenSpec 和当前源码。在当前工作树接续实施，保留原有未提交审计与任务书。未回退历史版本、重新克隆或初始化工程。没有同目标变更时创建了 `petstory-user-journey-repair`，其他历史未完成项不因本轮完成而改为完成。

| 用户动作 | 正常可见入口 | 事件处理／实际调用 | 成功后的页面反馈与下一步 | 失败／阻断后的页面 |
| --- | --- | --- | --- | --- |
| 创建短剧 | 总览或萌宠短剧页“新建萌宠短剧” | `PetStoryCreateProject` → `createProject({ accountId, studioProjectId })` → 现有创建 IPC／原生目录选择 | 显示本地短剧、关联项目和绑定账号，进入直接剧本输入 | 弹窗内选择／添加账号、去登录、选择关联项目；创建错误就地显示，取消目录保留配置 |
| 粘贴并分析 | “完整剧本原文”“保存并分析剧本” | 先 `saveOriginalStory`，需要时保存项目预设；保存成功后调用现有 `analyze`／`prepareRuntime('analysis')` | 当前任务区显示执行与等待；本次结果就绪后显示方案和确认入口 | 保存失败零分析请求；原任务尚未发送、已发送待回复、需修订分别说明 |
| 采用并确认方案 | 方案候选“采用此分镜方案”；顶部“确认方案并进入素材准备” | `adoptPlanCandidate` → `confirmStory` | 采用与确认分开，确认成功进入基础素材；不生成媒体 | 未采用方案不能冒充当前制作依据；真实确认服务返回的错误保留在当前页 |
| 补齐文字 | 当前阶段推荐按钮，注明素材／关键帧／视频项数 | 后端 `promptStageTargets` 只读核对 → 与执行共用范围 → `continuePromptStage` | 显示当前批次、目标和原任务；正文保存、候选待采用分别显示 | 恢复保存的原批次时明确显示原范围；结束等待的目标不会被补齐动作自动重发 |
| 准备素材图 | 素材分组卡的检查、生成、上传、选图和确认 | 原 `inspectCapability`、`generateMaterials`、`addMaterialImage`、`selectMaterialImage`、`approveMaterials` | 图片回填对应卡片，选中后仍需本人查看确认；全部确认后可进入关键帧 | 当前位置显示后端资格缺项及处理按钮，图片检查不要求视频控件先就绪 |
| 制作关键帧／视频 | 对应镜头媒体卡 | 只读 `inspectGeneration`；点击生成后仍调用原 `generateShotMedia` 与制作链 | 实际产物回填本镜，可查看原会话、重新下载和文件定位 | 缺素材、首帧、尾帧或前镜视频时定位真实对应控件；不代为生成前置媒体 |
| 恢复原任务 | 固定“当前任务与需要处理的事项”及对象卡 | 原 `startBoundChat`、`collect`、`recoverChat`、`endChatWaiting`、`resumeProduction` | 沿原任务收取／下载，原始事实和记录保留 | 不确定发送只读核对，不重复发送；结束等待不表示取消平台任务或采用成功 |
| 查看逐镜文件 | “查看成果” | 当前方案和实际所选媒体的只读投影，`readMedia/readReference`、受边界保护的 `revealAsset/revealProject` | 逐镜图片／视频、正文匹配、校验记录、人工质量及缺失项分别显示 | 没有文件显示去制作入口；读取失败显示实际错误，不显示不存在的整片完成 |

当前普通 Chat 仍走现有**工具自动发送链**。页面已明确告知点击分析／生成才授权发起文字请求；输入、保存、展开卡片、切阶段和打开项目不会发起创作。没有仅更换文案，冒充已经交付“人工发送＋自动收取”。

## 3. UX01～UX11 核实与修复

| 项目 | 核实的问题与实际修复 | 主要实际文件 | 验证范围 |
| --- | --- | --- | --- |
| UX01 新建入口 | 原入口依赖全局已选账号。新增同处账号／关联项目选择、添加账号和登录入口；登录返回保留新建配置。绑定账号与浏览账号分别显示。过滤尚未交付生产能力的 Dola；打开账号复用交互租约检查，不暗中改绑。 | `PetStoryCreateProject.tsx`、`WorkspaceOverview.tsx`、`App.tsx`、`PetStoryPanel.tsx`、`usePetStoryStore.ts` | 真实新建与原生目录选择；无账号、Dola、归档项目和租约冲突有离线 DOM 覆盖 |
| UX02 直接剧本 | 默认显示完整原文和演员摘要；抖音辅助提取为独立可选方式。主动作先保存，再分析；保存失败不发请求。可选链接草稿不锁住直接模式。复杂预设收起，可添加必要配角。 | `PetStoryPanel.tsx` | 原故事真实输入／保存／分析；保存失败与链接草稿离线点击测试 |
| UX03 方案交接 | 跟踪本次分析及其修订后继，完成后主动呈现结果；失败不把旧方案误报成本次成功。展示理解、角色对应、资产数和动态镜头；候选采用与制作依据确认分别调用原服务。确认按钮每次真正调用 `confirmStory`，不因旧批准对象仍存在而跳过重新确认。 | `PetStoryPanel.tsx`、`PetStoryRuntime.tsx` | 真实分析返回四镜头、确认进入素材；未采用候选、异步修订及历史结果误报离线覆盖 |
| UX04 双主流程 | 六阶段为唯一正常主路径；原画布保留为“画布全景”。故事／资产／镜头旧编辑归入“高级编辑”。素材和提示词编辑器保持单一实例，阶段切换共享数据，不再挂两份隐藏表单。 | `PetStoryPanel.tsx`、`PetStoryCanvas.tsx`、`PetStoryPlanAssets.tsx`、`storyboard-canvas.css` | 真实阶段切换、原项目画布和全文编辑；DOM 验证导航不生成请求 |
| UX05 生成范围 | 推荐文字操作显示实际素材／关键帧／视频数量；恢复已保存批次时显示原范围，与执行共用目标选择。重新生成全部置于次级入口，说明包含对象、不含对象、保留手改和不生成媒体。 | `PetStoryPanel.tsx`、`PetStoryCanvas.tsx`、`PetStoryMaterials.tsx`、`usePetStoryStore.ts` | 真实单项素材文字生成；原批次范围与结束等待排除离线覆盖 |
| UX06 素材就地处理 | 人物／道具／场景分组显示已选、已确认、缺图。提示词、图片、历史选图、上传、明确逐张确认／勾选后确认均在当前阶段。图片入口检查直接可用，不先检查视频。图片显示或生成成功不自动批准。 | `PetStoryMaterials.tsx`、`PetStoryMediaEntryCheck.tsx`、`BrowserPanel.tsx`、`doubaoBridge.ts` | 真实观察一项素材提示词和零图片交接；检查／上传／批准及生成链以离线测试为依据，未冒充实机生图 |
| UX07 镜头前置 | 单节点只读资格调用主进程原校验，显示具体对象和直接处理入口。视频模式、时长、备选在本镜可编辑；连续首帧缺前镜实际视频时正确定位前镜视频。重新生成、下载和关联已有产物保持不同操作。 | `PetStoryCanvasMedia.tsx`、`PetStoryGenerationBlockers.tsx`、`usePetStoryGenerationEligibility.ts`、`main/utils/petstoryProduction.ts`、相关契约／IPC／preload | 真实点击缺素材、缺首帧处理入口；资格一致性、零写入和模式／设置合并离线覆盖；媒体发送未实测 |
| UX08 恢复可见 | 固定任务区处于画布缩放之外，对象卡也显示原任务恢复。未发送、已发送待回复、不确定发送、内容需处理和结束等待分别解释。未收到正文时禁用收取；缺原会话地址时明确打开执行账号、从历史找到原请求再只读核对，不猜测当前页。成功修订后不再把已解决父任务列为当前阻断。只读收取／下载不强迫核对无关的新生成入口，新增生成仍核对入口。 | `PetStoryTaskRecovery.tsx`、`PetStoryCanvasPrompt.tsx`、`petstoryRecovery.ts`、`usePetStoryStore.ts` | 原项目真实只读恢复按钮点击及缺地址交接、原数据未变；其他恢复分支离线 DOM／服务覆盖 |
| UX09 草稿可定位 | 顶部明确列出原剧本、链接、演员风格、具体素材／镜头提示词、模式时长或高级方案草稿，提供保存、查看、放弃。原子保存提示词；高级方案只合并真正修改的字段，拒绝并发冲突并保留双方内容。无关镜头草稿不再封锁所有单项操作，恢复和返回素材导航独立可用。 | `PetStoryDrafts.tsx`、`PetStoryPanel.tsx`、`PetStoryCanvasPrompt.tsx`、`PetStoryCanvasMedia.tsx`、`PetStoryMaterials.tsx`、`petstoryPlanDraft.ts` | 真实本地临时草稿、跨阶段保留／定位／放弃、原全文入口及手改保护；保存与并发合并由离线交互测试验证 |
| UX10 完成度 | 以当前方案目标及实际所选媒体统计；素材批准、已保存正文、新候选、待复核、正文匹配关键帧／视频、文件校验记录、人工质量分列。画布与成果页采用同一媒体选择投影。显式首尾帧请求计入尾帧目标。批次完成不代表全项目完成。 | `petstoryJourney.ts`、`WorkspaceOverview.tsx`、`PetStoryResults.tsx`、`PetStoryCanvasMedia.tsx`、`main/ipc/petstory.ts` | 原项目真实看到八张关键帧、无视频及缺失项；单素材／单节点 complete、历史选择和候选计数离线覆盖 |
| UX11 产品文案 | 清除“五镜头回归”等测试说明；正常页面使用当前正文、新候选、图片待确认、正在生成、需要处理。原始 JSON、规则、任务／运行标识仍在诊断详情。高级制作记录中的工程事实保留排障用途。 | `PetStoryRuntime.tsx`、`PetStoryCanvasPrompt.tsx`、`PetStoryCanvasMedia.tsx`、`PetStoryTaskRecovery.tsx`、`PetStoryPlanAssets.tsx` | 当前真实页面走查与源码核查；未把测试专用说明留作普通用户下一步 |

以上表内源码位于 `src/components/`，工具位于 `src/utils/`，状态位于 `src/store/`；表中已写明的 `main/` 路径除外。共享新增契约位于 `packages/contracts/src/dto/petstory.ts`、`packages/contracts/src/index.ts`，预加载位于 `main/preload.ts`。

## 4. 六阶段的推荐动作、条件与反馈

阶段只是当前真实状态的只读导航投影，没有新增持久化阶段字段，也不是需要点满的强制向导。用户可查看前后阶段，已有成果默认保留。阶段操作及当前任务区在画布缩放范围之外。

| 阶段 | 推荐主动作 | 真实前置条件及当前页处理 | 成功反馈与交接 |
| --- | --- | --- | --- |
| 输入剧本 | 保存并分析剧本；已有方案时明确为重新分析 | 完整原文、有效绑定账号／关联项目、本人确认普通 Chat 免费、原任务／制作锁；先保存再请求，错误就地显示 | 固定区显示当前分析任务与实际发送／等待事实；本次结果就绪进入方案确认，正在编辑其他内容时提供“查看方案结果” |
| 确认方案 | 确认方案并进入素材准备 | 没有当前方案时先查看并采用候选；有草稿先定位保存／放弃；由原 `confirmStory` 验证当前制作依据 | 显示确认成功，进入素材准备；没有生成图片／视频 |
| 准备基础素材 | 生成缺失提示词（基础素材 N 项）／继续原文字批次；正文齐备后查看并确认基础图片 | 原清单／正文资格来自后端；每张图片的入口、正文、方案确认缺项就在卡片处理。生成缺失基础图、上传、选图和确认均可达 | 正文回填本素材；图片仍待本人接受；分组计数更新，全部确认后有进入关键帧入口 |
| 制作关键帧 | 缺基础正文时“去素材阶段补齐提示词”；否则生成列明关键帧及视频范围的缺失提示词／继续原批次；齐备后查看本镜制作条件 | 返回素材仅导航，不要求授权发送或清空草稿。原文字批次沿原依赖串行，明确可能包含视频文字；媒体按钮仍独立。素材未确认、首帧／前镜视频缺失等显示后端原因并直达对象 | 真实生成后应回填本镜实际图片；本轮仅验证缺项导航与旧图片展示，未进行新关键帧生成 |
| 制作镜头视频 | 缺基础正文时返回素材；否则补齐列明范围的提示词／继续原批次；齐备后查看本镜制作条件 | 本镜正文、真实素材、首帧／必要尾帧、当前视频入口、模式时长和备选由原服务复核；按钮不能静默生成前置图片。真正文字发送前显示免费确认缺项 | 原任务执行／等待／产物、下载和校验分开显示；本轮停在缺首帧的可见交接点 |
| 查看成果 | 查看逐镜成果与缺失项 | 无需生成授权即可查看已保存文件；缺失项可返回相应阶段，质量确认定位原任务 | 每镜可查看图片／播放视频、定位文件、查看原任务；只交付逐镜素材，不显示不存在的整片合成或完整短剧导出 |

顶部“正文匹配”只表示已保存正文与产物记录相符，不等于已经核对当前网页模型／模式，也不代替人工画面质量。媒体能否再次发送始终由主进程正式资格校验决定。

## 5. 原功能入口的新去向

| 原功能 | 当前去向及保留方式 |
| --- | --- |
| 新建／打开本地短剧 | 总览和萌宠短剧顶部；新建弹窗直接选择账号及关联项目，打开沿用原生目录／路径入口 |
| 手机提取提示词、链接保存 | 输入剧本 →“从抖音链接辅助提取”；直接剧本模式不要求链接 |
| 演员、别名、身份、默认造型、共同／分类风格 | 输入剧本 →“默认角色与共同风格（可编辑）”；项目级预设仍走原保存服务 |
| 故事理解、空间连续性、重新分析、素材拆解、审查与定点修订 | 确认方案中的运行时结果与操作；具体正文卡保留本项审查／修订 |
| 分镜方案／素材清单候选采用 | 确认方案中的对应候选，原采用服务、来源与手改保护保留 |
| 基础素材提示词、局部编辑计划、图像变体 | 准备基础素材对应人物／道具／场景卡，文字候选与实际图片生成分开 |
| 上传参考、历史选图、同框身份图绑定、人物／道具／场景设计编辑 | 素材卡保留上传和历史选图；高级编辑保留角色参考／共用身份、道具和场景档案，以及镜头关联 |
| 首帧、尾帧、视频正文编辑／复制／放大／采用新候选 | 制作关键帧、制作镜头视频及画布全景共用同一组真实编辑器 |
| 镜头顺序、动作、起止状态、对白、造型、连续关系 | “高级编辑：故事、角色与镜头”，仍保存当前方案；并发新正文不会被旧表单快照覆盖 |
| 视频请求模式／时长／备选 | 制作镜头视频的当前镜头卡可改；高级镜头编辑和高级批量制作仍可访问原设置 |
| 原批量制作、数量预览、暂停／继续 | 高级编辑 →“高级批量制作、模式备选及原批次恢复”；固定任务区也提供必要恢复 |
| 原批次素材、多图选择、实际末帧及连续镜头记录 | 高级编辑 →“原批次素材、多图选择与连续镜头记录”；保留原 `ProductionImageChoice/selectProductionImage`，暂停原批次且有另一有效图片时可选择 |
| 文字任务原回复、未发送继续、只读恢复、结束等待 | 固定当前任务区和对象卡直接可见；完整请求、原始记录和标识移入诊断 |
| 关联已有豆包媒体、重新下载 | 对应镜头媒体卡；关联、重新下载和重新生成分别授权 |
| 提示词与引用记录导出、质量确认、文件定位 | 顶部／查看成果保留导出；成果页定位原任务质量确认和实际项目文件，不新增 P5 导出能力 |

## 6. 真实 Electron 操作记录与截图

所有下列截图来自本轮真实应用窗口，保存在 ignored 的 `artifacts/user-journey-repair/`，没有上传。真实验收使用可见控件、正常输入、原生文件选择和正常事件处理；没有从外部调 store、IPC 或 service 推进项目，没有编辑项目 JSON、批准状态、最终正文或任务状态，也没有注入人工模型回复。

### 6.1 样本与数据核对

- **隔离新项目**：`artifacts/user-journey-repair/from-story/`。先建空目录，再通过真实新建弹窗与原生目录选择器创建项目；输入使用用户原故事，角色资料及 A／B／C 对应来自原项目，未另编测试故事。只读核对为 revision 11、4 镜头、3 人物／3 道具／1 场景、7 项基础素材、2 个真实文字 job（analysis 与 materialPrompt 均 applied/adopted），0 个媒体资产。
- **原五镜头项目**：`/Users/zarkding/Desktop/测试/`。用户恢复该目录后，从正常打开入口选择。只读核对为 revision 604、5 镜头、7 项基础素材、123 个历史 job、11 个媒体资产：3 张基础图与 8 张关键帧，没有本地视频；镜头提示词为 5 首帧／3 尾帧／5 视频。
- 原项目 `project.json` 操作前后 SHA-256 一致：`1e58f9cf169e2e8e698c6277afab65e184d947545b35174c353f464332c478c2`。基线见 ignored `original-before.json`。原始故事、请求全文、内部页面地址和账号凭证不写入本报告。

### 6.2 正常控件点击记录

下表“通过”只对应本行观察到的动作，不代表之后未执行的媒体步骤通过。

| 步骤 | 页面可见状态 | 点击／输入的真实控件 | 页面反馈 | 下一步入口 | 当前窗口证据 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 初始走查 | 原入口要求用户自行先选账号，缺少就地创建配置 | 查看当前空项目入口 | 确认旧入口仍存在隐含前置 | 修复后新建弹窗 | [00-before.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/00-before.png) | 已复现 |
| 1 新建 | 新建弹窗直接显示执行账号、关联项目和保存说明 | “新建萌宠短剧”→选择账号／关联项目→“选择保存目录并创建”，使用原生目录选择器 | 隔离目录创建成功，进入零状态 | 完整剧本原文框 | [01-create-account.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/01-create-account.png)、[02-zero-script.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/02-zero-script.png) | 通过 |
| 2 输入原故事与演员 | 默认直接剧本，无需链接；演员高级配置可展开 | 原文框粘贴用户原故事；普通表单填写原演员资料、别名及配角；保存 | 原文／预设正常保存，下一步可分析 | 顶部分析主按钮 | [03-input-profile.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/03-input-profile.png)、[04-saved-input.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/04-saved-input.png)、[05-analysis-ready.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/05-analysis-ready.png) | 通过 |
| 3 启动真实分析 | 当前页分析主按钮可用，已说明自动发送机制 | 本人普通 Chat 免费确认；“保存并分析剧本”；等待中曾点击一次“读取原任务已保存回复” | 固定区显示执行／等待；过早收取实际报尚无最终正文，未重发。回复就绪后沿原任务收取；已据此修复为未落盘时禁用收取 | 等待本次结果或就地恢复原任务 | [06-analysis-started.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/06-analysis-started.png)、[07-chat-collection.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/07-chat-collection.png)、[08-chat-platform.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/08-chat-platform.png) | 真实文字请求通过；中途发现问题已修复并离线覆盖 |
| 4 方案交接 | 显示本次故事理解、角色与动态镜头 | 查看分析结果 | 本次真实回复保存为采用方案，共四镜头，未固定为五镜头 | “确认方案并进入素材准备” | [09-real-plan-four-shots.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/09-real-plan-four-shots.png) | 通过 |
| 5 确认制作依据 | 当前方案可查看，无媒体自动生成 | “确认方案并进入素材准备” | 基础素材清单显示，图片仍缺失／待本人接受 | 素材文字与图片就地操作 | [10-material-handoff.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/10-material-handoff.png) | 通过 |
| 6 一项真实素材文字 | 素材卡显示当前正文、候选与生成操作 | 对一项素材点击文字生成入口，等待原豆包回复 | 真实素材提示词回填并采用；新项目媒体资产仍为零 | 继续其余素材文字；之后检查入口／生成或上传图片 | [11-one-material-text.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/11-one-material-text.png)、[12-material-real-reply.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/12-material-real-reply.png) | 通过：仅一项文字 |
| 7 缺素材处理 | 关键帧卡显示后端返回的缺素材／未确认原因 | 对应“查看并补齐素材”处理按钮 | 返回素材阶段，定位对应真实素材卡 | 该卡上传／选图／确认或生成 | [13-keyframe-blockers.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/13-keyframe-blockers.png)、[14-blocker-locates-material.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/14-blocker-locates-material.png) | 通过：阻断及导航 |
| 8 缺首帧处理 | 视频卡明确显示本镜缺首帧 | “去制作本镜首帧” | 切至关键帧并定位对应真实控件 | 本镜首帧提示词／入口／生成操作 | [15-video-blockers.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/15-video-blockers.png)、[16-video-locates-first-frame.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/16-video-locates-first-frame.png) | 通过：阻断及导航；未生成 |
| 9 打开原项目 | 正常打开用户恢复的真实目录 | “输入项目路径”→输入目录→“打开项目” | 原五镜头项目载入，成果与历史记录保留 | 阶段导航、当前任务和画布 | [18-original-stable.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/18-original-stable.png) | 通过；17 为载入中截图，不计稳定原项目证据 |
| 10 原手改与候选 | 关键帧阶段显示原首帧手改正文及新候选 | 查看本镜提示词／新候选，不点击采用 | 87 字手改保持，候选独立可比较 | 采用候选或继续保留手改均有入口 | [19-original-keyframes-candidate.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/19-original-keyframes-candidate.png)、[20-original-final-candidate-visible.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/20-original-final-candidate-visible.png) | 通过：查看与保护；未采用 |
| 11 正文放大 | 原文可放大查看／编辑 | “放大镜头1首帧生图提示词” | 正常完整编辑弹窗显示，可返回；未保存改写原项目 | 返回画布／保存原子正文 | [21-original-full-editor.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/21-original-full-editor.png) | 通过：入口与显示 |
| 12 实际成果 | 成果页显示已有关键帧、缺视频及缺失处理 | “查看成果”，点击图片查看 | 实际本地图片打开；没有显示全项目视频完成 | 去制作缺失视频／文件定位／原任务 | [22-original-results.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/22-original-results.png)、[23-original-result-image.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/23-original-result-image.png) | 通过：真实旧图片展示 |
| 13 原任务只读恢复 | 原历史等待记录有可见只读处理入口 | “检查原回复（不重复发送）” | 原任务未保存会话地址，当前页不唯一匹配，核对安全停止；未绑定、未重发，原项目 hash 仍一致 | 打开执行账号，在历史对话找到原请求后再核对 | [24-original-readonly-recovery.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/24-original-readonly-recovery.png) | 仅入口及不重发通过；未找回新回复 |
| 14 具体草稿与跨阶段 | 新项目素材卡已有真实保存正文 | 在噜噜真实提示词框输入临时本地草稿→“4 制作关键帧”→“查看修改”→“放弃本次修改” | 顶部一直指出人物“噜噜”的提示词；查看返回并聚焦原编辑器，放弃恢复已保存正文；未点击保存或发送 | 恢复正常素材操作 | [25-material-draft.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/25-material-draft.png)、[26-cross-stage-draft.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/26-cross-stage-draft.png)、[27-draft-located.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/27-draft-located.png)、[28-draft-discarded.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/28-draft-discarded.png) | 通过；只验证草稿，不将人工文字写入项目或冒充模型回复 |
| 15 缺素材主导航 | 未勾选文字免费确认，关键帧缺基础正文 | “4 制作关键帧”→主按钮“去素材阶段补齐提示词” | 主导航可用；返回素材后执行型文字主按钮仍禁用，并显示需要确认的原因 | 素材当前卡片／文字免费确认 | [29-navigation-no-chat-authorization.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/29-navigation-no-chat-authorization.png)、[30-navigation-returned-materials.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/30-navigation-returned-materials.png) | 通过：导航零发送 |
| 16 画布与账号往返 | 原画布全景保留缩放控件 | “画布全景”→“缩小画布”→“打开本短剧豆包账号”→侧栏“账号与浏览器”→“创作工作台” | 画布为 67%，当前任务区未缩入画布；往返后保持 67%，右侧仍显示同一已有对话，未新建或发送 | 正常六阶段导航 | [31-panorama-zoom.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/31-panorama-zoom.png)、[32-bound-browser-before-nav.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/32-bound-browser-before-nav.png)、[33-account-browser.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/33-account-browser.png)、[34-return-canvas-browser-alive.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/34-return-canvas-browser-alive.png) | 通过：本次往返；不代表长时间保活压力验证 |
| 17 历史会话地址缺失交接 | 重新正常打开原项目，原恢复卡现在直接显示缺地址原因和操作 | “打开执行账号豆包” | 只打开原账号；说明从历史找原请求，再唯一匹配检查，未自动绑定当前页 | 右侧原账号历史对话和可见只读检查按钮 | [35-original-recovery-guidance.png](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/35-original-recovery-guidance.png) | 通过：可见交接；历史原回复未恢复 |

10 月 28 日截图为 2800×1800 像素（Retina 对应逻辑 1400×900 外框），00～36 的原生截图为 JPEG 字节、沿用 `.png` 名称保存，未后期编辑。当时 CUA 窗口拖动返回 `noWindowsAvailable`。用户反馈手动无法调准后，10 月 29 日通过显式开发启动尺寸解决，新增 37～55 使用 `.jpg` 保存；指定视口结论以 6.4 为准，没有用页面缩放、离线渲染或强制隐藏元素替代真实窗口检查。

### 6.3 本轮未执行的真实媒体步骤

| 分支 | 当前真实状态 | 实际可见的后续操作 | 本轮结论 |
| --- | --- | --- | --- |
| 新项目其余素材文字 | 7 项中只有一项本轮完成真实文字创作 | 当前阶段明确范围的补齐按钮或单项文字操作 | 尚未全部真实生成 |
| 素材图片 | 新项目 0 张图，没有批准素材 | 素材卡检查图片入口、生成此图／生成缺失图、上传已有图片、查看后确认 | 待用户授权／本人美术接受，未自动批准 |
| 新关键帧 | 尚缺确认素材和实际首帧等前置 | 缺项按钮已真实定位；补齐后在对应本镜卡生成 | 待人工媒体验收 |
| 新视频 | 没有新关键帧和视频 | 本镜模式／时长／入口检查及首尾帧处理入口 | 待人工媒体验收 |
| 新视频下载／文件校验／质量 | 没有本轮新视频 | 原任务执行后自动下载／校验；成果页查看实际视频并定位质量确认 | 未测试，不宣称全流程通过 |
| 原多图切换、尾帧与连续镜头实际生成 | 源码入口保留，原数据未为验证而改写 | 高级原批次记录、多图选择及对应镜头卡 | 离线覆盖；未消耗媒体额度实测 |

### 6.4 指定视口续验（2026-10-29）

用户反馈无法手动调准窗口后，新增仅在未打包应用显式使用的 `--dev-viewport-size=宽x高`。`main/utils/developmentWindow.ts` 严格解析参数，拒绝打包态、重复、非法格式及越界；`main/main.ts` 仅在参数存在时使用 `useContentSize`，没有参数仍保持原 1400×900 外框。参数只控制启动尺寸、不增加 IPC 或业务写入口。验收时不额外打开 DevTools，避免焦点和窗口混淆。

实际启动命令与主进程回读如下；标题栏计入外框，内容区尺寸与任务书一致。截图像素为 Retina 两倍，未缩放页面或画布来冒充指定内容区。

| 启动命令 | 实际内容区 | 实际外框 | 原生截图像素 |
| --- | --- | --- | --- |
| `pnpm run dev:mac --dev-viewport-size=1280x800` | 1280×800 | 1280×828 | 2560×1656 |
| `pnpm run dev:mac --dev-viewport-size=1440x900` | 1440×900 | 1440×928 | 2880×1856 |

启动日志为 ignored `dev-1280x800.log` 与 `dev-1440x900.log`，其中 `[DevelopmentViewport]` 记录 `getSize()` 和 `getContentSize()` 的实际值。两个实例均沿正常“输入项目路径”打开用户原五镜头目录，没有从外部推进状态。

| 视口与动作 | 看到什么、点击什么、页面反馈与下一步 | 当前窗口证据 | 结论 |
| --- | --- | --- | --- |
| 1280×800：正常打开原项目 | 总览“输入项目路径”→原目录→“打开项目”；显示确认方案、六阶段、推荐确认按钮和当前任务区 | [37 启动](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/37-1280x800-start.jpg)、[38 方案主动作](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/38-1280x800-original-plan.jpg) | 阶段／主动作可见，没有生成请求 |
| 1280×800：全文编辑 | “4 制作关键帧”→“放大镜头1首帧生图提示词”；首次发现长候选把页脚挤出视口。修复弹窗正文高度和内部滚动后，原手改、候选与返回／保存均可见；实际向下滚动查看候选，页脚持续可见，再“返回画布” | [39 关键帧](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/39-1280x800-keyframes.jpg)、[40 修前页脚问题](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/40-1280x800-full-prompt.jpg)、[41 修后](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/41-1280x800-full-prompt-fixed.jpg)、[42 内部滚动](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/42-1280x800-modal-scroll.jpg) | 修复后通过；没有修改正文或采用候选 |
| 1280×800：缺项处理 | 点击首镜“查看并补齐素材”，定位原噜噜图片卡，待确认／缺入口／缺方案确认及处理按钮可读；再“5 制作镜头视频”→“查看本镜视频制作条件”，定位正文和具体制作缺项 | [43 对应素材](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/43-1280x800-blocker-material.jpg)、[44 视频主动作](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/44-1280x800-video.jpg)、[45 视频制作条件](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/45-1280x800-video-conditions.jpg) | 原因和处理控件可达；未生成、未批准 |
| 1440×900：正常打开与全文 | 同一可见路径打开原项目→“4 制作关键帧”→放大首镜正文；正文、完整候选、返回／保存位于实际窗口内 | [46 启动](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/46-1440x900-start.jpg)、[47 方案](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/47-1440x900-original-plan.jpg)、[48 关键帧](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/48-1440x900-keyframes.jpg)、[49 全文](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/49-1440x900-full-prompt.jpg) | 通过；原手改和候选不变 |
| 1440×900：素材与视频 | “返回画布”→“查看并补齐素材”，实际定位同一素材卡；“5 制作镜头视频”→“查看本镜视频制作条件”，显示实际缺项和处理按钮 | [50 对应素材](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/50-1440x900-blocker-material.jpg)、[51 视频](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/51-1440x900-video.jpg)、[52 制作条件](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/52-1440x900-video-conditions.jpg) | 通过：查看／导航，未生成 |
| 1440×900：浏览器与往返 | “打开本短剧豆包账号”后阶段自动换行，视频主动作仍可见；侧栏“账号与浏览器”→“创作工作台”，仍为原视频阶段和同一账号首页 | [53 浏览器展开](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/53-1440x900-browser-and-primary.jpg)、[54 侧栏返回](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/54-1440x900-return-browser.jpg) | 本次往返通过；首页展示不冒充找回旧会话，原对话保留证据另见 32～34 |
| 最终交接 | 收起浏览器，通过“输入项目路径”重开现有隔离新项目；当前素材准备、6 项缺失文字、免费确认原因清楚，保留应用供用户查看 | [55 新项目素材准备](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/55-1440x900-final-new-project.jpg) | 已保留 1440×900 实例 |

全文弹窗修复位于 `src/styles/storyboard-canvas.css`：正文区限制高度并内部滚动，textarea 依据实际视口限制高度，页脚独立保留。没有通过隐藏候选、缩小字体或解除 disabled 完成检查。

视口续验前后，原项目 p604、新项目 p11 与 155 条任务文件 SHA 均完全一致，见 ignored `viewport-before.json`／`viewport-after.json`。因此本次没有新建文字或媒体任务、改批准状态、保存手改或采用原候选。原历史回复仍未找回、真实媒体仍未新生成；这两项边界不因尺寸检查通过而改变。

## 7. 离线验证、真实 Chat 与真实媒体分开记账

### 7.1 完整工程门禁

命令：

```bash
pnpm run validate
```

最终源码与测试冻结后完整重跑，退出码 0。结果见本地 ignored `artifacts/user-journey-repair/validate-viewport.log`（此前 `validate-delivery.log` 的 2022 项和 `validate-final.log` 的 2008 项均为较早检查点）：

- contracts／main／renderer／test TypeScript 检查通过。
- ESLint：0 errors、149 warnings，保留现有 149 上限，未为通过修改门槛。
- 工程 fixture、契约 fixture、工程结构及 contracts 边界检查通过。
- Vitest：106 文件／2060 测试全部通过。
- Vite renderer 构建、contracts 编译和 main TypeScript 构建通过。
- 构建仍有大 chunk 提示；DOM 环境存在 TextArea 测量 NaN 和 Ant Design `addonBefore/addonAfter` 弃用提示。这些不是生成成功或失败证据，也未通过删除测试来消除。

最终 `git diff --check` 与 `pnpm exec openspec validate petstory-user-journey-repair --strict` 均通过。完整 validate 在精确视口参数、38 项解析边界测试及全文弹窗 CSS 修复完成后执行；没有用之前的通过结果替代最后源码。

### 7.2 本轮主要新增／补充测试

| 测试文件 | 验证内容 | 分类 |
| --- | --- | --- |
| `developmentWindow.test.ts` | 38 项开发内容区参数解析边界：无参数默认、打包拒绝、重复／非法／越界、合理尺寸和输入不变 | 离线启动参数；实际窗口另见 6.4 |
| `petstoryJourney.dom.test.tsx` | 正常 DOM 点击、真实 Collapse 展开、默认剧本、保存失败零分析、异步方案交接、修订后继、本次失败不引用历史成功、候选先采用再确认、链接草稿、跨页保存／定位／放弃、素材就地检查及恢复入口 | 离线 UI，服务替身；不能替代真实 Electron |
| `petstoryEntrySettings.dom.test.tsx` | 无效 Dola 默认、租约冲突、归档项目、视频模式／时长编辑冲突与合并 | 离线 UI |
| `petstoryJourney.test.ts` | 动态目标计数、单素材批次不冒充全项目、确认摘要、旧正文产物、新候选和手改分列、历史选择、质量独立计算、发送事实 | 纯逻辑／离线 |
| `petstoryMediaFeedback.test.ts` | 阻断文案与目标、连续首帧定位前镜视频、身份确认、历史产物用途及选择一致性 | 离线 |
| `petstoryPlanDraft.test.ts` | 高级草稿仅合并已改字段，新正文保留，同字段冲突拒绝，重排／增删、空数组并发及可选字段删除 | 离线 |
| `petstoryAssetFirst.test.ts` | 只读资格复用正式规则，具体阻断对象、前置、版本变化、零项目写入／零任务；保留实际素材确认链 | 离线服务 |
| `petstoryCapabilityInspection.test.ts` | 图片检查不要求视频模式和控件就绪，仍沿用可见入口及免费确认 | 离线平台 DOM |
| `petstoryExportIpc.test.ts` | 项目／素材文件定位、归属和路径边界拒绝 | 离线 IPC |
| `petstoryMediaAuthorization.test.ts` 等既有回归 | 原制作授权、只读恢复、新生成门禁、任务／来源／候选保护和保活相关既有行为 | 离线回归 |

测试环境增加 Happy DOM 与 Testing Library，分别使用独立 DOM project 和原 Node project；未更换产品技术栈。保留已有静态渲染测试，其结果不作为可见用户流程验收。

### 7.3 真实外部执行

本轮隔离新项目实际记录了 1 个 analysis 与 1 个 materialPrompt，二者均由正常页面触发、来自豆包普通 Chat 原回复，已收取采用。新方案实际为 4 镜头。没有用原项目的五镜头静态 fixture 替代这次新分析，也没有由 Codex 编写正文回填项目。

本轮未新建图片或视频任务、未对新项目批准图片、未新生成媒体。原项目已有 11 张图片仅用于查看和恢复展示，其历史生成不计入本轮真实媒体验收。

## 8. 实现约束和数据保护

`inspectGeneration` 是最小只读接口，复用主进程现有方案／素材确认、正文资格、待收取冲突、能力、模式、引用编译和文件检查。查询不会创建任务、写项目、提取连续末帧或取得制作授权；查询前后核对 revision。前端只把结构化阻断映射成文案与定位按钮，点击生成后仍由原正式方法重验。没有在前端重写一套正则或持久化工作流门禁。

正文、手改、候选和来源继续经过原 Chat runtime 与资格服务；素材确认继续绑定实际 asset ID、文件摘要和人物身份外观。原任务继续保留 task/run 和提交事实，不通过删任务、改状态、伪造 approved/final 或解除租约来消除阻断。结束等待只结束应用等待，不取消平台任务，也不表示回复已采用。

新增文件定位只接受已打开项目和本项目素材标识，通过现有项目路径边界解析；不接受外部任意文件路径或 shell 参数。原有 TaskService／Repository、账号 session partition、自动发送器、下载器与生产执行链继续复用。

应用页面与账号 Webview 保持原位置；总览的新建弹窗和创作编辑器在导航时保留实例。已有保活回归仍在测试集中；本轮真实侧栏往返后仍显示同一已有对话、画布保持 67%；没有通过销毁重建 Webview 推进业务。指定视口已有 6.4 的真实点击、截图与尺寸回读；长时保活和全部平台异常分支仍未穷尽实测。

## 9. 启动与下一步

普通 Mac 开发启动命令：

```bash
cd /Users/zarkding/Documents/doubao-studio
pnpm run dev:mac
```

本次保留实例的精确启动命令：

```bash
pnpm run dev:mac --dev-viewport-size=1440x900
```

当前保留 1440×900 内容区的新项目素材准备页，参见 [55-1440x900-final-new-project.jpg](/Users/zarkding/Documents/doubao-studio/artifacts/user-journey-repair/55-1440x900-final-new-project.jpg)。运行使用当前仓库 Electron 43.8.3、Node 24。当前实例带显式开发视口参数，不带 `--local-control` 或 `--local-cdp`，启动日志位于 ignored `artifacts/user-journey-repair/dev-1440x900.log`。`dev:mac` 使用现有 mac-dev 数据隔离配置，未改为其他历史版本。构建命令为 `pnpm run build`；本轮没有发布安装包。

继续新项目时，可从素材阶段完成剩余文字创作，再由用户在真实图片卡查看／接受素材、明确授权必要媒体任务，随后沿各镜头前置入口制作关键帧与视频。当前所有未完成媒体步骤均保留真实可操作交接，不以“等待用户发送”替代缺失接线，也不将本轮扩大为自动点击、VPN 或 P5 专项。
