// 清除代理伺服器環境變數以防 Axios 走代理導致無法連線本機設備
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const express = require('express');
const axios = require('axios');
const webPushLibrary = require('web-push');
const fs = require('node:fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const {
    loadEnvFile,
    parseDesiredEnvFile,
    rewriteEnvFileAtomically,
    upsertEnvAssignment
} = require('./server/storage/env-file-store');
const {
    readJsonObjectFile,
    writeJsonObjectAtomically
} = require('./server/storage/json-file-store');
const { acquireInstanceLock } = require('./server/storage/instance-lock');
const { createSshConnectionPool } = require('./server/integrations/ssh-connection-pool');
const ENV_FILE = path.resolve(process.env.SMARTHUB_ENV_FILE || path.join(__dirname, '.env'));
const envFileState = loadEnvFile(ENV_FILE, {
    environment: process.env,
    required: process.env.NODE_ENV === 'production'
}); // 先驗證 regular/size/mode/RW，再載入；開發環境允許檔案不存在
const os = require('os');
const { version: APP_VERSION } = require('./package.json');
const { createBuildIdentity } = require('./observability/build-identity');
const { ERROR_CODES } = require('./observability/error-codes');
const { createLogger, maskString } = require('./observability/logger');
const { IssueTracker } = require('./observability/issue-tracker');
const { TaskTracker } = require('./observability/task-tracker');
const { SystemMonitor } = require('./observability/system-monitor');
const { registerHealthRoutes } = require('./observability/health-routes');
const { forwardNasLogs, forwardNasAlerts } = require('./nas-log-forwarder');
const { createActivityLease } = require('./activity-lease');
const { TelegramCommandBot } = require('./telegram-command-bot');
const { createPanelSecurity, parseTrustedProxies } = require('./server/middleware/panel-security');
const { frontendStaticOptions, registerFrontendAssetRoutes } = require('./server/routes/frontend-asset-routes');
const { registerPanelAuthRoutes } = require('./server/routes/panel-auth-routes');
const { createPublicSystemHealthService } = require('./server/services/public-system-health');
const { registerWiimCommandRoutes } = require('./server/routes/wiim-command-routes');
const { createSiteManagerClient } = require('./server/integrations/site-manager-client');
const { createUniFiTrafficListClient } = require('./server/integrations/unifi-traffic-list-client');
const { createAdGuardConnection } = require('./server/integrations/adguard-client');
const { createNasMonitorConnection } = require('./server/integrations/nas-monitor-client');
const {
    PartialNotificationDeliveryError,
    createNotificationDispatcher,
    dispatchNotificationFanout
} = require('./server/integrations/notification-delivery');
const writeInput = require('./server/policies/write-input-policy');
const queryInput = require('./server/policies/query-input-policy');
const threatIpPolicy = require('./server/policies/threat-ip-policy');
const adguardServicePolicy = require('./server/policies/adguard-service-policy');
const {
    DockerActionPolicyError,
    ambiguousDockerActionResult,
    containersFromPayload,
    selectDockerActionTarget
} = require('./server/policies/docker-action-policy');
const { deriveDueReportSlot } = require('./server/jobs/report-schedule');
const { createReportRunner } = require('./server/jobs/report-runner');
const { createUpsState, FETCH_HEALTH, TRANSITION_TYPES } = require('./server/jobs/ups-state');
const {
    DEFAULT_SAG_THRESHOLD_V,
    createUpsSagDetector,
    normalizePpbEvent
} = require('./server/services/ups-power-quality');
const {
    BACKUP_MEDIA_TYPE,
    MAX_BACKUP_BYTES,
    BackupValidationError,
    applyPendingRestore,
    createConfigBackupService
} = require('./server/services/config-backup');
const {
    ThreatIpBlockingError,
    createThreatIpBlockingService
} = require('./server/services/threat-ip-blocking');
const {
    AdGuardServicePolicyError,
    createAdGuardServicePolicyService
} = require('./server/services/adguard-service-policy');
const {
    WebPushServiceError,
    createWebPushService
} = require('./server/services/web-push');
const { createDockerMetricAlertState } = require('./server/services/docker-notification-state');
const { createRecoverableFailureState } = require('./server/services/recoverable-failure-state');
const {
    createAutoDefenseBlockState,
    isRecentAlarmTimestamp
} = require('./server/services/auto-defense-block-state');
const { renderPwaServiceWorker } = require('./server/services/pwa-service-worker');
const { registerWebPushRoutes } = require('./server/routes/web-push-routes');
const { renderWifiQrSvg } = require('./server/services/wifi-qr');
const { createAdaptiveSampler } = require('./server/services/adaptive-sampler');
const { createSseBackpressure } = require('./server/services/sse-backpressure');
const { createArtworkCache, fetchArtwork } = require('./server/services/wiim-art-proxy');
const { createDeviceCollectorCache } = require('./server/services/device-collector-cache');
const { createUnifiDeviceTelemetrySnapshot } = require('./server/services/unifi-device-telemetry-snapshot');
const { createUnifiDeviceThermalSshCollector, normalizeDeviceId, managementIp } = require('./server/integrations/unifi-device-thermal-ssh');
const { createUnifiDeviceTemperatureAlertState } = require('./server/services/unifi-device-temperature-alert-state');
const {
    findTemperature,
    presentUnifiDeviceTelemetry,
    temperatureNotificationText,
    telemetryHistoryPoint
} = require('./server/services/unifi-device-telemetry');

if (process.env.BUILD_IDENTITY_REQUIRED !== undefined
    && !['true', 'false'].includes(process.env.BUILD_IDENTITY_REQUIRED)) {
    throw new Error('BUILD_IDENTITY_REQUIRED must be true or false');
}
const buildIdentityRequired = process.env.BUILD_IDENTITY_REQUIRED === 'true';
const buildIdentity = createBuildIdentity(process.env, {
    requireComplete: buildIdentityRequired,
    requireClean: buildIdentityRequired
});

const APP_STARTED_AT = Date.now();
let shuttingDown = false;
const lifecycleIntervals = new Set();
const lifecycleTimeouts = new Set();
let eventLoopLagMs = 0;
let eventLoopExpectedAt = Date.now() + 1000;

function lifecycleInterval(callback, milliseconds) {
    const handle = setInterval(callback, milliseconds);
    lifecycleIntervals.add(handle);
    return handle;
}

function clearLifecycleInterval(handle) {
    if (!handle) return;
    clearInterval(handle);
    lifecycleIntervals.delete(handle);
}

lifecycleInterval(() => {
    const now = Date.now();
    eventLoopLagMs = Math.max(0, now - eventLoopExpectedAt);
    eventLoopExpectedAt = now + 1000;
}, 1000).unref?.();

function lifecycleTimeout(callback, milliseconds, { unref = false } = {}) {
    let handle;
    handle = setTimeout(() => {
        lifecycleTimeouts.delete(handle);
        callback();
    }, milliseconds);
    lifecycleTimeouts.add(handle);
    if (unref && typeof handle.unref === 'function') handle.unref();
    return handle;
}

function clearLifecycleTimeout(handle) {
    if (!handle) return;
    clearTimeout(handle);
    lifecycleTimeouts.delete(handle);
}

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

function validatedInput(res, parse, { module, function: functionName }) {
    try { return parse(); }
    catch (error) {
        if (!(error instanceof writeInput.InputValidationError)) throw error;
        apiError(res, error, {
            status: error.httpStatus,
            code: ERROR_CODES.API_VALIDATION_FAILED,
            publicMessage: error.message,
            module,
            function: functionName,
            fields: error.field ? { field: error.field } : undefined
        });
        return null;
    }
}

// 某些唯讀整合端點為維持既有 UI 契約，失敗時仍以 200 + source:error 回退。
// 這些錯誤必須進 Docker log，但以 cooldown 合併，避免前端輪詢造成 log storm。
const RECOVERABLE_LOG_COOLDOWN_MS = Math.max(Number(process.env.ALERT_COOLDOWN_SECONDS) || 300, 1) * 1000;
const recoverableFailures = createRecoverableFailureState({
    cooldownMs: RECOVERABLE_LOG_COOLDOWN_MS,
    maxEntries: 2000
});
function publicError(error) {
    return maskString(error?.message || String(error || 'External service unavailable')).slice(0, 500);
}
function logRecoverableFailure(key, error, options = {}) {
    const now = Date.now();
    const state = recoverableFailures.record(key, now);
    if (state.shouldLog) {
        logger.warning({
            module: options.module || 'external', function: options.function || 'fallback',
            code: options.code || ERROR_CODES.API_INTERNAL_ERROR,
            message: options.message || 'Recoverable integration failure; fallback response returned',
            error, fields: { ...options.fields, occurrences: state.occurrences, cooldown_seconds: RECOVERABLE_LOG_COOLDOWN_MS / 1000 }
        });
    }
}

logger.info({
    module: 'app.lifecycle', function: 'bootstrap', code: ERROR_CODES.SYS_START,
    message: 'SmartHub starting', fields: {
        version: APP_VERSION,
        ...buildIdentity.logFields,
        environment: process.env.NODE_ENV || 'development',
        node: process.version,
        hostname: os.hostname(),
        log_level: logger.level,
        log_format: logger.format
    }
});

const app = express();
// 前端與後端同源 (由本伺服器託管)，不需要 CORS；移除全開 cors() 以避免跨站請求濫用
const trustedProxies = parseTrustedProxies(process.env.PANEL_TRUSTED_PROXIES);
if (trustedProxies) app.set('trust proxy', trustedProxies);
app.use(logger.requestMiddleware());
const panelSecurity = createPanelSecurity({
    adminPassword: process.env.PANEL_PASSWORD,
    readonlyPassword: process.env.PANEL_READONLY_PASSWORD,
    readonlyUsername: process.env.PANEL_READONLY_USERNAME || 'readonly',
    requireAdminPassword: process.env.NODE_ENV === 'production',
    allowedOrigins: process.env.PANEL_ALLOWED_ORIGINS,
    maxFailures: Number(process.env.PANEL_AUTH_MAX_FAILURES) || 5,
    failureWindowMs: (Number(process.env.PANEL_AUTH_WINDOW_SECONDS) || 300) * 1000,
    cooldownMs: (Number(process.env.PANEL_AUTH_COOLDOWN_SECONDS) || 300) * 1000,
    maxTrackedClients: Number(process.env.PANEL_AUTH_MAX_CLIENTS) || 1000,
    sessionIdleMs: (Number(process.env.PANEL_SESSION_IDLE_SECONDS) || 43200) * 1000,
    sessionRememberMs: (Number(process.env.PANEL_SESSION_REMEMBER_SECONDS) || 2592000) * 1000,
    maxSessions: Number(process.env.PANEL_SESSION_MAX) || 1000,
    publicMetadata: { version: APP_VERSION },
    getRequestId: () => logger.getContext().request_id,
    authCode: ERROR_CODES.API_AUTH_FAILED,
    rateLimitCode: ERROR_CODES.API_AUTH_RATE_LIMITED,
    authorizationCode: ERROR_CODES.API_AUTHORIZATION_FAILED,
    csrfCode: ERROR_CODES.API_CSRF_FAILED,
    originCode: ERROR_CODES.API_ORIGIN_FAILED,
    onEvent: ({ type, ...fields }) => logger.warning({
        module: 'api.security', function: type,
        code: type.startsWith('auth_') ? ERROR_CODES.API_AUTH_FAILED
            : type === 'authorization_denied' ? ERROR_CODES.API_AUTHORIZATION_FAILED
                : type === 'origin_denied' ? ERROR_CODES.API_ORIGIN_FAILED : ERROR_CODES.API_CSRF_FAILED,
        message: 'Panel security request denied', fields
    })
});
const publicSystemHealth = createPublicSystemHealthService({
    maxRequests: Number(process.env.PANEL_PUBLIC_HEALTH_MAX_REQUESTS) || 30,
    windowMs: (Number(process.env.PANEL_PUBLIC_HEALTH_WINDOW_SECONDS) || 60) * 1000,
    maxClients: Number(process.env.PANEL_PUBLIC_HEALTH_MAX_CLIENTS) || 1000
});
registerPanelAuthRoutes(app, {
    rootDir: __dirname,
    security: panelSecurity,
    publicSystemHealth
});
app.use(panelSecurity.authenticate);
app.get('/api/security/csrf', panelSecurity.csrf);
app.use(panelSecurity.protectWrites);
app.use('/api/config/restore', express.raw({ type: BACKUP_MEDIA_TYPE, limit: MAX_BACKUP_BYTES }));
app.use(express.json({ limit: '256kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// 託管前端靜態網頁
registerFrontendAssetRoutes(app, { rootDir: __dirname });
app.use(express.static(path.join(__dirname, 'public'), frontendStaticOptions()));

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
// transport 使用動態 closure，設定頁熱重建 axios instance 後不會保留舊 API key。
const siteManagerClient = createSiteManagerClient({
    transport: (endpoint, config) => unifiCloudClient.get(endpoint, config)
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

// SSH 遙測含 sleep 1；同一設備重用單一連線、命令序列化，閒置時自動釋放。
const ucgSshPool = createSshConnectionPool({
    getConfig: () => ({
        host: process.env.UCG_IP,
        port: parseInt(process.env.SSH_PORT || '22', 10),
        username: process.env.SSH_USER,
        password: process.env.SSH_PASSWORD,
        tryKeyboard: true
    }),
    onKeyboardInteractive: (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => process.env.SSH_PASSWORD));
    }
});

async function fetchHardwareSSH() {
    sysLog('Hardware', `透過共用 SSH 連線讀取 UCG-Ultra (${process.env.UCG_IP}:${process.env.SSH_PORT || 22})...`);
    let output;
    try { output = await ucgSshPool.execute(HW_CMD); }
    catch (error) {
        const authFail = /authentication methods failed/i.test(error.message || '');
        sysLog('Hardware', `SSH 指令或連線失敗: ${error.code || error.message}`, true);
        throw {
            status: 500, body: {
                error: 'SSH Connection Failed',
                details: authFail
                    ? 'SSH 密碼被 UCG 拒絕。注意：SSH 密碼是獨立的，不是 UniFi 登入密碼 — 請到 UniFi 主控台 → Console Settings → Advanced → SSH，在那裡「設定 SSH 專用密碼」後填入本頁'
                    : error.message
            }
        };
    }
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
        return data;
    } catch (error) {
        throw { status: 500, body: { error: 'Hardware Output Parse Failed: ' + error.message } };
    }
}

function generalCollectorCacheAgeMs() {
    return Math.max(normalDeviceSampleMs() * 2, 1000);
}
const deviceCollectorCache = createDeviceCollectorCache({ cacheAgeMs: generalCollectorCacheAgeMs });
const unifiDeviceThermalCollector = createUnifiDeviceThermalSshCollector({
    getEnvironment: () => process.env
});
const unifiThermalCache = createDeviceCollectorCache({ cacheAgeMs: () => unifiTelemetrySampleMs() });
let unifiThermalLastRunAt = null;
const unifiDeviceTelemetrySnapshot = createUnifiDeviceTelemetrySnapshot({
    sample: () => collectUnifiDeviceTelemetrySnapshot(),
    staleAfterMs: () => Math.max(unifiTelemetrySampleMs() * 3, 15 * 60 * 1000)
});
async function readDeviceCollector(name, collect, { refresh = false, allowStale = false } = {}) {
    return deviceCollectorCache.read(name, collect, { refresh, allowStale });
}
function latestDeviceCollector(name) {
    return deviceCollectorCache.snapshot(name)?.data;
}
function deviceCollectorSnapshot(name) {
    return deviceCollectorCache.snapshot(name);
}

// 行程內共用入口 (route / notificationWatcher / buildReport 皆走這裡，不再自打 HTTP)
async function getHardwareCached({ force = false, allowStale = false } = {}) {
    return readDeviceCollector('ucg.hardware', fetchHardwareSSH, { refresh: force, allowStale });
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

async function collectUnifiClients() {
    const cookie = await getLocalSession();
    const response = await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { 'Cookie': cookie } });
    return response.data.data || [];
}
async function getUnifiClientsCached(options) {
    return readDeviceCollector('unifi.clients', collectUnifiClients, options);
}
async function collectUnifiNetworkDevices() {
    const cookie = await getLocalSession();
    const response = await unifiClient.get('/proxy/network/api/s/default/stat/device', { headers: { 'Cookie': cookie } });
    return response.data.data || [];
}
async function collectUnifiHealth() {
    const cookie = await getLocalSession();
    const response = await unifiClient.get('/proxy/network/api/s/default/stat/health', { headers: { 'Cookie': cookie } });
    return { ok: true, payload: response.data };
}
function getUnifiHealthCached(options) {
    return readDeviceCollector('unifi.health', collectUnifiHealth, options);
}
function getUnifiNetworkDevicesCached(options) {
    return readDeviceCollector('unifi.networkDevices', collectUnifiNetworkDevices, options);
}
async function getUnifiDeviceTelemetryCached() {
    // This route-facing read is intentionally independent from the general
    // device collector: only the dedicated 60/300-second sampler refreshes it.
    return unifiDeviceTelemetrySnapshot.read();
}
function presentUnifiDeviceTelemetrySnapshot(devices, sampledAt = null) {
    const directThermalByDevice = latestUnifiDeviceThermals(devices);
    const telemetry = presentUnifiDeviceTelemetry(devices, {
        sampledAt: sampledAt
            ? new Date(sampledAt).toISOString()
            : new Date().toISOString(),
        directThermalByDevice,
        thermalSshConfigured: unifiDeviceThermalCollector.configured()
    });
    const entries = [...directThermalByDevice.values()];
    const missingTargets = entries.filter(entry => entry.errorCode === 'device_not_found');
    telemetry.thermalSsh = {
        ...unifiDeviceThermalCollector.status(),
        lastRunAt: unifiThermalLastRunAt,
        successfulDeviceCount: entries.filter(entry => entry.thermal && !entry.stale).length,
        failedDeviceCount: entries.filter(entry => entry.errorCode).length,
        notFoundDeviceCount: missingTargets.length,
        missingTargets: missingTargets.map(entry => ({ id: entry.id, errorCode: entry.errorCode }))
    };
    return telemetry;
}

function latestUnifiDeviceThermals(rawDevices) {
    const targets = new Set(unifiDeviceThermalCollector.parseTargetIds());
    const direct = new Map();
    const byId = new Map((Array.isArray(rawDevices) ? rawDevices : []).map(device => [normalizeDeviceId(device?.mac || device?._id), device]).filter(([id]) => id));
    for (const id of targets) {
        const device = byId.get(id);
        if (!device) {
            direct.set(id, { id, selected: true, configured: true, thermal: null, stale: false, lastSuccessAt: null, lastErrorAt: null, errorCode: 'device_not_found' });
            continue;
        }
        const snapshot = unifiThermalCache.snapshot(`unifi.deviceThermal.${id}`);
        const data = snapshot?.data;
        const ageMs = snapshot?.lastSuccessAt ? Date.now() - snapshot.lastSuccessAt : Infinity;
        const offline = !(device.state === 1 || device.state === '1' || String(device.state).toLowerCase() === 'connected');
        direct.set(id, {
            id,
            selected: true,
            thermal: data?.thermal || null,
            stale: !!data?.thermal && (offline || !!snapshot?.lastErrorAt || ageMs > Math.max(unifiTelemetrySampleMs() * 3, 15 * 60 * 1000)),
            lastSuccessAt: snapshot?.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : null,
            lastErrorAt: snapshot?.lastErrorAt ? new Date(snapshot.lastErrorAt).toISOString() : null,
            errorCode: offline ? 'device_offline' : (snapshot?.lastError?.code || null)
        });
    }
    return direct;
}

async function refreshUnifiDeviceThermals(rawDevices) {
    const targets = new Set(unifiDeviceThermalCollector.parseTargetIds());
    const selected = (Array.isArray(rawDevices) ? rawDevices : []).filter(device => {
        const id = normalizeDeviceId(device?.mac || device?._id);
        return id && targets.has(id) && !findTemperature(device);
    });
    const results = await Promise.all(selected.map(async device => {
        const id = normalizeDeviceId(device.mac || device._id);
        const key = `unifi.deviceThermal.${id}`;
        try {
            await unifiThermalCache.read(key, async () => {
                const result = await unifiDeviceThermalCollector.collect(device);
                if (result.thermal && !result.discarded) return result;
                const error = new Error(result.errorCode || 'unknown_error');
                error.code = result.errorCode || 'unknown_error';
                throw error;
            }, { refresh: true });
            return { id, ok: true };
        } catch (error) {
            logRecoverableFailure(`sampler.unifiDeviceThermal:${id}`, error, {
                module: 'scheduler.unifiDeviceThermal', function: 'collect', code: ERROR_CODES.EXT_UNIFI_FAILED,
                fields: { device_id: id, error_code: error.code || 'unknown_error' }
            });
            return { id, ok: false };
        }
    }));
    unifiThermalLastRunAt = new Date().toISOString();
    return results;
}

async function collectUnifiDeviceTelemetrySnapshot() {
    const devices = await getUnifiNetworkDevicesCached({ refresh: true });
    await refreshUnifiDeviceThermals(devices);
    const controllerSnapshot = deviceCollectorSnapshot('unifi.networkDevices');
    const telemetry = presentUnifiDeviceTelemetrySnapshot(devices, controllerSnapshot?.lastSuccessAt);
    return {
        ...telemetry,
        controllerSampledAt: controllerSnapshot?.lastSuccessAt ? new Date(controllerSnapshot.lastSuccessAt).toISOString() : telemetry.sampledAt,
        thermalSampledAt: unifiThermalLastRunAt || telemetry.sampledAt
    };
}
async function collectUnifiWifiNetworks() {
    const cookie = await getLocalSession();
    const response = await unifiClient.get('/proxy/network/api/s/default/rest/wlanconf', { headers: { 'Cookie': cookie } });
    return response.data.data || [];
}
function getUnifiWifiNetworksCached(options) {
    return readDeviceCollector('unifi.wifiNetworks', collectUnifiWifiNetworks, options);
}
function presentUnifiClients(rawClients) {
    return rawClients.map(c => ({
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
}
// 2. 獲取活躍客戶端
app.get('/api/clients', async (req, res) => {
    try {
        sysLog('UniFi API', '獲取活躍客戶端清單...');
        const clients = presentUnifiClients(await getUnifiClientsCached());
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

app.get('/api/network/devices/telemetry', async (_req, res) => {
    try {
        res.json(await getUnifiDeviceTelemetryCached());
    } catch (error) {
        apiError(res, error, {
            code: ERROR_CODES.EXT_UNIFI_FAILED,
            module: 'api.unifiDeviceTelemetry',
            function: 'getCurrent',
            logMessage: 'Failed to fetch UniFi device telemetry'
        });
    }
});

app.post('/api/network/devices/telemetry/thermal-probe', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseUnifiDeviceThermalProbe(req.body), {
        module: 'api.unifiDeviceTelemetry', function: 'thermalProbe'
    });
    if (!input) return;
    try {
        const devices = await getUnifiNetworkDevicesCached({ refresh: true });
        const target = devices.find(device => normalizeDeviceId(device?.mac || device?._id) === input.deviceId);
        if (!target) return res.status(404).json({ error: 'device_not_found', code: ERROR_CODES.API_NOT_FOUND });
        if (!unifiDeviceThermalCollector.parseTargetIds().includes(input.deviceId)) {
            return res.status(400).json({ error: 'device_not_selected', code: ERROR_CODES.API_VALIDATION_FAILED });
        }
        await refreshUnifiDeviceThermals([target]);
        const direct = latestUnifiDeviceThermals([target]).get(input.deviceId);
        res.json({
            deviceId: input.deviceId,
            temperature: direct?.thermal ? {
                maxTemperatureC: direct.thermal.maxTemperatureC,
                averageTemperatureC: direct.thermal.averageTemperatureC,
                cpuTemperatureC: direct.thermal.cpuTemperatureC,
                zones: direct.thermal.zones,
                source: direct.thermal.source,
                sampledAt: direct.thermal.sampledAt,
                stale: direct.stale
            } : null,
            errorCode: direct?.errorCode || null
        });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.unifiDeviceTelemetry', function: 'thermalProbe', logMessage: 'UniFi device SSH thermal probe failed' });
    }
});

app.get('/api/network/devices/telemetry/history', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.unifiDeviceTelemetry', function: 'listHistory'
    });
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({
        data: historyDb.getSince('unifiDevices', cutoff),
        source: {
            system: 'UniFi Network Controller',
            endpoint: '/proxy/network/api/s/default/stat/device',
            interpretation: 'direct_device_report'
        }
    });
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
    const input = validatedInput(res, () => writeInput.parseWifiUpdate(req.params.id, req.body), {
        module: 'api.wifi', function: 'updateWifiNetwork'
    });
    if (!input) return;
    try {
        sysLog('UniFi API', `調整 SSID 狀態：ID ${input.id} -> 啟用: ${input.enabled}`);
        const cookie = await getLocalSession();
        const response = await unifiClient.put(`/proxy/network/api/s/default/rest/wlanconf/${input.id}`, {
            enabled: input.enabled
        }, { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', `SSID 狀態變更成功。`);
        res.json({ success: true });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.wifi', function: 'updateWifiNetwork', logMessage: 'Failed to update WiFi network' });
    }
});

app.post('/api/wifi/qr', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseWifiQrRequest(req.body), {
        module: 'api.wifiQr', function: 'render'
    });
    if (!input) return;
    try {
        const svg = await renderWifiQrSvg(input);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.type('image/svg+xml').send(svg);
    } catch (error) {
        apiError(res, error, { module: 'api.wifiQr', function: 'render', logMessage: 'WiFi QR generation failed' });
    }
});

async function collectUnifiThreats() {
    const cookie = await getLocalSession();
    const response = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
    return response.data.data || [];
}
async function getUnifiThreatsCached(options) {
    return readDeviceCollector('unifi.threats', collectUnifiThreats, options);
}
function presentUnifiThreats(rawThreats) {
    return rawThreats.filter(isIpsAlarm).map(t => {
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
}
// 5. 獲取 IPS/IDS 威脅警報
app.get('/api/threats', async (req, res) => {
    try {
        const threats = presentUnifiThreats(await getUnifiThreatsCached());
        res.json({ threats });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.threats', function: 'getThreats', logMessage: 'Failed to fetch UniFi threats' });
    }
});

// 資料持久化目錄 (可用 DATA_DIR 環境變數覆寫；Docker 部署時掛載為 volume 以保留歷史資料)
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
   以獨立 SQLite authority 在 IMMEDIATE transaction 內寫入 runtime/PID/token + renewable lease；
   lease 過期才可接管，舊版 PID lock 只在取得 transaction owner 後遷移。
   設 ALLOW_MULTI_INSTANCE=1 可跳過 (僅限隔離測試)。 */
const LOCK_FILE = path.join(DATA_DIR, '.instance-lock.sqlite');
const LEGACY_LOCK_FILE = path.join(DATA_DIR, '.instance.lock');
let instanceLock = null;
if (process.env.ALLOW_MULTI_INSTANCE !== '1') {
    try {
        instanceLock = acquireInstanceLock({ lockFile: LOCK_FILE, legacyLockFile: LEGACY_LOCK_FILE });
    }
    catch (error) {
        logger.critical({
            module: 'app.instanceLock', function: 'acquire', code: ERROR_CODES.SYS_START_FAILED,
            message: error.code === 'INSTANCE_LOCK_HELD'
                ? 'Another SmartHub instance is already using this DATA_DIR'
                : 'Failed to acquire SmartHub instance lock',
            error,
            fields: {
                lock_file: path.basename(LOCK_FILE),
                ...(error.ownerPid ? { existing_pid: error.ownerPid } : {}),
                suggested_check: 'Use a different DATA_DIR or set ALLOW_MULTI_INSTANCE=1 only for isolated tests.'
            }
        });
        process.exit(1);
    }
    const heartbeat = lifecycleInterval(() => {
        try {
            if (instanceLock.renew()) return;
            throw new Error('instance lock owner row no longer matches this runtime');
        } catch (error) {
            logger.critical({
                module: 'app.instanceLock', function: 'renew', code: ERROR_CODES.SYS_START_FAILED,
                message: 'SmartHub lost DATA_DIR instance ownership; shutting down', error
            });
            void gracefulShutdown('instance-lock-lost', 1);
        }
    }, instanceLock.heartbeatMs);
    heartbeat.unref();
    process.on('exit', () => { instanceLock?.release(); });
}

// Restore mutates the complete persistent state and must never run until this
// process owns the DATA_DIR instance lock. This keeps accidental parallel
// starts from replacing a database that another process still has open.
try {
    const restoreResult = applyPendingRestore({ dataDir: DATA_DIR });
    if (restoreResult.applied) {
        logger.warning({
            module: 'config.restore', function: 'applyPendingRestore', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'A validated configuration restore was applied during startup',
            fields: { rollback_directory: path.basename(restoreResult.backupDirectory), secrets_restored: false }
        });
    }
} catch (error) {
    logger.critical({
        module: 'config.restore', function: 'applyPendingRestore', code: ERROR_CODES.SYS_START_FAILED,
        message: 'Startup failed while applying or recovering a staged restore', error
    });
    process.exit(1);
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
const configBackupService = createConfigBackupService({
    dataDir: DATA_DIR,
    envFile: ENV_FILE,
    appVersion: APP_VERSION,
    database: historyDb
});
const threatTrafficListClient = createUniFiTrafficListClient({
    transport: ({ tlsVerify, ...request }) => axios({
        ...request,
        httpsAgent: new https.Agent({ rejectUnauthorized: tlsVerify !== false })
    }),
    getEnvironment: () => process.env
});
const threatIpBlockingService = createThreatIpBlockingService({
    repository: historyDb,
    client: threatTrafficListClient,
    logger
});
const adguardServicePolicyClient = {
    configuration: () => ({
        configured: adguardConnection.configured,
        transport: adguardConnection.url ? new URL(adguardConnection.url).protocol.replace(':', '') : null,
        tlsVerified: adguardConnection.tlsVerified
    }),
    listClients: () => adgReq('/control/clients'),
    listServices: () => adgReq('/control/blocked_services/all'),
    updateClient: (name, data) => adgReq('/control/clients/update', 'post', { name, data })
};
const adguardServicePolicyService = createAdGuardServicePolicyService({
    repository: historyDb,
    client: adguardServicePolicyClient,
    logger
});
const webPushService = createWebPushService({
    repository: historyDb,
    webPush: webPushLibrary,
    env: process.env,
    logger
});

function protectedManagementAddresses() {
    const addresses = new Set();
    for (const key of ['UCG_IP', 'NAS_HOST', 'WIIM_IP', 'NUT_HOST', 'PPB_HOST', 'ADGUARD_HOST', 'LINUX_HOST']) {
        if (process.env[key]) addresses.add(process.env[key]);
    }
    for (const key of ['UNIFI_CONTROLLER_URL', 'UNIFI_NETWORK_API_URL', 'ADGUARD_URL']) {
        try { addresses.add(new URL(process.env[key]).hostname); } catch { }
    }
    const targets = new Set(unifiDeviceThermalCollector?.parseTargetIds?.() || []);
    const devices = latestDeviceCollector('unifi.networkDevices') || [];
    for (const device of devices) {
        if (targets.has(normalizeDeviceId(device?.mac || device?._id))) {
            const ip = managementIp(device);
            if (ip) addresses.add(ip);
        }
    }
    return [...addresses];
}

app.get('/api/security/threat-blocks', panelSecurity.requireAdmin, (_req, res) => {
    res.json(threatIpBlockingService.snapshot());
});

app.post('/api/security/threat-blocks', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => threatIpPolicy.parseCreateThreatIpBlock(req.body, {
        protectedAddresses: protectedManagementAddresses()
    }), { module: 'api.threatBlock', function: 'add' });
    if (!input) return;
    try {
        const result = await threatIpBlockingService.add(input);
        res.status(result.applied ? (result.duplicate ? 200 : 201) : 202).json(result);
    } catch (error) {
        const expected = error instanceof ThreatIpBlockingError;
        apiError(res, error, {
            status: expected ? error.httpStatus : 500,
            code: expected ? ERROR_CODES.SYS_CONFIG_INVALID : ERROR_CODES.EXT_UNIFI_FAILED,
            publicMessage: expected ? error.message : 'Threat block request failed',
            module: 'api.threatBlock', function: 'add', logMessage: 'Threat block request failed'
        });
    }
});

app.delete('/api/security/threat-blocks/:id', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => threatIpPolicy.parseRemoveThreatIpBlock(req.params.id, req.body), {
        module: 'api.threatBlock', function: 'remove'
    });
    if (!input) return;
    try {
        const result = await threatIpBlockingService.remove(input.id);
        res.status(result.applied ? 200 : 202).json(result);
    } catch (error) {
        const expected = error instanceof ThreatIpBlockingError;
        apiError(res, error, {
            status: expected ? error.httpStatus : 500,
            code: expected && error.httpStatus === 404 ? ERROR_CODES.API_NOT_FOUND : ERROR_CODES.EXT_UNIFI_FAILED,
            publicMessage: expected ? error.message : 'Threat block removal failed',
            module: 'api.threatBlock', function: 'remove', logMessage: 'Threat block removal failed'
        });
    }
});
const HISTORY_HARD_CAP = 100000;
let lastHistoryCleanup = { durationMs: null, failed: false, completedAt: null };
const systemMonitor = new SystemMonitor({
    dataDir: DATA_DIR, db: historyDb, taskTracker, issueTracker, logger,
    version: APP_VERSION, buildIdentity: buildIdentity.public
});

/* ===================== 應用程式設定 (可於「設定」頁調整所有伺服器端輪詢間隔) ===================== */
const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
const APP_DEFAULTS = {
    deviceActiveFrontendPollSec: 5,
    deviceActiveBackendSampleSec: 5,
    deviceIdleBackendSampleSec: 600,
    unifiTelemetryActiveSec: 60,
    unifiTelemetryIdleSec: 300,
    heartbeatSec: 5,
    activeLeaseSec: 30,
    // Preserve the previous UPS defaults: live status was 3s while viewed and
    // its unattended collector was 10s.
    upsFrontendPollSec: 3,
    upsActiveBackendSampleSec: 3,
    upsIdleBackendSampleSec: 10,
    upsHistoryFrontendPollSec: 10,
    upsPpbEventsFrontendPollSec: 10,
    upsPpbEventActiveBackendSampleSec: 10,
    upsPpbEventIdleBackendSampleSec: 60,
    watcherSec: 20,         // 通知監看器間隔
    toastSec: 10,           // 右下角通知泡泡顯示秒數
    autoDefenseSec: 30,     // 自動防禦掃描間隔
    reportEnabled: true,    // 定期報表 (預設開啟；實際發送仍需通知頁啟用推播+設定管道)
    reportFreq: 'daily',    // daily | weekly
    reportHour: 8,          // 每日幾點發送 (0-23)
    reportHour2: 20,        // 「每日兩次」的第二次發送時間 (0-23)
    wiimCpuAlert: 70,       // WiiM CPU 溫度警示門檻 (°C，圖上門檻線 + 超標推播)
    wiimBoardAlert: 60,     // WiiM 主機板溫度警示門檻 (°C)
    historyFlushMin: 10,    // 一般遙測先存記憶體，再批次寫入 SQLite
    historyKeepDays: 30     // 歷史資料保存天數 (trend/UCG/NAS/UPS/WiiM 統一)
};
const APP_SETTING_RANGES = {
    deviceActiveFrontendPollSec: [1, 3600], deviceActiveBackendSampleSec: [1, 3600],
    deviceIdleBackendSampleSec: [1, 86400], heartbeatSec: [1, 3600], activeLeaseSec: [2, 3600],
    unifiTelemetryActiveSec: [15, 3600], unifiTelemetryIdleSec: [60, 86400],
    upsFrontendPollSec: [1, 3600], upsActiveBackendSampleSec: [1, 3600], upsIdleBackendSampleSec: [1, 3600],
    upsHistoryFrontendPollSec: [1, 3600], upsPpbEventsFrontendPollSec: [1, 3600],
    upsPpbEventActiveBackendSampleSec: [1, 3600], upsPpbEventIdleBackendSampleSec: [1, 3600],
    // Deprecated API aliases remain accepted for existing API clients.  The
    // settings page only exposes the replacement fields above.
    trendActiveSec: [5, 3600], trendIdleSec: [60, 86400], activeWindowSec: [5, 3600], upsSampleSec: [5, 3600],
    watcherSec: [5, 3600], autoDefenseSec: [5, 3600], reportHour: [0, 23], reportHour2: [0, 23],
    wiimCpuAlert: [1, 120], wiimBoardAlert: [1, 120],
    toastSec: [1, 60], historyFlushMin: [1, 60], historyKeepDays: [1, 365]
};
function migrateLegacyAppSettings(stored) {
    const migrated = { ...stored };
    const mappings = [
        ['trendActiveSec', 'deviceActiveBackendSampleSec'],
        ['trendIdleSec', 'deviceIdleBackendSampleSec'],
        ['activeWindowSec', 'activeLeaseSec'],
        ['upsSampleSec', 'upsIdleBackendSampleSec']
    ];
    for (const [legacy, canonical] of mappings) {
        if (Object.hasOwn(stored, legacy) && !Object.hasOwn(stored, canonical)) migrated[canonical] = stored[legacy];
    }
    return migrated;
}
function normalizeAppSettings(settings, incoming = {}) {
    // One-time migration and old API compatibility.  Keep aliases in the
    // response/file so older clients continue to work, but all schedulers read
    // only the canonical settings.
    if (!Object.hasOwn(settings, 'deviceActiveBackendSampleSec')) settings.deviceActiveBackendSampleSec = settings.trendActiveSec;
    if (!Object.hasOwn(settings, 'deviceIdleBackendSampleSec')) settings.deviceIdleBackendSampleSec = settings.trendIdleSec;
    if (!Object.hasOwn(settings, 'activeLeaseSec')) settings.activeLeaseSec = settings.activeWindowSec;
    if (!Object.hasOwn(settings, 'upsIdleBackendSampleSec')) settings.upsIdleBackendSampleSec = settings.upsSampleSec;
    if (Object.hasOwn(incoming, 'trendActiveSec') && !Object.hasOwn(incoming, 'deviceActiveBackendSampleSec')) settings.deviceActiveBackendSampleSec = incoming.trendActiveSec;
    if (Object.hasOwn(incoming, 'trendIdleSec') && !Object.hasOwn(incoming, 'deviceIdleBackendSampleSec')) settings.deviceIdleBackendSampleSec = incoming.trendIdleSec;
    if (Object.hasOwn(incoming, 'activeWindowSec') && !Object.hasOwn(incoming, 'activeLeaseSec')) settings.activeLeaseSec = incoming.activeWindowSec;
    if (Object.hasOwn(incoming, 'upsSampleSec') && !Object.hasOwn(incoming, 'upsIdleBackendSampleSec')) settings.upsIdleBackendSampleSec = incoming.upsSampleSec;
    for (const [key, [min, max]] of Object.entries(APP_SETTING_RANGES)) {
        if (typeof settings[key] === 'number' && Number.isFinite(settings[key])) {
            settings[key] = Math.min(max, Math.max(min, settings[key]));
        }
    }
    settings.trendActiveSec = settings.deviceActiveBackendSampleSec;
    settings.trendIdleSec = settings.deviceIdleBackendSampleSec;
    settings.activeWindowSec = settings.activeLeaseSec;
    settings.upsSampleSec = settings.upsIdleBackendSampleSec;
    return settings;
}
let appSettings = normalizeAppSettings((() => {
    try {
        const stored = readJsonObjectFile(APP_SETTINGS_FILE);
        const migrated = migrateLegacyAppSettings(stored);
        const next = normalizeAppSettings({ ...APP_DEFAULTS, ...migrated }, stored);
        if (Object.keys(migrated).some(key => migrated[key] !== stored[key])) writeJsonObjectAtomically(APP_SETTINGS_FILE, next);
        return next;
    }
    catch (error) {
        if (error.cause?.code !== 'ENOENT') logger.warning({
            module: 'config.app', function: 'loadAppSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'App settings could not be read; defaults are in use', error, fields: { file: path.basename(APP_SETTINGS_FILE) }
        });
        return { ...APP_DEFAULTS };
    }
})());
function saveAppSettings(next) {
    try { writeJsonObjectAtomically(APP_SETTINGS_FILE, next); }
    catch (error) {
        if (error.committed) appSettings = next;
        throw error;
    }
    appSettings = next;
}

/* ===================== 跨部署 UI 偏好 =====================
   連線、通知與伺服器設定各自已有專用檔案；這裡保存純介面偏好，讓重建
   容器或換瀏覽器後，仍可還原使用者最後選擇的主題、輪詢與版面。 */
const UI_PREFERENCES_FILE = path.join(DATA_DIR, 'ui-preferences.json');
let uiPreferences = (() => {
    try { return readJsonObjectFile(UI_PREFERENCES_FILE); }
    catch (error) {
        if (error.cause?.code !== 'ENOENT') logger.warning({
            module: 'config.uiPreferences', function: 'loadUiPreferences', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'UI preferences could not be read; using an empty object', error, fields: { file: path.basename(UI_PREFERENCES_FILE) }
        });
        return {};
    }
})();
app.get('/api/ui-preferences', (_req, res) => res.json({ preferences: uiPreferences }));
app.post('/api/ui-preferences', (req, res) => {
    const incoming = validatedInput(res, () => writeInput.parseUiPreferences(req.body), {
        module: 'api.uiPreferences', function: 'save'
    });
    if (!incoming) return;
    const next = { ...uiPreferences, ...incoming };
    try { writeJsonObjectAtomically(UI_PREFERENCES_FILE, next); }
    catch (error) {
        if (error.committed) uiPreferences = next;
        return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.uiPreferences', function: 'save', logMessage: 'UI preference persistence failed' });
    }
    uiPreferences = next;
    res.json({ ok: true, preferences: uiPreferences });
});

// SQLite 以資料庫端清理取代舊的記憶體陣列 prune；清理後保留增量 vacuum，避免檔案無限膨脹。
async function runHistoryCleanup() {
    const startedAt = Date.now();
    try {
        const result = await historyDb.cleanupYielding(appSettings.historyKeepDays, HISTORY_HARD_CAP);
        lastHistoryCleanup = { durationMs: Date.now() - startedAt, failed: false, completedAt: new Date().toISOString(), ...result };
    } catch (error) {
        lastHistoryCleanup = { durationMs: Date.now() - startedAt, failed: true, completedAt: new Date().toISOString(), processed: 0, compacted: 0, deleted: 0 };
        throw error;
    }
}
const startupHistoryCleanupPromise = runHistoryCleanup().catch(error => {
    logger.error({
        module: 'history.cleanup', function: 'startup', code: ERROR_CODES.DB_QUERY_FAILED,
        message: 'Startup history cleanup failed', error
    });
    return false;
});
lifecycleInterval(() => runSerialJob('historyCleanup', runHistoryCleanup), 60 * 60 * 1000);
let lastHistoryFlushTs = Date.now();
lifecycleInterval(() => {
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
    try { return readJsonObjectFile(CLIENT_ALIAS_FILE); }
    catch (error) {
        if (error.cause?.code !== 'ENOENT') logger.warning({
            module: 'config.clientAliases', function: 'loadAliases', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Client aliases could not be read; using an empty map', error, fields: { file: path.basename(CLIENT_ALIAS_FILE) }
        });
        return {};
    }
})();
app.get('/api/client-aliases', (req, res) => res.json({ aliases: clientAliases }));
app.post('/api/client-aliases', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAlias(req.body), {
        module: 'api.clientAliases', function: 'saveAlias'
    });
    if (!input) return;
    const next = { ...clientAliases };
    if (input.name) next[input.mac] = input.name;
    else delete next[input.mac];
    try { writeJsonObjectAtomically(CLIENT_ALIAS_FILE, next); }
    catch (error) {
        if (error.committed) clientAliases = next;
        return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.clientAliases', function: 'saveAlias', logMessage: 'Client alias persistence failed' });
    }
    clientAliases = next;
    res.json({ ok: true, aliases: clientAliases });
});

