# WiiM HTTP API 與通訊協定完整技術參照表

本技術參照表針對 WiiM 串流設備（涵蓋 WiiM Mini, Pro, Pro Plus, Amp 及 Ultra）之 HTTP API 與系統協定進行高密度結構化彙整。

系統設計上，所有 API 端點皆採用 HTTP/HTTPS GET 請求，即使涉及狀態變更或參數寫入亦然。
- **基礎請求 URL 格式**：`http://<WiiM-IP-ADDRESS>/httpapi.asp?command=<指令與參數>`
- 多數回傳結果採 JSON 格式；由於設備憑證多為自簽發，自動化腳本需略過 TLS 憑證驗證或建立反向代理。

---

## 1. 設備狀態與網路拓樸組態

此模組涵蓋系統硬體層級資訊與 IP 網路配置。getStatusEx 提供了硬體版本的精確判別，例如 WiiM Amp 可透過檢查 PCB_version 欄位確認主機板修訂版本，藉此診斷 Subwoofer 輸出的硬體濾波或雜訊處理能力。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `getStatusEx` | 無 | 輸出完整 JSON，包含 `UUID`, `firmware`, `MAC`, `AP_MAC`, `date`, `time`, `netstat`, `PCB_version`, `languages` 等欄位。 |
| `wlanGetConnectState` | 無 | 回傳當前 WLAN 連線狀態之純文字（非 JSON）。 |
| `getStaticIpInfo` | 無 | 回傳 JSON，含 `wlanStaticIp`, `wlanGateWay`, `wlanDnsServer`, `wlanStaticIpEnable`，以及對應之 eth 乙太網路欄位。若採 DHCP，靜態欄位為空字串。 |
| `setWlanStaticIp` | `:ipAddr=<IP/遮罩>:gateWay=<IP>:dnsServer=<IP>` | 寫入靜態 IP 設置。預設 DNS 為 `8.8.8.8`。回傳 `OK`。 |

---

## 2. 播放狀態、非同步中繼資料與核心架構

WiiM 系統的播放控制呈現「分裂腦 (Split Brain)」架構特性。播放器狀態的 `mode` 欄位決定了設備當前由誰主控：當模式為網路串流 (Mode 10) 或 USB (Mode 11) 時，WiiM 設備的 Linux OS 為絕對主控端，負責管理佇列與索引；若為 AirPlay (Mode 1) 或 Spotify Connect (Mode 31)，則 WiiM 僅作為純接收節點 (Renderer)，此時針對佇列或循環的 API 控制將會失效。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `getPlayerStatus` | 無 | 核心 JSON 結構包含：<br>• `type`: 0 (主設備/獨立), 1 (從屬節點)<br>• `ch`: 0 (立體聲), 1 (左), 2 (右)<br>• `mode`: 1 (AirPlay), 2 (DLNA), 10~19 (Wiimu 網路串流), 31 (Spotify), 40 (AUX/Line-in), 41 (藍牙)<br>• `status`: play, pause, stop, loading<br>• `vol` (0-100), `mute` (0/1), `eq` (EQ預設編號)<br>• `curpos`, `totlen` (進度與總長ms)。 |
| `getMetaInfo` | 無 | 獲取 metaData JSON 物件，解析出 `title`, `artist`, `album`, `albumArtURI`, `sampleRate`, `bitDepth`。 |

---

## 3. 播放控制與媒體串流注入

以下端點直接操作播放引擎。送出串流 URL 播放時，需注意 Hex 編碼機制的應用（針對特殊字元網址）；循環控制端點的有效性嚴格綁定於上述的播放器 `mode` 狀態。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `setPlayerCmd:play:<url>` | URL 直接附加於後 | 注入並播放音訊流位址，回傳 `OK`。 |
| `setPlayerCmd:playlist:<url>:<idx>` | URL 與起始索引 `idx` | 解析並播放 M3U 或 ASX 播放清單。 |
| `setPlayerCmd:hex_playlist:<url>:<idx>` | 將 URL 轉為 Hex 編碼 | 針對含特殊字元之清單網址進行 Hex 編碼後播放。 |
| `setPlayerCmd:m3u:play:<url>` | URL 直接附加於後 | 針對特定 m3u 格式之播放注入端點。 |
| `setPlayerCmd:pause` / `resume` | 無 | 執行暫停或恢復播放。 |
| `setPlayerCmd:onepause` | 無 | 狀態切換 (Toggle)：若暫停則播放，若播放則暫停。 |
| `setPlayerCmd:stop` | 無 | 停止播放，釋放緩衝區。 |
| `setPlayerCmd:prev` / `next` | 無 | 佇列上/下移控制。 |
| `setPlayerCmd:seek:<sec>` | `<sec>` 為絕對秒數 | 指定跳轉至音軌之秒數。 |
| `setPlayerCmd:loopmode:<n>` | `<n>`: 0(順序), 1(單曲), 2(隨機), -1(清單循環) | 控制 RAM 中的佇列排序。僅在設備擁有控制權 (如 USB/本地清單) 時生效。 |

