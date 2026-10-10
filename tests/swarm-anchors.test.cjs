'use strict';

/**
 * Swarm anchor verification and pruning (#5273, ADR-5273 Decision 3 "Mechanical floor").
 *
 * These cases pin the MECHANICS: the anchor grammar, each source check, the claim-unit boundary in
 * each artefact schema, the REVIEW.md recount and the fail-closed paths. They are deliberately not
 * the representative gate fixtures: per tests/fixtures/representative/README.md a gate's fixtures
 * may not come from its author, so the real swarm artefacts and the real fabricated-anchor answer
 * land under tests/fixtures/representative/swarm-equivalence/ from the founder's captured runs,
 * and the equivalence assertions that read them are added then.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');

const {
  parseAnchors,
  checkAnchor,
  verifyAnchors,
  claimUnit,
  pruneArtefact,
  kindForArtefact,
  normalizeForMatch,
  REMOVED_SECTION,
  MAX_ANCHORS,
} = require('../gsd-core/bin/lib/swarm-anchors.cjs');

const anchor = (p, lines, quote) => `<!-- swarm-anchor ${JSON.stringify({ path: p, lines, quote })} -->`;

let root;
before(() => {
  root = createTempDir('gsd-swarm-anchors-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'const x = 1;\r\nconst  y =   2;\r\n');
});
after(() => cleanup(root));

describe('parseAnchors', () => {
  test('reads every well-formed anchor with its line, and reports malformed JSON by line', () => {
    const text = ['# T', `claim ${anchor('src/a.ts', '1', 'export function a(')}`, '<!-- swarm-anchor {"path": broken} -->', `two ${anchor('x', '1', 'q')} ${anchor('y', '2', 'r')}`].join('\n');
    const { anchors, malformed } = parseAnchors(text);
    assert.deepEqual(anchors.map((a) => [a.line, a.path]), [[1, 'src/a.ts'], [3, 'x'], [3, 'y']]);
    assert.deepEqual(malformed, [{ line: 2, path: '', lines: '', reason: 'malformed_anchor' }]);
  });

  test('property: never throws on arbitrary text, and finds nothing in text without the marker', () => {
    fc.assert(fc.property(fc.string(), (t) => {
      const r = parseAnchors(t);
      return Array.isArray(r.anchors) && (t.includes('swarm-anchor') || (r.anchors.length === 0 && r.malformed.length === 0));
    }));
  });

  test('property: an anchor built from any path, range and quote round-trips', () => {
    fc.assert(fc.property(fc.string(), fc.string(), fc.string().filter((q) => !q.includes('-->')), (p, l, q) => {
      const { anchors } = parseAnchors(`x ${anchor(p, l, q)}`);
      return anchors.length === 1 && anchors[0].path === p && anchors[0].lines === l && anchors[0].quote === q;
    }));
  });
});

describe('checkAnchor: each source check returns its own reason', () => {
  const at = (p, lines, quote) => checkAnchor({ line: 0, path: p, lines, quote }, root);

  test('a quote inside the cited lines holds; whitespace and CRLF are normalized on both sides', () => {
    assert.equal(at('src/a.ts', '1-2', 'export function a() { return 1;'), null);
    assert.equal(at('src/crlf.ts', '2', 'const y = 2;'), null);
    assert.equal(normalizeForMatch('a\r\n  b\tc '), 'a b c');
  });

  test('bounds: the last line holds, one past it is out_of_range (a trailing newline adds no line)', () => {
    assert.equal(at('src/a.ts', '3', '}'), null);
    assert.equal(at('src/a.ts', '4', '}'), 'out_of_range');
    assert.equal(at('src/a.ts', '3', ''), 'empty_quote');
  });

  test('a quote from another line, a bad range, and hostile paths each fail by name', () => {
    assert.equal(at('src/a.ts', '1', 'return 1'), 'quote_mismatch');
    assert.equal(at('src/a.ts', '0', 'x'), 'bad_lines');
    assert.equal(at('src/a.ts', '3-1', 'x'), 'bad_lines');
    assert.equal(at('src/a.ts', 'one', 'x'), 'bad_lines');
    assert.equal(at('../etc/passwd', '1', 'root'), 'path_dot_dot');
    assert.equal(at('/etc/passwd', '1', 'root'), 'path_absolute');
    assert.equal(at('src/missing.ts', '1', 'x'), 'path_missing');
    assert.equal(at('src\n.ts', '1', 'x'), 'path_control_char');
  });

  test('a symlink that escapes the root is rejected without reading its target', () => {
    const outside = createTempDir('gsd-swarm-outside-');
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));
      let reads = 0;
      const r = checkAnchor({ line: 0, path: 'src/link.txt', lines: '1', quote: 'TOP SECRET' }, root, () => { reads++; return 'TOP SECRET'; });
      assert.equal(r, 'path_escapes_root');
      assert.equal(reads, 0);
    } finally {
      fs.unlinkSync(path.join(root, 'src', 'link.txt'));
      cleanup(outside);
    }
  });

  test(`more than ${MAX_ANCHORS} anchors are refused as a whole`, () => {
    const text = Array.from({ length: MAX_ANCHORS + 1 }, () => `c ${anchor('src/a.ts', '1', 'export')}`).join('\n');
    assert.equal(verifyAnchors(text, root).tooMany, true);
  });
});

describe('claimUnit: the claim around an anchor, per schema', () => {
  test('a list item with its continuation lines', () => {
    const lines = ['## S', '- first claim', `- second claim ${anchor('a', '1', 'q')}`, '  continued', '- third', ''];
    assert.deepEqual(claimUnit(lines, 2, 'research'), [2, 3]);
  });

  test('an anchor alone on the line after a list item belongs to that item', () => {
    const lines = ['## S', '- claim one', anchor('a', '1', 'q'), '- claim two'];
    assert.deepEqual(claimUnit(lines, 2, 'research'), [1, 2]);
  });

  test('a table row is just its row', () => {
    const lines = ['| a | b |', '|---|---|', `| x | y ${anchor('a', '1', 'q')} |`, '| z | w |'];
    assert.deepEqual(claimUnit(lines, 2, 'research'), [2, 2]);
  });

  test('a paragraph runs between blank lines', () => {
    const lines = ['## S', '', 'line one', `line two ${anchor('a', '1', 'q')}`, 'line three', '', 'next'];
    assert.deepEqual(claimUnit(lines, 3, 'research'), [2, 4]);
  });

  test('PATTERNS: a label line takes the fenced excerpt it introduces', () => {
    const lines = ['### src/x.ts', `**Auth pattern** (lines 12-18): ${anchor('a', '12-18', 'q')}`, '```ts', 'code', '```', '', 'after'];
    assert.deepEqual(claimUnit(lines, 1, 'patterns'), [1, 4]);
  });

  test('an anchor inside a heading cannot be pruned cleanly', () => {
    assert.equal(claimUnit(['## Heading ' + anchor('a', '1', 'q')], 0, 'research'), null);
  });

  test('REVIEW: the whole finding block up to the next heading', () => {
    const lines = ['## Warnings', '', '### WR-01: T', '', `**File:** \`a:1\` ${anchor('a', '1', 'q')}`, '**Issue:** i', '', '### WR-02: U', 'x'];
    assert.deepEqual(claimUnit(lines, 4, 'review'), [2, 5]);
    assert.equal(claimUnit(['## Summary', `text ${anchor('a', '1', 'q')}`], 1, 'review'), null);
  });
});

function reviewDoc(wrongWarning, wrongCritical) {
  const crQuote = wrongCritical ? 'not in the file' : 'export function a(';
  const wrQuote = wrongWarning ? 'not in the file' : 'return 1;';
  return [
    '---', 'phase: 1', 'files_reviewed_list:', '  - src/a.ts', 'findings:', '  critical: 1', '  warning: 1', '  info: 0', '  total: 2', 'status: issues_found', '---',
    '# Phase 1: Code Review Report', '', '**Status:** issues_found', '', '## Critical Issues', '',
    '### CR-01: Critical thing', '', `**File:** \`src/a.ts:1\` ${anchor('src/a.ts', '1', crQuote)}`, '**Issue:** bad', '',
    '## Warnings', '',
    '### WR-01: Warning thing', '', `**File:** \`src/a.ts:2\` ${anchor('src/a.ts', '2', wrQuote)}`, '**Issue:** meh', '',
    '---', '', '_Reviewed: now_', '',
  ].join('\n');
}

describe('pruneArtefact: REVIEW.md', () => {
  test('all anchors holding: the artefact is returned unchanged', () => {
    const doc = reviewDoc(false, false);
    const r = pruneArtefact(doc, 'review', root);
    assert.deepEqual([r.verdict, r.pruned.length, r.text === doc], ['ok', 0, true]);
  });

  test('a fabricated warning removes WR-01, recounts the frontmatter, drops the empty Warnings section, and lists it', () => {
    const r = pruneArtefact(reviewDoc(true, false), 'review', root);
    assert.equal(r.verdict, 'ok');
    assert.deepEqual(r.pruned.map((p) => p.reason), ['quote_mismatch']);
    assert.ok(!r.text.includes('### WR-01'));
    assert.ok(!r.text.includes('## Warnings'));
    assert.ok(r.text.includes('### CR-01'));
    assert.match(r.text, /\n {2}warning: 0\n/);
    assert.match(r.text, /\n {2}total: 1\n/);
    assert.match(r.text, /\nstatus: issues_found\n/);
    assert.ok(r.text.includes(REMOVED_SECTION));
    assert.ok(r.text.includes('- `src/a.ts:2` — quote_mismatch'));
    assert.ok(!r.text.includes('not in the file') || r.text.indexOf('not in the file') < r.text.indexOf(REMOVED_SECTION), 'the removal list echoes no quote');
  });

  test('every finding removed: counts are zero and status turns clean in frontmatter and body', () => {
    const r = pruneArtefact(reviewDoc(true, true), 'review', root);
    assert.equal(r.verdict, 'ok');
    assert.match(r.text, /\n {2}total: 0\n/);
    assert.match(r.text, /\nstatus: clean\n/);
    assert.ok(r.text.includes('**Status:** clean'));
  });
});

describe('pruneArtefact: RESEARCH.md fails closed when pruning would empty a required section', () => {
  const doc = (wrong) => [
    '# Research', '', '## Architectural Responsibility Map', '', `- the data layer owns a ${anchor('src/a.ts', '1', wrong ? 'nope' : 'export function a(')}`, '',
    '## Open Questions', '', '- none', '', '## Validation Architecture', '', '- unit tests', '',
  ].join('\n');

  test('a failing anchor whose removal leaves a required section empty is anchor_check_failed', () => {
    const r = pruneArtefact(doc(true), 'research', root);
    assert.deepEqual([r.verdict, r.reason], ['anchor_check_failed', 'required_section_emptied']);
  });

  test('a failing anchor in a section that keeps other content is pruned', () => {
    const text = doc(false).replace('- none', `- none\n- a fabricated claim ${anchor('src/a.ts', '3', 'nothing like this')}`);
    const r = pruneArtefact(text, 'research', root);
    assert.equal(r.verdict, 'ok');
    assert.ok(!r.text.includes('fabricated claim'));
    assert.ok(r.text.includes('- none'));
  });

  test('CRLF artefacts stay CRLF after pruning', () => {
    const text = doc(false).replace('- none', `- none\n- bad ${anchor('src/a.ts', '3', 'zzz')}`).replace(/\n/g, '\r\n');
    const r = pruneArtefact(text, 'research', root);
    assert.equal(r.verdict, 'ok');
    assert.ok(!/[^\r]\n/.test(r.text));
  });
});

describe('kindForArtefact', () => {
  test('the three artefact names map to their kinds; anything else is null', () => {
    assert.deepEqual(['01-RESEARCH.md', '01-PATTERNS.md', '01-REVIEW.md', '01-SUMMARY.md'].map(kindForArtefact), ['research', 'patterns', 'review', null]);
  });
});

describe('CLI: swarm verify-anchors', () => {
  let tmp;
  before(() => {
    tmp = createTempProject('gsd-swarm-va-');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function a() {\n  return 1;\n}\n');
  });
  after(() => cleanup(tmp));

  test('report mode names the failing anchor and leaves the file untouched; --prune rewrites it', () => {
    const p = path.join(tmp, '01-REVIEW.md');
    const doc = reviewDoc(true, false);
    fs.writeFileSync(p, doc);
    const report = runGsdTools(['swarm', 'verify-anchors', '01-REVIEW.md'], tmp, { HOME: tmp });
    assert.equal(report.success, true, report.error);
    const out = JSON.parse(report.output);
    assert.deepEqual([out.verdict, out.total, out.failures.map((f) => f.reason)], ['anchor_check_failed', 2, ['quote_mismatch']]);
    assert.equal(fs.readFileSync(p, 'utf8'), doc);

    const pruned = runGsdTools(['swarm', 'verify-anchors', '01-REVIEW.md', '--prune'], tmp, { HOME: tmp });
    assert.equal(pruned.success, true, pruned.error);
    assert.deepEqual([JSON.parse(pruned.output).verdict, JSON.parse(pruned.output).written], ['ok', true]);
    assert.ok(!fs.readFileSync(p, 'utf8').includes('### WR-01'));
  });

  test('an artefact outside the project root, or of unknown kind, is a usage error', () => {
    assert.equal(runGsdTools(['swarm', 'verify-anchors', '../x-REVIEW.md'], tmp, { HOME: tmp }).success, false);
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'x');
    assert.equal(runGsdTools(['swarm', 'verify-anchors', 'notes.md'], tmp, { HOME: tmp }).success, false);
  });
});
