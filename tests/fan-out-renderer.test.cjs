'use strict';

/**
 * ADR-5273 implementation step 5: one Workflow-script renderer for execute-phase's waves and for a
 * strategy's fan-out stages.
 *
 * The rendered scripts are executed here under stubs of the Workflow primitives (`phase`,
 * `parallel`, `agent`), so the tests check what a script does, not only what it says: the wave
 * script returns `{ plan, expects_worktree, metadata }` with the real `<worktree_metadata>` block
 * parsed, and a fan-out stage returns `{ purpose, text }` in plan order across batches. Running
 * the script is also what proves a hostile prompt cannot break out of its string literal.
 * The waves' byte-for-byte output stays pinned by tests/claude-orchestration.test.cjs.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const {
  emitWorkflowScript,
  renderFanOutPlan,
  renderFanOutStage,
  wavesToFanOutPlan,
} = require('../gsd-core/bin/lib/claude-orchestration.cjs');
const { EXECUTOR_ONLY_FIELDS, FAN_OUT_WORKER_AGENT } = require('../gsd-core/bin/lib/fan-out-plan.cjs');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** Run a rendered script under recording stubs; `reply(prompt, opts)` is each agent's result. */
async function runScript(script, reply) {
  const calls = { phases: [], barriers: [], agents: [] };
  const body = script.replace(/^export const meta/, 'const meta');
  const fn = new AsyncFunction('phase', 'parallel', 'agent', body);
  const result = await fn(
    (title) => { calls.phases.push(title); },
    async (thunks) => {
      assert.ok(Array.isArray(thunks) && thunks.every((t) => typeof t === 'function'), 'parallel() takes an array of thunks');
      calls.barriers.push(thunks.length);
      return Promise.all(thunks.map((t) => t()));
    },
    async (prompt, opts) => {
      calls.agents.push({ prompt, opts });
      return reply(prompt, opts);
    },
  );
  return { result, calls };
}

const HOSTILE = 'x"); agent("evil"); // </script>\\ ${process}`';

function workerDispatch(i, prompt = `question ${i}`) {
  return { purpose: 'worker', agentType: FAN_OUT_WORKER_AGENT, model: 'haiku', tier: 'haiku', prompt, schema: { type: 'object' }, scope: [`src/f${i}.ts`] };
}

function fanOutPlan(n, extra = {}) {
  return {
    mode: 'fan-out', stage: 'fan-out', maxWorkers: 20, maxConcurrency: 20,
    stages: [
      { id: 'workers', dispatches: Array.from({ length: n }, (_, i) => workerDispatch(i)), ...extra },
      { id: 'synthesize', dispatches: [{ purpose: 'synthesizer', agentType: 'gsd-code-reviewer', model: 'sonnet', tier: 'sonnet', prompt: 'synthesize <swarm_worker_answers_slot/>', schema: null }] },
    ],
  };
}

describe('wave scripts: the adapter and the renderer behave as the emitter always did', () => {
  const waves = [
    { id: '1', plans: [
      { id: '01-01', brief: 'plan a', files_modified: ['a.ts'] },
      { id: '01-02', brief: 'plan b', files_modified: ['a.ts'] },
      { id: '01-03', brief: HOSTILE, files_modified: ['c.ts'], use_worktree: false },
    ] },
    { id: '2', plans: [{ id: '02-01', brief: 'plan d', files_modified: [] }] },
  ];

  test('the adapter maps waves to phases, overlap to stages, plans to gsd-executor dispatches', () => {
    const a = wavesToFanOutPlan(waves, 'sonnet');
    assert.deepEqual(a.phases, [{ title: 'Wave 1', detail: '3 plan(s)' }, { title: 'Wave 2', detail: '1 plan(s)' }]);
    assert.deepEqual(a.stagesByWave, [[['01-01', '01-03'], ['01-02']], [['02-01']]]);
    assert.deepEqual([a.plans, a.worktreePlans], [4, 3]);
    const d = a.plan.stages[0].dispatches;
    assert.deepEqual(d.map((x) => [x.purpose, x.agentType, x.id, x.isolation, x.resultContract]), [
      ['execute', 'gsd-executor', '01-01', 'worktree', 'worktree_metadata'],
      ['execute', 'gsd-executor', '01-03', undefined, 'worktree_metadata'],
    ]);
  });

  test('executed, the wave script returns one tagged outcome per plan with the metadata parsed', async () => {
    const out = emitWorkflowScript({ phaseDir: '.planning/phases/01-x', runId: 'r1', waves, executorModel: 'sonnet' });
    assert.equal(out.ok, true, out.reason);
    const { result, calls } = await runScript(out.script, (prompt) => (prompt === 'plan b'
      ? 'done, no block'
      : `ok <worktree_metadata>{"branch":"wt-${prompt.length}"}</worktree_metadata>`));
    assert.deepEqual(calls.phases, ['Wave 1', 'Wave 2']);
    assert.deepEqual(calls.barriers, [2, 1, 1]);
    assert.deepEqual(calls.agents.map((a) => a.opts), [
      { agentType: 'gsd-executor', isolation: 'worktree', model: 'sonnet' },
      { agentType: 'gsd-executor', model: 'sonnet' },
      { agentType: 'gsd-executor', isolation: 'worktree', model: 'sonnet' },
      { agentType: 'gsd-executor', isolation: 'worktree', model: 'sonnet' },
    ]);
    assert.equal(calls.agents[1].prompt, HOSTILE, 'the hostile brief reaches agent() verbatim, as data');
    assert.deepEqual(result, [
      { plan: '01-01', expects_worktree: true, metadata: { branch: 'wt-6' } },
      { plan: '01-03', expects_worktree: false, metadata: { branch: `wt-${HOSTILE.length}` } },
      { plan: '01-02', expects_worktree: true, metadata: null },
      { plan: '02-01', expects_worktree: true, metadata: { branch: 'wt-6' } },
    ]);
  });
});