---

## 4. 音訊硬體設定與數位訊號處理 (DSP)

此模組涵蓋音量絕對/相對控制、輸入源增益與各項數位輸出延遲調校。WiiM Ultra 等設備允許透過設定動態改變各輸入源的預增益 (Pre-gain)，以達到不同音源切換時的響度一致性。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `setPlayerCmd:vol:<value>` | `<value>`: 0 至 100 | 設定絕對音量，即時生效。 |
| `setPlayerCmd:vol++` / `vol--` | 無 | 遞增或遞減音量（以單一單位步進）。 |
| `setPlayerCmd:mute:<n>` | `<n>`: 1 (靜音), 0 (解除) | 主節點靜音時，群組內從屬節點同步靜音。 |
| `getChannelBalance` | 無 | 獲取左右聲道平衡，數值介於 -1.0 (極左) 至 1.0 (極右)。 |
| `setChannelBalance:<val>` | `<val>`: -1.0 ~ 1.0 | 設定左右聲道平衡。 |
| `getSpdifOutSwitchDelayMs` | 無 | 獲取 SPDIF 數位輸出端取樣率切換延遲 (ms)。 |
| `setSpdifOutSwitchDelayMs:<val>` | `<val>`: 最高 3000 | 減輕外部 DAC 切換取樣率時產生的爆音現象。 |
| `getPlayModeGainConfig` | 無 | 讀取來源之 Pre-gain (預增益) 設定陣列。 |
| `setPlayModeGainConfig:<json>` | 需經 URL 編碼之 JSON | 寫入預增益。結構例：`{"config":[{"gain":"0","mode":"10","name":"wifi"}...],"enable":1,"max_gain":"10.0","min_gain":"-10.0"}`。 |
| `getNewAudioOutputHardwareMode` | 無 | 獲取底層音訊輸出介面狀態。 |

---

## 5. 輸入源切換與捷徑預設 (Presets)

針對多介面設備（如 WiiM Amp / Ultra），可透過 API 強制變更訊號接收源，並利用捷徑調用儲存的網路串流。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `setPlayerCmd:switchmode:<m>` | `<m>`: wifi, line-in, bluetooth, optical, co-axial, udisk, PCUSB | 強制切換硬體輸入源。 |
| `getPresetInfo` | 無 | 獲取 `preset_list` 陣列，含 1-12 組儲存之電台/清單資訊。 |
| `MCUKeyShortClick:<n>` | `<n>`: 1 至 12 | 觸發指定編號之預設內容。 |

---

## 6. GEQ 與 PEQ 均衡器控制

此 API 允許針對 10 段圖形均衡器 (GEQ) 與參數均衡器 (PEQ) 進行深度調校，支援外部感測器透過即時發送封包 (Throttle) 平滑控制頻段數值。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `EQGetStat` | 無 | 回傳 `{"EQStat":"On"}` 或 `Off`。 |
| `EQOn` / `EQOff` | 無 | 快速啟用/停用現有均衡器配置。 |
| `EQGetList` | 無 | 回傳內建模式字串陣列 (如 Flat, Rock)。 |
| `EQLoad:<name>` | `<name>` 需吻合 List 內容 | 載入特定預設 EQ。 |
| `EQGetBand` | 無 | 獲取目前量測/套用之 EQ/PEQ 陣列，含各頻帶數值 (0-99，50為平直)。 |
| `EQSetBand:<json>` | 附加 URL 編碼 JSON | 針對特定頻率寫入增益：`{"EQBand":[{"index":0,"param_name":"band31hz","value":10}]}`。 |
| `EQChangeSourceFX:<json>` | 附加 URL 編碼 JSON | 載入 PEQ 插件至指定輸入源。例：`{"source_name":"wifi","pluginURI":"http://moddevices.com/plugins/caps/EqNp"}`。 |
| `EQSourceOff:<json>` | 附加 URL 編碼 JSON | 針對指定輸入源停用特效插件。 |

---

## 7. 藍牙協議層與通訊管理

