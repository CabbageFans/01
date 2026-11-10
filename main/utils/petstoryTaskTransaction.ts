import type { PetStoryProject, PetStoryTaskIntent, Task, TaskAddParams } from '@doubao-studio/contracts';

interface IntentProjects { read: (id: string) => Promise<PetStoryProject>; write: (project: PetStoryProject) => Promise<PetStoryProject> }
interface IntentTasks { list: () => Task[]; create: (input: TaskAddParams, accountId: string) => Task }

function matchesIntent(task: Task, project: PetStoryProject, intent: PetStoryTaskIntent): boolean {
  const binding = intent.kind === 'media' ? task.petstory : task.petstoryChat;
  return binding?.projectId === project.id && (intent.kind === 'media' ? task.petstory?.stepId : task.petstoryChat?.jobId) === intent.targetId;
}
/** 所有 task/project 绑定遵循同一写入顺序；重启只修复关联，不获取派发授权。 */
export async function commitPetStoryTaskIntent(projects: IntentProjects, tasks: IntentTasks, project: PetStoryProject, intent: PetStoryTaskIntent,
  bind: (project: PetStoryProject, task: Task) => void, create?: () => Task): Promise<{ project: PetStoryProject; task: Task }> {
  let current = project;
  const existing = current.taskIntents?.find((item): boolean => item.operationId === intent.operationId);
  if (!existing) { current.taskIntents = [...(current.taskIntents || []), structuredClone(intent)]; current = await projects.write(current); }
  const stored = current.taskIntents?.find((item): boolean => item.operationId === intent.operationId);
  if (!stored) throw new Error('原任务意图写入回读缺失');
  const matches = tasks.list().filter((task): boolean => matchesIntent(task, current, stored));
  if (matches.length > 1) throw new Error('同一制作意图存在多个历史任务，请选择保留的原任务；未启动或重复创建');
  const candidate = matches[0];
  // Task落盘与账号绑定之间退出也属于同一意图；TaskService.create幂等回读后补完原账号绑定。
  const task = candidate && candidate.assignedAccountId !== null ? candidate : (create ? create() : tasks.create(stored.input, stored.accountId));
  if (task.projectId !== current.studioProjectId || task.assignedAccountId !== current.accountId || !matchesIntent(task, current, stored)
    || task.prompt !== stored.input.prompts[0]) throw new Error('原任务意图与实际任务不符，未授权派发');
  // 再读保证异步写入期间的暂停、结束或新编辑不会被覆盖。
  const latest = await projects.read(current.id);
  if (latest.revision !== current.revision) throw new Error('任务创建期间项目已变化；原hold任务已保留，可继续原意图');
  bind(current, task); stored.taskId = task.id;
  current = await projects.write(current);
  return { project: current, task };
}

/** 读入后可重入修复已创建任务的项目关联，不创建新任务、不触发平台。 */
export async function reconcilePetStoryTaskIntents(projects: IntentProjects, tasks: Pick<IntentTasks, 'list'>, project: PetStoryProject): Promise<PetStoryProject> {
  let changed = false;
  for (const intent of project.taskIntents || []) {
    const matches = tasks.list().filter((task): boolean => matchesIntent(task, project, intent));
    if (matches.length > 1) continue;
    const task = matches[0];
    if (!task || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId || task.prompt !== intent.input.prompts[0]) continue;
    if (intent.kind === 'chat' && intent.chatJob && !project.jobs.some((job): boolean => job.id === intent.targetId)) {
      bindPetStoryChatIntent(project, intent, task); changed = true;
    }
    if (intent.kind === 'media') {
      const production = [project.production, ...Object.values(project.imageProductions || {})].find((item): boolean => !!item?.steps.some((step): boolean => step.id === intent.targetId));
      const step = production?.steps.find((item): boolean => item.id === intent.targetId);
      if (step && !step.taskId) { step.taskId = task.id; step.status = 'bound'; changed = true; }
    }
    if (intent.taskId !== task.id) { intent.taskId = task.id; changed = true; }
  }
  return changed ? projects.write(project) : project;
}

/** 正文任务的项目内关联由同一日志协调器恢复，包括图片准备、批次和局部修订。 */
export function bindPetStoryChatIntent(project: PetStoryProject, intent: PetStoryTaskIntent, task: Task): void {
  if (intent.kind !== 'chat' || !intent.chatJob) throw new Error('原正文意图模板缺失');
  const job = { ...structuredClone(intent.chatJob), taskId: task.id };
  if (!project.jobs.some((item): boolean => item.id === job.id)) project.jobs.push(job);
  const operationId = intent.input.petstoryChat?.imageOperationId;
  const operation = operationId ? project.imageOperations?.find((item): boolean => item.id === operationId) : undefined;
  if (operation && job.kind === 'materialPrompt') operation.chatJobId = job.id;
  if (project.promptBatch?.status === 'running' && job.promptBatchId === project.promptBatch.id) project.promptBatch.jobId = job.id;
  if (project.chatAdjustment?.status === 'active' && job.repairReplySource?.adjustmentId === project.chatAdjustment.id) project.chatAdjustment.repairJobId = job.id;
}