// 6. 客戶端限速/阻斷控制
app.put('/api/device/restrict', async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseDeviceRestriction(req.body), {
        module: 'api.devices', function: 'restrictDevice'
    });
    if (!input) return;
    try {
        sysLog('UniFi API', `收到客戶端控制請求：MAC ${input.deviceId} -> 阻斷: ${input.blockState}`);
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/stamgr', {
            cmd: input.blockState ? 'block-sta' : 'unblock-sta',
            mac: input.deviceId
        }, { headers: { 'Cookie': cookie } });
        { const ns = loadNotifSettings(); if (ns.enabled && ns.triggerBlockAction !== false) notify(input.blockState ? '🚫 設備已封鎖' : '✅ 設備已解除封鎖', `${input.deviceName || input.deviceId}`).catch(() => { }); }
        appendBlockHistory({
            datetime: new Date().toISOString(),
            mac: input.deviceId,
            name: input.deviceName || 'Unknown Device',
            action: input.blockState ? 'block' : 'unblock',
            source: 'manual'
        });
        sysLog('UniFi API', `客戶端 ${input.deviceId} 狀態設定成功。`);
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
    const input = validatedInput(res, () => writeInput.parsePoePowerCycle(req.body), {
        module: 'api.poe', function: 'powerCycle'
    });
    if (!input) return;
    try {
        sysLog('UniFi API', `收到 PoE Port 重啟請求：Switch ${input.switchMac}, Port ${input.portIndex}`);
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/devmgr', {
            cmd: "power-cycle",
            mac: input.switchMac,
            port_idx: input.portIndex
        }, { headers: { 'Cookie': cookie } });
        sysLog('UniFi API', `PoE Port 重啟命令發送成功。`);
        res.json({ success: true });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UNIFI_FAILED, module: 'api.poe', function: 'powerCycle', logMessage: 'PoE power cycle failed' });
    }
});

// 8. 觸發測速
app.post('/api/speedtest', async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body), {
        module: 'api.speedtest', function: 'startSpeedtest'
    });
    if (!input) return;
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

function cloudConfigured() {
    return !!(process.env.UNIFI_API_KEY && !process.env.UNIFI_API_KEY.includes('your_unifi'));
}
function getCloudIspMetricsCached(options) {
    return readDeviceCollector('cloud.ispMetrics', () => siteManagerClient.get('/isp-metrics/5m', { params: { duration: '24h' } }), options);
}
function getCloudHealthCached(options) {
    return readDeviceCollector('cloud.health', async () => {
        try { await siteManagerClient.get('/hosts', { timeoutMs: 8000 }); return { ok: true }; }
        catch { return { ok: false }; }
    }, options);
}
// 9. 獲取雲端站點清單 (對接 UniFi 官方 Site Manager v1.0)
app.get('/api/cloud/sites', async (req, res) => {
    try {
        if (!process.env.UNIFI_API_KEY || process.env.UNIFI_API_KEY.includes('your_unifi')) {
            return res.json({ data: [], source: 'not_configured' });
        }
        res.json(await siteManagerClient.listSites());
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
        res.json(await siteManagerClient.listDevices());
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
        const response = await getCloudIspMetricsCached();
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
        res.json(await siteManagerClient.listHosts());
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
        res.json(await siteManagerClient.listEndpoint('/sd-wan-configs'));
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
    try { secSettingsCache = { autoDefense: false, ...readJsonObjectFile(SEC_FILE) }; }
    catch (error) {
        if (error.cause?.code !== 'ENOENT') logger.warning({
            module: 'config.security', function: 'loadSecSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Security settings could not be read; safe defaults are in use', error, fields: { file: path.basename(SEC_FILE) }
        });
        secSettingsCache = { autoDefense: false };
    }
    return secSettingsCache;
}
function saveSecSettings(s) {
    try { writeJsonObjectAtomically(SEC_FILE, s); }
    catch (error) {
        if (error.committed) secSettingsCache = s;
        throw error;
    }
    secSettingsCache = s;
}

app.get('/api/security/settings', (req, res) => res.json(loadSecSettings()));
app.post('/api/security/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseSingleBoolean(req.body, 'autoDefense'), {
        module: 'api.security', function: 'saveSecSettings'
    });
    if (!input) return;
    const s = { ...loadSecSettings(), autoDefense: input.autoDefense };
    try { saveSecSettings(s); }
    catch (error) { return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.security', function: 'saveSecSettings', logMessage: 'Security settings persistence failed' }); }
    res.json(s);
});

const INFECTION_KEYWORDS = ['MALWARE', 'TROJAN', 'BOTNET', 'CNC', ' C2 ', 'COINMINER', 'RANSOMWARE', 'BACKDOOR'];
const autoDefenseBlockState = createAutoDefenseBlockState({ cooldownMs: 10 * 60 * 1000, maxEntries: 2000 });

