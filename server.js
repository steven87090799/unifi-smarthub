// 清除代理伺服器環境變數以防 Axios 走代理導致無法連線本機設備
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const express = require('express');
const axios = require('axios');
const { Client } = require('ssh2');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // 以專案目錄定位 .env，與啟動時的 cwd 無關
const os = require('os');
const { version: APP_VERSION } = require('./package.json');
const { ERROR_CODES } = require('./observability/error-codes');
const { createLogger, maskString } = require('./observability/logger');
const { IssueTracker } = require('./observability/issue-tracker');
const { TaskTracker } = require('./observability/task-tracker');
const { SystemMonitor } = require('./observability/system-monitor');
const { registerHealthRoutes } = require('./observability/health-routes');
const { forwardNasLogs, forwardNasAlerts } = require('./nas-log-forwarder');
const { createActivityLease } = require('./activity-lease');

const APP_STARTED_AT = Date.now();
const logger = createLogger({ service: 'smarthub' });
const issueTracker = new IssueTracker({ cooldownSeconds: process.env.ALERT_COOLDOWN_SECONDS || 300 });
const taskTracker = new TaskTracker({ logger, stuckSeconds: process.env.TASK_STUCK_SECONDS || 1800 });

// 統一結構化日誌輸出
function sysLog(module, message, isError = false) {
    const moduleName = String(module || 'app').toLowerCase().replace(/\s+/g, '.');
    const errorCode = moduleName.includes('scheduler') ? ERROR_CODES.WORKER_TASK_FAILED
        : moduleName.includes('persist') || moduleName.includes('history') ? ERROR_CODES.DB_QUERY_FAILED
            : moduleName.includes('diag') ? ERROR_CODES.SYS_CONFIG_INVALID
                : moduleName.includes('nas') ? ERROR_CODES.EXT_NAS_FAILED
                    : moduleName.includes('unifi') ? ERROR_CODES.EXT_UNIFI_FAILED
                        : moduleName.includes('wiim') ? ERROR_CODES.EXT_WIIM_FAILED
                            : moduleName.includes('ups') ? ERROR_CODES.EXT_UPS_FAILED
                                : ERROR_CODES.API_INTERNAL_ERROR;
    const event = {
        module: moduleName,
        function: 'legacy',
        code: isError ? errorCode : undefined,
        message
    };
    if (isError) logger.error(event);
    else logger.info(event);
}

function apiError(res, error, options = {}) {
    const status = options.status || 500;
    const code = options.code || (status === 400 ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR);
    const context = logger.getContext();
    logger[status >= 500 ? 'error' : 'warning']({
        module: options.module || 'api', function: options.function || 'handler', code,
        http_status: status, message: options.logMessage || 'API request failed', error,
        fields: options.fields
    });
    return res.status(status).json({
        error: options.publicMessage || (status >= 500 ? 'Internal server error' : maskString(error?.message || String(error))),
        code,
        request_id: context.request_id
    });
}

// 某些唯讀整合端點為維持既有 UI 契約，失敗時仍以 200 + source:error 回退。
// 這些錯誤必須進 Docker log，但以 cooldown 合併，避免前端輪詢造成 log storm。
const recoverableFailures = new Map();
const RECOVERABLE_LOG_COOLDOWN_MS = Math.max(Number(process.env.ALERT_COOLDOWN_SECONDS) || 300, 1) * 1000;
function publicError(error) {
    return maskString(error?.message || String(error || 'External service unavailable')).slice(0, 500);
}
function logRecoverableFailure(key, error, options = {}) {
    const now = Date.now();
    const state = recoverableFailures.get(key) || { occurrences: 0, last_logged_at: 0 };
    state.occurrences += 1;
    if (now - state.last_logged_at >= RECOVERABLE_LOG_COOLDOWN_MS) {
        state.last_logged_at = now;
        logger.warning({
            module: options.module || 'external', function: options.function || 'fallback',
            code: options.code || ERROR_CODES.API_INTERNAL_ERROR,
            message: options.message || 'Recoverable integration failure; fallback response returned',
            error, fields: { ...options.fields, occurrences: state.occurrences, cooldown_seconds: RECOVERABLE_LOG_COOLDOWN_MS / 1000 }
        });
    }
    recoverableFailures.set(key, state);
}

logger.info({
    module: 'app.lifecycle', function: 'bootstrap', code: ERROR_CODES.SYS_START,
    message: 'SmartHub starting', fields: {
        version: APP_VERSION,
        environment: process.env.NODE_ENV || 'development',
        node: process.version,
        hostname: os.hostname(),
        log_level: logger.level,
        log_format: logger.format
    }
});

const app = express();
// 前端與後端同源 (由本伺服器託管)，不需要 CORS；移除全開 cors() 以避免跨站請求濫用
app.use(logger.requestMiddleware());
app.use(express.json());

