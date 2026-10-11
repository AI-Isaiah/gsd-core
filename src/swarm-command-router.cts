'use strict';
/**
 * Swarm command router — `gsd-tools swarm <subcommand>` (#5273, ADR-5273).
 *
 * The swarm capability's ADR-959 command family, discovered through the capability registry.
 * `swarm plan` is the `fanOutStrategy` core's `loop fan-out-plan` invokes; the other subcommands
 * are what a spawn site runs around the fan-out (answer checks, telemetry, anchor verification).
 * Every policy decision lives in `src/swarm.cts`; this router reads config, resolves models and
 * files, and prints JSON.
 *
 * Router signature: { args, cwd, raw, error } — identical to the other capability routers.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationMod = require('./capability-activation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');

import { safeJsonParse } from './security.cjs';
import {
  ROLE_BY_AGENT,
  SWARM_REASON,
  readSwarmConfig,
  workerTierUsable,
  readUnits,
  parseScopeFile,
  buildSwarmPlan,
  checkAnswers,
  buildTelemetryEntry,
  buildRepairs,
  parseDiffRanges,
} from './swarm.cjs';
import type { Unit, RawAnswer } from './swarm.cjs';
import { FAN_OUT_WORKER_AGENT, checkWorkerAnswer } from './fan-out-plan.cjs';
import { retryRenameSync } from './shell-command-projection.cjs';
import { kindForArtefact, pruneArtefact, verifyAnchors } from './swarm-anchors.cjs';
import type { ArtefactKind } from './swarm-anchors.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
import type { ResolvedModel, FanOutDispatch } from './fan-out-plan.cjs';

const { output, ERROR_REASON } = io;
const { makeInvalidArgs } = commandRoutingHub;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { isCapabilityActive } = capabilityStateMod;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { findPhaseInternal } = phaseLocatorMod;

const CAPABILITY_ID = 'swarm';

/** Bound on a `--units` or `--scope-file` file read; both are workflow-written, never huge. */
const INPUT_MAX_BYTES = 1024 * 1024;

interface RouteSwarmCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: replace model resolution. */
  _resolveModel?: (cwd: string, agent: string) => ResolvedModel;
  /** Test seam: replace "does this runtime's catalog map tiers to models". */
  _runtimeMapsTiers?: (cwd: string) => boolean;
}

/** `--flag value` or `--flag=value`; a following flag-shaped token is not a value. */
function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const next = args[i + 1];
      return next === undefined || next.startsWith('--') ? '' : next;
    }
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function defaultResolveModel(cwd: string, agent: string): ResolvedModel {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mr = require('./model-resolver.cjs') as { resolveModelInternal(c: string, a: string): string; resolveTierInternal(c: string, a: string): string };
  return { model: mr.resolveModelInternal(cwd, agent), tier: mr.resolveTierInternal(cwd, agent) };
}

function defaultRuntimeMapsTiers(cwd: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveRuntime } = require('./runtime-slash.cjs') as { resolveRuntime: (c: string) => string };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RUNTIME_PROFILE_MAP } = require('./model-catalog.cjs') as { RUNTIME_PROFILE_MAP: Record<string, Record<string, unknown>> };
    const tiers = RUNTIME_PROFILE_MAP[resolveRuntime(cwd)];
    return Boolean(tiers && tiers['haiku']);
  } catch {
    return false;
  }
}

function readBoundedFile(p: string): { ok: true; text: string } | { ok: false; detail: string } {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, detail: `${p} is not a regular file` };
    if (st.size > INPUT_MAX_BYTES) return { ok: false, detail: `${p} exceeds ${INPUT_MAX_BYTES} bytes` };
    return { ok: true, text: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { ok: false, detail: `${p}: ${(e as Error).message}` };
  }
}

