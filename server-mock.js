const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { version: APP_VERSION } = require('./package.json');
const { ERROR_CODES } = require('./observability/error-codes');
const { createPanelSecurity } = require('./server/middleware/panel-security');
const { registerWiimCommandRoutes } = require('./server/routes/wiim-command-routes');
const writeInput = require('./server/policies/write-input-policy');
const queryInput = require('./server/policies/query-input-policy');
const { selectDockerActionTarget } = require('./server/policies/docker-action-policy');
const {
    BACKUP_MEDIA_TYPE,
    MAX_BACKUP_BYTES,
    BackupValidationError,
    createConfigBackupService
} = require('./server/services/config-backup');

const app = express();
app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    next();
});
const mockSecurity = createPanelSecurity({
    adminPassword: process.env.PANEL_PASSWORD,
    readonlyPassword: process.env.PANEL_READONLY_PASSWORD,
    readonlyUsername: process.env.PANEL_READONLY_USERNAME || 'readonly',
    requireAdminPassword: process.env.NODE_ENV === 'production',
    authCode: ERROR_CODES.API_AUTH_FAILED,
    rateLimitCode: ERROR_CODES.API_AUTH_RATE_LIMITED,
    authorizationCode: ERROR_CODES.API_AUTHORIZATION_FAILED,
    csrfCode: ERROR_CODES.API_CSRF_FAILED,
    originCode: ERROR_CODES.API_ORIGIN_FAILED
});
app.use(mockSecurity.authenticate);
app.get('/api/security/csrf', mockSecurity.csrf);
app.use(mockSecurity.protectWrites);
app.use('/api/config/restore', express.raw({ type: BACKUP_MEDIA_TYPE, limit: MAX_BACKUP_BYTES }));
app.use(express.json({ limit: '256kb', strict: true }));

function mockApiError(res, error, {
    status = 500,
    code = status === 400 ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
    publicMessage = status >= 500 ? 'Internal server error' : (error?.message || String(error))
} = {}) {
    return res.status(status).json({
        error: publicMessage,
        code,
        request_id: res.locals.requestId
    });
}

function validatedInput(res, parse) {
    try { return parse(); }
    catch (error) {
        if (!(error instanceof writeInput.InputValidationError)) throw error;
        mockApiError(res, error, {
            status: error.httpStatus,
            code: ERROR_CODES.API_VALIDATION_FAILED,
            publicMessage: error.message
        });
        return null;
    }
}

// 託管前端靜態網頁
app.use(express.static(path.join(__dirname, 'public')));

// 模擬變數
let mockClients = [
    { mac: "00:11:22:33:44:55", name: "Steven's MacBook Pro", ip: "192.168.1.100", is_wifi: true, wifi_signal: -54, rx_bytes: 104857600, tx_bytes: 52428800, blocked: false },
    { mac: "aa:bb:cc:dd:ee:ff", name: "Living Room Apple TV", ip: "192.168.1.102", is_wifi: false, wifi_signal: null, rx_bytes: 4194304000, tx_bytes: 104857600, blocked: false },
    { mac: "11:22:33:44:55:66", name: "Suspicious IoT Bulb", ip: "192.168.1.199", is_wifi: true, wifi_signal: -78, rx_bytes: 500000, tx_bytes: 120000, blocked: true }
];
let mockClientAliases = {};
let mockUiPreferences = {};

const MOCK_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smarthub-mock-backup-'));
fs.writeFileSync(path.join(MOCK_BACKUP_DIR, 'app-settings.json'), JSON.stringify({ source: 'mock' }), { mode: 0o600 });
const mockBackupDb = new Database(':memory:');
mockBackupDb.exec(`
    CREATE TABLE history (id INTEGER PRIMARY KEY, series TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE ups_events (id INTEGER PRIMARY KEY, start_ts INTEGER NOT NULL);
    CREATE TABLE block_history (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
    CREATE TABLE report_runs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
`);
const mockConfigBackupService = createConfigBackupService({
    dataDir: MOCK_BACKUP_DIR,
    envFile: path.join(MOCK_BACKUP_DIR, '.env'),
    appVersion: APP_VERSION,
    database: { backup: destination => mockBackupDb.backup(destination) }
});

let mockWiFi = [
    { _id: "wifi-1", name: "UniFi_Main_5G", enabled: true },
    { _id: "wifi-2", name: "UniFi_IoT_2.4G", enabled: true },
    { _id: "wifi-3", name: "UniFi_Guest_WiFi", enabled: false }
];

let mockThreats = [
    { id: "threat-1", datetime: new Date(Date.now() - 5000).toISOString(), src_ip: "185.220.101.5", src_country: "Germany", msg: "ET EXPLOIT Apache Struts RCE Attempt", port: "443/TCP", severity: "HIGH", category: "Web Exploit", target_ip: "192.168.1.102", target_device: "Living Room Apple TV", action_taken: "BLOCKED" },
    { id: "threat-2", datetime: new Date(Date.now() - 3600000).toISOString(), src_ip: "45.142.195.12", src_country: "Russia", msg: "ET SCAN SSH Brute Force Login Attempt", port: "22/TCP", severity: "HIGH", category: "Brute Force", target_ip: "192.168.1.1", target_device: "UCG-Ultra", action_taken: "BLOCKED" },
    { id: "threat-3", datetime: new Date(Date.now() - 1.5 * 86400000).toISOString(), src_ip: "193.201.224.32", src_country: "Ukraine", msg: "ET MALWARE Trojan.Win32.Generic Request", port: "80/TCP", severity: "HIGH", category: "Malware", target_ip: "192.168.1.100", target_device: "Steven's MacBook Pro", action_taken: "BLOCKED" },
    { id: "threat-4", datetime: new Date(Date.now() - 2.8 * 86400000).toISOString(), src_ip: "103.85.20.4", src_country: "China", msg: "ET SCAN Potential SSH Brute Force", port: "22/TCP", severity: "MEDIUM", category: "Scanner", target_ip: "192.168.1.1", target_device: "UCG-Ultra", action_taken: "BLOCKED" },
    { id: "threat-5", datetime: new Date(Date.now() - 5.5 * 86400000).toISOString(), src_ip: "182.23.40.101", src_country: "North Korea", msg: "ET DOS Malformed Packet Flooding", port: "53/UDP", severity: "HIGH", category: "DoS", target_ip: "192.168.1.1", target_device: "UCG-Ultra", action_taken: "BLOCKED" },
    { id: "threat-6", datetime: new Date(Date.now() - 12 * 86400000).toISOString(), src_ip: "80.12.94.55", src_country: "Iran", msg: "ET EXPLOIT Webmin Backdoor Attempt", port: "10000/TCP", severity: "HIGH", category: "Web Exploit", target_ip: "192.168.1.102", target_device: "Living Room Apple TV", action_taken: "BLOCKED" },
    { id: "threat-7", datetime: new Date(Date.now() - 22 * 86400000).toISOString(), src_ip: "91.240.118.4", src_country: "Russia", msg: "ET SCAN Portscan Detected", port: "0/ANY", severity: "LOW", category: "Scanner", target_ip: "192.168.1.102", target_device: "Living Room Apple TV", action_taken: "BLOCKED" }
];

let mockSites = [
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
    },
    {
        siteId: "guest-site-id",
        hostId: "default-host-id",
        meta: {
            desc: "Hsinchu Factory",
            gatewayMac: "70:a7:41:97:aa:bb",
            name: "hsinchu_fac",
            timezone: "Asia/Taipei"
        },
        statistics: {
            counts: {
                totalDevice: 12,
                offlineDevice: 1,
                wiredClient: 104,
                wifiClient: 180
            },
            ispInfo: {
                name: "FarEasTone (遠傳電信)",
                organization: "Far EasTone Telecommunications"
            },
            percentages: {
                wanUptime: 99.85
            }
        },
        permission: "admin",
        isOwner: true
    }
];

