---
"@search-docs/db-engine": patch
---

メモリ監視の統一とスカラーインデックスの増分更新

- メモリ監視をPython PerformanceLoggerに統一し、execSyncによるCPUスパイクを解消
- データ書き込み後にtable.optimize()を呼び、スカラーインデックスを増分更新するよう修正
