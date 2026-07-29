import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const codePath = path.resolve(here, '../apps-script/Code.gs');
const code = fs.readFileSync(codePath, 'utf8');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: codePath });

assert.equal(
  sandbox.urlKey_('https://www.instagram.com/sko_vkurse/?igsh=abc&utm_source=x#fragment'),
  'instagram.com/sko_vkurse',
  'Instagram tracking parameters must not create a duplicate URL',
);

assert.equal(
  sandbox.urlKey_('https://t.me/s/tengrinews/123?utm_source=test'),
  sandbox.urlKey_('https://t.me/tengrinews/123'),
  'Telegram public-view and direct links must share one key',
);

assert.equal(
  sandbox.urlKey_('https://example.kz/news?id=7&fbclid=tracking'),
  'example.kz/news?id=7',
  'Meaningful query parameters must remain while tracking is removed',
);

const sameSiteA = sandbox.sourceTitleKey_(
  'https://site-a.kz/news/1',
  'Site A',
  'В СКО открыли новую школу',
);
const sameSiteB = sandbox.sourceTitleKey_(
  'https://site-a.kz/another-address',
  'Site A',
  'В СКО открыли новую школу',
);
const anotherSite = sandbox.sourceTitleKey_(
  'https://site-b.kz/news/9',
  'Site B',
  'В СКО открыли новую школу',
);

assert.equal(sameSiteA, sameSiteB, 'Same title on the same site must be a duplicate');
assert.notEqual(sameSiteA, anotherSite, 'Same event on another media site must be preserved');

const googleA = sandbox.sourceTitleKey_(
  'https://news.google.com/rss/articles/abc',
  'Kazinform',
  'В СКО открыли новую школу - Kazinform',
);
const googleB = sandbox.sourceTitleKey_(
  'https://news.google.com/rss/articles/def',
  'Zakon.kz',
  'В СКО открыли новую школу - Zakon.kz',
);
assert.notEqual(googleA, googleB, 'Unresolved Google News links must remain separated by publisher');

const ambiguousBaiterek = sandbox.checkTextForSko_(
  'В Астане у монумента Байтерек состоялось торжественное мероприятие',
  ['Байтерек'],
  [],
);
assert.equal(
  ambiguousBaiterek.status,
  'maybe',
  'Baiterek alone must not auto-post an Astana story as SKO',
);

const skoBaiterek = sandbox.checkTextForSko_(
  'В селе Байтерек Кызылжарского района СКО отремонтировали дорогу',
  ['Байтерек', 'Кызылжарск', 'СКО'],
  [],
);
assert.equal(skoBaiterek.status, 'hit', 'Baiterek with clear SKO context must remain publishable');

assert.equal(
  sandbox.cleanListingTitle_('Страна Сегодня, 09:19 В СКО бесплатно подключили дома к теплу'),
  'В СКО бесплатно подключили дома к теплу',
);
assert.equal(
  sandbox.cleanListingTitle_('20:28, 24 Июля 2026 Объем финансирования предприятий увеличили'),
  'Объем финансирования предприятий увеличили',
);
assert.equal(
  sandbox.cleanListingTitle_('24 часа без воды: жители Петропавловска обратились к властям'),
  '24 часа без воды: жители Петропавловска обратились к властям',
  'A real title that begins with a number must remain intact',
);

const htmlItems = sandbox.extractFromHtml_(
  '<article><time datetime="2026-07-26T09:15:00+05:00"></time>' +
    '<a href="/news/sko/road">09:15, 26 июля 2026 В СКО отремонтировали дорогу</a></article>',
  'https://example.kz/',
);
assert.equal(htmlItems.length, 1);
assert.equal(htmlItems[0].title, 'В СКО отремонтировали дорогу');
assert.equal(htmlItems[0].pubDate.toISOString(), '2026-07-26T04:15:00.000Z');

