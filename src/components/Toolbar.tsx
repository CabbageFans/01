/**
 * src/components/Toolbar.tsx
 * 页面工具与低频维护入口
 * 复用原暂停、批次下载和维护处理函数，由六入口外壳决定展示位置。
 */

import React from 'react';
import { PauseCircleOutlined, PlayCircleOutlined, DownloadOutlined, FolderOpenOutlined, SettingOutlined, DatabaseOutlined, ToolOutlined, BarChartOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Button, Descriptions, message, Modal, Progress, Segmented, Space } from 'antd';

import { useTaskStore } from '../store/useTaskStore';
import { SettingsModal } from './SettingsModal';
import { OutputPreviewModal } from './OutputPreviewModal';
import type { OutputItem, OutputScopeSummary } from './OutputPreviewModal';
import { DownloadQueueModal } from './DownloadQueueModal';
import type { AdapterSelfCheckReport, DownloadJob } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { ArtifactCenterModal } from './ArtifactCenterModal';
import { BatchManagerModal } from './BatchManagerModal';
import { installAdapterBundle, rollbackAdapterBundle } from '../automation/doubaoAdapter';
import { LogCenterModal } from './LogCenterModal';
import { ProjectOverviewModal } from './ProjectOverviewModal';
import { useProjectStore } from '../store/useProjectStore';
import type { WorkspacePage } from '../utils/workspace';
import { calculatePlatformSuccessRate, getPlatformTaskStats } from '../utils/taskStats';

interface ToolbarProps { page: WorkspacePage; }

/** 页面工具保留旧处理函数和模态框，入口从顶栏移入对应业务页面。 */
export const Toolbar: React.FC<ToolbarProps> = ({ page }): React.ReactElement => {
  const [assetView, setAssetView] = React.useState<'outputs' | 'downloads'>('outputs');
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
    .filter((task) => task.status === 'done' && task.runtime?.startedAt)
    .map((task) => new Date(task.updatedAt).getTime() - new Date(task.runtime!.startedAt).getTime())
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
        const result = await window.electronAPI.system.checkIntegrity();
        if (result.success) message.success('数据完整性检查通过');
        else message.error(result.issues.join('；'));
      },
    },
    {
      key: 'backup',
      label: '备份 Studio 数据',
      onClick: async () => {
        const result = await window.electronAPI.system.exportBackup();
        if (result.success) message.success(`备份已导出：${result.filePath}`);
        else if (result.error) message.error(result.error);
      },
    },
    {
      key: 'restore',
      label: '恢复 Studio 数据备份',
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

  const toolButton = (key: string): React.ReactNode => {
    const item = moreMenuItems?.find((entry): boolean => entry?.key === key);
    if (!item || !('label' in item)) return null;
    return <Button key={key} disabled={'disabled' in item && item.disabled} onClick={(): void => {
      if ('onClick' in item && item.onClick) void item.onClick();
    }}>{item.label}</Button>;
  };

  return (
    <>
      {page === 'overview' && <div className="page-tools"><Button icon={<FolderOpenOutlined />} onClick={(): void => setProjectOverviewOpen(true)}>当前项目概览与元数据导出</Button></div>}
      {page === 'tasks' && <div className="page-tools"><Button icon={schedulerPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={(): void => { void handleTogglePause(); }}>{schedulerPaused ? '继续全局调度' : '暂停全局调度'}</Button><Button icon={<UnorderedListOutlined />} onClick={(): void => setBatchManagerOpen(true)}>当前项目批次</Button><span className="muted-text">全局调度{schedulerPaused ? '已暂停' : '运行中'} · 任务列表按当前项目显示</span></div>}
      {page === 'assets' && <section className="workspace-card asset-workspace">
        <div className="section-heading"><Segmented value={assetView} onChange={(value): void => setAssetView(value as 'outputs' | 'downloads')} options={[{ label: '产物', value: 'outputs' }, { label: '下载记录', value: 'downloads' }]} /><Button icon={<DownloadOutlined />} disabled={!completedWithOutputs} onClick={handleBatchDownload}>按批次选择下载</Button></div>
        <p className="muted-text asset-scope">产物范围：当前 Studio 项目。远程地址状态与本地文件校验分别显示。</p>
        <ArtifactCenterModal open={assetView === 'outputs'} embedded onClose={(): void => setAssetView('outputs')} />
        {assetView === 'downloads' && <DownloadQueueModal embedded open jobs={downloadJobs} loading={downloadJobsLoading} onClose={(): void => setAssetView('outputs')} onRefresh={(): void => { void loadDownloadJobs(); }} onRetry={handleRetryDownload} />}
      </section>}
      {page === 'settings' && <div className="settings-groups">
        <section className="workspace-card"><div className="section-heading"><div><h2><SettingOutlined /> 偏好</h2><p>下载目录、素材授权与初始化并发</p></div></div><Space wrap>{toolButton('settings')}{toolButton('updates')}</Space></section>
        <section className="workspace-card"><div className="section-heading"><div><h2><DatabaseOutlined /> 数据与维护</h2><p>Studio 数据备份不自动包含外部萌宠项目目录和全部媒体</p></div></div><Space wrap>{['integrity', 'backup', 'restore'].map(toolButton)}</Space></section>
        <section className="workspace-card"><div className="section-heading"><div><h2><ToolOutlined /> 诊断</h2><p>当前账号页面自检、运行日志与页面适配规则</p></div></div><Space wrap>{['logs', 'diagnostics', 'adapter-check', 'adapter-import', 'adapter-rollback'].map(toolButton)}<Button icon={<BarChartOutlined />} onClick={(): void => { void loadDownloadJobs(); setMetricsOpen(true); }}>全局运行统计</Button></Space></section>
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
        <Descriptions.Item label="未标记登录/额度异常">
          {accounts.filter((account) => !account.seedanceQuota?.exhausted && !account.health?.verificationRequired && account.health?.loginState !== 'expired').length}
        </Descriptions.Item>
        <Descriptions.Item label="额度耗尽账号">{accounts.filter((account) => account.seedanceQuota?.exhausted).length}</Descriptions.Item>
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
