# 短剧工作室 · Figma Make 设计交接包

2026-11-02。本轮完成真实产品走查、操作取舍与下一阶段原型依据。**正式 UI、业务代码未修改；未提交／推送；未发起豆包文字、图片或视频任务，未采用或修改图片。** 原窗口已恢复 `ui-project` 的基础素材页，临时 Electron 与 Browser 已关闭。

## 上传哪些文件

将 `upload/` 中以下 **10 个文件** 一起附到 Figma Make，再发送第二份指令。不要上传整个仓库、`evidence/` 或正式项目目录。若视频附件受限，先附 01–09，10 作为可选样片另附；不要用网络图片替代。

| 文件 | 用途与来源 |
| --- | --- |
| [01_DESIGN_BRIEF.md](upload/01_DESIGN_BRIEF.md) | 产品规则、固定画布骨架、唯一设计方向、明确删除项、批准边界。 |
| [02_INTERACTION_MAP.md](upload/02_INTERACTION_MAP.md) | 四分类操作取舍、六阶段、完整状态、真实服务接线、七项实现差距；包含下面的截图边界。 |
| [03_SAMPLE_CONTENT.json](upload/03_SAMPLE_CONTENT.json) | 真实 6 镜项目的剧本、3 角色、3 道具、1 场景、7 基础素材、38 媒体元数据和全部镜头提示词；`content` 与 `uiState` 分离，代表镜头 sh03。 |
| [04_CURRENT_CANVAS.png](upload/04_CURRENT_CANVAS.png) | 本轮真实 Electron 隔离实例，1440×900 内容区、DPR 2、画布 59.7711%（界面四舍五入 60%）；展示左故事／素材与右四列骨架，保留 01–06 导航。源文件 `evidence/32-canvas-skeleton-1440.png`。 |
| [05_CURRENT_IMAGE_REVIEW.png](upload/05_CURRENT_IMAGE_REVIEW.png) | 真实图片预览／历史备选／当前采用对照与采用入口，1440×900、DPR 2；仅查看，没有采用。源文件 `15-image-history-review-1440.png`。 |
| [06_CURRENT_FEEDBACK.png](upload/06_CURRENT_FEEDBACK.png) | 真实“修改这张图片”弹窗，绑定 sh03 选中历史图片；空输入、未提交，1440×900、DPR 2。源文件 `16-image-feedback-1440.png`。 |
| [07_CHARACTER.png](upload/07_CHARACTER.png) | 真实项目已采用的 ch01 角色图。历史名字／物种／美术仅属此项目，不是新项目默认。 |
| [08_KEYFRAME.png](upload/08_KEYFRAME.png) | sh03 已采用首帧，真实原 PNG。 |
| [09_VIDEO_POSTER.png](upload/09_VIDEO_POSTER.png) | sh03 真实已选视频第 1 秒解码帧。 |
| [10_SAMPLE_VIDEO.mp4](upload/10_SAMPLE_VIDEO.mp4) | 同一真实历史视频，约 5.056 秒、720×1280；为可移植播放从 HEVC 转 H.264/AAC，无剪辑、无补帧、原音频保留。可选附件。 |

上传文件均为普通本地文件；JSON 使用白名单提取，无 Cookie、令牌、Session、账号标识、素材绝对路径、内部会话 URL 或签名下载地址。文件大小及哈希见 `evidence/upload-manifest.json`。完整正文未为排版缩写。

## 真实／模拟边界

