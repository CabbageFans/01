## Purpose

保证短剧工作室分镜以原剧本的信息和情绪变化为依据，在每镜 5～10 秒整秒的生成限制内安排必要动作、逐字对白与自然表演，并将同一制作时间计划传递到候选、采用和下游正文，使用户能通过既有方案反馈改善节奏而无需技术审批。

## ADDED Requirements

### Requirement: Legal duration and content led planning
The system SHALL accept new storyboard durations only as finite integer numbers 5, 6, 7, 8, 9 or 10. Ordinary Doubao Chat SHALL arrange source coverage, meaningful changes and sequential or concurrent events before choosing the shortest sufficient duration, without duration quotas or deleting dialogue.

#### Scenario: Wider platform capability
- **WHEN** a page or capability reports durations outside 5～10 seconds
- **THEN** new plan and video task durations remain within the product range and actual execution checks the selected value on the page

#### Scenario: Necessary long content
- **WHEN** necessary content cannot fit within 10 seconds after removing decorative actions and allowing plausible overlap
- **THEN** Chat returns natural splits of 5～10 seconds preserving original dialogue, speakers, order and causality

### Requirement: Persisted timing and source fragments
The system SHALL preserve optional structured event windows, duration and cut reasons, and dialogue occurrence/fragment references through parsing, candidate adoption, reopening, design snapshots and downstream requests. Structured timing SHALL take precedence over legacy prose timing.

#### Scenario: Overlap and sequence
- **WHEN** talking and movement share a window or one event explicitly follows another
- **THEN** the plan uses timeline span rather than summing overlaps and rejects windows that contradict explicit ordering or exceed shot duration

#### Scenario: Dialogue fragments and repeated lines
- **WHEN** a full source utterance is split or intentionally repeated in the script
- **THEN** fragments identify their occurrence and character ranges, preserve exact ordered coverage and cannot duplicate or omit text

#### Scenario: Legacy project
- **WHEN** an existing project has no structured timing
- **THEN** it opens with its original story, plan, media and history preserved and cannot create new out of range video tasks

### Requirement: Feedback and downstream scope
The system SHALL allow authorized complete-plan pacing feedback to split, merge and retime shots as a new candidate. Asset completion and single prompt feedback SHALL retain their existing scope. First frames SHALL express only actionable start states, last frames the end states, and video requests the adopted event order and duration without new decorative opening or waiting.

#### Scenario: Candidate and adoption
- **WHEN** a feedback candidate changes shot structure or timing
- **THEN** the adopted plan remains unchanged until explicit adoption, affected prompt and continuous-shot dependencies update, and unrelated results and historical media remain available

### Requirement: Honest acceptance evidence
The system MUST distinguish offline technical fixtures, visible UI, real Chat and real media validation and compare any creative results to the same original user script.

#### Scenario: No new media test
- **WHEN** only storyboard and prompt wiring have been tested
- **THEN** the report does not claim measured improvement to generated video pacing
