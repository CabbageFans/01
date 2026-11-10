# 视频工作流验收证据（2026-11-10）

本记录把本次要求的 19 个场景映射到实际行为测试和本机证据。**真实豆包三种视频模式的“画布点击 → 受理 → 成片 → 下载 → 入库 → 本地播放”尚未完成实机验收。** 离线三模式页面组合与真实本地 MP4 播放分别成立，不能拼接成同一次真实平台运行。

本文件只记录现有证据，不修改产品状态，不授权或触发任何平台重发。实现和兼容边界分别见 [总体重构记录](architecture/VIDEO_WORKFLOW_REFACTOR.md)、[输入与事务迁移](VIDEO_WORKFLOW_MIGRATION.md)、[下载与本地媒体](VIDEO_MEDIA_PIPELINE.md)。

## 证据层级与运行结果

- **领域行为**：调用实际 `TaskService` / `TaskRepository`、版本合并和动作选择模块，注入保存失败及乱序回执，核对返回结果、持久数据和副作用次数。
- **离线组合**：调用实际 `DoubaoVideoAdapter`、共享 composer 探针、提交协调器、原消息观察器，使用受控 DOM；下载组合另使用受控 HTTP、真实文件和媒体工具。外部页面、登录和部分 Electron 边界由夹具替代。
- **本机原生播放**：真实 Electron Chromium 播放真实 MP4，经正式本地协议 Range 读取，观察 `timeupdate` 和 seek；没有用 `play()` mock 或伪 data URI 代替解码。
- **真实平台**：现有原账号的实际原对话记录，独立记录是否确实产生媒体。当前记录为未完成。

最终完整 `pnpm run validate` 已通过：**252 个测试文件、4,807 项测试全部通过**，类型、Lint、工程规则、契约和构建均通过。Lint 为 143 个警告、0 错误，沿用原有 149 容限。最终日志保存于 `artifacts/mac/video-workflow-final-20261110/validate-complete.log`。旧夹具已按正式运行身份及原生输入边界迁移；没有通过提高超时、扩大 Lint 容限、放宽类型或批量跳过获得通过。

源码字符串和 AST 结构断言只作辅助工程约束，下表不把它们作为主要成功证据。DOM 中 `<video src>` 的断言只证明入口接线；实际可解码、能播放由原生证据单独证明。

## 19 个验收场景对应

“离线覆盖”表示下述具体行为有测试证据，不能推导真实平台已通过同一场景。