let mockCloudDevices = [
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
    },
    {
        id: "F4E2C6C23F15",
        mac: "F4E2C6C23F15",
        name: "Office-AP-U6-Pro",
        model: "U6-Pro",
        shortname: "U6PRO",
        ip: "192.168.1.10",
        status: "online",
        version: "6.6.73",
        productLine: "network"
    },
    {
        id: "F4E2C6C23F16",
        mac: "F4E2C6C23F16",
        name: "Warehouse-AP-AC-Mesh",
        model: "UAP-AC-Mesh",
        shortname: "UAPACM",
        ip: "192.168.1.12",
        status: "offline",
        version: "6.6.65",
        productLine: "network"
    }
];

let mockIspMetrics = {
    latency: 12.4,
    packetLoss: 0.00,
    downloadSpeedMbps: 294.5,
    uploadSpeedMbps: 98.2,
    ispName: "Chunghwa Telecom (中華電信)",
};

let mockHosts = [
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

let mockSdwanConfigs = [
    {
        id: "9304163b-680d-4de8-a7a0-7617e328911d",
        name: "Taipei-to-Hsinchu VPN",
        type: "sdwan-hbsp"
    }
];

// 1. 獲取硬體即時狀態
app.get('/api/hardware', (req, res) => {
    const cpuUsage = Math.floor(Math.random() * 25) + 15; // 15% - 40%
    const cpuTemp = Math.floor(Math.random() * 10) + 48; // 48 - 58 °C
    const memUsagePct = 54;
    
    const generateCoreUsage = (base) => Math.min(Math.max(base + Math.floor(Math.random() * 10 - 5), 1), 100);

    res.json({
        cpuTemp,
        cpuUsage,
        cores: [
            generateCoreUsage(cpuUsage), generateCoreUsage(cpuUsage),
            generateCoreUsage(cpuUsage), generateCoreUsage(cpuUsage)
        ],
        memUsagePct,
        memStr: `1.62 GB / 3.00 GB`,
        emmcUsagePct: 32,
        emmcStr: `5.12 GB / 16.00 GB`,
        uptime: 'System Active (Mock)',
        interfaces: [
            { name: "WAN (Port 5)", status: "connected", speed: "2.5 Gbps", rxRate: (Math.random() * 20 + 5).toFixed(1) + " Mbps", txRate: (Math.random() * 5 + 1).toFixed(1) + " Mbps" },
            { name: "LAN 1 (Port 1)", status: "connected", speed: "1 Gbps", rxRate: (Math.random() * 10).toFixed(1) + " Mbps", txRate: (Math.random() * 15).toFixed(1) + " Mbps" },
            { name: "LAN 2 (Port 2)", status: "disconnected", speed: "1 Gbps", rxRate: "0 Mbps", txRate: "0 Mbps" },
            { name: "LAN 3 (Port 3)", status: "connected", speed: "1 Gbps", rxRate: (Math.random() * 1.5).toFixed(1) + " Mbps", txRate: (Math.random() * 2).toFixed(1) + " Mbps" },
            { name: "LAN 4 (Port 4)", status: "disconnected", speed: "1 Gbps", rxRate: "0 Mbps", txRate: "0 Mbps" }
        ]
    });
});

const mockHardwareHistory = (() => {
    const points = [];
    const now = Date.now();
    for (let i = 2016; i >= 0; i--) { // 7 days @ 5 minutes
        const t = now - i * 300000;
        points.push({
            t: new Date(t).toISOString(),
            cpuTemp: +(52 + Math.sin(t / 7.2e6) * 4 + Math.random()).toFixed(1),
            cpuUsage: +(25 + Math.sin(t / 3.6e6) * 8 + Math.random() * 5).toFixed(1),
            memUsagePct: +(54 + Math.sin(t / 2.16e7) * 3).toFixed(1)
        });
    }
    return points;
})();
app.get('/api/hardware/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ data: mockHardwareHistory.filter(point => new Date(point.t).getTime() >= cutoff), source: 'mock' });
});

// 2. 獲取活躍客戶端
app.get('/api/clients', (req, res) => {
    // 模擬流量稍微增加
    mockClients.forEach(c => {
        if (!c.blocked) {
            c.rx_bytes += Math.floor(Math.random() * 1000000);
            c.tx_bytes += Math.floor(Math.random() * 200000);
        }
    });
    res.json({
        clients: mockClients.map(client => {
            const alias = mockClientAliases[client.mac.toLowerCase()];
            return {
                ...client,
                name: alias || client.name,
                aliased: !!alias,
                original_name: client.name
            };
        })
    });
});

app.get('/api/network/switches', (_req, res) => res.json({
    source: 'mock',
    devices: [{
        name: 'USW-Lite-8-PoE', type: 'usw', model: 'USW-Lite-8-PoE',
        ports: [
            { port_idx: 1, up: true, is_uplink: true, poe: false, speedMbps: 1000, rxMbps: 18.4, txMbps: 4.2, client: { name: 'UCG-Ultra' } },
            { port_idx: 2, up: true, is_uplink: false, poe: true, speedMbps: 1000, rxMbps: 6.8, txMbps: 1.7, client: { name: 'U7-Pro' } },
            { port_idx: 3, up: true, is_uplink: false, poe: false, speedMbps: 1000, rxMbps: 12.1, txMbps: 8.3, client: { name: 'UGREEN-NAS' } },
            { port_idx: 4, up: false, is_uplink: false, poe: false, speedMbps: 0, rxMbps: 0, txMbps: 0, client: null },
            { port_idx: 5, up: true, is_uplink: false, poe: false, speedMbps: 1000, rxMbps: 2.4, txMbps: 1.1, client: { name: 'WiiM-Amp' } },
            { port_idx: 6, up: false, is_uplink: false, poe: false, speedMbps: 0, rxMbps: 0, txMbps: 0, client: null },
            { port_idx: 7, up: false, is_uplink: false, poe: false, speedMbps: 0, rxMbps: 0, txMbps: 0, client: null },
            { port_idx: 8, up: false, is_uplink: false, poe: false, speedMbps: 0, rxMbps: 0, txMbps: 0, client: null }
        ]
    }]
}));

app.get('/api/ui-preferences', (_req, res) => res.json({ preferences: mockUiPreferences }));
app.post('/api/ui-preferences', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseUiPreferences(req.body));
    if (!input) return;
    Object.assign(mockUiPreferences, input);
    res.json({ ok: true, preferences: mockUiPreferences });
});

app.get('/api/client-aliases', (_req, res) => res.json({ aliases: mockClientAliases }));
app.post('/api/client-aliases', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAlias(req.body));
    if (!input) return;
    if (input.name) mockClientAliases[input.mac] = input.name;
    else delete mockClientAliases[input.mac];
    res.json({ ok: true, aliases: mockClientAliases });
});

// 3. 獲取 SSID 列表
app.get('/api/wifi-networks', (req, res) => {
    res.json({ networks: mockWiFi });
});

// 4. 控制 SSID 狀態
app.put('/api/wifi-networks/:id', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseWifiUpdate(req.params.id, req.body));
    if (!input) return;
    const net = mockWiFi.find(n => n._id === input.id);
    if (net) {
        net.enabled = input.enabled;
    }
    res.json({ success: true });
});

// 5. 獲取 IPS/IDS 威脅警報
app.get('/api/threats', (req, res) => {
    // 偶爾隨機增加一個威脅警報以展示雷達動態效果
    if (Math.random() > 0.8) {
        const randomIps = ["8.8.8.8", "193.201.224.32", "91.241.19.84", "185.156.74.58"];
        const countries = ["USA", "Ukraine", "China", "Netherlands"];
        const msgs = [
            "ET SCAN Potential SSH Scan OUTBOUND",
            "ET MALWARE Trojan.Win32.Generic Request",
            "ET WEB_SPECIFIC_APPS Drupal Drupalgeddon RCE",
            "ET DOS DNS Amplification Attack"
        ];
        const categories = ["Scanner", "Malware", "Web Exploit", "DoS"];
        const targetIps = ["192.168.1.100", "192.168.1.102", "192.168.1.1", "192.168.1.199"];
        const targetDevices = ["Steven's MacBook Pro", "Living Room Apple TV", "UCG-Ultra", "Suspicious IoT Bulb"];
        
        const index = Math.floor(Math.random() * randomIps.length);
        mockThreats.unshift({
            id: `threat-${Date.now()}`,
            datetime: new Date().toISOString(),
            src_ip: randomIps[index],
            src_country: countries[index],
            msg: msgs[Math.floor(Math.random() * msgs.length)],
            port: index % 2 === 0 ? "80/TCP" : "443/TCP",
            severity: "HIGH",
            category: categories[Math.floor(Math.random() * categories.length)],
            target_ip: targetIps[index],
            target_device: targetDevices[index],
            action_taken: "BLOCKED"
        });
        if (mockThreats.length > 30) mockThreats.pop();
    }
    res.json({ threats: mockThreats });
});

