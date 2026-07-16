'use strict';

const SNAPSHOT_MAX_AGE_MS = 3 * 60 * 1000;
const SNAPSHOT_CLOCK_INTERVAL_MS = 15 * 1000;
const PUBLIC_SNAPSHOT_STATUSES = new Set(['operational', 'degraded', 'critical', 'unknown']);

const form = document.getElementById('login-form');
const card = document.getElementById('login-card');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const rememberInput = document.getElementById('remember');
const usernameField = document.getElementById('username-field');
const passwordField = document.getElementById('password-field');
const usernameError = document.getElementById('username-error');
const passwordError = document.getElementById('password-error');
const passwordToggle = document.getElementById('password-toggle');
const forgotPassword = document.getElementById('forgot-password');
const securityHelp = document.getElementById('security-help');
const submitButton = document.getElementById('login-submit');
const submitLabel = document.getElementById('login-submit-label');
const sessionState = document.getElementById('session-state');
const formAlert = document.getElementById('form-alert');
const formAlertText = document.getElementById('form-alert-text');
const snapshotPanel = document.getElementById('system-snapshot');
const snapshotBadge = document.getElementById('snapshot-badge');
const snapshotDescription = document.getElementById('snapshot-description');
const snapshotSecondary = document.getElementById('snapshot-secondary');
const snapshotOnline = document.getElementById('snapshot-online');
const snapshotTotal = document.getElementById('snapshot-total');
const snapshotOffline = document.getElementById('snapshot-offline');
const snapshotTime = document.getElementById('snapshot-time');
const snapshotExpiry = document.getElementById('snapshot-expiry');
const snapshotReload = document.getElementById('snapshot-reload');
const snapshotAnnouncement = document.getElementById('snapshot-announcement');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let submitting = false;
let pointerFrame = 0;
let pointerState = null;
let snapshotClock = 0;
let snapshotData = null;
let snapshotAnnouncementKey = null;
let publicSystemHealthRequest = null;
let cardStateTimer = 0;

async function fetchWithTimeout(input, init = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
}

function safeReturnPath() {
    const value = new URLSearchParams(window.location.search).get('return') || '/';
    return /^\/(?!\/)/u.test(value) && !value.startsWith('/login') ? value : '/';
}

function normalizePublicSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || !PUBLIC_SNAPSHOT_STATUSES.has(payload.status)) {
        throw new TypeError('Invalid public system health response');
    }
    const total = Number(payload.total);
    const online = Number(payload.online);
    const offline = Number(payload.offline);
    if (![total, online, offline].every(value => Number.isSafeInteger(value) && value >= 0)
        || online + offline !== total) {
        throw new TypeError('Invalid public system health counts');
    }
    if (payload.status === 'unknown' || payload.snapshotAt == null) {
        return { status: 'unknown', total: 0, online: 0, offline: 0, snapshotAt: null };
    }
    const snapshotTimestamp = Date.parse(payload.snapshotAt);
    if (!Number.isFinite(snapshotTimestamp)) throw new TypeError('Invalid public system health timestamp');
    return {
        status: payload.status,
        total,
        online,
        offline,
        snapshotAt: new Date(snapshotTimestamp).toISOString()
    };
}

function requestPublicSystemHealthOnce() {
    if (!publicSystemHealthRequest) {
        publicSystemHealthRequest = fetchWithTimeout('/api/public/system-health', {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        }, 5000).then(async response => {
            if (!response.ok) throw new Error('Public system health request failed');
            return normalizePublicSnapshot(await response.json());
        });
    }
    return publicSystemHealthRequest;
}

function formatSnapshotTime(timestamp) {
    return new Intl.DateTimeFormat('zh-TW', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(timestamp));
}