// 可選的整站 Basic Auth：liveness/readiness 不擋，完整 diagnostics 仍受保護。
app.use((req, res, next) => {
    const pw = process.env.PANEL_PASSWORD;
    if (!pw || ['/health', '/healthz', '/health/ready'].includes(req.path)) return next();
    const hdr = req.headers.authorization || '';
    const decoded = hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString('utf8') : '';
    if (decoded.split(':').slice(1).join(':') === pw) return next();
    logger.warning({
        module: 'api.auth', function: 'basicAuth', code: ERROR_CODES.API_AUTH_FAILED,
        http_status: 401, message: 'Panel authentication failed', fields: { method: req.method, path: req.path }
    });
    res.set('WWW-Authenticate', 'Basic realm="SmartHub"');
    res.status(401).json({ error: 'Authentication required', code: ERROR_CODES.API_AUTH_FAILED, request_id: logger.getContext().request_id });
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
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 10000
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

// 本地 API 登入 Session 管理 (併發去重：Cookie 過期瞬間多請求同時進來只登入一次)
let unifiLoginInflight = null;
async function getLocalSession() {
    if (isPlaceholder(process.env.UNIFI_USERNAME) || isPlaceholder(process.env.UNIFI_PASSWORD)) {
        throw new Error('unifi_not_configured (UNIFI_USERNAME/PASSWORD 尚未填寫，略過連線)');
    }
    const now = Date.now();
    if (localCookie && now < cookieExpiry) {
        sysLog('UniFi Auth', '使用快取的本地控制器 Session Cookie。');
        return localCookie;
    }
    if (unifiLoginInflight) return unifiLoginInflight;
    unifiLoginInflight = doUnifiLogin().finally(() => { unifiLoginInflight = null; });
    return unifiLoginInflight;
}
async function doUnifiLogin() {
    const now = Date.now();
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
        },
        timeout: 8000
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

// SSH 遙測含 sleep 1 且每次開新連線，加上 5 秒快取 + in-flight 去重：
// 前端輪詢與 notificationWatcher 同時打進來時只開一條 SSH，其餘共用同一結果
let hwCache = null;      // { ts, data }
let hwInflight = null;
function fetchHardwareSSH() {
    return new Promise((resolve, reject) => {
    sysLog('Hardware', `發起 SSH 連線至 UCG-Ultra (${process.env.UCG_IP}:${process.env.SSH_PORT || 22})...`);
    const conn = new Client();
    conn.on('ready', () => {
        sysLog('Hardware', 'SSH 連線建立成功，執行遙測指令組...');
        conn.exec(HW_CMD, (err, stream) => {
            if (err) {
                sysLog('Hardware', `SSH 指令執行失敗: ${err.message}`, true);
                conn.end();
                return reject({ status: 500, body: { error: 'SSH Command Execution Failed' } });
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

                    const data = {
                        cpuTemp, cpuUsage, cores, memUsagePct,
                        memStr: `${(memUsed / 1024).toFixed(2)} GB / ${(memTotal / 1024).toFixed(2)} GB`,
                        emmcUsagePct, emmcStr, uptime, interfaces,
                        dataSource: 'real'
                    };
                    resolve(data);
                    sampleUcgHistory({ cpuTemp, cpuUsage, cores, memUsagePct });
                } catch (e) {
                    reject({ status: 500, body: { error: 'Hardware Output Parse Failed: ' + e.message } });
                }
            });
        });
    }).on('error', (err) => {
        const authFail = /authentication methods failed/i.test(err.message || '');
        reject({
            status: 500, body: {
                error: 'SSH Connection Failed',
                details: authFail
                    ? 'SSH 密碼被 UCG 拒絕。注意：SSH 密碼是獨立的，不是 UniFi 登入密碼 — 請到 UniFi 主控台 → Console Settings → Advanced → SSH，在那裡「設定 SSH 專用密碼」後填入本頁'
                    : err.message
            }
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
}

// 行程內共用入口 (route / notificationWatcher / buildReport 皆走這裡，不再自打 HTTP)
async function getHardwareCached() {
    if (hwCache && Date.now() - hwCache.ts < 15000) return hwCache.data;
    if (!hwInflight) hwInflight = fetchHardwareSSH().finally(() => { hwInflight = null; });
    const data = await hwInflight;
    hwCache = { ts: Date.now(), data };
    return data;
}

app.get('/api/hardware', async (req, res) => {
    // 帳密未填時不發起 SSH：反覆的 SSH 連線嘗試會被 UniFi IPS 判定為 SSH 掃描 (ET SCAN 2003068)
    if (isPlaceholder(process.env.SSH_PASSWORD) || !process.env.UCG_IP) {
        return apiError(res, new Error('UCG SSH is not configured'), {
            status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'ssh_not_configured',
            module: 'api.hardware', function: 'getHardware', fields: { hint: 'Configure SSH_PASSWORD and UCG_IP.' }
        });
    }
    try {
        res.json(await getHardwareCached());
    } catch (e) {
        res.status((e && e.status) || 500).json((e && e.body) || { error: String((e && e.message) || e) });
    }
});

// 2. 獲取活躍客戶端
app.get('/api/clients', async (req, res) => {
    try {
        sysLog('UniFi API', '獲取活躍客戶端清單...');
        const cookie = await getLocalSession();
        const response = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });

        const clients = response.data.data.map(c => ({
            mac: c.mac,
            name: clientAliases[(c.mac || '').toLowerCase()] || c.name || c.hostname || 'Unknown Device',
            aliased: !!clientAliases[(c.mac || '').toLowerCase()],
            original_name: c.name || c.hostname || '',
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.clients', function: 'getClients', logMessage: 'Failed to fetch UniFi clients' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.switches', function: 'getSwitches', logMessage: 'Failed to fetch UniFi switches' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.wifi', function: 'getWifiNetworks', logMessage: 'Failed to fetch WiFi networks' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.wifi', function: 'updateWifiNetwork', logMessage: 'Failed to update WiFi network' });
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
            // 內網來源 (OUTBOUND 警報，例如內網設備對外掃描/可疑流量) 沒有 GeoIP，
            // 標示為「內網設備」而非 Unknown，避免誤以為資料壞掉
            const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(t.src_ip || '');
            return {
                id: t._id,
                datetime: new Date(t.time || Date.parse(t.datetime)).toISOString(), // 優先用不會有時區歧義的 epoch time 欄位
                src_ip: t.src_ip,
                src_country: geo.country_name || t.src_country || (isPrivate ? '內網設備' : 'Unknown'),
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.threats', function: 'getThreats', logMessage: 'Failed to fetch UniFi threats' });
    }
});

// 資料持久化目錄 (可用 DATA_DIR 環境變數覆寫；Docker 部署時掛載為 volume 以保留歷史資料)
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (error) {
    logger.critical({
        module: 'app.storage', function: 'mkdir', code: ERROR_CODES.SYS_START_FAILED,
        message: 'Startup failed: data directory is not writable', error,
        fields: { data_dir: DATA_DIR, suggested_check: 'Check DATA_DIR ownership and Docker volume permissions.' }
    });
    process.exit(1);
}

/* ===================== 單一實例鎖 =====================
   防止同一份 DATA_DIR 被多個 server.js 同時使用：每個實例都有自己的推播監看器，
   多開會導致同一事件重複推播 N 次 (實際發生過：4 個測試殘留實例 + 正式 = 同則警報×5)。
   鎖檔記 PID；持鎖程序已死 (stale) 則接管。設 ALLOW_MULTI_INSTANCE=1 可跳過 (測試用)。 */
const LOCK_FILE = path.join(DATA_DIR, '.instance.lock');
if (process.env.ALLOW_MULTI_INSTANCE !== '1') {
    try {
        const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
        if (oldPid && oldPid !== process.pid) {
            let alive = false;
            try { process.kill(oldPid, 0); alive = true; } catch { }
            if (alive) {
                logger.critical({
                    module: 'app.instanceLock', function: 'acquire', code: ERROR_CODES.SYS_START_FAILED,
                    message: 'Another SmartHub instance is already using this DATA_DIR',
                    fields: { existing_pid: oldPid, suggested_check: 'Use a different DATA_DIR or set ALLOW_MULTI_INSTANCE=1 only for isolated tests.' }
                });
                process.exit(1);
            }
        }
    } catch { /* 鎖檔不存在 = 正常首啟 */ }
    try { fs.writeFileSync(LOCK_FILE, String(process.pid)); }
    catch (error) {
        logger.critical({
            module: 'app.instanceLock', function: 'acquire', code: ERROR_CODES.SYS_START_FAILED,
            message: 'Failed to create SmartHub instance lock', error, fields: { lock_file: path.basename(LOCK_FILE) }
        });
        process.exit(1);
    }
    process.on('exit', () => { try { if (parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK_FILE); } catch { } });
}

// 統計/歷史資料集中由 SQLite 管理；啟動時會將既有 JSON 匯入並保留 .migrated.bak。
const { createHistoryDb } = require('./db');
let historyDb;
try {
    historyDb = createHistoryDb(DATA_DIR, { logger, slowQueryMs: process.env.DB_SLOW_QUERY_MS });
} catch (error) {
    logger.critical({
        module: 'app.lifecycle', function: 'initializeDatabase', code: ERROR_CODES.SYS_START_FAILED,
        message: 'STARTUP FAILED: SQLite initialization failed', error,
        fields: {
            component: 'SQLite',
            possible_causes: ['DATA_DIR is not writable', 'Database file is corrupt or locked', 'Container volume ownership is incorrect'],
            suggested_checks: ['docker compose logs unifi-smarthub', 'docker compose exec unifi-smarthub ls -la /app/data']
        }
    });
    process.exit(1);
}
const HISTORY_HARD_CAP = 100000;
const systemMonitor = new SystemMonitor({
    dataDir: DATA_DIR, db: historyDb, taskTracker, issueTracker, logger, version: APP_VERSION
});

/* ===================== 應用程式設定 (可於「設定」頁調整所有伺服器端輪詢間隔) ===================== */
const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
const APP_DEFAULTS = {
    trendActiveSec: 30,     // 有人瀏覽時趨勢取樣間隔
    trendIdleSec: 1800,     // 閒置時趨勢取樣間隔 (30 分鐘)
    activeWindowSec: 30,    // 最近幾秒內有活動視為「有人瀏覽」
    watcherSec: 20,         // 通知監看器間隔
    toastSec: 10,           // 右下角通知泡泡顯示秒數
    autoDefenseSec: 30,     // 自動防禦掃描間隔
    reportEnabled: true,    // 定期報表 (預設開啟；實際發送仍需通知頁啟用推播+設定管道)
    reportFreq: 'daily',    // daily | weekly
    reportHour: 8,          // 每日幾點發送 (0-23)
    reportHour2: 20,        // 「每日兩次」的第二次發送時間 (0-23)
    upsSampleSec: 30,       // UPS 電壓/電池取樣間隔 (不做閒置降頻，持續記錄)
    wiimCpuAlert: 70,       // WiiM CPU 溫度警示門檻 (°C，圖上門檻線 + 超標推播)
    wiimBoardAlert: 60,     // WiiM 主機板溫度警示門檻 (°C)
    historyFlushMin: 10,    // 一般遙測先存記憶體，再批次寫入 SQLite
    historyKeepDays: 30     // 歷史資料保存天數 (trend/UCG/NAS/UPS/WiiM 統一)
};
const APP_SETTING_RANGES = {
    trendActiveSec: [5, 3600], trendIdleSec: [60, 86400], activeWindowSec: [5, 3600],
    watcherSec: [5, 3600], autoDefenseSec: [5, 3600], reportHour: [0, 23], reportHour2: [0, 23],
    upsSampleSec: [5, 3600], wiimCpuAlert: [1, 120], wiimBoardAlert: [1, 120],
    toastSec: [1, 60], historyFlushMin: [1, 60], historyKeepDays: [1, 365]
};
function normalizeAppSettings(settings) {
    for (const [key, [min, max]] of Object.entries(APP_SETTING_RANGES)) {
        if (typeof settings[key] === 'number' && Number.isFinite(settings[key])) {
            settings[key] = Math.min(max, Math.max(min, settings[key]));
        }
    }
    return settings;
}
let appSettings = normalizeAppSettings((() => {
    try { return { ...APP_DEFAULTS, ...JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')) }; }
    catch (error) {
        if (error.code !== 'ENOENT') logger.warning({
            module: 'config.app', function: 'loadAppSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'App settings could not be read; defaults are in use', error, fields: { file: path.basename(APP_SETTINGS_FILE) }
        });
        return { ...APP_DEFAULTS };
    }
})());
function saveAppSettings() { fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }

// SQLite 以資料庫端清理取代舊的記憶體陣列 prune；清理後保留增量 vacuum，避免檔案無限膨脹。
historyDb.cleanup(appSettings.historyKeepDays, HISTORY_HARD_CAP);
setInterval(() => runSerialJob('historyCleanup', () => historyDb.cleanup(appSettings.historyKeepDays, HISTORY_HARD_CAP)), 60 * 60 * 1000);
let lastHistoryFlushTs = Date.now();
setInterval(() => {
    const gap = Math.max(Number(appSettings.historyFlushMin) || 10, 1) * 60 * 1000;
    if (Date.now() - lastHistoryFlushTs < gap) return;
    lastHistoryFlushTs = Date.now();
    runSerialJob('historyFlush', () => historyDb.flush());
}, 10000);

// 封鎖歷史紀錄 (僅記錄透過本面板下達的動作)
function loadBlockHistory() { return historyDb.listBlockHistory(); }
function appendBlockHistory(entry) { historyDb.insertBlock(entry); }

/* ===================== 客戶端自訂名稱 (別名) =====================
   UniFi 未命名的設備會顯示 Unknown，這裡讓使用者在面板上直接取名，
   存 data/client-aliases.json ({mac: name})，套用於客戶端清單/Top5/報表等所有顯示。 */
const CLIENT_ALIAS_FILE = path.join(DATA_DIR, 'client-aliases.json');
let clientAliases = (() => {
    try { return JSON.parse(fs.readFileSync(CLIENT_ALIAS_FILE, 'utf8')); }
    catch (error) {
        if (error.code !== 'ENOENT') logger.warning({
            module: 'config.clientAliases', function: 'loadAliases', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Client aliases could not be read; using an empty map', error, fields: { file: path.basename(CLIENT_ALIAS_FILE) }
        });
        return {};
    }
})();
app.get('/api/client-aliases', (req, res) => res.json({ aliases: clientAliases }));
app.post('/api/client-aliases', (req, res) => {
    const { mac, name } = req.body || {};
    if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) return apiError(res, new Error('invalid mac'), {
        status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'invalid mac', module: 'api.clientAliases', function: 'saveAlias'
    });
    if (name != null && typeof name !== 'string') return apiError(res, new Error('invalid name'), {
        status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'invalid name', module: 'api.clientAliases', function: 'saveAlias'
    });
    const trimmed = (name || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
    if (trimmed) clientAliases[mac.toLowerCase()] = trimmed;
    else delete clientAliases[mac.toLowerCase()];
    try { fs.writeFileSync(CLIENT_ALIAS_FILE, JSON.stringify(clientAliases, null, 2)); }
    catch (error) {
        return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.clientAliases', function: 'saveAlias', logMessage: 'Client alias persistence failed' });
    }
    res.json({ ok: true, aliases: clientAliases });
});

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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.poe', function: 'powerCycle', logMessage: 'PoE power cycle failed' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.speedtest', function: 'startSpeedtest', logMessage: 'UniFi speed test start failed' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.speedtest', function: 'getSpeedtestStatus', logMessage: 'Failed to fetch speed test status' });
    }
});

// 9. 獲取雲端站點清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/sites', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        const response = await unifiCloudClient.get('/sites');
        res.json(response.data);
    } catch (error) {
        logRecoverableFailure('cloud.sites', error, { module: 'api.cloud', function: 'getSites', code: ERROR_CODES.EXT_UNIFI_FAILED });
        res.json({ data: [], source: 'error', error: publicError(error) });
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
        logRecoverableFailure('cloud.devices', error, { module: 'api.cloud', function: 'getDevices', code: ERROR_CODES.EXT_UNIFI_FAILED });
        res.json({ data: [], source: 'error', error: publicError(error) });
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
        logRecoverableFailure('cloud.ispMetrics', error, { module: 'api.cloud', function: 'getIspMetrics', code: ERROR_CODES.EXT_UNIFI_FAILED });
        res.json({ data: null, source: 'error', error: publicError(error) });
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
        logRecoverableFailure('cloud.hosts', error, { module: 'api.cloud', function: 'getHosts', code: ERROR_CODES.EXT_UNIFI_FAILED });
        res.json({ data: [], source: 'error', error: publicError(error) });
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
        logRecoverableFailure('cloud.sdwan', error, { module: 'api.cloud', function: 'getSdwan', code: ERROR_CODES.EXT_UNIFI_FAILED });
        res.json({ data: [], source: 'error', error: publicError(error) });
    }
});

/* ===================== 資安設定與自動防禦聯動 ===================== */
// 自動防禦 (預設關閉)：偵測到內網設備遭 Malware/Trojan/Botnet/C2 感染事件時，自動 block-sta 斷網隔離。
// 僅隔離「內網受感染設備」(規格 §4.2)，不會改動主控台 IDS/IPS 偵測設定。
const SEC_FILE = path.join(DATA_DIR, 'security-settings.json');
// 記憶體快取：啟動時讀一次，之後讀取零 I/O，寫入時同步更新
let secSettingsCache = null;
function loadSecSettings() {
    if (secSettingsCache) return secSettingsCache;
    try { secSettingsCache = { autoDefense: false, ...JSON.parse(fs.readFileSync(SEC_FILE, 'utf8')) }; }
    catch (error) {
        if (error.code !== 'ENOENT') logger.warning({
            module: 'config.security', function: 'loadSecSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Security settings could not be read; safe defaults are in use', error, fields: { file: path.basename(SEC_FILE) }
        });
        secSettingsCache = { autoDefense: false };
    }
    return secSettingsCache;
}
function saveSecSettings(s) {
    secSettingsCache = s;
    fs.writeFileSync(SEC_FILE, JSON.stringify(s, null, 2));
}

app.get('/api/security/settings', (req, res) => res.json(loadSecSettings()));
app.post('/api/security/settings', (req, res) => {
    const s = loadSecSettings();
    if (typeof req.body.autoDefense === 'boolean') s.autoDefense = req.body.autoDefense;
    try { saveSecSettings(s); }
    catch (error) { return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.security', function: 'saveSecSettings', logMessage: 'Security settings persistence failed' }); }
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
    } catch (err) { throw err; }
}
// 掃描排程統一由 scheduleServerJobs() 管理 (間隔可於設定頁調整)；先前這裡多排了一個固定 30s 的
// setInterval 導致每輪實際掃描兩遍，已移除。

// 去重 Set 通用上限：超過 max 時保留最新一半，避免長期運行無限成長
function capSet(set, max = 2000) {
    if (set.size <= max) return;
    const keep = [...set].slice(-Math.floor(max / 2));
    set.clear();
    keep.forEach(x => set.add(x));
}

/* ===================== 通知推播中心 ===================== */
// 偵測到新威脅攔截或 NAS 嚴重警報時，推播到 Discord / Telegram / 通用 Webhook。
const NOTIF_FILE = path.join(DATA_DIR, 'notification-settings.json');
const NOTIF_DEFAULTS = { enabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', triggerThreats: true, triggerNasAlerts: true, triggerWiimTemp: true, triggerUpsOutage: true, triggerUpsLowBatt: true, triggerNewClient: false, triggerWiimOffline: false, triggerBlockAction: true, triggerNasDiskTemp: false, nasDiskTempAlert: 50, triggerNasSpace: false, nasSpaceAlert: 85, triggerUcgTemp: false, ucgTempAlert: 75, triggerWanDown: false, triggerNasLog: true, triggerUpsHighLoad: false, upsLoadAlert: 80, triggerUpsVoltAbnormal: false, upsVoltDeviationPct: 10, triggerUpsSourceChange: false, triggerAdgProtection: true, triggerAdgOffline: false, triggerLinuxTemp: true, linuxTempAlert: 70, triggerLinuxOffline: false, triggerLinuxDisk: false, linuxDiskAlert: 90 };
// 記憶體快取：watcher 每輪呼叫多次，不需要每次讀檔
let notifSettingsCache = null;
function loadNotifSettings() {
    if (notifSettingsCache) return notifSettingsCache;
    try { notifSettingsCache = { ...NOTIF_DEFAULTS, ...JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')) }; }
    catch (error) {
        if (error.code !== 'ENOENT') logger.warning({
            module: 'config.notifications', function: 'loadNotifSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Notification settings could not be read; defaults are in use', error, fields: { file: path.basename(NOTIF_FILE) }
        });
        notifSettingsCache = { ...NOTIF_DEFAULTS };
    }
    return notifSettingsCache;
}
function saveNotifSettings(s) {
    notifSettingsCache = s;
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(s, null, 2));
}

let notifLog = [];
function pushNotifLog(e) { notifLog.unshift(e); notifLog = notifLog.slice(0, 50); }

// 實際送出 (依 channel 走不同格式)。回傳 {ok} 或 {ok:false,error}
// 長文分段：依平台上限沿換行切塊 (Discord 2000 / Telegram 4096)，避免詳細報表被整則拒收
function chunkText(text, max) {
    if (text.length <= max) return [text];
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if (cur && cur.length + line.length + 1 > max) { chunks.push(cur); cur = ''; }
        cur = cur ? cur + '\n' + line : line;
    }
    if (cur) chunks.push(cur);
    return chunks;
}
async function dispatchNotification(title, body, settings) {
    const s = settings || loadNotifSettings();
    const text = `${title}\n${body}`;
    if (s.channel === 'telegram') {
        if (!s.botToken || !s.chatId) throw new Error('Telegram 未設定 botToken / chatId');
        try {
            for (const part of chunkText(text, 4000))
                await axios.post(`https://api.telegram.org/bot${s.botToken}/sendMessage`, { chat_id: s.chatId, text: part }, { timeout: 8000 });
        } catch (e) {
            const st = e.response && e.response.status;
            const desc = e.response && e.response.data && e.response.data.description;
            if (st === 404) throw new Error('Telegram 回應 404：Bot Token 錯誤 (請向 @BotFather 重新複製完整 token，格式如 123456789:AAxxxx)');
            if (st === 400 && /chat not found/i.test(desc || '')) throw new Error('Telegram：找不到聊天室。Chat ID 必須是數字 (不是 bot 名稱)，且你要先在 Telegram 對這個 bot 送出任一訊息，再按「偵測 Chat ID」');
            throw new Error(`Telegram ${st || ''}: ${desc || e.message}`);
        }
    } else if (s.channel === 'discord') {
        if (!s.webhookUrl) throw new Error('Discord Webhook URL 未設定');
        for (const part of chunkText(text, 1900))
            await axios.post(s.webhookUrl, { content: part }, { timeout: 8000 });
    } else {
        if (!s.webhookUrl) throw new Error('Webhook URL 未設定');
        await axios.post(s.webhookUrl, { title, body, text, ts: new Date().toISOString() }, { timeout: 8000 });
    }
}

// Telegram Chat ID 偵測：讀 bot 的 getUpdates，列出最近跟它說過話的聊天室
app.get('/api/notifications/telegram-chatid', async (req, res) => {
    const s = loadNotifSettings();
    if (!s.botToken) return apiError(res, new Error('Telegram bot token is not configured'), {
        status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: '請先填入 Bot Token 並儲存',
        module: 'api.notifications', function: 'detectTelegramChatId'
    });
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
        apiError(res, e, {
            code: ERROR_CODES.EXT_NOTIFICATION_FAILED, module: 'api.notifications', function: 'detectTelegramChatId',
            logMessage: 'Telegram chat ID lookup failed',
            publicMessage: st === 404 ? 'Bot Token 無效 (Telegram 回應 404)，請向 @BotFather 重新複製' : 'Telegram 查詢失敗'
        });
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
        logger.error({
            module: 'notification.dispatch', function: 'notify', code: ERROR_CODES.EXT_NOTIFICATION_FAILED,
            message: 'Notification delivery failed', error: e, fields: { channel: s.channel, title }
        });
        pushNotifLog({ ts: new Date().toISOString(), title, body, channel: s.channel, ok: false, error: publicError(e) });
        return { ok: false, error: publicError(e) };
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
        triggerUpsHighLoad: !!s.triggerUpsHighLoad, upsLoadAlert: s.upsLoadAlert ?? 80, triggerUpsVoltAbnormal: !!s.triggerUpsVoltAbnormal, upsVoltDeviationPct: s.upsVoltDeviationPct ?? 10, triggerUpsSourceChange: !!s.triggerUpsSourceChange,
        triggerAdgProtection: s.triggerAdgProtection !== false, triggerAdgOffline: !!s.triggerAdgOffline,
        triggerLinuxTemp: s.triggerLinuxTemp !== false, linuxTempAlert: s.linuxTempAlert ?? 70,
        triggerLinuxOffline: !!s.triggerLinuxOffline, triggerLinuxDisk: !!s.triggerLinuxDisk, linuxDiskAlert: s.linuxDiskAlert ?? 90,
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
    ['triggerUpsOutage', 'triggerUpsLowBatt', 'triggerNewClient', 'triggerWiimOffline', 'triggerBlockAction', 'triggerNasDiskTemp', 'triggerNasSpace', 'triggerUcgTemp', 'triggerWanDown', 'triggerNasLog', 'triggerUpsHighLoad', 'triggerUpsVoltAbnormal', 'triggerUpsSourceChange', 'triggerAdgProtection', 'triggerAdgOffline', 'triggerLinuxTemp', 'triggerLinuxOffline', 'triggerLinuxDisk'].forEach(k => { if (typeof b[k] === 'boolean') s[k] = b[k]; });
    ['nasDiskTempAlert', 'nasSpaceAlert', 'ucgTempAlert', 'upsLoadAlert', 'upsVoltDeviationPct', 'linuxTempAlert', 'linuxDiskAlert'].forEach(k => { if (typeof b[k] === 'number' && b[k] > 0) s[k] = b[k]; });
    if (b.webhookUrl) s.webhookUrl = b.webhookUrl;   // 留空不覆寫
    if (b.botToken) s.botToken = b.botToken;
    try { saveNotifSettings(s); }
    catch (error) { return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.notifications', function: 'saveNotifSettings', logMessage: 'Notification settings persistence failed' }); }
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
        } catch (error) {
            logRecoverableFailure('watcher.unifiThreats', error, { module: 'watcher.notifications', function: 'scanThreats', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // NAS 嚴重警報
    if (s.triggerNasAlerts && nasMonConfigured()) {
        try {
            const data = await nasMonGet('/api/alerts/events', { hours: 24 });
            const events = Array.isArray(data) ? data : (data.events || data.data || []);
            await forwardNasAlerts(events, {
                knownIds: notifiedNasAlertIds,
                bootstrapped: notifBootstrapped,
                notify
            });
        } catch (error) {
            logRecoverableFailure('watcher.nasAlerts', error, { module: 'watcher.notifications', function: 'scanNasAlerts', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        }
    }
    // WiiM 溫度超標推播 (30 分鐘冷卻，避免洗版)
    if (s.triggerWiimTemp !== false) {
        const last = historyDb.getLatest('wiim');
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
        } catch (error) {
            logRecoverableFailure('watcher.newClients', error, { module: 'watcher.notifications', function: 'scanNewClients', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // WiiM 離線/恢復 (轉態才通知)
    if (s.triggerWiimOffline) {
        let ok = false;
        try { ok = !!(await wiimGet('getStatusEx')); }
        catch (error) {
            ok = false;
            logRecoverableFailure('watcher.wiimOffline', error, { module: 'watcher.notifications', function: 'checkWiimOnline', code: ERROR_CODES.EXT_WIIM_FAILED });
        }
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
        } catch (error) {
            logRecoverableFailure('watcher.nasCapacity', error, { module: 'watcher.notifications', function: 'checkNasCapacity', code: ERROR_CODES.EXT_NAS_FAILED });
        }
    }
    // NAS 系統日誌 — 推播 UGOS 日誌中心所有事件（與前端 NAS 頁「系統日誌與警報」區塊同步）
    if (s.triggerNasLog && nasConfigured()) {
        try {
            const data = await nasGet('/ugreen/v1/log/query', { visualizer: false, page: 0, size: 50, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
            // NAS 事件一旦進入 SmartHub 就立即呼叫手機推播，不經過歷史資料的記憶體緩衝。
            await forwardNasLogs(data.log_list || [], {
                knownIds: notifiedNasLogIds,
                bootstrapped: notifBootstrapped,
                notify
            });
        } catch (error) {
            logRecoverableFailure('watcher.nasLogs', error, { module: 'watcher.notifications', function: 'scanNasLogs', code: ERROR_CODES.EXT_NAS_FAILED });
        }
    }
    // UCG CPU 溫度 / WAN 斷線 (透過本機 /api/hardware，僅在開啟時才發起 SSH)
    if ((s.triggerUcgTemp || s.triggerWanDown) && !isPlaceholder(process.env.SSH_PASSWORD)) {
        try {
            const hw = await getHardwareCached();
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
        } catch (error) {
            logRecoverableFailure('watcher.ucgHealth', error, { module: 'watcher.notifications', function: 'checkUcgHealth', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // AdGuard：保護被暫停 / 失聯 (轉態通知)
    if ((s.triggerAdgProtection !== false || s.triggerAdgOffline) && adgConfigured()) {
        let on = null;
        try { on = !!(await adgReq('/control/status')).protection_enabled; }
        catch (error) {
            on = null;
            logRecoverableFailure('watcher.adguard', error, { module: 'watcher.notifications', function: 'checkAdguard', code: ERROR_CODES.EXT_ADGUARD_FAILED });
        }
        if (s.triggerAdgOffline && on === null && adgWasOn !== null && notifBootstrapped) {
            await notify('🛡️ AdGuard 失聯', 'AdGuard Home 無回應，DNS 防護狀態未知');
        }
        if (s.triggerAdgProtection !== false && on !== null && adgWasOn !== null && on !== adgWasOn && notifBootstrapped) {
            await notify(on ? '🛡️ AdGuard 保護已恢復' : '⚠️ AdGuard 保護已暫停', on ? 'DNS 廣告攔截恢復運作' : '全網 DNS 廣告攔截目前停用中');
        }
        if (on !== null) adgWasOn = on;
    }
    // Linux 小主機：過熱 / 磁碟滿 (30 分鐘冷卻)、離線/恢復 (轉態)
    if ((s.triggerLinuxTemp !== false || s.triggerLinuxOffline || s.triggerLinuxDisk) && linuxConfigured()) {
        let d = null;
        try { d = await getLinuxCached(); }
        catch (error) {
            d = null;
            logRecoverableFailure('watcher.linux', error, { module: 'watcher.notifications', function: 'checkLinux', code: ERROR_CODES.EXT_LINUX_FAILED });
        }
        if (s.triggerLinuxOffline && lnxWasOnline !== null && (!!d) !== lnxWasOnline && notifBootstrapped) {
            await notify(d ? '🖥️ 小主機已恢復連線' : '🖥️ 小主機失去連線', `${process.env.LINUX_HOST} (SSH)`);
        }
        lnxWasOnline = !!d;
        if (d && s.triggerLinuxTemp !== false && d.cpuTemp != null && d.cpuTemp >= (s.linuxTempAlert ?? 70)
            && Date.now() - lastLinuxTempTs > 30 * 60 * 1000) {
            lastLinuxTempTs = Date.now();
            await notify('🔥 小主機溫度警報', `${d.hostname} CPU ${d.cpuTemp}°C (門檻 ${s.linuxTempAlert ?? 70}°C)`);
        }
        if (d && s.triggerLinuxDisk && d.diskUsagePct != null && d.diskUsagePct >= (s.linuxDiskAlert ?? 90)
            && Date.now() - lastLinuxDiskTs > 6 * 60 * 60 * 1000) {
            lastLinuxDiskTs = Date.now();
            await notify('💾 小主機磁碟空間警報', `${d.hostname} 系統碟已用 ${d.diskUsagePct}% (門檻 ${s.linuxDiskAlert ?? 90}%)`);
        }
    }
    // 去重 Set 上限維護 (防長期運行無限成長；iOS 隨機 MAC 會讓 knownClientMacs 持續累積)
    capSet(notifiedThreatIds); capSet(notifiedNasAlertIds); capSet(notifiedNasLogIds); capSet(knownClientMacs, 4000);
    notifBootstrapped = true;
}
let lastNasDiskTempTs = 0, lastNasSpaceTs = 0, lastUcgTempTs = 0, wanWasUp = null;
const knownClientMacs = new Set();
const notifiedNasLogIds = new Set();
let wiimWasOnline = null;
let lastWiimTempAlertTs = 0;
let adgWasOn = null, lnxWasOnline = null, lastLinuxTempTs = 0, lastLinuxDiskTs = 0;

/* ===================== 伺服器端排程 (間隔可於設定頁調整，變更後即時重排) ===================== */
let jobTimers = {};
const runningJobs = new Set();
async function runSerialJob(name, fn) {
    if (runningJobs.has(name)) {
        taskTracker.skip(name);
        return;
    }
    runningJobs.add(name);
    try { return await taskTracker.run(name, fn); }
    catch { /* TaskTracker 已記錄完整 error/stack/task_id；週期工作留待下一輪重試。 */ }
    finally { runningJobs.delete(name); }
}
function scheduleServerJobs() {
    clearInterval(jobTimers.watcher);
    clearInterval(jobTimers.autodef);
    jobTimers.watcher = setInterval(() => runSerialJob('notificationWatcher', notificationWatcher), Math.max(appSettings.watcherSec, 5) * 1000);
    jobTimers.autodef = setInterval(() => runSerialJob('autoDefenseSweep', autoDefenseSweep), Math.max(appSettings.autoDefenseSec, 5) * 1000);
}

/* ===================== 歷史趨勢取樣器 (自適應頻率) ===================== */
// 記錄一筆：客戶端數、24h 威脅數、ISP 延遲。
// 取樣頻率隨「是否有人正在看網頁」自動切換 (間隔取自 appSettings，可於設定頁調整)。
let lastSampleTs = 0;                    // 上一次取樣時間戳
let lastSchedulerState = null;           // 前端最後一狀態 (活躍/閒置)
const deviceActivity = createActivityLease({ maxLeaseMs: 45000 });
function markClientActivity(scopes = 'trend') {
    const requestedMs = (appSettings.activeWindowSec || 30) * 1000;
    return deviceActivity.mark(scopes, requestedMs);
}
function isDeviceSamplingActive(scope) { return deviceActivity.isActive(scope); }

async function sampleTrends() {
    const point = { t: new Date().toISOString(), clients: null, threats24h: null, latency: null };
    try {
        const cookie = await getLocalSession();
        const sta = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
        point.clients = (sta.data.data || []).length;
        const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
        const dayAgo = Date.now() - 86400000;
        point.threats24h = (alarm.data.data || []).filter(a => isIpsAlarm(a) && new Date(a.datetime).getTime() >= dayAgo).length;
    } catch (error) {
        logRecoverableFailure('sampler.trend.unifi', error, { module: 'scheduler.trend', function: 'sampleLocalMetrics', code: ERROR_CODES.EXT_UNIFI_FAILED });
        // 本地控制器不可用時該欄位保留 null。
    }
    try {
        if (process.env.UNIFI_API_KEY && !process.env.UNIFI_API_KEY.includes('your_unifi')) {
            const r = await unifiCloudClient.get('/isp-metrics/5m', { params: { duration: '24h' } });
            const periods = (r.data && r.data.data && r.data.data[0] && r.data.data[0].periods) || [];
            if (periods.length) point.latency = (periods[periods.length - 1].data.wan || {}).avgLatency ?? null;
        }
    } catch (error) {
        logRecoverableFailure('sampler.trend.cloud', error, { module: 'scheduler.trend', function: 'sampleCloudMetrics', code: ERROR_CODES.EXT_UNIFI_FAILED });
    }
    if (point.clients === null && point.threats24h === null && point.latency === null) return;
    historyDb.insertPoint('trend', point, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });
}

// 排程器：每秒檢查一次，依活躍/閒置狀態與設定的間隔決定是否該取樣
async function trendScheduler() {
    const now = Date.now();
    const active = isDeviceSamplingActive('trend');
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
setInterval(() => runSerialJob('trendScheduler', trendScheduler), 1000);
runSerialJob('trendScheduler', trendScheduler);
scheduleServerJobs();
systemMonitor.start();
logger.info({
    module: 'scheduler', function: 'scheduleServerJobs', code: ERROR_CODES.WORKER_READY,
    message: 'Background schedulers ready', fields: {
        jobs: ['notificationWatcher', 'autoDefenseSweep', 'trendScheduler', 'historyCleanup', 'nasHistory', 'reportScheduler', 'wiimTemperature', 'upsSample', 'linuxHistory']
    }
});

// 14. 歷史趨勢查詢 (?hours=24 / 168)。只加快 trend，不會連帶加快 NAS/WiiM/Linux。
app.get('/api/history', (req, res) => {
    markClientActivity('trend');
    const hours = parseInt(req.query.hours || '24', 10);
    const cutoff = Date.now() - hours * 3600000;
    res.json({ history: historyDb.getSince('trend', cutoff) });
});

// 輕量心跳端點：只為目前顯示的裝置續短租約；沒有續約最晚 45 秒自動回到低頻。
app.get('/api/heartbeat', (req, res) => {
    const activity = markClientActivity(req.query.scope || '');
    res.json({ ok: true, activeScopes: deviceActivity.activeScopes(), expiresAt: activity.expiresAt });
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

async function nasGet(pathName, params = {}, _retried = false) {
    const token = await getNasToken();
    const r = await nasClient.get(pathName, { params: { ...params, token } });
    // UGOS 一律回 HTTP 200，錯誤放在 body.code (1004/1008 = 權限不足，需管理員帳號)
    if (r.data && typeof r.data.code === 'number' && r.data.code !== 200) {
        const permErr = [1004, 1008].includes(r.data.code);
        // 權限錯誤重試也沒用；其他錯誤(含 token 失效，例如 NAS 重開機後舊 token 被清空)一律
        // 清掉快取 token 重新登入後重試一次 —— 不用去猜 UGOS 到底吐哪個代碼表示 token 失效
        if (!permErr && !_retried) {
            sysLog('NAS Auth', `${pathName} 回 code ${r.data.code}，可能是 token 失效 (如 NAS 重開機)，清除快取重新登入後重試`, false);
            nasToken = ''; nasTokenExpiry = 0;
            return nasGet(pathName, params, true);
        }
        throw new Error(permErr
            ? `NAS 帳號權限不足 (code ${r.data.code})：此 API 僅限管理員帳號，請在 UGOS 將使用者設為管理員或改用管理員帳密`
            : `UGOS code ${r.data.code}: ${r.data.msg || r.data.debug || ''}`);
    }
    return r.data && r.data.data !== undefined ? r.data.data : r.data;
}

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
        // 休眠判定以 UGOS 日誌為準：get_all 的 activate 實測不可靠 (休眠中仍回 true，前端全部顯示運轉中)
        let disksLite = [];
        try {
            const sleepMap = await getDiskSleepFromLogs();
            disksLite = ((statsRaw && statsRaw.disk && statsRaw.disk.series) || [])
                .filter(d => d.name !== 'overview')
                .map(d => {
                    const name = d.label || d.name;
                    const sleeping = sleepMap[name] ?? !d.activate;
                    return { name, temperature: sleeping ? null : d.temperature, sleeping };
                });
        } catch { }
        // 風扇轉速：藏在 get_all 的 overview.device_fan / overview.cpu_fan (陣列，每顆風扇 {speed,status})
        // 這份資料先前誤判為「此機型無風扇轉速」，實測 UGOS 1.17 確實有回傳
        let fans = [];
        try {
            const ov = statsRaw && statsRaw.overview;
            if (ov) {
                const label = (arr, prefix) => (arr || []).map((f, i) => ({ name: `${prefix}${arr.length > 1 ? i + 1 : ''}`, rpm: f.speed ?? null, status: f.status === 1 ? 'normal' : (f.status != null ? `abnormal(${f.status})` : 'unknown') }));
                fans = [...label(ov.cpu_fan, 'CPU 風扇'), ...label(ov.device_fan, '機殼風扇')];
            }
        } catch { }
        res.json({ info, stats, disksLite, fans, statsRaw, statsError, source: 'nas_api' });
    } catch (error) {
        logRecoverableFailure('nas.overview', error, { module: 'api.nas', function: 'getOverview', code: ERROR_CODES.EXT_NAS_FAILED });
        res.json({ info: null, stats: null, source: 'error', error: publicError(error) });
    }
});

/* 硬碟目前是否休眠 — 以 UGOS 日誌中心的 sleeping 事件推斷 (每顆碟取最新一筆
   "Hard Drive N started/stopped sleeping")。get_all 與 disk/list 的 activate/is_standby
   欄位實測不可靠 (休眠中仍回運轉)，且 disk/list 本身會喚醒硬碟；日誌查詢不會。快取 60 秒。 */
let diskSleepCache = { ts: 0, map: {} };
async function getDiskSleepFromLogs() {
    if (Date.now() - diskSleepCache.ts < 60 * 1000) return diskSleepCache.map;
    try {
        const data = await nasGet('/ugreen/v1/log/query', { visualizer: false, page: 0, size: 200, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
        const latest = {}; // 硬碟N → { t, sleeping }
        for (const l of (data.log_list || [])) {
            const m = (l.content || '').match(/Hard Drive (\d+) (started|stopped) sleeping/i);
            if (!m) continue;
            const k = '硬碟' + m[1];
            if (!latest[k] || l.create_time > latest[k].t) latest[k] = { t: l.create_time, sleeping: m[2].toLowerCase() === 'started' };
        }
        diskSleepCache = { ts: Date.now(), map: Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.sleeping])) };
    } catch { diskSleepCache.ts = Date.now(); } // 讀不到日誌就沿用舊快取，避免連續重試
    return diskSleepCache.map;
}

// 16. NAS 實體硬碟清單 (含溫度與健康狀態)
app.get('/api/nas/disks', async (req, res) => {
    if (!nasConfigured()) return res.json({ disks: [], source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
        let disks = deepFind({ d: data }, ['result', 'list', 'disks']) || (Array.isArray(data) ? data : []);
        const sleepMap = await getDiskSleepFromLogs();
        // UGOS 1.17 實機：status 為數字 (1=健康)、size 為 bytes、顯示名稱在 label (硬碟1...)
        disks = disks.map(d => ({
            ...d,
            name: d.label || d.name,
            status: d.status === 1 ? 'good' : (typeof d.status === 'number' ? `abnormal(${d.status})` : d.status),
            size_gb: d.size ? Math.round(d.size / 1e9) : d.size_gb,
            // 休眠判定：日誌優先，回退 is_standby / activate
            sleeping: sleepMap[d.label || d.name] ?? (d.is_standby === true || d.activate === false)
        }));
        res.json({ disks, source: 'nas_api' });
    } catch (error) {
        logRecoverableFailure('nas.disks', error, { module: 'api.nas', function: 'getDisks', code: ERROR_CODES.EXT_NAS_FAILED });
        res.json({ disks: [], source: 'error', error: publicError(error) });
    }
});

// 16-1. 單顆硬碟 SMART 詳情 (UGOS 端點需要 disk=/dev/<dev_name>)
app.get('/api/nas/disk-smart', async (req, res) => {
    if (!nasConfigured()) return apiError(res, new Error('NAS is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_not_configured', module: 'api.nas', function: 'getDiskSmart'
    });
    let dev = req.query.dev; // 前端傳 dev_name (sdb / nvme0n1)，或只傳 name (硬碟1) 由後端查對照
    try {
        if (!dev && req.query.name) {
            // 前端平時不打 disk/list (避免喚醒)；使用者點看 SMART 才在此查一次 label→dev_name
            const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
            const list = deepFind({ d: data }, ['result', 'list', 'disks']) || [];
            const hit = list.find(d => (d.label || d.name) === req.query.name);
            if (hit) dev = hit.dev_name;
        }
        if (!dev) return apiError(res, new Error('missing dev'), {
            status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'missing dev', module: 'api.nas', function: 'getDiskSmart'
        });
        const diskPath = dev.startsWith('/dev/') ? dev : `/dev/${dev}`;
        const data = await nasGet('/ugreen/v1/storage/disk/smart/info', { disk: diskPath });
        res.json({ smart: data, source: 'nas_api' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_FAILED, module: 'api.nas', function: 'getDiskSmart', logMessage: 'Failed to fetch NAS SMART data' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_FAILED, module: 'api.nas', function: 'getNasLogs', logMessage: 'Failed to fetch NAS system logs' });
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
        const byDay = {};  // 'YYYY-MM-DD' → { driveN: { sec, n } }
        const wakeEvents = {}; // day → [{drive, t}]
        // 日期鍵必須零填補 (YYYY-MM-DD)：原本 zh-TW 格式 '2026/7/12' 用字串排序會排在 '2026/7/2' 前面，
        // 導致統計清單的日期順序錯亂；en-CA locale 恰好輸出 ISO 格式，可直接字串排序
        const dayKey = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_FAILED, module: 'api.nas', function: 'getNasSleepStats', logMessage: 'Failed to fetch NAS sleep statistics' });
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
        logRecoverableFailure('nas.volumes', error, { module: 'api.nas', function: 'getVolumes', code: ERROR_CODES.EXT_NAS_FAILED });
        res.json({ volumes: [], source: 'error', error: publicError(error) });
    }
});

// 18. NAS UPS 狀態
app.get('/api/nas/ups', async (req, res) => {
    if (!nasConfigured()) return res.json({ ups: null, source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/config');
        res.json({ ups: data, source: 'nas_api' });
    } catch (error) {
        logRecoverableFailure('nas.ups', error, { module: 'api.nas', function: 'getUps', code: ERROR_CODES.EXT_NAS_FAILED });
        res.json({ ups: null, source: 'error', error: publicError(error) });
    }
});

// 18-1. NAS UPS USB 快速存在性檢查 (系統 A)
app.get('/api/nas/ups-usb', async (req, res) => {
    if (!nasConfigured()) return res.json({ present: null, source: 'not_configured' });
    try {
        const data = await nasGet('/ugreen/v1/hardware/ups/usb/info');
        res.json({ data, source: 'nas_api' });
    } catch (error) {
        logRecoverableFailure('nas.upsUsb', error, { module: 'api.nas', function: 'getUpsUsb', code: ERROR_CODES.EXT_NAS_FAILED });
        res.json({ present: null, source: 'error', error: publicError(error) });
    }
});

/* ===================== UCG 歷史自建取樣器 =====================
   跟 /api/hardware 的 SSH 輪詢共生：每次前端拉硬體資訊成功時，順手記一筆 (節流 30 秒)，
   不需要額外開 SSH 連線。*/
let lastUcgSampleTs = 0;
function sampleUcgHistory({ cpuTemp, cpuUsage, cores, memUsagePct }) {
    if (Date.now() - lastUcgSampleTs < 30000) return;
    lastUcgSampleTs = Date.now();
    historyDb.insertPoint('ucg', { t: new Date().toISOString(), cpuTemp, cpuUsage, memUsagePct, cores }, {
        keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP
    });
}
app.get('/api/hardware/history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    const cutoff = Date.now() - hours * 3600000;
    res.json({ data: historyDb.getSince('ucg', cutoff) });
});

/* ===================== NAS 歷史自建取樣器 =====================
   UGOS 沒有提供歷史 API (只有即時快照 get_all)，這裡自己定期取樣 get_all + volume/list 並持久化，
   讓「系統負載 / 網路流量 / 散熱 / 儲存趨勢」四張圖有真實歷史可畫，不需要另外部署 NAS Monitor (系統 B)。 */
let lastNasSampleTs = 0;

async function sampleNasHistory() {
    if (!nasConfigured()) return;
    try {
        const raw = await nasGet('/ugreen/v1/taskmgr/stat/get_all');
        if (!raw || !raw.cpu) return;
        const cpu = (raw.cpu.series && raw.cpu.series[0]) || {};
        const mem = (raw.mem && raw.mem.series && raw.mem.series[0]) || {};
        const netOv = ((raw.net && raw.net.series) || []).find(n => n.name === 'overview') || {};
        // 只在硬碟「運轉中」時記錄溫度；休眠中的碟記為 null (斷點) —
        // 這樣歷史圖能忠實顯示休眠區段，也證明我們不會為了測溫而喚醒硬碟。
        // 休眠判定與硬碟卡一致：以 UGOS 日誌為準 (activate 欄位不可靠)
        const sleepMap = await getDiskSleepFromLogs();
        const diskTemps = {};
        ((raw.disk && raw.disk.series) || []).filter(d => d.name !== 'overview').forEach(d => {
            const name = d.label || d.name;
            const sleeping = sleepMap[name] ?? !d.activate;
            diskTemps[name] = (!sleeping && d.temperature != null) ? d.temperature : null;
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
        // 風扇轉速 (RPM)：overview.device_fan / cpu_fan，多顆風扇取平均代表一筆歷史值
        let fanRpm = null;
        try {
            const ov = raw.overview;
            const all = [...(ov?.cpu_fan || []), ...(ov?.device_fan || [])].map(f => f.speed).filter(v => v != null);
            if (all.length) fanRpm = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
        } catch { }
        const point = {
            t: new Date().toISOString(),
            cpu: cpu.used_percent != null ? Math.round(cpu.used_percent) : null,
            memory: mem.used_percent != null ? Math.round(mem.used_percent) : null,
            temperature: cpu.temp ?? null,
            fan_rpm: fanRpm,
            up_mbps: +(((netOv.send_rate || 0) * 8 / 1e6).toFixed(2)),
            down_mbps: +(((netOv.recv_rate || 0) * 8 / 1e6).toFixed(2)),
            disks: diskTemps,
            used_gb: volUsedGb, total_gb: volTotalGb
        };
        historyDb.insertPoint('nas', point, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });
    } catch (e) { throw e; }
}
// 自適應：有人看網頁時每 120 秒、閒置時每 15 分鐘。
setInterval(() => {
    const active = isDeviceSamplingActive('nas');
    const gap = (active ? 120 : 900) * 1000;
    if (Date.now() - lastNasSampleTs >= gap) {
        lastNasSampleTs = Date.now();
        runSerialJob('nasHistory', sampleNasHistory);
    }
}, 5000);

function nasHistorySince(hours) {
    return historyDb.getSince('nas', Date.now() - hours * 3600000);
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

// 通用代理：優先呼叫系統 B，失敗或未設定時回退 fallback
async function nasMonProxy(res, path, params, fallback) {
    // 誠實模式：未設定就回空殼 (保留欄位結構、陣列清空)，絕不回傳模擬數據
    const emptyLike = v => Array.isArray(v) ? [] : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyLike(x)])) : null);
    if (!nasMonConfigured()) return res.json({ ...emptyLike(fallback), source: 'not_configured' });
    try {
        const data = await nasMonGet(path, params);
        res.json({ data, source: 'nas_monitor' });
    } catch (error) {
        logRecoverableFailure(`nasMonitor.proxy:${path}`, error, { module: 'api.nasMonitor', function: 'proxy', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, fields: { upstream_path: path } });
        res.json({ ...emptyLike(fallback), source: 'error', error: publicError(error) });
    }
}

// 19. Docker 容器清單 (含即時 CPU/RAM)
app.get('/api/nas/docker', async (req, res) => {
    if (!nasMonConfigured()) return res.json({ containers: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/docker/containers');
        res.json({ containers: Array.isArray(data) ? data : (data.containers || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        logRecoverableFailure('nasMonitor.docker', error, { module: 'api.nasMonitor', function: 'getDockerContainers', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ containers: [], source: 'error', error: publicError(error) });
    }
});

// 20. Docker 容器操作 (start / stop / restart)
app.post('/api/nas/docker/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['start', 'stop', 'restart'].includes(action)) return apiError(res, new Error('invalid action'), {
        status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'invalid action', module: 'api.nasMonitor', function: 'dockerAction'
    });
    if (!nasMonConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'dockerAction'
    });
    try {
        const r = await nasMonClient.post(`/api/docker/containers/${id}/${action}`);
        res.json({ success: true, data: r.data, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'dockerAction', logMessage: 'NAS Monitor Docker action failed' });
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
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'dockerLogs', logMessage: 'Failed to fetch Docker logs' });
    }
});

// 22. 流量統計 (今日 / 本週 / 本月聚合)
app.get('/api/nas/traffic-summary', (req, res) => nasMonProxy(res, '/api/traffic/summary', {},
    { data: { today_gb: 42.6, week_gb: 318.2, month_gb: 1240.7, today_up_gb: 8.1, today_down_gb: 34.5 } }));

// 23. 流量歷史 — 優先系統 B；否則用自建 NAS 取樣歷史
app.get('/api/nas/traffic-history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    if (nasMonConfigured()) return nasMonProxy(res, '/api/traffic/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, upload_mbps: p.up_mbps, download_mbps: p.down_mbps }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 24. 系統歷史 (CPU / 記憶體 / 溫度)
app.get('/api/nas/system-history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    if (nasMonConfigured()) return nasMonProxy(res, '/api/system/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, cpu: p.cpu, memory: p.memory, temperature: p.temperature, fan_rpm: p.fan_rpm ?? null }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 25. 溫度歷史 (各硬碟溫度；此機型 API 無風扇轉速)
app.get('/api/nas/temperature-history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    if (nasMonConfigured()) return nasMonProxy(res, '/api/temperature/history', { hours }, { data: [] });
    const pts = nasHistorySince(hours);
    // 收集所有出現過的硬碟名稱，供前端動態畫線
    const diskNames = [...new Set(pts.flatMap(p => Object.keys(p.disks || {})))];
    const data = pts.map(p => ({ t: p.t, disks: p.disks || {}, fan_rpm: p.fan_rpm ?? null }));
    res.json({ data, diskNames, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 26. 儲存容量歷史
app.get('/api/nas/storage-history', (req, res) => {
    const hours = parseFloat(req.query.hours || '720');
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
        logRecoverableFailure('nasMonitor.alerts', error, { module: 'api.nasMonitor', function: 'getAlerts', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ events: [], source: 'error', error: publicError(error) });
    }
});

// 30. 確認 (清除) 警報
app.post('/api/nas/alerts/:id/ack', async (req, res) => {
    if (!nasMonConfigured()) {
        return apiError(res, new Error('NAS Monitor is not configured'), {
            status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'ackAlert'
        });
    }
    try {
        await nasMonClient.post(`/api/alerts/events/${req.params.id}/acknowledge`);
        res.json({ success: true, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'ackAlert', logMessage: 'NAS Monitor alert acknowledgement failed' });
    }
});

// 31. 警報閾值設定 (系統 B)：面板直接管理各指標的觸發門檻，取代目前「只能看不能改」
app.get('/api/nas/alerts/config', async (req, res) => {
    if (!nasMonConfigured()) return res.json({ config: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/alerts/config');
        res.json({ config: Array.isArray(data) ? data : (data.config || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        logRecoverableFailure('nasMonitor.alertConfig', error, { module: 'api.nasMonitor', function: 'getAlertConfig', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ config: [], source: 'error', error: publicError(error) });
    }
});
app.post('/api/nas/alerts/config', async (req, res) => {
    if (!nasMonConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'saveAlertConfig'
    });
    try {
        const r = await nasMonClient.post('/api/alerts/config', req.body || {});
        res.json({ ok: true, data: r.data, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'saveAlertConfig', logMessage: 'NAS Monitor alert configuration failed' });
    }
});
app.delete('/api/nas/alerts/config/:metric', async (req, res) => {
    if (!nasMonConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'deleteAlertConfig'
    });
    try {
        await nasMonClient.delete(`/api/alerts/config/${encodeURIComponent(req.params.metric)}`);
        res.json({ ok: true, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'deleteAlertConfig', logMessage: 'NAS Monitor alert configuration delete failed' });
    }
});

/* ===================== 32. NAS Monitor 即時推送 (SSE 中繼) =====================
   瀏覽器 EventSource 無法帶自訂認證標頭，所以由後端代為連線系統 B 的 /api/stream
   (帶 API Key)，再原樣轉發給前端。多個分頁共用同一條上游連線 (惰性建立/無人訂閱即斷開)，
   避免每個分頁各開一條 SSE 消耗 NAS 資源。上游斷線會自動退避重連。 */
const sseClients = new Set();
let sseUpstreamReq = null, sseReconnectTimer = null;
function sseConnectUpstream() {
    if (!nasMonConfigured() || sseUpstreamReq || sseClients.size === 0) return;
    const base = NASMON_URL.replace(/\/$/, '');
    const key = process.env.NAS_MONITOR_API_KEY || '';
    axios.get(`${base}/api/stream`, {
        responseType: 'stream', timeout: 0,
        headers: { Accept: 'text/event-stream', 'X-API-Key': key, Authorization: `Bearer ${key}` }
    }).then(r => {
        sysLog('NAS SSE', '已連線上游即時推送串流');
        sseUpstreamReq = r;
        r.data.on('data', chunk => { for (const c of sseClients) c.write(chunk); });
        r.data.on('end', () => { sseUpstreamReq = null; scheduleSseReconnect(); });
        r.data.on('error', () => { sseUpstreamReq = null; scheduleSseReconnect(); });
    }).catch(e => { sysLog('NAS SSE', `連線失敗: ${e.message}，10 秒後重試`, true); sseUpstreamReq = null; scheduleSseReconnect(); });
}
function scheduleSseReconnect() {
    if (sseReconnectTimer || sseClients.size === 0) return;
    sseReconnectTimer = setTimeout(() => { sseReconnectTimer = null; sseConnectUpstream(); }, 10000);
}
app.get('/api/nas/stream', (req, res) => {
    if (!nasMonConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'stream'
    });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(':ok\n\n');
    sseClients.add(res);
    sseConnectUpstream();
    req.on('close', () => { sseClients.delete(res); if (sseClients.size === 0 && sseUpstreamReq) { try { sseUpstreamReq.data.destroy(); } catch { } sseUpstreamReq = null; } });
});

/* ===================== 應用程式設定 API ===================== */
app.get('/api/settings', (req, res) => res.json(appSettings));
app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    for (const [key, [min, max]] of Object.entries(APP_SETTING_RANGES)) {
        if (typeof b[key] === 'number' && Number.isFinite(b[key])) {
            appSettings[key] = Math.min(max, Math.max(min, b[key]));
        }
    }
    if (typeof b.reportEnabled === 'boolean') appSettings.reportEnabled = b.reportEnabled;
    if (['daily', 'twice', 'every6h', 'weekly'].includes(b.reportFreq)) appSettings.reportFreq = b.reportFreq;
    try { saveAppSettings(); }
    catch (error) { return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.settings', function: 'saveAppSettings', logMessage: 'App settings persistence failed' }); }
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
    { key: 'UPS_SOURCE' }, { key: 'NUT_HOST' }, { key: 'NUT_UPS_NAME' }, { key: 'PWRSTAT_PATH' },
    { key: 'PPB_HOST' }, { key: 'PPB_PORT' }, { key: 'PPB_USER' }, { key: 'PPB_PASSWORD', secret: true },
    { key: 'ADGUARD_HOST' }, { key: 'ADGUARD_PORT' }, { key: 'ADGUARD_USER' }, { key: 'ADGUARD_PASSWORD', secret: true },
    { key: 'LINUX_HOST' }, { key: 'LINUX_SSH_PORT' }, { key: 'LINUX_SSH_USER' }, { key: 'LINUX_SSH_PASSWORD', secret: true }
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
    if (sseUpstreamReq) { try { sseUpstreamReq.data.destroy(); } catch { } sseUpstreamReq = null; sseConnectUpstream(); } // NAS_MONITOR_URL 可能已變更，重連上游 SSE
    wiimIP = process.env.WIIM_IP || wiimIP;
    localCookie = ''; cookieExpiry = 0;   // 重置 UniFi session
    nasToken = ''; nasTokenExpiry = 0;    // 重置 NAS token
    ppbToken = null; ppbHttpsPort = null; // 重置 PPB session (PPB_HOST/PORT 可能已變更)
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
        return apiError(res, e, {
            code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.connections', function: 'persistEnvVars',
            logMessage: '.env persistence failed', publicMessage: '.env 寫入失敗，請檢查檔案權限'
        });
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
    const fmtDur = sec => sec >= 3600 ? `${Math.floor(sec / 3600)}h${Math.round(sec % 3600 / 60)}m` : sec >= 60 ? `${Math.round(sec / 60)} 分` : `${sec} 秒`;
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
            threats.forEach(t => { const geo = t.srcipGeo || {}; const ip = t.src_ip || '?'; srcs[ip] = srcs[ip] || { n: 0, c: geo.country_name || '' }; srcs[ip].n++; });
            const top = Object.entries(srcs).sort((a, b) => b[1].n - a[1].n).slice(0, 3);
            L.push(`  主要來源：${top.map(([ip, v]) => `${ip}${v.c ? `(${v.c})` : ''} ×${v.n}`).join('、')}`);
        }
        // 封鎖動作 (本面板 24h)
        const blocks = loadBlockHistory().filter(b => Date.parse(b.datetime) >= dayAgo);
        if (blocks.length) {
            const auto = blocks.filter(b => b.source === 'auto').length;
            L.push(`• 24H 封鎖動作：${blocks.length} 次${auto ? ` (自動防禦 ${auto} 次)` : ''}`);
        }
        // 客戶端
        const sta = (await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } })).data.data || [];
        const wired = sta.filter(c => c.is_wired).length;
        const blocked = sta.filter(c => c.blocked).length;
        L.push(`• 線上客戶端：${sta.length} 台 (有線 ${wired} / 無線 ${sta.length - wired}${blocked ? ` / 封鎖中 ${blocked}` : ''})`);
        const totalRx = sta.reduce((a, c) => a + (c.rx_bytes || 0), 0), totalTx = sta.reduce((a, c) => a + (c.tx_bytes || 0), 0);
        L.push(`• 客戶端累計流量：↓${(totalRx / 1073741824).toFixed(1)} GB / ↑${(totalTx / 1073741824).toFixed(1)} GB`);
        // Top 5 流量
        const top5 = [...sta].sort((a, b) => ((b.rx_bytes || 0) + (b.tx_bytes || 0)) - ((a.rx_bytes || 0) + (a.tx_bytes || 0))).slice(0, 5);
        if (top5.length) {
            L.push('• Top 5 流量：');
            top5.forEach((c, i) => L.push(`  ${i + 1}. ${c.name || c.hostname || c.mac}：${(((c.rx_bytes || 0) + (c.tx_bytes || 0)) / 1073741824).toFixed(2)} GB`));
        }
        // WiFi
        try {
            const wl = (await unifiClient.get('/proxy/network/api/s/default/rest/wlanconf', { headers: { 'Cookie': cookie } })).data.data || [];
            L.push(`• WiFi 網路：${wl.filter(w => w.enabled).length}/${wl.length} 個啟用`);
        } catch { }
        // 最近一次測速
        try {
            const www = ((await unifiClient.get('/proxy/network/api/s/default/stat/health', { headers: { 'Cookie': cookie } })).data.data || []).find(x => x.subsystem === 'www') || {};
            if (www.xput_down) L.push(`• 最近測速：↓${www.xput_down} / ↑${www.xput_up} Mbps，ping ${www.speedtest_ping} ms${www.speedtest_lastrun ? ` (${new Date(www.speedtest_lastrun * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : ''}`);
        } catch { }
    } catch { L.push('• 本地控制器未連線'); }
    const trends = historyDb.getSince('trend', dayAgo);
    const lat = trends.map(p => p.latency).filter(v => v != null);
    if (lat.length) L.push(`• ISP 延遲：平均 ${avg(lat).toFixed(1)} ms (最高 ${Math.max(...lat)} ms)`);
    const cli = trends.map(p => p.clients).filter(v => v != null);
    if (cli.length) L.push(`• 客戶端數 24H：平均 ${Math.round(avg(cli))} / 最高 ${Math.max(...cli)} 台`);

    // ── UCG 硬體 ──
    if (!isPlaceholder(process.env.SSH_PASSWORD)) {
        try {
            const hw = await getHardwareCached();
            L.push('\n━━ 🖥️ UCG-Ultra 閘道器 ━━');
            L.push(`• CPU：${hw.cpuUsage ?? '--'}% / ${hw.cpuTemp ?? '--'}°C　記憶體：${hw.memUsagePct ?? '--'}% (${hw.memStr || ''})`);
            if (hw.cores && hw.cores.length) L.push(`• 各核心：${hw.cores.map((c, i) => `C${i} ${c}%`).join(' · ')}`);
            L.push(`• 系統碟 (eMMC)：${hw.emmcUsagePct ?? '--'}% (${hw.emmcStr || ''})`);
            if (hw.uptime) L.push(`• 運行時間：${hw.uptime}`);
            const wan = (hw.interfaces || []).find(i => i.name.startsWith('WAN'));
            if (wan) L.push(`• WAN(${wan.speed})：${wan.status === 'connected' ? '正常' : '⚠ 離線'} ↓${wan.rxRate} ↑${wan.txRate}`);
            // 24H 溫度統計 (自建歷史)
            const ucg24 = historyDb.getSince('ucg', dayAgo);
            const temps = ucg24.map(p => p.cpuTemp).filter(v => v != null);
            if (temps.length) L.push(`• 24H CPU 溫度：平均 ${avg(temps).toFixed(1)}°C / 最高 ${Math.max(...temps)}°C / 最低 ${Math.min(...temps)}°C`);
        } catch { L.push('\n━━ 🖥️ UCG-Ultra ━━\n• SSH 讀取失敗'); }
    }

    // ── NAS ──
    if (nasConfigured()) {
        try {
            L.push('\n━━ 💾 UGREEN NAS ━━');
            // 即時 CPU/RAM/溫度
            try {
                const raw = await nasGet('/ugreen/v1/taskmgr/stat/get_all');
                const c = (raw.cpu && raw.cpu.series && raw.cpu.series[0]) || {};
                const m = (raw.mem && raw.mem.series && raw.mem.series[0]) || {};
                if (c.used_percent != null) L.push(`• CPU：${Math.round(c.used_percent)}% / ${c.temp ?? '--'}°C　記憶體：${m.used_percent != null ? (+m.used_percent).toFixed(1) : '--'}%`);
                // 各硬碟溫度/休眠 (日誌判定)
                const sleepMap = await getDiskSleepFromLogs();
                const dparts = ((raw.disk && raw.disk.series) || []).filter(d => d.name !== 'overview').map(d => {
                    const name = d.label || d.name;
                    return sleepMap[name] ? `${name} 💤休眠` : `${name} ${d.temperature ?? '--'}°C`;
                });
                if (dparts.length) L.push(`• 硬碟：${dparts.join('、')}`);
            } catch { }
            // 健康 + 容量
            const disks = (await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 }).catch(() => null));
            let dl = disks ? (deepFind({ d: disks }, ['result', 'list', 'disks']) || []) : [];
            if (dl.length) {
                const bad = dl.filter(d => d.status !== 1);
                L.push(`• 硬碟健康：${dl.length} 顆，${bad.length ? `⚠ ${bad.length} 顆異常 (${bad.map(d => d.label || d.name).join('、')})` : '全部健康'}`);
            }
            const vdata = await nasGet('/ugreen/v1/storage/volume/list', { start: 0, size: 50 }).catch(() => null);
            const vols = vdata ? (deepFind({ d: vdata }, ['result', 'list', 'volumes']) || []) : [];
            vols.filter(v => v.total).forEach(v => {
                const pct = Math.round(v.used / v.total * 100);
                L.push(`• ${v.label || v.name}：${(v.used / 1073741824 / 1024).toFixed(2)}/${(v.total / 1073741824 / 1024).toFixed(2)} TB (${pct}%)${pct >= 85 ? ' ⚠' : ''}`);
            });
            // 24H 系統負載統計 (自建歷史)
            const nas24 = nasHistorySince(24);
            const ncpu = nas24.map(p => p.cpu).filter(v => v != null);
            if (ncpu.length) L.push(`• 24H CPU：平均 ${avg(ncpu).toFixed(1)}% / 峰值 ${Math.max(...ncpu)}%`);
            const nup = nas24.map(p => p.up_mbps).filter(v => v != null), ndown = nas24.map(p => p.down_mbps).filter(v => v != null);
            if (nup.length) L.push(`• 24H 網路：↓平均 ${avg(ndown).toFixed(1)} / 峰值 ${Math.max(...ndown).toFixed(0)} Mbps　↑平均 ${avg(nup).toFixed(1)} / 峰值 ${Math.max(...nup).toFixed(0)} Mbps`);
            // UGOS 日誌 24H 警告/錯誤
            try {
                const logs = await nasGet('/ugreen/v1/log/query', { visualizer: false, page: 0, size: 200, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
                const recent = (logs.log_list || []).filter(l => l.create_time * 1000 >= dayAgo);
                const warns = recent.filter(l => ['warning', 'error', 'critical'].includes(l.level));
                L.push(`• 24H 系統日誌：${recent.length} 筆${warns.length ? `，⚠ 警告/錯誤 ${warns.length} 筆` : '，無警告'}`);
                warns.slice(0, 3).forEach(l => L.push(`  [${l.level}] ${l.content.slice(0, 60)}`));
            } catch { }
        } catch { L.push('• NAS 讀取失敗 (可能需管理員權限)'); }
    }

    // ── UPS ──
    try {
        const ups = await readUpsLive();
        if (ups) {
            L.push('\n━━ 🔋 UPS ━━');
            L.push(`• ${ups.model || 'UPS'} (來源 ${(ups.actualSource || '').toUpperCase()})：${ups.onBattery ? '⚡ 電池供電中' : '🟢 市電正常'}`);
            L.push(`• 電池 ${ups.battery ?? '--'}%　負載 ${ups.loadPct ?? '--'}%　可撐 ${ups.runtimeSec ? Math.round(ups.runtimeSec / 60) + ' 分' : '--'}`);
            L.push(`• 電壓：輸入 ${ups.inputV ?? '--'}V / 輸出 ${ups.outputV ?? '--'}V`);
            // 24H 電壓/負載統計
            const ups24 = historyDb.getSince('ups', dayAgo);
            const inv = ups24.map(p => p.inV).filter(v => v != null && v > 0);
            if (inv.length) L.push(`• 24H 輸入電壓：平均 ${avg(inv).toFixed(1)}V / 最高 ${Math.max(...inv)}V / 最低 ${Math.min(...inv)}V`);
            const loads = ups24.map(p => p.load).filter(v => v != null);
            if (loads.length) L.push(`• 24H 負載：平均 ${avg(loads).toFixed(1)}% / 峰值 ${Math.max(...loads)}%`);
            // 斷電事件明細
            const outages = historyDb.listUpsEvents().filter(e => Date.parse(e.start) >= dayAgo);
            if (outages.length) {
                L.push(`• 24H 斷電事件：${outages.length} 次`);
                outages.slice(0, 3).forEach(e => L.push(`  ${new Date(e.start).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })} ${e.end ? `持續 ${fmtDur(e.durationSec)}，最低電池 ${e.minBattery ?? '?'}%` : '⚡ 進行中'}`));
            } else L.push('• 24H 斷電事件：無');
        }
    } catch (error) {
        logRecoverableFailure('report.ups', error, { module: 'report.builder', function: 'appendUpsStatus', code: ERROR_CODES.EXT_UPS_FAILED });
    }

    // ── AdGuard DNS ──
    if (adgConfigured()) {
        try {
            const [ast, asts] = await Promise.all([adgReq('/control/status'), adgReq('/control/stats')]);
            L.push('\n━━ 🛡️ AdGuard DNS 防護 ━━');
            L.push(`• 保護狀態：${ast.protection_enabled ? '🟢 啟用中' : '⚠️ 已暫停'}`);
            L.push(`• DNS 查詢：${(asts.num_dns_queries ?? 0).toLocaleString()} 次，攔截 ${(asts.num_blocked_filtering ?? 0).toLocaleString()} 次 (${asts.num_dns_queries ? (asts.num_blocked_filtering / asts.num_dns_queries * 100).toFixed(1) : 0}%)`);
            const tb = (asts.top_blocked_domains || []).slice(0, 3).map(o => { const [k, v] = Object.entries(o)[0]; return `${k}(${v})`; });
            if (tb.length) L.push(`• 被攔截最多：${tb.join('、')}`);
        } catch { L.push('\n━━ 🛡️ AdGuard ━━\n• 無法連線'); }
    }

    // ── Linux 小主機 ──
    if (linuxConfigured()) {
        try {
            const d = await getLinuxCached();
            L.push(`\n━━ 🖥️ Linux 小主機 (${d.hostname}) ━━`);
            L.push(`• CPU：${d.cpuUsage}% / ${d.cpuTemp ?? '--'}°C　記憶體：${d.memUsagePct}% (${d.memStr})`);
            L.push(`• 磁碟：${d.diskUsagePct}% (${d.diskStr})　負載 ${d.load ? d.load.join(' / ') : '--'}`);
            L.push(`• 運行時間：${d.uptime}`);
            const lnx24 = historyDb.getSince('linux', dayAgo);
            const lt = lnx24.map(p => p.temp).filter(v => v != null);
            if (lt.length) L.push(`• 24H 溫度：平均 ${avg(lt).toFixed(1)}°C / 最高 ${Math.max(...lt)}°C`);
        } catch { L.push('\n━━ 🖥️ Linux 小主機 ━━\n• SSH 無法連線'); }
    }

    // ── WiiM ──
    const wiim24h = historyDb.getSince('wiim', dayAgo);
    if (wiim24h.length) {
        const cpus = wiim24h.map(h => h.cpu).filter(v => v !== null);
        const boards = wiim24h.map(h => h.board).filter(v => v !== null);
        if (cpus.length && boards.length) {
            L.push('\n━━ 🔊 WiiM Amp ━━');
            L.push(`• 24H 均溫：CPU ${avg(cpus).toFixed(1)}°C (最高 ${Math.max(...cpus).toFixed(1)}) / 主板 ${avg(boards).toFixed(1)}°C (最高 ${Math.max(...boards).toFixed(1)})`);
            try {
                const st = JSON.parse(await wiimGet('getPlayerStatus') || '{}');
                if (st.status) L.push(`• 目前狀態：${st.status === 'play' ? '▶️ 播放中' : st.status === 'pause' ? '⏸ 暫停' : '⏹ 停止'}，音量 ${st.vol ?? '--'}%`);
            } catch { }
        }
    }

    // ── 面板本身 ──
    L.push('\n━━ ⚙️ 面板 ━━');
    L.push(`• 面板運行：${fmtDur(Math.round(process.uptime()))}　記憶體 ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
    return L.join('\n') || '（無可彙整的資料）';
}

let lastReportKey = '';
async function reportScheduler() {
    if (!appSettings.reportEnabled) return;
    const now = new Date();
    if (now.getMinutes() !== 0) return;
    const h = now.getHours(), f = appSettings.reportFreq;
    let fire = false;
    if (f === 'weekly') fire = now.getDay() === 1 && h === appSettings.reportHour;          // 每週一
    else if (f === 'twice') fire = h === appSettings.reportHour || h === (appSettings.reportHour2 ?? 20);
    else if (f === 'every6h') fire = h % 6 === ((appSettings.reportHour ?? 8) % 6);          // 每 6 小時
    else fire = h === appSettings.reportHour;                                                // daily
    if (!fire) return;
    const key = now.toISOString().slice(0, 13); // 精確到「小時」去重，每個觸發時段最多發一次
    if (key === lastReportKey) return;
    lastReportKey = key;
    const body = await buildReport();
    const freqLabel = { weekly: '每週', twice: '每日兩次', every6h: '每 6 小時' }[f] || '每日';
    await notify(`📊 SmartHub ${freqLabel}報表`, body);
}
setInterval(() => runSerialJob('reportScheduler', reportScheduler), 60 * 1000);

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
  if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/health'))return; // API / health 不快取
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));
});`);
});

// --- WiiM Amp Integration Endpoints & Background Polling ---
let wiimIP = process.env.WIIM_IP || '192.168.0.170'; // let：連線設定頁可熱更新
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
    } catch (error) {
        logRecoverableFailure('sampler.wiim.parse', error, { module: 'scheduler.wiim', function: 'parseTemperature', code: ERROR_CODES.EXT_WIIM_FAILED });
    }
    if (isNaN(cpu) && isNaN(board)) { sysLog('WiiM Poll', 'getStatusEx 回應中無溫度欄位，跳過本次取樣', true); return; }
    const ts = Math.floor(Date.now() / 1000);
    historyDb.insertPoint('wiim', { ts, cpu: isNaN(cpu) ? null : cpu, board: isNaN(board) ? null : board }, {
        keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP
    });
    sysLog('WiiM Poll', `溫度採樣完成 (CPU: ${cpu}°C, Board: ${board}°C)`);
}
// 自適應排程：有人瀏覽時每 30 秒取樣，閒置時降為 trendIdleSec。
let lastWiimPollTs = 0;
setInterval(() => {
    const now = Date.now();
    const active = isDeviceSamplingActive('wiim');
    const gap = active ? 30000 : appSettings.trendIdleSec * 1000;
    if (now - lastWiimPollTs >= gap) {
        lastWiimPollTs = now;
        runSerialJob('wiimTemperature', pollWiimTemp);
    }
}, 1000);

app.get('/api/wiim/history', (req, res) => {
    res.json({
        interval: 10,
        cpu_alert: appSettings.wiimCpuAlert ?? 70,
        board_alert: appSettings.wiimBoardAlert ?? 60,
        data: historyDb.getSince('wiim', 0)
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
    if (!command) return apiError(res, new Error('No command'), {
        status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'No command', module: 'api.wiim', function: 'command'
    });
    const raw = await wiimGet(command);
    res.json({ result: raw || "OK" });
});

// 專輯封面代理：WiiM 回的 albumArtURI 常是裝置自簽 HTTPS 或外部 CDN，瀏覽器直連會被擋
// 由後端抓取後轉發 (忽略自簽憑證)，記憶體快取 5 分鐘
const wiimArtCache = {};
app.get('/api/wiim/art', async (req, res) => {
    const u = req.query.u || '';
    if (!/^https?:\/\//i.test(u)) return res.status(400).end();
    // SSRF 防護：僅允許抓 WiiM 裝置本身，或非內網的公開 CDN；
    // 禁止以此代理探測其他內網位址 (10.x / 172.16-31.x / 192.168.x / 127.x / 169.254.x)
    try {
        const host = new URL(u).hostname;
        const isPrivate = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'localhost';
        if (isPrivate && host !== wiimIP) return res.status(403).end();
    } catch { return res.status(400).end(); }
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
    historyDb.deleteSeries('wiim');
    res.json({ ok: true });
});

app.get('/api/wiim/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=wiim_temp_log.csv');
    let csv = 'timestamp,iso_time,cpu_c,board_tmp102_c\n';
    for (const h of historyDb.getSince('wiim', 0)) {
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
// 電壓歷史與斷電事件持久化於 SQLite (斷電紀錄不可因重啟遺失)。
// 呼叫時讀取 env，設定頁修改後即時生效
const UPS_SOURCE = () => process.env.UPS_SOURCE || 'auto';
const NUT_HOST = () => process.env.NUT_HOST || 'localhost';
const NUT_UPS_NAME = () => process.env.NUT_UPS_NAME || 'cyberpower';
const PWRSTAT_PATH = () => process.env.PWRSTAT_PATH || 'pwrstat';
let upsLastLive = null;     // 最近一次成功讀取 (含 source)
// 重啟接續：若最新事件尚未結束 (重啟前正在斷電)，視為仍在電池供電，
// 下次取樣時若市電已恢復會正常補上結束時間，不會再開一筆重複事件
let upsWasOnBattery = !!historyDb.getOpenUpsEvent();

function execCmd(cmd, timeoutMs = 5000) {
    return new Promise(resolve => exec(cmd, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout)));
}

// parseFloat(x) || null 會把合法的 0 (電池 0%、負載 0%) 誤判為 null，改用 finite 檢查
function numOrNull(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

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
        inputV: numOrNull(kv['input.voltage']),
        outputV: numOrNull(kv['output.voltage']),
        battery: numOrNull(kv['battery.charge']),
        runtimeSec: numOrNull(kv['battery.runtime']),
        loadPct: numOrNull(kv['ups.load']),
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
        inputV: numOrNull(grab(/Utility Voltage\.+\s*([\d.]+)/)),
        outputV: numOrNull(grab(/Output Voltage\.+\s*([\d.]+)/)),
        battery: numOrNull(grab(/Battery Capacity\.+\s*([\d.]+)/)),
        runtimeSec: (() => { const m = numOrNull(grab(/Remaining Runtime\.+\s*([\d.]+)/)); return m != null ? m * 60 : null; })(),
        loadPct: numOrNull(grab(/Load\.+\s*([\d.]+)/))
    };
}

// --- 來源 4: CyberPower PowerPanel Business REST API (無 pwrstat CLI 時用這個) ---
// PPB 主機/埠可用環境變數指定：部署到 Docker/NAS 後 127.0.0.1 是容器自己，
// 必須以 PPB_HOST 指向實際跑 PowerPanel Business 的機器 IP
const PPB_HOST = () => process.env.PPB_HOST || '127.0.0.1';
const PPB_HTTP_PORT = () => process.env.PPB_PORT || '3052';
let ppbToken = null, ppbHttpsPort = null;
async function ppbDiscoverPort() {
    if (ppbHttpsPort) return ppbHttpsPort;
    const r = await axios.get(`http://${PPB_HOST()}:${PPB_HTTP_PORT()}/local/`, { maxRedirects: 0, validateStatus: () => true, timeout: 5000 });
    const loc = r.headers.location || '';
    const m = loc.match(/^https:\/\/[^:/]+:(\d+)/);
    if (m) ppbHttpsPort = m[1];
    return ppbHttpsPort;
}
async function ppbLogin() {
    const port = await ppbDiscoverPort();
    if (!port) return null;
    const r = await axios.post(`https://${PPB_HOST()}:${port}/local/rest/v1/login/verify`,
        { userName: process.env.PPB_USER, password: process.env.PPB_PASSWORD },
        { httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 8000, validateStatus: () => true });
    if (r.status !== 200) return null;
    ppbToken = r.data; return ppbToken;
}
async function readPpb() {
    if (!process.env.PPB_USER || !process.env.PPB_PASSWORD) return null;
    try {
        const port = await ppbDiscoverPort();
        if (!port) return null;
        if (!ppbToken) await ppbLogin();
        const opts = { headers: { Authorization: ppbToken }, httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 8000, validateStatus: () => true };
        let resp = await axios.get(`https://${PPB_HOST()}:${port}/local/rest/v1/ups/status`, opts);
        if (resp.status === 401 || resp.status === 403) { await ppbLogin(); resp = await axios.get(`https://${PPB_HOST()}:${port}/local/rest/v1/ups/status`, { ...opts, headers: { Authorization: ppbToken } }); }
        if (resp.status !== 200) return null;
        const d = resp.data;
        const numV = s => { const m = (s || '').toString().match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
        return {
            source: 'ppb', model: 'CyberPower UPS (PowerPanel Business)',
            status: d.input?.stateText || 'Unknown',
            onBattery: (d.input?.state ?? 0) !== 0,
            inputV: numV(d.input?.voltages?.[0]),
            outputV: numV(d.output?.voltages?.[0]),
            battery: numV(d.battery?.capacity),
            runtimeSec: d.battery?.remainingRunTimeInSecs ?? null,
            loadPct: numV(d.output?.loads?.[0])
        };
    } catch {
        // PPB 服務重啟後 HTTPS 埠可能改變，清掉快取讓下次重新探索
        ppbHttpsPort = null; ppbToken = null;
        return null;
    }
}

// 通用 PowerPanel Business API GET (自動登入/token 失效重試一次)
async function ppbGet(path) {
    if (!process.env.PPB_USER || !process.env.PPB_PASSWORD) throw new Error('ppb_not_configured');
    const port = await ppbDiscoverPort();
    if (!port) throw new Error(`PowerPanel Business 服務未偵測到 (${PPB_HOST()}:${PPB_HTTP_PORT()})`);
    if (!ppbToken) await ppbLogin();
    const opts = { headers: { Authorization: ppbToken }, httpsAgent: new https.Agent({ rejectUnauthorized: false }), timeout: 8000, validateStatus: () => true };
    let resp = await axios.get(`https://${PPB_HOST()}:${port}${path}`, opts);
    if (resp.status === 401 || resp.status === 403) { await ppbLogin(); resp = await axios.get(`https://${PPB_HOST()}:${port}${path}`, { ...opts, headers: { Authorization: ppbToken } }); }
    if (resp.status !== 200) throw new Error(`PPB API ${resp.status}`);
    return resp.data;
}
// PPB API 固定回英文 (Accept-Language 無效)；官方網頁是前端用語系檔翻譯。
// ppb-i18n-zh.json 即擷取自 PowerPanel Business 網頁的官方 zh 語系檔
// (assets/i18n/zh.json 的 eventDescription/eventName 全部 332 句)，翻譯結果與官方介面一模一樣。
const ppbZhMap = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'ppb-i18n-zh.json'), 'utf8')); } catch { return {}; } })();
app.get('/api/ups/ppb-events', async (req, res) => {
    try {
        const raw = await ppbGet('/local/rest/v1/eventlogs/report');
        const events = (Array.isArray(raw) ? raw : []).map(e => ({
            id: e.id, ts: e.logTime24H,
            desc: ppbZhMap[(e.description || '').trim()] || e.description,
            level: /failure|lost|fault/i.test(e.description) ? 'error' : /test/i.test(e.description) ? 'test' : /resumed|restored/i.test(e.description) ? 'ok' : 'info'
        }));
        res.json({ events, source: 'ppb' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UPS_FAILED, module: 'api.ups', function: 'getPpbEvents', logMessage: 'Failed to fetch PowerPanel events' });
    }
});

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
    const order = chosen === 'auto' ? ['ppb', 'nut', 'pwrstat', 'pmset'] : [chosen, ...['ppb', 'nut', 'pwrstat', 'pmset'].filter(s => s !== chosen)];
    const tried = [];
    for (const src of order) {
        const fn = { nut: readNut, pwrstat: readPwrstat, pmset: readPmset, ppb: readPpb }[src];
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
    historyDb.insertPoint('ups', {
        t: new Date().toISOString(), inV: live.inputV, outV: live.outputV,
        batt: live.battery, load: live.loadPct, rt: live.runtimeSec, ob: live.onBattery ? 1 : 0
    }, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });

    // 斷電事件：市電斷 → 開新事件；恢復 → 補上結束時間與時長
    if (live.onBattery && !upsWasOnBattery) {
        historyDb.flush(); // 電源異常時先保全尚未落盤的一般遙測
        historyDb.insertUpsEvent({ start: new Date().toISOString(), minBattery: live.battery, startVoltage: live.inputV });
        sysLog('UPS', `⚡ 偵測到斷電！事件已記錄 (電池 ${live.battery}%)`, true);
        const ns = loadNotifSettings();
        if (ns.enabled && ns.triggerUpsOutage !== false) await notify('⚡ UPS 斷電！', `市電中斷，UPS 供電中 (電池 ${live.battery ?? '?'}%)`);
        upsLowBattNotified = false;
    } else if (!live.onBattery && upsWasOnBattery && historyDb.getOpenUpsEvent()) {
        const open = historyDb.getOpenUpsEvent();
        const end = new Date().toISOString();
        const durationSec = Math.round((Date.now() - new Date(open.start).getTime()) / 1000);
        historyDb.closeOpenUpsEvent(end, durationSec);
        sysLog('UPS', `✅ 市電恢復，斷電持續 ${durationSec} 秒`);
        const ns = loadNotifSettings();
        if (ns.enabled && ns.triggerUpsOutage !== false) await notify('✅ 市電恢復', `斷電持續 ${durationSec} 秒，最低電池 ${open.minBattery ?? '?'}%`);
    } else if (live.onBattery && historyDb.getOpenUpsEvent()) {
        const open = historyDb.getOpenUpsEvent();
        if (live.battery != null) historyDb.updateOpenUpsMinBattery(Math.min(open.minBattery ?? 100, live.battery));
        if (live.battery != null && live.battery <= 20 && !upsLowBattNotified) {
            upsLowBattNotified = true;
            const ns = loadNotifSettings();
            if (ns.enabled && ns.triggerUpsLowBatt !== false) await notify('🪫 UPS 電池電量低', `僅剩 ${live.battery}%，請儘快處理或準備關機`);
        }
    }
    upsWasOnBattery = live.onBattery;

    // 負載過高 (30 分鐘冷卻)
    const ns2 = loadNotifSettings();
    if (ns2.enabled && ns2.triggerUpsHighLoad && live.loadPct != null && live.loadPct >= (ns2.upsLoadAlert ?? 80)) {
        if (Date.now() - lastUpsHighLoadTs > 30 * 60 * 1000) {
            lastUpsHighLoadTs = Date.now();
            await notify('⚠️ UPS 負載過高', `目前負載 ${live.loadPct}% (門檻 ${ns2.upsLoadAlert ?? 80}%)，逼近滿載`);
        }
    }
    // 輸出電壓異常 (30 分鐘冷卻；輸出電壓長時間偏離 110V/220V 標準值可能是 UPS 硬體問題)
    if (ns2.enabled && ns2.triggerUpsVoltAbnormal && live.outputV != null) {
        const nominal = live.outputV > 180 ? 220 : 110;
        const dev = Math.abs(live.outputV - nominal) / nominal * 100;
        if (dev >= (ns2.upsVoltDeviationPct ?? 10) && Date.now() - lastUpsVoltAbnormalTs > 30 * 60 * 1000) {
            lastUpsVoltAbnormalTs = Date.now();
            await notify('⚡ UPS 輸出電壓異常', `輸出 ${live.outputV}V，偏離標準值 ${nominal}V 達 ${dev.toFixed(1)}%`);
        }
    }
    // 來源切換 (例如 PowerPanel Business 斷線改回 pmset)：只要跟上次不同就通知一次
    if (ns2.enabled && ns2.triggerUpsSourceChange && lastUpsSource && live.actualSource && live.actualSource !== lastUpsSource) {
        await notify('🔀 UPS 資料來源切換', `從 ${lastUpsSource.toUpperCase()} 切換為 ${live.actualSource.toUpperCase()}`);
    }
    if (live.actualSource) lastUpsSource = live.actualSource;
}
let lastUpsHighLoadTs = 0, lastUpsVoltAbnormalTs = 0, lastUpsSource = null;
// UPS 取樣「不做閒置降頻」：斷電/電壓紀錄是核心需求，無人看網頁也要持續記錄 (本地指令，成本低)
let upsLowBattNotified = false;
let lastUpsSampleTs = 0;
setInterval(() => {
    const gap = (appSettings.upsSampleSec || 30) * 1000;
    if (Date.now() - lastUpsSampleTs >= gap) {
        lastUpsSampleTs = Date.now();
        runSerialJob('upsSample', sampleUps);
    }
}, 1000);

app.get('/api/ups/status', async (req, res) => {
    // 前端與背景取樣共用最近狀態，避免每次畫面刷新都重新呼叫 PPB/NUT。
    const maxAge = (appSettings.upsSampleSec || 30) * 1000;
    if (upsLastLive && Date.now() - upsLastLive.ts < maxAge) {
        return res.json({ ...upsLastLive, cached: true, sampleSec: appSettings.upsSampleSec || 30 });
    }
    const live = await readUpsLive();
    if (live) upsLastLive = { ...live, ts: Date.now() };
    res.json(live ? { ...live, sampleSec: appSettings.upsSampleSec || 30 }
        : { source: 'unreachable', reason: upsLastReason, lastKnown: upsLastLive, sampleSec: appSettings.upsSampleSec || 30 });
});

app.get('/api/ups/history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    const cutoff = Date.now() - hours * 3600000;
    res.json({ history: historyDb.getSince('ups', cutoff) });
});

