# Claude Code background subagents and nested dispatch

Date: 2026-11-08. Point-in-time record for issue #6007 (child 1 of epic #5969). It re-measures the
`claude` dispatch descriptor's `backgroundDispatch` and `maxDepth` axes, which the 2.1.177 spike
behind #1184 had set to `false` and `5`.

Host version: **Claude Code 2.1.319** (`claude --version` prints `2.1.319 (Claude Code)`).
Base: `origin/next` at `92415cf6`.

## 1. What the live docs say (primary: https://code.claude.com/docs/en/sub-agents, read 2026-11-08)

- Depth: "By default, a subagent can spawn subagents of its own, up to three layers below the main
  conversation. At the depth limit, Claude Code withholds the `Agent` tool from every subagent except
  a fork, so a subagent at the limit does its delegated work itself and returns one summary."
- The limit is configurable: "To change the limit, set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` to the
  number of subagent layers you want below your main conversation." … "Set `1` to turn nesting off."
- Background tool set: "Apart from `Agent` and `ExitPlanMode`, which follow the first filter's
  conditions wherever the subagent runs, a background subagent keeps every MCP tool but only these
  built-in tools: …". The first filter removes "`Agent`, when the subagent is at the depth limit".
  So a background subagent keeps `Agent` unless it is at the depth limit.
- `AskUserQuestion` is in the list the first filter always removes from subagents.
- Waiting, interactive session: "only the top-level subagent's summary returns to you, because a
  subagent that launches background subagents waits for their results before it finishes."
- Waiting, `claude -p` and the Agent SDK: "the spawning subagent waits while fork mode is on. If you
  turn fork mode off, nested subagents start in the background instead. The spawning subagent doesn't
  wait for a background nested subagent, which reports to your main conversation if it outlasts the
  spawning subagent."

The earlier evidence quote in the matrix ("Background subagents are limited to a depth of five and
cannot spawn further") no longer appears on the page.

## 2. What was measured (Claude Code 2.1.319)

The measuring agent was itself a subagent of an interactive Claude Code session. It reports to its
caller through `SubagentHandback`, which the docs list as a tool of background subagents.

| Question | Result |
|---|---|
| Does the subagent have the `Agent` tool? | Yes. |
| Does it have `AskUserQuestion`? | No. It is in neither the direct nor the deferred tool list. |
| Does a nested `general-purpose` agent it dispatches run and return? | Yes. The prompt was "reply with the word ok"; the nested agent replied `ok`. It also reported that it had `Agent` and did not have `AskUserQuestion`. It used 1 tool call and took about 4.9 s. |
| Can a nested dispatch run in the foreground? | No. The dispatch did not ask for the background, but the Agent tool returned "Async agent launched successfully … The agent is working in the background." This matches the second follow-up measurement on #5969. |
| Does a foreground-requested nested call block the caller's turn until it returns? | No. The call returned at once. The caller kept making tool calls, and the nested agent's report arrived later as a message while the caller was still working. |
| Does a layer-1 agent that waits on a background child end its turn before the child finishes? | **Not measured.** The caller never tried to end its turn while the child was still running. The docs (section 1) say it waits in an interactive session. Observation 5 on #5969 says it does not. This record does not settle that disagreement. |
| Default nesting depth | Not measured by probing to the limit. Taken from the docs: three layers below the main conversation. |
| The same facts under `claude -p` | **Not measured.** See section 4. |
| End-to-end run of the existing `FLATTEN=false` branches (`/gsd-manager`, `/gsd-autonomous --interactive`) on Claude Code | **Not run.** See section 4. |

## 3. Descriptor decision

- `backgroundDispatch`: `false` → `true`. The docs state it, and the measurement above corroborates it.
- `maxDepth`: `5` → `3`, the documented default. A user who sets
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` turns nesting off. The descriptor cannot see that setting, so
  the #2939 depth gate is shown on the `claude` shape at `maxDepth: 1` (it still flattens) by a unit
  test.

With these values `shouldFlattenDispatch` returns `false` for `claude`, so
`gsd-tools query dispatch-should-flatten` prints `false` for `GSD_RUNTIME=claude`. Every workflow site
still branches on `FLATTEN`. No branch logic changed.

## 4. Open points left for the maintainer

1. **`claude -p`.** Nothing in GSD can tell an interactive session from `claude -p`; the #3159
   survivability work was withdrawn. The docs say that under `-p`, with fork mode on, the spawning
   subagent waits; with fork mode off, it does not wait, and a nested child that outlasts it reports to
   the main conversation. This change adds no mechanism for `-p` and invents no environment-variable
   heuristic, as #6007 recommends. If a `-p` run shows nested dispatch does not complete within the
   turn, a survivability child has to be filed and land first. Otherwise, the epic's criterion 1 is
   amended to "no survivability axis needed".
2. **End-to-end check of the `FLATTEN=false` branches.** On Claude Code, `/gsd-manager` and
   `/gsd-autonomous --interactive` now take the background branches that Codex and Cursor already
   take. A plan and a two-plan wave still have to be run once through each branch. If that run
   fails, option (b) in #6007 applies: keep `claude` flattening in these two workflows until #6010.
3. **Layer-1 waiting** (the "Not measured" row above). Child #6019's `WAITING ON CHILDREN` turn-end
   block handles either outcome.
