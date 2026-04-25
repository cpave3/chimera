## 1. Setup Theme Module

- [x] 1.1 Create `packages/tui/src/theme/` directory structure
- [x] 1.2 Add theme types file (`types.ts`) with token interfaces
- [x] 1.3 Define Theme interface with base, accent, status, text groups

## 2. Define Tokens and Default Theme

- [x] 2.1 Create token constants for base colors (background, foreground)
- [x] 2.2 Create token constants for accent colors (primary, secondary)
- [x] 2.3 Create token constants for status colors (success, warning, error)
- [x] 2.4 Create token constants for text colors (primary, secondary, muted)
- [x] 2.5 Export defaultTheme object with sensible ANSI color values

## 3. Implement Theme Provider

- [x] 3.1 Create ThemeContext using React.createContext
- [x] 3.2 Implement ThemeProvider component with theme prop
- [x] 3.3 Implement useTheme() hook with context consumption
- [x] 3.4 Export theme module from tui package index

## 4. Implement Theme Loading

- [x] 4.1 Add config path utility for `~/.chimera/theme.json` (co-located with the rest of Chimera's user state)
- [x] 4.2 Implement loadUserTheme() to read and parse theme file
- [x] 4.3 Implement deepMerge() utility for merging user theme with defaults
- [x] 4.4 Handle missing theme file gracefully (use defaults)
- [x] 4.5 Integrate theme loading into TUI initialization

## 5. Refactor Components

- [x] 5.1 Wrap TUI root with ThemeProvider
- [x] 5.2 Update component imports to include useTheme
- [x] 5.3 Replace hardcoded status colors with theme tokens
- [x] 5.4 Replace hardcoded text colors with theme tokens
- [x] 5.5 Replace hardcoded accent colors with theme tokens
- [x] 5.6 Verify visual appearance matches pre-refactor state

## 6. Testing and Documentation

- [x] 6.1 Add unit tests for token deep merge logic
- [x] 6.2 Add unit tests for useTheme hook
- [x] 6.3 Create example theme.json documentation
- [x] 6.4 Add theme customization section to README
- [x] 6.5 Run full test suite to verify no regressions