app.get('/api/ups/events', (req, res) => res.json({ events: historyDb.listUpsEvents() }));

app.get('/api/ups/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ups_history.csv');
    let csv = 'time,input_v,output_v,battery_pct,load_pct,runtime_sec,on_battery\n';
    for (const h of historyDb.getSince('ups', 0)) csv += `${h.t},${h.inV ?? ''},${h.outV ?? ''},${h.batt ?? ''},${h.load ?? ''},${h.rt ?? ''},${h.ob}\n`;
    res.send(csv);
});

/* ===================== AdGuard Home DNS 防護 (REST API, Basic Auth) ===================== */
const adgConfigured = () => !!(process.env.ADGUARD_HOST && process.env.ADGUARD_USER && !isPlaceholder(process.env.ADGUARD_PASSWORD));
let adgLastOkTs = 0;
async function adgReq(pathName, method = 'get', data) {
    const base = `http://${process.env.ADGUARD_HOST}:${process.env.ADGUARD_PORT || 80}`;
    const r = await axios({ url: base + pathName, method, data, timeout: 8000, auth: { username: process.env.ADGUARD_USER, password: process.env.ADGUARD_PASSWORD } });
    adgLastOkTs = Date.now();
    return r.data;
}
// 總覽：狀態 + 統計 (查詢數/攔截數/Top 網域/Top 客戶端)
app.get('/api/adguard/overview', async (req, res) => {
    if (!adgConfigured()) return res.json({ source: 'not_configured' });
    try {
        const [status, stats] = await Promise.all([adgReq('/control/status'), adgReq('/control/stats')]);
        res.json({ status, stats, source: 'adguard' });
    } catch (e) {
        logRecoverableFailure('adguard.overview', e, { module: 'api.adguard', function: 'getOverview', code: ERROR_CODES.EXT_ADGUARD_FAILED });
        res.json({ source: 'error', error: publicError(e) });
    }
});
// 即時查詢日誌 (簡化欄位)
app.get('/api/adguard/querylog', async (req, res) => {
    if (!adgConfigured()) return res.json({ entries: [], source: 'not_configured' });
    try {
        const filtered = req.query.filtered === '1' ? '&response_status=filtered' : '';
        const d = await adgReq(`/control/querylog?limit=${Math.min(parseInt(req.query.limit || '100', 10), 200)}${filtered}`);
        const entries = (d.data || []).map(e => ({
            time: e.time,
            domain: e.question && e.question.name,
            type: e.question && e.question.type,
            client: e.client,
            blocked: !!(e.reason && /Filtered/i.test(e.reason) && e.reason !== 'NotFilteredNotFound' && e.reason !== 'NotFilteredWhiteList'),
            reason: e.reason,
            elapsedMs: e.elapsedMs ? parseFloat(e.elapsedMs).toFixed(1) : null
        }));
        res.json({ entries, source: 'adguard' });
    } catch (e) {
        logRecoverableFailure('adguard.querylog', e, { module: 'api.adguard', function: 'getQueryLog', code: ERROR_CODES.EXT_ADGUARD_FAILED });
        res.json({ entries: [], source: 'error', error: publicError(e) });
    }
});
// 保護開關
app.post('/api/adguard/protection', async (req, res) => {
    if (!adgConfigured()) return apiError(res, new Error('AdGuard is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'not_configured', module: 'api.adguard', function: 'setProtection'
    });
    try {
        await adgReq('/control/protection', 'post', { enabled: !!req.body.enabled });
        res.json({ ok: true, enabled: !!req.body.enabled });
    } catch (e) { apiError(res, e, { code: ERROR_CODES.EXT_ADGUARD_FAILED, module: 'api.adguard', function: 'setProtection', logMessage: 'Failed to update AdGuard protection' }); }
});

