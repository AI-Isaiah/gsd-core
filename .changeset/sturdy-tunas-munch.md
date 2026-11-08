---
type: Changed
pr: 0
---
**`/gsd-manager` and `/gsd-autonomous --interactive` now background plan and execute on Claude Code** — the `claude` dispatch descriptor was re-measured on Claude Code 2.1.319 against the live sub-agents docs: a backgrounded agent keeps its `Agent` tool and can nest up to three layers below the main conversation, so `backgroundDispatch` is now `true` and `maxDepth` is `3`, and `gsd-tools query dispatch-should-flatten` returns `false` for `claude` instead of forcing these workflows inline. A depth limit of 1 still flattens. The workflow prose that said Claude Code background agents have no `Agent`/`Task` tool is corrected, and the measurement is recorded in `docs/research/2026-11-08-claude-code-background-nesting.md`. (#6007)