function handlePlan(opts: RouteSwarmCommandOptions): unknown {
  const { args, cwd, raw } = opts;
  const usage = 'Usage: gsd-tools swarm plan --agent <agent> --phase <n> --stage decompose|fan-out [--units <file>] [--scope-file <file> [--diff-base <ref>]]';
  const agent = flagValue(args, '--agent');
  const phase = flagValue(args, '--phase');
  const stage = flagValue(args, '--stage') || 'fan-out';
  if (!agent) return makeInvalidArgs('agent', usage, ERROR_REASON.USAGE);
  if (!phase) return makeInvalidArgs('phase', usage, ERROR_REASON.USAGE);
  if (stage !== 'decompose' && stage !== 'fan-out') return makeInvalidArgs('stage', usage, ERROR_REASON.USAGE);

  const role = ROLE_BY_AGENT[agent];
  if (!role) {
    output({ mode: 'single', reason: SWARM_REASON.UNKNOWN_ROLE, detail: `${agent} has no swarm role` }, raw);
    return undefined;
  }
  if (!isCapabilityActive(CAPABILITY_ID, cwd)) {
    output({ mode: 'single', reason: SWARM_REASON.DISABLED }, raw);
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const config = loadConfig(cwd);
  const key = (k: string): unknown => resolveConfigKey(k, { config, cwd, registry }).value;
  const cfg = readSwarmConfig({
    enabled: key('swarm.enabled'),
    roles: key('swarm.roles'),
    maxWorkers: key('swarm.max_workers'),
    maxConcurrency: key('swarm.max_concurrency'),
  });
  if (!cfg.ok) {
    output({ mode: 'single', reason: cfg.reason, detail: cfg.detail }, raw);
    return undefined;
  }

  const resolveModel = opts._resolveModel ?? defaultResolveModel;
  const worker = resolveModel(cwd, FAN_OUT_WORKER_AGENT);
  const step = resolveModel(cwd, agent);
  const mapsTiers = (opts._runtimeMapsTiers ?? defaultRuntimeMapsTiers)(cwd);
  // Only a run that would actually dispatch workers needs a usable worker tier.
  if (cfg.config.enabled && cfg.config.roles.includes(role) && !workerTierUsable(worker, mapsTiers)) {
    output({ mode: 'single', reason: SWARM_REASON.NO_WORKER_TIER, detail: `gsd-swarm-worker resolves to model "${worker.model}" tier "${worker.tier}" with no runtime mapping; set model_overrides.gsd-swarm-worker` }, raw);
    return undefined;
  }

  let units: Unit[] | undefined;
  const unitsArg = flagValue(args, '--units');
  if (unitsArg !== undefined) {
    if (stage !== 'fan-out' || !unitsArg) return makeInvalidArgs('units', usage, ERROR_REASON.USAGE);
    const file = readBoundedFile(path.resolve(cwd, unitsArg));
    const parsed = file.ok ? safeJsonParse(file.text, { maxLength: INPUT_MAX_BYTES, label: '--units' }) : null;
    const read = parsed && parsed.ok ? readUnits(parsed.value, cwd) : null;
    if (!read || !read.ok) {
      const detail = !file.ok ? file.detail : parsed && !parsed.ok ? String(parsed.error) : read && !read.ok ? read.detail : 'unreadable';
      output({ mode: 'single', reason: SWARM_REASON.INVALID_UNITS, detail }, raw);
      return undefined;
    }
    units = read.units;
  }

  let files: string[] | undefined;
  const scopeArg = flagValue(args, '--scope-file');
  if (scopeArg !== undefined) {
    if (!scopeArg) return makeInvalidArgs('scope-file', usage, ERROR_REASON.USAGE);
    const file = readBoundedFile(path.resolve(cwd, scopeArg));
    if (!file.ok) {
      output({ mode: 'single', reason: SWARM_REASON.INVALID_SCOPE_FILE, detail: file.detail }, raw);
      return undefined;
    }
    files = parseScopeFile(file.text);
  }

  // Live-run lesson (2026-10-11): review workers read only around the change when the step has a
  // diff base. A failed diff leaves changedLines undefined, so the units are reviewed whole.
  let changedLines: Record<string, string[]> | undefined;
  let lineCounts: Record<string, number> | undefined;
  let boundaries: Record<string, number[]> | undefined;
  const diffBase = flagValue(args, '--diff-base');
  if (files !== undefined) {
    if (diffBase) {
      if (!DIFF_BASE_RE.test(diffBase)) return makeInvalidArgs('diff-base', `--diff-base must be a git revision. ${usage}`, ERROR_REASON.USAGE);
      changedLines = diffRanges(cwd, diffBase, files);
      // Each file's length (for its read window) and its blank lines (where a long change is cut).
      lineCounts = {};
      boundaries = {};
      for (const f of files) {
        const r = readBoundedFile(path.resolve(cwd, f));
        if (!r.ok) continue;
        const lines = r.text.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        lineCounts[f] = lines.length;
        boundaries[f] = lines.flatMap((l, i) => (l.trim() === '' ? [i + 1] : []));
      }
    }
  }

  // The decomposition reads the phase's own inputs; name the ones that exist so it never guesses.
  const phaseInputs: string[] = [];
  const found = findPhaseInternal(cwd, phase);
  if (found && found.found === true) {
    for (const name of ['CONTEXT.md', 'RESEARCH.md']) {
      const rel = path.join(found.directory, `${found.phase_number}-${name}`);
      if (fs.existsSync(path.join(cwd, rel))) phaseInputs.push(rel.split(path.sep).join('/'));
    }
  }

  output(buildSwarmPlan({ stage, role, stepAgent: agent, phase, config: cfg.config, worker, step, units, files, projectRoot: cwd, phaseInputs, changedLines, lineCounts, boundaries }), raw);
  return undefined;
}

/**
 * `swarm check-answers --agent <agent> --answers <file> [--plan <verdict>]`: the file is a JSON
 * array of `{ purpose: "worker" | "cross-file", text, repaired? }`, one per worker dispatch, in
 * plan order. Prints the verdict, the drop list and the `<swarm_worker_answers>` block for the
 * synthesizer. With `--plan` (the `loop fan-out-plan` verdict), it also prints `repairs`: one
 * dispatch per dropped answer not yet repaired, carrying the rejection reason, up to `repairCap`.
 */
function handleCheckAnswers(opts: RouteSwarmCommandOptions): unknown {
  const { args, cwd, raw } = opts;
  const usage = 'Usage: gsd-tools swarm check-answers --agent <agent> --answers <file> [--plan <verdict file>]';
  const agent = flagValue(args, '--agent');
  const answersArg = flagValue(args, '--answers');
  if (!agent) return makeInvalidArgs('agent', usage, ERROR_REASON.USAGE);
  if (!answersArg) return makeInvalidArgs('answers', usage, ERROR_REASON.USAGE);
  const role = ROLE_BY_AGENT[agent];
  if (!role) return makeInvalidArgs('agent', `${agent} has no swarm role. ${usage}`, ERROR_REASON.USAGE);
  const file = readBoundedFile(path.resolve(cwd, answersArg));
  if (!file.ok) return makeInvalidArgs('answers', file.detail, ERROR_REASON.USAGE);
  const parsed = safeJsonParse(file.text, { maxLength: INPUT_MAX_BYTES, label: '--answers' });
  if (!parsed.ok || !Array.isArray(parsed.value)) return makeInvalidArgs('answers', '--answers must hold a JSON array of { purpose, text }', ERROR_REASON.USAGE);
  const items = parsed.value as RawAnswer[];
  const check = checkAnswers(role, items, checkWorkerAnswer);
  const planArg = flagValue(args, '--plan');
  if (planArg === undefined) {
    output(check, raw);
    return undefined;
  }
  if (!planArg) return makeInvalidArgs('plan', usage, ERROR_REASON.USAGE);
  const planFile = readBoundedFile(path.resolve(cwd, planArg));
  if (!planFile.ok) return makeInvalidArgs('plan', planFile.detail, ERROR_REASON.USAGE);
  const verdict = safeJsonParse(planFile.text, { maxLength: INPUT_MAX_BYTES, label: '--plan' });
  const plan = verdict.ok && verdict.value !== null && typeof verdict.value === 'object'
    ? ((verdict.value as Record<string, unknown>)['plan'] ?? verdict.value) as { maxWorkers?: unknown; stages?: unknown }
    : null;
  const stage = plan !== null && Array.isArray(plan.stages)
    ? (plan.stages as Array<{ dispatches?: unknown }>).find((st) => Array.isArray(st.dispatches)
      && (st.dispatches as Array<{ purpose?: unknown }>).some((d) => d.purpose === 'worker'))
    : undefined;
  if (plan === null || stage === undefined || typeof plan.maxWorkers !== 'number') {
    return makeInvalidArgs('plan', '--plan must hold a fan-out verdict or plan with a worker stage', ERROR_REASON.USAGE);
  }
  const dispatches = stage.dispatches as FanOutDispatch[];
  if (dispatches.length !== items.length) {
    return makeInvalidArgs('plan', `--answers holds ${items.length} answers but the worker stage has ${dispatches.length} dispatches`, ERROR_REASON.USAGE);
  }
  output({ ...check, repairs: buildRepairs(items, check.dropped, dispatches, plan.maxWorkers) }, raw);
  return undefined;
}

/**
 * `swarm record --phase <n> --entry <file>`: validate one telemetry entry (ADR-5273 Decision 5),
 * compute its per-model maps, and append it to `<phase dir>/<NN>-SWARM.json`. Swarm off writes
 * nothing, so a disabled project stays byte-identical.
 */
function handleRecord(opts: RouteSwarmCommandOptions): unknown {
  const { args, cwd, raw } = opts;
  const usage = 'Usage: gsd-tools swarm record --phase <n> --entry <file>';
  const phase = flagValue(args, '--phase');
  const entryArg = flagValue(args, '--entry');
  if (!phase) return makeInvalidArgs('phase', usage, ERROR_REASON.USAGE);
  if (!entryArg) return makeInvalidArgs('entry', usage, ERROR_REASON.USAGE);
  if (!isCapabilityActive(CAPABILITY_ID, cwd)) {
    output({ recorded: false, reason: SWARM_REASON.DISABLED }, raw);
    return undefined;
  }
  const search = findPhaseInternal(cwd, phase);
  if (!search || search.found !== true) return makeInvalidArgs('phase', `phase ${phase} not found. ${usage}`, ERROR_REASON.USAGE);
  const file = readBoundedFile(path.resolve(cwd, entryArg));
  if (!file.ok) return makeInvalidArgs('entry', file.detail, ERROR_REASON.USAGE);
  const parsed = safeJsonParse(file.text, { maxLength: INPUT_MAX_BYTES, label: '--entry' });
  const built = parsed.ok ? buildTelemetryEntry(parsed.value) : { ok: false as const, detail: String(parsed.error) };
  if (!built.ok) return makeInvalidArgs('entry', built.detail, ERROR_REASON.USAGE);

  const target = path.join(cwd, search.directory, `${search.phase_number}-SWARM.json`);
  let entries: unknown[] = [];
  if (fs.existsSync(target)) {
    const prior = safeJsonParse(fs.readFileSync(target, 'utf8'), { label: 'SWARM.json' });
    if (!prior.ok || !Array.isArray(prior.value)) return makeInvalidArgs('entry', `${target} exists but is not a JSON array; refusing to overwrite it`, ERROR_REASON.USAGE);
    entries = prior.value;
  }
  entries.push(built.entry);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  try {
    retryRenameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  output({ recorded: true, path: path.relative(cwd, target), entries: entries.length, entry: built.entry }, raw);
  return undefined;
}

/**
 * `swarm verify-anchors <artefact> [--prune] [--kind research|patterns|review]` (ADR-5273
 * Decision 3). Without `--prune` it only reports. With `--prune` it removes each failing anchor's
 * claim unit, rewrites the artefact atomically, and lists the removals; a prune that cannot be done
 * cleanly answers `anchor_check_failed` and leaves the file untouched. Never prints file content.
 */
function handleVerifyAnchors(opts: RouteSwarmCommandOptions): unknown {
  const { args, cwd, raw } = opts;
  const usage = 'Usage: gsd-tools swarm verify-anchors <artefact> [--prune] [--kind research|patterns|review]';
  const target = args[2];
  if (!target || target.startsWith('--')) return makeInvalidArgs('artefact', usage, ERROR_REASON.USAGE);
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return makeInvalidArgs('artefact', `${target} is outside the project root`, ERROR_REASON.USAGE);
  const kindArg = flagValue(args, '--kind');
  const kind = (kindArg || kindForArtefact(abs)) as ArtefactKind | null;
  if (kind !== 'research' && kind !== 'patterns' && kind !== 'review') {
    return makeInvalidArgs('kind', `cannot tell the artefact kind of ${target}; pass --kind. ${usage}`, ERROR_REASON.USAGE);
  }
  const file = readBoundedFile(abs);
  if (!file.ok) return makeInvalidArgs('artefact', file.detail, ERROR_REASON.USAGE);

  if (!args.includes('--prune')) {
    const v = verifyAnchors(file.text, cwd);
    const failed = v.tooMany || v.failures.length > 0;
    output({ verdict: failed ? 'anchor_check_failed' : 'ok', total: v.total, failures: v.failures, ...(v.tooMany ? { reason: 'too_many_anchors' } : {}) }, raw);
    return undefined;
  }

  const r = pruneArtefact(file.text, kind, cwd);
  if (r.verdict === 'ok' && r.pruned.length > 0) {
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.text, 'utf8');
    try {
      retryRenameSync(tmp, abs);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }
  if (r.verdict === 'ok') {
    output({ verdict: 'ok', total: r.total, pruned: r.pruned, written: r.pruned.length > 0 }, raw);
  } else {
    output({ verdict: r.verdict, reason: r.reason, total: r.total, failures: r.failures, written: false }, raw);
  }
  return undefined;
}

/** A git revision as a review step names it: no leading dash, no whitespace or control characters. */
const DIFF_BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/;

/** `git diff -U0 <base> -- <files>` as changed-line ranges; undefined when git cannot answer. */
function diffRanges(cwd: string, base: string, files: readonly string[]): Record<string, string[]> | undefined {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, '--', ...files], {
    cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (r.error || r.status !== 0) return undefined;
  return Object.fromEntries(parseDiffRanges(String(r.stdout)));
}

function routeSwarmCommand(opts: RouteSwarmCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  routeHubCommandFamily({
    family: 'swarm',
    args,
    subcommands: ['check-answers', 'plan', 'record', 'verify-anchors'],
    handlers: {
      'check-answers': () => handleCheckAnswers(opts),
      plan: () => handlePlan(opts),
      record: () => handleRecord(opts),
      'verify-anchors': () => handleVerifyAnchors(opts),
    },
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown swarm subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeSwarmCommand,
  CAPABILITY_ID,
};