function formatRemaining(milliseconds) {
    const totalSeconds = Math.max(Math.ceil(milliseconds / 1000), 0);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setSnapshotVisualState(state) {
    snapshotPanel.classList.remove(
        'is-loading',
        'is-operational',
        'is-degraded',
        'is-critical',
        'is-unknown',
        'is-expired'
    );
    snapshotPanel.classList.add(`is-${state}`);
}

function announceSnapshot(key, message) {
    if (snapshotAnnouncementKey === key) return;
    snapshotAnnouncementKey = key;
    snapshotAnnouncement.textContent = message;
}

function showSnapshotUnavailable() {
    snapshotData = null;
    window.clearInterval(snapshotClock);
    snapshotClock = 0;
    setSnapshotVisualState('unknown');
    snapshotBadge.textContent = '無法取得';
    snapshotDescription.textContent = '暫時無法取得狀態快照';
    snapshotSecondary.textContent = 'STATUS SNAPSHOT UNAVAILABLE';
    snapshotOnline.textContent = '--';
    snapshotTotal.textContent = '--';
    snapshotOffline.textContent = '離線數量 --';
    snapshotTime.textContent = '快照時間 --:--:--';
    snapshotExpiry.textContent = '請重新整理頁面後再試';
    snapshotReload.hidden = false;
    announceSnapshot('unavailable', '暫時無法取得核心服務狀態快照，登入功能仍可正常使用。');
}

function showExpiredSnapshot(data) {
    window.clearInterval(snapshotClock);
    snapshotClock = 0;
    setSnapshotVisualState('expired');
    snapshotBadge.textContent = '已過期';
    snapshotDescription.textContent = '狀態快照已過期';
    snapshotSecondary.textContent = 'STATUS SNAPSHOT EXPIRED';
    snapshotOnline.textContent = String(data.online);
    snapshotTotal.textContent = String(data.total);
    snapshotOffline.textContent = `取得快照時 ${data.offline} 個節點離線`;
    snapshotTime.textContent = `資料取得於 ${formatSnapshotTime(data.snapshotAt)}`;
    snapshotExpiry.textContent = '請重新整理頁面取得最新狀態';
    snapshotReload.hidden = false;
    announceSnapshot('expired', '核心服務狀態快照已過期，頁面不會自動重新查詢。');
}

function renderSnapshotClock() {
    if (!snapshotData?.snapshotAt) return;
    const expiresAt = Date.parse(snapshotData.snapshotAt) + SNAPSHOT_MAX_AGE_MS;
    const remaining = Math.max(0, expiresAt - Date.now());
    if (remaining <= 0) {
        showExpiredSnapshot(snapshotData);
        return;
    }
    snapshotExpiry.textContent = `快照有效時間 ${formatRemaining(remaining)}`;
}

function startSnapshotClock() {
    window.clearInterval(snapshotClock);
    snapshotClock = 0;
    renderSnapshotClock();
    if (!snapshotData || document.hidden || snapshotPanel.classList.contains('is-expired')) return;
    snapshotClock = window.setInterval(renderSnapshotClock, SNAPSHOT_CLOCK_INTERVAL_MS);
}

function showSnapshot(data) {
    if (data.status === 'unknown' || !data.snapshotAt) {
        showSnapshotUnavailable();
        return;
    }
    snapshotData = data;
    const expired = Date.now() >= Date.parse(data.snapshotAt) + SNAPSHOT_MAX_AGE_MS;
    if (expired) {
        showExpiredSnapshot(data);
        return;
    }

    const messages = {
        operational: {
            badge: '正常',
            primary: '所有核心服務正常',
            secondary: 'ALL CORE SERVICES OPERATIONAL'
        },
        degraded: {
            badge: '部分異常',
            primary: '偵測到部分節點離線',
            secondary: 'DEGRADED SERVICE'
        },
        critical: {
            badge: '嚴重異常',
            primary: '核心服務狀態異常',
            secondary: 'CRITICAL SERVICE CONDITION'
        }
    };
    const message = messages[data.status];
    setSnapshotVisualState(data.status);
    snapshotBadge.textContent = message.badge;
    snapshotDescription.textContent = message.primary;
    snapshotSecondary.textContent = message.secondary;
    snapshotOnline.textContent = String(data.online);
    snapshotTotal.textContent = String(data.total);
    snapshotOffline.textContent = `${data.offline} 個節點離線`;
    snapshotTime.textContent = `快照取得於 ${formatSnapshotTime(data.snapshotAt)}`;
    snapshotReload.hidden = true;
    startSnapshotClock();
    announceSnapshot(data.status, `${message.primary}，${data.online} / ${data.total} 個節點在線。`);
}

async function loadSystemSnapshot() {
    try {
        showSnapshot(await requestPublicSystemHealthOnce());
    } catch {
        showSnapshotUnavailable();
    }
}

async function checkExistingSession() {
    try {
        const response = await fetchWithTimeout('/api/auth/status', {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!response.ok) return;
        const status = await response.json();
        if (status.authenticated) {
            document.body.classList.add('is-authenticated');
            window.setTimeout(() => window.location.replace(safeReturnPath()), reducedMotion.matches ? 0 : 120);
            return;
        }
        if (window.matchMedia('(min-width: 821px)').matches && document.visibilityState === 'visible') {
            window.requestAnimationFrame(() => usernameInput.focus({ preventScroll: true }));
        }
    } catch {
        // 登入表單仍可使用；實際送出時會顯示明確的網路錯誤。
    }
}

function setFieldError(field, input, errorElement, message) {
    field.classList.toggle('is-error', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    errorElement.textContent = message || '';
}

function syncFieldState(field, input) {
    const hasValue = input.value.length > 0;
    field.classList.toggle('is-filled', hasValue);
    field.classList.toggle('is-valid', hasValue && !field.classList.contains('is-error'));
}

function validateUsername(showError = true) {
    const valid = usernameInput.value.trim().length > 0;
    if (showError) setFieldError(usernameField, usernameInput, usernameError, valid ? '' : '請輸入帳號。');
    syncFieldState(usernameField, usernameInput);
    return valid;
}

function validatePassword(showError = true) {
    const valid = passwordInput.value.length > 0;
    if (showError) setFieldError(passwordField, passwordInput, passwordError, valid ? '' : '請輸入密碼。');
    syncFieldState(passwordField, passwordInput);
    return valid;
}

function clearAlert() {
    formAlert.classList.remove('is-visible');
    formAlertText.textContent = '';
}

function setCardTransientState(state) {
    window.clearTimeout(cardStateTimer);
    card.classList.remove('is-error-state', 'is-success-state');
    if (!state) return;
    card.classList.add(state);
    if (state === 'is-error-state') {
        cardStateTimer = window.setTimeout(() => card.classList.remove(state), 700);
    }
}

function showAlert(message) {
    formAlertText.textContent = message;
    formAlert.classList.add('is-visible');
    setCardTransientState('is-error-state');
}

function shakeForm() {
    if (reducedMotion.matches || typeof form.animate !== 'function') return;
    form.getAnimations().forEach(animation => {
        if (animation.id === 'login-form-shake') animation.cancel();
    });
    const animation = form.animate([
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)', offset: 0.24 },
        { transform: 'translateX(3px)', offset: 0.48 },
        { transform: 'translateX(-2px)', offset: 0.7 },
        { transform: 'translateX(0)' }
    ], { duration: 300, easing: 'ease-in-out' });
    animation.id = 'login-form-shake';
}

function setSubmitting(active) {
    submitting = active;
    submitButton.disabled = active;
    submitButton.classList.toggle('is-loading', active);
    card.classList.toggle('is-authenticating', active);
    usernameInput.disabled = active;
    passwordInput.disabled = active;
    rememberInput.disabled = active;
    passwordToggle.disabled = active;
    forgotPassword.disabled = active;
    if (active) {
        submitLabel.textContent = '驗證中';
        sessionState.textContent = 'ESTABLISHING SECURE SESSION';
    } else {
        submitLabel.textContent = '驗證身分';
        sessionState.textContent = 'ENCRYPTED SESSION REQUIRED';
    }
}

function finishSuccess() {
    card.classList.remove('is-authenticating');
    setCardTransientState('is-success-state');
    submitButton.classList.remove('is-loading');
    submitButton.classList.add('is-success');
    submitLabel.textContent = '驗證成功';
    sessionState.textContent = 'ACCESS GRANTED';
    window.setTimeout(() => document.body.classList.add('is-authenticated'), reducedMotion.matches ? 0 : 120);
    window.setTimeout(() => window.location.replace(safeReturnPath()), reducedMotion.matches ? 0 : 320);
}

function authenticationMessage(response, payload) {
    if (response.status === 429) {
        const seconds = Number(payload.retry_after_seconds);
        return Number.isFinite(seconds) && seconds > 0
            ? `登入嘗試過多，請在 ${seconds} 秒後再試。`
            : '登入嘗試過多，請稍後再試。';
    }
    if (response.status === 401) return '帳號或密碼不正確，請重新確認。';
    if (response.status === 403) return '此登入要求未通過安全來源檢查，請重新整理頁面後再試。';
    if (response.status === 400 || response.status === 415) return '登入資料格式不正確，請重新輸入。';
    return '登入服務暫時無法完成要求，請稍後再試。';
}

async function submitLogin(event) {
    event.preventDefault();
    if (submitting) return;

    clearAlert();
    const usernameValid = validateUsername(true);
    const passwordValid = validatePassword(true);
    if (!usernameValid || !passwordValid) {
        showAlert('請完成標示的必填欄位。');
        sessionState.textContent = 'IDENTITY VERIFICATION INCOMPLETE';
        shakeForm();
        (usernameValid ? passwordInput : usernameInput).focus();
        return;
    }

    setSubmitting(true);
    try {
        const response = await fetchWithTimeout('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({
                username: usernameInput.value.trim(),
                password: passwordInput.value,
                remember: rememberInput.checked
            })
        }, 12_000);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
            showAlert(authenticationMessage(response, payload));
            if (response.status === 401) {
                setFieldError(passwordField, passwordInput, passwordError, '請重新輸入密碼後再試。');
                passwordInput.value = '';
                syncFieldState(passwordField, passwordInput);
            }
            shakeForm();
            setSubmitting(false);
            sessionState.textContent = 'AUTHENTICATION FAILED';
            (response.status === 401 ? passwordInput : usernameInput).focus();
            return;
        }
        finishSuccess();
    } catch {
        showAlert('無法連線到登入服務，請檢查網路後再試。');
        shakeForm();
        setSubmitting(false);
        sessionState.textContent = 'SECURE SESSION UNAVAILABLE';
        submitButton.focus();
    }
}

