import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyMaterialAuthorizationSnapshot,
  decideMaterialAuthorizationAutoConfirm,
} from '../../src/utils/materialAuthorization';
import { InitializationGate } from '../../src/utils/initializationGate';
import {
  classifyUploadReadinessFailure,
  isUploadSnapshotReady,
} from '../../src/utils/uploadReadiness';
import { confirmMaterialAuthorizationIfAllowed, inspectMaterialAuthorization } from '../../src/utils/doubaoBridge';
import { normalizeDoubaoConversationUrl } from '../../src/utils/taskConversationLocator';

interface AuthorizationNode {
  tagName: string; innerText: string; textContent: string; offsetParent: object; parentElement: AuthorizationNode | null; disabled: boolean;
  attributes: Record<string, string>; children: AuthorizationNode[]; position: string;
  bounds: { left: number; top: number; width: number; height: number };
  getBoundingClientRect(): AuthorizationNode['bounds']; getAttribute(name: string): string | null; hasAttribute(name: string): boolean;
  closest(selector: string): AuthorizationNode | null; contains(node: AuthorizationNode): boolean; matches(selector: string): boolean; click(): void;
}
function authorizationNode(tagName: string, text: string, left = 100): AuthorizationNode {
  const result: AuthorizationNode = { tagName, innerText: text, textContent: text, offsetParent: {}, parentElement: null, disabled: false,
    attributes: {}, children: [], position: 'static', bounds: { left, top: 200, width: tagName === 'BUTTON' ? 80 : 400, height: tagName === 'BUTTON' ? 40 : 300 },
    getBoundingClientRect: (): AuthorizationNode['bounds'] => result.bounds, getAttribute: (name: string): string | null => result.attributes[name] ?? null,
    hasAttribute: (name: string): boolean => name in result.attributes, closest: (): null => null,
    contains: (node: AuthorizationNode): boolean => result === node || result.children.includes(node), matches: (): boolean => tagName === 'BUTTON', click: (): void => undefined };
  return result;
}
function authorizationEnvironment(options: { confirms?: number; refusals?: number; body?: string; stayOpen?: boolean; activationDelay?: number } = {}): {
  view: Parameters<typeof confirmMaterialAuthorizationIfAllowed>[0]; native: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn>;
  root: AuthorizationNode; confirm: AuthorizationNode; location: { href: string }; attachments: number; pending: boolean; beforeActivation?: () => void; afterClick?: () => void;
} {
  const body = authorizationNode('BODY', '');
  const root = authorizationNode('DIV', options.body || '安全确认 上传、使用的素材均已充分授权 拒绝 确认'); root.parentElement = body; root.attributes.role = 'dialog';
  root.children = [...Array.from({ length: options.refusals ?? 1 }, (): AuthorizationNode => authorizationNode('BUTTON', '拒绝')),
    ...Array.from({ length: options.confirms ?? 1 }, (): AuthorizationNode => authorizationNode('BUTTON', '确认', 220))];
  for (const button of root.children) button.parentElement = root;
  const confirm = root.children.find((button): boolean => button.innerText === '确认') || authorizationNode('BUTTON', 'missing');
  const asset = authorizationNode('IMG', ''); const progress = authorizationNode('DIV', '');
  const location = { href: 'https://www.doubao.com/chat/OFFLINE' }; const native = vi.fn(); let present = true; let calls = 0;
  const click = vi.fn((): void => { test.afterClick?.(); if (!options.stayOpen) present = false; });
  for (const button of root.children) button.click = click;
  const document = { body, documentElement: body, hasFocus: (): boolean => false,
    querySelectorAll: (selector: string): AuthorizationNode[] => {
      if (selector.startsWith('img,')) return Array.from({ length: test.attachments }, (): AuthorizationNode => asset);
      if (selector.startsWith('[aria-busy')) return test.pending ? [progress] : [];
      if (selector.startsWith('button,')) return present ? root.children : [];
      return present ? [root] : [];
    }, elementFromPoint: (): AuthorizationNode => confirm };
  const window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: (node: AuthorizationNode): object => ({ display: 'block', visibility: 'visible', position: node.position }) };
  const context = vm.createContext({ document, window, location, Date });
  const test: ReturnType<typeof authorizationEnvironment> = { root, confirm, location, native, click, attachments: 1, pending: false, view: {
    getURL: (): string => location.href, loadURL: (): void => undefined, sendInputEvent: native,
    executeJavaScript: async (script: string): Promise<unknown> => {
      calls++;
      if (calls === 2) {
        test.beforeActivation?.();
        if (options.activationDelay) await new Promise<void>((resolve): void => { setTimeout(resolve, options.activationDelay); });
      }
      return vm.runInContext(script, context);
    },
  } };
  return test;
}
const authorizationInput = { enabled: true, expectedConversationUrl: 'https://www.doubao.com/chat/OFFLINE', assetsValidated: true };

