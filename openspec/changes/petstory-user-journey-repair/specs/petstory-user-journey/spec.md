# Spec Delta

## Purpose

让用户在保留既有分镜生产画布、专用豆包普通 Chat 与实际媒体执行链的前提下，从直接输入剧本逐步到达逐镜素材成果，并在每个阻断点看懂缺项、对应对象和真正可用的下一步操作。

## ADDED Requirements

### Requirement: Six visible stages share current project facts

The system SHALL present script input, plan confirmation, base materials, keyframes, shot videos and results as one primary journey derived from saved project facts, while retaining the canvas and existing advanced functions.

#### Scenario: Open existing partial project
- **WHEN** a user opens a project with some actual outcomes and unfinished targets
- **THEN** the page recommends a relevant unfinished step, shows completed work and a clear next action, and permits inspecting other stages without generating requests

### Requirement: Reachable creation and explicit script analysis

The system SHALL offer execution account and associated Studio project selection at creation, default to direct script entry, and reliably save the script before explicitly requested analysis.

#### Scenario: Direct script without optional URL
- **WHEN** a user enters a script without a URL and selects save and analyze
- **THEN** the script is saved before analysis and a save failure creates no model request

#### Scenario: Account selection is missing
- **WHEN** the user starts creating without a selected account
- **THEN** the same entry offers account selection or account login navigation and preserves creation context

### Requirement: Analysis hands off adoption and confirmation

The system SHALL distinguish received analysis, adopted plan and confirmed production basis, visibly show understanding, role mapping, dynamic assets and shots, and expose the next real operation.

#### Scenario: Analysis completes on the same project
- **WHEN** the current analysis returns a plan candidate
- **THEN** the current page exposes the result and adoption action followed by an explicit confirmation action, without generating media

### Requirement: One recommended action has a truthful scope

The system SHALL name the current recommended operation by target scope and dynamic missing count, show progress and unadopted candidates accurately, and keep destructive regeneration as a separate secondary action.

#### Scenario: Some prompts are already valid
- **WHEN** the user continues missing prompt creation
- **THEN** valid adopted content is reused, protected edits remain and candidates are not counted as adopted completion

### Requirement: Prerequisites are actionable beside the target

The system SHALL display authoritative generation blockers and direct handling controls beside materials and media nodes; image actions SHALL not require unrelated video controls.

#### Scenario: Video lacks a first or required last frame
- **WHEN** a user inspects the video operation before required keyframes exist
- **THEN** the page names the missing frame and provides a control locating the corresponding real frame operation, without generating it silently

#### Scenario: Current image entrance has not been inspected
- **WHEN** the user is preparing base images without a current entrance check
- **THEN** the material area offers entrance inspection and displays its result in place

### Requirement: Recovery and specific drafts stay visible

The system SHALL expose current target, actual waiting state and original-task recovery outside diagnostic logs, and SHALL identify unsaved objects with save, locate and discard controls.

#### Scenario: Original submission is uncertain
- **WHEN** the page displays an uncertain original request
- **THEN** it explains that the request will not be resent and offers the available original conversation, read-only reply inspection or end-waiting actions without declaring success

#### Scenario: A hidden editor contains a draft
- **WHEN** the user navigates to another stage with unsaved changes
- **THEN** the page names the object and offers handling controls without silently losing the draft or disabling unrelated recovery

### Requirement: Results reflect actual scope and files

The system SHALL separately show material confirmation, prompt adoption, keyframe availability, video download, file validation and human quality confirmation for the current dynamic plan, and SHALL expose safe location controls for actual files.

#### Scenario: A single material batch completes
- **WHEN** the last batch is complete but required shot videos are missing
- **THEN** the project still shows missing shot outcomes and a working continuation entry rather than reporting a finished film

### Requirement: Product language and acceptance evidence are truthful

The system SHALL keep regression instructions and internal identifiers in diagnostics and SHALL base visible-flow acceptance on normal Electron controls and current-window screenshots, reporting offline, real Chat and real media verification separately.

#### Scenario: Media authorization is absent
- **WHEN** normal verification reaches an unapproved image or unauthorized media operation
- **THEN** evidence records the visible handoff as pending human media acceptance and does not claim end-to-end completion

### Requirement: Approved product design is the implementation baseline

The system SHALL implement the explicitly approved short drama studio design across the application, remove generic creation entry points, retain all short-drama capabilities, and preserve the full ai_story canvas relationships in keyframe and video stages.

#### Scenario: Inspect a different creation stage
- **WHEN** a user switches stages or opens a node
- **THEN** the existing canvas and views remain usable and no creation request, approval, or inferred completion occurs

### Requirement: Every image requires explicit preview and adoption

The system SHALL store generated and uploaded images as candidates before adoption for characters, props, scenes, first frames and last frames; candidate arrival SHALL NOT replace an adopted image or permit video references.

#### Scenario: New candidate arrives for an adopted image
- **WHEN** an image is downloaded or uploaded for that object
- **THEN** the current adopted image remains unchanged until the user previews and adopts a specific candidate

#### Scenario: Confirm a replacement image
- **WHEN** the selected candidate passes target, version and file checks and the user confirms adoption
- **THEN** the new image becomes current, the old image remains in history, existing outcomes remain and related downstream content is marked for review

#### Scenario: Upload a shot frame
- **WHEN** the user selects an image from a first-frame or last-frame node
- **THEN** the target and use are determined by that node and the same preview/adoption flow applies without requiring internal identifiers

### Requirement: A chosen free-chat reply applies only to its bound target

The system SHALL bind an adjustment to one creation object and its current basis, protect free conversation from automatic task injection, let the user choose a specific stable assistant reply, preview its full content and target, and apply only after explicit confirmation and freshness checks.

#### Scenario: Discuss several alternatives
- **WHEN** the user freely chats and multiple assistant replies exist
- **THEN** no reply is implicitly selected and no automatic task changes the conversation or editor draft

#### Scenario: Adopt a specific reply
- **WHEN** the user selects a concrete reply and confirms its application preview
- **THEN** only the bound object is updated, original reply evidence and previous content are retained, and stale or ambiguous replies do not overwrite newer work

#### Scenario: A reply needs structured preparation
- **WHEN** the chosen reply cannot satisfy the bound creation object
- **THEN** the UI permits continuing discussion or requesting Doubao preparation and does not generate creative content in program code
