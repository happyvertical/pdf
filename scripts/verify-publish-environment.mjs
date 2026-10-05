#!/usr/bin/env node
// Workflow policy for the publish credentials (happyvertical/iac#2165).
//
// - Every job that references a publish secret (NPM_HAPPYVERTICAL_PUBLISH_TOKEN,
//   NPM_TOKEN) declares `environment: release`, the Environment whose
//   deployment-branch rule allows only `main`, and refuses to run off the
//   default branch (`if:` on github.ref) when the workflow is dispatchable.
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
const secretRef = new RegExp(`secrets\\.(${SECRETS.join('|')})\\b`);
const mainGuard = /github\.ref\s*==\s*'refs\/heads\/main'/;

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

  for (const job of jobs) {
    const body = job.body.join('\n');
    if (!secretRef.test(body)) continue;
    if (prTriggered.length) continue; // already reported above
    if (!/^ {4}environment:\s*release\s*$/m.test(body)) {
      errors.push(`${name}: job "${job.id}" references a publish secret without "environment: release"`);
    }
    if (dispatchable) {
      const cond = /^ {4}if:\s*(.*)$/m.exec(body);
      if (!cond || !mainGuard.test(cond[1])) {
        errors.push(
          `${name}: job "${job.id}" is workflow_dispatch-able but has no job-level "if: github.ref == 'refs/heads/main'"`,
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
