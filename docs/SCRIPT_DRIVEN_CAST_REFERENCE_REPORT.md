# 剧本驱动角色与采用图优先交付报告

日期：2026-11-01。工作区：`/Users/zarkding/Documents/doubao-studio`。统一变更：`script-driven-cast-reference-first`。

## 交付结论与验收边界

代码、离线行为检查和完整工程门禁已完成。真实界面完成同一原故事的空项目创建、分析、方案采用、三个动态角色直接上传／预览／采用、取消预览保护、全部七项现有素材采用，以及代表镜头关键帧文字的实际请求、原回复和正常采用。三个角色均没有基础生图正文或来源任务，仍正常就绪。

代表镜头视频文字的原任务在提交前暂停：首次为 `chat_assets_not_ready`（未找到图片上传入口）；两次显式继续同一任务后为 `page_unrecognized`。三次准备尝试均无 `submittedAt`，没有视频文字原回复或候选，不计为真实视频文字验收通过。检查可见普通 Chat 页面和展开文件菜单没有解决识别问题，未绕过执行器发送、换账号、伪造正文或创建替代任务。

本轮新建图片／视频生产任务 **0**。上传的角色、道具、场景与代表首帧均来自原项目实际文件；代表首帧属于已有媒体，不能称为新规则生成的画面。新形象关键帧、尾帧、成片表演与声音的视觉效果仍属媒体验收项。

## 实际问题与移除位置

| 旧路径 | 本次处理 |
| --- | --- |
| `petstoryPresets.json` 的 lulu／lumei 身份、默认帽饰及毛毡／黏土 3D 通用风格 | 新默认 `characters={}`、`style=''`、通用风格为空，仅保留单幅完整人物、道具完整轮廓和场景空间等通用要求 |
| `petstoryPromptQuality.orderedChatAssets` 和渲染 `petstoryPrompts` 空值回退 | 不再补固定角色 ID；新项目没有预设演员区，角色卡来自实际方案 |
| Runtime 的默认演员、分析映射、动画美术回退 | 分析从原故事动态提取角色，不限定角色数量，不以默认演员替换原人物；未明确风格不补动画美术 |
| 已保存 profile 中从软件继承的旧默认 | `petstoryPromptProfile` 仅按完整原样配置比对退出有效回退；原配置放在 `petstoryLegacyDefaults.json` 作兼容比较，不按名字删除用户设计，不改写磁盘历史 |
| 修订、审查和规则资源保留旧外观的指令 | 调整 `runtime.json`、`studio-adapters.json` 及 Seedream／Seedance 源规则；保留 drama 的拆镜、表演、运镜、声音和引用能力及第三方许可来源 |

运行时规则为现有维护源；仓库没有可恢复整套 runtime 的其他生成脚本。本次增加 `node scripts/sync-petstory-rule-adapters.mjs --check` 核对已有 Markdown 与 JSON 适配内容，去掉 `--check` 可同步适配产物，避免构建后回流旧规则。

## 上传采用、旧正文失效和图片就绪

采用服务在同一次项目保存中更新 `selectedAssetId`、`referenceAssetId`、图片采用记录与 `approved` 文件指纹，并记录 `material.visualBasis={assetId,sha256,adoptedAt}`。人物身份确认只绑定图片，不再把旧 description 复制为上传图身份。

`prompt.supersededByAssetId` 明确旧基础正文已由当前图片替代。原 `original`、`optimized`、`final`、原回复、原任务和来源完整保留，但素材同步、专用正文资格、批次投影、补齐、自由 Chat 应用、迟到结果、编译与导出都遵守此关系。导出将其放入 `historicalPrompt`，不导出为当前模型正文或可采用候选。不为上传图伪造 `sourceJobId`。

只是上传或预览不更新正式选图、身份或失效关系。实际 UI 的“暂不采用”后，当前图片及正文依据均未变化；重新打开同一候选后通过正常“满意，采用图片”切换。

角色图就绪检查角色归属、用户采用、文件解码与 SHA，不要求基础提示词，不比较身份文字与旧 description。基础提示词来源只在确实生成基础图时检查；用户明确重新生成时，由本次图片操作取得新的真实 Chat 候选。同步、重开和补齐不会复活旧基础正文。新图生效后，旧文字结果只能保留为历史／失效候选，旧图片下载只增加候选，不夺取当前形象。

## 有效输入、角色标签和生产正文

