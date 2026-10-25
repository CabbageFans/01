# Mac 基础功能与普通 Chat 实机验收

## 最新复测：2026-10-24（本节为当前结论）

按用户“重新开始走流程”继续同一工作区、main、基线 SHA 与 mac-dev；保留全部已有修改、账号和任务。未重新克隆、安装依赖、切分支、提交或发布。Node 24.15.0 / pnpm 11.0.0 / Electron 43.8.3 arm64 不变。GUI 本次已解锁，上一日的锁屏 BLOCKED 不再是当前阻断。

**Mac 基础能力与本次普通 Chat：PASS。** 本次新增的一条普通文字任务收到真实回复，消息节点匹配预期测试标记，本地任务经正式执行链自然进入 done；退出后重开原会话仍显示同一次回复，未补发。**图片、视频及其下载/播放：BLOCKED**，因为虽有入口，无法核实官方免费权益。没有创建或提交媒体任务，不能宣称完整生成流程已通过。Chat 正文未保存为独立产物仍为原有功能缺口（FAIL），不增加完整 JSON 提取器。

### 本次结果与证据

| 项目 | 状态 | 验证方式及限制 |
| --- | --- | --- |
| 原有安装、contracts、编译链 | PASS | 复用已确认安装；本次两次完整 validate 均成功，最终 61 files / 1184 tests、0 errors / 148 warnings，原 warning 门槛未改；保留 Vite 大 chunk 提示 |
| 真实主界面、preload、IPC、控制桥、Webview | PASS | 本机 Electron GUI 可观察；正式 local-control ready；普通 Chat 的真实消息节点与回复，不以假页面或进程存在代替验收 |
| 原生焦点与最小化后恢复 | PASS | 实际应用内使用独立非持久化本地 Webview；生产发送函数取得 OS 焦点，只有 1 次 trusted 点击，focusedAtClick=true；原账号页面未导航、更换或被替换。两次冷运行均通过 |
| 标题栏、缩放/全屏、Dock | PASS | 沿用上一轮用户“全部正常，原任务与网页仍在”的人工结果；本次未重复拖动、全屏与 Dock 点击 |
| 关闭隐藏、恢复同窗 | PASS | 真实 close IPC 证明 hidden=true；恢复后 renderer timeOrigin、guest ID、run、submittedAt 均不变，控制桥仍 ready。原生红色关闭的人工证据沿用；本次 native AX 回读会干预窗口观察，不单凭它宣称隐藏 |
| Cmd+Q | PASS | 本次原生快捷键后 launcher/Vite/Electron 实查退出，调试端口关闭；重启后同 profile 数据保留 |
| 宿主 Cmd+A/C/V/X/Z | PASS | 实际 macOS 原生组合键；React 正文框选区、剪切为空、撤销恢复、独立 C/V 回读均通过；不保存测试任务 |
| guest Cmd+A/C/V/X/Z | PASS | 实际原生组合键，在真实空白豆包 composer 中回读；剪切后为空、撤销恢复、C/V 精确匹配；测试后清空，消息数始终 0，无发送 |
| 中文、多行、长文本粘贴 | PASS | 两个输入框均使用本机粘贴与真实 readback，源文本 1463 字符。guest contenteditable 段落产生额外换行，折叠段落空白后正文完全一致；并非逐字节相等 |
| 宿主系统中文输入法候选/换行 | PASS | 用户明确人工确认“中文候选选字和换行正常，已取消”；无任务创建 |
| guest 系统中文输入法候选 | NOT TESTED | 原生中文粘贴不替代 guest 的 OS 组合输入候选测试；未收到此项人工结论 |
| 项目、账号、任务与 hold 持久化 | PASS | 最终 1 项目 / 1 账号 / 4 任务；稳定 hold taskId 不变，仍 queued/hold，无提交标记；两条旧任务仍暂停、run/attempt 不变 |
| 手动登录和 Session 保持 | PASS | 上轮用户本人手动登录，本次跨日及多次 Cmd+Q/重启后仍已登录；未读取或导入任何 Cookie/Token，没有清理登录数据 |
| 本次普通文字页面往返 | PASS | 当前新任务中只有 1 条用户消息 / 1 条助手消息，助手正文精确匹配预期标记，使用消息区 DOM，不匹配侧栏标题 |
| 本次文字本地完成 | PASS | 实际状态自然变为 done/completed，errorInfo 为空；没有人为写 done。发送前基线、原会话匹配与稳定助手消息共同判定 |
| Chat 正文产物 | FAIL | outputs=0，原产品没有保存正文为独立产物；本次也避免将页面旧媒体错绑到文字任务，不添加 Chat JSON 提取器 |
| 原会话重开 | PASS | 开始时上一轮真实回复已可恢复；本次新任务 Quit 后再冷启动，经原“打开原会话”动作再次看到同一回复、同一 run/attempt 与具体会话绑定，无补发 |
| 暂停、恢复与重复请求 | PASS | 两条历史已提交任务保持暂停；本次首次尝试在 page_loading 阶段阻断，明确无输入、无 submittedAt、0 消息，暂停/冷启动后仅该未发送任务经正式 retry 恢复；相同 requestId 回放仍 done、attempt 不变，没有新 run/发送。4 项既有恢复安全回归仍通过 |
| 中文/空格文件、原生选择器与缩略图 | PASS | 沿用上轮真实 PNG 签名、尺寸/hash 与用户选图缩略图确认；本次未重新上传素材 |
| 图片、视频、平台产物下载与播放 | BLOCKED | 当前普通 Chat 中图片/视频入口可见，但官方免费余额/权益及可用免费规格未知；媒体任务/提交均 0，未消费付费权益，未去水印或改写权限 |
| 真实睡眠、合盖、断网恢复 | NOT TESTED | 未改系统睡眠/网络/VPN。退出后本机观察停止；远端可能继续，不承诺合盖或退出后继续观察 |
| 远程冷启动稳定性 | FAIL | 一次 fresh-root 导航约 78 秒才结束加载，首次本地运行被 page_loading 拦在发送前。已减少已就绪空根页的重复加载；慢资源与间歇连接错误仍未根治 |
| 安全停止 | PASS | 见 final-process-audit.json：本次拥有进程 0，5173/9334 关闭，另三个已记录 Node 进程仍存活；没有 killall/pkill |
| 本机打包/签名、Windows 实机、Dola | NOT TESTED | 本轮停止于基础/文字验收；没有自动进入打包或后续业务 |

