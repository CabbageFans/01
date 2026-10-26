import type { PetStoryCompiledPrompt, PetStoryPageBinding } from '@doubao-studio/contracts';

export function renderReferenceSegments(segments: NonNullable<PetStoryCompiledPrompt['segments']>, bindings?: PetStoryPageBinding[]): string {
  return segments.map((segment): string => {
    if ('text' in segment) return segment.text;
    if (!bindings) {
      // 保留 Chat 已写出的语法；只有素材顺序变化时替换该引用的编号。
      if (segment.sourceText) return segment.sourceText.replace(/\d+/, String(segment.referenceOrder));
      return `第 ${segment.referenceOrder} 张图`;
    }
    const binding = bindings[segment.referenceOrder - 1];
    if (!binding) throw new Error('结构化引用缺少实际页面绑定');
    return binding.reference === 'slot' ? binding.slot === 'first_frame' ? '首帧画面' : '尾帧画面' : binding.label;
  }).join('');
}

/** 只解析本次编译中的编号；final 原文不被改写。网页重排后编号跟随实际素材。 */
export function bindReferenceText(compiled: PetStoryCompiledPrompt, bindings: PetStoryPageBinding[]): PetStoryCompiledPrompt {
  if (bindings.length !== compiled.references.length || bindings.some((b, i): boolean => b.assetId !== compiled.references[i].assetId || b.order !== i + 1)) throw new Error('实际页面素材与编译引用不符');
  if (compiled.segments) return { ...compiled, text: renderReferenceSegments(compiled.segments, bindings) };
  const text = compiled.text.replace(/第\s*(\d+)\s*张(?:参考)?图|@图片\s*(\d+)/g, (_all: string, chineseOrder: string | undefined, mentionOrder: string | undefined): string => {
    const binding = bindings[Number(chineseOrder || mentionOrder) - 1];
    if (!binding) throw new Error('图片编号缺少实际绑定');
    return binding.reference === 'slot' ? binding.slot === 'first_frame' ? '首帧画面' : '尾帧画面' : binding.label;
  });
  return { ...compiled, text };
}
