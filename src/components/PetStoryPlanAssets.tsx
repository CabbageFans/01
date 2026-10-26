import React from 'react';
import { Button, Card, Input, Select, Space, Tag, Typography } from 'antd';
import type { PetStoryPlan, PetStoryProp, PetStoryScene } from '@doubao-studio/contracts';

export const PetStoryPlanAssets: React.FC<{ plan: PetStoryPlan; disabled: boolean; edit: (change: (plan: PetStoryPlan) => void) => void }> = ({ plan, disabled, edit }): React.ReactElement => {
  const propFields: (keyof Pick<PetStoryProp, 'name' | 'description' | 'keyStates' | 'scale' | 'appearanceState'>)[] = ['name', 'description', 'appearanceState', 'keyStates', 'scale'];
  const sceneFields: (keyof Pick<PetStoryScene, 'name' | 'location' | 'time' | 'lighting' | 'layout' | 'view'>)[] = ['name', 'location', 'time', 'lighting', 'layout', 'view'];
  const labels = { name: '名称', description: '外形／材质／辨识细节', appearanceState: '基础图静态可视状态', keyStates: '剧情状态变化（制作元数据）', scale: '尺寸与比例依据', location: '地点', time: '时间', lighting: '光线', layout: '空间布局与相邻区域', view: '主视角／派生视角' };
  return <Card size="small" title="剧本道具与场景清单（同一实体跨镜复用）">
    <Space direction="vertical" className="w-full">
      <Typography.Text type="secondary">只列需要辨认的关键道具。普通切镜共用场景 ID，视角写在镜头中；独立派生图必须选择同地点的主场景。未知设计请保留“待确认”。</Typography.Text>
      {(plan.props || []).map((prop, index): React.ReactNode => <Card size="small" key={prop.id} title={<><Tag>道具</Tag>{prop.id}</>}>
        <Space direction="vertical" className="w-full">{propFields.map((key): React.ReactNode => <Input key={key} disabled={disabled} addonBefore={labels[key]} value={prop[key]} onChange={(e): void => edit((p): void => { (p.props || [])[index][key] = e.target.value; })} />)}
          <Input disabled={disabled} addonBefore="别名（顿号分隔）" value={prop.aliases.join('、')} onChange={(e): void => edit((p): void => { (p.props || [])[index].aliases = e.target.value.split('、').filter(Boolean); })} />
          <Select aria-label={`${prop.id}设计来源`} disabled={disabled} value={prop.designOrigin} options={[{ value: 'script', label: '剧本明确设定' }, { value: 'proposed', label: '待用户确认设计' }]} onChange={(value: PetStoryProp['designOrigin']): void => edit((p): void => { (p.props || [])[index].designOrigin = value; })} />
          <Button danger disabled={disabled} onClick={(): void => edit((p): void => { (p.props || []).splice(index, 1); })}>删除此道具（保存时校验镜头引用）</Button>
        </Space>
      </Card>)}
      <Button disabled={disabled} onClick={(): void => edit((p): void => { p.props = [...(p.props || []), { id: `prop-${crypto.randomUUID()}`, name: '', aliases: [], description: '', keyStates: '', scale: '', designOrigin: 'proposed' }]; p.scenes ??= []; })}>增加必要道具</Button>
      {(plan.scenes || []).map((scene, index): React.ReactNode => <Card size="small" key={scene.id} title={<><Tag>场景</Tag>{scene.id}</>}>
        <Space direction="vertical" className="w-full">{sceneFields.map((key): React.ReactNode => <Input key={key} disabled={disabled} addonBefore={labels[key]} value={scene[key]} onChange={(e): void => edit((p): void => { (p.scenes || [])[index][key] = e.target.value; })} />)}
          <Select className="w-full" aria-label={`${scene.id}主场景`} allowClear disabled={disabled} placeholder="主场景留空；派生图选择同地点已确认主图" value={scene.parentSceneId} options={(plan.scenes || []).filter((s): boolean => s.id !== scene.id).map((s): { value: string; label: string } => ({ value: s.id, label: s.name || s.id }))} onChange={(value?: string): void => edit((p): void => { (p.scenes || [])[index].parentSceneId = value; })} />
          <Select aria-label={`${scene.id}设计来源`} disabled={disabled} value={scene.designOrigin} options={[{ value: 'script', label: '剧本明确设定' }, { value: 'proposed', label: '待用户确认设计' }]} onChange={(value: PetStoryScene['designOrigin']): void => edit((p): void => { (p.scenes || [])[index].designOrigin = value; })} />
          <Button danger disabled={disabled} onClick={(): void => edit((p): void => { (p.scenes || []).splice(index, 1); })}>删除此场景（保存时校验镜头引用）</Button>
        </Space>
      </Card>)}
      <Button disabled={disabled} onClick={(): void => edit((p): void => { p.props ??= []; p.scenes = [...(p.scenes || []), { id: `scene-${crypto.randomUUID()}`, name: '', location: '', time: '未指定，待确认', lighting: '未指定，待确认', layout: '', view: '主场景', designOrigin: 'proposed' }]; })}>增加场景</Button>
    </Space>
  </Card>;
};