### 本次最小修复与文件清单

| 文件 | 修改必要性 |
| --- | --- |
| `src/utils/chatReadback.ts`（新增） | 普通 Chat 专用的消息区快照与比较：只接受本次唯一用户提示词之后的唯一助手正文；排除编辑器、侧栏和脚本；缺失或歧义时等待 |
| `src/utils/doubaoBridge.ts` | 通过正式 Webview 执行自包含消息探针；普通 Chat 只有在精确官方空根页、可见空编辑器、零消息全部回读通过后复用页面，避免再次等待慢资源；其它模式保留原路径 |
| `src/components/BrowserPanel.tsx` | 在发送前记录 Chat 消息基线；单次发送后仅回读原会话、稳定助手消息，不把快速回复吞入发送后的基线；文字任务不扫描媒体产物。保留原生焦点、输入验证、持久化提交意图与不重发规则 |
| `tests/unit/chatReadback.test.ts`（新增） | 11 项行为回归：草稿不等于发布、用户回显不等于助手、快速回复、历史排除、混合/歧义拒绝、实际序列化 guest 探针、复用空根页及保留已有草稿等 |
| 本报告、`MAC_BASELINE_STATUS.json`、`MAC_ENVIRONMENT.md` | 分离最新事实与此前失败历史，记录真实请求次数、剩余限制和安全收尾 |

