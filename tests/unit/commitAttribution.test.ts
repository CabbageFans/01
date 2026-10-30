import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-commit-attribution.mjs');
let directory: string;
let environment: NodeJS.ProcessEnv;

function git(args: string[], overrides: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync('git', args, { cwd: directory, env: { ...environment, ...overrides }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function check(args: string[], overrides: NodeJS.ProcessEnv = {}): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, env: { ...environment, ...overrides }, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

function commit(message: string, overrides: NodeJS.ProcessEnv = {}): void {
  git(['commit', '--allow-empty', '-q', '-m', message], overrides);
}

beforeEach((): void => {
  directory = mkdtempSync(path.join(tmpdir(), 'commit-attribution-'));
  environment = { ...process.env, GIT_AUTHOR_NAME: 'Actual contributor', GIT_AUTHOR_EMAIL: 'actual@example.test',
    GIT_COMMITTER_NAME: 'Actual contributor', GIT_COMMITTER_EMAIL: 'actual@example.test' };
  git(['init', '-q']);
  git(['config', 'core.hooksPath', path.join(directory, 'no-hooks')]);
  commit('Initial');
});

afterEach((): void => { rmSync(directory, { recursive: true, force: true }); });

describe('提交署名门禁', (): void => {
  it('允许实际贡献者和旧上游来源文字，不修改提交', (): void => {
    commit('Merge pull request from dorakoo/old-branch\n\nSource: https://github.com/dorakoo/doubao-studio', {
      GIT_AUTHOR_NAME: 'Upstream contributors', GIT_AUTHOR_EMAIL: 'upstream@contributors.invalid',
    });
    const before = git(['rev-parse', 'HEAD']);
    expect(check(['--identity', '--history', 'HEAD']).status).toBe(0);
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
  });

  it.each([
    { GIT_AUTHOR_NAME: 'DoRaKoO' },
    { GIT_AUTHOR_EMAIL: '123+dorakoo@users.noreply.github.com' },
    { GIT_COMMITTER_NAME: 'dorakoo' },
    { GIT_COMMITTER_EMAIL: 'DORAKOO@example.test' },
    { GIT_AUTHOR_NAME: 'ｄｏｒａｋｏｏ' },
  ])('拒绝当前身份与历史中的禁止署名：%o', (overrides: NodeJS.ProcessEnv): void => {
    expect(check(['--identity'], overrides).status).toBe(1);
    commit('Forbidden attribution', overrides);
    commit('Clean tip');
    expect(check(['--history', 'HEAD']).status).toBe(1);
  });

  it('拒绝共同作者字段，允许来源说明及合法共同作者', (): void => {
    const messagePath = path.join(directory, 'message.txt');
    writeFileSync(messagePath, 'Fix\n\nCo-authored-by: Actual Person <person@example.test>\nSource: dorakoo');
    expect(check(['--message-file', messagePath]).status).toBe(0);
    writeFileSync(messagePath, 'Fix\n\nco-AUTHORED-by: Other Name <42+DORAKOO@users.noreply.github.com>');
    expect(check(['--message-file', messagePath]).status).toBe(1);
    commit(readFileSync(messagePath, 'utf8'));
    expect(check(['--history', 'HEAD']).status).toBe(1);
  });

  it('不让 mailmap 掩盖原始作者', (): void => {
    commit('Forbidden author', { GIT_AUTHOR_NAME: 'dorakoo', GIT_AUTHOR_EMAIL: 'alias@example.test' });
    writeFileSync(path.join(directory, '.mailmap'), 'Safe Name <safe@example.test> dorakoo <alias@example.test>\n');
    git(['config', 'log.mailmap', 'true']);
    expect(check(['--history', 'HEAD']).status).toBe(1);
  });

  it('无效引用或缺少参数时失败，不误报通过', (): void => {
    expect(check(['--history', 'missing-ref']).status).toBe(1);
    expect(check([]).status).toBe(1);
  });
});
