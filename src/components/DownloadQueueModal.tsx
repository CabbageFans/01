import React from 'react';
import { Button, Empty, List, Modal, Space, Tag } from 'antd';
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import type { DownloadJob } from '../types';

interface DownloadQueueModalProps {
  open: boolean;
  embedded?: boolean;
  scopeLabel?: string;
  jobs: DownloadJob[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onRetry: (job: DownloadJob) => Promise<void>;
}

const STATUS_LABELS: Record<DownloadJob['status'], { label: string; color: string }> = {
  queued: { label: '等待下载', color: 'blue' },
  downloading: { label: '下载中', color: 'processing' },
  done: { label: '下载完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
};

export const DownloadQueueModal: React.FC<DownloadQueueModalProps> = ({
  open,
  embedded = false,
  scopeLabel = '全部项目',
  jobs,
  loading,
  onClose,
  onRefresh,
  onRetry,
}) => (
  <DownloadSurface
    embedded={embedded}
    scopeLabel={scopeLabel}
    title="下载记录"
    open={open}
    onCancel={onClose}
    width={760}
    footer={(
      <Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新</Button>
        {!embedded && <Button onClick={onClose}>关闭</Button>}
      </Space>
    )}
    styles={{ body: { maxHeight: '62vh', overflowY: 'auto' } }}
  >
    {jobs.length === 0 ? <Empty description="暂无下载记录" /> : (
      <List
        dataSource={[...jobs].reverse()}
        renderItem={(job) => {
          const status = STATUS_LABELS[job.status];
          return (
            <List.Item
              actions={job.status === 'failed' ? [
                <Button key="retry" size="small" aria-label="重新下载" icon={<ReloadOutlined />} onClick={() => onRetry(job)}>
                  重新下载
                </Button>,
              ] : undefined}
            >
              <List.Item.Meta
                title={(
                  <Space size={8}>
                    <Tag color={status.color}>{job.status === 'downloading' && <SyncOutlined spin />} {status.label}</Tag>
                    <span>{job.mode === 'video' ? '视频' : job.mode === 'image' ? '图片' : '文件'}</span>

                  </Space>
                )}
                description={(
                  <div style={{ minWidth: 0 }}>
                    <div>{job.filePath?.split(/[/\\]/).pop() || '文件尚未保存'}</div>
                    <div className="muted-text" style={{ marginTop: 4 }}>{job.status === 'failed' ? '下载未完成，可以重新下载原产物。' : job.bytes ? `${(job.bytes / 1024 / 1024).toFixed(1)} MB` : `已尝试 ${job.attempts} 次`}</div>
                    <details className="download-file-details"><summary>诊断详情</summary><dl><dt>任务</dt><dd>{job.taskId}</dd><dt>文件位置</dt><dd>{job.filePath || '尚未保存'}</dd><dt>来源</dt><dd>{job.url}</dd>{job.error && <><dt>失败原因</dt><dd>{job.error}</dd></>}</dl></details>
                  </div>
                )}
              />
            </List.Item>
          );
        }}
      />
    )}
  </DownloadSurface>
);

const DownloadSurface: React.FC<React.ComponentProps<typeof Modal> & { embedded: boolean; scopeLabel: string }> = ({ embedded, scopeLabel, children, footer, ...props }): React.ReactElement => embedded ? <div className="embedded-downloads"><div className="download-tools">{typeof footer === 'function' ? null : footer}<span className="muted-text">{scopeLabel}下载记录 · 下载完成后仍需检查文件</span></div>{children}</div> : <Modal {...props} footer={footer}>{children}</Modal>;