// 封鎖歷史紀錄 (記憶體內模擬)
let mockBlockHistory = [
    { datetime: new Date(Date.now() - 2 * 86400000).toISOString(), mac: "11:22:33:44:55:66", name: "Suspicious IoT Bulb", action: "block", source: "manual" }
];

// 6. 客戶端限速/阻斷控制
app.put('/api/device/restrict', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseDeviceRestriction(req.body));
    if (!input) return;
    const client = mockClients.find(c => c.mac === input.deviceId);
    if (client) {
        client.blocked = input.blockState;
    }
    mockBlockHistory.unshift({
        datetime: new Date().toISOString(),
        mac: input.deviceId,
        name: input.deviceName || (client && client.name) || 'Unknown Device',
        action: input.blockState ? 'block' : 'unblock',
        source: 'manual'
    });
    res.json({ success: true });
});

// 6-1. 封鎖歷史時間軸
app.get('/api/block-history', (req, res) => {
    res.json({ history: mockBlockHistory });
});

// 7. PoE Port 斷電重啟
app.post('/api/poe/power-cycle', (req, res) => {
    const input = validatedInput(res, () => writeInput.parsePoePowerCycle(req.body));
    if (!input) return;
    res.json({ success: true });
});

// 8. 觸發測速 (模擬：8 秒後產生結果)
let mockSpeedtestStart = 0;
app.post('/api/speedtest', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body));
    if (!input) return;
    mockSpeedtestStart = Date.now();
    res.json({ success: true });
});

// 8-1. 查詢測速狀態與結果
app.get('/api/speedtest/status', (req, res) => {
    const elapsed = Date.now() - mockSpeedtestStart;
    if (mockSpeedtestStart && elapsed < 8000) {
        return res.json({ status: 'running', ping: null, download: null, upload: null, lastRun: null });
    }
    res.json({
        status: 'idle',
        ping: 4.2,
        download: 291.8 + Math.random() * 10,
        upload: 97.4 + Math.random() * 3,
        lastRun: mockSpeedtestStart ? new Date(mockSpeedtestStart + 8000).toISOString() : new Date(Date.now() - 3600000).toISOString()
    });
});

// 9. 獲取雲端站點清單
app.get('/api/cloud/sites', (req, res) => {
    res.json({ data: mockSites, source: 'fallback' });
});

// 10. 獲取雲端託管設備清單
app.get('/api/cloud/devices', (req, res) => {
    res.json({ data: mockCloudDevices, source: 'fallback' });
});

// 11. 獲取 ISP 效能數據指標
app.get('/api/cloud/isp-metrics', (req, res) => {
    // 隨機微調數值增加真實感
    const latencyVal = (12 + Math.random() * 2).toFixed(1);
    res.json({
        data: {
            ...mockIspMetrics,
            latency: parseFloat(latencyVal)
        },
        source: 'fallback'
    });
});

// 12. 獲取雲端控制台主機清單
app.get('/api/cloud/hosts', (req, res) => {
    res.json({ data: mockHosts, source: 'fallback' });
});

// 13. 獲取 SD-WAN VPN 配置清單
app.get('/api/cloud/sdwan', (req, res) => {
    res.json({ data: mockSdwanConfigs, source: 'fallback' });
});

// 資安設定與自動防禦 (模擬)
let mockSecSettings = { autoDefense: false };
app.get('/api/security/settings', (req, res) => res.json(mockSecSettings));
app.post('/api/security/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseSingleBoolean(req.body, 'autoDefense'));
    if (!input) return;
    mockSecSettings.autoDefense = input.autoDefense;
    res.json(mockSecSettings);
});

const INFECTION_KEYWORDS = ['MALWARE', 'TROJAN', 'BOTNET', 'CNC', 'COINMINER', 'RANSOMWARE', 'BACKDOOR'];
setInterval(() => {
    if (!mockSecSettings.autoDefense) return;
    const recent = mockThreats.filter(t => Date.now() - new Date(t.datetime).getTime() < 10 * 60 * 1000);
    for (const t of recent) {
        const msg = (t.msg || '').toUpperCase();
        if (!INFECTION_KEYWORDS.some(k => msg.includes(k))) continue;
        const victim = mockClients.find(c => c.ip === t.target_ip && !c.blocked);
        if (victim) {
            victim.blocked = true;
            mockBlockHistory.unshift({
                datetime: new Date().toISOString(),
                mac: victim.mac,
                name: victim.name,
                action: 'block',
                source: 'auto',
                reason: t.msg
            });
        }
    }
}, 10 * 1000);

// 14. 歷史趨勢 (先合成一段歷史打底，之後用自適應頻率即時追加)
const TREND_LIMIT = 9999;
const synthPoint = (t) => {
    const hour = new Date(t).getHours();
    const dayFactor = Math.sin((hour - 6) / 24 * Math.PI * 2) * 0.5 + 0.5;
    return {
        t: new Date(t).toISOString(),
        clients: Math.round(45 + dayFactor * 30 + Math.random() * 5),
        threats24h: Math.round(4 + dayFactor * 4 + Math.random() * 2),
        latency: parseFloat((11 + dayFactor * 4 + Math.random() * 2).toFixed(1))
    };
};
let mockTrendHistory = (() => {
    const points = [];
    const now = Date.now();
    for (let i = 2016; i >= 0; i--) points.push(synthPoint(now - i * 5 * 60 * 1000));
    return points;
})();

// 自適應取樣：依正式後端預設值，有前端活躍時每 30 秒、閒置時每 30 分鐘。
let lastClientActivity = 0, lastSampleTs = 0;
let ACTIVE_SAMPLE_MS = 30000, IDLE_SAMPLE_MS = 30 * 60 * 1000, ACTIVE_WINDOW_MS = 30000;
setInterval(() => {
    const now = Date.now();
    const active = (now - lastClientActivity) < ACTIVE_WINDOW_MS;
    if (now - lastSampleTs >= (active ? ACTIVE_SAMPLE_MS : IDLE_SAMPLE_MS)) {
        lastSampleTs = now;
        mockTrendHistory.push(synthPoint(now));
        if (mockTrendHistory.length > TREND_LIMIT) mockTrendHistory = mockTrendHistory.slice(-TREND_LIMIT);
    }
}, 1000);

app.get('/api/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    lastClientActivity = Date.now();
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ history: mockTrendHistory.filter(p => new Date(p.t).getTime() >= cutoff) });
});

app.get('/api/heartbeat', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHeartbeatQuery(req.query));
    if (!query) return;
    lastClientActivity = Date.now();
    res.json({ ok: true, mode: 'active', activeScopes: query.scopes, promptScopes: [] });
});

// 15-18. UGREEN NAS 模擬端點
app.get('/api/nas/overview', (req, res) => {
    res.json({
        info: { model: 'UGREEN DXP4800 Plus', firmware_version: 'UGOS Pro 1.4.0.2333', cpu_model: 'Intel N100 (4C/4T)', device_name: 'UGREEN-NAS-HQ' },
        stats: {
            cpu: { usage: Math.round(8 + Math.random() * 10), temperature: Math.round(41 + Math.random() * 5) },
            memory: { usage: 38, total_mb: 8192, used_mb: 3112 },
            network: { upload_bps: Math.round(2e6 + Math.random() * 2e6), download_bps: Math.round(8e6 + Math.random() * 8e6) }
        },
        source: 'fallback'
    });
});