/* ===================== Linux 小主機監控 (SSH，比照 UCG 模式) ===================== */
const linuxConfigured = () => !!(process.env.LINUX_HOST && process.env.LINUX_SSH_USER && !isPlaceholder(process.env.LINUX_SSH_PASSWORD));
const LINUX_CMD = [
    'hostname', 'cat /proc/uptime', 'free -m', 'df -m /', 'cat /proc/loadavg',
    'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null',
    'cat /proc/stat', 'sleep 1; cat /proc/stat'
].join('; echo __S__; ');
let linuxCache = null, linuxInflight = null;
function fetchLinuxSSH() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec(LINUX_CMD, (err, stream) => {
                if (err) { conn.end(); return reject(new Error('SSH exec failed')); }
                let out = '';
                stream.on('data', c => out += c).stderr.on('data', () => { });
                stream.on('close', () => {
                    conn.end();
                    try {
                        const sec = out.split('__S__');
                        const hostname = sec[0].trim();
                        const upSec = parseFloat(sec[1]);
                        const fm = sec[2].match(/Mem:\s+(\d+)\s+(\d+)/);
                        const memTotal = fm ? +fm[1] : 0, memUsed = fm ? +fm[2] : 0;
                        const dm = sec[3].match(/(\d+)\s+(\d+)\s+\d+\s+(\d+)%/);
                        const load = sec[4].trim().split(/\s+/).slice(0, 3).map(Number);
                        const temps = sec[5].trim().split('\n').map(t => parseInt(t, 10) / 1000).filter(t => t > 0 && t < 150);
                        const s1 = parseProcStat(sec[6]), s2 = parseProcStat(sec[7]);
                        let cpuUsage = 0;
                        if (s1.cpu && s2.cpu) {
                            const dT = s2.cpu.total - s1.cpu.total, dI = s2.cpu.idle - s1.cpu.idle;
                            cpuUsage = dT > 0 ? Math.round((1 - dI / dT) * 100) : 0;
                        }
                        resolve({
                            hostname, cpuUsage,
                            cpuTemp: temps.length ? Math.round(Math.max(...temps)) : null,
                            memUsagePct: memTotal ? Math.round(memUsed / memTotal * 100) : 0,
                            memStr: `${(memUsed / 1024).toFixed(2)} / ${(memTotal / 1024).toFixed(2)} GB`,
                            diskUsagePct: dm ? +dm[3] : null,
                            diskStr: dm ? `${(+dm[2] / 1024).toFixed(1)} / ${(+dm[1] / 1024).toFixed(1)} GB` : '--',
                            load,
                            uptime: isNaN(upSec) ? '--' : `up ${Math.floor(upSec / 86400)}d ${Math.floor((upSec % 86400) / 3600)}h`,
                            dataSource: 'real'
                        });
                    } catch (e) { reject(new Error('parse failed: ' + e.message)); }
                });
            });
        }).on('error', e => reject(e))
            .connect({
                host: process.env.LINUX_HOST,
                port: parseInt(process.env.LINUX_SSH_PORT || '22', 10),
                username: process.env.LINUX_SSH_USER,
                password: process.env.LINUX_SSH_PASSWORD,
                readyTimeout: 8000
            });
    });
}
async function getLinuxCached() {
    if (linuxCache && Date.now() - linuxCache.ts < 10000) return linuxCache.data;
    if (!linuxInflight) linuxInflight = fetchLinuxSSH().finally(() => { linuxInflight = null; });
    const data = await linuxInflight;
    linuxCache = { ts: Date.now(), data };
    return data;
}
app.get('/api/linux/stats', async (req, res) => {
    if (!linuxConfigured()) return res.json({ source: 'not_configured' });
    try { res.json({ ...(await getLinuxCached()), source: 'ssh' }); }
    catch (e) {
        logRecoverableFailure('linux.stats', e, { module: 'api.linux', function: 'getStats', code: ERROR_CODES.EXT_LINUX_FAILED });
        res.json({ source: 'error', error: publicError(e) });
    }
});
// 歷史取樣 (自適應：活躍 120s / 閒置 15min)
let lastLinuxSampleTs = 0;
setInterval(() => {
    if (!linuxConfigured()) return;
    const active = isDeviceSamplingActive('linux');
    const gap = (active ? 120 : 900) * 1000;
    if (Date.now() - lastLinuxSampleTs < gap) return;
    lastLinuxSampleTs = Date.now();
    runSerialJob('linuxHistory', async () => {
        const d = await getLinuxCached();
        historyDb.insertPoint('linux', {
            t: new Date().toISOString(), cpu: d.cpuUsage, temp: d.cpuTemp,
            mem: d.memUsagePct, load: d.load && d.load[0]
        }, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });
    });
}, 5000);
app.get('/api/linux/history', (req, res) => {
    const hours = parseFloat(req.query.hours || '24');
    res.json({ data: historyDb.getSince('linux', Date.now() - hours * 3600000) });
});

