import { describe, expect, it } from 'vitest';
import { appendToDiagnosticTail } from './child-extraction';

describe('child extraction diagnostics', () => {
  it('keeps only the diagnostic tail when child stderr is noisy', () => {
    let stderr = appendToDiagnosticTail('', '0123456789', 12);
    stderr = appendToDiagnosticTail(stderr, 'abcdef', 12);

    expect(stderr).toBe('456789abcdef');
  });
});
