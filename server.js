// 清除代理伺服器環境變數以防 Axios 走代理導致無法連線本機設備
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Client } = require('ssh2');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // 以專案目錄定位 .env，與啟動時的 cwd 無關

// 統一結構化日誌輸出
function sysLog(module, message, isError = false) {
    const time = new Date().toLocaleString('zh-TW');
    const prefix = `[${time}] [${module}]`;
    if (isError) {
        console.error(`${prefix} ❌ ${message}`);
    } else {
        console.log(`${prefix} ℹ️ ${message}`);
    }
}

const app = express();
app.use(cors());
app.use(express.json());

// Debug 中介層：記錄所有 API 請求 (設 DEBUG_HTTP=0 可關閉)
app.use((req, res, next) => {
    if (process.env.DEBUG_HTTP !== '0' && req.path.startsWith('/api/')) {
        const q = Object.keys(req.query).length ? ' ' + JSON.stringify(req.query) : '';
        sysLog('HTTP', `${req.method} ${req.path}${q}`);
    }
    next();
});

// 託管前端靜態網頁
app.use(express.static(path.join(__dirname, 'public')));

// 建立忽略內網自簽 HTTPS 憑證錯誤的 Axios 實例
// 以 let + 工廠函式宣告，讓「設定頁」修改連線資訊後可熱重建、免重啟 (見 /api/connections)
let unifiCsrfToken = '';
function buildUnifiClient() {
    const c = axios.create({
        baseURL: process.env.UNIFI_CONTROLLER_URL,
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    // UniFi OS 的寫入操作 (POST/PUT) 需要登入時取得的 CSRF token
    c.interceptors.request.use(cfg => { if (unifiCsrfToken) cfg.headers['x-csrf-token'] = unifiCsrfToken; return cfg; });
    return c;
}
let unifiClient = buildUnifiClient();

let localCookie = '';
let cookieExpiry = 0;

// 佔位字串檢查：帳密未填時「完全不發起連線」，避免反覆嘗試被 IPS 判定為掃描行為
const isPlaceholder = v => !v || /your_/i.test(v);

// list/alarm 的 IPS 紀錄 key 依韌體版本不同 (ips:alert / EVT_IPS_IpsAlert)，統一用 isIpsAlarm 判斷
const isIpsAlarm = a => a && (a.key === 'ips:alert' || /^EVT_IPS/i.test(a.key || '') || /^IPS Alert/i.test(a.msg || ''));

// 本地 API 登入 Session 管理
async function getLocalSession() {
    if (isPlaceholder(process.env.UNIFI_USERNAME) || isPlaceholder(process.env.UNIFI_PASSWORD)) {
        throw new Error('unifi_not_configured (UNIFI_USERNAME/PASSWORD 尚未填寫，略過連線)');
    }
    const now = Date.now();
    if (localCookie && now < cookieExpiry) {
        sysLog('UniFi Auth', '使用快取的本地控制器 Session Cookie。');
        return localCookie;
    }

    try {
        sysLog('UniFi Auth', '發起全新的本地控制器登入請求...');
        const response = await unifiClient.post('/api/auth/login', {
            username: process.env.UNIFI_USERNAME,
            password: process.env.UNIFI_PASSWORD
        });

        const cookies = response.headers['set-cookie'];
        if (cookies) {
            unifiCsrfToken = response.headers['x-csrf-token'] || unifiCsrfToken;
            localCookie = cookies.join('; ');
            cookieExpiry = now + 15 * 60 * 1000; // 15 分鐘過期
            sysLog('UniFi Auth', '登入成功，已快取 Session Cookie (15分鐘)。');
            return localCookie;
        }
        throw new Error('No cookie returned from Controller');
    } catch (error) {
        sysLog('UniFi Auth', `控制器登入失敗: ${error.message}`, true);
        throw new Error('UniFi Controller Login Failed: ' + error.message);
    }
}

// 建立 UniFi 官方雲端 Site Manager API 客戶端
function buildUnifiCloudClient() {
    return axios.create({
        baseURL: 'https://api.ui.com/v1',
        headers: {
            'Accept': 'application/json',
            'X-API-KEY': process.env.UNIFI_API_KEY || ''
        }
    });
}
let unifiCloudClient = buildUnifiCloudClient();

// 1. 獲取硬體即時狀態 (SSH) — /proc/stat 與 ip -s link 各取樣兩次(間隔 1 秒)，以差值計算真實核心使用率與網卡速率
const HW_CMD = [
    'ubnt-systool cputemp',
    'free -m',
    'df -m /',
    'cat /proc/uptime',
    'cat /proc/stat',
    'ip -s link',
    'for f in /sys/class/net/*/speed; do echo "$f $(cat $f 2>/dev/null)"; done',
    'sleep 1; cat /proc/stat',
    'ip -s link'
].join('; echo __S__; ');

// 解析 /proc/stat：回傳 { cpu: {idle,total}, cpu0: {...}, ... }
function parseProcStat(txt) {
    const m = {};
    txt.split('\n').forEach(line => {
        const p = line.trim().split(/\s+/);
        if (/^cpu\d*$/.test(p[0])) {
            const nums = p.slice(1).map(Number);
            m[p[0]] = { idle: nums[3] + (nums[4] || 0), total: nums.reduce((a, b) => a + (b || 0), 0) };
        }
    });
    return m;
}

// 解析 ip -s link：回傳 { eth0: {state, rx, tx}, ... }
function parseIpLinks(txt) {
    const m = {};
    txt.split(/^\d+: /m).slice(1).forEach(block => {
        const name = block.split(/[@:]/)[0].trim();
        const state = (block.match(/state (\w+)/) || [])[1] || 'DOWN';
        const rx = (block.match(/RX:[^\n]*\n\s*(\d+)/) || [])[1];
        const tx = (block.match(/TX:[^\n]*\n\s*(\d+)/) || [])[1];
        if (name) m[name] = { state, rx: parseInt(rx, 10) || 0, tx: parseInt(tx, 10) || 0 };
    });
    return m;
}

app.get('/api/hardware', (req, res) => {
    // 帳密未填時不發起 SSH：反覆的 SSH 連線嘗試會被 UniFi IPS 判定為 SSH 掃描 (ET SCAN 2003068)
    if (isPlaceholder(process.env.SSH_PASSWORD) || !process.env.UCG_IP) {
        return res.status(503).json({ error: 'ssh_not_configured', hint: '請在 .env 填寫 SSH_PASSWORD 後重啟' });
    }
    sysLog('Hardware', `發起 SSH 連線至 UCG-Ultra (${process.env.UCG_IP}:${process.env.SSH_PORT || 22})...`);
    const conn = new Client();
    conn.on('ready', () => {
        sysLog('Hardware', 'SSH 連線建立成功，執行遙測指令組...');
        conn.exec(HW_CMD, (err, stream) => {
            if (err) {
                sysLog('Hardware', `SSH 指令執行失敗: ${err.message}`, true);
                conn.end();
                return res.status(500).json({ error: 'SSH Command Execution Failed' });
            }
            let output = '';
            stream.on('data', (chunk) => { output += chunk; })
                .stderr.on('data', () => { });
            stream.on('close', () => {
                sysLog('Hardware', '遙測指令組執行完成，關閉 SSH 連線。');
                conn.end();
                try {
                    const sec = output.split('__S__');

                    // 1. CPU 溫度
                    const tempMatch = sec[0].match(/(\d+)/);
                    const cpuTemp = tempMatch ? parseInt(tempMatch[1], 10) : null;

                    // 2. 記憶體
                    const freeMatch = sec[1].match(/Mem:\s+(\d+)\s+(\d+)/);
                    let memUsagePct = 0, memTotal = 0, memUsed = 0;
                    if (freeMatch) {
                        memTotal = parseInt(freeMatch[1], 10);
                        memUsed = parseInt(freeMatch[2], 10);
                        memUsagePct = Math.round((memUsed / memTotal) * 100);
                    }

                    // 3. 硬碟空間 (eMMC)
                    const dfMatch = sec[2].match(/(\d+)\s+(\d+)\s+\d+\s+(\d+)%\s+\/\s*$/m);
                    let emmcUsagePct = 0, emmcStr = '-- GB / -- GB';
                    if (dfMatch) {
                        emmcUsagePct = parseInt(dfMatch[3], 10);
                        emmcStr = `${(parseInt(dfMatch[2], 10) / 1024).toFixed(2)} GB / ${(parseInt(dfMatch[1], 10) / 1024).toFixed(2)} GB`;
                    }

                    // 4. 真實 Uptime
                    const upSec = parseFloat(sec[3]);
                    const uptime = isNaN(upSec) ? 'System Active'
                        : `up ${Math.floor(upSec / 86400)}d ${Math.floor((upSec % 86400) / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`;

                    // 5. CPU 使用率：兩次 /proc/stat 取樣差值 (真實數據)
                    const s1 = parseProcStat(sec[4]), s2 = parseProcStat(sec[7]);
                    const usagePct = (key) => {
                        if (!s1[key] || !s2[key]) return null;
                        const dTotal = s2[key].total - s1[key].total;
                        const dIdle = s2[key].idle - s1[key].idle;
                        return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
                    };
                    const cpuUsage = usagePct('cpu') ?? 0;
                    const cores = [];
                    for (let i = 0; s1['cpu' + i]; i++) cores.push(usagePct('cpu' + i) ?? 0);

                    // 6. 網卡速率：兩次 ip -s link 取樣的位元組差值 (真實數據)
                    const l1 = parseIpLinks(sec[5]), l2 = parseIpLinks(sec[8]);
                    const speedMap = {};
                    sec[6].split('\n').forEach(line => {
                        const m = line.match(/\/sys\/class\/net\/([^/]+)\/speed\s+(\d+)/);
                        if (m) speedMap[m[1]] = parseInt(m[2], 10);
                    });
                    const wanIface = process.env.WAN_IFACE || 'eth4';
                    const interfaces = Object.keys(l2)
                        .filter(n => /^(eth|en|sfp)/.test(n))
                        .map(n => {
                            const rxMbps = l1[n] ? Math.max((l2[n].rx - l1[n].rx) * 8 / 1e6, 0) : 0;
                            const txMbps = l1[n] ? Math.max((l2[n].tx - l1[n].tx) * 8 / 1e6, 0) : 0;
                            const spd = speedMap[n];
                            return {
                                name: n === wanIface ? `WAN (${n})` : n,
                                status: l2[n].state === 'UP' ? 'connected' : 'disconnected',
                                speed: spd > 0 ? (spd >= 1000 ? `${spd / 1000} Gbps` : `${spd} Mbps`) : 'Link',
                                rxRate: rxMbps.toFixed(1) + ' Mbps',
                                txRate: txMbps.toFixed(1) + ' Mbps'
                            };
                        });

                    res.json({
                        cpuTemp, cpuUsage, cores, memUsagePct,
                        memStr: `${(memUsed / 1024).toFixed(2)} GB / ${(memTotal / 1024).toFixed(2)} GB`,
                        emmcUsagePct, emmcStr, uptime, interfaces,
                        dataSource: 'real'
                    });
                } catch (e) {
                    res.status(500).json({ error: 'Hardware Output Parse Failed: ' + e.message });
                }
            });
        });
    }).on('error', (err) => {
        const authFail = /authentication methods failed/i.test(err.message || '');
        res.status(500).json({
            error: 'SSH Connection Failed',
            details: authFail
                ? 'SSH 密碼被 UCG 拒絕。注意：SSH 密碼是獨立的，不是 UniFi 登入密碼 — 請到 UniFi 主控台 → Console Settings → Advanced → SSH，在那裡「設定 SSH 專用密碼」後填入本頁'
                : err.message
        });
    }).on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // UniFi OS 的 sshd 只開放 keyboard-interactive，不接受純 password 認證
        finish(prompts.map(() => process.env.SSH_PASSWORD));
    }).connect({
        host: process.env.UCG_IP,
        port: parseInt(process.env.SSH_PORT || '22', 10),
        username: process.env.SSH_USER,
        password: process.env.SSH_PASSWORD,
        tryKeyboard: true
    });
});

// 2. 獲取活躍客戶端
app.get('/api/clients', async (req, res) => {
    try {
        sysLog('UniFi API', '獲取活躍客戶端清單...');
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });

        const clients = response.data.data.map(c => ({
            mac: c.mac,
            name: c.name || c.hostname || 'Unknown Device',
            ip: c.ip || 'DHCP Pending',
            is_wifi: !c.is_wired,
            wifi_signal: c.is_wired ? null : c.rssi,
            rx_bytes: c.rx_bytes || 0,
            tx_bytes: c.tx_bytes || 0,
            blocked: c.blocked || false
        }));
        sysLog('UniFi API', `成功獲取 ${clients.length} 個客戶端。`);
        res.json({ clients });
    } catch (error) {
        sysLog('UniFi API', `獲取客戶端失敗: ${error.message}`, true);
        res.status(500).json({ error: error.message });
    }
});

// 2-1. 全網路裝置的實體網埠矩陣 (UCG/USW/AP)，含即時速率與埠上連接的裝置對照
// UniFi 自己已經算好即時速率 (port_table[].tx_bytes-r / rx_bytes-r，單位 bytes/sec)，不需要像 SSH 那樣手動兩次取樣差值
app.get('/api/network/switches', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const [devRes, staRes] = await Promise.all([
            unifiClient.get('/proxy/network/api/s/default/stat/device', { headers: { 'Cookie': cookie } }),
            unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } })
        ]);
        // 依 sw_mac + sw_port 建立「哪個埠接了哪個客戶端」的對照表
        const bySwPort = {};
        (staRes.data.data || []).forEach(c => {
            if (c.sw_mac && c.sw_port != null) bySwPort[`${c.sw_mac}_${c.sw_port}`] = { name: c.name || c.hostname || 'Unknown', mac: c.mac, ip: c.ip };
        });
        const devices = (devRes.data.data || [])
            .filter(d => Array.isArray(d.port_table) && d.port_table.length)
            .map(d => ({
                mac: d.mac,
                name: d.name || d.model,
                model: d.model,
                type: d.type, // udm=閘道器, usw=交換器, uap=無線
                ports: d.port_table.map(p => ({
                    port_idx: p.port_idx,
                    name: p.name || `Port ${p.port_idx}`,
                    up: !!p.up,
                    is_uplink: !!p.is_uplink,
                    speedMbps: p.speed || 0,
                    poe: !!p.port_poe,
                    rxMbps: +(((p['rx_bytes-r'] || 0) * 8 / 1e6).toFixed(2)),
                    txMbps: +(((p['tx_bytes-r'] || 0) * 8 / 1e6).toFixed(2)),
                    client: bySwPort[`${d.mac}_${p.port_idx}`] || (p.last_connection && p.last_connection.connected
                        ? { name: '未知裝置 (無客戶端紀錄，可能是上聯埠)', mac: p.last_connection.mac, ip: p.last_connection.ip }
                        : null)
                }))
            }));
        res.json({ devices });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. 獲取 SSID 列表
