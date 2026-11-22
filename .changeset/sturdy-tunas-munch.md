---
type: Changed
pr: 0
---
**The `claude` dispatch descriptor states what current Claude Code does** — re-measured on Claude Code 2.1.319 against the live sub-agents docs, a backgrounded agent keeps its `Agent` tool and can nest up to three layers below the main conversation, so `backgroundDispatch` is now `true` and `maxDepth` is `3`. `gsd-tools query dispatch-should-flatten` still returns `true` for `claude`, now because of the `backgroundSurvivesHeadless: false` axis (a `claude -p` run stops background work after its final turn), so `/gsd-manager` and `/gsd-autonomous --interactive` keep running plan and execute inline on Claude Code. A depth limit of 1 still flattens. The workflow prose that said Claude Code background agents have no `Agent`/`Task` tool is corrected, and the measurement is recorded in `docs/research/2026-11-08-claude-code-background-nesting.md`. (#6007)