function togglePasswordVisibility() {
    const reveal = passwordInput.type === 'password';
    passwordInput.type = reveal ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    passwordToggle.setAttribute('aria-label', reveal ? '隱藏密碼' : '顯示密碼');
    passwordInput.focus({ preventScroll: true });
    const end = passwordInput.value.length;
    passwordInput.setSelectionRange(end, end);
}

function toggleSecurityHelp() {
    const open = securityHelp.hidden;
    securityHelp.hidden = !open;
    forgotPassword.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function applyPointerState() {
    pointerFrame = 0;
    if (!pointerState) return;
    const { clientX, clientY } = pointerState;
    const xRatio = clientX / window.innerWidth - 0.5;
    const yRatio = clientY / window.innerHeight - 0.5;
    document.documentElement.style.setProperty('--scene-x', `${xRatio * -6}px`);
    document.documentElement.style.setProperty('--scene-y', `${yRatio * -4}px`);

    const bounds = card.getBoundingClientRect();
    const cardX = Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100));
    const cardY = Math.max(0, Math.min(100, ((clientY - bounds.top) / bounds.height) * 100));
    document.documentElement.style.setProperty('--card-x', `${cardX}%`);
    document.documentElement.style.setProperty('--card-y', `${cardY}%`);
}

function queuePointerState(event) {
    pointerState = { clientX: event.clientX, clientY: event.clientY };
    if (!pointerFrame) pointerFrame = window.requestAnimationFrame(applyPointerState);
}

