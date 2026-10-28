# Prompt pipeline delta

## Purpose

统一故事入口与既有画布的专用豆包文字生产，使每项正文拥有真实来源和适用目标，并可恢复原回复、保护手改、保存采用关系及按实际依赖继续制作。文字验证与媒体授权明确区分，完整证据留在用户本地。

## ADDED Requirements

### Requirement: Analysis designs and dedicated Chat writes
The system SHALL use analysis for story understanding, provenance, dynamic entities, spatial and shot design. Media bodies returned by legacy analysis MUST remain drafts without fabricated dedicated provenance. First workflow, single regeneration, batches and revisions SHALL use the same dedicated request, validation, candidate and adoption path, preserving manual final and optional end frames.

#### Scenario: New project completes text stages
- **WHEN** user adopts an analysis and authorizes continuing current text stage
- **THEN** missing material or per-shot dedicated targets advance sequentially through the existing queue without media submission; designed shots with empty final remain viewable and persist across reopen.

#### Scenario: Source actors differ from configured production cast
- **WHEN** source descriptions contain different actors or an earlier unconfirmed design conflicts with the current production cast
- **THEN** analysis receives source facts and current production cast separately, including actual identity approval evidence; Doubao maps source roles to the configured cast and returns the complete candidate without program-written identity substitutions.

#### Scenario: Explicit source aliases bind production actors
- **WHEN** current actor settings contain explicit source aliases or main/supporting roles
- **THEN** the actual request bindings persist and analysis adoption checks those IDs, alias ownership and roles; missing legacy aliases are not invented, additional actors remain dynamic, and a mismatched reply stays preserved for the normal bounded Chat repair.

#### Scenario: Prior unconfirmed identity differs from the new reply
- **WHEN** analysis or asset adoption receives a new character description and the old plan has no valid current image identity approval
- **THEN** the reply description remains intact; only an identity approval bound to the current selected actual image and matching validation hash can preserve confirmed identity facts, while selecting an image alone never creates approval.

#### Scenario: Adopted redesign removes saved batch targets
- **WHEN** an explicitly resumed text batch contains targets removed by a newly adopted design
- **THEN** unresolved original tasks retain read-only recovery protections; otherwise the existing stage service computes current missing targets without submitting deleted targets or marking them adopted.

### Requirement: Current submission qualification
The system SHALL distinguish creative plans, adopted unbound bodies, submittable bodies and required revisions. Actual media creation, bulk and recovery SHALL validate real adopted dedicated provenance, model dialect, input mode, current confirmed design/dialogue/frames and reference purpose. Generic and missing contracts MUST NOT pass known-model submission. Same-material reorder or pending-to-file resolution SHALL map deterministically without rewriting creative content.

#### Scenario: Model and mode changes
- **WHEN** a legacy, generic, edited or mismatched body is selected for a known model or changed input mode
- **THEN** submission waits for normal Chat generation or revision while matching bodies can continue and old text remains visible.

### Requirement: Recover or end waiting without resending
The system SHALL recover replies read-only from the original account/session/run and uniquely associated user/assistant turns plus request targets, preserve raw replies separately from comparison views and retain ambiguous evidence. Users SHALL explicitly end waiting without deleting submission facts, cancelling platform work or adopting results. Historical unrelated text SHALL NOT block valid independent targets; real account activity and affected frame/material dependencies remain protected.

#### Scenario: Late or ambiguous response
- **WHEN** multiple messages conflict or a reply arrives after waiting ended
- **THEN** no reply is guessed or automatically adopted and no request is resent; evidence persists for user verification.

### Requirement: Bounded validation and revisions
The system SHALL recognize finite equivalent subtitle prohibitions, reject missing or contradictory prohibitions, strictly check reference binding and exact dialogue/count, and preserve sound rules. Creative corrections MUST come from Doubao; at most one automatic revision is allowed per original request, with explicit later operations starting new requests.

#### Scenario: Equivalent natural language
- **WHEN** a response prohibits subtitles and dialogue text overlays using an accepted equivalent expression
- **THEN** no revision is spent merely to force one literal sentence, while positive subtitle instructions and watermark-only text fail.

#### Scenario: Reviewed body changed before revision
- **WHEN** a target final differs from its actual per-target review snapshot
- **THEN** old issues remain historical and revision requires a new review; format repairs inherit the original snapshot and never manufacture missing legacy review evidence.

### Requirement: Real story evidence and persistence
The system SHALL support a normal new-project story path and the original five-shot 5 first/3 end/5 video path, preserving current facts and manual edits, without automatic media generation. Requests, raw replies, candidates, adoption, canvas/export/task consistency, ended waiting and batch status SHALL be verified after reopen; offline and real verification MUST be reported separately.

#### Scenario: External blocker remains
- **WHEN** login, verification, material approval or reply content prevents completion
- **THEN** the per-target blocker and original evidence remain visible without developer-written creative bodies or false success.

#### Scenario: Manual assignment updates the renderer without execution
- **WHEN** a queued task is manually assigned through the normal desktop IPC
- **THEN** a successful Core data result is returned as the shared TaskResult task field, the renderer reflects the saved account, and execution stays on hold until explicit authorization; actual failures retain their specific reason.
