import type {
  SearchRequest,
  SearchResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  GetOutlineRequest,
  GetOutlineResponse,
  OutlineItem,
  GetStatusResponse,
  SearchDocsConfig,
} from '@search-docs/types';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';

/**
 * SearchDocsサーバのメインクラス（読み取り専用）
 *
 * 検索・文書取得・アウトライン取得・ステータス取得を担当。
 * ファイル監視・インデックス更新は WatcherProcess が担当。
 */
export class SearchDocsServer {
  private startTime: number = 0;
  private requestStats = {
    total: 0,
    search: 0,
    getDocument: 0,
  };
  constructor(
    private config: SearchDocsConfig,
    private storage: FileStorage,
    private dbEngine: DBEngine,
    private version: string = 'unknown'
  ) {}

  /**
   * サーバ起動
   */
  async start(): Promise<void> {
    this.startTime = Date.now();

    // DB接続をバックグラウンドで開始（サーバ起動をブロックしない）
    this.dbEngine.connect().catch((error) => {
      console.error('[SearchDocsServer] DB connection failed:', error);
    });
  }

  /**
   * サーバ停止
   */
  async stop(): Promise<void> {
    this.dbEngine.disconnect();
  }

  /**
   * DB接続状態を確認し、未接続の場合は親切なエラーメッセージを投げる
   */
  private checkDatabaseConnection(): void {
    const connectionState = this.dbEngine.getConnectionState();

    if (connectionState.state !== 'ready') {
      switch (connectionState.state) {
        case 'connecting':
          throw new Error(
            'データベース接続中です。Pythonワーカーとデータベース接続を開始しています。\n' +
            'しばらくお待ちください（通常5-10秒程度）。'
          );
        case 'initializing_model':
          throw new Error(
            'データベース接続中です。Ruri埋め込みモデルを初期化しています。\n' +
            'しばらくお待ちください（残り5秒程度）。'
          );
        case 'error':
          throw new Error(
            `データベース接続エラー: ${connectionState.error?.message || '不明なエラー'}\n` +
            'サーバーを再起動してください。'
          );
        case 'disconnected':
        default:
          throw new Error(
            'データベースに接続されていません。サーバーを再起動してください。'
          );
      }
    }
  }

  /**
   * 検索API
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    this.checkDatabaseConnection();

    this.requestStats.total++;
    this.requestStats.search++;
    const startTime = Date.now();

    // indexStatusによるフィルタ処理
    let autoExcludePaths: string[] | undefined;
    if (
      request.options?.indexStatus === 'latest_only' ||
      request.options?.indexStatus === 'completed_only'
    ) {
      // pending/processingのリクエストがあるdocument_pathを除外
      autoExcludePaths = await this.dbEngine.getPathsWithStatus(['pending', 'processing']);
    }

    // ユーザー指定のexcludePathsと自動除外パスをマージ
    const mergedExcludePaths = [
      ...(request.options?.excludePaths || []),
      ...(autoExcludePaths || []),
    ];

    const response = await this.dbEngine.search({
      query: request.query,
      ...request.options,
      excludePaths: mergedExcludePaths.length > 0 ? mergedExcludePaths : undefined,
    });

    // 各結果にindex状態情報を付与
    const resultsWithStatus = await Promise.all(
      response.results.map(async (section) => {
        const status = await this.computeIndexStatus(section.documentPath, section.documentHash);
        return {
          ...section,
          indexStatus: status.status,
          isLatest: status.isLatest,
          hasPendingUpdate: status.hasPendingUpdate,
        };
      })
    );

    return {
      results: resultsWithStatus,
      total: response.total,
      took: Date.now() - startTime,
    };
  }

  /**
   * 文書取得API
   */
  async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse> {
    this.checkDatabaseConnection();

    this.requestStats.total++;
    this.requestStats.getDocument++;

    // pathとsectionIdのどちらか一方は必須
    if (!request.path && !request.sectionId) {
      throw new Error('pathまたはsectionIdのどちらか一方を指定してください');
    }

    // sectionIdが指定されている場合はセクションを取得
    if (request.sectionId) {
      const result = await this.dbEngine.getSectionById(request.sectionId);
      return { document: null, section: result.section };
    }

    // 文書全体を取得
    const document = await this.storage.get(request.path!);

    if (!document) {
      throw new Error(`Document not found: ${request.path}`);
    }

    return { document };
  }

