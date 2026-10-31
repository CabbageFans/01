# PetStory 当前仓库与最新设计符合性评审

## 结论

**主要架构按最新设计开发了，而且并非仅复制 Skill 文件；但还不能认定“全部入口都已完成迁移、正常流程已全面验收”。**

最重要的问题不是继续增加提示词规则，而是统一以下三条路径：

1. 首次理解剧本／创建制作方案；
2. 单项重新生成图片、尾帧、视频提示词；
3. 最终生成模型与素材已经确定后的媒体提交。

目前第 2 条迁移较完整，第 1 条仍有一次生成全部镜头正文的旧设计，第 3 条存在通用稿／缺少方言信息时的放行边界。此外，真实 Chat 回读的未决状态仍能锁住整个项目的媒体制作。

## 审查范围与证据等级

- 对象：`CabbageFans/01` 本次读取的 main 分支。
- 审查快照：`cababc48d59c553eab60ce59df50cc665878f973`。仅用于标识此次证据，不要求开发回退或以此作为以后开发基准。
- 方式：核心源码调用链、规则资源、相关测试源码、最新运行报告的交叉检查；对两处纯条件判断做了独立的小范围复现。
- 没有修改远程仓库；没有运行用户 Mac 应用或登录豆包；没有独立重跑仓库完整测试。
- 仓库报告中的真实生成结果与“1568项测试通过”均标为**仓库自述记录**，不是本次重新执行结果。
- 不入库的 `artifacts/chat-internalization/` 原请求、原回复及截图未取得，因此不能独立复核全部最新正文。

## 1. 符合设计的实质实现

### 1.1 规则确实进入豆包普通 Chat 请求

`main/utils/petstoryRuntimeRequest.ts::buildDramaRequest` 实际导入 `main/resources/drama/runtime.json`，按阶段选择 `rules.stages`，将规则正文与任务、项目事实、素材列表、输出约定拼成完整请求。

请求明确让豆包执行文字创作，不要求它访问本地文件、不要求它认识 Skill 名称。资产类型分别处理，首帧、尾帧、视频有不同任务说明；中文正文、原剧本优先、允许补全合理拍摄细节等要求也已写入。

这符合“程序承担宿主职责，豆包承担创作职责”的最新设计。

### 1.2 请求确实连接到正式执行链

`src/store/usePetStoryStore.ts::prepareRuntime` 调用 Electron IPC；`main/utils/petstoryChat.ts::prepareRuntime` 调用请求构造器，创建 `mode:'chat'` 的正式任务，保存 `requestText`、`ruleFiles`、`expectedIds`、`promptTask` 和上下文快照，然后由原任务执行能力启动。

这不是只增加一个没有产品调用点的辅助模块。

### 1.3 区分 Chat 看图附件与媒体生成引用

`attachmentList` 表示本次 Chat 理解图片的顺序；`targetReferenceList` 表示目标生图／生视频任务的素材用途和标签。Seedance 已知方言明确要求豆包自己写出 `@图片N`；Seedream 使用本任务适合的中文图片引用和编辑表达。

这修复了“参考规则只有名称、没有真正进入正文要求”的方向性问题。

### 1.4 资产先确认再生成关键帧

`main/utils/petstoryMaterials.ts` 已有按人物、道具、场景建立清单、实际选图、具体文件摘要确认、派生场景依赖和按镜头选择引用的实现。

`requireApprovedMaterials` 和生产服务会检查所需资产；“有描述”“生成成功”与“具体图片已确认”不是同一状态。

新基础素材本地摘要只留在 `original` 预览，`optimized/final` 初始为空；正常生产要求已采用的 Chat 来源或用户明确编辑。不能将代码拼出的设计摘要当成模型创作正文直接生产。

### 1.5 正文读取、采用与用户编辑保护

`petstoryChat.ts::collect` 先保存 `rawText`，再解析、核对目标，保存候选；`applyRuntimePrompt` 用 `answer.optimized` 更新候选和满足条件的 final，不额外撰写画面细节。

