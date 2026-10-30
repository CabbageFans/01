/**
 * src/components/Toolbar.tsx
 * 页面工具与低频维护入口
 * 复用原暂停、批次下载和维护处理函数，由六入口外壳决定展示位置。
 */

import React from 'react';
import { PauseCircleOutlined, PlayCircleOutlined, DownloadOutlined, ToolOutlined, BarChartOutlined, UnorderedListOutlined, MoreOutlined } from '@ant-design/icons';
import { Button, Descriptions, message, Modal, Progress, Segmented, Space, Dropdown, Tag, Empty } from 'antd';

import { useTaskStore } from '../store/useTaskStore';
import { SettingsModal } from './SettingsModal';
import { OutputPreviewModal } from './OutputPreviewModal';
import type { OutputItem, OutputScopeSummary } from './OutputPreviewModal';
import { DownloadQueueModal } from './DownloadQueueModal';
import type { AdapterSelfCheckReport, DownloadJob, Task } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { ArtifactCenterModal } from './ArtifactCenterModal';
import { BatchManagerModal } from './BatchManagerModal';
import { installAdapterBundle, rollbackAdapterBundle } from '../automation/doubaoAdapter';
import { LogCenterModal } from './LogCenterModal';
import { ProjectOverviewModal } from './ProjectOverviewModal';
import { useProjectStore } from '../store/useProjectStore';
import { ProjectSwitcher } from './ProjectSwitcher';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { PetStoryImageReview, imageBelongsToTarget } from './PetStoryImageReview';
import { isPetStoryMaterialImageApproved } from './PetStoryMaterials';
import type { PetStoryImageTarget } from '@doubao-studio/contracts';
import type { WorkspacePage } from '../utils/workspace';
import { calculatePlatformSuccessRate, getPlatformTaskStats } from '../utils/taskStats';

interface ToolbarProps { page: WorkspacePage; }