  /**
   * 文書アウトライン取得API
   */
  async getOutline(request: GetOutlineRequest): Promise<GetOutlineResponse> {
    this.checkDatabaseConnection();

    // pathとsectionIdのどちらか一方は必須
    if (!request.path && !request.sectionId) {
      throw new Error('pathまたはsectionIdのどちらか一方を指定してください');
    }

    // セクション一覧を取得
    let sections;
    if (request.sectionId) {
      // sectionIdが指定されている場合は、そのセクションを取得
      const result = await this.dbEngine.getSectionById(request.sectionId);
      // 指定されたセクション配下のセクションを取得するため、同じdocumentPathで取得
      const allSections = await this.dbEngine.getSectionsByPath(result.section.documentPath);

      // 指定されたsectionのsectionNumberで始まるセクションのみをフィルタ
      const targetSectionNumber = result.section.sectionNumber;
      sections = allSections.sections.filter(s => {
        // 同じセクション番号で始まり、かつ階層が深いもの（子孫）を含める
        if (s.sectionNumber.length <= targetSectionNumber.length) {
          return false;
        }
        return targetSectionNumber.every((num, idx) => s.sectionNumber[idx] === num);
      });
    } else {
      // pathが指定されている場合は、その文書全体のセクションを取得
      const result = await this.dbEngine.getSectionsByPath(request.path!);
      sections = result.sections;
    }

    // depth=0（document root）を除外
    sections = sections.filter(s => s.depth > 0);

    // section_numberの配列を辞書順で比較してソート
    sections.sort((a, b) => {
      const aNum = a.sectionNumber;
      const bNum = b.sectionNumber;

      // 配列を要素ごとに比較
      for (let i = 0; i < Math.min(aNum.length, bNum.length); i++) {
        if (aNum[i] !== bNum[i]) {
          return aNum[i] - bNum[i];
        }
      }

      // 前半が同じ場合、短い方が先（例: [1, 2] < [1, 2, 1]）
      return aNum.length - bNum.length;
    });

    // OutlineItemに変換
    const items: OutlineItem[] = sections.map(section => ({
      number: section.sectionNumber.join('.'),
      heading: section.heading,
      lines: section.endLine - section.startLine + 1,
      tokens: section.tokenCount,
      id: section.id,
    }));

    return { items };
  }

  /**
   * ステータス取得API
   */
  async getStatus(): Promise<GetStatusResponse> {
    // DB接続状態を取得
    const connectionState = this.dbEngine.getConnectionState();

    // DB接続が完了していない場合は、統計情報取得をスキップ
    let stats = { totalDocuments: 0, totalSections: 0, dirtyCount: 0 };
    let queueCount = 0;

    if (connectionState.state === 'ready') {
      // DBから統計情報を取得（.select()で最適化済み）
      stats = await this.dbEngine.getStats();

      // pendingリクエストの数を取得（count専用メソッドで高速化）
      queueCount = await this.dbEngine.countIndexRequests({ status: 'pending' });
    }

    return {
      server: {
        version: this.version,
        uptime: Date.now() - this.startTime,
        pid: process.pid,
        syncing: false,
        requests: {
          total: this.requestStats.total,
          search: this.requestStats.search,
          getDocument: this.requestStats.getDocument,
          indexDocument: 0,
          rebuildIndex: 0,
        },
      },
      database: {
        connectionState: connectionState.state,
        connectionError: connectionState.error?.message,
      },
      index: {
        totalDocuments: stats.totalDocuments,
        totalSections: stats.totalSections,
        dirtyCount: stats.dirtyCount,
      },
      worker: {
        running: false,
        processing: 0,
        queue: queueCount,
      },
    };
  }

  /**
   * インデックス状態を計算
   */
  private async computeIndexStatus(
    documentPath: string,
    sectionHash: string
  ): Promise<{
    status: 'latest' | 'outdated' | 'updating';
    isLatest: boolean;
    hasPendingUpdate: boolean;
  }> {
    // 1. storageから最新のdocument_hashを取得
    const doc = await this.storage.get(documentPath);
    if (!doc) {
      return {
        status: 'outdated',
        isLatest: false,
        hasPendingUpdate: false,
      };
    }

    const isLatest = sectionHash === doc.metadata.fileHash;

    // 2. pending/processingのリクエストがあるか確認
    const pendingRequests = await this.dbEngine.findIndexRequests({
      documentPath,
      status: ['pending', 'processing'],
    });

    const hasPendingUpdate = pendingRequests.length > 0;

    // 3. ステータスを判定
    let status: 'latest' | 'outdated' | 'updating';
    if (hasPendingUpdate) {
      status = 'updating';
    } else if (isLatest) {
      status = 'latest';
    } else {
      status = 'outdated'; // 通常ありえない（古いindexは削除されるため）
    }

    return { status, isLatest, hasPendingUpdate };
  }
}
