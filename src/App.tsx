import React, { useState, useEffect, useRef } from 'react';
import { Button, Tooltip } from 'antd';
import { AppstoreOutlined, EditOutlined, UnorderedListOutlined, FolderOpenOutlined, TeamOutlined, SettingOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MessageOutlined, VideoCameraOutlined, GlobalOutlined, CloseOutlined, ExpandOutlined, MinusOutlined, BorderOutlined } from '@ant-design/icons';
import BrowserPanel from './components/BrowserPanel';
import PetStoryChatAdjustmentPanel from './components/PetStoryChatAdjustmentPanel';
import { PetStoryPanel } from './components/PetStoryPanel';
import TaskConsole from './components/TaskConsole';
import { AccountList } from './components/AccountList';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { observePetStoryTasks } from './store/usePetStoryStore';
import { Toolbar } from './components/Toolbar';
import { useAccountStore } from './store/useAccountStore';
import { useTaskStore } from './store/useTaskStore';
import { useProjectStore } from './store/useProjectStore';
import { millisecondsUntilNextLocalMidnight } from './utils/dailyReset';
import { handleControlCommand } from './control/handleControlCommand';
import { WORKSPACE_PAGES, needsTaskAttention } from './utils/workspace';
import type { WorkspacePage } from './utils/workspace';
import type { Task } from './types';
import './styles/global.css';

const pageIcons: Record<WorkspacePage, React.ReactNode> = { overview: <AppstoreOutlined />, create: <EditOutlined />, tasks: <UnorderedListOutlined />, assets: <FolderOpenOutlined />, accounts: <TeamOutlined />, settings: <SettingOutlined /> };
const isMac = /Mac/.test(navigator.platform);

