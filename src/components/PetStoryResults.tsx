import React from 'react';
import { Alert, Button, Card, Empty, Space, Tag } from 'antd';
import type { PetStoryAsset, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, Task } from '@doubao-studio/contracts';
import { useTaskStore } from '../store/useTaskStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { journeyAssetMatchesPrompt, selectPetStoryJourney } from '../utils/petstoryJourney';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { navigateWorkspace } from '../utils/workspace';
import { pendingImageCandidates } from '../utils/petstoryImageCandidates';
import { CanvasMediaPreview } from './PetStoryCanvasMedia';

type ResultNavigate = (stage: PetStoryJourneyStage, shotId?: string, kind?: PetStoryPromptKind) => void;

function resultTask(project: PetStoryProject, shotId: string, kind: PetStoryPromptKind, asset: PetStoryAsset | undefined, tasks: Task[]): Task | undefined {
  const steps = [...(project.productionHistory || []).flatMap((production) => production.steps), ...(project.production?.steps || [])];
  const step = [...steps].reverse().find((item): boolean => item.shotId === shotId && item.kind === kind);
  const taskId = asset?.taskId || step?.taskId;
  const runId = asset?.taskId ? asset.runId : step?.runId;
  // 不把同一任务后续重跑的状态当作这个历史文件的来源事实。
  return tasks.find((task): boolean => task.id === taskId && !!runId && task.runtime?.runId === runId);
}

function resultGenerationLabel(asset: PetStoryAsset | undefined, task: Task | undefined, candidate: boolean, hasTaskRecord: boolean): string {
  if (task?.outputs.length) return '平台产物已读取';
  if (task?.status === 'done') return '任务已完成，产物待核对';
  if (task?.status === 'fail') return '任务失败，平台结果需核对';
  if (task?.status === 'generating') return '正在生成';
  if (task) return '任务待处理';
  if (asset?.taskId) return '已保存豆包产物';
  if (asset) return '用户上传图片';
  if (candidate) return '图片候选已保存';
  return hasTaskRecord ? '任务记录待核对' : '尚未开始';
}

function resultReviewReason(asset: PetStoryAsset, prompt: PetStoryPrompt | undefined): string {
  if (asset.needsReview) return '制作依据已更新，请复核这项成果；原文件已保留。';
  if (prompt?.needsReview) return '当前提示词仍有待复核问题，请先处理对应提示词。';
  if (asset.generationFinal === undefined) return '旧产物未记录对应提示词，不能确认与当前版本一致。';
  return asset.generationFinal !== prompt?.final ? '当前提示词已变化，此文件保留供查看。' : '文件尚无有效解码校验记录。';
}

const ResultAsset: React.FC<{ project: PetStoryProject; shotId: string; kind: PetStoryPromptKind; asset?: PetStoryAsset; prompt?: PetStoryPrompt; title: string; onContinue: () => void }> = ({ project, shotId, kind, asset, prompt, title, onContinue }): React.ReactElement => {
  const [preview, setPreview] = React.useState(false);
  const [feedback, setFeedback] = React.useState('');
  const tasks = useTaskStore((store) => store.tasks);
  const task = resultTask(project, shotId, kind, asset, tasks);
  const candidate = kind !== 'video' && pendingImageCandidates(project, { shotId, kind }, asset?.id).length > 0;
  const current = journeyAssetMatchesPrompt(asset, prompt);
  const hasTaskRecord = [...(project.productionHistory || []).flatMap((production) => production.steps), ...(project.production?.steps || [])].some((step): boolean => step.shotId === shotId && step.kind === kind && !!step.taskId);
  const generation = resultGenerationLabel(asset, task, candidate, hasTaskRecord);
  const locate = async (): Promise<void> => {
    if (!asset) return;
    try {
      const result = await window.electronAPI.petstory.revealAsset(project.id, asset.id);
      setFeedback(result.success ? '已在文件夹中定位此文件。' : result.error || '文件定位失败，请查看原任务下载情况。');
    } catch { setFeedback('文件定位失败，请查看原任务下载情况。'); }
  };
  return <section className="petstory-result-asset" aria-label={title}>
    <strong>{title}</strong>
    <dl className="petstory-result-facts"><div><dt>生成任务</dt><dd>{generation}</dd></div><div><dt>下载与保存</dt><dd>{asset ? '项目内文件已保存' : candidate ? '候选已保存，尚未采用' : '尚无项目内文件'}</dd></div><div><dt>文件校验</dt><dd>{asset?.validation?.decoded ? '文件校验通过' : asset ? '文件尚未校验' : '尚无可检查的采用文件'}</dd></div></dl>
    {!asset ? <><Button size="small" onClick={onContinue}>{candidate ? '查看并采用' : task?.outputs.length ? '查看下载与收取' : `去制作${title}`}</Button>{task && <Button type="link" size="small" onClick={(): void => openQualityTask(task)}>查看原任务</Button>}</> : <>
      <p className="my-2"><Tag color={current ? 'green' : 'orange'}>{current ? '对应当前内容' : '内容需要复核'}</Tag></p>
      {preview ? <CanvasMediaPreview project={project} asset={asset} name={title} /> : <Button size="small" onClick={(): void => setPreview(true)}>{asset.kind === 'video' ? '播放镜头视频' : '查看图片'}</Button>}
      {!current && <p className="my-2 canvas-error">{resultReviewReason(asset, prompt)}<Button type="link" size="small" onClick={onContinue}>核对并继续制作</Button></p>}
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
          <ResultAsset project={project} shotId={item.shot.id} kind="firstFrame" asset={item.firstFrame} prompt={item.shot.prompts.firstFrame} title="本镜首帧" onContinue={(): void => onNavigate('keyframes', item.shot.id, 'firstFrame')} />
          {(item.requiresLastFrame || item.lastFrame) && <ResultAsset project={project} shotId={item.shot.id} kind="lastFrame" asset={item.lastFrame} prompt={item.shot.prompts.lastFrame} title="本镜尾帧" onContinue={(): void => onNavigate('keyframes', item.shot.id, 'lastFrame')} />}
          <ResultAsset project={project} shotId={item.shot.id} kind="video" asset={item.video} prompt={item.shot.prompts.video} title="本镜视频" onContinue={(): void => onNavigate('videos', item.shot.id, 'video')} />
        </div>
        <Space wrap className="mt-3"><span>人工质量：{task?.qualityVerdict?.status === 'accepted' ? '已确认合格' : task?.qualityVerdict?.status === 'rejected' ? '已拒收，需处理' : '尚未确认'}</span>{task && <Button size="small" onClick={(): void => openQualityTask(task)}>查看原任务与质量确认</Button>}</Space>
      </Card>;
    })}
  </div>;
};
