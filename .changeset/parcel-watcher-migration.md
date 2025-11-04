---
'@search-docs/server': minor
---

@parcel/watcherへの移行でファイル監視を改善

chokidarから@parcel/watcherへ完全移行し、大規模プロジェクトでのEMFILE問題を根本的に解決しました。

**主な変更:**
- ネイティブC++実装によるイベントスロットリング
- Watchman連携（オプション）による高速化
- 大規模プロジェクト（10万ファイル規模）でも効率的に動作

**破壊的変更:**
- WatcherConfigからusePolling/pollingIntervalを削除（@parcel/watcherはネイティブ実装のため不要）

**実績:**
- Parcel, Nuxt.js, Viteで採用実績あり
- 全69テストがパス
