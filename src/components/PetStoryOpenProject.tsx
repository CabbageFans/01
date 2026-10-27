import React, { useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { usePetStoryStore } from '../store/usePetStoryStore';

/** 两个打开入口复用同一项目服务，选择器不可用时仍可明确输入已有项目位置。 */
export const PetStoryOpenProject: React.FC<{ disabled?: boolean; label?: string; onOpened?: () => void }> = ({ disabled = false, label = '打开项目目录', onOpened }): React.ReactElement => {
  const state = usePetStoryStore();
  const [visible, setVisible] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const open = async (value?: string): Promise<void> => {
    await state.openProject(value);
    const current = usePetStoryStore.getState();
    if (!current.error && current.project) { setVisible(false); setProjectPath(''); onOpened?.(); }
  };
  const blocked = disabled || state.busy;
  return <>
    <Button icon={<FolderOpenOutlined />} disabled={blocked} onClick={(): void => { void open(); }}>{label}</Button>
    <Button size="small" disabled={blocked} onClick={(): void => setVisible(true)}>输入项目路径</Button>
    <Modal title="按路径打开已有短剧" open={visible} onCancel={(): void => { if (!state.busy) setVisible(false); }} onOk={(): void => { void open(projectPath.trim()); }}
      okText="打开项目" cancelText="取消" confirmLoading={state.busy} okButtonProps={{ disabled: blocked || !projectPath.trim() }} cancelButtonProps={{ disabled: state.busy }}>
      <p className="mb-3">文件选择器不可用时，输入已有项目目录或其中 project.json 的完整路径。</p>
      <Input aria-label="已有短剧项目完整路径" value={projectPath} disabled={state.busy} onChange={(event): void => setProjectPath(event.target.value)} placeholder="项目目录或 project.json 的完整路径" />
      {state.error && <p role="alert" className="mt-2 text-red-400">{state.error}</p>}
    </Modal>
  </>;
};