/* ===================== 連線狀態一覽 (設定頁 📡 面板) =====================
   原本前端從側邊欄徽章 DOM 推斷，時常不準；改由後端記憶體現況直接彙整。 */
// Site Manager 雲端沒有像其他設備一樣有背景輪詢會順手更新「最後成功時間」，
// 這裡在查詢狀態面板時「順便」主動測一次 (節流 60 秒，避免洗掉雲端 100 次/分鐘的速率限制)
let cloudLastCheckTs = 0, cloudLastOk = null;
async function checkCloudStatus() {
    if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) return { configured: false, ok: null, detail: '' };
    if (Date.now() - cloudLastCheckTs < 60000) return { configured: true, ok: cloudLastOk, detail: cloudLastOk === false ? '連線失敗' : (cloudLastOk ? '連線正常' : '檢查中') };
    cloudLastCheckTs = Date.now();
    try { await unifiCloudClient.get('/hosts', { timeout: 8000 }); cloudLastOk = true; }
    catch { cloudLastOk = false; }
    return { configured: true, ok: cloudLastOk, detail: cloudLastOk ? '連線正常' : '連線失敗 (API Key 無效或被限流)' };
}
app.get('/api/connections/status', async (req, res) => {
    const fresh = (ts, sec) => ts && (Date.now() - ts) < sec * 1000;
    const wiimHit = wiimCache['getStatusEx'];
    const cloud = await checkCloudStatus();
    res.json({
        devices: [
            { name: 'UCG-Ultra (SSH)', configured: !isPlaceholder(process.env.SSH_PASSWORD) && !!process.env.UCG_IP, ok: fresh(hwCache && hwCache.ts, 120), detail: hwCache ? `CPU ${hwCache.data.cpuTemp}°C / ${hwCache.data.cpuUsage}%` : '尚無資料' },
            { name: 'UniFi 控制器', configured: !isPlaceholder(process.env.UNIFI_USERNAME), ok: !!localCookie && Date.now() < cookieExpiry, detail: localCookie ? 'Session 有效' : '未登入' },
            { name: 'Site Manager 雲端', configured: cloud.configured, ok: cloud.ok, detail: cloud.detail },
            { name: 'UGREEN NAS', configured: nasConfigured(), ok: !!nasToken && Date.now() < nasTokenExpiry, detail: nasToken ? 'Token 有效' : '未登入' },
            { name: 'NAS Monitor (系統B)', configured: nasMonConfigured(), ok: null, detail: nasMonConfigured() ? '已設定' : '' },
            { name: 'WiiM Amp', configured: true, ok: fresh(wiimHit && wiimHit.timestamp, 120), detail: wiimHit ? '有回應' : '無快取' },
            { name: 'CyberPower UPS', configured: true, ok: !!upsLastLive && fresh(upsLastLive.ts, 180), detail: upsLastLive ? `${(upsLastLive.actualSource || '').toUpperCase()} · 電池 ${upsLastLive.battery ?? '--'}%` : (upsLastReason ? '所有來源失聯' : '尚無資料') },
            { name: 'AdGuard Home', configured: adgConfigured(), ok: fresh(adgLastOkTs, 180), detail: adgLastOkTs ? '有回應' : '尚無資料' },
            { name: 'Linux 小主機', configured: linuxConfigured(), ok: fresh(linuxCache && linuxCache.ts, 180), detail: linuxCache ? `${linuxCache.data.hostname} · ${linuxCache.data.cpuTemp ?? '--'}°C` : '尚無資料' }
        ]
    });
});