已有手改正文保留，旧请求晚返回或镜头上下文变化时不静默覆盖。首尾文字上下文和前镜已采用边界也有对应快照检查。

### 1.6 编译器不再给旧正文添加创作前后缀

`petstoryPromptQuality.ts::compilePrompt/compileMaterialPrompt` 保留 final，调用 `compileReferencedText` 做已有引用的映射，不继续把人物介绍、保持项和“从首帧开始”等写作内容机械追加到正文。

这些改变是正确的，应保留。

### 1.7 引用节点不只是字符串替换

`src/utils/petstoryControls.ts` 包含当前输入区的上传、预览识别、`@`菜单选项、引用节点和首尾槽位探测；`main/utils/petstoryProduction.ts` 校验素材文件、用途、顺序和页面绑定记录。

可以认定有实际适配代码；不能据此认定所有当前网页入口都已经通过真实生成验收。

## 2. 最高优先级问题：首次分析与单项生成仍然是两套质量路径

### 代码证据

- `petstoryRuntimeRequest.ts::selectStages`：`analysis` 只加载 `analysis + assets + storyboard`。
- 同文件 `outputContract`：`analysis` 又要求在每个 `shot.prompts` 中输出完整 `firstFrame.optimized`、`video.optimized` 和可选 `lastFrame.optimized`。
- `petstoryChat.ts::applyRuntime`：analysis 分支进入 `applyStory` 与方案采用，不经过单项正文的 `applyRuntimePrompt/runtimePromptIssues`。
- `petstoryValidation.ts::prompt(..., model=true)`：把 `optimized` 赋为 `final`。
- `petstoryChat.ts::adoptPlan`：为这些正文记录来源，但没有替每项建立对应 `promptTask`；第一次无方案时还会自动采用分析候选。

### 判断

**这不是“提前允许草稿”的问题，而是草稿与正式正文没有完整分层。**

首次分析请求仍然要豆包同时理解故事、拆资产、设计分镜、写全部首帧／尾帧／视频正文；其中视频正文没有加载专门的 `video` 与 `video20/video25` 创作规则，也没有逐镜的目标素材合同。

因此，用户进入新项目，可能得到与手动逐项“重新生成”完全不同质量的正文。即使这些文本确实来自豆包，也不能说明都执行了最新创作方法。

### 建议修复

首次分析保留剧本理解、资产事实、全场设计和动态镜头候选；镜头正文可以先是草稿，但不能直接成为可提交 final。

资产确认后，由应用顺序调用已经存在的专用首帧、尾帧、视频请求，正常保存采用并回填画布。不要另建新工作流框架，也不要要求用户记住必须手动重生每一条。

## 3. 高优先级问题：通用稿进入已知 Seedance 模型时，校验存在缺口

### 代码证据

`main/utils/petstoryPromptQuality.ts::validateVideoPromptTarget`：

```ts
if (!prompt.promptTask) return;
...
if (dialect
    && ['seedance20', 'seedance25'].includes(prompt.promptTask.dialect)
    && prompt.promptTask.dialect !== dialect) {
  throw new Error(...);
}
```

这段逻辑会阻止 `seedance25 → seedance20` 不匹配，但不会阻止 `generic → seedance20`；缺少 `promptTask` 的旧正文更早返回。

### 独立条件复现

只提取此函数的判断分支，移除 TypeScript 类型标注后在 Node 运行。目标模型为 `seedance-2.0-fast`，实际模式为 `reference`：

| 来源正文合同 | 此函数的结果 |
|---|---|
| 没有 promptTask | 不报错返回 |
| generic / reference | 不报错返回 |
| seedance25 / reference | 拒绝方言不匹配 |
| seedance20 / reference | 不报错返回 |

这是单函数条件结果，不代表完整应用已实际提交上述任务。生产流程的其他素材和账号条件仍可能阻止执行。

