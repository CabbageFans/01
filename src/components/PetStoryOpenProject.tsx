import React from 'react';
import { Alert, Button, Input, Modal, Space } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import { usePetStoryStore } from '../store/usePetStoryStore';

/** 优先使用文件选择器；系统选框不可用时可直接输入已有项目位置。 */
export const PetStoryOpenProject: React.FC<{ disabled?: boolean; label?: string; onOpened?: () => void }> = ({ disabled = false, label = '打开项目', onOpened }): React.ReactElement => {
  const state = usePetStoryStore();
  const [locationOpen, setLocationOpen] = React.useState(false);
  const [location, setLocation] = React.useState('');
  const [opening, setOpening] = React.useState(false);
  const [error, setError] = React.useState('');
  const open = async (): Promise<void> => {
    await state.openProject();
    const current = usePetStoryStore.getState();
    if (!current.error && current.project) onOpened?.();
  };
  const openLocation = async (): Promise<void> => {
    const path = location.trim();
    if (!path || disabled || state.busy || opening) return;
    setOpening(true); setError('');
    try {
      await state.openProject(path);
      const current = usePetStoryStore.getState();
      if (current.error || !current.project) { setError(current.error || '项目尚未打开，请检查填写的位置。'); return; }
      setLocationOpen(false); onOpened?.();
    } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '项目暂时无法打开，请检查填写的位置。'); }
    finally { setOpening(false); }
  };
  const blocked = disabled || state.busy;
  return <><Space size={4}><Button aria-label={label} icon={<FolderOpenOutlined />} disabled={blocked || opening} onClick={(): void => { void open(); }}>{label}</Button>
    <Button type="link" size="small" disabled={blocked || opening} onClick={(): void => { setError(''); setLocationOpen(true); }}>按位置打开</Button></Space>
    <Modal title="按位置打开项目" open={locationOpen} onCancel={(): void => setLocationOpen(false)} footer={<><Button aria-label="取消" onClick={(): void => setLocationOpen(false)}>取消</Button><Button aria-label="打开此项目" type="primary" loading={opening} disabled={!location.trim() || blocked || opening} onClick={(): void => { void openLocation(); }}>打开此项目</Button></>}>
      <p>粘贴项目文件夹或 project.json 文件的完整位置。</p>
      <Input aria-label="项目位置" autoFocus value={location} disabled={opening || state.busy} placeholder="例如：/Users/你的名字/短剧项目" onChange={(event): void => setLocation(event.target.value)} onPressEnter={(): void => { void openLocation(); }} />
      {error && <Alert className="mt-3" type="error" showIcon message={error} />}
    </Modal></>;
};
