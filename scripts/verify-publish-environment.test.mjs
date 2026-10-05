import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWorkflow } from './verify-publish-environment.mjs';

const wf = ({ on, job }) => `name: t\non:\n${on}\njobs:\n  publish:\n${job}\n`;
const PUSH_MAIN = '  push:\n    branches: [main]';
const OK_JOB = [
  '    environment: release',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo "$T"',
  '        env:',
  '          T: ${{ secrets.NPM_TOKEN }}',
].join('\n');
const check = (o) => checkWorkflow('t.yml', wf(o));

test('a protected job on push to main passes', () => {
  assert.deepEqual(check({ on: PUSH_MAIN, job: OK_JOB }), []);
});

test('a dispatchable job needs a plain main guard', () => {
  const on = `${PUSH_MAIN}\n  workflow_dispatch:`;
  assert.equal(check({ on, job: OK_JOB }).length, 1);
  const guarded = (cond) => `    if: ${cond}\n${OK_JOB}`;
  assert.deepEqual(check({ on, job: guarded("github.ref == 'refs/heads/main'") }), []);
  assert.equal(check({ on, job: guarded("github.ref == 'refs/heads/main' || true") }).length, 1);
});

test('a missing environment is reported, in either secret syntax', () => {
  const noEnv = OK_JOB.replace('    environment: release\n', '');
  assert.equal(check({ on: PUSH_MAIN, job: noEnv }).length, 1);
  const bracket = noEnv.replace('secrets.NPM_TOKEN', "secrets['npm_token']");
  assert.equal(check({ on: PUSH_MAIN, job: bracket }).length, 1);
  const dq = noEnv.replace('secrets.NPM_TOKEN', 'secrets["NPM_HAPPYVERTICAL_PUBLISH_TOKEN"]');
  assert.equal(check({ on: PUSH_MAIN, job: dq }).length, 1);
});

test('push must be restricted to main', () => {
  assert.equal(check({ on: '  push:', job: OK_JOB }).length, 1);
  assert.equal(check({ on: '  push:\n    branches: [main, dev]', job: OK_JOB }).length, 1);
  assert.deepEqual(check({ on: '  push:\n    branches:\n      - main', job: OK_JOB }), []);
});

test('unsupported triggers are rejected for publish workflows', () => {
  assert.equal(check({ on: `${PUSH_MAIN}\n  release:\n    types: [created]`, job: OK_JOB }).length, 1);
});

test('pull-request workflows reference no publish secret', () => {
  for (const event of ['pull_request', 'pull_request_target', 'merge_group']) {
    for (const ref of ['secrets.NPM_TOKEN', "secrets['NPM_TOKEN']"]) {
      const job = OK_JOB.replace('secrets.NPM_TOKEN', ref);
      assert.equal(check({ on: `  ${event}:`, job }).length, 1, `${event} ${ref}`);
    }
  }
  assert.equal(check({ on: '  pull_request:', job: '    uses: ./x.yml\n    secrets: inherit' }).length, 1);
  assert.deepEqual(check({ on: '  pull_request:', job: '    steps:\n      - run: echo hi' }), []);
});
