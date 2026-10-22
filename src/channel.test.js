import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.js читает окружение при импорте — выставляем до динамического импорта.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
process.env.BOT_TOKEN = '1:test';
process.env.OWNER_ID = '100';
process.env.TMP_DIR = path.join(tmp, 'tmp');
process.env.CHANNEL = '@TestChannel';

const { subscriptionGate, isMemberStatus, hasPassed } = await import('./channel.js');

/** Минимальный бот: запоминает middleware и обработчик кнопки. */
function fakeBot() {
  const bot = { mw: null, cb: {} };
  bot.use = (fn) => (bot.mw = fn);
  bot.callbackQuery = (name, fn) => (bot.cb[name] = fn);
  return bot;
}

function ctxFor(userId, { status = 'member', throws = false, callback = null } = {}) {
  const calls = { replies: [], sends: [], answers: [] };
  const ctx = {
    from: { id: userId },
    me: { username: 'test_bot' },
    callbackQuery: callback ? { data: callback } : undefined,
    api: {
      getChatMember: async () => {
        if (throws) throw new Error('chat not found');
        return { status };
      },
      sendMessage: async (chat, text) => calls.sends.push({ chat, text }),
    },
    reply: async (text, extra) => calls.replies.push({ text, extra }),
    answerCallbackQuery: async (o) => calls.answers.push(o),
  };
  return { ctx, calls };
}

async function run(bot, ctx) {
  let nexted = false;
  await bot.mw(ctx, async () => {
    nexted = true;
  });
  return nexted;
}

test('isMemberStatus: подписчики и админы да; ушедшие и забаненные нет', () => {
  for (const s of ['creator', 'administrator', 'member']) assert.equal(isMemberStatus(s), true);
  for (const s of ['left', 'kicked']) assert.equal(isMemberStatus(s), false);
  assert.equal(isMemberStatus('restricted', true), true);
  assert.equal(isMemberStatus('restricted', false), false);
});

test('владелец бота проходит без проверки', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const { ctx } = ctxFor(100, { throws: true });
  assert.equal(await run(bot, ctx), true);
});

test('подписанный проходит и запоминается: второй раз Telegram уже не спрашиваем', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const a = ctxFor(201, { status: 'member' });
  assert.equal(await run(bot, a.ctx), true);
  assert.equal(hasPassed(201), true);
  const b = ctxFor(201, { throws: true }); // если бы спросили — упало бы в «unknown» и ушло владельцу
  assert.equal(await run(bot, b.ctx), true);
  assert.equal(b.calls.sends.length, 0);
});

test('не подписанный остановлен, получает просьбу с кнопками подписки', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const { ctx, calls } = ctxFor(202, { status: 'left' });
  assert.equal(await run(bot, ctx), false);
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].text, /@TestChannel/);
  assert.equal(hasPassed(202), false);
});

test('нажатие кнопки не подписанным: ответ на кнопку и просьба, не пропуск', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const { ctx, calls } = ctxFor(203, { status: 'left', callback: 'dl:123' });
  assert.equal(await run(bot, ctx), false);
  assert.equal(calls.answers.length, 1);
});

test('нельзя проверить (бот не админ канала): пускаем и один раз в сутки говорим владельцу', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const a = ctxFor(204, { throws: true });
  assert.equal(await run(bot, a.ctx), true);
  assert.equal(a.calls.sends.length, 1);
  assert.equal(a.calls.sends[0].chat, '100');
  assert.match(a.calls.sends[0].text, /не админ канала/);
  const b = ctxFor(205, { throws: true });
  assert.equal(await run(bot, b.ctx), true);
  assert.equal(b.calls.sends.length, 0, 'второе предупреждение в те же сутки не отправляется');
  assert.equal(hasPassed(204), false, 'непроверенного не помечаем как прошедшего');
});

test('кнопка «Я подписался»: не подписан — предупреждение; подписался — запомнен', async () => {
  const bot = fakeBot();
  subscriptionGate(bot);
  const no = ctxFor(206, { status: 'left', callback: 'subcheck' });
  await bot.cb.subcheck(no.ctx);
  assert.equal(no.calls.answers[0].show_alert, true);
  assert.equal(hasPassed(206), false);
  const yes = ctxFor(207, { status: 'member', callback: 'subcheck' });
  await bot.cb.subcheck(yes.ctx);
  assert.equal(hasPassed(207), true);
});

test('подписка запоминается на диске (переживает рестарт)', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'subscribed.json'), 'utf8'));
  assert.ok(saved.includes('201') && saved.includes('207'));
});
