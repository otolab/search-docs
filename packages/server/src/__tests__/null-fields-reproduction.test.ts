import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { DBEngine } from '@search-docs/db-engine';
import * as path from 'path';
import * as fs from 'fs/promises';
import { MarkdownSplitter } from '../splitter/markdown-splitter.js';
import type { Section } from '@search-docs/types';

/**
 * ユーザー報告の問題を再現するテスト
 *
 * 報告内容：
 * - documentPath: "tools/pandoc-ruby/PANDOC_REFERENCE.md"
 * - heading: "**1.3 表の活用**"
 * - depth: 2
 * - startLine: null
 * - endLine: null
 * - sectionNumber: null
 * - indexStatus: "latest" (最新のインデックス)
 */

describe('null fields reproduction test', () => {
  const testDbPath = path.join(__dirname, 'test-null-fields');
  let dbEngine: DBEngine;

  beforeAll(async () => {
    // テスト用DBディレクトリをクリーンアップ
    await fs.rm(testDbPath, { recursive: true, force: true });

    // DBエンジンを接続
    dbEngine = new DBEngine({
      dbPath: testDbPath,
      embeddingModel: 'cl-nagoya/ruri-v3-30m'
    });
    await dbEngine.connect();
  });

  afterAll(async () => {
    await dbEngine.disconnect();
    await fs.rm(testDbPath, { recursive: true, force: true });
  });

  test('実際のMarkdown内容でstartLine/endLine/sectionNumberがnullにならないことを確認', async () => {
    // 実際のファイルを読み込む
    const actualFilePath = path.join(__dirname, '../../../../../study-contents/tools/pandoc-ruby/PANDOC_REFERENCE.md');
    const markdownContent = await fs.readFile(actualFilePath, 'utf-8');

    const documentPath = 'tools/pandoc-ruby/PANDOC_REFERENCE.md';
    const documentHash = 'test-hash-123';

    // MarkdownSplitterでセクションを分割
    const splitter = new MarkdownSplitter({
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m'
    });

    const sections = splitter.split(markdownContent, documentPath, documentHash);

    // "**1.3 表の活用**"セクションを探す
    const targetSection = sections.find((s: Omit<Section, 'vector'>) => s.heading === '**1.3 表の活用**');

    expect(targetSection).toBeDefined();
    expect(targetSection?.depth).toBe(2);

    console.log('Target section:', JSON.stringify(targetSection, null, 2));

    // 重要：startLine, endLine, sectionNumberがnullでないことを確認
    expect(targetSection?.startLine, 'startLine should not be null').not.toBeNull();
    expect(targetSection?.endLine, 'endLine should not be null').not.toBeNull();
    expect(targetSection?.sectionNumber, 'sectionNumber should not be null').not.toBeNull();

    // 値が正しいことを確認
    expect(targetSection?.startLine).toBeGreaterThan(0);
    expect(targetSection?.endLine).toBeGreaterThan(0);
    expect(targetSection?.endLine).toBeGreaterThanOrEqual(targetSection!.startLine);
    expect(targetSection?.sectionNumber).toBeInstanceOf(Array);
    expect(targetSection?.sectionNumber?.length).toBeGreaterThan(0);

    // DBに追加
    if (targetSection) {
      const sectionsToAdd = [{
        id: targetSection.id,
        documentPath: targetSection.documentPath,      // camelCase
        heading: targetSection.heading,
        depth: targetSection.depth,
        content: targetSection.content,
        tokenCount: targetSection.tokenCount,          // camelCase
        parentId: targetSection.parentId,              // camelCase
        order: targetSection.order,
        isDirty: false,                                // camelCase
        documentHash: documentHash,                    // camelCase
        createdAt: new Date(),                         // camelCase
        updatedAt: new Date(),                         // camelCase
        startLine: targetSection.startLine,            // camelCase
        endLine: targetSection.endLine,                // camelCase
        sectionNumber: targetSection.sectionNumber     // camelCase
      }];

      const result = await dbEngine.addSections(sectionsToAdd);
      expect(result.count).toBe(1);

      // DBから取得して確認
      const searchResults = await dbEngine.search({
        query: '表の活用',
        limit: 5
      });

      console.log('Search results:', JSON.stringify(searchResults.results, null, 2));

      const dbSection = searchResults.results.find(r => r.heading === '**1.3 表の活用**');
      expect(dbSection).toBeDefined();

      // DB取得後もnullでないことを確認
      expect(dbSection?.startLine, 'DB: startLine should not be null').not.toBeNull();
      expect(dbSection?.endLine, 'DB: endLine should not be null').not.toBeNull();
      expect(dbSection?.sectionNumber, 'DB: sectionNumber should not be null').not.toBeNull();

      console.log('DB section fields:', {
        startLine: dbSection?.startLine,
        endLine: dbSection?.endLine,
        sectionNumber: dbSection?.sectionNumber
      });
    }
  });
});
