const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 託管前端靜態網頁
app.use(express.static(path.join(__dirname, 'public')));

// 模擬變數
let mockClients = [
    { mac: "00:11:22:33:44:55", name: "Steven's MacBook Pro", ip: "192.168.1.100", is_wifi: true, wifi_signal: -54, rx_bytes: 104857600, tx_bytes: 52428800, blocked: false },
    { mac: "aa:bb:cc:dd:ee:ff", name: "Living Room Apple TV", ip: "192.168.1.102", is_wifi: false, wifi_signal: null, rx_bytes: 4194304000, tx_bytes: 104857600, blocked: false },
    { mac: "11:22:33:44:55:66", name: "Suspicious IoT Bulb", ip: "192.168.1.199", is_wifi: true, wifi_signal: -78, rx_bytes: 500000, tx_bytes: 120000, blocked: true }
];

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

// 2. 獲取活躍客戶端
app.get('/api/clients', (req, res) => {
    // 模擬流量稍微增加
    mockClients.forEach(c => {
        if (!c.blocked) {
            c.rx_bytes += Math.floor(Math.random() * 1000000);
            c.tx_bytes += Math.floor(Math.random() * 200000);
        }
    });
    res.json({ clients: mockClients });
});

// 3. 獲取 SSID 列表
app.get('/api/wifi-networks', (req, res) => {
    res.json({ networks: mockWiFi });
});

