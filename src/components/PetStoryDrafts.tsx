import { registerPetStoryDraft, unregisterPetStoryDraft } from '../utils/petstoryDraftPresence';
import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';

export interface PetStoryDraftActions { save: () => Promise<void>; discard: () => void; locate: () => void }
export interface PetStoryDraft { id: string; label: string; actions: React.MutableRefObject<PetStoryDraftActions> }
interface DraftRegistry { register: (draft: PetStoryDraft) => void; unregister: (id: string) => void }
export const PetStoryDraftContext = createContext<DraftRegistry | null>(null);
/** 草稿只登记位置和原子保存动作，不复制项目快照；切页不丢字段。 */
export function usePetStoryDraft(id: string, label: string, dirty: boolean, actions: PetStoryDraftActions): void {
  const registry = useContext(PetStoryDraftContext);
  const current = useRef(actions); current.current = actions;
  useEffect(() => {
    if (!dirty) return;
    registerPetStoryDraft(id, label);
    registry?.register({ id, label, actions: current });
    return (): void => { unregisterPetStoryDraft(id); registry?.unregister(id); };
  }, [registry, id, label, dirty]);
}
export function usePetStoryDraftRegistry(): { value: DraftRegistry; drafts: PetStoryDraft[] } {
  const [drafts, setDrafts] = React.useState<PetStoryDraft[]>([]);
  const value = useMemo<DraftRegistry>(() => ({
    register: (draft: PetStoryDraft): void => setDrafts((old): PetStoryDraft[] => [...old.filter((item): boolean => item.id !== draft.id), draft]),
    unregister: (id: string): void => setDrafts((old): PetStoryDraft[] => old.filter((item): boolean => item.id !== id)),
  }), []);
  return { value, drafts };
}
export function locatePetStoryDraft(stage: string, id: string): void {
  window.dispatchEvent(new CustomEvent('petstory-locate-draft', { detail: { stage, id } }));
  requestAnimationFrame((): void => { const field = document.getElementById(id); field?.scrollIntoView({ block: 'center', behavior: 'smooth' }); field?.focus(); });
}
