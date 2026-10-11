/**
 * Claude Orchestration Capability — Workflow-tool backend detection + emitter
 *
 * #1143 — adopts Claude Code's Workflow tool (the engine behind `/effort ultracode`)
 * as an optional, runtime-gated parallel-execution backend for the GSD loop.
 *
 * This module is the pure, testable core of the capability. It owns two seams:
 *
 *   detectWorkflowBackend({ runtimeId, hostIntegration, config, agentSdkVersion })
 *     → { available: boolean, backend: 'workflow'|'inline', reason: string }
 *     Fail-closed: every miss degrades to `inline` (today's behaviour), so the
 *     core loop is byte-identical unless every gate opens. This is criteria 3 + 6.
 *
 *   emitWorkflowScript({ phaseDir, waves, runId, budgetTokens? })
 *     → { ok:true, script, summary } | { ok:false, reason }
 *     Maps GSD's wave/plan model 1:1 onto Workflow primitives:
 *       wave  → sequential `parallel()` stage barriers,
 *       plan  → `agent(brief, { agentType:'gsd-executor', isolation:'worktree' })`
 *         — UNLESS the plan's `use_worktree` is explicitly `false`, in which case
 *         `isolation` is omitted entirely for that plan (#2772 / #2285 finding 1:
 *         a submodule-touching plan must never be forced into worktree isolation
 *         the inline path (execute-phase.md step 2.5) would keep it out of),
 *       files_modified overlap → forces plans into separate sequential stages
 *         (the same overlap rule execute-phase already applies inline),
 *       resumeFromRunId → wired to the phase run id,
 *       budgetTokens → a shared token pool.
 *     The emitted script composes the SAME gsd-executor agent the inline path
 *     uses, with per-plan worktree isolation mirroring the inline path's own
 *     per-plan decision, so it produces the same artifacts/commits (criterion 2).
 *     It is a generated string consumed by the orchestrator; this module never
 *     invokes the Workflow tool itself.
 *
 * Design laws:
 *   - Gall's Law: ship a small working slice that composes existing primitives
 *     (gsd-executor + worktree isolation) rather than reinventing them.
 *   - Greenspun's Tenth Rule (cited in #1143): adopt the Workflow tool's
 *     barrier/pipeline/budget/resume semantics instead of hand-rolling them.
 *   - Postel's Law: liberal in input (missing fields → inline), conservative in
 *     output (workflow only when every gate opens).
 *   - Fail-closed: an unknown version, a missing descriptor, or a disabled
 *     toggle all resolve to `inline`, never to `workflow`.
 *
 * Zero external dependencies. Pure functions. Never throws on bad input.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- file-overlap-partitioner.cjs is an export= CommonJS module
import fileOverlapPartitionerMod = require('./file-overlap-partitioner.cjs');
const { partitionByFileOverlap } = fileOverlapPartitionerMod;
import type { RenderableDispatch, RenderablePlan, RenderableStage } from './fan-out-plan.cjs';
import { EXECUTOR_ONLY_FIELDS } from './fan-out-plan.cjs';

/**
 * Dispatch fields a strategy's fan-out plan may never carry into a render: core's executor-only
 * fields plus `id`, which only the wave adapter sets (it names a plan in the worktree result).
 */
const FAN_OUT_REFUSED_DISPATCH_FIELDS: readonly string[] = [...EXECUTOR_ONLY_FIELDS, 'id'];

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The Agent SDK version that introduced the Workflow tool (#1143 prior art).
 * Used as the default floor when config does not override it. A runtime reporting
 * an agentSdkVersion below this cannot host the Workflow backend.
 */
const WORKFLOW_TOOL_FLOOR_VERSION = '0.3.149';

/** Closed enum for the `claude_orchestration.execution_backend` config key. */
const BACKEND_VALUES = new Set<string>(['auto', 'workflow', 'inline']);

/** Only this runtime can host the Workflow tool (Claude Code / Agent SDK). */
const WORKFLOW_RUNTIME = 'claude';

// ─── Semver helpers ───────────────────────────────────────────────────────────

/** Official-ish strict SemVer 2.0.0 numeric triple (+ optional pre/build). */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True for a syntactically valid semver string. */
function isValidSemver(s: unknown): s is string {
  return typeof s === 'string' && SEMVER_RE.test(s);
}

/**
 * Compare two semver strings.
 * Returns -1/0/1 in the usual sense. Garbage in either position → -1 (fail-closed:
 * an unparseable version is treated as "less than" any real floor, so detection
 * never accidentally enables the preview backend on an unknown SDK).
 *
 * Pre-release/build metadata are ignored for the comparison — only the numeric
 * major.minor.patch triple participates, matching how the Workflow-tool floor is
 * specified (a plain "0.3.149").
 */
function compareSemver(a: string, b: string): number {
  if (!isValidSemver(a) || !isValidSemver(b)) return -1;
  // Split numeric triple from pre-release/build metadata.
  const parseTriple = (s: string): number[] => {
    const core = s.split('-')[0].split('+')[0].split('.');
    return [parseInt(core[0], 10), parseInt(core[1], 10), parseInt(core[2], 10)];
  };
  const hasPre = (s: string): boolean => s.indexOf('-') !== -1;
  const preIdentifiers = (s: string): string[] => (s.split('-')[1] || '').split('+')[0].split('.').filter((x) => x.length > 0);
  const am = parseTriple(a);
  const bm = parseTriple(b);
  for (let i = 0; i < 3; i++) {
    if (am[i] < bm[i]) return -1;
    if (am[i] > bm[i]) return 1;
  }
  // Numeric triple is equal. SemVer 2.0.0 §11 precedence:
  //   - a version WITH a pre-release tag is LOWER than the same triple WITHOUT one
  //     (keeps the floor fail-closed for pre-release builds of the GA floor);
  //   - two pre-releases of the same triple are ordered by their dot-separated
  //     identifiers (numeric < alphanumeric; numeric compared numerically,
  //     alphanumeric lexically; fewer identifiers < more).
  const aPre = hasPre(a);
  const bPre = hasPre(b);
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) {
    const ai = preIdentifiers(a);
    const bi = preIdentifiers(b);
    const len = Math.min(ai.length, bi.length);
    for (let i = 0; i < len; i++) {
      const ax = ai[i];
      const bx = bi[i];
      const aNum = /^\d+$/.test(ax);
      const bNum = /^\d+$/.test(bx);
      if (aNum && bNum) {
        const an = parseInt(ax, 10);
        const bn = parseInt(bx, 10);
        if (an < bn) return -1;
        if (an > bn) return 1;
      } else if (aNum && !bNum) {
        return -1; // numeric identifiers always lower than alphanumeric
      } else if (!aNum && bNum) {
        return 1;
      } else {
        if (ax < bx) return -1;
        if (ax > bx) return 1;
      }
    }
    if (ai.length < bi.length) return -1;
    if (ai.length > bi.length) return 1;
  }
  return 0;
}

