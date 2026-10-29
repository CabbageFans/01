import React from 'react';
import { Alert, Button, Card, Empty, Space, Tag } from 'antd';
import type { PetStoryAsset, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, Task } from '@doubao-studio/contracts';
import { useTaskStore } from '../store/useTaskStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { journeyAssetMatchesPrompt, selectPetStoryJourney } from '../utils/petstoryJourney';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { navigateWorkspace } from '../utils/workspace';
import { CanvasMediaPreview } from './PetStoryCanvasMedia';

type ResultNavigate = (stage: PetStoryJourneyStage, shotId?: string, kind?: PetStoryPromptKind) => void;

const ResultAsset: React.FC<{ project: PetStoryProject; asset?: PetStoryAsset; prompt?: PetStoryPrompt; title: string; onContinue: () => void }> = ({ project, asset, prompt, title, onContinue }): React.ReactElement => {
  const [preview, setPreview] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const current = journeyAssetMatchesPrompt(asset, prompt);
  const locate = async (): Promise<void> => {
    if (!asset) return;
    try {
      const result = await window.electronAPI.petstory.revealAsset(project.id, asset.id);
      setFeedback(result.success ? '已在文件夹中定位此文件。' : result.error || '文件定位失败，请查看原任务下载情况。');
    } catch { setFeedback('文件定位失败，请查看原任务下载情况。'); }
  };
  return <section className="petstory-result-asset" aria-label={title}>
    <strong>{title}</strong>
    {!asset ? <><p className="my-3 text-gray-400">尚无实际本地文件。</p><Button size="small" onClick={onContinue}>去制作{title}</Button></> : <>
      <p className="my-2"><Tag color={current ? 'green' : 'orange'}>{current ? '对应当前内容' : '内容需要复核'}</Tag><Tag>{asset.validation?.decoded ? '文件校验通过' : '文件尚未校验'}</Tag></p>
      {preview ? <CanvasMediaPreview project={project} asset={asset} name={title} /> : <Button size="small" onClick={(): void => setPreview(true)}>{asset.kind === 'video' ? '播放镜头视频' : '查看图片'}</Button>}
      {!current && <p className="my-2 canvas-error">{asset.generationFinal === undefined ? '旧产物未记录对应提示词，不能确认与当前版本一致。' : asset.generationFinal !== prompt?.final ? '当前提示词已变化，此文件保留供查看。' : prompt?.needsReview ? '当前提示词仍有待复核问题，请先处理对应提示词。' : '文件尚无有效解码校验记录。'}<Button type="link" size="small" onClick={onContinue}>核对并继续制作</Button></p>}
      <details className="petstory-secondary-tools"><summary>提示词与文件详情</summary><p>项目内位置：{asset.relativePath}</p>{prompt && <pre className="prompt-readonly">{prompt.final || '尚无已采用提示词'}</pre>}{asset.validation && <p>文件检查：{asset.validation.width} × {asset.validation.height}{asset.validation.durationSeconds ? ` · ${asset.validation.durationSeconds.toFixed(2)} 秒` : ''}</p>}{asset.needsReview && <p>参考素材已更新，请核对这项成果。</p>}</details>
      <Button size="small" onClick={(): void => { void locate(); }}>在文件夹中定位</Button>{feedback && <p role="status" className="mt-2">{feedback}</p>}
    </>}
  </section>;
};

function openQualityTask(task: Task): void {
  navigateWorkspace('tasks');
  window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: task.id } }));
}

