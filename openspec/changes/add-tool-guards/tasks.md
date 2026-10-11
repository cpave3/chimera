## 1. Tolerant edit

- [ ] 1.1 Test and implement the trailing-whitespace level
- [ ] 1.2 Test and implement the any-whitespace level with re-indentation
- [ ] 1.3 Test and implement the ambiguity error
- [ ] 1.4 Test and implement the closest-block error

## 2. Tool-call repair

- [ ] 2.1 Test and implement argument repair (fence, JSON string, coercion, nulls)
- [ ] 2.2 Test and implement tool-name repair

## 3. Interceptors and guards

- [ ] 3.1 Test and implement `interceptTools`
- [ ] 3.2 Test and implement the repeat note
- [ ] 3.3 Test and implement the output budget with recall archiving
- [ ] 3.4 Wrap every tool surface in the CLI factory; add `outputBudgetTokens` to `ModelConfig`

## 4. Wrap-up

- [ ] 4.1 Show the match level and archive id in the TUI tool line
- [ ] 4.2 Update `README.md`
- [ ] 4.3 `pnpm -r build`, `pnpm -r test`, `pnpm biome:lint`