// ─── detectWorkflowBackend ────────────────────────────────────────────────────

interface HostIntegration {
  dispatch?: {
    nested?: boolean;
    background?: boolean;
    backgroundDispatch?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface BackendConfig {
  'claude_orchestration.enabled'?: unknown;
  'claude_orchestration.execution_backend'?: unknown;
  'claude_orchestration.min_agent_sdk_version'?: unknown;
  [k: string]: unknown;
}

interface DetectInput {
  runtimeId?: string;
  hostIntegration?: HostIntegration | null;
  config?: BackendConfig | null;
  agentSdkVersion?: string;
}

interface DetectResult {
  available: boolean;
  backend: 'workflow' | 'inline';
  reason: string;
}

/** Inline result shorthand. */
function inline(reason: string, available = false): DetectResult {
  return { available, backend: 'inline', reason };
}

/**
 * Resolve whether the Workflow-tool backend should activate.
 *
 * Gate ladder (all must pass for `workflow`; first miss wins, fail-closed):
 *   1. capability enabled (claude_orchestration.enabled truthy)
 *   2. runtime is Claude (the only runtime that exposes the Workflow tool)
 *   3. execution_backend !== 'inline'
 *   4. host descriptor signals nested+background dispatch (Workflow-tool capable)
 *   5. agentSdkVersion is a known, valid semver
 *   6. agentSdkVersion >= the configured floor (default WORKFLOW_TOOL_FLOOR_VERSION)
 *   7. execution_backend === 'workflow' OR 'auto' (both reach here; 'inline' exited at 3)
 *
 * Never throws. Destructures defensively.
 */
function detectWorkflowBackend(input: DetectInput | null | undefined): DetectResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return inline('capability_disabled');
  }

  const cfg: BackendConfig =
    (input.config !== null && input.config !== undefined && typeof input.config === 'object')
      ? input.config
      : {};

  // 1. capability must be opted in (default-off — ships disabled).
  if (!cfg['claude_orchestration.enabled']) {
    return inline('capability_disabled');
  }

  // 2. only Claude can host the Workflow tool.
  if (input.runtimeId !== WORKFLOW_RUNTIME) {
    return inline('runtime_not_claude');
  }

  // 3. explicit inline opt-out short-circuits.
  let backendRaw = cfg['claude_orchestration.execution_backend'];
  if (typeof backendRaw !== 'string' || !BACKEND_VALUES.has(backendRaw)) {
    backendRaw = 'auto';
  }
  if (backendRaw === 'inline') {
    return inline('backend_inline');
  }

  // 4. the host dispatch descriptor must be the nesting-capable Claude-Code shape
  //    (a proxy for Workflow-tool presence). This is Claude-specific and already
  //    gated at step 2; `background:true` alone is true on several non-Claude hosts,
  //    so the proxy is only meaningful after the runtime check above. Note: this is
  //    NOT the canonical `shouldFlattenDispatch` rule (which keys on
  //    `backgroundDispatch`); the Workflow backend works precisely because a single
  //    tool-call orchestrates internally, sidestepping the backgroundDispatch:false
  //    limitation. Missing/false/foreign descriptor → fail-closed.
  const hi = input.hostIntegration;
  if (hi === null || hi === undefined || typeof hi !== 'object' || Array.isArray(hi)) {
    return inline('workflow_tool_unavailable');
  }
  const dispatch = (hi as { dispatch?: Record<string, unknown> }).dispatch;
  if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) {
    return inline('workflow_tool_unavailable');
  }
  const nested = dispatch['nested'];
  const background = dispatch['background'];
  if (nested !== true || background !== true) {
    return inline('workflow_tool_unavailable');
  }

  // 5. an unknown agentSdkVersion cannot be trusted to meet the floor.
  if (!isValidSemver(input.agentSdkVersion)) {
    return inline('agent_sdk_version_unknown');
  }

  // 6. version floor (config override > default constant).
  const floorRaw = cfg['claude_orchestration.min_agent_sdk_version'];
  const floor = typeof floorRaw === 'string' && isValidSemver(floorRaw) ? floorRaw : WORKFLOW_TOOL_FLOOR_VERSION;
  if (compareSemver(input.agentSdkVersion, floor) < 0) {
    return inline('agent_sdk_version_below_floor');
  }

  // 7. auto/workflow both reach the workflow backend once every gate passes.
  return { available: true, backend: 'workflow', reason: 'workflow_backend_active' };
}

// ─── emitWorkflowScript ───────────────────────────────────────────────────────

