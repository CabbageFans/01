# 短剧工作室 · Product Design 设计探索

日期：2026-10-29（Asia/Shanghai）。当前状态：**审核与三方向视觉探索；尚未选定方向，尚未完成全量高保真或交互原型，未获最终设计批准。**

本目录为独立设计产物。没有修改产品源码、CSS、业务行为或项目数据，没有运行产品测试，没有提交或推送 Git。

## 实际依据

- 实际工作区：`/Users/dingzhenyu/Documents/01`。用户任务中的 `/Users/zarkding/Documents/doubao-studio` 不存在。当前目录具有指定两份任务文件及匹配组件。
- 完整阅读 `AGENTS.md`、`docs/PetStory_UI_Design_Spec.md`、`docs/PetStory_ProductDesign_UI_Review_Task.md`；参考 `DESIGN.md`、`USER_JOURNEY_REPAIR_REPORT.md`、`UI_REFACTOR_REPORT.md`，并检查真实组件和两套样式。
- `docs/PetStory_UI_Design_Concept.html` 与报告中的 `artifacts/` 旧验收截图目录在此工作区不存在。没有把它们当成已查看材料。当前用户没有附加新截图。
- 已直接查看 `docs/canvas-reference/` 下五张现有图；这些是用户指定材料中的历史参考，不能证明当前版本实机行为。
- 本次新采集并逐张查看的实机证据位于 `evidence/`。普通内置 Browser 访问既有 Vite 地址时为空白，因此实机视觉观察以已运行 Electron 窗口为准；未开启 CDP、未注入 API、未触发任务生成或下载。
- 当前提交与 492 个受版本控制文件的 SHA-256 基线记录于 `source-baseline.json`；结束时另生成 `source-integrity.json`。

## 设计工作流

实际采用 Product Design 0.1.56 的 index → user-context preflight → audit → get-context → ideate。无已保存的 Product Design 用户上下文。图像由内置 Image Gen 生成，并实际附加已查看的本地截图。

Product Design ideate 要求先生成三个独立视觉方向，再等待用户选择，之后才能开始原型搭建。本轮遵守该顺序：先交审核证据与可比较图，不把一张主屏方向图宣称为全页面设计完成。方向选择只授权继续独立设计，不等于批准产品开发。

## 文件

- `audit.md`：本轮截图审核、源码交叉核对、未能实机检查的部分。
- `short-drama-source-inventory.md`：六阶段真实能力、入口与去向、前置条件与不可虚构项。
- `management-source-inventory.md`：管理页面能力与入口审核。
- `design-constraints.md`：统一视觉/文案约束、全量页面计划和冻结边界草案。
- `evidence/01-tasks-live.png` 至 `06-settings-live.png`：本轮真实窗口证据。只代表各自画面状态，没有执行生成链路。
- `direction-01.png`、`direction-02.png`、`direction-03.png`：三张独立方向图；编号与聊天中实际展示顺序一致。
- `generation-prompts.json`：实际生成提示词与附件路径，已保存。
- `visual-review.md`：方向图检查结果和选定后必须修正的生成偏差。

原生截图返回 JPEG 字节，`evidence/*.png` 保留采集时原始字节和文件名，未编辑或转换。方向图为 PNG。

## 下一步与完成边界

用户选择视觉方向后，继续制作 11 个主要页面（其中六阶段各自独立）、画布全景及必要的抽屉/弹窗和异常态，交付独立交互 HTML 与完整规范、文案和入口映射。之后再等待用户明确最终批准；任何时候都不以方向选择代替正式开发授权。

所有方向图中的项目、图片、数量、提示词和状态均为设计样例，不读取后端、不代表已有生成成果。评审说明只在本文件，不混入产品界面。生成图中的细微文字若与规范冲突，以经用户最终批准的交互稿和文案清单为准；目前尚未冻结。
