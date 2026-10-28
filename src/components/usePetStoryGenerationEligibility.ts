import { useEffect, useState } from 'react';
import type { PetStoryGenerationEligibilityResult, PetStoryProject, PetStoryRuntimeTarget } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';

export type PetStoryGenerationEligibility = NonNullable<PetStoryGenerationEligibilityResult['eligibility']>;
export type PetStoryGenerationBlocker = PetStoryGenerationEligibility['blockers'][number];

/** 只读查询复用主进程实际生成核验；页面不复制正文或工作流资格判断。 */
export function usePetStoryGenerationEligibility(project: PetStoryProject, target: PetStoryRuntimeTarget): { eligibility?: PetStoryGenerationEligibility; loading: boolean; error: string; refresh: () => void } {
  const capability = usePetStoryStore((state) => state.capabilityCheckedInSession ? state.capability : null);
  const fallbacks = usePetStoryStore((state) => state.fallbacks);
  const [eligibility, setEligibility] = useState<PetStoryGenerationEligibility>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const { materialId, shotId, promptKind } = target;
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setEligibility(undefined);
    void window.electronAPI.petstory.inspectGeneration(project.id, project.revision, { materialId, shotId, promptKind }, capability || undefined, fallbacks).then((result): void => {
      if (!active) return;
      setEligibility(result.eligibility); setError(result.success ? '' : result.error || '暂时无法核对制作条件，请重新检查');
    }).catch((): void => { if (active) setError('制作条件读取失败，请重新检查'); }).finally((): void => { if (active) setLoading(false); });
    return (): void => { active = false; };
  }, [project.id, project.revision, materialId, shotId, promptKind, capability, fallbacks, refreshKey]);
  return { eligibility, loading, error, refresh: (): void => setRefreshKey((value): number => value + 1) };
}
