import { create } from 'zustand';
import type { Task, PetStoryPlan, PetStoryProject, PetStoryPromptKind, PetStoryResult, PetStoryChatJob, PetStoryCapability, PetStoryProductionCounts, PetStoryModeResolution } from '@doubao-studio/contracts';
import { useTaskStore } from './useTaskStore';
import { useAccountStore } from './useAccountStore';
import { useProjectStore } from './useProjectStore';
import { analysisPrompt, optimizationPrompt, repairPrompt } from '../utils/petstoryPrompts';

interface PetStoryState {
  project: PetStoryProject | null;
  projectName: string;
  capability: PetStoryCapability | null;
  productionCounts: PetStoryProductionCounts | null;
  productionResolutions: Record<string, PetStoryModeResolution>;
  fallbacks: Record<string, 'first_frame' | 'reference'>;
  selectProductionImage: (stepId: string, artifactId: string) => Promise<void>;
  inspectCapability: (freeConfirmed: boolean) => Promise<void>;
  setFallback: (shotId: string, mode?: 'first_frame' | 'reference') => void;
  previewProduction: () => Promise<void>;
  startProduction: () => Promise<void>;
  pauseProduction: () => Promise<void>;
  resumeProduction: () => Promise<void>;

  busy: boolean;
  error: string;
  freeChatConfirmed: boolean;
  autoRepair: boolean;
  setFreeChatConfirmed: (value: boolean) => void;
  setAutoRepair: (value: boolean) => void;
  createProject: () => Promise<void>;
  openProject: () => Promise<void>;
  saveSource: (text: string) => Promise<void>;
  saveMobileStory: (text: string) => Promise<void>;
  addSceneReference: (shotId: string) => Promise<void>;
  addReference: (characterId: string) => Promise<void>;
  savePlan: (plan: PetStoryPlan) => Promise<void>;
  analyze: () => Promise<void>;
  optimize: (shotId: string, kind: PetStoryPromptKind) => Promise<void>;
  correctOnce: (jobId: string) => Promise<void>;
  startBoundChat: (jobId: string) => Promise<void>;
  retryUnsubmitted: (jobId: string) => Promise<void>;
  collect: (jobId: string, allowRepair?: boolean) => Promise<void>;
  draftFinal: (shotId: string) => Promise<void>;
}
const liveJobs = new Set<string>();
let activeProductionId: string | null = null;
let productionTickRunning = false;
const observingProductionTasks = new Set<string>();
/** 打开清单不启用接力；只在本会话一次确认或显式继续后推进。 */
export async function tickPetStoryProduction(): Promise<void> {
  const id = activeProductionId;
  const state = usePetStoryStore.getState();
  if (!id || state.project?.id !== id || state.busy || productionTickRunning) return;
  productionTickRunning = true;
  try {
    const result = await window.electronAPI.petstory.advanceProduction(id);
    if (result.project && usePetStoryStore.getState().project?.id === id) usePetStoryStore.setState({ project: result.project });
    if (activeProductionId !== id) return;
    if (!result.success || result.project?.production?.state !== 'running') {
      activeProductionId = null;
      if (!result.success) usePetStoryStore.setState({ error: result.error || '制作已暂停' });
      return;
    }
    if (result.taskId && result.action === 'start') {
      await refreshTasks();
      if (activeProductionId !== id) return;
      const started = await useTaskStore.getState().startAutomation(result.taskId, async (task: Task): Promise<void> => {
        if (activeProductionId !== id || !task.runtime) throw new Error('制作已暂停');
        const bound = await window.electronAPI.petstory.bindProductionRun(id, task.id, task.runtime.runId);
        if (!bound.success) throw new Error(bound.error || '制作运行绑定未保存');
        if (bound.project) usePetStoryStore.setState({ project: bound.project });
      });
      if (!started) {
        activeProductionId = null;
        const paused = await window.electronAPI.petstory.pauseProduction(id);
        usePetStoryStore.setState({ ...(paused.project ? { project: paused.project } : {}), error: useTaskStore.getState().error || '原任务未启动，请处理后继续' });
      }
    } else if (result.taskId && result.action === 'observe') {
      if (observingProductionTasks.has(result.taskId)) {
        activeProductionId = null;
        const paused = await window.electronAPI.petstory.pauseProduction(id);
        usePetStoryStore.setState({ ...(paused.project ? { project: paused.project } : {}), error: '原会话本轮只读观察未完成，请处理后显式继续；未重新生成' });
        return;
      }
      observingProductionTasks.add(result.taskId);
      const resumed = await useTaskStore.getState().updateTaskRuntime(result.taskId, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '继续只读观察原制作会话，不重复发送' } });
      if (!resumed || activeProductionId !== id) return;
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: result.taskId } }));
    }
  } catch (error: unknown) {
    activeProductionId = null;
    usePetStoryStore.setState({ error: error instanceof Error ? error.message : '制作接力中断，请打开原项目核对后继续' });
  } finally { productionTickRunning = false; }
}
async function refreshTasks(): Promise<void> {
  const tasks = await window.electronAPI.tasks.list();
  useTaskStore.setState({ tasks });
}
export const usePetStoryStore = create<PetStoryState>((set, get) => {
  const accept = (result: PetStoryResult): void => {
    if (result.project) set({ project: result.project, projectName: result.displayName ?? (get().project?.id === result.project.id ? get().projectName : '') });
    if (!result.success) set({ error: result.error || '操作未完成' });
  };
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (get().busy) return;
    set({ busy: true, error: '' });
    try { await work(); }
    catch (error: unknown) { set({ error: error instanceof Error ? error.message : '操作失败' }); }
    finally { set({ busy: false }); }
  };
  const startBound = async (jobId: string): Promise<void> => {
    const project = get().project;
    const job = project?.jobs.find((j): boolean => j.id === jobId);
    if (!project || !job || job.status !== 'bound') throw new Error('请选择原步骤');
    if (!project.mobileStory || job.sourceStoryId !== project.mobileStory.id) throw new Error('旧版链接直读任务已停用，请保存手机豆包故事后生成制作方案');
    if (!get().freeChatConfirmed) throw new Error('请本人确认当前普通Chat免费可用');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原Studio项目不存在');
    liveJobs.add(job.id);
    const started = await useTaskStore.getState().startAutomation(job.taskId, async (task: Task): Promise<void> => {
      if (!job || !task.runtime?.runId) throw new Error('本步骤运行未初始化');
      const bound = await window.electronAPI.petstory.bindRun(project.id, job.id, task.runtime.runId);
      accept(bound);
      if (!bound.success) throw new Error(bound.error || '本步骤运行绑定未保存');
    });
    if (!started) throw new Error(useTaskStore.getState().error || '原任务保持已绑定；请处理原因后启动原任务，不要重复分析');
  };
  const prepare = async (prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind): Promise<void> => {
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (!get().freeChatConfirmed) throw new Error('请先由本人确认当前普通Chat免费可用，未知时暂停');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    const result = await window.electronAPI.petstory.prepareChat(project.id, prompt, kind, parentJobId, shotId, promptKind);
    accept(result);
    if (!result.success || !result.taskId || !result.project) return;
    await refreshTasks();
    const job = result.project.jobs.find((j): boolean => j.taskId === result.taskId);
    if (job) await startBound(job.id);
  };
  return {
    project: null, projectName: '', capability: null, productionCounts: null, productionResolutions: {}, fallbacks: {},
    selectProductionImage: async (stepId: string, artifactId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.selectProductionImage(p.id, stepId, artifactId));
    }),
    inspectCapability: async (freeConfirmed: boolean): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) throw new Error('请先打开原项目');
      const capability = await new Promise<PetStoryCapability>((resolve, reject): void => {
        const timeout = setTimeout((): void => reject(new Error('当前可见入口检查超时，仍记待确认，未上传或提交')), 60_000);
        window.dispatchEvent(new CustomEvent('petstory-inspect-capability', { detail: { accountId: p.accountId, freeConfirmed,
          resolve: (value: PetStoryCapability): void => { clearTimeout(timeout); resolve(value); },
          reject: (error: Error): void => { clearTimeout(timeout); reject(error); } } }));
      });
      set({ capability, productionCounts: null, productionResolutions: {} });
    }),
    setFallback: (shotId: string, mode?: 'first_frame' | 'reference'): void => {
      const fallbacks = { ...get().fallbacks };
      if (mode) fallbacks[shotId] = mode; else delete fallbacks[shotId];
      set({ fallbacks, productionCounts: null, productionResolutions: {} });
    },
    previewProduction: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const capability = get().capability;
      if (!p || !capability) throw new Error('请先核对当前原账号的免费创作入口');
      const result = await window.electronAPI.petstory.previewProduction(p.id, capability, get().fallbacks);
      accept(result);
      set({ productionCounts: result.counts || null, productionResolutions: result.resolutions || {} });
    }),
    startProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p || !capability || !get().productionCounts) throw new Error('请先查看并确认制作数量');
        const result = await window.electronAPI.petstory.approveProduction(p.id, p.revision, capability, get().fallbacks);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); }
      });
      await tickPetStoryProduction();
    },
    pauseProduction: async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      activeProductionId = null;
      const taskId = p.production?.steps.find((s): boolean => s.status !== 'complete')?.taskId;
      if (taskId) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId } }));
      await run(async (): Promise<void> => accept(await window.electronAPI.petstory.pauseProduction(p.id)));
    },
    resumeProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p || !capability) throw new Error('重新打开后请本人核对当前入口，再显式继续原制作');
        const result = await window.electronAPI.petstory.resumeProduction(p.id, capability);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); }
        await refreshTasks();
      });
      await tickPetStoryProduction();
    },
    busy: false, error: '', freeChatConfirmed: false, autoRepair: true,
    setFreeChatConfirmed: (value: boolean): void => set({ freeChatConfirmed: value }),
    setAutoRepair: (value: boolean): void => set({ autoRepair: value }),
    createProject: async (): Promise<void> => run(async (): Promise<void> => {
      activeProductionId = null;
      set({ capability: null, productionCounts: null, fallbacks: {} });
      const accountId = useAccountStore.getState().selectedAccountId;
      if (!accountId) throw new Error('请先选择已登录的豆包账号');
      const result = await window.electronAPI.petstory.create(useProjectStore.getState().activeProjectId, accountId);
      accept(result);
      if (result.success) { liveJobs.clear(); set({ freeChatConfirmed: false }); }
    }),
    openProject: async (): Promise<void> => run(async (): Promise<void> => {
      activeProductionId = null;
      liveJobs.clear();
      set({ freeChatConfirmed: false, capability: null, productionCounts: null, fallbacks: {} });
      const result = await window.electronAPI.petstory.open();
      accept(result);
      if (result.project) {
        const project = result.project;
        const studio = useProjectStore.getState();
        if (studio.projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) studio.selectProject(project.studioProjectId);
        else set({ error: '原 Studio 项目缺失或已归档，保留当前文件，不能开始新的对话' });
        if (useAccountStore.getState().accounts.some((a): boolean => a.id === project.accountId)) useAccountStore.getState().selectAccount(project.accountId);
      }
    }),
    saveSource: async (text: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.saveSource(p.id, p.revision, text));
    }),
    saveMobileStory: async (text: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.saveMobileStory(p.id, p.revision, text));
    }),
    addSceneReference: async (shotId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.addSceneReference(p.id, shotId));
      set({ productionCounts: null });
    }),
    addReference: async (characterId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.addReference(p.id, characterId));
      set({ productionCounts: null });
    }),
    savePlan: async (plan: PetStoryPlan): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      set({ productionCounts: null });
      if (p) accept(await window.electronAPI.petstory.savePlan(p.id, p.revision, plan));
    }),
    analyze: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) await prepare(analysisPrompt(p), 'analysis');
    }),
    optimize: async (shotId: string, kind: PetStoryPromptKind): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) await prepare(optimizationPrompt(p, shotId, kind), 'optimize', undefined, shotId, kind);
    }),
    correctOnce: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      const job = p?.jobs.find((j): boolean => j.id === jobId);
      if (p && job) await prepare(repairPrompt(p, job), 'repair', job.id);
    }),
    startBoundChat: async (jobId: string): Promise<void> => run((): Promise<void> => startBound(jobId)),
    retryUnsubmitted: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p || !get().freeChatConfirmed) throw new Error('请先打开原项目并本人确认普通 Chat 免费可用');
      const result = await window.electronAPI.petstory.retryUnsubmitted(p.id, jobId);
      accept(result);
      await refreshTasks();
      if (result.success) await startBound(jobId);
    }),
    collect: async (jobId: string, allowRepair = false): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      const result = await window.electronAPI.petstory.collectChat(p.id, jobId);
      accept(result);
      if (allowRepair && get().autoRepair && get().freeChatConfirmed && liveJobs.has(jobId) && result.needsRepair && result.project) {
        const job = result.project.jobs.find((j): boolean => j.id === jobId);
        if (job) await prepare(repairPrompt(result.project, job), 'repair', job.id);
      }
      liveJobs.delete(jobId);
    }),
    draftFinal: async (shotId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      accept(await window.electronAPI.petstory.draftFinal(p.id, shotId, 'firstFrame'));
      await refreshTasks();
    }),
  };
});
/** 仅收取本会话显式启动任务的结果；打开项目不会授权纠正或发送。 */
export function observePetStoryTasks(): () => void {
  const attempted = new Set<string>();
  const interval = setInterval((): void => { void tickPetStoryProduction(); }, 1000);
  const unsubscribe = useTaskStore.subscribe((state): void => {
    void tickPetStoryProduction();
    const p = usePetStoryStore.getState();
    if (p.busy || !p.project) return;
    const job = p.project.jobs.find((j): boolean => liveJobs.has(j.id) && !attempted.has(j.id) && j.status === 'bound' && state.tasks.some((t): boolean => t.id === j.taskId && t.status === 'done' && !!t.runtime?.chatResponse));
    if (!job) return;
    attempted.add(job.id);
    void p.collect(job.id, true);
  });
  return (): void => { clearInterval(interval); unsubscribe(); };
}
