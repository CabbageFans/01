/** 验证构建适配资源来自规则源；不代表真实豆包内容或媒体效果通过。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import adapters from '../../main/resources/drama/studio-adapters.json';
import runtime from '../../main/resources/drama/runtime.json';

describe('短剧规则资源与源文件', (): void => {
  it.each([['seedream', adapters.sourceFiles[0]], ['seedance', adapters.sourceFiles[1]]] as const)('%s运行资源与当前规则正文逐字一致', async (kind: 'seedream' | 'seedance', filename: string): Promise<void> => {
    expect(adapters[kind]).toBe(await fs.readFile(path.join(process.cwd(), filename), 'utf8'));
  });
  it('各阶段保留固定上游来源与许可，并应用当前剧本／图片职责', (): void => {
    expect(runtime.license).toBe('MIT'); expect(runtime.licenseText).toContain(runtime.copyright);
    for (const stage of Object.values(runtime.stages)) {
      expect(stage.sources.length).toBeGreaterThan(0); expect(stage.rules).toContain('剧本决定角色和剧情');
      expect(stage.rules).toContain('当前采用图片决定角色视觉形象'); expect(stage.rules).not.toContain('沿用当前确认的动画形态和造型');
    }
    expect(runtime.stages.video.rules).toContain('触发'); expect(runtime.stages.video.rules).toContain('原台词全文');
    expect(runtime.stages.video.rules).toContain('全部模式正文均不重新定义人物外观');
  });
});
