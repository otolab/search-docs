/**
 * サーバマネージャー（関連プロジェクトURL接続管理）
 */

import { SearchDocsClient } from '@search-docs/client';
import type { RelatedProjectConfig } from '@search-docs/types';

/**
 * サーバ情報（複数プロジェクト対応）
 */
interface ServerInfo {
  client: SearchDocsClient;
  port: number;
  projectRoot: string;
  projectName: string;
}

/**
 * サーバマネージャー（関連プロジェクトURL接続管理）
 */
export class ServerManager {
  // 複数プロジェクトのサーバを管理
  private servers: Map<string, ServerInfo> = new Map();

  // 一時的な関連プロジェクト（設定ファイル未保存）
  private temporaryRelatedProjects: Map<string, RelatedProjectConfig> = new Map();


  /**
   * 起動済みプロジェクトのサーバクライアントを取得
   * @param projectName プロジェクト名
   * @returns クライアント（未起動またはダウンの場合はnull）
   */
  async getServer(projectName: string): Promise<SearchDocsClient | null> {
    const cached = this.servers.get(projectName);
    if (!cached) {
      return null;
    }

    try {
      await cached.client.healthCheck();
      return cached.client;
    } catch {
      // サーバが停止している、キャッシュをクリア
      this.servers.delete(projectName);
      return null;
    }
  }


  /**
   * すべてのサーバ情報を取得
   */
  getAllServers(): Map<string, ServerInfo> {
    return this.servers;
  }

  /**
   * 関連プロジェクトへのURL接続を確立
   */
  async connectRelatedProject(
    projectName: string,
    allRelated: Record<string, RelatedProjectConfig>
  ): Promise<SearchDocsClient> {
    // キャッシュにあればヘルスチェック付きで返す
    const cached = await this.getServer(projectName);
    if (cached) return cached;

    const relatedConfig = allRelated[projectName];
    if (!relatedConfig) {
      throw new Error(
        `関連プロジェクト "${projectName}" が設定されていません。\n\n` +
        `利用可能なプロジェクト: ${Object.keys(allRelated).join(', ') || '(なし)'}\n` +
        `追加するには: add_related_project`
      );
    }

    if (!relatedConfig.url) {
      throw new Error(
        `関連プロジェクト "${projectName}" の設定に "url" が必要です。`
      );
    }

    const baseUrl = ServerManager.resolveDockerUrl(relatedConfig.url);
    console.error(`[mcp-server] Connecting to URL for project: ${projectName} (${baseUrl})`);
    const client = new SearchDocsClient({ baseUrl });

    try {
      await client.healthCheck();
      console.error(`[mcp-server] ✓ Connection established for project: ${projectName}`);
    } catch (error) {
      throw new Error(
        `関連プロジェクト "${projectName}" のサーバ (URL: ${relatedConfig.url}) に接続できません。\n` +
        `エラー: ${(error as Error).message}`
      );
    }

    const serverInfo: ServerInfo = {
      client,
      port: 0,
      projectRoot: '',
      projectName,
    };
    this.servers.set(projectName, serverInfo);
    console.error(`[mcp-server] URL client cached for project: ${projectName}`);

    return client;
  }

  /**
   * 一時的な関連プロジェクトを追加
   */
  addTemporaryRelatedProject(name: string, config: RelatedProjectConfig): void {
    this.temporaryRelatedProjects.set(name, config);
  }

  /**
   * 設定ファイルと一時追加分をマージした関連プロジェクト一覧を取得
   */
  getAllRelatedProjects(
    configRelated?: Record<string, RelatedProjectConfig>
  ): Record<string, RelatedProjectConfig> {
    const merged: Record<string, RelatedProjectConfig> = {};

    // 設定ファイルからの関連プロジェクト
    if (configRelated) {
      for (const [name, config] of Object.entries(configRelated)) {
        merged[name] = { ...config };
      }
    }

    // 一時追加分（同名がある場合は一時追加分が優先）
    for (const [name, config] of this.temporaryRelatedProjects) {
      merged[name] = config;
    }

    return merged;
  }

  /**
   * Docker環境ではlocalhost/127.0.0.1をhost.docker.internalに置換
   */
  static resolveDockerUrl(url: string): string {
    if (process.env.IS_DOCKER !== 'true') return url;
    return url.replace(/\/\/(localhost|127\.0\.0\.1)([:/]|$)/, '//host.docker.internal$2');
  }
}
