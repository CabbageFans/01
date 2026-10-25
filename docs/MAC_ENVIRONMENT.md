# Mac 本机环境记录

检测日期：2026-10-23（Asia/Shanghai）。本轮后续验证复用此记录，不重复整套探测。

| 项目 | 实际结果 |
| --- | --- |
| 工作区 | `/Users/zarkding/Documents/doubao-studio` |
| origin | `https://github.com/dorakoo/doubao-studio.git` |
| HEAD / 已审查基线 | `7eeb7b67a518e47ee4296c36e5c5f17942a9cff0` / v2.3.8，完全一致 |
| 分支 | `main`，沿用当前分支，未切换、未克隆 |
| 开始时已有改动 | `main/main.ts`：macOS 原生标题栏；保留，原始 diff 保存于忽略的 `artifacts/mac/pre-existing-main.patch` |
| macOS | 15.3.1，build 24D70，Darwin 24.3.0 |
| CPU / 当前进程 | Apple Silicon / arm64；`hw.optional.arm64=1`；`sysctl.proc_translated=0`，未通过 Rosetta |
| Node | 24.15.0，`/Users/zarkding/.nvm/versions/node/v24.15.0/bin/node`；`process.platform=darwin`，`process.arch=arm64` |
| npm | 11.12.1，`/Users/zarkding/.nvm/versions/node/v24.15.0/bin/npm` |
| 原有 pnpm | 10.33.2，`/Users/zarkding/.nvm/versions/node/v24.15.0/bin/pnpm`，保持原样 |
| 本轮选用 pnpm | 固定 11.0.0，与 CI 的主版本一致；用户级独立安装于 `~/.local/share/doubao-studio-tools/pnpm-11.0.0/node_modules/.bin/pnpm` |
| 版本管理器 | 复用已有 nvm，`~/.nvm/nvm.sh` 存在；未覆盖系统 Node、未重装 npm、未使用 sudo |
| Git | `/usr/bin/git`，2.39.5 (Apple Git-154) |
| 工作区可用空间 | 首次检查约 52 GiB |
| Command Line Tools | NOT TESTED：安装无需编译原生模块，未额外探测或安装 |

以下变量均 **absent**：`ELECTRON_RUN_AS_NODE`、`ELECTRON_SKIP_BINARY_DOWNLOAD`、`VITE_DEV_SERVER_URL`、`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及上述代理变量的小写版本。未输出完整环境或任何代理值。

已读取：真实的 `AGENTS.md`、完整 `README.md`、`package.json`、锁文件（配置/importer/锁定包版本）、`pnpm-workspace.yaml`、`.npmrc`、CI 与 Windows Release 工作流、开发启动器。`allowBuilds` 仅放行 electron/esbuild，保持原样。AGENTS.md 无作者 Windows 绝对路径；未搜索用户磁盘。

第二轮变更（2026-10-23）：Electron 从已结束维护的 **33.4.11** 单独升级并精确锁定为 **43.8.3**，实际二进制为 Mach-O arm64；Node、npm、pnpm 和其他顶层依赖版本不变。锁文件仅调整 Electron 及其传递依赖，`allowBuilds` 仍仅允许 electron/esbuild。用户登录前已完成升级、sandbox 与 IPC 回归。

官方 [发布时间表](https://releases.electronjs.org/schedule)（2026-10-23 查阅）显示：33 于 2025-04-28 结束维护，43 是当日仍受支持的最早主版本，计划于 2027-01-05 结束维护（暂定）。[43.8.3 发布说明](https://github.com/electron/electron/releases/tag/v43.8.3)包含 Chromium/V8 等安全修复回移；固定版本不代表永久安全，后续真实使用仍需跟进该分支补丁与维护期限。

本机网络事实：宿主 curl 的 IPv4 可达、证书校验成功；IPv6 探测超时。Electron 43 默认解析配置仍出现 `ERR_SOCKET_NOT_CONNECTED (-15)`。隔离对照后，仅在本应用 Mac 分支使用系统解析器及 Happy Eyeballs（`enableBuiltInResolver:false`、`enableHappyEyeballs:true`），真实普通 Chat 页面与资源可加载，并收到一次真实回复。此为应用内兼容配置，没有修改系统 DNS、代理、VPN、hosts 或证书策略。日志仍有部分后台连接错误，不能据此宣称所有平台资源永久可达。

固定 profile 仍为 `/Users/zarkding/Library/Application Support/DoubaoStudioDevelopment/mac-dev`，`userData` / `sessionData` 均复用这里；用户已在此手动登录一个本人账号，真实重启后保持登录。未导入其他应用 Cookie。宿主 BrowserWindow 已启用 `sandbox:true`；远程 guest 保持无 Node、隔离上下文与默认 webSecurity。实际第二轮验收见 [MAC_SMOKE_TEST_REPORT.md](MAC_SMOKE_TEST_REPORT.md)，当前机器可读状态见 [MAC_BASELINE_STATUS.json](MAC_BASELINE_STATUS.json)。第一轮 [MAC_BOOTSTRAP_REPORT.md](MAC_BOOTSTRAP_REPORT.md) 保留当时的历史结果。

网络追加复测（同日 22:16 起）：用户报告已处理网络。工具链与 profile 均未改变、未重新安装依赖；本机公开 Chat 首页 curl HTTP 200 / SSL verify 0，实际首页与登录态可加载。旧会话重开仍回根页，本次新增文字任务发送后未观察到页面受理，已安全暂停。22:36 后原生 GUI 工具明确报告 Mac 已锁屏，焦点与 GUI 后续实测因此 BLOCKED，需用户手动解锁；该临时状态不当作系统配置或应用永久缺陷。


2026-10-24 复测变化事实：本机 GUI 已解锁；Node/pnpm/Electron/架构/profile 不变，未重装依赖或重跑整套环境探测。当前实际 Vite 使用 127.0.0.1:5173（上一日原占用进程在本次开始前已消失）。原登录 Session 跨日及真实 Cmd+Q 重启后可用；普通文字本次真实回复及本地 done 均通过，原会话可重开。一次重新加载根页仍耗时约 78 秒，不能声明网络长期稳定；没有改变系统网络配置。官方 Electron 43 维护状态于本日复核，维护期限仍为暂定 2027-01-05。原生工具结束后绑定已释放，本次进程及短时 CDP 均关闭，详见最新 smoke 报告与状态文件。