app.get('/api/nas/sleep-stats', (req, res) => {
    res.json({ days: [], awakeSessions: [], source: 'mock' });
});
app.get('/api/nas/disks', (req, res) => {
    res.json({
        disks: [
            { slot: 1, name: 'WD Red Plus 4TB', model: 'WD40EFPX', temperature: 38, status: 'Good', size_gb: 4000 },
            { slot: 2, name: 'WD Red Plus 4TB', model: 'WD40EFPX', temperature: 39, status: 'Good', size_gb: 4000 },
            { slot: 3, name: 'Seagate IronWolf 8TB', model: 'ST8000VN004', temperature: 41, status: 'Good', size_gb: 8000 }
        ],
        source: 'fallback'
    });
});
app.get('/api/nas/volumes', (req, res) => {
    res.json({
        volumes: [{ name: '存儲空間 1', fs: 'Btrfs', raid: 'RAID 5', total_gb: 7451, used_gb: 3120, status: 'normal' }],
        source: 'fallback'
    });
});
app.get('/api/nas/ups', (req, res) => {
    res.json({
        ups: { present: true, model: 'APC Back-UPS 700VA', battery_percent: 100, runtime_min: 42, status: 'online' },
        source: 'fallback'
    });
});

app.get('/api/nas/ups-usb', (req, res) => res.json({ present: true, source: 'fallback' }));

/* ===== NAS Monitor 系統 B 模擬端點 ===== */
function mSeries(hours, stepMin, gen) {
    const arr = [], now = Date.now(), step = stepMin * 60000, n = Math.floor(hours * 60 / stepMin);
    for (let i = n; i >= 0; i--) arr.push(gen(new Date(now - i * step), i));
    return arr;
}
let mockDocker = [
    { id: 'a'.repeat(64), name: 'jellyfin', image: 'jellyfin/jellyfin:latest', state: 'running', status: 'Up 3 days', cpu_percent: 4.2, mem_usage_mb: 512, mem_limit_mb: 2048, logs_allowed: true },
    { id: 'b'.repeat(64), name: 'qbittorrent', image: 'linuxserver/qbittorrent', state: 'running', status: 'Up 3 days', cpu_percent: 1.1, mem_usage_mb: 210, mem_limit_mb: 1024, logs_allowed: true },
    { id: 'c'.repeat(64), name: 'homeassistant', image: 'homeassistant/home-assistant', state: 'running', status: 'Up 5 days', cpu_percent: 2.8, mem_usage_mb: 380, mem_limit_mb: 1024, logs_allowed: true },
    { id: 'd'.repeat(64), name: 'nginx-proxy-manager', image: 'jc21/nginx-proxy-manager', state: 'running', status: 'Up 5 days', cpu_percent: 0.3, mem_usage_mb: 96, mem_limit_mb: 512, logs_allowed: true },
    { id: 'e'.repeat(64), name: 'immich-server', image: 'ghcr.io/immich-app/immich', state: 'exited', status: 'Exited (0) 2 hours ago', cpu_percent: 0, mem_usage_mb: 0, mem_limit_mb: 2048, logs_allowed: true }
];
let mockAlerts = [
    { id: 'al-1', datetime: new Date(Date.now() - 3600000).toISOString(), metric: 'disk_temperature', level: 'warning', message: 'Seagate IronWolf 8TB 溫度達 48°C (閾值 45°C)', acknowledged: false },
    { id: 'al-2', datetime: new Date(Date.now() - 6 * 3600000).toISOString(), metric: 'cpu_usage', level: 'info', message: 'CPU 使用率短暫達 82% (備份任務)', acknowledged: true },
    { id: 'al-3', datetime: new Date(Date.now() - 26 * 3600000).toISOString(), metric: 'volume_usage', level: 'critical', message: '存儲空間 1 使用率超過 85%', acknowledged: false }
];
let mockAlertConfig = [
    { metric: 'disk_temperature', threshold: 50, condition: 'above', enabled: true },
    { metric: 'volume_usage', threshold: 85, condition: 'above', enabled: true }
];
app.get('/api/nas/docker', (req, res) => {
    mockDocker.forEach(c => {
        if (c.state === 'running') c.cpu_percent = +(Math.random() * 5).toFixed(1);
        c.allowed_actions = c.state === 'running' ? ['restart', 'stop'] : ['start'];
    });
    res.json({ containers: mockDocker, total: mockDocker.length, truncated: false, actionsEnabled: true, source: 'fallback' });
});
app.post('/api/nas/docker/:id/:action', (req, res) => {
    const input = validatedInput(res, () => ({
        id: writeInput.identifierValue(req.params.id, { field: 'id', max: 128 }),
        action: writeInput.enumValue(req.params.action, ['start', 'stop', 'restart'], 'action'),
        ...writeInput.parseEmptyBody(req.body)
    }));
    if (!input) return;
    mockDocker.forEach(c => { c.allowed_actions = c.state === 'running' ? ['restart', 'stop'] : ['start']; });
    let target;
    try { target = selectDockerActionTarget({ containers: mockDocker }, input.id, input.action); }
    catch (error) { return mockApiError(res, error, { status: 403, code: ERROR_CODES.API_AUTHORIZATION_FAILED, publicMessage: 'docker_action_not_allowed' }); }
    const c = mockDocker.find(x => x.id === target.id);
    if (c) {
        c.state = input.action === 'stop' ? 'exited' : 'running';
        c.status = input.action === 'stop' ? 'Exited (0) just now' : 'Up 1 second';
        if (input.action === 'stop') { c.cpu_percent = 0; c.mem_usage_mb = 0; } else if (!c.mem_usage_mb) c.mem_usage_mb = 128;
        c.allowed_actions = c.state === 'running' ? ['restart', 'stop'] : ['start'];
    }
    res.json({ success: true, source: 'fallback' });
});
app.get('/api/nas/docker/:id/logs', mockSecurity.requireAdmin, (req, res) => {
    const input = validatedInput(res, () => ({
        id: queryInput.safePathIdentifierValue(req.params.id, { field: 'id', max: 128 }),
        ...queryInput.parseDockerLogsQuery(req.query)
    }));
    if (!input) return;
    const count = Math.min(input.lines, 100);
    res.json({ logs: `[demo] ${input.id} 日誌\n` + Array.from({ length: count }, (_, i) => `${new Date(Date.now() - i * 5000).toISOString()}  INFO  service tick #${1000 - i}`).join('\n'), source: 'fallback' });
});
app.get('/api/nas/traffic-summary', (req, res) => res.json({ data: { today_gb: 42.6, week_gb: 318.2, month_gb: 1240.7, today_up_gb: 8.1, today_down_gb: 34.5 }, source: 'fallback' }));
app.get('/api/nas/traffic-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const { hours } = query;
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), upload_mbps: +(2 + f * 12 + Math.random() * 3).toFixed(1), download_mbps: +(5 + f * 40 + Math.random() * 8).toFixed(1) }; }), source: 'fallback' });
});
app.get('/api/nas/system-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const { hours } = query;
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), cpu: Math.round(8 + f * 30 + Math.random() * 6), memory: Math.round(34 + f * 10 + Math.random() * 4), temperature: Math.round(40 + f * 6 + Math.random() * 2) }; }), source: 'fallback' });
});
app.get('/api/nas/temperature-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const { hours } = query;
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), fan_rpm: Math.round(900 + f * 500), disk1: Math.round(36 + f * 4), disk2: Math.round(37 + f * 4), disk3: Math.round(39 + f * 5) }; }), source: 'fallback' });
});
app.get('/api/nas/storage-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query, { defaultValue: 720 }));
    if (!query) return;
    const { hours } = query;
    res.json({ data: mSeries(hours, 720, (d, i) => ({ t: d.toISOString(), used_gb: Math.round(3120 - i * 6 + Math.random() * 4), total_gb: 7451 })), source: 'fallback' });
});
app.get('/api/nas/storage-forecast', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryDaysQuery(req.query));
    if (!query) return;
    res.json({ data: { days_until_full: 512, daily_growth_gb: 6.2, projected_full_date: new Date(Date.now() + 512 * 86400000).toISOString().slice(0, 10), current_used_percent: 42 }, source: 'fallback' });
});
app.get('/api/nas/downtime', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryDaysQuery(req.query));
    if (!query) return;
    res.json({ data: { uptime_percent: 99.97, downtime_events: 1, last_downtime: new Date(Date.now() - 12 * 86400000).toISOString(), total_downtime_min: 13 }, source: 'fallback' });
});
app.get('/api/nas/alerts', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseNasAlertsQuery(req.query));
    if (!query) return;
    res.json({ events: mockAlerts, source: 'fallback' });
});
app.post('/api/nas/alerts/:id/ack', (req, res) => {
    const input = validatedInput(res, () => ({
        id: writeInput.identifierValue(req.params.id, { field: 'id', max: 128 }),
        ...writeInput.parseEmptyBody(req.body)
    }));
    if (!input) return;
    const a = mockAlerts.find(x => x.id === input.id);
    if (a) a.acknowledged = true;
    res.json({ success: true, source: 'fallback' });
});
app.get('/api/nas/alerts/config', (_req, res) => res.json({ config: mockAlertConfig, source: 'fallback' }));
app.post('/api/nas/alerts/config', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAlertConfig(req.body));
    if (!input) return;
    const index = mockAlertConfig.findIndex(config => config.metric === input.metric);
    if (index >= 0) mockAlertConfig[index] = input;
    else mockAlertConfig.push(input);
    res.json({ ok: true, data: input, source: 'fallback' });
});
app.delete('/api/nas/alerts/config/:metric', (req, res) => {
    const input = validatedInput(res, () => ({
        metric: writeInput.identifierValue(req.params.metric, {
            field: 'metric', max: 64, pattern: /^[A-Za-z][A-Za-z0-9._:-]*$/u
        }),
        ...writeInput.parseEmptyBody(req.body)
    }));
    if (!input) return;
    mockAlertConfig = mockAlertConfig.filter(config => config.metric !== input.metric);
    res.json({ ok: true, source: 'fallback' });
});

