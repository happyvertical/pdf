import { execFileSync } from 'node:child_process';

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: 'inherit',
  });
}

function read(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

run('pnpm', ['docs:api']);

const status = read('git', ['status', '--porcelain', '--', 'docs/api']).trim();
if (status) {
  console.error(
    'Generated API docs are not up to date. Run `pnpm docs:api` and commit the result.',
  );
  console.error(status);
  execFileSync('git', ['diff', '--', 'docs/api'], {
    stdio: 'inherit',
  });
  process.exit(1);
}
