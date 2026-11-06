import { describe, expect, it } from 'vitest';
import { InitializationGate } from '../../src/utils/initializationGate';

describe('图片准备和其他账号输入的短暂独占租约', (): void => {
  it('其他任务提高初始化并发数也不能抢占图片的上传/发送焦点', async (): Promise<void> => {
    const gate = new InitializationGate(); const image = await gate.acquire('TEST-image', { limit: 1, exclusive: true });
    let otherStarted = false;
    const waiting = gate.acquire('TEST-other-account', { limit: 3 }).then((lease) => { otherStarted = true; return lease; });
    await Promise.resolve(); expect(otherStarted).toBe(false);
    image.release(); const other = await waiting; expect(otherStarted).toBe(true); other.release();
  });

  it('图片等待已有输入完成，后来的普通请求不能越过图片队列', async (): Promise<void> => {
    const gate = new InitializationGate(); const first = await gate.acquire('TEST-first', { limit: 3 });
    const entered: string[] = [];
    const imageWaiting = gate.acquire('TEST-image', { limit: 1, exclusive: true }).then((lease) => { entered.push('image'); return lease; });
    const otherWaiting = gate.acquire('TEST-other', { limit: 3 }).then((lease) => { entered.push('other'); return lease; });
    await Promise.resolve(); expect(entered).toEqual([]);
    first.release(); const image = await imageWaiting; expect(entered).toEqual(['image']);
    image.release(); const other = await otherWaiting; expect(entered).toEqual(['image', 'other']); other.release();
  });

  it('取消尚未获得焦点的图片不会阻塞其他任务，也不释放正在使用的焦点', async (): Promise<void> => {
    const gate = new InitializationGate(); const first = await gate.acquire('TEST-first', { limit: 3 }); const abort = new AbortController();
    const cancelled = gate.acquire('TEST-image', { exclusive: true, signal: abort.signal });
    const rejection = expect(cancelled).rejects.toThrow('Aborted');
    let otherStarted = false;
    const waiting = gate.acquire('TEST-other', { limit: 3 }).then((lease) => { otherStarted = true; return lease; });
    await Promise.resolve(); expect(otherStarted).toBe(false); abort.abort(); await rejection;
    const other = await waiting; expect(otherStarted).toBe(true); first.release(); other.release();
  });
});