/* ===== 通知推播中心 (模擬) ===== */
let mockNotif = {
    enabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', telegramCommandsEnabled: false,
    triggerThreats: true, triggerNasAlerts: true, triggerWiimTemp: true, triggerUpsOutage: true, triggerUpsLowBatt: true,
    triggerNewClient: false, triggerClientIpChange: false, triggerClientWeakSignal: false, triggerClientConnectivity: false, clientSignalAlert: 75,
    triggerNetworkDeviceOffline: false, triggerWifiSsidChange: false, triggerUnifiUpgrade: false, triggerCloudOffline: false,
    triggerWiimOffline: false, triggerWiimHighVolume: false, triggerWiimPlaybackChange: false, wiimVolumeAlert: 80, triggerBlockAction: true,
    triggerNasDiskTemp: false, nasDiskTempAlert: 50, triggerNasSpace: false, nasSpaceAlert: 85, triggerNasDiskHealth: true, triggerNasOffline: false, triggerNasHighCpu: false, nasCpuAlert: 90, triggerNasHighMemory: false, nasMemoryAlert: 90,
    triggerUcgTemp: false, ucgTempAlert: 75, triggerUcgHighCpu: false, ucgCpuAlert: 90, triggerUcgHighMemory: false, ucgMemoryAlert: 90, triggerUcgDisk: false, ucgDiskAlert: 85,
    triggerWanDown: false, triggerWanLatency: false, wanLatencyAlert: 100, triggerUnifiOffline: false, triggerNasLog: true, triggerNasSleepWake: false,
    triggerUpsHighLoad: false, upsLoadAlert: 80, triggerUpsLowRuntime: false, upsRuntimeAlertMin: 10, triggerUpsVoltAbnormal: false, upsVoltDeviationPct: 10, triggerUpsSourceChange: false, triggerUpsOffline: true,
    triggerAdgProtection: true, triggerAdgOffline: false, triggerAdgHighBlockRate: false, adgBlockRateAlert: 50,
    triggerLinuxTemp: true, linuxTempAlert: 70, triggerLinuxOffline: false, triggerLinuxDisk: false, linuxDiskAlert: 90, triggerLinuxHighCpu: false, linuxCpuAlert: 90, triggerLinuxHighMemory: false, linuxMemoryAlert: 90, triggerLinuxHighLoad: false, linuxLoadAlert: 4,
    triggerDockerCriticalLog: true, triggerDockerErrorLog: false, triggerDockerState: true, triggerDockerHealth: true, triggerDockerRestart: true, triggerDockerInventory: false, triggerDockerOom: true, triggerDockerHighCpu: false, dockerCpuAlert: 90, triggerDockerHighMemory: false, dockerMemoryAlert: 90,
    triggerSystemCritical: true, triggerSystemWarning: false, triggerSystemRecovery: true, triggerSystemStartup: false
};
let mockNotifLog = [];
function pushMockNotif(e) { mockNotifLog.unshift(e); mockNotifLog = mockNotifLog.slice(0, 50); }
app.get('/api/notifications/settings', (req, res) => {
    const { webhookUrl, botToken, ...safe } = mockNotif;
    res.json({ ...safe, webhookUrlSet: !!webhookUrl, botTokenSet: !!botToken });
});
app.post('/api/notifications/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseNotificationSettings(req.body));
    if (!input) return;
    Object.assign(mockNotif, input);
    res.json({ ok: true });
});
app.post('/api/notifications/test', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body));
    if (!input) return;
    // 展示模式：模擬送出成功 (需先啟用且已填目標)
    if (!mockNotif.enabled) return res.json({ skipped: 'disabled' });
    const configured = mockNotif.channel === 'telegram' ? (mockNotif.botToken && mockNotif.chatId) : mockNotif.webhookUrl;
    const entry = { ts: new Date().toISOString(), title: '🔔 SmartHub 測試通知', body: `測試訊息 ${new Date().toLocaleString('zh-TW')}`, channel: mockNotif.channel, ok: !!configured };
    if (!configured) entry.error = '尚未填寫推播目標';
    pushMockNotif(entry);
    res.json(entry.ok ? { ok: true } : { ok: false, error: entry.error });
});
app.get('/api/notifications/log', (req, res) => res.json({ log: mockNotifLog }));
// 模擬：啟用後每 25 秒模擬推播一則新威脅通知，讓預覽的紀錄會累積
setInterval(() => {
    if (!mockNotif.enabled || !mockNotif.triggerThreats) return;
    const configured = mockNotif.channel === 'telegram' ? (mockNotif.botToken && mockNotif.chatId) : mockNotif.webhookUrl;
    const t = mockThreats[0];
    if (t) pushMockNotif({ ts: new Date().toISOString(), title: '🛡️ IPS 攔截新威脅', body: `來源 ${t.src_ip} (${t.src_country})\n${t.msg}`, channel: mockNotif.channel, ok: !!configured });
}, 25000);

/* ===== 應用程式設定 (模擬) ===== */
const MOCK_APP_SETTING_RANGES = {
    trendActiveSec: [5, 3600], trendIdleSec: [60, 86400], activeWindowSec: [5, 3600],
    watcherSec: [5, 3600], autoDefenseSec: [5, 3600], reportHour: [0, 23], reportHour2: [0, 23],
    upsSampleSec: [5, 3600], wiimCpuAlert: [1, 120], wiimBoardAlert: [1, 120],
    toastSec: [1, 60], historyFlushMin: [1, 60], historyKeepDays: [1, 365]
};
let mockAppSettings = {
    trendActiveSec: 30, trendIdleSec: 1800, activeWindowSec: 30, watcherSec: 20,
    toastSec: 10, autoDefenseSec: 30, reportEnabled: true, reportFreq: 'daily',
    reportHour: 8, reportHour2: 20, upsSampleSec: 30, wiimCpuAlert: 70,
    wiimBoardAlert: 60, historyFlushMin: 10, historyKeepDays: 30
};
app.get('/api/settings', (req, res) => res.json(mockAppSettings));
app.post('/api/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAppSettings(req.body, MOCK_APP_SETTING_RANGES));
    if (!input) return;
    Object.assign(mockAppSettings, input);
    // 套用新的趨勢取樣間隔
    ACTIVE_SAMPLE_MS = mockAppSettings.trendActiveSec * 1000;
    IDLE_SAMPLE_MS = mockAppSettings.trendIdleSec * 1000;
    ACTIVE_WINDOW_MS = mockAppSettings.activeWindowSec * 1000;
    res.json({ ok: true, settings: mockAppSettings });
});