| # | 验收场景 | 主要行为证据 | 已证明的结果与边界 |
| --- | --- | --- | --- |
| 1 | 三种模式从画布到本地播放，身份一致 | [videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts)、[videoWorkflowActions.dom.test.tsx](../tests/unit/videoWorkflowActions.dom.test.tsx)、下文原生 MP4 记录 | 离线三模式执行实际配置、共享 composer 回读、真实槽位上传、单次提交及原消息/vid 观察；制作服务固定输入与素材摘要。本地下载到播放另有真实闭环。**三模式真实平台整体待验，三段证据不属于一次平台运行。** |
| 2 | 点击前控件消失或租约撤回，明确未派发 | [videoSubmissionBoundary.dom.test.ts](../tests/unit/videoSubmissionBoundary.dom.test.ts)、[videoExecutionContext.dom.test.ts](../tests/unit/videoExecutionContext.dom.test.ts)、[videoTaskAuthority.test.ts](../tests/unit/videoTaskAuthority.test.ts) | 撤回权限后返回 `not_dispatched`、零最终点击；旧 guest 异步动作不得借用新 run 权限；确定未派发可保留原任务重新准备。未实测真实平台控件在点击前卸载的现场。 |
| 3 | 只有紫色附件按钮，不得误点或假报派发 | [videoSubmissionBoundary.dom.test.ts](../tests/unit/videoSubmissionBoundary.dom.test.ts)、[videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts) | 实际正式探针拒绝紫色附件按钮及“视频生成/图像生成/重新生成图片”等非最终发送入口；返回明确未派发，附件和生成点击均为零。 |
| 4 | 素材授权与人机验证沿同一尝试继续 | [videoAuthorizationCoordinator.dom.test.ts](../tests/unit/videoAuthorizationCoordinator.dom.test.ts)、[videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts)、[petstoryVideoNodeRecovery.dom.test.tsx](../tests/unit/petstoryVideoNodeRecovery.dom.test.tsx) | 实际长协调器在权威 `waiting_verification` 时接受素材授权回读，保存同一 run/submittedAt；节点验证恢复只检查原请求，错误身份不放行。人机验证未在真实平台人工完成一轮视频验收。 |
| 5 | 激活 ACK 丢失、平台已受理时不补点 | [videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts)、[videoTaskAuthority.test.ts](../tests/unit/videoTaskAuthority.test.ts) | 正式派发后丢 ACK，原消息和卡片仍由 observer 取得；最终发送激活保持一次。无平台幂等键，不宣称远端 exactly-once。 |
| 6 | 暂时 IPC 失败进入可恢复状态 | [petstoryProductionRace.test.ts](../tests/unit/petstoryProductionRace.test.ts)、[videoTaskStoreAuthority.test.ts](../tests/unit/videoTaskStoreAuthority.test.ts)、[localMediaTaskAuthority.test.ts](../tests/unit/localMediaTaskAuthority.test.ts) | 推进 IPC 失败落盘暂停，可明确继续；暂停保存失败先停止本地执行，但不伪造已保存状态；关键本地阶段保存失败不能发布成功。 |
| 7 | 旧列表、旧 run、旧下载、旧项目回执不得覆盖新版本 | [videoTaskStoreAuthority.test.ts](../tests/unit/videoTaskStoreAuthority.test.ts)、[videoTaskAuthority.test.ts](../tests/unit/videoTaskAuthority.test.ts)、[downloadIdentity.test.ts](../tests/unit/downloadIdentity.test.ts)、[petstoryProductionRace.test.ts](../tests/unit/petstoryProductionRace.test.ts) | 实际服务与 Store 覆盖列表/命令乱序、旧 run 完成、终态保护、下载归属和切项目迟到回执；原运行迟到产物只进入原历史。 |
| 8 | 跨文件半写入失败并重启，唯一关联且不重复提交 | [petstoryTaskTransaction.test.ts](../tests/unit/petstoryTaskTransaction.test.ts)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts)、[downloadServiceIntegration.test.ts](../tests/unit/downloadServiceIntegration.test.ts) | 真实项目文件与 TaskRepository 覆盖意图保存、任务创建、账号绑定、项目回填四个关键写点；制作组合另覆盖页面绑定/任务正文半写入、库文件已复制而项目未存、最终下载台账保存失败。重开复用原身份且不派发。此为所列故障点的证据，**不是每个任意文件系统指令均已穷举故障注入**。 |
| 9 | 两个下载交错完成且保存失败不得伪报成功 | [videoDownloadWorkflow.test.ts](../tests/unit/videoDownloadWorkflow.test.ts)、[downloadServiceIntegration.test.ts](../tests/unit/downloadServiceIntegration.test.ts) | 真实下载 IPC 两条记录交错完成均保留；初始台账失败零网络；最终台账失败返回失败，重建服务复用原已保存文件，无第二次下载。 |
| 10 | 收到头后 body 停滞仍超时/可取消，暂停不等长操作 | [downloadServiceIntegration.test.ts](../tests/unit/downloadServiceIntegration.test.ts)、[videoDownloadWorkflow.test.ts](../tests/unit/videoDownloadWorkflow.test.ts)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts) | 真实 HTTP 发送响应头后挂起 body，完整预算终止流并清理本次 part；取消原 run 立即结束本地等待；结束制作不排在网络之后，迟到下载不覆盖新制作。媒体命令超时另由工具测试覆盖。 |
| 11 | FFmpeg/ffprobe 缺失或超时只重校验原视频 | [mediaToolFailure.test.ts](../tests/unit/mediaToolFailure.test.ts)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts) | 保留工具缺失/超时、cause 等分类；缺 ffprobe 时不拒绝产物，恢复工具后复用原下载、不新增任务并完成入库；历史工具误拒可重复迁移。跨系统安装边界见下节。 |
| 12 | 清理 Task、远端失效后仍本地播放/续用 | [localVideoAsset.test.ts](../tests/unit/localVideoAsset.test.ts)、[downloadedMediaReadback.test.ts](../tests/unit/downloadedMediaReadback.test.ts)、[localMediaProtocol.test.ts](../tests/unit/localMediaProtocol.test.ts)、原生 MP4 记录 | 实际已校验本地资产在 Task 缺失时仍通过来源与文件校验；下载台账独立授予读取能力；原生记录在删除 Task、关闭 HTTP 后成功 Range 播放。制作测试覆盖真实末帧提取与拒绝替代计划尾帧。**尚无真实平台成片在清 Task 后导出及接力的同次实机记录。** |
| 13 | 已有视频可生成新版本，旧成果保留；未提交输入可重新准备 | [videoWorkflowActions.dom.test.tsx](../tests/unit/videoWorkflowActions.dom.test.tsx)、[petstoryUnsubmittedVideoRecovery.dom.test.tsx](../tests/unit/petstoryUnsubmittedVideoRecovery.dom.test.tsx)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts) | 已有资产按钮仍提供新版本，点击不移除旧文件与选择；未派发恢复核对原 task/run，明确输入修订保存新版本，旧运行与绑定历史保留。 |
| 14 | 结束失败制作后可做独立镜头，旧结果不覆盖新成果 | [videoWorkflowActions.dom.test.tsx](../tests/unit/videoWorkflowActions.dom.test.tsx)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts)、[videoTaskAuthority.test.ts](../tests/unit/videoTaskAuthority.test.ts) | 正式结束保存历史并释放槽位；保存失败仍保留原槽位供重试；旧网络完成只回填原历史；结束后的旧运行完成不能重启或改成新结果。 |
| 15 | 浏览器可见性、切项目、重挂载不篡改运行 | [materialImageReadiness.test.ts](../tests/unit/materialImageReadiness.test.ts)、[petstoryProjectSwitchStore.test.ts](../tests/unit/petstoryProjectSwitchStore.test.ts)、[taskExecutionHostRemount.test.ts](../tests/unit/taskExecutionHostRemount.test.ts)、[chatRemountSafety.test.ts](../tests/unit/chatRemountSafety.test.ts) | 实际执行入口在打开 Chat 时仍持有独立视频/图片页；切项目保留本镜执行权并停止后续镜头安排；模块重载保持原 observer Promise/控制器；已有控制器不被重挂载接管。 |
| 16 | 下载、预览、工具故障分别重试原阶段 | [videoWorkflowActions.dom.test.tsx](../tests/unit/videoWorkflowActions.dom.test.tsx)、[downloadedVideoEntrypoints.dom.test.tsx](../tests/unit/downloadedVideoEntrypoints.dom.test.tsx)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts) | 动作选择实际渲染“重试下载/重新校验/重试入库”；预览读取失败只重读原资产/jobId；工具恢复不重新下载或生成。DOM 播放器本身不代替原生解码证据。 |
| 17 | 重启区分未派发/未知/已受理/已下载未入库 | [videoTaskAuthority.test.ts](../tests/unit/videoTaskAuthority.test.ts)、[localMediaTaskAuthority.test.ts](../tests/unit/localMediaTaskAuthority.test.ts)、[downloadServiceIntegration.test.ts](../tests/unit/downloadServiceIntegration.test.ts)、[petstoryProduction.test.ts](../tests/unit/petstoryProduction.test.ts) | 未派发允许原准备；未知派发保留观察责任、不得退回意图；本地未完成阶段重启变为原阶段暂停；已落文件/库 checkpoint 可继续完成，不凭打开项目或启动新增平台请求。 |
| 18 | 新建/恢复使用统一观察，多视频及真实终态不盲等 | [videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts)、[videoArtifactObservation.test.ts](../tests/unit/videoArtifactObservation.test.ts)、[videoAuthorizationCoordinator.dom.test.ts](../tests/unit/videoAuthorizationCoordinator.dom.test.ts)、[videoGenerationAdvice.dom.test.ts](../tests/unit/videoGenerationAdvice.dom.test.ts)、[videoCandidateIdentity.test.ts](../tests/unit/videoCandidateIdentity.test.ts) | 正式 adapter 观察原消息；结构化 unauthorized/expired/needs_manual_selection 结束等待、落 paused/manual_review，无自动 reconcile 循环；原回复无视频卡且 !generating、只给明确复制用提示词/操作建议时，两次稳定证据后以 generation_not_started 暂停；暂时读取异常有限恢复；多个 URL 分别保留自己的 vid。真实平台不同终态与重启恢复仍待验。 |
| 19 | 基础图片、首尾帧、原对话与候选采用不回归 | [petstoryImageFlowStore.test.ts](../tests/unit/petstoryImageFlowStore.test.ts)、[petstoryImageAdoption.test.ts](../tests/unit/petstoryImageAdoption.test.ts)、[imageArtifactHistory.dom.test.ts](../tests/unit/imageArtifactHistory.dom.test.ts)、[petstoryNativeVideoSlots.dom.test.ts](../tests/unit/petstoryNativeVideoSlots.dom.test.ts)、[imageArtifactReadback.test.ts](../tests/unit/imageArtifactReadback.test.ts) | 唯一图片占用、当前具体图连续修改、原助手消息链、候选明确采用与首尾真实上传行为保留。现场发现“只回复生图操作建议仍等待”后补了先失败后通过回归；无卡且 !generating 的稳定明确建议现在暂停原请求。**真实客户端此次尾帧没有产图，不能称图片全链实测通过。** |