/** 最终页汇总逐镜本地素材；生成批次完成、解码通过和人工质量是不同事实。 */
export const PetStoryResults: React.FC<{ project: PetStoryProject; onNavigate: ResultNavigate }> = ({ project, onNavigate }): React.ReactElement => {
  const tasks = useTaskStore((store) => store.tasks);
  const state = usePetStoryStore();
  const [feedback, setFeedback] = React.useState('');
  const journey = selectPetStoryJourney(project, tasks);
  const { counts } = journey;
  const revealProject = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.petstory.revealProject(project.id);
      setFeedback(result.success ? '已打开当前短剧目录。' : result.error || '项目目录暂时无法打开。');
    } catch { setFeedback('项目目录暂时无法打开，请重新打开项目后重试。'); }
  };
  if (!journey.shots.length) return <Empty description="还没有分镜方案。请先保存剧本、查看分析结果并采用方案。"><Button onClick={(): void => onNavigate('plan')}>查看并确认方案</Button></Empty>;
  return <div className="space-y-4" aria-label="逐镜实际成果">
    <Card size="small" title="逐镜素材成果">
      <p>查看每个镜头的关键帧与视频。当前交付逐镜素材，人工质量确认请以实际画面和声音为准。</p>
      <Space wrap className="my-3 petstory-result-summary">
        <Tag>基础图片确认 {counts.materials.confirmed}/{counts.materials.total}</Tag>
        <Tag>当前关键帧 {counts.keyframes.current}/{counts.keyframes.total}</Tag>
        <Tag>视频已保存 {counts.videos.present}/{counts.videos.total}</Tag>
        <Tag>视频文件校验记录 {counts.videos.validated}/{counts.videos.total}</Tag>
        <Tag>人工质量合格 {counts.quality.confirmed}/{counts.quality.total}</Tag>
      </Space>
      <details className="petstory-secondary-tools"><summary>提示词与对应情况</summary><p>已保存提示词 {counts.prompts.saved}/{counts.prompts.total} · 新候选 {counts.prompts.candidates} · 待复核 {counts.prompts.needsReview} · 视频对应当前正文 {counts.videos.current}/{counts.videos.total}</p></details>
      {journey.stage !== 'results' && <Alert type="info" showIcon message={journey.reason} action={<Button size="small" onClick={(): void => onNavigate(journey.stage)}>继续缺失项</Button>} />}
      <Space wrap className="mt-3"><Button onClick={(): void => { void revealProject(); }}>打开成果文件夹</Button><Button disabled={state.busy} onClick={(): void => { void state.exportPrompts(); }}>导出提示词与素材清单</Button></Space>
      {feedback && <p role="status" className="mt-2">{feedback}</p>}{state.exportStatus && <p role="status" className="mt-2">{state.exportStatus}</p>}
    </Card>
    {journey.shots.map((item): React.ReactNode => {
      const task = tasks.find((candidate): boolean => candidate.id === item.video?.taskId && candidate.runtime?.runId === item.video?.runId);
      return <Card size="small" key={item.shot.id} title={`镜头 ${item.shot.order} · ${item.shot.scene}`}>
        <p className="mb-3">{item.shot.action}</p>
        {item.missing.length > 0 && <p className="mb-3 canvas-error">待处理：{item.missing.join('；')}</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <ResultAsset project={project} asset={item.firstFrame} prompt={item.shot.prompts.firstFrame} title="本镜首帧" onContinue={(): void => onNavigate('keyframes', item.shot.id, 'firstFrame')} />
          {(item.requiresLastFrame || item.lastFrame) && <ResultAsset project={project} asset={item.lastFrame} prompt={item.shot.prompts.lastFrame} title="本镜尾帧" onContinue={(): void => onNavigate('keyframes', item.shot.id, 'lastFrame')} />}
          <ResultAsset project={project} asset={item.video} prompt={item.shot.prompts.video} title="本镜视频" onContinue={(): void => onNavigate('videos', item.shot.id, 'video')} />
        </div>
        <Space wrap className="mt-3"><span>人工质量：{task?.qualityVerdict?.status === 'accepted' ? '已确认合格' : task?.qualityVerdict?.status === 'rejected' ? '已拒收，需处理' : '尚未确认'}</span>{task && <Button size="small" onClick={(): void => openQualityTask(task)}>查看原任务与质量确认</Button>}</Space>
      </Card>;
    })}
  </div>;
};
