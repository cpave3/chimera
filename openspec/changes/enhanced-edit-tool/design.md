## Context

The current `edit` tool is extremely brittle due to its reliance on exact-string matching. This makes complex refactorings prone to failure whenever whitespace or indentation differs even slightly from the source code being read.

## Goals / Non-Goals

**Goals:**
- Improve the reliability of the `edit` tool during automated agent tasks.
- Reduce the "context window" required for an agent to perform an edit by allowing targeted line replacements.
- Maintain backward compatibility with the existing literal-string replacement behavior.

**Non-Goals:**
- Re-implementing a full IDE-grade refactoring engine.
- Modifying the `write` or `read` tools.

## Decisions

**Decision 1: Extend `edit` with an `isRegex` flag.**
- **Rationale**: Instead of creating a entirely new tool, we extend the existing one. This preserves compatibility for all existing agent workflows that rely on literal matches, while providing an "opt-in" for more powerful regex-based operations.
- **Alternative**: Creating a separate `regex_edit` tool. 
- **Why X over Y**: Extending `edit` keeps the toolset surface area smaller and allows simpler fallback logic.

**Decision 2: Implement Line-Range Replacement via a companion `replace_lines` tool.**
- **Rationale**: While we could add line numbers to `edit`, doing so would fundamentally change its signature and break existing calls. A separate, surgical tool like `replace_lines(path, start, end, content)` is much cleaner for high-precision tasks and doesn't compromise the simplicity of the original `edit` tool.
- **Alternative**: Adding `start_line`/`end_line` to the existing `edit` tool.
- **Why X over Y**: The `replace_lines` approach avoids breaking changes (the "mirror rule") for all current users and agents, while providing a new, powerful primitive for complex tasks.

## Risks / Trade-offs

**[Risk] Regex complexity/performance** → **Mitigation**: We will use the underlying system's regex engine (e.g., via Node.js `String.replace`) which is highly optimized, and we will not introduce complex lookahead/lookbehind requirements that could slow down execution.

**[Risk] Tool confusion** → **Mitigation**: Clear documentation in the tool definitions for both `edit` (with `isRegex`) and `replace_lines`.

## Open Questions

- Should `replace_lines` also support a "wrap with context" mode? (Decided: No, keep it surgical).
