/**
 * DBEngine統合テスト
 * 実際のDBEngineを使ってパス解決が正しく動作するか確認
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBEngine } from '@search-docs/db-engine';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DBEngine統合テスト', () => {
  let dbEngine: DBEngine;
  const testDbPath = path.join(__dirname, 'test-db-integration');

  beforeAll(async () => {
    // テスト用DBディレクトリを作成
    await fs.mkdir(testDbPath, { recursive: true });

    dbEngine = new DBEngine({ dbPath: testDbPath });
    await dbEngine.connect();
  });

  afterAll(async () => {
    if (dbEngine) {
      dbEngine.disconnect();
    }
    await fs.rm(testDbPath, { recursive: true, force: true });
  });

  it('DBEngineが正しく接続できる', () => {
    expect(dbEngine).toBeDefined();
  });

  it('セクションを追加して検索できる', async () => {
    const section = {
      id: 'test-section-1',
      documentPath: 'test.md',
      heading: 'Test Heading',
      depth: 1,
      content: 'This is a test content for integration testing.',
      tokenCount: 10,
      parentId: null,
      order: 0,
      isDirty: false,
      documentHash: 'test-hash',
      createdAt: new Date(),
      updatedAt: new Date(),
      startLine: 1,
      endLine: 1,
      sectionNumber: [1],
    };

    await dbEngine.addSections([section]);

    const results = await dbEngine.search({
      query: 'test content',
      limit: 10,
    });

    expect(results.results.length).toBeGreaterThan(0);
    expect(results.results[0].documentPath).toBe('test.md');
  });
});