interface Plan {
  id: string;
  brief: string;
  files_modified: string[];
  /**
   * #2772 / #2285 finding 1 — mirrors execute-phase.md step 2.5's
   * `USE_WORKTREES_FOR_PLAN` (per-plan submodule-intersection + project-level
   * `workflow.use_worktrees` gate). The inline dispatch path in step 3 omits
   * `isolation="worktree"` for a plan that touches a submodule path (the
   * executor commit protocol cannot correctly handle submodule commits inside
   * an isolated worktree). The Workflow backend MUST honor the SAME per-plan
   * decision — it must never force worktree isolation on a plan the inline
   * path would keep out of worktrees.
   *
   * Optional, defaults to `true` (preserves prior behavior for callers that
   * don't populate it — e.g. a manifest with no submodule paths at all).
   * Only an explicit `false` omits `isolation: "worktree"` for that plan.
   */
  use_worktree?: boolean;
}

interface Wave {
  id: string;
  plans: Plan[];
}

interface EmitInput {
  phaseDir: string;
  waves: Wave[];
  runId: string;
  budgetTokens?: number;
  /**
   * #2686 — the resolved `gsd-executor` model, threaded so this backend honors
   * model_overrides / model_policy / model_profile exactly as the inline path
   * does. Omitted from the emitted options when it is `"inherit"`, empty, or not
   * a string (#2517: an empty model 404s on runtimes without native tier
   * aliases). When absent the emitted script is byte-identical to pre-#2686.
   */
  executorModel?: string;
}

interface EmitOk {
  ok: true;
  script: string;
  summary: {
    waves: number;
    plans: number;
    /**
     * #3302 — the number of record-agent entries the orchestrator must end up
     * with in WAVE_WORKTREE_MANIFEST after the run (plans with `use_worktree`
     * not `false`). The loud count check: fewer entries than this after the
     * Workflow run means metadata capture failed and the wave must HALT.
     */
    worktreePlans: number;
    stagesByWave: string[][][]; // wave → stage → planId[]
    resumeRunId: string;
    budgetTokens: number | null;
  };
}

interface EmitErr {
  ok: false;
  reason: string;
}

/**
 * Partition a wave's plans into a near-minimal number of sequential stages (via
 * greedy first-fit — not guaranteed optimal for arbitrary overlap graphs, but
 * correct: no two plans sharing a file ever cohabit a stage) such that no two
 * plans in the same stage share a modified file. Each plan goes into the earliest
 * stage where it does not overlap any plan already there.
 *
 * A plan with an EMPTY files_modified set declares no files; it overlaps nothing
 * and coalesces into stage 0 (same behavior as the inline path, which also cannot
 * guard against undeclared concurrent writes — declare filesModified accurately).
 *
 * This is the same overlap rule execute-phase applies inline — the only difference
 * is the execution vehicle (Workflow `parallel()` vs one-agent-per-message).
 *
 * #3674: the algorithm itself now lives in the generic, dependency-free
 * `file-overlap-partitioner.cts` module (`partitionByFileOverlap`) — this is a
 * thin adapter mapping this module's own `Plan[]` shape onto that module's
 * generic `{ id, files }[]` input and back. Behavior-preserving extraction:
 * same greedy first-fit algorithm, same output, only the implementation moved.
 */
function partitionStages(plans: Plan[]): string[][] {
  return partitionByFileOverlap(plans.map((p) => ({ id: p.id, files: p.files_modified })));
}

/**
 * Quote a free-text value for safe embedding as a JavaScript/Workflow double-quoted
 * string literal. Uses JSON.stringify so every JS-relevant escape (backslash, quote,
 * newline, tab, NUL, U+2028/U+2029, all control chars) is handled by the language
 * itself — there is no hand-rolled escape table to drift. Returns the value already
 * wrapped in its surrounding quotes.
 */
function quoteString(s: string): string {
  return JSON.stringify(s);
}

/**
 * #2686 — the single decision of whether a resolved executor model is emittable,
 * and what to emit. Shared by `agentOptions` (the emission) and the provenance
 * comment (the claim about it) so the two can never disagree — a generated
 * comment asserting something the generator does not actually do is the exact
 * failure #2686 was filed for.
 *
 * Returns the model to emit, or `undefined` for "emit nothing":
 *   - non-string        → malformed config; omit rather than throw, matching the
 *                         defensive typeof guard `mapClaudeOverrideForRuntime`
 *                         already carries in model-resolver for the same reason.
 *   - empty/whitespace  → #2517: emitting `model: ""` 404s on runtimes without
 *                         native tier aliases. Trimmed, so `" "` is also "none".
 *   - "inherit"         → same rule; matched case-insensitively after trimming,
 *                         since config is user-authored free text.
 *
 * NOTE it does NOT reject unscriptable characters — that is a hard input error,
 * not a silent omission, and is rejected up front by `emitWorkflowScript` so the
 * caller sees a reason instead of quietly losing their model routing.
 */
function emittableModel(executorModel: unknown): string | undefined {
  if (typeof executorModel !== 'string') return undefined;
  const trimmed = executorModel.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.toLowerCase() === 'inherit') return undefined;
  return trimmed;
}

/**
 * Render the `agent()` options object for one dispatch. `isolation: "worktree"` is emitted only
 * when the dispatch carries it, and only `wavesToFanOutPlan` sets it, from a plan's
 * `use_worktree` (#2772 / #2285 finding 1): that adapter is the single place that decides worktree
 * isolation for the Workflow backend, and it must never diverge from the inline path's per-plan gate.
 */
function dispatchOptions(d: RenderableDispatch): string {
  const parts = ['agentType: ' + quoteString(d.agentType)];
  if (d.isolation === 'worktree') parts.push('isolation: "worktree"');
  // #2686: carry the resolved model so this backend honors model_overrides / model_policy /
  // model_profile exactly as the inline path.
  const model = emittableModel(d.model);
  if (model !== undefined) parts.push('model: ' + quoteString(model));
  return '{ ' + parts.join(', ') + ' }';
}