## 同一次真实本地媒体运行

证据目录是本机私有验收产物，不作为跨机器自动存在的仓库文件。可通过 [验收脚本](../scripts/fixtures/verify-local-video-playback.mjs) 重新生成：

```bash
pnpm run verify:video-local
```

最近成功记录：[evidence.json](../artifacts/mac/video-workflow-local/2026-11-10T03-32-29-247Z/evidence.json)，同目录保存下载台账、项目、真实 MP4、截图及文本形式的当次 Electron harness。记录明确为 `fixture=true`、`platformVerified=false`。

| 核对项 | 同一记录中的事实 |
| --- | --- |
| 构建 | 应用 2.3.8；Electron 43.8.3 / Chromium 150.0.7871.250 / Node 24.22.0；版本来自当次实际进程 |
| 原身份 | `fixture-task` / `fixture-run` / `artifact-401a9744`；下载 job 与资产均记录在同一 identity 对象 |
| 实际文件 | `project/shots/fixture-shot/fixture-asset.mp4`；87,128 bytes；5 秒；160×240 |
| SHA-256 | `79d7df54f573a63ecd06e47ef3fdfba4666f7da6652977ee90d20136c427cb8f` |
| 权威本地阶段 | TaskService 接收 downloading → downloaded → validating → library → ready，并记录各阶段时间 |
| 删除与断网 | 原 Task 清理后数量为 0；HTTP fixture 已关闭，然后才读取并播放资产 |
| 真实播放 | `currentTime=4.021602`、`readyState=4`、seek 完成；Chromium 发出 `Range: bytes=0-`，协议响应 206 |

