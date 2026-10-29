import React, { useState } from 'react';
import { Alert, Button, Modal, Select } from 'antd';
import type { PetStoryMediaCandidate, PetStoryProject, PetStoryPromptKind, PetStoryShot } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';

/** 只关联已完成且经服务核验的原任务文件；此入口不具备模型发送能力。 */
export const PetStoryExistingMediaPicker: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean }> = ({ project, shot, kind, disabled }): React.ReactElement => {
  const [open, setOpen] = useState(false); const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<PetStoryMediaCandidate[]>([]); const [selected, setSelected] = useState<string>(); const [error, setError] = useState('');
  const state = usePetStoryStore();
  const load = async (): Promise<void> => {
    setOpen(true); setLoading(true); setError(''); setCandidates([]); setSelected(undefined);
    try {
      const result = await window.electronAPI.petstory.listExistingMediaCandidates(project.id, shot.id, kind);
      if (!result.success) setError(result.error || '原任务核验失败');
      else { setCandidates(result.candidates || []); if (result.candidates?.length === 1) setSelected(result.candidates[0].artifactId); }
    } catch { setError('暂时无法读取原任务产物'); }
    finally { setLoading(false); }
  };
  const link = async (): Promise<void> => {
    const candidate = candidates.find((item): boolean => item.artifactId === selected); if (!candidate) return;
    await state.linkExistingMedia(shot.id, kind, candidate.taskId, candidate.artifactId);
    const current = usePetStoryStore.getState();
    if (current.error) setError(current.error);
    else if (current.project?.assets.some((asset): boolean => asset.shotId === shot.id && asset.taskId === candidate.taskId && asset.artifactId === candidate.artifactId)) setOpen(false);
  };
  return <><Button className="canvas-history-button" size="small" disabled={disabled} onClick={(): void => { void load(); }}>读取已有豆包{kind === 'video' ? '视频' : '图片候选'}</Button><Modal title={`镜头 ${shot.order} · 关联已有豆包产物`} open={open} onCancel={(): void => setOpen(false)} onOk={(): void => { void link(); }} okText={kind === 'video' ? '关联原视频' : '保存为图片候选'} confirmLoading={state.busy} okButtonProps={{ disabled: !selected || loading || disabled }}>
    <p>只显示与本镜当前或历史正文、原账号及素材引用精确对应，并已下载的真实产物。当前图片和提示词保持不变；图片读取后还需预览并采用。</p>
    {error && <Alert type="error" message={error} />}
    <Select className="w-full" aria-label="选择已核验的豆包原任务产物" loading={loading} value={selected} onChange={(value: string): void => setSelected(value)} placeholder={loading ? '正在核验原任务与文件…' : '选择已核验的原任务'} options={candidates.map((item, index): { value: string; label: string } => ({ value: item.artifactId, label: `${new Date(item.createdAt).toLocaleString('zh-CN')} · 产物 ${index + 1}` }))} />
    {!loading && !error && !candidates.length && <p>没有可精确归属的已下载产物。此操作不会新建生成或下载任务。</p>}
  </Modal></>;
};