describe('P0-1 素材授权精确白名单', () => {
  it.each([
    ['精确素材授权', { title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'present'],
    ['视频生成确认', { title: '安全确认', body: '视频生成参数确认，确认后开始生成视频', actions: ['拒绝', '确认'] }, 'blocked'],
    ['登录确认', { title: '安全确认', body: '请登录并确认上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'blocked'],
    ['支付确认', { title: '安全确认', body: '确认支付额度，上传、使用的素材均已充分授权', actions: ['拒绝', '确认'] }, 'blocked'],
    ['按钮不全', { title: '安全确认', body: '上传、使用的素材均已充分授权', actions: ['确认'] }, 'blocked'],
  ] as const)('$0 → $2', (_name, snapshot, expected) => {
    expect(classifyMaterialAuthorizationSnapshot(snapshot)).toBe(expected);
  });

  it.each([
    [{ enabled: false }, 'disabled'],
    [{ state: 'blocked' as const }, 'not_whitelisted'],
    [{ currentUrl: 'https://www.doubao.com/chat/other' }, 'conversation_mismatch'],
    [{ assetsValidated: false }, 'assets_unverified'],
    [{ confirmPosition: undefined }, 'target_missing'],
  ])('任一门禁缺失均拒绝自动确认 %#', (override, reason) => {
    expect(decideMaterialAuthorizationAutoConfirm({
      enabled: true,
      state: 'present',
      currentUrl: 'https://www.doubao.com/chat/a',
      expectedConversationUrl: 'https://www.doubao.com/chat/a',
      assetsValidated: true,
      confirmPosition: '100,200',
      ...override,
    })).toEqual({ allowed: false, reason });
  });

  it('窗口失焦时只激活唯一授权按钮一次，并回读弹窗消失', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = authorizationEnvironment(); const pending = confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput);
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).status).toBe('confirmed'); expect(test.click).toHaveBeenCalledOnce(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('只读授权检查不触发任何控件', async (): Promise<void> => {
    const test = authorizationEnvironment();
    expect(await inspectMaterialAuthorization(test.view)).toBe('present'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });

  it.each([{ confirms: 0 }, { confirms: 2 }, { refusals: 0 }, { refusals: 2 }, { body: '安全确认 视频生成参数确认 上传、使用的素材均已充分授权' }])('拒绝不完整、重复或其他业务语义的确认%j', async (options): Promise<void> => {
    const test = authorizationEnvironment(options);
    expect((await confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput)).status).toBe('not_allowed'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { assetsValidated: false }, { expectedConversationUrl: 'https://www.doubao.com/chat/OTHER' }])('宿主授权门禁缺失时不激活%j', async (override): Promise<void> => {
    const test = authorizationEnvironment();
    expect((await confirmMaterialAuthorizationIfAllowed(test.view, { ...authorizationInput, ...override })).status).toBe('not_allowed'); expect(test.click).not.toHaveBeenCalled();
  });

  it.each(['attachments', 'pending', 'body', 'geometry', 'url'] as const)('激活前%s变化时重读并拒绝点击', async (change): Promise<void> => {
    const test = authorizationEnvironment();
    test.beforeActivation = (): void => {
      if (change === 'attachments') test.attachments = 2;
      if (change === 'pending') test.pending = true;
      if (change === 'body') test.root.innerText = '安全确认 上传、使用的素材均已充分授权 确认支付';
      if (change === 'geometry') test.confirm.bounds.left += 10;
      if (change === 'url') test.location.href += '-changed';
    };
    expect((await confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput)).status).toBe('uncertain'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });

  it('点击后素材数变化时保留不确定结果且不补点', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = authorizationEnvironment(); test.afterClick = (): void => { test.attachments = 2; };
      const pending = confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput); await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ status: 'uncertain', reason: 'attachment_count_changed' }); expect(test.click).toHaveBeenCalledOnce(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('授权回执不明时不重发，同一页面授权也不能再次消费', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = authorizationEnvironment({ stayOpen: true }); const pending = confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput);
      await vi.advanceTimersByTimeAsync(2100); expect((await pending).status).toBe('uncertain');
      expect((await confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput)).status).toBe('uncertain'); expect(test.click).toHaveBeenCalledOnce(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('排队超时的授权脚本迟到后也不点击', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = authorizationEnvironment({ activationDelay: 6000 }); const pending = confirmMaterialAuthorizationIfAllowed(test.view, authorizationInput);
      await vi.advanceTimersByTimeAsync(5100); expect((await pending).status).toBe('uncertain');
      await vi.advanceTimersByTimeAsync(1000); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

});

describe('P0-2 初始化闸门与慢上传', () => {
  it('初始化并发 1 时第二任务等待，首任务释放后获得租约', async () => {
    const gate = new InitializationGate();
    const first = await gate.acquire('a', { limit: 1 });
    let secondAcquired = false;
    const secondPromise = gate.acquire('b', { limit: 1 }).then((lease) => { secondAcquired = true; return lease; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it('上传中、数量不足和额外素材分别给出机器码，只有精确数量放行', () => {
    expect(classifyUploadReadinessFailure({ inputFileCount: 1, visibleAttachmentCount: 1, matchingFileNameCount: 1, pending: true }, 1, 0)).toBe('pending');
    expect(classifyUploadReadinessFailure({ inputFileCount: 0, visibleAttachmentCount: 1, matchingFileNameCount: 0, pending: false }, 2, 0)).toBe('count_incomplete');
    expect(classifyUploadReadinessFailure({ inputFileCount: 3, visibleAttachmentCount: 3, matchingFileNameCount: 3, pending: false }, 2, 0)).toBe('count_mismatch');
    expect(isUploadSnapshotReady({ inputFileCount: 2, visibleAttachmentCount: 2, matchingFileNameCount: 2, pending: false }, 2, 0)).toBe(true);
  });
});

describe('P0-3 人工提交只读观察边界', () => {
  const panel = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8');

  it('人工声明入口只接受具体豆包会话并进入独立状态', () => {
    expect(panel).toContain("status: 'manual_submission_observing'");
    expect(panel).toContain("stage: 'manual_submission_observing'");
    expect(panel).toContain('userConfirmedCurrentUrl');
    expect(normalizeDoubaoConversationUrl('https://www.doubao.com/chat/verified?from=manual'))
      .toBe('https://www.doubao.com/chat/verified');
    expect(normalizeDoubaoConversationUrl('https://www.doubao.com/chat/')).toBeNull();
  });

  it('只读核对函数不包含注入、发送或新建对话调用', () => {
    const start = panel.indexOf('const handleSubmissionReconcile');
    const end = panel.indexOf("window.addEventListener('mark-manual-submission'", start);
    const body = panel.slice(start, end);
    expect(body).not.toContain('injectPrompt(');
    expect(body).not.toContain('submitPromptWithNativeClick(');
    expect(body).not.toContain('startNewConversation(');
    expect(body).toContain('matchesSubmissionConversation');
    expect(body).toContain('resolveVideoArtifact');
  });

  it('观察超时进入 manual_review，不计入账号失败或自动冷却', () => {
    expect(panel).toContain("code: isManualObservation ? 'manual_review_required' : 'submission_uncertain'");
    const reconcileStart = panel.indexOf('const handleSubmissionReconcile');
    const reconcileEnd = panel.indexOf("window.addEventListener('mark-manual-submission'", reconcileStart);
    const reconcileBody = panel.slice(reconcileStart, reconcileEnd);
    expect(reconcileBody).not.toContain('recordAccountOutcome(accountId, \'failure\'');
    expect(reconcileBody).not.toContain('cooldownUntil');
  });
});
