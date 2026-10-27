/** 离线配置与真实 JSON 保存机制回归；不生成创作正文或伪造豆包来源。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PetStoryPromptProfile } from '@doubao-studio/contracts';
import { PetStoryProjects, validatePromptProfile } from '../../main/utils/petstoryProject';
import { defaultPromptProfile } from '../../main/utils/petstoryPromptQuality';
import fixture from '../fixtures/drama-runtime-input.json';

let directory: string;
beforeEach(async (): Promise<void> => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'petstory-cast-profile-')); });
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

describe('动态演员来源别名与主配角配置', (): void => {
  it('正式保存与重新打开原样保留当前演员事实、顺序与空外观，不改旧稿或猜映射', async (): Promise<void> => {
    const projects = new PetStoryProjects(); const project = await projects.create(directory, 'TEST-studio', 'TEST-account');
    const profile: PetStoryPromptProfile = { style: '', characters: Object.fromEntries(fixture.plan.characters.map((character): [string, PetStoryPromptProfile['characters'][string]] => [character.id,
      { identity: character.description, appearance: '', aliases: ['TEST-source-' + character.id], role: character.role as 'main' | 'supporting' }])) };
    // 任意动态配角保留原字符串；不靠 ID 名字推断来源称谓或主配角。
    profile.characters.dynamic_guest = { identity: fixture.plan.characters[2].description, appearance: '', aliases: [' TEST已保存称谓 ', 'TEST另一个称谓'], role: 'supporting' };
    const before = structuredClone(profile); const saved = await projects.savePromptProfile(project.id, project.revision, profile);
    expect(saved.promptProfile).toEqual(before); expect(profile).toEqual(before); expect(saved.plan).toEqual(project.plan); expect(saved.jobs).toEqual(project.jobs);
    const filename = path.join(directory, 'project.json'); const disk = await fs.readFile(filename, 'utf8');
    expect((await new PetStoryProjects().open(directory)).promptProfile).toEqual(before); expect(await fs.readFile(filename, 'utf8')).toBe(disk);
  });
  it('旧配置缺可选事实和显式空演员清单均原样保存，打开不补预设或来源别名', async (): Promise<void> => {
    const projects = new PetStoryProjects(); let project = await projects.create(directory, 'TEST-studio', 'TEST-account');
    const profiles: PetStoryPromptProfile[] = [{ style: '', characters: { unknown_actor: { identity: fixture.plan.characters[0].description, appearance: '' } } }, { style: '', characters: {} }];
    for (const profile of profiles) {
      project = await projects.savePromptProfile(project.id, project.revision, profile);
      expect((await new PetStoryProjects().open(directory)).promptProfile).toEqual(profile);
      expect(validatePromptProfile(profile)).toEqual(profile);
    }
  });
  it('新项目默认两主演仅明确main，默认不制造来源A/B映射', async (): Promise<void> => {
    const profile = defaultPromptProfile(); expect(Object.values(profile.characters)).toHaveLength(2);
    for (const character of Object.values(profile.characters)) { expect(character.role).toBe('main'); expect(character).not.toHaveProperty('aliases'); }
    expect(validatePromptProfile(profile)).toEqual(profile);
    const project = await new PetStoryProjects().create(directory, 'TEST-studio', 'TEST-account'); expect(project.promptProfile).toEqual(profile);
  });
  it.each([null, 'A', [], [''], ['   '], ['A', 1], Array(1), Array(101).fill('A'), ['x'.repeat(201)]])('拒绝非法来源别名%j，不自动清洗为合法数据', (aliases: unknown): void => {
    expect((): unknown => validatePromptProfile({ style: '', characters: { actor: { identity: '', appearance: '', aliases } } })).toThrow('角色来源别名无效');
  });
  it.each([null, '', 'MAIN', 'lead', 1, true])('拒绝非法主配角%j', (role: unknown): void => {
    expect((): unknown => validatePromptProfile({ style: '', characters: { actor: { identity: '', appearance: '', role } } })).toThrow('角色主配角配置无效');
  });
  it('无效配置保存失败保留原项目文件与版本', async (): Promise<void> => {
    const projects = new PetStoryProjects(); const project = await projects.create(directory, 'TEST-studio', 'TEST-account');
    const filename = path.join(directory, 'project.json'); const before = await fs.readFile(filename, 'utf8');
    const profile: PetStoryPromptProfile = { style: '', characters: { actor: { identity: '', appearance: '', aliases: [' '] } } };
    await expect(projects.savePromptProfile(project.id, project.revision, profile)).rejects.toThrow('角色来源别名无效');
    expect(await fs.readFile(filename, 'utf8')).toBe(before); expect((await projects.read(project.id)).revision).toBe(project.revision);
  });
  it('同一来源别名绑定不同演员是配置歧义，拒绝保存而不猜测', (): void => {
    expect((): unknown => validatePromptProfile({ style: '', characters: { first: { identity: '', appearance: '', aliases: [' A '] }, second: { identity: '', appearance: '', aliases: ['a'] } } })).toThrow('配置存在歧义');
    expect(validatePromptProfile({ style: '', characters: { first: { identity: '', appearance: '', aliases: ['A', 'A'] } } }).characters.first.aliases).toEqual(['A', 'A']);
  });
});
