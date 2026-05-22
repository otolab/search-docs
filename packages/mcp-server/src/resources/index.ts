import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GETTING_STARTED_CONTENT } from './getting-started.js';
import { ARCHITECTURE_CONTENT } from './architecture.js';
import { USAGE_CONTENT } from './usage.js';
import { CONFIG_REFERENCE_CONTENT } from './config-reference.js';

interface ResourceDefinition {
  name: string;
  uri: string;
  description: string;
  content: string;
}

const RESOURCES: ResourceDefinition[] = [
  {
    name: 'search-docsをはじめる',
    uri: 'search-docs://getting-started',
    description: 'セットアップ手順と設定ファイルの書き方',
    content: GETTING_STARTED_CONTENT,
  },
  {
    name: 'アーキテクチャ概要',
    uri: 'search-docs://architecture',
    description: 'プロセス構成・Embedding・Worker・Docker・CLI',
    content: ARCHITECTURE_CONTENT,
  },
  {
    name: 'search-docsの使い方',
    uri: 'search-docs://usage',
    description: '検索・文書取得・アウトラインの効果的な使い方',
    content: USAGE_CONTENT,
  },
  {
    name: '設定リファレンス',
    uri: 'search-docs://config-reference',
    description: '.search-docs.jsonの全オプション解説',
    content: CONFIG_REFERENCE_CONTENT,
  },
];

export function registerResources(server: McpServer): void {
  for (const resource of RESOURCES) {
    server.resource(
      resource.name,
      resource.uri,
      { description: resource.description, mimeType: 'text/markdown' },
      () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: 'text/markdown',
            text: resource.content,
          },
        ],
      })
    );
  }
}
