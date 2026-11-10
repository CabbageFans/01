/** 真实正式resolver/observer读取原消息；纯文字操作建议不伪装成视频生成中。 */
import { afterEach, expect, it, vi } from 'vitest';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { resolveVideoArtifact } from '../../src/utils/doubaoBridge';
import { geometry, settleVideoFixture, videoFixturePrompt, videoFixtureUrl, videoWorkflowFixture, workflowMessage, workflowCard } from '../fixtures/videoWorkflowDom';

const context = { conversationUrl: videoFixtureUrl, runId: 'TEST-run', sourcePrompt: videoFixturePrompt,
  readbackContext: { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: videoFixtureUrl, currentConversationUrl: videoFixtureUrl } };
const advice = '✅视频生成提示词（可直接复制使用）\nTEST 角色打开门。\n参数核对：Seedance2.0 Fast，5秒，9:16。';
afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('原助手仅提供可复制提示词时，正式resolver保留未执行生成的结构化结果且无页面写入', async (): Promise<void> => {
  const page = videoWorkflowFixture('first_frame', true); page.editor.value = '';
  workflowMessage('user', videoFixturePrompt, 'TEST-user'); workflowMessage('assistant', advice, 'TEST-assistant');
  const result = await resolveVideoArtifact(page.view, context);
  expect(result).toMatchObject({ status: 'generation_not_started', reason: '平台仅返回可复制的视频提示词，未执行视频生成', evidenceKey: expect.any(String) });
  expect(JSON.stringify(result)).not.toContain('TEST 角色打开门'); expect(page.finalClicks).not.toHaveBeenCalled(); expect(page.view.loadURL).not.toHaveBeenCalled(); expect(page.view.sendInputEvent).not.toHaveBeenCalled();
});
it('正式adapter观察两次稳定原建议即结束，不等一小时，也不额外发送', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); page.editor.value = '';
  workflowMessage('user', videoFixturePrompt, 'TEST-user'); workflowMessage('assistant', advice, 'TEST-assistant');
  const progress = vi.fn(async (): Promise<void> => {}); const adapter = new DoubaoVideoAdapter(page.view);
  const result = await settleVideoFixture(adapter.observe({ context, signal: new AbortController().signal, timeoutMs: 60 * 60_000, ensureCurrent: (): void => {}, onProgress: progress }), 4000);
  expect(result.status).toBe('generation_not_started'); expect(page.view.executeJavaScript).toHaveBeenCalledTimes(2); expect(progress).toHaveBeenCalledOnce(); expect(page.finalClicks).not.toHaveBeenCalled();
});
it('原助手只指示用户去视频生成面板粘贴并生成时，同样保留明确未执行的结构化原因', async (): Promise<void> => {
  const page = videoWorkflowFixture('first_frame', true); page.editor.value = '';
  workflowMessage('user', videoFixturePrompt, 'TEST-user'); workflowMessage('assistant', '请在视频生成面板粘贴本段提示词后点击生成即可。', 'TEST-assistant');
  expect(await resolveVideoArtifact(page.view, context)).toMatchObject({ status: 'generation_not_started', reason: '平台仅提供视频生成操作建议，未执行视频生成' });
  expect(page.finalClicks).not.toHaveBeenCalled();
});
it.each(['generating', 'card', 'ordinary-text', 'other-turn'] as const)('%s不能由原建议标题误判为未执行生成', async (scenario): Promise<void> => {
  const page = videoWorkflowFixture('first_frame', true); page.editor.value = '';
  workflowMessage('user', videoFixturePrompt, 'TEST-user'); const reply = workflowMessage('assistant', scenario === 'ordinary-text' || scenario === 'other-turn' ? 'TEST原请求正常回复，等待视频卡' : advice, 'TEST-assistant');
  if (scenario === 'generating') { const stop = geometry(document.createElement('button')); stop.setAttribute('aria-label', '停止生成'); document.body.append(stop); }
  if (scenario === 'card') workflowCard(reply, 'TEST-vid', 'https://fixture.test/video/original.mp4');
  if (scenario === 'other-turn') { workflowMessage('user', 'TEST其它请求', 'TEST-other-user'); workflowMessage('assistant', advice, 'TEST-other-assistant'); }
  expect((await resolveVideoArtifact(page.view, context)).status).toBe(scenario === 'card' ? 'resolved' : 'unavailable'); expect(page.finalClicks).not.toHaveBeenCalled();
});