### 判断与建议

未知模型时生成通用草稿是合理的；之后选定具体 Seedance 模型时，应标记该草稿需要通过相应 Chat 任务重新生成／修订，不能沿用“无方言要求”作为已合规。

旧稿保留、画布允许查看，但没有来源合同或合同仍是 generic 的视频正文，不应自动获得当前具体模型的可提交状态。

## 4. 高优先级可用性问题：Chat 回读失败仍能锁住全部媒体制作

### 代码与报告证据

- `src/utils/chatReadback.ts::inspectChatReadback` 只有在唯一新增用户消息通过 `publishedPromptMatches` 时，才收取对应助手回复。
- `publishedPromptMatches` 进行了部分 Markdown/DOM 排版处理，但仍依赖完整长请求的显示内容匹配。
- 最新报告记录：一条修订的用户消息和助手回复可见，却因嵌套 JSON 的大量显示差异未完成核对。
- `petstoryProduction.ts::checkCapability` 遇到任一 `bound/captured` Chat job，就阻止所有媒体制作。
- 最新报告明确记录因此“媒体整体保持暂停”。

### 判断

防止串回复、重复发送本身是正确的；当前问题是未决任务缺少足够可用的恢复／结束路径。用户已经有合格的其他镜头，也可能无法继续制作。

### 建议修复

保留发送前全文校验，完善发送后的会话、消息轮次、请求ID、预期目标及附件归属确认。不能用只看开头、粗暴删除所有空白的方式替代。

对明确已发送但尚待核对的任务，提供可见的只读补取和用户确认放弃该候选入口；保留原记录、不重发、不标为成功。随后只允许不依赖该任务的已确认目标继续，不静默使用过期正文。

这是恢复机制修复，不是继续扩展提示词规则。

## 5. 中优先级：部分检查把标准要求变成了唯一固定字符串

### 代码证据

`petstoryValidation.ts::runtimeReferenceIssues` 使用：

```ts
!body.includes('全程无字幕、无对白文字叠加。')
```

即使豆包写成语义相同的“全程无字幕，不叠加对白文字。”，该条件也会认定缺失。

独立条件复现同样确认：指定原句通过，等义句不通过。

### 判断

当前请求确实要求使用这条原句，因此这不是前后代码不一致；但是产品把一种自然语言措辞升级为唯一合格形式，可能增加不必要的修订和暂停。

对关键素材编号、原台词、真实输入模式保持严格检查是必要的；对自然语言等义表达，宜采用有限等义识别或交给豆包内容审查，不应由代码补写创作正文。

此外，声音检查能抓明确的 XML 成对标签错误，但不能普遍证明所有环境音都已正确表达。最新报告中仍需内容审查来发现未包裹声音，说明“结构检查通过”并不代表“声音和表演全部正确”。

## 6. 最新真实验证记录：有进步，但没有全部通过

以下仅为仓库 `docs/DOUBAO_CHAT_INTERNALIZATION_REPORT.md` 的结果，不是本次重新登录运行：

| 目标 | 报告记录 |
|---|---|
| 五镜头13项正文 | 都取得新的回复；并非全部采用且通过 |
| 第1镜首帧 | 新候选保留，原手改 final 不变；候选仍有接触关系问题 |
| 第1镜视频 | 一次修订页面可见，但未完成正式回读核对；旧 final 保留 |
| 第2镜视频 | 修订仍使用 XML 成对声音标签，新候选未采用 |
| 第3镜视频 | 已有 @、对白和过程，但鼻息仍在声音标签外，标待复核 |
| 第4镜视频 | 报告称首次代码块回复已有正确引用、对白及走位并采用 |
| 第5镜视频 | 一次修订后仍有环境底噪表达待复核 |
| 整体结果 | `verificationPass=true`，`acceptanceAllPassed=false` |
| 媒体 | 本轮新增0项；真实@节点、首尾槽位、连续画面与声音待验收 |

