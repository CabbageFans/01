import React, { useEffect, useState } from 'react';
import { Alert, Button, Modal, Radio } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
import type { PetStoryProject, PetStoryRuntimeTarget, PetStoryAdjustmentPreview } from '@doubao-studio/contracts';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { PetStoryPlanPreview } from './PetStoryPlanPreview';
import { pendingPetStoryDrafts } from '../utils/petstoryDraftPresence';
import '../styles/petstory-chat-adjustment.css';

function targetName(p: PetStoryProject, target: PetStoryRuntimeTarget): string {
  if (target.materialId) return `${p.materials?.find((m): boolean => m.id === target.materialId)?.name || '基础素材'} · 图片提示词`;
  if (target.shotId) return `镜头 ${p.plan?.shots.find((s): boolean => s.id === target.shotId)?.order || ''} · ${{ firstFrame: '首帧提示词', lastFrame: '尾帧提示词', video: '视频提示词' }[target.promptKind || 'video']}`;
  return '故事理解与分镜方案';
}
/** 仅提取展示摘要；网页回读的原始正文仍由正式预览和采用服务核对。 */
function replyObjects(text: string): Record<string, unknown>[] {
  const objects = new Map<string, Record<string, unknown>>();
  const collect = (body: string): void => {
    try {
      const value: unknown = JSON.parse(body);
      if (value && typeof value === 'object' && !Array.isArray(value)) objects.set(JSON.stringify(value), value as Record<string, unknown>);
    } catch { /* 语言标签与自然语言不是创作数据。 */ }
  };
  collect(text.trim());
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) collect(match[1]);
  let start = -1; let depth = 0; let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (start < 0) { if (character === '{') { start = index; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) { collect(text.slice(start, index + 1)); start = -1; }
  }
  return [...objects.values()];
}
function replyContent(text: string): string {
  const objects = replyObjects(text);
  const needsOrganization = '这条回复尚未整理为可预览的创作内容，请在豆包中要求整理当前对象的完整方案或提示词。';
  if (objects.length > 1) return needsOrganization;
  if (objects.length === 1) {
    const answer = objects[0];
    if (typeof answer.optimized === 'string') return answer.optimized;
    const lines: string[] = [];
    for (const field of ['understanding', 'sceneDesign']) if (typeof answer[field] === 'string') lines.push(answer[field] as string);
    if (Array.isArray(answer.shots)) for (const shot of answer.shots) {
      if (!shot || typeof shot !== 'object') continue;
      const item = shot as Record<string, unknown>;
      lines.push([typeof item.order === 'number' ? `镜头 ${item.order}` : '', item.title, item.scene, item.action, item.description].filter((value): value is string => typeof value === 'string' && !!value).join(' · '));
    }
    if (lines.length) return lines.join('\n\n');
    return needsOrganization;
  }
  return text;
}

const AdjustmentRestoreNotice: React.FC = (): React.ReactElement | null => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((value) => value.tasks); const accountId = useAccountStore((value) => value.selectedAccountId);
  const protectedTask = tasks.find((task): boolean => task.assignedAccountId === accountId && task.runtime?.chatAdjustmentGuard?.active === true);
  return protectedTask ? <section className="petstory-adjustment" aria-label="未结束的创作调整"><strong>这个账号还有未结束的创作调整</strong><p>打开原短剧项目，继续交流并采用回复，或结束调整后再制作。</p><Button size="small" onClick={(): void => { void state.openProject(); }}>打开原短剧项目</Button></section> : null;
};

