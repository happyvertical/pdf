#!/usr/bin/env node
// Workflow policy for the publish credentials (happyvertical/iac#2165).
//
// - Every job that references a publish secret (NPM_HAPPYVERTICAL_PUBLISH_TOKEN,
//   NPM_TOKEN) declares `environment: release`, the Environment whose
//   deployment-branch rule allows only `main`. Its workflow may only be
//   triggered by push restricted to `branches: [main]`, schedule,
//   repository_dispatch, workflow_call or workflow_dispatch; a dispatchable
//   workflow also needs a job-level `if:` that is a plain main-ref guard (no
//   `||`).
// - No workflow triggered by pull_request, pull_request_target or merge_group
//   references a publish secret (a pull request runs its own copy of the
//   workflow files, so it could read the secret), and none passes
//   `secrets: inherit`.
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
const mainGuard = /github\.ref\s*==\s*'refs\/heads\/main'/;
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
      if (secretRef.test(l) || /^\s*secrets:\s*inherit\b/.test(l)) {
        errors.push(
          `${name}:${i + 1}: triggered by ${prTriggered.join('/')} but references a publish secret`,
        );
      }
    });
  }

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
    if (
      push &&
      !(
        /branches:\s*\[\s*['"]?main['"]?\s*\]/.test(push) ||
        /branches:\s*\n\s*-\s*['"]?main['"]?\s*(\n|$)/.test(push)
      )
    ) {
      errors.push(`${name}: push trigger must be restricted to "branches: [main]"`);
    }
    if (push && /(branches-ignore|tags|tags-ignore):/.test(push)) {
      errors.push(`${name}: push trigger must not use branches-ignore or tags filters`);
    }
  }

  for (const job of secretJobs) {
    const body = job.body.join('\n');
    if (prTriggered.length) continue; // already reported above
    if (!/^ {4}environment:\s*release\s*$/m.test(body)) {
      errors.push(`${name}: job "${job.id}" references a publish secret without "environment: release"`);
    }
    if (dispatchable) {
      const cond = jobIf(body);
      if (cond === null || !mainGuard.test(cond) || cond.includes('||')) {
        errors.push(
          `${name}: job "${job.id}" is workflow_dispatch-able but has no plain job-level "if: github.ref == 'refs/heads/main'" guard (no ||)`,
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
