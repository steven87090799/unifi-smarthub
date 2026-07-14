'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramCommandBot, parseCommand, splitTelegramText } = require('../telegram-command-bot');

function makeBot(commands = {}) {
    const posts = [];
    const axios = {
        post: async (url, body) => { posts.push({ url, body }); return { data: { ok: true } }; },
        get: async () => ({ data: { result: [] } })
    };
    const settings = { botToken: 'token', chatId: '123', telegramCommandsEnabled: true };
    const bot = new TelegramCommandBot({ axios, getSettings: () => settings, commands, logger: null });
    return { bot, posts, settings };
}

test('parseCommand accepts Telegram bot suffix and arguments', () => {
    assert.deepEqual(parseCommand('/clients@SmartHubBot phone 192.168.1.2'), {
        command: 'clients', args: ['phone', '192.168.1.2'], rawArgs: 'phone 192.168.1.2'
    });
    assert.equal(parseCommand('status'), null);
});

test('splitTelegramText keeps every chunk within Telegram limit, including long lines', () => {
    const value = `${'a'.repeat(9000)}\nend`;
    const chunks = splitTelegramText(value, 4000);
    assert.deepEqual(chunks.map(x => x.length), [4000, 4000, 1004]);
    assert.equal(chunks.join(''), value);
});

test('unauthorized chat is silently rejected', async () => {
    const { bot, posts, settings } = makeBot({ health: { description: 'health', run: async () => 'ok' } });
    await bot.handleUpdate({ message: { chat: { id: 999 }, text: '/health' } }, settings);
    assert.equal(posts.length, 0);
});

test('read-only command sends its result', async () => {
    const { bot, posts, settings } = makeBot({ health: { description: 'health', run: async () => 'all good' } });
    await bot.handleUpdate({ message: { chat: { id: 123 }, text: '/health' } }, settings);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.text, 'all good');
});

test('mutating command requires a one-time confirmation code', async () => {
    let executions = 0;
    const { bot, posts, settings } = makeBot({
        reboot: {
            description: 'restart', mutating: true,
            prepare: async () => ({ confirmation: 'restart now', execute: async () => { executions += 1; return 'done'; } })
        }
    });
    await bot.handleUpdate({ message: { chat: { id: 123 }, text: '/reboot' } }, settings);
    assert.equal(executions, 0);
    const code = posts[0].body.text.match(/\/confirm (\d{6})/)[1];

    await bot.handleUpdate({ message: { chat: { id: 123 }, text: `/confirm ${code}` } }, settings);
    assert.equal(executions, 1);
    assert.match(posts.at(-1).body.text, /操作完成/);

    await bot.handleUpdate({ message: { chat: { id: 123 }, text: `/confirm ${code}` } }, settings);
    assert.equal(executions, 1);
    assert.match(posts.at(-1).body.text, /沒有待確認操作/);
});