/* ===================== 重大事件警報 (前端頂部閃爍橫幅) =====================
   只放「需要立刻知道」的狀態，全部由記憶體現況計算，零上游呼叫。
   id 含事件起始時間，前端點擊關閉後記住 id；同一事件不再彈出，新事件會重新出現。 */
app.get('/api/alerts/critical', (req, res) => {
    const alerts = [];
    const openUpsEvent = historyDb.getOpenUpsEvent();
    // UPS 斷電進行中
    if (openUpsEvent) {
        alerts.push({ id: 'ups-outage-' + openUpsEvent.start, level: 'critical', msg: `UPS 斷電中！市電中斷 (電池 ${upsLastLive?.battery ?? '?'}%，可撐約 ${upsLastLive?.runtimeSec ? Math.round(upsLastLive.runtimeSec / 60) + ' 分' : '--'})` });
    }
    // UPS 電池低 (斷電中或充電異常皆適用)
    if (upsLastLive && upsLastLive.battery != null && upsLastLive.battery <= 20) {
        alerts.push({ id: 'ups-lowbatt-' + (openUpsEvent?.start || 'now'), level: 'critical', msg: `UPS 電池僅剩 ${upsLastLive.battery}%，請儘快處理` });
    }
    // UPS 完全失聯 (連續取樣失敗)
    if (upsLastReason && !upsLastLive) {
        alerts.push({ id: 'ups-unreachable', level: 'warning', msg: 'UPS 無法讀取 (所有來源失聯)' });
    }
    // WAN 斷線 (取自最近一次硬體快取)
    const hw = hwCache && hwCache.data;
    if (hw) {
        const wan = (hw.interfaces || []).find(i => i.name.startsWith('WAN'));
        if (wan && wan.status !== 'connected') alerts.push({ id: 'wan-down', level: 'critical', msg: 'WAN 對外連線中斷！請檢查數據機/ISP' });
        if (hw.cpuTemp != null && hw.cpuTemp >= 85) alerts.push({ id: 'ucg-hot', level: 'warning', msg: `UCG CPU ${hw.cpuTemp}°C 嚴重過熱` });
    }
    res.json({ alerts });
});