const App: React.FC = (): React.ReactElement => {
  const [page, setPage] = useState<WorkspacePage>('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserWide, setBrowserWide] = useState(false);
  const pageBeforeBrowser = useRef<WorkspacePage>('create');
  const changePage = (next: WorkspacePage): void => {
    if (next === 'accounts' && page !== 'accounts') pageBeforeBrowser.current = page;
    setPage(next);
  };
  const [version, setVersion] = useState('');
  useEffect(() => observePetStoryTasks(), []);
  useEffect((): void => { void window.electronAPI.system.getVersion().then(setVersion); }, []);
  const activeAccountId = useAccountStore((s) => s.selectedAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const tasks = useTaskStore((s) => s.tasks);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const refreshDailyQuota = useAccountStore((s) => s.refreshDailyQuota);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;
  const projectTasks = tasks.filter((t: Task): boolean => (t.projectId || 'default-project') === activeProjectId);
  const attention = projectTasks.filter(needsTaskAttention).length;
  const info = WORKSPACE_PAGES.find((item): boolean => item.id === page) || WORKSPACE_PAGES[0];

  useEffect((): (() => void) => {
    const navigate = (event: Event): void => {
      const detail = (event as CustomEvent<{ page: WorkspacePage; mode?: 'studio' | 'petstory' }>).detail;
      if (!WORKSPACE_PAGES.some((item): boolean => item.id === detail?.page)) return;
      setPage((current: WorkspacePage): WorkspacePage => { if (detail.page === 'accounts' && current !== 'accounts') pageBeforeBrowser.current = current; return detail.page; });
    };
    const reveal = (): void => setBrowserOpen(true);
    const revealWide = (): void => { setBrowserWide(true); setBrowserOpen(true); };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) setBrowserOpen(false); };
    window.addEventListener('navigate-workspace', navigate);
    window.addEventListener('reveal-workspace-browser', reveal);
    // 原会话／人工处理仍由 BrowserPanel 执行；这里仅展开可见区域。
    window.addEventListener('open-task-conversation', reveal);
    window.addEventListener('reconcile-task-submission', reveal);
    window.addEventListener('petstory-inspect-capability', revealWide);
    window.addEventListener('adapter-self-check', revealWide);
    window.addEventListener('keydown', escape);
    return (): void => {
      window.removeEventListener('navigate-workspace', navigate);
      window.removeEventListener('reveal-workspace-browser', reveal);
      window.removeEventListener('open-task-conversation', reveal);
      window.removeEventListener('reconcile-task-submission', reveal);
      window.removeEventListener('petstory-inspect-capability', revealWide);
      window.removeEventListener('adapter-self-check', revealWide);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const autoStates = useTaskStore((s) => s.accountAutomationState);
  useEffect((): void => {
    if (tasks.some((task: Task): boolean => ['waiting_verification', 'waiting_generation_confirmation'].includes(task.status))) setBrowserOpen(true);
  }, [tasks]);
  const interactive = Object.values(autoStates).some((state): boolean => state === 'injecting' || state === 'submitting');
  const browserVisible = browserOpen || interactive;

  // ---- 初始化加载 ----

  useEffect(() => {
    let startupQueueTimer: ReturnType<typeof setTimeout> | undefined;
    void Promise.all([loadAccounts(), loadProjects(), loadTasks(true)]).then(() => {
      // 账号/任务加载完成后做一次启动队列评估；否则已满足 all_accepted 的排队任务可能没有调度事件。
      startupQueueTimer = setTimeout(() => useTaskStore.getState().processQueue(), 0);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleMidnightRefresh = () => {
      timer = setTimeout(async () => {
        await refreshDailyQuota();
        useTaskStore.getState().processQueue();
        scheduleMidnightRefresh();
      }, millisecondsUntilNextLocalMidnight() + 250);
    };
    scheduleMidnightRefresh();
    return () => {
      if (timer) clearTimeout(timer);
      if (startupQueueTimer) clearTimeout(startupQueueTimer);
    };
  }, [loadAccounts, loadProjects, loadTasks, refreshDailyQuota]);

  // 本机控制面只通过稳定 ID 调用现有调度边界；不暴露 DOM/webview/页面会话。
  useEffect(() => {
    const unsubscribe = window.electronAPI.control.onCommand(async (command) => {
      const response = await handleControlCommand(command, {
        readTasks: async (): Promise<Task[]> => {
          const tasks = await window.electronAPI.tasks.list();
          // 本机指派写入主进程后，控制动作必须使用同一份新快照，不能启动旧的未指派投影。
          useTaskStore.setState({ tasks });
          return tasks;
        },
        start: (taskId) => useTaskStore.getState().startAutomation(taskId),
        retry: (taskId) => useTaskStore.getState().retryTask(taskId),
        getLastError: () => useTaskStore.getState().error,
        updateStatus: (taskId, status, result) => useTaskStore.getState().updateTaskStatus(taskId, status, result),
        abortActive: (taskId, targetStatus) => window.dispatchEvent(new CustomEvent('cancel-task-automation', {
          detail: { taskId, targetStatus },
        })),
      });
      try {
        await window.electronAPI.logs.append({
          level: response.ok ? 'info' : 'warn',
          scope: 'local_control',
          message: `${command.action}:${response.code}:project=${command.projectId}:batch=${command.batchId}:request=${command.requestId}`,
          taskId: command.taskId,
        });
      } catch {
        // 审计不可用不得吞掉已执行命令的确定结果；调用方仍可按 taskId 回读。
      }
      window.electronAPI.control.complete(response);
    });
    // Electron 的 did-start-loading 可能与首次 effect 交错并把 Main 侧就绪态
    // 重置。监听器已经注册后做短时、有界的幂等重申，避免服务永久停在
    // ready=false；不使用常驻心跳，也不会触发任何任务动作。
    const announceReady = () => window.electronAPI.control.ready();
    announceReady();
    const readinessInterval = setInterval(announceReady, 250);
    const readinessStop = setTimeout(() => clearInterval(readinessInterval), 5_000);
    return () => {
      unsubscribe();
      clearInterval(readinessInterval);
      clearTimeout(readinessStop);
    };
  }, []);


  return (
    <div className={`studio-shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <aside className="studio-nav" aria-label="主导航">
        <div className="studio-brand"><span className="brand-mark"><VideoCameraOutlined /></span>{!collapsed && <div><strong>短剧工作室</strong><span>STORY STUDIO</span></div>}</div>
        <nav>{WORKSPACE_PAGES.map((item): React.ReactNode => <Tooltip key={item.id} title={collapsed ? item.label : ''} placement="right"><button className={`nav-item ${page === item.id ? 'selected' : ''} ${item.id === 'settings' ? 'nav-settings' : ''}`} aria-current={page === item.id ? 'page' : undefined} aria-label={item.label} onClick={(): void => changePage(item.id)}>{pageIcons[item.id]}{!collapsed && <span>{item.label}</span>}</button></Tooltip>)}</nav>
        <div className="nav-footer">{!collapsed && <span>版本 {version || '读取中'}</span>}<Button type="text" aria-label={collapsed ? '展开导航' : '折叠导航'} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={(): void => setCollapsed(!collapsed)} /></div>
      </aside>
      <div className="studio-main">
        <header className="context-bar">
          <strong>创作工作台</strong>{page !== 'overview' && <><span className="context-divider">/</span><span className="context-page">{info.label}</span></>}
          <div className="context-actions">{attention > 0 && <Button type="text" className="context-attention" onClick={(): void => { setPage('tasks'); window.dispatchEvent(new CustomEvent('filter-attention-tasks')); }}>待处理 {attention}</Button>}<span className="context-account"><span className="context-account-dot" />{activeAccount?.name || '尚未选择账号'}</span><Button icon={<MessageOutlined />} aria-pressed={browserVisible} onClick={(): void => { setBrowserWide(false); setBrowserOpen(!browserOpen); }}>豆包 Chat</Button>
            {!isMac && <div className="window-controls"><Button type="text" aria-label="最小化" icon={<MinusOutlined />} onClick={(): void => window.electronAPI.system.minimize()} /><Button type="text" aria-label="最大化" icon={<BorderOutlined />} onClick={(): void => window.electronAPI.system.toggleMaximize()} /><Button type="text" aria-label="关闭" icon={<CloseOutlined />} onClick={(): void => window.electronAPI.system.close()} /></div>}
          </div>
        </header>
        <div className={`workspace-body ${page === 'accounts' ? 'browser-full' : browserVisible ? 'browser-open' : ''}`}>
          <main className="workspace-content">
            {page !== 'create' && <div className="page-heading"><div><h1>{page === 'overview' ? '创作工作台' : info.label}</h1><p>{page === 'overview' ? '从一个故事，开始下一部短剧。' : info.description}</p></div></div>}
            <Toolbar page={page} />
            {/* 新建弹窗的账号／目录选择与创作草稿一样，切去登录后仍保留。 */}
            <div className={page === 'overview' ? '' : 'page-hidden'}><WorkspaceOverview /></div>
            {/* 业务表单也保留在原位置，导航不会丢失未保存内容。 */}
            <div className={page === 'tasks' ? 'page-fill' : 'page-hidden'}><TaskConsole view="tasks" /></div>
            <div className={page === 'create' ? 'page-fill' : 'page-hidden'}><PetStoryPanel /></div>
            <div className={page === 'accounts' ? 'account-workspace' : 'page-hidden'}><AccountList /><p className="account-note">选择账号后，在右侧处理登录或查看会话。正在配置或提交时，请先等待当前操作结束。</p></div>
          </main>
          {/* 唯一运行时宿主：只调整 CSS；屏外保持非零尺寸及可合成，不改 key 或 partition。 */}
          <aside className={`browser-host ${page === 'accounts' ? 'is-full' : browserVisible ? 'is-assist' : 'is-parked'} ${interactive || browserWide && browserVisible ? 'is-engaged' : ''}`} aria-label="豆包常驻浏览器" aria-hidden={page !== 'accounts' && !browserVisible} {...(page !== 'accounts' && !browserVisible ? { inert: '' } : {})}>
            <div className="browser-host-header"><GlobalOutlined /><strong>{activeAccount?.name || '豆包浏览器'}</strong><span className="host-caption">豆包 Chat</span>{page !== 'accounts' && <Button type="text" aria-label="全宽浏览器" icon={<ExpandOutlined />} onClick={(): void => { changePage('accounts'); setBrowserOpen(false); }} />}<Button type="text" disabled={interactive} title={interactive ? '正在配置或提交，保持原账号可见' : undefined} aria-label={page === 'accounts' ? '返回之前的工作区' : '收起浏览器'} icon={<CloseOutlined />} onClick={(): void => { if (page === 'accounts') setPage(pageBeforeBrowser.current); setBrowserOpen(false); }} /></div>
            <BrowserPanel accounts={accounts} activeAccount={activeAccount} refreshKey={0} />
            <PetStoryChatAdjustmentPanel />
          </aside>
        </div>
      </div>
    </div>
  );
};

export default App;
