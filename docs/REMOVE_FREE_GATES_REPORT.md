# 移除免费校验与人工入口检查报告

2026-10-30。已在本机现有工作树 `/Users/dingzhenyu/Documents/01` 实施；任务书中的旧工作区路径本机不存在。原未提交修改保留，未提交、推送、发布或开发 P5。

## 实际删除

- 删除 `PetStoryMediaEntryCheck.tsx`、全部引用和事件，包括 App 的展开监听、BrowserPanel 的独立检查处理；清除素材页、方案、画布、提示词卡、恢复区的确认框、检查按钮、时间、免责声明和空容器。
- Store 删除 `freeChatConfirmed`、`capabilityCheckedInSession`、检查动作、引用同意状态及全部依赖。分析、重新分析、人物／道具／场景及镜头提示词、手动／自动修订、选定 Chat 回复整理、批次接力和继续制作直接进入原任务链。
- 后端资格、创建、执行、恢复和模式解析不再要求免费证明、人工检查或快照有效期。contracts 删除 `PetStoryFreeState`、入口 `free`、`freeEvidence`、`allowPlainReferences`；媒体 IPC／preload 的 capability 参数改为可选。没有把旧字段设成 true 或伪造 free。
- 账号指派、排队和视频预检删除本地额度预算、历史耗尽标志及会员未知预测阻断；删除额度拒绝后的自动换号重试。平台实际拒绝仍记录为本次失败。

## 页面数据与创作保护

`BrowserPanel.executeAutomation` 在任务开始后进入图片／视频页面，复用 `configureVideoOptions` 设置并回读模型、时长、比例；上传前调用 `readPetStoryComposer` 与 `checkPetStoryPageGuard` 核对真实输入区和槽位。文件读取、SHA、上传预览、原生引用节点及最终全文仍逐项核验，随后持久化提交意图、单次发送、读取平台结果。不在打开项目或只读渲染时探测生成入口。

请求参数保留所选模型和已保存规格；缺省为原有 Seedance 2.0 Fast／9:16，实际时长取当前镜头。auto 沿用已有制作／已采用正文的具体模式；新计划缺少具体模式时使用普通参考输入意图，不宣称页面支持原生槽位。旧批次恢复保留已选模式，执行时核对实际页面。普通中文素材用途映射自动复用已有适配；原生 @ 仍须真实节点，普通双图不冒充首尾帧。

方案确认、具体回复选择、图片先预览后采用、手改保护、素材归属、提交不明不重发及下载失败只重下均保留。

## 旧项目兼容

旧对象及历史任务快照允许含遗留字段，读取时不据此阻断，也不批量重写项目、原回复或历史事实。新请求只投影正常参数，不继承免费声明与旧检查时间。创作上下文哈希排除废弃检查数据，并能用原任务快照核对旧哈希；真实模型、画幅、故事与素材变化仍校验，未把全部历史提示词／素材标成过期。

## 验证与界面证据

最终 `pnpm run validate` **exit 0：124 文件／2313 测试通过**；contracts/main/renderer/test 类型、工程／契约边界和双端构建通过。ESLint 0 error／148 warning，原上限 149 未改。专项 OpenSpec strict 与 `git diff --check` 通过。日志位于本地 ignored `artifacts/remove-free-gates/validate-integration.log`。

离线行为回归覆盖原故事／原五镜头夹具；旧免费 false／unknown／缺失的新建与重开文字任务、自动修订、基础图／关键帧／视频任务创建、单项／批次、暂停继续、旧 auto 模式恢复、上传／预览／采用、原产物下载／导出、真实参数及文件绑定、手改与候选保护均通过。测试准备不设置免费确认。页面替身测试不代表豆包实机生成。

真实普通 Electron 从可见“按路径打开”进入本机现存六镜头项目，点击方案、素材、关键帧与视频阶段，展开完整方案、素材更多操作和视频制作设置并截图。旧 p604 五镜头项目文件本机缺失，不能宣称其真实 GUI 全链已验证。本轮未新增普通 Chat、图片或视频请求，媒体真实生成未实测；可见按钮因缺正文／未采用素材而禁用的原因保留。现存项目文件和 tasks.json 在界面检查前后 SHA-256 完全一致。

截图：[素材页](assets/remove-free-gates/materials.png)、[素材展开区](assets/remove-free-gates/material-actions.png)、[方案页](assets/remove-free-gates/plan.png)、[画布](assets/remove-free-gates/canvas.png)、[展开的视频设置](assets/remove-free-gates/video-settings.png)。截图取自真实可见窗口，未改页面或伪造结果。

全仓复核：活跃 `src`、`main`、contracts 与 schemas 对任务书旧标识符／事件为 **0 匹配**。其余匹配为负向遗留兼容测试、明确取消旧要求的规范说明、任务书和历史报告；平台错误识别保留实际额度／会员拒绝文本，第三方资料与许可证保持原样。有效需求、AGENTS、CONTRIBUTING、执行计划、自有规则与相关在途 OpenSpec 已同步；冻结设计另附本次授权修正，不改历史批准摘要。

## 普通应用启动

```bash
cd /Users/dingzhenyu/Documents/01
pnpm run dev:mac
```

交付保留普通实例，不含 `--local-control`／`--local-cdp`；9333、9334、17891 无监听。
