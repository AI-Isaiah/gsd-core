/**
 * Fan-out plan (#5273, ADR-5273 Decisions 1, 2 and 9).
 *
 * Core's half of the fan-out seam: the plan schema, its validator and the concurrency
 * resolution. It holds NO policy. How a brief is decomposed, how many workers run and which
 * prompt each one gets belong to the capability that declares `fanOutStrategy`; this module
 * only decides whether what that capability returned is a plan core will hand to an executor.
 *
 * A plan is an ordered list of stages with a barrier between consecutive stages. Two shapes
 * exist, one per `loop fan-out-plan --stage`:
 *
 * - `decompose`: one stage holding one `decompose` dispatch.
 * - `fan-out`: a `workers` stage (2..maxWorkers `worker` dispatches plus at most one
 *   `cross-file` dispatch), then a `synthesize` stage holding exactly one `synthesizer`.
 *
 * The design point is a swarm (ADR-5273 Decision 2): many weak read-only workers, each looking at
 * a very small part, in parallel. `maxWorkers` has no upper bound; the strategy reads
 * `swarm.max_workers` and `swarm.max_concurrency` and writes them into the plan, so core never
 * reads a swarm-owned key.
 *
 * Every rejection carries a stable reason code, so the caller can degrade to single-agent
 * dispatch loudly (ADR-5273 Decision 6). Nothing here throws on hostile input.
 */

import fs from 'node:fs';
import path from 'node:path';

import { tryWithinRootLexical } from './security.cjs';

/** Every role run reserves one dispatch for the loud single-agent fallback. */
export const RESERVED_FALLBACK_DISPATCHES = 1;

/**
 * Dispatches a role run spends beyond its workers: the one extra dispatch each role has
 * (decomposition for research and pattern-mapping, the cross-file worker for code-review), the
 * synthesizer, and the reserved fallback.
 */
export const AGENT_OVERHEAD = 1 + 1 + RESERVED_FALLBACK_DISPATCHES;

/** ADR-5273 Decision 2: one role run dispatches at most `maxWorkers` + 3 agents, fallback included. */
export function agentBudget(maxWorkers: number): number {
  return maxWorkers + AGENT_OVERHEAD;
}

/** The one read-only worker agent a fan-out plan may dispatch besides the step's own agent. */
export const FAN_OUT_WORKER_AGENT = 'gsd-swarm-worker';

/** A fan-out needs at least two workers. There is deliberately no maximum (ADR-5273 Decision 2). */
export const MIN_WORKERS = 2;

/**
 * ADR-5273 Decision 9: the executor drops (never truncates) a worker answer larger than this before
 * it reaches the synthesizer, so the synthesis input grows by at most maxWorkers × 4 KiB.
 */
export const ANSWER_MAX_BYTES = 4 * 1024;

/** Byte bounds on model-bound text a plan carries (ADR-5273 Decision 9). */
export const PROMPT_MAX_BYTES = 32 * 1024;
export const SCHEMA_MAX_BYTES = 8 * 1024;
export const SCOPE_MAX_PATHS = 64;

export type WorkerAnswerResult =
  | { ok: true; bytes: number; answer: Record<string, unknown> }
  | { ok: false; bytes: number; reason: 'answer_too_large' | 'not_json' | 'not_object' };

/**
 * ADR-5273 Decision 9: the one predicate for a worker's raw answer text before it may reach the
 * synthesizer. Over `ANSWER_MAX_BYTES` UTF-8 bytes is dropped, never truncated, because a cut
 * could split an anchor or a quote. The size check runs before parsing, so an oversized answer
 * is never parsed. Validation against the dispatch's own `schema` stays with the executor.
 */
export function checkWorkerAnswer(text: unknown): WorkerAnswerResult {
  if (typeof text !== 'string') return { ok: false, bytes: 0, reason: 'not_json' };
  const bytes = byteLength(text);
  if (bytes > ANSWER_MAX_BYTES) return { ok: false, bytes, reason: 'answer_too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, bytes, reason: 'not_json' };
  }
  if (!isPlainObject(parsed)) return { ok: false, bytes, reason: 'not_object' };
  return { ok: true, bytes, answer: parsed };
}

export const FAN_OUT_STAGES = Object.freeze(['decompose', 'fan-out'] as const);
export type FanOutStage = (typeof FAN_OUT_STAGES)[number];