此前 Mac 启动器/profile、Electron 安全升级、菜单/窗口、恢复幂等及原生焦点修复全部保留；完整历史文件清单见下文原第二轮记录。没有批量升级依赖、改品牌/UI 架构、清除缓存/登录数据或改变系统网络。2026-10-24 再查官方 [Electron 发布计划](https://releases.electronjs.org/schedule)，43 仍属维护分支（计划 2027-01-05 EOL，暂定）；[43.8.3 发布说明](https://github.com/electron/electron/releases/tag/v43.8.3)包含安全修复回移。固定版本不代表永久安全。

### 单次提交台账

- 本次稳定 taskId：`a2af3db4-d541-4577-b963-678432535d3e`；仍用原项目及唯一账号，未新建账号/Session。
- 首次本地 run 在 new_conversation/page_loading 阶段阻断：无输入、无 submittedAt、无绑定地址、页面消息为 0；正式暂停后冷启动。保留此失败，不将其算作平台受理。
- 只有这条已证明未提交的任务调用一次正式 retry 恢复；最终 run 为 `a2af3db4-d541-4577-b963-678432535d3e-1792801184897`，attempt=2。平台发送边界执行 1 次，观察到 1 条真实用户消息 / 1 条真实回复，随后 done。
- 本机 start 命令 1 次；未提交任务的唯一 retry 命令 1 次，另将同一 requestId 回放一次验证幂等缓存，未产生新 attempt/run。HTTP 控制命令数不是平台生成请求数。
- 本轮新任务的确认平台提交/回复为 **1 / 1**；图片/视频各 **0**。未抓取平台 HTTP 请求正文/头，因此不宣称统计了平台内部传输重试。
- 两条旧任务从未 retry/重发；旧成功回复可回读但旧本地任务仍 paused，第二条历史任务受理仍未知，不能当作本次的成功或擅自重新发送。
- 官方免费额度与变化均 **未知**。源码“6 单位”只属本地估算，不是官方余额。没有付费、充值、会员升级或媒体返工。

### 复现命令与进程收尾

```bash
cd /Users/zarkding/Documents/doubao-studio
source "$HOME/.nvm/nvm.sh"
nvm use 24.15.0
export PATH="$HOME/.local/share/doubao-studio-tools/pnpm-11.0.0/node_modules/.bin:$PATH"
pnpm run dev:mac
```

profile 仍由 Electron 平台路径 API 推导：`/Users/zarkding/Library/Application Support/DoubaoStudioDevelopment/mac-dev`。默认无 CDP；仅本轮短时诊断加 `--local-control --local-cdp-port=9334`。正常退出用 Cmd+Q 或启动终端 Ctrl+C；必要时只向该次 `[dev] launcher=...` PID 发 `kill -TERM <PID>`，不要按进程名批量停止。

本次 launcher / Vite / Electron：30307/30319/30321、31092/31095/31097、31722/31725/31727、31890/31896/31898，均已停止。31097 与 31727 经真实 Cmd+Q 退出，最后一组按 launcher 定向 SIGTERM 收尾（终端退出码 143 为本次主动停止）。GUI 观察在 Quit 后曾自动拉起同一 Electron 可执行文件的 31864 及后代 31865/31866/31867，已按精确 PID 额外停止，并释放原生工具绑定；不把观察工具的新进程误认作原工作室未退出。第一轮旧 7471/7474 在本次开始前就已不在，未被本轮终止。最终独立审计确认本项目 Electron 43 进程 0、所有本轮拥有进程 0；当前另有 Node 7726/7728/7729 保持存活和原父进程；记录中的 9470/9471 在工具/会话释放期间已结束，未对它们发送终止信号，不声称仍存活。不会在会话结束后维护进程。

### 证据与剩余条件

证据目录 `artifacts/mac/restart-2026-10-24/` 已被 Git 忽略。关键文件：`native-focus-fixture.json`、host/guest native edit JSON、`ime-human-confirmation.json`、`old-conversation-final.json`、`request-ledger.json`、`chat-status-observation.json`、`chat-production-readback.json`、`close-handler-proof.json`、`final-conversation-after-quit.json`、`free-entitlement-check.json`、`validate-after-ready-root.log`、`final-process-audit.json`。不保存登录后个人历史截图、聊天全文、Cookie/Token、验证码或签名媒体 URL；调试 ws 地址已脱敏。

最初的新增 probe 测试有一次断言未考虑 NFKC 全角冒号规范化而失败，已修正断言后两次完整 validate 通过；证据保留，不删除测试或调低门槛。短时诊断也保留了转义/Promise collected 等工具失败；不是应用崩溃。一次慢加载仍出现 MaxListenersExceededWarning（最终两次启动未出现），不宣称已彻底解决。

后续只有在官方入口明确免费权益/规格并建立媒体单次提交保护后，才可继续图片/视频；Chat 正文产物、旧暂停任务的本地状态恢复和慢加载仍如实列为缺口。宿主系统中文输入法已有人工证据，guest OS 候选输入及真实睡眠/断网仍未测。普通文字已通过，满足用户允许的“可另起本机打包”前提，但本轮没有执行打包，也不自动进入下一轮。

---

## 2026-10-23 历史记录（以下不代表最新状态）

日期：2026-10-23（Asia/Shanghai）。工作区 `/Users/zarkding/Documents/doubao-studio`，`main`，HEAD `7eeb7b67a518e47ee4296c36e5c5f17942a9cff0`。沿用原工作区与第一轮未提交修改；没有克隆、切主线、stash/reset/clean、commit/push 或 Release。

## 用户处理网络后的追加复测（22:16 起）

本节为用户明确要求“再走一遍流程”后的追加验收，以下原第二轮记录保留历史，不把此前的真实回复冒称本次回复。

固定 mac-dev、Node/pnpm/Electron 与版本不变，未重新安装依赖。冷启动首页与已登录导航、输入框正常，控制桥 ready，原 project/account/task IDs 保留，hold 测试任务仍未提交。宿主公开首页 curl HTTP 200、SSL verify 0；系统代理仅检查开关，HTTP/HTTPS/SOCKS/PAC 均未启用。真实 Webview 仍有部分 ERR_SOCKET_NOT_CONNECTED / CONNECTION_RESET，以及观察窗口内 3 个未能归属具体域名的 ERR_TIMED_OUT；未改系统网络设置。

原 Chat 任务只走现有“打开原会话”处理器，未 retry 或发送；仍由有效的具体会话地址返回 Chat 根页，未显示原消息。该项仍 FAIL，不能只凭用户已处理网络改写为 PASS。

本次仅新增一条普通 Chat 测试任务 `3f4f4db8-0f1d-49dc-8037-23daba96308b`，复用原项目与唯一账号；本机 start 一次，HTTP 202。运行 ID `3f4f4db8-0f1d-49dc-8037-23daba96308b-1792765235909`，attempt=1。真实发送调用后，提示词仍在草稿框，回读 `inputCleared=false / generationStarted=false / promptPublished=false / messageCount=0`，任务安全暂停。**本次确认的平台新消息/回复均为 0，平台实际受理与否未知**；不能把本机 202、提交意图或发送函数返回 true 当作平台成功。没有再次点击、补按 Enter 或 retry；旧任务也没有重发。两次验收累计只确认上一轮的一次真实文字提交/回复。本次图片/视频仍各 0 次。

进一步用独立 mac-test、真实 Electron 43 的本地按钮复现：窗口未聚焦时一次点击曾只获得焦点而未触发按钮，聚焦后点击有效。其他对照中后台输入亦可能被接受，因此这只能证明原生焦点条件会影响可靠性，不能认定本次平台未受理唯一由焦点导致。官方 [sendInputEvent 文档](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent)明确要求宿主 BrowserWindow 先聚焦；[Webview 方法](https://www.electronjs.org/docs/latest/api/webview-tag#webviewsendinputeventevent) 返回 Promise。

本次最小修复：增加仅宿主可调用的 `system.prepareNativeInput` IPC；主进程恢复/显示窗口并确认实际焦点，失败则拒绝发送；guest focus 后顺序 await 唯一的 mouseMove/down/up，不增加任何备用发送。涉及 `main/main.ts`、`main/utils/windowLifecycle.ts`、`main/preload.ts`、`packages/contracts/src/dto/electron-api.ts`、`src/utils/doubaoBridge.ts`，以及现有窗口测试与新增 `tests/unit/nativeSubmissionFocus.test.ts`。8 项新增行为测试覆盖焦点等待/超时/清理、无焦点零鼠标事件、单次有序鼠标事件与部分失败禁止回退。

**当前实机聚焦集成验收 BLOCKED：GUI 工具明确返回 Mac 已锁屏、无法自动解锁。** 此前真实应用的系统焦点持续 false，新门禁正确阻止点击；独立本地对照的背景输入结果存在差异，不能借此放宽为仅信任 DOM hasFocus，也不能把锁屏期间的焦点失败直接归为应用缺陷。已要求用户手动解锁，未读取/输入密码或尝试绕过锁屏。待解锁后重新验证真实应用内的本地按钮点击，再决定是否具备额外真实 Chat 请求的验收条件；当前真实任务次数边界保持，不重发。

最终源码的完整 validate 再次通过，退出码 0：60 files / 1173 tests，Lint 0 errors / 148 warnings，门槛未改。日志 `artifacts/mac/network-recheck/validate-final.log`，此前单元与集成尝试亦保留。新增 native IPC 与 preload/contracts 对应，工程检查 54 handle/invoke、5 on/send。原有大 chunk 提示保持。

本次慢页过程中仍复现 MaxListenersExceededWarning，上一轮限制文档轮询并未覆盖所有等待来源；未提高监听上限，也不把这项警告标成已彻底根除。由于当前锁屏，原生编辑快捷键/输入法、聚焦集成、进一步 GUI 验收均未完成。图片/视频的免费权益也尚未核实，未创建或提交媒体任务。

复测日志、过滤的页面/任务快照、只包含域名与错误的网络元数据、本地焦点对照和请求次数台账保存于忽略的 `artifacts/mac/network-recheck/`。未保存请求头/正文、聊天全文或签名媒体 URL；本地按钮测试不替代豆包普通 Chat 成功判据。

| 本次追加复测项目 | 状态 | 当前结论 |
| --- | --- | --- |
| contracts / 类型 / Lint / 工程检查 / 测试 / build | PASS | 最终完整 validate 60 files / 1173 tests，0 errors / 148 warnings |
| 首页、普通 Chat Webview、原登录态 | PASS | 新启动输入框及已登录导航可见，无登录/验证提示 |
| 原项目/账号/hold 任务、旧提交标记 | PASS | 读取到稳定 IDs、hold 未提交、旧 run/attempt 未改变 |
| 原会话重开 | FAIL | 仍回 Chat 根页，无原消息，不再猜测/重发 |
| 本次新文字任务 | FAIL | 本机 start 一次；发送结果不确定、草稿未清空、无新回复；安全暂停 |
| 原生焦点准备真机正向集成 | BLOCKED | GUI 工具确认锁屏；锁屏期间拒绝原生点击，需人工解锁继续 |
| 本地焦点门禁单元行为 | PASS | 新增 8 项，确认失败零鼠标事件、成功一次有序事件、部分失败无回退 |
| 标题栏/窗口、Cmd+Q、文件选择 | NOT TESTED | 本次未重复人工测试，原第二轮人工 PASS 的历史结果保留 |
| 编辑快捷键、OS 中文输入法 | NOT TESTED | 仍缺人工验证，锁屏后无法补测 |
| 生图/生视频、真实下载/播放 | BLOCKED | 免费权益未核实、文字提交未确认；媒体提交仍为 0 |
| 真实睡眠/断网恢复 | NOT TESTED | 没有主动改变 VPN/网络/睡眠 |
| 安全停止 | PASS | 本次启动进程及临时网络/按钮测试进程均退出，5174/9334 关闭，原实例存活 |

本次三组 launcher / Vite / Electron：19886/19897/19899、21146/21154/21156、21362/21366/21368，均已定向停止。最终剩余本次拥有进程 0，Electron 43 进程 0；原 7471/7474 及后代保留。详见 `artifacts/mac/network-recheck/final-process-audit.json`。当前没有保留诊断实例等待解锁；收到解锁确认后须按下方相同命令重新启动，再验证本地聚焦门禁。源码与 profile 已保存，不承诺后台维护进程。

## 原第二轮记录

**真实普通 Chat 往返 PASS；本地 Chat 状态收敛 FAIL，整体生成全链未通过。** 用户手动登录后，仅显式启动一条 Chat 任务，页面观察到一条测试消息和一条符合指定标记的真实回复。任务在早期回读超时后保持 `paused/submission_uncertain`，没有再次发送，也没有伪造 `done`。图片/视频各提交 **0 次**，因免费权益未知及提交回读缺口而 BLOCKED。

本报告记录第二轮；[第一轮报告](MAC_BOOTSTRAP_REPORT.md) 保留当时 Electron 33、网络受阻的历史结果。当前事实以本报告、[环境记录](MAC_ENVIRONMENT.md) 和 [状态 JSON](MAC_BASELINE_STATUS.json) 为准。

## 环境与第一轮阻断修复

复用已确认的 macOS 15.3.1 / Apple Silicon arm64、nvm Node 24.15.0、独立用户级 pnpm 11.0.0。没有重新探测整套环境、安装新版本管理器、覆盖系统 Node 或使用 sudo。仅为真实登录前的安全前置条件升级 Electron。

依据 2026-10-23 的官方 [版本维护时间表](https://releases.electronjs.org/schedule)，33 已结束维护，43 是当日仍受支持的最早主版本（计划 EOL 2027-01-05，暂定）。精确锁定 **43.8.3**，官方 [发布说明](https://github.com/electron/electron/releases/tag/v43.8.3) 包含 Chromium/V8 等修复回移。只调整 Electron 与其传递依赖；没有批量升级其他顶层包。实际安装二进制与运行时均为 43.8.3 / arm64。`allowBuilds` 未变，仍仅 electron/esbuild。固定版本仍需后续补丁维护，不能保证持续安全。

安全回归：宿主 `sandbox:true`，preload/IPC 可用；宿主与远程 Webview 无 Node，保持 contextIsolation 和默认 webSecurity；移除 guest `allowpopups`，宿主新窗口仅允许 http(s) 交由系统浏览器。没有 `--no-sandbox`、证书忽略、SSL 关闭或远程 nodeIntegration。未开启历史请求改写、15 秒补丁、实验去水印或私有接口绕过。

升级后默认网络仍失败。隔离 `mac-test` 对照显示：宿主 IPv4 curl 可达且证书校验成功，IPv6 探测超时；Electron 默认配置及显式 direct 配置仍出现 `ERR_SOCKET_NOT_CONNECTED (-15)`。Happy Eyeballs 单独启用仅主文档成功，资源仍失败；系统解析器与 Happy Eyeballs 同时启用后，实际 Webview 的未登录普通 Chat、登录与文字回复成功。Mac 分支仅在本应用 ready 后、Session 初始化前调用 `app.configureHostResolver({enableBuiltInResolver:false, enableHappyEyeballs:true})`。这组对照支持应用内解析/连接兼容修复，不能推断用户网络的唯一根因。未修改 AmneziaVPN、系统代理/DNS/hosts 或网络/睡眠设置。部分后台连接仍报错，不能宣称所有资源始终可达。

## 分项结果与证据

| 项目 | 状态 | 证据与限制 |
| --- | --- | --- |
| 依赖/编译链 | PASS | 第一轮 frozen install 已通过；本轮仅安装必要的 Electron 升级，真实二进制可启动；contracts、类型、工程规则、测试、build 与完整 validate 均通过。没有删除锁文件或绕用 npm/yarn |
| 非空主界面、preload、IPC、Webview | PASS | 真实 Electron 43 宿主界面、任务对话框和控制桥有效；真实远程普通 Chat 有输入框及消息 DOM，guest `require` 不存在；不是本地假页面代替平台 |
| 标题栏拖动、最小化/恢复、缩放/全屏/退出全屏 | PASS | 用户逐项人工检查并回复“全部正常，原任务与网页仍在”；程序未冒充原生手势验证 |
| 红色关闭、Dock 重开 | PASS | 用户人工确认；程序另证实关闭隐藏后同一 renderer timeOrigin、guest webContentsId、内存标记与控制桥 ready 保持。第二实例恢复探测不冒称 Dock 点击证据 |
| Cmd+Q | PASS | 用户人工确认正常退出；PID 回读证实 launcher 17441 / Vite 17444 / Electron 17446 全部退出，5174/9334 关闭，原实例不受影响。工具组合键投递本身未可靠，采用人工证据 |
| 宿主 React 中文、多行、长文本 | PASS | 在真实添加任务输入框通过 Chromium 输入事件输入 1463 字符，逐字回读相等；取消对话框，无任务创建 |
| Cmd+A/C/V/X/Z（宿主与 guest） | NOT TESTED | 已加入标准 Edit roles；工具的 Meta 组合键未可靠执行，不能据此判定真实快捷键失效或通过。一次 Cmd+Z 表面相等因前一步剪切未发生而无效；尚未收到此项人工结论 |
| 系统中文输入法候选/组合输入、guest 多行/长文本 | NOT TESTED | 程序直接插入中文不等于 OS 输入法验收，尚未收到此项人工结论；没有改成盲目替换所有 Control 为 Meta |
| 项目、账号配置、未启动任务持久化 | PASS | 同一 mac-dev 多次真实退出/重开，稳定 projectId/accountId/taskId 保持；最终未启动任务仍 `queued/hold`，无 submittedAt，不自动提交 |
| 用户手动登录 | PASS | 用户明确回复“已登录”；程序只回读普通 Chat、输入框/登录提示存在性与验证状态，不读取密码、号码、验证码、Cookie 或 Token |
| 登录 Session 重启保持 | PASS | 用户登录后正常 Quit、再次启动仍同一账号/partition，页面输入框可用、未出现登录提示；命名 localStorage 测试标记保留。未保证登录永久有效 |
| 普通文字页面往返 | PASS | 唯一真实 Chat 任务：用户消息数 1、助手消息数 1，分别在 send_message / receive_message 的 message_text_content 中精确匹配测试输入/预期标记；不以侧栏标题或本地状态推断回复 |
| 普通文字本地状态/正文产物 | FAIL | 页面已回复，但任务仍 `paused`、错误 `submission_uncertain`，outputs=0；现有早期提交回读窗口未及时识别，后续只读证据才确认。没有人为写 done、实现 Chat JSON 提取或重新发送 |
| 暂停/继续/重复点击 | PASS | 修复后 cold-runtime 实测与 4 项回归测试：重复暂停请求幂等；并发继续合并；hold 不变 armed；不确定已提交保持暂停；已受理只观察原 run。真实 Chat 只回读原会话，未执行 retry |
| 中文文件名及含空格路径读取 | PASS | 项目内自建 32×32 PNG，99 字节；读取 IPC 返回真实 PNG 签名、尺寸及 SHA-256 均与磁盘相等，无个人素材 |
| 原生文件选择及缩略图 | PASS | 用户通过系统选择器选中项目内中文/空格路径 PNG，确认缩略图显示并取消整个任务对话框；原 taskCount 仍为 2，无上传或新任务 |
| 免费生图 | BLOCKED | 官方免费权益/余额无法确认，且本轮提交确认存在不确定性；未创建、未启动，提交 0 次 |
| 免费生视频 | BLOCKED | 生图未执行，唯一合法参考图前置条件不满足，免费 5 秒/9:16 选项未确认；未创建、未启动，提交 0 次 |
| 本次平台产物下载、类型检查与视频播放 | BLOCKED | 无本次生成媒体，不能验证绑定、合法下载、真实类型或可播放性；本地测试 PNG 不算生成产物 |
| 退出后不重复发送、原任务恢复安全 | PASS | 同一 task/run/submittedAt 与原会话绑定保留，重新启动后安全暂停，不自动补发；未重建账号或任务 |
| 退出后重新打开平台原会话 | FAIL | 最终冷启动后经现有“打开原会话”处理器只读导航；存储地址语法有效，但页面最终回到 Chat 根页，消息数 0，未能重新显示原回复。未见对应标记的历史控件，不猜其它会话；原因未确定 |
| 远程页面冷启动稳定性 | FAIL | 曾有一次冷启动数分钟无输入框；修复轮询重复探测后最终冷启动可加载登录态与输入框，但未证明网络长期稳定，也未修复上述原会话恢复问题 |
| 真实睡眠、合盖、断网恢复 | NOT TESTED | 没有主动改变网络/VPN/系统睡眠；本地恢复测试通过不替代真实系统中断。应用退出后本机观察停止，远端任务可能继续 |
| 安全停止、不影响其他 Node/Electron | PASS | Cmd+Q 后本轮拥有进程与端口关闭，开始时已有 7471/7474 及后代仍存活；最终诊断进程收尾另记下方 |
| Windows 实机、Dola、打包/签名 | NOT TESTED | 保留现有 Windows 分支和路径；本轮未执行这些后续工作 |

## 稳定数据与一次提交边界

开发 profile 实际解析路径（Electron 平台 API 推导，源码没有硬编码）：

```text
/Users/zarkding/Library/Application Support/DoubaoStudioDevelopment/mac-dev
```

userData / sessionData 均在此路径。仅一个由用户本人登录的测试账号；未读/拷贝/导出 Chrome、官方豆包 App 或其他 Studio profile 的 Cookie，未清任何 Cookie、Local Storage、IndexedDB、钥匙串或其他应用数据。自动化网络探测使用另一个临时 `mac-test`，不接触真实登录 Session。

| 记录 | 稳定 ID / 结果 |
| --- | --- |
| 项目 | `9ba569bf-7618-4c0f-999c-10810c527302` |
| 本地测试账号 | `0ac68864-8559-491d-afb7-280b347b0267`（本地 UUID，不是平台账号号码） |
| 永不启动的 hold 测试任务 | `e69f6146-afe1-4e3d-8fe3-fa5e4ded567e` |
| 唯一真实 Chat 任务 | `7c4ec9f3-c4ba-4c26-8f4a-a324a44b727d` |
| 唯一 run | `7c4ec9f3-c4ba-4c26-8f4a-a324a44b727d-1792762528747`，attempt=1 |
| 本机 start 命令 | 共 2 次：首次 409/ACCOUNT_REQUIRED，在平台提交前被拒；修复后同一任务一次 202/START_ACCEPTED |
| 观察到的平台文字提交/回复 | 1 / 1；每个真实消息包装节点精确匹配，不记录正文或内部会话 URL |
| 图片/视频创建与提交 | 各 0 / 0，无自动返工 |
| 平台官方免费额度及变化 | 未知；未观察到可可靠核实的余额/权益变化 |
| 本地额度估计 | 原代码的“6 单位”等仅是本地调度估计，不能当官方余额、免费承诺或消费凭据 |

提交计数依据：一个持久化 run、单次发送边界和页面一条测试用户消息；没有抓取登录请求头或 HTTP 正文，不能宣称已统计平台内部所有 HTTP 重试。真实回复在任务安全暂停后通过只读回读确认。原会话 URL 只由现有合法 URL 校验后保存在原任务 runtime 中，不写入报告/控制输出。后续核对必须进入这个原任务/原会话；不要为此点“重试”或新建任务。

## 修复、发现与未掩盖的失败

| 文件 | 本轮必要性 |
| --- | --- |
| `package.json`、`pnpm-lock.yaml` | 登录前将 Electron 单独精确锁定至仍受维护的 43.8.3，传递依赖随之调整 |
| `main/main.ts` | 启用宿主 sandbox、Mac 原生菜单与 Edit roles；关闭时隐藏，Dock/第二实例恢复同窗；每次窗口创建均注册控制桥生命周期；应用内 Mac 网络兼容；保留第一轮启动/profile 与用户原生标题栏改动 |
| `main/utils/windowLifecycle.ts` | 将保留窗口与恢复规则集中成小函数，不销毁执行链或重建账号 Session |
| `main/ipc/accounts.ts` | Session 使用当前本机 Chromium UA，替代写死 Windows/Chrome 120；重启时同一 partition 重新设置 UA，不清数据 |
| `src/components/BrowserPanel.tsx` | 移除 guest 弹窗权限；日志不再输出 partition、内部资源 URL 数组或参考素材绝对路径；慢页文档轮询只保留一个未完成 Electron 脚本请求，避免超时 race 后重复挂加载监听 |
| `src/utils/doubaoBridge.ts` | 去除提示词预览日志，只保留必要长度与状态证据 |
| `src/store/useTaskStore.ts` | “继续队列”回读原任务并保留执行意图；不再调用会重新 armed 的 retry；不确定提交禁止自动恢复重发，并发继续合并 |
| `src/App.tsx` | 本机控制在 assign 后刷新实际 renderer 任务投影，消除已指派但 start 读旧“无账号”状态的问题 |
| `tests/unit/windowLifecycle.test.ts` | 7 项生命周期规则验证 |
| `tests/unit/resumeSafety.test.ts` | 4 项有行为意义的恢复/幂等回归验证 |
| `docs/MAC_SMOKE_TEST_REPORT.md`、`docs/MAC_ENVIRONMENT.md`、`docs/MAC_BASELINE_STATUS.json` | 真实验收、变化事实与机器状态 |

第一轮已有的 `scripts/dev.mjs`、`vite.config.ts`、`main/utils/developmentProfile.ts`、`tests/unit/developmentProfile.test.ts`、`.gitignore` 和第一轮报告均保留。本轮未重写启动器、UI 或任务架构。

保留的失败证据包括：升级后默认网络仍受阻；原“继续”会给 hold 任务 armed 的回归失败；旧 HMR 模块的现场诊断曾短暂把未指派 hold 任务置 armed，已立即通过正式 IPC 恢复 hold，无平台提交，cold restart 后重新验证修复；第一次本机 start 读到旧投影而返回 ACCOUNT_REQUIRED，修复后才在同一任务上首次进入平台；实际 Chat 提交回读超时与本地状态不收敛。后一项是现有能力缺口，尚无证据把它归为 macOS 特有问题。

另保留本轮诊断脚本的扩展名/ready 时机/转义错误、一次测试 fixture 类型字段遗漏，以及删除日志后未使用 catch 变量导致 150 warnings 超过原阈值的门禁失败。均修正后重跑，未删除测试、吞错、降低门槛或更改 warning 上限。这些检查脚本问题不冒称上游失败。

Cmd+Q 后的最终诊断重启（18118/18128/18130）中，宿主与稳定任务数据正常，但远程网页数分钟未形成输入框，只读打开原会话亦未及时完成；同时发现原轮询 `Promise.race` 超时并不取消 Electron 脚本请求，每 2 秒会累积 `did-stop-loading` 监听。已最小修改为等待原请求实际完成，保留 60 秒提示与正式事件，不提高监听上限或吞掉警告。该修复消除重复探测的原因，不能当成远程资源加载根因已经解决；后续重启结果独立记录。

修复后的最后一次冷启动（18767/18773/18775）确实显示普通 Chat 输入框与已登录导航证据，无登录控件、无验证提示，project/account/task IDs 及提交标记保留。经现有 `open-task-conversation` 处理器导航后，原地址被带回 Chat 根页，未显示消息；因此只判登录保持 PASS，原会话恢复 FAIL。该次启动未再出现 MaxListenersExceededWarning，不能仅凭一次未重现就宣称所有慢页场景已修复。没有把空白根页的“未见回复”推翻为此前从未产生过真实回复，两项证据对应不同时间与页面。

## 回归结果

最终 `pnpm run validate`：**PASS**。contracts、main/renderer/tests TypeScript、ESLint、项目 fixture/IPC/contracts 边界、单元测试与 renderer/main 生产 build 全部通过。**59 files / 1165 tests**，**0 lint errors / 148 warnings**（原上限 149 未变）。新增生命周期 7 项、恢复安全 4 项；连同第一轮 profile 8 项均通过。既有 Vite >500 kB chunk 提示仍在；其他顶层依赖弃用提示未通过无关升级消除。没有待修的类型/测试/build 门禁失败；真实 Chat 状态缺口单独列 FAIL，门禁通过不替代平台全链验收。

最终日志：`artifacts/mac/round2/validate-final.log`。独立相关测试日志及各次失败也保留在同目录。没有为这轮添加或调用新的 AI/Computer-Use 模型来验收。

## 今后启动与安全退出

在本机终端执行：

```bash
cd /Users/zarkding/Documents/doubao-studio
source "$HOME/.nvm/nvm.sh"
nvm use 24.15.0
export PATH="$HOME/.local/share/doubao-studio-tools/pnpm-11.0.0/node_modules/.bin:$PATH"
pnpm run dev:mac
```

启动器先编译 contracts/main，再启动 loopback Vite 与 Electron；5173 被其他实例占用时自动选择实际空闲端口并传入 Electron。本轮为 5174，未杀占用 5173 的原实例。默认没有本机控制或 CDP；短时诊断才用 `pnpm run dev:mac --local-control --local-cdp-port=9334`，用后退出关闭入口。

Mac 红色关闭/Cmd+W 隐藏同一窗口；Dock 重开恢复同一 renderer/Webview。正常退出用 Cmd+Q 或原生菜单 Quit，也可在启动终端按 Ctrl+C。只在必要时针对当次 `[dev] launcher=...` 的 PID 使用 `kill -TERM <launcherPID>`，不要使用 `killall/pkill Electron/node`。退出后本机不会继续观察；不承诺合盖持续运行，也不承诺会话结束后维护进程。

本轮先后启动并停止的 launcher / Vite / Electron PID：14540/14549/14551、15001/15006/15008、15251/15254/15256、16354/16357/16359、16919/16922/16924、17441/17444/17446、18118/18128/18130、18767/18773/18775。中间的独立网络探测进程也已停止。最终一组按自己持有的 launcher PID 定向 SIGTERM 收尾；实查本轮剩余拥有进程 **0**、Electron 43 进程 **0**，5174/CDP 9334 均关闭，详见 `final-process-audit.json` 与状态文件。没有按名称杀进程。开始时的 Vite 7471、Electron 7474 及 7475/7476/7477 后代保持存活，未操作其他项目或应用。

## 证据与后续前置条件

本机详细证据位于被 Git 忽略的 `artifacts/mac/round2/`：`electron-upgrade.log`、各 network probe 及摘要、`webview-system-resolver.json`、持久化与 Session 重启 JSON、窗口身份回读和人工确认、`request-ledger.json`、`chat-real-response-proof.json`、`final-live-snapshot.json`、暂停恢复前后证据、文件读取证据和完整门禁日志。登录后仅保存过滤后的状态/数量/布尔判断，不保存聊天全文、凭据或完整签名媒体 URL；没有拍摄包含真实登录历史的截图。第一轮截图仅证明第一轮 GUI，不冒称 Electron 43 的截图。

下一步先核对未完成人工输入项目，定位原会话重开回到根页与间歇性慢加载，并修复/验证普通 Chat 提交确认及终态回读，继续坚持原会话、最多一次发送。需要追加新的真实请求必须由用户另行明确授权，本轮额度边界不自动重置。图片/视频必须先由当前官方入口确认免费权益与可选规格，并证明单次提交可保护，才可在后续轮次执行。现有 Chat 正文未保存为产物是独立缺口，不在本轮增加完整 JSON 提取器。

本轮到此停止，不自动开发后续业务或打包发布。普通 Chat 页面往返已实测通过；不能据此宣称完整任务完成、生成媒体、下载或视频播放链路通过。
