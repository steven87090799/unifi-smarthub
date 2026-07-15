'use strict';

(() => {
    let webPushConfig = null;

    function base64UrlToUint8Array(value) {
        const padding = '='.repeat((4 - value.length % 4) % 4);
        const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, character => character.charCodeAt(0));
    }

    function capabilityError() {
        if (!window.isSecureContext) return 'Web Push 需要 HTTPS secure context';
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return '此瀏覽器不支援 Web Push';
        if (Notification.permission === 'denied') return '通知權限已被瀏覽器拒絕';
        return null;
    }

    async function fetchWebPushState() {
        const status = document.getElementById('web-push-status');
        if (!status) return false;
        const subscribeButton = document.getElementById('web-push-subscribe');
        const unsubscribeButton = document.getElementById('web-push-unsubscribe');
        const isAdmin = document.documentElement.dataset.panelRole === 'admin';
        try {
            const response = await fetch('/api/web-push/config', { cache: 'no-store' });
            const state = await response.json();
            if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
            webPushConfig = state;
            const browserError = capabilityError();
            let localSubscription = null;
            if (!browserError) {
                const registration = await navigator.serviceWorker.ready;
                localSubscription = await registration.pushManager.getSubscription();
            }
            const configuration = !state.configured
                ? state.error === 'partial_vapid_configuration' ? 'VAPID 設定不完整' : state.error === 'invalid_vapid_configuration' ? 'VAPID 設定無效' : '伺服器尚未設定 VAPID'
                : null;
            status.textContent = browserError || configuration || `${localSubscription ? '此瀏覽器已訂閱' : '此瀏覽器未訂閱'} · 伺服器共 ${state.subscriptionCount || 0} 筆`;
            status.className = `text-[9px] ${browserError || configuration ? 'text-red-400' : localSubscription ? 'text-emerald-400' : 'text-slate-500'}`;
            subscribeButton.textContent = localSubscription ? '同步/更新此瀏覽器訂閱' : '授權並訂閱此瀏覽器';
            subscribeButton.disabled = !isAdmin || !!browserError || !!configuration;
            unsubscribeButton.disabled = !isAdmin || !localSubscription;
            for (const button of [subscribeButton, unsubscribeButton]) button.classList.toggle('opacity-50', button.disabled);
            return true;
        } catch (error) {
            webPushConfig = null;
            status.textContent = `Web Push 狀態讀取失敗：${error.message}`;
            status.className = 'text-[9px] text-red-400';
            subscribeButton.disabled = true;
            unsubscribeButton.disabled = true;
            return false;
        }
    }

    async function subscribeWebPush() {
        if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可建立 Web Push 訂閱', true);
        const browserError = capabilityError();
        if (browserError) return showToast(browserError, true);
        try {
            if (!webPushConfig?.configured && !await fetchWebPushState()) throw new Error('無法取得 Web Push 設定');
            if (!webPushConfig?.configured || !webPushConfig.publicKey) throw new Error('伺服器尚未完成 VAPID 設定');
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知權限已被拒絕' : '未授予通知權限');
            const registration = await navigator.serviceWorker.ready;
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: base64UrlToUint8Array(webPushConfig.publicKey)
            });
            const response = await fetch('/api/web-push/subscriptions', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: subscription.toJSON() })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            showToast(result.created ? '此瀏覽器已建立 Web Push 訂閱' : '此瀏覽器訂閱已更新');
            await fetchWebPushState();
        } catch (error) {
            showToast(`Web Push 訂閱失敗：${error.message}`, true);
            await fetchWebPushState();
        }
    }

    async function unsubscribeWebPush() {
        if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可移除 Web Push 訂閱', true);
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (!subscription) return showToast('此瀏覽器沒有 Web Push 訂閱', true);
            const response = await fetch('/api/web-push/subscriptions', {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            await subscription.unsubscribe();
            showToast('此瀏覽器 Web Push 訂閱已移除');
            await fetchWebPushState();
        } catch (error) { showToast(`Web Push 取消失敗：${error.message}`, true); }
    }

    window.fetchWebPushState = fetchWebPushState;
    window.subscribeWebPush = subscribeWebPush;
    window.unsubscribeWebPush = unsubscribeWebPush;
})();
