'use strict';

/**
 * ADR-5273 implementation step 4: the three swarm spawn sites.
 *
 * The code-review site's fan-out fence is executed for real in a temp project, so the test proves
 * what the workflow runs, not what it says: swarm off is a quiet `single` (the site's spawn runs
 * unchanged), swarm on fans out over exactly `REVIEW_FILES`. The executor procedure lives in
 * `gsd-core/references/fan-out-dispatch.md`; its site table is checked against the capability
 * manifests, and its telemetry example against the real `swarm record` validator.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { SEAM_DEFAULT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { extractBashBlockContaining } = require('./helpers/pr-branch-filter.cjs');
const { findTableWithColumns } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { ANSWERS_SLOT, ROLE_BY_AGENT, buildTelemetryEntry } = require('../gsd-core/bin/lib/swarm.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PLAN_PHASE = read('gsd-core/workflows/plan-phase.md');
const CODE_REVIEW = read('gsd-core/workflows/code-review.md');
const CODE_REVIEW_STEP = read('gsd-core/workflows/code-review/steps/swarm-fan-out.md');
const REFERENCE = read('gsd-core/references/fan-out-dispatch.md');

describe('code-review spawn site: the fan-out step file, executed', () => {
  let tmp;
  const fence = extractBashBlockContaining(CODE_REVIEW_STEP, 'loop fan-out-plan');
  const runFence = (cfg) => {
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify(cfg));
    const script = [
      'set -uo pipefail',
      'PADDED_PHASE="01"',
      'REVIEW_FILES=("src/a.ts" "src/b c.ts" "src/d.ts")',
      fence,
      'printf "%s" "$FANOUT"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: SEAM_DEFAULT_TIMEOUT_MS,
      // RUNTIME_DIR points the fence's launcher preamble at this checkout's CLI.
      env: { ...process.env, HOME: tmp, RUNTIME_DIR: ROOT, GSD_RUNTIME: 'claude', GSD_DISPATCH_MAX_CONCURRENCY: '20' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  before(() => {
    tmp = createTempProject('gsd-swarm-sites-');
    fs.mkdirSync(path.join(tmp, 'src'));
    // 160 lines each: past REVIEW_UNIT_LINES, so every file is its own review unit.
    for (const f of ['a.ts', 'b c.ts', 'd.ts']) fs.writeFileSync(path.join(tmp, 'src', f), 'export {};\n'.repeat(160));
    fs.mkdirSync(path.join(tmp, '.planning', 'phases', '01-demo'), { recursive: true });
  });
  after(() => cleanup(tmp));

  test('the fence is one block that writes the scope file and calls the verb with the code-review row', () => {
    assert.match(fence, /printf '%s\\n' "\$\{REVIEW_FILES\[@\]\}" > "\$SWARM_SCOPE_FILE"/);
    assert.match(fence, /--cap-id code-review --point "\$CODE_REVIEW_POINT"/);
    assert.match(fence, /--agent gsd-code-reviewer/);
  });

  test('code-review.md reads the step file inside spawn_reviewer, after the scope blocks and before the spawn', () => {
    const step = CODE_REVIEW.slice(CODE_REVIEW.indexOf('<step name="spawn_reviewer">'), CODE_REVIEW.indexOf('<step name="commit_review">'));
    const pointer = step.indexOf('read and execute `gsd-core/workflows/code-review/steps/swarm-fan-out.md`');
    assert.ok(pointer > step.indexOf('CONFIG_FILES=""'), 'pointer must follow the scope blocks');
    assert.ok(pointer < step.indexOf('Agent('), 'pointer must come before the spawn');
    assert.ok(!CODE_REVIEW.includes('loop fan-out-plan'), 'the fence lives in the step file, not code-review.md');
  });

  test('swarm off: a quiet single, so the reviewer spawn below runs unchanged', () => {
    assert.deepEqual(runFence({}), { mode: 'single', reason: 'no_strategy', loud: false });
  });

  test('swarm on: one worker per REVIEW_FILES entry (a path with a space included) plus the cross-file worker', () => {
    const r = runFence({ swarm: { enabled: true } });
    assert.equal(r.mode, 'fan-out', JSON.stringify(r));
    const scopes = r.plan.stages[0].dispatches.map((d) => d.scope);
    assert.deepEqual(scopes, [['src/a.ts'], ['src/b c.ts'], ['src/d.ts'], ['src/a.ts', 'src/b c.ts', 'src/d.ts']]);
    assert.ok(r.plan.stages[1].dispatches[0].prompt.includes(ANSWERS_SLOT));
  });
});

describe('plan-phase spawn sites: the hooks they gate on carry the trait', () => {
  let tmp;
  before(() => { tmp = createTempProject('gsd-swarm-hooks-'); });
  after(() => cleanup(tmp));

  test('render-hooks plan:pre --raw emits supportsFanOut on the research and pattern-mapper hooks', () => {
    fs.writeFileSync(path.join(tmp, '.planning', 'config.json'), JSON.stringify({ swarm: { enabled: true }, workflow: { pattern_mapper: true } }));
    const r = spawnSync(process.execPath, [TOOLS_PATH, 'loop', 'render-hooks', 'plan:pre', '--raw'], {
      cwd: tmp, encoding: 'utf8', timeout: SEAM_DEFAULT_TIMEOUT_MS, env: { ...process.env, HOME: tmp },
    });
    assert.equal(r.status, 0, r.stderr);
    const hooks = JSON.parse(r.stdout).activeHooks;
    for (const [capId, agent] of [['research', 'gsd-phase-researcher'], ['pattern-mapper', 'gsd-pattern-mapper']]) {
      const hook = hooks.find((h) => h.capId === capId);
      assert.ok(hook, `${capId} hook not active`);
      assert.deepEqual([hook.ref.agent, hook.supportsFanOut], [agent, true], capId);
    }
  });
});

describe('plan-phase spawn sites: pointers, not procedure', () => {
  const research = PLAN_PHASE.slice(PLAN_PHASE.indexOf('### Spawn gsd-phase-researcher'), PLAN_PHASE.indexOf('### Handle Researcher Return'));
  const mapper = PLAN_PHASE.slice(PLAN_PHASE.indexOf('## 7.8. Spawn gsd-pattern-mapper'), PLAN_PHASE.indexOf('## 7.9.'));

  test('the research site points at the reference before its Agent() call', () => {
    const pointer = research.indexOf('`supportsFanOut`, first follow `gsd-core/references/fan-out-dispatch.md` (research row)');
    assert.ok(pointer > 0, 'research pointer missing');
    assert.ok(pointer < research.indexOf('Agent('), 'pointer must come before the spawn');
  });

  test('the pattern-mapper site points at the same procedure before its Agent() call', () => {
    const pointer = mapper.indexOf('Fan-out: as in step 5, pattern-mapping row.');
    assert.ok(pointer > 0, 'pattern-mapper pointer missing');
    assert.ok(pointer < mapper.indexOf('Agent('), 'pointer must come before the spawn');
  });

  test('no procedure text and no eager import of the reference enter plan-phase.md', () => {
    assert.ok(!PLAN_PHASE.includes('@gsd-core/references/fan-out-dispatch.md'));
    assert.ok(!PLAN_PHASE.includes('swarm check-answers'));
    assert.ok(!PLAN_PHASE.includes(ANSWERS_SLOT));
  });
});

describe('fan-out-dispatch.md executor procedure', () => {
  const table = findTableWithColumns(REFERENCE, ['Site', '`--cap-id`', '`--point`', '`--agent`', 'Artefact']);
  const bare = (cell) => cell.replace(/`/g, '');
  const rows = (table ? table.rows : []).map((r) => ({ capId: bare(r['`--cap-id`']), point: bare(r['`--point`']), agent: bare(r['`--agent`']) }));

  test('the site table has the three swarm roles', () => {
    assert.deepEqual(rows.map((r) => ROLE_BY_AGENT[r.agent]).sort(), ['code-reviewer', 'pattern-mapper', 'researcher']);
  });

  test('every row names a step its capability declares with supportsFanOut on that point and agent', () => {
    for (const { capId, point, agent } of rows) {
      const manifest = JSON.parse(read(`capabilities/${capId}/capability.json`));
      const fanOut = manifest.steps.filter((s) => s.supportsFanOut === true);
      if (point === '$CODE_REVIEW_POINT') {
        assert.deepEqual(fanOut.map((s) => s.point).sort(), ['execute:post', 'execute:wave:post'], capId);
      } else {
        assert.ok(fanOut.some((s) => s.point === point && s.ref && s.ref.agent === agent), `${capId} ${point} ${agent}`);
      }
    }
  });

  test('it names the answers slot, the answers file and the three swarm post-steps', () => {
    assert.ok(REFERENCE.includes(ANSWERS_SLOT));
    assert.ok(REFERENCE.includes('${PHASE_DIR}/${PADDED_PHASE}-SWARM-ANSWERS-<role>.json'));
    for (const cmd of ['gsd_run swarm check-answers --agent', 'gsd_run swarm verify-anchors <artefact> --prune', 'gsd_run swarm record --phase']) {
      assert.ok(REFERENCE.includes(cmd), cmd);
    }
  });

  test('its telemetry example passes the real swarm record validator', () => {
    const lines = splitLines(REFERENCE);
    const bodies = scanFencedBlocks(lines)
      .filter((b) => b.closeLineIdx !== -1 && b.infoString.trim() === 'json')
      .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'))
      .filter((body) => body.includes('"run_id"'));
    assert.equal(bodies.length, 1, 'exactly one telemetry example');
    const built = buildTelemetryEntry(JSON.parse(bodies[0]));
    assert.equal(built.ok, true, built.detail);
    assert.deepEqual(built.entry.tokens_by_model, {});
  });
});
