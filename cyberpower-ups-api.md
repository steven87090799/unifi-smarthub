# CyberPower UPS macOS 電源管理與 API 參考指南

本文件彙整了在 macOS 環境下監控 CyberPower 不斷電系統 (UPS) 的原生電源架構、官方 PowerPanel 背景進程 API 逆向，以及開源與免驅動物理 HID 方案，提供給自動化監控與整合儀表板開發使用。

---

## 1. macOS 原生電源管理架構 (IOKit / pmset)

macOS 系統內建 `com.apple.BatteryCenter` 與 `com.apple.iohid` 機制，核心預設每 2-5 秒自動輪詢符合 USB HID Power Device Class 標準的設備（以 CyberPower 為例，其 VendorID 為 `1892` / `0x0764`，ProductID 通常為 `1281`）。

### 1.1 終端機/腳本解析方案
- **快速查詢**：`pmset -g ps` 或 `pmset -g batt`。
- **極簡 Bash 正則解析器**：
```bash
pmset -g ps | awk -F';' 'NR==2 {print "Capacity:" $1, "Status:" $2}' | sed 's/.*-\s*//'
```

### 1.2 原生 PyObjC 記憶體呼叫 API (免 Subprocess 開銷)
透過 macOS 原生的 `IOPS` (Input Output Power Sources) API 直接獲取資料，以避免頻繁建立 Subprocess 的系統開銷：
```python
import objc, json
from Foundation import NSBundle

def get_ups_data():
    IOKit = NSBundle.bundleWithIdentifier_('com.apple.framework.IOKit')
    functions = [
        ("IOPSCopyPowerSourcesInfo", b"@"),
        ("IOPSCopyPowerSourcesList", b"@@"),
        ("IOPSGetPowerSourceDescription", b"@@@")
    ]
    objc.loadBundleFunctions(IOKit, globals(), functions)
    blob = IOPSCopyPowerSourcesInfo()
    lst = IOPSCopyPowerSourcesList(blob)
    return [IOPSGetPowerSourceDescription(blob, x) for x in lst if IOPSGetPowerSourceDescription(blob, x).get("Type") == "UPS"]

print(json.dumps(get_ups_data()))
```
- **回傳字典關鍵字**：`Name`, `Power Source State`, `Current Capacity`, `Max Capacity`, `Is Charging`, `Voltage` (單位毫伏 mV), `Time to Empty` (單位分鐘)。

---

## 2. 官方 PowerPanel 背景進程解耦與 API 逆向

### 2.1 停用前台 GUI，僅保留後台 USB 守護進程
PowerPanel Personal 在 `/Library` 下註冊有以下兩個啟動項：
- **後台 Daemon**：`/Library/LaunchDaemons/com.cyberpower.powerpanel-personal.daemon.plist`
- **前台 GUI Client**：`/Library/LaunchAgents/com.cyberpower.powerpanel-personal.client.plist`
- **操作**：移除或移動 `com.cyberpower.powerpanel-personal.client.plist`，重新開機後即可關閉前台 GUI，僅讓 Daemon 在背景運作，從而釋放系統 UI 資源。

### 2.2 封裝官方 CLI 工具
- **底層 CLI 查詢**：`/bin/pwrstat -status`
- **REST API 封裝 (sbruggeman/pwrstat-api)**：可基於 Python 定期調用 `pwrstat -status` 並以正則表達式轉化為 JSON。預設監聽 `5002` 埠。

### 2.3 逆向 PowerPanel Business Local 網頁 API
PowerPanel Business 本地 Web 伺服器預設監聽 `3052` 埠：
- **數據 API 端點**：`http://localhost:3052/agent/ppbe.js/init_status.js`
- **回傳格式 (非標準 JSON)**：`var ppbeJsObj = {"status": ...};`
- **解析與讀取機制**：
```python
import urllib.request, re
raw = urllib.request.urlopen("http://localhost:3052/agent/ppbe.js/init_status.js").read().decode('utf-8')
json_data = re.sub(r'^var ppbeJsObj\s*=\s*|;\s*$', '', raw.strip())
```

---

## 3. 純開源與物理 HID 免驅動方案

### 3.1 方案 A：Network UPS Tools (NUT)
- **安裝**：`brew install nut`
- **`ups.conf` 核心配置**：
```ini
[cyberpower]
driver = usbhid-ups
port = auto
pollinterval = 15
```
- **`nut.conf` 配置**：`MODE=netserver`

#### macOS 獨佔衝突排除 (claim USB device failed)
macOS 系統節能器預設會獨佔 UPS USB HID 連線。
1. 停止官方的 PowerPanel Daemon 服務。
2. 進入 macOS **系統設定 -> 節能器 (或電池)** -> **取消勾選** 任何 UPS 監控選項，強迫 macOS 核心釋放對該 HID 設備的獨佔權。
3. 啟動 NUT 服務：`brew services start nut`。
4. 查詢數據：`upsc cyberpower@localhost`。

### 3.2 方案 B：純 Python 免驅動直接讀取
- **開源庫**：`bjonnh/cyberpower-usb-watcher`
- **依賴環境**：`brew install hidapi`，利用 `libhidapi-libusb` 與 Python `hid` 模組。
- **機制**：直接向 USB 總線發送符合 `pdcv10.pdf` 標準的 `GET_REPORT` 請求，完全不依賴任何作業系統守護進程 (daemon)。自帶 HTTP exporter 預設於 `http://127.0.0.1:9500/metrics` 輸出 Prometheus 格式指標。

---

## 4. 指標欄位對照表

| 監控物理指標 | IOKit / pmset 鍵值 | cyberpower-usb-watcher (HID) | pwrstat JSON 鍵值 | 單位 |
| :--- | :--- | :--- | :--- | :--- |
| **市電輸入電壓** | N/A | `vin` | `Utility Voltage` | V |
| **UPS 輸出電壓** | `Voltage` (毫伏) | `vout` | `Output Voltage` | V / mV |
| **當前負載功率** | N/A | `load` | `Load` | % / W |
| **剩餘電池容量** | `Current Capacity` | `battery` | `Battery Capacity` | % |
| **預估剩餘時間** | `Time to Empty` | `runtime` | `Remaining Runtime` | Min / Sec |

---

## 5. 開源檢索避坑指南
- **避免檢索**：`shipping-ups`、`ups-api`、`node-shipping-ups` 等項目。此為 **United Parcel Service (快遞公司/物流托運)** 的追蹤 API。
- **正確關鍵詞**：`NUT`、`usbhid-ups`、`pwrstat-api`、`cyberpower-usb-watcher`、`IOPowerSources`。