该脚本从受控 HTTP MP4 开始，不覆盖真实豆包页面提交、平台生成或真实账号签名 URL 下载。它也不是对三种模式各完成一次真实平台生成的替代证据。

## 真实豆包原账号现场

现场记录：[acceptance.json](../artifacts/video-workflow-platform-20261110/acceptance.json)，`platformVerified=false`。使用现有 `sh01` 五秒镜头、原账号与已采用首帧，没有新增购买或充值。

- 视频正文任务 `15d54fbb-2267-4783-b692-55716424d7ee`、尾帧正文任务 `d8e1c921-5064-425b-aafd-f55a91d4b596` 已受理、读回并确认使用。
- 尾帧图片任务 `236b494e-b7f1-4f47-9a4c-607cf7772406` 的原对话只返回生图操作建议，没有实际图片。已停止本地等待，保留同一原请求与输入，没有自动重发。
- 随后已使用现有首帧启动 `first_frame` 视频任务 `aeffa5d8-8927-4941-9790-a54cc28b3cd5`，原 run 为 `aeffa5d8-8927-4941-9790-a54cc28b3cd5-1794278728144`。页面核对视频技能、Seedance 2.0 Fast、5 秒、9:16，原消息保存 accepted；但原助手只给“视频生成提示词（可直接复制使用）”及参数核对，没有视频卡或视频文件。该事实不证明视频工具实际开始生成，也不算成片成功。原请求保留，未自动重发。
- 最终构建重启后，点击“检查原视频结果”复用同一 run；2026-11-10T03:35:21.986Z 的观察为 `generation_not_started`，权威状态为 paused，错误码 `video_generation_not_started`，输出 0，原 submission=accepted 事实保留。启动和只读检查均未新增请求。2026-11-10 用户明确选择“先不重发，只保留原结果”，并反馈电脑已解锁；本次不创建关联重发任务，不再等待重发授权。
- 本次仍没有同一次真实平台运行的成片、下载、入库和本地播放文件记录；`first_frame`、`first_last_frame`、`reference` 均仍须真实平台全链验收。参数回读完成、正文完成、消息受理或暂停观察都不算生成成功。

本次按用户选择保留原请求、输入和结果，不重发。若用户后续另行要求继续，先检查原请求，再由正式动作继续制作；已有提交不能因启动、重挂载或检查而再次点击发送。任何明确重发仍须沿原任务提供的独立授权动作，保留原记录。

此次纯文字结果另有机制审查：在独立 Electron 受控按钮实验中，`button.click()` 只产生 `click`（`isTrusted=false`、无用户激活），从该按钮实时几何取点后 `webContents.sendInputEvent` 产生完整可信 pointer/mouse/click 序列。证据为 [点击机制实验](../artifacts/mac/video-click-mechanism/2026-11-10-native-events/evidence.json)，实验没有访问豆包，也没有操作真实客户端。**它证明两种输入机制不同，不能证明可信事件就是本次豆包只回文字的根因，亦不能证明更换点击机制后真实平台会成功。**

