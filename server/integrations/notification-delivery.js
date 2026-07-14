'use strict';

class PartialNotificationDeliveryError extends Error {
    constructor(message, { channel, sentParts, totalParts, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'PartialNotificationDeliveryError';
        this.code = 'NOTIFICATION_PARTIAL_DELIVERY';
        this.channel = channel;
        this.sentParts = sentParts;
        this.totalParts = totalParts;
    }
}

function chunkText(value, maxLength) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
        throw new TypeError('maxLength must be a positive safe integer');
    }
    let remaining = String(value);
    if (remaining.length <= maxLength) return [remaining];

    const chunks = [];
    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        let consume = 1;
        if (splitAt < Math.floor(maxLength / 2)) {
            splitAt = maxLength;
            consume = 0;
            // Do not split a UTF-16 surrogate pair at a hard boundary.
            const before = remaining.charCodeAt(splitAt - 1);
            const after = remaining.charCodeAt(splitAt);
            if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) splitAt -= 1;
        }
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt + consume);
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    throw signal.reason instanceof Error ? signal.reason : new Error('Notification delivery aborted');
}

function reportProgress(observer, progress) {
    if (typeof observer !== 'function') return;
    try { observer(progress); } catch { /* Observability cannot alter delivery semantics. */ }
}

function telegramError(error) {
    const status = error?.response?.status;
    const description = error?.response?.data?.description;
    if (status === 404) {
        return new Error('Telegram 回應 404：Bot Token 錯誤 (請向 @BotFather 重新複製完整 token，格式如 123456789:AAxxxx)');
    }
    if (status === 400 && /chat not found/i.test(description || '')) {
        return new Error('Telegram：找不到聊天室。Chat ID 必須是數字 (不是 bot 名稱)，且你要先在 Telegram 對這個 bot 送出任一訊息，再按「偵測 Chat ID」');
    }
    return new Error(`Telegram ${status || ''}: ${description || error?.message || 'delivery failed'}`);
}

function createNotificationDispatcher({ httpClient } = {}) {
    if (!httpClient || typeof httpClient.post !== 'function') {
        throw new TypeError('httpClient must expose post()');
    }

    return async function dispatchNotification(title, body, settings, {
        signal,
        scheduleKey = null,
        onProgress = null
    } = {}) {
        if (!settings || typeof settings !== 'object') throw new TypeError('notification settings are required');
        const text = `${title}\n${body}`;
        throwIfAborted(signal);

        if (settings.channel === 'telegram') {
            if (!settings.botToken || !settings.chatId) throw new Error('Telegram 未設定 botToken / chatId');
            const parts = chunkText(text, 4000);
            let sentParts = 0;
            try {
                for (const part of parts) {
                    throwIfAborted(signal);
                    await httpClient.post(
                        `https://api.telegram.org/bot${settings.botToken}/sendMessage`,
                        { chat_id: settings.chatId, text: part },
                        { timeout: 8000, signal }
                    );
                    sentParts += 1;
                    reportProgress(onProgress, { channel: 'telegram', sentParts, totalParts: parts.length });
                }
            } catch (error) {
                const failure = telegramError(error);
                if (sentParts > 0) throw new PartialNotificationDeliveryError(failure.message, {
                    channel: 'telegram', sentParts, totalParts: parts.length, cause: failure
                });
                throw failure;
            }
        } else if (settings.channel === 'discord') {
            if (!settings.webhookUrl) throw new Error('Discord Webhook URL 未設定');
            const parts = chunkText(text, 1900);
            let sentParts = 0;
            try {
                for (const part of parts) {
                    throwIfAborted(signal);
                    await httpClient.post(settings.webhookUrl, { content: part }, { timeout: 8000, signal });
                    sentParts += 1;
                    reportProgress(onProgress, { channel: 'discord', sentParts, totalParts: parts.length });
                }
            } catch (error) {
                if (sentParts > 0) throw new PartialNotificationDeliveryError(error.message, {
                    channel: 'discord', sentParts, totalParts: parts.length, cause: error
                });
                throw error;
            }
        } else {
            if (!settings.webhookUrl) throw new Error('Webhook URL 未設定');
            const headers = scheduleKey
                ? { 'Idempotency-Key': scheduleKey, 'X-SmartHub-Schedule-Key': scheduleKey }
                : undefined;
            await httpClient.post(settings.webhookUrl, {
                title,
                body,
                text,
                ts: new Date().toISOString(),
                ...(scheduleKey ? { schedule_key: scheduleKey } : {})
            }, { timeout: 8000, signal, headers });
            reportProgress(onProgress, { channel: settings.channel || 'webhook', sentParts: 1, totalParts: 1 });
        }
        throwIfAborted(signal);
    };
}

module.exports = {
    PartialNotificationDeliveryError,
    chunkText,
    createNotificationDispatcher
};
