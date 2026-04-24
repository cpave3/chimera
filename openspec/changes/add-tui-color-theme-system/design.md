## Context

The TUI currently uses hardcoded ANSI color codes (e.g., `chalk.blue`, `chalk.green`) directly in components. This makes it difficult to:
- Support user customization
- Ensure accessibility contrast
- Maintain consistent visual language
- Support different terminal capabilities

## Goals / Non-Goals

**Goals:**
- Define a semantic color token system that abstracts ANSI colors from component logic
- Provide theme loading from user configuration files
- Maintain backward compatibility - current appearance remains unchanged by default
- Support deep merging of user themes with defaults

**Non-Goals:**
- Terminal capability detection (256 vs truecolor) - out of scope for initial implementation
- Dynamic theme switching at runtime (can be added later)
- Non-color styling (borders, spacing, typography) - focus on colors only

## Decisions

### Token naming: Semantic over literal
Theme tokens use semantic names (`primary`, `error`, `muted`) rather than literal colors (`blue`, `red`, `gray`).
- **Why**: Semantic names are meaningful in context. `error` is red by default but could be bright orange in high-contrast themes.
- **Alternatives considered**: Literal naming (rejected - too rigid), numbered scales only (rejected - harder to understand)

### Token structure: Hierarchical groups
Tokens are organized by purpose: `base.*` (foundational), `accent.*` (interactive), `status.*` (feedback), `text.*` (content).
- **Why**: Groups make themes scannable and provide clear extension points.

### Storage: Config file with fallback
Themes loaded from `~/.config/chimera/theme.json` with deep merge against defaults.
- **Why**: JSON is simple, portable, and sufficient for key-value color definitions.
- **Alternatives considered**: TypeScript module (rejected - requires build step), embedded in main config (rejected - themes are separate concern)

### Provider pattern: React context
Theme provider wraps the TUI app, exposing `useTheme()` hook for components.
- **Why**: Standard React pattern, works with Ink's component model, allows for future runtime switching.

## Risks / Trade-offs

- **Migration complexity**: Existing components need updates to use tokens.
  - *Mitigation*: Default theme matches current colors exactly; migration can be gradual
- **Terminal color variance**: Same ANSI codes render differently across terminals.
  - *Mitigation*: Document recommended terminal settings; consider truecolor in future
- **Over-tokenization**: Too many tokens become unwieldy.
  - *Mitigation*: Start minimal (~15 tokens), add as needed based on usage
