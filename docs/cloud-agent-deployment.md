# Cursor Cloud Agent 向け search-docs 運用

[Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup) / [Builds](https://cursor.com/docs/cloud-agent/builds) に沿った、このリポジトリ向けの手順です。

**前提**: 公開 npm の **`npx @search-docs/cli`** でサーバを起動する構成（Docker 第一選択ではない）。Epic: [GitHub #141](https://github.com/otolab/search-docs/issues/141)、ドキュメント Issue: [#142](https://github.com/otolab/search-docs/issues/142)。

## 2 種類の disk 状態

| 種類 | 含めるもの | 含めないもの |
|------|------------|--------------|
| **ベース**（Build の `install` + lean Environment Save） | `uv`、`pnpm install`（モノレポ開発時）、Ruri ONNX（`scripts/hf-prefetch` → `~/.cache/huggingface`） | LanceDB 索引（`storage` で指定したパス） |
| **索引付きスナップショット**（Environment **Version Save**） | 上記 + 索引・ドキュメントコピー先 | （特になし） |

- **ベース Build に索引 warm を入れない** — `install` が毎回走っても索引構築で時間を消費しない。
- **索引は Environment のバージョン履歴で保持** — Dashboard で Restore / Activate する運用を想定。

> **注意（2026-10）**: 索引付き Environment Version Save の復元は **まだ検証中**。手順は以下に記載するが、Save → 新 Agent で検索できることは未確認。

## 設定の考え方

### `.search-docs.json`

リポジトリにコミットするのは **設定のみ**（[user-guide.md](./user-guide.md) と同様）。

Cloud Agent で「ワークツリー外にドキュメントと索引を置く」例:

```json
{
  "storage": {
    "documentsPath": "/home/ubuntu/.local/share/search-docs/my-project/documents",
    "indexPath": "/home/ubuntu/.local/share/search-docs/my-project/index",
    "cachePath": "/home/ubuntu/.local/share/search-docs/my-project/cache"
  },
  "files": {
    "sources": ["/home/ubuntu/.local/share/search-docs/my-project/docs/**/*.md"],
    "exclude": ["**/node_modules/**"]
  }
}
```

- 検索対象 Markdown は **別ディレクトリにコピー**（または sync）し、`sources` で参照する。
- 本リポジトリ単体で試す場合は、ルートの [`.search-docs.json`](../.search-docs.json) の既定（`.search-docs/` 配下）でもよいが、**`.search-docs/` は `.gitignore` 済み**のため VM 再作成時は索引が消える。

### `.gitignore`

- **コミットする**: `.search-docs.json`
- **コミットしない**: `.search-docs/`（索引・PID・ログ）、必要に応じて外部 `storage` パス全体

## リポジトリ側のフック

[`.cursor/environment.json`](../.cursor/environment.json):

| フィールド | 役割 |
|-----------|------|
| `install` | [`scripts/cloud-agent/install.sh`](../scripts/cloud-agent/install.sh) — `uv` + HF prefetch（**`embedding start` は使わない**） |
| `start` | Agent run 開始時に `npx -y @search-docs/cli@… server start`（embedding は server が子プロセス起動） |
| `egressAllowlist` | npm / uv / **Hugging Face Hub + LFS + CDN (`*.hf.co` 系)** |

CLI バージョンは `SEARCH_DOCS_CLI`（例: `@search-docs/cli@1.3.1`）で揃える。

## 手順

### 1. 初回 — lean ベース

1. Cloud Agents → この repo の Environment → Setup。
2. Build が `install` を実行（`uv` + Ruri ONNX prefetch）。
3. **索引は作らない**まま Environment を Save（ベース用バージョン）。

### 2. 索引付きスナップショットを作る（検証中）

メンテナーがドキュメントが揃った VM で:

```bash
bash scripts/cloud-agent/snapshot-search-docs-index.sh
# または
pnpm run search-docs:snapshot
```

完了後:

1. Dashboard → **Environment → Save**（新バージョン）。説明例: `search-docs index @ main <short-sha>`。
2. チーム既定にする場合、そのバージョンを **Restore / Activate**。

ドキュメントを大きく増やしたあとは同手順で索引スナップショットを更新する。

### 3. 通常の Agent run

- lean `install` の Build から起動。
- 索引付きバージョンを Restore していれば差分 sync のみを期待（未検証）。
- `start` で search-docs server。未 Restore なら初回 run でバックグラウンド索引（モデルは `install` 済みなら DL 不要）。

### 4. ローカル（Cursor Desktop）

Cloud と同じ `storage` 絶対パスに揃えると VM と索引を共有しやすい。Cloud Agent のホームは多くの場合 `/home/ubuntu`。

## 補助スクリプト

| コマンド | 内容 |
|---------|------|
| `pnpm run env:install` | Build `install` と同内容（手元確認） |
| `pnpm run search-docs:snapshot` | server 起動 → 索引キューが空になるまで待機 → Save 前に実行 |

`wait-search-docs-index.mjs` は `SEARCH_DOCS_INDEX_WAIT_MS` / `SEARCH_DOCS_INDEX_POLL_MS` で調整可能。

## トラブルシュート

| 症状 | 対処 |
|------|------|
| embedding Connection refused | `server start` のみ（手動 `embedding start` 不要）。24281 競合時は `embedding stop --force` |
| HF モデル DL 失敗 | egress に HF CDN/LFS ホストを追加。[HF meta](https://huggingface.co/.well-known/meta.json) 参照。`HF_HUB_DISABLE_XET=1`（install 既定）。レート制限なら `HF_TOKEN` |
| 初回 HF が遅い | `scripts/hf-prefetch/` の `snapshot_download`（リトライ 5 回）。Build では CLI の 120s ready 制限を使わない |
| `install` で embedding がタイムアウト | [#139](https://github.com/otolab/search-docs/issues/139) — ready 待ち・`embedding download` 改善 |
| 索引が古い | `snapshot-search-docs-index.sh` → Environment Save |
| Build が遅い | `install` に索引 warm を入れない（本 repo の方針） |

## 関連

- [docker-deployment.md](./docker-deployment.md) — Docker / MCP イメージ向け
- [mcp-integration.md](./mcp-integration.md) — MCP 設定
- [user-guide.md](./user-guide.md) — `.search-docs.json` と CLI 一般
