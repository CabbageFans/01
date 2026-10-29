/** 离线实际回复选择界面；采用服务为明确替身，不把界面测试当真实豆包验收。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PetStoryChatAdjustmentPanel from '../../src/components/PetStoryChatAdjustmentPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { registerPetStoryDraft, unregisterPetStoryDraft } from '../../src/utils/petstoryDraftPresence';
import type { PetStoryConversationReply, PetStoryAdjustmentPreview, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = usePetStoryStore.getState(); const now = '2026-10-29T06:00:00.000Z';
let project: PetStoryProject;
function reply(key: string, text: string): PetStoryConversationReply { return { key, text, precedingUserText: 'TEST 当前对象讨论', capturedAt: now, turnId: `TEST-turn-${key}` }; }
function choose(index: number): void { fireEvent.click(screen.getByRole('button', { name: /选择回复/ })); fireEvent.click(screen.getByRole('radio', { name: `豆包回复 ${index}` })); }
async function preview(): Promise<void> { fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' })); await screen.findByText('确认应用这条回复'); }
beforeEach((): void => {
  project = { schemaVersion: 1, id: 'TEST-ui-adjustment', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now, plan: structuredClone(snapshot.plan) as PetStoryPlan,
    chatAdjustment: { id: 'TEST-adjustment', target: { shotId: 'shot_1', promptKind: 'video' }, sourceJobId: 'TEST-source', conversationUrl: 'https://www.doubao.com/chat/TEST-original', basisHash: 'TEST-basis', previousText: 'TEST 当前采用视频正文', startedAt: now, status: 'active', replies: [reply('TEST-question', 'TEST 需要保留当前机位吗？'), reply('TEST-chosen', JSON.stringify({ optimized: 'TEST 用户满意的完整视频正文\n保留台词。', requestId: 'TEST-hidden-contract' })), reply('TEST-latest', 'TEST 后来的中间建议，不应自动采用。')] } };
  usePetStoryStore.setState({ ...initial, project, busy: false, error: '', chatReadbackError: '', previewChatReply: vi.fn(async (key: string): Promise<PetStoryAdjustmentPreview | null> => { const selected = project.chatAdjustment?.replies.find((item): boolean => item.key === key); if (!selected) return null; let body = selected.text; try { const parsed = JSON.parse(body) as { optimized?: string }; body = parsed.optimized || body; } catch { /* 测试自然语言原样返回。 */ } return { target: project.chatAdjustment!.target, previousBody: 'TEST 当前采用视频正文', body }; }), adoptChatReply: vi.fn(async (key: string): Promise<void> => { if (key !== 'TEST-chosen') throw new Error('TEST 采用了错误的具体回复'); usePetStoryStore.setState({ project: { ...project, chatAdjustment: { ...project.chatAdjustment!, status: 'adopted', adoptedReplyKey: key } } }); }), endChatAdjustment: vi.fn(async (): Promise<void> => undefined) });
});
afterEach((): void => { cleanup(); unregisterPetStoryDraft(`${project.id}:TEST-draft`); usePetStoryStore.setState(initial); vi.restoreAllMocks(); });