assert.match(code, /SEEN_MAX:\s+50000/, 'Seen memory must cover more than one full crawl');
assert.match(code, /enqueueTelegramFindings_\(findings, headerLabel\);\s*flushTelegramQueue_\(\);/s);
assert.doesNotMatch(code, /tgSeen\[gk\]/, 'Channel dedupe must not suppress another publisher globally');
assert.match(code, /function enableAutoCheckSilent_\(\)/);
assert.doesNotMatch(code, /newTrigger\('makeWeeklyBackup_'\)/, 'Publication archive backups stay disabled');
assert.match(code, /confirmedNegative\.map\(function\(x\) \{ return x\.finding; \}\)/);
assert.match(
  code,
  /var staleCut = Date\.now\(\) - 24 \* 60 \* 60 \* 1000/,
  'Every fresh main finding must remain eligible for Telegram for the full monitoring day',
);
assert.match(code, /upd\.action === 'delivery_status'/);
assert.match(code, /upd\.action === 'run_main_check'/);
assert.match(code, /getRange\(2, 1, sh\.getLastRow\(\) - 1, 6\)\.clearContent\(\)/);
assert.doesNotMatch(code, /function globalTitleKey_\(/);
assert.doesNotMatch(code, /function normalizeTitleForKey_\(/);

console.log('Apps Script core tests: OK');

// Республиканские Telegram-каналы: без них 41 источник из 80 не проверял никто,
// а у «Чиновника», «Писем Президенту» и Qazaqparat канал — единственная площадка.
assert.match(code, /platform:\s*'telegram',\s*workflow:\s*'sko_mentions'/);
assert.match(code, /hostOf_\(src\.url\) === 't\.me'/);
assert.match(code, /function extractTelegramItems_\(/);
assert.match(code, /function telegramChannelFromUrl_\(/);

const tgHtml = [
  '<div data-post="chinovnik_kz/7899" class="tgme_widget_message">',
  '<time datetime="2026-07-25T13:37:11+00:00" class="time">13:37</time>',
  '<div class="tgme_widget_message_text js-message_text">',
  'Президент возложил цветы к мемориальной доске в Петропавловске</div></div>',
  '<div data-post="chinovnik_kz/7900"><div class="tgme_widget_message_text">коротко</div></div>',
].join('');
const tgItems = sandbox.extractTelegramItems_(tgHtml);
assert.equal(tgItems.length, 1, 'Короткие подписи под картинкой в канал не идут');
assert.equal(tgItems[0].url, 'https://t.me/chinovnik_kz/7899');
assert.equal(tgItems[0].pubDate.toISOString(), '2026-07-25T13:37:11.000Z');
assert.equal(sandbox.telegramChannelFromUrl_('https://t.me/s/chinovnik_kz'), 'chinovnik_kz');
assert.equal(sandbox.telegramChannelFromUrl_('https://t.me/QazAqparat_kz'), 'QazAqparat_kz');

// Обход прерывается по лимиту времени, а начинался всегда с первого источника:
// хвост списка терялся один и тот же и не проверялся никогда.
assert.match(code, /var sources = rotateSources_\(loadSources_\(\)\)/);
assert.match(code, /function rotateSources_\(/);

let cursorValue = '0';
sandbox.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k === 'SKO_SOURCE_CURSOR' ? cursorValue : null),
    setProperty: (k, v) => { if (k === 'SKO_SOURCE_CURSOR') cursorValue = v; },
  }),
};
const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const firstRun = sandbox.rotateSources_(list.slice());
const secondRun = sandbox.rotateSources_(list.slice());
assert.deepEqual(firstRun, list, 'Первый прогон идёт в исходном порядке');
assert.notDeepEqual(secondRun, firstRun, 'Второй прогон начинается с другого места');
assert.equal(secondRun.length, list.length, 'Ни один источник не выпадает');
assert.deepEqual([...secondRun].sort(), [...list].sort(), 'Состав списка сохраняется');
assert.deepEqual(sandbox.rotateSources_(['solo']), ['solo']);

// Пульт в Telegram: кнопки были написаны, но вебхук смотрел на постороннее
// развёртывание, поэтому нажатия не доходили. Адрес теперь задаётся явно.
assert.match(code, /upd\.action === 'bot_menu'/);
assert.match(code, /function botMenuSecure_\(/);
assert.match(code, /drop_pending_updates/);
assert.match(code, /upd\.action === 'sync_registry'/);

// Городской контур собирается на Mac, поэтому владельцу нужен его статус.
assert.match(code, /'🏙 Городские жалобы'/);
assert.match(code, /'📋 Источники'/);
assert.match(code, /text === '\/city'/);
assert.match(code, /text === '\/sources'/);
assert.match(code, /function buildCityStatus_\(/);
assert.match(code, /function buildSourcesSummary_\(/);

const keyboard = sandbox.tgMainKeyboard_().keyboard.flat();
assert.ok(keyboard.includes('🏙 Городские жалобы'), 'Кнопка городского контура на пульте');
assert.ok(keyboard.includes('📋 Источники'), 'Кнопка сводки по источникам на пульте');
assert.ok(keyboard.includes('▶ Проверить СМИ'), 'Старые кнопки никуда не делись');
assert.ok(keyboard.includes('⏰ Статус'));

// Apps Script всегда отвечает переадресацией, а Telegram по ней не ходит:
// нажатия копились недоставленными. Поэтому бот переведён на опрос.
assert.match(code, /upd\.action === 'bot_polling'/);
assert.match(code, /function pollTelegramUpdates_\(/);
assert.match(code, /function pollTelegramUpdatesSilent_\(/);
assert.match(code, /everyMinutes\(1\)/);
// Указатель сдвигается до разбора: упавшая команда не должна возвращаться вечно.
assert.match(
  code,
  /props\.setProperty\('TG_POLL_OFFSET', String\(lastId \+ 1\)\);[\s\S]{0,400}handleTgMessage_/
);
assert.match(code, /deleteWebhook/);
