import React from 'react';
import type { PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryPromptReference, PetStoryShot } from '@doubao-studio/contracts';
import { planDisplayText } from '../utils/petstoryPlanReview';

export interface PetStoryPlanPreviewProps {
  plan: PetStoryPlan;
  contentBasis?: PetStoryProject['contentBasis'];
}
interface PreviewFieldProps { label: string; value?: string }
const PreviewPlanContext = React.createContext<PetStoryPlan | undefined>(undefined);
const PreviewField: React.FC<PreviewFieldProps> = ({ label, value }): React.ReactElement => {
  const plan = React.useContext(PreviewPlanContext);
  return <div className="petstory-plan-field"><dt>{label}</dt><dd>{value?.trim() ? planDisplayText(plan, value) : '未填写'}</dd></div>;
};

function entityName(items: { id: string; name: string }[] | undefined, id: string | undefined, missing: string): string {
  if (!id) return missing;
  return items?.find((item): boolean => item.id === id)?.name || missing;
}
function designSource(origin: 'script' | 'proposed' | undefined): string {
  return origin === 'script' ? '剧本明确' : origin === 'proposed' ? '方案补充，待确认' : '未标注';
}
const modes: Record<PetStoryShot['requestedMode'], string> = { auto: '自动选择', first_frame: '首帧', first_last_frame: '首尾帧', reference: '多参考图片' };
const dialects: Record<NonNullable<PetStoryPrompt['promptTask']>['dialect'], string> = { seedance20: 'Seedance 2.0', seedance25: 'Seedance 2.5', seedream: 'Seedream', generic: '未限定模型' };
const referenceUses: Record<PetStoryPromptReference['purpose'], string> = { identity: '人物身份参考', prop: '道具参考', scene: '场景参考', firstFrame: '首帧', plannedEndImage: '尾帧', actualEndFrame: '前镜视频末帧' };

function referenceLabel(plan: PetStoryPlan, reference: PetStoryPromptReference): string {
  const characters = reference.characterIds.map((id): string => entityName(plan.characters, id, '未对应人物')).join('、');
  const slot = reference.slot === 'first' ? ' · 首帧位置' : reference.slot === 'last' ? ' · 尾帧位置' : '';
  return `图片 ${reference.order} · ${referenceUses[reference.purpose]}${characters ? ` · ${characters}` : ''}${slot}`;
}

/** 只读展示方案将更新的创作正文；技术来源与内部标识不作为用户确认内容。 */
const PromptPreview: React.FC<{ plan: PetStoryPlan; prompt: PetStoryPrompt; title: string }> = ({ plan, prompt, title }): React.ReactElement => <section className="petstory-plan-prompt" aria-label={title}>
  <h5>{title}</h5><dl>
    <PreviewField label="当前采用正文" value={prompt.final} />
    <PreviewField label="候选正文" value={prompt.optimized} />
    <PreviewField label="原始正文" value={prompt.original} />
    <PreviewField label="参考草稿" value={prompt.draft} />
    <PreviewField label="编辑与复核" value={`${prompt.edited ? '包含用户修改' : '没有用户修改标记'} · ${prompt.needsReview ? '需要复核' : '没有待复核标记'}`} />
    {prompt.editIntent && <><PreviewField label="编辑基图" value="使用已关联图片" /><PreviewField label="本次变化" value={prompt.editIntent.changes} /><PreviewField label="保留内容" value={prompt.editIntent.preserve} /><PreviewField label="适用范围" value={prompt.editIntent.validity} /></>}
    {prompt.promptTask && <><PreviewField label="提示词适用模型" value={dialects[prompt.promptTask.dialect]} /><PreviewField label="提示词适用模式" value={prompt.promptTask.mode ? modes[prompt.promptTask.mode] : '未限定模式'} /><PreviewField label="图片引用与顺序" value={prompt.promptTask.references.map((reference): string => referenceLabel(plan, reference)).join('\n') || '没有图片引用'} /></>}
  </dl>
