/**
 * src/components/TaskConsole.tsx
 * 任务调度控制台 — V3 多模式支持
 *
 * 支持：
 * - 批量添加任务 + 选择生成模式（对话/图片/视频/音乐）
 * - 指派账号、启动自动化、查看状态
 * - 任务列表中显示模式标签
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button, Select, Input, Modal, Dropdown, Space, Segmented, Tooltip, message, Switch, Alert, Collapse, Table, Tag } from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  SyncOutlined,
  PictureOutlined,
  AudioOutlined,
  EyeOutlined,
  ReloadOutlined,
  EditOutlined,
  StopOutlined,
  FileExcelOutlined,
  MessageOutlined,
  VideoCameraOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { useTaskStore, isDependencyBlockedTask, describeDependencyBlock } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import TaskDetailModal from './TaskDetailModal';
import type { Task, TaskUpdateInput } from '../types';
import { isTaskConversationMissing } from '../utils/taskConversationLocator';
import {
  TASK_STATUS_CONFIG,
  TASK_STAGE_LABELS,
  GENERATION_MODE_CONFIG,
  VIDEO_MODEL_LABELS,
  VIDEO_MODEL_COST,
  DEFAULT_VIDEO_CONFIG,
  type GenerationMode,
  type VideoModel,
  type VideoDuration,
  type VideoAspectRatio,
} from '../types';
import { evaluateVideoCapability } from '../utils/videoCapability';
import { buildManualAssignmentOptions } from '../utils/accountAssignment';
import { buildAutoAssignmentPlan } from '../utils/autoAssignment';
import { requiresSubmissionReconciliation } from '../utils/realSendStateMachine';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { navigateWorkspace, needsTaskAttention, taskNextAction, revealBrowser } from '../utils/workspace';
import type { ColumnsType } from 'antd/es/table';
import { decideCsvDrop } from '../utils/csvDrop';

const { TextArea } = Input;

interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  mode: GenerationMode;
  videoConfig?: Task['videoConfig'];
  attachments: string[];
  audioAttachment?: string;
}

function expandPromptVariables(promptText: string, rowsText: string): string {
  const rows = rowsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length === 0) return promptText;
  const prompts = promptText.split('%%%%%%%%%%').map((item) => item.trim()).filter(Boolean);
  const expanded: string[] = [];
  for (const row of rows) {
    const values = new Map<string, string>();
    for (const pair of row.split(/[;；]/)) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    for (const prompt of prompts) {
      expanded.push(prompt.replace(/\{\{([^}]+)\}\}/g, (match, key) => values.get(String(key).trim()) ?? match));
    }
  }
  return expanded.join('\n%%%%%%%%%%\n');
}

// ==================== 模式选择组件 ====================

const ModeSelector: React.FC<{
  value: GenerationMode;
  onChange: (mode: GenerationMode) => void;
}> = ({ value, onChange }) => {
  const icons: Record<GenerationMode, React.ReactNode> = { chat: <MessageOutlined />, image: <PictureOutlined />, video: <VideoCameraOutlined />, music: <AudioOutlined /> };
  return <Segmented aria-label="生成模式" value={value} onChange={(val): void => onChange(val as GenerationMode)} options={Object.entries(GENERATION_MODE_CONFIG).map(([key, cfg]): { label: React.ReactNode; value: string } => ({ label: <span className="mode-option">{icons[key as GenerationMode]}{cfg.label}</span>, value: key }))} block />;
};

type ArmTasksFn = (taskIds: string[]) => Promise<{ armed: number; failed: number; error?: string }>;

function autoExecuteTooltip(enabled: boolean): string {
  return enabled ? '导入后执行：开启' : '导入后执行：关闭';
}

function importedExecutionSuffix(armed: number): string {
  return armed > 0 ? `，已显式授权执行 ${armed} 条` : '';
}

async function armImportedTasksAfterAssignment(importedTasks: Task[], autoExecute: boolean, armTasks: ArmTasksFn): Promise<number> {
  if (!autoExecute || importedTasks.length === 0) return 0;
  const importedIds = new Set(importedTasks.map((task) => task.id));
  const assignedIds = useTaskStore.getState().tasks
    .filter((task) => importedIds.has(task.id) && task.assignedAccountId)
    .map((task) => task.id);
  if (assignedIds.length === 0) {
    message.info('已导入任务，但没有已指派账号；任务保持 hold，需指派后手动启动');
    return 0;
  }
  const armResult = await armTasks(assignedIds);
  if (armResult.failed > 0) message.warning(armResult.error || `${armResult.failed} 条任务执行意图写入失败，已保持 hold`);
  return armResult.armed;
}

// ==================== 组件 ====================

const TaskConsole: React.FC<{ view?: 'create' | 'tasks' }> = ({ view = 'tasks' }): React.ReactElement => {
  const {
    tasks: allTasks,
    addTasks,
    importCsv,
    assignTask,
    armTasks,
    deleteTask,
    startAutomation,
    accountBusy,
    clearError,
    error,
    updateTask,
  } = useTaskStore();
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const activeProject = useProjectStore((state) => state.projects.find((project) => project.id === state.activeProjectId));
  const tasks = allTasks.filter((task) => (task.projectId || 'default-project') === activeProjectId);

  const accounts = useAccountStore((s) => s.accounts);
  const selectAccount = useAccountStore((s) => s.selectAccount);
  const accountAutomationState = useTaskStore((s) => s.accountAutomationState);

  const [creationAccountId, setCreationAccountId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState<'all' | 'attention' | 'queued' | 'done'>('all');
  const [creating, setCreating] = useState(false);
  const [inputText, setInputText] = useState('');
  const [selectedMode, setSelectedMode] = useState<GenerationMode>('chat');
  const [videoConfig, setVideoConfig] = useState({ ...DEFAULT_VIDEO_CONFIG });
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachmentBase64s, setAttachmentBase64s] = useState<Record<string, string>>({});
  const [audioAttachment, setAudioAttachment] = useState<string>('');
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const liveSelectedTask = allTasks.find((task: Task): boolean => task.id === selectedTask?.id) || selectedTask;
  const [autoAssign, setAutoAssign] = useState(false);
  const [autoExecute, setAutoExecute] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editingPrompt, setEditingPrompt] = useState('');
  const [editingVideoConfig, setEditingVideoConfig] = useState({ ...DEFAULT_VIDEO_CONFIG });
  const [editingAttachments, setEditingAttachments] = useState<string[]>([]);
  const [editingAttachmentBase64s, setEditingAttachmentBase64s] = useState<Record<string, string>>({});
  const [editingAudioAttachment, setEditingAudioAttachment] = useState('');
  const [variableRows, setVariableRows] = useState('');
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [isCsvDragging, setIsCsvDragging] = useState(false);
  const [isCsvImporting, setIsCsvImporting] = useState(false);
  const csvDragDepth = useRef(0);

  useEffect(() => {
    void window.electronAPI.settings.get().then((settings) => {
      setTemplates(Array.isArray(settings.taskTemplates) ? settings.taskTemplates : []);
      setAutoAssign(settings.autoAssignEnabled === true);
      setAutoExecute(settings.autoExecuteEnabled === true);
    });
  }, []);

  useEffect((): (() => void) => {
    const showTask = (event: Event): void => {
      const task = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === (event as CustomEvent<{ taskId: string }>).detail?.taskId);
      if (task) { setSelectedTask(task); setDetailModalOpen(true); }
    };
    const attention = (): void => setTaskFilter('attention');
    window.addEventListener('show-workspace-task', showTask);
    window.addEventListener('filter-attention-tasks', attention);
    return (): void => { window.removeEventListener('show-workspace-task', showTask); window.removeEventListener('filter-attention-tasks', attention); };
  }, []);

  const persistTemplates = async (nextTemplates: TaskTemplate[]) => {
    const settings = await window.electronAPI.settings.get();
    await window.electronAPI.settings.save({ ...settings, taskTemplates: nextTemplates });
    setTemplates(nextTemplates);
  };

  const saveCurrentTemplate = async () => {
    if (!templateName.trim()) return;
    const template: TaskTemplate = {
      id: `template-${Date.now()}`,
      name: templateName.trim(),
      prompt: inputText,
      mode: selectedMode,
      videoConfig: selectedMode === 'video' ? { ...videoConfig } : undefined,
      attachments: [...attachments],
      audioAttachment: audioAttachment || undefined,
    };
    await persistTemplates([...templates, template]);
    setTemplateName('');
    setTemplateModalOpen(false);
    message.success('任务模板已保存');
  };

  const applyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setInputText(template.prompt);
    setSelectedMode(template.mode);
    setVideoConfig({ ...(template.videoConfig || DEFAULT_VIDEO_CONFIG) });
    setAttachments([...template.attachments]);
    setAudioAttachment(template.audioAttachment || '');
    setAttachmentBase64s({});
    for (const filePath of template.attachments) {
      void window.electronAPI.tasks.readFileAsBase64(filePath).then((result) => {
        if (result.success && result.data) {
          setAttachmentBase64s((current) => ({ ...current, [filePath]: result.data! }));
        }
      });
    }
  };

  // ---- 自动分配账号 ----
  const autoAssignTasks = useCallback(async (newTasks: Task[]) => {
    const plan = buildAutoAssignmentPlan(newTasks, allTasks, accounts);
    let assigned = 0;
    let unassigned = plan.unassignedTaskIds.length;
    for (const assignment of plan.assignments) {
      if (await assignTask(assignment.taskId, assignment.accountId)) assigned++;
      else unassigned++;
    }
    return { assigned, unassigned };
  }, [accounts, allTasks, assignTask]);

  // ---- 添加任务 ----

  const handleAddTasks = useCallback(async (): Promise<void> => {
    if (creating || !inputText.trim()) return;
    setCreating(true);
    try {
    const vc = selectedMode === 'video' ? videoConfig : undefined;
    const att = (selectedMode === 'video' || selectedMode === 'image') && attachments.length > 0 ? attachments : undefined;
    const audioAtt = selectedMode === 'video' && audioAttachment ? audioAttachment : undefined;
    const expandedText = expandPromptVariables(inputText, variableRows);
    const newTasks = await addTasks(expandedText, selectedMode, vc, att, audioAtt);
    if (newTasks && newTasks.length > 0) {
      // 自动指派
      if (creationAccountId) {
        for (const task of newTasks) await assignTask(task.id, creationAccountId);
      } else if (autoAssign) {
        const assignment = await autoAssignTasks(newTasks);
        if (assignment.unassigned > 0) {
          message.warning(`${assignment.unassigned} 个任务没有满足额度/健康条件的可用账号，已保留为未指派`);
        }
      }
      setInputText('');
      setSelectedMode('chat');
      setVideoConfig({ ...DEFAULT_VIDEO_CONFIG });
      setAttachments([]);
      setAudioAttachment('');
      setVariableRows('');
      message.success(`已创建 ${newTasks.length} 项待执行任务；尚未授权发送`);
    }
    } finally { setCreating(false); }
  }, [creating, creationAccountId, assignTask, inputText, variableRows, selectedMode, videoConfig, attachments, audioAttachment, addTasks, autoAssign, autoAssignTasks]);

  const handleImportCsv = useCallback(async (filePath?: string) => {
    if (isCsvImporting) return;
    setIsCsvImporting(true);
    try {
      const result = await importCsv(filePath);
      if (!result) {
        if (useTaskStore.getState().error) message.error(useTaskStore.getState().error);
        return;
      }
      const assignment = autoAssign && result.tasks.length > 0
        ? await autoAssignTasks(result.tasks)
        : { assigned: 0, unassigned: 0 };
      const armed = await armImportedTasksAfterAssignment(result.tasks, autoExecute, armTasks);
      const suffix = importedExecutionSuffix(armed);
      if (result.errors.length > 0) {
        message.warning(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条；${result.errors[0]}${suffix}`);
      } else if (assignment.unassigned > 0) {
        message.warning(`已导入 ${result.imported} 条；${assignment.unassigned} 条无可用账号，保留为未指派${suffix}`);
      } else {
        message.success(`已导入 ${result.imported} 条任务${suffix}`);
      }
    } finally {
      setIsCsvImporting(false);
    }
  }, [autoAssign, autoAssignTasks, autoExecute, armTasks, importCsv, isCsvImporting]);

  const handleCsvDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current += 1;
    if (Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) setIsCsvDragging(true);
  }, []);

  const handleCsvDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current = Math.max(0, csvDragDepth.current - 1);
    if (csvDragDepth.current === 0) setIsCsvDragging(false);
  }, []);

  const handleCsvDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    csvDragDepth.current = 0;
    setIsCsvDragging(false);
    const decision = decideCsvDrop(event.dataTransfer.files);
    if (!decision.ok) {
      message.error(decision.message);
      return;
    }
    try {
      const filePath = window.electronAPI.tasks.getPathForDroppedFile(decision.file);
      if (!filePath) throw new Error('无法读取拖入文件的本地路径');
      void handleImportCsv(filePath);
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '无法导入拖入的 CSV 文件');
    }
  }, [handleImportCsv]);

  const handleAutoExecuteChange = useCallback(async (enabled: boolean) => {
    setAutoExecute(enabled);
    const settings = await window.electronAPI.settings.get();
    const result = await window.electronAPI.settings.save({ ...settings, autoExecuteEnabled: enabled });
    if (!result.success) {
      setAutoExecute(!enabled);
      message.error(result.error || '导入后执行设置保存失败');
    }
  }, []);

  const handleAutoAssignChange = useCallback(async (enabled: boolean) => {
    setAutoAssign(enabled);
    const settings = await window.electronAPI.settings.get();
    const result = await window.electronAPI.settings.save({ ...settings, autoAssignEnabled: enabled });
    if (!result.success) {
      setAutoAssign(!enabled);
      message.error(result.error || '自动指派设置保存失败');
    }
  }, []);

  // ---- 选择参考图片 ----
  const handleSelectImages = useCallback(async () => {
    const result = await window.electronAPI.tasks.selectImages();
    if (result.success && result.filePaths && result.filePaths.length > 0) {
      setAttachments((prev) => [...prev, ...result.filePaths!]);
      // 读取文件为 base64 用于缩略图显示
      for (const filePath of result.filePaths!) {
        const base64Result = await window.electronAPI.tasks.readFileAsBase64(filePath);
        if (base64Result.success && base64Result.data) {
          setAttachmentBase64s((prev) => ({ ...prev, [filePath]: base64Result.data! }));
        }
      }
    }
  }, []);

  // ---- 选择参考音频 ----
  const handleSelectAudio = useCallback(async () => {
    const result = await window.electronAPI.tasks.selectAudio();
    if (result.success && result.filePath) {
      setAudioAttachment(result.filePath);
    }
  }, []);

  // ---- 指派账号 ----

  const handleAssign = useCallback(
    async (taskId: string, accountId: string) => {
      await assignTask(taskId, accountId);
    },
    [assignTask]
  );

  // ---- 启动自动化 ----

  const handleStartTask = useCallback(
    async (taskId: string) => {
      await clearError();
      await startAutomation(taskId);
    },
    [startAutomation, clearError]
  );

  const openEditAndRerun = (task: Task) => {
    setEditingTask(task);
    setEditingPrompt(task.prompt);
    setEditingVideoConfig({ ...(task.videoConfig || DEFAULT_VIDEO_CONFIG) });
    setEditingAttachments([...(task.attachments || [])]);
    setEditingAudioAttachment(task.audioAttachment || '');
    setEditingAttachmentBase64s({});
    for (const filePath of task.attachments || []) {
      void window.electronAPI.tasks.readFileAsBase64(filePath).then((result) => {
        if (result.success && result.data) {
          setEditingAttachmentBase64s((current) => ({ ...current, [filePath]: result.data! }));
        }
      });
    }
  };

  const resetEditingTask = () => {
    setEditingTask(null);
    setEditingPrompt('');
    setEditingVideoConfig({ ...DEFAULT_VIDEO_CONFIG });
    setEditingAttachments([]);
    setEditingAttachmentBase64s({});
    setEditingAudioAttachment('');
  };

  const handleSelectEditingImages = async () => {
    const result = await window.electronAPI.tasks.selectImages();
    if (!result.success || !result.filePaths?.length) return;
    const newPaths = result.filePaths.filter((path) => !editingAttachments.includes(path));
    setEditingAttachments((current) => [...current, ...newPaths]);
    for (const filePath of newPaths) {
      const base64Result = await window.electronAPI.tasks.readFileAsBase64(filePath);
      if (base64Result.success && base64Result.data) {
        setEditingAttachmentBase64s((current) => ({ ...current, [filePath]: base64Result.data! }));
      }
    }
  };

  const handleSelectEditingAudio = async () => {
    const result = await window.electronAPI.tasks.selectAudio();
    if (result.success && result.filePath) setEditingAudioAttachment(result.filePath);
  };

  const handleEditAndRerun = async () => {
    if (!editingTask || !editingPrompt.trim()) {
      message.warning('提示词不能为空');
      return;
    }

    const updates: TaskUpdateInput = {
      prompt: editingPrompt.trim(),
      videoConfig: editingTask.mode === 'video' ? editingVideoConfig : undefined,
      attachments: editingTask.mode === 'video' || editingTask.mode === 'image'
        ? editingAttachments
        : undefined,
      audioAttachment: editingTask.mode === 'video' ? editingAudioAttachment || undefined : undefined,
    };
    const isActive = editingTask.status === 'executing' || editingTask.status === 'generating' || editingTask.status === 'waiting_verification' || editingTask.status === 'waiting_generation_confirmation' || editingTask.status === 'manual_submission_observing';
    if (isActive) {
      window.dispatchEvent(new CustomEvent('cancel-task-automation', {
        detail: { taskId: editingTask.id, restartTask: updates },
      }));
    } else {
      const updated = await updateTask(editingTask.id, updates);
      if (!updated) {
        message.error(useTaskStore.getState().error || '编辑任务失败');
        return;
      }
      const armResult = await armTasks([editingTask.id]);
      if (armResult.armed === 1 && armResult.failed === 0) {
        message.success('提示词已更新，任务已显式授权执行');
      } else {
        message.error(armResult.error || '提示词已更新，但执行授权写入失败；任务保持 hold');
      }
    }

    resetEditingTask();
  };

  // ---- 右键菜单 ----

  const getContextMenu = (taskId: string): MenuProps['items'] => {
    const task = tasks.find((t) => t.id === taskId);
    const mustReconcile = requiresSubmissionReconciliation(task);
    const canRetry = task && !task.petstory && !mustReconcile && !isDependencyBlockedTask(task) && (
      task.status === 'fail' || task.status === 'done' || task.status === 'paused' ||
      task.status === 'cancelled' || task.status === 'waiting_verification'
    );

    return [
      {
        key: 'detail',
        label: '查看详情',
        icon: <EyeOutlined />,
        onClick: () => {
          setSelectedTask(task || null);
          setDetailModalOpen(true);
        },
      },
      ...(mustReconcile ? [{
        key: 'reconcile-submission',
        label: task?.status === 'waiting_generation_confirmation' ? '人工确认后，只读回读原会话' : '核对平台结果（不重新发送）',
        icon: <SyncOutlined />,
        onClick: () => window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId, useCurrentPage: task?.mode === 'chat' && isTaskConversationMissing(task) } })),
      }] : task?.petstory ? [] : [{
        key: 'edit-rerun',
        label: '编辑提示词并重跑',
        icon: <EditOutlined />,
        onClick: () => task && openEditAndRerun(task),
      }]),
      ...(canRetry ? [
        {
          key: 'retry',
          label: task?.status === 'waiting_verification' ? '完成处理后重新执行' : '重新执行',
          icon: <ReloadOutlined />,
          onClick: () => useTaskStore.getState().retryTask(taskId),
        },
      ] : []),
      { type: 'divider' as const },
      {
        key: 'delete',
        label: '删除任务',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: (): void => { Modal.confirm({ title: '确认删除任务？', content: '此操作删除任务记录；请先确认无需继续观察原会话。', okText: '删除', okType: 'danger', cancelText: '取消', onOk: async (): Promise<void> => { await deleteTask(taskId); } }); },
      },
    ];
  };

  // ---- 渲染模式标签 ----

  const renderModeTag = (mode: GenerationMode) => {
    const cfg = GENERATION_MODE_CONFIG[mode] || GENERATION_MODE_CONFIG.chat;
    return (
      <Tooltip title={cfg.description}>
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
          style={{
            backgroundColor: cfg.color + '18',
            color: cfg.color,
            border: `1px solid ${cfg.color}30`,
          }}
        >
          {({ chat: <MessageOutlined />, image: <PictureOutlined />, video: <VideoCameraOutlined />, music: <AudioOutlined /> })[mode]}
          {cfg.label}
        </span>
      </Tooltip>
    );
  };

  // ---- 渲染状态标签 ----

  const renderStatusTag = (task: (typeof tasks)[0]) => {
    const status = task.status;
    // 依赖阻断任务保持 queued（可被调度器重新评估），因此用独立标签区分，不能只显示“排队”。
    if (isDependencyBlockedTask(task)) {
      return (
        <Tooltip title={describeDependencyBlock(task)}>
          <span className="task-status-tag" style={{ borderColor: '#b97515', color: '#996115' }}>
            <StopOutlined style={{ marginRight: 4 }} />
            依赖阻断
          </span>
        </Tooltip>
      );
    }
    const cfg = TASK_STATUS_CONFIG[status];
    return (
      <span className={`task-status-tag ${cfg.className}`} style={{ borderColor: cfg.color, color: cfg.color }}>
        {status === 'generating' && <SyncOutlined spin style={{ marginRight: 4 }} />}
        {status === 'executing' && <ThunderboltOutlined style={{ marginRight: 4 }} />}
        {status === 'waiting_verification' && <LoadingOutlined spin style={{ marginRight: 4 }} />}
        {status === 'waiting_generation_confirmation' && <ClockCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'manual_submission_observing' && <SyncOutlined spin style={{ marginRight: 4 }} />}
        {(status === 'paused' || status === 'cancelled') && <PauseCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'queued' && <ClockCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'done' && <CheckCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'fail' && <CloseCircleOutlined style={{ marginRight: 4 }} />}
        {status === 'queued' && task.executionIntent !== 'armed' ? '待授权执行' : cfg.label}
      </span>
    );
  };

  // ---- 点击任务跳转到对应账号 ----

  const handleTaskClick = (task: Task) => {
    if (task.assignedAccountId) {
      const interactiveAccountId = findInteractiveAccountId(accountAutomationState);
      if (!canSelectAccount(task.assignedAccountId, interactiveAccountId)) {
        const interactiveAccount = accounts.find((account) => account.id === interactiveAccountId);
        message.warning(`任务正在 ${interactiveAccount?.name || '当前账号'} 配置或提交，进入生成阶段后即可切换`);
        return;
      }
      selectAccount(task.assignedAccountId);
    }
  };

  const taskColumns: ColumnsType<Task> = [
    { title: '任务摘要', key: 'summary', width: 310, render: (_: unknown, task: Task): React.ReactNode => <button className="task-summary-button" onClick={(): void => { setSelectedTask(task); setDetailModalOpen(true); }}><strong>{task.prompt.slice(0, 100)}</strong><small>{task.id.slice(0, 8)} · {taskNextAction(task)}</small></button> },
    { title: '类型', width: 88, render: (_: unknown, task: Task): React.ReactNode => renderModeTag(task.mode || 'chat') },
    { title: '执行状态', width: 156, render: (_: unknown, task: Task): React.ReactNode => <div className="task-status-cell">{renderStatusTag(task)}{task.status === 'done' && <small>人工质量{task.qualityVerdict?.status === 'accepted' ? '合格' : task.qualityVerdict?.status === 'rejected' ? '拒收' : '未评'}</small>}</div> },
    { title: '执行账号', width: 180, render: (_: unknown, task: Task): React.ReactNode => <Select aria-label={`${task.id}执行账号`} size="small" placeholder="未指派" value={task.assignedAccountId || undefined} onChange={(value: string): void => { void handleAssign(task.id, value); }} style={{ width: '100%' }} disabled={!!task.petstory || ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status)} popupMatchSelectWidth={false} options={buildManualAssignmentOptions(accounts, task.mode || 'chat', task.videoConfig?.duration)} /> },
    { title: '批次 / 阶段', width: 155, render: (_: unknown, task: Task): React.ReactNode => <div className="table-secondary"><span>{task.batchId ? task.batchId.slice(-10) : '无批次'}</span><small>{task.runtime?.stage ? TASK_STAGE_LABELS[task.runtime.stage] || task.runtime.stage : '尚未开始'}{task.dependsOnTaskIds?.length ? ` · ${task.dependsOnTaskIds.length} 项前置` : ''}</small></div> },
    { title: '更新时间', width: 138, render: (_: unknown, task: Task): React.ReactNode => new Date(task.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) },
    { title: '下一步', width: 165, fixed: 'right', render: (_: unknown, task: Task): React.ReactNode => <Space size={4}>
      {requiresSubmissionReconciliation(task) ? <Button size="small" onClick={(): void => { handleTaskClick(task); revealBrowser(); window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } })); }}>核对原会话</Button> : task.status === 'queued' && !task.petstory ? <Button size="small" type="primary" disabled={!task.assignedAccountId || !!accountBusy[task.assignedAccountId]} onClick={(): void => { void handleStartTask(task.id); }}>授权执行</Button> : <Button size="small" onClick={(): void => { setSelectedTask(task); setDetailModalOpen(true); }}>详情</Button>}
      <Dropdown menu={{ items: getContextMenu(task.id) }} trigger={['click']}><Button size="small" aria-label={`${task.id}更多操作`} icon={<MoreOutlined />} /></Dropdown>
    </Space> },
  ];
  const visibleTasks = tasks.filter((task: Task): boolean => taskFilter === 'all' || taskFilter === 'attention' && needsTaskAttention(task) || task.status === taskFilter).filter((task: Task): boolean => !query.trim() || `${task.prompt} ${task.id} ${task.batchId || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a: Task, b: Task): number => b.updatedAt.localeCompare(a.updatedAt));

  // ---- 统计 ----

  const queuedCount = tasks.filter((t) => t.status === 'queued').length;
  const runningCount = tasks.filter(
    (t) => t.status === 'executing' || t.status === 'generating'
  ).length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  // 依赖阻断是调度阻断（任务仍保持 queued），与普通平台失败分开显示，避免被误读为生成失败。
  const failCount = tasks.filter((t) => t.status === 'fail' && !isDependencyBlockedTask(t)).length;
  const dependencyBlockedCount = tasks.filter((t) => isDependencyBlockedTask(t)).length;

  return (
    <div
      className={`task-console ${view === 'create' ? 'creation-console' : 'task-center'}${isCsvDragging ? ' csv-dragging' : ''}`}
      onDragEnter={handleCsvDragEnter}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={handleCsvDragLeave}
      onDrop={handleCsvDrop}
    >
      {isCsvDragging && (
        <div className="csv-drop-overlay" role="status" aria-live="polite">
          <FileExcelOutlined />
          <strong>松开导入 CSV</strong>
          <span>导入当前项目；未明确启动的任务不会自动执行</span>
        </div>
      )}
      {/* 顶部操作栏 */}
      {view === 'tasks' && <div className="task-console-header">
        <Tooltip title={`项目 ID：${activeProjectId}`}>
          <span className="task-console-title">任务调度 · {activeProject?.name || activeProjectId}</span>
        </Tooltip>
        <div className="task-console-stats">
          <span className="stat-badge running"><LoadingOutlined spin={runningCount > 0} /> 运行 {runningCount}</span>
          <span className="stat-badge queued"><ClockCircleOutlined /> 待执行 {queuedCount}</span>
          <span className="stat-badge done"><CheckCircleOutlined /> 完成 {doneCount}</span>
          {failCount > 0 && (
            <span className="stat-badge fail">
              <CloseCircleOutlined /> 失败 {failCount}
            </span>
          )}
          {dependencyBlockedCount > 0 && (
            <Tooltip title="依赖阻断：调度阻断，任务仍在队列中等待重新评估；不计入平台生成失败率，也不会自动重试">
              <span className="stat-badge fail">
                <StopOutlined /> 依赖阻断 {dependencyBlockedCount}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="task-console-actions">
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={(): void => navigateWorkspace('create', 'studio')}
            type="primary"
          >
            新建创作
          </Button>
          <Tooltip title="从 CSV 导入任务批次">
            <Button
              size="small"
              icon={<FileExcelOutlined />}
              aria-label="导入 CSV"
              loading={isCsvImporting}
              disabled={isCsvImporting}
              onClick={() => void handleImportCsv()}
            />
          </Tooltip>
          {doneCount > 0 && (
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => {
                // 打开批次选择器；下载范围固定为当前项目和用户选择的单个批次。
                window.dispatchEvent(new CustomEvent('open-batch-manager'));
              }}
            >
              批量下载
            </Button>
          )}
        </div>
      </div>}

      {/* 错误提示 */}
      {error && (
        <div className="task-console-error">
          <CloseCircleOutlined style={{ marginRight: 6 }} />
          {error}
        </div>
      )}

      {view === 'tasks' && <><div className="task-filter-bar"><Input.Search aria-label="搜索任务" placeholder="搜索提示词、任务 ID 或批次" allowClear value={query} onChange={(event): void => setQuery(event.target.value)} /><Segmented value={taskFilter} onChange={(value): void => setTaskFilter(value as typeof taskFilter)} options={[{ label: '全部', value: 'all' }, { label: '待处理', value: 'attention' }, { label: '待执行', value: 'queued' }, { label: '已生成', value: 'done' }]} /></div><div className="task-table"><Table rowKey="id" dataSource={visibleTasks} columns={taskColumns} size="middle" pagination={{ pageSize: 12, showSizeChanger: false }} scroll={{ x: 1192 }} locale={{ emptyText: '当前范围没有任务；到创作工作台创建待执行任务' }} /></div></>}

      {view === 'create' && <div className="composer-grid">
        <section className="workspace-card composer-editor">
          <div className="section-heading"><div><h2>创建一项新作品</h2><p>先准备内容，再到任务中心明确授权执行</p></div><Tag>待执行草稿</Tag></div>
          <ModeSelector value={selectedMode} onChange={setSelectedMode} />
          {selectedMode === 'music' && <Alert type="info" showIcon message="音乐入口保留；尚未完成本轮真实平台验收" />}
          <label className="field-label" htmlFor="creation-prompt">提示词</label>
          <TextArea id="creation-prompt" value={inputText} onChange={(event): void => setInputText(event.target.value)} placeholder="描述你想创作的内容、画面和风格…" autoSize={{ minRows: 10, maxRows: 20 }} />
          {(selectedMode === 'image' || selectedMode === 'video') && <div className="reference-section"><div className="section-heading"><label className="field-label">参考图片 <span>按显示顺序上传</span></label><Button icon={<PictureOutlined />} onClick={handleSelectImages}>添加图片</Button></div><div className="reference-strip">{attachments.map((path: string, index: number): React.ReactNode => <div className="reference-thumb" key={`${path}-${index}`}><img src={attachmentBase64s[path] || ''} alt={`第 ${index + 1} 张参考图`} /><span>{index + 1}</span><Button size="small" type="text" aria-label={`移除第 ${index + 1} 张参考图`} icon={<CloseCircleOutlined />} onClick={(): void => setAttachments(attachments.filter((_, i: number): boolean => i !== index))} /></div>)}{!attachments.length && <p className="muted-text">可选 · 选择本机图片作为身份、构图或画面参考</p>}</div></div>}
          {selectedMode === 'video' && <div className="audio-reference"><Button icon={<AudioOutlined />} onClick={handleSelectAudio}>选择参考音频</Button>{audioAttachment && <><span>{audioAttachment.split(/[/\\]/).pop()}</span><Button type="text" aria-label="移除参考音频" icon={<CloseCircleOutlined />} onClick={(): void => setAudioAttachment('')} /></>}</div>}
          <Collapse className="batch-tools" items={[{ key: 'batch', label: '批量与模板 · CSV、变量和分隔符', children: <Space direction="vertical" size={12} className="w-full">
            <p>多个任务用 <code>%%%%%%%%%%</code> 分隔；变量使用 <code>{'{{变量名}}'}</code>。每行变量展开一组任务。</p>
            <TextArea aria-label="批量变量" value={variableRows} onChange={(event): void => setVariableRows(event.target.value)} rows={3} placeholder={'产品=保温杯;场景=客厅\n产品=咖啡杯;场景=办公室'} />
            <Space wrap><Select aria-label="应用任务模板" placeholder="应用任务模板" style={{ width: 190 }} options={templates.map((template): { value: string; label: string } => ({ value: template.id, label: template.name }))} onChange={applyTemplate} allowClear /><Button onClick={(): void => setTemplateModalOpen(true)}>保存为模板</Button><Tooltip title="删除最近保存的模板"><Button danger disabled={!templates.length} aria-label="删除最近保存的模板" icon={<DeleteOutlined />} onClick={(): void => { const last = templates[templates.length - 1]; if (last) void persistTemplates(templates.filter((item): boolean => item.id !== last.id)); }} /></Tooltip></Space>
            <Space wrap><Button icon={<FileExcelOutlined />} loading={isCsvImporting} onClick={(): void => { void handleImportCsv(); }}>导入 CSV</Button><span className="muted-text">也可拖入 CSV；导入当前 Studio 项目，保留参数与前置依赖</span></Space>
            <Space wrap><Switch aria-label="自动指派账号" checked={autoAssign} onChange={(enabled: boolean): void => { void handleAutoAssignChange(enabled); }} /><span>自动指派账号</span><Switch aria-label={autoExecuteTooltip(autoExecute)} checked={autoExecute} onChange={(enabled: boolean): void => { void handleAutoExecuteChange(enabled); }} /><span>导入 CSV 后授权执行</span></Space><p className="muted-text">指派不等于执行。仅 CSV 导入受“导入后执行”开关影响；下方创建按钮始终只创建待执行任务。</p>
          </Space> }]} />
          <div className="composer-footer"><span>创建不会发送到豆包或消耗生成额度</span><Button type="primary" size="large" loading={creating} disabled={!inputText.trim()} onClick={(): void => { void handleAddTasks(); }}>创建待执行任务</Button></div>
        </section>
        <aside className="workspace-card composer-config"><h2>创作配置</h2><label className="field-label">执行账号</label><Select aria-label="新任务执行账号" placeholder={autoAssign ? '自动指派可用账号' : '稍后在任务中心指派'} allowClear value={creationAccountId} onChange={(value: string | undefined): void => setCreationAccountId(value)} options={buildManualAssignmentOptions(accounts, selectedMode, videoConfig.duration)} className="w-full" /><p className="muted-text">独立于浏览器当前账号。指定账号后仍需授权执行。</p>
          {selectedMode === 'video' && <><label className="field-label">视频模型</label><Select aria-label="视频模型" value={videoConfig.model} onChange={(value: VideoModel): void => setVideoConfig({ ...videoConfig, model: value })} options={Object.entries(VIDEO_MODEL_LABELS).map(([value, label]): { value: string; label: string } => ({ value, label }))} className="w-full" /><label className="field-label">时长</label><Select aria-label="视频时长" value={videoConfig.duration} onChange={(value: VideoDuration): void => setVideoConfig({ ...videoConfig, duration: value })} options={Array.from({ length: 12 }, (_, index: number): { value: string; label: string } => ({ value: `${index + 4}s`, label: `${index + 4} 秒` }))} className="w-full" /><label className="field-label">画面比例</label><Select aria-label="画面比例" value={videoConfig.aspectRatio} onChange={(value: VideoAspectRatio): void => setVideoConfig({ ...videoConfig, aspectRatio: value })} options={['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].map((value: string): { value: string; label: string } => ({ value, label: value }))} className="w-full" /><p className="muted-text">{VIDEO_MODEL_COST[videoConfig.model]} · 本地配置提示；实际能力以提交前平台控件回读为准。</p></>}
          <div className="config-note"><h3>下一步</h3><ol><li>创建待执行任务</li><li>在任务中心核对内容与账号</li><li>明确授权后开始执行</li></ol><Button onClick={(): void => navigateWorkspace('tasks')}>前往任务中心</Button></div>
        </aside>
      </div>}

      <Modal
        title="保存任务模板"
        open={templateModalOpen}
        onOk={() => void saveCurrentTemplate()}
        onCancel={() => setTemplateModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={templateName}
          onChange={(event) => setTemplateName(event.target.value)}
          onPressEnter={() => void saveCurrentTemplate()}
          placeholder="模板名称"
          autoFocus
        />
      </Modal>

      <Modal
        title="编辑提示词并重新运行"
        open={!!editingTask}
        onOk={handleEditAndRerun}
        onCancel={resetEditingTask}
        okText="保存并重新运行"
        cancelText="取消"
        width={620}
        okButtonProps={{
          // 已绑定账号且预检 blocked 时禁用确认按钮
          disabled: (() => {
            if (!editingTask || editingTask.mode !== 'video') return false;
            const boundAccountId = editingTask.assignedAccountId;
            if (!boundAccountId) return false;
            const boundAccount = useAccountStore.getState().accounts.find(a => a.id === boundAccountId);
            if (!boundAccount) return false;
            const capability = evaluateVideoCapability({
              model: editingVideoConfig.model,
              duration: editingVideoConfig.duration,
              aspectRatio: editingVideoConfig.aspectRatio,
              manual15sEnabled: false,
              seedanceQuota: boundAccount.seedanceQuota,
              health: boundAccount.health,
              scheduling: boundAccount.scheduling,
              accountStatus: boundAccount.status,
            });
            return !capability.canSubmit;
          })(),
        }}
      >
        <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>提示词</div>
        <TextArea
          value={editingPrompt}
          onChange={(event) => setEditingPrompt(event.target.value)}
          rows={10}
          autoFocus
          placeholder="请输入提示词"
          style={{
            background: '#fafafb',
            border: '1px solid #e2e3e8',
            color: '#252631',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineHeight: 1.7,
            marginBottom: 16,
          }}
        />

        {editingTask?.mode === 'video' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>视频模型</div>
            <Segmented
              value={editingVideoConfig.model}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, model: value as VideoModel })}
              options={Object.entries(VIDEO_MODEL_LABELS).map(([key, label]) => ({
                label,
                value: key,
              }))}
              block
              style={{ background: '#fafafb', padding: 4, marginBottom: 12 }}
            />
            <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>视频时长</div>
            <Segmented
              value={editingVideoConfig.duration}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, duration: value as VideoDuration })}
              options={Array.from({ length: 12 }, (_, index) => {
                const seconds = index + 4;
                return { label: `${seconds} 秒`, value: `${seconds}s` };
              })}
              block
              style={{ background: '#fafafb', padding: 4, marginBottom: 12 }}
            />
            <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>画面比例</div>
            <Segmented
              value={editingVideoConfig.aspectRatio}
              onChange={(value) => setEditingVideoConfig({ ...editingVideoConfig, aspectRatio: value as VideoAspectRatio })}
              options={['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']}
              block
              style={{ background: '#fafafb', padding: 4 }}
            />

            {/* 视频能力预检提示（使用任务已绑定账号，非 selectedAccountId） */}
            {(() => {
              const boundAccountId = editingTask?.assignedAccountId;
              if (!boundAccountId) {
                // 未绑定账号时仅展示风险提示
                if (Number.parseInt(editingVideoConfig.duration, 10) >= 11) {
                  return (
                    <div style={{
                      marginTop: 12,
                      padding: '8px 12px',
                      borderRadius: 8,
                      fontSize: 12,
                      background: 'rgba(250,173,20,0.1)',
                      border: '1px solid rgba(250,173,20,0.3)',
                      color: '#996115',
                    }}>
                      11–15 秒必须在执行时取得页面实时可选证据；出现会员窗口或无法确认时将停止提交
                    </div>
                  );
                }
                return null;
              }
              const boundAccount = useAccountStore.getState().accounts.find(a => a.id === boundAccountId);
              if (!boundAccount) return null;
              const capability = evaluateVideoCapability({
                model: editingVideoConfig.model,
                duration: editingVideoConfig.duration,
                aspectRatio: editingVideoConfig.aspectRatio,
                manual15sEnabled: false,
                seedanceQuota: boundAccount.seedanceQuota,
                health: boundAccount.health,
                scheduling: boundAccount.scheduling,
                accountStatus: boundAccount.status,
              });
              if (capability.state === 'allowed') return null;
              const isBlocked = capability.state === 'blocked';
              return (
                <div style={{
                  marginTop: 12,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  background: isBlocked ? 'rgba(255,77,79,0.1)' : 'rgba(250,173,20,0.1)',
                  border: `1px solid ${isBlocked ? 'rgba(255,77,79,0.3)' : 'rgba(250,173,20,0.3)'}`,
                  color: isBlocked ? '#ff6b6b' : '#996115',
                }}>
                  {`[绑定账号：${boundAccount.name}] ${capability.userMessage}`}
                  {capability.suggestion && (
                    <div style={{ marginTop: 4, color: '#6b6d7c' }}>
                      建议：{capability.suggestion.reason}
                    </div>
                  )}
                  {isBlocked && (
                    <div style={{ marginTop: 4, color: '#6b6d7c' }}>
                      该账号当前不可用，请先解决上述问题或更换绑定账号
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {(editingTask?.mode === 'video' || editingTask?.mode === 'image') && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>参考图片</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {editingAttachments.map((filePath) => (
                <div key={filePath} style={{ position: 'relative', width: 64, height: 64 }}>
                  <img
                    src={editingAttachmentBase64s[filePath] || ''}
                    alt="参考图片"
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e3e8' }}
                  />
                  <Button
                    size="small"
                    danger
                    shape="circle"
                    icon={<DeleteOutlined />}
                    onClick={() => setEditingAttachments((current) => current.filter((path) => path !== filePath))}
                    style={{ position: 'absolute', top: -7, right: -7, width: 22, minWidth: 22, height: 22 }}
                  />
                </div>
              ))}
              <Button
                icon={<PictureOutlined />}
                onClick={handleSelectEditingImages}
                style={{ width: 64, height: 64 }}
              >
                添加
              </Button>
            </div>
          </div>
        )}

        {editingTask?.mode === 'video' && (
          <div>
            <div style={{ color: '#6b6d7c', marginBottom: 8, fontSize: 13 }}>参考音频</div>
            <Space>
              <Button icon={<AudioOutlined />} onClick={handleSelectEditingAudio}>
                {editingAudioAttachment ? '更换音频' : '选择音频'}
              </Button>
              {editingAudioAttachment && (
                <>
                  <span style={{ color: '#434552', fontSize: 12 }}>
                    {editingAudioAttachment.split(/[/\\]/).pop()}
                  </span>
                  <Button size="small" danger onClick={() => setEditingAudioAttachment('')}>移除</Button>
                </>
              )}
            </Space>
          </div>
        )}
      </Modal>

      {/* 任务详情弹窗 */}
      <TaskDetailModal
        open={detailModalOpen}
        task={liveSelectedTask}
        onEditAndRerun={openEditAndRerun}
        onClose={() => {
          setDetailModalOpen(false);
          setSelectedTask(null);
        }}
      />
    </div>
  );
};

export default TaskConsole;
