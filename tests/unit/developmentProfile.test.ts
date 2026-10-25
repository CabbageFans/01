import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureDevelopmentProfile } from '../../main/utils/developmentProfile';

describe('isolated development profiles', (): void => {
  let root: string;
  let application: Pick<App, 'isPackaged' | 'getPath' | 'setPath'>;

  beforeEach((): void => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-profile-unit-')));
    for (const name of ['appData', 'temp']) fs.mkdirSync(path.join(root, name));
    application = {
      isPackaged: false,
      getPath: vi.fn((name: string): string => path.join(root, name)),
      setPath: vi.fn(),
    };
  });

  afterEach((): void => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves the existing Windows/default profile untouched without an explicit flag', (): void => {
    expect(configureDevelopmentProfile(application, [])).toBeNull();
    expect(application.getPath).not.toHaveBeenCalled();
    expect(application.setPath).not.toHaveBeenCalled();
  });

  it('reuses the controlled mac-dev directory and redirects both data paths', (): void => {
    const first = configureDevelopmentProfile(application, ['--profile=mac-dev']);
    expect(configureDevelopmentProfile(application, ['--profile=mac-dev'])).toEqual(first);
    expect(first?.userData).toBe(path.join(root, 'appData', 'DoubaoStudioDevelopment', 'mac-dev'));
    expect(application.setPath).toHaveBeenCalledWith('userData', first?.userData);
    expect(application.setPath).toHaveBeenCalledWith('sessionData', first?.userData);
  });

  it('creates a separate fresh temporary directory for each automated launch', (): void => {
    const first = configureDevelopmentProfile(application, ['--profile=mac-test']);
    const second = configureDevelopmentProfile(application, ['--profile=mac-test']);
    expect(first?.temporary).toBe(true);
    expect(first?.userData).not.toBe(second?.userData);
    expect(path.dirname(first!.userData)).toBe(path.join(root, 'temp'));
  });

  it.each(['other', '../../Chrome', '/tmp/arbitrary'])(
    'rejects arbitrary names or paths: %s',
    (name: string): void => {
      expect((): unknown => configureDevelopmentProfile(application, [`--profile=${name}`])).toThrow();
      expect(application.setPath).not.toHaveBeenCalled();
    },
  );

  it('rejects packaged use, duplicate flags and user-data overrides', (): void => {
    expect((): unknown => configureDevelopmentProfile({ ...application, isPackaged: true }, ['--profile=mac-dev'])).toThrow();
    expect((): unknown => configureDevelopmentProfile(application, ['--profile=mac-dev', '--profile=mac-test'])).toThrow();
    expect((): unknown => configureDevelopmentProfile(application, ['--profile=mac-dev', '--user-data-dir=/tmp/other'])).toThrow();
    expect(application.setPath).not.toHaveBeenCalled();
  });

  it('refuses a root symlink before creating files in the target', (): void => {
    const external = path.join(root, 'other-app');
    fs.mkdirSync(external);
    // Windows CI 使用无需额外符号链接权限的 junction，Mac 使用目录符号链接。
    fs.symlinkSync(external, path.join(root, 'appData', 'DoubaoStudioDevelopment'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((): unknown => configureDevelopmentProfile(application, ['--profile=mac-dev'])).toThrow('符号链接');
    expect(fs.readdirSync(external)).toEqual([]);
    expect(application.setPath).not.toHaveBeenCalled();
  });
});
