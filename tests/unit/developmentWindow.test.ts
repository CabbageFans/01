import { describe, expect, it } from 'vitest';
import { parseDevelopmentWindowSize } from '../../main/utils/developmentWindow';
import type { DevelopmentWindowSize } from '../../main/utils/developmentWindow';

describe('显式开发视口尺寸参数', (): void => {
  it.each([false, true])('未指定参数时保持现有默认尺寸，打包状态为 %s', (isPackaged: boolean): void => {
    expect(parseDevelopmentWindowSize([], isPackaged)).toBeUndefined();
    expect(parseDevelopmentWindowSize(['electron', '.', '--local-control', '--unrelated=1440x900'], isPackaged)).toBeUndefined();
  });

  it.each([
    [1280, 800], [1440, 900], [1366, 768], [1920, 1080], [1024, 720], [3840, 2160],
  ])('接受合理范围内的内容区 %i×%i，不限定为验收中的两个尺寸', (width: number, height: number): void => {
    const argv: readonly string[] = ['electron', '.', `--dev-viewport-size=${width}x${height}`, '--other'];
    const before = [...argv]; const result: DevelopmentWindowSize | undefined = parseDevelopmentWindowSize(argv, false);
    expect(result).toEqual({ width, height }); expect(argv).toEqual(before);
  });

  it('打包应用拒绝开发参数，不因值看似合理而启用', (): void => {
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize(['--dev-viewport-size=1280x800'], true)).toThrow(/未打包/);
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize(['--dev-viewport-size=invalid'], true)).toThrow(/未打包/);
  });

  it.each([
    ['--dev-viewport-size=1280x800', '--dev-viewport-size=1440x900'],
    ['--dev-viewport-size=1280x800', '--dev-viewport-size=1280x800'],
    ['--dev-viewport-size', '--dev-viewport-size=1280x800'],
  ])('重复参数必须明确拒绝，不静默选第一项或最后一项：%j', (...argv: string[]): void => {
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize(argv, false)).toThrow(/重复/);
  });

  it.each([
    '--dev-viewport-size', '--dev-viewport-size=', '--dev-viewport-size=1280', '--dev-viewport-size=x800', '--dev-viewport-size=1280x',
    '--dev-viewport-size=1280x800x600', '--dev-viewport-size=1280X800', '--dev-viewport-size=1280×800',
    '--dev-viewport-size=1280.5x800', '--dev-viewport-size=1280x800.5', '--dev-viewport-size=1280x8e2',
    '--dev-viewport-size=-1280x800', '--dev-viewport-size=1280x-800', '--dev-viewport-size=NaNx800', '--dev-viewport-size=Infinityx800',
    '--dev-viewport-size= 1280x800', '--dev-viewport-size=1280x800 ', '--dev-viewport-size=1280 x 800',
  ])('格式非法或非整数时拒绝：%s', (argument: string): void => {
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize([argument], false)).toThrow(/格式必须/);
  });

  it('不接受分离值语法，避免意外忽略无效的显式参数', (): void => {
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize(['--dev-viewport-size', '1280x800'], false)).toThrow(/格式必须/);
  });

  it.each([
    '1023x800', '3841x800', '1280x719', '1280x2161', '0x800', '1280x0', '9999999999999999999999999999999x800',
  ])('超出内容区范围或安全整数范围时拒绝：%s', (size: string): void => {
    expect((): DevelopmentWindowSize | undefined => parseDevelopmentWindowSize([`--dev-viewport-size=${size}`], false)).toThrow(/超出范围/);
  });
});
