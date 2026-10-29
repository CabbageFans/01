const drafts = new Map<string, string>();
export function registerPetStoryDraft(id: string, label: string): void { drafts.set(id, label); }
export function unregisterPetStoryDraft(id: string): void { drafts.delete(id); }
export function pendingPetStoryDrafts(projectId: string): string[] { return [...drafts].filter(([id]): boolean => id.startsWith(`${projectId}:`)).map(([, label]): string => label); }
