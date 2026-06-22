import { execFileSync, spawnSync } from 'node:child_process';

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

function splitLines(output: string): string[] {
  return output.trim().split(/\r?\n/).filter(Boolean);
}

function printUntrackedDiffs(files: string[]): void {
  for (const file of files) {
    console.error(`\nDiff for new generated file: ${file}`);

    const result = spawnSync(
      'git',
      ['diff', '--no-index', '--', '/dev/null', file],
      {
        stdio: 'inherit',
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0 && result.status !== 1) {
      process.exit(result.status ?? 1);
    }
  }
}

run('pnpm', ['docs:api']);

const status = read('git', ['status', '--porcelain', '--', 'docs/api']).trim();
if (status) {
  const untrackedFiles = splitLines(
    read('git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'docs/api',
    ]),
  );

  console.error(
    'Generated API docs are not up to date. Run `pnpm docs:api` and commit the result.',
  );
  console.error(status);
  execFileSync('git', ['diff', '--', 'docs/api'], {
    stdio: 'inherit',
  });
  printUntrackedDiffs(untrackedFiles);
  process.exit(1);
}
