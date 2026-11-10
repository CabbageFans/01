import { DoubaoVideoAdapter } from './DoubaoVideoAdapter';
import type { AdapterSelfCheckReport } from '../types';
import type { WebviewHandle } from '../utils/doubaoBridge';
import { DOUBAO_CAPABILITY_ADAPTER_VERSION } from './doubaoCapability';

export const DOUBAO_ADAPTER_VERSION = DOUBAO_CAPABILITY_ADAPTER_VERSION;

/** 规则包曾只影响自检而不影响生产。现在自检直接消费正式适配器，不接受旁路选择器。 */
export async function runAdapterSelfCheck(webview: WebviewHandle): Promise<AdapterSelfCheckReport> {
  const { composer, submit, nativeInputAvailable } = await new DoubaoVideoAdapter(webview).readComposer();
  const items: AdapterSelfCheckReport['items'] = [
    { key: 'page', label: '豆包页面', ok: /^https:\/\/(?:www\.)?doubao\.com\//.test(webview.getURL()), detail: '原账号页面' },
    { key: 'input', label: '视频输入区', ok: composer.present, detail: composer.present ? '正式输入区探针已定位' : '当前输入区不可确认' },
    { key: 'submit', label: '最终发送控件', ok: submit.ok, detail: submit.ok ? `正式提交探针：${submit.method}` : '未找到唯一合法发送控件' },
    { key: 'native_input', label: '可信控件点击', ok: nativeInputAvailable, detail: nativeInputAvailable ? '宿主提供原生输入能力；本次仅只读检查' : '宿主无原生输入能力，媒体不会派发' },
    { key: 'video_mode', label: '视频模式', ok: composer.selectedSkill === 'video', detail: composer.selectedSkill || '未确认' },
    { key: 'model', label: '模型回读', ok: !!composer.model, detail: composer.model || '尚未读取' },
    { key: 'duration', label: '时长回读', ok: composer.duration > 0, detail: `${composer.duration}秒` },
    { key: 'ratio', label: '比例回读', ok: !!composer.aspectRatio, detail: composer.aspectRatio || '尚未读取' },
    { key: 'upload', label: '素材上传区', ok: composer.generic || composer.first, detail: composer.pending ? '上传中' : `已读取${composer.count}项` },
    { key: 'verification', label: '人机验证', ok: !submit.humanVerification, detail: submit.humanVerification ? '需在原账号人工完成' : '提交探针未发现验证遮挡' },
    { key: 'final_submit', label: '只读自检', ok: true, detail: '未激活最终生成控件' },
  ];
  return { adapterVersion: DOUBAO_ADAPTER_VERSION, pageUrl: webview.getURL(), checkedAt: new Date().toISOString(),
    score: Math.round(items.filter((item): boolean => item.ok).length / items.length * 100), items };
}
