import React from 'react';
import { Button, Checkbox, Tag } from 'antd';
import type { PetStoryReviewIssue } from '@doubao-studio/contracts';

/** 仅错误默认待修；建议和提醒只有用户明确勾选后才进入本次修订。 */
export const ReviewIssueSelection: React.FC<{
  issues: PetStoryReviewIssue[]; targetLabel: string; disabled: boolean; revised: boolean;
  onRevise: (selectedIssueIds: string[]) => Promise<void>;
}> = ({ issues, targetLabel, disabled, revised, onRevise }): React.ReactElement => {
  const [choices, setChoices] = React.useState<Record<string, boolean>>({});
  const selectedIssueIds = issues.filter((issue): boolean => choices[issue.id] ?? issue.severity === 'error').map((issue): string => issue.id);
  const blocked = disabled;
  return <div className="canvas-review-selection" aria-label={`${targetLabel}修订问题选择`}>
    <p className="canvas-hint">{targetLabel} · 默认只选择错误；提醒与建议需主动勾选。本次修订只处理所选问题，每个原请求最多一次自动修订；主动新一轮会保留上轮记录。</p>
    {issues.map((issue): React.ReactNode => <div className="canvas-review-issue" key={issue.id}>
      <Checkbox data-issue-id={issue.id} checked={selectedIssueIds.includes(issue.id)} disabled={blocked} onChange={(event): void => setChoices((previous): Record<string, boolean> => ({ ...previous, [issue.id]: event.target.checked }))}>
        <Tag color={issue.severity === 'error' ? 'orange' : 'blue'}>{issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '提醒' : '建议'}</Tag>{issue.impact}
      </Checkbox>
      <p>证据：{issue.evidence}</p><p>修订目标：{issue.requestedChange}</p>
    </div>)}
    <Button size="small" disabled={blocked || !selectedIssueIds.length} onClick={(): void => { if (!blocked && selectedIssueIds.length) void onRevise(selectedIssueIds); }}>{revised ? '主动开始新一轮修订（保留上轮）' : `修订所选 ${selectedIssueIds.length} 项问题`}</Button>
  </div>;
};
