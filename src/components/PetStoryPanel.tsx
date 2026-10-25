import React, { useEffect, useState, useRef } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Input, InputNumber, Select, Space, Tag, Typography, Tabs, ConfigProvider, Empty } from 'antd';
import type { PetStoryPlan, PetStoryShot, PetStoryPrompt, PetStoryPromptKind, PetStoryCharacter, PetStoryProject } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useProjectStore } from '../store/useProjectStore';
import { navigateWorkspace } from '../utils/workspace';
import { useAccountStore } from '../store/useAccountStore';
import { mobileStoryPrompt } from '../utils/petstoryPrompts';

const { Text, Title } = Typography;
const { TextArea } = Input;
const promptLabels: Record<PetStoryPromptKind, string> = { firstFrame: '首帧', lastFrame: '尾帧', video: '视频' };
function blankPrompt(): PetStoryPrompt {
  return { original: '', optimized: '', final: '', edited: true, rulesVersion: 'manual' };
}
function renumber(shots: PetStoryShot[]): PetStoryShot[] {
  // 保留原连续引用；增删排序后若引用失效，保存时明确报错，不暗改故事或切镜。
  return shots.map((s: PetStoryShot, index: number): PetStoryShot => ({ ...s, order: index + 1 }));
}
const ReferenceImage: React.FC<{ projectId: string; assetId: string; name: string }> = ({ projectId, assetId, name }): React.ReactElement => {
  const [data, setData] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData('');
    setError('');
    void window.electronAPI.petstory.readReference(projectId, assetId).then((result): void => {
      if (!active) return;
      if (result.success && result.data) setData(result.data);
      else setError(result.error || '参考图无法读取');
    }).catch((): void => { if (active) setError('参考图读取失败'); });
    return (): void => { active = false; };
  }, [projectId, assetId]);
  return data ? <img src={data} alt={`${name}项目参考图`} className="w-20 h-20 object-contain rounded bg-gray-950" /> : <Text type="secondary">{error || '读取参考图…'}</Text>;
};
function canAnalyzeStory(project: PetStoryProject, freeConfirmed: boolean): boolean {
  return !!project.mobileStory && freeConfirmed && !project.jobs.some((job): boolean => job.kind === 'analysis' && job.sourceUrl === project.source.url && job.sourceStoryId === project.mobileStory?.id);
}
const MobileStoryInput: React.FC<{ project: PetStoryProject; disabled: boolean; linkUnsaved: boolean; onDirtyChange: (dirty: boolean) => void }> = ({ project: p, disabled, linkUnsaved, onDirtyChange }): React.ReactElement => {
  const save = usePetStoryStore((state) => state.saveMobileStory);
  const [storyText, setStoryText] = useState(p.mobileStory?.text || '');
  const [copyState, setCopyState] = useState('');
  useEffect((): void => { setStoryText(p.mobileStory?.text || ''); setCopyState(''); }, [p.id, p.mobileStory?.text]);
  useEffect((): void => { onDirtyChange(storyText !== (p.mobileStory?.text || '')); }, [storyText, p.mobileStory?.text, onDirtyChange]);
  const phonePrompt = p.source.url ? mobileStoryPrompt(p) : '';
  const copyPhonePrompt = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(phonePrompt); setCopyState('已复制，请在手机豆包粘贴发送，再将故事情节复制回来。'); }
    catch { setCopyState('未能复制，请从下面的提示词框手动选择复制。'); }
  };
  return (
        <div className="mt-4 space-y-2">
          <Text strong>1. 在手机豆包取得故事情节</Text>
          <div><Text type="secondary">保存链接后，复制下方提示词到手机豆包发送。取得故事后请对照原视频核对，再复制回来。桌面端不再尝试读取抖音视频。</Text></div>
          <Button disabled={disabled || !phonePrompt || linkUnsaved} onClick={(): void => { void copyPhonePrompt(); }}>复制手机豆包提示词</Button>
          {copyState && <div role="status"><Text type="secondary">{copyState}</Text></div>}
          {phonePrompt && <TextArea aria-label="手机豆包提示词" readOnly value={phonePrompt} autoSize={{ minRows: 3, maxRows: 6 }} />}
          <div><Text strong>2. 粘贴手机豆包返回的故事情节</Text></div>
          <TextArea readOnly={disabled} aria-label="手机豆包故事原文" value={storyText} onChange={(e): void => setStoryText(e.target.value)} autoSize={{ minRows: 5, maxRows: 12 }} maxLength={50_000} showCount placeholder="粘贴完整故事情节，包括开头、关键变化和结局；普通文本即可，无需 JSON。" />
          <Button disabled={disabled || !p.source.url || linkUnsaved || !storyText.trim() || storyText === p.mobileStory?.text} onClick={(): void => { void save(storyText); }}>保存故事情节</Button>
          {p.mobileStory && <Tag color="green">手机故事原文已保存</Tag>}
        </div>
  );
};
const ProductionImageChoice: React.FC<{ project: PetStoryProject; stepId: string }> = ({ project, stepId }): React.ReactElement | null => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((s) => s.tasks);
  const step = project.production?.steps.find((s): boolean => s.id === stepId);
  const task = tasks.find((t): boolean => t.id === step?.taskId && t.status === 'done');
  if (!step || step.kind === 'video' || project.production?.state !== 'paused' || !task) return null;
  const artifacts = task.artifacts?.filter((a): boolean => a.kind === 'image' && a.runId === step.runId && task.outputs.includes(a.url)) || [];
  if (artifacts.length < 2) return null;
  const selected = project.assets.find((a): boolean => a.id === step.assetId)?.artifactId;
  return <Select className="w-72" aria-label={`${stepId}选中图片`} placeholder="选择原任务返回的另一有效图片" value={selected} disabled={state.busy}
    options={artifacts.map((a, index): { value: string; label: string } => ({ value: a.id, label: `原任务第 ${index + 1} 张${a.id === selected ? '（当前选中）' : ''}` }))}
    onChange={(artifactId: string): void => { void state.selectProductionImage(stepId, artifactId); }} />;
};
const ProductionControls: React.FC<{ project: PetStoryProject; disabled: boolean; view: 'prepare' | 'progress' }> = ({ project, disabled, view }): React.ReactElement => {
  const state = usePetStoryStore();
  const [freeConfirmed, setFreeConfirmed] = useState(false);
  const counts = state.productionCounts;
  const capability = state.capability;
  const production = project.production;
  const pendingTaskId = production?.steps.find((step): boolean => step.status !== 'complete')?.taskId;
  const pendingTask = useTaskStore((s) => s.tasks.find((task): boolean => task.id === pendingTaskId));
  useEffect((): void => { setFreeConfirmed(false); }, [project.id]);
  return <Card size="small" title={view === 'prepare' ? '核对入口与制作计划' : '镜头制作进度'}>
    <Space direction="vertical" className="w-full">
      <Text type="secondary">在原账号检查一次可见创作入口，无上传、无提交。未识别槽位保留待确认；检查和本地数量均不是豆包官方剩余额度。</Text>
      <Checkbox checked={freeConfirmed} onChange={(event): void => setFreeConfirmed(event.target.checked)}>本人已核对原账号当前图片／视频入口及选定规格免费可用；收费或未知时不勾选</Checkbox>
      <Button disabled={disabled || (production?.state === 'running' && !!capability)} onClick={(): void => { void state.inspectCapability(freeConfirmed); }}>{capability ? '重新核对当前入口（暂停后）' : '检查当前可见入口（不提交）'}</Button>
      {!capability && production?.capability && <Alert type="info" message={`已保存检查：${new Date(production.capability.checkedAt).toLocaleString('zh-CN')} · ${production.capability.freeEvidence === 'user_confirmed' ? '本人确认免费' : production.capability.freeEvidence === 'visible' ? '页面观察免费' : '免费状态未知'}。恢复前仍需核对当前入口。`} />}
      {capability && <>
        <Text>免费来源：{capability.freeEvidence === 'user_confirmed' ? '本人确认' : capability.freeEvidence === 'visible' ? '页面观察' : '未知'}；图片：{capability.image.state} / {capability.image.free}；视频规格：{capability.videoConfig ? `${capability.videoConfig.model} · ${capability.videoConfig.aspectRatio}` : '待确认'}；已观察时长：{capability.durations.join(' / ') || '未知'} 秒</Text>
        {(['first_frame', 'first_last_frame', 'reference'] as const).map((mode): React.ReactNode => <Text key={mode}>{mode}：{capability.modes[mode].state} / {capability.modes[mode].free} · {capability.modes[mode].reason}</Text>)}
      </>}
      {view === 'prepare' && !production && project.plan?.shots.map((shot): React.ReactNode => <Space key={shot.id} wrap><Text>{shot.order} · 请求 {shot.requestedMode} · {shot.durationSeconds} 秒</Text>{counts && state.productionResolutions[shot.id] && <Text>→ 本次实际 {state.productionResolutions[shot.id].resolvedMode} · {state.productionResolutions[shot.id].reason}</Text>}
        <Select aria-label={`${shot.id}批准备选`} className="w-64" value={state.fallbacks[shot.id] || 'none'} disabled={disabled} options={[{ value: 'none', label: '不允许降级（必须首尾帧时保留此项）' }, { value: 'first_frame', label: '入口不可用时批准改为首帧' }, { value: 'reference', label: '入口不可用时批准改为参考图' }]} onChange={(mode: string): void => state.setFallback(shot.id, mode === 'none' ? undefined : mode as 'first_frame' | 'reference')} />
      </Space>)}
      {view === 'prepare' && !production && <Button disabled={disabled || !capability} onClick={(): void => { void state.previewProduction(); }}>查看本次实际制作数量</Button>}
      {counts && <Alert type="info" message={`${counts.shots} 个镜头，${counts.supporting} 个必要配角；计划新增角色图 ${counts.newCharacters}、首帧 ${counts.firstFrames}、尾帧 ${counts.lastFrames}；视频请求 ${counts.videos}。复用素材不重复计入新增。`} />}
      <Space wrap>
        {view === 'prepare' && !production && <Button type="primary" disabled={disabled || !counts} onClick={(): void => { void state.startProduction(); }}>确认方案并开始生成素材</Button>}
        {production && production.state !== 'complete' && <>
          <Button disabled={state.busy} onClick={(): void => { void state.pauseProduction(); }}>暂停制作</Button>
          <Button type="primary" disabled={disabled || !capability} onClick={(): void => { void state.resumeProduction(); }}>显式继续原制作</Button>
          {production.state === 'paused' && pendingTask?.runtime?.submittedAt && !pendingTask.runtime.conversationUrl && <Button disabled={state.busy} onClick={(): void => {
            window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: pendingTask.id, useCurrentPage: true } }));
          }}>只读核对当前原制作会话</Button>}
        </>}
      </Space>
      {production && view === 'progress' && <>
        <Alert type={production.state === 'paused' ? 'warning' : production.state === 'complete' ? 'success' : 'info'} message={`${production.state === 'complete' ? '镜头素材已生成并完成下载校验' : `${production.state === 'paused' ? '制作已暂停' : '正在制作镜头素材'} · ${production.message}`}`} />
        {project.plan?.shots.map((shot): React.ReactNode => {
          const media = production.shots[shot.id];
          const video = project.assets.find((a): boolean => a.id === media?.videoId);
          return <div key={shot.id} className="space-y-1 border-t border-gray-700 pt-2">
            <Text>{shot.order} · {shot.id} · 请求 {media?.requestedMode} → 实际 {media?.resolvedMode} · 请求 {shot.durationSeconds} 秒</Text>
            <div><Text type="secondary">{media?.reason}</Text></div>
            <div className="shot-media-strip">{([{ id: media?.firstFrameId, label: '首帧' }, { id: media?.plannedEndImageId, label: '计划尾帧' }, { id: media?.actualEndFrameId, label: '实际视频末帧' }]).map((item): React.ReactNode => <div key={item.label}><Tag>{item.label}</Tag>{item.id ? <ReferenceImage projectId={project.id} assetId={item.id} name={item.label} /> : <Text type="secondary">尚无素材</Text>}</div>)}</div>
            {media?.startFromPreviousEnd && <div><Text>连续起点：上一选中视频 {media.startFromPreviousEnd.assetId}，实际 {media.startFromPreviousEnd.atSeconds.toFixed(3)} 秒画面</Text></div>}
            {video && <div className="video-material"><Tag color={video.validation?.decoded ? 'green' : 'default'}>{video.validation?.decoded ? '视频文件校验通过' : '文件未检查'}</Tag><Text>{video.relativePath} · {video.validation?.durationSeconds} 秒 · {video.validation?.width}×{video.validation?.height}</Text><Button disabled={!video.taskId} onClick={(): void => { navigateWorkspace('tasks'); window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: video.taskId } })); }}>查看单镜头视频与产物</Button><Tag>人工质量以任务详情结论为准</Tag></div>}
          </div>;
        })}
        <Collapse items={[{ key: 'steps', label: '当前步骤与素材绑定（首个有效产物按本次返回顺序选择）', children: production.steps.map((step): React.ReactNode => <div key={step.id}><Text>{step.characterId || step.shotId} / {step.kind} / {step.status} · {step.taskId || '创建意图已保存，待核对任务'} · {step.error}</Text><ProductionImageChoice project={project} stepId={step.id} /></div>) }]} />
      </>}
    </Space>
  </Card>;
};
export const PetStoryPanel: React.FC = () => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((s) => s.tasks);
  const accounts = useAccountStore((s) => s.accounts);
  const p = state.project;
  const projects = useProjectStore((s) => s.projects);
  const [stage, setStage] = useState(0);
  const [selectedShotId, setSelectedShotId] = useState('');
  const stageProjectId = useRef('');
  useEffect((): void => { if (p && p.id !== stageProjectId.current) { stageProjectId.current = p.id; setStage(p.production ? 3 : p.plan ? 1 : 0); } }, [p]);
  const [link, setLink] = useState('');
  const [plan, setPlan] = useState<PetStoryPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [localProjectId, setLocalProjectId] = useState('');
  useEffect((): void => {
    if (!p) return;
    if (p.id !== localProjectId || !dirty) {
      setPlan(p.plan ? structuredClone(p.plan) : null);
      setLink(p.source.url);
      setLocalProjectId(p.id);
      setDirty(false);
    }
  }, [p, dirty, localProjectId]);
  const edit = (change: (value: PetStoryPlan) => void): void => {
    if (!plan || p?.production) return;
    const next = structuredClone(plan);
    change(next);
    setPlan(next);
    setDirty(true);
  };
  const updateShot = (id: string, patch: Partial<PetStoryShot>): void => edit((value: PetStoryPlan): void => {
    value.shots = value.shots.map((s: PetStoryShot): PetStoryShot => s.id === id ? { ...s, ...patch } : s);
  });
  const updatePrompt = (id: string, kind: PetStoryPromptKind, final: string): void => edit((value: PetStoryPlan): void => {
    const prompt = value.shots.find((s: PetStoryShot): boolean => s.id === id)?.prompts[kind];
    if (!prompt) return;
    if (prompt.rulesVersion === 'manual') prompt.original = final;
    prompt.final = final;
    prompt.edited = true;
  });
  const addShot = (): void => edit((value: PetStoryPlan): void => {
    value.shots.push({ id: `shot-${crypto.randomUUID()}`, order: value.shots.length + 1, characterIds: [], scene: '', action: '', startState: '', endState: '', durationSeconds: NaN,
      transition: 'cut', requestedMode: 'auto', prompts: { firstFrame: blankPrompt(), video: blankPrompt() } });
  });
  const addCharacter = (): void => edit((value: PetStoryPlan): void => {
    value.characters.push({ id: `support-${crypto.randomUUID()}`, name: '', role: 'supporting', purpose: '', description: '' });
  });
  const disabled = state.busy || dirty || !!p?.production;
  const [storyDirty, setStoryDirty] = useState(false);
  const sourceDirty = !!p && (link !== p.source.url || storyDirty);
  const accountName = accounts.find((a): boolean => a.id === p?.accountId)?.name || '原账号缺失';
  const retryableJob = p?.jobs.find((job): boolean => !!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.status === 'bound' && job.sourceUrl === p.source.url && tasks.some((task): boolean =>
    task.id === job.taskId && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status) && !!task.runtime && !task.runtime.submittedAt && !task.runtime.acceptanceObservation
    && ['video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'authentication_unconfirmed', 'cancelled'].includes(task.errorInfo?.code || '')));
  return <section className="petstory-panel space-y-4" aria-label="萌宠短剧">

    <Space wrap>
      <Button onClick={(): void => { void state.createProject(); }} disabled={state.busy || dirty}>新建项目目录</Button>
      <Button onClick={(): void => { void state.openProject(); }} disabled={state.busy || dirty}>打开项目目录</Button>
      {p && <><Tag>本地短剧 · {state.projectName || p.id.slice(0, 8)}</Tag><Tag>关联 Studio：{projects.find((project): boolean => project.id === p.studioProjectId)?.name || '原项目缺失'}</Tag><Tag>执行账号：{accountName}</Tag><Tag color={dirty || sourceDirty ? 'orange' : 'default'}>{dirty || sourceDirty ? '有未保存内容' : `已保存 · v${p.revision}`}</Tag></>}
    </Space>
    {state.error && <Alert type="error" showIcon message={state.error} />}
    {!p && <Alert type="info" message="先在“账号与浏览器”选择本人豆包账号，再新建短剧目录；也可打开已有目录继续。当前仅制作逐镜素材。" />}
    {p && <>
      <nav className="petstory-stages" aria-label="短剧制作阶段">{['故事输入', '角色与分镜', '制作准备', '制作进度与素材'].map((label: string, index: number): React.ReactNode => <button key={label} className={stage === index ? 'active' : ''} aria-current={stage === index ? 'step' : undefined} onClick={(): void => setStage(index)}><span>{index + 1}</span>{label}</button>)}</nav>
      {!!p.production && <Alert type="info" showIcon message="方案已进入制作，编辑已锁定；可查看方案、原任务与镜头素材。" />}
      <div className={stage === 0 ? 'stage-content space-y-4' : 'page-hidden'}>
      <Card size="small" title="来源与固定主演">
        <TextArea readOnly={!!p.production} aria-label="抖音分享文本或链接" value={link} onChange={(e): void => setLink(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="粘贴一条抖音分享文本或视频链接" />
        <Space className="mt-2" wrap>
          <Button onClick={(): void => { void state.saveSource(link); }} disabled={disabled}>保存链接</Button>
          {(['lulu', 'lumei'] as const).map((id): React.ReactNode => <Button key={id} disabled={disabled} onClick={(): void => { void state.addReference(id); }}>
            {id === 'lulu' ? '噜噜' : '噜妹'}参考图 {p.assets.some((a): boolean => a.characterId === id) ? '✓' : '待选择'}
          </Button>)}
        </Space>
        <MobileStoryInput project={p} disabled={disabled} linkUnsaved={link !== p.source.url} onDirtyChange={setStoryDirty} />
        <div className="flex gap-3 mt-3">{p.assets.filter((a): boolean => a.characterId === 'lulu' || a.characterId === 'lumei').map((a): React.ReactNode => <ReferenceImage key={a.id} projectId={p.id} assetId={a.id} name={a.characterId === 'lulu' ? '噜噜' : '噜妹'} />)}</div>
        <div className="mt-3 space-y-2">
          <Checkbox disabled={!!p.production} checked={state.freeChatConfirmed} onChange={(e): void => state.setFreeChatConfirmed(e.target.checked)}>本人已确认项目原账号当前普通 Chat 免费可用</Checkbox>
          <Checkbox disabled={!!p.production} checked={state.autoRepair} onChange={(e): void => state.setAutoRepair(e.target.checked)}>结构错误时允许最多追加一次格式纠正对话</Checkbox>
          <div><Button type="primary" disabled={disabled || sourceDirty || !canAnalyzeStory(p, state.freeChatConfirmed)} onClick={(): void => { void state.analyze(); }}>根据已保存故事生成制作方案</Button></div>
          {retryableJob && <div><Alert className="mb-2" type="warning" showIcon message="原 Chat 任务在提交前停止。处理附件或页面问题后，可保留链接、角色图和原任务重试。" /><Button type="primary" disabled={disabled || !state.freeChatConfirmed} onClick={(): void => { void state.retryUnsubmitted(retryableJob.id); }}>重试原任务（尚未提交）</Button></div>}
        </div>
        <div className="mt-3"><Text type="secondary">桌面普通 Chat 仅处理你粘贴的故事与角色参考图。故事不足时请补充原文；工具不获取或分析链接视频。复制提示词、保存原文不会发送模型请求。</Text></div>
        {p.source.reason && <Alert className="mt-3" type={p.source.status === 'blocked' ? 'error' : 'warning'} message={p.source.reason} />}
        {p.contentBasis && <Collapse className="mt-3" items={[{ key: 'basis', label: '按粘贴原文整理的故事依据（待本人核对）', children: <Space direction="vertical"><Text>开头：{p.contentBasis.beginning}</Text><Text>变化：{p.contentBasis.middle}</Text><Text>结局：{p.contentBasis.ending}</Text></Space> }]} />}
      </Card>
      {p.jobs.length > 0 && <Collapse items={[{ key: 'jobs', label: '本次 Chat 原文、任务绑定与收取结果', children: <Space direction="vertical" className="w-full">
        {p.jobs.map((job): React.ReactNode => <Card size="small" key={job.id} title={`${job.kind} · ${job.status}`}>
          <Text type="secondary">任务 {job.taskId} · {tasks.find((t): boolean => t.id === job.taskId)?.status || '原任务缺失'}</Text>
          {job.runId && <div><Text type="secondary">运行 {job.runId}</Text></div>}
          {job.error && <Alert type="warning" message={job.error} />}
          {!job.sourceStoryId && <Tag>旧版链接直读记录，仅供核对</Tag>}
          <Space className="mt-2" wrap>
            {!!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.status === 'bound' && tasks.some((t): boolean => t.id === job.taskId && t.status === 'queued') && <Button disabled={disabled || sourceDirty || !state.freeChatConfirmed} onClick={(): void => { void state.startBoundChat(job.id); }}>启动原绑定 Chat 任务</Button>}
            <Button disabled={disabled || job.status === 'applied'} onClick={(): void => { void state.collect(job.id); }}>读取原任务已保存正文</Button>
            <Button disabled={disabled || job.status === 'applied' || !tasks.some((t): boolean => t.id === job.taskId && !!t.runtime?.submittedAt && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(t.status))} onClick={(): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: job.taskId, useCurrentPage: !tasks.find((t): boolean => t.id === job.taskId)?.runtime?.conversationUrl } })); }}>{tasks.find((t): boolean => t.id === job.taskId)?.runtime?.conversationUrl ? '原会话只读补取' : '核对当前 Chat 原回复'}</Button>
            {!!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.kind === 'analysis' && job.status === 'invalid' && p.source.status !== 'blocked' && !p.jobs.some((j): boolean => j.parentJobId === job.id) && <Button disabled={disabled || sourceDirty || !state.freeChatConfirmed} onClick={(): void => { void state.correctOnce(job.id); }}>纠正一次结构</Button>}
          </Space>
          {job.rawText && <pre className="mt-2 whitespace-pre-wrap break-words text-xs max-h-80 overflow-auto select-text">{job.rawText}</pre>}
        </Card>)}
      </Space> }]} />}
      </div>
      <div className={stage === 1 ? 'stage-content space-y-4' : 'page-hidden'}>
      {!plan && <Empty description="保存手机故事并生成制作方案后，在这里整理角色与分镜" />}
      {plan && <>
        <ConfigProvider componentDisabled={state.busy || !!p.production}>
        <Card size="small" title="故事与角色">
          <Text>原片梗概</Text><TextArea aria-label="原片梗概" value={plan.sourceSummary} onChange={(e): void => edit((v: PetStoryPlan): void => { v.sourceSummary = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} />
          <div className="mt-3"><Text>相似故事</Text><TextArea aria-label="相似故事" value={plan.adaptedStory} onChange={(e): void => edit((v: PetStoryPlan): void => { v.adaptedStory = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} /></div>
          <Collapse className="mt-4" items={[{ key: 'characters', label: `角色档案 · ${plan.characters.length} 位 · 固定主演与必要配角`, children: <div className="character-grid">{plan.characters.map((c: PetStoryCharacter, index: number): React.ReactNode => <div key={c.id} className="rounded border border-gray-700 p-2 space-y-2">
            <Space><Tag>{c.role === 'main' ? '固定主演' : '必要配角'}</Tag><Text code>{c.id}</Text></Space>
            <Input aria-label={`${c.id}名称`} value={c.name} disabled={c.role === 'main' || state.busy || !!p.production} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].name = e.target.value; })} />
            <Input aria-label={`${c.id}剧情作用`} placeholder="剧情作用" value={c.purpose} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].purpose = e.target.value; })} />
            <Input aria-label={`${c.id}外观设定`} placeholder="外观与服装" value={c.description} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].description = e.target.value; })} />
            {c.referenceAssetId && <ReferenceImage projectId={p.id} assetId={c.referenceAssetId} name={c.name} />}
            <Button disabled={disabled} onClick={(): void => { void state.addReference(c.id); }}>{c.referenceAssetId ? '替换项目参考图' : '选择项目参考图'}</Button>
            {c.role === 'supporting' && <Button danger disabled={state.busy || !!p?.production} onClick={(): void => edit((v: PetStoryPlan): void => { v.characters.splice(index, 1); })}>删除配角</Button>}
          </div>)}</div> }]} />
          <Button className="mt-3" onClick={addCharacter} disabled={state.busy || !!p?.production}>添加必要配角</Button>
        </Card>
        </ConfigProvider>
        <Space wrap><Title level={5} className="!m-0">{plan.shots.length} 个镜头 · {plan.characters.length} 个角色</Title><Button onClick={addShot} disabled={state.busy || !!p?.production}>增加镜头</Button><Button type="primary" disabled={!dirty || state.busy || !!p.production} onClick={(): void => { void state.savePlan(plan).then((): void => { if (!usePetStoryStore.getState().error) setDirty(false); }); }}>校验并保存所有修改</Button>{dirty && <Tag color="orange">有未保存修改</Tag>}</Space>
        <div className="shot-workspace"><nav className="shot-list" aria-label="镜头列表">{plan.shots.map((shot: PetStoryShot): React.ReactNode => <button key={shot.id} className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? 'active' : ''} onClick={(): void => setSelectedShotId(shot.id)}><span className="shot-number">{String(shot.order).padStart(2, '0')}</span><span><strong>{shot.scene || '待填写场景'}</strong><small>{shot.characterIds.map((id: string): string => plan.characters.find((character): boolean => character.id === id)?.name || id).join('、') || '未选角色'}</small><small>{shot.durationSeconds || '—'} 秒 · {shot.transition === 'cut' ? '切镜' : '连续动作'} · {shot.requestedMode}</small></span></button>)}</nav><div className="shot-detail">
        {plan.shots.map((shot: PetStoryShot, index: number): React.ReactNode => <Card className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? '' : 'page-hidden'} size="small" key={shot.id} title={`镜头 ${shot.order} · ${shot.id}`}>
          <Space wrap>
            <Button disabled={index === 0 || state.busy || !!p.production} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index - 1], v.shots[index]] = [v.shots[index], v.shots[index - 1]]; v.shots = renumber(v.shots); })}>上移</Button>
            <Button disabled={index === plan.shots.length - 1 || state.busy || !!p.production} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index + 1], v.shots[index]] = [v.shots[index], v.shots[index + 1]]; v.shots = renumber(v.shots); })}>下移</Button>
            <Button danger disabled={state.busy || !!p?.production} onClick={(): void => edit((v: PetStoryPlan): void => { v.shots.splice(index, 1); v.shots = renumber(v.shots); })}>删除镜头</Button>
            <InputNumber disabled={!!p.production || state.busy} aria-label={`${shot.id}时长`} addonAfter="秒" status={!Number.isFinite(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 ? 'error' : undefined} placeholder="5～10" value={Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : null} onChange={(value: number | null): void => updateShot(shot.id, { durationSeconds: value ?? NaN })} />
          </Space>
          <div className="mt-3 space-y-2">
            <Select disabled={!!p.production || state.busy} aria-label={`${shot.id}角色及参考顺序`} className="w-full" mode="multiple" value={shot.characterIds} options={plan.characters.map((c: PetStoryCharacter): { value: string; label: string } => ({ value: c.id, label: c.name || c.id }))} onChange={(value: string[]): void => updateShot(shot.id, { characterIds: value })} placeholder="选择本镜角色；按此顺序绑定参考图" />
            <Text type="secondary">生成素材顺序：{shot.characterIds.map((id: string, i: number): string => `${i + 1}→${plan.characters.find((c): boolean => c.id === id)?.name || id}`).join('，')}</Text>
            {(['scene', 'action', 'startState', 'endState'] as const).map((field): React.ReactNode => <Input disabled={!!p.production || state.busy} key={field} aria-label={`${shot.id}${field}`} addonBefore={{ scene: '场景', action: '主要动作', startState: '开始状态', endState: '结束状态' }[field]} value={shot[field]} onChange={(e): void => updateShot(shot.id, { [field]: e.target.value })} />)}
            <Space wrap>
              <Select disabled={!!p.production || state.busy} aria-label={`${shot.id}关系`} value={shot.transition} options={[{ value: 'cut', label: '正常切镜' }, { value: 'continue', label: '连续动作' }]} onChange={(value: 'cut' | 'continue'): void => updateShot(shot.id, { transition: value, previousShotId: value === 'continue' ? plan.shots[index - 1]?.id : undefined })} />
              <Select disabled={!!p.production || state.busy} aria-label={`${shot.id}请求模式`} value={shot.requestedMode} options={[{ value: 'auto', label: '自动选择' }, { value: 'first_frame', label: '首帧' }, { value: 'first_last_frame', label: '首尾帧（待能力确认）' }, { value: 'reference', label: '参考图' }]} onChange={(value: PetStoryShot['requestedMode']): void => updateShot(shot.id, { requestedMode: value, prompts: { ...shot.prompts, lastFrame: value === 'first_last_frame' ? shot.prompts.lastFrame || blankPrompt() : shot.prompts.lastFrame } })} />
            </Space>
            <Space wrap><Button disabled={disabled} onClick={(): void => { void state.addSceneReference(shot.id); }}>添加本镜头场景参考图</Button>{shot.sceneReferenceAssetIds?.map((id): React.ReactNode => <ReferenceImage key={id} projectId={p.id} assetId={id} name="本镜场景" />)}</Space>
            <div className="prompt-workspace"><Text strong>提示词详情</Text><p className="muted-text">实际提交使用最终文本 final；保存修改后才可创建草稿或单独优化。</p><Tabs items={(['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => !!shot.prompts[kind]).map((kind): { key: string; label: string; children: React.ReactNode } => {
              const prompt = shot.prompts[kind] as PetStoryPrompt;
              return { key: kind, label: promptLabels[kind], children: <><Space wrap><Tag>{prompt.rulesVersion === 'manual' ? '尚未优化' : prompt.rulesVersion}</Tag>{prompt.edited && <Tag color="purple">已手动编辑</Tag>}</Space><Tabs defaultActiveKey="final" type="card" size="small" items={[
                { key: 'original', label: '原始', children: <pre className="prompt-readonly">{prompt.original || '暂无原始文本'}</pre> },
                { key: 'optimized', label: '优化', children: <pre className="prompt-readonly">{prompt.optimized || '尚未通过 Chat 优化'}</pre> },
                { key: 'final', label: '最终 · 实际提交', children: <TextArea readOnly={!!p.production} aria-label={`${shot.id}${kind}最终提示词`} value={prompt.final} onChange={(event): void => updatePrompt(shot.id, kind, event.target.value)} autoSize={{ minRows: 5, maxRows: 16 }} /> },
              ]} /><TooltipPrompt locked={!!p.production} dirty={dirty} confirmed={state.freeChatConfirmed}><Button disabled={disabled || !state.freeChatConfirmed} onClick={(): void => { void state.optimize(shot.id, kind); }}>仅重新优化此项</Button></TooltipPrompt></> };
            })} /></div>
            <Button disabled={disabled} onClick={(): void => { void state.draftFinal(shot.id); }}>将最终首帧文本保存为 Studio 待执行草稿</Button>
          </div>
        </Card>)}
        </div></div>
      </>}
      </div>
      <div className={stage === 2 || stage === 3 ? 'stage-content space-y-4' : 'page-hidden'}>
        {stage === 3 && plan && !p.production && <Alert type="info" message="尚未开始制作。请先在制作准备中核对入口与数量，再明确授权生成素材。" action={<Button onClick={(): void => setStage(2)}>前往制作准备</Button>} />}
        {!plan ? <Empty description="先生成并保存制作方案" /> : <ProductionControls project={p} disabled={state.busy || dirty || sourceDirty} view={stage === 3 ? 'progress' : 'prepare'} />}
        {stage === 3 && p.assets.some((asset): boolean => asset.kind === 'character') && <Card size="small" title="角色参考素材"><div className="shot-media-strip">{p.assets.filter((asset): boolean => asset.kind === 'character').map((asset): React.ReactNode => <div key={asset.id}><Tag>{p.plan?.characters.find((character): boolean => character.id === asset.characterId)?.name || asset.characterId || '角色参考'}</Tag><ReferenceImage projectId={p.id} assetId={asset.id} name="角色参考" /></div>)}</div></Card>}
        <p className="muted-text">制作完成仅表示逐镜素材已生成及下载；完整短剧合成尚未实现。首帧／首尾帧原生能力以当前入口核对为准。</p>
      </div>
    </>}
  </section>;
};

const TooltipPrompt: React.FC<{ locked: boolean; dirty: boolean; confirmed: boolean; children: React.ReactNode }> = ({ locked, dirty, confirmed, children }): React.ReactElement => <div><span title={locked ? '制作中方案已锁定' : dirty ? '请先保存方案修改' : !confirmed ? '请先在故事输入确认原账号普通 Chat 免费' : '发起一次新的普通 Chat 优化请求'}>{children}</span></div>;
