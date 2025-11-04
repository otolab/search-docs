---
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/storage": patch
---

Fix test failures and improve test stability

- **db-engine**: Fix Python-TypeScript snake_case/camelCase conversion in search results. Task14 fields (startLine, endLine, sectionNumber) are now correctly converted.
- **server**: Fix test timeout issues and type errors in test files. Increase beforeAll timeout to handle concurrent Python worker initialization.
- **storage**: Add dist/ exclusion to vitest config to prevent duplicate test execution.
- **db-engine**: Enable 2 previously skipped tests (findSectionsByPathAndHash, deleteSectionsByPathExceptHash).
