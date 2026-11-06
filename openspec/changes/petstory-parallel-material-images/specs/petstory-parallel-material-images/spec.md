## Purpose

让创作者可以连续发起不同人物、道具和场景的图片生成或修改，各自拥有豆包对话和可恢复进度，避免独立素材互相等待或结果错绑，同时保留单图的精确修改依据与提交安全。

## ADDED Requirements

### Requirement: Independent material operations
系统 SHALL 允许不同基础素材同时拥有生成或修改流程，并分别显示准备、生成、保存、候选和失败状态。

#### Scenario: Multiple cards started
- **WHEN** 用户在A生成期间点击B生成或提交B的图片修改
- **THEN** B建立独立流程，其对话、结果和错误不覆盖A，平台生成等待可以重叠

### Requirement: Isolated conversation execution
每个活动图片操作 MUST 使用所属账号的独立豆包执行页面及明确绑定的任务对话；输入、上传和发送 SHALL 受短交互租约保护。

#### Scenario: Results finish out of order
- **WHEN** B先于A完成，或用户查看A的实际对话
- **THEN** 各结果仅保存到自己的素材，其他任务仍可继续观察原会话

#### Scenario: Independent page is still loading or fails
- **WHEN** 独立页面文档已就绪但输入区尚未挂载，或页面首载失败
- **THEN** 任务等待自己的真实输入区条件；首载失败或准备截止时仅暂停本任务并释放预留，不借用其他页面、增加重试或永久占用执行槽

#### Scenario: Concurrent availability probes finish out of order
- **WHEN** 同账号两个页面分别读到可用和页面未就绪，且探测乱序返回
- **THEN** 各任务只使用本页证据；真实登录或验证码仍保护所属账号，过期页面及旧验证代次不得重新开放调度

### Requirement: Same material exclusivity and exact image edits
同一素材的未结束操作 MUST 防止重复提交；修改 MUST 绑定用户所选具体基图、摘要及反馈，连续修改继承选定的上一候选。

#### Scenario: Repeated and continued edit
- **WHEN** 用户重复点击同一素材，或在上一轮结果生成后继续修改该结果
- **THEN** 重复点击不产生额外发送，新的修改使用选定结果且保留历史图片

### Requirement: Operation scoped recovery
单项失败、暂停、重开、下载重试及显式重发 SHALL 只影响关联操作，已受理或受理不明的原任务 MUST 继续原核对和授权规则。

#### Scenario: One failed operation recovers
- **WHEN** A下载失败而B仍在生成，用户继续A
- **THEN** 仅补A的下载或观察原结果，B不停顿且没有重复平台提交

#### Scenario: Released waiting tasks do not consume material capacity
- **WHEN** 两项任务在发送前失败并释放锁，另外的素材仍排队
- **THEN** 排队素材可使用空闲执行槽；原失败项单独恢复，同素材及真实账号验证保护继续有效

#### Scenario: Dispatch pauses before page authorization
- **WHEN** 原任务在项目运行绑定前明确暂停，用户打开原项目后继续
- **THEN** 正式服务核对原任务、输入和零提交证据后沿同一任务恢复；已有提交、受理不明或归属不符的记录不得走未提交恢复入口

### Requirement: Compatible project transactions
系统 MUST 保留项目串行持久化和旧项目兼容，无关素材上传与明确采用 SHALL 不受其他素材生成阻塞。

#### Scenario: Concurrent starts and adoption
- **WHEN** 用户快速开始A、B并采用C的候选
- **THEN** 操作及采用均保留，版本更新不丢失数据，现有视频和真实素材依赖仍有效