/** 在真实豆包网页旁选择具体回复；所有发送仍在该网页完成。 */
const PetStoryChatAdjustmentPanel: React.FC = (): React.ReactElement | null => {
  const state = usePetStoryStore(); const p = state.project; const a = p?.chatAdjustment;

  const [application, setApplication] = useState<PetStoryAdjustmentPreview | null>(null); const [previewLoading, setPreviewLoading] = useState(false);
  const [choosing, setChoosing] = useState(false); const [selectedKey, setSelectedKey] = useState<string>(); const [preview, setPreview] = useState(false);
  useEffect((): void => { setSelectedKey(undefined); setChoosing(false); setPreview(false); setApplication(null); }, [a?.id]);
  const selected = a?.replies.find((reply): boolean => reply.key === selectedKey);
  const draftLabels = p ? pendingPetStoryDrafts(p.id) : [];
  if (!p || a?.status !== 'active') return <AdjustmentRestoreNotice />;
  const target = targetName(p, a.target);
  const body = application?.body ?? (selected ? replyContent(selected.text) : '');
  const question = !!body && body.length < 100 && /[？?]\s*$/.test(body);
  const openPreview = async (): Promise<void> => {
    if (!selected) return;
    setPreviewLoading(true);
    try { const value = await state.previewChatReply(selected.key); if (value) { setApplication(value); setPreview(true); } }
    catch (error: unknown) { usePetStoryStore.setState({ error: error instanceof Error ? error.message : '回复预览未准备好' }); }
    finally { setPreviewLoading(false); }
  };
  const apply = async (): Promise<void> => {
    if (!selected) return;
    await state.adoptChatReply(selected.key);
    if (usePetStoryStore.getState().project?.chatAdjustment?.status === 'adopted') { setPreview(false); setChoosing(false); }
  };
  return <section className="petstory-adjustment" aria-label="当前创作的豆包调整">
    <div className="adjustment-target"><MessageOutlined /><div><small>正在调整</small><strong>{target}</strong></div><Button type="text" size="small" disabled={state.busy} onClick={(): void => { void state.endChatAdjustment(); }}>结束调整</Button></div>
    <p>在豆包中自由交流，选中满意的具体回复后应用。</p>
    {state.chatReadbackError && <p role="status" className="adjustment-readback">{state.chatReadbackError}</p>}
    <div className="adjustment-actions"><Button size="small" onClick={(): void => { window.dispatchEvent(new CustomEvent('petstory-open-adjustment')); }}>打开关联会话</Button><Button type="primary" size="small" disabled={!a.replies.length || state.busy} onClick={(): void => setChoosing(true)}>选择回复{a.replies.length ? ` · ${a.replies.length}` : ''}</Button></div>
    <Modal title={`选择用于「${target}」的回复`} open={choosing && !preview} width={680} onCancel={(): void => setChoosing(false)} footer={<><Button onClick={(): void => setChoosing(false)}>返回对话</Button><Button type="primary" loading={previewLoading} disabled={!selected || state.busy} onClick={(): void => { void openPreview(); }}>应用到当前创作</Button></>}>
      <p className="adjustment-note">选择完整的助手回复。网页只读取当前会话中可辨认的回复；找不到时，请在豆包中滚动到该回复。</p>
      {state.error && <Alert type="error" showIcon message={state.error} />}
      <Radio.Group className="adjustment-replies" value={selectedKey} onChange={(event): void => setSelectedKey(event.target.value as string)}>
        {a.replies.map((reply, index): React.ReactElement => <label key={reply.key} className={`adjustment-reply ${selectedKey === reply.key ? 'is-selected' : ''}`}><Radio value={reply.key}>豆包回复 {index + 1}</Radio><p>{replyContent(reply.text)}</p></label>)}
      </Radio.Group>
    </Modal>
    <Modal title="确认应用这条回复" open={preview} width={880} onCancel={(): void => setPreview(false)} footer={<><Button onClick={(): void => setPreview(false)}>重新选择</Button><Button type="primary" loading={state.busy} disabled={!selected || !!draftLabels.length || question} onClick={(): void => { void apply(); }}>确认采用此回复</Button></>}>
      <div className="adjustment-apply-target">应用到：<strong>{target}</strong></div>
      <div className="adjustment-comparison"><section><h3>当前采用</h3>{application?.previousPlan ? <PetStoryPlanPreview plan={application.previousPlan} contentBasis={application.previousContentBasis} /> : <pre>{application?.previousBody || a.previousText || '尚无采用正文'}</pre>}</section><section><h3>选中的豆包回复</h3>{application?.plan ? <PetStoryPlanPreview plan={application.plan} contentBasis={application.contentBasis} /> : <pre>{body}</pre>}</section></div>
      {question && <Alert type="warning" showIcon message="这条回复包含追问，请在豆包中整理为完整方案或提示词后再采用" />}
      {!!draftLabels.length && <Alert type="warning" showIcon message="还有未保存的修改，请先保存或放弃，再采用回复" description={draftLabels.join('、')} />}
      {state.error && <Alert type="error" showIcon message={state.error} />}
    </Modal>
  </section>;
};
export default PetStoryChatAdjustmentPanel;