app.get('/api/wifi-networks', async (req, res) => {
    try {
        sysLog('UniFi API', '獲取 SSID 設定清單...');
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/proxy/network/api/s/default/rest/wlanconf', { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', `成功獲取 ${response.data.data.length} 個 SSID 配置。`);
        res.json({ networks: response.data.data });
    } catch (error) {
        sysLog('UniFi API', `獲取 SSID 失敗: ${error.message}`, true);
        res.status(500).json({ error: error.message });
    }
});

// 4. 控制 SSID 狀態
app.put('/api/wifi-networks/:id', async (req, res) => {
    try {
        sysLog('UniFi API', `調整 SSID 狀態：ID ${req.params.id} -> 啟用: ${req.body.enabled}`);
        const cookie = await getLocalSession();
        const response = await unifiClient.put(`/proxy/network/api/s/default/rest/wlanconf/${req.params.id}`, {
            enabled: req.body.enabled
        }, { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', `SSID 狀態變更成功。`);
        res.json({ success: true });
    } catch (error) {
        sysLog('UniFi API', `SSID 變更失敗: ${error.message}`, true);
        res.status(500).json({ error: error.message });
    }
});

// 5. 獲取 IPS/IDS 威脅警報
app.get('/api/threats', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });

        // 過濾出與 IPS 相關的警告並擴充結構
        const threats = response.data.data.filter(isIpsAlarm).map(t => {
            // 嘗試解析威脅種類
            let category = "Intrusion Attempt";
            if (t.msg.includes("EXPLOIT")) category = "Web Exploit";
            else if (t.msg.includes("SCAN")) category = "Scanner";
            else if (t.msg.includes("MALWARE") || t.msg.includes("Trojan")) category = "Malware";
            else if (t.msg.includes("DOS")) category = "DoS";

            const geo = t.srcipGeo || {};
            return {
                id: t._id,
                datetime: new Date(t.time || Date.parse(t.datetime)).toISOString(), // 優先用不會有時區歧義的 epoch time 欄位
                src_ip: t.src_ip,
                src_country: geo.country_name || t.src_country || 'Unknown',
                src_lat: geo.latitude || null,   // 0/未知一律視為無座標
                src_lon: geo.longitude || null,
                msg: t.msg,
                port: t.dst_port ? `${t.dst_port}/${t.proto || 'TCP'}` : 'Any',
                severity: 'HIGH',
                category,
                target_ip: t.dest_ip || 'WAN-IN',
                target_device: 'UCG-Ultra Core',
                action_taken: 'BLOCKED'
            };
        }).sort((a, b) => new Date(b.datetime) - new Date(a.datetime)); // list/alarm 由舊到新，前端要最新在前
        res.json({ threats });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 資料持久化目錄 (可用 DATA_DIR 環境變數覆寫；Docker 部署時掛載為 volume 以保留歷史資料)
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { }

/* ===================== 應用程式設定 (可於「設定」頁調整所有伺服器端輪詢間隔) ===================== */
const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
const APP_DEFAULTS = {
    trendActiveSec: 5,      // 有人瀏覽時趨勢取樣間隔
    trendIdleSec: 1800,     // 閒置時趨勢取樣間隔 (30 分鐘)
    activeWindowSec: 30,    // 最近幾秒內有活動視為「有人瀏覽」
    watcherSec: 20,         // 通知監看器間隔
    toastSec: 10,           // 右下角通知泡泡顯示秒數
    autoDefenseSec: 30,     // 自動防禦掃描間隔
    reportEnabled: false,   // 定期報表
    reportFreq: 'daily',    // daily | weekly
    reportHour: 8,          // 每日幾點發送 (0-23)
    upsSampleSec: 30,       // UPS 電壓/電池取樣間隔 (不做閒置降頻，持續記錄)
    wiimCpuAlert: 70,       // WiiM CPU 溫度警示門檻 (°C，圖上門檻線 + 超標推播)
    wiimBoardAlert: 60      // WiiM 主機板溫度警示門檻 (°C)
};
let appSettings = (() => { try { return { ...APP_DEFAULTS, ...JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')) }; } catch { return { ...APP_DEFAULTS }; } })();
function saveAppSettings() { try { fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); } catch { } }

// 封鎖歷史紀錄 (持久化於本地 JSON，僅記錄透過本面板下達的動作)
const HISTORY_FILE = path.join(DATA_DIR, 'block-history.json');
const HISTORY_LIMIT = 200;

function loadBlockHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function appendBlockHistory(entry) {
    const history = loadBlockHistory();
    history.unshift(entry);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, HISTORY_LIMIT), null, 2));
}

// 6. 客戶端限速/阻斷控制
app.put('/api/device/restrict', async (req, res) => {
    try {
        sysLog('UniFi API', `收到客戶端控制請求：MAC ${req.body.deviceId} -> 阻斷: ${req.body.blockState}`);
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/stamgr', {
            cmd: req.body.blockState ? 'block-sta' : 'unblock-sta',
            mac: req.body.deviceId
        }, { headers: { 'Cookie': cookie } });
        { const ns = loadNotifSettings(); if (ns.enabled && ns.triggerBlockAction !== false) notify(req.body.blockState ? '🚫 設備已封鎖' : '✅ 設備已解除封鎖', `${req.body.deviceName || req.body.deviceId}`).catch(() => { }); }
        appendBlockHistory({
            datetime: new Date().toISOString(),
            mac: req.body.deviceId,
            name: req.body.deviceName || 'Unknown Device',
            action: req.body.blockState ? 'block' : 'unblock',
            source: 'manual'
        });
        sysLog('UniFi API', `客戶端 ${req.body.deviceId} 狀態設定成功。`);
        res.json({ success: true });
    } catch (error) {
        const perm = error.response && error.response.data && error.response.data.meta && error.response.data.meta.msg === 'api.err.NoPermission';
        const msg = perm
            ? 'UniFi 帳號權限不足 (NoPermission)：目前登入的本地帳號是「唯讀 (readonly)」角色，只能讀取資料不能下達封鎖指令。請到 UniFi 主控台 → Admins → 把此帳號角色改為「Full Management / Site Admin」'
            : error.message;
        sysLog('UniFi API', `阻斷控制失敗: ${msg}`, true);
        res.status(error.response ? error.response.status : 500).json({ error: msg, code: perm ? 'no_permission' : undefined });
    }
});

// 6-1. 封鎖歷史時間軸
app.get('/api/block-history', (req, res) => {
    res.json({ history: loadBlockHistory() });
});

// 7. PoE Port 斷電重啟
app.post('/api/poe/power-cycle', async (req, res) => {
    try {
        sysLog('UniFi API', `收到 PoE Port 重啟請求：Switch ${req.body.switchMac}, Port ${req.body.portIndex}`);
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/devmgr', {
            cmd: "power-cycle",
            mac: req.body.switchMac,
            port_idx: parseInt(req.body.portIndex, 10)
        }, { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', `PoE Port 重啟命令發送成功。`);
        res.json({ success: true });
    } catch (error) {
        sysLog('UniFi API', `PoE 重啟失敗: ${error.message}`, true);
        res.status(500).json({ error: error.message });
    }
});

// 8. 觸發測速
app.post('/api/speedtest', async (req, res) => {
    try {
        sysLog('UniFi API', '收到手動觸發 Speedtest 指令。');
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/devmgr', {
            cmd: "speedtest"
        }, { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', '測速指令發送成功，控制器開始測速。');
        res.json({ success: true });
    } catch (error) {
        sysLog('UniFi API', `觸發測速失敗: ${error.message}`, true);
        res.status(500).json({ error: error.message });
    }
});

// 8-1. 查詢測速狀態與結果 (輪詢 stat/health 中 www 子系統的 xput 數據)
app.get('/api/speedtest/status', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/proxy/network/api/s/default/stat/health', { headers: { 'Cookie': cookie } });
        const www = (response.data.data || []).find(s => s.subsystem === 'www') || {};
        res.json({
            status: www.speedtest_status || 'unknown',
            ping: www.speedtest_ping ?? null,
            download: www['xput_down'] ?? null,
            upload: www['xput_up'] ?? null,
            lastRun: www.speedtest_lastrun ? new Date(www.speedtest_lastrun * 1000).toISOString() : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 生產環境備用雲端數據回退快取 (當未配置 API Key 或連線失敗時使用)
const mockSitesFallback = [
    {
        siteId: "default-site-id",
        hostId: "default-host-id",
        meta: {
            desc: "Taipei HQ Office",
            gatewayMac: "70:a7:41:97:83:ed",
            name: "default",
            timezone: "Asia/Taipei"
        },
        statistics: {
            counts: {
                totalDevice: 6,
                offlineDevice: 0,
                wiredClient: 28,
                wifiClient: 45
            },
            ispInfo: {
                name: "Chunghwa Telecom (中華電信)",
                organization: "Data Communication Business Group"
            },
            percentages: {
                wanUptime: 99.98
            }
        },
        permission: "admin",
        isOwner: true
    }
];

const mockDevicesFallback = [
    {
        id: "F4E2C6C23F13",
        mac: "F4E2C6C23F13",
        name: "HQ-Gateway-UCG",
        model: "UCG-Ultra",
        shortname: "UCGULTRA",
        ip: "192.168.1.1",
        status: "online",
        version: "4.1.13",
        productLine: "network"
    },
    {
        id: "F4E2C6C23F14",
        mac: "F4E2C6C23F14",
        name: "Core-Switch-USW-24",
        model: "USW-24-PoE",
        shortname: "USW24POE",
        ip: "192.168.1.2",
        status: "online",
        version: "7.0.50",
        productLine: "network"
    }
];

const mockIspMetricsFallback = {
    latency: 12.4,
    packetLoss: 0.00,
    downloadSpeedMbps: 294.5,
    uploadSpeedMbps: 98.2,
    ispName: "Chunghwa Telecom (中華電信)",
    ipAddress: "220.130.137.169"
};
const mockHostsFallback = [
    {
        id: "default-host-id",
        hardwareId: "e5bf13cd-98a7-5a96-9463-0d65d78cd3a4",
        type: "ucore",
        ipAddress: "220.130.137.169",
        owner: true,
        isBlocked: false,
        registrationTime: "2024-04-16T02:52:54.193Z",
        reportedState: {
            name: "HQ-Gateway-UCG",
            version: "4.1.13",
            state: "connected"
        }
    }
];

const mockSdwanFallback = [
    {
        id: "9304163b-680d-4de8-a7a0-7617e328911d",
        name: "Taipei-to-Hsinchu VPN",
        type: "sdwan-hbsp"
    }
];

// 9. 獲取雲端站點清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/sites', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/sites');
        res.json(response.data);
    } catch (error) {
        res.json({ data: [], source: 'error', error: error.message });
    }
});

// 10. 獲取雲端託管設備清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/devices', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/devices');
        res.json(response.data);
    } catch (error) {
        res.json({ data: [], source: 'error', error: error.message });
    }
});

// 11. 獲取 ISP 效能數據指標 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/isp-metrics', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: null, source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/isp-metrics/5m', { params: { duration: '24h' } });
        if (response.data && response.data.data && response.data.data.length > 0) {
            const metrics = response.data.data[0];
            const periods = metrics.periods || [];
            if (periods.length > 0) {
                const latestPeriod = periods[periods.length - 1];
                const wanData = latestPeriod.data.wan || {};
                return res.json({
                    data: {
                        latency: wanData.avgLatency || 0,
                        packetLoss: wanData.packetLoss || 0,
                        downloadSpeedMbps: wanData.download_kbps ? parseFloat((wanData.download_kbps / 1000).toFixed(1)) : 0,
                        uploadSpeedMbps: wanData.upload_kbps ? parseFloat((wanData.upload_kbps / 1000).toFixed(1)) : 0,
                        ispName: wanData.ispName || 'Unknown ISP',
                        ipAddress: metrics.ipAddress || 'Unknown'
                    },
                    source: 'cloud_api'
                });
            }
        }
        throw new Error('No WAN metrics data returned from Cloud API');
    } catch (error) {
        res.json({ data: null, source: 'error', error: error.message });
    }
});

// 12. 獲取雲端控制台主機清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/hosts', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/hosts');
        res.json(response.data);
    } catch (error) {
        res.json({ data: [], source: 'error', error: error.message });
    }
});

// 13. 獲取 SD-WAN VPN 配置清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/sdwan', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/sd-wan-configs');
        res.json(response.data);
    } catch (error) {
        res.json({ data: [], source: 'error', error: error.message });
    }
});

