/**
 * Swarm anchor verification and pruning (#5273, ADR-5273 Decision 3 "Mechanical floor").
 *
 * The synthesizer marks every worker claim it keeps with an anchor, a JSON object inside an HTML
 * comment on one line:
 *
 *   <!-- swarm-anchor {"path":"src/a.ts","lines":"12-18","quote":"export function a("} -->
 *
 * `verifyAnchors` checks each anchor against the source: the path passes core's containment
 * check, the line range is in bounds, and the quote occurs in the cited lines (line endings and
 * whitespace runs normalized on both sides). It never returns file content, only reason codes, so
 * it is not a read oracle.
 *
 * `pruneArtefact` removes the claim unit around each failing anchor, by the artefact's schema:
 *
 * - REVIEW.md: the whole `### XX-NN:` finding block; the frontmatter `findings` counts and
 *   `status`, and the body `**Status:**` line, are recomputed, and a severity section left
 *   without findings is removed.
 * - RESEARCH.md and PATTERNS.md: the smallest enclosing element — a table row, a list item, a
 *   label line with the fenced code block it introduces, or a paragraph.
 *
 * Pruning that cannot be done cleanly (an anchor inside a heading or outside any finding block,
 * or a required section left empty) returns `anchor_check_failed`, and the caller falls back to
 * single-agent dispatch. Every removal is listed in a closing section of the artefact.
 */

import fs from 'node:fs';
import path from 'node:path';

import { checkScopePath } from './fan-out-plan.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';

export const ANCHOR_RE = /<!-- swarm-anchor (\{.*?\}) -->/g;
export const MAX_ANCHORS = 2000;
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const REMOVED_SECTION = '## Swarm: removed unverified claims';

export type ArtefactKind = 'research' | 'patterns' | 'review';

export const REQUIRED_SECTIONS: Readonly<Record<ArtefactKind, readonly string[]>> = Object.freeze({
  research: ['## Architectural Responsibility Map', '## Open Questions', '## Validation Architecture'],
  patterns: ['## File Classification', '## Pattern Assignments', '## Shared Patterns'],
  review: [],
});

export interface Anchor {
  /** 0-based line index of the anchor comment in the artefact. */
  line: number;
  path: string;
  lines: string;
  quote: string;
}

export interface AnchorFailure {
  line: number;
  path: string;
  lines: string;
  reason: string;
}

const LINES_RE = /^([1-9]\d*)(?:-([1-9]\d*))?$/;

export function kindForArtefact(file: string): ArtefactKind | null {
  const base = path.basename(file);
  if (/RESEARCH\.md$/.test(base)) return 'research';
  if (/PATTERNS\.md$/.test(base)) return 'patterns';
  if (/REVIEW\.md$/.test(base)) return 'review';
  return null;
}

/** Every anchor in the artefact; a comment whose JSON is malformed is reported as a failure. */
export function parseAnchors(text: string): { anchors: Anchor[]; malformed: AnchorFailure[] } {
  const anchors: Anchor[] = [];
  const malformed: AnchorFailure[] = [];
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(ANCHOR_RE)) {
      let v: unknown;
      try {
        v = JSON.parse(m[1]);
      } catch {
        v = null;
      }
      const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      if (o && typeof o['path'] === 'string' && typeof o['lines'] === 'string' && typeof o['quote'] === 'string') {
        anchors.push({ line: i, path: o['path'], lines: o['lines'], quote: o['quote'] });
      } else {
        malformed.push({ line: i, path: o && typeof o['path'] === 'string' ? o['path'] : '', lines: o && typeof o['lines'] === 'string' ? o['lines'] : '', reason: 'malformed_anchor' });
      }
    }
  });
  return { anchors, malformed };
}

