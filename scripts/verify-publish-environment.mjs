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

  if (prTriggered.length) {
    lines.forEach((l, i) => {
      if (secretRef.test(l) || /^\s*secrets:/.test(l)) {
        errors.push(
          `${name}:${i + 1}: triggered by ${prTriggered.join('/')} but references a publish secret`,
        );
      }
    });
  }

  // Global, before any classification: quoted keys, anchors and aliases could hide
  // triggers, jobs or pass-through from the line scan, and computed access to the
  // secrets context cannot be attributed to a name.
  lines.forEach((l, i) => {
    if (/^\s*(-\s+)?['"][\w-]+['"]\s*:/.test(l) || /<<:|:\s*[&*][\w-]+/.test(l)) {
      errors.push(`${name}:${i + 1}: quoted keys, anchors and aliases are not supported in workflows`);
    }
    if (/\bsecrets\s*\[\s*(?!['"][\w-]+['"]\s*\])|\(\s*secrets\s*[,)]/i.test(l)) {
      errors.push(`${name}:${i + 1}: computed or whole-context access to secrets is not supported`);
    }
  });

  const secretJobs = jobs.filter((j) => secretRef.test(j.body.join('\n')));
  if (secretJobs.length && !prTriggered.length) {
    const events = [...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]);
    const inline = /^["']?on["']?:\s*\S/.test(lines[onIdx] ?? '');
    if (inline) errors.push(`${name}: use a block-style "on:" so triggers can be verified`);
    for (const e of events) {
      if (!ALLOWED_EVENTS.includes(e)) {
        errors.push(`${name}: publish-secret workflow has unsupported trigger "${e}"`);
      }
    }
    const push = eventBlock(triggers, 'push');
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
  const inJobs = secretJobs.reduce(
    (n, j) => n + j.body.filter((l) => secretRef.test(l)).length,
    0,
  );
  if (lines.filter((l) => secretRef.test(l)).length !== inJobs) {
    errors.push(`${name}: publish secrets may only be referenced inside a job, not at workflow level`);
  }

  for (const job of secretJobs) {
    const body = job.body.join('\n');
    if (prTriggered.length) continue; // already reported above
    if (!/^ {4}environment:\s*release\s*$/m.test(body)) {
      errors.push(`${name}: job "${job.id}" references a publish secret without "environment: release"`);
    }
    if (dispatchable || callable) {
      const cond = jobIf(body);
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
