import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from 'antd';

interface DownloadedVideoPreviewProps { jobId: string; label?: string }
/** 只接收台账jobId，所有入口共用受控文件读取；失败重读不会下载或重新生成。 */
export const DownloadedVideoPreview: React.FC<DownloadedVideoPreviewProps> = ({ jobId, label = '本地视频' }): React.ReactElement => {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const invalidate = useCallback((): void => { request.current++; }, []);
  const read = useCallback(async (): Promise<void> => {
    const current = ++request.current; setLoading(true); setError('');
    try {
      const result = await window.electronAPI.tasks.readDownloadedMedia(jobId);
      if (current !== request.current) return;
      if (!result.success || !result.data || !/^doubao-media:\/\/asset\/[a-f0-9]{64}$/.test(result.data)) throw new Error(result.error || '本地视频读取失败，请重新读取');
      setSource(result.data);
    } catch (failure: unknown) {
      if (current === request.current) setError(failure instanceof Error ? failure.message : '本地视频读取失败，请重新读取');
    } finally { if (current === request.current) setLoading(false); }
  }, [jobId]);
  useEffect((): (() => void) => { setSource(undefined); void read(); return invalidate; }, [read, invalidate]);
  return <div>
    {source && <video aria-label={`${label}播放器`} src={source} controls preload="metadata" onError={(): void => setError('视频文件读取或解码失败，原文件仍保留；可以重新读取。')} style={{ width: '100%', maxHeight: '65vh', display: 'block', background: '#000' }} />}
    {loading && <p role="status">正在读取本地视频…</p>}
    {error && <p role="alert">{error}</p>}
    <Button size="small" aria-label="重新读取" loading={loading} onClick={(): void => { void read(); }}>重新读取</Button>
  </div>;
};