let mockReportLog = [];
function pushMockReport(entry) { mockReportLog.unshift(entry); mockReportLog = mockReportLog.slice(0, 20); }
app.post('/api/reports/run', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body));
    if (!input) return;
    const cpus = mockWiimHistory.map(h => h.cpu).filter(v => v !== null);
    const boards = mockWiimHistory.map(h => h.board).filter(v => v !== null);
    let wiimLine = '';
    if (cpus.length && boards.length) {
        const maxCpu = Math.max(...cpus).toFixed(1);
        const avgCpu = (cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(1);
        const maxBoard = Math.max(...boards).toFixed(1);
        const avgBoard = (boards.reduce((a, b) => a + b, 0) / boards.length).toFixed(1);
        wiimLine = `\n🔊 WiiM Amp 狀態：24H 均溫 CPU ${avgCpu}°C (最高 ${maxCpu}°C) / 主板 ${avgBoard}°C (最高 ${maxBoard}°C)`;
    }
    const body = [`📊 SmartHub 每日摘要 · ${new Date().toLocaleString('zh-TW')}`, `🛡️ 資安與網路\n• 24H 威脅攔截：${mockThreats.filter(t => Date.now() - new Date(t.datetime).getTime() < 86400000).length} 次\n• 線上客戶端：${mockClients.length} 台\n• ISP 延遲：13.2 ms`, `💾 儲存與容器\n• NAS 30 天正常運行率：99.97%\n• Docker 容器：3/3 運行中，健康檢查正常\n• Docker 近期嚴重/錯誤 Log：無`, `⚙️ SmartHub\n• 系統診斷：Healthy · 背景工作正常`].join('\n\n') + wiimLine;
    if (mockNotif.enabled) pushMockNotif({ ts: new Date().toISOString(), title: '📊 SmartHub 報表 (手動觸發)', body, channel: mockNotif.channel, ok: true });
    const delivery = mockNotif.enabled ? { ok: true } : { skipped: 'disabled' };
    pushMockReport({ id: Date.now(), ts: new Date().toISOString(), trigger: 'manual', title: '📊 SmartHub 報表 (手動觸發)', deliveryStatus: delivery.ok ? 'sent' : 'skipped:disabled', channel: delivery.ok ? mockNotif.channel : null, body });
    res.json({ report: body, delivery });
});
app.get('/api/reports/log', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseReportLogQuery(req.query));
    if (!query) return;
    res.json({ runs: mockReportLog.slice(0, query.limit) });
});

const PWA_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0b1220"/><g fill="none" stroke="#3b82f6" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M96 40L44 66l52 26 52-26-52-26z"/><path d="M44 126l52 26 52-26M44 96l52 26 52-26"/></g></svg>');
app.get('/manifest.webmanifest', (req, res) => res.json({
    name: 'SmartHub 戰情室', short_name: 'SmartHub', start_url: '/', display: 'standalone',
    background_color: '#030712', theme_color: '#030712', orientation: 'portrait-primary',
    icons: [{ src: PWA_ICON, sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' }, { src: PWA_ICON, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }]
}));
app.get('/sw.js', (req, res) => res.type('application/javascript').send(`
const C='smarthub-v1';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['/'])))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/health'))return;e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));});`));

// --- WiiM Amp Mock Endpoints & Background Polling ---
let mockWiimHistory = [];

function pollMockWiimTemp() {
    const cpu = parseFloat((45 + Math.random() * 8).toFixed(1));
    const board = parseFloat((38 + Math.random() * 5).toFixed(1));
    const ts = Math.floor(Date.now() / 1000);
    mockWiimHistory.push({ ts, cpu, board });
    if (mockWiimHistory.length > 5000) mockWiimHistory.shift();
}
pollMockWiimTemp();
setInterval(pollMockWiimTemp, 10000);

app.get('/api/wiim/history', (req, res) => {
    res.json({
        interval: 10,
        cpu_alert: 70,
        board_alert: 60,
        data: mockWiimHistory
    });
});

app.get('/api/wiim/status', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseWiimStatusQuery(req.query));
    if (!query) return;
    const { type } = query;
    const out = {};
    if (type === 'all' || type === 'play') {
        out.player = {
            type: 0, ch: 0, mode: 10, status: "play", vol: 35, mute: 0, eq: 0,
            curpos: 45000 + Math.floor(Math.random() * 1000), totlen: 240000
        };
        out.meta = {
            metaData: {
                title: "Mock WiiM Streaming Track",
                artist: "WiiM Amp Renderer",
                album: "SmartHub Album",
                albumArtURI: "",
                sampleRate: 44100, bitDepth: 16
            }
        };
    }
    if (type === 'all' || type === 'status') {
        out.status = {
            DeviceName: "WiiM Amp Testbed",
            firmware: "4.8.618254",
            hardware: "WiiM Amp",
            temperature_cpu: 48.5,
            temperature_tmp102: 40.2,
            bt_remote_bat: "85",
            bt_remote_rssi: "-65",
            bt_remote_mac: "00:E0:4C:12:34:56",
            bt_remote_status: "connected"
        };
    }
    res.json({
        ...out,
        ip: "192.168.0.170"
    });
});

app.get('/api/wiim/art', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseWiimArtQuery(req.query));
    if (!query) return;
    res.status(404).end();
});

// 查詢型指令回擬真 JSON，其餘回 OK；production/mock 共用同一 allowlist 與 method contract。
const mockWiimCommandResults = {
        getStatusEx: { DeviceName: 'WiiM Amp Testbed', firmware: '4.8.618254', hardware: 'AmlogicA113', project: 'WiiM_Amp', PCB_version: '2', MAC: '00:22:6C:AA:BB:CC', uuid: 'FF31F09E-MOCK', netstat: 2, date: '2026:07:10', time: '09:30:00' },
        getStaticIpInfo: { wlanStaticIpEnable: 0, wlanStaticIp: '', wlanGateWay: '192.168.0.1', wlanDnsServer: '8.8.8.8' },
        EQGetStat: { EQStat: 'On' },
        EQGetList: ['Flat', 'Rock', 'Jazz', 'Classical', 'Vocal', 'Bass Booster'],
        getPresetInfo: { preset_num: 3, preset_list: [{ number: 1, name: 'KISS Radio' }, { number: 2, name: 'Jazz24' }, { number: 3, name: '晚安歌單' }] },
        getShutdown: 0,
        getbtpairstatus: { result: 3 },
        'Squeezelite:getState': { state: 'stopped', discover_list: [] },
        wlanGetConnectState: 'OK'
};
registerWiimCommandRoutes(app, {
    execute: async command => {
        const value = mockWiimCommandResults[command];
        return value == null ? 'OK' : (typeof value === 'string' ? value : JSON.stringify(value));
    }
});

app.delete('/api/wiim/history', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body));
    if (!input) return;
    mockWiimHistory = [];
    res.json({ ok: true });
});

app.get('/api/wiim/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=wiim_temp_log.csv');
    let csv = 'timestamp,iso_time,cpu_c,board_tmp102_c\n';
    for (const h of mockWiimHistory) {
        const iso = new Date(h.ts * 1000).toISOString();
        csv += `${h.ts},${iso},${h.cpu !== null && h.cpu !== undefined ? h.cpu : ''},${h.board !== null && h.board !== undefined ? h.board : ''}\n`;
    }
    res.send(csv);
});

