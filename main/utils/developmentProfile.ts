import type { App } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface DevelopmentProfile {
  name: 'mac-dev' | 'mac-test';
  userData: string;
  temporary: boolean;
}

/** 必须在单实例锁、app ready、任何 Session 与数据读写之前调用。 */
export function configureDevelopmentProfile(
  application: Pick<App, 'isPackaged' | 'getPath' | 'setPath'>,
  argv: readonly string[],
): DevelopmentProfile | null {
  const args = argv.filter((arg: string): boolean => arg.startsWith('--profile='));
  if (args.length === 0) return null;
  const name = args[0].slice('--profile='.length);
  // 不接受用户输入路径或任意 profile，避免误读真实工作区及其他应用资料。
  if (application.isPackaged || args.length !== 1 || (name !== 'mac-dev' && name !== 'mac-test')) {
    throw new Error('开发 profile 仅允许未打包程序显式选择 mac-dev 或 mac-test');
  }
  if (argv.some((arg: string): boolean => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))) {
    throw new Error('开发 profile 不允许覆盖 user-data-dir');
  }
  const temporary = name === 'mac-test';
  const root = path.join(application.getPath('appData'), 'DoubaoStudioDevelopment');
  if (!temporary) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(root) !== path.resolve(root)) {
      throw new Error('开发 profile 根目录不得通过符号链接指向其他位置');
    }
  }
  const userData = temporary
    ? fs.mkdtempSync(path.join(application.getPath('temp'), 'doubao-studio-mac-test-'))
    : path.join(root, name);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  // 新 profile 不接受符号链接到其他应用目录；不运行历史缓存迁移。
  if (fs.realpathSync(userData) !== path.resolve(userData)) {
    // macOS 的 /var -> /private/var 是系统路径别名，临时目录由 mkdtemp 独占创建。
    if (!temporary) throw new Error('开发 profile 目录不得通过符号链接指向其他位置');
  }
  application.setPath('userData', userData);
  application.setPath('sessionData', userData);
  return { name, userData, temporary };
}