`petstoryRuntimeRequest` 按分析、初始人物图、关键帧、视频、审查与修订投影事实。尚无图的初始人物准备可以使用剧本明确设计；有图后不把 description、旧 identity、基础图正文或 `appearanceOverrides` 作为外观锁定事实。原故事、原回复与旧边界保留明确的来源／历史属性，动作及逐字对白不经过颜色或身体词黑名单修改。

关键帧安排构图、站位、姿态、表情、视线、动作瞬间和道具关系；人物图只负责身份形象，不复制其背景、姿势或旁人。尾帧保持以当前首帧编辑终态的职责。实际图片反馈只使用用户选中的基图与本轮原意见，不重放整份镜头的旧换装字段和旧提示词。

视频请求明确使用实际帧图／身份图驱动表演，保留触发原因、动作先后、神态视线、互动、持物／接触／传递、逐字台词、语气节奏、必要声音和机位运镜。首帧、首尾帧和多参考模式分别生成实际目标清单，Chat 看图序号与媒体引用编号分开，帧图不冒充单人身份图。

角色稳定 ID、原称谓和别名保留。中性 `productionLabel` 随角色 ID 保存，重排不交换，新增角色与称谓碰撞时分配不冲突的标签。动作主体、参考图 `characterMapping`、对白合同和 speakerId 共用映射；合法历史称谓继续兼容，台词正文逐字保留。

单项图片／视频的正常按钮可先准备当前规则下的文字候选。关键帧缺正文或旧正文需按新图适配时，不再因媒体预检缺正文而无法点击；候选仍由用户正常确认，不自动创建媒体。批量、反馈、自动修订和恢复沿原服务；所有创作性改写仍由豆包普通 Chat 完成，程序只做事实投影、来源校验和确定的引用绑定。

## 局部依赖与旧项目保护

换图首先标记使用该角色的镜头，再沿真正的 `continue` 依赖扩展。旧帧／视频保留文件和采用历史，以 `visualBasisStale` 区别于旧的泛复核标记，不能自动冒充新形象。无该角色的切镜不因前镜视觉复核元数据变化而要求重写；前镜真实终态、持物正文、来源发生变化仍会阻断。

新合同保存 `visualPolicy='reference-first-v1'` 和角色图片指纹。旧规则正文按正常操作交 Chat 适配为候选；新规则纯表演正文在其他有效设计和素材职责不变时，可确定映射同角色的新图片，不改原 source、raw 或 hash 假称已重新创作。实际替换帧仍走生成、上传或反馈后明确采用，旧帧不会自动更新。

文字设计摘要、素材摘要和生产摘要对有采用图的角色使用当前图的 ID／SHA 和剧情职责，不继续依赖旧外观文字、旧确认描述或旧默认美术。真实换图、文件变化、角色职责、镜头、台词及正文变化仍检查。旧运行仅按原算法精确匹配兼容，不重写历史摘要。

正式项目 `测试项目` revision **734** 的 project.json 与本轮开始时逐字节一致；原角色、五官／衣饰历史、六镜方案、媒体和任务记录未清空。验收副本的五镜方案来自本次豆包实际分析，不固定套用原六镜或历史五镜。没有修改运行中 tasks.json，所有新任务由正常界面进入正式服务。

## 测试及真实证据

最终 `pnpm run validate` 成功：**170 个文件／3338 项测试通过**，类型、契约、工程规则和双端构建通过，ESLint **0 error／149 既有 warning**，上限未提高。日志：`/private/tmp/cast-reference-final-validate.log`。`openspec validate script-driven-cast-reference-first --strict`、规则资源一致性及 `git diff --check` 通过。

