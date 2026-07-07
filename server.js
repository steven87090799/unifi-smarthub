const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Client } = require('ssh2');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 託管前端靜態網頁
app.use(express.static(path.join(__dirname, 'public')));

// 建立忽略內網自簽 HTTPS 憑證錯誤的 Axios 實例
const unifiClient = axios.create({
    baseURL: process.env.UNIFI_CONTROLLER_URL,
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

let localCookie = '';
let cookieExpiry = 0;

// 本地 API 登入 Session 管理
async function getLocalSession() {
    const now = Date.now();
    if (localCookie && now < cookieExpiry) return localCookie;

    try {
        const response = await unifiClient.post('/api/auth/login', {
            username: process.env.UNIFI_USERNAME,
            password: process.env.UNIFI_PASSWORD
        });
        
        const cookies = response.headers['set-cookie'];
        if (cookies) {
            localCookie = cookies.join('; ');
            cookieExpiry = now + 15 * 60 * 1000; // 15 分鐘過期
            return localCookie;
        }
        throw new Error('No cookie returned from Controller');
    } catch (error) {
        throw new Error('UniFi Controller Login Failed: ' + error.message);
    }
}

// 建立 UniFi 官方雲端 Site Manager API 客戶端
const unifiCloudClient = axios.create({
    baseURL: 'https://api.ui.com/v1',
    headers: {
        'Accept': 'application/json',
        'X-API-KEY': process.env.UNIFI_API_KEY || ''
    }
});

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
    const conn = new Client();
    conn.on('ready', () => {
        conn.exec(HW_CMD, (err, stream) => {
            if (err) {
                conn.end();
                return res.status(500).json({ error: 'SSH Command Execution Failed' });
            }
            let output = '';
            stream.on('data', (chunk) => { output += chunk; })
                  .stderr.on('data', () => {});
            stream.on('close', () => {
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
        res.status(500).json({ error: 'SSH Connection Failed', details: err.message });
    }).connect({
        host: process.env.UCG_IP,
        port: parseInt(process.env.SSH_PORT || '22', 10),
        username: process.env.SSH_USER,
        password: process.env.SSH_PASSWORD
    });
});

// 2. 獲取活躍客戶端
app.get('/api/clients', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        
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
        res.json({ clients });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. 獲取 SSID 列表
app.get('/api/wifi-networks', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/api/s/default/rest/wlanconf', { headers: { 'Cookie': cookie } });
        res.json({ networks: response.data.data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. 控制 SSID 狀態
app.put('/api/wifi-networks/:id', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.put(`/api/s/default/rest/wlanconf/${req.params.id}`, {
            enabled: req.body.enabled
        }, { headers: { 'Cookie': cookie } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. 獲取 IPS/IDS 威脅警報
app.get('/api/threats', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/api/s/default/stat/alarm', { headers: { 'Cookie': cookie } });
        
        // 過濾出與 IPS 相關的警告並擴充結構
        const threats = response.data.data.filter(a => a.key === 'ips:alert').map(t => {
            // 嘗試解析威脅種類
            let category = "Intrusion Attempt";
            if (t.msg.includes("EXPLOIT")) category = "Web Exploit";
            else if (t.msg.includes("SCAN")) category = "Scanner";
            else if (t.msg.includes("MALWARE") || t.msg.includes("Trojan")) category = "Malware";
            else if (t.msg.includes("DOS")) category = "DoS";

            return {
                id: t._id,
                datetime: new Date(t.datetime).toISOString(),
                src_ip: t.src_ip,
                src_country: t.src_country || 'Unknown',
                msg: t.msg,
                port: t.dst_port ? `${t.dst_port}/${t.proto || 'TCP'}` : 'Any',
                severity: 'HIGH',
                category,
                target_ip: t.dest_ip || 'WAN-IN',
                target_device: 'UCG-Ultra Core',
                action_taken: 'BLOCKED'
            };
        });
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
    autoDefenseSec: 30,     // 自動防禦掃描間隔
    reportEnabled: false,   // 定期報表
    reportFreq: 'daily',    // daily | weekly
    reportHour: 8           // 每日幾點發送 (0-23)
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
        const cookie = await getLocalSession();
        await unifiClient.post('/api/s/default/cmd/stamgr', {
            cmd: req.body.blockState ? 'block-sta' : 'unblock-sta',
            mac: req.body.deviceId
        }, { headers: { 'Cookie': cookie } });
        appendBlockHistory({
            datetime: new Date().toISOString(),
            mac: req.body.deviceId,
            name: req.body.deviceName || 'Unknown Device',
            action: req.body.blockState ? 'block' : 'unblock',
            source: 'manual'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6-1. 封鎖歷史時間軸
app.get('/api/block-history', (req, res) => {
    res.json({ history: loadBlockHistory() });
});

// 7. PoE Port 斷電重啟
app.post('/api/poe/power-cycle', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        await unifiClient.post('/api/s/default/cmd/devmgr', {
            cmd: "power-cycle",
            mac: req.body.switchMac,
            port_idx: parseInt(req.body.portIndex, 10)
        }, { headers: { 'Cookie': cookie } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. 觸發測速
app.post('/api/speedtest', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        await unifiClient.post('/api/s/default/cmd/devmgr', {
            cmd: "speedtest"
        }, { headers: { 'Cookie': cookie } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8-1. 查詢測速狀態與結果 (輪詢 stat/health 中 www 子系統的 xput 數據)
app.get('/api/speedtest/status', async (req, res) => {
    try {
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/api/s/default/stat/health', { headers: { 'Cookie': cookie } });
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
            return res.json({ data: mockSitesFallback, source: 'fallback' });
        }
        const response = await unifiCloudClient.get('/sites');
        res.json(response.data);
    } catch (error) {
        res.json({ data: mockSitesFallback, source: 'fallback_on_error', error: error.message });
    }
});

// 10. 獲取雲端託管設備清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/devices', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: mockDevicesFallback, source: 'fallback' });
        }
        const response = await unifiCloudClient.get('/devices');
        res.json(response.data);
    } catch (error) {
        res.json({ data: mockDevicesFallback, source: 'fallback_on_error', error: error.message });
    }
});

// 11. 獲取 ISP 效能數據指標 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/isp-metrics', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            const latencyVal = (12 + Math.random() * 2).toFixed(1);
            return res.json({
                data: {
                    ...mockIspMetricsFallback,
                    latency: parseFloat(latencyVal)
                },
                source: 'fallback'
            });
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
        const latencyVal = (12 + Math.random() * 2).toFixed(1);
        res.json({
            data: {
                ...mockIspMetricsFallback,
                latency: parseFloat(latencyVal)
            },
            source: 'fallback_on_error',
            error: error.message
        });
    }
});

// 12. 獲取雲端控制台主機清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/hosts', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: mockHostsFallback, source: 'fallback' });
        }
        const response = await unifiCloudClient.get('/hosts');
        res.json(response.data);
    } catch (error) {
        res.json({ data: mockHostsFallback, source: 'fallback_on_error', error: error.message });
    }
});

// 13. 獲取 SD-WAN VPN 配置清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/sdwan', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: mockSdwanFallback, source: 'fallback' });
        }
        const response = await unifiCloudClient.get('/sd-wan-configs');
        res.json(response.data);
    } catch (error) {
        res.json({ data: mockSdwanFallback, source: 'fallback_on_error', error: error.message });
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
        const cookie = await getLocalSession();
        const alarm = await unifiClient.get('/api/s/default/stat/alarm', { headers: { 'Cookie': cookie } });
        const recent = (alarm.data.data || []).filter(a =>
            a.key === 'ips:alert' && Date.now() - new Date(a.datetime).getTime() < 10 * 60 * 1000);
        if (!recent.length) return;
        const sta = await unifiClient.get('/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        const clients = sta.data.data || [];
        for (const t of recent) {
            const msg = (t.msg || '').toUpperCase();
            if (!INFECTION_KEYWORDS.some(k => msg.includes(k))) continue;
            const victim = clients.find(c => c.ip === t.dest_ip && !c.blocked);
            if (victim && !autoBlockedMacs.has(victim.mac)) {
                await unifiClient.post('/api/s/default/cmd/stamgr', { cmd: 'block-sta', mac: victim.mac }, { headers: { 'Cookie': cookie } });
                autoBlockedMacs.add(victim.mac);
                appendBlockHistory({
                    datetime: new Date().toISOString(),
                    mac: victim.mac,
                    name: victim.name || victim.hostname || 'Unknown Device',
                    action: 'block',
                    source: 'auto',
                    reason: t.msg
                });
            }
        }
    } catch { /* 控制器不可用時靜默跳過，下輪重試 */ }
}
setInterval(autoDefenseSweep, 30 * 1000);

/* ===================== 通知推播中心 ===================== */
// 偵測到新威脅攔截或 NAS 嚴重警報時，推播到 Discord / Telegram / 通用 Webhook。
const NOTIF_FILE = path.join(DATA_DIR, 'notification-settings.json');
const NOTIF_DEFAULTS = { enabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', triggerThreats: true, triggerNasAlerts: true };
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
        await axios.post(`https://api.telegram.org/bot${s.botToken}/sendMessage`, { chat_id: s.chatId, text }, { timeout: 8000 });
    } else if (s.channel === 'discord') {
        if (!s.webhookUrl) throw new Error('Discord Webhook URL 未設定');
        await axios.post(s.webhookUrl, { content: text }, { timeout: 8000 });
    } else {
        if (!s.webhookUrl) throw new Error('Webhook URL 未設定');
        await axios.post(s.webhookUrl, { title, body, text, ts: new Date().toISOString() }, { timeout: 8000 });
    }
}

async function notify(title, body) {
    const s = loadNotifSettings();
    if (!s.enabled) return { skipped: 'disabled' };
    try {
        await dispatchNotification(title, body, s);
        pushNotifLog({ ts: new Date().toISOString(), title, body, channel: s.channel, ok: true });
        return { ok: true };
    } catch (e) {
        pushNotifLog({ ts: new Date().toISOString(), title, body, channel: s.channel, ok: false, error: e.message });
        return { ok: false, error: e.message };
    }
}

// GET：回傳設定但遮罩機密 (webhookUrl/botToken 不外洩，改回傳 *Set 布林旗標)
app.get('/api/notifications/settings', (req, res) => {
    const s = loadNotifSettings();
    res.json({
        enabled: s.enabled, channel: s.channel, chatId: s.chatId,
        triggerThreats: s.triggerThreats, triggerNasAlerts: s.triggerNasAlerts,
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
            const alarm = await unifiClient.get('/api/s/default/stat/alarm', { headers: { 'Cookie': cookie } });
            const alerts = (alarm.data.data || []).filter(a => a.key === 'ips:alert');
            // 首輪只記錄既有事件，避免啟動時一次推播歷史全部
            if (!notifBootstrapped) { alerts.forEach(a => notifiedThreatIds.add(a._id)); }
            else {
                for (const a of alerts) {
                    if (notifiedThreatIds.has(a._id)) continue;
                    notifiedThreatIds.add(a._id);
                    await notify('🛡️ IPS 攔截新威脅', `來源 ${a.src_ip || '?'} (${a.src_country || '未知'})\n${a.msg || ''}`);
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
    notifBootstrapped = true;
}

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
function markClientActivity() { lastClientActivity = Date.now(); }

function loadTrends() {
    try { return JSON.parse(fs.readFileSync(TREND_FILE, 'utf8')); } catch { return []; }
}

async function sampleTrends() {
    const point = { t: new Date().toISOString(), clients: null, threats24h: null, latency: null };
    try {
        const cookie = await getLocalSession();
        const sta = await unifiClient.get('/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        point.clients = (sta.data.data || []).length;
        const alarm = await unifiClient.get('/api/s/default/stat/alarm', { headers: { 'Cookie': cookie } });
        const dayAgo = Date.now() - 86400000;
        point.threats24h = (alarm.data.data || []).filter(a => a.key === 'ips:alert' && new Date(a.datetime).getTime() >= dayAgo).length;
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
    const gap = (active ? appSettings.trendActiveSec : appSettings.trendIdleSec) * 1000;
    if (now - lastSampleTs >= gap) {
        lastSampleTs = now;
        await sampleTrends();
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
const NAS_BASE = process.env.NAS_HOST
    ? `${process.env.NAS_SCHEME || 'https'}://${process.env.NAS_HOST}:${process.env.NAS_PORT || '9443'}`
    : null;
const nasClient = NAS_BASE ? axios.create({
    baseURL: NAS_BASE,
    headers: { 'ug-agent': 'PC/WEB', 'Accept': 'application/json' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 10000
}) : null;

function nasConfigured() {
    return !!(NAS_BASE && process.env.NAS_USER && process.env.NAS_PASSWORD);
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
    if (nasToken && now < nasTokenExpiry) return nasToken;
    const pkRes = await nasClient.get('/ugreen/v1/verify/rsa_public_key');
    const publicKey = deepFind(pkRes.data, ['public_key', 'publicKey', 'rsa_public_key', 'key']);
    if (!publicKey || !String(publicKey).includes('KEY')) throw new Error('NAS RSA public key not found in response');
    const encrypted = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(process.env.NAS_PASSWORD)
    ).toString('base64');
    const loginRes = await nasClient.post('/ugreen/v1/verify/login', {
        username: process.env.NAS_USER,
        password: encrypted,
        device_type: 1
    });
    const token = deepFind(loginRes.data, ['token', 'access_token']);
    if (!token) throw new Error('NAS login did not return a token');
    nasToken = token;
    nasTokenExpiry = now + 12 * 60 * 60 * 1000; // Token 官方效期 24H，保守 12H 換發
    return nasToken;
}

async function nasGet(pathName, params = {}) {
    const token = await getNasToken();
    const r = await nasClient.get(pathName, { params: { ...params, token } });
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
    if (!nasConfigured()) return res.json({ ...mockNasOverview, source: 'fallback' });
    try {
        const [info, stats] = await Promise.all([
            nasGet('/ugreen/v1/sysinfo/machine/common'),
            nasGet('/ugreen/v1/taskmgr/stat/get_all')
        ]);
        res.json({ info, stats, source: 'nas_api' });
    } catch (error) {
        res.json({ ...mockNasOverview, source: 'fallback_on_error', error: error.message });
    }
});

// 16. NAS 實體硬碟清單 (含溫度與健康狀態)
app.get('/api/nas/disks', async (req, res) => {
    if (!nasConfigured()) return res.json({ disks: mockNasDisks, source: 'fallback' });
    try {
        const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
        const disks = deepFind({ d: data }, ['result', 'list', 'disks']) || (Array.isArray(data) ? data : []);
        res.json({ disks, source: 'nas_api' });
    } catch (error) {
        res.json({ disks: mockNasDisks, source: 'fallback_on_error', error: error.message });
    }
});

// 17. NAS 邏輯儲存區清單 (回應包裝於 data.result)
app.get('/api/nas/volumes', async (req, res) => {
    if (!nasConfigured()) return res.json({ volumes: mockNasVolumes, source: 'fallback' });
    try {
        const data = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
        const volumes = deepFind({ d: data }, ['result', 'list', 'volumes']) || (Array.isArray(data) ? data : []);
        res.json({ volumes, source: 'nas_api' });
    } catch (error) {
        res.json({ volumes: mockNasVolumes, source: 'fallback_on_error', error: error.message });
    }
});

// 18. NAS UPS 狀態
app.get('/api/nas/ups', async (req, res) => {
    if (!nasConfigured()) return res.json({ ups: mockNasUps, source: 'fallback' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/config');
        res.json({ ups: data, source: 'nas_api' });
    } catch (error) {
        res.json({ ups: mockNasUps, source: 'fallback_on_error', error: error.message });
    }
});

// 18-1. NAS UPS USB 快速存在性檢查 (系統 A)
app.get('/api/nas/ups-usb', async (req, res) => {
    if (!nasConfigured()) return res.json({ present: true, source: 'fallback' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/usb/info');
        res.json({ data, source: 'nas_api' });
    } catch (error) {
        res.json({ present: false, source: 'fallback_on_error', error: error.message });
    }
});

/* ===================== NAS Monitor 擴充 REST API (系統 B / nas-monitor-interface) ===================== */
// 選填：若另外部署了 nas-monitor-interface (Flask 中介層)，設定 NAS_MONITOR_URL + NAS_MONITOR_API_KEY 即可
// 取得 Docker 管理、流量/儲存/溫度歷史、儲存滿載預測、警報等進階功能。未設定時全部回退展示資料。
const NASMON_URL = process.env.NAS_MONITOR_URL || null;
const NASMON_KEY = process.env.NAS_MONITOR_API_KEY || '';
const nasMonClient = NASMON_URL ? axios.create({
    baseURL: NASMON_URL.replace(/\/$/, ''),
    headers: { 'Accept': 'application/json', 'X-API-Key': NASMON_KEY, 'Authorization': `Bearer ${NASMON_KEY}` },
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 12000
}) : null;
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
    if (!nasMonConfigured()) return res.json({ ...fallback, source: 'fallback' });
    try {
        const data = await nasMonGet(path, params);
        res.json({ data, source: 'nas_monitor' });
    } catch (error) {
        res.json({ ...fallback, source: 'fallback_on_error', error: error.message });
    }
}

// 19. Docker 容器清單 (含即時 CPU/RAM)
app.get('/api/nas/docker', async (req, res) => {
    if (!nasMonConfigured()) return res.json({ containers: mockDockerContainers, source: 'fallback' });
    try {
        const data = await nasMonGet('/api/docker/containers');
        res.json({ containers: Array.isArray(data) ? data : (data.containers || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        res.json({ containers: mockDockerContainers, source: 'fallback_on_error', error: error.message });
    }
});

// 20. Docker 容器操作 (start / stop / restart)
app.post('/api/nas/docker/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (!nasMonConfigured()) {
        // 展示模式：直接改記憶體內狀態
        const c = mockDockerContainers.find(x => x.id === id || x.name === id);
        if (c) {
            c.state = action === 'stop' ? 'exited' : 'running';
            c.status = action === 'stop' ? 'Exited (0) just now' : 'Up 1 second';
            if (action === 'stop') { c.cpu_percent = 0; c.mem_usage_mb = 0; }
        }
        return res.json({ success: true, source: 'fallback' });
    }
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
        return res.json({
            logs: `[demo] ${req.params.id} 日誌 (未接 NAS Monitor)\n` +
                Array.from({ length: 12 }, (_, i) => `${new Date(Date.now() - i * 5000).toISOString()}  INFO  service tick #${1000 - i}`).join('\n'),
            source: 'fallback'
        });
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

// 23. 流量歷史
app.get('/api/nas/traffic-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    nasMonProxy(res, '/api/traffic/history', { hours }, { data: mockTrafficHistory(hours) });
});

// 24. 系統歷史 (CPU / 記憶體 / 溫度)
app.get('/api/nas/system-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    nasMonProxy(res, '/api/system/history', { hours }, { data: mockSystemHistory(hours) });
});

// 25. 溫度歷史 (風扇 RPM + 各硬碟溫度)
app.get('/api/nas/temperature-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    nasMonProxy(res, '/api/temperature/history', { hours }, { data: mockTemperatureHistory(hours) });
});

// 26. 儲存容量歷史
app.get('/api/nas/storage-history', (req, res) => {
    const hours = parseInt(req.query.hours || '720', 10);
    nasMonProxy(res, '/api/storage/history', { hours }, { data: mockStorageHistory(hours) });
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
    if (!nasMonConfigured()) return res.json({ events: mockAlertEvents, source: 'fallback' });
    try {
        const data = await nasMonGet('/api/alerts/events', { hours: req.query.hours || 24 });
        res.json({ events: Array.isArray(data) ? data : (data.events || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        res.json({ events: mockAlertEvents, source: 'fallback_on_error', error: error.message });
    }
});

// 30. 確認 (清除) 警報
app.post('/api/nas/alerts/:id/ack', async (req, res) => {
    if (!nasMonConfigured()) {
        const a = mockAlertEvents.find(x => x.id === req.params.id);
        if (a) a.acknowledged = true;
        return res.json({ success: true, source: 'fallback' });
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
    ['trendActiveSec', 'trendIdleSec', 'activeWindowSec', 'watcherSec', 'autoDefenseSec', 'reportHour'].forEach(k => {
        if (typeof b[k] === 'number' && b[k] >= 0) appSettings[k] = b[k];
    });
    if (typeof b.reportEnabled === 'boolean') appSettings.reportEnabled = b.reportEnabled;
    if (b.reportFreq === 'daily' || b.reportFreq === 'weekly') appSettings.reportFreq = b.reportFreq;
    saveAppSettings();
    scheduleServerJobs();   // 立即套用新的伺服器端間隔
    res.json({ ok: true, settings: appSettings });
});

/* ===================== 定期報表 ===================== */
// 彙整過去 24 小時的關鍵指標成一段文字
async function buildReport() {
    const lines = [];
    const dayAgo = Date.now() - 86400000;
    try {
        const cookie = await getLocalSession();
        const alarm = await unifiClient.get('/api/s/default/stat/alarm', { headers: { 'Cookie': cookie } });
        const threats = (alarm.data.data || []).filter(a => a.key === 'ips:alert' && new Date(a.datetime).getTime() >= dayAgo);
        lines.push(`🛡️ 24H 威脅攔截：${threats.length} 次`);
        const sta = await unifiClient.get('/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        lines.push(`📱 目前線上客戶端：${(sta.data.data || []).length} 台`);
    } catch { lines.push('🛡️ 威脅/客戶端：本地控制器未連線'); }
    const trends = loadTrends().filter(p => new Date(p.t).getTime() >= dayAgo);
    if (trends.length) {
        const lat = trends.map(p => p.latency).filter(v => v != null);
        if (lat.length) lines.push(`📶 平均 ISP 延遲：${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1)} ms`);
    }
    if (nasMonConfigured()) {
        try {
            const dt = await nasMonGet('/api/downtime', { days: 30 });
            const d = dt.data || dt; if (d && d.uptime_percent != null) lines.push(`💾 NAS 30 天正常運行率：${d.uptime_percent}%`);
        } catch { }
    }
    return lines.join('\n') || '（無可彙整的資料）';
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

// 健康檢查端點 (供 Docker healthcheck / 反向代理使用)
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Production Server listening on port ${PORT}`));