/* ===== CyberPower UPS 模擬端點 ===== */
const mockUpsHistory = (() => {
    const pts = [], now = Date.now();
    for (let i = 2880; i >= 0; i--) { // 24h @30s
        const t = now - i * 30000;
        const isOutage = i <= 1210 && i >= 1180; // 模擬一段 15 分鐘的斷電
        pts.push({
            t: new Date(t).toISOString(),
            inV: isOutage ? 0 : +(110 + Math.sin(t / 3.6e6) * 2.5 + Math.random()).toFixed(1),
            outV: +(110 + Math.random() * 0.8).toFixed(1),
            batt: isOutage ? Math.max(62, 100 - Math.round((1210 - i) * 1.2)) : 100,
            load: Math.round(18 + Math.random() * 8),
            rt: isOutage ? 1500 : 2520,
            ob: isOutage ? 1 : 0
        });
    }
    return pts;
})();
const mockUpsEvents = [
    { start: new Date(Date.now() - 1210 * 30000).toISOString(), end: new Date(Date.now() - 1180 * 30000).toISOString(), durationSec: 900, minBattery: 62, startVoltage: 108.9 },
    { start: new Date(Date.now() - 5 * 86400000).toISOString(), end: new Date(Date.now() - 5 * 86400000 + 120000).toISOString(), durationSec: 120, minBattery: 95, startVoltage: 109.4 }
];
app.get('/api/ups/status', (req, res) => res.json({
    source: 'nut', model: 'CyberPower CP1500PFCLCDa', status: 'OL',
    onBattery: false, inputV: +(110 + Math.random() * 2).toFixed(1), outputV: 110.2,
    battery: 100, runtimeSec: 2520, loadPct: Math.round(18 + Math.random() * 6), sampleSec: 30
}));
app.get('/api/ups/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ history: mockUpsHistory.filter(p => new Date(p.t).getTime() >= cutoff) });
});
app.get('/api/ups/events', (req, res) => res.json({ events: mockUpsEvents }));
app.get('/api/ups/ppb-events', (_req, res) => res.json({ events: [], source: 'mock' }));
app.get('/api/ups/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ups_history.csv');
    let csv = 'time,input_v,output_v,battery_pct,load_pct,runtime_sec,on_battery\n';
    for (const h of mockUpsHistory) csv += `${h.t},${h.inV ?? ''},${h.outV ?? ''},${h.batt ?? ''},${h.load ?? ''},${h.rt ?? ''},${h.ob}\n`;
    res.send(csv);
});

const mockLinuxHistory = Array.from({ length: 96 }, (_, index) => ({
    t: new Date(Date.now() - (95 - index) * 15 * 60 * 1000).toISOString(),
    cpu: 12 + (index % 9),
    temp: 43 + (index % 5),
    mem: 38 + (index % 4),
    load: Number((0.2 + (index % 6) / 10).toFixed(1))
}));
app.get('/api/linux/stats', (_req, res) => res.json({
    hostname: 'smarthub-mock-linux', cpuUsage: 18, cpuTemp: 45, memUsagePct: 40,
    diskUsagePct: 31, load: [0.4, 0.3, 0.2], uptime: 'up 14d 3h', source: 'mock'
}));
app.get('/api/linux/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query));
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ data: mockLinuxHistory.filter(point => Date.parse(point.t) >= cutoff), source: 'mock' });
});

/* ===== AdGuard Home (模擬) ===== */
let mockAdguardProtection = true;
const mockAdguardQueryLog = Array.from({ length: 40 }, (_, index) => {
    const blocked = index % 3 === 0;
    return {
        time: new Date(Date.now() - index * 45_000).toISOString(),
        domain: blocked ? `tracker-${index}.example` : `service-${index}.example`,
        type: 'A',
        client: `192.168.1.${100 + (index % 20)}`,
        blocked,
        reason: blocked ? 'FilteredBlackList' : 'NotFilteredNotFound',
        elapsedMs: Number((0.3 + (index % 7) * 0.1).toFixed(1))
    };
});
app.get('/api/adguard/overview', (_req, res) => res.json({
    status: { version: 'v0.107.55-mock', protection_enabled: mockAdguardProtection },
    stats: {
        num_dns_queries: 12_480,
        num_blocked_filtering: 2_147,
        avg_processing_time: 0.00082,
        top_blocked_domains: [{ 'telemetry.example': 312 }, { 'ads.example': 184 }],
        top_clients: [{ '192.168.1.100': 3_214 }, { '192.168.1.102': 2_401 }]
    },
    source: 'adguard'
}));
app.get('/api/adguard/querylog', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseAdGuardQueryLogQuery(req.query));
    if (!query) return;
    const entries = query.filtered
        ? mockAdguardQueryLog.filter(entry => entry.blocked)
        : mockAdguardQueryLog;
    res.json({ entries: entries.slice(0, query.limit), source: 'adguard' });
});
app.post('/api/adguard/protection', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseSingleBoolean(req.body, 'enabled'));
    if (!input) return;
    mockAdguardProtection = input.enabled;
    res.json({ ok: true, enabled: mockAdguardProtection });
});

/* ===== 連線設定 (模擬) ===== */
const MOCK_CONNECTION_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'mock-connections.json');
const mockConnDefaults = {
    UCG_IP: '192.168.0.1', SSH_PORT: '22', SSH_USER: 'root', WAN_IFACE: 'eth4',
    UNIFI_CONTROLLER_URL: 'https://192.168.0.1', UNIFI_USERNAME: 'demo',
    NAS_HOST: '', NAS_PORT: '9443', NAS_SCHEME: 'https', NAS_USER: '',
    NAS_MONITOR_URL: '', NAS_MONITOR_MODE: 'docker_only', WIIM_IP: '192.168.0.170',
    UPS_SOURCE: 'auto', NUT_HOST: 'localhost', NUT_UPS_NAME: 'cyberpower', PWRSTAT_PATH: '',
    PPB_HOST: '', PPB_PORT: '3052', PPB_USER: '',
    ADGUARD_HOST: '', ADGUARD_PORT: '80', ADGUARD_USER: '',
    LINUX_HOST: '', LINUX_SSH_PORT: '22', LINUX_SSH_USER: ''
};
const mockSecretDefaults = {
    SSH_PASSWORD: false, UNIFI_PASSWORD: false, UNIFI_API_KEY: false,
    NAS_PASSWORD: false, NAS_MONITOR_API_KEY: false, PPB_PASSWORD: false,
    ADGUARD_PASSWORD: false, LINUX_SSH_PASSWORD: false
};
const MOCK_RESTART_REQUIRED_FIELDS = Object.freeze([
    'NAS_MONITOR_URL',
    'NAS_MONITOR_API_KEY',
    'NAS_MONITOR_MODE'
]);
const MOCK_CONN_FIELDS = [
    ...Object.keys(mockConnDefaults).map(key => ({ key, restartRequired: MOCK_RESTART_REQUIRED_FIELDS.includes(key) })),
    ...Object.keys(mockSecretDefaults).map(key => ({ key, secret: true, restartRequired: MOCK_RESTART_REQUIRED_FIELDS.includes(key) }))
];

