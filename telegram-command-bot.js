'use strict';

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const CONFIRM_TTL_MS = 60_000;

function splitTelegramText(value, max = 4000) {
    const text = String(value ?? '');
    if (!text) return ['（無資料）'];
    const parts = [];
    let remaining = text;
    while (remaining.length > max) {
        let cut = remaining.lastIndexOf('\n', max);
        if (cut < Math.floor(max / 2)) cut = max;
        parts.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\n/, '');
    }
    if (remaining) parts.push(remaining);
    return parts;
}

function parseCommand(text) {
    const input = String(text || '').trim();
    if (!input.startsWith('/')) return null;
    const [head, ...rest] = input.split(/\s+/);
    const command = head.slice(1).split('@')[0].toLowerCase();
    return command ? { command, args: rest, rawArgs: rest.join(' ') } : null;
}

class TelegramCommandBot {
    constructor({ axios, getSettings, commands, logger, formatError, pollTimeoutSeconds = DEFAULT_POLL_TIMEOUT_SECONDS }) {
        this.axios = axios;
        this.getSettings = getSettings;
        this.commands = commands;
        this.logger = logger;
        this.formatError = formatError || (error => String(error?.message || error).slice(0, 500));
        this.pollTimeoutSeconds = pollTimeoutSeconds;
        this.running = false;
        this.offset = 0;
        this.abortController = null;
        this.pending = new Map();
        this.busyChats = new Set();
        this.rateLimits = new Map();
        this.registeredToken = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.loopPromise = this._loop();
    }

    stop() {
        this.running = false;
        this.abortController?.abort();
        this.abortController = null;
    }

    async _loop() {
        while (this.running) {
            const settings = this.getSettings();
            if (!settings.telegramCommandsEnabled || !settings.botToken || !settings.chatId) {
                await this._delay(3000);
                continue;
            }
            try {
                await this._registerCommands(settings.botToken);
                this.abortController = new AbortController();
                const response = await this.axios.get(`https://api.telegram.org/bot${settings.botToken}/getUpdates`, {
                    params: { offset: this.offset, timeout: this.pollTimeoutSeconds, allowed_updates: JSON.stringify(['message']) },
                    timeout: (this.pollTimeoutSeconds + 5) * 1000,
                    signal: this.abortController.signal
                });
                for (const update of response.data?.result || []) {
                    this.offset = Math.max(this.offset, Number(update.update_id) + 1);
                    await this.handleUpdate(update, this.getSettings());
                }
            } catch (error) {
                if (!this.running || error?.code === 'ERR_CANCELED') break;
                this._log('warning', 'Telegram command polling failed', error);
                await this._delay(3000);
            } finally {
                this.abortController = null;
            }
        }
    }

    async _registerCommands(token) {
        if (this.registeredToken === token) return;
        this.offset = 0; // update_id 屬於個別 Bot；更換 Token 時不可沿用舊 offset
        const commands = Object.entries(this.commands).map(([command, def]) => ({ command, description: def.description.slice(0, 256) }));
        commands.push({ command: 'confirm', description: '確認執行待處理操作' }, { command: 'cancel', description: '取消待處理操作' });
        await this.axios.post(`https://api.telegram.org/bot${token}/setMyCommands`, { commands }, { timeout: 8000 });
        this.registeredToken = token;
    }

