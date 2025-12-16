/**
 * getOutline API のテスト
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SearchDocsServer } from '../server/search-docs-server.js';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsConfig, Document } from '@search-docs/types';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('getOutline API', () => {
  let server: SearchDocsServer;
  let storage: FileStorage;
  let dbEngine: DBEngine;
  const testDir = path.join(__dirname, 'test-get-outline');
  const dbPath = path.join(testDir, 'db');
  const storagePath = path.join(testDir, 'storage');

  const config: SearchDocsConfig = {
    version: '1.0',
    project: {
      name: 'test-project',
      root: testDir,
    },
    files: {
      include: ['**/*.md'],
      exclude: [],
      ignoreGitignore: false,
    },
    indexing: {
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 3,
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    },
    search: {
      defaultLimit: 10,
      maxLimit: 100,
      includeCleanOnly: false,
    },
    server: {
      host: 'localhost',
      port: 24280,
      protocol: 'json-rpc',
    },
    storage: {
      documentsPath: storagePath,
      indexPath: dbPath,
      cachePath: path.join(testDir, 'cache'),
    },
    worker: {
      enabled: false,
      interval: 5000,
      maxConcurrent: 3,
      delayBetweenDocuments: 0,
    },
    watcher: {
      enabled: false,
      debounceMs: 1000,
      awaitWriteFinishMs: 100,
    },
  };

  beforeAll(async () => {
    // テストディレクトリを作成
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(dbPath, { recursive: true });
    await fs.mkdir(storagePath, { recursive: true });

    // DBEngineとStorageを初期化
    dbEngine = new DBEngine({ dbPath });
    await dbEngine.connect();

    storage = new FileStorage({ basePath: storagePath });

    // Serverを初期化
    server = new SearchDocsServer(config, storage, dbEngine);
    await server.start();
  }, 20000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (dbEngine) {
      dbEngine.disconnect();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('pathもsectionIdも指定しない場合はエラー', async () => {
    await expect(server.getOutline({})).rejects.toThrow(
      'pathまたはsectionIdのどちらか一方を指定してください'
    );
  });

  it('path指定で文書全体のアウトラインを取得', async () => {
    const docPath = 'test-doc.md';
    const doc: Document = {
      path: docPath,
      content: '# Title\n\n## Section 1\n\n## Section 2',
      metadata: {
        fileHash: createHash('sha256').update('test-content').digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    await storage.save(doc.path, doc);

    // セクションを追加
    // 注: H1が文書の最初の見出しなので、H1のsectionNumber=[1]、そのH2子のsectionNumber=[1,1], [1,2]
    await dbEngine.addSections([
      {
        id: 'section-0',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '(document root)',
        depth: 0,
        content: '# Title\n\n## Section 1\n\n## Section 2',
        tokenCount: 100,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 10,
        sectionNumber: [1],
      },
      {
        id: 'section-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '# Title',
        depth: 1,
        content: '# Title',
        tokenCount: 50,
        parentId: 'section-0',
        order: 1,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 11,
        endLine: 20,
        sectionNumber: [1],
      },
      {
        id: 'section-1-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## Section 1',
        depth: 2,
        content: '## Section 1',
        tokenCount: 50,
        parentId: 'section-1',
        order: 2,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 11,
        endLine: 20,
        sectionNumber: [1, 1],
      },
      {
        id: 'section-1-2',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## Section 2',
        depth: 2,
        content: '## Section 2',
        tokenCount: 30,
        parentId: 'section-1',
        order: 3,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 21,
        endLine: 25,
        sectionNumber: [1, 2],
      },
    ]);

    const result = await server.getOutline({ path: docPath });

    // depth=0（document root）は除外される
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({
      number: '1',
      heading: '# Title',
      lines: 10,
      tokens: 50,
      id: 'section-1',
    });
    expect(result.items[1]).toEqual({
      number: '1.1',
      heading: '## Section 1',
      lines: 10,
      tokens: 50,
      id: 'section-1-1',
    });
    expect(result.items[2]).toEqual({
      number: '1.2',
      heading: '## Section 2',
      lines: 5,
      tokens: 30,
      id: 'section-1-2',
    });
  });

  it('section_numberの辞書順でソート（複雑な階層）', async () => {
    const docPath = 'test-complex-order.md';
    const doc: Document = {
      path: docPath,
      content: '# Root\n## A\n#### A.1.1\n## A.1',
      metadata: {
        fileHash: createHash('sha256').update('test-complex').digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    await storage.save(doc.path, doc);

    // orderとsection_numberが一致しないケース
    await dbEngine.addSections([
      {
        id: 'root',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '(document root)',
        depth: 0,
        content: '',
        tokenCount: 10,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 1,
        sectionNumber: [1],
      },
      {
        id: 'section-a',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## A',
        depth: 2,
        content: '## A',
        tokenCount: 50,
        parentId: 'root',
        order: 1,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 2,
        endLine: 5,
        sectionNumber: [1],
      },
      {
        id: 'section-a-1-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '#### A.1.1',
        depth: 3, // H4以降は親のcontentに含まれるが、テスト用に独立セクションとして登録
        content: '#### A.1.1',
        tokenCount: 30,
        parentId: 'section-a',
        order: 2, // order上は2番目
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 6,
        endLine: 10,
        sectionNumber: [1, 1], // section_number上は [1, 1]
      },
      {
        id: 'section-a-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## A.1',
        depth: 2,
        content: '## A.1',
        tokenCount: 40,
        parentId: 'root',
        order: 3, // order上は3番目だが、section_numberでは [1, 1] より前
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 11,
        endLine: 15,
        sectionNumber: [2], // section_number上は [2]
      },
    ]);

    const result = await server.getOutline({ path: docPath });

    // section_numberの辞書順でソート: [1] < [1,1] < [2]
    expect(result.items).toHaveLength(3);
    expect(result.items[0].number).toBe('1'); // section-a
    expect(result.items[1].number).toBe('1.1'); // section-a-1-1
    expect(result.items[2].number).toBe('2'); // section-a-1
  });

  it('sectionId指定で特定セクション配下のアウトラインを取得', async () => {
    const docPath = 'test-doc-with-subsections.md';
    const doc: Document = {
      path: docPath,
      content: '# Title\n\n## Chapter 1\n\n### Section 1.1\n\n### Section 1.2\n\n## Chapter 2',
      metadata: {
        fileHash: createHash('sha256').update('test-content-2').digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    await storage.save(doc.path, doc);

    // セクションを追加
    await dbEngine.addSections([
      {
        id: 'root',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '(document root)',
        depth: 0,
        content: '# Title',
        tokenCount: 100,
        parentId: null,
        order: 0,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 5,
        sectionNumber: [1],
      },
      {
        id: 'title',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '# Title',
        depth: 1,
        content: '# Title',
        tokenCount: 100,
        parentId: 'root',
        order: 1,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 1,
        endLine: 5,
        sectionNumber: [1],
      },
      {
        id: 'chapter-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## Chapter 1',
        depth: 2,
        content: '## Chapter 1',
        tokenCount: 200,
        parentId: 'title',
        order: 2,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 6,
        endLine: 20,
        sectionNumber: [1, 1],
      },
      {
        id: 'section-1-1',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '### Section 1.1',
        depth: 3,
        content: '### Section 1.1',
        tokenCount: 50,
        parentId: 'chapter-1',
        order: 3,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 21,
        endLine: 30,
        sectionNumber: [1, 1, 1],
      },
      {
        id: 'section-1-2',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '### Section 1.2',
        depth: 3,
        content: '### Section 1.2',
        tokenCount: 60,
        parentId: 'chapter-1',
        order: 4,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 31,
        endLine: 40,
        sectionNumber: [1, 1, 2],
      },
      {
        id: 'chapter-2',
        documentPath: docPath,
        documentHash: doc.metadata.fileHash,
        heading: '## Chapter 2',
        depth: 2,
        content: '## Chapter 2',
        tokenCount: 100,
        parentId: 'title',
        order: 5,
        isDirty: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        startLine: 41,
        endLine: 50,
        sectionNumber: [1, 2],
      },
    ]);

    // chapter-1配下のみを取得
    const result = await server.getOutline({ sectionId: 'chapter-1' });

    // chapter-1の子（section-1-1, section-1-2）のみが返される
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      number: '1.1.1',
      heading: '### Section 1.1',
      lines: 10,
      tokens: 50,
      id: 'section-1-1',
    });
    expect(result.items[1]).toEqual({
      number: '1.1.2',
      heading: '### Section 1.2',
      lines: 10,
      tokens: 60,
      id: 'section-1-2',
    });
  });
});

describe('maxDepth検証: Issue #30', () => {
  let server: SearchDocsServer;
  let storage: FileStorage;
  let dbEngine: DBEngine;
  const testDir = path.join(__dirname, 'test-maxdepth-issue30');
  const dbPath = path.join(testDir, 'db');
  const storagePath = path.join(testDir, 'storage');

  // maxDepth=6の設定
  const config: SearchDocsConfig = {
    version: '1.0',
    project: {
      name: 'test-maxdepth',
      root: testDir,
    },
    files: {
      include: ['**/*.md'],
      exclude: [],
      ignoreGitignore: false,
    },
    indexing: {
      maxTokensPerSection: 2000,
      minTokensForSplit: 100,
      maxDepth: 6, // Issue #30の設定値
      vectorDimension: 256,
      embeddingModel: 'cl-nagoya/ruri-v3-30m',
    },
    search: {
      defaultLimit: 10,
      maxLimit: 100,
      includeCleanOnly: false,
    },
    server: {
      host: 'localhost',
      port: 64916, // Issue #30指定のポート
      protocol: 'json-rpc',
    },
    storage: {
      documentsPath: storagePath,
      indexPath: dbPath,
      cachePath: path.join(testDir, 'cache'),
    },
    worker: {
      enabled: false,
      interval: 5000,
      maxConcurrent: 3,
      delayBetweenDocuments: 0,
    },
    watcher: {
      enabled: false,
      debounceMs: 1000,
      awaitWriteFinishMs: 100,
    },
  };

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(dbPath, { recursive: true });
    await fs.mkdir(storagePath, { recursive: true });

    dbEngine = new DBEngine({ dbPath });
    await dbEngine.connect();

    storage = new FileStorage({ basePath: storagePath });
    server = new SearchDocsServer(config, storage, dbEngine);
    await server.start();
  }, 20000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    if (dbEngine) {
      dbEngine.disconnect();
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('maxDepth=6の設定でH4, H5のセクションが作成され、getOutlineで取得できる', async () => {
    // MarkdownSplitterをインポート
    const { MarkdownSplitter } = await import('../splitter/markdown-splitter.js');

    const docPath = 'deep-document.md';
    const content = `# Level 1

Content at level 1.

## Level 2

Content at level 2.

### Level 3

Content at level 3.

#### Level 4

Content at level 4.

##### Level 5

Content at level 5.
`;

    const doc: Document = {
      path: docPath,
      content,
      metadata: {
        fileHash: createHash('sha256').update(content).digest('hex'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    await storage.save(doc.path, doc);

    // MarkdownSplitterでセクションを生成
    const splitter = new MarkdownSplitter(config.indexing);
    const sections = splitter.split(content, docPath, doc.metadata.fileHash);

    console.log('Generated sections:');
    sections.forEach(section => {
      console.log(`  depth=${section.depth}, heading="${section.heading}"`);
    });

    // セクションをDBに追加
    await dbEngine.addSections(sections);

    // depth分布を確認
    const depthCounts: Record<number, number> = {};
    sections.forEach(s => {
      depthCounts[s.depth] = (depthCounts[s.depth] || 0) + 1;
    });
    console.log('Depth distribution:', depthCounts);

    // depth 4, 5のセクションが存在することを確認
    const depth4Sections = sections.filter(s => s.depth === 4);
    const depth5Sections = sections.filter(s => s.depth === 5);

    expect(depth4Sections.length).toBeGreaterThan(0);
    expect(depth5Sections.length).toBeGreaterThan(0);

    // getOutlineで全セクションを取得
    const outline = await server.getOutline({ path: docPath });

    console.log('Outline items:');
    outline.items.forEach(item => {
      console.log(`  ${item.number}: ${item.heading}`);
    });

    // depth 4, 5のセクションがgetOutlineに含まれることを確認
    // sectionNumberの長さ（ドット区切りの要素数）でdepthを判断
    // depth N のセクション番号は N 個の数字を含む（例: depth 4 = "1.1.1.1" = 4個）
    const outlineDepth4 = outline.items.filter(item => item.number.split('.').length === 4); // depth 4
    const outlineDepth5 = outline.items.filter(item => item.number.split('.').length === 5); // depth 5

    expect(outlineDepth4.length).toBeGreaterThan(0);
    expect(outlineDepth5.length).toBeGreaterThan(0);

    // 念のため、見出しテキストでも確認
    const level4 = outline.items.find(item => item.heading === 'Level 4');
    const level5 = outline.items.find(item => item.heading === 'Level 5');

    expect(level4).toBeDefined();
    expect(level5).toBeDefined();
  });
});
