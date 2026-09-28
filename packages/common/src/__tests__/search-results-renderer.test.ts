import { describe, expect, it } from 'vitest';
import type { SearchResponse, SearchResult } from '@search-docs/types';
import {
  formatSectionNumber,
  getPreviewContent,
  renderSearchResultsText,
} from '../index.js';

function createResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'section-1',
    documentPath: 'docs/example.md',
    documentHash: 'hash-1',
    heading: '概要',
    depth: 1,
    content: '本文です。',
    score: 0.98,
    isDirty: false,
    tokenCount: 10,
    indexStatus: 'latest',
    isLatest: true,
    hasPendingUpdate: false,
    startLine: 10,
    endLine: 12,
    sectionNumber: [1],
    ...overrides,
  };
}

function createResponse(results: SearchResult[], total = results.length): SearchResponse {
  return {
    results,
    total,
    took: 12,
  };
}

describe('renderSearchResultsText', () => {
  it('0件の結果をMCP形式で表示する', () => {
    expect(renderSearchResultsText(createResponse([]))).toBe(
      '検索結果: 0件\n処理時間: 12ms\n\n該当する結果が見つかりませんでした。'
    );
  });

  it('複数件の結果に順位、ID、indexStatus、プレビューを表示する', () => {
    const response = createResponse([
      createResult({
        id: 'section-1',
        content: '一行目\n二行目',
        sectionNumber: [1],
        indexStatus: 'latest',
      }),
      createResult({
        id: 'section-2',
        heading: '詳細',
        documentPath: 'docs/detail.md',
        content: '三行目',
        sectionNumber: [1, 2, 1],
        startLine: 20,
        endLine: 20,
        indexStatus: 'outdated',
      }),
    ]);

    const output = renderSearchResultsText(response, { hints: false });

    expect(output).toContain('📄 「概要」(第1章)');
    expect(output).toContain('📄 「詳細」(第1章2節1項)');
    expect(output).toContain('10-12行目 | 1位/2件 | id: section-1 | indexStatus: latest');
    expect(output).toContain('20-20行目 | 2位/2件 | id: section-2 | indexStatus: outdated');
    expect(output).not.toContain('0.98');
    expect(output).toContain('   一行目\n   二行目');
  });

  it('depth=0の結果は章節項号を付けずに表示する', () => {
    const result = createResult({
      depth: 0,
      heading: '',
      sectionNumber: [],
    });

    const output = renderSearchResultsText(createResponse([result]), { hints: false });

    expect(output).toContain('📄 (no heading)\n');
    expect(output).not.toContain('第');
  });

  it('長い本文を指定行数で切り詰める', () => {
    const result = createResult({
      content: '一行目\n二行目\n三行目\n四行目',
    });

    const output = renderSearchResultsText(createResponse([result]), {
      previewLines: 2,
      hints: false,
    });

    expect(output).toContain('   一行目\n   二行目\n   ... (残り2行)');
    expect(output).not.toContain('   三行目');
  });

  it('indexStatusがない応答でもメタ行の項目を省略しない', () => {
    const result = createResult({ indexStatus: undefined });

    expect(renderSearchResultsText(createResponse([result]), { hints: false })).toContain(
      'indexStatus: unknown'
    );
  });

  it('プロジェクトラベルとMCPヒントを表示する', () => {
    const output = renderSearchResultsText(createResponse([createResult()]), {
      projectLabel: 'related-project',
      hints: 'mcp',
    });

    expect(output).toContain('[プロジェクト: related-project]');
    expect(output).toContain('get_document(sectionId: "...", project: "related-project")');
    expect(output).toContain('search(..., { project: "related-project", limit: 20 })');
  });

  it('CLIヒントはCLIの呼び出し例を表示する', () => {
    const output = renderSearchResultsText(createResponse([createResult()]), { hints: 'cli' });

    expect(output).toContain('search-docs search "..." --limit 20');
    expect(output).toContain('search-docs search "..." --format json');
    expect(output).not.toContain('get_document(');
  });
});

describe('shared search result helpers', () => {
  it('section numberを章節項号へ変換する', () => {
    expect(formatSectionNumber([])).toBe('');
    expect(formatSectionNumber([1, 2, 3, 1])).toBe('第1章2節3項1号');
  });

  it('previewを行数で切り詰める', () => {
    expect(getPreviewContent('一行目\n二行目\n三行目', 2)).toBe(
      '一行目\n二行目\n... (残り1行)'
    );
  });
});