// Mock Server 也保留「已填過」的連線狀態，重啟開發伺服器時不用重填；密碼本身不會寫入。
function loadMockConnections() {
    try {
        const saved = JSON.parse(fs.readFileSync(MOCK_CONNECTION_FILE, 'utf8'));
        const savedFields = writeInput.isPlainObject(saved.fields) ? saved.fields : {};
        const savedSecrets = writeInput.isPlainObject(saved.secretsSet) ? saved.secretsSet : {};
        return {
            fields: Object.fromEntries(Object.entries(mockConnDefaults).map(([key, fallback]) => [
                key, typeof savedFields[key] === 'string' ? savedFields[key] : fallback
            ])),
            secretsSet: Object.fromEntries(Object.keys(mockSecretDefaults).map(key => [
                key, savedSecrets[key] === true
            ]))
        };
    } catch { return { fields: { ...mockConnDefaults }, secretsSet: { ...mockSecretDefaults } }; }
}
function saveMockConnections() {
    fs.mkdirSync(path.dirname(MOCK_CONNECTION_FILE), { recursive: true });
    const tempFile = `${MOCK_CONNECTION_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify({ fields: mockConn, secretsSet: mockConnSecrets }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempFile, MOCK_CONNECTION_FILE);
}
const savedMockConnections = loadMockConnections();
let mockConn = savedMockConnections.fields;
let mockConnSecrets = savedMockConnections.secretsSet;
const mockAppliedConn = { ...mockConn };
const mockPendingRestartFields = new Set();
app.get('/api/connections', (req, res) => res.json({
    fields: mockConn,
    secretsSet: mockConnSecrets,
    restartRequiredFields: [...MOCK_RESTART_REQUIRED_FIELDS],
    pendingRestartFields: [...mockPendingRestartFields]
}));
app.get('/api/connections/status', (_req, res) => res.json({
    source: 'mock',
    devices: [
        { name: 'UCG SSH', configured: true, ok: true, detail: mockConn.UCG_IP },
        { name: 'UniFi Controller', configured: true, ok: true, detail: 'Legacy API' },
        { name: 'Site Manager', configured: false, ok: null, detail: '' },
        { name: 'UGREEN NAS', configured: !!(mockConn.NAS_HOST && mockConn.NAS_USER && mockConnSecrets.NAS_PASSWORD), ok: mockConn.NAS_HOST && mockConn.NAS_USER && mockConnSecrets.NAS_PASSWORD ? true : null, detail: mockConn.NAS_HOST || '' },
        { name: 'NAS Monitor', configured: !!mockConn.NAS_MONITOR_URL, ok: mockConn.NAS_MONITOR_URL ? true : null, detail: mockConn.NAS_MONITOR_URL || '' },
        { name: 'WiiM Amp', configured: true, ok: true, detail: mockConn.WIIM_IP },
        { name: 'UPS', configured: true, ok: true, detail: 'NUT mock' }
    ]
}));
app.post('/api/connections', (req, res) => {
    const updates = validatedInput(res, () => writeInput.parseConnectionUpdates(req.body, MOCK_CONN_FIELDS));
    if (!updates) return;
    for (const [key, value] of Object.entries(updates)) {
        if (Object.hasOwn(mockConnSecrets, key)) mockConnSecrets[key] = true;
        else mockConn[key] = value;
        if (!MOCK_RESTART_REQUIRED_FIELDS.includes(key)) continue;
        if (Object.hasOwn(mockConnSecrets, key) || mockConn[key] !== mockAppliedConn[key]) {
            mockPendingRestartFields.add(key);
        } else {
            mockPendingRestartFields.delete(key);
        }
    }
    const changed = Object.keys(updates).length;
    if (changed) saveMockConnections();
    res.json({ ok: true, changed, restartRequired: Object.keys(updates).filter(key => mockPendingRestartFields.has(key)) });
});

app.get('/api/config/backup/status', mockSecurity.requireAdmin, (_req, res) => {
    res.json(mockConfigBackupService.status());
});
app.get('/api/config/backup', mockSecurity.requireAdmin, async (_req, res) => {
    try {
        const backup = await mockConfigBackupService.exportBackup();
        res.set('Content-Type', BACKUP_MEDIA_TYPE);
        res.set('Content-Disposition', 'attachment; filename="smarthub-mock-backup.json"');
        res.set('Cache-Control', 'no-store');
        res.send(JSON.stringify(backup));
    } catch (error) {
        const validation = error instanceof BackupValidationError;
        mockApiError(res, error, {
            status: validation ? error.httpStatus : 500,
            code: validation ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
            publicMessage: validation ? error.message : 'Internal server error'
        });
    }
});
app.post('/api/config/restore', mockSecurity.requireAdmin, (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.is(BACKUP_MEDIA_TYPE)) {
        return mockApiError(res, new Error(`Content-Type must be ${BACKUP_MEDIA_TYPE}`), {
            status: 415, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'unsupported_backup_content_type'
        });
    }
    try {
        res.status(202).json(mockConfigBackupService.stageRestore(req.body, req.get('x-smarthub-restore-confirmation')));
    } catch (error) {
        const validation = error instanceof BackupValidationError;
        mockApiError(res, error, {
            status: validation ? error.httpStatus : 500,
            code: validation ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
            publicMessage: validation ? error.message : 'Internal server error'
        });
    }
});

app.get('/api/alerts/critical', (_req, res) => res.json({ alerts: [], source: 'mock' }));

const mockBuildIdentity = Object.freeze({
    version: 'unknown', revision: 'unknown', created: 'unknown', dirty: null,
    status: 'incomplete', complete: false
});
const mockHealth = (_req, res) => res.json({ status: 'healthy', code: ERROR_CODES.API_HEALTH_OK, uptime_seconds: Math.floor(process.uptime()), version: APP_VERSION, build: mockBuildIdentity, timestamp: new Date().toISOString(), source: 'mock' });
app.get('/health', mockHealth);
app.get('/healthz', mockHealth);
app.get('/health/ready', (_req, res) => res.json({
    status: 'ready', code: ERROR_CODES.API_READY_OK, source: 'mock', build: mockBuildIdentity,
    checks: { database: { status: 'healthy', latency_ms: 0 }, worker: { status: 'healthy', active_tasks: 0, stuck_tasks: 0 } }
}));
const mockSystemTrend = [];
app.get('/api/system/status', (_req, res) => {
    const mem = process.memoryUsage();
    const totalMemory = os.totalmem();
    const availableMemory = typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem();
    const memoryPercent = Number(((totalMemory - availableMemory) / totalMemory * 100).toFixed(1));
    const memoryStatus = memoryPercent >= 90 ? 'critical' : memoryPercent >= 80 ? 'warning' : 'healthy';
    const memoryIssue = memoryStatus === 'healthy' ? [] : [{
        id: `memory:${memoryStatus}`, severity: memoryStatus,
        code: memoryStatus === 'critical' ? ERROR_CODES.SYS_MEMORY_CRITICAL : ERROR_CODES.SYS_MEMORY_WARNING,
        message: memoryStatus === 'critical' ? 'Memory usage critical' : 'Memory usage high',
        first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), occurrences: 1
    }];
    const sample = {
        timestamp: new Date().toISOString(), process_cpu_percent: 1.2, system_cpu_percent: 18,
        process_rss_bytes: mem.rss, system_memory_percent: memoryPercent,
        db_active_connections: 0, active_tasks: 0
    };
    mockSystemTrend.push(sample);
    if (mockSystemTrend.length > 60) mockSystemTrend.shift();
    res.json({
        status: memoryStatus, source: 'mock', sampled_at: sample.timestamp, uptime_seconds: Math.floor(process.uptime()), app_version: APP_VERSION, build: mockBuildIdentity,
        cpu: { status: 'healthy', usage_percent: sample.system_cpu_percent, process_usage_percent: sample.process_cpu_percent, load_average: os.loadavg() },
        memory: { status: memoryStatus, usage_percent: sample.system_memory_percent, process_mb: Number((mem.rss / 1048576).toFixed(1)), system_available_bytes: availableMemory, system_total_bytes: totalMemory },
        disk: { status: 'unknown', usage_percent: null, free_bytes: null },
        database: { status: 'unknown', type: 'mock', latency_ms: null, pool: { type: 'mock', size: 0, active: 0, available: 0, waiting: 0 }, slow_queries: 0, failed_queries: 0 },
        worker: { status: 'healthy', active_tasks: 0, queued_tasks: 0, failed_tasks: 0, completed_tasks: 0, retry_tasks: 0, skipped_tasks: 0, long_running_tasks: 0, stuck_tasks: 0 },
        active_issues: memoryIssue, resolved_issues: [], trend_data: mockSystemTrend
    });
});

app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    return mockApiError(res, new Error(`Route not found: ${req.method} ${req.path}`), {
        status: 404,
        code: ERROR_CODES.API_NOT_FOUND,
        publicMessage: 'API endpoint not found'
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const isTooLarge = error && (error.type === 'entity.too.large' || error.status === 413);
    const isJsonError = error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError);
    return mockApiError(res, error, {
        status: isTooLarge ? 413 : isJsonError ? 400 : 500,
        code: isTooLarge || isJsonError ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
        publicMessage: isTooLarge ? 'JSON request body exceeds 256 KiB'
            : isJsonError ? 'Invalid JSON request body' : 'Internal server error'
    });
});

const PORT = process.env.PORT || 3005;
const mockServer = app.listen(PORT, () => console.log(`Mock Server listening on port ${PORT}`));
function stopMock() {
    mockServer.close(() => {
        try { mockBackupDb.close(); } catch { }
        fs.rmSync(MOCK_BACKUP_DIR, { recursive: true, force: true });
        process.exit(0);
    });
}
process.once('SIGTERM', stopMock);
process.once('SIGINT', stopMock);
