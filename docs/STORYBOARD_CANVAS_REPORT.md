# 分镜生产画布交付报告

验收日期：2026-10-25。独立 OpenSpec 变更：`petstory-storyboard-canvas`，保留当前工作树及其他变更，未提交、推送或归档。

## 实际完成

现有萌宠短剧页默认进入画布：左侧原剧本与当前故事卡，右侧每镜一行，横排「分镜及首／尾帧提示词 → 首／尾帧图片 → 视频提示词／运镜 → 镜头视频」。采用浅色网格、白卡、青绿色操作；支持空白拖动、缩放、适应、逐镜聚焦及视角恢复。正文可在卡片滚动查看，或放大全文编辑、复制、保存；人物、道具、场景档案与素材的展示、编辑、生成和确认仍在同页展开。

已阅读 ai_story 指定七个 Vue 组件，借鉴节点分工及画布交互，在 React 独立实现。画布接入原 `usePetStoryStore`、普通 Chat 回读、TaskService、素材与生产服务；没有引入参考项目后台、模型 API、媒体或品牌。新增历史任务产物核验与关联入口，核对账号、项目、任务运行、提示词、附件和本地文件后才绑定。

主要文件：`src/components/PetStoryCanvas*.tsx`、`usePetStoryCanvasViewport.ts`、`src/styles/storyboard-canvas.css`；接线位于 `src/store/usePetStoryStore.ts`、`main/ipc/petstory.ts`、`main/utils/petstoryChat.ts`、`petstoryProduction.ts` 和 `petstoryExistingMedia.ts`。

重新生成提示词、生成图片、生成视频、重新下载为独立操作。草稿未保存时阻止使用旧正文发起生成；新任务使用保存的 final。历史媒体保留当时使用的正文，可与当前 final 对照，差异明确显示。切页、展开和缩放不发起生成。

## 原五镜头真实 Chat 验收

使用原“测试”项目的故事、三名角色和五镜结构，未替换故事或手工注入结果。通过页面调用的普通 Chat 业务链取得并保存 **13/13** 项新回复：5 首帧、镜头 2／3／4 的 3 尾帧、5 视频。新增 13 个 Chat 任务、0 个媒体任务；全部核对输入哈希、taskId、runId、回读时间和镜头绑定。原两项手改 final 保留，新回复作为可采用候选；其余 11 项自动回填 final。项目重开后恢复成功。

两次 macOS 原生焦点检查失败后，链路保守暂停；在可见页面对当前待发送内容各进行一次有人值守点击，随后沿同一 task/run 回读保存，没有新建替代请求或自动重发。因此本次不宣称完全无人值守成功。

文字测试前项目版本 v100，Chat 完成 v152，历史图片关联 v160；另经页面进行一次编辑保存及原文恢复，最终 **v162**。原剧本、角色引用和镜头结构保持一致。证据：[`chat-verification.json`](../artifacts/storyboard-canvas/chat-verification.json)。

普通模式重开后逐项比对 13 个 final 与候选，均与 Chat 完成快照一致；最终摘要见 [`restored-project-verification.json`](../artifacts/storyboard-canvas/restored-project-verification.json)。

## 媒体实测与限制

已核验并关联 **8 张已有真实豆包图片**（5 首帧、3 尾帧，均 1152×2048），通过原任务与下载产物证明来源，并校验本地解码及 SHA-256。它们使用历史正文，均不等同本轮新 final，页面如实标为历史产物；包含原结果自身的角色偏差，未人工修改。证据：[`media-verification.json`](../artifacts/storyboard-canvas/media-verification.json)。

原项目没有对应镜头视频，全部显示未生成。本轮没有新抽图片或视频，没有重新下载已有完整文件；仅实测已有下载文件读取、核验和节点关联。新媒体生成、视频播放及平台首尾帧／多参考入口的真实提交未在本轮执行。旧项目尚缺道具、场景与镜头关系清单，新的关键帧生产仍须在同页补齐并经用户确认素材；不能将已有三张用户参考图视为全部素材已确认。

## 验证与截图

`pnpm run validate` 通过：类型、Lint、工程规则、75 个测试文件／1392 项测试及双进程构建全部成功。Lint 为 0 错误、149 条现有警告；构建仍有大包提示。OpenSpec strict 与 `git diff --check` 通过。

实际 Electron 检查了 13 个编辑器、长文、候选、草稿刷新保留、保存重开、平移缩放、同页素材和切页恢复。切页／缩放前后账号 Webview ID 保持 2，任务总数保持 47，未因界面操作新增任务。记录见 [`ui-verification.json`](../artifacts/storyboard-canvas/ui-verification.json) 与 [`validate-final.log`](../artifacts/storyboard-canvas/validate-final.log)。

- [五镜头总览](canvas-reference/storyboard-canvas-overview.jpg)：实际 Electron 扩展视口 2100×7800，画布 100%，完整五行。
- [正常窗口镜头 2](canvas-reference/storyboard-canvas-shot-2.png)：四列对应及真实图片。
- [完整正文编辑](canvas-reference/storyboard-canvas-prompt-full.png)：本轮镜头 3 视频回复。
- [同页基础素材](canvas-reference/storyboard-canvas-materials.png)：原用户参考图与确认边界。

## 启动与范围

已关闭本轮短时诊断接口，以普通开发模式启动并打开原项目画布。再次启动：

```bash
cd /Users/zarkding/Documents/doubao-studio
pnpm run dev:mac
```

进入「创作工作台 → 萌宠短剧 → 打开项目目录」，选择原“测试”目录，即进入分镜生产画布。未改变提示词优化算法或继续优化专项；未开发整片合成、配音、字幕、发布或新工作流平台。本轮到此停止。