不能继续用早先没有 `@图片` 的导出，断言这次完全没改；也不能用报告中的代码测试数，反过来宣称内容效果已经合格。

## 7. 最新需求覆盖矩阵

| 最新设计要求 | 结论 |
|---|---|
| Skill知识进入豆包Chat，而非仅安装到Codex | 符合；有运行时加载及请求调用 |
| 所有新创作正文来自普通Chat | 核心新路径符合；材料生产另有来源校验；用户手改保留 |
| 剧本理解、资产拆解、分镜导演规则 | 有实质规则与数据接线；效果仍依赖真实回复 |
| 先基础素材生成确认，再关键帧生产 | 有明确实际文件确认检查 |
| 首帧、尾帧、视频分别组织请求 | 单项请求符合；首次analysis仍混写全部正文 |
| Seedance对应规则与@引用 | 已知模型的单项路径符合；generic/无合同进入生产仍有缺口 |
| 同一镜头共享起终、首尾文字与前镜边界 | 有实现；不等同自动证明语义连续 |
| 不让代码补写提示词内容 | 新编译器符合，仅映射原有引用 |
| 手改final、新候选、过期回复区分 | 有实质实现 |
| 画布采用当前结果、复用P4任务执行 | store和服务已有调用；本次未独立运行Electron UI |
| 内容审查与一次修订 | 有实现，但不能保证修订后全部合格 |
| 只使用原五镜头业务验收 | 报告与相关夹具遵循；本次未用其他故事作内容验收 |
| 最新13项提示词全部合格 | 未通过，仓库报告已明确 |
| 真实图视频效果与素材绑定全通过 | 尚无足够新验证证据 |

## 8. 下一轮最小修复顺序

1. **统一首次分析和单项生成路径。** 初始分析不直接提供可投产的全部正文；调用已有专用Chat阶段完成正文。
2. **补齐 generic/缺失 promptTask 到已知模型的转换检查。** 保留旧稿，要求当前方言重新生成或修订。
3. **完成未决Chat的恢复／放弃候选闭环。** 防串号、防重发保留，不让无关有效目标无限停摆。
4. **调整自然语言等义校验。** 不再把非实质性的标点／固定句式误判为核心生成失败。
5. **仍用原五镜头从正常页面完整复测。** 先检查实际请求、豆包原回复、保存采用是否相同，再由用户确认素材并做媒体测试。

不建议重做画布、不建议再换一个提示词框架、不建议继续堆叠多套“优化器”。当前工作已经形成可用基础，需要收敛入口和恢复路径。

## 9. 源码索引

以下链接固定到此次审查快照，仅供复核证据：

- [请求构造、阶段选择与输出约定](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryRuntimeRequest.ts)
- [运行时创作规则](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/resources/drama/runtime.json)
- [Chat任务创建、收取与采用](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryChat.ts)
- [提示词编译及方言检查](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryPromptQuality.ts)
- [回复契约和文本检查](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryValidation.ts)
- [资产选择、批准与来源](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryMaterials.ts)
- [生产调度与页面绑定](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/main/utils/petstoryProduction.ts)
- [画布业务状态入口](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/src/store/usePetStoryStore.ts)
- [页面参考图与@控件](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/src/utils/petstoryControls.ts)
- [Chat DOM回读](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/src/utils/chatReadback.ts)
- [请求构造相关测试源码](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/tests/unit/dramaRuntimeRequest.test.ts)
- [本轮Chat内化报告](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/docs/DOUBAO_CHAT_INTERNALIZATION_REPORT.md)
- [之前的运行时迁移报告](https://github.com/CabbageFans/01/blob/cababc48d59c553eab60ce59df50cc665878f973/docs/DRAMA_SKILLS_RUNTIME_REPORT.md)

本次独立条件复现脚本：`branch_probe.cjs`；结果：`branch_probe_results.json`。它们不是仓库完整测试，也不发送任何模型请求。
