import { describe, expect, it } from 'vitest';
import type { PetStoryProject } from '@doubao-studio/contracts';
import { buildPetStoryDiagnostics } from '../../main/utils/petstoryDiagnostics';

it('原诊断投影串起project/step/run/asset，正文、路径、平台地址和凭据不导出', (): void => {
  const now = '2026-11-10T01:00:00.000Z'; const entry = { state: 'unknown' as const, reason: '' };
  const project: PetStoryProject = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 8, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: 'TEST_PRIVATE_STORY', importedAt: now }, jobs: [],
    production: { state: 'paused', phase: 'shots', planHash: 'a'.repeat(64), approvedAt: now, shots: {}, fallbacks: {}, capability: { accountId: 'TEST-account', image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      message: '本镜校验失败', steps: [{ id: 'TEST-step', taskId: 'TEST-task', runId: 'TEST-run', shotId: 'TEST-shot', kind: 'video', status: 'bound', attachmentAssetIds: ['TEST-image'], inputHash: 'b'.repeat(64),
        compiledPrompt: { kind: 'video', requestedMode: 'first_frame', final: 'TEST_PRIVATE_PROMPT', text: 'TEST_PRIVATE_PROMPT', rulesVersion: 'TEST', references: [] },
        failure: { stage: 'validation', code: 'tool_missing', message: "spawn /Users/TEST-private/bin/ffprobe ENOENT" },
        mediaFailure: { taskId: 'TEST-task', runId: 'TEST-run', artifactId: 'TEST-artifact', code: 'tool_missing', recordedAt: now,
          stderr: "input https://www.doubao.com/chat/TEST_PRIVATE_URL token=TEST_PRIVATE_TOKEN\n/Users/TEST-private/source/movie.mp4" } }] },
    assets: [{ id: 'TEST-asset', kind: 'video', relativePath: 'shots/TEST-shot/TEST-private-file.mp4', shotId: 'TEST-shot', taskId: 'TEST-task', runId: 'TEST-run', artifactId: 'TEST-artifact', downloadJobId: 'TEST-download',
      generationPrompt: 'TEST_PRIVATE_PROMPT', validation: { decoded: true, sha256: 'c'.repeat(64), bytes: 100, width: 64, height: 96, durationSeconds: 5, checkedAt: now } }] };
  const output = buildPetStoryDiagnostics(project); const json = JSON.stringify(output);
  for (const value of ['TEST_PRIVATE_STORY', 'TEST_PRIVATE_PROMPT', '/Users/', 'TEST_PRIVATE_URL', 'TEST_PRIVATE_TOKEN', 'TEST-private-file']) expect(json).not.toContain(value);
  for (const value of ['TEST-project', 'TEST-step', 'TEST-task', 'TEST-run', 'TEST-artifact', 'TEST-download', 'tool_missing']) expect(json).toContain(value);
});

describe('多项目诊断不改变当前打开项目', (): void => {
  it('投影不修改传入项目对象', (): void => {
    const project: PetStoryProject = { schemaVersion: 1, id: 'TEST-readonly', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'script', url: '', status: 'pending' }, assets: [], jobs: [] };
    const before = structuredClone(project); buildPetStoryDiagnostics(project); expect(project).toEqual(before);
  });
});
