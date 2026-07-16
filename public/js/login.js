'use strict';

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
const formAlert = document.getElementById('form-alert');
const formAlertText = document.getElementById('form-alert-text');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let submitting = false;
let pointerFrame = 0;
let pointerState = null;

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

function setVersion(version) {
    const label = typeof version === 'string' && version ? `v${version.replace(/^v/u, '')}` : 'v--';
    document.querySelectorAll('[data-app-version]').forEach(element => {
        element.textContent = label;
    });
}

async function checkExistingSession() {
    try {
        const response = await fetchWithTimeout('/api/auth/status', {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (!response.ok) return;
        const status = await response.json();
        setVersion(status.version);
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

function showAlert(message) {
    formAlertText.textContent = message;
    formAlert.classList.add('is-visible');
}

function shakeCard() {
    if (reducedMotion.matches || typeof form.animate !== 'function') return;
    form.getAnimations().forEach(animation => {
        if (animation.id === 'login-form-shake') animation.cancel();
    });
    const animation = form.animate([
        { transform: 'translateX(0)' },
        { transform: 'translateX(-5px)', offset: 0.22 },
        { transform: 'translateX(4px)', offset: 0.46 },
        { transform: 'translateX(-2px)', offset: 0.68 },
        { transform: 'translateX(1px)', offset: 0.86 },
        { transform: 'translateX(0)' }
    ], { duration: 340, easing: 'ease-in-out' });
    animation.id = 'login-form-shake';
}

function setSubmitting(active) {
    submitting = active;
    submitButton.disabled = active;
    submitButton.classList.toggle('is-loading', active);
    usernameInput.disabled = active;
    passwordInput.disabled = active;
    rememberInput.disabled = active;
    passwordToggle.disabled = active;
    forgotPassword.disabled = active;
    if (active) submitLabel.textContent = '登入中';
}

function finishSuccess() {
    submitButton.classList.remove('is-loading');
    submitButton.classList.add('is-success');
    submitLabel.textContent = '驗證成功';
    window.setTimeout(() => document.body.classList.add('is-authenticated'), reducedMotion.matches ? 0 : 140);
    window.setTimeout(() => window.location.replace(safeReturnPath()), reducedMotion.matches ? 0 : 360);
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
        shakeCard();
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
            shakeCard();
            setSubmitting(false);
            (response.status === 401 ? passwordInput : usernameInput).focus();
            return;
        }
        setVersion(payload.version);
        finishSuccess();
    } catch {
        showAlert('無法連線到登入服務，請檢查網路後再試。');
        shakeCard();
        setSubmitting(false);
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
    document.documentElement.style.setProperty('--scene-x', `${xRatio * -8}px`);
    document.documentElement.style.setProperty('--scene-y', `${yRatio * -6}px`);

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

form.addEventListener('submit', submitLogin);
passwordToggle.addEventListener('click', togglePasswordVisibility);
forgotPassword.addEventListener('click', toggleSecurityHelp);

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

void checkExistingSession();
