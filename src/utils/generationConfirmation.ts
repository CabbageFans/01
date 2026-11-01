export interface GenerationConfirmationEvidence {
  state: 'present' | 'absent' | 'unknown';
  detectedAt: string;
  marker?: 'parameter_confirmation' | 'confirm_before_generation';
  model?: string;
  duration?: string;
  aspectRatio?: string;
}

export function classifyGenerationConfirmationText(text: string, detectedAt = new Date().toISOString()): GenerationConfirmationEvidence {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  const parameterMarker = /视频生成参数确认/.test(normalized);
  // 豆包也会要求回复“开始”；必须同时出现后续视频制作动作，普通“开始”文字不算确认请求。
  const startReplyMarker = /回复\s*[“"'‘「]?开始[”"'’」]?\s*(?:后|[，,：:])[^。！？!?]{0,24}(?:生成|制作)视频/.test(normalized);
  const confirmMarker = /确认后.{0,16}(?:开始|进行|为你)?生成视频/.test(normalized) || /回复[“"']?确认[”"']?.{0,16}生成/.test(normalized) || startReplyMarker;
  if (!parameterMarker && !confirmMarker) return { state: 'absent', detectedAt };
  const model = normalized.match(/Seedance\s*[0-9.]+(?:\s*Fast|\s*Mini)?/i)?.[0];
  const duration = normalized.match(/(?:时长|视频时长)[:：]?\s*(\d{1,2}\s*s|\d{1,2}\s*秒)/i)?.[1]?.replace(/\s+/g, '');
  const aspectRatio = normalized.match(/(?:比例|画面比例)[:：]?\s*(\d{1,2}:\d{1,2})/)?.[1];
  return {
    state: 'present',
    detectedAt,
    marker: parameterMarker ? 'parameter_confirmation' : 'confirm_before_generation',
    model,
    duration,
    aspectRatio,
  };
}

export function isGenerationConfirmationTask(task: {
  status?: string;
  errorInfo?: { code?: string };
} | undefined): boolean {
  return task?.status === 'waiting_generation_confirmation' || task?.errorInfo?.code === 'generation_confirmation_required';
}
