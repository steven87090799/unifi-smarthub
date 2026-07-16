# 待確認刪除清單

建立日期：2026-07-17。此資料夾尚未永久刪除任何內容。

| 分類 | 數量 | 原因 |
|---|---:|---|
| `completed-prompts/` | 2 | 生產強化任務與初始審查已完成，結果已進最終報告 |
| `obsolete-docs/` | 2 | 舊架構規格過長；WiiM 舊規格與目前 SQLite／3 秒取樣不符 |
| `duplicate-tests/` | 29 | 與同名正式測試逐位元完全相同的 `* 2.js` |
| `runtime-backups/` | 7 | 2026-07-13 SQLite 遷移後的 `*.migrated.bak`，程式不再讀取 |

`duplicate-tests/` 與 `runtime-backups/` 已加入 `.gitignore`：前者避免提交純副本，後者避免把可能含內網歷史的資料加入 Git。它們仍保留在本機此資料夾內。

確認刪除前可檢查：

```bash
find _pending-delete-2026-07-17 -type f | sort
du -sh _pending-delete-2026-07-17
```

建議確認後整個刪除 `_pending-delete-2026-07-17/`，再移除 `.gitignore` 中兩條對應規則。