/**
 * True if `s` is a safe identifier/path token to interpolate into the generated
 * script WITHOUT requiring a string-literal context — i.e. it contains no
 * character that could terminate a comment line (`\n`/`\r`), break out of a
 * string literal (`"` / `\`), or smuggle a NUL/control sequence. Used for
 * `phaseDir`, `runId`, `wave.id`, and `plan.id`, which are identifiers/paths and
 * must never legitimately contain such characters. Rejecting them at validation
 * (rather than silently flattening) keeps the emitted script faithful to input.
 */
const UNSCRIPTABLE_CHAR_RE = /[\r\n"\\\x00-\x1f\x7f\u2028\u2029]/;
function isScriptableIdentifier(s: unknown): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  return !UNSCRIPTABLE_CHAR_RE.test(s);
}

// ─── renderFanOutPlan / wavesToFanOutPlan (ADR-5273 Decision 1, step 5) ─────

/** A line terminator ends a `//` comment, so text bound for a comment may carry none. */
const LINE_TERMINATOR_RE = /[\r\n\u2028\u2029]/;

interface RenderPhase {
  title: string;
  detail: string;
}

interface RenderOptions {
  /** `meta.name` of the script. */
  name: string;
  /** `meta.description` of the script. */
  description: string;
  /** Header comment lines, without the `//`. An empty string renders a bare `//`. */
  header: string[];
  /**
   * `meta.phases`, in order. Every stage names one of them through `phase` (default: its `id`).
   * When absent, each distinct stage phase becomes one, with a dispatch count as its detail.
   */
  phases?: RenderPhase[];
  /**
   * The most `agent()` calls one `parallel()` barrier may hold. A larger stage is rendered as
   * sequential batches. Absent: one barrier per stage, however large.
   */
  concurrency?: number;
}

type RenderResult = { ok: true; script: string } | { ok: false; reason: string };

/**
 * The one Workflow-script emitter (ADR-5273 Decision 1). It decides nothing about what to
 * dispatch: the plan's owner does (execute-phase's waves through `wavesToFanOutPlan`, a swarm
 * strategy's fan-out plan as `loop fan-out-plan` returned it). Pure and deterministic. Every
 * value it interpolates outside a string literal is checked first, so a hostile id or comment
 * cannot become live script.
 *
 * Each dispatch result is returned to the orchestrator: a `worktree_metadata` dispatch as
 * `{ plan, expects_worktree, metadata }` (#3302), any other as `{ purpose, text }`, the shape
 * `swarm check-answers --answers` reads.
 */