// 4. 控制 SSID 狀態
app.put('/api/wifi-networks/:id', (req, res) => {
    const net = mockWiFi.find(n => n._id === req.params.id);
    if (net) {
        net.enabled = req.body.enabled;
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
    const client = mockClients.find(c => c.mac === req.body.deviceId);
    if (client) {
        client.blocked = req.body.blockState;
    }
    mockBlockHistory.unshift({
        datetime: new Date().toISOString(),
        mac: req.body.deviceId,
        name: req.body.deviceName || (client && client.name) || 'Unknown Device',
        action: req.body.blockState ? 'block' : 'unblock',
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
    res.json({ success: true });
});

// 8. 觸發測速 (模擬：8 秒後產生結果)
let mockSpeedtestStart = 0;
app.post('/api/speedtest', (req, res) => {
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
    if (typeof req.body.autoDefense === 'boolean') mockSecSettings.autoDefense = req.body.autoDefense;
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

// 自適應取樣：有前端活躍時每 5 秒、閒置時每小時 (與正式後端行為一致)
let lastClientActivity = 0, lastSampleTs = 0;
let ACTIVE_SAMPLE_MS = 5000, IDLE_SAMPLE_MS = 30 * 60 * 1000, ACTIVE_WINDOW_MS = 30000;
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
    lastClientActivity = Date.now();
    const hours = parseInt(req.query.hours || '24', 10);
    const cutoff = Date.now() - hours * 3600000;
    res.json({ history: mockTrendHistory.filter(p => new Date(p.t).getTime() >= cutoff) });
});

app.get('/api/heartbeat', (req, res) => {
    lastClientActivity = Date.now();
    res.json({ ok: true, mode: 'active' });
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
    { id: 'a1b2c3d4e5f6', name: 'jellyfin', image: 'jellyfin/jellyfin:latest', state: 'running', status: 'Up 3 days', cpu_percent: 4.2, mem_usage_mb: 512, mem_limit_mb: 2048 },
    { id: 'b2c3d4e5f6a1', name: 'qbittorrent', image: 'linuxserver/qbittorrent', state: 'running', status: 'Up 3 days', cpu_percent: 1.1, mem_usage_mb: 210, mem_limit_mb: 1024 },
    { id: 'c3d4e5f6a1b2', name: 'homeassistant', image: 'homeassistant/home-assistant', state: 'running', status: 'Up 5 days', cpu_percent: 2.8, mem_usage_mb: 380, mem_limit_mb: 1024 },
    { id: 'd4e5f6a1b2c3', name: 'nginx-proxy-manager', image: 'jc21/nginx-proxy-manager', state: 'running', status: 'Up 5 days', cpu_percent: 0.3, mem_usage_mb: 96, mem_limit_mb: 512 },
    { id: 'e5f6a1b2c3d4', name: 'immich-server', image: 'ghcr.io/immich-app/immich', state: 'exited', status: 'Exited (0) 2 hours ago', cpu_percent: 0, mem_usage_mb: 0, mem_limit_mb: 2048 }
];
let mockAlerts = [
    { id: 'al-1', datetime: new Date(Date.now() - 3600000).toISOString(), metric: 'disk_temperature', level: 'warning', message: 'Seagate IronWolf 8TB 溫度達 48°C (閾值 45°C)', acknowledged: false },
    { id: 'al-2', datetime: new Date(Date.now() - 6 * 3600000).toISOString(), metric: 'cpu_usage', level: 'info', message: 'CPU 使用率短暫達 82% (備份任務)', acknowledged: true },
    { id: 'al-3', datetime: new Date(Date.now() - 26 * 3600000).toISOString(), metric: 'volume_usage', level: 'critical', message: '存儲空間 1 使用率超過 85%', acknowledged: false }
];
app.get('/api/nas/docker', (req, res) => {
    mockDocker.forEach(c => { if (c.state === 'running') { c.cpu_percent = +(Math.random() * 5).toFixed(1); } });
    res.json({ containers: mockDocker, source: 'fallback' });
});
app.post('/api/nas/docker/:id/:action', (req, res) => {
    const { id, action } = req.params;
    const c = mockDocker.find(x => x.id === id || x.name === id);
    if (c) {
        c.state = action === 'stop' ? 'exited' : 'running';
        c.status = action === 'stop' ? 'Exited (0) just now' : 'Up 1 second';
        if (action === 'stop') { c.cpu_percent = 0; c.mem_usage_mb = 0; } else if (!c.mem_usage_mb) c.mem_usage_mb = 128;
    }
    res.json({ success: true, source: 'fallback' });
});
app.get('/api/nas/docker/:id/logs', (req, res) => {
    res.json({ logs: `[demo] ${req.params.id} 日誌\n` + Array.from({ length: 14 }, (_, i) => `${new Date(Date.now() - i * 5000).toISOString()}  INFO  service tick #${1000 - i}`).join('\n'), source: 'fallback' });
});
app.get('/api/nas/traffic-summary', (req, res) => res.json({ data: { today_gb: 42.6, week_gb: 318.2, month_gb: 1240.7, today_up_gb: 8.1, today_down_gb: 34.5 }, source: 'fallback' }));
app.get('/api/nas/traffic-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), upload_mbps: +(2 + f * 12 + Math.random() * 3).toFixed(1), download_mbps: +(5 + f * 40 + Math.random() * 8).toFixed(1) }; }), source: 'fallback' });
});
app.get('/api/nas/system-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), cpu: Math.round(8 + f * 30 + Math.random() * 6), memory: Math.round(34 + f * 10 + Math.random() * 4), temperature: Math.round(40 + f * 6 + Math.random() * 2) }; }), source: 'fallback' });
});
app.get('/api/nas/temperature-history', (req, res) => {
    const hours = parseInt(req.query.hours || '24', 10);
    res.json({ data: mSeries(hours, 30, d => { const f = Math.sin((d.getHours() - 6) / 24 * Math.PI * 2) * 0.5 + 0.5; return { t: d.toISOString(), fan_rpm: Math.round(900 + f * 500), disk1: Math.round(36 + f * 4), disk2: Math.round(37 + f * 4), disk3: Math.round(39 + f * 5) }; }), source: 'fallback' });
});
app.get('/api/nas/storage-history', (req, res) => {
    const hours = parseInt(req.query.hours || '720', 10);
    res.json({ data: mSeries(hours, 720, (d, i) => ({ t: d.toISOString(), used_gb: Math.round(3120 - i * 6 + Math.random() * 4), total_gb: 7451 })), source: 'fallback' });
});
app.get('/api/nas/storage-forecast', (req, res) => res.json({ data: { days_until_full: 512, daily_growth_gb: 6.2, projected_full_date: new Date(Date.now() + 512 * 86400000).toISOString().slice(0, 10), current_used_percent: 42 }, source: 'fallback' }));
app.get('/api/nas/downtime', (req, res) => res.json({ data: { uptime_percent: 99.97, downtime_events: 1, last_downtime: new Date(Date.now() - 12 * 86400000).toISOString(), total_downtime_min: 13 }, source: 'fallback' }));
app.get('/api/nas/alerts', (req, res) => res.json({ events: mockAlerts, source: 'fallback' }));
app.post('/api/nas/alerts/:id/ack', (req, res) => {
    const a = mockAlerts.find(x => x.id === req.params.id);
    if (a) a.acknowledged = true;
    res.json({ success: true, source: 'fallback' });
});

/* ===== 通知推播中心 (模擬) ===== */
let mockNotif = { enabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', triggerThreats: true, triggerNasAlerts: true };
let mockNotifLog = [];
function pushMockNotif(e) { mockNotifLog.unshift(e); mockNotifLog = mockNotifLog.slice(0, 50); }
app.get('/api/notifications/settings', (req, res) => res.json({
    enabled: mockNotif.enabled, channel: mockNotif.channel, chatId: mockNotif.chatId,
    triggerThreats: mockNotif.triggerThreats, triggerNasAlerts: mockNotif.triggerNasAlerts,
    webhookUrlSet: !!mockNotif.webhookUrl, botTokenSet: !!mockNotif.botToken
}));
app.post('/api/notifications/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') mockNotif.enabled = b.enabled;
    if (b.channel) mockNotif.channel = b.channel;
    if (typeof b.chatId === 'string') mockNotif.chatId = b.chatId;
    if (typeof b.triggerThreats === 'boolean') mockNotif.triggerThreats = b.triggerThreats;
    if (typeof b.triggerNasAlerts === 'boolean') mockNotif.triggerNasAlerts = b.triggerNasAlerts;
    if (b.webhookUrl) mockNotif.webhookUrl = b.webhookUrl;
    if (b.botToken) mockNotif.botToken = b.botToken;
    res.json({ ok: true });
});
app.post('/api/notifications/test', (req, res) => {
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
let mockAppSettings = { trendActiveSec: 5, trendIdleSec: 1800, activeWindowSec: 30, watcherSec: 20, autoDefenseSec: 30, reportEnabled: false, reportFreq: 'daily', reportHour: 8 };
app.get('/api/settings', (req, res) => res.json(mockAppSettings));
app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    ['trendActiveSec', 'trendIdleSec', 'activeWindowSec', 'watcherSec', 'autoDefenseSec', 'reportHour'].forEach(k => { if (typeof b[k] === 'number' && b[k] >= 0) mockAppSettings[k] = b[k]; });
    if (typeof b.reportEnabled === 'boolean') mockAppSettings.reportEnabled = b.reportEnabled;
    if (b.reportFreq === 'daily' || b.reportFreq === 'weekly') mockAppSettings.reportFreq = b.reportFreq;
    // 套用新的趨勢取樣間隔
    ACTIVE_SAMPLE_MS = mockAppSettings.trendActiveSec * 1000;
    IDLE_SAMPLE_MS = mockAppSettings.trendIdleSec * 1000;
    ACTIVE_WINDOW_MS = mockAppSettings.activeWindowSec * 1000;
    res.json({ ok: true, settings: mockAppSettings });
});

app.post('/api/reports/run', (req, res) => {
    const body = [`🛡️ 24H 威脅攔截：${mockThreats.filter(t => Date.now() - new Date(t.datetime).getTime() < 86400000).length} 次`, `📱 目前線上客戶端：${mockClients.length} 台`, `📶 平均 ISP 延遲：13.2 ms`, `💾 NAS 30 天正常運行率：99.97%`].join('\n');
    if (mockNotif.enabled) pushMockNotif({ ts: new Date().toISOString(), title: '📊 SmartHub 報表 (手動觸發)', body, channel: mockNotif.channel, ok: true });
    res.json({ report: body, delivery: mockNotif.enabled ? { ok: true } : { skipped: 'disabled' } });
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
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url);if(u.pathname.startsWith('/api/')||u.pathname==='/healthz')return;e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));});`));

app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() }));

const PORT = 3005;
app.listen(PORT, () => console.log(`Mock Server listening on port ${PORT}`));