describe('fan-out stages: one stage per script, in batches of C', () => {
  test('5 workers at C = 2 run as three barriers and return { purpose, text } in plan order', async () => {
    const out = renderFanOutStage({ plan: fanOutPlan(5), stageId: 'workers', concurrency: 2, runId: 'swarm-1' });
    assert.equal(out.ok, true, out.reason);
    assert.deepEqual(out.summary, { stage: 'workers', dispatches: 5, batches: 3, resumeRunId: 'swarm-1' });
    assert.match(out.script, /const gsdStage_0_0_0 = await parallel/);
    assert.match(out.script, /const gsdStage_0_0_2 = await parallel/);
    assert.match(out.script, /workflowSizeGuideline/);
    const { result, calls } = await runScript(out.script, (prompt) => `{"answer":"${prompt}"}`);
    assert.deepEqual(calls.barriers, [2, 2, 1]);
    assert.deepEqual(calls.agents[0].opts, { agentType: FAN_OUT_WORKER_AGENT, model: 'haiku' }, 'no schema option: the result stays raw text');
    assert.deepEqual(result, Array.from({ length: 5 }, (_, i) => ({ purpose: 'worker', text: `{"answer":"question ${i}"}` })));
  });

  test('C at or above the stage size renders one barrier with no batch suffix', () => {
    const out = renderFanOutStage({ plan: fanOutPlan(3), stageId: 'workers', concurrency: 3, runId: 'r' });
    assert.equal(out.summary.batches, 1);
    assert.match(out.script, /const gsdStage_0_0 = await parallel/);
    assert.doesNotMatch(out.script, /gsdStage_0_0_\d/);
  });

  test('a hostile prompt is carried as data: the script still runs and agent() gets it verbatim', async () => {
    const plan = fanOutPlan(2);
    plan.stages[0].dispatches[1].prompt = HOSTILE;
    const out = renderFanOutStage({ plan, stageId: 'workers', concurrency: 20, runId: 'r' });
    const { calls } = await runScript(out.script, () => '{}');
    assert.deepEqual(calls.agents.map((a) => a.prompt), ['question 0', HOSTILE]);
  });

  describe('refusals', () => {
    const cases = [
      ['the synthesizer stage', () => ({ plan: fanOutPlan(2), stageId: 'synthesize' }), /synthesizer stage is not rendered/],
      ['an unknown stage', () => ({ plan: fanOutPlan(2), stageId: 'nope' }), /no stage "nope"/],
      ['concurrency 0', () => ({ plan: fanOutPlan(2), concurrency: 0 }), /concurrency must be a positive integer/],
      ['concurrency NaN', () => ({ plan: fanOutPlan(2), concurrency: Number.NaN }), /concurrency must be a positive integer/],
      ['a run id with a quote', () => ({ plan: fanOutPlan(2), runId: 'a"b' }), /runId must be/],
      ['a model with U+2028', () => { const plan = fanOutPlan(2); plan.stages[0].dispatches[0].model = 'h x'; return { plan }; }, /model must not contain/],
      ['a stage id with a quote', () => { const plan = fanOutPlan(2); plan.stages[0].id = 'w"x'; return { plan, stageId: 'w"x' }; }, /id must be a non-empty string/],
    ];
    for (const [name, make, re] of cases) {
      test(name, () => {
        const out = renderFanOutStage({ stageId: 'workers', concurrency: 20, runId: 'r', ...make() });
        assert.equal(out.ok, false);
        assert.match(out.reason, re);
      });
    }

    for (const field of [...EXECUTOR_ONLY_FIELDS, 'id']) {
      test(`the executor-only field ${field} on a strategy dispatch`, () => {
        const plan = fanOutPlan(2);
        plan.stages[0].dispatches[1][field] = field === 'isolation' ? 'worktree' : 'x';
        const out = renderFanOutStage({ plan, stageId: 'workers', concurrency: 20, runId: 'r' });
        assert.equal(out.ok, false);
        assert.match(out.reason, new RegExp(`executor-only field ${field}`));
      });
    }
  });
});