/** Closed set of reasons a fan-out degrades to single-agent dispatch at plan time. */
export const FAN_OUT_REASON = Object.freeze({
  NO_FAN_OUT_TRAIT: 'no_fan_out_trait',
  NO_STRATEGY: 'no_strategy',
  STRATEGY_FAILED: 'strategy_failed',
  PARALLELIZATION_DISABLED: 'parallelization_disabled',
  NO_NAMED_DISPATCH: 'no_named_dispatch',
  NO_CONCURRENCY: 'no_concurrency',
  INVALID_PLAN: 'invalid_plan',
  OVER_AGENT_BUDGET: 'over_agent_budget',
  TOO_FEW_UNITS: 'too_few_units',
  AMBIGUOUS_STRATEGY: 'ambiguous_strategy',
} as const);
export type FanOutReason = (typeof FAN_OUT_REASON)[keyof typeof FAN_OUT_REASON];

/** Reasons a strategy may return itself on a `mode: "single"` answer, beyond core's own. */
const STRATEGY_REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const DISPATCH_PURPOSES = Object.freeze(['decompose', 'worker', 'cross-file', 'synthesizer'] as const);
export type DispatchPurpose = (typeof DISPATCH_PURPOSES)[number];

/**
 * Fields only execute-phase's wave adapter may set (ADR-5273 Decision 1, implementation step 5).
 * A plan returned by a `fanOutStrategy` command carrying any of them is rejected.
 */
export const EXECUTOR_ONLY_FIELDS = Object.freeze(['isolation', 'worktree_metadata', 'resultContract'] as const);

const PLAN_KEYS = new Set(['mode', 'stage', 'maxWorkers', 'maxConcurrency', 'stages']);
const STAGE_KEYS = new Set(['id', 'dispatches']);
const DISPATCH_KEYS = new Set(['purpose', 'agentType', 'model', 'tier', 'prompt', 'schema', 'scope']);

const CONTROL_CHAR = /[\x00-\x1f\x7f\u2028\u2029]/;

export interface ResolvedModel {
  model: string;
  tier: string;
}

export interface FanOutDispatch {
  purpose: DispatchPurpose;
  agentType: string;
  model: string;
  tier: string;
  prompt: string;
  schema: Record<string, unknown> | null;
  scope?: string[];
}

export interface FanOutPlanStage {
  id: string;
  dispatches: FanOutDispatch[];
}

export interface FanOutPlan {
  mode: 'fan-out';
  stage: FanOutStage;
  maxWorkers: number;
  maxConcurrency: number;
  stages: FanOutPlanStage[];
}

export interface ValidateFanOutPlanContext {
  /** Which `--stage` call this plan answers. */
  stage: FanOutStage;
  /** The step's own agent, the only allowed synthesizer (e.g. `gsd-phase-researcher`). */
  stepAgent: string;
  /** `resolve-model` for an agent. Returns null when the agent cannot be resolved. */
  resolveModel: (agentType: string) => ResolvedModel | null;
  /** Absolute project root every scope path must stay inside. */
  projectRoot: string;
  /** Dispatches this role run already spent before this call (the decomposition, if any). */
  priorDispatches?: number;
}

export type ValidateResult =
  | { ok: true; plan: FanOutPlan; dispatches: number }
  | { ok: false; reason: FanOutReason; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function invalid(detail: string): { ok: false; reason: FanOutReason; detail: string } {
  return { ok: false, reason: FAN_OUT_REASON.INVALID_PLAN, detail };
}

export type ScopePathResult =
  | { ok: true }
  | { ok: false; code: 'not_string' | 'control_char' | 'absolute' | 'dot_dot' | 'escapes_root' | 'missing' };

/**
 * ADR-4650 containment for a model-written path, in the two halves `validatePaths`
 * (src/reviewer-step-dispatch.cts) applies: a lexical check, then a realpath check so a symlink
 * whose own path is inside the root cannot point outside it. Stricter than that function in two
 * places, because these paths come from a model rather than from `git diff`: any `..` segment is
 * rejected even when it would resolve inside the root, and a path that does not exist is rejected
 * rather than skipped.
 */
export function checkScopePath(projectRoot: string, p: unknown): ScopePathResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, code: 'not_string' };
  if (CONTROL_CHAR.test(p)) return { ok: false, code: 'control_char' };
  if (path.isAbsolute(p) || path.win32.isAbsolute(p)) return { ok: false, code: 'absolute' };
  if (p.split(/[\\/]/).includes('..')) return { ok: false, code: 'dot_dot' };
  const root = path.resolve(projectRoot);
  if (tryWithinRootLexical(p, root) === null) return { ok: false, code: 'escapes_root' };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, code: 'missing' };
  }
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(root, p));
  } catch {
    return { ok: false, code: 'missing' };
  }
  if (tryWithinRootLexical(real, realRoot) === null) return { ok: false, code: 'escapes_root' };
  return { ok: true };
}

