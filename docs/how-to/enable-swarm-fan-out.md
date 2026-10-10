# How to enable swarm fan-out

Let research, pattern-mapping and code review fan out to a swarm of small read-only workers
instead of one strong agent reading everything itself. Each worker looks at a very small part of
the codebase, in parallel, and the step's own agent synthesizes their answers into the same
`RESEARCH.md`, `PATTERNS.md` or `REVIEW.md` it always writes.

> **Default-off and BETA.** The design and its trade-offs are in
> [ADR-5273](../adr/5273-swarm-fan-out-capability.md). The workflow spawn sites that call the
> fan-out are wired in a later step of that ADR; until then, enabling the capability makes the
> `gsd_run swarm` and `gsd_run loop fan-out-plan` commands answer with fan-out plans, but
> `/gsd-plan-phase` and `/gsd-code-review` still dispatch their single agent.

**What you need:**

- GSD installed with the `full` profile (the capability is `tier: full`).
- A runtime whose descriptor declares named dispatch and a concurrency of at least 2. Today that is
  Claude Code (`dispatch-capacity` 20). On any other runtime the steps run single-agent and say why.
- A Haiku-class model for the workers on your runtime. The catalog maps the `haiku` tier on
  Claude Code; elsewhere set `model_overrides.gsd-swarm-worker`.

---

## Step 1 — Turn it on

```bash
gsd-tools config-set swarm.enabled true
```

That is enough: all three roles fan out, up to 20 workers per role run, up to 20 at a time.

## Step 2 — Size the swarm (optional)

```bash
gsd-tools config-set swarm.max_workers 50       # more, smaller units; no upper bound
gsd-tools config-set swarm.max_concurrency 10   # fewer at once, if you hit rate limits
gsd-tools config-set swarm.roles code-reviewer  # only code review fans out
```

`config-set` checks the type only. A value the swarm cannot use, such as `swarm.max_workers 1`,
is reported when the step runs, as `invalid_swarm_config` naming the key, and that step runs
single-agent.

Concurrency is min(`dispatch-capacity`, `swarm.max_concurrency`, `swarm.max_workers`). With the
defaults on Claude Code, 50 workers run as three waves of 20, 20 and 10.
`parallelization.max_concurrent_agents` plays no part.

## Step 3 — Check what a step would do

```bash
printf 'src/a.ts\nsrc/b.ts\nsrc/c.ts\n' > /tmp/review-files.txt
gsd-tools loop fan-out-plan --cap-id code-review --point execute:post \
  --agent gsd-code-reviewer --phase 1 --scope-file /tmp/review-files.txt
```

A `"mode": "fan-out"` answer lists every dispatch and the concurrency. A `"mode": "single"` answer
names the reason (`disabled`, `role_not_selected`, `no_concurrency`, `no_worker_tier`, …); when
`"loud"` is `true` the spawn site prints it as a banner.

## What a run leaves behind

- The artefact itself, written by the step's own agent. Every claim it kept from a worker carries
  an invisible `<!-- swarm-anchor … -->` comment that `gsd-tools swarm verify-anchors` checked
  against the source.
- A closing `## Swarm: removed unverified claims` section when the check removed claims whose
  evidence did not hold. In `REVIEW.md` the finding counts and status are recomputed after removal.
- `<phase dir>/<NN>-SWARM.json`, one entry per role run, with the token split by model. Host-reported
  figures and chars/4 estimates sit in separate maps and are never summed.

## When it falls back

A role runs its single agent, loudly, when more than 25 % of worker answers had to be dropped
(over 4 KiB, not JSON, or off-schema), when the synthesizer wrote nothing, or when an unverified
claim could not be removed cleanly. The fallback's artefact replaces the swarm's.