/* ===================== 資安設定與自動防禦聯動 ===================== */
// 自動防禦 (預設關閉)：偵測到內網設備遭 Malware/Trojan/Botnet/C2 感染事件時，自動 block-sta 斷網隔離。
// 僅隔離「內網受感染設備」(規格 §4.2)，不會改動主控台 IDS/IPS 偵測設定。
const SEC_FILE = path.join(DATA_DIR, 'security-settings.json');
function loadSecSettings() {
    try { return { autoDefense: false, ...JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')) }; } catch { return { autoDefense: false }; }
}
function saveSecSettings(s) {
    try { fs.writeFileSync(SEC_FILE, JSON.stringify(s, null, 2)); } catch { }
}

app.get('/api/security/settings', (req, res) => res.json(loadSecSettings()));
app.post('/api/security/settings', (req, res) => {
    const s = loadSecSettings();
    if (typeof req.body.autoDefense === 'boolean') s.autoDefense = req.body.autoDefense;
    saveSecSettings(s);
    res.json(s);
});

const INFECTION_KEYWORDS = ['MALWARE', 'TROJAN', 'BOTNET', 'CNC', ' C2 ', 'COINMINER', 'RANSOMWARE', 'BACKDOOR'];
const autoBlockedMacs = new Set();

async function autoDefenseSweep() {
    if (!loadSecSettings().autoDefense) return;
    try {
        sysLog('AutoDefense', '啟動自動防禦威脅日誌掃描...');
        const cookie = await getLocalSession();
        const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
        const recent = (alarm.data.data || []).filter(a =>
            isIpsAlarm(a) && Date.now() - new Date(a.datetime).getTime() < 10 * 60 * 1000);
        if (!recent.length) {
            sysLog('AutoDefense', '掃描完成，未偵測到近 10 分鐘內的高危 IPS 威脅。');
            return;
        }
        const sta = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        const clients = sta.data.data || [];
        for (const t of recent) {
            const msg = (t.msg || '').toUpperCase();
            if (!INFECTION_KEYWORDS.some(k => msg.includes(k))) continue;
            const victim = clients.find(c => c.ip === t.dest_ip && !c.blocked);
            if (victim && !autoBlockedMacs.has(victim.mac)) {
                sysLog('AutoDefense', `⚠️ 偵測到重大感染威脅：設備 IP ${t.dest_ip} (${victim.mac}) 觸發「${t.msg}」，即將自動進行網絡物理隔離！`, true);
                await unifiClient.post('/proxy/network/api/s/default/cmd/stamgr', { cmd: 'block-sta', mac: victim.mac }, { headers: { 'Cookie': cookie } });
                autoBlockedMacs.add(victim.mac);
                appendBlockHistory({
                    datetime: new Date().toISOString(),
                    mac: victim.mac,
                    name: victim.name || victim.hostname || 'Unknown Device',
                    action: 'block',
                    source: 'auto',
                    reason: t.msg
                });
                sysLog('AutoDefense', `✅ 已成功對受感染設備 ${victim.mac} 下達 block-sta 斷網隔離命令。`);
            }
        }
    } catch (err) {
        sysLog('AutoDefense', `防禦掃描出錯: ${err.message}，下輪重試。`, true);
    }
}
setInterval(autoDefenseSweep, 30 * 1000);

/* ===================== 通知推播中心 ===================== */
// 偵測到新威脅攔截或 NAS 嚴重警報時，推播到 Discord / Telegram / 通用 Webhook。
const NOTIF_FILE = path.join(DATA_DIR, 'notification-settings.json');
const NOTIF_DEFAULTS = { enabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', triggerThreats: true, triggerNasAlerts: true, triggerWiimTemp: true, triggerUpsOutage: true, triggerUpsLowBatt: true, triggerNewClient: false, triggerWiimOffline: false, triggerBlockAction: true, triggerNasDiskTemp: false, nasDiskTempAlert: 50, triggerNasSpace: false, nasSpaceAlert: 85, triggerUcgTemp: false, ucgTempAlert: 75, triggerWanDown: false, triggerNasLog: true };
function loadNotifSettings() {
    try { return { ...NOTIF_DEFAULTS, ...JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')) }; } catch { return { ...NOTIF_DEFAULTS }; }
}
function saveNotifSettings(s) { try { fs.writeFileSync(NOTIF_FILE, JSON.stringify(s, null, 2)); } catch { } }

let notifLog = [];
function pushNotifLog(e) { notifLog.unshift(e); notifLog = notifLog.slice(0, 50); }

// 實際送出 (依 channel 走不同格式)。回傳 {ok} 或 {ok:false,error}
async function dispatchNotification(title, body, settings) {
    const s = settings || loadNotifSettings();
    const text = `${title}\n${body}`;
    if (s.channel === 'telegram') {
        if (!s.botToken || !s.chatId) throw new Error('Telegram 未設定 botToken / chatId');
        try {
            await axios.post(`https://api.telegram.org/bot${s.botToken}/sendMessage`, { chat_id: s.chatId, text }, { timeout: 8000 });
        } catch (e) {
            const st = e.response && e.response.status;
            const desc = e.response && e.response.data && e.response.data.description;
            if (st === 404) throw new Error('Telegram 回應 404：Bot Token 錯誤 (請向 @BotFather 重新複製完整 token，格式如 123456789:AAxxxx)');
            if (st === 400 && /chat not found/i.test(desc || '')) throw new Error('Telegram：找不到聊天室。Chat ID 必須是數字 (不是 bot 名稱)，且你要先在 Telegram 對這個 bot 送出任一訊息，再按「偵測 Chat ID」');
            throw new Error(`Telegram ${st || ''}: ${desc || e.message}`);
        }
    } else if (s.channel === 'discord') {
        if (!s.webhookUrl) throw new Error('Discord Webhook URL 未設定');
        await axios.post(s.webhookUrl, { content: text }, { timeout: 8000 });
    } else {
        if (!s.webhookUrl) throw new Error('Webhook URL 未設定');
        await axios.post(s.webhookUrl, { title, body, text, ts: new Date().toISOString() }, { timeout: 8000 });
    }
}

// Telegram Chat ID 偵測：讀 bot 的 getUpdates，列出最近跟它說過話的聊天室
app.get('/api/notifications/telegram-chatid', async (req, res) => {
    const s = loadNotifSettings();
    if (!s.botToken) return res.status(400).json({ error: '請先填入 Bot Token 並儲存' });
    try {
        const r = await axios.get(`https://api.telegram.org/bot${s.botToken}/getUpdates`, { timeout: 8000 });
        const chats = {};
        (r.data.result || []).forEach(u => {
            const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
            if (c) chats[c.id] = { id: c.id, name: c.title || c.username || `${c.first_name || ''} ${c.last_name || ''}`.trim() || String(c.id), type: c.type };
        });
        res.json({ chats: Object.values(chats) });
    } catch (e) {
        const st = e.response && e.response.status;
        res.status(500).json({ error: st === 404 ? 'Bot Token 無效 (Telegram 回應 404)，請向 @BotFather 重新複製' : e.message });
    }
});

async function notify(title, body) {
    const s = loadNotifSettings();
    if (!s.enabled) return { skipped: 'disabled' };
    sysLog('Notification', `發送推播通知：主題 "${title}"，頻道: ${s.channel}...`);
    try {
        await dispatchNotification(title, body, s);
        pushNotifLog({ ts: new Date().toISOString(), title, body, channel: s.channel, ok: true });
        sysLog('Notification', '通知推送成功。');
        return { ok: true };
    } catch (e) {
        sysLog('Notification', `通知推送失敗: ${e.message}`, true);
        pushNotifLog({ ts: new Date().toISOString(), title, body, channel: s.channel, ok: false, error: e.message });
        return { ok: false, error: e.message };
    }
}

// GET：回傳設定但遮罩機密 (webhookUrl/botToken 不外洩，改回傳 *Set 布林旗標)
app.get('/api/notifications/settings', (req, res) => {
    const s = loadNotifSettings();
    res.json({
        enabled: s.enabled, channel: s.channel, chatId: s.chatId,
        triggerThreats: s.triggerThreats, triggerNasAlerts: s.triggerNasAlerts, triggerWiimTemp: s.triggerWiimTemp !== false,
        triggerUpsOutage: s.triggerUpsOutage !== false, triggerUpsLowBatt: s.triggerUpsLowBatt !== false,
        triggerNewClient: !!s.triggerNewClient, triggerWiimOffline: !!s.triggerWiimOffline, triggerBlockAction: s.triggerBlockAction !== false,
        triggerNasDiskTemp: !!s.triggerNasDiskTemp, nasDiskTempAlert: s.nasDiskTempAlert ?? 50,
        triggerNasSpace: !!s.triggerNasSpace, nasSpaceAlert: s.nasSpaceAlert ?? 85,
        triggerUcgTemp: !!s.triggerUcgTemp, ucgTempAlert: s.ucgTempAlert ?? 75, triggerWanDown: !!s.triggerWanDown, triggerNasLog: !!s.triggerNasLog,
        webhookUrlSet: !!s.webhookUrl, botTokenSet: !!s.botToken
    });
});

// POST：合併更新。機密欄位留空 = 保留原值 (避免遮罩後被清空)
app.post('/api/notifications/settings', (req, res) => {
    const s = loadNotifSettings();
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') s.enabled = b.enabled;
    if (b.channel) s.channel = b.channel;
    if (typeof b.chatId === 'string') s.chatId = b.chatId;
    if (typeof b.triggerThreats === 'boolean') s.triggerThreats = b.triggerThreats;
    if (typeof b.triggerNasAlerts === 'boolean') s.triggerNasAlerts = b.triggerNasAlerts;
    if (typeof b.triggerWiimTemp === 'boolean') s.triggerWiimTemp = b.triggerWiimTemp;
    ['triggerUpsOutage', 'triggerUpsLowBatt', 'triggerNewClient', 'triggerWiimOffline', 'triggerBlockAction', 'triggerNasDiskTemp', 'triggerNasSpace', 'triggerUcgTemp', 'triggerWanDown', 'triggerNasLog'].forEach(k => { if (typeof b[k] === 'boolean') s[k] = b[k]; });
    ['nasDiskTempAlert', 'nasSpaceAlert', 'ucgTempAlert'].forEach(k => { if (typeof b[k] === 'number' && b[k] > 0) s[k] = b[k]; });
    if (b.webhookUrl) s.webhookUrl = b.webhookUrl;   // 留空不覆寫
    if (b.botToken) s.botToken = b.botToken;
    saveNotifSettings(s);
    res.json({ ok: true });
});

// 測試推播
app.post('/api/notifications/test', async (req, res) => {
    const r = await notify('🔔 SmartHub 測試通知', `這是一則測試訊息，發送時間 ${new Date().toLocaleString('zh-TW')}`);
    res.json(r);
});

// 近期推播紀錄
app.get('/api/notifications/log', (req, res) => res.json({ log: notifLog }));

// 監看器：偵測新威脅 (ips:alert) 與 NAS 嚴重警報，推播並去重
const notifiedThreatIds = new Set();
const notifiedNasAlertIds = new Set();
let notifBootstrapped = false;
async function notificationWatcher() {
    const s = loadNotifSettings();
    if (!s.enabled) return;
    // 新威脅
    if (s.triggerThreats) {
        try {
            const cookie = await getLocalSession();
            const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
            const alerts = (alarm.data.data || []).filter(isIpsAlarm);
            // 首輪只記錄既有事件，避免啟動時一次推播歷史全部
            if (!notifBootstrapped) { alerts.forEach(a => notifiedThreatIds.add(a._id)); }
            else {
                for (const a of alerts) {
                    if (notifiedThreatIds.has(a._id)) continue;
                    notifiedThreatIds.add(a._id);
                    await notify('🛡️ IPS 攔截新威脅', `來源 ${a.src_ip || '?'} (${(a.srcipGeo && a.srcipGeo.country_name) || '未知'})\n${a.msg || ''}`);
                }
            }
        } catch { }
    }
    // NAS 嚴重警報
    if (s.triggerNasAlerts && nasMonConfigured()) {
        try {
            const data = await nasMonGet('/api/alerts/events', { hours: 24 });
            const events = Array.isArray(data) ? data : (data.events || data.data || []);
            for (const e of events) {
                if (e.acknowledged || e.level === 'info') continue;
                if (notifiedNasAlertIds.has(e.id)) continue;
                notifiedNasAlertIds.add(e.id);
                if (notifBootstrapped) await notify('💾 NAS 警報', `[${e.level}] ${e.message || e.metric}`);
            }
        } catch { }
    }
    // WiiM 溫度超標推播 (30 分鐘冷卻，避免洗版)
    if (s.triggerWiimTemp !== false) {
        const last = wiimHistory[wiimHistory.length - 1];
        const cpuA = appSettings.wiimCpuAlert ?? 70, brdA = appSettings.wiimBoardAlert ?? 60;
        if (last && ((last.cpu != null && last.cpu >= cpuA) || (last.board != null && last.board >= brdA))
            && Date.now() - lastWiimTempAlertTs > 30 * 60 * 1000) {
            lastWiimTempAlertTs = Date.now();
            sysLog('Watcher', `WiiM 溫度超標！CPU ${last.cpu}°C / 主機板 ${last.board}°C`, true);
            await notify('🔥 WiiM 溫度警報', `CPU ${last.cpu}°C (門檻 ${cpuA}°C)\n主機板 ${last.board}°C (門檻 ${brdA}°C)`);
        }
    }
    // 新設備加入網路 (預設關閉；首輪只登記既有設備)
    if (s.triggerNewClient) {
        try {
            const cookie = await getLocalSession();
            const sta = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
            for (const c of (sta.data.data || [])) {
                if (knownClientMacs.has(c.mac)) continue;
                knownClientMacs.add(c.mac);
                if (notifBootstrapped) await notify('📱 新設備連上網路', `${c.name || c.hostname || c.mac}\nIP ${c.ip || '(取得中)'} · ${c.is_wired ? '有線' : 'WiFi'}`);
            }
        } catch { }
    }
    // WiiM 離線/恢復 (轉態才通知)
    if (s.triggerWiimOffline) {
        let ok = false;
        try { ok = !!(await wiimGet('getStatusEx')); } catch { ok = false; }
        if (wiimWasOnline !== null && ok !== wiimWasOnline && notifBootstrapped) {
            await notify(ok ? '🔊 WiiM 已恢復連線' : '🔇 WiiM 失去連線', `裝置 IP ${wiimIP}`);
        }
        wiimWasOnline = ok;
    }
    // NAS 硬碟溫度 / 儲存空間門檻 (30 分鐘冷卻)
    if ((s.triggerNasDiskTemp || s.triggerNasSpace) && nasConfigured()) {
        try {
            if (s.triggerNasDiskTemp && Date.now() - lastNasDiskTempTs > 30 * 60 * 1000) {
                const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
                const disks = deepFind({ d: data }, ['result', 'list', 'disks']) || [];
                const hot = disks.filter(d => d.temperature != null && d.temperature >= (s.nasDiskTempAlert ?? 50));
                if (hot.length) {
                    lastNasDiskTempTs = Date.now();
                    await notify('🌡️ NAS 硬碟溫度警報', hot.map(d => `${d.label || d.name} ${d.temperature}°C (門檻 ${s.nasDiskTempAlert ?? 50}°C)`).join('\n'));
                }
            }
            if (s.triggerNasSpace && Date.now() - lastNasSpaceTs > 6 * 60 * 60 * 1000) {
                const data = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
                const vols = deepFind({ d: data }, ['result', 'list', 'volumes']) || [];
                const full = vols.filter(v => v.total && (v.used / v.total * 100) >= (s.nasSpaceAlert ?? 85));
                if (full.length) {
                    lastNasSpaceTs = Date.now();
                    await notify('💾 NAS 儲存空間警報', full.map(v => `${v.label || v.name} 已用 ${Math.round(v.used / v.total * 100)}% (門檻 ${s.nasSpaceAlert ?? 85}%)`).join('\n'));
                }
            }
        } catch { }
    }
    // NAS 系統日誌 — 推播 UGOS 日誌中心所有事件（與前端 NAS 頁「系統日誌與警報」區塊同步）
    if (s.triggerNasLog && nasConfigured()) {
        try {
            const data = await nasGet('/ugreen/v1/log/query', { visualizer: false, page: 0, size: 50, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
            for (const l of (data.log_list || [])) {
                if (notifiedNasLogIds.has(l.log_id)) continue;
                notifiedNasLogIds.add(l.log_id);
                if (!notifBootstrapped) continue;               // 首輪只登記既有事件
                const emoji = { critical: '🚨', error: '❌', warning: '⚠️' }[l.level] || '📋';
                await notify(`${emoji} NAS 日誌 [${l.level}]`, `[${l.module}] ${l.content}`);
            }
            if (notifiedNasLogIds.size > 2000) { // 防無限成長
                const keep = [...notifiedNasLogIds].slice(-1000);
                notifiedNasLogIds.clear(); keep.forEach(x => notifiedNasLogIds.add(x));
            }
        } catch { }
    }
    // UCG CPU 溫度 / WAN 斷線 (透過本機 /api/hardware，僅在開啟時才發起 SSH)
    if ((s.triggerUcgTemp || s.triggerWanDown) && !isPlaceholder(process.env.SSH_PASSWORD)) {
        try {
            const hw = (await axios.get(`http://127.0.0.1:${process.env.PORT || 3000}/api/hardware`, { timeout: 15000 })).data;
            if (s.triggerUcgTemp && hw.cpuTemp != null && hw.cpuTemp >= (s.ucgTempAlert ?? 75)
                && Date.now() - lastUcgTempTs > 30 * 60 * 1000) {
                lastUcgTempTs = Date.now();
                await notify('🔥 UCG-Ultra 溫度警報', `CPU ${hw.cpuTemp}°C (門檻 ${s.ucgTempAlert ?? 75}°C)`);
            }
            if (s.triggerWanDown) {
                const wan = (hw.interfaces || []).find(i => i.name.startsWith('WAN'));
                const wanUp = wan ? wan.status === 'connected' : null;
                if (wanUp !== null && wanWasUp !== null && wanUp !== wanWasUp && notifBootstrapped) {
                    await notify(wanUp ? '🌐 WAN 已恢復連線' : '🚨 WAN 斷線！', wanUp ? '對外網路恢復正常' : '閘道器對外連線中斷，請檢查數據機/ISP');
                }
                if (wanUp !== null) wanWasUp = wanUp;
            }
        } catch { }
    }
    notifBootstrapped = true;
}
let lastNasDiskTempTs = 0, lastNasSpaceTs = 0, lastUcgTempTs = 0, wanWasUp = null;
const knownClientMacs = new Set();
const notifiedNasLogIds = new Set();
let wiimWasOnline = null;
let lastWiimTempAlertTs = 0;

/* ===================== 伺服器端排程 (間隔可於設定頁調整，變更後即時重排) ===================== */
let jobTimers = {};
function scheduleServerJobs() {
    clearInterval(jobTimers.watcher);
    clearInterval(jobTimers.autodef);
    jobTimers.watcher = setInterval(notificationWatcher, Math.max(appSettings.watcherSec, 5) * 1000);
    jobTimers.autodef = setInterval(autoDefenseSweep, Math.max(appSettings.autoDefenseSec, 5) * 1000);
}

/* ===================== 歷史趨勢取樣器 (自適應頻率) ===================== */
// 記錄一筆：客戶端數、24h 威脅數、ISP 延遲。保留上限 9999 筆，持久化於 trend-history.json。
// 取樣頻率隨「是否有人正在看網頁」自動切換 (間隔取自 appSettings，可於設定頁調整)。
const TREND_FILE = path.join(DATA_DIR, 'trend-history.json');
const TREND_LIMIT = 9999;

let lastClientActivity = 0;              // 前端最後一次活動時間戳
let lastSampleTs = 0;                    // 上一次取樣時間戳
let lastSchedulerState = null;           // 前端最後一狀態 (活躍/閒置)
function markClientActivity() { lastClientActivity = Date.now(); }

function loadTrends() {
    try { return JSON.parse(fs.readFileSync(TREND_FILE, 'utf8')); } catch { return []; }
}

async function sampleTrends() {
    const point = { t: new Date().toISOString(), clients: null, threats24h: null, latency: null };
    try {
        const cookie = await getLocalSession();
        const sta = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        point.clients = (sta.data.data || []).length;
        const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
        const dayAgo = Date.now() - 86400000;
        point.threats24h = (alarm.data.data || []).filter(a => isIpsAlarm(a) && new Date(a.datetime).getTime() >= dayAgo).length;
    } catch { /* 本地控制器不可用時該欄位保留 null */ }
    try {
        if (process.env.UNIFI_API_KEY && !process.env.UNIFI_API_KEY.includes('your_unifi')) {
            const r = await unifiCloudClient.get('/isp-metrics/5m', { params: { duration: '24h' } });
            const periods = (r.data && r.data.data && r.data.data[0] && r.data.data[0].periods) || [];
            if (periods.length) point.latency = (periods[periods.length - 1].data.wan || {}).avgLatency ?? null;
        }
    } catch { }
    if (point.clients === null && point.threats24h === null && point.latency === null) return;
    const trends = loadTrends();
    trends.push(point);
    try { fs.writeFileSync(TREND_FILE, JSON.stringify(trends.slice(-TREND_LIMIT))); } catch { }
}

// 排程器：每秒檢查一次，依活躍/閒置狀態與設定的間隔決定是否該取樣
async function trendScheduler() {
    const now = Date.now();
    const active = (now - lastClientActivity) < appSettings.activeWindowSec * 1000;
    const stateStr = active ? 'Active (活躍模式)' : 'Idle (閒置模式)';
    if (stateStr !== lastSchedulerState) {
        sysLog('Scheduler', `取樣頻率切換至：${stateStr}。取樣間隔：${active ? appSettings.trendActiveSec : appSettings.trendIdleSec} 秒`);
        lastSchedulerState = stateStr;
    }
    const gap = (active ? appSettings.trendActiveSec : appSettings.trendIdleSec) * 1000;
    if (now - lastSampleTs >= gap) {
        lastSampleTs = now;
        sysLog('Scheduler', '開始執行趨勢遙測資料取樣...');
        await sampleTrends();
        sysLog('Scheduler', '趨勢遙測資料取樣完成。');
    }
}
setInterval(trendScheduler, 1000);
trendScheduler();
scheduleServerJobs();

// 14. 歷史趨勢查詢 (?hours=24 / 168)。任何前端讀取都視為「活躍」，觸發高頻取樣。
app.get('/api/history', (req, res) => {
    markClientActivity();
    const hours = parseInt(req.query.hours || '24', 10);
    const cutoff = Date.now() - hours * 3600000;
    res.json({ history: loadTrends().filter(p => new Date(p.t).getTime() >= cutoff) });
});

// 輕量心跳端點：前端開著頁面時定時呼叫，維持「活躍」狀態 (不觸發任何上游 API)
app.get('/api/heartbeat', (req, res) => {
    markClientActivity();
    res.json({ ok: true, mode: 'active' });
});

/* ===================== UGREEN NAS (UGOS Pro 原生 API) ===================== */
// 認證流程：GET rsa_public_key → RSA PKCS1v15 加密密碼 → POST login 取 token (掛在 query ?token=)
const crypto = require('crypto');
function buildNasClient() {
    const base = process.env.NAS_HOST
        ? `${process.env.NAS_SCHEME || 'https'}://${process.env.NAS_HOST}:${process.env.NAS_PORT || '9443'}`
        : null;
    return {
        base,
        client: base ? axios.create({
            baseURL: base,
            headers: { 'ug-agent': 'PC/WEB', 'Accept': 'application/json' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 10000
        }) : null
    };
}
let { base: NAS_BASE, client: nasClient } = buildNasClient();

function nasConfigured() {
    return !!(NAS_BASE && process.env.NAS_USER && process.env.NAS_PASSWORD)
        && !isPlaceholder(process.env.NAS_PASSWORD);
}

// 在未知巢狀結構中依鍵名尋找值 (UGOS 回應包裝層級不固定)
function deepFind(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return undefined;
    for (const k of Object.keys(obj)) {
        if (keys.includes(k)) return obj[k];
    }
    for (const k of Object.keys(obj)) {
        const r = deepFind(obj[k], keys, depth + 1);
        if (r !== undefined) return r;
    }
    return undefined;
}

let nasToken = '', nasTokenExpiry = 0;
async function getNasToken() {
    const now = Date.now();
    if (nasToken && now < nasTokenExpiry) {
        sysLog('NAS Auth', '使用快取的 UGREEN NAS JWT Token。');
        return nasToken;
    }
    try {
        sysLog('NAS Auth', '開始進行 UGREEN NAS RSA 登入認證流程 (UGOS Pro)...');
        // UGOS Pro (>=1.1x)：POST /verify/check，RSA 公鑰放在回應標頭 x-rsa-token (base64 DER)
        let keyObj = null;
        try {
            const chk = await nasClient.post('/ugreen/v1/verify/check?token=', { username: process.env.NAS_USER });
            const hdr = chk.headers['x-rsa-token'] || '';
            if (hdr) {
                // 標頭是 base64 的 PEM；注意 UGOS 的 PEM 標籤寫 "RSA PUBLIC KEY" 但內容其實是 SPKI 格式 (標籤誤植)
                const pem = Buffer.from(hdr, 'base64').toString('utf8');
                const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
                try { keyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
                catch { keyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' }); }
            }
        } catch (e) { sysLog('NAS Auth', `verify/check 失敗 (${e.message})，改試舊版端點`, false); }
        if (!keyObj) {
            // 舊版 UGOS：GET /verify/rsa_public_key 直接回 PEM
            const pkRes = await nasClient.get('/ugreen/v1/verify/rsa_public_key');
            const publicKey = deepFind(pkRes.data, ['public_key', 'publicKey', 'rsa_public_key', 'key']);
            if (!publicKey || !String(publicKey).includes('KEY')) throw new Error('取不到 NAS RSA 公鑰 (新舊端點皆失敗)');
            keyObj = crypto.createPublicKey(publicKey);
        }

        const encrypted = crypto.publicEncrypt(
            { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(process.env.NAS_PASSWORD)
        ).toString('base64');

        const loginRes = await nasClient.post('/ugreen/v1/verify/login', {
            is_simple: true, keepalive: true, otp: false,
            username: process.env.NAS_USER,
            password: encrypted
        });
        if (loginRes.data && loginRes.data.code && loginRes.data.code !== 200) {
            throw new Error(`NAS 登入被拒 (code ${loginRes.data.code}): ${loginRes.data.msg || loginRes.data.debug || '帳號或密碼錯誤'}`);
        }
        const token = deepFind(loginRes.data, ['token', 'access_token']);
        if (!token) throw new Error('NAS login did not return a token');

        nasToken = token;
        nasTokenExpiry = now + 12 * 60 * 60 * 1000; // Token 官方效期 24H，保守 12H 換發
        sysLog('NAS Auth', 'NAS 登入成功，快取 JWT Token (12小時)。');
        return nasToken;
    } catch (error) {
        sysLog('NAS Auth', `NAS 登入流程失敗: ${error.message}`, true);
        throw error;
    }
}

async function nasGet(pathName, params = {}) {
    const token = await getNasToken();
    const r = await nasClient.get(pathName, { params: { ...params, token } });
    // UGOS 一律回 HTTP 200，錯誤放在 body.code (1004/1008 = 權限不足，需管理員帳號)
    if (r.data && typeof r.data.code === 'number' && r.data.code !== 200) {
        const permErr = [1004, 1008].includes(r.data.code);
        throw new Error(permErr
            ? `NAS 帳號權限不足 (code ${r.data.code})：此 API 僅限管理員帳號，請在 UGOS 將使用者設為管理員或改用管理員帳密`
            : `UGOS code ${r.data.code}: ${r.data.msg || r.data.debug || ''}`);
    }
    return r.data && r.data.data !== undefined ? r.data.data : r.data;
}

// NAS 展示用回退資料 (未設定 NAS_HOST/NAS_USER/NAS_PASSWORD 或連線失敗時)
const mockNasOverview = {
    info: { model: 'UGREEN DXP4800 Plus', firmware_version: 'UGOS Pro 1.4.0.2333', cpu_model: 'Intel N100 (4C/4T)', device_name: 'UGREEN-NAS-HQ' },
    stats: {
        cpu: { usage: 11, temperature: 43 },
        memory: { usage: 38, total_mb: 8192, used_mb: 3112 },
        network: { upload_bps: 2621440, download_bps: 10485760 }
    }
};
const mockNasDisks = [
    { slot: 1, name: 'WD Red Plus 4TB', model: 'WD40EFPX', temperature: 38, status: 'Good', size_gb: 4000 },
    { slot: 2, name: 'WD Red Plus 4TB', model: 'WD40EFPX', temperature: 39, status: 'Good', size_gb: 4000 },
    { slot: 3, name: 'Seagate IronWolf 8TB', model: 'ST8000VN004', temperature: 41, status: 'Good', size_gb: 8000 }
];
const mockNasVolumes = [
    { name: '存儲空間 1', fs: 'Btrfs', raid: 'RAID 5', total_gb: 7451, used_gb: 3120, status: 'normal' }
];
const mockNasUps = { present: true, model: 'APC Back-UPS 700VA', battery_percent: 100, runtime_min: 42, status: 'online' };

// 15. NAS 總覽 (硬體資訊 + 即時遙測 taskmgr/stat/get_all)
app.get('/api/nas/overview', async (req, res) => {
    if (!nasConfigured()) return res.json({ info: null, stats: null, source: 'not_configured' });
    try {
        const info = await nasGet('/ugreen/v1/sysinfo/machine/common');
        // 遙測 (taskmgr) 需管理員權限；一般帳號拿不到就只給機型資訊，不整卡報錯
        let statsRaw = null, statsError = null;
        try { statsRaw = await nasGet('/ugreen/v1/taskmgr/stat/get_all'); } catch (e) { statsError = e.message; }
        // UGOS 1.17 實機格式：cpu/mem/net 都包在 series[] 裡，這裡攤平成前端好讀的形狀
        let stats = statsRaw;
        try {
            if (statsRaw && statsRaw.cpu && Array.isArray(statsRaw.cpu.series)) {
                const c = statsRaw.cpu.series[0] || {};
                const m = (statsRaw.mem && statsRaw.mem.series && statsRaw.mem.series[0]) || {};
                const ms = (statsRaw.mem && statsRaw.mem.structure) || {};
                const netOv = ((statsRaw.net && statsRaw.net.series) || []).find(n => n.name === 'overview') || {};
                stats = {
                    cpu: { usage: c.used_percent ?? null, temperature: c.temp ?? null },
                    memory: {
                        usage: m.used_percent != null ? +(+m.used_percent).toFixed(1) : null,
                        total_mb: ms.total ? Math.round(ms.total / 1048576) : null,
                        used_mb: ms.used ? Math.round(ms.used / 1048576) : null
                    },
                    network: { upload_bps: (netOv.send_rate ?? 0) * 8, download_bps: (netOv.recv_rate ?? 0) * 8 }
                };
            }
        } catch { }
        // 從 get_all 的 disk series 取出每顆硬碟的即時溫度/運轉狀態 (免喚醒)，供前端硬碟卡使用，
        // 讓前端不必再輪詢會喚醒硬碟的 disk/list。
        let disksLite = [];
        try {
            disksLite = ((statsRaw && statsRaw.disk && statsRaw.disk.series) || [])
                .filter(d => d.name !== 'overview')
                .map(d => ({ name: d.label || d.name, temperature: d.activate ? d.temperature : null, sleeping: !d.activate }));
        } catch { }
        res.json({ info, stats, disksLite, statsRaw, statsError, source: 'nas_api' });
    } catch (error) {
        res.json({ info: null, stats: null, source: 'error', error: error.message });
    }
});

// 16. NAS 實體硬碟清單 (含溫度與健康狀態)
app.get('/api/nas/disks', async (req, res) => {
    if (!nasConfigured()) return res.json({ disks: [], source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
        let disks = deepFind({ d: data }, ['result', 'list', 'disks']) || (Array.isArray(data) ? data : []);
        // UGOS 1.17 實機：status 為數字 (1=健康)、size 為 bytes、顯示名稱在 label (硬碟1...)
        disks = disks.map(d => ({
            ...d,
            name: d.label || d.name,
            status: d.status === 1 ? 'good' : (typeof d.status === 'number' ? `abnormal(${d.status})` : d.status),
            size_gb: d.size ? Math.round(d.size / 1e9) : d.size_gb,
            // 休眠/運轉狀態：is_standby 或 activate===false 皆視為休眠中
            sleeping: d.is_standby === true || d.activate === false
        }));
        res.json({ disks, source: 'nas_api' });
    } catch (error) {
        res.json({ disks: [], source: 'error', error: error.message });
    }
});

// 16-1. 單顆硬碟 SMART 詳情 (UGOS 端點需要 disk=/dev/<dev_name>)
app.get('/api/nas/disk-smart', async (req, res) => {
    if (!nasConfigured()) return res.status(503).json({ error: 'nas_not_configured' });
    const dev = req.query.dev; // 前端傳 dev_name，例如 sdb / nvme0n1
    if (!dev) return res.status(400).json({ error: 'missing dev' });
    try {
        const diskPath = dev.startsWith('/dev/') ? dev : `/dev/${dev}`;
        const data = await nasGet('/ugreen/v1/storage/disk/smart/info', { disk: diskPath });
        res.json({ smart: data, source: 'nas_api' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 16-2. UGOS 日誌中心 (login/storage/snapshot 等系統事件)
app.get('/api/nas/logs', async (req, res) => {
    if (!nasConfigured()) return res.json({ logs: [], total: 0, source: 'not_configured' });
    try {
        const page = parseInt(req.query.page || '0', 10);
        const size = Math.min(parseInt(req.query.size || '50', 10), 200);
        const data = await nasGet('/ugreen/v1/log/query', {
            visualizer: false, page, size, order: 'down', log_type: 0,
            from_time: '', to_time: '', order_param: '', log_id: ''
        });
        let logs = (data.log_list || []).map(l => ({
            id: l.log_id, level: l.level, module: l.module, operator: l.operator,
            content: l.content, ts: l.create_time * 1000
        }));
        // hideSelf=1：過濾本站監控帳號的例行登入 (避免 log 被自己洗版)
        if (req.query.hideSelf === '1') {
            const selfUser = process.env.NAS_USER;
            logs = logs.filter(l => !(l.module === 'login' && l.operator === selfUser && /logged in successfully/.test(l.content)));
        }
        res.json({ logs, total: data.total ?? logs.length, source: 'nas_api' });
    } catch (error) {
        res.status(500).json({ logs: [], error: error.message });
    }
});

// 16-3. 硬碟休眠統計 — 解析 UGOS 日誌中心的 sleeping 事件，算出每顆機械碟每天的休眠時數/次數/平均/喚醒時間
app.get('/api/nas/sleep-stats', async (req, res) => {
    if (!nasConfigured()) return res.json({ days: [], source: 'not_configured' });
    try {
        const pages = Math.min(parseInt(req.query.pages || '10', 10), 20);
        let all = [];
        for (let p = 0; p < pages; p++) {
            const data = await nasGet('/ugreen/v1/log/query', { visualizer: false, page: p, size: 200, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
            const lst = data.log_list || [];
            all = all.concat(lst);
            if (lst.length < 200) break;
        }
        // 取出 sleeping 事件（時間升冪），配對 sleep→wake
        const sw = all.filter(l => /sleeping/i.test(l.content))
            .map(l => ({ t: l.create_time, drive: (l.content.match(/Hard Drive (\d+)/) || [])[1], action: /stopped/i.test(l.content) ? 'wake' : 'sleep' }))
            .filter(e => e.drive).sort((a, b) => a.t - b.t);
        const open = {};   // drive → 開始休眠的 epoch
        const byDay = {};  // 'YYYY/M/D' → { driveN: { sec, n } }
        const wakeEvents = {}; // day → [{drive, t}]
        const dayKey = ts => new Date(ts * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
        const ensure = (d, drv) => { byDay[d] = byDay[d] || {}; byDay[d][drv] = byDay[d][drv] || { sec: 0, n: 0, longest: 0 }; return byDay[d][drv]; };
        for (const e of sw) {
            if (e.action === 'sleep') open[e.drive] = e.t;
            else if (e.action === 'wake') {
                const day = dayKey(e.t);
                (wakeEvents[day] = wakeEvents[day] || []).push({ drive: '硬碟' + e.drive, t: e.t * 1000 });
                if (open[e.drive]) {
                    const start = open[e.drive], end = e.t, drv = '硬碟' + e.drive, totalDur = end - start;
                    // 跨日的休眠時段按日切分，讓每天的休眠時數 ≤ 24h、比例 ≤ 100%
                    let cur = start;
                    while (cur < end) {
                        const midnight = new Date(cur * 1000); midnight.setHours(24, 0, 0, 0);
                        const segEnd = Math.min(end, Math.floor(midnight.getTime() / 1000));
                        const seg = segEnd - cur, rec = ensure(dayKey(cur), drv);
                        rec.sec += seg;
                        cur = segEnd;
                    }
                    // 「次數」與「最長單次」記在開始日
                    const rec0 = ensure(dayKey(start), drv);
                    rec0.n++; rec0.longest = Math.max(rec0.longest, totalDur);
                    open[e.drive] = null;
                }
            }
        }
        const days = Object.keys(byDay).sort().reverse().slice(0, 14).map(day => ({
            day,
            drives: Object.entries(byDay[day]).map(([name, v]) => ({
                name, sleepHours: +(v.sec / 3600).toFixed(1), sessions: v.n,
                avgMin: v.n ? Math.round(v.sec / v.n / 60) : 0,
                longestMin: Math.round(v.longest / 60),
                sleepPct: Math.min(100, Math.round(v.sec / 86400 * 100))
            })).sort((a, b) => a.name.localeCompare(b.name)),
            wakes: (wakeEvents[day] || []).map(w => ({ drive: w.drive, time: new Date(w.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) }))
        }));
        res.json({ days, source: 'nas_api' });
    } catch (error) {
        res.status(500).json({ days: [], error: error.message });
    }
});

// 17. NAS 邏輯儲存區清單 (回應包裝於 data.result)
app.get('/api/nas/volumes', async (req, res) => {
    if (!nasConfigured()) return res.json({ volumes: [], source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
        let volumes = deepFind({ d: data }, ['result', 'list', 'volumes']) || (Array.isArray(data) ? data : []);
        // UGOS 1.17 實機：total/used 為 bytes、health 0 = 正常、顯示名稱在 label (儲存空間1...)
        volumes = volumes.map(v => ({
            ...v,
            name: v.label || v.name,
            used_gb: v.used != null ? Math.round(v.used / 1073741824) : v.used_gb,
            total_gb: v.total != null ? Math.round(v.total / 1073741824) : v.total_gb,
            status: (v.health === 0 || v.status === 0) ? 'normal' : `warning(${v.health ?? v.status})`
        }));
        res.json({ volumes, source: 'nas_api' });
    } catch (error) {
        res.json({ volumes: [], source: 'error', error: error.message });
    }
});

// 18. NAS UPS 狀態
app.get('/api/nas/ups', async (req, res) => {
    if (!nasConfigured()) return res.json({ ups: null, source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/config');
        res.json({ ups: data, source: 'nas_api' });
    } catch (error) {
        res.json({ ups: null, source: 'error', error: error.message });
    }
});

// 18-1. NAS UPS USB 快速存在性檢查 (系統 A)
app.get('/api/nas/ups-usb', async (req, res) => {
    if (!nasConfigured()) return res.json({ present: null, source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/usb/info');
        res.json({ data, source: 'nas_api' });
    } catch (error) {
        res.json({ present: null, source: 'error', error: error.message });
    }
});

/* ===================== NAS 歷史自建取樣器 =====================
   UGOS 沒有提供歷史 API (只有即時快照 get_all)，這裡自己定期取樣 get_all + volume/list 並持久化，
   讓「系統負載 / 網路流量 / 散熱 / 儲存趨勢」四張圖有真實歷史可畫，不需要另外部署 NAS Monitor (系統 B)。 */
const NAS_HISTORY_FILE = path.join(DATA_DIR, 'nas-history.json');
const NAS_HISTORY_LIMIT = 6000;   // 60 秒間隔 ≈ 4 天
let nasHistory = (() => { try { return JSON.parse(fs.readFileSync(NAS_HISTORY_FILE, 'utf8')); } catch { return []; } })();
let lastNasSampleTs = 0;

async function sampleNasHistory() {
    if (!nasConfigured()) return;
    try {
        const raw = await nasGet('/ugreen/v1/taskmgr/stat/get_all');
        if (!raw || !raw.cpu) return;
        const cpu = (raw.cpu.series && raw.cpu.series[0]) || {};
        const mem = (raw.mem && raw.mem.series && raw.mem.series[0]) || {};
        const netOv = ((raw.net && raw.net.series) || []).find(n => n.name === 'overview') || {};
        // 只在硬碟「運轉中(activate)」時記錄溫度；休眠中的碟記為 null (斷點) —
        // 這樣歷史圖能忠實顯示休眠區段，也證明我們不會為了測溫而喚醒硬碟。
        const diskTemps = {};
        ((raw.disk && raw.disk.series) || []).filter(d => d.name !== 'overview').forEach(d => {
            diskTemps[d.label || d.name] = (d.activate && d.temperature != null) ? d.temperature : null;
        });
        // 容量：另外讀 volume/list 加總 (get_all 的 used_percent 常為 0)
        let volUsedGb = null, volTotalGb = null;
        try {
            const vdata = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
            const vols = (deepFind({ d: vdata }, ['result', 'list', 'volumes']) || []).filter(v => v.total);
            if (vols.length) {
                volUsedGb = Math.round(vols.reduce((a, v) => a + (v.used || 0), 0) / 1073741824);
                volTotalGb = Math.round(vols.reduce((a, v) => a + (v.total || 0), 0) / 1073741824);
            }
        } catch { }
        nasHistory.push({
            t: new Date().toISOString(),
            cpu: cpu.used_percent != null ? Math.round(cpu.used_percent) : null,
            memory: mem.used_percent != null ? Math.round(mem.used_percent) : null,
            temperature: cpu.temp ?? null,
            up_mbps: +(((netOv.send_rate || 0) * 8 / 1e6).toFixed(2)),
            down_mbps: +(((netOv.recv_rate || 0) * 8 / 1e6).toFixed(2)),
            disks: diskTemps,
            used_gb: volUsedGb, total_gb: volTotalGb
        });
        if (nasHistory.length > NAS_HISTORY_LIMIT) nasHistory = nasHistory.slice(-NAS_HISTORY_LIMIT);
        try { fs.writeFileSync(NAS_HISTORY_FILE, JSON.stringify(nasHistory)); } catch { }
    } catch (e) { sysLog('NAS History', `取樣失敗: ${e.message}`, false); }
}
// 自適應：有人看網頁時每 60 秒、閒置時每 10 分鐘 (歷史圖不需要太密)
setInterval(() => {
    const active = (Date.now() - lastClientActivity) < appSettings.activeWindowSec * 1000;
    const gap = (active ? 60 : 600) * 1000;
    if (Date.now() - lastNasSampleTs >= gap) { lastNasSampleTs = Date.now(); sampleNasHistory(); }
}, 5000);

function nasHistorySince(hours) {
    const cutoff = Date.now() - hours * 3600000;
    return nasHistory.filter(p => new Date(p.t).getTime() >= cutoff);
}

/* ===================== NAS Monitor 擴充 REST API (系統 B / nas-monitor-interface) ===================== */
// 選填：若另外部署了 nas-monitor-interface (Flask 中介層)，設定 NAS_MONITOR_URL + NAS_MONITOR_API_KEY 即可
// 取得 Docker 管理、流量/儲存/溫度歷史、儲存滿載預測、警報等進階功能。未設定時全部回退展示資料。
function buildNasMonClient() {
    const url = process.env.NAS_MONITOR_URL || null;
    const key = process.env.NAS_MONITOR_API_KEY || '';
    return {
        url,
        client: url ? axios.create({
            baseURL: url.replace(/\/$/, ''),
            headers: { 'Accept': 'application/json', 'X-API-Key': key, 'Authorization': `Bearer ${key}` },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 12000
        }) : null
    };
}
let { url: NASMON_URL, client: nasMonClient } = buildNasMonClient();
function nasMonConfigured() { return !!NASMON_URL; }
async function nasMonGet(p, params) { const r = await nasMonClient.get(p, { params }); return r.data; }

// ---- 系統 B 展示用假資料產生器 ----
function synthSeries(hours, stepMin, gen) {
    const arr = [], now = Date.now(), step = stepMin * 60000, n = Math.floor(hours * 60 / stepMin);
    for (let i = n; i >= 0; i--) arr.push(gen(new Date(now - i * step), i));
    return arr;
}
const mockDockerContainers = [
    { id: 'a1b2c3d4e5f6', name: 'jellyfin', image: 'jellyfin/jellyfin:latest', state: 'running', status: 'Up 3 days', cpu_percent: 4.2, mem_usage_mb: 512, mem_limit_mb: 2048 },
    { id: 'b2c3d4e5f6a1', name: 'qbittorrent', image: 'linuxserver/qbittorrent', state: 'running', status: 'Up 3 days', cpu_percent: 1.1, mem_usage_mb: 210, mem_limit_mb: 1024 },
    { id: 'c3d4e5f6a1b2', name: 'homeassistant', image: 'homeassistant/home-assistant', state: 'running', status: 'Up 5 days', cpu_percent: 2.8, mem_usage_mb: 380, mem_limit_mb: 1024 },
    { id: 'd4e5f6a1b2c3', name: 'nginx-proxy-manager', image: 'jc21/nginx-proxy-manager', state: 'running', status: 'Up 5 days', cpu_percent: 0.3, mem_usage_mb: 96, mem_limit_mb: 512 },
    { id: 'e5f6a1b2c3d4', name: 'immich-server', image: 'ghcr.io/immich-app/immich', state: 'exited', status: 'Exited (0) 2 hours ago', cpu_percent: 0, mem_usage_mb: 0, mem_limit_mb: 2048 }
];
const mockAlertEvents = [
    { id: 'al-1', datetime: new Date(Date.now() - 3600000).toISOString(), metric: 'disk_temperature', level: 'warning', message: 'Seagate IronWolf 8TB 溫度達 48°C (閾值 45°C)', acknowledged: false },
    { id: 'al-2', datetime: new Date(Date.now() - 6 * 3600000).toISOString(), metric: 'cpu_usage', level: 'info', message: 'CPU 使用率短暫達 82% (備份任務)', acknowledged: true },
    { id: 'al-3', datetime: new Date(Date.now() - 26 * 3600000).toISOString(), metric: 'volume_usage', level: 'critical', message: '存儲空間 1 使用率超過 85%', acknowledged: false }
];
function mockTrafficHistory(hours) {
    return synthSeries(hours, 30, (d) => {
        const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5;
        return { t: d.toISOString(), upload_mbps: +(2 + f * 12 + Math.random() * 3).toFixed(1), download_mbps: +(5 + f * 40 + Math.random() * 8).toFixed(1) };
    });
}
function mockSystemHistory(hours) {
    return synthSeries(hours, 30, (d) => {
        const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5;
        return { t: d.toISOString(), cpu: Math.round(8 + f * 30 + Math.random() * 6), memory: Math.round(34 + f * 10 + Math.random() * 4), temperature: Math.round(40 + f * 6 + Math.random() * 2) };
    });
}
function mockTemperatureHistory(hours) {
    return synthSeries(hours, 30, (d) => {
        const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5;
        return { t: d.toISOString(), fan_rpm: Math.round(900 + f * 500), disk1: Math.round(36 + f * 4), disk2: Math.round(37 + f * 4), disk3: Math.round(39 + f * 5) };
    });
}
function mockStorageHistory(hours) {
    const base = 3120, n = Math.floor(hours / 24);
    return synthSeries(hours, 720, (d, i) => ({ t: d.toISOString(), used_gb: Math.round(base - (i) * 6 + Math.random() * 4), total_gb: 7451 }));
}

// 通用代理：優先呼叫系統 B，失敗或未設定時回退 fallback
async function nasMonProxy(res, path, params, fallback) {
    // 誠實模式：未設定就回空殼 (保留欄位結構、陣列清空)，絕不回傳模擬數據
    const emptyLike = v => Array.isArray(v) ? [] : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyLike(x)])) : null);
    if (!nasMonConfigured()) return res.json({ ...emptyLike(fallback), source: 'not_configured' });
    try {
        const data = await nasMonGet(path, params);
        res.json({ data, source: 'nas_monitor' });
    } catch (error) {
        res.json({ ...emptyLike(fallback), source: 'error', error: error.message });
    }
}

// 19. Docker 容器清單 (含即時 CPU/RAM)
app.get('/api/nas/docker', async (req, res) => {
    if (!nasMonConfigured()) return res.json({ containers: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/docker/containers');
        res.json({ containers: Array.isArray(data) ? data : (data.containers || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        res.json({ containers: [], source: 'error', error: error.message });
    }
});

// 20. Docker 容器操作 (start / stop / restart)
app.post('/api/nas/docker/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!nasMonConfigured()) return res.status(503).json({ success: false, error: 'nas_monitor_not_configured', source: 'not_configured' });
    try {
        const r = await nasMonClient.post(`/api/docker/containers/${id}/${action}`);
        res.json({ success: true, data: r.data, source: 'nas_monitor' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 21. Docker 容器日誌
app.get('/api/nas/docker/:id/logs', async (req, res) => {
    if (!nasMonConfigured()) {
        return res.json({ logs: '', source: 'not_configured' });
    }
    try {
        const data = await nasMonGet(`/api/docker/containers/${req.params.id}/logs`, { lines: req.query.lines || 200 });
        res.json({ logs: typeof data === 'string' ? data : (data.logs || JSON.stringify(data)), source: 'nas_monitor' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 22. 流量統計 (今日 / 本週 / 本月聚合)
app.get('/api/nas/traffic-summary', (req, res) => nasMonProxy(res, '/api/traffic/summary', {},
    { data: { today_gb: 42.6, week_gb: 318.2, month_gb: 1240.7, today_up_gb: 8.1, today_down_gb: 34.5 } }));

// 23. 流量歷史 — 優先系統 B；否則用自建 NAS 取樣歷史
app.get('/api/nas/traffic-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    if (nasMonConfigured()) return nasMonProxy(res, '/api/traffic/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, upload_mbps: p.up_mbps, download_mbps: p.down_mbps }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 24. 系統歷史 (CPU / 記憶體 / 溫度)
app.get('/api/nas/system-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    if (nasMonConfigured()) return nasMonProxy(res, '/api/system/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, cpu: p.cpu, memory: p.memory, temperature: p.temperature }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 25. 溫度歷史 (各硬碟溫度；此機型 API 無風扇轉速)
app.get('/api/nas/temperature-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    if (nasMonConfigured()) return nasMonProxy(res, '/api/temperature/history', { hours }, { data: [] });
    const pts = nasHistorySince(hours);
    // 收集所有出現過的硬碟名稱，供前端動態畫線
    const diskNames = [...new Set(pts.flatMap(p => Object.keys(p.disks || {})))];
    const data = pts.map(p => ({ t: p.t, disks: p.disks || {} }));
    res.json({ data, diskNames, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 26. 儲存容量歷史
app.get('/api/nas/storage-history', (req, res) => {
    const hours = parseInt(req.query.hours || '720', 10);
    if (nasMonConfigured()) return nasMonProxy(res, '/api/storage/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).filter(p => p.used_gb != null).map(p => ({ t: p.t, used_gb: p.used_gb, total_gb: p.total_gb }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 27. 儲存滿載預測 (線性迴歸估算剩餘天數)
app.get('/api/nas/storage-forecast', (req, res) => {
    const days = parseInt(req.query.days || '30', 10);
    nasMonProxy(res, '/api/storage/forecast', { days },
        { data: { days_until_full: 512, daily_growth_gb: 6.2, projected_full_date: new Date(Date.now() + 512 * 86400000).toISOString().slice(0, 10), current_used_percent: 42 } });
});

// 28. 正常運行時間 / 離線事件
app.get('/api/nas/downtime', (req, res) => {
    const days = parseInt(req.query.days || '30', 10);
    nasMonProxy(res, '/api/downtime', { days },
        { data: { uptime_percent: 99.97, downtime_events: 1, last_downtime: new Date(Date.now() - 12 * 86400000).toISOString(), total_downtime_min: 13 } });
});

// 29. 警報事件
app.get('/api/nas/alerts', async (req, res) => {
    if (!nasMonConfigured()) return res.json({ events: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/alerts/events', { hours: req.query.hours || 24 });
        res.json({ events: Array.isArray(data) ? data : (data.events || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        res.json({ events: [], source: 'error', error: error.message });
    }
});

// 30. 確認 (清除) 警報
app.post('/api/nas/alerts/:id/ack', async (req, res) => {
    if (!nasMonConfigured()) {
        return res.status(503).json({ success: false, error: 'nas_monitor_not_configured', source: 'not_configured' });
    }
    try {
        await nasMonClient.post(`/api/alerts/events/${req.params.id}/acknowledge`);
        res.json({ success: true, source: 'nas_monitor' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/* ===================== 應用程式設定 API ===================== */
app.get('/api/settings', (req, res) => res.json(appSettings));
app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    ['trendActiveSec', 'trendIdleSec', 'activeWindowSec', 'watcherSec', 'autoDefenseSec', 'reportHour', 'upsSampleSec', 'wiimCpuAlert', 'wiimBoardAlert', 'toastSec'].forEach(k => {
        if (typeof b[k] === 'number' && b[k] >= 0) appSettings[k] = b[k];
    });
    if (typeof b.reportEnabled === 'boolean') appSettings.reportEnabled = b.reportEnabled;
    if (b.reportFreq === 'daily' || b.reportFreq === 'weekly') appSettings.reportFreq = b.reportFreq;
    saveAppSettings();
    scheduleServerJobs();   // 立即套用新的伺服器端間隔
    res.json({ ok: true, settings: appSettings });
});

/* ===================== 連線設定 (網頁直接改 .env，熱重建免重啟) ===================== */
const ENV_FILE = path.join(__dirname, '.env');
// 允許透過設定頁修改的欄位 (secret: GET 時只回「是否已設定」)
const CONN_FIELDS = [
    { key: 'UCG_IP' }, { key: 'SSH_PORT' }, { key: 'SSH_USER' }, { key: 'SSH_PASSWORD', secret: true }, { key: 'WAN_IFACE' },
    { key: 'UNIFI_CONTROLLER_URL' }, { key: 'UNIFI_USERNAME' }, { key: 'UNIFI_PASSWORD', secret: true },
    { key: 'UNIFI_API_KEY', secret: true },
    { key: 'NAS_HOST' }, { key: 'NAS_PORT' }, { key: 'NAS_SCHEME' }, { key: 'NAS_USER' }, { key: 'NAS_PASSWORD', secret: true },
    { key: 'NAS_MONITOR_URL' }, { key: 'NAS_MONITOR_API_KEY', secret: true },
    { key: 'WIIM_IP' },
    { key: 'UPS_SOURCE' }, { key: 'NUT_HOST' }, { key: 'NUT_UPS_NAME' }, { key: 'PWRSTAT_PATH' }
];

// 更新 .env 檔：既有 KEY= 行 (含註解掉的) 就地取代，否則附加到檔尾
function persistEnvVars(updates) {
    let content = '';
    try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch { }
    for (const [k, v] of Object.entries(updates)) {
        const line = `${k}=${v}`;
        const re = new RegExp(`^#?\\s*${k}=.*$`, 'm');
        content = re.test(content) ? content.replace(re, line) : content + (content.endsWith('\n') || !content ? '' : '\n') + line + '\n';
    }
    fs.writeFileSync(ENV_FILE, content);
}

// 熱重建所有依賴 env 的客戶端與快取 (免重啟)
function rebuildClients() {
    unifiClient = buildUnifiClient();
    unifiCloudClient = buildUnifiCloudClient();
    ({ base: NAS_BASE, client: nasClient } = buildNasClient());
    ({ url: NASMON_URL, client: nasMonClient } = buildNasMonClient());
    wiimIP = process.env.WIIM_IP || wiimIP;
    localCookie = ''; cookieExpiry = 0;   // 重置 UniFi session
    nasToken = ''; nasTokenExpiry = 0;    // 重置 NAS token
    Object.keys(wiimCache).forEach(k => delete wiimCache[k]);
    sysLog('Connections', '連線設定已更新，所有客戶端已熱重建');
}

// GET：非機密回明碼、機密只回是否已設定 (佔位字串視為未設定)
app.get('/api/connections', (req, res) => {
    const fields = {}, secretsSet = {};
    for (const f of CONN_FIELDS) {
        const v = process.env[f.key];
        if (f.secret) secretsSet[f.key] = !isPlaceholder(v);
        else fields[f.key] = isPlaceholder(v) ? '' : (v || '');
    }
    res.json({ fields, secretsSet });
});

// POST：留空 = 不變更；寫入 .env + 即時生效
app.post('/api/connections', (req, res) => {
    const b = req.body || {};
    const updates = {};
    for (const f of CONN_FIELDS) {
        const v = b[f.key];
        if (typeof v === 'string' && v.trim() !== '') updates[f.key] = v.trim();
    }
    if (!Object.keys(updates).length) return res.json({ ok: true, changed: 0 });
    for (const [k, v] of Object.entries(updates)) process.env[k] = v;
    try { persistEnvVars(updates); } catch (e) {
        sysLog('Connections', `.env 寫入失敗: ${e.message}`, true);
        return res.status(500).json({ error: '.env 寫入失敗: ' + e.message });
    }
    rebuildClients();
    sysLog('Connections', `已更新 ${Object.keys(updates).length} 個欄位: ${Object.keys(updates).join(', ')}`);
    res.json({ ok: true, changed: Object.keys(updates).length });
});

/* ===================== 定期報表 ===================== */
// 彙整過去 24 小時的關鍵指標成一段文字
async function buildReport() {
    const L = [];
    const dayAgo = Date.now() - 86400000;
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    L.push(`🗓️ SmartHub 系統報表 · ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);

    // ── 資安 / 網路 ──
    L.push('\n━━ 🛡️ 資安與網路 ━━');
    try {
        const cookie = await getLocalSession();
        const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
        const threats = (alarm.data.data || []).filter(a => isIpsAlarm(a) && (a.time || Date.parse(a.datetime)) >= dayAgo);
        L.push(`• 24H 威脅攔截：${threats.length} 次`);
        if (threats.length) {
            const cat = {};
            threats.forEach(t => { const m = /SCAN/.test(t.msg) ? '掃描' : /EXPLOIT/.test(t.msg) ? '漏洞攻擊' : /MALWARE|Trojan/i.test(t.msg) ? '惡意程式' : /DOS/.test(t.msg) ? 'DoS' : '其他'; cat[m] = (cat[m] || 0) + 1; });
            L.push(`  類別：${Object.entries(cat).map(([k, v]) => `${k} ${v}`).join('、')}`);
            const srcs = {};
            threats.forEach(t => { const ip = t.src_ip || '?'; srcs[ip] = (srcs[ip] || 0) + 1; });
            const top = Object.entries(srcs).sort((a, b) => b[1] - a[1]).slice(0, 3);
            L.push(`  主要來源：${top.map(([ip, n]) => `${ip}(${n})`).join('、')}`);
        }
        const sta = (await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } })).data.data || [];
        const wired = sta.filter(c => c.is_wired).length;
        L.push(`• 線上客戶端：${sta.length} 台 (有線 ${wired} / 無線 ${sta.length - wired})`);
        const totalRx = sta.reduce((a, c) => a + (c.rx_bytes || 0), 0), totalTx = sta.reduce((a, c) => a + (c.tx_bytes || 0), 0);
        L.push(`• 客戶端累計流量：↓${(totalRx / 1073741824).toFixed(1)} GB / ↑${(totalTx / 1073741824).toFixed(1)} GB`);
    } catch { L.push('• 本地控制器未連線'); }
    const trends = loadTrends().filter(p => (Date.parse(p.t)) >= dayAgo);
    const lat = trends.map(p => p.latency).filter(v => v != null);
    if (lat.length) L.push(`• ISP 延遲：平均 ${avg(lat).toFixed(1)} ms (最高 ${Math.max(...lat)} ms)`);
    const cli = trends.map(p => p.clients).filter(v => v != null);
    if (cli.length) L.push(`• 客戶端數 24H：平均 ${Math.round(avg(cli))} / 最高 ${Math.max(...cli)} 台`);

    // ── UCG 硬體 ──
    if (!isPlaceholder(process.env.SSH_PASSWORD)) {
        try {
            const hw = (await axios.get(`http://127.0.0.1:${process.env.PORT || 3000}/api/hardware`, { timeout: 15000 })).data;
            L.push('\n━━ 🖥️ UCG-Ultra 閘道器 ━━');
            L.push(`• CPU：${hw.cpuUsage ?? '--'}% / ${hw.cpuTemp ?? '--'}°C　記憶體：${hw.memUsagePct ?? '--'}%`);
            if (hw.uptime) L.push(`• 運行時間：${hw.uptime}`);
            const wan = (hw.interfaces || []).find(i => i.name.startsWith('WAN'));
            if (wan) L.push(`• WAN(${wan.speed})：${wan.status === 'connected' ? '正常' : '離線'} ↓${wan.rxRate} ↑${wan.txRate}`);
        } catch { }
    }

    // ── NAS ──
    if (nasConfigured()) {
        try {
            L.push('\n━━ 💾 UGREEN NAS ━━');
            const disks = (await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 }).catch(() => null));
            let dl = disks ? (deepFind({ d: disks }, ['result', 'list', 'disks']) || []) : [];
            if (dl.length) {
                const temps = dl.filter(d => d.activate && d.temperature).map(d => d.temperature);
                const bad = dl.filter(d => d.status !== 1);
                L.push(`• 硬碟：${dl.length} 顆，${bad.length ? `⚠ ${bad.length} 顆異常` : '全部健康'}${temps.length ? `，溫度 ${Math.min(...temps)}–${Math.max(...temps)}°C` : ''}`);
                const sleeping = dl.filter(d => d.is_standby || d.activate === false).length;
                if (sleeping) L.push(`  ${sleeping} 顆休眠中`);
            }
            const vdata = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 }).catch(() => null);
            const vols = vdata ? (deepFind({ d: vdata }, ['result', 'list', 'volumes']) || []) : [];
            vols.filter(v => v.total).forEach(v => {
                const pct = Math.round(v.used / v.total * 100);
                L.push(`• ${v.label || v.name}：${(v.used / 1073741824 / 1024).toFixed(2)}/${(v.total / 1073741824 / 1024).toFixed(2)} TB (${pct}%)${pct >= 85 ? ' ⚠' : ''}`);
            });
        } catch { L.push('• NAS 讀取失敗 (可能需管理員權限)'); }
    }

    // ── UPS ──
    try {
        const ups = await readUpsLive();
        if (ups) {
            L.push('\n━━ 🔋 UPS ━━');
            L.push(`• ${ups.model || 'UPS'}：${ups.onBattery ? '⚡ 電池供電中' : '🟢 市電正常'}，電池 ${ups.battery ?? '--'}%${ups.inputV ? `，輸入 ${ups.inputV}V` : ''}`);
            const outages = upsEvents.filter(e => Date.parse(e.start) >= dayAgo);
            if (outages.length) L.push(`• 24H 斷電事件：${outages.length} 次`);
        }
    } catch { }

    // ── WiiM ──
    const wiim24h = wiimHistory.filter(h => (h.ts * 1000) >= dayAgo);
    if (wiim24h.length) {
        const cpus = wiim24h.map(h => h.cpu).filter(v => v !== null);
        const boards = wiim24h.map(h => h.board).filter(v => v !== null);
        if (cpus.length && boards.length) {
            L.push('\n━━ 🔊 WiiM Amp ━━');
            L.push(`• 24H 均溫：CPU ${avg(cpus).toFixed(1)}°C (最高 ${Math.max(...cpus).toFixed(1)}) / 主板 ${avg(boards).toFixed(1)}°C (最高 ${Math.max(...boards).toFixed(1)})`);
        }
    }
    return L.join('\n') || '（無可彙整的資料）';
}

let lastReportKey = '';
async function reportScheduler() {
    if (!appSettings.reportEnabled) return;
    const now = new Date();
    if (now.getHours() !== appSettings.reportHour || now.getMinutes() !== 0) return;
    const key = appSettings.reportFreq === 'weekly'
        ? `${now.getFullYear()}-W${Math.floor(now.getDate() / 7)}-${now.getDay()}`
        : now.toISOString().slice(0, 10);
    if (appSettings.reportFreq === 'weekly' && now.getDay() !== 1) return; // 週報只在週一
    if (key === lastReportKey) return;
    lastReportKey = key;
    const body = await buildReport();
    await notify(`📊 SmartHub ${appSettings.reportFreq === 'weekly' ? '每週' : '每日'}報表`, body);
}
setInterval(reportScheduler, 60 * 1000);

// 立即產生報表 (預覽 + 若已啟用推播則送出)
app.post('/api/reports/run', async (req, res) => {
    const body = await buildReport();
    const r = await notify('📊 SmartHub 報表 (手動觸發)', body);
    res.json({ report: body, delivery: r });
});

/* ===================== PWA (manifest + service worker) ===================== */
const PWA_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0b1220"/><g fill="none" stroke="#3b82f6" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M96 40L44 66l52 26 52-26-52-26z"/><path d="M44 126l52 26 52-26M44 96l52 26 52-26"/></g></svg>');
app.get('/manifest.webmanifest', (req, res) => {
    res.json({
        name: 'SmartHub 戰情室', short_name: 'SmartHub', start_url: '/', display: 'standalone',
        background_color: '#030712', theme_color: '#030712', orientation: 'portrait-primary',
        icons: [
            { src: PWA_ICON, sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
            { src: PWA_ICON, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
    });
});
app.get('/sw.js', (req, res) => {
    res.type('application/javascript').send(`
const C='smarthub-v1';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['/'])))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/')||u.pathname==='/healthz')return; // API 不快取
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));
});`);
});

// --- WiiM Amp Integration Endpoints & Background Polling ---
let wiimIP = process.env.WIIM_IP || '192.168.0.170'; // let：連線設定頁可熱更新
let wiimHistory = [];

const wiimCache = {};

async function wiimGet(command) {
    const cacheKey = command;
    const now = Date.now();
    const isCacheable = ['getPlayerStatus', 'getMetaInfo', 'getStatusEx', 'getPresetInfo', 'getbtdiscoveryresult'].includes(command);

    if (isCacheable && wiimCache[cacheKey] && (now - wiimCache[cacheKey].timestamp < 2000)) {
        sysLog('WiiM Proxy', `命中 2 秒內的唯讀快取，直接返回快取。命令: ${command}`);
        return wiimCache[cacheKey].data;
    }

    const headers = { 'User-Agent': 'wiim-temp/2.0' };
    let result = null;
    try {
        const res = await axios.get(`https://${wiimIP}/httpapi.asp?command=${encodeURIComponent(command)}`, {
            headers,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 3000
        });
        result = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    } catch (e1) {
        sysLog('WiiM Proxy', `[HTTPS 失敗] 命令: ${command}，錯誤: ${e1.message}。嘗試 HTTP 回退...`, true);
        try {
            const res = await axios.get(`http://${wiimIP}/httpapi.asp?command=${encodeURIComponent(command)}`, {
                headers,
                timeout: 3000
            });
            result = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        } catch (e2) {
            sysLog('WiiM Proxy', `[HTTP 失敗] 命令: ${command}，錯誤: ${e2.message}。連線無法建立！`, true);
            result = null;
        }
    }

    if (isCacheable && result !== null) {
        wiimCache[cacheKey] = {
            data: result,
            timestamp: now
        };
    } else if (isCacheable && wiimCache[cacheKey]) {
        // 容錯機制：若目前連線失敗但有之前的快取，回傳舊快取作為備份
        return wiimCache[cacheKey].data;
    }

    return result;
}

// 只記錄真實裝置回傳的溫度；連不上時跳過本次取樣，不偽造數據混入歷史
async function pollWiimTemp() {
    const raw = await wiimGet('getStatusEx');
    if (!raw) { sysLog('WiiM Poll', 'WiiM 裝置無回應，跳過本次溫度取樣', true); return; }
    let cpu = null, board = null;
    try {
        const d = JSON.parse(raw);
        cpu = parseFloat(d.temperature_cpu);
        board = parseFloat(d.temperature_tmp102);
    } catch { }
    if (isNaN(cpu) && isNaN(board)) { sysLog('WiiM Poll', 'getStatusEx 回應中無溫度欄位，跳過本次取樣', true); return; }
    const ts = Math.floor(Date.now() / 1000);
    wiimHistory.push({ ts, cpu: isNaN(cpu) ? null : cpu, board: isNaN(board) ? null : board });
    if (wiimHistory.length > 5000) wiimHistory.shift();
    sysLog('WiiM Poll', `溫度採樣完成 (CPU: ${cpu}°C, Board: ${board}°C)`);
}
// 自適應排程：有人瀏覽時每 10 秒取樣，閒置時降為 trendIdleSec (與趨勢取樣器同一套活躍判定)
let lastWiimPollTs = 0;
setInterval(async () => {
    const now = Date.now();
    const active = (now - lastClientActivity) < appSettings.activeWindowSec * 1000;
    const gap = active ? 10000 : appSettings.trendIdleSec * 1000;
    if (now - lastWiimPollTs >= gap) { lastWiimPollTs = now; await pollWiimTemp(); }
}, 1000);

app.get('/api/wiim/history', (req, res) => {
    res.json({
        interval: 10,
        cpu_alert: appSettings.wiimCpuAlert ?? 70,
        board_alert: appSettings.wiimBoardAlert ?? 60,
        data: wiimHistory
    });
});

app.get('/api/wiim/status', async (req, res) => {
    const type = req.query.type || 'all';
    const out = {};
    const targets = [];
    if (type === 'all' || type === 'play') {
        targets.push(['player', 'getPlayerStatus']);
        targets.push(['meta', 'getMetaInfo']);
    }
    if (type === 'all' || type === 'status') {
        targets.push(['status', 'getStatusEx']);
    }

    for (const [key, cmd] of targets) {
        const raw = await wiimGet(cmd);
        try {
            out[key] = raw ? JSON.parse(raw) : null;
        } catch {
            out[key] = { raw };
        }
    }
    // 正式伺服器只回真實數據：裝置無回應時各欄位為 null 並標記 unreachable，不偽造展示資料
    const unreachable = Object.values(out).every(v => v === null || (v && v.raw === null));
    if (unreachable) sysLog('WiiM Proxy', `裝置 ${wiimIP} 無回應 (type=${type})，回傳 unreachable`, true);
    res.json({
        ...out,
        ip: wiimIP,
        source: unreachable ? 'unreachable' : 'wiim_api'
    });
});

app.get('/api/wiim/cmd', async (req, res) => {
    const command = req.query.command || '';
    if (!command) return res.status(400).json({ error: 'No command' });
    const raw = await wiimGet(command);
    res.json({ result: raw || "OK" });
});

// 專輯封面代理：WiiM 回的 albumArtURI 常是裝置自簽 HTTPS 或外部 CDN，瀏覽器直連會被擋
// 由後端抓取後轉發 (忽略自簽憑證)，記憶體快取 5 分鐘
const wiimArtCache = {};
app.get('/api/wiim/art', async (req, res) => {
    const u = req.query.u || '';
    if (!/^https?:\/\//i.test(u)) return res.status(400).end();
    // AirPlay 的封面 URI 固定不變、內容隨曲目更換 → 以前端傳來的曲名 (v) 作為快取版本鍵
    const key = u + '|' + (req.query.v || '');
    const hit = wiimArtCache[key];
    if (hit && Date.now() - hit.ts < 5 * 60 * 1000) {
        res.set('Content-Type', hit.type); return res.send(hit.buf);
    }
    try {
        const r = await axios.get(u, {
            responseType: 'arraybuffer', timeout: 6000,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: { 'User-Agent': 'wiim-temp/2.0' }
        });
        const type = r.headers['content-type'] || 'image/jpeg';
        wiimArtCache[key] = { buf: r.data, type, ts: Date.now() };
        // 快取上限 20 張，超過清最舊
        const keys = Object.keys(wiimArtCache);
        if (keys.length > 20) delete wiimArtCache[keys.sort((a, b) => wiimArtCache[a].ts - wiimArtCache[b].ts)[0]];
        res.set('Content-Type', type); res.send(r.data);
    } catch (e) {
        sysLog('WiiM Art', `封面抓取失敗: ${e.message}`, true);
        res.status(502).end();
    }
});

app.get('/api/wiim/clear', (req, res) => {
    wiimHistory = [];
    res.json({ ok: true });
});

app.get('/api/wiim/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=wiim_temp_log.csv');
    let csv = 'timestamp,iso_time,cpu_c,board_tmp102_c\n';
    for (const h of wiimHistory) {
        // 使用 ISO 格式時間
        const iso = new Date(h.ts * 1000).toISOString();
        csv += `${h.ts},${iso},${h.cpu !== null && h.cpu !== undefined ? h.cpu : ''},${h.board !== null && h.board !== undefined ? h.board : ''}\n`;
    }
    res.send(csv);
});

/* ===================== CyberPower UPS 電源監控 (NUT 優先，多來源回退) ===================== */
// 架構 (詳見 cyberpower-ups-api.md)：UPS_SOURCE=auto|nut|pwrstat|pmset
//   1) NUT:     upsc <NUT_UPS_NAME>@<NUT_HOST>       ← 建議方案 (brew install nut)
//   2) pwrstat: /bin/pwrstat -status                  ← 官方 PowerPanel CLI
//   3) pmset:   pmset -g ps                           ← macOS 原生 (僅容量/充電狀態，無電壓)
// 電壓歷史與斷電事件「持久化」於 DATA_DIR (斷電紀錄不可因重啟遺失)。
// 呼叫時讀取 env，設定頁修改後即時生效
const UPS_SOURCE = () => process.env.UPS_SOURCE || 'auto';
const NUT_HOST = () => process.env.NUT_HOST || 'localhost';
const NUT_UPS_NAME = () => process.env.NUT_UPS_NAME || 'cyberpower';
const PWRSTAT_PATH = () => process.env.PWRSTAT_PATH || 'pwrstat';
const UPS_HISTORY_FILE = path.join(DATA_DIR, 'ups-history.json');
const UPS_EVENTS_FILE = path.join(DATA_DIR, 'ups-events.json');
const UPS_HISTORY_LIMIT = 20000; // 30 秒間隔 ≈ 7 天

let upsHistory = (() => { try { return JSON.parse(fs.readFileSync(UPS_HISTORY_FILE, 'utf8')); } catch { return []; } })();
let upsEvents = (() => { try { return JSON.parse(fs.readFileSync(UPS_EVENTS_FILE, 'utf8')); } catch { return []; } })();
let upsLastLive = null;     // 最近一次成功讀取 (含 source)
let upsWasOnBattery = false;

function execCmd(cmd, timeoutMs = 5000) {
    return new Promise(resolve => exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout)));
}

// --- 來源 1: NUT (upsc key: value 格式) ---
async function readNut() {
    const out = await execCmd(`upsc ${NUT_UPS_NAME()}@${NUT_HOST()} 2>/dev/null`);
    if (!out || !out.includes(':')) return null;
    const kv = {};
    out.split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    if (!kv['ups.status']) return null;
    return {
        source: 'nut', model: kv['device.model'] || kv['ups.model'] || 'UPS',
        status: kv['ups.status'],
        onBattery: /\bOB\b/.test(kv['ups.status']),
        inputV: parseFloat(kv['input.voltage']) || null,
        outputV: parseFloat(kv['output.voltage']) || null,
        battery: parseFloat(kv['battery.charge']) || null,
        runtimeSec: parseFloat(kv['battery.runtime']) || null,
        loadPct: parseFloat(kv['ups.load']) || null,
        raw: kv
    };
}

// --- 來源 2: pwrstat (CyberPower 官方 CLI，"Key.... Value" 格式) ---
async function readPwrstat() {
    const out = await execCmd(`${PWRSTAT_PATH()} -status 2>/dev/null`);
    if (!out || !out.includes('Utility Voltage')) return null;
    const grab = re => { const m = out.match(re); return m ? m[1].trim() : null; };
    const state = grab(/State\.+\s*(.+)/) || '';
    return {
        source: 'pwrstat', model: grab(/Model Name\.+\s*(.+)/) || 'CyberPower UPS',
        status: state,
        onBattery: /Utility Failure|Battery Power/i.test(state),
        inputV: parseFloat(grab(/Utility Voltage\.+\s*([\d.]+)/)) || null,
        outputV: parseFloat(grab(/Output Voltage\.+\s*([\d.]+)/)) || null,
        battery: parseFloat(grab(/Battery Capacity\.+\s*([\d.]+)/)) || null,
        runtimeSec: (parseFloat(grab(/Remaining Runtime\.+\s*([\d.]+)/)) || 0) * 60 || null,
        loadPct: parseFloat(grab(/Load\.+\s*([\d.]+)/)) || null
    };
}

// --- 來源 3: pmset (macOS 原生，資訊有限) ---
async function readPmset() {
    const out = await execCmd('pmset -g ps 2>/dev/null');
    // UPS 會以電源裝置行出現，例如「 -CP1000AVRLCDa (id=xxx) 100%; AC attached; ...」
    // 不能靠字面 "UPS" 判斷（CyberPower 顯示的是型號名）；排除筆電內建電池
    const devLine = (out || '').split('\n').find(l => /^\s*-.*\d+%/.test(l) && !/InternalBattery/i.test(l));
    if (!devLine) return null;
    const cap = devLine.match(/(\d+)%/);
    const onBattery = /'UPS Power'|Battery Power/i.test(out) || /discharging/i.test(devLine);
    return {
        source: 'pmset',
        model: (devLine.match(/^\s*-\s*([^(]+?)\s*(?:\(|\t|\d+%)/) || [])[1] || 'USB HID UPS',
        status: onBattery ? 'OB (Battery)' : 'OL (AC)',
        onBattery,
        inputV: null, outputV: null, // pmset 不提供電壓；要電壓紀錄請改用 NUT
        battery: cap ? parseFloat(cap[1]) : null,
        runtimeSec: (() => { const m = devLine.match(/(\d+):(\d+) remaining/); return m ? (+m[1] * 60 + +m[2]) * 60 : null; })(),
        loadPct: null
    };
}

let upsLastReason = '';
async function readUpsLive() {
    // 指定來源優先嘗試；即使指定的來源失敗，仍回退到其他來源 (避免選錯來源就整個抓不到)
    const chosen = UPS_SOURCE();
    const order = chosen === 'auto' ? ['nut', 'pwrstat', 'pmset'] : [chosen, ...['nut', 'pwrstat', 'pmset'].filter(s => s !== chosen)];
    const tried = [];
    for (const src of order) {
        const fn = { nut: readNut, pwrstat: readPwrstat, pmset: readPmset }[src];
        if (!fn) continue;
        const r = await fn();
        if (r) {
            if (src !== chosen && chosen !== 'auto') sysLog('UPS', `指定來源 ${chosen} 無法使用，已自動改用 ${src}`, true);
            sysLog('UPS', `讀取成功 via ${src}: ${r.status} 輸入${r.inputV}V 電池${r.battery}%`);
            upsLastReason = ''; return { ...r, actualSource: src };
        }
        tried.push(src);
    }
    upsLastReason = `所有來源皆無法讀取 (已嘗試: ${tried.join(', ')})。pwrstat 需安裝 CyberPower PowerPanel；NUT 需安裝並設定 upsc；pmset 為 macOS 內建`;
    sysLog('UPS', upsLastReason, true);
    return null;
}

// 取樣 + 斷電事件偵測 (皆持久化)
async function sampleUps() {
    const live = await readUpsLive();
    if (!live) { sysLog('UPS', '所有來源皆不可用，跳過本次取樣', true); upsLastLive = null; return; }
    upsLastLive = { ...live, ts: Date.now() };
    upsHistory.push({ t: new Date().toISOString(), inV: live.inputV, outV: live.outputV, batt: live.battery, load: live.loadPct, rt: live.runtimeSec, ob: live.onBattery ? 1 : 0 });
    if (upsHistory.length > UPS_HISTORY_LIMIT) upsHistory = upsHistory.slice(-UPS_HISTORY_LIMIT);
    try { fs.writeFileSync(UPS_HISTORY_FILE, JSON.stringify(upsHistory)); } catch (e) { sysLog('UPS', `歷史寫入失敗: ${e.message}`, true); }

    // 斷電事件：市電斷 → 開新事件；恢復 → 補上結束時間與時長
    if (live.onBattery && !upsWasOnBattery) {
        upsEvents.unshift({ start: new Date().toISOString(), end: null, durationSec: null, minBattery: live.battery, startVoltage: live.inputV });
        sysLog('UPS', `⚡ 偵測到斷電！事件已記錄 (電池 ${live.battery}%)`, true);
        const ns = loadNotifSettings();
        if (ns.enabled && ns.triggerUpsOutage !== false) await notify('⚡ UPS 斷電！', `市電中斷，UPS 供電中 (電池 ${live.battery ?? '?'}%)`);
        upsLowBattNotified = false;
    } else if (!live.onBattery && upsWasOnBattery && upsEvents[0] && !upsEvents[0].end) {
        upsEvents[0].end = new Date().toISOString();
        upsEvents[0].durationSec = Math.round((Date.now() - new Date(upsEvents[0].start).getTime()) / 1000);
        sysLog('UPS', `✅ 市電恢復，斷電持續 ${upsEvents[0].durationSec} 秒`);
        const ns = loadNotifSettings();
        if (ns.enabled && ns.triggerUpsOutage !== false) await notify('✅ 市電恢復', `斷電持續 ${upsEvents[0].durationSec} 秒，最低電池 ${upsEvents[0].minBattery ?? '?'}%`);
    } else if (live.onBattery && upsEvents[0] && !upsEvents[0].end) {
        if (live.battery != null) upsEvents[0].minBattery = Math.min(upsEvents[0].minBattery ?? 100, live.battery);
        if (live.battery != null && live.battery <= 20 && !upsLowBattNotified) {
            upsLowBattNotified = true;
            const ns = loadNotifSettings();
            if (ns.enabled && ns.triggerUpsLowBatt !== false) await notify('🪫 UPS 電池電量低', `僅剩 ${live.battery}%，請儘快處理或準備關機`);
        }
    }
    upsEvents = upsEvents.slice(0, 200);
    try { fs.writeFileSync(UPS_EVENTS_FILE, JSON.stringify(upsEvents)); } catch { }
    upsWasOnBattery = live.onBattery;
}
// UPS 取樣「不做閒置降頻」：斷電/電壓紀錄是核心需求，無人看網頁也要持續記錄 (本地指令，成本低)
let upsLowBattNotified = false;
let lastUpsSampleTs = 0;
setInterval(async () => {
    const gap = (appSettings.upsSampleSec || 30) * 1000;
    if (Date.now() - lastUpsSampleTs >= gap) { lastUpsSampleTs = Date.now(); await sampleUps(); }
}, 1000);

app.get('/api/ups/status', async (req, res) => {
    // 讀取即時值；失敗時回報最後一次成功樣本供前端顯示「最後已知狀態」
    const live = await readUpsLive();
    if (live) upsLastLive = { ...live, ts: Date.now() };
    res.json(live ? { ...live, sampleSec: appSettings.upsSampleSec || 30 }
        : { source: 'unreachable', reason: upsLastReason, lastKnown: upsLastLive, sampleSec: appSettings.upsSampleSec || 30 });
});

app.get('/api/ups/history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    const cutoff = Date.now() - hours * 3600000;
    res.json({ history: upsHistory.filter(p => new Date(p.t).getTime() >= cutoff) });
});

app.get('/api/ups/events', (req, res) => res.json({ events: upsEvents }));

app.get('/api/ups/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ups_history.csv');
    let csv = 'time,input_v,output_v,battery_pct,load_pct,runtime_sec,on_battery\n';
    for (const h of upsHistory) csv += `${h.t},${h.inV ?? ''},${h.outV ?? ''},${h.batt ?? ''},${h.load ?? ''},${h.rt ?? ''},${h.ob}\n`;
    res.send(csv);
});

// 健康檢查端點 (供 Docker healthcheck / 反向代理使用)
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Production Server listening on port ${PORT}`));