function renderFanOutPlan(plan: RenderablePlan | null | undefined, opts: RenderOptions | null | undefined): RenderResult {
  if (plan === null || plan === undefined || typeof plan !== 'object' || !Array.isArray(plan.stages) || plan.stages.length === 0) {
    return { ok: false, reason: 'plan must have a non-empty stages array' };
  }
  if (opts === null || opts === undefined || typeof opts !== 'object') return { ok: false, reason: 'invalid_options' };
  if (typeof opts.name !== 'string' || typeof opts.description !== 'string') return { ok: false, reason: 'name and description must be strings' };
  if (!Array.isArray(opts.header) || opts.header.some((h) => typeof h !== 'string' || LINE_TERMINATOR_RE.test(h))) {
    return { ok: false, reason: 'header must be an array of single-line strings' };
  }
  const concurrency = opts.concurrency;
  if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    return { ok: false, reason: 'concurrency must be a positive integer if present' };
  }

  // Group stages by phase. A phase's stages must be contiguous, or its progress group would split.
  const groups: Array<{ title: string; stages: RenderableStage[] }> = [];
  for (let si = 0; si < plan.stages.length; si++) {
    const st = plan.stages[si];
    if (st === null || typeof st !== 'object' || !isScriptableIdentifier(st.id)) {
      return { ok: false, reason: 'stages[' + si + '].id must be a non-empty string without newlines/quotes/backslash/control chars' };
    }
    const title = st.phase === undefined ? st.id : st.phase;
    if (!isScriptableIdentifier(title)) return { ok: false, reason: 'stages[' + si + '].phase must not contain newlines/quotes/backslash/control chars' };
    if (st.comment !== undefined && (typeof st.comment !== 'string' || LINE_TERMINATOR_RE.test(st.comment))) {
      return { ok: false, reason: 'stages[' + si + '].comment must be a single-line string' };
    }
    if (!Array.isArray(st.dispatches) || st.dispatches.length === 0) return { ok: false, reason: 'stages[' + si + '] must have a non-empty dispatches array' };
    for (let di = 0; di < st.dispatches.length; di++) {
      const d = st.dispatches[di];
      const at = 'stages[' + si + '].dispatches[' + di + ']';
      if (d === null || typeof d !== 'object' || typeof d.prompt !== 'string' || !isScriptableIdentifier(d.agentType) || !isScriptableIdentifier(d.purpose)) {
        return { ok: false, reason: at + ' must be { purpose, agentType, prompt } with scriptable purpose and agentType' };
      }
      if (typeof d.model === 'string' && UNSCRIPTABLE_CHAR_RE.test(d.model)) {
        return { ok: false, reason: at + '.model must not contain newlines/quotes/backslash/control/line-separator chars' };
      }
      if (d.isolation !== undefined && d.isolation !== 'worktree') return { ok: false, reason: at + '.isolation must be "worktree" if present' };
      if (d.resultContract !== undefined && d.resultContract !== 'worktree_metadata') {
        return { ok: false, reason: at + '.resultContract must be "worktree_metadata" if present' };
      }
      if (d.resultContract === 'worktree_metadata' && !isScriptableIdentifier(d.id)) {
        return { ok: false, reason: at + '.id is required, and must be scriptable, for a worktree_metadata result' };
      }
    }
    const last = groups[groups.length - 1];
    if (last !== undefined && last.title === title) {
      last.stages.push(st);
    } else {
      if (groups.some((g) => g.title === title)) return { ok: false, reason: 'phase "' + title + '" is split by another phase; its stages must be contiguous' };
      groups.push({ title, stages: [st] });
    }
  }

  let phases: RenderPhase[];
  if (opts.phases === undefined) {
    phases = groups.map((g) => ({ title: g.title, detail: g.stages.reduce((n, st) => n + st.dispatches.length, 0) + ' dispatch(es)' }));
  } else {
    if (!Array.isArray(opts.phases) || opts.phases.length !== groups.length
      || opts.phases.some((ph, i) => ph === null || typeof ph !== 'object' || ph.title !== groups[i].title || typeof ph.detail !== 'string')) {
      return { ok: false, reason: 'phases must list every stage phase once, in stage order, each with a string detail' };
    }
    phases = opts.phases;
  }

  const lines: string[] = [];
  // `export const meta = {…}` MUST be the first statement in the script — the
  // Workflow tool rejects the whole script otherwise (#2590). Leading comments
  // are not statements, but the meta block is emitted first regardless so the
  // contract holds under the strictest reading of "first statement".
  //
  // meta.phases must be a PURE LITERAL (no variables, calls, spreads, or
  // template interpolation), and its titles are matched EXACTLY against the
  // phase() calls emitted below.
  lines.push('export const meta = {');
  lines.push('  name: ' + quoteString(opts.name) + ',');
  lines.push('  description: ' + quoteString(opts.description) + ',');
  lines.push('  phases: [');
  for (const ph of phases) {
    lines.push('    { title: ' + quoteString(ph.title) + ', detail: ' + quoteString(ph.detail) + ' },');
  }
  lines.push('  ],');
  lines.push('}');
  lines.push('');
  for (const h of opts.header) lines.push(h === '' ? '//' : '// ' + h);
  lines.push('');

  const wantsMetadata = plan.stages.some((st) => st.dispatches.some((d) => d.resultContract === 'worktree_metadata'));
  if (wantsMetadata) {
    // #3302: the generated script must hand the per-agent executor results back
    // to the orchestrator so it can feed the wave merge chain: a helper that
    // extracts the executor's <worktree_metadata> JSON (agents/gsd-executor.md
    // <worktree_metadata_capture>) from one agent() result. `metadata` is null
    // when the result carried no parseable block — the LOUD-failure input the
    // orchestrator halts on for expects_worktree plans (never a silent skip).
    lines.push('// #3302: extract the executor-returned <worktree_metadata> JSON so the');
    lines.push('// orchestrator can record it into WAVE_WORKTREE_MANIFEST after the run');
    lines.push('// (worktree.record-agent -> worktree.cleanup-wave, the same manifest-scoped');
    lines.push('// merge chain inline dispatch feeds). null = absent/unparseable/interrupted.');
    lines.push('function gsdWorktreeMetadata(agentResult) {');
    lines.push('  if (typeof agentResult !== \'string\') return null;');
    lines.push('  const m = agentResult.match(/<worktree_metadata>([\\s\\S]*?)<\\/worktree_metadata>/);');
    lines.push('  if (m === null) return null;');
    lines.push('  try {');
    lines.push('    const parsed = JSON.parse(m[1]);');
    lines.push('    return (parsed !== null && typeof parsed === \'object\') ? parsed : null;');
    lines.push('  } catch (e) {');
    lines.push('    return null;');
    lines.push('  }');
    lines.push('}');
  }
  lines.push('const gsdAgentOutcomes = [];');
  lines.push('');

  for (let pi = 0; pi < groups.length; pi++) {
    const group = groups[pi];
    lines.push('// ' + group.title);
    // Title must match this phase's meta.phases entry EXACTLY.
    lines.push('phase(' + quoteString(group.title) + ')');
    for (let si = 0; si < group.stages.length; si++) {
      const st = group.stages[si];
      if (st.comment !== undefined) lines.push('// ' + st.comment);
      const batchSize = concurrency === undefined ? st.dispatches.length : concurrency;
      const batches: RenderableDispatch[][] = [];
      for (let b = 0; b < st.dispatches.length; b += batchSize) batches.push(st.dispatches.slice(b, b + batchSize));
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const name = 'gsdStage_' + pi + '_' + si + (batches.length > 1 ? '_' + bi : '');
        // parallel() takes an ARRAY OF THUNKS — `parallel(agent(…), agent(…))`
        // threw "parallel() expects an array of functions" (#2590). Passing
        // agent() results directly would also start every agent eagerly, before
        // parallel() could bound concurrency.
        // #3302: capture the barrier's resolved results (one per thunk, in thunk
        // order — the documented parallel() contract) so each dispatch's outcome
        // can be tagged and returned below.
        lines.push('const ' + name + ' = await parallel([');
        // A dispatch's `schema` is deliberately NOT passed to agent(): with a schema the Workflow
        // tool returns a parsed object, and the `{ purpose, text }` result must carry the raw text
        // `swarm check-answers` size-checks and parses itself (checkWorkerAnswer rejects a
        // non-string). The schema already rides inside the prompt's <schema> block.
        for (const d of batch) {
          lines.push('  () => agent(' + quoteString(d.prompt) + ', ' + dispatchOptions(d) + '),');
        }
        lines.push('])');
        // Positional tagging is decided at RENDER time from the validated plan,
        // so attribution survives out-of-order completion and needs no runtime
        // introspection.
        lines.push('gsdAgentOutcomes.push(');
        for (let di = 0; di < batch.length; di++) {
          const d = batch[di];
          const tail = di < batch.length - 1 ? ',' : '';
          const result = name + '[' + di + ']';
          if (d.resultContract === 'worktree_metadata') {
            lines.push('  { plan: ' + quoteString(d.id as string) + ', expects_worktree: ' + (d.isolation === 'worktree') + ', metadata: gsdWorktreeMetadata(' + result + ') }' + tail);
          } else {
            lines.push('  { purpose: ' + quoteString(d.purpose) + ', text: ' + result + ' }' + tail);
          }
        }
        lines.push(')');
      }
    }
    if (pi < groups.length - 1) lines.push('');
  }

  // #3302: the script's top-level return value is what the Workflow tool hands
  // back to the orchestrator: one entry per dispatch, in plan order.
  lines.push('return gsdAgentOutcomes');

  return { ok: true, script: lines.join('\n') };
}