// Liveness / readiness / 完整 diagnostics；/api/system/status 會沿用上方 Basic Auth。
registerHealthRoutes(app, { monitor: systemMonitor, db: historyDb, taskTracker, version: APP_VERSION });

/* ===================== 啟動連線自我診斷 =====================
   開機時逐一測試每個設備連線並輸出 ✅/❌ + 具體原因與修復提示，
   專為 Docker/NAS 部署除錯設計 (docker logs 直接看得到哪台設備為什麼連不上)。 */
const IS_DOCKER = fs.existsSync('/.dockerenv') || process.env.DOCKER === '1';
function connHint(err, host) {
    const msg = (err && err.message) || String(err);
    if (/ECONNREFUSED/i.test(msg)) return `連線被拒 (${host})：主機有回應但該埠無服務 — 檢查埠號與目標服務是否啟動。原始錯誤: ${msg}`;
    if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return `無法到達主機 (${host})：IP/網段錯誤，或容器網路不可達內網 (檢查 docker network / VLAN)。原始錯誤: ${msg}`;
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return `DNS 解析失敗 (${host})：主機名稱錯誤或容器 DNS 未設定。原始錯誤: ${msg}`;
    if (/ETIMEDOUT|timed? ?out/i.test(msg)) return `連線逾時 (${host})：IP 錯誤、防火牆阻擋、或跨 VLAN 不通。原始錯誤: ${msg}`;
    if (/authentication|401|403|password|login/i.test(msg)) return `認證失敗 (${host})：帳號或密碼錯誤。原始錯誤: ${msg}`;
    if (/certificate|self.?signed/i.test(msg)) return `憑證問題 (${host})：${msg}`;
    return `${msg} (${host})`;
}
function warnIfLocalhost(name, host) {
    if (IS_DOCKER && /^(127\.|localhost$)/.test(host || ''))
        sysLog('Diag', `⚠️ ${name}=${host}：容器內的 localhost/127.0.0.1 是容器自己，連不到宿主機或其他設備 — 請改成實際 IP`, true);
}
async function startupDiagnostics() {
    sysLog('Diag', `━━ 啟動連線診斷開始 (${IS_DOCKER ? '🐳 Docker 容器' : '💻 主機'} 環境, TZ=${process.env.TZ || '(未設定，UTC)'}) ━━`);
    if (IS_DOCKER && !process.env.TZ) sysLog('Diag', '⚠️ 未設定 TZ 環境變數：報表排程與日誌時間將是 UTC (差 8 小時)，請在 compose 加 TZ=Asia/Taipei', true);

    // 1. UCG SSH
    if (!isPlaceholder(process.env.SSH_PASSWORD) && process.env.UCG_IP) {
        try { const hw = await getHardwareCached(); sysLog('Diag', `✅ UCG SSH (${process.env.UCG_IP}:${process.env.SSH_PORT || 22})：CPU ${hw.cpuTemp}°C，正常`); }
        catch (e) { sysLog('Diag', `❌ UCG SSH：${connHint(new Error((e && e.body && (e.body.details || e.body.error)) || (e && e.message) || String(e)), process.env.UCG_IP)}`, true); }
    } else sysLog('Diag', '⏭️ UCG SSH：未設定 (SSH_PASSWORD/UCG_IP)，略過');

    // 2. UniFi 本地控制器
    if (!isPlaceholder(process.env.UNIFI_USERNAME) && !isPlaceholder(process.env.UNIFI_PASSWORD)) {
        warnIfLocalhost('UNIFI_CONTROLLER_URL', (process.env.UNIFI_CONTROLLER_URL || '').replace(/^https?:\/\//, '').split(/[:/]/)[0]);
        try { await getLocalSession(); sysLog('Diag', `✅ UniFi 控制器 (${process.env.UNIFI_CONTROLLER_URL})：登入成功`); }
        catch (e) { sysLog('Diag', `❌ UniFi 控制器：${connHint(e, process.env.UNIFI_CONTROLLER_URL)}`, true); }
    } else sysLog('Diag', '⏭️ UniFi 控制器：未設定帳密，略過');

    // 3. Site Manager 雲端
    if (process.env.UNIFI_API_KEY && !process.env.UNIFI_API_KEY.includes('your_unifi')) {
        try { await unifiCloudClient.get('/hosts'); sysLog('Diag', '✅ Site Manager 雲端 API：正常'); }
        catch (e) { sysLog('Diag', `❌ Site Manager 雲端：${e.response ? `HTTP ${e.response.status} (${e.response.status === 401 ? 'API Key 無效' : e.response.status === 429 ? '被限流' : '見狀態碼'})` : connHint(e, 'api.ui.com')}`, true); }
    } else sysLog('Diag', '⏭️ Site Manager：未設定 UNIFI_API_KEY，略過');

    // 4. UGREEN NAS
    if (nasConfigured()) {
        warnIfLocalhost('NAS_HOST', process.env.NAS_HOST);
        try { await getNasToken(); sysLog('Diag', `✅ UGREEN NAS (${NAS_BASE})：登入成功`); }
        catch (e) { sysLog('Diag', `❌ UGREEN NAS：${connHint(e, process.env.NAS_HOST)}${/1004|1008/.test(e.message || '') ? '' : '。若是密碼正確仍失敗，確認 NAS_SCHEME/NAS_PORT (預設 https:9443)'}`, true); }
    } else sysLog('Diag', '⏭️ UGREEN NAS：未設定，略過');

    // 5. NAS Monitor (系統 B)
    if (nasMonConfigured()) {
        warnIfLocalhost('NAS_MONITOR_URL', (NASMON_URL || '').replace(/^https?:\/\//, '').split(/[:/]/)[0]);
        try { await nasMonGet('/api/downtime', { days: 1 }); sysLog('Diag', `✅ NAS Monitor (${NASMON_URL})：正常`); }
        catch (e) { sysLog('Diag', `❌ NAS Monitor：${e.response ? `HTTP ${e.response.status}${e.response.status === 401 ? ' (API Key 錯誤)' : ''}` : connHint(e, NASMON_URL)}`, true); }
    } else sysLog('Diag', '⏭️ NAS Monitor：未設定，略過');

    // 6. WiiM
    warnIfLocalhost('WIIM_IP', wiimIP);
    const wiimOk = await wiimGet('getStatusEx');
    if (wiimOk) sysLog('Diag', `✅ WiiM Amp (${wiimIP})：正常`);
    else sysLog('Diag', `❌ WiiM Amp (${wiimIP})：HTTPS/HTTP 皆無回應 — 檢查 IP 是否正確、裝置是否開機、容器可否達該網段 (新韌體須帶 User-Agent，已內建)`, true);

    // 7. UPS
    warnIfLocalhost('NUT_HOST', NUT_HOST());
    warnIfLocalhost('PPB_HOST', PPB_HOST());
    const ups = await readUpsLive();
    if (ups) sysLog('Diag', `✅ UPS：來源 ${ups.actualSource.toUpperCase()}，${ups.status}，電池 ${ups.battery ?? '--'}%`);
    else {
        sysLog('Diag', `❌ UPS：${upsLastReason}`, true);
        if (IS_DOCKER) sysLog('Diag', '   Docker 環境 UPS 檢查清單：(1) UPS_SOURCE=nut + NUT_HOST=<跑 NUT server 的主機 IP>，容器已內建 upsc；(2) 或 PPB_HOST=<跑 PowerPanel Business 的機器 IP>+PPB_USER/PPB_PASSWORD；(3) pwrstat/pmset 在容器內不可用', true);
    }
    sysLog('Diag', '━━ 啟動連線診斷完成 ━━');
}

app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    return apiError(res, new Error(`Route not found: ${req.method} ${req.path}`), {
        status: 404, code: ERROR_CODES.API_NOT_FOUND, publicMessage: 'API endpoint not found',
        module: 'api.router', function: 'notFound'
    });
});

app.use((error, req, res, _next) => {
    if (res.headersSent) return _next(error);
    const isJsonError = error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError);
    apiError(res, error, {
        status: isJsonError ? 400 : 500,
        code: isJsonError ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
        publicMessage: isJsonError ? 'Invalid JSON request body' : 'Internal server error',
        module: 'api.middleware', function: 'errorHandler', fields: { method: req.method, path: req.path }
    });
});

const PORT = process.env.PORT || 3000;
let shuttingDown = false;
let httpServer;

function gracefulShutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({
        module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.SYS_SHUTDOWN,
        message: 'SmartHub shutdown started', fields: { signal, exit_code: exitCode }
    });
    systemMonitor.stop();
    Object.values(jobTimers).forEach(clearInterval);
    const finish = () => {
        try { historyDb.close(); }
        catch (error) {
            logger.error({ module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.DB_CLOSE, message: 'SQLite close failed during shutdown', error });
        }
        process.exit(exitCode);
    };
    if (httpServer && httpServer.listening) httpServer.close(finish);
    else finish();
    setTimeout(finish, 5000).unref();
}