/** Whose resolved model and tier a dispatch of this purpose must carry (ADR-5273 Decision 9). */
function modelOwner(purpose: DispatchPurpose, stepAgent: string): string {
  return purpose === 'worker' ? FAN_OUT_WORKER_AGENT : stepAgent;
}

function validateDispatch(
  d: unknown,
  where: string,
  ctx: ValidateFanOutPlanContext,
): { ok: true; dispatch: FanOutDispatch } | { ok: false; reason: FanOutReason; detail: string } {
  if (!isPlainObject(d)) return invalid(`${where} is not an object`);
  for (const k of Object.keys(d)) {
    if ((EXECUTOR_ONLY_FIELDS as readonly string[]).includes(k)) return invalid(`${where} carries executor-only field ${k}`);
    if (!DISPATCH_KEYS.has(k)) return invalid(`${where} carries unknown field ${k}`);
  }
  const purpose = d['purpose'];
  if (typeof purpose !== 'string' || !(DISPATCH_PURPOSES as readonly string[]).includes(purpose)) {
    return invalid(`${where}.purpose is not one of ${DISPATCH_PURPOSES.join(', ')}`);
  }
  const p = purpose as DispatchPurpose;
  const expectedAgent = p === 'synthesizer' ? ctx.stepAgent : FAN_OUT_WORKER_AGENT;
  if (d['agentType'] !== expectedAgent) {
    return invalid(`${where}.agentType must be ${expectedAgent} for a ${p} dispatch`);
  }
  const owner = modelOwner(p, ctx.stepAgent);
  const resolved = ctx.resolveModel(owner);
  if (!resolved || typeof resolved.model !== 'string' || typeof resolved.tier !== 'string') {
    return invalid(`${where}: resolve-model returned nothing for ${owner}`);
  }
  if (d['model'] !== resolved.model || d['tier'] !== resolved.tier) {
    return invalid(`${where}: model/tier differ from resolve-model ${owner}`);
  }
  const prompt = d['prompt'];
  if (typeof prompt !== 'string' || prompt.length === 0) return invalid(`${where}.prompt is not a non-empty string`);
  if (byteLength(prompt) > PROMPT_MAX_BYTES) return invalid(`${where}.prompt exceeds ${PROMPT_MAX_BYTES} bytes`);
  const schema = d['schema'];
  if (p === 'synthesizer') {
    if (schema !== null && schema !== undefined) return invalid(`${where}.schema must be null for the synthesizer`);
  } else {
    if (!isPlainObject(schema)) return invalid(`${where}.schema is not an object`);
    let json: string;
    try {
      json = JSON.stringify(schema);
    } catch {
      return invalid(`${where}.schema is not serializable`);
    }
    if (byteLength(json) > SCHEMA_MAX_BYTES) return invalid(`${where}.schema exceeds ${SCHEMA_MAX_BYTES} bytes`);
  }
  const scope = d['scope'];
  const needsScope = p === 'worker' || p === 'cross-file';
  if (needsScope) {
    if (!Array.isArray(scope) || scope.length === 0) return invalid(`${where}.scope is not a non-empty array`);
    if (scope.length > SCOPE_MAX_PATHS) return invalid(`${where}.scope exceeds ${SCOPE_MAX_PATHS} paths`);
    for (let i = 0; i < scope.length; i++) {
      const r = checkScopePath(ctx.projectRoot, scope[i]);
      if (!r.ok) return invalid(`${where}.scope[${i}] rejected: ${r.code}`);
    }
  } else if (scope !== undefined) {
    return invalid(`${where}.scope is only allowed on worker and cross-file dispatches`);
  }
  return {
    ok: true,
    dispatch: {
      purpose: p,
      agentType: expectedAgent,
      model: resolved.model,
      tier: resolved.tier,
      prompt,
      schema: p === 'synthesizer' ? null : (schema as Record<string, unknown>),
      ...(needsScope ? { scope: [...(scope as string[])] } : {}),
    },
  };
}

