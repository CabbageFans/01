/** 仅补齐离线模拟回复的新时间合同，不改剧本、台词或已有（包括故意错误的）字段。 */
export function withOfflineTimingPlan<T extends object>(value: T, originalText: string): T {
  const result = structuredClone(value) as T & { shots?: Record<string, unknown>[] };
  const occurrences = new Map<string, number>();
  for (const shot of result.shots || []) {
    const dialogue = Array.isArray(shot.dialogue) ? shot.dialogue as Record<string, unknown>[] : [];
    for (const line of dialogue) {
      if (typeof line.text !== 'string') continue;
      const occurrence = (occurrences.get(line.text) || 0) + 1; occurrences.set(line.text, occurrence);
      if (line.source === undefined && originalText.includes(line.text)) line.source = { text: line.text, occurrence, start: 0, end: Array.from(line.text).length };
    }
    if (shot.timingPlan !== undefined) continue;
    const duration = typeof shot.durationSeconds === 'number' && Number.isFinite(shot.durationSeconds) && shot.durationSeconds > 0 ? shot.durationSeconds : 5;
    const endSeconds = Math.max(0.1, duration - 0.25);
    shot.timingPlan = { events: [{ id: 'TEST-action', kind: 'action', description: 'TEST离线原动作结构占位，不是实际节奏结论', startSeconds: 0, endSeconds },
      ...dialogue.map((_: unknown, dialogueIndex: number): object => ({ id: `TEST-speech-${dialogueIndex}`, kind: 'dialogue', description: 'TEST离线原台词引用结构', startSeconds: 0, endSeconds, dialogueIndex }))],
    estimatedRequiredSeconds: endSeconds, durationReason: 'TEST仅验证合同字段贯通，不代表发声或动作估时', cutReason: 'TEST原分镜结果边界' };
  }
  return result;
}