/** Line endings and whitespace runs collapse, so a CRLF file and a reflowed quote still match. */
export function normalizeForMatch(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

export type ReadSource = (absPath: string) => string | null;

export function defaultReadSource(absPath: string): string | null {
  try {
    const st = fs.lstatSync(absPath);
    if (!st.isFile() || st.size > SOURCE_MAX_BYTES) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Check one anchor; returns a reason code, or null when it holds. */
export function checkAnchor(a: Anchor, projectRoot: string, read: ReadSource = defaultReadSource): string | null {
  const contained = checkScopePath(projectRoot, a.path);
  if (!contained.ok) return `path_${contained.code}`;
  const m = LINES_RE.exec(a.lines);
  if (!m) return 'bad_lines';
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (end < start) return 'bad_lines';
  const src = read(path.resolve(projectRoot, a.path));
  if (src === null) return 'unreadable';
  const fileLines = src.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline ends the last line; it does not start a phantom line N+1.
  if (fileLines.length > 1 && fileLines[fileLines.length - 1] === '') fileLines.pop();
  if (end > fileLines.length) return 'out_of_range';
  const quote = normalizeForMatch(a.quote);
  if (quote.length === 0) return 'empty_quote';
  return normalizeForMatch(fileLines.slice(start - 1, end).join('\n')).includes(quote) ? null : 'quote_mismatch';
}

export function verifyAnchors(text: string, projectRoot: string, read: ReadSource = defaultReadSource): {
  total: number;
  failures: AnchorFailure[];
  tooMany: boolean;
} {
  const { anchors, malformed } = parseAnchors(text);
  const total = anchors.length + malformed.length;
  if (total > MAX_ANCHORS) return { total, failures: [], tooMany: true };
  const failures = [...malformed];
  for (const a of anchors) {
    const reason = checkAnchor(a, projectRoot, read);
    if (reason) failures.push({ line: a.line, path: a.path, lines: a.lines, reason });
  }
  failures.sort((x, y) => x.line - y.line);
  return { total, failures, tooMany: false };
}

// ─── Claim units ─────────────────────────────────────────────────────────────

const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(```|~~~)/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s/;
const FINDING_RE = /^### ([A-Z]{2})-\d+:/;

function anchorOnly(line: string): boolean {
  return line.replace(ANCHOR_RE, '').trim().length === 0;
}

/** Index ranges of fenced code blocks: [open, close] inclusive. An unclosed fence runs to the end. */
function fenceRanges(lines: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  lines.forEach((l, i) => {
    if (FENCE_RE.test(l)) {
      if (open === -1) open = i;
      else {
        out.push([open, i]);
        open = -1;
      }
    }
  });
  if (open !== -1) out.push([open, lines.length - 1]);
  return out;
}

/** Index of the first content line after a leading YAML frontmatter block (the repo's one fence reader). */
function bodyStart(lines: readonly string[]): number {
  const text = lines.join('\n');
  const fence = locateFrontmatterFence(text);
  if (!fence || !fence.closed) return 0;
  return text.slice(0, fence.closingStart).split('\n').length;
}

/** A Markdown thematic break (the REVIEW.md footer rule), which also ends a finding block. */
const THEMATIC_BREAK_RE = /^-{3,}[ \t]*$/;

/** The inclusive line range of the claim an anchor belongs to, or null when it cannot be located cleanly. */
export function claimUnit(lines: readonly string[], anchorLine: number, kind: ArtefactKind): [number, number] | null {
  const start0 = bodyStart(lines);
  if (anchorLine < start0) return null;
  if (kind === 'review') {
    let h = -1;
    for (let i = anchorLine; i >= start0; i--) {
      if (FINDING_RE.test(lines[i])) {
        h = i;
        break;
      }
      if (/^#{1,3}\s/.test(lines[i])) return null;
    }
    if (h === -1) return null;
    let end = lines.length - 1;
    for (let i = h + 1; i < lines.length; i++) {
      if (/^#{1,3}\s/.test(lines[i]) || THEMATIC_BREAK_RE.test(lines[i])) {
        end = i - 1;
        break;
      }
    }
    while (end > h && lines[end].trim() === '') end--;
    return [h, end];
  }

  const fences = fenceRanges(lines);
  const inFence = (i: number) => fences.find(([a, b]) => i >= a && i <= b);
  // The claim line: the anchor's own line, or the line before when the anchor stands alone.
  let c = anchorLine;
  if (anchorOnly(lines[anchorLine])) {
    c = anchorLine - 1;
    while (c >= start0 && lines[c].trim() === '') c--;
    if (c < start0) return null;
  }
  const fenced = inFence(c);
  if (fenced) {
    // An anchor right after an excerpt: the unit is the excerpt and the label line before it.
    let a = fenced[0];
    if (a - 1 >= start0 && lines[a - 1].trim() !== '' && !HEADING_RE.test(lines[a - 1])) a--;
    return [a, Math.max(fenced[1], anchorLine)];
  }
  if (HEADING_RE.test(lines[c])) return null;
  if (lines[c].trimStart().startsWith('|')) return [c, Math.max(c, anchorLine)];

  // A label line that introduces a fenced excerpt takes the excerpt with it.
  let next = Math.max(c, anchorLine) + 1;
  while (next < lines.length && lines[next].trim() === '') next++;
  const following = next < lines.length ? inFence(next) : undefined;
  if (following && following[0] === next && next - Math.max(c, anchorLine) <= 2) return [c, following[1]];

  const list = LIST_RE.exec(lines[c]);
  if (list || (/^\s+\S/.test(lines[c]) && c > start0)) {
    // Walk up to the item's marker line, then down to the next sibling or a blank line.
    let s = c;
    while (s > start0 && !LIST_RE.test(lines[s]) && /^\s+\S/.test(lines[s])) s--;
    const m = LIST_RE.exec(lines[s]);
    if (!m) return null;
    const indent = m[1].length;
    let e = Math.max(c, anchorLine);
    for (let i = s + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '' || HEADING_RE.test(l)) break;
      const mm = LIST_RE.exec(l);
      if (mm && mm[1].length <= indent) break;
      e = i;
    }
    return [s, Math.max(e, anchorLine)];
  }

  let s = c;
  while (s - 1 >= start0 && lines[s - 1].trim() !== '' && !HEADING_RE.test(lines[s - 1]) && !inFence(s - 1)) s--;
  let e = Math.max(c, anchorLine);
  while (e + 1 < lines.length && lines[e + 1].trim() !== '' && !HEADING_RE.test(lines[e + 1]) && !inFence(e + 1)) e++;
  return [s, e];
}

// ─── REVIEW.md recount ───────────────────────────────────────────────────────

const SEVERITY_BY_PREFIX: Readonly<Record<string, 'critical' | 'warning' | 'info'>> = Object.freeze({ CR: 'critical', BL: 'critical', WR: 'warning', IN: 'info' });
const SEVERITY_SECTIONS = ['## Critical Issues', '## Warnings', '## Info'];

function recountReview(lines: string[]): string[] {
  const counts = { critical: 0, warning: 0, info: 0 };
  const start0 = bodyStart(lines);
  for (let i = start0; i < lines.length; i++) {
    const m = FINDING_RE.exec(lines[i]);
    if (m && SEVERITY_BY_PREFIX[m[1]]) counts[SEVERITY_BY_PREFIX[m[1]]]++;
  }
  const total = counts.critical + counts.warning + counts.info;
  const status = total === 0 ? 'clean' : 'issues_found';
  // A severity section with no finding left is omitted, as the reviewer's schema already does.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i >= start0 && SEVERITY_SECTIONS.includes(lines[i].trim())) {
      let j = i + 1;
      while (j < lines.length && !/^#{1,2}\s/.test(lines[j]) && !THEMATIC_BREAK_RE.test(lines[j])) j++;
      if (!lines.slice(i + 1, j).some((l) => FINDING_RE.test(l))) {
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  const fmEnd = start0 > 0 ? start0 - 1 : -1;
  return out.map((l, i) => {
    if (i < fmEnd) {
      const m = /^(\s+)(critical|blocker|warning|info|total):\s*\d+\s*$/.exec(l);
      if (m) {
        const key = m[2] === 'blocker' ? 'critical' : (m[2] as 'critical' | 'warning' | 'info' | 'total');
        return `${m[1]}${m[2]}: ${key === 'total' ? total : counts[key]}`;
      }
      if (/^status:\s*\S+/.test(l)) return `status: ${status}`;
    } else if (/^\*\*Status:\*\*/.test(l)) {
      return `**Status:** ${status}`;
    }
    return l;
  });
}

// ─── Prune ───────────────────────────────────────────────────────────────────

export type PruneResult =
  | { verdict: 'ok'; total: number; pruned: AnchorFailure[]; text: string }
  | { verdict: 'anchor_check_failed'; total: number; reason: string; failures: AnchorFailure[] };

function sectionEmpty(lines: readonly string[], heading: string): boolean {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return false;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^#{1,2}\s/.test(lines[j])) break;
    if (lines[j].trim() !== '') return false;
  }
  return true;
}

export function pruneArtefact(text: string, kind: ArtefactKind, projectRoot: string, read: ReadSource = defaultReadSource): PruneResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const checked = verifyAnchors(lines.join('\n'), projectRoot, read);
  if (checked.tooMany) return { verdict: 'anchor_check_failed', total: checked.total, reason: 'too_many_anchors', failures: [] };
  if (checked.failures.length === 0) return { verdict: 'ok', total: checked.total, pruned: [], text };

  const ranges: Array<[number, number]> = [];
  for (const f of checked.failures) {
    const unit = claimUnit(lines, f.line, kind);
    if (!unit) return { verdict: 'anchor_check_failed', total: checked.total, reason: 'unit_not_located', failures: checked.failures };
    ranges.push(unit);
  }
  const drop = new Set<number>();
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) drop.add(i);
  let kept = lines.filter((_, i) => !drop.has(i));
  if (kind === 'review') kept = recountReview(kept);

  for (const heading of REQUIRED_SECTIONS[kind]) {
    if (!sectionEmpty(lines, heading) && sectionEmpty(kept, heading)) {
      return { verdict: 'anchor_check_failed', total: checked.total, reason: 'required_section_emptied', failures: checked.failures };
    }
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push('', REMOVED_SECTION, '', `The swarm anchor check removed ${checked.failures.length} claim(s) whose evidence did not hold against the source.`, '');
  // Path and lines come from the artefact, which a model wrote: strip what could break the list item.
  const safe = (v: string) => (v || '?').replace(/[`\x00-\x1f\x7f\u2028\u2029]/g, '?').slice(0, 300);
  for (const f of checked.failures) kept.push(`- \`${safe(f.path)}:${safe(f.lines)}\` — ${f.reason}`);
  kept.push('');
  return { verdict: 'ok', total: checked.total, pruned: checked.failures, text: kept.join(eol) };
}
