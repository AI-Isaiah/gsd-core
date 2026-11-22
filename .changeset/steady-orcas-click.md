---
type: Changed
pr: 0
---
**The `claude` flatten verdict no longer rests on a stale descriptor row** — the host-integration dispatch descriptor gains an optional `backgroundSurvivesHeadless` axis, and `claude` declares it `false` from the documented `claude -p` background-wait ceiling (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`), so `gsd-tools query dispatch-should-flatten` keeps returning `true` for `claude` in every session even once the nesting rows are corrected. No verdict changes today; descriptors that do not declare the axis keep their current verdict. (#6119)