| 验收项 | 本次证据与边界 |
| --- | --- |
| A 剧本拆角色 | 真实 UI 空项目→同一原故事→3 角色／5 镜／7 素材；原回复无软件演员或美术注入。明确提供噜噜／噜妹的兼容由请求及校验回归覆盖 |
| B 无提示词直接上传 | 真实 UI 三角色均采用；基础角色文字任务 0，角色 final 与 sourceJobId 均为空，图片就绪 |
| C 旧提示词再采用图 | 原故事派生服务回归覆盖旧外观保留历史、有效正文失效、无虚构身份与来源；未冒充额外真实 UI 案例 |
| D 取消上传 | 真实预览“暂不采用”后无选图／视觉依据／正文失效副作用，任务数不变 |
| E 重开／补齐 | 保存重开、同步、批次跳过图片已就绪角色及迟到保护回归；最终普通重开另有字节核对 |
| F 外观称谓 | 来源保留；新关键帧实际使用角色1／角色2与身份图映射。说话者、标签重排／碰撞和逐字对白回归 |
| G 三视频模式 | 离线请求、引用及校验回归覆盖首帧／首尾／多参考。代表多参考视频文字真实原任务未提交，尚无 raw；不能称真实视频正文通过 |
| H 关键帧／反馈 | 真实关键帧 raw 本身按图安排画面；选中上传／未采用／历史图反馈与去旧 overrides 有回归。未新增真实改图媒体 |
| I 迟到／局部依赖 | 回归覆盖旧文字／图片不抢当前图、旧帧保留、连续依赖、无关切镜、真实边界变化仍阻断及有效生产摘要 |
| J 旧项目 | 正式项目 SHA 未变；历史 ID／图片绑定／媒体／对白、旧精确 hash 与默认风格兼容回归。打开不自动发送 |

私有证据在被忽略的 `artifacts/script-driven-cast-reference/`，不将真实请求、原回复、账号关联或素材提交到 Git。主要文件：

- `actual-request-chain-evidence.json`：实际 Job、Task、runtime、完整原请求／回复及附件顺序、字节和摘要；`final-functional-proof.json`：原项目保护、角色无基础文字及真实任务结果。
- `real-analysis-review.md`：真实原回复→解析方案。两句实际对白与 speakerId 一致；语气比喻没有变成额外对白。保留“未展示的预知被写成理解事实”和道具“干燥”修饰来源不足两项内容质量缺口，不将采用等同于全部内容完美。
- `real-keyframe-review.md`：代表镜头实际请求→5 个实际附件→原回复→331 字候选→正式正文；5 个目标引用正确，无人物造型重新定义。没有导出后删段落制造合格。
- `upload-before-adopt-proof.json`、`upload-cancel-proof.json`、`direct-upload-adopt-proof.json`：真实上传、暂不采用和采用关系。

UI 截图（本机证据）：[空项目](../artifacts/script-driven-cast-reference/ui-empty-project.png)、[真实分析候选](../artifacts/script-driven-cast-reference/ui-analysis-candidate.png)、[动态角色卡](../artifacts/script-driven-cast-reference/ui-script-role-cards.png)、[上传预览](../artifacts/script-driven-cast-reference/ui-upload-preview.png)、[第三角色预览](../artifacts/script-driven-cast-reference/ui-third-role-preview.png)、[七项素材采用](../artifacts/script-driven-cast-reference/ui-all-materials-adopted.png)、[已有首帧上传](../artifacts/script-driven-cast-reference/ui-existing-frame-preview.png)、[视频文字阻断](../artifacts/script-driven-cast-reference/ui-video-text-blocked.png)。这些截图不是新媒体生成证明。

## 启动与交付状态

普通启动命令：

```bash
cd /Users/zarkding/Documents/doubao-studio
pnpm run dev:mac
```

验收期间临时使用 `--local-control` 作只读健康核对，其接口未覆盖项目创建／采用，实际修改均从可见 UI 进入；未开启 CDP，未通过外部 store／service／IPC 或手改项目 JSON 代替流程。交付前退出该验收实例，以以上普通命令启动，并重开副本供用户检查。启动／重开不自动继续暂停的视频文字任务，不承诺会话结束后持续维护实例。

最终普通实例已实际启动，正常 UI 重开副本后停在基础素材页：**已采用7/7、待确认0、缺少0**。`ordinary-reopen-proof.json` 确认验收项目、正式项目和 tasks 文件在普通启动／重开前后 SHA 均相同；副本仍 revision34、3个原Chat任务、0角色文字任务、无production。临时控制发现文件和令牌均已删除，普通实例未启用控制或CDP。截图：[普通重开后素材状态](../artifacts/script-driven-cast-reference/ui-ordinary-reopen-materials.png)。

有效需求更新至 v2.1，AGENTS 和 OpenSpec context 已同步。OpenSpec 的真实全链验收任务保留未完成，等待现有页面识别／上传条件恢复后继续原视频文字任务；不以离线通过或关键帧文字通过勾完。未自动 Git 提交、推送、Tag、Release，不进入 P5。Dola 真实端到端可用性仍未验证。
