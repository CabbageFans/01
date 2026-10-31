/** 网页边界离线模拟：验证原生菜单动作、真实节点回读和发送前失配阻断。 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { PetStoryCompiledPrompt, PetStoryPageBinding } from '@doubao-studio/contracts';
import { bindPetStoryReferences, verifyPetStoryReferenceBindings, type WebviewHandle, type PetStoryUploadReceipt } from '../../src/utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../../src/utils/petstoryControls';

function fixture(mention = true): { view: WebviewHandle; snapshot: PetStoryComposerSnapshot; receipts: PetStoryUploadReceipt[]; compiled: PetStoryCompiledPrompt; actions: string[]; breakNode: () => void } {
  let text = ''; let broken = false; const actions: string[] = [];
  const snapshot: PetStoryComposerSnapshot = { present: true, generic: true, first: false, last: false, nativeLabel: false, firstLabel: false, model: '', duration: 0, durations: [], aspectRatio: '', count: 2, pending: false,
    referenceSyntax: mention ? 'mention' : 'plain', previews: [{ key: 'key-b', label: mention ? '@图片2' : '第 1 张图', nodeId: 'asset-b' }, { key: 'key-a', label: mention ? '@图片1' : '第 2 张图', nodeId: 'asset-a' }],
    referenceOptions: mention ? [{ label: '@图片2', key: 'key-b', nodeId: 'asset-b' }, { label: '@图片1', key: 'key-a', nodeId: 'asset-a' }] : [], referenceNodes: [] };
  const view: WebviewHandle = { getURL: (): string => '', loadURL: (): void => {}, executeJavaScript: async (code: string): Promise<unknown> => {
    if (code.includes('petStoryComposerProbe')) {
      const match = code.match(/\)\((\{[\s\S]*\})\)$/); const operation = match ? JSON.parse(match[1]) as { selectReference?: string } : {};
      if (operation.selectReference) {
        const option = snapshot.referenceOptions?.find((o): boolean => o.label === operation.selectReference); actions.push(`select:${operation.selectReference}`);
        if (option) { text = text.replace(/@$/, option.label); snapshot.referenceNodes?.push({ label: option.label, nodeId: broken ? 'wrong-node' : option.nodeId! }); }
        return { ...snapshot, selectedReference: !!option };
      }
      return structuredClone(snapshot);
    }
    if (code.includes('appendExactComposerText')) {
      const match = code.match(/\)\(("[\s\S]*"),\s*(true|false)\)$/);
      if (match) { const value = JSON.parse(match[1]) as string; if (match[2] === 'true') { text = value; snapshot.referenceNodes = []; } else text += value; }
      else if (code.includes("('@',true)")) { text = '@'; snapshot.referenceNodes = []; }
      return true;
    }
    if (code.includes('insertExactComposerText')) { const match = code.match(/\)\(("[\s\S]*")\)$/); if (match) text = JSON.parse(match[1]) as string; return true; }
    // 正式全文校验脚本在该边界读取的编辑器正文；比较保持完整空白，不模拟实际发送。
    if (code.includes('readExactText')) return runInNewContext(code, { document: { querySelectorAll: (): object[] => [{ offsetParent: {}, disabled: false, tagName: 'TEXTAREA', value: text, getAttribute: (): null => null, getBoundingClientRect: (): object => ({ left: 20, top: 10, right: 620, bottom: 110, width: 600, height: 100 }) }] }, window: { innerWidth: 1200, innerHeight: 900, getComputedStyle: (): object => ({ visibility: 'visible', display: 'block' }) } }) as boolean;
    return true;
  } };
  const receipts: PetStoryUploadReceipt[] = [{ fileIndex: 0, key: 'key-a', label: mention ? '@图片1' : '第 2 张图', slot: 'reference', reference: mention ? 'mention' : 'plain' }, { fileIndex: 1, key: 'key-b', label: mention ? '@图片2' : '第 1 张图', slot: 'reference', reference: mention ? 'mention' : 'plain' }];
  const compiled: PetStoryCompiledPrompt = { text: '第 1 张图提供人物身份。\n第 2 张图提供环境。\n用户最终正文保留。', final: '用户最终正文保留。', kind: 'firstFrame', rulesVersion: 'TEST', requestedMode: 'auto', references: [{ assetId: 'file-a', characterIds: ['actor-a'], purpose: 'identity', order: 1 }, { assetId: 'file-b', characterIds: [], purpose: 'scene', order: 2 }] };
  return { view, snapshot, receipts, compiled, actions, breakNode: (): void => { broken = true; } };
}
async function fast<T>(work: () => Promise<T>): Promise<T> { return work(); }
describe('实际素材引用与节点', (): void => {
  it('按文件指纹映射页面重排后的编号，通过菜单创建平台节点并回读', async (): Promise<void> => {
    const test = fixture(); const bound = await fast((): ReturnType<typeof bindPetStoryReferences> => bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal));
    expect(test.actions).toEqual(['select:@图片1', 'select:@图片2']); expect(bound.bindings.map((b): string | undefined => b.nodeId)).toEqual(['asset-a', 'asset-b']);
    expect(bound.bindings.map((b): string => b.assetId)).toEqual(['file-a', 'file-b']); expect(bound.compiled.final).toBe(test.compiled.final);
    await verifyPetStoryReferenceBindings(test.view, bound.bindings);
    test.snapshot.referenceNodes![0].nodeId = 'wrong-node'; await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).rejects.toThrow('引用节点已变化');
  });
  it('支持@但菜单无法对应文件时阻断，不降级为文本或漏素材', async (): Promise<void> => {
    const test = fixture(); test.snapshot.referenceOptions = [];
    await expect(fast((): ReturnType<typeof bindPetStoryReferences> => bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal))).rejects.toThrow('菜单与实际文件');
    expect(test.actions).toEqual([]);
  });
  it('不能以同名但错绑节点冒充实际素材', async (): Promise<void> => {
    const test = fixture(); test.breakNode();
    await expect(fast((): ReturnType<typeof bindPetStoryReferences> => bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal))).rejects.toThrow('节点与本次文件');
  });
  it('不支持@的入口自动使用真实文件中文映射；上传预览变化后仍阻断', async (): Promise<void> => {
    const test = fixture(false);
    const bound = await fast((): ReturnType<typeof bindPetStoryReferences> => bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal));
    expect(bound.compiled.text.startsWith('第 2 张图提供人物身份')).toBe(true); expect(test.actions).toEqual([]);
    test.snapshot.previews![1].key = 'different-file'; await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).rejects.toThrow('素材丢失');
  });
  it('漏图及专用槽丢失不能通过提交前核对', async (): Promise<void> => {
    const test = fixture(false); const binding: PetStoryPageBinding = { assetId: 'file-a', order: 1, slot: 'last_frame', previewHash: '0'.repeat(64), label: '第 1 张图', reference: 'slot' };
    await expect(verifyPetStoryReferenceBindings(test.view, [binding])).rejects.toThrow('素材丢失');
  });
  it('结构化引用的每次出现都创建节点，普通数字不全局替换；少一个节点即阻断', async (): Promise<void> => {
    const test = fixture();
    test.compiled.segments = [{ referenceOrder: 1 }, { text: '提供身份；在' }, { referenceOrder: 1 }, { text: '的基础上构图。\n墙上保留第 2 张画。\n' }, { referenceOrder: 2 }, { text: '提供场景。' }];
    test.compiled.text = '第 1 张图提供身份；在第 1 张图的基础上构图。\n墙上保留第 2 张画。\n第 2 张图提供场景。';
    const bound = await bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal);
    expect(test.actions).toEqual(['select:@图片1', 'select:@图片1', 'select:@图片2']);
    expect(bound.bindings[0].occurrenceCount).toBe(2); expect(bound.bindings[0].targetId).toBe('asset-a');
    expect(bound.compiled.text).toContain('墙上保留第 2 张画。');
    test.snapshot.referenceNodes!.splice(0, 1);
    await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).rejects.toThrow('引用节点已变化');
  });
  it('未在正文引用的附件只核对真实上传，不补写引用节点；该附件丢失仍阻断', async (): Promise<void> => {
    const test = fixture();
    test.compiled.final = '@图片1中的人物坐着。';
    test.compiled.text = test.compiled.final;
    test.compiled.segments = [{ referenceOrder: 1, sourceText: '@图片1' }, { text: '中的人物坐着。' }];
    const bound = await bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal);
    expect(bound.compiled.text).toBe(test.compiled.final); expect(test.actions).toEqual(['select:@图片1']);
    expect(bound.bindings[1].occurrenceCount).toBe(0); expect(bound.bindings[1].nodeIds).toEqual([]); expect(bound.bindings[1].nodeId).toBeUndefined();
    await verifyPetStoryReferenceBindings(test.view, bound.bindings);
    test.snapshot.previews = test.snapshot.previews!.filter((preview): boolean => preview.key !== 'key-b');
    await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).rejects.toThrow('素材丢失');
  });
  it('同名菜单的文件目标不同不能按标签猜测；错槽回执在修改编辑器前阻断', async (): Promise<void> => {
    const test = fixture(); test.snapshot.referenceOptions![0].nodeId = 'foreign'; test.snapshot.referenceOptions![0].key = 'foreign';
    await expect(bindPetStoryReferences(test.view, test.compiled, test.receipts, new AbortController().signal)).rejects.toThrow('菜单与实际文件');
    const wrongSlot = fixture(); wrongSlot.receipts[0].slot = 'first_frame';
    await expect(bindPetStoryReferences(wrongSlot.view, wrongSlot.compiled, wrongSlot.receipts, new AbortController().signal)).rejects.toThrow('次序／槽位');
    expect(wrongSlot.actions).toEqual([]);
  });
});
