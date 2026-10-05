#!/usr/bin/env node
// Workflow policy for the publish credentials (happyvertical/iac#2165).
//
// - Every job that references a publish secret (NPM_HAPPYVERTICAL_PUBLISH_TOKEN,
//   NPM_TOKEN) declares `environment: release`, the Environment whose
//   deployment-branch rule allows only `main`. Its workflow may only be
//   triggered by push restricted to `branches: [main]`, schedule,
//   repository_dispatch, workflow_call or workflow_dispatch; a dispatchable
//   workflow also needs a job-level `if:` that is a plain main-ref guard (no
//   `||`, no negation).
// - No workflow triggered by pull_request, pull_request_target or merge_group
//   references a publish secret (a pull request runs its own copy of the
//   workflow files, so it could read the secret), and none passes
//   any `secrets:` pass-through.
//
// Dependency-free line scan of .github/workflows/*.yml; exits non-zero with one
// line per violation. Run: node scripts/verify-publish-environment.mjs [dir]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRETS = ['NPM_HAPPYVERTICAL_PUBLISH_TOKEN', 'NPM_TOKEN'];
const PR_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];
const names = SECRETS.join('|');
// secrets.NAME and secrets['NAME'] / secrets["NAME"]; names are case-insensitive.
const secretRef = new RegExp(
  `secrets\\s*(?:\\.\\s*(?:${names})\\b|\\[\\s*['"](?:${names})['"]\\s*\\])`,
  'i',
);
const ALLOWED_EVENTS = [
  'push',
  'schedule',
  'repository_dispatch',
  'workflow_dispatch',
  'workflow_call',
];

// Lines of one event's block inside the `on:` text (deeper-indented than the event key).
function eventBlock(triggers, event) {
  const ls = triggers.split('\n');
  const i = ls.findIndex((l) => new RegExp(`^ {2}${event}:`).test(l));
  if (i < 0) return null;
  const out = [ls[i]];
  for (let j = i + 1; j < ls.length && (/^ {3,}/.test(ls[j]) || ls[j].trim() === ''); j++) {
    out.push(ls[j]);
  }
  return out.join('\n');
}

function jobIf(body) {
  const ls = body.split('\n');
  const i = ls.findIndex((l) => /^ {4}if:/.test(l));
  if (i < 0) return null;
  let cond = ls[i].replace(/^ {4}if:\s*[>|][-+]?\s*/, '').replace(/^ {4}if:\s*/, '');
  for (let j = i + 1; j < ls.length && /^ {5,}/.test(ls[j]); j++) cond += ` ${ls[j].trim()}`;
  return cond;
}

// A job-level condition that starts with the main-ref equality and only narrows it
// further with `&&` conjuncts: no negation of the guard, no `||`.
function isMainGuard(cond) {
  const c = cond
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(/^\(\s*/, '');
  if (c.includes('||')) return false;
  return /^github\.ref\s*==\s*'refs\/heads\/main'\s*(\)\s*)?(&&|$)/.test(c);
}

