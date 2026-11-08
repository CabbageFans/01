import React, { useId, useRef, useState } from 'react';
import { Alert, Button, Modal, Select, message } from 'antd';
import { VideoCameraOutlined } from '@ant-design/icons';
import { useAccountStore } from '../store/useAccountStore';
import { useProjectStore } from '../store/useProjectStore';
import { usePetStoryStore } from '../store/usePetStoryStore';

/** 新建只选择执行账号；任务归属沿用工作台项目，不改变当前浏览的账号。 */
export const PetStoryCreateProject: React.FC<{ disabled?: boolean; primary?: boolean; label?: string; onCreated?: () => void }> = ({ disabled = false, primary = false, label = '新建短剧项目', onCreated }): React.ReactElement => {
  const state = usePetStoryStore();
  const accountState = useAccountStore();
  const projectState = useProjectStore();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState<string>();
  const [error, setError] = useState('');
  const [messageApi, contextHolder] = message.useMessage();
  const accountSelectId = useId();
  const submitting = useRef(false);
  const accounts = accountState.accounts.filter((account): boolean => account.platform !== 'dola');
  const selectedAccount = accounts.find((account): boolean => account.id === accountId);
  const projects = projectState.projects.filter((project): boolean => !project.archived);
  const studioProject = projects.find((project): boolean => project.id === projectState.activeProjectId)
    || projects.find((project): boolean => project.id === 'default-project') || projects[0];

  const show = (): void => {
    setAccountId(accounts.find((account): boolean => account.id === accountState.selectedAccountId)?.id || accounts[0]?.id);
    setError('');
    setOpen(true);
  };
  const create = async (): Promise<void> => {
    if (!selectedAccount || !studioProject || state.busy || submitting.current) return;
    submitting.current = true;
    setError('');
    try {
      await state.createProject({ accountId: selectedAccount.id, studioProjectId: studioProject.id });
      const current = usePetStoryStore.getState();
      // 取消目录选择是正常返回，保留配置，也不能把原先打开的项目误判为新建成功。
      if (current.error === '已取消') {
        usePetStoryStore.setState({ error: '' });
        void messageApi.info('已取消', 2);
        return;
      }
      if (current.error) { setError(current.error); return; }
      if (current.project) { setOpen(false); onCreated?.(); }
    } finally { submitting.current = false; }
  };

  return <>
    {contextHolder}
    <Button type={primary ? 'primary' : 'default'} disabled={disabled || state.busy} onClick={show}>{label}</Button>
    <Modal
      title={<div className="story-create-heading">
        <span className="story-create-icon" aria-hidden="true"><VideoCameraOutlined /></span>
        <span className="story-create-title">新建短剧项目</span>
      </div>}
      className="story-create-modal"
      width={460}
      centered
      open={open}
      closable={!state.busy}
      maskClosable={!state.busy}
      keyboard={!state.busy}
      onCancel={(): void => setOpen(false)}
      footer={<Button type="primary" disabled={!selectedAccount || !studioProject || state.busy} loading={state.busy} onClick={(): void => { void create(); }}>创建项目</Button>}
    >
      <p className="story-create-intro">从一个故事，开始下一部短剧。</p>
      <div className="story-create-field">
        <label htmlFor={accountSelectId}>执行账号</label>
        <Select
          id={accountSelectId}
          aria-label="新短剧执行账号"
          className="w-full"
          size="large"
          placeholder="请选择豆包账号"
          value={selectedAccount?.id}
          options={accounts.map((account): { value: string; label: string } => ({ value: account.id, label: account.name }))}
          onChange={(value: string): void => { setAccountId(value); setError(''); }}
          notFoundContent="暂无豆包账号"
        />
        {!accounts.length && <p className="story-create-field-hint">暂无豆包账号，请先在账号管理中添加。</p>}
      </div>
      <p className="story-create-save-hint">点击创建后，选择一个空文件夹保存项目。</p>
      {!studioProject && <Alert type="info" showIcon message="项目信息尚未就绪，请稍后重试。" />}
      {error && <Alert type="error" showIcon message={error} />}
    </Modal>
  </>;
};