function validateStage(
  s: unknown,
  index: number,
  ctx: ValidateFanOutPlanContext,
): { ok: true; stage: FanOutPlanStage } | { ok: false; reason: FanOutReason; detail: string } {
  const where = `stages[${index}]`;
  if (!isPlainObject(s)) return invalid(`${where} is not an object`);
  for (const k of Object.keys(s)) {
    if ((EXECUTOR_ONLY_FIELDS as readonly string[]).includes(k)) return invalid(`${where} carries executor-only field ${k}`);
    if (!STAGE_KEYS.has(k)) return invalid(`${where} carries unknown field ${k}`);
  }
  if (typeof s['id'] !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(s['id'])) return invalid(`${where}.id is not a slug`);
  const dispatches = s['dispatches'];
  if (!Array.isArray(dispatches) || dispatches.length === 0) return invalid(`${where}.dispatches is not a non-empty array`);
  const out: FanOutDispatch[] = [];
  for (let i = 0; i < dispatches.length; i++) {
    const r = validateDispatch(dispatches[i], `${where}.dispatches[${i}]`, ctx);
    if (!r.ok) return r;
    out.push(r.dispatch);
  }
  return { ok: true, stage: { id: s['id'], dispatches: out } };
}

/**
 * Validate a plan a `fanOutStrategy` command returned. Checks run in a fixed order so each
 * boundary has one verdict: every structural and trust check (`invalid_plan`), then the unit
 * count (`too_few_units`), then the agent budget (`over_agent_budget`).
 */
export function validateFanOutPlan(plan: unknown, ctx: ValidateFanOutPlanContext): ValidateResult {
  if (!isPlainObject(plan)) return invalid('plan is not an object');
  for (const k of Object.keys(plan)) {
    if ((EXECUTOR_ONLY_FIELDS as readonly string[]).includes(k)) return invalid(`plan carries executor-only field ${k}`);
    if (!PLAN_KEYS.has(k)) return invalid(`plan carries unknown field ${k}`);
  }
  if (plan['mode'] !== 'fan-out') return invalid('plan.mode is not "fan-out"');
  if (plan['stage'] !== ctx.stage) return invalid(`plan.stage is not "${ctx.stage}"`);
  const maxWorkers = plan['maxWorkers'];
  if (typeof maxWorkers !== 'number' || !Number.isSafeInteger(maxWorkers) || maxWorkers < MIN_WORKERS) {
    return invalid(`plan.maxWorkers is not an integer of at least ${MIN_WORKERS}`);
  }
  const maxConcurrency = plan['maxConcurrency'];
  if (typeof maxConcurrency !== 'number' || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    return invalid('plan.maxConcurrency is not an integer of at least 1');
  }
  const rawStages = plan['stages'];
  if (!Array.isArray(rawStages)) return invalid('plan.stages is not an array');
  const stages: FanOutPlanStage[] = [];
  for (let i = 0; i < rawStages.length; i++) {
    const r = validateStage(rawStages[i], i, ctx);
    if (!r.ok) return r;
    stages.push(r.stage);
  }

  const purposesOf = (st: FanOutPlanStage): DispatchPurpose[] => st.dispatches.map((d) => d.purpose);
  let workerCount = 0;
  if (ctx.stage === 'decompose') {
    if (stages.length !== 1) return invalid('a decompose plan has exactly one stage');
    const ps = purposesOf(stages[0]);
    if (ps.length !== 1 || ps[0] !== 'decompose') return invalid('a decompose plan holds exactly one decompose dispatch');
  } else {
    if (stages.length !== 2) return invalid('a fan-out plan has exactly two stages: workers, then synthesize');
    const workerPs = purposesOf(stages[0]);
    if (workerPs.some((x) => x !== 'worker' && x !== 'cross-file')) return invalid('stages[0] holds only worker and cross-file dispatches');
    if (workerPs.filter((x) => x === 'cross-file').length > 1) return invalid('stages[0] holds at most one cross-file dispatch');
    workerCount = workerPs.filter((x) => x === 'worker').length;
    const synthPs = purposesOf(stages[1]);
    if (synthPs.length !== 1 || synthPs[0] !== 'synthesizer') return invalid('stages[1] holds exactly one synthesizer dispatch');
    if (workerCount > maxWorkers) return invalid(`plan has ${workerCount} worker units, more than maxWorkers ${maxWorkers}`);
    if (workerCount < MIN_WORKERS) {
      return { ok: false, reason: FAN_OUT_REASON.TOO_FEW_UNITS, detail: `plan has ${workerCount} worker unit(s); at least ${MIN_WORKERS} are needed` };
    }
  }

  const prior = Number.isSafeInteger(ctx.priorDispatches) && (ctx.priorDispatches as number) > 0 ? (ctx.priorDispatches as number) : 0;
  const dispatches = stages.reduce((n, st) => n + st.dispatches.length, 0);
  const total = prior + dispatches + RESERVED_FALLBACK_DISPATCHES;
  const budget = agentBudget(maxWorkers);
  if (total > budget) {
    return {
      ok: false,
      reason: FAN_OUT_REASON.OVER_AGENT_BUDGET,
      detail: `${prior} prior + ${dispatches} planned + ${RESERVED_FALLBACK_DISPATCHES} reserved fallback = ${total} > maxWorkers ${maxWorkers} + ${AGENT_OVERHEAD} = ${budget}`,
    };
  }

  return { ok: true, plan: { mode: 'fan-out', stage: ctx.stage, maxWorkers, maxConcurrency, stages }, dispatches };
}