async function autoDefenseSweep() {
    if (!loadSecSettings().autoDefense) return;
    try {
        const sweepTimestamp = Date.now();
        sysLog('AutoDefense', '啟動自動防禦威脅日誌掃描...');
        const cookie = await getLocalSession();
        const alarm = await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { 'Cookie': cookie } });
        const recent = (alarm.data.data || []).filter(a =>
            isIpsAlarm(a) && isRecentAlarmTimestamp(a.datetime, sweepTimestamp));
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
            if (victim && autoDefenseBlockState.shouldBlock(victim.mac, sweepTimestamp)) {
                sysLog('AutoDefense', `⚠️ 偵測到重大感染威脅：設備 IP ${t.dest_ip} (${victim.mac}) 觸發「${t.msg}」，即將自動進行網絡物理隔離！`, true);
                await unifiClient.post('/proxy/network/api/s/default/cmd/stamgr', { cmd: 'block-sta', mac: victim.mac }, { headers: { 'Cookie': cookie } });
                autoDefenseBlockState.record(victim.mac, sweepTimestamp);
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
function capMap(map, max = 2000) {
    if (map.size <= max) return;
    const keep = [...map.entries()].slice(-Math.floor(max / 2));
    map.clear();
    keep.forEach(([key, value]) => map.set(key, value));
}

function notificationSecretValues() {
    return Object.entries(process.env)
        .filter(([key, value]) => /pass(word)?|api[_-]?key|token|authorization|cookie|session|secret|webhook|private[_-]?key/i.test(key)
            && typeof value === 'string' && value.length >= 4)
        .map(([, value]) => value);
}
function safeDockerLogExcerpt(value, max = 320) {
    return maskString(String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(), notificationSecretValues()).slice(0, max);
}
function dockerLogSeverity(line) {
    const text = String(line || '');
    if (/\b(fatal|panic|critical|oomkilled|out of memory|segmentation fault|unhandled (exception|rejection))\b/i.test(text)) return 'critical';
    if (/\b(error|err(or)?|exception|failed|failure|crash(?:ed)?)\b/i.test(text)) return 'error';
    return null;
}
function dockerLogFindings(raw, container, max = 8) {
    const id = container.id || container.name || 'unknown';
    return String(raw || '').split('\n').map(line => {
        const severity = dockerLogSeverity(line);
        if (!severity) return null;
        const excerpt = safeDockerLogExcerpt(line);
        return excerpt ? { id, name: container.name || id, severity, excerpt, fingerprint: `${id}:${severity}:${excerpt}` } : null;
    }).filter(Boolean).slice(-max);
}
async function readDockerLogFindings(containers, { lines = 120, maxContainers = 12, maxPerContainer = 8 } = {}) {
    if (!nasMonConfigured()) return [];
    const selected = containers.filter(c => c && c.id).slice(0, maxContainers);
    const results = selected.map(container => {
        const data = deviceCollectorSnapshot(`nasMonitor.dockerLog.${container.id}`)?.data;
        if (data === undefined) return [];
        const raw = typeof data === 'string' ? data : (data?.logs || JSON.stringify(data || ''));
        return dockerLogFindings(raw, container, maxPerContainer);
    });
    return results.flat();
}

async function warmDockerLogCaches(s, containers, { lines = 120, maxContainers = 12 } = {}) {
    if (!(s.triggerDockerCriticalLog !== false || s.triggerDockerErrorLog)) return;
    const selected = containers.filter(c => c && c.id).slice(0, maxContainers);
    await Promise.all(selected.map(container => readDeviceCollector(`nasMonitor.dockerLog.${container.id}`, () =>
        nasMonGet(`/api/docker/containers/${encodeURIComponent(container.id)}/logs`, { lines }), { refresh: true })
        .catch(error => logRecoverableFailure(`watcher.dockerLogs:${container.id}`, error, {
            module: 'watcher.notifications', function: 'sampleDockerLogs', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED,
            fields: { container: container.name || container.id }
        }))));
}

/* ===================== 通知推播中心 ===================== */
// 偵測到新威脅攔截或 NAS 嚴重警報時，推播到 Discord / Telegram / 通用 Webhook。
const NOTIF_FILE = path.join(DATA_DIR, 'notification-settings.json');
const NOTIF_DEFAULTS = {
    enabled: false, webPushEnabled: false, channel: 'discord', webhookUrl: '', botToken: '', chatId: '', telegramCommandsEnabled: false,
    triggerThreats: true, triggerNasAlerts: true, triggerWiimTemp: true, triggerUpsOutage: true, triggerUpsLowBatt: true,
    triggerNewClient: false, triggerClientIpChange: false, triggerClientWeakSignal: false, triggerClientConnectivity: false, clientSignalAlert: 75,
    triggerNetworkDeviceOffline: false, triggerWifiSsidChange: false, triggerUnifiUpgrade: false, triggerCloudOffline: false,
    triggerUnifiDeviceTemp: true, unifiDeviceTempAlert: 75,
    triggerWiimOffline: false, triggerWiimHighVolume: false, triggerWiimPlaybackChange: false, wiimVolumeAlert: 80, triggerBlockAction: true,
    triggerNasDiskTemp: false, nasDiskTempAlert: 50, triggerNasSpace: false, nasSpaceAlert: 85,
    triggerNasDiskHealth: true, triggerNasOffline: false,
    triggerNasHighCpu: false, nasCpuAlert: 90, triggerNasHighMemory: false, nasMemoryAlert: 90,
    triggerUcgTemp: false, ucgTempAlert: 75, triggerUcgHighCpu: false, ucgCpuAlert: 90, triggerUcgHighMemory: false, ucgMemoryAlert: 90, triggerUcgDisk: false, ucgDiskAlert: 85,
    triggerWanDown: false, triggerWanLatency: false, wanLatencyAlert: 100,
    triggerUnifiOffline: false, triggerNasLog: true, triggerNasSleepWake: false,
    triggerUpsHighLoad: false, upsLoadAlert: 80, triggerUpsLowRuntime: false, upsRuntimeAlertMin: 10, triggerUpsVoltAbnormal: false, upsVoltDeviationPct: 10, triggerUpsSag: true, upsSagThresholdV: DEFAULT_SAG_THRESHOLD_V, triggerUpsSourceChange: false, triggerUpsOffline: true,
    triggerAdgProtection: true, triggerAdgOffline: false, triggerAdgHighBlockRate: false, adgBlockRateAlert: 50,
    triggerLinuxTemp: true, linuxTempAlert: 70, triggerLinuxOffline: false, triggerLinuxDisk: false, linuxDiskAlert: 90, triggerLinuxHighCpu: false, linuxCpuAlert: 90, triggerLinuxHighMemory: false, linuxMemoryAlert: 90, triggerLinuxHighLoad: false, linuxLoadAlert: 4,
    triggerDockerCriticalLog: true, triggerDockerErrorLog: false, triggerDockerState: true, triggerDockerHealth: true, triggerDockerRestart: true, triggerDockerInventory: false, triggerDockerOom: true,
    triggerDockerHighCpu: false, dockerCpuAlert: 90, triggerDockerHighMemory: false, dockerMemoryAlert: 90,
    triggerSystemCritical: true, triggerSystemWarning: false, triggerSystemRecovery: true, triggerSystemStartup: false
};
// 記憶體快取：watcher 每輪呼叫多次，不需要每次讀檔
let notifSettingsCache = null;
function loadNotifSettings() {
    if (notifSettingsCache) return notifSettingsCache;
    try { notifSettingsCache = { ...NOTIF_DEFAULTS, ...readJsonObjectFile(NOTIF_FILE) }; }
    catch (error) {
        if (error.cause?.code !== 'ENOENT') logger.warning({
            module: 'config.notifications', function: 'loadNotifSettings', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'Notification settings could not be read; defaults are in use', error, fields: { file: path.basename(NOTIF_FILE) }
        });
        notifSettingsCache = { ...NOTIF_DEFAULTS };
    }
    return notifSettingsCache;
}
function saveNotifSettings(s) {
    try { writeJsonObjectAtomically(NOTIF_FILE, s); }
    catch (error) {
        if (error.committed) notifSettingsCache = s;
        throw error;
    }
    notifSettingsCache = s;
}

let notifLog = [];
function pushNotifLog(e) { notifLog.unshift(e); notifLog = notifLog.slice(0, 50); }

// 實際送出與分段/partial 語意集中在可注入、可故障測試的 integration module。
const dispatchNotification = createNotificationDispatcher({ httpClient: axios });

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

async function notify(title, body, options = {}) {
    const s = loadNotifSettings();
    if (!s.enabled) return { skipped: 'disabled' };
    sysLog('Notification', `發送推播通知：主題 "${title}"，頻道: ${s.channel}...`);
    try {
        const delivery = await dispatchNotificationFanout({
            dispatchPrimary: dispatchNotification,
            dispatchWebPush: (pushTitle, pushBody, pushOptions) => webPushService.send(pushTitle, pushBody, pushOptions),
            title,
            body,
            settings: s,
            options
        });
        if (delivery.primaryError) logger.warning({
            module: 'notification.dispatch', function: 'notify', code: ERROR_CODES.EXT_NOTIFICATION_FAILED,
            message: 'Primary notification channel failed; Web Push fallback succeeded',
            error: delivery.primaryError,
            fields: { channel: s.channel, title, fallback: 'web_push' }
        });
        if (delivery.webPush?.serviceError) logger.warning({
            module: 'notification.webPush', function: 'notify', code: ERROR_CODES.EXT_NOTIFICATION_FAILED,
            message: 'Web Push fanout service failed; primary notification result was preserved',
            error: delivery.webPush.serviceError,
            fields: { channel: s.channel, title }
        });
        pushNotifLog({
            ts: new Date().toISOString(), title, body, channel: s.channel, ok: true,
            ...(delivery.partial ? { partial: true } : {}),
            webPush: {
                sent: Number(delivery.webPush?.sent || 0),
                failed: Number(delivery.webPush?.failed || 0),
                expired: Number(delivery.webPush?.expired || 0),
                skipped: delivery.webPush?.skipped || null
            },
            ...(delivery.fallback ? { fallback: delivery.fallback } : {})
        });
        sysLog('Notification', '通知推送成功。');
        return {
            ok: true,
            ...(delivery.partial ? { partial: true } : {}),
            ...(delivery.fallback ? { fallback: delivery.fallback } : {}),
            webPush: {
                sent: Number(delivery.webPush?.sent || 0),
                failed: Number(delivery.webPush?.failed || 0),
                expired: Number(delivery.webPush?.expired || 0),
                skipped: delivery.webPush?.skipped || null
            }
        };
    } catch (e) {
        const partial = e instanceof PartialNotificationDeliveryError;
        logger.error({
            module: 'notification.dispatch', function: 'notify', code: ERROR_CODES.EXT_NOTIFICATION_FAILED,
            message: partial ? 'Notification delivery was only partially accepted' : 'Notification delivery failed',
            error: e,
            fields: {
                channel: s.channel,
                title,
                ...(partial ? { sent_parts: e.sentParts, total_parts: e.totalParts } : {})
            }
        });
        pushNotifLog({
            ts: new Date().toISOString(), title, body, channel: s.channel, ok: false,
            error: publicError(e), ...(partial ? { partial: true, sentParts: e.sentParts, totalParts: e.totalParts } : {})
        });
        return {
            ok: false,
            error: publicError(e),
            ...(partial ? {
                partial: true,
                deliveryAmbiguous: true,
                channel: e.channel,
                sentParts: e.sentParts,
                totalParts: e.totalParts
            } : {})
        };
    }
}

// GET：回傳設定但遮罩機密 (webhookUrl/botToken 不外洩，改回傳 *Set 布林旗標)
app.get('/api/notifications/settings', (req, res) => {
    const s = loadNotifSettings();
    res.json({
        enabled: s.enabled, webPushEnabled: !!s.webPushEnabled, channel: s.channel, chatId: s.chatId, telegramCommandsEnabled: !!s.telegramCommandsEnabled,
        triggerThreats: s.triggerThreats, triggerNasAlerts: s.triggerNasAlerts, triggerWiimTemp: s.triggerWiimTemp !== false,
        triggerUpsOutage: s.triggerUpsOutage !== false, triggerUpsLowBatt: s.triggerUpsLowBatt !== false,
        triggerNewClient: !!s.triggerNewClient, triggerClientIpChange: !!s.triggerClientIpChange, triggerClientWeakSignal: !!s.triggerClientWeakSignal, triggerClientConnectivity: !!s.triggerClientConnectivity, clientSignalAlert: s.clientSignalAlert ?? 75,
        triggerNetworkDeviceOffline: !!s.triggerNetworkDeviceOffline, triggerWifiSsidChange: !!s.triggerWifiSsidChange, triggerUnifiUpgrade: !!s.triggerUnifiUpgrade, triggerCloudOffline: !!s.triggerCloudOffline,
        triggerUnifiDeviceTemp: s.triggerUnifiDeviceTemp !== false, unifiDeviceTempAlert: s.unifiDeviceTempAlert ?? 75,
        triggerWiimOffline: !!s.triggerWiimOffline, triggerWiimHighVolume: !!s.triggerWiimHighVolume, triggerWiimPlaybackChange: !!s.triggerWiimPlaybackChange, wiimVolumeAlert: s.wiimVolumeAlert ?? 80, triggerBlockAction: s.triggerBlockAction !== false,
        triggerNasDiskTemp: !!s.triggerNasDiskTemp, nasDiskTempAlert: s.nasDiskTempAlert ?? 50,
        triggerNasSpace: !!s.triggerNasSpace, nasSpaceAlert: s.nasSpaceAlert ?? 85,
        triggerNasDiskHealth: s.triggerNasDiskHealth !== false, triggerNasOffline: !!s.triggerNasOffline,
        triggerNasHighCpu: !!s.triggerNasHighCpu, nasCpuAlert: s.nasCpuAlert ?? 90, triggerNasHighMemory: !!s.triggerNasHighMemory, nasMemoryAlert: s.nasMemoryAlert ?? 90,
        triggerUcgTemp: !!s.triggerUcgTemp, ucgTempAlert: s.ucgTempAlert ?? 75,
        triggerUcgHighCpu: !!s.triggerUcgHighCpu, ucgCpuAlert: s.ucgCpuAlert ?? 90, triggerUcgHighMemory: !!s.triggerUcgHighMemory, ucgMemoryAlert: s.ucgMemoryAlert ?? 90, triggerUcgDisk: !!s.triggerUcgDisk, ucgDiskAlert: s.ucgDiskAlert ?? 85,
        triggerWanDown: !!s.triggerWanDown, triggerWanLatency: !!s.triggerWanLatency, wanLatencyAlert: s.wanLatencyAlert ?? 100, triggerUnifiOffline: !!s.triggerUnifiOffline, triggerNasLog: !!s.triggerNasLog, triggerNasSleepWake: !!s.triggerNasSleepWake,
        triggerUpsHighLoad: !!s.triggerUpsHighLoad, upsLoadAlert: s.upsLoadAlert ?? 80, triggerUpsLowRuntime: !!s.triggerUpsLowRuntime, upsRuntimeAlertMin: s.upsRuntimeAlertMin ?? 10, triggerUpsVoltAbnormal: !!s.triggerUpsVoltAbnormal, upsVoltDeviationPct: s.upsVoltDeviationPct ?? 10, triggerUpsSag: s.triggerUpsSag !== false, upsSagThresholdV: s.upsSagThresholdV ?? DEFAULT_SAG_THRESHOLD_V, triggerUpsSourceChange: !!s.triggerUpsSourceChange, triggerUpsOffline: s.triggerUpsOffline !== false,
        triggerAdgProtection: s.triggerAdgProtection !== false, triggerAdgOffline: !!s.triggerAdgOffline, triggerAdgHighBlockRate: !!s.triggerAdgHighBlockRate, adgBlockRateAlert: s.adgBlockRateAlert ?? 50,
        triggerLinuxTemp: s.triggerLinuxTemp !== false, linuxTempAlert: s.linuxTempAlert ?? 70,
        triggerLinuxOffline: !!s.triggerLinuxOffline, triggerLinuxDisk: !!s.triggerLinuxDisk, linuxDiskAlert: s.linuxDiskAlert ?? 90, triggerLinuxHighCpu: !!s.triggerLinuxHighCpu, linuxCpuAlert: s.linuxCpuAlert ?? 90, triggerLinuxHighMemory: !!s.triggerLinuxHighMemory, linuxMemoryAlert: s.linuxMemoryAlert ?? 90, triggerLinuxHighLoad: !!s.triggerLinuxHighLoad, linuxLoadAlert: s.linuxLoadAlert ?? 4,
        triggerDockerCriticalLog: s.triggerDockerCriticalLog !== false, triggerDockerErrorLog: !!s.triggerDockerErrorLog, triggerDockerState: s.triggerDockerState !== false, triggerDockerHealth: s.triggerDockerHealth !== false, triggerDockerRestart: s.triggerDockerRestart !== false, triggerDockerInventory: !!s.triggerDockerInventory, triggerDockerOom: s.triggerDockerOom !== false,
        triggerDockerHighCpu: !!s.triggerDockerHighCpu, dockerCpuAlert: s.dockerCpuAlert ?? 90,
        triggerDockerHighMemory: !!s.triggerDockerHighMemory, dockerMemoryAlert: s.dockerMemoryAlert ?? 90,
        triggerSystemCritical: s.triggerSystemCritical !== false, triggerSystemWarning: !!s.triggerSystemWarning, triggerSystemRecovery: s.triggerSystemRecovery !== false, triggerSystemStartup: !!s.triggerSystemStartup,
        webhookUrlSet: !!s.webhookUrl, botTokenSet: !!s.botToken
    });
});

// POST：合併更新。機密欄位留空 = 保留原值 (避免遮罩後被清空)
app.post('/api/notifications/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseNotificationSettings(req.body), {
        module: 'api.notifications', function: 'saveNotifSettings'
    });
    if (!input) return;
    const s = { ...loadNotifSettings(), ...input };
    try { saveNotifSettings(s); }
    catch (error) { return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.notifications', function: 'saveNotifSettings', logMessage: 'Notification settings persistence failed' }); }
    res.json({ ok: true });
});

// 測試推播
app.post('/api/notifications/test', async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body), {
        module: 'api.notifications', function: 'testNotification'
    });
    if (!input) return;
    const r = await notify('🔔 SmartHub 測試通知', `這是一則測試訊息，發送時間 ${new Date().toLocaleString('zh-TW')}`);
    res.json(r);
});

// 近期推播紀錄
app.get('/api/notifications/log', (req, res) => res.json({ log: notifLog }));

registerWebPushRoutes(app, {
    requireAdmin: panelSecurity.requireAdmin,
    getState: () => ({ ...webPushService.snapshot(), enabled: !!loadNotifSettings().webPushEnabled }),
    subscribe: input => webPushService.subscribe(input),
    unsubscribe: endpoint => webPushService.unsubscribe(endpoint),
    onValidationError: (error, { operation, res }) => apiError(res, error, {
        status: error.httpStatus || 400,
        code: ERROR_CODES.API_VALIDATION_FAILED,
        publicMessage: error.message,
        module: 'api.webPush', function: operation, logMessage: `Web Push ${operation} validation failed`,
        fields: error.field ? { field: error.field } : undefined
    }),
    onOperationError: (error, { operation, res }) => {
        const expected = error instanceof WebPushServiceError;
        return apiError(res, error, {
            status: expected ? error.httpStatus : operation === 'unsubscribe' ? 400 : 500,
            code: expected ? ERROR_CODES.SYS_CONFIG_INVALID : ERROR_CODES.API_INTERNAL_ERROR,
            publicMessage: expected ? error.message : `Web Push ${operation} failed`,
            module: 'api.webPush', function: operation, logMessage: `Web Push ${operation} failed`
        });
    }
});

// 監看器：偵測新威脅 (ips:alert) 與 NAS 嚴重警報，推播並去重
const notifiedThreatIds = new Set();
const notifiedNasAlertIds = new Set();
let notifBootstrapped = false;

async function scanSystemIssueNotifications(s) {
    if (!s.triggerSystemCritical && !s.triggerSystemWarning && !s.triggerSystemRecovery) return;
    let status;
    try { status = await systemMonitor.ensureSample(); }
    catch (error) {
        logRecoverableFailure('watcher.systemDiagnostics', error, { module: 'watcher.notifications', function: 'scanSystemIssues', code: ERROR_CODES.SYS_MONITOR_FAILED });
        return;
    }
    const current = new Map((status.active_issues || []).map(issue => [issue.id || issue.code || issue.message, issue]));
    const nextKnown = new Map();
    const firstBaseline = !systemIssueWatcherBootstrapped;
    for (const [id, issue] of current) {
        const previousState = knownSystemIssues.get(id);
        const previous = previousState?.issue;
        let notified = previousState?.notified || false;
        const isCritical = issue.severity === 'critical';
        const enabled = isCritical ? s.triggerSystemCritical : s.triggerSystemWarning;
        if (!firstBaseline && notifBootstrapped && enabled && (!previous || previous.severity !== issue.severity)) {
            const emoji = isCritical ? '🚨' : '⚠️';
            await notify(`${emoji} SmartHub 系統${isCritical ? '嚴重' : '警告'}事件`, `${issue.code || 'SYSTEM'}\n${issue.message || '系統診斷偵測到異常'}\n發生次數 ${issue.occurrences || 1}`);
            notified = true;
        }
        nextKnown.set(id, { issue, notified });
    }
    if (!firstBaseline && notifBootstrapped && s.triggerSystemRecovery) {
        for (const [id, state] of knownSystemIssues) {
            if (!current.has(id) && state.notified) await notify('✅ SmartHub 系統事件已恢復', `${state.issue.code || 'SYSTEM'}\n${state.issue.message || '先前的診斷異常已解除'}`);
        }
    }
    knownSystemIssues.clear();
    nextKnown.forEach((state, id) => knownSystemIssues.set(id, state));
    systemIssueWatcherBootstrapped = true;
}