1. **当前真实项目有两个，不能混用。** 会话开始的实窗为历史验收副本 `ui-project`：5 镜、8 媒体。完整样板来自用户已有桌面项目：6 镜、38 媒体，revision 734。先复制为 `evidence/sample-project/` 再查看，原项目未改；样板全部 6 镜导航保留。代表 sh03 的首帧／尾帧／视频正文分别为 334／374／431 字。
2. **04–06 是真实 Electron 截图。** 运行当前工作树 React 与现有编译主进程，通过原 Open 按钮、现有 IPC、校验和媒体读取打开真实副本。Playwright 仅一次性自动选择目录、点击正常控件、设置内容尺寸和截图，没有伪造项目或媒体、没有替换业务 API。临时 `mac-test` 不复制账号、任务或登录 Session，并阻断外部 HTTP。
3. **隔离限制必须识别。** 04 的“原任务／账号／项目／输入归属不符，停止且不重建”来自隔离实例缺少真实任务台账，不能作为原项目失败证据，也不是新原型必须照抄的状态。隔离账号页只有空态，平台页因网络阻断未加载，不冒称真实登录验收。
4. **原实例补齐真实播放。** 在原实例正常目录选择器打开同一副本，sh03 视频可读并实际播放到约 0:05，截图为 `evidence/40-native-canvas-sh03.png`、`41-native-video-playback.png`。真实提示“实际 5.04 秒，原请求 7 秒，请复核”被保留；不能称全项目完成。原生整窗截图保留标题栏，不冒称 1440×900 内容图；未直接读回的原窗 DPR／内容尺寸如实标记未知。
5. **Browser 失败未当作检查成功。** 优先尝试 Codex 内置 Browser；因缺 Electron preload，页面读取 `settings` 报错，未接受空白图为证据。随后使用用户允许的 Playwright Electron 与原生桌面能力。
6. **模拟只在 `preview/`。** 三类独立“设计模拟”状态：生成中、失败／提交未明、候选待采用，引用真实 sh03 和媒体 ID。没有计时假成功、生产 IPC 或项目回写。历史 candidate 字段已被当前采用图收束，不能冒充当前待处理候选。首批 upload 不含旧候选原文件时，只能用已附真实图片标明“候选界面投影”。

## 本地证据与用途

- [walkthrough.md](evidence/walkthrough.md)：按步骤列真实截图、操作事实、交互与可访问性问题及缺口；内嵌主要截图。
- [screenshot-manifest.json](evidence/screenshot-manifest.json)：每张图的真实／隔离边界、内容视口、DPR、画布 transform、哈希；失败尝试单独列为不接受。
- `12/19-canvas-*`：1440×900／1280×800 的 sh03 细节；`32/33-canvas-skeleton-*`：两个尺寸的骨架；`13/34-prompt-full-*`：真实完整正文。
- `14/15/18-image-*`、`16/17-image-feedback-*`：预览、历史选图、采用入口、反馈弹窗。历史图仅被查看，没有切换正式采用。
- `22/23-results-*`、`24/25-plan-*`、`26/27-materials-*`、`30/31-settings-*`：两个尺寸的当前页面。结果与方案处于既有状态，未伪造新候选。
- `42-native-accounts.png`：真实原实例账号页，含私人昵称及会话标题，**仅本地查看，禁止上传**。`28/29-accounts-*` 只证明隔离账号空态。
- [source-map.md](evidence/source-map.md)、[rules-current.md](evidence/rules-current.md)：更完整的源码行号、需求／OpenSpec／历史批准冲突与接线依据。
- [data-provenance.json](evidence/data-provenance.json)、[data-qa.json](evidence/data-qa.json)：内容来源、媒体哈希、转换、全部正文逐项核对与脱敏检查。
- `evidence/sample-project/`：可由本产品只读打开的本地真实副本，含历史服务 ID 与账号关联，**禁止上传**；上传数据只用已脱敏的 03。
- `qa-contact-sheet.png` 是本地缩略检查拼图，不是新截图，不替代各源图。未命名为成功的调试 PNG、原始 YAML 均只在本地留档。

## 尚缺材料与能力限制

- 没有本轮实际运行的文字／图片／视频生成中、正在修订、保存失败、登录／人机验证或受理未明流程证据。已在独立 preview 派生状态，未为补图发任务。
- 样板方案和提示词已采用，没有新的实时文字候选确认截图；真实完整正文截图已保存，候选确认依真实服务契约交接。
- 未真实执行上传、反馈提交、采用、重发、质量确认、下载重试；本轮只核查入口与源码接线。
- sh06 无媒体；sh05 仅首帧；sh01 历史视频未在 `selectedVideos` 明选；sh03 请求 7 秒而文件约 5 秒。历史媒体和当前正文不能一概称一致。
- 方案后台自然语言调整、全对象自动保存、成果原位质量确认、已有视频的显式重新生成等差距在 02 列明；Figma 原型不能把设计态说成当前已接通。
- Dola、P5 合成、配音、字幕、自动发布与模型 API 均未扩展或验收。

下一步：将上述 `upload/` 文件附到 Figma Make，再发送第二份指令，制作同一套可交互原型；获得新的明确批准后才实施正式 UI。