/** A strategy's quiet or loud refusal: `{ "mode": "single", "reason": "<code>" }`. */
export function readStrategySingle(answer: unknown): { reason: string } | null {
  if (!isPlainObject(answer) || answer['mode'] !== 'single') return null;
  const reason = answer['reason'];
  return { reason: typeof reason === 'string' && STRATEGY_REASON_RE.test(reason) ? reason : FAN_OUT_REASON.STRATEGY_FAILED };
}

export interface ConcurrencyInput {
  /** `dispatch-capacity`'s resolved value for this runtime. */
  dispatchCapacity: number;
  /** The validated plan's `maxConcurrency` (the strategy's `swarm.max_concurrency`). */
  maxConcurrency: number;
  /** The validated plan's `maxWorkers`. */
  maxWorkers: number;
}

export type ConcurrencyResult =
  | { ok: true; c: number; terms: { dispatchCapacity: number; maxConcurrency: number; maxWorkers: number } }
  | { ok: false; reason: FanOutReason; detail: string };

/**
 * ADR-5273 Decision 2: C = min(dispatch-capacity, maxConcurrency, maxWorkers). Workers run in waves
 * of at most C per message. A C below 2 cannot fan out at all.
 */
export function resolveConcurrency(input: ConcurrencyInput): ConcurrencyResult {
  const cap = Number.isSafeInteger(input.dispatchCapacity) && input.dispatchCapacity > 0 ? input.dispatchCapacity : 1;
  const terms = { dispatchCapacity: cap, maxConcurrency: input.maxConcurrency, maxWorkers: input.maxWorkers };
  const c = Math.min(terms.dispatchCapacity, terms.maxConcurrency, terms.maxWorkers);
  if (!(c >= 2)) {
    return {
      ok: false,
      reason: FAN_OUT_REASON.NO_CONCURRENCY,
      detail: `C = min(dispatch-capacity ${terms.dispatchCapacity}, maxConcurrency ${terms.maxConcurrency}, maxWorkers ${terms.maxWorkers}) = ${c}`,
    };
  }
  return { ok: true, c, terms };
}

/**
 * Reasons that mean "the user did not ask for a fan-out here", so the caller prints nothing
 * (ADR-5273 Decision 6, the two un-loud rungs, plus the two seam-level equivalents: the step did
 * not opt in, or no fan-out capability is installed and active).
 */
export const QUIET_SINGLE_REASONS: ReadonlySet<string> = new Set([
  FAN_OUT_REASON.NO_FAN_OUT_TRAIT,
  FAN_OUT_REASON.NO_STRATEGY,
  'disabled',
  'role_not_selected',
]);

export interface FanOutStrategyRef {
  capId: string;
  command: string;
}

export interface PlanFanOutInput {
  stage: FanOutStage;
  /** The agent the role would dispatch single-agent; the only allowed synthesizer. */
  stepAgent: string;
  projectRoot: string;
  /** True when a decomposition already ran for this role run (`--units` was passed). */
  decomposed: boolean;
}

