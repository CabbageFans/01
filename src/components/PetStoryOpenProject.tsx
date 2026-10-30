import React from 'react';
import { Button } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { usePetStoryStore } from '../store/usePetStoryStore';

/** 通过文件选择器打开已有项目，并在成功后继续创作。 */
export const PetStoryOpenProject: React.FC<{ disabled?: boolean; label?: string; onOpened?: () => void }> = ({ disabled = false, label = '打开项目', onOpened }): React.ReactElement => {
  const state = usePetStoryStore();
  const open = async (): Promise<void> => {
    await state.openProject();
    const current = usePetStoryStore.getState();
    if (!current.error && current.project) onOpened?.();
  };
  const blocked = disabled || state.busy;
  return <Button icon={<FolderOpenOutlined />} disabled={blocked} onClick={(): void => { void open(); }}>{label}</Button>;
};