function resetPointerState() {
    pointerState = null;
    document.documentElement.style.setProperty('--scene-x', '0px');
    document.documentElement.style.setProperty('--scene-y', '0px');
    document.documentElement.style.setProperty('--card-x', '50%');
    document.documentElement.style.setProperty('--card-y', '0%');
}

function handleVisibilityChange() {
    document.body.classList.toggle('is-page-hidden', document.hidden);
    if (document.hidden) {
        window.clearInterval(snapshotClock);
        snapshotClock = 0;
        return;
    }
    if (snapshotData) startSnapshotClock();
}

function submitOnEnter(event) {
    if (event.key !== 'Enter' || event.isComposing || submitting) return;
    if (event.target !== usernameInput && event.target !== passwordInput) return;
    event.preventDefault();
    form.requestSubmit();
}

form.addEventListener('submit', submitLogin);
form.addEventListener('keydown', submitOnEnter);
passwordToggle.addEventListener('click', togglePasswordVisibility);
forgotPassword.addEventListener('click', toggleSecurityHelp);
snapshotReload.addEventListener('click', () => window.location.reload());
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pagehide', () => window.clearInterval(snapshotClock), { once: true });

usernameInput.addEventListener('input', () => {
    clearAlert();
    if (usernameField.classList.contains('is-error')) validateUsername(true);
    else syncFieldState(usernameField, usernameInput);
});
passwordInput.addEventListener('input', () => {
    clearAlert();
    if (passwordField.classList.contains('is-error')) validatePassword(true);
    else syncFieldState(passwordField, passwordInput);
});
usernameInput.addEventListener('blur', () => {
    if (usernameInput.value.length) validateUsername(true);
});
passwordInput.addEventListener('blur', () => {
    if (passwordInput.value.length) validatePassword(true);
});

if (!reducedMotion.matches && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    window.addEventListener('pointermove', queuePointerState, { passive: true });
    document.documentElement.addEventListener('mouseleave', resetPointerState);
}

handleVisibilityChange();
void Promise.allSettled([checkExistingSession(), loadSystemSnapshot()]);