## 正式媒体可信点击的独立验收

视频与图片正式派发已使用同一提交探针核验唯一控件、正文、文档和本次操作，并先消费单次 key、安装原生事件回执；这一步只预留，不调用 DOM `click()`。宿主在每个异步边界核对原运行后，向该控件本次实时 DOM 中心发送一次原生 mouseDown/mouseUp，再读取同 key 的可信激活回执。没有 `sendInputEvent` 能力时返回明确未派发，不静默回退媒体 DOM 发送；正式 composer 与只读自检同时报告该能力。普通 Chat 保留原页内兼容路径，均不请求窗口焦点或发送键盘。

预留 ACK 丢失且尚未调用 mouseDown 时为 `not_dispatched`，真实 Core 清除 submittedAt；原生输入已经尝试或既有 key 可能已激活时为 `dispatch_unknown`。按下后取消会在原 webview 的页面外松键，保留原控件取消墓碑阻断迟到序列，不激活新控件；新正式预留交接清理旧守卫，旧宿主异步续步仍受冻结运行上下文约束。丢失激活 ACK 只能观察原请求，不补按。

最终 [真实 Electron webview 证据](../artifacts/mac/native-submission/verified-native-8-final/evidence.json) 为 8/8 通过、`success=true`，其中源码 SHA-256 与当次正式 bridge/probe/dispatch/context 文件一致：

- 唯一控件实际收到 pointerdown、mousedown、pointerup、mouseup、click 各一次，全部 `isTrusted=true`；BrowserWindow 焦点前后均为 false。
- 仅预留 ACK 丢失：`not_dispatched`，原生输入 0、事件 0、激活 0。
- 激活 ACK 丢失：首次 `dispatch_unknown`，真实可信激活 1；同 key 再调用仍为 1。
- 点击前取消、真实 mouseDown 后取消、原预留取消后的迟到事件、旧 run 撤回和新 run 独立派发均通过。

复验使用 `node scripts/fixtures/verify-native-submission.mjs`。脚本创建独立 userData 与本地 HTTP guest，不读取原账号、不访问豆包、不重启真实客户端。行为回归见 [nativeMediaDispatch.dom.test.ts](../tests/unit/nativeMediaDispatch.dom.test.ts) 与 [videoAdapterWorkflow.dom.test.ts](../tests/unit/videoAdapterWorkflow.dom.test.ts)；DOM 测试中可信原生传输是显式边界替身，真实事件可信性以此 webview 记录为准。**此证据不等于真实平台生成成功，原视频请求仍未因此自动重发。**

## 媒体工具与安装环境边界

本机 macOS 开发环境已实际运行 ffmpeg/ffprobe，生成、完整解码和播放上述 MP4；工具缺失/超时及恢复由行为测试验证。实际安装后的 Windows 与 macOS packaged 应用尚未完成媒体工具实机验收。

解析器依次支持 `DOUBAO_FFMPEG_PATH` / `DOUBAO_FFPROBE_PATH`、Electron resources 中 `media-tools` / `bin` / `app.asar.unpacked/bin`，macOS 常见工具目录，最后回退 PATH；Windows 使用 `.exe` 名称。**路径解析代码与离线故障测试，不证明安装包已携带工具，也不证明 Windows 可执行、权限、签名或实际解码可用。** 本次未引入或分发新的媒体二进制。

后续安装环境验收至少应在各自真实安装目录运行一次原文件校验、工具缺失后恢复校验、受控 Range 播放；记录解析到的工具版本及真实结果到诊断，不输出用户素材绝对路径。

## 最小复验与定位

直接启动使用 `pnpm run dev`；完整门禁使用 `pnpm run validate`；真实本地媒体闭环使用 `pnpm run verify:video-local`。真实账号验收在现有完整输入镜头点击“生成视频”，沿同一运行等到本地可播放，再分别验证“检查原结果”“重试下载”“重新校验”“重新读取”，三种逻辑模式分别留证。

出现问题时导出原有诊断包，按 project/shot/step/task/run 定位，不新建一套日志。输入摘要、提交状态、阶段耗时、页面观察、下载、工具分类与资产来源关联的行为证据在 [videoWorkflowDiagnostics.test.ts](../tests/unit/videoWorkflowDiagnostics.test.ts) 和 [petstoryDiagnostics.test.ts](../tests/unit/petstoryDiagnostics.test.ts)。Task 已清理时诊断仍关联资产来源并标记 `taskMissing`；正文、凭据、内部平台 URL 和素材绝对路径不应进入导出。