</section>;

const ShotPreview: React.FC<{ plan: PetStoryPlan; shot: PetStoryShot }> = ({ plan, shot }): React.ReactElement => {
  const previous = plan.shots.find((item): boolean => item.id === shot.previousShotId);
  const cast = shot.characterIds.map((id): string => entityName(plan.characters, id, '未对应人物')).join('、');
  const props = shot.propIds?.map((id): string => entityName(plan.props, id, '未对应道具')).join('、');
  return <article className="petstory-plan-shot" aria-label={`镜头 ${shot.order} 完整方案`}>
    <h4>镜头 {shot.order} · {shot.scene || '未填写场景'}</h4><dl>
      <PreviewField label="人物" value={cast || '没有指定人物'} /><PreviewField label="道具" value={props || '没有指定道具'} />
      <PreviewField label="所属场景" value={entityName(plan.scenes, shot.sceneId, '没有对应场景')} /><PreviewField label="场景画面" value={shot.scene} />
      <PreviewField label="场景视角" value={shot.sceneView} /><PreviewField label="镜头目的" value={shot.narrativePurpose} />
      <PreviewField label="剧情来源" value={shot.sourceRefs?.join('\n')} /><PreviewField label="景别、机位与构图" value={shot.framing} />
      <PreviewField label="人物站位与互动安排" value={shot.blocking} /><PreviewField label="主要动作" value={shot.action} />
      <PreviewField label="开始状态" value={shot.startState} /><PreviewField label="结束状态" value={shot.endState} />
      <PreviewField label="表演" value={shot.performance} /><PreviewField label="表情变化" value={shot.expression} />
      <PreviewField label="视线目标" value={shot.gaze} /><PreviewField label="人物互动" value={shot.interaction} />
      <PreviewField label="镜头运动" value={shot.camera} /><PreviewField label="声音安排" value={shot.sound} />
      <PreviewField label="动作与发声节奏" value={shot.timing} /><PreviewField label="镜头时长" value={`${shot.durationSeconds} 秒`} />
      <PreviewField label="视频模式" value={modes[shot.requestedMode]} /><PreviewField label="镜头衔接" value={shot.transition === 'continue' ? '延续上一镜' : '正常切镜'} />
      <PreviewField label="衔接镜头" value={previous ? `镜头 ${previous.order} · ${previous.scene}` : shot.previousShotId ? '未对应到前一镜头，请核对' : '没有指定前一镜头'} />
      <PreviewField label="连续性要求" value={shot.continuity} /><PreviewField label="已有场景参考图片" value={`${shot.sceneReferenceAssetIds?.length || 0} 张`} />
      <PreviewField label="本场人物造型" value={Object.entries(shot.appearanceOverrides || {}).map(([id, value]): string => `${entityName(plan.characters, id, '未对应人物')}：${value || '未填写'}`).join('\n')} />
      <PreviewField label="道具状态与持有者" value={shot.propStates?.map((state): string => `${entityName(plan.props, state.propId, '未对应道具')} · ${state.holderId ? entityName(plan.characters, state.holderId, '未对应持有者') : '未指定持有者'}：${state.state || '未填写状态'}`).join('\n')} />
    </dl>
    <section aria-label={`镜头 ${shot.order} 原台词`}><h5>原台词与演绎</h5>{shot.dialogue?.length ? shot.dialogue.map((line, index): React.ReactNode => <dl key={index} className="petstory-plan-dialogue"><PreviewField label="说话人物" value={entityName(plan.characters, line.speakerId, '未对应人物')} /><PreviewField label="台词" value={line.text} /><PreviewField label="语气" value={line.tone} /><PreviewField label="节奏" value={line.pace} /><PreviewField label="演绎位置" value={line.delivery ? { onscreen: '画内说话', offscreen: '画外说话', voiceover: '旁白' }[line.delivery] : '未指定'} /></dl>) : <p>没有安排台词。</p>}</section>
    <PromptPreview plan={plan} prompt={shot.prompts.firstFrame} title={`镜头 ${shot.order} · 首帧提示词`} />
    {shot.prompts.lastFrame ? <PromptPreview plan={plan} prompt={shot.prompts.lastFrame} title={`镜头 ${shot.order} · 尾帧提示词`} /> : <p>本方案没有尾帧提示词。</p>}
    <PromptPreview plan={plan} prompt={shot.prompts.video} title={`镜头 ${shot.order} · 视频提示词`} />
  </article>;
};

