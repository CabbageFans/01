import React, { useState, useRef } from 'react';
import { Alert, Button, Input, Modal, Select, Space, message } from 'antd';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { navigateWorkspace } from '../utils/workspace';
import { useTaskStore } from '../store/useTaskStore';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';

/** 账号和项目选择属于新建本身，不改变正在浏览的账号或已有短剧绑定。 */
export const PetStoryCreateProject: React.FC<{ disabled?: boolean; onCreated?: () => void }> = ({ disabled = false, onCreated }): React.ReactElement => {
  const state = usePetStoryStore(); const accountState = useAccountStore(); const projectState = useProjectStore();
  const [open, setOpen] = useState(false); const [accountId, setAccountId] = useState<string>(); const [studioProjectId, setStudioProjectId] = useState<string>();
  const [newName, setNewName] = useState(''); const [adding, setAdding] = useState(false);
  const selectedAccount = accountState.accounts.find((account): boolean => account.id === accountId && account.platform !== 'dola');
  const selectedProject = projectState.projects.find((project): boolean => project.id === studioProjectId && !project.archived);
  const create = async (): Promise<void> => {
    if (!selectedAccount || !selectedProject) return;
    await state.createProject({ accountId: selectedAccount.id, studioProjectId: selectedProject.id });
    if (!usePetStoryStore.getState().error && usePetStoryStore.getState().project) { setOpen(false); onCreated?.(); }
  };
  const openLogin = (): void => {
    if (!selectedAccount) return;
    const interactiveId = findInteractiveAccountId(useTaskStore.getState().accountAutomationState);
    if (!canSelectAccount(selectedAccount.id, interactiveId)) {
      const interactiveAccount = accountState.accounts.find((account): boolean => account.id === interactiveId);
      message.warning(`任务正在 ${interactiveAccount?.name || '当前账号'} 配置或提交，进入生成阶段后即可切换`);
      return;
    }
    accountState.selectAccount(selectedAccount.id); navigateWorkspace('accounts'); setOpen(false);
  };
  const add = async (): Promise<void> => {
    const before = new Set(accountState.accounts.map((account): string => account.id)); setAdding(true);
    try { if (await accountState.addAccount(newName.trim(), 'doubao')) { const added = useAccountStore.getState().accounts.find((account): boolean => !before.has(account.id)); setAccountId(added?.id); setNewName(''); } }
    finally { setAdding(false); }
  };
  const initialized = useRef(false);
  return <><Button disabled={disabled || state.busy} onClick={(): void => { if (!initialized.current) { setAccountId(accountState.accounts.find((account): boolean => account.id === accountState.selectedAccountId && account.platform !== 'dola')?.id); setStudioProjectId(projectState.activeProjectId); initialized.current = true; } setOpen(true); }}>新建萌宠短剧</Button>
    <Modal title="新建萌宠短剧" open={open} onCancel={(): void => setOpen(false)} footer={<><Button onClick={(): void => setOpen(false)}>暂不创建</Button><Button type="primary" disabled={!selectedAccount || !selectedProject || state.busy} loading={state.busy} onClick={(): void => { void create(); }}>选择保存目录并创建</Button></>}>
      <Space direction="vertical" className="w-full">
        <label>执行账号</label><Select aria-label="新短剧执行账号" className="w-full" allowClear placeholder="请选择已登录的豆包账号" value={accountId} options={accountState.accounts.filter((account): boolean => account.platform !== 'dola').map((account): { value: string; label: string } => ({ value: account.id, label: account.name }))} onChange={(value?: string): void => setAccountId(value)} />
        {!selectedAccount && <Alert type="info" message="还没有选择可用的豆包执行账号；可在这里选择、添加，或前往登录后返回。" />}
        <Space.Compact className="w-full"><Input aria-label="添加豆包账号名称" placeholder="新账号名称" value={newName} onChange={(event): void => setNewName(event.target.value)} /><Button loading={adding} disabled={!newName.trim()} onClick={(): void => { void add(); }}>添加账号</Button></Space.Compact>
        <Button disabled={!selectedAccount} onClick={openLogin}>去登录／检查账号（返回后继续新建）</Button>
        <label>关联项目</label><Select aria-label="新短剧关联Studio项目" className="w-full" value={studioProjectId} options={projectState.projects.filter((project): boolean => !project.archived).map((project): { value: string; label: string } => ({ value: project.id, label: project.name }))} onChange={(value: string): void => setStudioProjectId(value)} />
        {!selectedProject && <Alert type="info" message="请选择仍在使用的关联项目，任务会归集到这里。" />}
        <p>短剧保存在你选择的本地目录；关联项目用于归集任务。点击下方按钮选择一个空目录，取消选择会保留当前配置。</p>
        {(state.error || accountState.error) && <Alert type="error" message={state.error || accountState.error} />}
      </Space>
    </Modal></>;
};