describe('renderFanOutPlan input checks', () => {
  const stage = (id, phase) => ({ id, phase, dispatches: [workerDispatch(0)] });
  const opts = { name: 'n', description: 'd', header: [] };

  test('a header line carrying a line terminator is refused', () => {
    for (const h of ['a\nb', 'a\rb', 'a b', 'a b']) {
      assert.match(renderFanOutPlan({ stages: [stage('s')] }, { ...opts, header: [h] }).reason, /header must be/);
    }
  });

  test('a stage comment carrying a line terminator is refused', () => {
    const st = { ...stage('s'), comment: 'x\ny' };
    assert.match(renderFanOutPlan({ stages: [st] }, opts).reason, /comment must be a single-line string/);
  });

  test('a phase split by another phase is refused', () => {
    const r = renderFanOutPlan({ stages: [stage('a', 'P'), stage('b', 'Q'), stage('c', 'P')] }, opts);
    assert.match(r.reason, /phase "P" is split/);
  });

  test('explicit phases must match the stage phases in order', () => {
    const r = renderFanOutPlan({ stages: [stage('a', 'P')] }, { ...opts, phases: [{ title: 'Q', detail: '' }] });
    assert.match(r.reason, /phases must list every stage phase/);
  });

  test('a worktree_metadata dispatch needs a scriptable id', () => {
    const d = { ...workerDispatch(0), resultContract: 'worktree_metadata' };
    assert.match(renderFanOutPlan({ stages: [{ id: 's', dispatches: [d] }] }, opts).reason, /id is required/);
  });

  test('never throws on arbitrary input', () => {
    fc.assert(fc.property(fc.anything(), fc.anything(), (plan, o) => {
      const r = renderFanOutPlan(plan, o);
      assert.equal(typeof r.ok, 'boolean');
    }), { numRuns: 300 });
    fc.assert(fc.property(fc.anything(), (input) => {
      const r = renderFanOutStage(input);
      assert.equal(typeof r.ok, 'boolean');
    }), { numRuns: 300 });
  });
});

describe('CLI: loop fan-out-plan → claude-orchestration render-fan-out', () => {
  let tmp;
  const env = () => ({ HOME: tmp, GSD_RUNTIME: 'claude', GSD_DISPATCH_MAX_CONCURRENCY: '20' });

  before(() => {
    tmp = createTempProject('gsd-fan-out-render-');
    fs.mkdirSync(path.join(tmp, 'src'));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmp, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
    fs.writeFileSync(path.join(tmp, 'files.txt'), [0, 1, 2, 3, 4].map((i) => `src/f${i}.ts`).join('\n') + '\n');
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({
      swarm: { enabled: true, max_concurrency: 2 },
      claude_orchestration: { enabled: true },
    }));
  });
  after(() => cleanup(tmp));

  test('the workers stage of a real verdict renders in ceil(dispatches / C) batches', async () => {
    const v = runGsdTools(['loop', 'fan-out-plan', '--cap-id', 'code-review', '--point', 'execute:post',
      '--agent', 'gsd-code-reviewer', '--phase', '1', '--scope-file', 'files.txt'], tmp, env());
    assert.equal(v.success, true, v.error);
    const verdict = JSON.parse(v.output);
    assert.equal(verdict.mode, 'fan-out', v.output);
    fs.writeFileSync(path.join(tmp, 'verdict.json'), v.output);

    const r = runGsdTools(['claude-orchestration', 'render-fan-out', '--verdict', 'verdict.json', '--stage', 'workers', '--run-id', 'r1'], tmp, env());
    assert.equal(r.success, true, r.error);
    const out = JSON.parse(r.output);
    const workers = verdict.plan.stages[0].dispatches.length;
    assert.deepEqual([out.summary.dispatches, out.summary.batches], [workers, Math.ceil(workers / verdict.concurrency.c)]);
    const { result } = await runScript(out.script, () => '{}');
    assert.deepEqual(result.map((x) => x.purpose), verdict.plan.stages[0].dispatches.map((d) => d.purpose));
  });

  test('the synthesizer stage and a single verdict are refused', () => {
    const s = runGsdTools(['claude-orchestration', 'render-fan-out', '--verdict', 'verdict.json', '--stage', 'synthesize', '--run-id', 'r1'], tmp, env());
    assert.equal(s.success, false);
    assert.match(s.error, /synthesizer stage is not rendered/);
    fs.writeFileSync(path.join(tmp, 'single.json'), JSON.stringify({ mode: 'single', reason: 'disabled', loud: false }));
    const one = runGsdTools(['claude-orchestration', 'render-fan-out', '--verdict', 'single.json', '--stage', 'workers', '--run-id', 'r1'], tmp, env());
    assert.equal(one.success, false);
    assert.match(one.error, /mode "fan-out"/);
  });
});
