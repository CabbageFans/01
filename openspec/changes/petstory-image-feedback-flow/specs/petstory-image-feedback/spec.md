## Purpose

让创作者围绕人物、道具、场景的实际图片完成生成、自然语言反馈与明确采用。系统负责中间文字、真实平台执行与候选保存，保护现有正式素材和用户自主选择，能够恢复任务且不重复发送。

## ADDED Requirements

### Requirement: Single material image action
系统 SHALL 将所选素材的“生成图片”解释为本次必要文字准备和图片生成的完整授权，复用适用手改或已采用正文，否则取得真实豆包文字、按现有服务保存并自动继续生图；授权 MUST 不扩展到其他素材或视频。

#### Scenario: Material without final prompt
- **WHEN** 用户对已确认方案中的无正文素材点击一次生成图片
- **THEN** 系统自动准备文字并继续图片任务，不要求采用中间文字，下载校验后登记为该素材候选

#### Scenario: Existing final and repeated click
- **WHEN** 素材有适用手改正文或同一操作仍在运行
- **THEN** 系统保留并优先复用正文，同一点击及重复通知不产生重复任务

### Requirement: Feedback edits the selected image
系统 MUST 保存预览当前选定的具体基图及其校验摘要、用户原话与输出关联，并将该文件作为本次图片修改输入。系统 SHALL 支持未采用候选、上传图、已采用图、旧候选和连续修改；不要求用户先采用或找到原会话。

#### Scenario: Modify an older unadopted candidate
- **WHEN** 用户选择较早的候选并提交自然语言意见
- **THEN** 系统用该候选文件修改而非正式图或最新图，保存新候选，旧图与用户原话保留

#### Scenario: Upload and repeated feedback
- **WHEN** 用户对上传图或上一轮修改结果再次反馈
- **THEN** 系统允许新的主动修改操作，不受自动结构修订次数限制；空意见和取消不产生请求

### Requirement: Image focused materials page
素材页 MUST 删除提示词生成／编辑／采用、生成记录／诊断、更多及省略号替代菜单、变体或局部编辑计划。系统 SHALL 保留分类、名称、用途、图片预览、生成、上传、简短错误和主动查看真实豆包对话；修改弹窗只包含选中图片、名称、单个反馈输入及取消／提交修改。

#### Scenario: Result preview
- **WHEN** 图片候选可读且用户仍在当前操作素材，没有其他编辑弹窗
- **THEN** 系统显示大图供“满意，采用图片”或“不满意，修改图片”；用户离开时只在对应素材显示图片待确认，不连续强制弹窗

### Requirement: Background execution and truthful stages
系统 SHALL 复用常驻账号执行宿主，默认不自动展开浏览器、切页或抢占自由聊天草稿。进度 MUST 由真实任务、阶段和可读下载文件驱动；没有百分比时显示阶段进度，不编造时间或完成。

#### Scenario: Open the actual source conversation
- **WHEN** 用户主动查看生成中或候选图片的豆包对话
- **THEN** 系统打开当前实际任务或该图片来源的会话，上传图没有来源时不伪造链接

#### Scenario: Recover without resubmission
- **WHEN** 用户重开项目或图片生成后下载失败
- **THEN** 系统恢复真实操作与候选，只补原下载或只读收取，不重复生成；提交不明继续禁止重发

### Requirement: Explicit adoption preserves scope
新生成、修改和上传图 MUST 先保存为候选，用户明确采用前正式节点及下游继续使用旧已采用图。采用 SHALL 经原正式服务只更新所选对象，保留旧文件和已有媒体，并沿用受影响对象复核，不启动额外任务。

#### Scenario: Close then adopt candidate
- **WHEN** 用户关闭候选预览后再次打开并明确采用
- **THEN** 候选仍可读取，采用只更新正确素材，重开后保留；其他节点及视频操作保持有效