interface WavesToFanOutPlanResult {
  plan: RenderablePlan;
  phases: RenderPhase[];
  stagesByWave: string[][][];
  plans: number;
  worktreePlans: number;
}

/**
 * The wave adapter (ADR-5273 Decision 1): execute-phase's waves as a renderable plan. Each wave
 * is one phase, `partitionStages` splits it into sequential stages on `files_modified` overlap,
 * and each plan becomes one `gsd-executor` dispatch with the `worktree_metadata` result contract
 * and, unless its `use_worktree` is `false`, worktree isolation. Expects waves `emitWorkflowScript`
 * has already validated.
 */
function wavesToFanOutPlan(waves: Wave[], executorModel?: unknown): WavesToFanOutPlanResult {
  const stages: RenderableStage[] = [];
  const phases: RenderPhase[] = [];
  const stagesByWave: string[][][] = [];
  let plans = 0;
  let worktreePlans = 0;
  for (const wave of waves) {
    const title = 'Wave ' + wave.id;
    phases.push({ title, detail: wave.plans.length + ' plan(s)' });
    const partition = partitionStages(wave.plans);
    stagesByWave.push(partition);
    plans += wave.plans.length;
    for (let si = 0; si < partition.length; si++) {
      // Resolve back to plan objects for briefs (ids are unique within a wave — validated).
      const stagePlans = partition[si].map((id) => wave.plans.find((p) => p.id === id) as Plan);
      const stage: RenderableStage = {
        id: wave.id + '-' + si,
        phase: title,
        dispatches: stagePlans.map((p): RenderableDispatch => {
          const d: RenderableDispatch = {
            purpose: 'execute',
            agentType: 'gsd-executor',
            model: executorModel,
            prompt: p.brief,
            id: p.id,
            resultContract: 'worktree_metadata',
          };
          if (p.use_worktree !== false) {
            d.isolation = 'worktree';
            worktreePlans += 1;
          }
          return d;
        }),
      };
      if (partition.length > 1) stage.comment = 'Stage ' + si + (si > 0 ? ' (sequential — files_modified overlap)' : '');
      stages.push(stage);
    }
  }
  return { plan: { stages }, phases, stagesByWave, plans, worktreePlans };
}

interface FanOutStageInput {
  /** The `plan` of a `loop fan-out-plan` verdict with `mode: "fan-out"`. */
  plan: RenderablePlan;
  /** The id of the one stage to render. */
  stageId: string;
  /** The verdict's `concurrency.c`: the most agents one barrier holds. */
  concurrency: number;
  runId: string;
}

type FanOutStageResult =
  | { ok: true; script: string; summary: { stage: string; dispatches: number; batches: number; resumeRunId: string } }
  | { ok: false; reason: string };

/**
 * ADR-5273 step 5: one stage of a strategy's fan-out plan (from `loop fan-out-plan`) as a
 * Workflow script, through the same `renderFanOutPlan` the waves use. The script returns one
 * `{ purpose, text }` per dispatch in plan order, the array `swarm check-answers --answers` reads.
 *
 * One stage per script, because the orchestrator works between stages: it checks the worker
 * answers and fills the synthesizer's answer slot. A `synthesizer` stage is therefore refused, and
 * so is any executor-only field, which a strategy's plan may never carry. Batches hold at most
 * `concurrency` agents. Which route runs the script is #4747 item E's decision; nothing here
 * invokes the Workflow tool.
 */
function renderFanOutStage(input: FanOutStageInput | null | undefined): FanOutStageResult {
  if (input === null || input === undefined || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  const { plan, stageId, concurrency, runId } = input;
  if (!isScriptableIdentifier(runId)) return { ok: false, reason: 'runId must be a non-empty string without newlines/quotes/backslash/control chars' };
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) return { ok: false, reason: 'concurrency must be a positive integer' };
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.stages)) return { ok: false, reason: 'plan must have a stages array' };
  const stage = plan.stages.find((st) => st !== null && typeof st === 'object' && st.id === stageId);
  if (stage === undefined) return { ok: false, reason: 'plan has no stage "' + String(stageId) + '"' };
  if (!Array.isArray(stage.dispatches)) return { ok: false, reason: 'stage "' + stageId + '" has no dispatches array' };
  for (const d of stage.dispatches) {
    if (d === null || typeof d !== 'object') return { ok: false, reason: 'stage "' + stageId + '" holds a dispatch that is not an object' };
    if (d.purpose === 'synthesizer') {
      return { ok: false, reason: 'a synthesizer stage is not rendered: its prompt is completed between stages, so it runs inline' };
    }
    for (const k of FAN_OUT_REFUSED_DISPATCH_FIELDS) {
      if ((d as unknown as Record<string, unknown>)[k] !== undefined) {
        return { ok: false, reason: 'a fan-out plan dispatch may not carry the executor-only field ' + k };
      }
    }
  }
  const rendered = renderFanOutPlan({ stages: [{ id: stage.id, dispatches: stage.dispatches }] }, {
    name: 'gsd-fan-out-' + runId,
    description: 'GSD fan-out stage ' + stage.id,
    header: [
      'GSD Workflow script — one fan-out stage (ADR-5273), rendered by claude-orchestration',
      'BETA: on any failure the orchestrator runs the stage inline instead.',
      'Returns one { purpose, text } per dispatch, in plan order: the swarm check-answers input.',
      'Each agent() gets no schema option, so its result stays the raw text check-answers checks;',
      'the schema is in the prompt. Batches hold at most ' + concurrency + ' agents.',
      'Size: the Workflow tool advises fewer than 10 agents per script (workflowSizeGuideline);',
      'raise that guideline for a larger stage (ADR-5273 Decision 2).',
      '',
      'resume: pass ' + quoteString(runId) + ' as the Workflow tool\'s resumeFromRunId input',
      '(it is a tool parameter, NOT a script function).',
    ],
    concurrency,
  });
  if (!rendered.ok) return rendered;
  return {
    ok: true,
    script: rendered.script,
    summary: {
      stage: stage.id,
      dispatches: stage.dispatches.length,
      batches: Math.ceil(stage.dispatches.length / concurrency),
      resumeRunId: runId,
    },
  };
}

