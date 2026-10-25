import React, { useState } from 'react';
import { Button, Input, Modal, Select, Space, message } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useProjectStore } from '../store/useProjectStore';
import { ProjectManagementModal } from './ProjectManagementModal';

export const ProjectSwitcher: React.FC<{ variant?: 'context' | 'actions' }> = ({ variant = 'context' }): React.ReactElement => {
  const { projects, activeProjectId, selectProject, addProject } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = async () => {
    if (!name.trim()) return;
    if (await addProject(name.trim(), description.trim())) {
      setName(''); setDescription(''); setOpen(false); message.success('项目已创建');
    }
  };
  return (
    <>
      <Space.Compact>
        {variant === 'context' && (
        <Select
          value={activeProjectId}
          onChange={selectProject}
          style={{ width: 180 }}
          aria-label="当前 Studio 项目"
          options={projects.filter((project) => !project.archived).map((project) => ({ value: project.id, label: project.name }))}
        />
        )}
        {variant === 'actions' && <Button icon={<PlusOutlined />} onClick={(): void => setOpen(true)}>新建 Studio 项目</Button>}
        {variant === 'actions' && <Button icon={<SettingOutlined />} aria-label="管理项目" onClick={(): void => setManageOpen(true)}>管理项目</Button>}
      </Space.Compact>
      <Modal title="新建项目" open={open} onOk={() => void create()} onCancel={() => setOpen(false)} okText="创建" cancelText="取消">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" autoFocus style={{ marginBottom: 12 }} />
        <Input.TextArea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="项目说明" rows={3} />
      </Modal>
      <ProjectManagementModal open={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  );
};