export const PetStoryPlanPreview: React.FC<PetStoryPlanPreviewProps> = ({ plan, contentBasis }): React.ReactElement => <PreviewPlanContext.Provider value={plan}><div className="petstory-plan-preview" aria-label="完整方案预览">
  <section><h3>故事理解与内容安排</h3><dl><PreviewField label="故事梗概" value={plan.sourceSummary} /><PreviewField label="故事理解" value={plan.understanding} /><PreviewField label="本次故事" value={plan.adaptedStory} /><PreviewField label="全场空间与连续性" value={plan.sceneDesign} />
    {contentBasis && <><PreviewField label="起始事件" value={contentBasis.beginning} /><PreviewField label="发展过程" value={contentBasis.middle} /><PreviewField label="结尾结果" value={contentBasis.ending} /></>}
  </dl></section>
  <section><h3>人物 · {plan.characters.length} 位</h3>{plan.characters.map((character): React.ReactNode => <article key={character.id}><h4>{character.name || '未命名人物'}</h4><dl><PreviewField label="角色职责" value={character.role === 'main' ? '主演' : '配角'} /><PreviewField label="来源称谓" value={character.aliases?.join('、')} /><PreviewField label="剧情作用" value={character.purpose} /><PreviewField label="外观与服装" value={character.description} /><PreviewField label="连续性要求" value={character.continuity} /><PreviewField label="设计来源" value={designSource(character.designOrigin)} /><PreviewField label="人物参考图片" value={character.referenceAssetId ? '已有关联图片' : '尚未关联图片'} /></dl></article>)}</section>
  <section><h3>道具 · {plan.props?.length || 0} 项</h3>{plan.props?.map((prop): React.ReactNode => <article key={prop.id}><h4>{prop.name || '未命名道具'}</h4><dl><PreviewField label="来源称谓" value={prop.aliases.join('、')} /><PreviewField label="外观描述" value={prop.description} /><PreviewField label="关键状态" value={prop.keyStates} /><PreviewField label="尺寸与比例" value={prop.scale} /><PreviewField label="基础图静态状态" value={prop.appearanceState} /><PreviewField label="设计来源" value={designSource(prop.designOrigin)} /></dl></article>)}</section>
  <section><h3>场景 · {plan.scenes?.length || 0} 处</h3>{plan.scenes?.map((scene): React.ReactNode => <article key={scene.id}><h4>{scene.name || '未命名场景'}</h4><dl><PreviewField label="地点" value={scene.location} /><PreviewField label="时间" value={scene.time} /><PreviewField label="光线" value={scene.lighting} /><PreviewField label="空间布局" value={scene.layout} /><PreviewField label="场景视角" value={scene.view} /><PreviewField label="关联主场景" value={scene.parentSceneId ? entityName(plan.scenes, scene.parentSceneId, '未对应主场景') : '独立场景'} /><PreviewField label="设计来源" value={designSource(scene.designOrigin)} /></dl></article>)}</section>
  <section><h3>动态分镜 · {plan.shots.length} 个镜头</h3>{plan.shots.map((shot): React.ReactNode => <ShotPreview key={shot.id} plan={plan} shot={shot} />)}</section>
</div></PreviewPlanContext.Provider>;
