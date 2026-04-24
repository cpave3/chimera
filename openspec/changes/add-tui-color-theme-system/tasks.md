## 1. Setup Theme Module

- [ ] 1.1 Create `packages/tui/src/theme/` directory structure
- [ ] 1.2 Add theme types file (`types.ts`) with token interfaces
- [ ] 1.3 Define Theme interface with base, accent, status, text groups

## 2. Define Tokens and Default Theme

- [ ] 2.1 Create token constants for base colors (background, foreground)
- [ ] 2.2 Create token constants for accent colors (primary, secondary)
- [ ] 2.3 Create token constants for status colors (success, warning, error)
- [ ] 2.4 Create token constants for text colors (primary, secondary, muted)
- [ ] 2.5 Export defaultTheme object with sensible ANSI color values

## 3. Implement Theme Provider

- [ ] 3.1 Create ThemeContext using React.createContext
- [ ] 3.2 Implement ThemeProvider component with theme prop
- [ ] 3.3 Implement useTheme() hook with context consumption
- [ ] 3.4 Export theme module from tui package index

## 4. Implement Theme Loading

- [ ] 4.1 Add config path utility for `~/.config/chimera/theme.json`
- [ ] 4.2 Implement loadUserTheme() to read and parse theme file
- [ ] 4.3 Implement deepMerge() utility for merging user theme with defaults
- [ ] 4.4 Handle missing theme file gracefully (use defaults)
- [ ] 4.5 Integrate theme loading into TUI initialization

## 5. Refactor Components

- [ ] 5.1 Wrap TUI root with ThemeProvider
- [ ] 5.2 Update component imports to include useTheme
- [ ] 5.3 Replace hardcoded status colors with theme tokens
- [ ] 5.4 Replace hardcoded text colors with theme tokens
- [ ] 5.5 Replace hardcoded accent colors with theme tokens
- [ ] 5.6 Verify visual appearance matches pre-refactor state

## 6. Testing and Documentation

- [ ] 6.1 Add unit tests for token deep merge logic
- [ ] 6.2 Add unit tests for useTheme hook
- [ ] 6.3 Create example theme.json documentation
- [ ] 6.4 Add theme customization section to README
- [ ] 6.5 Run full test suite to verify no regressions