async function scanDockerNotifications(s) {
    const usesDockerMonitor = s.triggerDockerCriticalLog !== false || s.triggerDockerErrorLog || s.triggerDockerState !== false || s.triggerDockerHealth !== false || s.triggerDockerRestart !== false || s.triggerDockerInventory || s.triggerDockerOom !== false || s.triggerDockerHighCpu || s.triggerDockerHighMemory;
    if (!usesDockerMonitor || !nasMonConfigured()) return;
    const snapshot = deviceCollectorSnapshot('nasMonitor.dockerContainers');
    if (!snapshot?.data) return;
    if (snapshot.lastErrorAt) {
        logRecoverableFailure('watcher.dockerContainers', snapshot.lastError, { module: 'watcher.notifications', function: 'scanDocker', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        return;
    }
    const containers = Array.isArray(snapshot.data) ? snapshot.data : (snapshot.data.containers || snapshot.data.data || []);
    const firstBaseline = !dockerWatcherBootstrapped;
    const currentIds = new Set();
    for (const container of containers) {
        const id = container.id || container.name;
        if (!id) continue;
        currentIds.add(id);
        const state = String(container.state || 'unknown').toLowerCase();
        const health = String(container.health || (/\b(unhealthy|healthy|starting)\b/i.exec(String(container.status || '')) || [])[1] || 'unknown').toLowerCase();
        const restartCount = Math.max(0, Number(container.restart_count ?? container.restartCount ?? 0) || 0);
        const oomKilled = container.oom_killed === true || container.OOMKilled === true || /\boomkilled\b|out of memory/i.test(String(container.status || ''));
        const previous = dockerContainerStates.get(id);
        if (!firstBaseline && notifBootstrapped && s.triggerDockerInventory && !previous) {
            await notify('➕ Docker 新容器出現', `${container.name || id}\n狀態 ${state} · ${container.image || 'image unknown'}`);
        }
        if (!firstBaseline && notifBootstrapped && s.triggerDockerState !== false && previous && previous.state !== state) {
            const recovered = state === 'running';
            await notify(recovered ? '✅ Docker 容器已恢復運行' : '🐳 Docker 容器狀態異常', `${container.name || id}\n${previous.state} → ${state}\n${container.status || ''}`.trim());
        }
        if (!firstBaseline && notifBootstrapped && s.triggerDockerHealth !== false && previous && previous.health !== health) {
            const recovered = health === 'healthy';
            await notify(recovered ? '✅ Docker 容器健康檢查恢復' : '⚠️ Docker 容器健康檢查異常', `${container.name || id}\n${previous.health} → ${health}\n${container.status || ''}`.trim());
        }
        if (!firstBaseline && notifBootstrapped && s.triggerDockerRestart !== false && previous && restartCount > previous.restartCount) {
            await notify('🔄 Docker 容器重新啟動', `${container.name || id}\n重新啟動次數 ${previous.restartCount} → ${restartCount}\n${container.status || ''}`.trim());
        }
        if (!firstBaseline && notifBootstrapped && s.triggerDockerOom !== false && oomKilled && !previous?.oomKilled) {
            await notify('💥 Docker 容器發生 OOM', `${container.name || id}\n容器因記憶體不足被系統終止，請檢查 memory limit 與使用量`);
        }
        dockerContainerStates.set(id, { name: container.name || id, state, health, restartCount, oomKilled, status: container.status || '' });

        const cpu = Number(container.cpu_percent);
        const memUsage = Number(container.mem_usage_mb);
        const memLimit = Number(container.mem_limit_mb);
        const memPercent = memLimit > 0 && Number.isFinite(memUsage) ? memUsage / memLimit * 100 : null;
        const metricChecks = [
            { enabled: s.triggerDockerHighCpu, value: cpu, threshold: s.dockerCpuAlert ?? 90, key: 'cpu', label: 'CPU', unit: '%' },
            { enabled: s.triggerDockerHighMemory, value: memPercent, threshold: s.dockerMemoryAlert ?? 90, key: 'memory', label: '記憶體', unit: '%' }
        ];
        for (const metric of metricChecks) {
            if (!metric.enabled || !Number.isFinite(metric.value) || metric.value < metric.threshold) continue;
            const last = dockerMetricAlertState.get(metric.key, id) || 0;
            if (firstBaseline || !notifBootstrapped || Date.now() - last <= 30 * 60 * 1000) continue;
            dockerMetricAlertState.record(metric.key, id, Date.now());
            await notify('🐳 Docker 容器資源過高', `${container.name || id}\n${metric.label} ${metric.value.toFixed(1)}${metric.unit} (門檻 ${metric.threshold}${metric.unit})`);
        }
    }
    if (!firstBaseline && notifBootstrapped) {
        for (const [id, previous] of dockerContainerStates) {
            if (currentIds.has(id)) continue;
            if (s.triggerDockerInventory) await notify('➖ Docker 容器已移除', `${previous.name || id}\n先前狀態 ${previous.state || 'unknown'}`);
            dockerContainerStates.delete(id);
            dockerMetricAlertState.removeContainer(id);
            recoverableFailures.remove(`watcher.dockerLogs:${id}`);
        }
    }

    const dockerLogScanGap = Math.max(Number(appSettings.watcherSec) || 20, 30) * 1000;
    if ((s.triggerDockerCriticalLog !== false || s.triggerDockerErrorLog) && Date.now() - lastDockerLogScanTs >= dockerLogScanGap) {
        lastDockerLogScanTs = Date.now();
        const findings = await readDockerLogFindings(containers);
        for (const finding of findings) {
            if (notifiedDockerLogFingerprints.has(finding.fingerprint)) continue;
            notifiedDockerLogFingerprints.add(finding.fingerprint);
            const enabled = finding.severity === 'critical' ? s.triggerDockerCriticalLog !== false : s.triggerDockerErrorLog;
            if (!firstBaseline && notifBootstrapped && enabled) {
                const emoji = finding.severity === 'critical' ? '🚨' : '❌';
                await notify(`${emoji} Docker ${finding.severity === 'critical' ? '嚴重' : '錯誤'}日誌`, `[${finding.name}]\n${finding.excerpt}`);
            }
        }
    }
    capSet(notifiedDockerLogFingerprints, 5000);
    dockerWatcherBootstrapped = true;
}

async function notificationWatcher() {
    refreshPublicSystemHealthSnapshot();
    const s = loadNotifSettings();
    if (!s.enabled) return;
    await scanSystemIssueNotifications(s);
    // 新威脅
    if (s.triggerThreats) {
        try {
            const alerts = (await getUnifiThreatsCached({ allowStale: true })).filter(isIpsAlarm);
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
    // UniFi 本地控制器離線 / 恢復 (只在使用者開啟時額外做驗證，避免增加預設輪詢成本)
    if (s.triggerUnifiOffline) {
        const snapshot = deviceCollectorSnapshot('unifi.health');
        const ok = Boolean(snapshot?.data?.ok) && !snapshot?.lastErrorAt;
        if (unifiWasOnline !== null && ok !== unifiWasOnline && notifBootstrapped) {
            await notify(ok ? '✅ UniFi 控制器已恢復連線' : '🌐 UniFi 控制器失去連線', ok ? '本地控制器登入驗證恢復正常' : '無法向本地控制器建立登入 Session，請檢查控制器、網路與帳密');
        }
        unifiWasOnline = ok;
    }
    // UniFi 管理裝置（AP / Switch / Gateway）離線與恢復；首輪建立基準不推送既有狀態。
    if (s.triggerNetworkDeviceOffline || s.triggerUnifiUpgrade) {
        try {
            const data = await getUnifiNetworkDevicesCached({ allowStale: true });
            for (const device of data) {
                const id = device.mac || device._id;
                if (!id) continue;
                const online = device.state === 1 || device.state === '1' || String(device.state).toLowerCase() === 'connected';
                const previous = networkDeviceStates.get(id);
                if (notifBootstrapped && s.triggerNetworkDeviceOffline && previous && previous.online !== online) {
                    const name = device.name || device.model || id;
                    await notify(online ? '✅ UniFi 網路設備已恢復' : '📡 UniFi 網路設備離線', `${name}\n${previous.online ? '在線' : '離線'} → ${online ? '在線' : '離線'} · ${device.model || device.type || 'UniFi device'}`);
                }
                if (notifBootstrapped && s.triggerUnifiUpgrade && device.upgradable
                    && Date.now() - (unifiUpgradeAlertTs.get(id) || 0) > 24 * 60 * 60 * 1000) {
                    unifiUpgradeAlertTs.set(id, Date.now());
                    await notify('⬆️ UniFi 裝置有韌體可更新', `${device.name || device.model || id}\n目前 ${device.version || '未知版本'} · 型號 ${device.model || device.type || '--'}`);
                }
                networkDeviceStates.set(id, { online, name: device.name || device.model || id });
            }
        } catch (error) {
            logRecoverableFailure('watcher.networkDevices', error, { module: 'watcher.notifications', function: 'checkNetworkDeviceStates', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // Controller 或設備 SSH 的新鮮真實溫度才會參與狀態機；stale/null/SSH 失敗一律不計數。
    if (s.triggerUnifiDeviceTemp !== false) {
        try {
            const telemetry = await getUnifiDeviceTelemetryCached();
            const threshold = s.unifiDeviceTempAlert ?? 75;
            for (const device of telemetry.devices) {
                const action = unifiDeviceTemperatureAlertState.evaluate(device, { threshold });
                if (!action) continue;
                if (action.type === 'recovered') {
                    await notify(`✅ ${device.name} 溫度已恢復`, temperatureNotificationText(device, action));
                } else {
                    await notify(`${action.type === 'critical' ? '🚨' : '🔥'} ${device.name} 內部溫度過高`,
                        temperatureNotificationText(device, action));
                }
            }
        } catch (error) {
            logRecoverableFailure('watcher.unifiDeviceTelemetry', error, {
                module: 'watcher.notifications', function: 'checkUnifiDeviceTemperature', code: ERROR_CODES.EXT_UNIFI_FAILED
            });
        }
    }
    // WiFi SSID 啟用狀態變更；使用設定本身的 stable id 作為去重基準。
    if (s.triggerWifiSsidChange) {
        try {
            const data = await getUnifiWifiNetworksCached({ allowStale: true });
            for (const wlan of data) {
                const id = wlan._id || wlan.name;
                if (!id) continue;
                const enabled = wlan.enabled !== false;
                const previous = wifiSsidStates.get(id);
                if (notifBootstrapped && previous && previous.enabled !== enabled) {
                    await notify(enabled ? '✅ WiFi SSID 已啟用' : '📴 WiFi SSID 已停用', `${wlan.name || id}\n${previous.enabled ? '啟用' : '停用'} → ${enabled ? '啟用' : '停用'}`);
                }
                wifiSsidStates.set(id, { enabled, name: wlan.name || id });
            }
        } catch (error) {
            logRecoverableFailure('watcher.wifiSsids', error, { module: 'watcher.notifications', function: 'checkWifiSsidStates', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // Site Manager Cloud 離線 / 恢復；checkCloudStatus 已有 60 秒節流。
    if (s.triggerCloudOffline) {
        try {
            const snapshot = deviceCollectorSnapshot('cloud.health');
            const status = snapshot?.data;
            const cloud = { configured: cloudConfigured(), ok: !snapshot?.lastErrorAt && status?.ok === true, detail: status?.ok ? '連線正常' : '連線失敗 (API Key 無效或被限流)' };
            if (cloud.configured && cloudLastOnline !== null && cloud.ok !== cloudLastOnline && notifBootstrapped) {
                await notify(cloud.ok ? '☁️ Site Manager 已恢復連線' : '☁️ Site Manager 連線失敗', cloud.detail || (cloud.ok ? '雲端 API 回應正常' : '請檢查 API Key 與外網連線'));
            }
            if (cloud.configured && cloud.ok !== null) cloudLastOnline = cloud.ok;
        } catch (error) {
            logRecoverableFailure('watcher.cloud', error, { module: 'watcher.notifications', function: 'checkCloudOnline', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // NAS 嚴重警報
    if (s.triggerNasAlerts && nasMonAdvancedConfigured()) {
        try {
            const data = await getNasMonitorCached('alerts24h', '/api/alerts/events', { hours: 24 }, { allowStale: true });
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
    // NAS 原生 API 離線 / 恢復
    if (s.triggerNasOffline && nasConfigured()) {
        const snapshot = deviceCollectorSnapshot('nas.common');
        const ok = snapshot?.data !== undefined && !snapshot.lastErrorAt;
        if (nasWasOnline !== null && ok !== nasWasOnline && notifBootstrapped) {
            await notify(ok ? '✅ NAS 已恢復連線' : '💾 NAS 失去連線', ok ? 'UGOS Pro API 恢復回應' : 'NAS 原生 API 無回應，請檢查 NAS、網路與帳密');
        }
        nasWasOnline = ok;
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
    // 新設備加入網路：只在 UniFi 已配發 IP 後通知，避免收到「取得中」且錯過後續 IP。
    if (s.triggerNewClient || s.triggerClientIpChange || s.triggerClientWeakSignal || s.triggerClientConnectivity) {
        try {
            const sta = await getUnifiClientsCached({ allowStale: true });
            const seenClients = new Set();
            for (const c of sta) {
                if (!c.mac) continue;
                seenClients.add(c.mac);
                const ip = String(c.ip || '').trim();
                const rssi = Number(c.rssi);
                const presence = clientPresenceStates.get(c.mac);
                if (s.triggerClientConnectivity && notifBootstrapped && presence && presence.online === false) {
                    await notify('✅ 網路設備已重新連線', `${c.name || c.hostname || c.mac}\nIP ${ip || '尚未取得'} · ${c.is_wired ? '有線' : 'WiFi'}`);
                }
                clientPresenceStates.set(c.mac, { online: true, misses: 0, name: c.name || c.hostname || c.mac, ip });
                if (s.triggerClientWeakSignal && !c.is_wired && Number.isFinite(rssi) && rssi <= -(s.clientSignalAlert ?? 75)
                    && Date.now() - (clientSignalAlertTs.get(c.mac) || 0) > 30 * 60 * 1000) {
                    clientSignalAlertTs.set(c.mac, Date.now());
                    await notify('📶 WiFi 設備訊號過弱', `${c.name || c.hostname || c.mac}\nRSSI ${rssi} dBm (門檻 -${s.clientSignalAlert ?? 75} dBm) · IP ${ip || '尚未取得'}`);
                }
                // 首輪只建立既有設備基準；後續的新設備則等待 DHCP/UniFi 回報有效 IP。
                if (!notifBootstrapped) {
                    knownClientMacs.add(c.mac);
                    if (ip && ip !== '0.0.0.0') clientIpByMac.set(c.mac, ip);
                    continue;
                }
                if (knownClientMacs.has(c.mac)) {
                    const previousIp = clientIpByMac.get(c.mac);
                    if (s.triggerClientIpChange && ip && ip !== '0.0.0.0' && previousIp && previousIp !== ip) {
                        await notify('🔁 網路設備 IP 已變更', `${c.name || c.hostname || c.mac}\n${previousIp} → ${ip} · ${c.is_wired ? '有線' : 'WiFi'}`);
                    }
                    if (ip && ip !== '0.0.0.0') clientIpByMac.set(c.mac, ip);
                    continue;
                }
                if (!ip || ip === '0.0.0.0') continue;
                knownClientMacs.add(c.mac);
                clientIpByMac.set(c.mac, ip);
                if (s.triggerNewClient) await notify('📱 新設備連上網路', `${c.name || c.hostname || c.mac}\nIP ${ip} · ${c.is_wired ? '有線' : 'WiFi'}`);
            }
            if (s.triggerClientConnectivity) {
                for (const [mac, presence] of clientPresenceStates) {
                    if (seenClients.has(mac) || presence.online === false) continue;
                    presence.misses = Number(presence.misses || 0) + 1;
                    if (presence.misses < 2) continue; // 連續兩輪缺席才視為離線，避免單次漏報造成誤警報
                    presence.online = false;
                    if (notifBootstrapped) await notify('📴 網路設備已離線', `${presence.name || mac}\n最後 IP ${presence.ip || '--'} · 連續兩次未出現在 UniFi 活躍客戶端清單`);
                }
            }
        } catch (error) {
            logRecoverableFailure('watcher.newClients', error, { module: 'watcher.notifications', function: 'scanNewClients', code: ERROR_CODES.EXT_UNIFI_FAILED });
        }
    }
    // WiiM 離線/恢復 (轉態才通知)
    if (s.triggerWiimOffline) {
        let ok = false;
        try { ok = !!(await wiimGet('getStatusEx', { allowStale: true })); }
        catch (error) {
            ok = false;
            logRecoverableFailure('watcher.wiimOffline', error, { module: 'watcher.notifications', function: 'checkWiimOnline', code: ERROR_CODES.EXT_WIIM_FAILED });
        }
        if (wiimWasOnline !== null && ok !== wiimWasOnline && notifBootstrapped) {
            await notify(ok ? '🔊 WiiM 已恢復連線' : '🔇 WiiM 失去連線', `裝置 IP ${wiimIP}`);
        }
        wiimWasOnline = ok;
    }
    if (s.triggerWiimHighVolume || s.triggerWiimPlaybackChange) {
        try {
            const raw = await wiimGet('getPlayerStatus', { allowStale: true });
            const status = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
            const volume = Number(status.vol);
            if (status.status === 'play' && Number.isFinite(volume) && volume >= (s.wiimVolumeAlert ?? 80)
                && Date.now() - lastWiimVolumeTs > 30 * 60 * 1000) {
                lastWiimVolumeTs = Date.now();
                await notify('🔊 WiiM 音量過高', `播放中音量 ${volume}% (門檻 ${s.wiimVolumeAlert ?? 80}%)`);
            }
            const playback = { status: String(status.status || 'unknown'), mode: String(status.mode || '') };
            if (s.triggerWiimPlaybackChange && wiimPlaybackState && notifBootstrapped
                && (playback.status !== wiimPlaybackState.status || playback.mode !== wiimPlaybackState.mode)) {
                const stateLabels = { play: '開始播放', pause: '暫停播放', stop: '停止播放', loading: '載入中' };
                const modeLabels = { '1': 'AirPlay', '2': 'DLNA', '10': 'WiFi 串流', '11': 'USB', '31': 'Spotify Connect', '32': 'TIDAL Connect', '40': 'Line-In', '41': '藍牙', '43': '光纖', '47': 'Line-In 2', '51': '同軸' };
                await notify('🎵 WiiM 播放狀態變更', `${stateLabels[playback.status] || playback.status}\n訊源 ${modeLabels[playback.mode] || playback.mode || '未知'} · 音量 ${Number.isFinite(volume) ? volume + '%' : '--'}`);
            }
            wiimPlaybackState = playback;
        } catch (error) {
            logRecoverableFailure('watcher.wiimVolume', error, { module: 'watcher.notifications', function: 'checkWiimVolume', code: ERROR_CODES.EXT_WIIM_FAILED });
        }
    }
    // NAS 硬碟溫度 / 健康 / 儲存空間門檻 (溫度 30 分鐘、健康 6 小時冷卻)
    if ((s.triggerNasDiskTemp || s.triggerNasDiskHealth !== false || s.triggerNasSpace) && nasConfigured()) {
        try {
            if ((s.triggerNasDiskTemp && Date.now() - lastNasDiskTempTs > 30 * 60 * 1000)
                || (s.triggerNasDiskHealth !== false && Date.now() - lastNasDiskHealthCheckTs > 10 * 60 * 1000)) {
                const data = await getNasApiCached('disks', '/ugreen/v1/storage/disk/list', { start: 0, size: 50 }, { allowStale: true });
                const disks = deepFind({ d: data }, ['result', 'list', 'disks']) || [];
                lastNasDiskHealthCheckTs = Date.now();
                const hot = s.triggerNasDiskTemp ? disks.filter(d => d.temperature != null && d.temperature >= (s.nasDiskTempAlert ?? 50)) : [];
                if (hot.length && Date.now() - lastNasDiskTempTs > 30 * 60 * 1000) {
                    lastNasDiskTempTs = Date.now();
                    await notify('🌡️ NAS 硬碟溫度警報', hot.map(d => `${d.label || d.name} ${d.temperature}°C (門檻 ${s.nasDiskTempAlert ?? 50}°C)`).join('\n'));
                }
                const bad = s.triggerNasDiskHealth !== false ? disks.filter(d => d.status != null && !['1', 'healthy', 'normal', 'ok'].includes(String(d.status).toLowerCase())) : [];
                if (bad.length && Date.now() - lastNasDiskHealthAlertTs > 6 * 60 * 60 * 1000) {
                    lastNasDiskHealthAlertTs = Date.now();
                    await notify('🚨 NAS 硬碟健康異常', bad.map(d => `${d.label || d.name}：${d.status}`).join('\n'));
                }
            }
            if (s.triggerNasSpace && Date.now() - lastNasSpaceTs > 6 * 60 * 60 * 1000) {
                const data = await getNasApiCached('volumes', '/ugreen/v1/storage/volume/list', { start: 0, size: 50 }, { allowStale: true });
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
    // NAS 系統日誌；可只訂閱硬碟休眠/喚醒，或訂閱其餘所有事件。
    if ((s.triggerNasLog || s.triggerNasSleepWake) && nasConfigured()) {
        try {
            const data = await getNasApiCached('logs', '/ugreen/v1/log/query', { visualizer: false, page: 0, size: 50, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' }, { allowStale: true });
            const logs = data.log_list || [];
            if (s.triggerNasSleepWake) {
                const sleepLogs = logs.filter(log => /sleeping/i.test(String(log.content || '')));
                for (const log of sleepLogs) {
                    const id = log.id || log.log_id || `${log.create_time}:${log.content}`;
                    if (notifiedNasSleepWakeIds.has(id)) continue;
                    notifiedNasSleepWakeIds.add(id);
                    if (!notifBootstrapped) continue;
                    const drive = (String(log.content || '').match(/Hard Drive (\d+)/i) || [])[1];
                    const woke = /stopped/i.test(String(log.content || ''));
                    await notify(woke ? '💽 NAS 硬碟已喚醒' : '💤 NAS 硬碟進入休眠', `硬碟${drive || '?'}\n${new Date(Number(log.create_time) * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
                }
            }
            // NAS 事件一旦進入 SmartHub 就立即呼叫手機推播，不經過歷史資料的記憶體緩衝。
            if (s.triggerNasLog) {
                await forwardNasLogs(s.triggerNasSleepWake ? logs.filter(log => !/sleeping/i.test(String(log.content || ''))) : logs, {
                    knownIds: notifiedNasLogIds,
                    bootstrapped: notifBootstrapped,
                    notify
                });
            }
        } catch (error) {
            logRecoverableFailure('watcher.nasLogs', error, { module: 'watcher.notifications', function: 'scanNasLogs', code: ERROR_CODES.EXT_NAS_FAILED });
        }
    }
    // NAS CPU / 記憶體：與 NAS 面板相同資料源，每 30 分鐘最多各通知一次。
    if ((s.triggerNasHighCpu || s.triggerNasHighMemory) && nasConfigured()) {
        try {
            const raw = await getNasStatsCached({ allowStale: true });
            const cpu = Number(raw?.cpu?.series?.[0]?.used_percent);
            const memory = Number(raw?.mem?.series?.[0]?.used_percent);
            if (s.triggerNasHighCpu && Number.isFinite(cpu) && cpu >= (s.nasCpuAlert ?? 90) && Date.now() - lastNasCpuTs > 30 * 60 * 1000) {
                lastNasCpuTs = Date.now();
                await notify('🖥️ NAS CPU 使用率過高', `CPU ${cpu.toFixed(1)}% (門檻 ${s.nasCpuAlert ?? 90}%)`);
            }
            if (s.triggerNasHighMemory && Number.isFinite(memory) && memory >= (s.nasMemoryAlert ?? 90) && Date.now() - lastNasMemoryTs > 30 * 60 * 1000) {
                lastNasMemoryTs = Date.now();
                await notify('🧠 NAS 記憶體使用率過高', `記憶體 ${memory.toFixed(1)}% (門檻 ${s.nasMemoryAlert ?? 90}%)`);
            }
        } catch (error) {
            logRecoverableFailure('watcher.nasResources', error, { module: 'watcher.notifications', function: 'checkNasResources', code: ERROR_CODES.EXT_NAS_FAILED });
        }
    }
    // UCG CPU 溫度 / 使用率 / WAN 斷線 (透過本機 /api/hardware，僅在開啟時才發起 SSH)
    if ((s.triggerUcgTemp || s.triggerUcgHighCpu || s.triggerUcgHighMemory || s.triggerUcgDisk || s.triggerWanDown) && !isPlaceholder(process.env.SSH_PASSWORD)) {
        try {
            const hw = await getHardwareCached({ allowStale: true });
            if (s.triggerUcgTemp && hw.cpuTemp != null && hw.cpuTemp >= (s.ucgTempAlert ?? 75)
                && Date.now() - lastUcgTempTs > 30 * 60 * 1000) {
                lastUcgTempTs = Date.now();
                await notify('🔥 UCG-Ultra 溫度警報', `CPU ${hw.cpuTemp}°C (門檻 ${s.ucgTempAlert ?? 75}°C)`);
            }
            const ucgCpuThreshold = s.ucgCpuAlert ?? 90;
            if (s.triggerUcgHighCpu && hw.cpuUsage != null && hw.cpuUsage >= ucgCpuThreshold) {
                ucgCpuHighSamples += 1;
            } else {
                // 只要一次取樣回到門檻以下，就重新累計，避免短暫尖峰觸發告警。
                ucgCpuHighSamples = 0;
            }
            if (ucgCpuHighSamples >= UCG_CPU_ALERT_SAMPLES
                && Date.now() - lastUcgCpuTs > 30 * 60 * 1000) {
                lastUcgCpuTs = Date.now();
                await notify('🖥️ UCG-Ultra CPU 使用率過高', `CPU ${hw.cpuUsage}% (連續 ${ucgCpuHighSamples} 次，門檻 ${ucgCpuThreshold}%)`);
            }
            if (s.triggerUcgHighMemory && hw.memUsagePct != null && hw.memUsagePct >= (s.ucgMemoryAlert ?? 90)
                && Date.now() - lastUcgMemoryTs > 30 * 60 * 1000) {
                lastUcgMemoryTs = Date.now();
                await notify('🧠 UCG-Ultra 記憶體使用率過高', `記憶體 ${hw.memUsagePct}% (門檻 ${s.ucgMemoryAlert ?? 90}%)`);
            }
            if (s.triggerUcgDisk && hw.emmcUsagePct != null && hw.emmcUsagePct >= (s.ucgDiskAlert ?? 85)
                && Date.now() - lastUcgDiskTs > 6 * 60 * 60 * 1000) {
                lastUcgDiskTs = Date.now();
                await notify('💾 UCG-Ultra 系統碟空間警報', `eMMC 已用 ${hw.emmcUsagePct}% (門檻 ${s.ucgDiskAlert ?? 85}%)`);
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
    if (s.triggerWanLatency) {
        const latestTrend = historyDb.getLatest('trend');
        const latency = Number(latestTrend?.latency);
        if (Number.isFinite(latency) && latency >= (s.wanLatencyAlert ?? 100)
            && Date.now() - lastWanLatencyTs > 30 * 60 * 1000) {
            lastWanLatencyTs = Date.now();
            await notify('🐢 WAN 延遲過高', `目前平均延遲 ${latency.toFixed(1)} ms (門檻 ${s.wanLatencyAlert ?? 100} ms)`);
        }
    }
    // AdGuard：保護被暫停 / 失聯 (轉態通知)
    if ((s.triggerAdgProtection !== false || s.triggerAdgOffline || s.triggerAdgHighBlockRate) && adgConfigured()) {
        let on = null;
        const adguardSnapshot = deviceCollectorSnapshot('adguard.overview');
        try { on = adguardSnapshot?.lastErrorAt ? null : !!adguardSnapshot?.data?.status?.protection_enabled; }
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
        if (s.triggerAdgHighBlockRate && on !== null && Date.now() - lastAdgBlockRateTs > 30 * 60 * 1000) {
            try {
                const stats = adguardSnapshot?.data?.stats;
                if (!stats) throw new Error('AdGuard stats cache is not ready');
                const queries = Number(stats.num_dns_queries || 0);
                const blocked = Number(stats.num_blocked_filtering || 0);
                const rate = queries > 0 ? blocked / queries * 100 : 0;
                if (queries >= 100 && rate >= (s.adgBlockRateAlert ?? 50)) {
                    lastAdgBlockRateTs = Date.now();
                    await notify('🛡️ AdGuard 攔截率異常升高', `DNS 查詢 ${queries.toLocaleString()} 次，攔截 ${blocked.toLocaleString()} 次 (${rate.toFixed(1)}%，門檻 ${s.adgBlockRateAlert ?? 50}%)`);
                }
            } catch (error) {
                logRecoverableFailure('watcher.adguardStats', error, { module: 'watcher.notifications', function: 'checkAdguardBlockRate', code: ERROR_CODES.EXT_ADGUARD_FAILED });
            }
        }
        if (on !== null) adgWasOn = on;
    }
    // Linux 小主機：過熱 / 磁碟滿 (30 分鐘冷卻)、離線/恢復 (轉態)
    if ((s.triggerLinuxTemp !== false || s.triggerLinuxOffline || s.triggerLinuxDisk || s.triggerLinuxHighCpu || s.triggerLinuxHighMemory || s.triggerLinuxHighLoad) && linuxConfigured()) {
        const linuxSnapshot = deviceCollectorSnapshot('linux.stats');
        const d = linuxSnapshot?.lastErrorAt ? null : linuxSnapshot?.data || null;
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
        if (d && s.triggerLinuxHighCpu && d.cpuUsage != null && d.cpuUsage >= (s.linuxCpuAlert ?? 90)
            && Date.now() - lastLinuxCpuTs > 30 * 60 * 1000) {
            lastLinuxCpuTs = Date.now();
            await notify('🖥️ 小主機 CPU 使用率過高', `${d.hostname} CPU ${d.cpuUsage}% (門檻 ${s.linuxCpuAlert ?? 90}%)`);
        }
        if (d && s.triggerLinuxHighMemory && d.memUsagePct != null && d.memUsagePct >= (s.linuxMemoryAlert ?? 90)
            && Date.now() - lastLinuxMemoryTs > 30 * 60 * 1000) {
            lastLinuxMemoryTs = Date.now();
            await notify('🧠 小主機記憶體使用率過高', `${d.hostname} 記憶體 ${d.memUsagePct}% (門檻 ${s.linuxMemoryAlert ?? 90}%)`);
        }
        const load1m = Number(d?.load?.[0]);
        if (d && s.triggerLinuxHighLoad && Number.isFinite(load1m) && load1m >= (s.linuxLoadAlert ?? 4)
            && Date.now() - lastLinuxLoadTs > 30 * 60 * 1000) {
            lastLinuxLoadTs = Date.now();
            await notify('📈 小主機系統負載過高', `${d.hostname} 1 分鐘 load average ${load1m.toFixed(2)} (門檻 ${s.linuxLoadAlert ?? 4})`);
        }
    }
    // 去重 Set 上限維護 (防長期運行無限成長；iOS 隨機 MAC 會讓 knownClientMacs 持續累積)
    capSet(notifiedThreatIds); capSet(notifiedNasAlertIds); capSet(notifiedNasLogIds); capSet(notifiedNasSleepWakeIds); capSet(knownClientMacs, 4000);
    capMap(clientIpByMac, 4000); capMap(clientSignalAlertTs, 4000); capMap(clientPresenceStates, 4000); capMap(networkDeviceStates, 1000); capMap(wifiSsidStates, 200); capMap(unifiUpgradeAlertTs, 1000);
    notifBootstrapped = true;
}
const UCG_CPU_ALERT_SAMPLES = 3;
let lastNasDiskTempTs = 0, lastNasSpaceTs = 0, lastNasDiskHealthCheckTs = 0, lastNasDiskHealthAlertTs = 0, lastNasCpuTs = 0, lastNasMemoryTs = 0, lastUcgTempTs = 0, lastUcgCpuTs = 0, lastUcgMemoryTs = 0, lastUcgDiskTs = 0, lastWanLatencyTs = 0, ucgCpuHighSamples = 0, wanWasUp = null;
const knownClientMacs = new Set();
const clientIpByMac = new Map();
const clientSignalAlertTs = new Map();
const clientPresenceStates = new Map();
const networkDeviceStates = new Map();
const wifiSsidStates = new Map();
const unifiUpgradeAlertTs = new Map();
const unifiDeviceTemperatureAlertState = createUnifiDeviceTemperatureAlertState({ maxEntries: 1000 });
const notifiedNasLogIds = new Set();
const notifiedNasSleepWakeIds = new Set();
let wiimWasOnline = null;
let lastWiimTempAlertTs = 0, lastWiimVolumeTs = 0;
let wiimPlaybackState = null;
let adgWasOn = null, lastAdgBlockRateTs = 0, lnxWasOnline = null, lastLinuxTempTs = 0, lastLinuxDiskTs = 0, lastLinuxCpuTs = 0, lastLinuxMemoryTs = 0, lastLinuxLoadTs = 0;
let nasWasOnline = null, unifiWasOnline = null;
let cloudLastOnline = null;
let dockerWatcherBootstrapped = false, systemIssueWatcherBootstrapped = false;
const dockerContainerStates = new Map();
const dockerMetricAlertState = createDockerMetricAlertState({ maxEntries: 2000 });
const notifiedDockerLogFingerprints = new Set();
const knownSystemIssues = new Map();
let lastDockerLogScanTs = 0;

/* ===================== 伺服器端排程 (間隔可於設定頁調整，變更後即時重排) ===================== */
let jobTimers = {};
const runningJobs = new Set();
const runningJobPromises = new Set();
async function runSerialJob(name, fn) {
    if (shuttingDown) {
        taskTracker.skip(name);
        return;
    }
    if (runningJobs.has(name)) {
        taskTracker.skip(name);
        return;
    }
    runningJobs.add(name);
    const jobPromise = Promise.resolve().then(() => taskTracker.run(name, fn));
    runningJobPromises.add(jobPromise);
    try { return await jobPromise; }
    catch { /* TaskTracker 已記錄完整 error/stack/task_id；週期工作留待下一輪重試。 */ }
    finally {
        runningJobs.delete(name);
        runningJobPromises.delete(jobPromise);
    }
}
lifecycleInterval(() => runSerialJob('threatBlockReconcile', () => threatIpBlockingService.reconcile()), 15000);
runSerialJob('threatBlockReconcile', () => threatIpBlockingService.reconcile());
lifecycleInterval(() => runSerialJob('adguardPolicyReconcile', () => adguardServicePolicyService.reconcile()), 15000);
runSerialJob('adguardPolicyReconcile', () => adguardServicePolicyService.reconcile());
function scheduleServerJobs() {
    clearLifecycleInterval(jobTimers.watcher);
    clearLifecycleInterval(jobTimers.autodef);
    if (shuttingDown) return;
    jobTimers.watcher = lifecycleInterval(() => runSerialJob('notificationWatcher', notificationWatcher), Math.max(appSettings.watcherSec, 5) * 1000);
    jobTimers.autodef = lifecycleInterval(() => runSerialJob('autoDefenseSweep', autoDefenseSweep), Math.max(appSettings.autoDefenseSec, 5) * 1000);
}

/* ===================== 歷史取樣器 (可見分頁自適應頻率) ===================== */
// A visible tab maintains `general`; UPS retains its own scope so its high
// frequency collector is independent from the normal-device idle interval.
const deviceActivity = createActivityLease({ maxLeaseMs: 3600 * 1000 });
const backendSamplers = new Map();
const collectorMetrics = new Map();
function normalDeviceSampleMs() {
    return (isDeviceSamplingActive('general')
        ? appSettings.deviceActiveBackendSampleSec
        : appSettings.deviceIdleBackendSampleSec) * 1000;
}
function unifiTelemetrySampleMs() {
    return (isDeviceSamplingActive('general')
        ? appSettings.unifiTelemetryActiveSec
        : appSettings.unifiTelemetryIdleSec) * 1000;
}
function upsSampleMs() {
    return (isDeviceSamplingActive('ups')
        ? appSettings.upsActiveBackendSampleSec
        : appSettings.upsIdleBackendSampleSec) * 1000;
}
function ppbEventSyncMs() {
    return (isDeviceSamplingActive('ups')
        ? appSettings.upsPpbEventActiveBackendSampleSec
        : appSettings.upsPpbEventIdleBackendSampleSec) * 1000;
}
function registerBackendSampler(name, collect, getDelayMs) {
    backendSamplers.get(name)?.stop();
    const sampler = createAdaptiveSampler({
        collect: async () => {
            const startedAt = Date.now();
            const previous = collectorMetrics.get(name) || {};
            collectorMetrics.set(name, { ...previous, running: true, lastStartedAt: startedAt });
            try { return await runSerialJob(name, collect); }
            finally {
                collectorMetrics.set(name, {
                    ...collectorMetrics.get(name), running: false,
                    lastDurationMs: Date.now() - startedAt,
                    lastFinishedAt: Date.now()
                });
            }
        },
        getDelayMs,
        setTimeoutFn: (callback, delay) => lifecycleTimeout(callback, delay),
        clearTimeoutFn: clearLifecycleTimeout
    });
    backendSamplers.set(name, sampler);
    sampler.start();
    return sampler;
}
function rebuildBackendSamplers({ immediate = false } = {}) {
    for (const sampler of backendSamplers.values()) sampler.rebuild({ immediate });
}
function requestPromptSampling(scopes) {
    if (scopes.length) rebuildBackendSamplers({ immediate: true });
}
function markClientActivity(scopes = 'general', { focus = false, session = 'legacy' } = {}) {
    const requestedMs = appSettings.activeLeaseSec * 1000;
    // Focus/release applies only to this tab; another visible session stays
    // active until it releases or its own lease expires.
    const activity = deviceActivity.mark(scopes, requestedMs, { replace: focus, sessionId: session });
    // A page focus gets one prompt sample. A lease which had already expired
    // receives the same treatment, while normal heartbeat renewals do not.
    const promptScopes = focus ? activity.accepted : activity.activated;
    if (promptScopes.length) requestPromptSampling(promptScopes);
    else if (focus) rebuildBackendSamplers();
    return { ...activity, promptScopes };
}
function isDeviceSamplingActive(scope) { return deviceActivity.isActive(scope); }

async function sampleTrends() {
    const point = { t: new Date().toISOString(), clients: null, threats24h: null, latency: null };
    try {
        point.clients = (await getUnifiClientsCached({ refresh: true })).length;
    } catch (error) {
        logRecoverableFailure('sampler.trend.unifi.clients', error, { module: 'scheduler.trend', function: 'sampleLocalMetrics.clients', code: ERROR_CODES.EXT_UNIFI_FAILED });
    }
    try {
        const alarm = await getUnifiThreatsCached({ refresh: true });
        const dayAgo = Date.now() - 86400000;
        point.threats24h = alarm.filter(a => {
            const ts = Number.isFinite(Number(a.time)) ? Number(a.time) : Date.parse(a.datetime);
            return isIpsAlarm(a) && Number.isFinite(ts) && ts >= dayAgo;
        }).length;
    } catch (error) {
        logRecoverableFailure('sampler.trend.unifi.threats', error, { module: 'scheduler.trend', function: 'sampleLocalMetrics.threats', code: ERROR_CODES.EXT_UNIFI_FAILED });
    }
    const notificationSettings = loadNotifSettings();
    if (notificationSettings.enabled && (notificationSettings.triggerNetworkDeviceOffline || notificationSettings.triggerUnifiUpgrade)) {
        try { await getUnifiNetworkDevicesCached({ refresh: true }); }
        catch (error) { logRecoverableFailure('sampler.trend.unifi.devices', error, { module: 'scheduler.trend', function: 'sampleNetworkDevices', code: ERROR_CODES.EXT_UNIFI_FAILED }); }
    }
    if (notificationSettings.enabled && notificationSettings.triggerWifiSsidChange) {
        try { await getUnifiWifiNetworksCached({ refresh: true }); }
        catch (error) { logRecoverableFailure('sampler.trend.unifi.wifi', error, { module: 'scheduler.trend', function: 'sampleWifiNetworks', code: ERROR_CODES.EXT_UNIFI_FAILED }); }
    }
    if (adgConfigured()) {
        try { await getAdguardOverviewCached({ refresh: true }); }
        catch (error) { logRecoverableFailure('sampler.trend.adguard', error, { module: 'scheduler.trend', function: 'sampleAdguard', code: ERROR_CODES.EXT_ADGUARD_FAILED }); }
    }
    try {
        if (cloudConfigured()) {
            const r = await getCloudIspMetricsCached({ refresh: true });
            const periods = (r.data && r.data.data && r.data.data[0] && r.data.data[0].periods) || [];
            if (periods.length) point.latency = (periods[periods.length - 1].data.wan || {}).avgLatency ?? null;
        }
    } catch (error) {
        logRecoverableFailure('sampler.trend.cloud', error, { module: 'scheduler.trend', function: 'sampleCloudMetrics', code: ERROR_CODES.EXT_UNIFI_FAILED });
    }
    if (point.clients === null && point.threats24h === null && point.latency === null) return;
    historyDb.insertPoint('trend', point, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });
}

async function sampleNotificationSourceCaches() {
    const s = loadNotifSettings();
    if (!s.enabled) return;
    const jobs = [];
    if (s.triggerUnifiOffline) jobs.push(getUnifiHealthCached({ refresh: true }));
    if (s.triggerCloudOffline && cloudConfigured()) jobs.push(getCloudHealthCached({ refresh: true }));
    if (nasMonAdvancedConfigured() && s.triggerNasAlerts) jobs.push(getNasMonitorCached('alerts24h', '/api/alerts/events', { hours: 24 }, { refresh: true }));
    if (nasMonConfigured()) jobs.push(getNasMonitorDockerCached({ refresh: true }));
    if (nasConfigured()) {
        if (s.triggerNasOffline) jobs.push(getNasCommonCached({ refresh: true }));
        if (s.triggerNasHighCpu || s.triggerNasHighMemory) jobs.push(getNasStatsCached({ refresh: true }));
        if (s.triggerNasDiskTemp || s.triggerNasDiskHealth !== false) jobs.push(getNasApiCached('disks', '/ugreen/v1/storage/disk/list', { start: 0, size: 50 }, { refresh: true }));
        if (s.triggerNasSpace) jobs.push(getNasApiCached('volumes', '/ugreen/v1/storage/volume/list', { start: 0, size: 50 }, { refresh: true }));
        if (s.triggerNasLog || s.triggerNasSleepWake) jobs.push(getNasApiCached('logs', '/ugreen/v1/log/query', { visualizer: false, page: 0, size: 50, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' }, { refresh: true }));
    }
    await Promise.all(jobs);
    const dockerSnapshot = deviceCollectorSnapshot('nasMonitor.dockerContainers');
    const containers = Array.isArray(dockerSnapshot?.data) ? dockerSnapshot.data : (dockerSnapshot?.data?.containers || dockerSnapshot?.data?.data || []);
    await warmDockerLogCaches(s, containers);
    await scanDockerNotifications(s);
}

async function sampleUnifiDeviceTelemetry() {
    try {
        const telemetry = await unifiDeviceTelemetrySnapshot.refresh();
        if (!telemetry.devices.length) return;
        historyDb.insertPoint('unifiDevices', telemetryHistoryPoint(telemetry), {
            keepDays: appSettings.historyKeepDays,
            hardCap: HISTORY_HARD_CAP
        });
    } catch (error) {
        logRecoverableFailure('sampler.unifiDeviceTelemetry', error, {
            module: 'scheduler.unifiDeviceTelemetry',
            function: 'sample',
            code: ERROR_CODES.EXT_UNIFI_FAILED
        });
    }
}

registerBackendSampler('trendHistory', sampleTrends, normalDeviceSampleMs);
registerBackendSampler('notificationSourceCache', sampleNotificationSourceCaches, normalDeviceSampleMs);
registerBackendSampler('unifiDeviceHistory', sampleUnifiDeviceTelemetry, unifiTelemetrySampleMs);
scheduleServerJobs();
systemMonitor.start();
logger.info({
    module: 'scheduler', function: 'scheduleServerJobs', code: ERROR_CODES.WORKER_READY,
    message: 'Background schedulers ready', fields: {
        jobs: ['notificationWatcher', 'autoDefenseSweep', 'trendHistory', 'unifiDeviceHistory', 'historyCleanup', 'nasHistory', 'reportScheduler', 'wiimTemperature', 'upsSample', 'linuxHistory']
    }
});

// 14. 歷史趨勢查詢 (?hours=24 / 168)。只加快 trend，不會連帶加快 NAS/WiiM/Linux。
app.get('/api/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.history', function: 'listTrend'
    });
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ history: historyDb.getSince('trend', cutoff) });
});

// 輕量心跳端點：只為目前顯示的裝置續短租約；沒有續約最晚 3 分鐘自動回到低頻。
app.get('/api/heartbeat', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHeartbeatQuery(req.query), {
        module: 'api.heartbeat', function: 'renewActivity'
    });
    if (!query) return;
    const activity = markClientActivity(query.scope, { focus: query.focus, session: query.session });
    res.json({ ok: true, activeScopes: deviceActivity.activeScopes(), expiresAt: activity.expiresAt, promptScopes: activity.promptScopes });
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

let nasToken = '', nasTokenExpiry = 0, nasLoginPromise = null;
async function getNasToken() {
    const now = Date.now();
    if (nasToken && now < nasTokenExpiry) {
        sysLog('NAS Auth', '使用快取的 UGREEN NAS JWT Token。');
        return nasToken;
    }
    if (nasLoginPromise) return nasLoginPromise;
    const login = (async () => {
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
    })();
    nasLoginPromise = login;
    try { return await login; }
    finally { if (nasLoginPromise === login) nasLoginPromise = null; }
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
            if (nasToken === token) { nasToken = ''; nasTokenExpiry = 0; }
            return nasGet(pathName, params, true);
        }
        throw new Error(permErr
            ? `NAS 帳號權限不足 (code ${r.data.code})：此 API 僅限管理員帳號，請在 UGOS 將使用者設為管理員或改用管理員帳密`
            : `UGOS code ${r.data.code}: ${r.data.msg || r.data.debug || ''}`);
    }
    return r.data && r.data.data !== undefined ? r.data.data : r.data;
}
function getNasCommonCached(options) {
    return readDeviceCollector('nas.common', () => nasGet('/ugreen/v1/sysinfo/machine/common'), options);
}
function getNasStatsCached(options) {
    return readDeviceCollector('nas.stats', () => nasGet('/ugreen/v1/taskmgr/stat/get_all'), options);
}
function getNasApiCached(name, pathName, params, options) {
    return readDeviceCollector(`nas.${name}`, () => nasGet(pathName, params), options);
}

// 15. NAS 總覽 (硬體資訊 + 即時遙測 taskmgr/stat/get_all)
app.get('/api/nas/overview', async (req, res) => {
    if (!nasConfigured()) return res.json({ info: null, stats: null, source: 'not_configured' });
    try {
        const info = await getNasCommonCached();
        // 遙測 (taskmgr) 需管理員權限；一般帳號拿不到就只給機型資訊，不整卡報錯
        let statsRaw = null, statsError = null;
        try { statsRaw = await getNasStatsCached(); } catch (e) { statsError = e.message; }
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
        const data = await getNasApiCached('logs.sleep', '/ugreen/v1/log/query', { visualizer: false, page: 0, size: 200, order: 'down', log_type: 0, from_time: '', to_time: '', order_param: '', log_id: '' });
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
        const data = await getNasApiCached('disks', '/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
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
    const query = validatedInput(res, () => {
        queryInput.exactQuery(req.query, { allowed: ['dev', 'name'] });
        const dev = req.query.dev === undefined ? null
            : queryInput.safePathIdentifierValue(req.query.dev, { field: 'dev', max: 64 });
        const name = req.query.name === undefined ? null
            : writeInput.stringValue(req.query.name, { field: 'name', min: 1, max: 128 });
        if ((!dev && !name) || (dev && name)) throw new writeInput.InputValidationError('exactly one of dev or name is required');
        return { dev, name };
    }, { module: 'api.nas', function: 'getDiskSmart' });
    if (!query) return;
    if (!nasConfigured()) return apiError(res, new Error('NAS is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_not_configured', module: 'api.nas', function: 'getDiskSmart'
    });
    let { dev } = query; // 前端傳 dev_name (sdb / nvme0n1)，或只傳 name (硬碟1) 由後端查對照
    try {
        if (!dev && query.name) {
            // 前端平時不打 disk/list (避免喚醒)；使用者點看 SMART 才在此查一次 label→dev_name
            const data = await nasGet('/ugreen/v1/storage/disk/list', { start: 0, size: 50 });
            const list = deepFind({ d: data }, ['result', 'list', 'disks']) || [];
            const hit = list.find(d => (d.label || d.name) === query.name);
            if (hit) dev = queryInput.safePathIdentifierValue(hit.dev_name, { field: 'dev', max: 64 });
        }
        if (!dev) return apiError(res, new Error('missing dev'), {
            status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'missing dev', module: 'api.nas', function: 'getDiskSmart'
        });
        const diskPath = `/dev/${dev}`;
        const data = await nasGet('/ugreen/v1/storage/disk/smart/info', { disk: diskPath });
        res.json({ smart: data, source: 'nas_api' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_FAILED, module: 'api.nas', function: 'getDiskSmart', logMessage: 'Failed to fetch NAS SMART data' });
    }
});

// 16-2. UGOS 日誌中心 (login/storage/snapshot 等系統事件)
app.get('/api/nas/logs', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseNasLogsQuery(req.query), {
        module: 'api.nas', function: 'getNasLogs'
    });
    if (!query) return;
    if (!nasConfigured()) return res.json({ logs: [], total: 0, source: 'not_configured' });
    try {
        const { page, size } = query;
        const data = await getNasApiCached(`logs.${page}.${size}`, '/ugreen/v1/log/query', {
            visualizer: false, page, size, order: 'down', log_type: 0,
            from_time: '', to_time: '', order_param: '', log_id: ''
        });
        let logs = (data.log_list || []).map(l => ({
            id: l.log_id, level: l.level, module: l.module, operator: l.operator,
            content: l.content, ts: l.create_time * 1000
        }));
        // hideSelf=1：過濾本站監控帳號的例行登入 (避免 log 被自己洗版)
        if (query.hideSelf) {
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
    const query = validatedInput(res, () => queryInput.parseNasSleepStatsQuery(req.query), {
        module: 'api.nas', function: 'getSleepStats'
    });
    if (!query) return;
    if (!nasConfigured()) return res.json({ days: [], source: 'not_configured' });
    try {
        const { pages } = query;
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
        const awakeOpen = {}; // drive → 最近一次喚醒 epoch，用下一次 sleep 算出實際運轉時段
        const awakeSessions = [];
        const byDay = {};  // 'YYYY-MM-DD' → { driveN: { sec, n } }
        const wakeEvents = {}; // day → [{drive, t}]
        // 日期鍵必須零填補 (YYYY-MM-DD)：原本 zh-TW 格式 '2026/7/12' 用字串排序會排在 '2026/7/2' 前面，
        // 導致統計清單的日期順序錯亂；en-CA locale 恰好輸出 ISO 格式，可直接字串排序
        const dayKey = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
        const ensure = (d, drv) => { byDay[d] = byDay[d] || {}; byDay[d][drv] = byDay[d][drv] || { sec: 0, n: 0, longest: 0 }; return byDay[d][drv]; };
        for (const e of sw) {
            if (e.action === 'sleep') {
                if (awakeOpen[e.drive] && e.t > awakeOpen[e.drive]) {
                    awakeSessions.push({ drive: '硬碟' + e.drive, start: awakeOpen[e.drive], end: e.t, durationMin: Math.round((e.t - awakeOpen[e.drive]) / 60), ongoing: false });
                    awakeOpen[e.drive] = null;
                }
                open[e.drive] = e.t;
            }
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
                awakeOpen[e.drive] = e.t;
            }
        }
        const nowSec = Math.floor(Date.now() / 1000);
        Object.entries(awakeOpen).forEach(([drive, start]) => {
            if (start && nowSec > start) awakeSessions.push({ drive: '硬碟' + drive, start, end: nowSec, durationMin: Math.round((nowSec - start) / 60), ongoing: true });
        });
        const days = Object.keys(byDay).sort().reverse().slice(0, 14).map(day => ({
            day,
            drives: Object.entries(byDay[day]).map(([name, v]) => ({
                name, sleepHours: +(v.sec / 3600).toFixed(1), sessions: v.n,
                avgMin: v.n ? Math.round(v.sec / v.n / 60) : 0,
                longestMin: Math.round(v.longest / 60),
                sleepPct: Math.min(100, Math.round(v.sec / 86400 * 100))
            })).sort((a, b) => a.name.localeCompare(b.name)),
            wakes: (wakeEvents[day] || []).map(w => ({ drive: w.drive, time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Taipei' }).format(new Date(w.t)) }))
        }));
        res.json({ days, awakeSessions: awakeSessions.sort((a, b) => b.start - a.start).slice(0, 200), source: 'nas_api' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_FAILED, module: 'api.nas', function: 'getNasSleepStats', logMessage: 'Failed to fetch NAS sleep statistics' });
    }
});

// 17. NAS 邏輯儲存區清單 (回應包裝於 data.result)
app.get('/api/nas/volumes', async (req, res) => {
    if (!nasConfigured()) return res.json({ volumes: [], source: 'not_configured' });
    try {
        const data = await getNasApiCached('volumes', '/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
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

/* ===================== UCG 歷史自建取樣器 ===================== */
function sampleUcgHistory({ cpuTemp, cpuUsage, cores, memUsagePct }) {
    historyDb.insertPoint('ucg', { t: new Date().toISOString(), cpuTemp, cpuUsage, memUsagePct, cores }, {
        keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP
    });
}
async function collectUcgHistory() {
    if (isPlaceholder(process.env.SSH_PASSWORD) || !process.env.UCG_IP) return;
    const data = await getHardwareCached({ force: true });
    sampleUcgHistory(data);
}
registerBackendSampler('ucgHistory', collectUcgHistory, normalDeviceSampleMs);
app.get('/api/hardware/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.hardware', function: 'listHistory'
    });
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
    res.json({ data: historyDb.getSince('ucg', cutoff) });
});

/* ===================== NAS 歷史自建取樣器 =====================
   UGOS 沒有提供歷史 API (只有即時快照 get_all)，這裡自己定期取樣 get_all + volume/list 並持久化，
   讓「系統負載 / 網路流量 / 散熱 / 儲存趨勢」四張圖有真實歷史可畫，不需要另外部署 NAS Monitor (系統 B)。 */
async function sampleNasHistory() {
    if (!nasConfigured()) return;
    try {
        const raw = await getNasStatsCached();
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
            const vdata = await getNasApiCached('volumes', '/ugreen/v1/storage/volume/list', { start: 0, size: 50 });
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
registerBackendSampler('nasHistory', sampleNasHistory, normalDeviceSampleMs);

function nasHistorySince(hours) {
    return historyDb.getSince('nas', Date.now() - hours * 3600000);
}

/* ===================== NAS Monitor 擴充 REST API ===================== */
// 內建 Node broker 使用 docker_only；完整外部 monitor 才提供 history/alerts/SSE。
// 未設定或安全設定驗證失敗時，整合保持 optional 並回傳誠實的空狀態。
function buildNasMonClient() {
    try {
        nasMonConfigurationError = null;
        return createNasMonitorConnection({ axios, env: process.env });
    } catch (error) {
        nasMonConfigurationError = error;
        logger.warning({
            module: 'integration.nasMonitor', function: 'buildClient', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'NAS Monitor configuration rejected; integration disabled', error
        });
        return { url: null, client: null, configured: false };
    }
}
let nasMonConfigurationError = null;
let { url: NASMON_URL, client: nasMonClient } = buildNasMonClient();
function nasMonConfigured() { return !!NASMON_URL; }
function nasMonAdvancedConfigured() {
    return nasMonConfigured() && String(process.env.NAS_MONITOR_MODE || 'full').toLowerCase() !== 'docker_only';
}
async function nasMonGet(p, params) { const r = await nasMonClient.get(p, { params }); return r.data; }
function getNasMonitorCached(name, pathName, params, options) {
    return readDeviceCollector(`nasMonitor.${name}`, () => nasMonGet(pathName, params), options);
}
function getNasMonitorDockerCached(options) {
    return getNasMonitorCached('dockerContainers', '/api/docker/containers', undefined, options);
}
function allowLegacyNasMonActions() { return process.env.NAS_MONITOR_ALLOW_LEGACY_ACTIONS === 'true'; }
async function authorizeNasMonDockerAction(id, action) {
    const inventory = await nasMonGet('/api/docker/containers');
    return selectDockerActionTarget(inventory, id, action, { allowLegacy: allowLegacyNasMonActions() });
}

// 通用代理：優先呼叫系統 B，失敗或未設定時回退 fallback
async function nasMonProxy(res, path, params, fallback) {
    // 誠實模式：未設定就回空殼 (保留欄位結構、陣列清空)，絕不回傳模擬數據
    const emptyLike = v => Array.isArray(v) ? [] : (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyLike(x)])) : null);
    if (!nasMonAdvancedConfigured()) return res.json({ ...emptyLike(fallback), source: 'not_configured' });
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
        const data = await getNasMonitorDockerCached();
        const containers = containersFromPayload(data);
        res.json({
            containers,
            source: 'nas_monitor',
            total: Number.isInteger(data?.total) ? data.total : containers.length,
            truncated: data?.truncated === true,
            actionsEnabled: containers.some(container => Array.isArray(container?.allowed_actions) && container.allowed_actions.length > 0)
        });
    } catch (error) {
        logRecoverableFailure('nasMonitor.docker', error, { module: 'api.nasMonitor', function: 'getDockerContainers', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ containers: [], source: 'error', error: publicError(error) });
    }
});

// 20. Docker 容器操作 (start / stop / restart)
app.post('/api/nas/docker/:id/:action', async (req, res) => {
    const input = validatedInput(res, () => ({
        id: writeInput.identifierValue(req.params.id, { field: 'id', max: 128 }),
        action: writeInput.enumValue(req.params.action, ['start', 'stop', 'restart'], 'action'),
        ...writeInput.parseEmptyBody(req.body)
    }), {
        module: 'api.nasMonitor', function: 'dockerAction'
    });
    if (!input) return;
    if (!nasMonConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'dockerAction'
    });
    let actionSubmitted = false;
    try {
        const target = await authorizeNasMonDockerAction(input.id, input.action);
        actionSubmitted = true;
        const r = await nasMonClient.post(`/api/docker/containers/${encodeURIComponent(target.id)}/${target.action}`);
        res.json({ success: true, data: r.data, source: 'nas_monitor' });
    } catch (error) {
        if (error instanceof DockerActionPolicyError) return apiError(res, error, {
            status: 403, code: ERROR_CODES.API_AUTHORIZATION_FAILED, publicMessage: 'docker_action_not_allowed',
            module: 'api.nasMonitor', function: 'dockerAction'
        });
        const ambiguous = ambiguousDockerActionResult(error, input.action, { submitted: actionSubmitted });
        if (ambiguous) {
            logger.warning({
                module: 'api.nasMonitor', function: 'dockerAction', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED,
                http_status: 504, message: 'Docker action outcome is unknown; refresh state before deciding whether to retry',
                fields: { action: ambiguous.action, ambiguous: true }
            });
            return res.status(504).json({ ...ambiguous, source: 'nas_monitor' });
        }
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'dockerAction', logMessage: 'NAS Monitor Docker action failed' });
    }
});

// 21. Docker 容器日誌
app.get('/api/nas/docker/:id/logs', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => ({
        id: queryInput.safePathIdentifierValue(req.params.id, { field: 'id', max: 128 }),
        ...queryInput.parseDockerLogsQuery(req.query)
    }), { module: 'api.nasMonitor', function: 'dockerLogs' });
    if (!input) return;
    if (!nasMonConfigured()) {
        return res.json({ logs: '', source: 'not_configured' });
    }
    try {
        const data = await nasMonGet(`/api/docker/containers/${encodeURIComponent(input.id)}/logs`, { lines: input.lines });
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
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.nasMonitor', function: 'trafficHistory'
    });
    if (!query) return;
    const { hours } = query;
    if (nasMonAdvancedConfigured()) return nasMonProxy(res, '/api/traffic/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, upload_mbps: p.up_mbps, download_mbps: p.down_mbps }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 24. 系統歷史 (CPU / 記憶體 / 溫度)
app.get('/api/nas/system-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.nasMonitor', function: 'systemHistory'
    });
    if (!query) return;
    const { hours } = query;
    if (nasMonAdvancedConfigured()) return nasMonProxy(res, '/api/system/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).map(p => ({ t: p.t, cpu: p.cpu, memory: p.memory, temperature: p.temperature, fan_rpm: p.fan_rpm ?? null }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 25. 溫度歷史 (各硬碟溫度；此機型 API 無風扇轉速)
app.get('/api/nas/temperature-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.nasMonitor', function: 'temperatureHistory'
    });
    if (!query) return;
    const { hours } = query;
    if (nasMonAdvancedConfigured()) return nasMonProxy(res, '/api/temperature/history', { hours }, { data: [] });
    const pts = nasHistorySince(hours);
    // 收集所有出現過的硬碟名稱，供前端動態畫線
    const diskNames = [...new Set(pts.flatMap(p => Object.keys(p.disks || {})))];
    const data = pts.map(p => ({ t: p.t, disks: p.disks || {}, fan_rpm: p.fan_rpm ?? null }));
    res.json({ data, diskNames, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 26. 儲存容量歷史
app.get('/api/nas/storage-history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query, { defaultValue: 720 }), {
        module: 'api.nasMonitor', function: 'storageHistory'
    });
    if (!query) return;
    const { hours } = query;
    if (nasMonAdvancedConfigured()) return nasMonProxy(res, '/api/storage/history', { hours }, { data: [] });
    const data = nasHistorySince(hours).filter(p => p.used_gb != null).map(p => ({ t: p.t, used_gb: p.used_gb, total_gb: p.total_gb }));
    res.json({ data, source: nasConfigured() ? 'nas_sampler' : 'not_configured' });
});

// 27. 儲存滿載預測 (線性迴歸估算剩餘天數)
app.get('/api/nas/storage-forecast', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryDaysQuery(req.query), {
        module: 'api.nasMonitor', function: 'storageForecast'
    });
    if (!query) return;
    const { days } = query;
    nasMonProxy(res, '/api/storage/forecast', { days },
        { data: { days_until_full: 512, daily_growth_gb: 6.2, projected_full_date: new Date(Date.now() + 512 * 86400000).toISOString().slice(0, 10), current_used_percent: 42 } });
});

// 28. 正常運行時間 / 離線事件
app.get('/api/nas/downtime', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryDaysQuery(req.query), {
        module: 'api.nasMonitor', function: 'downtime'
    });
    if (!query) return;
    const { days } = query;
    nasMonProxy(res, '/api/downtime', { days },
        { data: { uptime_percent: 99.97, downtime_events: 1, last_downtime: new Date(Date.now() - 12 * 86400000).toISOString(), total_downtime_min: 13 } });
});

// 29. 警報事件
app.get('/api/nas/alerts', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseNasAlertsQuery(req.query), {
        module: 'api.nasMonitor', function: 'getAlerts'
    });
    if (!query) return;
    if (!nasMonAdvancedConfigured()) return res.json({ events: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/alerts/events', { hours: query.hours });
        res.json({ events: Array.isArray(data) ? data : (data.events || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        logRecoverableFailure('nasMonitor.alerts', error, { module: 'api.nasMonitor', function: 'getAlerts', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ events: [], source: 'error', error: publicError(error) });
    }
});

// 30. 確認 (清除) 警報
app.post('/api/nas/alerts/:id/ack', async (req, res) => {
    const input = validatedInput(res, () => ({
        id: writeInput.identifierValue(req.params.id, { field: 'id', max: 128 }),
        ...writeInput.parseEmptyBody(req.body)
    }), { module: 'api.nasMonitor', function: 'ackAlert' });
    if (!input) return;
    if (!nasMonAdvancedConfigured()) {
        return apiError(res, new Error('NAS Monitor is not configured'), {
            status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'ackAlert'
        });
    }
    try {
        await nasMonClient.post(`/api/alerts/events/${encodeURIComponent(input.id)}/acknowledge`);
        res.json({ success: true, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'ackAlert', logMessage: 'NAS Monitor alert acknowledgement failed' });
    }
});

// 31. 警報閾值設定 (系統 B)：面板直接管理各指標的觸發門檻，取代目前「只能看不能改」
app.get('/api/nas/alerts/config', async (req, res) => {
    if (!nasMonAdvancedConfigured()) return res.json({ config: [], source: 'not_configured' });
    try {
        const data = await nasMonGet('/api/alerts/config');
        res.json({ config: Array.isArray(data) ? data : (data.config || data.data || []), source: 'nas_monitor' });
    } catch (error) {
        logRecoverableFailure('nasMonitor.alertConfig', error, { module: 'api.nasMonitor', function: 'getAlertConfig', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
        res.json({ config: [], source: 'error', error: publicError(error) });
    }
});
app.post('/api/nas/alerts/config', async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAlertConfig(req.body), {
        module: 'api.nasMonitor', function: 'saveAlertConfig'
    });
    if (!input) return;
    if (!nasMonAdvancedConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'saveAlertConfig'
    });
    try {
        const r = await nasMonClient.post('/api/alerts/config', input);
        res.json({ ok: true, data: r.data, source: 'nas_monitor' });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_NAS_MONITOR_FAILED, module: 'api.nasMonitor', function: 'saveAlertConfig', logMessage: 'NAS Monitor alert configuration failed' });
    }
});
app.delete('/api/nas/alerts/config/:metric', async (req, res) => {
    const input = validatedInput(res, () => ({
        metric: writeInput.identifierValue(req.params.metric, {
            field: 'metric', max: 64, pattern: /^[A-Za-z][A-Za-z0-9._:-]*$/u
        }),
        ...writeInput.parseEmptyBody(req.body)
    }), { module: 'api.nasMonitor', function: 'deleteAlertConfig' });
    if (!input) return;
    if (!nasMonAdvancedConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'deleteAlertConfig'
    });
    try {
        await nasMonClient.delete(`/api/alerts/config/${encodeURIComponent(input.metric)}`);
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
const SSE_CONNECT_TIMEOUT_MS = 20_000;
let sseUpstreamReq = null, sseConnectAttempt = null, sseReconnectTimer = null;
const sseBackpressure = createSseBackpressure({
    setTimeoutFn: (fn, ms) => lifecycleTimeout(fn, ms, { unref: true }),
    clearTimeoutFn: clearLifecycleTimeout,
    onRemove(client) {
        sseClients.delete(client);
        if (sseClients.size === 0) resetSseUpstream();
    }
});

function clearSseConnectAttempt(attempt, { abort = false } = {}) {
    if (!attempt) return;
    clearLifecycleTimeout(attempt.timeout);
    attempt.timeout = null;
    if (sseConnectAttempt === attempt) sseConnectAttempt = null;
    if (abort && !attempt.controller.signal.aborted) {
        attempt.cancelled = true;
        attempt.controller.abort();
    }
}

function resetSseUpstream({ reconnect = false } = {}) {
    clearLifecycleTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
    clearSseConnectAttempt(sseConnectAttempt, { abort: true });
    if (sseUpstreamReq) {
        try { sseUpstreamReq.data.destroy(); } catch { }
        sseUpstreamReq = null;
    }
    if (reconnect && !shuttingDown && sseClients.size > 0) sseConnectUpstream();
}

function sseConnectUpstream() {
    if (shuttingDown || !nasMonAdvancedConfigured() || sseUpstreamReq || sseConnectAttempt || sseClients.size === 0) return;
    const attempt = { controller: new AbortController(), timeout: null, cancelled: false };
    sseConnectAttempt = attempt;
    attempt.timeout = lifecycleTimeout(() => attempt.controller.abort(), SSE_CONNECT_TIMEOUT_MS, { unref: true });
    nasMonClient.get('/api/stream', {
        responseType: 'stream', timeout: 0, signal: attempt.controller.signal
    }).then(r => {
        clearSseConnectAttempt(attempt);
        if (shuttingDown || sseClients.size === 0) {
            try { r.data.destroy(); } catch { }
            return;
        }
        sysLog('NAS SSE', '已連線上游即時推送串流');
        sseUpstreamReq = r;
        r.data.on('data', chunk => { for (const c of [...sseClients]) sseBackpressure.write(c, chunk); });
        const disconnected = () => {
            if (sseUpstreamReq !== r) return;
            sseUpstreamReq = null;
            scheduleSseReconnect();
        };
        r.data.once('end', disconnected);
        r.data.once('error', disconnected);
    }).catch(e => {
        clearSseConnectAttempt(attempt);
        if (attempt.cancelled || shuttingDown || sseClients.size === 0) return;
        sysLog('NAS SSE', `連線失敗: ${e.message}，10 秒後重試`, true);
        scheduleSseReconnect();
    });
}
function scheduleSseReconnect() {
    if (shuttingDown || sseReconnectTimer || sseClients.size === 0) return;
    sseReconnectTimer = lifecycleTimeout(() => { sseReconnectTimer = null; sseConnectUpstream(); }, 10000);
}
app.get('/api/nas/stream', (req, res) => {
    if (!nasMonAdvancedConfigured()) return apiError(res, new Error('NAS Monitor is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'nas_monitor_not_configured', module: 'api.nasMonitor', function: 'stream'
    });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(':ok\n\n');
    sseClients.add(res);
    sseConnectUpstream();
    req.on('close', () => {
        sseBackpressure.remove(res);
    });
});

/* ===================== 應用程式設定 API ===================== */
app.get('/api/settings', (req, res) => res.json(appSettings));
app.post('/api/settings', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseAppSettings(req.body, APP_SETTING_RANGES), {
        module: 'api.settings', function: 'saveAppSettings'
    });
    if (!input) return;
    const next = { ...appSettings, ...input };
    normalizeAppSettings(next, input);
    if (next.activeLeaseSec <= next.heartbeatSec) {
        return apiError(res, new writeInput.InputValidationError('activeLeaseSec must be greater than heartbeatSec', { field: 'activeLeaseSec' }), {
            status: 400, code: ERROR_CODES.API_VALIDATION_FAILED, module: 'api.settings', function: 'saveAppSettings', logMessage: 'Invalid heartbeat lease configuration'
        });
    }
    try { saveAppSettings(next); }
    catch (error) {
        if (error.committed) {
            scheduleServerJobs();
            rebuildBackendSamplers();
        }
        return apiError(res, error, { code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.settings', function: 'saveAppSettings', logMessage: 'App settings persistence failed' });
    }
    scheduleServerJobs();
    rebuildBackendSamplers(); // Clear old timers before scheduling with new values.
    res.json({ ok: true, settings: appSettings });
});

/* ===================== 連線設定 (網頁安全更新 config/.env) ===================== */
// 允許透過設定頁修改的欄位 (secret: GET 時只回「是否已設定」)
const CONN_FIELDS = [
    { key: 'UCG_IP' }, { key: 'SSH_PORT' }, { key: 'SSH_USER' }, { key: 'SSH_PASSWORD', secret: true }, { key: 'WAN_IFACE' },
    { key: 'UNIFI_CONTROLLER_URL' }, { key: 'UNIFI_USERNAME' }, { key: 'UNIFI_PASSWORD', secret: true },
    { key: 'UNIFI_DEVICE_SSH_PORT' }, { key: 'UNIFI_DEVICE_SSH_USER' }, { key: 'UNIFI_DEVICE_SSH_PASSWORD', secret: true }, { key: 'UNIFI_DEVICE_SSH_TARGET_IDS' },
    { key: 'UNIFI_API_KEY', secret: true },
    { key: 'UNIFI_NETWORK_API_URL' }, { key: 'UNIFI_NETWORK_API_KEY', secret: true },
    { key: 'UNIFI_NETWORK_TLS_VERIFY' },
    { key: 'UNIFI_NETWORK_SITE_ID' }, { key: 'UNIFI_THREAT_BLOCK_LIST_ID' },
    { key: 'UNIFI_THREAT_BLOCK_LIST_NAME' },
    { key: 'NAS_HOST' }, { key: 'NAS_PORT' }, { key: 'NAS_SCHEME' }, { key: 'NAS_USER' }, { key: 'NAS_PASSWORD', secret: true },
    { key: 'NAS_MONITOR_URL', restartRequired: true },
    { key: 'NAS_MONITOR_API_KEY', secret: true, restartRequired: true },
    { key: 'NAS_MONITOR_MODE', restartRequired: true },
    { key: 'WIIM_IP' },
    { key: 'UPS_SOURCE' }, { key: 'NUT_HOST' }, { key: 'NUT_UPS_NAME' }, { key: 'PWRSTAT_PATH' },
    { key: 'PPB_HOST' }, { key: 'PPB_PORT' }, { key: 'PPB_USER' }, { key: 'PPB_PASSWORD', secret: true },
    { key: 'ADGUARD_URL' }, { key: 'ADGUARD_HOST' }, { key: 'ADGUARD_PORT' },
    { key: 'ADGUARD_ALLOW_INSECURE_HTTP' }, { key: 'ADGUARD_TLS_VERIFY' }, { key: 'ADGUARD_CA_FILE' },
    { key: 'ADGUARD_USER' }, { key: 'ADGUARD_PASSWORD', secret: true },
    { key: 'LINUX_HOST' }, { key: 'LINUX_SSH_PORT' }, { key: 'LINUX_SSH_USER' }, { key: 'LINUX_SSH_PASSWORD', secret: true }
];
const pendingRestartConnectionFields = new Set();
const RECREATE_DEFAULTS = Object.freeze({
    NAS_MONITOR_URL: '',
    NAS_MONITOR_API_KEY: '',
    NAS_MONITOR_MODE: 'docker_only'
});

function recreateValue(source, key) {
    return Object.hasOwn(source || {}, key) ? String(source[key]) : RECREATE_DEFAULTS[key];
}

function reconcilePendingRestartFields(desired) {
    for (const field of CONN_FIELDS.filter(candidate => candidate.restartRequired)) {
        if (recreateValue(desired, field.key) === recreateValue(process.env, field.key)) {
            pendingRestartConnectionFields.delete(field.key);
        } else {
            pendingRestartConnectionFields.add(field.key);
        }
    }
}
reconcilePendingRestartFields(envFileState.parsed);

// 更新 .env 檔：既有 KEY= 行 (含註解掉的) 就地取代，否則附加到檔尾
function persistEnvVars(updates) {
    rewriteEnvFileAtomically(ENV_FILE, original => {
        let content = original;
        for (const [k, v] of Object.entries(updates)) {
            const line = `${k}=${writeInput.quoteEnvValue(v)}`;
            content = upsertEnvAssignment(content, k, line);
        }
        return content;
    });
}

// 熱重建所有依賴 env 的客戶端與快取 (免重啟)
function rebuildClients() {
    unifiClient = buildUnifiClient();
    unifiCloudClient = buildUnifiCloudClient();
    ({ base: NAS_BASE, client: nasClient } = buildNasClient());
    ({ url: NASMON_URL, client: nasMonClient } = buildNasMonClient());
    adguardConnection = buildAdguardConnection();
    resetSseUpstream({ reconnect: true });
    wiimIP = process.env.WIIM_IP || wiimIP;
    localCookie = ''; cookieExpiry = 0;   // 重置 UniFi session
    nasToken = ''; nasTokenExpiry = 0;    // 重置 NAS token
    ppbToken = null; ppbHttpsPort = null; // 重置 PPB session (PPB_HOST/PORT 可能已變更)
    Object.keys(wiimCache).forEach(k => delete wiimCache[k]);
    sysLog('Connections', '連線設定已更新，所有客戶端已熱重建');
}

// GET：非機密回明碼、機密只回是否已設定 (佔位字串視為未設定)
app.get('/api/connections', (req, res) => {
    let desired;
    try { desired = parseDesiredEnvFile(ENV_FILE); }
    catch (error) {
        return apiError(res, error, {
            code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.connections', function: 'readEnvFile',
            logMessage: '.env read failed', publicMessage: '.env 讀取失敗，請檢查檔案與目錄權限'
        });
    }
    reconcilePendingRestartFields(desired);
    const fields = {}, secretsSet = {};
    for (const f of CONN_FIELDS) {
        const v = Object.hasOwn(desired, f.key) ? desired[f.key] : process.env[f.key];
        if (f.secret) secretsSet[f.key] = !isPlaceholder(v);
        else fields[f.key] = isPlaceholder(v) ? '' : (v || '');
    }
    res.json({
        fields,
        secretsSet,
        restartRequiredFields: CONN_FIELDS.filter(field => field.restartRequired).map(field => field.key),
        pendingRestartFields: [...pendingRestartConnectionFields]
    });
});

// POST：留空 = 不變更；寫入 .env + 即時生效
app.post('/api/connections', (req, res) => {
    const updates = validatedInput(res, () => writeInput.parseConnectionUpdates(req.body, CONN_FIELDS), {
        module: 'api.connections', function: 'persistEnvVars'
    });
    if (!updates) return;
    if (!Object.keys(updates).length) return res.json({ ok: true, changed: 0 });
    if (Object.keys(updates).some(key => key.startsWith('ADGUARD_'))) {
        try { createAdGuardConnection({ env: { ...process.env, ...updates }, axios }); }
        catch (error) {
            return apiError(res, error, {
                status: 400,
                code: ERROR_CODES.API_VALIDATION_FAILED,
                module: 'api.connections',
                function: 'validateAdguardConnection',
                publicMessage: error.message
            });
        }
    }
    try { persistEnvVars(updates); } catch (e) {
        if (e?.committed && e?.ambiguous) {
            logger.error({
                module: 'api.connections', function: 'persistEnvVars', code: ERROR_CODES.SYS_CONFIG_INVALID,
                http_status: 500, message: '.env replacement committed but directory durability is unknown', error: e,
                fields: { committed: true, ambiguous: true, outcome: e.outcome }
            });
            return res.status(500).json({
                error: '.env 已替換，但持久化結果無法確認；請重新讀取設定後再決定是否重試',
                code: ERROR_CODES.SYS_CONFIG_INVALID,
                request_id: logger.getContext().request_id,
                committed: true,
                ambiguous: true
            });
        }
        return apiError(res, e, {
            code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.connections', function: 'persistEnvVars',
            logMessage: '.env persistence failed', publicMessage: '.env 寫入失敗，請檢查檔案權限'
        });
    }
    for (const [k, v] of Object.entries(updates)) {
        const field = CONN_FIELDS.find(candidate => candidate.key === k);
        if (field?.restartRequired) continue;
        process.env[k] = v;
    }
    let desiredAfterWrite;
    try { desiredAfterWrite = parseDesiredEnvFile(ENV_FILE); }
    catch (error) {
        return apiError(res, error, {
            code: ERROR_CODES.SYS_CONFIG_INVALID, module: 'api.connections', function: 'verifyEnvFile',
            logMessage: '.env verification failed after write', publicMessage: '.env 已寫入但驗證失敗，請勿直接重試'
        });
    }
    reconcilePendingRestartFields(desiredAfterWrite);
    if (Object.keys(updates).some(key => key.startsWith('UNIFI_DEVICE_SSH_'))) {
        unifiDeviceThermalCollector.reset();
        unifiThermalCache.clear();
        unifiDeviceTelemetrySnapshot.clear();
        unifiThermalLastRunAt = null;
    }
    if (Object.keys(updates).some(key => !CONN_FIELDS.find(field => field.key === key)?.restartRequired)) rebuildClients();
    sysLog('Connections', `已更新 ${Object.keys(updates).length} 個欄位: ${Object.keys(updates).join(', ')}`);
    res.json({
        ok: true,
        changed: Object.keys(updates).length,
        restartRequired: Object.keys(updates).filter(key => pendingRestartConnectionFields.has(key))
    });
});

/* ===================== 設定備份 / 還原 =====================
   匯出包含一致的 SQLite 快照與非機密 JSON 設定；.env 只輸出遮罩後的
   設定狀態。還原先完整驗證並 staging，下一次啟動才以可回滾交易套用。 */
app.get('/api/config/backup/status', panelSecurity.requireAdmin, (_req, res) => {
    res.json(configBackupService.status());
});

app.get('/api/config/backup', panelSecurity.requireAdmin, async (_req, res) => {
    try {
        const backup = await configBackupService.exportBackup();
        const date = new Date().toISOString().slice(0, 10);
        res.set('Content-Type', BACKUP_MEDIA_TYPE);
        res.set('Content-Disposition', `attachment; filename="smarthub-backup-${date}.json"`);
        res.set('Cache-Control', 'no-store');
        res.send(JSON.stringify(backup));
    } catch (error) {
        const validation = error instanceof BackupValidationError;
        apiError(res, error, {
            status: validation ? error.httpStatus : 500,
            code: validation ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.SYS_CONFIG_INVALID,
            publicMessage: validation ? error.message : undefined,
            module: 'api.configBackup', function: 'export', logMessage: 'Configuration backup export failed',
            fields: validation ? { reason: error.code } : undefined
        });
    }
});

app.post('/api/config/restore', panelSecurity.requireAdmin, (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.is(BACKUP_MEDIA_TYPE)) {
        return apiError(res, new Error(`Content-Type must be ${BACKUP_MEDIA_TYPE}`), {
            status: 415, code: ERROR_CODES.API_VALIDATION_FAILED, publicMessage: 'unsupported_backup_content_type',
            module: 'api.configBackup', function: 'restore'
        });
    }
    try {
        const result = configBackupService.stageRestore(req.body, req.get('x-smarthub-restore-confirmation'));
        logger.warning({
            module: 'api.configBackup', function: 'restore', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'A validated configuration restore was staged for the next process start',
            fields: { restart_required: true, secrets_restored: false }
        });
        res.status(202).json(result);
    } catch (error) {
        const validation = error instanceof BackupValidationError;
        apiError(res, error, {
            status: validation ? error.httpStatus : 500,
            code: validation ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.SYS_CONFIG_INVALID,
            publicMessage: validation ? error.message : undefined,
            module: 'api.configBackup', function: 'restore', logMessage: 'Configuration restore staging failed',
            fields: validation ? { reason: error.code } : undefined
        });
    }
});

/* ===================== 定期報表 ===================== */
// 彙整過去 24 小時的關鍵指標成一段文字
function throwIfReportAborted(signal) {
    if (!signal?.aborted) return;
    // Some legacy SSH operations cannot be forcibly interrupted after opening;
    // once they return, this guard stops subsequent report phases and delivery.
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('Report generation cancelled');
}

async function buildReport({ signal } = {}) {
    throwIfReportAborted(signal);
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
    throwIfReportAborted(signal);
    const trends = historyDb.getSince('trend', dayAgo);
    const lat = trends.map(p => p.latency).filter(v => v != null);
    if (lat.length) L.push(`• ISP 延遲：平均 ${avg(lat).toFixed(1)} ms (最高 ${Math.max(...lat)} ms)`);
    const cli = trends.map(p => p.clients).filter(v => v != null);
    if (cli.length) L.push(`• 客戶端數 24H：平均 ${Math.round(avg(cli))} / 最高 ${Math.max(...cli)} 台`);

    // ── UCG 硬體 ──
    throwIfReportAborted(signal);
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
    throwIfReportAborted(signal);
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

    // ── Docker（NAS Monitor 選配）──
    throwIfReportAborted(signal);
    if (nasMonConfigured()) {
        try {
            const data = await nasMonGet('/api/docker/containers');
            const containers = Array.isArray(data) ? data : (data.containers || data.data || []);
            const running = containers.filter(c => String(c.state).toLowerCase() === 'running');
            const stopped = containers.filter(c => String(c.state).toLowerCase() !== 'running');
            const unhealthy = containers.filter(c => /\bunhealthy\b/i.test(`${c.health || ''} ${c.status || ''}`));
            const restarting = containers.filter(c => Number(c.restart_count ?? c.restartCount ?? 0) > 0);
            L.push('\n━━ 🐳 Docker 容器 ━━');
            L.push(`• 容器狀態：${running.length}/${containers.length} 運行中${stopped.length ? `，⚠ 停止 ${stopped.map(c => c.name || c.id).join('、')}` : '，全部運行'}`);
            L.push(`• 健康檢查：${unhealthy.length ? `⚠ 異常 ${unhealthy.map(c => c.name || c.id).join('、')}` : '正常'}`);
            if (restarting.length) L.push(`• 曾重新啟動：${restarting.map(c => `${c.name || c.id} ×${c.restart_count ?? c.restartCount}`).join('、')}`);
            const hot = containers.map(c => {
                const cpu = Number(c.cpu_percent);
                const used = Number(c.mem_usage_mb), limit = Number(c.mem_limit_mb);
                const memory = limit > 0 && Number.isFinite(used) ? used / limit * 100 : null;
                return { ...c, cpu, memory };
            }).filter(c => (Number.isFinite(c.cpu) && c.cpu >= 80) || (Number.isFinite(c.memory) && c.memory >= 80));
            if (hot.length) L.push(`• 高資源：${hot.map(c => `${c.name || c.id} CPU ${Number.isFinite(c.cpu) ? c.cpu.toFixed(1) + '%' : '--'} / RAM ${Number.isFinite(c.memory) ? c.memory.toFixed(0) + '%' : '--'}`).join('、')}`);
            const findings = await readDockerLogFindings(containers, { lines: 100, maxPerContainer: 3 });
            if (findings.length) {
                const recent = findings.slice(-6);
                L.push(`• 近期嚴重/錯誤 Log：${findings.length} 筆`);
                recent.forEach(f => L.push(`  [${f.severity}] ${f.name}：${f.excerpt}`));
            } else L.push('• 近期嚴重/錯誤 Log：無');
        } catch (error) {
            logRecoverableFailure('report.docker', error, { module: 'report.builder', function: 'appendDockerStatus', code: ERROR_CODES.EXT_NAS_MONITOR_FAILED });
            L.push('\n━━ 🐳 Docker 容器 ━━\n• 無法讀取 NAS Monitor');
        }
    }

    // ── UPS ──
    throwIfReportAborted(signal);
    try {
        const upsPoll = await sampleUpsIfDue(upsSampleMs());
        const ups = upsPoll.snapshot.lastGood;
        if (ups) {
            L.push('\n━━ 🔋 UPS ━━');
            if (upsPoll.snapshot.dataIsStale) {
                L.push(`• ⚠️ 即時讀取失敗，以下為 ${Math.round((upsPoll.snapshot.staleAgeMs || 0) / 1000)} 秒前的最後有效資料 (${upsPoll.snapshot.fetchHealth} ${upsPoll.snapshot.consecutiveFailures}/${upsPoll.snapshot.failureThreshold})`);
            }
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
        } else L.push(`\n━━ 🔋 UPS ━━\n• 無有效資料 (${upsPoll.snapshot.fetchHealth} ${upsPoll.snapshot.consecutiveFailures}/${upsPoll.snapshot.failureThreshold})`);
    } catch (error) {
        logRecoverableFailure('report.ups', error, { module: 'report.builder', function: 'appendUpsStatus', code: ERROR_CODES.EXT_UPS_FAILED });
    }

    // ── AdGuard DNS ──
    throwIfReportAborted(signal);
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
    throwIfReportAborted(signal);
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
    throwIfReportAborted(signal);
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
    throwIfReportAborted(signal);
    L.push('\n━━ ⚙️ 面板 ━━');
    try {
        const diag = await systemMonitor.ensureSample();
        L.push(`• 面板運行：${fmtDur(Math.round(process.uptime()))}　程序記憶體 ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
        L.push(`• 主機資源：CPU ${diag.cpu?.usage_percent ?? '--'}%／記憶體 ${diag.memory?.usage_percent ?? '--'}%／磁碟 ${diag.disk?.usage_percent ?? '--'}%`);
        L.push(`• SQLite：${diag.database?.status || '--'} ${diag.database?.latency_ms ?? '--'} ms；背景工作 ${diag.worker?.status || '--'}（失敗 ${diag.worker?.failed_tasks ?? 0}）`);
        const issues = diag.active_issues || [];
        if (issues.length) L.push(`• Active Issues：${issues.map(i => `[${i.severity}] ${i.code || i.message}`).join('、')}`);
        else L.push('• Active Issues：無');
    } catch {
        L.push(`• 面板運行：${fmtDur(Math.round(process.uptime()))}　記憶體 ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
    }
    throwIfReportAborted(signal);
    return L.join('\n') || '（無可彙整的資料）';
}

function reportDeliveryStatus(delivery) {
    if (delivery?.ok) return 'sent';
    if (delivery?.partial) return 'partial';
    if (delivery?.skipped) return `skipped:${delivery.skipped}`;
    return 'failed';
}
async function createReportRun(trigger, title) {
    let body;
    let delivery;
    try {
        body = await buildReport();
        delivery = await notify(title, body);
    } catch (error) {
        const ts = new Date().toISOString();
        const failureBody = `報表建立失敗：${publicError(error)}`;
        try {
            historyDb.insertReportRun({ ts, trigger, title, deliveryStatus: 'failed', deliveryError: publicError(error), body: failureBody });
        } catch (dbError) {
            logger.error({ module: 'report.audit', function: 'recordFailure', code: ERROR_CODES.DB_QUERY_FAILED, message: 'Could not persist failed report run', error: dbError });
        }
        throw error;
    }
    try {
        const ts = new Date().toISOString();
        const entry = {
            ts, trigger, title, body, deliveryStatus: reportDeliveryStatus(delivery),
            channel: delivery?.ok ? loadNotifSettings().channel : null, deliveryError: delivery?.error || null
        };
        historyDb.insertReportRun(entry);
    } catch (error) {
        logger.error({ module: 'report.audit', function: 'recordRun', code: ERROR_CODES.DB_QUERY_FAILED, message: 'Could not persist report run', error });
    }
    return { report: body, delivery };
}

const reportRunner = createReportRunner({
    db: historyDb,
    deriveDueReportSlot,
    getSettings: () => appSettings,
    buildReport: options => buildReport(options),
    deliver: async (title, body, options) => {
        const delivery = await notify(title, body, options);
        return delivery?.ok ? { ...delivery, channel: loadNotifSettings().channel } : delivery;
    },
    logger
});

// 立即產生報表 (預覽 + 若已啟用推播則送出)
app.post('/api/reports/run', async (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body), {
        module: 'api.reports', function: 'runNow'
    });
    if (!input) return;
    try { res.json(await createReportRun('manual', '📊 SmartHub 報表 (手動觸發)')); }
    catch (error) { apiError(res, error, { code: ERROR_CODES.API_INTERNAL_ERROR, module: 'api.reports', function: 'runNow', logMessage: 'Manual report generation failed' }); }
});
app.get('/api/reports/log', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseReportLogQuery(req.query), {
        module: 'api.reports', function: 'listRuns'
    });
    if (!query) return;
    res.json({ runs: historyDb.listReportRuns(query.limit) });
});

/* ===================== Telegram 指令中心 ===================== */
const fmtBotPct = value => value == null || !Number.isFinite(Number(value)) ? '--' : `${Number(value).toFixed(1)}%`;
const fmtBotBytes = value => {
    const bytes = Number(value) || 0;
    return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
};
async function telegramNetworkSummary() {
    const cookie = await getLocalSession();
    const [staRes, healthRes, wlanRes] = await Promise.all([
        unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { Cookie: cookie } }),
        unifiClient.get('/proxy/network/api/s/default/stat/health', { headers: { Cookie: cookie } }),
        unifiClient.get('/proxy/network/api/s/default/rest/wlanconf', { headers: { Cookie: cookie } }).catch(() => ({ data: { data: [] } }))
    ]);
    const clients = staRes.data.data || [];
    const wan = (healthRes.data.data || []).find(x => x.subsystem === 'www') || {};
    const wlans = wlanRes.data.data || [];
    return [
        '🌐 網路即時狀態',
        `• WAN：${wan.status === 'ok' ? '🟢 正常' : `⚠️ ${wan.status || '未知'}`} · 延遲 ${wan.latency ?? '--'} ms`,
        `• 線上設備：${clients.length} 台（有線 ${clients.filter(c => c.is_wired).length} / WiFi ${clients.filter(c => !c.is_wired).length}）`,
        `• WiFi：${wlans.filter(w => w.enabled).length}/${wlans.length} 個 SSID 啟用`,
        `• 累計流量：↓ ${fmtBotBytes(clients.reduce((n, c) => n + (c.rx_bytes || 0), 0))} / ↑ ${fmtBotBytes(clients.reduce((n, c) => n + (c.tx_bytes || 0), 0))}`,
        wan.xput_down != null ? `• 最近測速：↓ ${wan.xput_down} / ↑ ${wan.xput_up} Mbps · ping ${wan.speedtest_ping ?? '--'} ms` : '• 最近測速：無資料'
    ].join('\n');
}
async function telegramClientsSummary(args) {
    const cookie = await getLocalSession();
    let clients = (await unifiClient.get('/proxy/network/api/s/default/stat/sta', { headers: { Cookie: cookie } })).data.data || [];
    const query = args.join(' ').trim().toLowerCase();
    if (query) clients = clients.filter(c => `${clientAliases[String(c.mac || '').toLowerCase()] || ''} ${c.name || ''} ${c.hostname || ''} ${c.ip || ''} ${c.mac || ''}`.toLowerCase().includes(query));
    clients.sort((a, b) => ((b.rx_bytes || 0) + (b.tx_bytes || 0)) - ((a.rx_bytes || 0) + (a.tx_bytes || 0)));
    const lines = [`📱 ${query ? `設備搜尋「${query}」` : '線上設備 Top 15'} · ${clients.length} 台`];
    clients.slice(0, 15).forEach((c, i) => lines.push(`${i + 1}. ${clientAliases[String(c.mac || '').toLowerCase()] || c.name || c.hostname || c.mac}\n   ${c.ip || '--'} · ${c.is_wired ? '有線' : `WiFi ${c.rssi ?? '--'} dBm`} · ${fmtBotBytes((c.rx_bytes || 0) + (c.tx_bytes || 0))}`));
    if (!clients.length) lines.push('沒有符合的線上設備。');
    if (clients.length > 15) lines.push(`…其餘 ${clients.length - 15} 台請用 /clients 關鍵字縮小範圍`);
    return lines.join('\n');
}
async function telegramThreatSummary() {
    const cookie = await getLocalSession();
    const dayAgo = Date.now() - 86400000;
    const alarms = (await unifiClient.get('/proxy/network/api/s/default/list/alarm', { headers: { Cookie: cookie } })).data.data || [];
    const threats = alarms.filter(a => isIpsAlarm(a) && Number(a.time || Date.parse(a.datetime)) >= dayAgo);
    const lines = [`🛡️ 最近 24 小時威脅：${threats.length} 件`];
    threats.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.msg || t.key || '安全事件'}\n   ${t.src_ip || '?'} → ${t.dest_ip || '?'} · ${new Date(Number(t.time) || Date.parse(t.datetime)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`));
    if (!threats.length) lines.push('✅ 沒有偵測到威脅。');
    return lines.join('\n');
}
async function telegramNasSummary() {
    if (!nasConfigured()) return '💾 NAS 尚未設定。';
    const raw = await nasGet('/ugreen/v1/taskmgr/stat/get_all');
    const cpu = raw?.cpu?.series?.[0] || {};
    const mem = raw?.mem?.series?.[0] || {};
    const disks = (raw?.disk?.series || []).filter(d => d.name !== 'overview');
    return [
        '💾 NAS 即時狀態',
        `• CPU：${fmtBotPct(cpu.used_percent)} · ${cpu.temp ?? '--'}°C`,
        `• 記憶體：${fmtBotPct(mem.used_percent)}`,
        `• 硬碟：${disks.length ? disks.map(d => `${d.label || d.name} ${d.temperature ?? '--'}°C`).join('、') : '無資料'}`
    ].join('\n');
}
async function telegramDockerSummary(args) {
    if (!nasMonConfigured()) return '🐳 NAS Docker Monitor 尚未設定。';
    const data = await nasMonGet('/api/docker/containers');
    let containers = Array.isArray(data) ? data : (data.containers || data.data || []);
    const query = args.join(' ').trim().toLowerCase();
    if (query) containers = containers.filter(c => `${c.name || ''} ${c.id || ''}`.toLowerCase().includes(query));
    const lines = [`🐳 Docker 容器 · ${containers.filter(c => String(c.state).toLowerCase() === 'running').length}/${containers.length} 運行中`];
    containers.slice(0, 20).forEach(c => lines.push(`${String(c.state).toLowerCase() === 'running' ? '🟢' : '🔴'} ${c.name || c.id} · ${c.status || c.state || '--'} · CPU ${fmtBotPct(c.cpu_percent)} · RAM ${c.mem_usage_mb != null ? `${c.mem_usage_mb} MB` : '--'}`));
    if (!containers.length) lines.push('沒有符合的容器。');
    return lines.join('\n');
}
async function telegramUpsSummary() {
    const result = await sampleUpsIfDue(upsSampleMs());
    const ups = result.snapshot.lastGood;
    if (!ups) return `🔌 UPS 無法讀取 (${result.snapshot.fetchHealth} ${result.snapshot.consecutiveFailures}/${result.snapshot.failureThreshold})\n${result.snapshot.failureReason || upsLastReason}`;
    return [
        '🔋 UPS 即時狀態',
        result.snapshot.dataIsStale ? `• ⚠️ 最後有效資料已過 ${Math.round((result.snapshot.staleAgeMs || 0) / 1000)} 秒` : null,
        `• ${ups.onBattery ? '⚡ 電池供電中' : '🟢 市電正常'} · ${(ups.actualSource || ups.source || '').toUpperCase()}`,
        `• 電池 ${ups.battery ?? '--'}% · 負載 ${ups.loadPct ?? '--'}% · 續航 ${ups.runtimeSec == null ? '--' : `${Math.round(ups.runtimeSec / 60)} 分`}`,
        `• 輸入 ${ups.inputV ?? '--'}V · 輸出 ${ups.outputV ?? '--'}V`
    ].filter(Boolean).join('\n');
}
async function telegramWiimSummary() {
    const raw = await wiimGet('getPlayerStatus');
    if (!raw) return '🔊 WiiM 無法連線。';
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const labels = { play: '▶️ 播放中', pause: '⏸️ 暫停', stop: '⏹️ 停止', loading: '⏳ 載入中' };
    return ['🔊 WiiM 即時狀態', `• ${labels[status.status] || status.status || '未知'} · 音量 ${status.vol ?? '--'}%`, `• 靜音：${String(status.mute) === '1' ? '是' : '否'} · 模式 ${status.mode ?? '--'}`, status.Title || status.title ? `• 曲目：${status.Title || status.title}` : null].filter(Boolean).join('\n');
}

const telegramCommands = {
    help: { description: '顯示完整指令說明', run: async () => '' },
    status: { description: '產生完整 24 小時系統報表', run: async () => buildReport() },
    health: { description: '快速檢查 SmartHub 本身健康', run: async () => {
        const d = await systemMonitor.ensureSample();
        const issues = d.active_issues || [];
        return [`${issues.length ? '⚠️' : '✅'} SmartHub ${issues.length ? '需要注意' : '運作正常'}`, `• CPU ${d.cpu?.usage_percent ?? '--'}% · RAM ${d.memory?.usage_percent ?? '--'}% · Disk ${d.disk?.usage_percent ?? '--'}%`, `• SQLite ${d.database?.status || '--'} (${d.database?.latency_ms ?? '--'} ms)`, `• 背景工作 ${d.worker?.status || '--'} · 失敗 ${d.worker?.failed_tasks ?? 0}`, `• 運行時間 ${Math.round(process.uptime() / 60)} 分鐘`, issues.length ? `• Issues：${issues.slice(0, 5).map(i => `[${i.severity}] ${i.code || i.message}`).join('、')}` : '• Active Issues：無'].join('\n');
    } },
    network: { description: 'WAN、WiFi、設備與最近測速摘要', run: telegramNetworkSummary },
    clients: { description: '列出或搜尋線上設備', usage: '[名稱/IP/MAC]', run: telegramClientsSummary },
    threats: { description: '列出最近 24 小時安全威脅', run: telegramThreatSummary },
    nas: { description: '查看 NAS 即時負載與硬碟溫度', run: telegramNasSummary },
    docker: { description: '列出或搜尋 Docker 容器', usage: '[容器名稱]', run: telegramDockerSummary },
    ups: { description: '查看市電、電池、負載與續航', run: telegramUpsSummary },
    wiim: { description: '查看 WiiM 播放與音量', run: telegramWiimSummary },
    alerts: { description: '查看系統問題與近期推播', run: async () => {
        const d = await systemMonitor.ensureSample();
        const issues = d.active_issues || [];
        const lines = [`🚨 Active Issues：${issues.length} 件`];
        issues.slice(0, 10).forEach(i => lines.push(`• [${i.severity}] ${i.code || i.message}`));
        lines.push('', '🔔 最近推播：');
        notifLog.slice(0, 5).forEach(n => lines.push(`• ${n.ok ? '✅' : '❌'} ${n.title} · ${new Date(n.ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`));
        if (!issues.length) lines.splice(1, 0, '✅ 無待處理系統問題');
        if (!notifLog.length) lines.push('尚無紀錄');
        return lines.join('\n');
    } },
    speedtest: { description: '啟動 UniFi WAN 測速', mutating: true, prepare: async () => ({ confirmation: '即將啟動 WAN Speedtest，測試期間可能佔用頻寬。', execute: async () => {
        const cookie = await getLocalSession();
        await unifiClient.post('/proxy/network/api/s/default/cmd/devmgr', { cmd: 'speedtest' }, { headers: { Cookie: cookie } });
        return 'UniFi 已開始測速；稍後用 /network 查看結果。';
    } }) },
    docker_restart: { description: '重新啟動指定 Docker 容器', usage: '<容器名稱>', mutating: true, prepare: async args => {
        const query = args.join(' ').trim().toLowerCase();
        if (!query) throw new Error('用法：/docker_restart <容器名稱>');
        if (!nasMonConfigured()) throw new Error('NAS Docker Monitor 尚未設定');
        const data = await nasMonGet('/api/docker/containers');
        const containers = containersFromPayload(data);
        const exact = containers.filter(c => String(c.name || '').toLowerCase() === query || String(c.id || '').toLowerCase() === query);
        const matches = exact.length ? exact : containers.filter(c => String(c.name || '').toLowerCase().includes(query));
        if (matches.length !== 1) throw new Error(matches.length ? `找到 ${matches.length} 個容器，請輸入更完整名稱` : '找不到指定容器');
        const container = matches[0];
        const target = selectDockerActionTarget(data, container.id, 'restart', { allowLegacy: allowLegacyNasMonActions() });
        return { confirmation: `即將重新啟動 Docker 容器「${target.name}」。`, execute: async () => {
            try { await nasMonClient.post(`/api/docker/containers/${encodeURIComponent(target.id)}/restart`); }
            catch (error) {
                if (ambiguousDockerActionResult(error, 'restart')) {
                    throw new Error('重啟結果不明；請先重新整理容器狀態，不要直接重試');
                }
                throw error;
            }
            return `${target.name} 已送出重新啟動指令。`;
        } };
    } },
    wiim_toggle: { description: '切換 WiiM 播放/暫停', mutating: true, prepare: async () => ({ confirmation: '即將切換 WiiM 播放/暫停狀態。', execute: async () => { if (!await wiimGet('setPlayerCmd:onepause')) throw new Error('WiiM 無回應'); return 'WiiM 播放狀態已切換。'; } }) },
    wiim_stop: { description: '停止 WiiM 播放', mutating: true, prepare: async () => ({ confirmation: '即將停止 WiiM 播放。', execute: async () => { if (!await wiimGet('setPlayerCmd:stop')) throw new Error('WiiM 無回應'); return 'WiiM 已停止播放。'; } }) },
    wiim_volume: { description: '設定 WiiM 音量', usage: '<0-100>', mutating: true, prepare: async args => {
        const volume = Number(args[0]);
        if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('用法：/wiim_volume <0-100>');
        return { confirmation: `即將把 WiiM 音量設為 ${volume}%${volume >= 80 ? '（高音量）' : ''}。`, execute: async () => { if (!await wiimGet(`setPlayerCmd:vol:${volume}`)) throw new Error('WiiM 無回應'); return `WiiM 音量已設為 ${volume}%。`; } };
    } }
};
const telegramCommandBot = new TelegramCommandBot({ axios, getSettings: loadNotifSettings, commands: telegramCommands, logger, formatError: publicError });

/* ===================== PWA (manifest + service worker) ===================== */
const PWA_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#0b1220"/><g fill="none" stroke="#3b82f6" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><path d="M96 40L44 66l52 26 52-26-52-26z"/><path d="M44 126l52 26 52-26M44 96l52 26 52-26"/></g></svg>');
const PWA_CACHE_NAME = `smarthub-shell-${buildIdentity.public.revision === 'unknown' ? APP_VERSION : buildIdentity.public.revision}`;
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
    res.type('application/javascript').send(renderPwaServiceWorker(PWA_CACHE_NAME));
});

// --- WiiM Amp Integration Endpoints & Background Polling ---
let wiimIP = process.env.WIIM_IP || '192.168.0.170'; // let：連線設定頁可熱更新
const wiimCache = {};

async function wiimGet(command, { refresh = false, allowStale = false } = {}) {
    const cacheKey = command;
    const now = Date.now();
    const isCacheable = ['getPlayerStatus', 'getMetaInfo', 'getStatusEx', 'getPresetInfo', 'getbtdiscoveryresult'].includes(command);

    if (isCacheable && !refresh && wiimCache[cacheKey] && (allowStale || now - wiimCache[cacheKey].timestamp < generalCollectorCacheAgeMs())) {
        sysLog('WiiM Proxy', `命中裝置 collector 快取，直接返回快取。命令: ${command}`);
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
    const raw = await wiimGet('getStatusEx', { refresh: true });
    const notificationSettings = loadNotifSettings();
    if (notificationSettings.enabled && (notificationSettings.triggerWiimHighVolume || notificationSettings.triggerWiimPlaybackChange)) {
        try { await wiimGet('getPlayerStatus', { refresh: true }); }
        catch (error) { logRecoverableFailure('sampler.wiim.player', error, { module: 'scheduler.wiim', function: 'samplePlayerStatus', code: ERROR_CODES.EXT_WIIM_FAILED }); }
    }
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
registerBackendSampler('wiimTemperature', pollWiimTemp, normalDeviceSampleMs);

app.get('/api/wiim/history', (req, res) => {
    res.json({
        interval: 10,
        cpu_alert: appSettings.wiimCpuAlert ?? 70,
        board_alert: appSettings.wiimBoardAlert ?? 60,
        data: historyDb.getSince('wiim', 0)
    });
});

app.get('/api/wiim/status', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseWiimStatusQuery(req.query), {
        module: 'api.wiim', function: 'getStatus'
    });
    if (!query) return;
    const { type } = query;
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

registerWiimCommandRoutes(app, {
    execute: command => wiimGet(command),
    onUnexpectedError: (error, _req, res) => apiError(res, error, {
        status: 502, code: ERROR_CODES.EXT_WIIM_FAILED, publicMessage: 'WiiM command transport failed',
        module: 'api.wiim', function: 'command', logMessage: 'WiiM command transport failed'
    })
});

// 專輯封面代理只接受公開 HTTP(S) 圖片；僅目前 WiiM 的精確位址可走私有網段。
const wiimArtCache = createArtworkCache();
app.get('/api/wiim/art', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseWiimArtQuery(req.query), {
        module: 'api.wiim', function: 'getAlbumArt'
    });
    if (!query) return;
    const { u } = query;
    // AirPlay 的封面 URI 固定不變、內容隨曲目更換 → 以前端傳來的曲名 (v) 作為快取版本鍵
    const key = u + '|' + query.v;
    const hit = wiimArtCache.get(key);
    if (hit) {
        res.set('Content-Type', hit.type); return res.send(hit.buffer);
    }
    try {
        const image = await fetchArtwork(u, { axiosInstance: axios, allowedPrivateAddresses: [wiimIP] });
        wiimArtCache.set(key, image);
        res.set('Content-Type', image.type); res.send(image.buffer);
    } catch (e) {
        sysLog('WiiM Art', `封面抓取失敗: ${e.message}`, true);
        res.status(502).end();
    }
});

app.delete('/api/wiim/history', (req, res) => {
    const input = validatedInput(res, () => writeInput.parseEmptyBody(req.body), {
        module: 'api.wiim', function: 'deleteHistory'
    });
    if (!input) return;
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
// 架構（詳見 docs/integrations/cyberpower-ups-api.md）：UPS_SOURCE=auto|nut|pwrstat|pmset|ppb
//   1) NUT:     upsc <NUT_UPS_NAME>@<NUT_HOST>       ← 建議方案 (brew install nut)
//   2) pwrstat: /bin/pwrstat -status                  ← 官方 PowerPanel CLI
//   3) pmset:   pmset -g ps                           ← macOS 原生 (僅容量/充電狀態，無電壓)
// 電壓歷史與斷電事件持久化於 SQLite (斷電紀錄不可因重啟遺失)。
// 呼叫時讀取 env，設定頁修改後即時生效
const UPS_SOURCE = () => process.env.UPS_SOURCE || 'auto';
const NUT_HOST = () => process.env.NUT_HOST || 'localhost';
const NUT_UPS_NAME = () => process.env.NUT_UPS_NAME || 'cyberpower';
const PWRSTAT_PATH = () => process.env.PWRSTAT_PATH || 'pwrstat';
const upsFetchState = createUpsState(); // 預設連續 3 次全來源失敗才確認 offline
let upsPollInFlight = null;
let upsLastLive = null;     // 最近一次成功讀取；失敗時保留，避免瞬斷抹除最後有效資料
// 重啟接續：若最新事件尚未結束 (重啟前正在斷電)，視為仍在電池供電，
// 下次取樣時若市電已恢復會正常補上結束時間，不會再開一筆重複事件
let upsWasOnBattery = !!historyDb.getOpenUpsEvent();

function execProgram(file, args, timeoutMs = 5000) {
    return new Promise(resolve => execFile(file, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout)));
}

// parseFloat(x) || null 會把合法的 0 (電池 0%、負載 0%) 誤判為 null，改用 finite 檢查
function numOrNull(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

// --- 來源 1: NUT (upsc key: value 格式) ---
async function readNut() {
    const out = await execProgram('upsc', [`${NUT_UPS_NAME()}@${NUT_HOST()}`]);
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
    const out = await execProgram(PWRSTAT_PATH(), ['-status']);
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
let ppbEventSyncInFlight = null;
let lastPpbEventSyncTs = 0;
let lastPpbEventSyncAttemptTs = 0;
let ppbEventSyncInitialized = historyDb.listUpsPowerEvents(1).length > 0;

function ppbConfigured() {
    return !!(process.env.PPB_USER && process.env.PPB_PASSWORD);
}

async function syncPpbEvents() {
    if (ppbEventSyncInFlight) return ppbEventSyncInFlight;
    const sync = (async () => {
        lastPpbEventSyncAttemptTs = Date.now();
        const raw = await ppbGet('/local/rest/v1/eventlogs/report');
        const normalized = (Array.isArray(raw) ? raw : [])
            .map(event => normalizePpbEvent(event, {
                translate: description => ppbZhMap[description.trim()] || description
            }))
            .filter(Boolean);
        const created = [];
        for (const event of normalized) {
            const result = historyDb.recordUpsPowerEvent(event);
            if (result.created && result.event) created.push({ ...result.event, sag: event.sag });
        }
        const shouldNotify = ppbEventSyncInitialized;
        ppbEventSyncInitialized = true;
        lastPpbEventSyncTs = Date.now();
        const settings = loadNotifSettings();
        if (shouldNotify && settings.enabled && settings.triggerUpsSag !== false) {
            for (const event of created.filter(item => item.sag).slice(0, 3)) {
                await notify('⚠️ UPS 原廠記錄到市電壓降', event.description);
            }
        }
        return { created: created.length, events: historyDb.listUpsPowerEvents(200) };
    })();
    ppbEventSyncInFlight = sync;
    try { return await sync; }
    finally { if (ppbEventSyncInFlight === sync) ppbEventSyncInFlight = null; }
}

async function syncPpbEventsIfDue(maxAgeMs) {
    if (lastPpbEventSyncAttemptTs && Date.now() - lastPpbEventSyncAttemptTs < maxAgeMs) {
        return { created: 0, events: historyDb.listUpsPowerEvents(200), cached: true };
    }
    return { ...await syncPpbEvents(), cached: false };
}

app.get('/api/ups/ppb-events', async (req, res) => {
    try {
        const result = ppbConfigured()
            ? await syncPpbEventsIfDue(ppbEventSyncMs())
            : { events: historyDb.listUpsPowerEvents(200), cached: true };
        const events = result.events.map(event => ({
            id: event.externalId,
            ts: event.eventTs ? new Date(event.eventTs).toISOString() : new Date(event.observedTs).toISOString(),
            desc: event.description,
            level: event.severity,
            source: event.source,
            type: event.type,
            inputV: event.inputV
        }));
        res.json({ events, source: ppbConfigured() ? 'ppb' : 'local', ppbConfigured: ppbConfigured(), cached: result.cached, syncedAt: lastPpbEventSyncTs || null });
    } catch (error) {
        apiError(res, error, { code: ERROR_CODES.EXT_UPS_FAILED, module: 'api.ups', function: 'getPpbEvents', logMessage: 'Failed to fetch PowerPanel events' });
    }
});

// --- 來源 3: pmset (macOS 原生，資訊有限) ---
async function readPmset() {
    const out = await execProgram('pmset', ['-g', 'ps']);
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

const UPS_OFFLINE_ISSUE_ID = 'ups-fetch-offline';

function observeUpsFetchHealth(outcome) {
    const { snapshot } = outcome;
    if (snapshot.fetchHealth === FETCH_HEALTH.OFFLINE) {
        const tracked = issueTracker.report({
            id: UPS_OFFLINE_ISSUE_ID,
            severity: 'warning',
            code: ERROR_CODES.EXT_UPS_FAILED,
            message: 'UPS monitoring sources are confirmed offline',
            details: {
                consecutive_failures: snapshot.consecutiveFailures,
                failure_threshold: snapshot.failureThreshold,
                last_success_at: snapshot.lastSuccessAt,
                stale_age_ms: snapshot.staleAgeMs
            }
        });
        if (tracked.shouldLog) logger.warning({
            module: 'ups.poller', function: 'pollUpsFetchState', code: ERROR_CODES.EXT_UPS_FAILED,
            message: 'UPS monitoring sources are confirmed offline',
            fields: {
                consecutive_failures: snapshot.consecutiveFailures,
                failure_threshold: snapshot.failureThreshold,
                stale_age_ms: snapshot.staleAgeMs,
                occurrences: tracked.issue.occurrences
            }
        });
        return;
    }

    if (snapshot.fetchHealth === FETCH_HEALTH.HEALTHY) {
        const resolved = issueTracker.resolve(UPS_OFFLINE_ISSUE_ID);
        if (resolved) logger.info({
            module: 'ups.poller', function: 'pollUpsFetchState', code: ERROR_CODES.EXT_UPS_FAILED,
            message: 'UPS monitoring source recovered',
            fields: { duration_seconds: resolved.duration_seconds, source: snapshot.lastGood?.actualSource || null }
        });
    }
}

async function notifyUpsFetchTransitions(outcome) {
    if (!outcome.transitions.length) return;
    const settings = loadNotifSettings();
    if (!settings.enabled || settings.triggerUpsOffline === false) return;

    for (const transition of outcome.transitions) {
        if (transition.type === TRANSITION_TYPES.OFFLINE) {
            await notify('🔌 UPS 監控完全失聯', outcome.snapshot.failureReason || 'PPB / NUT / pwrstat / pmset 所有資料來源皆無法讀取');
        } else if (transition.type === TRANSITION_TYPES.RECOVERED) {
            const live = outcome.snapshot.lastGood;
            await notify('✅ UPS 監控已恢復', `資料來源 ${(live?.actualSource || 'unknown').toUpperCase()} · 電池 ${live?.battery ?? '--'}%`);
        }
    }
}

// 所有 UPS 即時讀取共用同一個 in-flight poll；狀態轉移與通知也只在此處處理一次。
async function pollUpsFetchState() {
    if (upsPollInFlight) return upsPollInFlight;

    const poll = (async () => {
        let live = null;
        try {
            live = await readUpsLive();
        } catch (error) {
            upsLastReason = `UPS 輪詢失敗：${publicError(error)}`;
            logRecoverableFailure('ups.poll', error, {
                module: 'ups.poller', function: 'pollUpsFetchState', code: ERROR_CODES.EXT_UPS_FAILED
            });
        }

        let outcome;
        if (live) {
            const fresh = { ...live, ts: Date.now() };
            outcome = upsFetchState.recordSuccess(fresh);
            upsLastLive = outcome.snapshot.lastGood;
            live = outcome.snapshot.lastGood;
        } else {
            outcome = upsFetchState.recordFailure(upsLastReason || 'all UPS sources failed');
        }

        observeUpsFetchHealth(outcome);
        await notifyUpsFetchTransitions(outcome);
        return { live, snapshot: outcome.snapshot, transitions: outcome.transitions };
    })();

    upsPollInFlight = poll;
    try { return await poll; }
    finally { if (upsPollInFlight === poll) upsPollInFlight = null; }
}

function lastUpsAttemptAt(snapshot) {
    return Math.max(snapshot.lastSuccessAt || 0, snapshot.lastFailureAt || 0);
}

function upsStatusPayload(snapshot, { cached = false } = {}) {
    const lastGood = snapshot.lastGood ? { ...snapshot.lastGood } : null;
    const payload = lastGood || {};
    return {
        ...payload,
        // 保留 last-good 數值，但 confirmed offline 時維持既有 source 契約，讓舊 UI 不會誤亮綠燈。
        source: snapshot.fetchHealth === FETCH_HEALTH.OFFLINE || !lastGood ? 'unreachable' : lastGood.source,
        lastKnown: snapshot.dataIsStale ? lastGood : undefined,
        cached,
        sampleSec: isDeviceSamplingActive('ups') ? appSettings.upsActiveBackendSampleSec : appSettings.upsIdleBackendSampleSec,
        focusedSampling: isDeviceSamplingActive('ups'),
        fetchHealth: snapshot.fetchHealth,
        consecutiveFailures: snapshot.consecutiveFailures,
        failureThreshold: snapshot.failureThreshold,
        staleAgeMs: snapshot.staleAgeMs,
        dataIsStale: snapshot.dataIsStale,
        lastSuccessAt: snapshot.lastSuccessAt,
        lastFailureAt: snapshot.lastFailureAt,
        offlineSince: snapshot.offlineSince,
        failureReason: snapshot.failureReason,
        reason: snapshot.failureReason || undefined
    };
}

let upsSagDetector = null;
let upsSagDetectorThreshold = null;
let upsSampleInFlight = null;

function currentUpsSagDetector(settings) {
    const threshold = settings.upsSagThresholdV ?? DEFAULT_SAG_THRESHOLD_V;
    if (!upsSagDetector || upsSagDetectorThreshold !== threshold) {
        upsSagDetector = createUpsSagDetector({ thresholdV: threshold });
        upsSagDetectorThreshold = threshold;
    }
    return upsSagDetector;
}

function persistLocalUpsPowerEvent(event, live) {
    const isStart = event.type === 'sag_started';
    const occurredAt = isStart ? event.at : event.startedAt;
    return historyDb.recordUpsPowerEvent({
        source: live.actualSource || live.source || 'ups',
        externalId: `${event.type}:${occurredAt}`,
        type: isStart ? 'voltage_sag' : 'voltage_recovered',
        eventTs: event.at,
        observedTs: Date.now(),
        inputV: isStart ? event.inputV : event.minimumV,
        severity: isStart ? 'warning' : 'ok',
        description: isStart
            ? `市電輸入瞬間降至 ${event.inputV}V（門檻 ${event.thresholdV}V）`
            : `市電輸入恢復至 ${event.inputV}V；最低 ${event.minimumV}V，持續約 ${(event.durationMs / 1000).toFixed(1)} 秒`
    });
}

// 取樣 + 電力品質/斷電事件偵測 (皆持久化)
async function performUpsSample() {
    const { live, snapshot } = await pollUpsFetchState();
    if (!live) {
        sysLog('UPS', `本次取樣失敗 (${snapshot.fetchHealth} ${snapshot.consecutiveFailures}/${snapshot.failureThreshold})，保留最後有效資料`, true);
        return snapshot;
    }

    // 只有本次實際讀取成功的 fresh sample 可寫歷史、驅動斷電事件與告警。
    historyDb.insertPoint('ups', {
        t: new Date().toISOString(), inV: live.inputV, outV: live.outputV,
        batt: live.battery, load: live.loadPct, rt: live.runtimeSec, ob: live.onBattery ? 1 : 0
    }, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });

    const notificationSettings = loadNotifSettings();
    const sagEvent = currentUpsSagDetector(notificationSettings).observe(live);
    if (sagEvent.type) {
        const stored = persistLocalUpsPowerEvent(sagEvent, live);
        if (stored.created && sagEvent.type === 'sag_started') {
            historyDb.flush();
            sysLog('UPS', `⚠️ 偵測到市電瞬間壓降：${sagEvent.inputV}V（門檻 ${sagEvent.thresholdV}V）`, true);
            if (notificationSettings.enabled && notificationSettings.triggerUpsSag !== false) {
                await notify('⚠️ 偵測到市電瞬間壓降', `輸入電壓降至 ${sagEvent.inputV}V（警示門檻 ${sagEvent.thresholdV}V）`);
            }
        } else if (stored.created && sagEvent.type === 'sag_recovered') {
            sysLog('UPS', `✅ 市電電壓恢復：${sagEvent.inputV}V（最低 ${sagEvent.minimumV}V）`);
        }
    }

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
    // 預估續航過低：只在市電中斷、確實由電池供電時提示，避免正常待機數值誤報。
    if (ns2.enabled && ns2.triggerUpsLowRuntime && live.onBattery && live.runtimeSec != null
        && live.runtimeSec <= (ns2.upsRuntimeAlertMin ?? 10) * 60 && Date.now() - lastUpsLowRuntimeTs > 15 * 60 * 1000) {
        lastUpsLowRuntimeTs = Date.now();
        await notify('⏳ UPS 預估續航不足', `預估僅剩 ${Math.max(0, Math.round(live.runtimeSec / 60))} 分鐘 (門檻 ${ns2.upsRuntimeAlertMin ?? 10} 分鐘)，請準備安全關機`);
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
    return snapshot;
}

async function sampleUps() {
    if (upsSampleInFlight) return upsSampleInFlight;
    const sample = performUpsSample();
    upsSampleInFlight = sample;
    try { return await sample; }
    finally { if (upsSampleInFlight === sample) upsSampleInFlight = null; }
}

async function sampleUpsIfDue(maxAgeMs) {
    const before = upsFetchState.snapshot();
    const lastAttemptAt = lastUpsAttemptAt(before);
    if (lastAttemptAt && Date.now() - lastAttemptAt < maxAgeMs) {
        return { snapshot: before, polled: false };
    }
    return { snapshot: await sampleUps(), polled: true };
}
let lastUpsHighLoadTs = 0, lastUpsLowRuntimeTs = 0, lastUpsVoltAbnormalTs = 0, lastUpsSource = null;
let upsLowBattNotified = false;
registerBackendSampler('upsSample', () => sampleUpsIfDue(upsSampleMs()), upsSampleMs);
registerBackendSampler('ppbEventSync', async () => {
    if (ppbConfigured()) await syncPpbEventsIfDue(ppbEventSyncMs());
}, ppbEventSyncMs);

app.get('/api/ups/status', async (req, res) => {
    const result = await sampleUpsIfDue(upsSampleMs());
    res.json(upsStatusPayload(result.snapshot, { cached: !result.polled }));
});

app.get('/api/ups/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.ups', function: 'listHistory'
    });
    if (!query) return;
    const cutoff = Date.now() - query.hours * 3600000;
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
function buildAdguardConnection() {
    try {
        return { ...createAdGuardConnection({ env: process.env, axios }), configurationError: null };
    } catch (error) {
        logger.warning({
            module: 'integration.adguard', function: 'configure', code: ERROR_CODES.SYS_CONFIG_INVALID,
            message: 'AdGuard integration configuration rejected',
            fields: { error_code: error?.code || 'ADGUARD_CONFIG_INVALID' }
        });
        return { url: null, client: null, configured: false, tlsVerified: false, configurationError: true };
    }
}
let adguardConnection = buildAdguardConnection();
const adgConfigured = () => adguardConnection.configured;
let adgLastOkTs = 0;
async function adgReq(pathName, method = 'get', data, params) {
    if (!adguardConnection.client) throw new Error('AdGuard is not configured');
    const result = await adguardConnection.client.request(pathName, { method, data, params });
    adgLastOkTs = Date.now();
    return result;
}
function getAdguardOverviewCached(options) {
    return readDeviceCollector('adguard.overview', async () => {
        const [status, stats] = await Promise.all([adgReq('/control/status'), adgReq('/control/stats')]);
        return { status, stats };
    }, options);
}
// 總覽：狀態 + 統計 (查詢數/攔截數/Top 網域/Top 客戶端)
app.get('/api/adguard/overview', async (req, res) => {
    if (!adgConfigured()) {
        return res.json({ source: adguardConnection.configurationError ? 'configuration_error' : 'not_configured' });
    }
    try {
        const { status, stats } = await getAdguardOverviewCached();
        res.json({ status, stats, source: 'adguard' });
    } catch (e) {
        logRecoverableFailure('adguard.overview', e, { module: 'api.adguard', function: 'getOverview', code: ERROR_CODES.EXT_ADGUARD_FAILED });
        res.json({ source: 'error', error: publicError(e) });
    }
});
// 即時查詢日誌 (簡化欄位)
app.get('/api/adguard/querylog', async (req, res) => {
    const query = validatedInput(res, () => queryInput.parseAdGuardQueryLogQuery(req.query), {
        module: 'api.adguard', function: 'getQueryLog'
    });
    if (!query) return;
    if (!adgConfigured()) return res.json({ entries: [], source: 'not_configured' });
    try {
        const d = await adgReq('/control/querylog', 'get', undefined, {
            limit: query.limit,
            ...(query.filtered ? { response_status: 'filtered' } : {})
        });
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
    const input = validatedInput(res, () => writeInput.parseSingleBoolean(req.body, 'enabled'), {
        module: 'api.adguard', function: 'setProtection'
    });
    if (!input) return;
    if (!adgConfigured()) return apiError(res, new Error('AdGuard is not configured'), {
        status: 503, code: ERROR_CODES.SYS_CONFIG_INVALID, publicMessage: 'not_configured', module: 'api.adguard', function: 'setProtection'
    });
    try {
        await adgReq('/control/protection', 'post', { enabled: input.enabled });
        res.json({ ok: true, enabled: input.enabled });
    } catch (e) { apiError(res, e, { code: ERROR_CODES.EXT_ADGUARD_FAILED, module: 'api.adguard', function: 'setProtection', logMessage: 'Failed to update AdGuard protection' }); }
});

app.get('/api/adguard/service-policies', panelSecurity.requireAdmin, (_req, res) => {
    res.json(adguardServicePolicyService.snapshot());
});

app.post('/api/adguard/service-policies', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => adguardServicePolicy.parsePolicyRequest(req.body), {
        module: 'api.adguardPolicy', function: 'upsert'
    });
    if (!input) return;
    try {
        const result = await adguardServicePolicyService.upsert(input);
        res.status(result.applied ? (result.created ? 201 : 200) : 202).json(result);
    } catch (error) {
        const expected = error instanceof AdGuardServicePolicyError;
        apiError(res, error, {
            status: expected ? error.httpStatus : 500,
            code: expected ? ERROR_CODES.SYS_CONFIG_INVALID : ERROR_CODES.EXT_ADGUARD_FAILED,
            publicMessage: expected ? error.message : 'AdGuard service policy request failed',
            module: 'api.adguardPolicy', function: 'upsert', logMessage: 'AdGuard service policy request failed'
        });
    }
});

app.delete('/api/adguard/service-policies/:id', panelSecurity.requireAdmin, async (req, res) => {
    const input = validatedInput(res, () => adguardServicePolicy.parsePolicyRemoval(req.params.id, req.body), {
        module: 'api.adguardPolicy', function: 'remove'
    });
    if (!input) return;
    try {
        const result = await adguardServicePolicyService.remove(input.id);
        res.status(result.applied ? 200 : 202).json(result);
    } catch (error) {
        const expected = error instanceof AdGuardServicePolicyError;
        apiError(res, error, {
            status: expected ? error.httpStatus : 500,
            code: expected && error.httpStatus === 404 ? ERROR_CODES.API_NOT_FOUND : ERROR_CODES.EXT_ADGUARD_FAILED,
            publicMessage: expected ? error.message : 'AdGuard service policy removal failed',
            module: 'api.adguardPolicy', function: 'remove', logMessage: 'AdGuard service policy removal failed'
        });
    }
});

/* ===================== Linux 小主機監控 (SSH，比照 UCG 模式) ===================== */
const linuxConfigured = () => !!(process.env.LINUX_HOST && process.env.LINUX_SSH_USER && !isPlaceholder(process.env.LINUX_SSH_PASSWORD));
const LINUX_CMD = [
    'hostname', 'cat /proc/uptime', 'free -m', 'df -m /', 'cat /proc/loadavg',
    'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null',
    'cat /proc/stat', 'sleep 1; cat /proc/stat'
].join('; echo __S__; ');
const linuxSshPool = createSshConnectionPool({
    getConfig: () => ({
        host: process.env.LINUX_HOST,
        port: parseInt(process.env.LINUX_SSH_PORT || '22', 10),
        username: process.env.LINUX_SSH_USER,
        password: process.env.LINUX_SSH_PASSWORD
    })
});
async function fetchLinuxSSH() {
    let out;
    try { out = await linuxSshPool.execute(LINUX_CMD); }
    catch (error) { throw new Error(`SSH exec failed: ${error.code || error.message}`, { cause: error }); }
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
                    return {
                            hostname, cpuUsage,
                            cpuTemp: temps.length ? Math.round(Math.max(...temps)) : null,
                            memUsagePct: memTotal ? Math.round(memUsed / memTotal * 100) : 0,
                            memStr: `${(memUsed / 1024).toFixed(2)} / ${(memTotal / 1024).toFixed(2)} GB`,
                            diskUsagePct: dm ? +dm[3] : null,
                            diskStr: dm ? `${(+dm[2] / 1024).toFixed(1)} / ${(+dm[1] / 1024).toFixed(1)} GB` : '--',
                            load,
                            uptime: isNaN(upSec) ? '--' : `up ${Math.floor(upSec / 86400)}d ${Math.floor((upSec % 86400) / 3600)}h`,
                            dataSource: 'real'
                    };
    } catch (error) { throw new Error('parse failed: ' + error.message, { cause: error }); }
}
async function getLinuxCached({ refresh = false, allowStale = false } = {}) {
    return readDeviceCollector('linux.stats', fetchLinuxSSH, { refresh, allowStale });
}
app.get('/api/linux/stats', async (req, res) => {
    if (!linuxConfigured()) return res.json({ source: 'not_configured' });
    try { res.json({ ...(await getLinuxCached()), source: 'ssh' }); }
    catch (e) {
        logRecoverableFailure('linux.stats', e, { module: 'api.linux', function: 'getStats', code: ERROR_CODES.EXT_LINUX_FAILED });
        res.json({ source: 'error', error: publicError(e) });
    }
});
async function sampleLinuxHistory() {
    if (!linuxConfigured()) return;
    const d = await getLinuxCached({ refresh: true });
    historyDb.insertPoint('linux', {
        t: new Date().toISOString(), cpu: d.cpuUsage, temp: d.cpuTemp,
        mem: d.memUsagePct, load: d.load && d.load[0]
    }, { keepDays: appSettings.historyKeepDays, hardCap: HISTORY_HARD_CAP });
}
registerBackendSampler('linuxHistory', sampleLinuxHistory, normalDeviceSampleMs);
app.get('/api/linux/history', (req, res) => {
    const query = validatedInput(res, () => queryInput.parseHistoryHoursQuery(req.query), {
        module: 'api.linux', function: 'listHistory'
    });
    if (!query) return;
    res.json({ data: historyDb.getSince('linux', Date.now() - query.hours * 3600000) });
});

/* ===================== 連線狀態一覽 (設定頁 📡 面板) =====================
   原本前端從側邊欄徽章 DOM 推斷，時常不準；改由後端記憶體現況直接彙整。 */
let cloudLastCheckTs = 0, cloudLastOk = null;
async function checkCloudStatus() {
    if (!cloudConfigured()) return { configured: false, ok: null, detail: '' };
    const health = await getCloudHealthCached();
    cloudLastCheckTs = Date.now();
    cloudLastOk = health.ok;
    return { configured: true, ok: cloudLastOk, detail: cloudLastOk ? '連線正常' : '連線失敗 (API Key 無效或被限流)' };
}
app.get('/api/connections/status', async (req, res) => {
    const fresh = (ts, sec) => ts && (Date.now() - ts) < sec * 1000;
    const wiimHit = wiimCache['getStatusEx'];
    const cloud = await checkCloudStatus();
    const threatBlocks = threatIpBlockingService.snapshot();
    const adguardPolicies = adguardServicePolicyService.snapshot();
    const upsSnapshot = upsFetchState.snapshot();
    const upsDetail = upsSnapshot.lastGood
        ? `${(upsSnapshot.lastGood.actualSource || '').toUpperCase()} · 電池 ${upsSnapshot.lastGood.battery ?? '--'}%${upsSnapshot.dataIsStale ? ` · 資料已過 ${Math.round((upsSnapshot.staleAgeMs || 0) / 1000)} 秒` : ''}`
        : (upsSnapshot.failureReason ? `尚無有效資料 · ${upsSnapshot.fetchHealth} ${upsSnapshot.consecutiveFailures}/${upsSnapshot.failureThreshold}` : '尚無資料');
    const hardwareSnapshot = deviceCollectorSnapshot('ucg.hardware');
    const thermalTelemetry = latestDeviceCollector('unifi.networkDevices') || [];
    const thermal = presentUnifiDeviceTelemetrySnapshot(thermalTelemetry, deviceCollectorSnapshot('unifi.networkDevices')?.lastSuccessAt).thermalSsh;
    res.json({
        devices: [
            { name: 'UCG-Ultra (SSH)', configured: !isPlaceholder(process.env.SSH_PASSWORD) && !!process.env.UCG_IP, ok: hardwareSnapshot?.lastErrorAt ? false : fresh(hardwareSnapshot?.lastSuccessAt, 120), detail: hardwareSnapshot?.data ? `CPU ${hardwareSnapshot.data.cpuTemp}°C / ${hardwareSnapshot.data.cpuUsage}%` : '尚無資料' },
            { name: 'UniFi 控制器', configured: !isPlaceholder(process.env.UNIFI_USERNAME), ok: !!localCookie && Date.now() < cookieExpiry, detail: localCookie ? 'Session 有效' : '未登入' },
            { name: 'UniFi 裝置 SSH 溫度', configured: thermal.configured, ok: thermal.configured ? (thermal.failedDeviceCount ? false : (thermal.successfulDeviceCount ? true : null)) : null, detail: thermal.configured ? `選取 ${thermal.selectedDeviceCount} 台 · 成功 ${thermal.successfulDeviceCount} 台` : '尚未設定設備 SSH 帳密' },
            { name: 'Site Manager 雲端', configured: cloud.configured, ok: cloud.ok, detail: cloud.detail },
            { name: 'UniFi 威脅封鎖', configured: threatBlocks.configuration.configured, ok: threatBlocks.reconcile.status === 'healthy' ? true : null, detail: threatBlocks.configuration.configured ? threatBlocks.reconcile.status : '尚未設定 Integration API' },
            { name: 'UGREEN NAS', configured: nasConfigured(), ok: !!nasToken && Date.now() < nasTokenExpiry, detail: nasToken ? 'Token 有效' : '未登入' },
            { name: 'NAS Monitor (系統B)', configured: nasMonConfigured(), ok: null, detail: nasMonConfigured() ? (nasMonAdvancedConfigured() ? '完整模式' : 'Docker only') : '' },
            { name: 'WiiM Amp', configured: true, ok: fresh(wiimHit && wiimHit.timestamp, 120), detail: wiimHit ? '有回應' : '無快取' },
            { name: 'CyberPower UPS', configured: true, ok: upsSnapshot.fetchHealth === FETCH_HEALTH.OFFLINE ? false : (upsSnapshot.fetchHealth === FETCH_HEALTH.HEALTHY ? !!fresh(upsSnapshot.lastSuccessAt, 180) : null), detail: upsDetail },
            { name: 'AdGuard Home', configured: adgConfigured(), ok: fresh(adgLastOkTs, 180), detail: adgLastOkTs ? '有回應' : '尚無資料' },
            { name: 'AdGuard 裝置政策', configured: adguardPolicies.policies.length > 0, ok: adguardPolicies.reconcile.status === 'healthy' ? true : (adguardPolicies.reconcile.status === 'degraded' ? false : null), detail: `${adguardPolicies.policies.length} 筆 · ${adguardPolicies.reconcile.status}` },
            { name: 'Linux 小主機', configured: linuxConfigured(), ok: (() => { const snapshot = deviceCollectorSnapshot('linux.stats'); return snapshot?.lastErrorAt ? false : fresh(snapshot?.lastSuccessAt, 180); })(), detail: (() => { const data = deviceCollectorSnapshot('linux.stats')?.data; return data ? `${data.hostname} · ${data.cpuTemp ?? '--'}°C` : '尚無資料'; })() }
        ]
    });
});

// 匿名登入頁只讀取這份由既有排程壓縮的記憶體摘要。這裡不做任何
// Ping、SSH、設備 API 或歷史資料聚合，也不保留節點名稱、IP 或錯誤內容。
function refreshPublicSystemHealthSnapshot() {
    const now = Date.now();
    const fresh = (timestamp, seconds) => Number.isFinite(Number(timestamp))
        && now - Number(timestamp) < seconds * 1000;
    const system = systemMonitor.getStatus();
    const databaseOk = system
        ? system.database?.status !== 'critical'
        : historyDb.diagnostics().ok;
    const worker = system?.worker || taskTracker.getStatus();
    const ups = upsFetchState.snapshot();
    const wiim = wiimCache.getStatusEx;
    const hardwareSnapshot = deviceCollectorSnapshot('ucg.hardware');
    publicSystemHealth.update([
        { online: true, critical: true },
        { online: databaseOk, critical: true },
        { online: worker.status !== 'critical', critical: true },
        {
            included: Boolean(process.env.UCG_IP) && !isPlaceholder(process.env.SSH_PASSWORD),
            online: !hardwareSnapshot?.lastErrorAt && fresh(hardwareSnapshot?.lastSuccessAt, 180)
        },
        {
            included: !isPlaceholder(process.env.UNIFI_USERNAME) && !isPlaceholder(process.env.UNIFI_PASSWORD),
            online: Boolean(localCookie) && now < cookieExpiry
        },
        {
            included: nasConfigured(),
            online: Boolean(nasToken) && now < nasTokenExpiry
        },
        {
            included: Boolean(wiimIP),
            online: fresh(wiim?.timestamp, 180)
        },
        {
            included: true,
            online: ups.fetchHealth === FETCH_HEALTH.HEALTHY && fresh(ups.lastSuccessAt, 180)
        },
        {
            included: adgConfigured(),
            online: fresh(adgLastOkTs, 180)
        },
        {
            included: linuxConfigured(),
            online: (() => { const snapshot = deviceCollectorSnapshot('linux.stats'); return !snapshot?.lastErrorAt && fresh(snapshot?.lastSuccessAt, 180); })()
        }
    ], now);
}

/* ===================== 重大事件警報 (前端頂部閃爍橫幅) =====================
   只放「需要立刻知道」的狀態，全部由記憶體現況計算，零上游呼叫。
   id 含事件起始時間，前端點擊關閉後記住 id；同一事件不再彈出，新事件會重新出現。 */
app.get('/api/alerts/critical', (req, res) => {
    const alerts = [];
    const openUpsEvent = historyDb.getOpenUpsEvent();
    const upsSnapshot = upsFetchState.snapshot();
    // UPS 斷電進行中
    if (openUpsEvent) {
        alerts.push({ id: 'ups-outage-' + openUpsEvent.start, level: 'critical', msg: `UPS 斷電中！市電中斷 (電池 ${upsLastLive?.battery ?? '?'}%，可撐約 ${upsLastLive?.runtimeSec ? Math.round(upsLastLive.runtimeSec / 60) + ' 分' : '--'})` });
    }
    // UPS 電池低 (斷電中或充電異常皆適用)
    if (upsSnapshot.fetchHealth === FETCH_HEALTH.HEALTHY && upsLastLive && upsLastLive.battery != null && upsLastLive.battery <= 20) {
        alerts.push({ id: 'ups-lowbatt-' + (openUpsEvent?.start || 'now'), level: 'critical', msg: `UPS 電池僅剩 ${upsLastLive.battery}%，請儘快處理` });
    }
    // UPS 完全失聯 (連續取樣失敗)
    if (upsSnapshot.fetchHealth === FETCH_HEALTH.OFFLINE) {
        const staleLabel = upsSnapshot.lastSuccessAt
            ? `最後資料已過 ${Math.round((upsSnapshot.staleAgeMs || 0) / 1000)} 秒`
            : '尚無成功資料';
        alerts.push({ id: 'ups-unreachable-' + upsSnapshot.offlineSince, level: 'warning', msg: `UPS 無法讀取 (連續 ${upsSnapshot.consecutiveFailures} 次全來源失敗；${staleLabel})` });
    }
    // WAN 斷線 (取自最近一次硬體快取)
    const hw = deviceCollectorSnapshot('ucg.hardware')?.data;
    if (hw) {
        const wan = (hw.interfaces || []).find(i => i.name.startsWith('WAN'));
        if (wan && wan.status !== 'connected') alerts.push({ id: 'wan-down', level: 'critical', msg: 'WAN 對外連線中斷！請檢查數據機/ISP' });
        if (hw.cpuTemp != null && hw.cpuTemp >= 85) alerts.push({ id: 'ucg-hot', level: 'warning', msg: `UCG CPU ${hw.cpuTemp}°C 嚴重過熱` });
    }
    res.json({ alerts });
});

// Liveness / readiness / 完整 diagnostics；/api/system/status 會沿用上方 Basic Auth。
registerHealthRoutes(app, {
    monitor: systemMonitor, db: historyDb, taskTracker,
    version: APP_VERSION, buildIdentity: buildIdentity.public,
    runtimeDiagnostics: () => {
        const memory = process.memoryUsage();
        let sqliteBytes = null;
        try { sqliteBytes = fs.statSync(path.join(DATA_DIR, 'smarthub.db')).size; } catch { }
        return {
            node_memory: {
                rss: memory.rss, heap_used: memory.heapUsed, heap_total: memory.heapTotal,
                external: memory.external, array_buffers: memory.arrayBuffers
            },
            event_loop_lag_ms: eventLoopLagMs,
            sse_clients: sseClients.size,
            active_browser_sessions: deviceActivity.sessionCount(),
            collectors: {
                running: [...collectorMetrics.values()].filter(metric => metric.running).length,
                recent: Object.fromEntries([...collectorMetrics.entries()].map(([name, metric]) => [name, {
                    running: !!metric.running, last_duration_ms: metric.lastDurationMs ?? null,
                    last_finished_at: metric.lastFinishedAt ? new Date(metric.lastFinishedAt).toISOString() : null
                }]))
            },
            sqlite_file_bytes: sqliteBytes,
            cleanup: { duration_ms: lastHistoryCleanup.durationMs, failed: lastHistoryCleanup.failed, completed_at: lastHistoryCleanup.completedAt, processed: lastHistoryCleanup.processed ?? 0, compacted: lastHistoryCleanup.compacted ?? 0, deleted: lastHistoryCleanup.deleted ?? 0 },
            artwork_cache: { entries: wiimArtCache.size(), total_bytes: wiimArtCache.totalBytes() }
        };
    }
});

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
        try { await siteManagerClient.get('/hosts'); sysLog('Diag', '✅ Site Manager 雲端 API：正常'); }
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
        try {
            await nasMonGet(nasMonAdvancedConfigured() ? '/api/downtime' : '/health', nasMonAdvancedConfigured() ? { days: 1 } : undefined);
            sysLog('Diag', `✅ NAS Monitor (${NASMON_URL})：${nasMonAdvancedConfigured() ? '完整模式正常' : 'Docker only 正常'}`);
        }
        catch (e) { sysLog('Diag', `❌ NAS Monitor：${e.response ? `HTTP ${e.response.status}${e.response.status === 401 ? ' (API Key 錯誤)' : ''}` : connHint(e, NASMON_URL)}`, true); }
    } else sysLog('Diag', '⏭️ NAS Monitor：未設定，略過');

    // 6. WiiM
    warnIfLocalhost('WIIM_IP', wiimIP);
    const wiimOk = await wiimGet('getStatusEx');
    if (wiimOk) sysLog('Diag', `✅ WiiM Amp (${wiimIP})：正常`);
    else sysLog('Diag', `❌ WiiM Amp (${wiimIP})：HTTPS/HTTP 皆無回應 — 檢查 IP 是否正確、裝置是否開機、容器可否達該網段 (新韌體須帶 User-Agent，已內建)`, true);

    // 7. UPS
    warnIfLocalhost('PPB_HOST', PPB_HOST());
    const upsPoll = await sampleUpsIfDue(upsSampleMs());
    const ups = upsPoll.snapshot.lastGood;
    // PPB 已成功供應資料時，未設定的 NUT 回退值與目前 UPS 無關，不應誤報為設定錯誤。
    if (!ups || upsPoll.snapshot.dataIsStale || ups.actualSource === 'nut') warnIfLocalhost('NUT_HOST', NUT_HOST());
    if (ups && !upsPoll.snapshot.dataIsStale) sysLog('Diag', `✅ UPS：來源 ${ups.actualSource.toUpperCase()}，${ups.status}，電池 ${ups.battery ?? '--'}%`);
    else if (ups) {
        sysLog('Diag', `⚠️ UPS：本次讀取失敗 (${upsPoll.snapshot.fetchHealth} ${upsPoll.snapshot.consecutiveFailures}/${upsPoll.snapshot.failureThreshold})，保留 ${Math.round((upsPoll.snapshot.staleAgeMs || 0) / 1000)} 秒前的 ${(ups.actualSource || 'unknown').toUpperCase()} 資料`, true);
        if (IS_DOCKER) sysLog('Diag', '   Docker 環境 UPS 檢查清單：(1) UPS_SOURCE=ppb + PPB_HOST=host.docker.internal + PPB_PORT=3052；(2) 或 UPS_SOURCE=nut + NUT_HOST=<跑 NUT server 的主機 IP>；(3) pwrstat/pmset 在容器內不可用', true);
    }
    else {
        const label = upsPoll.snapshot.fetchHealth === FETCH_HEALTH.OFFLINE ? '❌ 已確認失聯' : '⚠️ 暫時讀取失敗';
        sysLog('Diag', `${label} (${upsPoll.snapshot.consecutiveFailures}/${upsPoll.snapshot.failureThreshold})：${upsPoll.snapshot.failureReason || upsLastReason}`, true);
        if (IS_DOCKER) sysLog('Diag', '   Docker 環境 UPS 檢查清單：(1) UPS_SOURCE=ppb + PPB_HOST=host.docker.internal + PPB_PORT=3052；(2) 或 UPS_SOURCE=nut + NUT_HOST=<跑 NUT server 的主機 IP>；(3) pwrstat/pmset 在容器內不可用', true);
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
    const isTooLarge = error && (error.type === 'entity.too.large' || error.status === 413);
    const isJsonError = error && (error.type === 'entity.parse.failed' || error instanceof SyntaxError);
    apiError(res, error, {
        status: isTooLarge ? 413 : isJsonError ? 400 : 500,
        code: isTooLarge || isJsonError ? ERROR_CODES.API_VALIDATION_FAILED : ERROR_CODES.API_INTERNAL_ERROR,
        publicMessage: isTooLarge ? 'JSON request body exceeds 256 KiB'
            : isJsonError ? 'Invalid JSON request body' : 'Internal server error',
        module: 'api.middleware', function: 'errorHandler', fields: { method: req.method, path: req.path }
    });
});

refreshPublicSystemHealthSnapshot();
const PORT = process.env.PORT || 3000;
let httpServer;
let shutdownPromise = null;
const SHUTDOWN_TIMEOUT_MS = 5000;

function gracefulShutdown(signal, exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
        logger.info({
            module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.SYS_SHUTDOWN,
            message: 'SmartHub shutdown started', fields: { signal, exit_code: exitCode }
        });

        for (const handle of lifecycleIntervals) clearInterval(handle);
        lifecycleIntervals.clear();
        for (const handle of lifecycleTimeouts) clearTimeout(handle);
        lifecycleTimeouts.clear();
        Object.values(jobTimers).forEach(clearInterval);
        jobTimers = {};
        for (const sampler of backendSamplers.values()) sampler.stop();
        backendSamplers.clear();
        ucgSshPool.close();
        linuxSshPool.close();
        unifiDeviceThermalCollector.closeAll();

        resetSseUpstream();
        for (const client of sseClients) {
            try { client.end(); } catch { }
        }
        sseClients.clear();

        try { telegramCommandBot.stop(); } catch { }
        try { systemMonitor.stop(); } catch { }

        const closeServer = new Promise(resolve => {
            if (!httpServer || !httpServer.listening) return resolve(true);
            httpServer.close(error => {
                if (error) logger.error({
                    module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.SYS_SHUTDOWN,
                    message: 'HTTP server close failed during shutdown', error
                });
                resolve(!error);
            });
        });
        const drainJobs = Promise.allSettled([...runningJobPromises, startupHistoryCleanupPromise]).then(() => true);
        const stopReportRunner = reportRunner.stop().then(() => true, error => {
            logger.error({
                module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.WORKER_TASK_FAILED,
                message: 'Scheduled report runner stop failed', error
            });
            return false;
        });
        const cleanShutdown = Promise.all([closeServer, drainJobs, stopReportRunner])
            .then(results => results.every(Boolean));
        const timeout = new Promise(resolve => setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS));
        const drained = await Promise.race([cleanShutdown, timeout]);

        if (!drained) {
            logger.warning({
                module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.SYS_SHUTDOWN,
                message: 'Shutdown deadline reached; skipping explicit SQLite close to avoid racing in-flight work',
                fields: { timeout_ms: SHUTDOWN_TIMEOUT_MS, running_jobs: [...runningJobs] }
            });
            if (typeof httpServer?.closeAllConnections === 'function') httpServer.closeAllConnections();
        } else {
            try { historyDb.close(); }
            catch (error) {
                logger.error({ module: 'app.lifecycle', function: 'gracefulShutdown', code: ERROR_CODES.DB_CLOSE, message: 'SQLite close failed during shutdown', error });
            }
        }
        process.exit(exitCode);
    })();
    return shutdownPromise;
}

httpServer = app.listen(PORT, () => {
    telegramCommandBot.start();
    reportRunner.start();
    systemMonitor.ensureSample().then(status => {
        logger.info({
            module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_READY,
            message: 'SYSTEM READY', fields: {
                port: Number(PORT),
                startup_ms: Date.now() - APP_STARTED_AT,
                database: status.database.status,
                database_latency_ms: status.database.latency_ms,
                storage_free_gb: status.disk.free_bytes == null ? null : Number((status.disk.free_bytes / 1073741824).toFixed(2)),
                worker: status.worker.status,
                ...buildIdentity.logFields
            }
        });
    }).catch(error => logger.error({
        module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_MONITOR_FAILED,
        message: 'Server is listening but initial resource diagnostics failed', error
    }));
    // 延遲數秒再診斷，避開啟動瞬間的排程尖峰
    lifecycleTimeout(() => startupDiagnostics().catch(error => logger.error({
        module: 'startup.diagnostics', function: 'startupDiagnostics', code: ERROR_CODES.SYS_CONFIG_INVALID,
        message: 'External service startup diagnostics failed', error
    })), 3000);
    lifecycleTimeout(() => {
        const settings = loadNotifSettings();
        if (settings.enabled && settings.triggerSystemStartup) {
            notify('🚀 SmartHub 服務已啟動', `版本 ${APP_VERSION} · Port ${PORT} · 啟動耗時 ${Date.now() - APP_STARTED_AT} ms`).catch(() => { });
        }
    }, 5000, { unref: true });
});
// Keep slow NAS/SSH/Cloud requests viable while bounding header drips and
// indefinitely reused sockets. SSE has no request body and remains open after
// the response starts, so these values do not terminate its stream.
httpServer.headersTimeout = 66_000;
httpServer.requestTimeout = 120_000;
httpServer.keepAliveTimeout = 65_000;
httpServer.maxRequestsPerSocket = 1_000;

httpServer.on('error', error => {
    logger.critical({
        module: 'app.lifecycle', function: 'listen', code: ERROR_CODES.SYS_START_FAILED,
        message: 'STARTUP FAILED: HTTP server could not listen', error,
        fields: { port: Number(PORT), suggested_check: error.code === 'EADDRINUSE' ? `Check which process already uses port ${PORT}.` : 'Check port and container network configuration.' }
    });
    void gracefulShutdown('listen-error', 1);
});

process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('uncaughtException', error => {
    logger.critical({
        module: 'app.lifecycle', function: 'uncaughtException', code: ERROR_CODES.SYS_UNCAUGHT_EXCEPTION,
        message: 'Uncaught exception; shutting down', error
    });
    void gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.critical({
        module: 'app.lifecycle', function: 'unhandledRejection', code: ERROR_CODES.SYS_UNHANDLED_REJECTION,
        message: 'Unhandled promise rejection', error
    });
    void gracefulShutdown('unhandledRejection', 1);
});
