# Spec Delta

## Purpose

让短剧工作室由用户剧本决定剧情角色，由用户明确采用的实际图片决定角色视觉形象；后续关键帧与视频在准确的角色、对白和附件对应关系下安排画面与表演，同时保护原项目和历史成果。

## ADDED Requirements

### Requirement: Script determines cast and style

The system SHALL start new projects with empty cast and no specific art style, extract roles dynamically, and preserve explicit user names including 噜噜 and 噜妹.

#### Scenario: Original story analysis
- **WHEN** the user analyzes a story in a new project
- **THEN** the analysis uses its actual roles and explicit style without software actor replacement, fixed role count, species or art defaults

### Requirement: Adopted character image is visual authority

The system SHALL allow upload, preview and adoption without a base prompt, and atomically supersede active old base prompts only on adoption while preserving their original text and jobs.

#### Scenario: Upload with or without an existing base prompt
- **WHEN** a user adopts a valid image on a script role card
- **THEN** the role becomes visually ready, its current references point to that image and old base prompts cannot revive through synchronization, reopening, batch completion or late results

#### Scenario: Cancel preview
- **WHEN** the user uploads or previews a candidate without adopting it
- **THEN** the current image and active creative basis remain unchanged

### Requirement: Reference images drive frames and performance

The system SHALL provide effective stage facts to ordinary Chat and actual media input; frames arrange composition and video arranges actions, expressions, interactions, word-for-word dialogue, sound and camera without redefining character appearance.

#### Scenario: Three video modes and revision
- **WHEN** a first-frame, first-last-frame or multiple-reference video prompt is generated or revised
- **THEN** its actual attachment list and labels match the target input, speaker IDs and dialogue remain accurate, and obsolete appearance is not active writing instruction

#### Scenario: Keyframe and image feedback
- **WHEN** a frame or selected-image edit is prepared
- **THEN** it uses current adopted identity images or the exact selected edit image, without restoring superseded character designs

### Requirement: Local dependencies and history remain coherent

The system SHALL preserve original stories, raw replies, jobs, images and videos, and limit replacement impact to shots using the character and actual continuous dependants without automatic media generation.

#### Scenario: Image replaced after frames exist
- **WHEN** a new role image is adopted
- **THEN** affected old frames remain viewable historical outputs and cannot pretend to depict the new role, unrelated shots stay valid and normal user actions handle only required current targets

#### Scenario: Legacy project opens
- **WHEN** an existing project with old IDs and adopted media is opened
- **THEN** stable bindings and dialogue remain available without automatically calling Chat or injecting software defaults
