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

console.log('Apps Script core tests: OK');
