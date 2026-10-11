## ADDED Requirements

### Requirement: Goal command
`/goal <condition>` SHALL set the session's goal, `/goal clear` SHALL remove it, and `/goal` with no argument SHALL show it.

#### Scenario: Set
- **WHEN** the user enters `/goal all tests pass`
- **THEN** the session's goal is "all tests pass"

#### Scenario: Clear
- **WHEN** the user enters `/goal clear`
- **THEN** the session has no goal

### Requirement: Goal on the screen
While a goal is set, the fullscreen layout SHALL show it in the context panel and the inline layout SHALL show it in the footer. Each `goal_updated` event SHALL add one line to the transcript that says what changed and why. The message that carries a `not_met` reason to the agent SHALL NOT appear as a message of the user.

#### Scenario: Active goal
- **WHEN** a goal is set
- **THEN** the context panel has a goal section with the condition

#### Scenario: Not met
- **WHEN** a `goal_updated` event with the change `not_met` arrives
- **THEN** the transcript gains one line with the reason and the continuation count, and no user message

### Requirement: Notices wrap between words
A notice or an error line of the transcript that is longer than the pane SHALL break between words. A word longer than a line SHALL be cut.

#### Scenario: Long reason
- **WHEN** a goal result has a reason of three lines
- **THEN** each line ends at the end of a word