/** 素材库与创作节点使用同一图片确认与采用入口。 */
const StoryImageLibrary: React.FC<{ view: 'adopted' | 'candidates' }> = ({ view }): React.ReactElement => {
  const pet = usePetStoryStore();
  const project = pet.project;
  const storyImages: Array<{ title: string; target: PetStoryImageTarget; currentAssetId?: string; identity?: string }> = [];
  if (project) {
    for (const material of project.materials || []) storyImages.push({ title: `${material.name} · ${material.kind === 'character' ? '人物' : material.kind === 'prop' ? '道具' : '场景'}`, target: { materialId: material.id }, currentAssetId: isPetStoryMaterialImageApproved(project, material) ? material.selectedAssetId : undefined, identity: material.kind === 'character' ? project.plan?.characters.find((character): boolean => character.id === material.entityId)?.description : undefined });
    for (const shot of project.plan?.shots || []) for (const kind of ['firstFrame', 'lastFrame'] as const) storyImages.push({ title: `镜头 ${shot.order} · ${kind === 'firstFrame' ? '首帧' : '尾帧'}`, target: { shotId: shot.id, kind }, currentAssetId: kind === 'firstFrame' ? project.adoptedImages?.[shot.id]?.firstFrameId : project.adoptedImages?.[shot.id]?.plannedEndImageId });
  }
  const visibleStoryImages = storyImages.filter((item): boolean => view === 'adopted' ? !!item.currentAssetId : !!project?.assets.some((asset): boolean => imageBelongsToTarget(project, asset, item.target) && asset.id !== item.currentAssetId && asset.imageReview?.state !== 'adopted'));

  return project && visibleStoryImages.length ? <div className="story-library-grid">{visibleStoryImages.map((item): React.ReactNode => <section className="story-library-item" key={item.title}><div className="section-heading"><h3>{item.title}</h3><Tag color={view === 'adopted' ? 'success' : 'warning'}>{view === 'adopted' ? '已采用' : '待确认'}</Tag></div><PetStoryImageReview project={project} target={item.target} title={item.title} currentAssetId={item.currentAssetId} identity={item.identity} disabled={pet.busy || project.production?.state === 'running'}
          onUpload={async (): Promise<void> => { if (item.target.materialId) await pet.addMaterialImage(item.target.materialId); else if (item.target.shotId && item.target.kind) await pet.uploadShotImage(item.target.shotId, item.target.kind); }}
          onAdopt={async (assetId: string): Promise<void> => { if (item.target.materialId) await pet.approveMaterials([{ materialId: item.target.materialId, assetId }]); else if (item.target.shotId && item.target.kind) await pet.adoptShotImage(item.target.shotId, item.target.kind, assetId); }}
          onAdjust={async (): Promise<void> => { if (item.target.materialId) await pet.openChatAdjustment({ materialId: item.target.materialId }); else await pet.openChatAdjustment({ shotId: item.target.shotId, promptKind: item.target.kind }); }} />
        </section>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!project ? '打开短剧项目后，在这里查看图片。' : view === 'adopted' ? '还没有已采用图片，请先在短剧中准备素材。' : '暂时没有待确认图片'} />;
};

/** 页面工具保留旧处理函数和模态框，入口从顶栏移入对应业务页面。 */
export const Toolbar: React.FC<ToolbarProps> = ({ page }): React.ReactElement => {
  const [assetView, setAssetView] = React.useState<'adopted' | 'candidates' | 'outputs' | 'downloads'>('adopted');
  const localStoryName = usePetStoryStore((state): string => state.project ? state.projectName || '当前短剧' : '未打开短剧');
  const { tasks, schedulerPaused, batchPause, resumeAll } = useTaskStore();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const accounts = useAccountStore((state) => state.accounts);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [completedOutputs, setCompletedOutputs] = React.useState<OutputItem[]>([]);
  const [previewScope, setPreviewScope] = React.useState<OutputScopeSummary | undefined>(undefined);
  const [downloadQueueOpen, setDownloadQueueOpen] = React.useState(false);
  const [downloadJobs, setDownloadJobs] = React.useState<DownloadJob[]>([]);
  const [downloadJobsLoading, setDownloadJobsLoading] = React.useState(false);
  const [metricsOpen, setMetricsOpen] = React.useState(false);
  const [adapterReport, setAdapterReport] = React.useState<AdapterSelfCheckReport | null>(null);
  const [adapterChecking, setAdapterChecking] = React.useState(false);
  const [batchManagerOpen, setBatchManagerOpen] = React.useState(false);
  const [logsOpen, setLogsOpen] = React.useState(false);
  const [projectOverviewOpen, setProjectOverviewOpen] = React.useState(false);
  const [integrityResult, setIntegrityResult] = React.useState<{ success: boolean; issues: string[] } | null>(null);
  const [checkingIntegrity, setCheckingIntegrity] = React.useState(false);

  React.useEffect(() => {
    const handleResult = (event: Event) => {
      const detail = (event as CustomEvent<{ report?: AdapterSelfCheckReport; error?: string }>).detail;
      setAdapterChecking(false);
      if (detail.error) message.error(`兼容性自检失败：${detail.error}`);
      else if (detail.report) setAdapterReport(detail.report);
    };
    window.addEventListener('adapter-self-check-result', handleResult);
    return () => window.removeEventListener('adapter-self-check-result', handleResult);
  }, []);

  const loadDownloadJobs = React.useCallback(async () => {
    setDownloadJobsLoading(true);
    try {
      setDownloadJobs(await window.electronAPI.tasks.listDownloads());
    } finally {
      setDownloadJobsLoading(false);
    }
  }, []);

  // 监听任务控制台打开批次选择器
  React.useEffect(() => {
    const handleOpenBatchManager = () => setBatchManagerOpen(true);
    window.addEventListener('open-batch-manager', handleOpenBatchManager);
    return () => window.removeEventListener('open-batch-manager', handleOpenBatchManager);
  }, []);

  // 只接受带真实范围摘要的批次预览事件；旧的无归属裸数组事件一律 fail-closed。
  React.useEffect(() => {
    const handleBatchDownloadOutputs = (e: Event) => {
      const detail = (e as CustomEvent<{ outputs?: OutputItem[]; scopeSummary?: OutputScopeSummary } | OutputItem[]>).detail;
      if (Array.isArray(detail)) {
        // 旧集成格式没有项目/批次归属：拒绝打开预览，避免生成无归属下载范围。
        if (detail.length > 0) message.error('下载事件缺少项目或批次归属，已拒绝打开预览');
        return;
      }
      const outputs = detail?.outputs;
      const scope = detail?.scopeSummary;
      const hasScope = !!scope
        && typeof scope.projectName === 'string' && scope.projectName.trim().length > 0
        && typeof scope.batchId === 'string' && scope.batchId.trim().length > 0;
      if (!outputs || outputs.length === 0) return;
      if (!hasScope) {
        message.error('下载范围缺少项目或批次归属，已拒绝打开预览');
        return;
      }
      setCompletedOutputs(outputs);
      setPreviewScope(scope);
      setPreviewOpen(true);
    };
    window.addEventListener('batch-download-outputs', handleBatchDownloadOutputs);
    return () => window.removeEventListener('batch-download-outputs', handleBatchDownloadOutputs);
  }, []);

  // 当前项目内已完成且有产物的任务数
  const completedWithOutputs = tasks.filter(
    (t) => (t.projectId || 'default-project') === activeProjectId && t.status === 'done' && t.outputs.length > 0
  ).length;
  const successRate = calculatePlatformSuccessRate(tasks);
  const platformStats = getPlatformTaskStats(tasks);
  const completedDurations = tasks
    .flatMap((task: Task): number[] => {
      const startedAt = task.runtime?.startedAt;
      if (task.status !== 'done' || !startedAt) return [];
      return [new Date(task.updatedAt).getTime() - new Date(startedAt).getTime()];
    })
    .filter((duration) => duration >= 0);
  const averageMinutes = completedDurations.length
    ? Math.round(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length / 60_000)
    : 0;

  // 处理暂停/继续
  const handleTogglePause = async () => {
    if (!schedulerPaused) {
      const paused = await batchPause();
      if (paused) message.info('任务调度已暂停');
    } else {
      const resumed = await resumeAll();
      if (resumed) {
        message.success('任务调度已恢复');
      } else {
        message.warning(useTaskStore.getState().error || '部分任务未能恢复，请查看任务详情');
      }
    }
  };

  // 批量下载统一先选择当前项目的具体批次，禁止默认全历史。
  const handleBatchDownload = () => {
    if (completedWithOutputs === 0) {
      message.info('当前项目暂无已完成产物');
      return;
    }
    setBatchManagerOpen(true);
  };

  const handleDownloadBatch = (outputs: OutputItem[], scope: OutputScopeSummary) => {
    setCompletedOutputs(outputs);
    setPreviewScope(scope);
    setPreviewOpen(true);
  };

  // 执行下载
  const handleDoDownload = async (selectedOutputs: OutputItem[]) => {
    // 获取下载目录设置
    const settings = await window.electronAPI.settings.get();
    const saveDir = settings.downloadDir || undefined;

    const result = await window.electronAPI.tasks.downloadOutputs(selectedOutputs, saveDir);
    await loadDownloadJobs();
    if (result.success) {
      if (result.failed > 0) {
        message.warning(`已下载 ${result.count} 个，失败 ${result.failed} 个：${result.error || '地址不可用'}`);
      } else {
        message.success(`已下载 ${result.count} 个产物到 ${result.saveDir || '下载目录'}`);
        setPreviewOpen(false);
      }
    } else {
      message.error(`下载失败：${result.error || '未能获取文件'}`);
    }
  };

  const handleRetryDownload = async (job: DownloadJob) => {
    const result = await window.electronAPI.tasks.downloadOutputs([{
      taskId: job.taskId,
      prompt: '',
      outputs: [job.url],
      accountId: job.accountId,
      mode: job.mode,
    }], job.saveDir);
    await loadDownloadJobs();
    if (result.success) message.success('重新下载成功');
    else message.error(`重新下载失败：${result.error || '地址不可用'}`);
  };

  // 更多操作菜单
  const moreMenuItems: Array<{ key: string; label: string; disabled?: boolean; onClick: () => void | Promise<void> }> = [
    {
      key: 'project-overview',
      label: '项目概览',
      onClick: () => setProjectOverviewOpen(true),
    },
    {
      key: 'batches',
      label: '任务批次',
      onClick: () => setBatchManagerOpen(true),
    },
    {
      key: 'logs',
      label: '运行日志',
      onClick: () => setLogsOpen(true),
    },
    {
      key: 'integrity',
      label: '检查数据完整性',
      onClick: async () => {
        setCheckingIntegrity(true);
        try {
          const result = await window.electronAPI.system.checkIntegrity();
          setIntegrityResult(result);
          if (result.success) message.success('数据完整性检查通过');
          else message.error(result.issues.join('；'));
        } catch {
          setIntegrityResult({ success: false, issues: ['检查未完成，请稍后重试。'] });
          message.error('检查未完成，请稍后重试。');
        } finally { setCheckingIntegrity(false); }
      },
    },
    {
      key: 'backup',
      label: '创建数据备份',
      onClick: async () => {
        const result = await window.electronAPI.system.exportBackup();
        if (result.success) message.success(`备份已导出：${result.filePath}`);
        else if (result.error) message.error(result.error);
      },
    },
    {
      key: 'restore',
      label: '恢复数据备份',
      onClick: async () => {
        const result = await window.electronAPI.system.restoreBackup();
        if (result.success) message.success('备份已恢复，请重新启动应用');
        else if (result.error) message.error(result.error);
      },
    },
    {
      key: 'updates',
      label: '检查应用更新',
      onClick: async () => {
        const result = await window.electronAPI.system.checkUpdate();
        if (!result.success) message.error(result.error);
        else if (result.hasUpdate) Modal.info({ title: `发现新版本 ${result.latestVersion}`, content: result.name, okText: '打开发布页面', onOk: () => result.url && window.open(result.url, '_blank') });
        else message.success(`当前已是最新版本 ${result.currentVersion}`);
      },
    },
    {
      key: 'adapter-check',
      label: adapterChecking ? '兼容性自检中...' : '豆包页面兼容性自检',
      disabled: adapterChecking,
      onClick: () => {
        setAdapterChecking(true);
        window.dispatchEvent(new CustomEvent('adapter-self-check'));
      },
    },
    {
      key: 'adapter-import',
      label: '导入页面适配规则',
      onClick: async () => {
        const selected = await window.electronAPI.tasks.selectAdapterRules();
        if (!selected.success || !selected.bundle) {
          if (selected.error) message.error(selected.error);
          return;
        }
        const result = await installAdapterBundle(selected.bundle);
        if (result.ok) message.success(`适配规则 ${selected.bundle.version} 已安装`);
        else message.error(result.error);
      },
    },
    {
      key: 'adapter-rollback',
      label: '回退页面适配规则',
      onClick: async () => {
        const result = await rollbackAdapterBundle();
        if (result.ok) message.success(`已回退到适配规则 ${result.version}`);
        else message.warning(result.error);
      },
    },
    {
      key: 'metrics',
      label: '运行统计',
      onClick: () => setMetricsOpen(true),
    },
    {
      key: 'diagnostics',
      label: '导出诊断包',
      onClick: async () => {
        const result = await window.electronAPI.tasks.exportDiagnostics();
        if (result.success) message.success(`诊断包已导出：${result.filePath}`);
        else if (result.error) message.error(`导出失败：${result.error}`);
      },
    },
    {
      key: 'settings',
      label: '偏好设置',
      onClick: () => setSettingsOpen(true),
    },
  ];

  React.useEffect((): void => {
    if (page === 'assets') void loadDownloadJobs();
  }, [page, loadDownloadJobs]);

  const toolButton = (key: string, primary: boolean = false): React.ReactNode => {
    const item = moreMenuItems?.find((entry): boolean => entry?.key === key);
    if (!item || !('label' in item)) return null;
    return <Button key={key} type={primary ? 'primary' : 'default'} disabled={'disabled' in item && item.disabled} onClick={(): void => {
      if ('onClick' in item && item.onClick) void item.onClick();
    }}>{item.label}</Button>;
  };


  return (
    <>
      {page === 'tasks' && <div className="page-tools task-page-tools"><span className="scope-label">项目</span><ProjectSwitcher variant="context" /><span className="scheduler-state">调度{schedulerPaused ? '已暂停' : '运行中'}</span><Dropdown trigger={['click']} menu={{ items: [
        { key: 'pause', label: schedulerPaused ? '继续全局调度' : '暂停全局调度', icon: schedulerPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />, onClick: (): void => { void handleTogglePause(); } },
        { key: 'batches', label: '查看任务批次', icon: <UnorderedListOutlined />, onClick: (): void => setBatchManagerOpen(true) },
        { key: 'overview', label: '项目信息与导出', onClick: (): void => setProjectOverviewOpen(true) },
        { type: 'divider' },
        { key: 'import', label: '受控 CSV 导入', onClick: (): void => { window.dispatchEvent(new CustomEvent('import-workspace-csv')); } },
      ] }}><Button icon={<MoreOutlined />}>更多</Button></Dropdown></div>}
      {page === 'assets' && <section className="workspace-card asset-workspace">
        <div className="section-heading"><Segmented aria-label="素材分类" value={assetView} onChange={(value): void => setAssetView(value as typeof assetView)} options={[{ label: '已采用图片', value: 'adopted' }, { label: '待确认图片', value: 'candidates' }, { label: '任务产物', value: 'outputs' }, { label: '下载记录', value: 'downloads' }]} /><div className="asset-scope-actions">{assetView === 'outputs' || assetView === 'downloads' ? <ProjectSwitcher variant="context" /> : <span className="muted-text">{localStoryName}</span>}{(assetView === 'outputs' || assetView === 'downloads') && <Button icon={<DownloadOutlined />} disabled={!completedWithOutputs} onClick={handleBatchDownload}>按批次选择下载</Button>}</div></div>
        <p className="muted-text asset-scope">{assetView === 'adopted' || assetView === 'candidates' ? '已采用图片可以用于后续制作；待确认图片请先预览，再决定是否采用。' : '图片下载后仍需在短剧中预览并采用；下载状态与文件校验分别记录。'}</p>
        {(assetView === 'adopted' || assetView === 'candidates') && <StoryImageLibrary view={assetView} />}
        <ArtifactCenterModal open={assetView === 'outputs'} embedded onClose={(): void => setAssetView('outputs')} />
        {assetView === 'downloads' && <DownloadQueueModal embedded open scopeLabel="当前项目" jobs={downloadJobs.filter((job): boolean => tasks.some((task): boolean => task.id === job.taskId && (task.projectId || 'default-project') === activeProjectId))} loading={downloadJobsLoading} onClose={(): void => setAssetView('outputs')} onRefresh={(): void => { void loadDownloadJobs(); }} onRetry={handleRetryDownload} />}
      </section>}
      {page === 'settings' && <div className="settings-grid">
        <div className="settings-groups"><section className="workspace-card"><div className="section-heading"><div><h2>使用偏好</h2><p>下载目录、素材授权与账号启动设置</p></div>{toolButton('settings', true)}</div><div className="settings-info-row"><div><strong>普通 Chat 发送方式</strong><p>工作室自动发送已授权请求；进入自由对话后暂停后续请求。</p></div><Tag>当前方式</Tag></div><div className="settings-info-row"><div><strong>图片预览与采用</strong><p>生成或上传后先预览，确认采用后用于制作。</p></div></div><div className="settings-info-row"><div><strong>素材替换与历史</strong><p>替换后保留原图与已有成果，相关镜头需要复核。</p></div></div><div className="section-footer">{toolButton('updates')}</div></section>
        <section className="workspace-card"><h2>数据与备份</h2><p className="muted-text settings-description">备份包含工作室记录；外部短剧项目目录和全部媒体需要单独保存。</p><details className="settings-details"><summary>备份与恢复</summary><Space wrap>{toolButton('backup')}{toolButton('restore')}</Space></details><details className="settings-details"><summary>项目记录与导出</summary><Space wrap>{toolButton('project-overview')}{toolButton('batches')}</Space></details></section></div>
        <div className="settings-groups"><section className="workspace-card"><div className="section-heading"><h2>运行检查</h2><Tag color={integrityResult?.success ? 'success' : undefined}>{integrityResult ? integrityResult.success ? '检查通过' : '需要处理' : '尚未检查'}</Tag></div><p className="muted-text settings-description">核对本地账号、任务与数据文件的完整性。</p>{integrityResult && <div className="integrity-summary" role="status">{integrityResult.success ? '本地数据完整性检查通过。' : integrityResult.issues.map((issue: string): React.ReactNode => <p key={issue}>{issue}</p>)}</div>}<Button type="primary" loading={checkingIntegrity} icon={<ToolOutlined />} onClick={(): void => { void moreMenuItems.find((item): boolean => item.key === 'integrity')?.onClick(); }}>{integrityResult ? '重新检查' : '开始检查'}</Button></section>
        <section className="workspace-card"><h2>诊断详情</h2><details className="settings-details"><summary>日志与问题反馈</summary><Space wrap>{toolButton('logs')}{toolButton('diagnostics')}</Space></details><details className="settings-details"><summary>页面兼容性与适配规则</summary><p className="muted-text">页面操作异常时，检查当前账号的页面或管理适配规则。</p><Space wrap>{toolButton('adapter-check')}{toolButton('adapter-import')}{toolButton('adapter-rollback')}</Space></details><details className="settings-details"><summary>运行统计</summary><Button icon={<BarChartOutlined />} onClick={(): void => { void loadDownloadJobs(); setMetricsOpen(true); }}>查看运行统计</Button></details><details className="settings-details"><summary>关于短剧工作室</summary><p className="muted-text">逐镜图片与视频创作。Dola 尚未完成真实端到端验收。</p></details></section></div>
      </div>}

    {/* 设置 Modal */}
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

    {/* 产物预览 Modal */}
    <OutputPreviewModal
      open={previewOpen}
      outputs={completedOutputs}
      scopeSummary={previewScope}
      onClose={() => setPreviewOpen(false)}
      onDownload={handleDoDownload}
    />
    <DownloadQueueModal
      open={downloadQueueOpen}
      jobs={downloadJobs}
      loading={downloadJobsLoading}
      onClose={() => setDownloadQueueOpen(false)}
      onRefresh={() => void loadDownloadJobs()}
      onRetry={handleRetryDownload}
    />
    <BatchManagerModal open={batchManagerOpen} onClose={() => setBatchManagerOpen(false)} onDownloadBatch={handleDownloadBatch} />
    <LogCenterModal open={logsOpen} onClose={() => setLogsOpen(false)} />
    <ProjectOverviewModal open={projectOverviewOpen} onClose={() => setProjectOverviewOpen(false)} />
    <Modal title="全局运行统计" open={metricsOpen} onCancel={() => setMetricsOpen(false)} footer={null} width={560}>
      <Progress percent={successRate} status={successRate >= 80 ? 'success' : 'normal'} />
      <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
        平台成功率只统计平台生成结果；依赖阻断（dependency_failed / dependency_missing / dependency_cycle）不计入分子或分母。
      </div>
      <Descriptions column={2} size="small" style={{ marginTop: 18 }}>
        <Descriptions.Item label="任务总数">{tasks.length}</Descriptions.Item>
        <Descriptions.Item label="成功率">{successRate}%</Descriptions.Item>
        <Descriptions.Item label="平均完成时间">{averageMinutes} 分钟</Descriptions.Item>
        <Descriptions.Item label="等待人工处理">
          {tasks.filter((task) => task.status === 'waiting_verification' || task.status === 'waiting_generation_confirmation' || task.status === 'manual_submission_observing' || task.status === 'paused').length}
        </Descriptions.Item>
        <Descriptions.Item label="失败任务">{platformStats.platformFailed}</Descriptions.Item>
        <Descriptions.Item label="依赖阻断">{platformStats.dependencyBlocked}</Descriptions.Item>
        <Descriptions.Item label="下载失败">{downloadJobsLoading ? '读取中' : downloadJobs.filter((job) => job.status === 'failed').length}</Descriptions.Item>
        <Descriptions.Item label="未标记登录/验证异常">
          {accounts.filter((account) => !account.health?.verificationRequired && account.health?.loginState !== 'expired').length}
        </Descriptions.Item>
        <Descriptions.Item label="历史额度耗尽记录">{accounts.filter((account) => account.seedanceQuota?.exhausted).length}</Descriptions.Item>
      </Descriptions>
    </Modal>
    <Modal
      title={`豆包页面兼容性 · ${adapterReport?.score ?? 0} 分`}
      open={!!adapterReport}
      onCancel={() => setAdapterReport(null)}
      footer={null}
      width={680}
    >
      {adapterReport && (
        <>
          <Progress percent={adapterReport.score} status={adapterReport.score >= 80 ? 'success' : 'exception'} />
          <Descriptions column={1} size="small" style={{ marginTop: 16 }}>
            <Descriptions.Item label="适配器版本">{adapterReport.adapterVersion}</Descriptions.Item>
            <Descriptions.Item label="页面地址">{adapterReport.pageUrl}</Descriptions.Item>
            {adapterReport.items.map((item) => (
              <Descriptions.Item key={item.key} label={item.label}>
                <span style={{ color: item.ok ? '#238563' : '#c44352' }}>{item.ok ? '正常' : '异常'}</span>
                <span style={{ marginLeft: 8, color: '#888' }}>{item.detail}</span>
              </Descriptions.Item>
            ))}
          </Descriptions>
        </>
      )}
    </Modal>
    </>
  );
};
