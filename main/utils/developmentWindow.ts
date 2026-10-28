/** 显式开发参数请求的 Electron 内容区尺寸，由创建窗口的调用者应用。 */
export interface DevelopmentWindowSize {
  width: number;
  height: number;
}

const argumentName = '--dev-viewport-size';
const argumentPrefix = `${argumentName}=`;

/** 仅解析显式开发视口参数；不访问 Electron、环境变量、文件或业务状态。 */
export function parseDevelopmentWindowSize(argv: readonly string[], isPackaged: boolean): DevelopmentWindowSize | undefined {
  const argumentsFound = argv.filter((argument: string): boolean => argument === argumentName || argument.startsWith(argumentPrefix));
  if (!argumentsFound.length) return undefined;
  if (isPackaged) throw new Error('开发视口尺寸参数仅允许在未打包的开发模式使用');
  if (argumentsFound.length !== 1) throw new Error('开发视口尺寸参数不能重复指定');
  const match = argumentsFound[0].slice(argumentPrefix.length).match(/^([0-9]+)x([0-9]+)$/);
  if (!argumentsFound[0].startsWith(argumentPrefix) || !match) throw new Error('开发视口尺寸格式必须为 --dev-viewport-size=宽x高，宽高必须是整数');
  const width = Number(match[1]); const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1024 || width > 3840 || height < 720 || height > 2160) {
    throw new Error('开发视口尺寸超出范围：宽度须为 1024～3840，高度须为 720～2160');
  }
  return { width, height };
}
