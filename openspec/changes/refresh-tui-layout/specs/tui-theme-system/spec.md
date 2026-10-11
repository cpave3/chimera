## ADDED Requirements

### Requirement: Syntax color tokens
The theme SHALL define the tokens `syntax.keyword`, `syntax.string`, `syntax.comment`, `syntax.number`, `syntax.function` and `syntax.type`. A user theme that omits them SHALL inherit them from the default theme.

#### Scenario: Partial user theme
- **WHEN** a user theme sets only `accent.primary`
- **THEN** the resolved theme has every `syntax` token from the default theme