    _delay(ms) {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
        });
    }

    _log(level, message, error, fields = {}) {
        this.logger?.[level]?.({
            module: 'telegram.commands', function: 'polling', code: error ? 'EXT_NOTIFICATION_FAILED' : undefined,
            message, error, fields
        });
    }

    _allowed(chatId, settings) {
        return String(chatId) === String(settings.chatId).trim();
    }

    _rateLimited(chatId) {
        const now = Date.now();
        const recent = (this.rateLimits.get(chatId) || []).filter(ts => now - ts < 60_000);
        recent.push(now);
        this.rateLimits.set(chatId, recent);
        return recent.length > 12;
    }

    async send(chatId, text, token = this.getSettings().botToken) {
        for (const part of splitTelegramText(text)) {
            await this.axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: part,
                disable_web_page_preview: true
            }, { timeout: 10_000 });
        }
    }

    helpText() {
        const lines = ['🤖 SmartHub 指令中心', '', '查詢指令：'];
        for (const [name, def] of Object.entries(this.commands).filter(([, def]) => !def.mutating)) {
            lines.push(`/${name}${def.usage ? ` ${def.usage}` : ''} — ${def.description}`);
        }
        lines.push('', '控制指令（需 60 秒內二次確認）：');
        for (const [name, def] of Object.entries(this.commands).filter(([, def]) => def.mutating)) {
            lines.push(`/${name}${def.usage ? ` ${def.usage}` : ''} — ${def.description}`);
        }
        lines.push('', '/confirm <確認碼> — 執行待處理操作', '/cancel — 取消待處理操作');
        return lines.join('\n');
    }

    async handleUpdate(update, settings = this.getSettings()) {
        const message = update?.message;
        const chatId = message?.chat?.id;
        const parsed = parseCommand(message?.text);
        if (!chatId || !parsed || !settings.telegramCommandsEnabled) return;
        if (!this._allowed(chatId, settings)) {
            this._log('warning', 'Rejected Telegram command from unauthorized chat', null, { chat_id: String(chatId) });
            return;
        }
        if (this._rateLimited(chatId)) return this.send(chatId, '⏳ 指令過於頻繁，請一分鐘後再試。', settings.botToken);
        if (this.busyChats.has(String(chatId))) return this.send(chatId, '⏳ 上一個指令仍在執行，請稍候。', settings.botToken);

        if (parsed.command === 'help' || parsed.command === 'start') return this.send(chatId, this.helpText(), settings.botToken);
        if (parsed.command === 'cancel') {
            this.pending.delete(String(chatId));
            return this.send(chatId, '✅ 已取消待處理操作。', settings.botToken);
        }
        if (parsed.command === 'confirm') return this._confirm(chatId, parsed.args[0], settings);

        const def = this.commands[parsed.command];
        if (!def) return this.send(chatId, `找不到 /${parsed.command}。傳送 /help 查看完整指令。`, settings.botToken);
        this.busyChats.add(String(chatId));
        try {
            if (def.mutating) {
                const prepared = await def.prepare(parsed.args, { chatId, message });
                const code = String(Math.floor(100000 + Math.random() * 900000));
                this.pending.set(String(chatId), { code, expiresAt: Date.now() + CONFIRM_TTL_MS, execute: prepared.execute });
                return this.send(chatId, `⚠️ ${prepared.confirmation}\n\n60 秒內傳送 /confirm ${code} 執行，或 /cancel 取消。`, settings.botToken);
            }
            const result = await def.run(parsed.args, { chatId, message });
            return this.send(chatId, result, settings.botToken);
        } catch (error) {
            this._log('warning', `Telegram command /${parsed.command} failed`, error, { chat_id: String(chatId) });
            return this.send(chatId, `❌ 指令失敗：${this.formatError(error)}`, settings.botToken);
        } finally {
            this.busyChats.delete(String(chatId));
        }
    }

    async _confirm(chatId, code, settings) {
        const key = String(chatId);
        const pending = this.pending.get(key);
        if (!pending || pending.expiresAt < Date.now()) {
            this.pending.delete(key);
            return this.send(chatId, '⌛ 沒有待確認操作，或確認碼已過期。', settings.botToken);
        }
        if (!code || code !== pending.code) return this.send(chatId, '❌ 確認碼不正確。', settings.botToken);
        this.pending.delete(key); // 一次性：先刪除，避免重送造成重複執行
        this.busyChats.add(key);
        try {
            const result = await pending.execute();
            return this.send(chatId, `✅ 操作完成\n${result || ''}`.trim(), settings.botToken);
        } catch (error) {
            this._log('warning', 'Confirmed Telegram action failed', error, { chat_id: key });
            return this.send(chatId, `❌ 操作失敗：${this.formatError(error)}`, settings.botToken);
        } finally {
            this.busyChats.delete(key);
        }
    }
}

module.exports = { TelegramCommandBot, parseCommand, splitTelegramText, CONFIRM_TTL_MS };