// Branch names of a push trigger block: inline list or block list, all of them.
function pushBranches(push) {
  const inline = /branches:\s*\[([^\]]*)\]/.exec(push);
  if (inline) {
    return inline[1]
      .split(',')
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const m = /^( *)branches:\s*$/m.exec(push);
  if (!m) return null;
  const items = [];
  for (const l of push.slice(m.index + m[0].length).split('\n').slice(1)) {
    if (l.trim() === '') continue; // comments are blanked before parsing
    const it = /^\s*-\s*(.*?)\s*$/.exec(l);
    if (!it) break;
    items.push(it[1].replace(/^['"]|['"]$/g, ''));
  }
  return items;
}

// Lines outside block-scalar bodies (`run: |` scripts, `if: >-` expressions are content).
function structural(lines) {
  const out = [];
  let blockIndent = -1;
  lines.forEach((l, i) => {
    const indent = l.length - l.trimStart().length;
    if (blockIndent >= 0) {
      if (l.trim() === '' || indent > blockIndent) return;
      blockIndent = -1;
    }
    const code = l.replace(/(^|\s)#.*$/, '');
    if (/:\s*[|>][-+0-9]*\s*$/.test(code) || /^\s*-\s*[|>][-+0-9]*\s*$/.test(code)) {
      blockIndent = indent;
    }
    out.push({ l, i });
  });
  return out;
}

export function checkWorkflow(name, text) {
  const errors = [];
  const lines = text
    .split('\n')
    .map((l) => (/^\s*#/.test(l) ? '' : l));

  // Triggers: the `on:` block (or an inline `on: [a, b]` / `on: a`).
  const onIdx = lines.findIndex((l) => /^["']?on["']?:/.test(l));
  let triggers = '';
  if (onIdx >= 0) {
    triggers = lines[onIdx];
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      triggers += `\n${lines[i]}`;
    }
  }
  if (onIdx >= 0 && /^["']?on["']?:\s*[^\s#]/.test(lines[onIdx])) {
    errors.push(`${name}: use a block-style "on:" so triggers can be verified`);
  }
  const has = (event) => new RegExp(`(^|[\\s\\[,:])${event}\\b`, 'm').test(triggers);
  const prTriggered = PR_EVENTS.filter(has);
  const dispatchable = has('workflow_dispatch');
  const callable = has('workflow_call');

  // Jobs: keys at two-space indent under `jobs:`.
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = [];
  if (jobsIdx >= 0) {
    for (let i = jobsIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = /^ {2}([\w-]+):\s*$/.exec(lines[i]);
      if (m) jobs.push({ id: m[1], body: [] });
      else if (jobs.length) jobs[jobs.length - 1].body.push(lines[i]);
    }
  }

  // Whole-text checks: expressions and keys may span lines, so nothing here is per line.
  const body = lines.join('\n');
  const anyRef = new RegExp(secretRef.source, 'gi');
  if (prTriggered.length) {
    if (anyRef.test(body)) {
      errors.push(`${name}: triggered by ${prTriggered.join('/')} but references a publish secret`);
    }
    // Only literal lookups (secrets.NAME, secrets['NAME']) may remain in a pull-request
    // workflow: pass-through (`secrets: inherit`, any spelling), wildcards, computed and
    // whole-context access cannot be attributed to a name.
    const code = [
      ...[...body.matchAll(/\$\{\{[\s\S]*?\}\}/g)].map((m) => m[0]),
      ...structural(lines).flatMap(({ l }) => l.match(/\bsecrets\s*:.*$/i) ?? []),
    ].join('\n');
    const residual = code
      .replace(/secrets\s*\.\s*[A-Za-z_][\w-]*/gi, '')
      .replace(/secrets\s*\[\s*['"][\w-]+['"]\s*\]/gi, '');
    if (/\bsecrets\b/i.test(residual)) {
      errors.push(`${name}: pull-request workflow uses the secrets context beyond literal lookups`);
    }
  }

  // Global, before any classification: quoted keys (of any content), anchors and aliases
  // could hide triggers, jobs or pass-through from this scan, and computed or
  // whole-context access to the secrets context cannot be attributed to a name.
  // Structural lines only (block-scalar bodies such as `run: |` scripts are skipped). A
  // structural line may not start with a quote, anchor, alias, tag or complex-key marker:
  // those spell mapping keys this scan cannot decode (`"pu\\\nsh":`, `&e push:`, `? secrets`).
  for (const { l, i } of structural(lines)) {
    // A quoted list item (`- 'path'`) is a plain scalar unless its closing quote is
    // missing (a multi-line key) or is followed by a colon (a key).
    const listQuote = /^\s*-\s+(['"])/.exec(l);
    const listScalar = listQuote && new RegExp(`^\\s*-\\s+${listQuote[1]}[^${listQuote[1]}]*${listQuote[1]}\\s*(,|$)`).test(l);
    const startsOdd = listQuote
      ? !listScalar
      : /^\s*(?:-\s+)?['"&*!?%]/.test(l);
    if (startsOdd || /<<:|:\s*[&*!][\w-]+/.test(l) || /^\s*-\s+[&*!?%]/.test(l)) {
      errors.push(
        `${name}:${i + 1}: quoted or anchored keys, aliases, tags and complex keys are not supported in workflows`,
      );
    }
  }
  if (
    /\bsecrets\s*(?:\.\s*\*|\[\s*(?!['"][\w-]+['"]\s*\]))|\(\s*secrets\s*[,)]/i.test(body)
  ) {
    errors.push(`${name}: computed or whole-context access to secrets is not supported`);
  }

  const secretJobs = jobs.filter((j) => secretRef.test(j.body.join('\n')));
  if (secretJobs.length && !prTriggered.length) {
    const events = [...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
    for (const e of events) {
      if (!ALLOWED_EVENTS.includes(e)) {
        errors.push(`${name}: publish-secret workflow has unsupported trigger "${e}"`);
      }
    }
    if (events.length === 0) errors.push(`${name}: could not read the "on:" triggers`);
    const push = eventBlock(triggers, 'push');
    if (has('push') && !push) errors.push(`${name}: could not read the push trigger`);
    if (push) {
      const branches = pushBranches(push);
      if (!branches || branches.length !== 1 || branches[0] !== 'main') {
        errors.push(`${name}: push trigger must be restricted to exactly "branches: [main]"`);
      }
      if (/(branches-ignore|tags|tags-ignore):/.test(push)) {
        errors.push(`${name}: push trigger must not use branches-ignore or tags filters`);
      }
    }
  }

  // References must sit inside job bodies: a workflow-level `env:` would bypass the job checks.
  const count = (t) => (t.match(new RegExp(secretRef.source, 'gi')) ?? []).length;
  const inJobs = secretJobs.reduce((n, j) => n + count(j.body.join('\n')), 0);
  if (count(body) !== inJobs) {
    errors.push(`${name}: publish secrets may only be referenced inside a job, not at workflow level`);
  }

  for (const job of secretJobs) {
    const jobBody = job.body.join('\n');
    if (prTriggered.length) continue; // already reported above
    if (!/^ {4}environment:\s*release\s*$/m.test(jobBody)) {
      errors.push(`${name}: job "${job.id}" references a publish secret without "environment: release"`);
    }
    if (dispatchable || callable) {
      const cond = jobIf(jobBody);
      if (cond === null || !isMainGuard(cond)) {
        errors.push(
          `${name}: job "${job.id}" can be dispatched or called from any ref but has no plain job-level "if: github.ref == 'refs/heads/main'" guard (no ||)`,
        );
      }
    }
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? '.github/workflows';
  const errors = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8')));
  if (errors.length) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log('publish-secret workflow policy: ok');
}