httpServer = app.listen(PORT, () => {
    systemMonitor.ensureSample().then(status => {
        logger.info({
            module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_READY,
            message: 'SYSTEM READY', fields: {
                port: Number(PORT),
                startup_ms: Date.now() - APP_STARTED_AT,
                database: status.database.status,
                database_latency_ms: status.database.latency_ms,
                storage_free_gb: status.disk.free_bytes == null ? null : Number((status.disk.free_bytes / 1073741824).toFixed(2)),
                worker: status.worker.status
            }
        });
    }).catch(error => logger.error({
        module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_MONITOR_FAILED,
        message: 'Server is listening but initial resource diagnostics failed', error
    }));
    // 延遲數秒再診斷，避開啟動瞬間的排程尖峰
    setTimeout(() => startupDiagnostics().catch(error => logger.error({
        module: 'startup.diagnostics', function: 'startupDiagnostics', code: ERROR_CODES.SYS_CONFIG_INVALID,
        message: 'External service startup diagnostics failed', error
    })), 3000);
});

httpServer.on('error', error => {
    logger.critical({
        module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_START_FAILED,
        message: 'STARTUP FAILED: HTTP server could not listen', error,
        fields: { port: Number(PORT), suggested_check: error.code === 'EADDRINUSE' ? `Check which process already uses port ${PORT}.` : 'Check port and container network configuration.' }
    });
    gracefulShutdown('listen-error', 1);
});

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', error => {
    logger.critical({
        module: 'app.lifecycle', function: 'uncaughtException', code: ERROR_CODES.SYS_UNCAUGHT_EXCEPTION,
        message: 'Uncaught exception; shutting down', error
    });
    gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.critical({
        module: 'app.lifecycle', function: 'unhandledRejection', code: ERROR_CODES.SYS_UNHANDLED_REJECTION,
        message: 'Unhandled promise rejection', error
    });
    gracefulShutdown('unhandledRejection', 1);
});