允許外部自動化系統觸發藍牙配對模式或清除連線狀態，以實現無人介入之環境整合。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `startbtdiscovery:<sec>` | `<sec>` 為掃描秒數 | 啟動藍牙裝置搜尋掃描程序。 |
| `getbtdiscoveryresult` | 無 | 輸出 `scan_status` (3: 掃描中, 4: 完成) 與 `list` 陣列。 |
| `clearbtdiscoveryresult` | 無 | 清空暫存的藍牙發現記錄。 |
| `getbthistory` | 無 | 獲取已配對的 Audio Sink/Source 歷史清單。 |
| `getbtpairstatus` | 無 | 回傳 `{"result":<n>}` (1: 未連線, 3: 已連線)。 |
| `connectbta2dpsynk:<mac>` | `<mac>` 格式: `xx:xx...` | 要求強制連線至特定藍牙 MAC 位址。 |
| `disconnectbta2dpsynk:<mac>` | `<mac>` 格式: `xx:xx...` | 斷開特定裝置連線。 |

---

## 8. 系統拓樸與多房間群組管理

在叢集拓樸中，多台 WiiM 設備透過 `JoinGroupMaster` 指令指派主從關係，封包將於區域網路內同步分發。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `ConnectMasterAp:JoinGroupMaster:eth<IP>` | `<IP>`: 目標主設備 IP | 將接收指令之節點綁定至 `<IP>` 主設備成為從屬節點。 |
| `ConnectMasterAp:JoinGroupMaster:eth0` | 參數固定為 `eth0` | 將接收指令之節點解除群組綁定，恢復為獨立模式。 |

---

## 9. 系統運維、排程與顯示器配置

涵蓋定時器機制、遠端重新啟動、與其他協議支援 (如 LMS, Chromecast 服務整合) 等進階功能。

| API 指令 (command=) | 參數與語法範例 | 回應資料結構與系統說明 |
| :--- | :--- | :--- |
| `reboot` | 無 | 觸發硬體重新啟動。 |
| `setShutdown:<sec>` | `<sec>`: 倒數秒數 | 寫入定時關機 / 待機排程。 |
| `getShutdown` | 無 | 回傳距關機剩餘秒數。 |
| `timeSync:<YYYYMMDDHHMMSS>` | UTC 絕對時間字串 | 於離線環境強制同步 RTC 時間。 |
| `setAlarmClock:<n>:<val>` | `<n>`: 操作模式, `<val>`: 參數 | 設定硬體鬧鐘功能 (0: 取消, 1: 單次含日期, 2: 每日)。 |
| `LED_SWITCH_SET:<n>` | `<n>`: 0 關, 1 開 | 硬體狀態指示燈明暗控制。 |
| `Button_Enable_SET:<n>` | `<n>`: 0 關, 1 開 | 觸控面板按鍵功能鎖定控制。 |
| `setLightOperationBrightConfig` | JSON 參數字串 | 針對具備 LCD (如 Amp/Ultra)，修改自動感光與亮度：`{"auto_sense_enable":0,"default_bright":1,"disable":1}`。 |
| `Squeezelite:getState` | 無 | 獲取 LMS 通訊協定介面狀態 (`state`, `discover_list` 等)。 |
| `Squeezelite:connectServer` | `:<IP>` | 將 Squeezelite 引擎連線至指定伺服器。 |
| `Cast:EnableCast` / `DisableCast` | 無 / 布林相關邏輯 | 開啟/關閉 Chromecast 整合及使用數據回報 (`EnableUsageReport`, `DisableUsageReport`)。 |

---

## 10. wiim_api 實作映射對照 (Rust 函式庫)

由開發者 `carloseberhardt` 釋出的 Rust `wiim_api` 工具包，將上述原始 HTTP 通訊協定進一步封裝為非同步 (Async) 型態呼叫。該函式庫覆蓋約 52% 之 API，以下為其指令封裝之對照，做為 AI 邏輯抽象之參照點：

- **實體化與連線測試**：提供 `WiimClient::new(ip)` 及非同步檢測 `WiimClient::connect(ip).await?`。
- **獲取狀態 (Getters)**：`get_now_playing()` 封裝了底層的 `getMetaInfo`；`get_player_status()` 則映射至同名 HTTP 指令並解析為強型別 Struct。
- **播放控制機制**：方法如 `play()`, `pause()`, `stop()`, `toggle_play_pause()`, `next_track()`, `previous_track()` 提供直覺之函式呼叫。
- **音量封裝**：`set_volume(u8)`, `volume_up(Option<u8>)`, `volume_down(Option<u8>)`, `mute()`, `unmute()` 提供對絕對數值與相對步進量的防呆處理。
- **目前缺漏與局限**：該 Rust 工具包尚未封裝 URL 串流注入、`MCUKeyShortClick` (捷徑預設)、輸入源切換 (`switchmode`) 及上述詳細之 EQ/PEQ 數位處理器調整。未涵蓋之功能需直接以本文件定義之底層端點字串進行操作。
