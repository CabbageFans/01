# 视频下载、入库和本地播放（2026-11-10）

本文件描述当前媒体边界。生成、派发和观察由正式任务运行负责；本地媒体资产在入库后独立于队列任务和签名 URL。

## 调用与所有权

| 边界 | 正式调用路径 | 持久事实 |
| --- | --- | --- |
| 下载 | `tasks:downloadOutputs`、制作收取、`downloadArtifactForLocalControl` → `DownloadService` | `downloads.json` 中按 jobId 更新的原 task/run/artifact/inputVersion |
| 下载写盘 | `DownloadRepository.put/patch` → 原子 JSON 写入 | 同步短读改写；网络和流写不持有整表快照 |
| 文件校验 | `petstoryMedia.validatePetStoryMedia` → ffprobe + 完整 ffmpeg 解码 | 文件 SHA-256、大小、实际尺寸、实际时长、检查时间 |
| 资产入库 | `PetStoryProductionService.importMediaArtifact` / 显式历史关联 | 项目相对路径、源运行和产物、不可变来源快照、原输入版本和引用摘要 |
| 本地读取 | `petstory:readMedia` → `assetFile` → `LocalMediaStreams.issue` | 来源及文件摘要核对后，发放进程内临时读取能力 |
| 桌面本地读取 | 产物中心 / 批次预览 / 下载列表 → `tasks:readDownloadedMedia(jobId)` → 同一 `LocalMediaStreams` | 台账原目录、普通文件、大小和 SHA-256；不依赖 Task 仍存在 |
| 原生播放 | `doubao-media:` 协议 → 打开的项目资产 | GET / HEAD / 单段 Range；不接受任意文件路径 |

已替换 `main/ipc/tasks.ts` 中桌面和本机控制的两套 `arrayBuffer` 下载。公开分享页导入仍有独立入口：它不使用账号 Cookie，也不属于任务产物下载，不能伪造 task/run 来源。

已替换视频预览的整文件 base64 IPC 和 50 MiB 预览限制。图片预览仍沿用原接口。`readMedia` 保持原返回形状，`data` 现在承载受控媒体 URL；旧 data URI 只作为历史兼容。

桌面三个视频预览入口共用 `DownloadedVideoPreview`，按原 run/artifact 找到下载记录，读取失败可“重新读取”；尚未下载则提供下载动作。播放器不再把远端签名地址直接作为 src。下载记录保存项目归属，旧任务已清理的历史记录仍可在下载列表查看，明确属于其他项目的记录保持隔离。图片产物和采用入口保留原调用。

## 取消与恢复

下载定时器覆盖 fetch、响应体、临时文件流写、收尾；finally 在流和句柄结束后清理。每个 job 的每次 attempt 独占随机临时文件，失败只移除该文件。暂停撤销原 run 的本地流，不声称取消平台生成。

下载对外异常使用 `DownloadFailure`，保留 `failureType`、与台账一致的友好原因和原始 `cause`，不把所有网络或文件故障压成无分类的普通 Error。HTTP 响应头到达后 body 停滞仍受同一计时器约束，超时对调用方返回“下载超时”，不能伪报成功或要求重新生成。

初始台账保存失败时零网络请求。最终文件路径先保存意图，成功流写、同步和 rename 后才登记 done；完成记录保存失败不会返回成功。再次请求同一 run/artifact 复用 job，签名 URL 变化不改变身份。若 rename 已完成而 done 保存失败，恢复时找回原最终文件，不重复生成和下载。进程重启将遗留 downloading 标为可重试失败，保留最终文件。

制作步骤记录 `failure.stage`（download / validation / library）和真实原因，供界面选择“重试下载”“重新校验”“重试入库”。工具错误另保留 `mediaFailure` 的关联身份、错误码、退出码和有界 stderr。以上动作均继续原产物，不增加平台提交。

## 工具与数据兼容

媒体工具统一从明确环境路径、安装资源目录、macOS 常见安装目录和 PATH 解析。可设置 `DOUBAO_FFMPEG_PATH`、`DOUBAO_FFPROBE_PATH` 指向已有工具。工具缺失、超时、权限故障和其他工具错误保留为可重校验失败；只有确证媒体内容损坏才登记拒绝。

读入迁移为历史已校验视频补最小 `sourceSnapshot`，来源只使用原项目和资产事实，不补造平台受理。存在旧版固定 ffmpeg/ffprobe 工具错误文案的 rejectedArtifactIds 会转入 `mediaRejectionHistory` 并释放原文件重校验；其他历史拒绝保留。迁移可重复读取，不删除文件，随下一次正式项目保存落盘。

清理队列 Task、原 Task 后续 run 改变、远端地址过期均不阻断已入库视频播放或真实末帧提取。文件摘要变化、来源身份不符仍会拒绝使用。

## 可复验离线证据

执行 `pnpm run verify:video-local`（需本机 Electron、ffmpeg 和 ffprobe）。脚本创建隔离目录和真实五秒 MP4，经本地 HTTP、正式 DownloadService/Repository、TaskService/TaskRepository、项目保存、完整解码，再清理原 Task 并关闭 HTTP 服务，最后由真实 Electron Chromium 播放到 timeupdate 并 seek；不使用 play mock 或 data URI。

最新成功记录为 [2026-11-10T03-32-29-247Z/evidence.json](../artifacts/mac/video-workflow-local/2026-11-10T03-32-29-247Z/evidence.json)。视频 87,128 bytes，SHA-256 `79d7df54f573a63ecd06e47ef3fdfba4666f7da6652977ee90d20136c427cb8f`，与先前记录一致；时长 5 秒，实际播放位置 4.021602 秒，readyState=4，seekCompleted=true；原 Task 数为 0；Chromium 通过 Range 请求收到 206。同目录保留项目、下载台账、实际文件和截图；权威 `TaskRuntime.localMedia` 的 downloading→downloaded→validating→library→ready 记录也保存在同一证据中，阶段写入均经正式 Core。

该证据的 `platformVerified=false`：它证明实际本地媒体闭环，不证明真实豆包提交、受理和生成。真实账号链路验收必须另行记录同一次原运行。

媒体可信派发的独立 [Electron webview 最终证据](../artifacts/mac/native-submission/verified-native-8-final/evidence.json) 为 8/8 通过：真实可信 pointer/mouse/click 单次激活、仅预留 ACK 丢失零输入且明确未派发、激活 ACK 丢失不补点、取消后的安全松键、迟到事件与新旧运行隔离均有记录。窗口在测试前后均未聚焦；该测试不访问豆包、不证明平台生成成功。

真实平台仍未成功。视频任务 `aeffa5d8-8927-4941-9790-a54cc28b3cd5` 的原助手只返回可复制的视频提示词，没有视频卡或成片；重启后的只读检查已按原运行暂停，错误码为 `video_generation_not_started`。原输入、受理与请求记录保留。2026-11-10 用户明确选择“先不重发，只保留原结果”，本次不安排平台重试；重启、恢复检查或离线证据通过均不触发重发。完整场景和现场边界见 [视频工作流验收](VIDEO_WORKFLOW_ACCEPTANCE.md)。
