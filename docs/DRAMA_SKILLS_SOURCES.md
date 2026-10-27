# drama-skills 产品规则来源与适配

本说明记录规则来源与宿主适配；真实运行、五镜头文字结果和媒体效果分别见 `DRAMA_SKILLS_RUNTIME_REPORT.md`。规则存在、离线测试通过或模型自检都不代表真实文字/媒体链路已验收。

## 固定基线与许可

- 仓库：[zenstory-ai/drama-skills](https://github.com/zenstory-ai/drama-skills)。
- 审查基线：标签 `v0.9.2`，提交 `fdb7b7c58017e3eae64eca382c2a85ede368dab0`；`git rev-parse HEAD`、`git tag --points-at HEAD` 与 `VERSION`（`0.9.2`）已核对。
- 获取/适配日期：2026-10-25（Asia/Shanghai）。参考源在临时缓存中审读，运行时不依赖缓存、Codex 技能目录、网络仓库或固定 CWD。
- 上游许可为 MIT，版权 `Copyright (c) 2026 drama-skills contributors`。原文保存在 `main/resources/drama/LICENSE`，并完整嵌入 `runtime.json.licenseText`，随 JSON 进入构建。许可允许改编，须保留版权和许可，不提供质量/适销保证。
- 产品规则版本：`drama-skills-0.9.2-studio.3`。这是 Studio 的适配资源版本，不冒充上游新版本或应用已发布版本。本轮仅统一分析／专用正文职责、有限等价字幕约束与每原请求一次自动修订；上游提交与许可保持原固定基线。

## 资源形式与加载

`main/resources/drama/runtime.json` 含 13 个阶段的实质规则、47 份源文件路径/固定 blob SHA/SHA-256、逐阶段来源与能力映射、产品决定和经验局限。规则写的是可复用方法，不含本案例的业务正文或固定五镜头答案。

主进程 `main/utils/petstoryRuntimeRequest.ts` 按阶段导入 JSON，构造真正发送的普通 Chat 请求：具体目标 + 实质规则 + 当前确认事实 + 本次实际附件清单/用途 + 输出契约。`resolveJsonModule` 使 JSON 进入主进程构建，源版权许可也在 JSON 中。渲染层通过现有 IPC/store 发起请求，不依靠买家安装 Skill。超长输入拒绝并要求拆批，不截断；镜头/素材正文由豆包本次回复产生。

| Stage | 迁移内容 | 使用方法 |
|---|---|---|
| `analysis` | 原文优先、必要规范化、因果、指代、对白/声音、来源/知情分层 | 分析与旧项目来源补齐；不默认改写确认剧本 |
| `assets` | 逐段出现、身份/变体/瞬态、地理/视角、道具状态、持续关系与连续性锁 | 动态资产提取或旧项目补齐 |
| `imageCharacter` | 人物锚点、单一相容造型、识别友好构图 | 单个人物基础图完整正文 |
| `imageProp` | 尺度/轮廓/材质/功能部件与当前静态状态 | 单件道具基础图完整正文 |
| `imageScene` | 文字地图、可通行地理、空场、同地光源连续 | 单个场景或 View 基础图完整正文 |
| `imageEdit` | base/delta/validity、目标/区域/变化/保持/影响 | 与适用素材类型规则组合，定点修订/变体 |
| `storyboard` | 原文落实、动态拆镜、镜头职责、观众揭示、全场站位、轴线、动作/对白预算 | 新动态方案候选；既有镜头模式保护 ID 和主起终 |
| `firstFrame` | 单时刻构图、只投影 start、反向读画面、防提前终态 | 与当前 Studio Seedream 适配组合 |
| `lastFrame` | 基于实际选定首帧编辑至 end、具体变化和保持集 | 无图仅编辑计划，不虚构首尾槽位 |
| `video` | 主状态链、接触/落点、表演、持续身体关系、声音与时长、可生成性 | 通用完整视频写作；模型未知只加载此规则 |
| `video20` | 2.0 中文动作次序、对白/音效方言、互斥模式与引用职责 | 仅明确 2.0 时，与 `video` 合用 |
| `video25` | 2.5 可见反应链、条件时间段、声音方言、任务意图边界 | 仅明确 2.5 时，与 `video` 合用；不启用默认 extend |
| `review` | 证据式审查、结构/语义分层、反模板、最小局部修订 | 明确目标、证据、影响、结果、保持集与严重度 |

分析/旧资产补齐会组合 `analysis + assets + storyboard`：旧五镜头缺少准确对白来源、空间和导演字段，需同步分析依据；资产补齐的输出契约只返回资产与既有镜头绑定/导演字段，不重新拆镜或写媒体正文。素材请求只加载本类型配方；视频只加载通用和命中版本，不一次倾倒全部图片/模型规则。每个阶段约 1.4–2.6K 字符，组合后仍保留主要方法，项目事实按请求范围投影。

素材卡的“变体／局部编辑计划”提供具体基准图片、变化、保留项与适用范围表单，沿原 `materialPrompt` 链加载本类型加 `imageEdit`，不另建执行器。编辑回复只保存候选，显式采用后把 `editIntent` 与最终正文一起保存，重开和引用编译继续使用该基准；普通重新生成并采用时清除旧编辑意图。缺少实际基准、图片已更换或范围未写明时，在创建 Chat 任务前拒绝。

生产前检查到的当前模型能力通过 `promptCapability` 留在同一项目和 Chat 快照中，供 `video20`/`video25` 选择与过期判定；不再要求先创建媒体 production 才能选择文字方言。重开时恢复文字选择，同时清除当前会话媒体验证标记；媒体创建、预览与继续仍须重新核对入口。对白的 `delivery` 明确画内、画外 OS 或旁白 VO，不因说话者有台词就强制将其作为可见人物入画。

## 源规则与产品决定

| 上游宿主/默认 | Studio 接法及理由 |
|---|---|
| 读本机剧本、视觉设定、分镜等五 Markdown | 当前项目 JSON/service 为唯一状态源；程序把相应内容注入自足请求，导出只是视图 |
| 调用另一个 Skill、写文件、执行供应商 adapter | 程序选创作阶段并保存/采用；媒体仍走当前豆包网页执行链，无第二模型 API/浏览器 |
| 无项目配置时图片正文默认英文 | 默认中文，逐字台词保原口语语言；服从用户当前项目 |
| 真人细节、人物三视图、组合 production sheet 示例 | 按确认动画形态和资产用途表达，默认清楚单图，不强制套真人比例/五指/微纹理 |
| 固定节奏档案、近景占比、一次一句的剪辑默认 | 仅已明确接受的当前限制生效；镜数/角色/道具/场景数动态，镜头职责和可读性先行 |
| Seedance 原生 API 时长/素材上限、同轨音频 | 只迁移版本对应写法；网页参数/容量/槽位/音频以现有能力记录与页面回读为准 |
| 2.5 默认 extend、连续容器/多镜容器 | 当前逐镜模式与 cut/continue 继续使用，未引入延长或多镜生产能力 |
| 缺图时不写最终视频提示词 | 本轮允许明确计划稿；不称已看图/已绑定/已批准，不使计划稿直接触发媒体提交 |
| REF/PLAN/IMG 路径及位置式引用 | 项目逻辑 assetId/版本/用途 → 本任务真实上传 → 实际 @ 节点或首尾槽位 → 最终任务快照；Chat序号和生成序号分开 |
| 同一文件多个职责拆多个 REF 槽 | 保留多个逻辑用途，但同一实际文件去重上传，不机械占满附件 |
| 审查与改稿分别由 Skill 分派 | 普通 Chat 证据式审查与对应阶段局部修订；诚实标注模型自检，每批最多一次自动内容修订 |
| 旧预览冲突不采用最后写入者获胜 | 当前版本/人工 final 保护、候选明确采用、较早请求晚回仅过期候选，由产品服务执行 |

不迁移长篇/多季开发平台、上游 Dashboard 或目录系统、供应商凭据/历史媒体、Ollama/其他云模型、TTS/音乐生成、全片编辑/字幕/合成/发布或新多智能体平台。`short-drama-produce` 和 `short-drama-edit` 不整体移植。

## C01–C14 方法追溯与代码接线

以下表标明迁移位置；完成程度/真实验证以结果报告和任务记录为准，不由这张映射自动判定。

| 能力 | 上游方法文件组 | 阶段与当前代码入口 | 验证关注点 |
|---|---|---|---|
| C01 剧本理解 | write SKILL / screenplay-format / script-craft / dialogue-craft | `analysis` → runtime request → Chat service | 原文保留、指代/事件/对白说话者正确 |
| C02 来源落实 | shot-craft / production-shot-grammar / coverage-audition | `analysis/storyboard/review` | 事件台词主承担镜头、信息不提前、遗漏/重复理由 |
| C03 资产 | assets SKILL 与7篇核心reference | `assets` → 提取/补齐候选 → 当前项目资产 | 动态集合、别名、身份/变体/地点View、持续关系 |
| C04 素材正文 | image-prompts SKILL / common-recipe / 各类型 / edit | `imageCharacter/Prop/Scene/Edit` | 类型不污染、完整本次正文、变化/保持边界 |
| C05 图片确认 | image-prompts参考边界 / reference-roles | `PetStoryMaterials` 与既有生成/导入/确认 | 指定具体图片，生成≠批准，缺图计划不能生产 |
| C06 分镜导演 | storyboard SKILL / shot-craft / production grammar / coverage | `storyboard` → 新方案候选/既有镜头完善 | 动态拆镜、镜头职责/景别/机位/切点/运镜理由 |
| C07 连续性 | assets continuity-delta/lock / blocking-playbooks | `assets/storyboard/keyframe/video/review` | 世界锚点→画面方位、轴线/视线/手/依托/持物 |
| C08 关键帧 | keyframe-craft / lighting-craft / 完整示例 | `firstFrame/lastFrame` + 当前 Seedream 适配 | 起终分离、单瞬间构图、尾帧变化/保持 |
| C09 动作表演 | motion-recipe / performance-action-timing / generability | `video` + 命中模型 | 触发/处理/接触/反应/落点与时间负载 |
| C10 声音时长 | dialogue-craft / shot-craft / camera-audio-continuity | analysis/分镜/video/review | 逐字与归属、VO/OS、发声窗口、估计≠实测 |
| C11 方言与引用 | target-model-profile / seedance-2.0/2.5 / reference-roles | `video20/25` 与现有引用编译/网页执行 | 真实附件、逻辑到实际编号、模式/槽位不混 |
| C12 审查修订 | review SKILL / rubrics / review-method / anti-template | `review` → 最小修订候选 | 明确证据/影响/保持、有限修订、无关项不重写 |
| C13 采用同步 | edit-and-revision / shot-revision-identity / review-method | Chat service → candidate/final → store/画布/导出/任务 | 手改保护、晚回过期、正文同源一致 |
| C14 完整性 | LICENSE / VERSION / 来源SHA / checker与probes | runtime JSON → 真正发送请求及规则记录 | 固定基线/许可进入构建、真实原五镜头文字链路 |

当前主入口：`main/utils/petstoryRuntimeRequest.ts`、`main/utils/petstoryChat.ts`、`main/ipc/petstory.ts`、`src/store/usePetStoryStore.ts`、`src/components/PetStoryRuntime.tsx` 及既有画布、素材/提示词面板。请求和回包契约由当前服务保存，不另建项目状态。针对这些接线的离线测试包括 `dramaRuntimeRequest.test.ts`、`petstoryDramaRuntime.test.ts`、`petstoryRuntimeStore.test.ts`；它们只验证机制，真实输出另验。

## 机械检查与经验边界

`skills/short-drama/scripts/creator_markdown_check.py` 的相关解析/验证代码用于审读机械检查边界：稳定ID与集合、引用/名称/角色对应、实际参考与挂图计划分离、文件存在性、逐字对白引用、同镜时长和锁面等。没有复制运行其五Markdown格式系统。缺输入时只能跳过依赖检查，不能写成通过；名字/锁面命中不能证明画面存在或语义正确。动作先后、表演可读性、因果、微表情/景别相容、素材像素等仍由有证据的内容/媒体验证处理。

`evaluations/model-behavior-probes.md` 已完整审读。它记录 2026-09-08～2026-10-20 的探索，多数经中转服务、部分为 Seedance 2.5 样片档；盲评判断者仍是同一模型，原始媒体在仓库外，没有可重放夹具。不能据其中小样本得出当前豆包普通Chat或网页生成的成功率、API支持、稳定因果或质量保证。保留的是可试验方法：按机位写前后景、给可见反应链、用接触点/地标表达动作落点、写光位与受光结果、核对首尾图中间动作；不搬固定动作数、H3专用表演配方、统一字数阈值或其他模型结论。

## 固定源文件清单

每项固定提交链接可查看原文。`runtime.json.sources` 另外保存全文 SHA-256 与 Git blob SHA，便于逐字核对；它们是来源证据，不是另一套业务状态。以下列出实际采用的方法章节，原文的文件系统/供应商操作按前文适配。

### `evaluations/model-behavior-probes.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/evaluations/model-behavior-probes.md)；Git blob `202fa58170d331b676e455f605febbbdacc4f02a`。
- 加载阶段：`video20`, `video25`。
- 审读/适配章节：探索观察完整表格；执行路径限制；后续使用与不可外推边界。

### `skills/short-drama-assets/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/SKILL.md)；Git blob `3cce5c0ababcf514f806e57f7b95656d2912d77c`。
- 加载阶段：`assets`。
- 审读/适配章节：入口与边界；工作流；内容要求；按需知识；完成。

### `skills/short-drama-assets/references/character-and-look.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/character-and-look.md)；Git blob `4281d0c654afe3dee69787b06253c541b9294d34`。
- 加载阶段：`assets`。
- 审读/适配章节：分工；画面代称要覆盖每一种正文语言；Character：最小稳定识别集；Look：一次相容的外观组合；可选声音方向：身份锚点不等于本场 delivery；制作形态与身份锚点的可表达性；合成例：顾禾；角色视觉设定的实用检查。

### `skills/short-drama-assets/references/continuity-delta.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/continuity-delta.md)；Git blob `6132864fc728e1688c5a03d9abd38246becdffa1`。
- 加载阶段：`assets`。
- 审读/适配章节：边界匹配 (`CON-01`)；状态表与变化记录的区别；各环节负责什么；需要追踪的五组状态；写变化记录的步骤；合成状态链；非线性时间与有意断裂；修订影响；交接检查。

### `skills/short-drama-assets/references/continuity-lock.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/continuity-lock.md)；Git blob `1f1db0239eeaf2e23c4af215770d9defa095fbfa`。
- 加载阶段：`assets`。
- 审读/适配章节：为什么识别锚点还不够；什么值得上一把锁；锁面怎么写；语法；道具 · 织了一半的毛衣；谁负责把锁面带走；反例；校验。

### `skills/short-drama-assets/references/identity-vs-variant.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/identity-vs-variant.md)；Git blob `7e57beee93bb1952227a043373486cc7170beec5`。
- 加载阶段：`assets`。
- 审读/适配章节：三个问题；持续身份与可变状态；判断步骤；容易误判的情况；合成判断例；决定记录要说明理由；制作案例说明。

### `skills/short-drama-assets/references/location-and-view.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/location-and-view.md)；Git blob `964a155a4d48a7b53c3f2c2f02c88d66536a6315`。
- 加载阶段：`assets`, `imageScene`。
- 审读/适配章节：分工；先明确空间关系，再写氛围；Location 边界；View 边界；光、天气和陈设必须有来源；合成例：旧渡站值班室；检查问题。

### `skills/short-drama-assets/references/occurrence-extraction.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/occurrence-extraction.md)；Git blob `ca91745c776f81fcc9c0eb79f404379739ae8fe3`。
- 加载阶段：`assets`。
- 审读/适配章节：目的：保存证据，不抢先下结论；逐段检查，而不是只找名词；事实分层；称谓、代词和匿名对象；出现不等于视觉资产；状态摘取要点；完整性检查。

### `skills/short-drama-assets/references/prop-and-state.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-assets/references/prop-and-state.md)；Git blob `0341bae8e2cf95670184fc047b3d8cb1bdc47ec3`。
- 加载阶段：`assets`。
- 审读/适配章节：道具不是名词表；道具：持续身份；状态：此刻怎样；个体、同款与集合；可读文字政策；内容物与知识是两条连续性；有明确用途的关键道具；合成例：铁皮匣；检查问题。

### `skills/short-drama-image-prompts/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/SKILL.md)；Git blob `583b2f9a51e032d970d6c3a34dc788fb1b2d94c0`。
- 加载阶段：`imageCharacter`, `imageProp`, `imageScene`, `imageEdit`。
- 审读/适配章节：入口；工作流；提示词要求；按需知识；完成与投产。

### `skills/short-drama-image-prompts/references/character-and-look.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/character-and-look.md)；Git blob `625a7a6dff22c60046bc9015a8ffc1fce0391def`。
- 加载阶段：`imageCharacter`。
- 审读/适配章节：身份测试 (`IMG-03`)；1. 人物设定图解决什么；2. 身份层与 Look 层；3. 构图方法；4. Look/state variant；5. 输出与审查；6. 制作形态投影与模板槽位。

### `skills/short-drama-image-prompts/references/common-recipe.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/common-recipe.md)；Git blob `595138a5b96f37f44363aca9df1941fbd0b59a76`。
- 加载阶段：`imageCharacter`, `imageProp`, `imageScene`, `imageEdit`。
- 审读/适配章节：本文负责的做法；1. 目的与输入；2. 从资产事实到画面语言；3. 八段式配方；4. 锚点、约束与取舍；5. 输出、常见问题与检查。

### `skills/short-drama-image-prompts/references/edit-and-revision.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/edit-and-revision.md)；Git blob `2788a7d60814bd508ff1f6d74a6d826a89cd738a`。
- 加载阶段：`imageEdit`, `lastFrame`。
- 审读/适配章节：有界编辑合同 (`IMG-06`)；1. 两类修改；2. Edit-delta 配方；3. 自然语言修订；4. 当前文件冲突；5. 失败与检查。

### `skills/short-drama-image-prompts/references/location-plate.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/location-plate.md)；Git blob `78a09fedbdfda165ef395f474e80b7342471d269`。
- 加载阶段：`imageScene`。
- 审读/适配章节：地理测试 (`IMG-04`)；1. 目的与输入；2. Location 与 View；3. 地理优先的编写法；4. 光线、气氛与空场；5. 输出与审查；6. 制作形态投影。

### `skills/short-drama-image-prompts/references/look-and-state-variant.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/look-and-state-variant.md)；Git blob `2d7d0c3c7146bfaa819841fc2709211702d7dfa6`。
- 加载阶段：`imageCharacter`, `imageProp`, `imageEdit`。
- 审读/适配章节：1. 什么时候需要变体；2. Base—delta—validity；3. 三类变体的写法；4. 变体 plate 与 edit 的区别；5. 输出、失败与审查。

### `skills/short-drama-image-prompts/references/prop-plate.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/prop-plate.md)；Git blob `fcb195ad15621691eb356c922f91f8b9d20950b1`。
- 加载阶段：`imageProp`。
- 审读/适配章节：识别测试 (`IMG-05`)；1. 目的与输入；2. 身份与 State；3. 可复用 plate 配方；4. 文字政策；5. 输出与审查；6. 制作形态投影。

### `skills/short-drama-image-prompts/references/review-and-fixtures.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-image-prompts/references/review-and-fixtures.md)；Git blob `0e00b124b58cfcb571917cc0b00584983f76768a`。
- 加载阶段：`imageEdit`, `review`。
- 审读/适配章节：1. 审查方式；2. 证据量表；3. 完成前结构检查；4. 合成正例；5. 合成反例。

### `skills/short-drama-review/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/SKILL.md)；Git blob `f4e4e41e94872514fda35ba8c6d79b7f3119e1d6`。
- 加载阶段：`review`。
- 审读/适配章节：Blocker · REV-001 · 画面文字未被镜头承载；选择审查范围；工作流；严重程度；边界。

### `skills/short-drama-review/references/anti-template-repair.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/references/anti-template-repair.md)；Git blob `2b0ad7f4ff95e51b074cfafa7d9064bbe50a3785`。
- 加载阶段：`review`。
- 审读/适配章节：1. 诊断四层；2. 修订不是换同义词；3. 误报反例；4. Finding 示例；Major · REV-003 · 连续两集用同一种自曝完成揭示；5. 分级。

### `skills/short-drama-review/references/review-method.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/references/review-method.md)；Git blob `0dbf1ad9c8617675ca57629a3cc70c7c592aa07e`。
- 加载阶段：`review`。
- 审读/适配章节：Rule classification；Governing know-how；Review scope；Mechanical before taste；Finding anatomy；Cross-layer synthesis；Revision and re-review；Anti-template review。

### `skills/short-drama-review/references/rubric-assets-prompts.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/references/rubric-assets-prompts.md)；Git blob `bec7d913b23bab66a6657188640aff53b65d17e8`。
- 加载阶段：`review`。
- 审读/适配章节：Occurrence and decision；Identity versus variant；Era；Prompt recipe review；Prompt quality failures。

### `skills/short-drama-review/references/rubric-story-script.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/references/rubric-story-script.md)；Git blob `44c209da1b39291a2e011d4f5865a113d467d23d`。
- 加载阶段：`review`。
- 审读/适配章节：Story promise and engine；Episode shape；Entry, character, and serial memory；Adaptation fidelity；Scene test；Action and production meaning；Dialogue；Rhythm profile (`REV-12`)；Local passes (`REV-13`)；Replaceable realization (`SCR-10`)；Common findings。

### `skills/short-drama-review/references/rubric-visual-motion.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-review/references/rubric-visual-motion.md)；Git blob `deede3b75cc5ccf53556e2aa8410c1f292448bba`。
- 加载阶段：`review`。
- 审读/适配章节：Coverage and meaning；Shot purpose and geography；Rhythm profile: shots；Frozen keyframe；Motion；Cross-shot continuity；Common findings；Production-risk and authorized-observation checklist (REV-08)。

### `skills/short-drama-storyboard/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/SKILL.md)；Git blob `62ab08d7b9bf0d9ffec57bd702a7ab973ff193dd`。
- 加载阶段：`storyboard`, `firstFrame`, `lastFrame`。
- 审读/适配章节：入口；工作流；镜头要求；视觉依据与图片；按需知识；修订；完成。

### `skills/short-drama-storyboard/references/blocking-playbooks.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/blocking-playbooks.md)；Git blob `01d63d006caa5307c892877ef64ff4e5f4580a98`。
- 加载阶段：`storyboard`, `firstFrame`。
- 审读/适配章节：1. 竖屏多人调度；1b. 站位、轴线与正反打；场景站位 · EP003-SC002 · 财务室；2. 单房对白；3. 证据揭示；4. 群体与轴线；5. 动态对象与竞赛；6. 观察视角与边界；7. 规则分级。

### `skills/short-drama-storyboard/references/coverage-audition.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/coverage-audition.md)；Git blob `ad8571ff2d9a43188efae08dd3f4e3053ac32d13`。
- 加载阶段：`storyboard`。
- 审读/适配章节：什么时候比较；什么叫真正不同；比较方式。

### `skills/short-drama-storyboard/references/keyframe-craft.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/keyframe-craft.md)；Git blob `90afb1b48566abd8eb8c06f2e830905dc53d5380`。
- 加载阶段：`firstFrame`, `lastFrame`。
- 审读/适配章节：Boundary and instant tests；Purpose；Ordered recipe；尾帧：什么时候可以有，以及它换来什么代价（`SHT-17`）；Start-only drafting discipline；Static test；Prompt economy；Failure examples。

### `skills/short-drama-storyboard/references/lighting-craft.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/lighting-craft.md)；Git blob `271dba0dd1921b1d7ce924dad146cf21ed1da849`。
- 加载阶段：`storyboard`, `firstFrame`。
- 审读/适配章节：分工；按镜头职责设计；把光位与画面效果一起写清；参考板与跨镜连续性。

### `skills/short-drama-storyboard/references/production-shot-grammar.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/production-shot-grammar.md)；Git blob `42ac8650b58520d43107b84a2b868685a10472c5`。
- 加载阶段：`storyboard`。
- 审读/适配章节：一、贯穿原则；二、编号与文本分工；三、拍→镜拆分规则；四、动作顺序交接（给视频提示词环节的输入）；五、镜头叙事学（摄影决策问题）；六、场景戏型诊断问题；七、项目选择（`craft_default`）；七之二、单集时长加总（`SHT-16`）；八、人物反应（SHT-11）；九、自检清单；十、范例（合成决策记录，不是镜头配额）；十一、反模式。

### `skills/short-drama-storyboard/references/screenplay-to-keyframe-example.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/screenplay-to-keyframe-example.md)；Git blob `0d6a01c7193821e9c423414feffe4cb27b50db7e`。
- 加载阶段：`storyboard`, `firstFrame`。
- 审读/适配章节：剧本段；EP004-SC002 内 · 社区洗衣房 · 清晨；原文落实；SHOT-01：拒绝交牌；SHOT-02：声音引导注意；SHOT-03：证据细节；KEY-03：冻结瞬间；KEY-03 之后：从成稿画面回填三条依据；连续性交接；（情绪）交接；EP002-SC004 内 · 老楼梯间 · 夜。

### `skills/short-drama-storyboard/references/shot-craft.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/shot-craft.md)；Git blob `c192cd53b124c8bc798404e8d38d5ee804bcc4ca`。
- 加载阶段：`storyboard`, `lastFrame`。
- 审读/适配章节：规则分级；先落实原文，再追求画面；镜头目的；场面调度与地理；景别与摄影机动机；时长与切镜；视觉方向选择 (`SHT-07`)；相连边界 (`CON-01`)；常见问题；审查问题；首尾成对；一镜到底还是切开。

### `skills/short-drama-storyboard/references/shot-revision-identity.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-storyboard/references/shot-revision-identity.md)；Git blob `a1c41c32f2618bc1cda77d15d4298f28b608b430`。
- 加载阶段：`storyboard`。
- 审读/适配章节：身份规则；每次拆分、合并或重排后的对账。

### `skills/short-drama-video-prompts/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/SKILL.md)；Git blob `e79ed31ef4fa575ee8f838227c854f49f4e448d9`。
- 加载阶段：`video`。
- 审读/适配章节：入口与边界；工作流；提示词要求；按需知识；完成与投产。

### `skills/short-drama-video-prompts/references/camera-audio-continuity.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/camera-audio-continuity.md)；Git blob `fb5addb6cf9e812adaee2f65532db8049d10303b`。
- 加载阶段：`video`。
- 审读/适配章节：摄影机合同；相连边界 (`CON-01`)；1. 摄影机为什么动或不动；2. 摄影机指令冲突；3. 环境运动；4. 对白、口型与声音；5. 只读边界与修订路由。

### `skills/short-drama-video-prompts/references/generability.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/generability.md)；Git blob `aad82f49e8db283112b136144d4917a75bad1ded`。
- 加载阶段：`video`。
- 审读/适配章节：1. 什么时候适用；2. 判据：这个动作在日常影像里常见吗；3. 四类高风险写法；4. 戏剧信息从哪里来；5. 改写方法；6. 失败征兆与审查问题。

### `skills/short-drama-video-prompts/references/motion-recipe.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/motion-recipe.md)；Git blob `c923d1622c2f607b60f1d7eb40cdd2b75143e923`。
- 加载阶段：`video`。
- 审读/适配章节：本文负责的规则；字段必须填写本镜的具体内容；末镜交接；1. 目的、输入与权属；2. 起止边界清单；3. 运动说明的七个部分；4. 从镜头事实到自然语言；5. 输出、常见问题与检查。

### `skills/short-drama-video-prompts/references/performance-action-timing.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/performance-action-timing.md)；Git blob `e129126fa1c2454dc78d89a808ce21a4ae1412c0`。
- 加载阶段：`video`。
- 审读/适配章节：时长门槛；1. 动作预算不是计数器；2. 构造可演的动作链；3. 构造可见的表演变化；4. 时间与对白共同预算；5. 超载修订与审查。

### `skills/short-drama-video-prompts/references/production-prompt-grammar.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/production-prompt-grammar.md)；Git blob `0cddbaf777547f4171129376c25b5ddf7006e0f9`。
- 加载阶段：`video`。
- 审读/适配章节：一、先写核心动作，再选择交付格式；二、连续性（不同镜头类型都适用）；三、按已知能力调整写法；四、文本交付读取的项目参数；五、文字与缺陷约束；六、决策规则；七、范例（从边界写成通用提示词）；交付文本只含交付内容；八、自检清单。

### `skills/short-drama-video-prompts/references/seedance-2.0.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/seedance-2.0.md)；Git blob `6f160f0b1948db1aa9e6dd0b5e08c578ccdda19b`。
- 加载阶段：`video20`。
- 审读/适配章节：正文组织；站位与视线；参考与续写；三种起点互斥；正文写多长；参考图挂多少；时长与边界。

### `skills/short-drama-video-prompts/references/seedance-2.5.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/seedance-2.5.md)；Git blob `eb7adb1745716f81cc5e48c8b77097ffc6a9c59b`。
- 加载阶段：`video25`。
- 审读/适配章节：生成与参考；编辑与延长不是普通参考；对白、声音与文字；连续容器；时长。

### `skills/short-drama-video-prompts/references/target-model-profile.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-video-prompts/references/target-model-profile.md)；Git blob `2ca73fdeb83812c1f1c5ee8eb5997bfa9748d764`。
- 加载阶段：`video`, `video20`, `video25`。
- 审读/适配章节：这份档案解决什么；九条会改变正文的能力轴；声音同轨生成；参考条件方式；未声明时怎么写；自检。

### `skills/short-drama-write/SKILL.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-write/SKILL.md)；Git blob `0a05607dcd70c7a960860c2711ec2baa59a392f6`。
- 加载阶段：`analysis`。
- 审读/适配章节：入口；工作流；写作要求；按需知识；时长估算（按需）；完成。

### `skills/short-drama-write/references/dialogue-craft.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-write/references/dialogue-craft.md)；Git blob `8a202919e5250aacd5fab54d364a64307b6eec70`。
- 加载阶段：`analysis`。
- 审读/适配章节：1. 对白的工作定义与规则分级；2. 先写议程，再写句子；3. 台词是一种行动；4. 潜台词来自已知差与风险；5. 信息如何进入冲突；6. 人物声音如何区分；7. 让对话改变权力与关系；8. 动作、停顿、打断与沉默；9. 高密度对白场景；10. 对白修订流程；11. 合成示例；12. 失败征兆与审查问题。

### `skills/short-drama-write/references/screenplay-format.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-write/references/screenplay-format.md)；Git blob `b884d84341c7f911080109f2a2984bf7585ff763`。
- 加载阶段：`analysis`。
- 审读/适配章节：1. 设计目标与事实所有权；2. 文件、集与场景结构；<场景ID> <内|外|内外> · <地点> · <时间/天气>；EP001-SC003 内 · 渡口售票室 · 雨夜；3. 动作、对白与生产标签；4. 注释与未知内容；5. 完整格式示例；EP001-SC003 内 · 渡口售票室 · 雨夜；6. 稳定 ID、临时索引与修订；7. 现有文本的规范化入口；8. 剧本中不应出现的内容；9. 完成前检查。

### `skills/short-drama-write/references/script-craft.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama-write/references/script-craft.md)；Git blob `dd13b8a04e625ae07e52d364484c2069d7954e6a`。
- 加载阶段：`analysis`。
- 审读/适配章节：1. 剧本的任务与规则分级；2. 从单集契约到场景；3. 冲突场景的发动机：目标、反对、转向、退出；4. 把内在意义写成可表演行动；5. 用空间、物件与反应组织冲突；6. 节奏来自压力变化；7. 写动作段落与生产事实；8. 开场、收束与集间交接；9. 修订方法；10. 现有剧本的最小规范化；11. 合成示例；EP001-SC002 内 · 社区打印店 · 夜；12. 失败征兆与审查问题。

### `skills/short-drama/references/reference-roles.md`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama/references/reference-roles.md)；Git blob `008e2860a732ce43b0edcdf6079b6b1d8506d0ab`。
- 加载阶段：`imageCharacter`, `imageProp`, `imageScene`, `firstFrame`, `lastFrame`, `video`。
- 审读/适配章节：每张参考回答五个问题；观察边界。

### `skills/short-drama/scripts/creator_markdown_check.py`

- [固定原文](https://github.com/zenstory-ai/drama-skills/blob/fdb7b7c58017e3eae64eca382c2a85ede368dab0/skills/short-drama/scripts/creator_markdown_check.py)；Git blob `5b0049e7a9dbbdabe8f54deaa2b44c18c420c61f`。
- 加载阶段：`review`。
- 审读/适配章节：引用/计划/真实媒体解析；对白与说话者来源；视觉依据/名称覆盖；连续性锁；validate_documents完整性与partial缺输入边界。
