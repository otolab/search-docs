import { describe, it, expect } from 'vitest';
import { checkConfigDeprecations } from '@search-docs/types';

describe('checkConfigDeprecations', () => {
  it('include のみ → 非推奨警告を返す', () => {
    const result = checkConfigDeprecations({
      files: { include: ['**/*.md'] },
    });

    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('files.include');
    expect(result[0].message).toContain('リネーム');
    expect(result[0].currentValue).toEqual(['**/*.md']);
  });

  it('sources あり → 警告なし', () => {
    const result = checkConfigDeprecations({
      files: { sources: ['**/*.md'] },
    });

    expect(result).toHaveLength(0);
  });

  it('include と sources 両方あり → 警告なし（sources が優先）', () => {
    const result = checkConfigDeprecations({
      files: { sources: ['**/*.md'], include: ['docs/**'] },
    });

    expect(result).toHaveLength(0);
  });

  it('files がない → 警告なし', () => {
    const result = checkConfigDeprecations({});

    expect(result).toHaveLength(0);
  });

  it('null/undefined → 警告なし', () => {
    expect(checkConfigDeprecations(null)).toHaveLength(0);
    expect(checkConfigDeprecations(undefined)).toHaveLength(0);
  });
});