/**
 * Emit a Workflow script mapping the phase's wave/plan model onto Workflow
 * primitives. Pure and deterministic: identical input yields an identical string.
 *
 * Returns ok:false (never throws) on invalid input — empty waves, missing runId,
 * a wave with no plans, etc.
 */
function emitWorkflowScript(input: EmitInput | null | undefined): EmitOk | EmitErr {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }
  const { phaseDir, waves, runId, executorModel } = input;
  // Identifiers/paths interpolated into the generated script must be free of any
  // character that could terminate a comment, break out of a string literal, or
  // smuggle control bytes — reject up front (security: #1143 review Finding 1).
  if (!isScriptableIdentifier(phaseDir)) {
    return { ok: false, reason: 'phaseDir must be a non-empty string without newlines/quotes/backslash/control chars' };
  }
  if (!isScriptableIdentifier(runId)) {
    return { ok: false, reason: 'runId must be a non-empty string without newlines/quotes/backslash/control chars' };
  }
  // #2686 security: the resolved model is interpolated into BOTH an object
  // literal (safe under quoteString) and a `//` provenance comment (NOT safe
  // under quoteString — U+2028/U+2029 are LineTerminators that end a single-line
  // comment in every engine, so a hostile model id would make the rest of the
  // line live code). Reject the whole emission rather than silently dropping the
  // model: an unscriptable id is malformed input, and `resolveWaveDispatch` maps
  // an emit failure to the inline backend WITH a reason, so the user sees it.
  // Only a STRING carrying such a character is rejected. A non-string is a
  // malformed config rather than an injection attempt, and stays on the existing
  // defensive path: `emittableModel` omits it and emission proceeds.
  if (typeof executorModel === 'string' && UNSCRIPTABLE_CHAR_RE.test(executorModel)) {
    return { ok: false, reason: 'executorModel must not contain newlines/quotes/backslash/control/line-separator chars' };
  }
  if (!Array.isArray(waves) || waves.length === 0) {
    return { ok: false, reason: 'waves must be a non-empty array' };
  }
  // Wave ids must be unique ACROSS waves, not just plan ids within one (#2590).
  // Each wave emits a `phase("Wave <id>")` call plus a matching meta.phases
  // entry, and the Workflow tool matches phase titles by exact string — two
  // waves sharing an id would collapse into one progress group and misattribute
  // every agent in the second wave to the first.
  const seenWaveIds = new Set<string>();
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    if (w === null || typeof w !== 'object' || typeof w.id !== 'string') {
      return { ok: false, reason: 'waves[' + i + '] must be { id, plans: non-empty[] }' };
    }
    if (!isScriptableIdentifier(w.id)) {
      return { ok: false, reason: 'waves[' + i + '].id must not contain newlines/quotes/backslash/control chars' };
    }
    if (seenWaveIds.has(w.id)) {
      return { ok: false, reason: 'duplicate wave id "' + w.id + '" — wave ids must be unique (phase titles must map 1:1)' };
    }
    seenWaveIds.add(w.id);
    if (!Array.isArray(w.plans) || w.plans.length === 0) {
      return { ok: false, reason: 'waves[' + i + '] must have a non-empty plans array' };
    }
    const seenIds = new Set<string>();
    for (let j = 0; j < w.plans.length; j++) {
      const p = w.plans[j];
      if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.brief !== 'string' || !Array.isArray(p.files_modified)) {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '] must be { id, brief, files_modified[] }' };
      }
      if (!isScriptableIdentifier(p.id)) {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].id must not contain newlines/quotes/backslash/control chars' };
      }
      if (p.use_worktree !== undefined && typeof p.use_worktree !== 'boolean') {
        return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].use_worktree must be a boolean if present' };
      }
      if (seenIds.has(p.id)) {
        return { ok: false, reason: 'waves[' + i + '] has duplicate plan id "' + p.id + '"' };
      }
      seenIds.add(p.id);
      for (const f of p.files_modified) {
        if (typeof f !== 'string' || f.length === 0) {
          return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].files_modified entries must be non-empty strings' };
        }
      }
    }
  }

  const budgetTokens = (typeof input.budgetTokens === 'number' && Number.isFinite(input.budgetTokens) && input.budgetTokens > 0)
    ? Math.floor(input.budgetTokens)
    : null;

  const header: string[] = [
    'GSD Workflow script — generated by the claude-orchestration capability (#1143)',
    'phase: ' + phaseDir,
    'BETA: preview-grade; on any failure the orchestrator falls back to inline dispatch.',
    'Composes the SAME gsd-executor agent as the inline path, so artifacts (SUMMARY.md)',
    'and commits are produced identically. Worktree isolation is per-plan (use_worktree)',
    'and mirrors execute-phase.md step 2.5\'s submodule gate exactly (#2772 / #2285).',
  ];
  // #2686 / ADR-1411: state which model was applied — or that none resolved —
  // so an opted-in user can SEE the routing decision instead of having to read
  // the emitted options. A fallback must be a visible value, never silent.
  //
  // SECURITY: this is a `//` comment, and U+2028/U+2029 are ECMAScript
  // LineTerminators that END a single-line comment in every engine — the ES2019
  // change legalized them inside string LITERALS only, so `quoteString` alone is
  // NOT sufficient here. An unscriptable model id is rejected above, and
  // `renderFanOutPlan` refuses any header line carrying a line terminator.
  const provenanceModel = emittableModel(executorModel);
  if (provenanceModel !== undefined) {
    header.push('model: ' + quoteString(provenanceModel) + ' (resolved for gsd-executor, same source as the inline path)');
  } else {
    header.push('model: none applied — resolved to "inherit"/empty, so each agent inherits the');
    header.push('orchestrator model (#2517: emitting an empty model 404s on some runtimes).');
  }
  header.push('');
  // resumeFromRunId is a Workflow TOOL INPUT parameter, not a script function —
  // calling it threw "resumeFromRunId is not defined" (#2590). The run id is
  // carried in summary.resumeRunId for the caller to pass as that input.
  header.push('resume: pass ' + quoteString(runId) + ' as the Workflow tool\'s resumeFromRunId input');
  header.push('(it is a tool parameter, NOT a script function).');
  if (budgetTokens !== null) {
    // `budget` is a read-only object ({ total, spent(), remaining() }) supplied
    // by the caller's token directive — a script cannot SET it, and `budget(n)`
    // threw "budget is not a function" (#2590). Recorded as intent only.
    header.push('budget: ' + budgetTokens + ' output tokens intended for this run; `budget` is');
    header.push('read-only in a Workflow script — set it via the caller\'s token directive.');
  }

  // ADR-5273 Decision 1: waves go through the adapter and the one renderer.
  const adapted = wavesToFanOutPlan(waves, executorModel);
  const rendered = renderFanOutPlan(adapted.plan, {
    name: 'gsd-execute-' + runId,
    description: 'GSD wave dispatch for ' + phaseDir,
    header,
    phases: adapted.phases,
  });
  if (!rendered.ok) return { ok: false, reason: rendered.reason };

  return {
    ok: true,
    script: rendered.script,
    summary: {
      waves: waves.length,
      plans: adapted.plans,
      // #3302: the number of record-agent entries the orchestrator must end up
      // with in WAVE_WORKTREE_MANIFEST after the run — the loud count check.
      worktreePlans: adapted.worktreePlans,
      stagesByWave: adapted.stagesByWave,
      resumeRunId: runId,
      budgetTokens,
    },
  };
}

