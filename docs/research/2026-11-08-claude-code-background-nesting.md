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

With these values alone `shouldFlattenDispatch` would return `false` for `claude`. Section 5 showed
that unsafe under `claude -p`, so the descriptor also declares #6119's
`backgroundSurvivesHeadless: false`, and `gsd-tools query dispatch-should-flatten` still prints `true`
for `GSD_RUNTIME=claude` (section 6). Every workflow site still branches on `FLATTEN`. No branch logic
changed.

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

## 5. Merge-condition spikes (2026-11-10, Claude Code 2.1.322)

Run for the two merge conditions on #6007. Host: `claude --version` prints `2.1.322 (Claude Code)`.
Branch rebased on `origin/next`. All runs in throwaway directories, headless.

### 5.1 `claude -p`: nested dispatch

Probe: the main session dispatches layer 1 with `run_in_background: true`; layer 1 dispatches one
nested `general-purpose` agent (no background flag) that sleeps 20 s, writes a timestamp and replies.
Command shape: `claude -p "<prompt>" --allowedTools Agent "Bash(date:*)" "Bash(node -e:*)" ...
--output-format stream-json --verbose`. Two runs, one text-output run, one positive control (layer 1
dispatched in the foreground).

| Run | layer-1 start → nested done → layer-1 end → process exit (s from main start) | exit |
|---|---|---|
| bg 1 | 17 → 45 → 56 → 65 | 0 |
| bg 2 | 19 → 45 → 58 → 66 | 0 |
| bg 3 (text output) | 19 → 44 → 57 → 68 | 0 |
| fg control | 16 → 45 → 54 → 65 | 0 |

- Under `-p`, the nested call ran in the **foreground**: it blocked layer 1 for 30-33 s and returned
  (`subagent_stats.requested.foreground: 1`, `started_in_background: 1`, the layer-1 agent only).
  This differs from the interactive 2.1.319 measurement in section 2.
- In every background run the main session's **turn ended first** (result 0: "waiting for its
  completion notification"). The process stayed alive, a task notification started a second turn,
  and that turn printed the nested result. With text output both turns' texts are printed.
- **The wait has a ceiling.** In section 5.2 the process printed to stderr: "Background tasks still
  running 10m after the last turn (subagent "Plan phase 1: Greet"); stopping them. Set
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely." The background agent was killed
  (`killed.system: 1`) and the process exited 0.

**Verdict: does not meet the condition.** Nested dispatch does not complete within the turn under
`-p`. Background work survives the turn only for up to 10 minutes after the last turn, by default,
and is then killed while the process still exits 0. A real plan phase exceeded that. Per #6007's
merge condition, a survivability child has to land first.

### 5.2 The flip: `FLATTEN=false` branches end to end

Fixture: a two-phase Node project (phase 1 one plan, phase 2 a two-plan wave), CONTEXT.md written,
GSD installed with this branch's `bin/install.js --claude --local`, `workflow.text_mode: true`,
`research: false`. `dispatch-should-flatten --raw` printed `false` in both fixtures, and both
workflows reported taking the background branch. Driven with `claude -p ... --permission-mode auto`,
one invocation per user reply (`--resume <session>`).

- `/gsd-autonomous --interactive --only 1`: the plan agent was dispatched in the background. The main
  turn ended after 1 turn; at 644 s the 10-minute ceiling killed the plan agent and its child. No
  `PLAN.md` was written. **Did not complete.**
- `/gsd-manager`, "Plan Phase 1": the background plan agent ran its layer-2 agents (pattern mapper,
  planner) and **ended its own turn before its planner finished** ("paused while its own background
  subagents keep working"). The manager then reported "The Phase 1 planner finished without a plan",
  and corrected itself when the orphaned planner later wrote `01-01-PLAN.md`. The plan was not
  committed, and the plan-phase pipeline after the planner (plan-checker, commit) did not run under
  the plan agent. Wall time 1099 s. **Did not complete cleanly.** This is #5969 observation 5
  measured under `-p`: section 4 item 3 is now answered.
- Execute and the two-plan wave were not run: planning did not complete in either workflow.

**Verdict: does not meet the condition** for either workflow. These runs were headless (`-p`), so the
10-minute ceiling confounds the autonomous result; the manager result (a layer-1 agent ending before
its layer-2 child) does not depend on the ceiling. An interactive end-to-end run was not made.

## 6. Survivability signal (#6119)

The follow-up question, whether GSD can tell a `claude -p` session from an interactive one from a
documented host signal, is answered in its own record:
[2026-11-19-claude-code-survivability-signal.md](2026-11-19-claude-code-survivability-signal.md).
It found no documented signal, so `claude` stays flattened until one exists or the maintainer
decides otherwise. The descriptor carries that as `dispatch.backgroundSurvivesHeadless: false`, which
makes `dispatch-should-flatten` return `true` whatever the nesting rows allow.
