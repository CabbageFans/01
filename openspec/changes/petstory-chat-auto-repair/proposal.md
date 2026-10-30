## Why

正常创作取得可修复的豆包回复后，部分收取、候选采用和自由 Chat 应用入口只显示错误，修订与原流程的交接也不一致。本专项按 `docs/Doubao_Chat_Auto_Repair_Codex.md` 接通已有普通 Chat 修订链，保留原回复和用户确认。

## What Changes

- 对明确内容错误收集字段、实际值与类型、约束，继承原任务职责构造完整修订请求。
- 正常创作与明确应用选定回复最多自动修订一次，以持久化任务关联去重并恢复原候选或批次。
- 最小接线当前状态与人工调整入口；打开项目、预览、停止等待不授权新发送。
- 围绕原故事五镜头完成离线回归，真实文字和可见 UI 验证分别记录边界。

## Capabilities

### New Capabilities

- `petstory-chat-auto-repair`: 普通 Chat 内容修订、轮次去重、自由回复应用及原流程恢复。

### Modified Capabilities

无。

## Impact

现有 PetStory 校验、运行请求、Chat/调整服务、IPC 契约、Zustand store 和当前方案/恢复/调整卡；复用 TaskService、project.json 和网页执行链。不引入第二套任务系统、媒体生成、付费接口或 P5。
