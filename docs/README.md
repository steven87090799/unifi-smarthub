# SmartHub 文件索引

根目錄只保留高頻入口；其餘文件依用途分類。

| 需求 | 文件 |
|---|---|
| AI／Claude Code 初始入口與低上下文流程 | [CLAUDE.md](../CLAUDE.md) |
| AI 任務分流與預設排除 | [CONTEXT.md](../CONTEXT.md)、[EXCLUDE-FILES.md](../EXCLUDE-FILES.md) |
| 安裝、快速使用 | [專案 README](../README.md) |
| 完整操作與文件規格 | [SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html](../SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html) |
| 目前架構 | [architecture.md](reference/architecture.md) |
| 後端定位 | [backend-map.md](reference/backend-map.md) |
| 前端定位 | [frontend-map.md](reference/frontend-map.md) |
| 正式發布 | [PRODUCTION-RELEASE-CHECKLIST.md](operations/PRODUCTION-RELEASE-CHECKLIST.md) |
| 最近一次 production blockers 記錄 | [PRODUCTION_RELEASE_BLOCKERS_20260907.md](reports/PRODUCTION_RELEASE_BLOCKERS_20260907.md) |
| 歷史 Production Acceptance 矩陣 | [PRODUCTION_ACCEPTANCE.md](operations/PRODUCTION_ACCEPTANCE.md) |
| Production-like staging 驗收 | [PRODUCTION-STAGING-ACCEPTANCE.md](operations/PRODUCTION-STAGING-ACCEPTANCE.md) |
| Docker 容器管理 | [NAS-DOCKER-MONITOR-SETUP.md](operations/NAS-DOCKER-MONITOR-SETUP.md) |
| 診斷與健康狀態 | [OBSERVABILITY.md](operations/OBSERVABILITY.md) |
| 所有前後端更新頻率 | [POLLING-INTERVALS.md](operations/POLLING-INTERVALS.md) |
| 裝置整合 | [integrations/](integrations/) |
| 未完成規劃 | [planning/](planning/) |
| 歷史報告與發布說明 | [reports/](reports/) |
| 長期硬化證據 | [PRODUCTION_LONG_RUN_HARDENING_REPORT.md](reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md) |
| 本次 final branch／legacy audit | [PRODUCTION_FINAL_LEGACY_SALVAGE.md](reports/PRODUCTION_FINAL_LEGACY_SALVAGE.md) |
| 本次 production finalization audit | [PRODUCTION_FINALIZATION_AUDIT.md](reports/PRODUCTION_FINALIZATION_AUDIT.md) |

權威順序：實際 source／tests → `reference/backend-map.md`／`reference/frontend-map.md` → 現行 `operations/`／`integrations/` → 日期綁定的 `reports/`。報告只代表其記錄日期、branch 與 commit，不取代目前程式；`PRODUCTION_ACCEPTANCE.md`、`PRODUCTION_READINESS_REPORT.md` 等歷史矩陣不能當成目前 exact-head 驗收。HTML 手冊列出所有 Markdown 的位置、用途與連結。

## Console UI 歷史設計

- [設計基線](reports/CONSOLE_UI_REDESIGN_BASELINE.md)
- [改版報告](reports/CONSOLE_UI_REDESIGN_REPORT.md)
