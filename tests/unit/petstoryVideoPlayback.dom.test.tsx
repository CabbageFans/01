/** 离线播放交互回归；媒体事件为替身，真实 Electron 解码与播放另行验收。 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasMediaNode, CanvasMediaPreview } from '../../src/components/PetStoryCanvasMedia';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const source = `doubao-media://asset/${'a'.repeat(64)}`;
let project: PetStoryProject;
let asset: PetStoryAsset;

beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, 1);
  asset = { id: 'TEST-saved-video', kind: 'video', shotId: plan.shots[0].id, relativePath: 'TEST.mp4',
    validation: { decoded: true, sha256: 'TEST', bytes: 20, width: 720, height: 1280, durationSeconds: 5.04, checkedAt: '2026-10-31T00:00:00.000Z' } };
  project = { schemaVersion: 1, id: 'TEST-playback-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [asset], jobs: [], updatedAt: '2026-10-31T00:00:00.000Z' };
  window.electronAPI = { petstory: {
    readMedia: vi.fn(async (): Promise<{ success: true; data: string; mimeType: string }> => ({ success: true, data: source, mimeType: 'video/mp4' })),
    inspectGeneration: vi.fn(async (): Promise<{ success: true; eligibility: { ready: true; blockers: [] } }> => ({ success: true, eligibility: { ready: true, blockers: [] } })),
  } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '' });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

async function loadedPlayer(node = false): Promise<HTMLVideoElement> {
  if (node) render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} />);
  else render(<CanvasMediaPreview project={project} asset={asset} name="TEST 视频" />);
  const player = await screen.findByLabelText(node ? '镜头 1 镜头视频' : 'TEST 视频') as HTMLVideoElement;
  expect(player.getAttribute('src')).toBe(source);
  return player;
}

describe('项目内视频播放', (): void => {
  it('真实入口 CSP 允许受控本地媒体协议，保留旧data兼容且不放开脚本或远程媒体', (): void => {
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
    expect(policy).toBeDefined();
    const directives = new Map(policy!.split(';').map((part): [string, string[]] => {
      const [name, ...sources] = part.trim().split(/\s+/); return [name, sources];
    }));
    expect(directives.get('media-src')).toEqual(["'self'", 'data:', 'doubao-media:']);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('script-src')).not.toContain('data:');
  });

  it('查看视频真正发起播放，且不重新生成或改变原素材', async (): Promise<void> => {
    const generate = vi.fn(); usePetStoryStore.setState({ generateShotMedia: generate });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const before = structuredClone(project.assets);
    const player = await loadedPlayer(true);
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看视频' }));
    await waitFor((): void => expect(play).toHaveBeenCalledOnce());
    expect(play.mock.instances[0]).toBe(player);
    expect(generate).not.toHaveBeenCalled(); expect(project.assets).toEqual(before);
  });

  it('手机改成 5 秒后保留可播放文件，明确真实 5.06 秒与原请求 7 秒，不拿当前计划替代原请求', async (): Promise<void> => {
    const now = project.updatedAt; project.plan!.shots[0].durationSeconds = 9;
    asset.taskId = 'TEST-original-video'; asset.runId = 'TEST-original-run'; asset.validation!.durationSeconds = 5.06;
    const videoConfig: NonNullable<Task['videoConfig']> = { model: 'seedance-2.0-fast', duration: '7s', aspectRatio: '9:16' };
    const task: Task = { id: asset.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, prompt: 'TEST 原视频正文', mode: 'video', videoConfig,
      status: 'done', outputs: ['https://TEST.invalid/original.mp4'], result: null, createdAt: now, updatedAt: now,
      runtime: { runId: asset.runId, attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        input: { prompt: 'TEST 原视频正文', mode: 'video', attachments: [], videoConfig } } };
    const before = structuredClone(task); const generate = vi.fn(); usePetStoryStore.setState({ generateShotMedia: generate });
    useTaskStore.setState({ tasks: [task] }); const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const player = await loadedPlayer(true);
    expect(screen.getByRole('note').textContent).toBe('实际5.06秒，原请求7秒，请复核。');
    fireEvent.click(screen.getByRole('button', { name: '查看视频' }));
    await waitFor((): void => expect(play).toHaveBeenCalledOnce());
    expect(player.getAttribute('src')).toBe(source); expect(generate).not.toHaveBeenCalled(); expect(task).toEqual(before);
    expect(project.plan!.shots[0].durationSeconds).toBe(9);
  });

  it.each([
    ['NotAllowedError', '播放未能开始，请点击视频播放器中的播放按钮。'],
    ['NotSupportedError', '当前播放器无法播放这段视频，原视频仍保留在项目中。'],
    ['AbortError', '视频播放已中止，请再次点击播放。'],
    ['Error', '视频播放失败，已生成的视频仍保留在项目中。'],
  ])('play 拒绝为 %s 时显示可读反馈并保留播放器', async (name: string, message: string): Promise<void> => {
    const failure = new Error('TEST 内部错误不应直接显示'); failure.name = name;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(failure);
    const player = await loadedPlayer(true);
    fireEvent.click(screen.getByRole('button', { name: '查看视频' }));
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toBe(message));
    expect(player.getAttribute('src')).toBe(source); expect(project.assets[0]).toBe(asset);
  });

  it.each([
    [1, '视频播放已中止，请再次点击播放。'],
    [2, '视频文件读取失败，已生成的视频仍保留在项目中。'],
    [3, '当前播放器无法解码这段视频，原视频仍保留在项目中。'],
    [4, '视频格式不受当前播放器支持，或视频加载被阻止。'],
    [undefined, '视频加载失败，已生成的视频仍保留在项目中。'],
  ])('浏览器媒体错误 %s 显示对应类别，恢复加载后消除错误', async (code: number | undefined, message: string): Promise<void> => {
    const player = await loadedPlayer();
    Object.defineProperty(player, 'error', { configurable: true, value: code === undefined ? null : { code } });
    fireEvent.error(player);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(screen.getByLabelText('TEST 视频')).toBe(player); expect(player.getAttribute('src')).toBe(source);
    fireEvent.loadedData(player); expect(screen.queryByRole('alert')).toBeNull();
  });
});