// ─── resolveWaveDispatch ──────────────────────────────────────────────────────

interface ResolveWaveDispatchInput {
  runtimeId?: string;
  hostIntegration?: HostIntegration | null;
  config?: BackendConfig | null;
  agentSdkVersion?: string;
  phaseDir: string;
  waves: Wave[];
  runId: string;
  budgetTokens?: number;
  /** #2686 — forwarded verbatim to `emitWorkflowScript`. */
  executorModel?: string;
}

interface ResolveWaveDispatchInline {
  backend: 'inline';
  reason: string;
}

interface ResolveWaveDispatchWorkflow {
  backend: 'workflow';
  reason: string;
  script: string;
  summary: EmitOk['summary'];
}

type ResolveWaveDispatchResult = ResolveWaveDispatchInline | ResolveWaveDispatchWorkflow;

/**
 * #2285 — single composed decision seam for a PRE-wave dispatch-backend selector
 * (e.g. the `execute:wave:pre` claude-orchestration contribution). Composes
 * `detectWorkflowBackend` (gate ladder) with `emitWorkflowScript` (wave→plan
 * mapping) into ONE call so the orchestrator (and its CLI wrapper,
 * `claude-orchestration resolve-wave-dispatch`) never has to re-implement the
 * two-step "detect, then maybe emit" sequencing.
 *
 * Fail-closed at every layer, matching the two composed functions:
 *   - `detectWorkflowBackend` resolving anything other than `'workflow'` →
 *     `inline` immediately; `emitWorkflowScript` is never invoked (no wasted
 *     work, no risk of a bad emit masking a correct inline fallback).
 *   - `detectWorkflowBackend` resolves `'workflow'` but `emitWorkflowScript`
 *     fails (`ok:false` — e.g. a malformed wave manifest) → `inline`, carrying
 *     the emit failure reason so the caller can surface it. Never a partial or
 *     broken script.
 *
 * This is the designated non-CLI-router, non-test caller of
 * `detectWorkflowBackend` and `emitWorkflowScript` — the standalone CLI
 * subcommands (`detect-backend`, `emit-workflow`) remain for inspection/
 * debugging, but the orchestrator's real per-wave dispatch decision goes
 * through this seam.
 *
 * Never throws on bad input.
 */
function resolveWaveDispatch(input: ResolveWaveDispatchInput | null | undefined): ResolveWaveDispatchResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { backend: 'inline', reason: 'invalid_input' };
  }

  const detected = detectWorkflowBackend({
    runtimeId: input.runtimeId,
    hostIntegration: input.hostIntegration,
    config: input.config,
    agentSdkVersion: input.agentSdkVersion,
  });

  if (detected.backend !== 'workflow') {
    return { backend: 'inline', reason: detected.reason };
  }

  const emitted = emitWorkflowScript({
    phaseDir: input.phaseDir,
    waves: input.waves,
    runId: input.runId,
    budgetTokens: input.budgetTokens,
    executorModel: input.executorModel,
  });

  if (!emitted.ok) {
    return { backend: 'inline', reason: 'emit_failed: ' + emitted.reason };
  }

  return {
    backend: 'workflow',
    reason: detected.reason,
    script: emitted.script,
    summary: emitted.summary,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export = {
  detectWorkflowBackend,
  emitWorkflowScript,
  renderFanOutPlan,
  renderFanOutStage,
  wavesToFanOutPlan,
  resolveWaveDispatch,
  compareSemver,
  isValidSemver,
  WORKFLOW_TOOL_FLOOR_VERSION,
  BACKEND_VALUES,
  WORKFLOW_RUNTIME,
};
