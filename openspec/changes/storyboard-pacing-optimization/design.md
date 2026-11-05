## Context

See proposal.md. Existing storyboard rules already include natural cuts, deduplicated actions and dialogue timing. Their enforcement relies on free prose and old preservation rules; no separate production executor is needed. User instructions authorize implementation and necessary ordinary Chat validation continuously in this turn.

## Goals / Non-Goals

**Goals:** One optional shot timing structure, exact dialogue fragment provenance, normal candidate/adoption persistence and existing design hashes, strict 5～10 integer planning/execution.

**Non-Goals:** Beat database, model registry, new UI panels, voice synthesis, editing/export P5, media generation during acceptance.

## Decisions

- Add `timingPlan` with event ID/kind/description/startSeconds/endSeconds, optional dialogueIndex and afterEventId, estimatedRequiredSeconds/durationReason/cutReason. It is authoritative when present; `timing` remains old-project prose only. Check concrete contradictions without rating creative quality.
- Dialogue `source` records the complete original utterance, 1-based occurrence and Unicode character half-open start/end. This permits natural long-line fragments without set deduplication or weakening whole-script coverage. Old dialogues remain compatible.
- Use current analysis/planFeedback requests and ordinary Chat for all creative text. Explicit whole-plan pacing feedback can split/merge and change duration; assets and target prompts cannot.
- Reuse current whole-shot hashes and affected-media preservation instead of adding parallel state. Existing visible preview displays event windows and reasons without a new dashboard.
- Preserve already sent task snapshots. Current new planning facts must match task configuration and page readback; edits do not rewrite creative bodies in code.

## Risks / Trade-offs

- Text timing is an estimate and platform performance is not frame accurate → report creative and video acceptance separately; no fixed character-speed formula.
- Model can return legal but weak timing → compare to full original script and real old plan, not merely its own sourceRefs.
- Real Chat may encounter login/verification → retain original request and state, never bypass or resend uncertain submissions.
- Existing explicit product reuse of adopted video text must remain compatible → apply timing-specific freshness to new structured plans without invalidating all historical projects.

## Migration Plan

Optional fields require no project migration. Build contracts and application together; open old projects read-only for comparison, use a UI-created isolated project for creative acceptance. Keep evidence outside the repository and leave incomplete real acceptance explicit.
