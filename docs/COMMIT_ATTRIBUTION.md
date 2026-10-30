# 提交署名与 Contributors

2026-10-30，用户要求不再将 `dorakoo` 列入本仓库 Contributors。核对默认分支原始作者、提交者和共同作者字段，没有该账号署名；GitHub Contributors REST 接口当前仅返回 `CabbageFans`（8 次贡献）。旧上游提交已经使用 `Upstream contributors <upstream@contributors.invalid>`，本轮不再改写历史或重新分配这些贡献。

Contributors 是 GitHub 根据默认分支提交统计的结果，不能作为人工名单编辑。历史调整后的统计可能需要约 24 小时刷新；若仍有旧数据显示，由仓库所有者联系 GitHub Support。参见 [GitHub Contributors 文档](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors#contributor-data-is-stale-after-history-changes)。

## 后续约束

- `AGENTS.md` 固定署名规则。`scripts/check-commit-attribution.mjs` 检查原始作者、提交者、邮箱和 `Co-authored-by`，大小写和全角字符规范化后拒绝 `dorakoo`。检查不依赖 `.mailmap`，不更改版权、来源说明或旧 PR 链接。
- `.githooks` 在提交前检查当前身份，提交消息阶段检查共同作者，推送前检查每个待推送引用的完整历史。新克隆需要执行 `git config --local core.hooksPath .githooks`；本工作区已启用。
- GitHub Actions `Commit attribution` 使用完整历史检查。默认分支配置同名必过检查，来源限定 GitHub Actions，无绕过账号。后续代码先推送 `codex/` 分支并创建 PR，等待检查通过再合入 `main`。
- 当前工作区提交身份配置为 `CabbageFans <43812560+CabbageFans@users.noreply.github.com>`。其他真实贡献者使用自己的身份，不冒用维护者。

这套检查阻止已知账号字符串和邮箱署名进入默认分支。GitHub 账号以后新增其他关联邮箱、仓库管理员主动修改规则等情况不在字符串检查保证范围内；变更身份策略时必须重新核对实际 GitHub 关联，不能宣称平台提供了永久排除某个 Contributors 账号的开关。

本轮图片功能验收见 [MATERIAL_IMAGE_FEEDBACK_REPORT.md](./MATERIAL_IMAGE_FEEDBACK_REPORT.md)。推送代码不会创建版本 Tag、Release 或启动 P5。
