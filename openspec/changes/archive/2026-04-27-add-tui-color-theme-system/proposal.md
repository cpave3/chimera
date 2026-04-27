## Why

The TUI currently uses hardcoded colors throughout its components, making it impossible for users to customize the visual appearance. A color theme system will allow users to define their own color schemes, improving accessibility and personal preference support.

## What Changes

- Add a color token system that maps semantic names (e.g., `primary`, `secondary`, `error`) to actual color values
- Create a theme provider that supplies tokens to TUI components via React context
- Add theme configuration loading from user config files
- Refactor existing TUI components to use theme tokens instead of hardcoded colors
- Add a default theme with sensible color choices that match current appearance

## Capabilities

### New Capabilities
- `tui-theme-system`: Color token system, theme context provider, and theme loading from config

### Modified Capabilities
- <!-- No existing TUI specs require behavioral changes -->

## Impact

- **Packages**: `@chimera/tui` - new theme module and component updates
- **User-facing**: Users can define custom themes in config files
- **Breaking**: None - default theme maintains current appearance