describe('自由对话的具体回复选择与确认', (): void => {
  it.each([
    { body: { requestId: 'TEST-hidden-request', targetIds: ['TEST-hidden-target'], understanding: 'TEST 真实回复的故事理解', sceneDesign: 'TEST 真实回复的场景安排', shots: [{ id: 'TEST-hidden-shot', order: 1, action: 'TEST 真实回复的动作' }] }, visible: 'TEST 真实回复的故事理解' },
    { body: { requestId: 'TEST-hidden-request', optimized: 'TEST 真实回复的完整提示词，保留 {模型正文中的括号}。' }, visible: 'TEST 真实回复的完整提示词，保留 {模型正文中的括号}。' },
    { body: { requestId: 'TEST-hidden-request', targetIds: ['TEST-hidden-target'] }, visible: '这条回复尚未整理为可预览的创作内容，请在豆包中要求整理当前对象的完整方案或提示词。' },
  ])('网页重复json标签后的结构化回复只展示创作摘要：$visible', ({ body, visible }): void => {
    const raw = `json\n\nTEST 网页代码语言标签\n\n\`\`\`json\n${JSON.stringify(body)}\n\n\`\`\``;
    project.chatAdjustment!.replies = [reply('TEST-prefixed', raw)]; usePetStoryStore.setState({ project });
    render(<PetStoryChatAdjustmentPanel />); fireEvent.click(screen.getByRole('button', { name: /选择回复/ }));
    const choice = screen.getByRole('radio', { name: '豆包回复 1' }).closest('label.adjustment-reply')!;
    expect(choice.textContent).toContain(visible); expect(choice.textContent).not.toMatch(/requestId|targetIds|TEST-hidden|```|网页代码语言标签/);
    expect(usePetStoryStore.getState().project?.chatAdjustment?.replies[0].text).toBe(raw);
    expect(usePetStoryStore.getState().previewChatReply).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled();
  });
  it('一条回复含两个不同JSON对象时不猜选正文，也不向用户展示原始数据', (): void => {
    project.chatAdjustment!.replies = [reply('TEST-ambiguous', 'TEST 多个版本\n{"optimized":"TEST 版本一"}\n{"optimized":"TEST 版本二"}')]; usePetStoryStore.setState({ project });
    render(<PetStoryChatAdjustmentPanel />); fireEvent.click(screen.getByRole('button', { name: /选择回复/ }));
    expect(screen.getByText('这条回复尚未整理为可预览的创作内容，请在豆包中要求整理当前对象的完整方案或提示词。')).toBeDefined();
    expect(screen.queryByText(/optimized|TEST 版本一|TEST 版本二/)).toBeNull();
  });
  it('打开选择层不默认选最后一条；选定具体回复后先比较，再确认采用', async (): Promise<void> => {
    render(<PetStoryChatAdjustmentPanel />); fireEvent.click(screen.getByRole('button', { name: /选择回复/ }));
    expect(screen.getAllByRole('radio').every((radio): boolean => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: '应用到当前创作' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '豆包回复 2' })); await preview();
    const dialog = screen.getByText('确认应用这条回复').closest('[role=dialog]') as HTMLElement; expect(within(dialog).getByText('镜头 1 · 视频提示词')).toBeDefined(); expect(within(dialog).getByText('TEST 当前采用视频正文')).toBeDefined(); expect(within(dialog).getByText(/TEST 用户满意的完整视频正文/)).toBeDefined(); expect(within(dialog).queryByText(/TEST-hidden-contract/)).toBeNull();
    expect(usePetStoryStore.getState().previewChatReply).toHaveBeenCalledExactlyOnceWith('TEST-chosen'); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole('button', { name: '确认采用此回复' }));
    await waitFor((): void => expect(usePetStoryStore.getState().adoptChatReply).toHaveBeenCalledExactlyOnceWith('TEST-chosen'));
    await waitFor((): void => expect(screen.queryByRole('region', { name: '当前创作的豆包调整' })).toBeNull());
  });
  it('追问可以查看但不能作为创作正文采用', async (): Promise<void> => {
    render(<PetStoryChatAdjustmentPanel />); choose(1); await preview();
    expect(screen.getByText('这条回复包含追问，请在豆包中整理为完整方案或提示词后再采用')).toBeDefined(); const button = screen.getByRole('button', { name: '确认采用此回复' }); expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled();
  });
  it('已有未保存草稿时先展示受保护对象并阻断采用', async (): Promise<void> => {
    registerPetStoryDraft(`${project.id}:TEST-draft`, '镜头 2 的首帧提示词'); render(<PetStoryChatAdjustmentPanel />); choose(2); await preview();
    expect(screen.getByText('还有未保存的修改，请先保存或放弃，再采用回复')).toBeDefined(); expect(screen.getByText('镜头 2 的首帧提示词')).toBeDefined(); const button = screen.getByRole('button', { name: '确认采用此回复' }); expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled();
  });
  it('已选回复回读后消失时禁用采用，不能将选择默默移到最后一条', async (): Promise<void> => {
    render(<PetStoryChatAdjustmentPanel />); choose(2); await preview();
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: { ...project, revision: 2, chatAdjustment: { ...project.chatAdjustment!, replies: [project.chatAdjustment!.replies[2]] } } }); });
    expect(screen.getByRole('button', { name: '确认采用此回复' }).hasAttribute('disabled')).toBe(true); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled();
  });
  it('正式预览失败时保留选择并展示错误，不进入确认或采用', async (): Promise<void> => {
    usePetStoryStore.setState({ previewChatReply: vi.fn(async (): Promise<null> => { usePetStoryStore.setState({ error: 'TEST 这条回复与当前镜头依据不符' }); return null; }) });
    render(<PetStoryChatAdjustmentPanel />); choose(2); fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' }));
    await waitFor((): void => expect(usePetStoryStore.getState().previewChatReply).toHaveBeenCalledExactlyOnceWith('TEST-chosen'));
    expect(await screen.findByText('TEST 这条回复与当前镜头依据不符')).toBeDefined(); expect(screen.queryByText('确认应用这条回复')).toBeNull(); expect(usePetStoryStore.getState().adoptChatReply).not.toHaveBeenCalled();
  });
  it('回读失败或尚无可辨认回复时说明原因，保持选择不可用', (): void => {
    project.chatAdjustment!.replies = []; usePetStoryStore.setState({ project, chatReadbackError: 'TEST 当前网页尚未识别到关联回复' }); render(<PetStoryChatAdjustmentPanel />);
    expect(screen.getByRole('status').textContent).toContain('尚未识别'); expect(screen.getByRole('button', { name: /选择回复/ }).hasAttribute('disabled')).toBe(true); expect(screen.queryByRole('button', { name: '确认采用此回复' })).toBeNull();
  });
});