export interface PlanFanOutDeps {
  /** Did the step at `--cap-id`/`--point` declare `supportsFanOut: true`, and which strategies are active? */
  resolveStep: () => { trait: boolean; strategies: FanOutStrategyRef[] };
  /** Run the strategy's command; returns its parsed JSON answer or a failure detail. */
  invokeStrategy: (strategy: FanOutStrategyRef) => { ok: true; answer: unknown } | { ok: false; detail: string };
  parallelizationEnabled: () => boolean;
  namedDispatch: () => boolean;
  dispatchCapacity: () => { capacity: number; source: string; reason: string };
  resolveModel: (agentType: string) => ResolvedModel | null;
}

export type PlanFanOutResult =
  | {
      mode: 'fan-out';
      stage: FanOutStage;
      strategy: FanOutStrategyRef;
      plan: FanOutPlan;
      dispatches: number;
      reservedFallback: number;
      concurrency: { c: number; terms: { dispatchCapacity: number; maxConcurrency: number; maxWorkers: number }; capacitySource: string; capacityReason: string };
      answerMaxBytes: number;
    }
  | { mode: 'single'; reason: string; loud: boolean; detail?: string; strategy?: FanOutStrategyRef };

function single(reason: string, detail?: string, strategy?: FanOutStrategyRef): PlanFanOutResult {
  return {
    mode: 'single',
    reason,
    loud: !QUIET_SINGLE_REASONS.has(reason),
    ...(detail !== undefined ? { detail } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
  };
}

/**
 * `gsd_run loop fan-out-plan`, minus argv parsing and I/O. The plan-time ladder of ADR-5273
 * Decision 6 runs in this order, and the first miss wins:
 *
 * 1. the step's `supportsFanOut` trait (quiet), 2. exactly one active strategy (none is quiet),
 * 3. the strategy's own answer (its `disabled` / `role_not_selected` are quiet), 4. the boolean
 * `parallelization`, 5. named dispatch, 6. plan validation, 7. C >= 2.
 *
 * Plan validation runs before C because two of C's terms are the plan's own `maxConcurrency` and
 * `maxWorkers`. The
 * strategy runs before the config rungs so a user who never enabled the strategy sees nothing.
 */
export function planFanOut(input: PlanFanOutInput, deps: PlanFanOutDeps): PlanFanOutResult {
  const step = deps.resolveStep();
  if (!step.trait) return single(FAN_OUT_REASON.NO_FAN_OUT_TRAIT);
  if (step.strategies.length === 0) return single(FAN_OUT_REASON.NO_STRATEGY);
  if (step.strategies.length > 1) {
    return single(FAN_OUT_REASON.AMBIGUOUS_STRATEGY, `active strategies: ${step.strategies.map((x) => x.capId).sort().join(', ')}`);
  }
  const strategy = step.strategies[0];

  const invoked = deps.invokeStrategy(strategy);
  if (!invoked.ok) return single(FAN_OUT_REASON.STRATEGY_FAILED, invoked.detail, strategy);
  const declined = readStrategySingle(invoked.answer);
  if (declined) return single(declined.reason, undefined, strategy);

  if (!deps.parallelizationEnabled()) return single(FAN_OUT_REASON.PARALLELIZATION_DISABLED, undefined, strategy);
  if (!deps.namedDispatch()) return single(FAN_OUT_REASON.NO_NAMED_DISPATCH, undefined, strategy);

  const validated = validateFanOutPlan(invoked.answer, {
    stage: input.stage,
    stepAgent: input.stepAgent,
    resolveModel: deps.resolveModel,
    projectRoot: input.projectRoot,
    priorDispatches: input.decomposed ? 1 : 0,
  });
  if (!validated.ok) return single(validated.reason, validated.detail, strategy);

  const cap = deps.dispatchCapacity();
  const conc = resolveConcurrency({ dispatchCapacity: cap.capacity, maxConcurrency: validated.plan.maxConcurrency, maxWorkers: validated.plan.maxWorkers });
  if (!conc.ok) return single(conc.reason, `${conc.detail} (dispatch-capacity source ${cap.source}, reason ${cap.reason})`, strategy);

  return {
    mode: 'fan-out',
    stage: input.stage,
    strategy,
    plan: validated.plan,
    dispatches: validated.dispatches,
    reservedFallback: RESERVED_FALLBACK_DISPATCHES,
    concurrency: { c: conc.c, terms: conc.terms, capacitySource: cap.source, capacityReason: cap.reason },
    answerMaxBytes: ANSWER_MAX_BYTES,
  };
}
