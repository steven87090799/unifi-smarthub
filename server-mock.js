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

// 6. 客戶端限速/阻斷控制
app.put('/api/device/restrict', (req, res) => {
    const client = mockClients.find(c => c.mac === req.body.deviceId);
    if (client) {
        client.blocked = req.body.blockState;
    }
    res.json({ success: true });
});

// 7. PoE Port 斷電重啟
app.post('/api/poe/power-cycle', (req, res) => {
    res.json({ success: true });
});

// 8. 觸發測速
app.post('/api/speedtest', (req, res) => {
    res.json({ success: true });
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

const PORT = 3005;
app.listen(PORT, () => console.log(`Mock Server listening on port ${PORT}`));
