// ============================================================
//  МОНИТОРИНГ УПОМИНАНИЙ СКО В РЕСПУБЛИКАНСКИХ СМИ
//
//  Работает БЕЗ Gemini и любых API-ключей — только словарь.
//  Задача: найти любую новость, где упоминается Северо-Казахстанская
//  область, Петропавловск, её районы, сёла, учреждения или руководство.
//  Тема новости не важна: ДТП, завод, президент — берём всё.
//
//  УСТАНОВКА:
//  1. Создай новую Google Таблицу, вставь этот код в Apps Script.
//  2. Меню "Мониторинг СКО" → "1. Настроить таблицу".
//  3. Меню → "🔍 Диагностика источников" — проверить, какие сайты
//     реально отдают контент боту (это честный тест из Apps Script).
//  4. Меню → "▶ Проверить сейчас".
//
//  ЛИСТЫ:
//  ИСТОЧНИКИ   — список сайтов (добавляй/удаляй строками)
//  СЛОВАРЬ     — слова-маркеры СКО (дополняй сам в любой момент!)
//  СТОП-СЛОВА  — что НЕ считать упоминанием (ЗКО, Жамбылская область...)
//  НАХОДКИ     — точные попадания
//  НА ПРОВЕРКУ — сомнительные, глянуть глазами (страховка от пропусков)
//  ЖУРНАЛ      — что проверено, что упало
// ============================================================

// Google News RSS — универсальный обходной путь: Google сам обходит и
// рендерит ВСЕ сайты (включая JS-ленты вроде Tengrinews и заблокированные
// для ботов). Мы просто спрашиваем у него всё свежее по нашим словам.
var GOOGLE_NEWS_QUERIES = [
  'СКО Казахстан',
  '"Северо-Казахстанская область"',
  'Петропавловск Казахстан',
  '"Солтүстік Қазақстан"'
];

// YouTube-каналы телеканалов (№36-42 из рабочего списка).
// handle — @имя канала. ID резолвится автоматически при первом запуске
// и запоминается, чтобы не тратить квоту API повторно.
var YT_CHANNELS = [
  { handle: '@1tveurasia',        name: 'Первый канал Евразия' },
  { handle: '@31kanal',           name: '31 канал' },
  { handle: '@AstanaTV',          name: 'Астана телеканал' },
  { handle: '@qazaqstan_tv',      name: 'Qazaqstan (Хабар)' },
  { handle: '@tv24kz',            name: '24 KZ' },
  { handle: '@ktk_kz',            name: 'КТК' },
  { handle: '@almatytv',          name: 'Алматы ТВ' }
];

var CFG_REGIONAL_SHEET = 'РЕГИОНАЛЬНЫЕ';
var CFG_NEG_SHEET      = 'НЕГАТИВ-СЛОВА';
var CFG_POSITIVE_SHEET = 'ПОЗИТИВ';
var CFG_DEEP_SHEET     = 'АРХИВ-ПОИСК';
var CFG_POS_SEEN_KEY   = 'sko_positive_seen';
var CFG_DEEP_STATE_KEY = 'sko_deep_state';
var CFG_PUBLICS_SHEET  = 'ПАБЛИКИ';
var CFG_REGISTRY_SHEET = 'РЕЕСТР ИСТОЧНИКОВ';
var CFG_DAILY_SHEET    = 'ЕЖЕДНЕВНЫЙ МОНИТОРИНГ';
var CFG_SEARCH_SHEET   = 'ПОИСК ЗА ПЕРИОД';

// Региональные домены — ЖЁСТКО зашиты: их новости НИКОГДА не идут
// в республиканский поток и Telegram-канал (плюс домены с листа РЕГИОНАЛЬНЫЕ)
var REGIONAL_HOSTS_BUILTIN = ['pkzsk.info', 'qaz-media.kz', 'qz-media.kz', 'timnews.kz', '7152.kz'];

// Регионалка распознаётся ЛЮБЫМ способом: по домену ссылки, по имени
// источника или по хвосту заголовка (" - pkzsk.info" из Google News).
// Дыра была именно тут: GN-находка с невытащенным оригиналом имела
// адрес news.google.com — и проходила фильтр по домену.
var REGIONAL_NAME_RE = /pkzsk\.info|pkzsk_info|qaz-media|qz-media|qazaqstan\s*media|timnews|тимньюс|7152\.kz|петропавловск[\s.]*news/i;

// Кэш названий регионалок с листа РЕГИОНАЛЬНЫЕ (колонка B) —
// впиши туда имя, каким источник зовут в Google News, и фильтр его выучит
var __regNamesCache = null;
function regionalNames_() {
  if (__regNamesCache !== null) return __regNamesCache;
  __regNamesCache = [];
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(CFG_REGIONAL_SHEET);
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().forEach(function(r) {
        var n = (r[0] || '').toString().trim().toLowerCase();
        if (n.length >= 4) __regNamesCache.push(n);
      });
    }
  } catch (e) {}
  try {
    loadRegistrySources_({ scope: 'regional' }).forEach(function(s) {
      var n = (s.name || '').toLowerCase();
      if (n.length >= 4 && __regNamesCache.indexOf(n) === -1) __regNamesCache.push(n);
    });
  } catch (eRegistry) {}
  return __regNamesCache;
}

function isRegionalFinding_(f) {
  // 1) По домену ссылки
  if (REGIONAL_HOSTS_BUILTIN.indexOf(hostOf_(f.url)) !== -1) return true;

  var src = (f.src || '').toLowerCase();
  var title = (f.title || '').toLowerCase();
  var text = src + ' ' + title;

  // 2) По встроенному списку имён (включая варианты Google News)
  if (REGIONAL_NAME_RE.test(text)) return true;

  // 3) По именам с листа РЕГИОНАЛЬНЫЕ — фильтр самообучается
  var names = regionalNames_();
  for (var i = 0; i < names.length; i++) {
    if (text.indexOf(names[i]) !== -1) return true;
  }

  // 4) ПО ХВОСТУ ЗАГОЛОВКА: Google News подписывает материал как
  //    "Заголовок - Имя издания". Сверяем именно этот хвост.
  var tailMatch = title.match(/[-–—]\s*([^-–—]{3,40})\s*$/);
  if (tailMatch) {
    var tail = tailMatch[1].trim();
    if (REGIONAL_NAME_RE.test(tail)) return true;
    for (var j = 0; j < names.length; j++) {
      if (tail.indexOf(names[j]) !== -1 || names[j].indexOf(tail) !== -1) return true;
    }
  }
  return false;
}
var CFG_PUB_SEEN_KEY   = 'sko_publics_seen';

var CODE_VERSION = 'v4.1 (Python-мост и два канала)';

var CFG = {
  SOURCES:     'ИСТОЧНИКИ',
  DICT:        'СЛОВАРЬ',
  STOP:        'СТОП-СЛОВА',
  FINDINGS:    'НАХОДКИ',
  MAYBE:       'НА ПРОВЕРКУ',
  LOG:         'ЖУРНАЛ',
  SEEN_KEY:    'sko_seen_links',
  // Техническая память ссылок, не архив публикаций. Старые ключи
  // автоматически вытесняются; 3000 было меньше одного полного обхода.
  SEEN_MAX:    50000,
  LOG_MAX:     1500,      // строк в ЖУРНАЛЕ (~неделя при проверке раз в час)
  FINDINGS_MAX: 1200,     // строк в НАХОДКИ / НА ПРОВЕРКУ / ПОЗИТИВ
  MAX_PER_SITE: 80,
  MAX_RUNTIME: 5 * 60 * 1000,
  SAFETY_STOP: 25 * 1000
};


// ============================================================
//  СЛОВАРЬ СКО — стартовый набор
//  Всё это попадёт на лист СЛОВАРЬ, дальше правишь прямо в таблице.
// ============================================================

// Уровень 1 — железные маркеры: если встретилось, это точно СКО
var LEVEL1_MARKERS = [
  'СКО',                          // короткое — ищется только как отдельное слово
  'Северо-Казахстанск',           // корень: ловит все падежи
  'Северо-Казахстанская область',
  'Северный Казахстан',
  'Солтүстік Қазақстан',
  'North Kazakhstan',
  'Петропавловск',                // корень: Петропавловске, Петропавловска, ...
  'Петропавл',                    // казахское написание
  'Petropavlovsk', 'Petropavl'
];

// Уровень 2 — районы СКО (все написания)
var LEVEL2_DISTRICTS = [
  // Корни прилагательных — ловят все падежи: "Кызылжарский", "Кызылжарском",
  // "Кызылжарского" и т.д. Эти названия уникальны для СКО.
  'Айыртауск', 'Айыртау ауданы',
  'Акжарск', 'Ақжар ауданы',
  'Аккайынск', 'Аққайың ауданы',
  'Кызылжарск', 'Қызылжар ауданы',
  'Мамлютск', 'Мамлют ауданы',
  'Тайыншинск', 'Тайынша ауданы',
  'Тимирязевск', 'Тимирязев ауданы',
  'Уалихановск', 'Уәлиханов ауданы',
  'Магжана Жумабаева', 'Жумабаева района', 'Жумабаевском', 'Мағжан Жұмабаев ауданы',
  'Габита Мусрепова', 'Мусрепова района', 'Мусреповском', 'Ғабит Мүсірепов ауданы',
  'Шал акына', 'Шал ақын ауданы', 'Шал акын',

  // ОСТОРОЖНО: "Жамбылский" и "Есильский" есть и в других регионах,
  // поэтому только с явным словом "район" во всех падежах.
  'Жамбылский район', 'Жамбылском районе', 'Жамбылского района', 'Жамбыл ауданы',
  'Есильский район', 'Есильском районе', 'Есильского района', 'Есіл ауданы'
];

// Уровень 3 — населённые пункты СКО (районные центры + известные сёла)
var LEVEL3_PLACES = [
  // Основы без последней буквы — ловят падежи ("Кишкенекол" → "Кишкенеколя")
  // Районные центры
  'Саумалкол', 'Талшик', 'Смирново', 'Явленк', 'Пресновк', 'Бишкул',
  'Мамлютк', 'Булаево', 'Новоишимско', 'Тайынш', 'Тимирязево',
  'Кишкенекол', 'Сергеевк',
  // Кызылжарский
  'Бескол', 'Боровско', 'Соколовк', 'Новокаменк', 'Большая Малышка',
  'Долматово', 'Знаменско', 'Петерфельд', 'Токуши', 'Байтерек',
  'Виноградовк', 'Мичурино', 'Налобино',
  // Жамбылский
  'Кайранкол', 'Казанско', 'Благовещенк', 'Архангелк', 'Айтуар',
  'Новорыбинк', 'Пресноредут', 'Кладбинк', 'Майбалык',
  // Есильский
  'Ильинк', 'Спасовк', 'Корнеевк', 'Заградовк', 'Волошинк', 'Тарангул',
  // Аккайынский
  'Астраханк', 'Киялы', 'Рождественк', 'Черкасско', 'Шагалалы',
  'Полтавк', 'Григорьевк',
  // Айыртауский
  'Арыкбалык', 'Имантау', 'Сырымбет', 'Лобаново', 'Володарско',
  'Новоукраинк', 'Шалкар',
  // Акжарский
  'Кулыкол', 'Ленинградско', 'Айсары', 'Горьковско', 'Кызылту',
  'Бостандык', 'Даукара',
  // Мамлютский
  'Афонькино', 'Воскресеновк', 'Дубровно', 'Леденёво', 'Меньшиковк',
  'Становое',
  // М. Жумабаева
  'Возвышенк', 'Полудино', 'Чистовско', 'Конюхово', 'Молодогвардейско',
  'Золотая Нива', 'Писаревк', 'Каракога',
  // Г. Мусрепова
  'Рузаевк', 'Чистопол', 'Ломоносовк', 'Тахтаброд', 'Нежинк',
  'Салкынкол', 'Червонно', 'Кырымбет', 'Шоптыкол',
  // Тайыншинский
  'Келлеровк', 'Чкалово', 'Донецко', 'Краснокаменк', 'Мироновк',
  'Красная Поляна', 'Летовочно', 'Огнеупорно',
  // Тимирязевский
  'Аксуат', 'Дзержинско', 'Дмитриевк', 'Докучаево', 'Хмельницко',
  'Москворецко',
  // Уалихановский
  'Акбулак', 'Каратерек', 'Мортык', 'Теренсай', 'Кобенсай', 'Бидайык',
  // Шал акына
  'Городецко', 'Афанасьевк', 'Новопокровк', 'Семипалатно',
  'Ждановк', 'Стерлитамак', 'Юбилейно'
];

// Уровень 4 — учреждения, предприятия, объекты, бренды СКО
var LEVEL4_ENTITIES = [
  'СКУ имени Козыбаева', 'СКУ им. Козыбаева', 'Козыбаева',
  'Северо-Казахстанский университет', 'Козыбаев атындағы',
  'ФК Кызылжар', 'Кызылжар', 'Кулагер',
  'Петропавловская ТЭЦ', 'ТЭЦ-2 Петропавловска',
  'Петропавловск-Кокшетау', 'аэропорт Петропавловск',
  'ЗИКСТО', 'Мунаймаш', 'Петропавловский завод тяжелого машиностроения',
  'ПЗТМ', 'Кызылжарский рынок', 'областная больница Петропавловск',
  'акимат СКО', 'аким СКО', 'аким Северо-Казахстанской',
  'СКО облысының әкімі', 'акимат Петропавловска'
];


// ============================================================
//  СТОП-СЛОВА — что НЕ считать упоминанием СКО
// ============================================================
var STOP_WORDS = [
  'Западно-Казахстанск', 'ЗКО', 'Батыс Қазақстан',
  'Восточно-Казахстанск', 'ВКО', 'Шығыс Қазақстан',
  'Южно-Казахстанск', 'ЮКО',
  'Жамбылская область', 'Жамбылской области', 'Жамбыл облысы',
  'Петропавловка',            // село в других регионах и в РФ
  'Камчатск',                 // Петропавловск-Камчатский во всех падежах
  'Камчатк'                   // "на Камчатке" и т.п.
];


// ============================================================
//  МЕНЮ
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Мониторинг СКО')
    .addItem('1. Настроить таблицу',      'setupSkoMonitor')
    .addSeparator()
    .addItem('▶ Проверить сейчас',        'runSkoCheck')
    .addSeparator()
    .addItem('⏰ ВКЛЮЧИТЬ автопроверку (каждые 30 мин)',  'enableAutoCheck')
    .addItem('⏸ ВЫКЛЮЧИТЬ автопроверку',                 'disableAutoCheck')
    .addSeparator()
    .addItem('🔍 Диагностика источников', 'diagnoseSources')
    .addItem('Обновить единый реестр источников', 'syncSourceRegistry')
    .addItem('🧪 Проверить память и версию', 'diagnoseMemory')
    .addItem('♻️ Вернуть отключённые источники', 'reviveDeadSources')
    .addSeparator()
    .addItem('✈️ Настроить Telegram-уведомления', 'setupTelegram')
    .addItem('Настроить канал «Ежедневный мониторинг»', 'setupNegativeTelegram')
    .addItem('✈️ Тест Telegram (пробное сообщение)', 'testTelegram')
    .addItem('✈️ Включить ЛИЧНОЕ меню бота', 'enableTgBotMenu')
    .addItem('✈️ Статус вебхука (почему бот молчит)', 'diagnoseWebhook')
    .addItem('✈️ Отключить Telegram', 'disableTelegram')
    .addItem('Подключить Python-помощник', 'setupMonitorBridge')
    .addSeparator()
    .addItem('📺 Вставить YouTube API ключ',   'setYoutubeKey')
    .addItem('📺 Проверить YouTube-каналы',    'runYoutubeCheck')
    .addSeparator()
    .addItem('🌿 Собрать ПОЗИТИВ (регион, за сегодня)', 'runPositiveCheck')
    .addItem('📲 Проверить ПАБЛИКИ (Telegram-зеркала)',  'runPublicsCheck')
    .addSeparator()
    .addItem('🕳 Глубокий поиск: начать',      'startDeepSearch')
    .addItem('🕳 Глубокий поиск: продолжить',  'continueDeepSearch')
    .addItem('🕳 Глубокий поиск: сбросить',    'resetDeepSearch')
    .addSeparator()
    .addItem('Очистить находки',          'clearSkoFindings')
    .addItem('Сбросить память ссылок',    'resetSkoMemory')
    .addToUi();
}


// ============================================================
//  НАСТРОЙКА ТАБЛИЦЫ
// ============================================================
function setupSkoMonitor() {
  var ss = SpreadsheetApp.getActive();

  // Повторный запуск теперь работает как безопасное обновление. Ничего,
  // что пользователь добавил в источники и словари, не очищаем.
  var dictExisting = ss.getSheetByName(CFG.DICT);
  if (dictExisting && dictExisting.getLastRow() > 1) {
    telegramQueueSheet_();
    ensureSourceRegistry_();
    SpreadsheetApp.getUi().alert(
      'Таблица уже настроена и обновлена до ' + CODE_VERSION + '.\n\n' +
      'Источники, словари, находки и твои собственные изменения сохранены.'
    );
    return;
  }

  // --- ИСТОЧНИКИ ---
  var src = getOrCreate_(ss, CFG.SOURCES);
  src.clear();
  src.getRange('A1:C1').setValues([['URL источника', 'Название', 'Заметка']]);
  src.getRange('A1:C1').setFontWeight('bold').setBackground('#1E5E9E').setFontColor('#FFFFFF');
  var starter = [
    // === Проверенные, работают надёжно ===
    ['https://www.nur.kz/',                    'Nur.kz',        'проверен, работает отлично'],
    ['https://www.zakon.kz/',                  'Zakon.kz',      'проверен'],
    ['https://www.inform.kz/ru',               'Kazinform рус', 'осн. адрес; если молчит — работает site:-лента ниже'],
    ['https://news.google.com/rss/search?q=site:inform.kz%20when:1d&hl=ru&gl=KZ&ceid=KZ:ru', 'Kazinform (G-лента)', 'обход: перс. лента Google по сайту'],
    ['https://www.inform.kz/kz',               'Kazinform каз', 'проверен'],
    ['https://orda.kz/',                       'Орда',          'проверен'],
    ['https://qumash.kz/',                     'Qumash.kz',     'проверен'],
    ['https://toppress.kz/',                   'Toppress',      'проверен'],
    ['https://rus.azattyq-ruhy.kz/',           'Azattyq Rýhy',  'проверен'],
    ['https://tengrinews.kz/kazakhstan_news/', 'Tengrinews',    'лента, НЕ главная (главная на JS)'],
    ['https://kaztag.kz/ru/',                  'КазТаг',        'прямой; если молчит — site:-лента ниже'],
    ['https://news.google.com/rss/search?q=site:kaztag.kz%20when:1d&hl=ru&gl=KZ&ceid=KZ:ru', 'КазТаг (G-лента)', 'обход: перс. лента Google по сайту'],
    ['https://ru.sputnik.kz/',                 'Спутник',       'проверен'],
    ['https://baigenews.kz/',                  'BaigeNews',     'проверен'],
    ['https://el.kz/ru/',                      'EL.KZ',         'проверен'],
    ['https://inbusiness.kz/ru',               'Inbusiness',    'проверен, видел СКО-новости'],
    ['https://liter.kz/',                      'Литер',         'проверен, часто пишет про СКО'],
    ['https://rus.baq.kz/',                    'Baq.kz',        'проверен (русская версия)'],
    ['https://kazlenta.kz/feed/',              'Kazlenta',      'RSS вместо JS-главной'],
    ['https://news.google.com/rss/search?q=site:kazlenta.kz%20when:1d&hl=ru&gl=KZ&ceid=KZ:ru', 'Kazlenta (G-лента)', 'обход JS-ленты'],
    ['https://www.kazpravda.kz/',              'Казправда',     'проверен'],
    ['https://www.caravan.kz/',                'Караван',       'проверен'],
    ['https://informburo.kz/',                 'Informburo',    'бонус: не из списка, но полезен'],
    // === Специализированные / нюансы ===
    ['https://vesti.kz/',                      'Vesti.kz',      'спортивный портал — СКО редко, но бывает'],
    ['https://ratel.kz/',                      'Ratel',         'аналитика, обновляется редко'],
    ['https://newtimes.kz/',                   'NewTimes',      'не проверен глубоко'],
    ['https://exclusive.kz/',                  'Exclusive',     'аналитический журнал'],
    ['https://qaz365.kz/',                     'Qaz365',        'каз./рус. издание'],
    ['https://kaz.kazlenta.kz/',               'Kazlenta каз',  'казахская версия'],
    ['https://www.time.kz/',                   'Время (Тайм)',  'газета Время'],
    ['https://hronika.kz/',                    'Hronika',       'экспериментальный'],
    // === Казахоязычные газеты (могут отдавать плохо — покажет диагностика) ===
    ['https://egemen.kz/',                     'Егемен Қазақстан', 'республиканская газета'],
    ['https://www.ulysmedia.kz/',              'Ұлыс медиа',    'не проверен'],
    ['https://halyqline.kz/',                  'Халық үні',     'уточнить URL, возможно halyquni.kz'],
    ['https://rus.azattyq.org/',               'Азаттык (RFE)', 'радио Азаттык'],
    ['https://arnapress.kz/',                  'Arna press',    'регион Семей, но бывает республика'],
    ['https://qazaquni.kz/',                   'Қазақ үні',     'каз. газета']
  ];
  src.getRange(2, 1, starter.length, 3).setValues(starter);
  src.setColumnWidth(1, 320); src.setColumnWidth(2, 160); src.setColumnWidth(3, 320);
  src.setFrozenRows(1);

  // --- СЛОВАРЬ ---
  var dict = getOrCreate_(ss, CFG.DICT);
  dict.clear();
  dict.getRange('A1:B1').setValues([['Слово / фраза', 'Категория']]);
  dict.getRange('A1:B1').setFontWeight('bold').setBackground('#1B8A3E').setFontColor('#FFFFFF');
  var dictRows = [];
  LEVEL1_MARKERS.forEach(function(w) { dictRows.push([w, 'область/город']); });
  LEVEL2_DISTRICTS.forEach(function(w) { dictRows.push([w, 'район']); });
  LEVEL3_PLACES.forEach(function(w)    { dictRows.push([w, 'село']); });
  LEVEL4_ENTITIES.forEach(function(w)  { dictRows.push([w, 'организация/объект']); });
  dict.getRange(2, 1, dictRows.length, 2).setValues(dictRows);
  dict.setColumnWidth(1, 340); dict.setColumnWidth(2, 200);
  dict.setFrozenRows(1);
  dict.getRange(1, 4).setValue(
    'Дополняй словарь сам! Просто впиши новое слово в колонку A.\n' +
    'Категория — любая, для твоего удобства. Бот проверяет все слова из колонки A.'
  ).setWrap(true).setFontColor('#666666');
  dict.setColumnWidth(4, 380);

  // --- СТОП-СЛОВА ---
  var stop = getOrCreate_(ss, CFG.STOP);
  stop.clear();
  stop.getRange('A1:B1').setValues([['Стоп-слово', 'Почему исключаем']]);
  stop.getRange('A1:B1').setFontWeight('bold').setBackground('#B23B3B').setFontColor('#FFFFFF');
  var stopRows = [
    ['Западно-Казахстанск',   'другой регион (ЗКО), корень ловит все падежи'],
    ['ЗКО',                   'другой регион'],
    ['Батыс Қазақстан',       'ЗКО по-казахски'],
    ['Восточно-Казахстанск',  'другой регион (ВКО)'],
    ['ВКО',                   'другой регион'],
    ['Шығыс Қазақстан',       'ВКО по-казахски'],
    ['Жамбылская область',    'юг РК, не наш Жамбылский район'],
    ['Жамбылской области',    'юг РК'],
    ['Жамбыл облысы',         'юг РК'],
    ['Петропавловка',         'село в других областях и в РФ'],
    ['Камчатск',              'Петропавловск-Камчатский (РФ), все падежи'],
    ['Камчатк',               '"на Камчатке" и т.п.']
  ];
  stop.getRange(2, 1, stopRows.length, 2).setValues(stopRows);
  stop.setColumnWidth(1, 280); stop.setColumnWidth(2, 320);
  stop.setFrozenRows(1);

  // --- НАХОДКИ ---
  var fnd = getOrCreate_(ss, CFG.FINDINGS);
  fnd.clear();
  fnd.getRange('A1:F1').setValues([['Найдено', 'Дата новости', 'Источник', 'Заголовок', 'Ссылка', 'Что нашли']]);
  fnd.getRange('A1:F1').setFontWeight('bold').setBackground('#1B8A3E').setFontColor('#FFFFFF');
  fnd.setColumnWidth(1, 100); fnd.setColumnWidth(2, 110); fnd.setColumnWidth(3, 130);
  fnd.setColumnWidth(4, 420); fnd.setColumnWidth(5, 300); fnd.setColumnWidth(6, 200);
  fnd.setFrozenRows(1);

  // --- НА ПРОВЕРКУ ---
  var mb = getOrCreate_(ss, CFG.MAYBE);
  mb.clear();
  mb.getRange('A1:F1').setValues([['Найдено', 'Дата новости', 'Источник', 'Заголовок', 'Ссылка', 'Почему сомнительно']]);
  mb.getRange('A1:F1').setFontWeight('bold').setBackground('#A07800').setFontColor('#FFFFFF');
  mb.setColumnWidth(1, 100); mb.setColumnWidth(2, 110); mb.setColumnWidth(3, 130);
  mb.setColumnWidth(4, 420); mb.setColumnWidth(5, 300); mb.setColumnWidth(6, 240);
  mb.setFrozenRows(1);

  // --- РЕГИОНАЛЬНЫЕ ---
  var reg = getOrCreate_(ss, CFG_REGIONAL_SHEET);
  reg.clear();
  reg.getRange('A1:C1').setValues([['URL источника', 'Название', 'Заметка']]);
  reg.getRange('A1:C1').setFontWeight('bold').setBackground('#7A3FA0').setFontColor('#FFFFFF');
  var regStart = [
    ['https://pkzsk.info/feed/?posts_per_page=50',    'Петропавловск.news', 'RSS-лента, 50 материалов'],
    ['https://pkzsk.info/',                           'Петропавловск.news', 'основной сайт'],
    ['https://qaz-media.kz/feed/?posts_per_page=50',  'Qaz-media',          'RSS-лента'],
    ['https://qaz-media.kz/category/novosti/',        'Qaz-media',          'раздел новостей'],
    ['https://qz-media.kz/feed/?posts_per_page=50',   'Qz-media',           'RSS-лента'],
    ['https://timnews.kz/feed/?posts_per_page=50',    'ТимНьюс',            'RSS-лента'],
    ['https://timnews.kz/',                           'ТимНьюс',            'основной сайт'],
    ['https://www.7152.kz/news',                      '7152.kz',            'раздел новостей']
  ];
  reg.getRange(2, 1, regStart.length, 3).setValues(regStart);
  reg.setColumnWidth(1, 320); reg.setColumnWidth(2, 180); reg.setColumnWidth(3, 300);
  reg.setFrozenRows(1);

  // --- НЕГАТИВ-СЛОВА (для фильтра позитива: позитив = всё, где НЕТ этих слов) ---
  var neg = getOrCreate_(ss, CFG_NEG_SHEET);
  neg.clear();
  neg.getRange('A1').setValue('Негативный маркер (дополняй сам)');
  neg.getRange('A1').setFontWeight('bold').setBackground('#B23B3B').setFontColor('#FFFFFF');
  var negWords = [
    'ДТП','авари','пожар','возгоран','погиб','умер','смерт','убий','зарезал',
    'кража','украл','ограб','изнасил','суд','приговор','арест','задержа',
    'штраф','взятк','коррупц','мошенн','обман','афер','жалоб','недовол',
    'возмущ','скандал','конфликт','драк','избил','паводок','наводнен','потоп',
    'ураган','обрушени','взрыв','отравлен','вспышк','розыск','пропал без вести',
    'наркот','пьян','сбил','столкнул','травм','ранен','госпитализ','реанимац',
    'поджог','теракт','экстремиз','банкрот','задолженност','отключени',
    'прорыв','критик','проблем','нарушени','халатност','обвал','упал с',
    'утонул','эвакуац','чрезвычайн','санкци','дефицит','подорожа','рост цен'
  ];
  neg.getRange(2, 1, negWords.length, 1).setValues(negWords.map(function(w){return [w];}));
  neg.setColumnWidth(1, 300);
  neg.setFrozenRows(1);
  neg.getRange(1, 3).setValue(
    'ПОЗИТИВ = новость, где НЕТ ни одного из этих слов.\n' +
    'Слишком много мусора в позитиве? Добавь маркеров.\n' +
    'Позитив отсеивает хорошее? Убери лишние.'
  ).setWrap(true).setFontColor('#666666');
  neg.setColumnWidth(3, 360);

  // --- ПОЗИТИВ ---
  var pos = getOrCreate_(ss, CFG_POSITIVE_SHEET);
  pos.clear();
  pos.getRange('A1:D1').setValues([['Время', 'Источник', 'Заголовок', 'Ссылка']]);
  pos.getRange('A1:D1').setFontWeight('bold').setBackground('#2E7D32').setFontColor('#FFFFFF');
  pos.setColumnWidth(1, 110); pos.setColumnWidth(2, 150);
  pos.setColumnWidth(3, 450); pos.setColumnWidth(4, 300);
  pos.setFrozenRows(1);

  // --- АРХИВ-ПОИСК ---
  var dp = getOrCreate_(ss, CFG_DEEP_SHEET);
  dp.clear();
  dp.getRange('A1:E1').setValues([['Найдено', 'Дата статьи', 'Заголовок/URL', 'Ссылка', 'Как нашли']]);
  dp.getRange('A1:E1').setFontWeight('bold').setBackground('#4527A0').setFontColor('#FFFFFF');
  dp.setColumnWidth(1, 110); dp.setColumnWidth(2, 110);
  dp.setColumnWidth(3, 420); dp.setColumnWidth(4, 300); dp.setColumnWidth(5, 150);
  dp.setFrozenRows(1);

  // --- ПАБЛИКИ (Telegram-зеркала местных инстаграм-пабликов) ---
  var pub = getOrCreate_(ss, CFG_PUBLICS_SHEET);
  pub.clear();
  pub.getRange('A1:C1').setValues([['Telegram-канал (имя без @ или ссылка)', 'Название паблика', 'Заметка']]);
  pub.getRange('A1:C1').setFontWeight('bold').setBackground('#0088CC').setFontColor('#FFFFFF');
  var pubStart = [
    ['pkzskinfo',   'Петропавловск.news', 'пример — проверь и замени на реальные'],
    ['sko_vkurse',  'СКО в курсе',        'пример — впиши реальное имя ТГ-канала'],
    ['petro_smi',   'Петро СМИ',          'пример']
  ];
  pub.getRange(2, 1, pubStart.length, 3).setValues(pubStart);
  pub.setColumnWidth(1, 320); pub.setColumnWidth(2, 200); pub.setColumnWidth(3, 320);
  pub.setFrozenRows(1);
  pub.getRange(1, 5).setValue(
    'КАК ЭТО РАБОТАЕТ: Instagram закрыт для ботов, но крупные паблики\n' +
    'дублируют посты в Telegram. У ТГ-каналов есть открытая веб-версия\n' +
    '(t.me/s/имя) — её бот и читает: бесплатно, без API, без блокировок.\n' +
    'Впиши сюда ТГ-зеркала своих пабликов. Найти их: открой профиль\n' +
    'паблика в Instagram — ссылка на Telegram обычно в шапке.'
  ).setWrap(true).setFontColor('#666666');
  pub.setColumnWidth(5, 420);

  // --- ЖУРНАЛ ---
  var log = getOrCreate_(ss, CFG.LOG);
  log.clear();
  log.getRange('A1:C1').setValues([['Время', 'Событие', 'Детали']]);
  log.getRange('A1:C1').setFontWeight('bold').setBackground('#2C3E50').setFontColor('#FFFFFF');
  log.setColumnWidth(1, 150); log.setColumnWidth(2, 200); log.setColumnWidth(3, 560);
  log.setFrozenRows(1);

  ensureSourceRegistry_();

  SpreadsheetApp.getUi().alert(
    '✅ Таблица настроена.\n\n' +
    'Словарь: ' + dictRows.length + ' слов. Дополняй его сам на листе СЛОВАРЬ.\n\n' +
    'Дальше:\n' +
    '1. «🔍 Диагностика источников» — проверить, какие сайты реально отдают контент боту.\n' +
    '2. «▶ Проверить сейчас» — первый мониторинг.\n\n' +
    'Точные попадания → лист НАХОДКИ.\n' +
    'Сомнительные → лист НА ПРОВЕРКУ (страховка, чтобы ничего не упустить).'
  );
}


function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function skoLog_(event, details) {
  var log = SpreadsheetApp.getActive().getSheetByName(CFG.LOG);
  if (!log) return;
  log.appendRow([new Date(), event, (details || '').toString().slice(0, 900)]);

  // Самоочистка: держим не больше LOG_MAX строк (старые уходят сверху).
  // Проверяем не каждый раз, а с запасом 60 строк — чтобы не тормозить.
  var last = log.getLastRow();
  if (last > CFG.LOG_MAX + 60) {
    log.deleteRows(2, last - CFG.LOG_MAX - 1);   // строка 1 — шапка
  }
}

// Мгновенная самопроверка: какой код работает и жива ли память.
// Если версия не совпадает с последней или ключей 0 после прогонов —
// значит работает СТАРОЕ развёртывание/код.
function diagnoseMemory() {
  var lines = ['Версия кода: ' + CODE_VERSION, ''];
  ['_ПАМЯТЬ_СМИ', '_ПАМЯТЬ_КАНАЛА', '_ПАМЯТЬ_ПОЗИТИВ', '_ПАМЯТЬ_ПАБЛИКИ'].forEach(function(n) {
    var sh = SpreadsheetApp.getActive().getSheetByName(n);
    if (!sh) {
      lines.push('✗ ' + n + ' — ЛИСТА НЕТ (память не работала ни разу)');
    } else {
      var rows = sh.getLastRow();
      lines.push((rows > 0 ? '✓ ' : '⚠ ') + n + ' — ключей: ' + rows);
    }
  });
  lines.push('');
  lines.push('Последняя проверка: ' + (getLastRunStamp_() || 'не найдена'));
  lines.push('');
  lines.push('⏱ РАСХОД КВОТЫ СЕГОДНЯ: ' + todayQuotaUsage_());
  lines.push('');
  lines.push('Если ключей 0 после прогонов или листов нет —');
  lines.push('работает старый код: обнови файл и РАЗВЁРТЫВАНИЕ (Новая версия).');
  SpreadsheetApp.getUi().alert('🧪 Память и версия\n\n' + lines.join('\n'));
}

// Считает, сколько минут работы скриптов израсходовано сегодня.
// Лимит Google — 90 минут в сутки на обычном аккаунте.
function todayQuotaUsage_() {
  try {
    var log = SpreadsheetApp.getActive().getSheetByName(CFG.LOG);
    if (!log || log.getLastRow() < 2) return 'нет данных';
    var tz = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy');
    var n = Math.min(500, log.getLastRow() - 1);
    var rows = log.getRange(log.getLastRow() - n + 1, 1, n, 3).getValues();

    var totalSec = 0, runs = 0;
    rows.forEach(function(r) {
      var when = r[0];
      if (!(when instanceof Date)) return;
      if (Utilities.formatDate(when, tz, 'dd.MM.yyyy') !== today) return;
      var m = (r[2] || '').toString().match(/длительность:\s*(\d+)\s*сек/);
      if (m) { totalSec += parseInt(m[1], 10); runs++; }
    });

    if (!runs) return 'нет замеров (обновлён код — счёт начнётся со следующего прогона)';
    var mins = Math.round(totalSec / 60);
    var pct = Math.round(mins / 90 * 100);
    var bar = pct < 60 ? '🟢' : (pct < 85 ? '🟡' : '🔴');
    return bar + ' ' + mins + ' из 90 мин (' + pct + '%), прогонов: ' + runs;
  } catch (e) { return 'ошибка подсчёта'; }
}

function clearSkoFindings() {
  var ss = SpreadsheetApp.getActive();
  [CFG.FINDINGS, CFG.MAYBE].forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
  });
  SpreadsheetApp.getUi().alert('Находки очищены. Память ссылок сохранена.');
}

function resetSkoMemory() {
  ['_ПАМЯТЬ_СМИ', '_ПАМЯТЬ_ПОЗИТИВ', '_ПАМЯТЬ_ПАБЛИКИ', '_ПАМЯТЬ_КАНАЛА'].forEach(function(n) {
    var sh = SpreadsheetApp.getActive().getSheetByName(n);
    if (sh) sh.clearContents();
  });
  var queue = SpreadsheetApp.getActive().getSheetByName(TG_QUEUE_SHEET);
  if (queue && queue.getLastRow() > 1) queue.deleteRows(2, queue.getLastRow() - 1);
  PropertiesService.getScriptProperties().deleteProperty(CFG.SEEN_KEY);
  SpreadsheetApp.getUi().alert('Память сброшена — при следующей проверке бот покажет всё заново (в канал уйдёт много сообщений!).');
}


// ============================================================
//  ЧТЕНИЕ СЛОВАРЯ И СТОП-СЛОВ ИЗ ТАБЛИЦЫ
// ============================================================
function loadDictionary_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.DICT);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function(r) { return (r[0] || '').toString().trim(); })
    .filter(function(w) { return w.length >= 3; });
}

function loadStopWords_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.STOP);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function(r) { return (r[0] || '').toString().trim(); })
    .filter(function(w) { return w.length >= 2; });
}

function loadSources_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG.SOURCES);
  var sources = [];
  if (sh && sh.getLastRow() >= 2) {
    sources = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
      .map(function(r) {
        return { url: (r[0] || '').toString().trim(), name: (r[1] || '').toString().trim() };
      })
      .filter(function(s) { return /^https?:\/\//i.test(s.url); });
  }

  // Новые адреса берутся из общего реестра, старый лист ИСТОЧНИКИ
  // продолжает работать. Пользовательские строки объединяются без потерь.
  try {
    loadRegistrySources_({ scope: 'republican', platform: 'website', workflow: 'sko_mentions' })
      .forEach(function(s) { sources.push({ url: s.url, name: s.name }); });
  } catch (eRegistry) {}

  var seen = {};
  return sources.filter(function(s) {
    var key = urlKey_(s.url);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}



// ============================================================
//  ПОИСК СЛОВА В ТЕКСТЕ С УЧЁТОМ ГРАНИЦ
//
//  КРИТИЧНО: короткие аббревиатуры (СКО, ЗКО, ВКО) нельзя искать
//  простым indexOf — "ско" есть внутри "ЖамбылСКОй", "ПавлодарСКОй",
//  "КазахстанСКОй". Такие слова ищем только как отдельное слово.
//  \b в JavaScript не работает с кириллицей, поэтому проверяем
//  символы вокруг вручную.
// ============================================================
function isWordChar_(ch) {
  return /[0-9a-zа-яёәғқңөұүһіŋ]/i.test(ch || '');
}

function containsWord_(text, word) {
  var t = (text || '').toLowerCase();
  var w = (word || '').toLowerCase().trim();
  if (!t || !w) return false;

  // Длинные слова и фразы — обычный поиск подстроки (ловит падежи:
  // "Петропавловск" найдётся в "Петропавловске", "Петропавловска")
  if (w.length >= 6 || w.indexOf(' ') !== -1) return t.indexOf(w) !== -1;

  // Короткие (до 5 символов) — только как отдельное слово
  var idx = 0;
  while ((idx = t.indexOf(w, idx)) !== -1) {
    var before = idx > 0 ? t.charAt(idx - 1) : '';
    var after  = (idx + w.length < t.length) ? t.charAt(idx + w.length) : '';
    if (!isWordChar_(before) && !isWordChar_(after)) return true;
    idx += w.length;
  }
  return false;
}


// ============================================================
//  ПРОВЕРКА ТЕКСТА ПО СЛОВАРЮ
//  Возвращает: {status: 'hit'|'maybe'|'no', matched: [...], reason: '...'}
// ============================================================
function checkTextForSko_(text, dict, stopWords) {
  var low = (text || '').toLowerCase();
  if (!low) return { status: 'no' };

  // 1. Сначала стоп-слова: если новость про ЗКО/Жамбылскую область — не наша
  var stopHits = [];
  for (var s = 0; s < stopWords.length; s++) {
    if (containsWord_(low, stopWords[s])) stopHits.push(stopWords[s]);
  }

  // 2. Ищем слова словаря
  var matched = [];
  for (var d = 0; d < dict.length; d++) {
    if (containsWord_(low, dict[d])) {
      matched.push(dict[d]);
      if (matched.length >= 4) break;   // хватит для отчёта
    }
  }

  if (matched.length === 0) {
    // 3. Страховка: похоже на новость о каком-то населённом пункте,
    //    но конкретики нет — отправим на ручную проверку
    if (/\b(сел[оае]|аул[еа]?|посёл|поселок|район[еа]?|область|облысы|ауданы)\b/i.test(low)
        && /\b(казахстан|қазақстан)\b/i.test(low)) {
      return { status: 'maybe', reason: 'Упоминается населённый пункт/район, но нет слов из словаря' };
    }
    return { status: 'no' };
  }

  // 4. Есть совпадения, но есть и стоп-слово — на проверку, не выбрасываем
  if (stopHits.length > 0) {
    return {
      status: 'maybe',
      matched: matched,
      reason: 'Найдено: ' + matched.join(', ') + ' — НО есть стоп-слово: ' + stopHits.join(', ')
    };
  }

  return { status: 'hit', matched: matched };
}


// ============================================================
//  ЗАГРУЗКА СТРАНИЦЫ С МНОГОУРОВНЕВЫМ ФОЛБЭКОМ
//  Если главная не отдала контент — пробуем типовые пути и RSS.
// ============================================================
function fetchWithFallback_(baseUrl) {
  var candidates = [baseUrl];
  var parts = getParts_(baseUrl);
  if (parts) {
    var root = parts.protocol + '://' + parts.host;
    if (parts.path === '/' || parts.path === '') {
      candidates.push(root + '/news/', root + '/novosti/', root + '/ru/',
                      root + '/rss/', root + '/rss.xml', root + '/feed/');
    } else {
      // Даже если задан раздел — при неудаче пробуем корень и типовые RSS
      candidates.push(root + '/', root + '/rss/', root + '/rss.xml', root + '/feed/');
    }
  }

  for (var i = 0; i < candidates.length; i++) {
    try {
      var resp = UrlFetchApp.fetch(candidates[i], {
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true,
        validateHttpsCertificates: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8'
        }
      });
      if (resp.getResponseCode() < 400) {
        var body = resp.getContentText();
        if (body && body.length > 500) {
          return { ok: true, url: candidates[i], body: body, code: resp.getResponseCode() };
        }
      }
    } catch (e) {
      // пробуем следующий вариант
    }
  }
  return { ok: false, url: baseUrl };
}


// ============================================================
//  ИЗВЛЕЧЕНИЕ ЗАГОЛОВКОВ + ССЫЛОК (HTML или RSS)
// ============================================================
function extractItems_(body, sourceUrl) {
  // RSS/Atom?
  if (/<(rss|feed)\b/i.test(body.slice(0, 2000))) {
    return extractFromRss_(body, sourceUrl);
  }
  return extractFromHtml_(body, sourceUrl);
}

function extractFromRss_(xml, sourceUrl) {
  var items = [];
  var blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  blocks.forEach(function(b) {
    var title = tagVal_(b, 'title');
    var link  = tagVal_(b, 'link') || attrVal_(b, 'link', 'href');
    var descRaw = tagVal_(b, 'description') || tagVal_(b, 'summary');
    if (!title || !link) return;

    // ОРИГИНАЛЬНАЯ ссылка вместо гугловской: Google News кладёт её
    // в description как <a href="https://оригинальный-сайт/...">
    var realUrl = absUrl_(link, sourceUrl);
    if (/news\.google\./i.test(realUrl)) {
      var am = (descRaw || '').match(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/i);
      if (am && !/news\.google\./i.test(am[1])) realUrl = decodeEnt_(am[1]);
    }

    // Имя источника (Google News даёт его в <source>)
    var srcName = clean_(tagVal_(b, 'source'));

    // Дата публикации
    var pubRaw = tagVal_(b, 'pubDate') || tagVal_(b, 'published') || tagVal_(b, 'updated');
    var pubDate = pubRaw ? new Date(pubRaw) : null;
    if (pubDate && isNaN(pubDate.getTime())) pubDate = null;

    items.push({
      title: clean_(title),
      url: realUrl,
      extra: clean_(strip_(descRaw || '')),
      pubDate: pubDate,
      srcName: srcName
    });
  });
  return items;
}

// Тональность по негатив-маркерам: 🔴 — есть маркер, 🟢 — чисто
function detectTone_(text, toneWords) {
  if (!toneWords || !toneWords.length) return '';
  var low = (text || '').toLowerCase();
  for (var i = 0; i < toneWords.length; i++) {
    if (low.indexOf(toneWords[i]) !== -1) return '🔴';
  }
  return '🟢';
}

// Дата из текста заголовка: "03.07.26", "03.07.2026", "19 июля 2026"
// (сайты вроде Inbusiness/Qumash пишут дату рубрики прямо в заголовок)
var MONTH_GEN_RE = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
var MONTH_GEN_MAP = {'января':0,'февраля':1,'марта':2,'апреля':3,'мая':4,'июня':5,
                     'июля':6,'августа':7,'сентября':8,'октября':9,'ноября':10,'декабря':11};

function dateFromText_(text) {
  var s = String(text || '');
  // 03.07.26 или 03.07.2026
  var m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) {
    var y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (y >= 2020 && y <= 2035) {
      return new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    }
  }
  // "19 июля 2026" или "19 июля"
  var m2 = s.match(new RegExp('(\\d{1,2})\\s+(' + MONTH_GEN_RE + ')(?:\\s+(20\\d{2}))?', 'i'));
  if (m2) {
    var y2 = m2[3] ? parseInt(m2[3], 10) : new Date().getFullYear();
    return new Date(y2, MONTH_GEN_MAP[m2[2].toLowerCase()], parseInt(m2[1], 10));
  }
  return null;
}

// Если оригинал не вытащился из description — достаём его со страницы
// google news (там всегда есть прямая ссылка). Не больше 8 резолвов
// за прогон, чтобы не жечь время.
var __gnResolveBudget = 8;
function resolveGoogleNewsUrl_(gUrl) {
  if (__gnResolveBudget <= 0) return gUrl;
  __gnResolveBudget--;
  try {
    var resp = UrlFetchApp.fetch(gUrl, { muteHttpExceptions: true, followRedirects: true });
    var html = resp.getContentText();
    var m = html.match(/href="(https?:\/\/(?!news\.google|www\.google|accounts|support\.google|policies)[^"]{15,})"/i);
    if (m) return decodeEnt_(m[1]);
  } catch (e) {}
  return gUrl;
}

// Дата из URL статьи: /2026/07/19/... или /19-07-2026/...
function dateFromUrl_(url) {
  var s = String(url || '');
  var m = s.match(/\/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[\/.-]|$)/);
  if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
  m = s.match(/\/(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})(?:[\/.-]|$)/);
  if (m) return new Date(parseInt(m[3],10), parseInt(m[2],10)-1, parseInt(m[1],10));
  return null;
}

function extractFromHtml_(html, sourceUrl) {
  var body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');

  var items = [];
  var seen = {};
  var re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;

  while ((m = re.exec(body)) !== null && items.length < CFG.MAX_PER_SITE * 3) {
    var url = absUrl_(decodeEnt_(m[1]), sourceUrl);
    var title = clean_(strip_(m[2]));
    if (!url || !title || title.length < 12) continue;
    if (!sameHost_(url, sourceUrl)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|mp3|mp4|css|js)(\?|$)/i.test(url)) continue;
    if (/\/(tag|tags|author|search|login|register|wp-admin|wp-content|advert)\b/i.test(url)) continue;
    if (/\/page\/\d+\/?$/.test(url)) continue;

    var p = getParts_(url);
    if (p && p.path.split('/').filter(Boolean).length < 2) continue;

    var key = url.replace(/\/$/, '').toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;

    items.push({ title: title, url: url, extra: '' });
    if (items.length >= CFG.MAX_PER_SITE) break;
  }
  return items;
}


// ============================================================
//  ГЛАВНАЯ ПРОВЕРКА
// ============================================================
function runSkoCheck() {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) { ui.alert('Проверка уже идёт.'); return; }
  try {
    var r = runSkoCheckCore_();
    ui.alert(r.message);
  } catch (err) {
    skoLog_('Ошибка', err && err.stack ? err.stack : String(err));
    ui.alert('Ошибка: ' + (err.message || err) + '\n\nСмотри лист ЖУРНАЛ.');
  } finally {
    lock.releaseLock();
  }
}

// Тихая версия для автотриггера — БЕЗ каких-либо UI-вызовов
// (в триггерах SpreadsheetApp.getUi() недоступен и роняет скрипт)
function runSkoCheckSilent() {
  // НОЧНОЙ РЕЖИМ: с 23:00 до 06:00 новости почти не выходят —
  // проверяем раз в час, чтобы днём хватило квоты на режим "каждые 15 минут".
  var hourNow = new Date().getHours();
  if (hourNow >= 23 || hourNow < 6) {
    var props0 = PropertiesService.getScriptProperties();
    var lastNight = Number(props0.getProperty('last_night_run') || 0);
    if (lastNight && (Date.now() - lastNight) < 55 * 60 * 1000) return;
    props0.setProperty('last_night_run', String(Date.now()));
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;   // другая проверка идёт — тихо выходим
  try {
    runSkoCheckCore_();
  } catch (err) {
    skoLog_('Ошибка (авто)', err && err.stack ? err.stack : String(err));
    // Особый случай: закончилась суточная квота выполнения
    var em = (err && err.message) || String(err);
    if (/exceeded|quota|too many|maximum execution/i.test(em)) {
      notifyAdmin_('🔴 <b>Исчерпана суточная квота Google</b>\n' +
        'Мониторинг остановлен до следующих суток.\n' +
        'Причина: слишком много прогонов (обычно из-за глубокого поиска).\n' +
        'Что делать: сегодня не запускать архивный поиск, ' +
        'либо увеличить интервал автопроверки.');
      return;
    }
    // Сообщаем владельцу в личку — сбой не останется незамеченным
    notifyAdmin_('⚠️ <b>Автопроверка упала с ошибкой</b>\n' +
      tgEsc_((err && err.message) || String(err)).slice(0, 500) +
      '\n\nПодробности — лист ЖУРНАЛ.');
  } finally {
    lock.releaseLock();
  }
}

// Общее ядро проверки. Возвращает {message, hits, maybes}
function runSkoCheckCore_() {
  var started = Date.now();

  var sources = loadSources_();
  // Региональные СМИ в общий мониторинг НЕ входят (решение пользователя):
  // республиканский поток — только республика. Регионалки живут отдельно:
  // кнопки "Позитив" и "Глубокий поиск".

  var dict = loadDictionary_();
  var stopWords = loadStopWords_();
  if (!dict.length) return { message: 'Словарь пуст. Запусти «1. Настроить таблицу».', hits: 0, maybes: 0 };

  // Негатив-маркеры для тональности находок (🔴 негатив / 🟢 нейтрал-позитив)
  var toneWords = [];
  try {
    var negSh = SpreadsheetApp.getActive().getSheetByName(CFG_NEG_SHEET);
    if (negSh && negSh.getLastRow() >= 2) {
      toneWords = negSh.getRange(2, 1, negSh.getLastRow() - 1, 1).getValues()
        .map(function(r) { return (r[0] || '').toString().trim().toLowerCase(); })
        .filter(function(w) { return w.length >= 3; });
    }
  } catch (e) {}

  __gnResolveBudget = 8;
  skoLog_('Старт ' + CODE_VERSION, 'Источников: ' + sources.length + ' + Google News, слов: ' + dict.length);

  var seen = loadSeen_();
  var hits = [], maybes = [];
  var checkedNew = 0;
  var siteReport = [];

  // --- 1. Прямой обход сайтов: ПАРАЛЛЕЛЬНАЯ первая волна ---
  // fetchAll опрашивает все сайты одновременно (~30 сек вместо ~3 мин).
  // Кому параллельная волна не помогла — добиваем старым fetchWithFallback_.
  // Убираем временно отключённые источники (экономия времени прогона)
  var dead = deadSources_();
  var deadCount = 0;
  sources = sources.filter(function(s) {
    if (dead[s.name]) { deadCount++; return false; }
    return true;
  });
  if (deadCount) skoLog_('Пропущено мёртвых источников', String(deadCount));

  var firstWave = {};
  try {
    var reqs = sources.map(function(s) {
      return {
        url: s.url,
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true,
        validateHttpsCertificates: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8'
        }
      };
    });
    var resps = UrlFetchApp.fetchAll(reqs);
    for (var w = 0; w < resps.length; w++) {
      try {
        var rw = resps[w];
        if (rw && rw.getResponseCode() < 400) {
          var bw = rw.getContentText();
          if (bw && bw.length > 500) firstWave[sources[w].url] = bw;
        }
      } catch (ew) {}
    }
    skoLog_('Параллельная волна', 'Успешно сразу: ' + Object.keys(firstWave).length + ' из ' + sources.length);
  } catch (eAll) {
    skoLog_('fetchAll недоступен', (eAll.message || String(eAll)).slice(0, 200) + ' — иду последовательно');
  }

  for (var i = 0; i < sources.length; i++) {
    if (Date.now() - started > CFG.MAX_RUNTIME - CFG.SAFETY_STOP) {
      skoLog_('Стоп по времени', 'Сайтов обработано: ' + i + ' из ' + sources.length);
      break;
    }
    var src = sources[i];
    var res;
    if (firstWave[src.url]) {
      res = { ok: true, url: src.url, body: firstWave[src.url] };
    } else {
      res = fetchWithFallback_(src.url);
    }
    if (!res.ok) {
      skoLog_('Сайт не отдал', src.name);
      siteReport.push(src.name + ':✗');
      trackSourceFail_(src.name);   // алерт владельцу после 3 провалов подряд
      continue;
    }
    trackSourceOk_(src.name);

    var items = extractItems_(res.body, res.url);
    if (!items.length) { skoLog_('Пусто', src.name); siteReport.push(src.name + ':0'); continue; }

    var staleLimit = new Date(Date.now() - 24 * 60 * 60 * 1000);   // только сутки
    var newCount = 0;
    items.forEach(function(it) {
      var key = urlKey_(it.url);
      if (seen[key]) return;

      // Вторая линия: тот же заголовок только у того же источника.
      // Одинаковые материалы разных СМИ должны сохраняться отдельно.
      var hostChk = hostOf_(it.url);
      var tkey = sourceTitleKey_(it.url, src.name, it.title);
      if (seen[tkey]) { seen[key] = true; return; }

      // Регионалка никогда не идёт в республиканский поток
      if (REGIONAL_HOSTS_BUILTIN.indexOf(hostChk) !== -1) { seen[key] = true; return; }

      // Дата из RSS, из URL или из текста заголовка; старые (2+ суток) пропускаем
      var pub = it.pubDate || dateFromUrl_(it.url) || dateFromText_(it.title);
      if (pub && pub < staleLimit) { seen[key] = true; return; }

      newCount++; checkedNew++;
      var v = checkTextForSko_(it.title + ' ' + (it.extra || ''), dict, stopWords);
      if (v.status === 'hit') {
        hits.push({ src: src.name || hostOf_(src.url), title: it.title, url: it.url,
                    note: detectTone_(it.title, toneWords) + ' ' + (v.matched || []).join(', '),
                    pub: pub });
      } else if (v.status === 'maybe') {
        maybes.push({ src: src.name || hostOf_(src.url), title: it.title, url: it.url,
                      note: v.reason || '', pub: pub });
      }
      seen[key] = true;
      seen[tkey] = true;
    });
    siteReport.push(src.name + ':' + newCount);
  }

  // --- 2. Google News RSS: страховочный слой по ВСЕМ СМИ сразу ---
  // when:1d = только за последние сутки. Плюс фильтр по pubDate ниже.
  var freshLimit = new Date(Date.now() - 24 * 60 * 60 * 1000);   // не старше 24 часов

  // Домены региональных СМИ — их новости НЕ идут в республиканский поток
  // (они мониторятся отдельно кнопками регионалки/позитива)
  var regionalHosts = {};
  REGIONAL_HOSTS_BUILTIN.forEach(function(h) { regionalHosts[h] = true; });
  try {
    var regSh = SpreadsheetApp.getActive().getSheetByName(CFG_REGIONAL_SHEET);
    if (regSh && regSh.getLastRow() >= 2) {
      regSh.getRange(2, 1, regSh.getLastRow() - 1, 1).getValues().forEach(function(r) {
        var u = (r[0] || '').toString().trim();
        if (/^https?:\/\//i.test(u)) regionalHosts[hostOf_(u)] = true;
      });
    }
  } catch (e) {}
  try {
    loadRegistrySources_({ scope: 'regional', platform: 'website' }).forEach(function(s) {
      regionalHosts[hostOf_(s.url)] = true;
    });
  } catch (eRegistry) {}

  var gnFound = 0;
  for (var q = 0; q < GOOGLE_NEWS_QUERIES.length; q++) {
    if (Date.now() - started > CFG.MAX_RUNTIME - CFG.SAFETY_STOP) break;
    try {
      var gnUrl = 'https://news.google.com/rss/search?q=' +
        encodeURIComponent(GOOGLE_NEWS_QUERIES[q] + ' when:1d') +
        '&hl=ru&gl=KZ&ceid=KZ:ru';
      var gnResp = UrlFetchApp.fetch(gnUrl, { muteHttpExceptions: true, followRedirects: true });
      if (gnResp.getResponseCode() >= 400) { skoLog_('Google News HTTP', gnResp.getResponseCode()); continue; }

      var gnItems = extractFromRss_(gnResp.getContentText(), gnUrl);
      gnItems.forEach(function(it) {
        var key = urlKey_(it.url);
        if (seen[key]) return;

        // До раскрытия Google-ссылки проверяем только точный URL.
        // Источник заголовка станет известен после resolveGoogleNewsUrl_.
        var gnHost = hostOf_(it.url);

        // ФИЛЬТР СВЕЖЕСТИ: только за последние сутки
        if (it.pubDate && it.pubDate < freshLimit) { seen[key] = true; return; }

        // Региональные СМИ в республиканский поток не пускаем (у них свой контур).
        // Проверяем и домен, и имя источника, и хвост заголовка — GN-находки
        // с невытащенным оригиналом имеют гугловский домен!
        if (regionalHosts[gnHost] ||
            REGIONAL_NAME_RE.test((it.srcName || '') + ' ' + (it.title || ''))) {
          seen[key] = true; return;
        }

        checkedNew++;
        var v = checkTextForSko_(it.title + ' ' + (it.extra || ''), dict, stopWords);
        var srcLabel = it.srcName || hostOf_(it.url);
        if (v.status === 'hit') {
          // Если ссылка осталась гугловской — дожимаем оригинал со страницы GN
          var finalUrl = it.url;
          if (/news\.google\./i.test(finalUrl)) finalUrl = resolveGoogleNewsUrl_(finalUrl);
          var finalKey = urlKey_(finalUrl);
          var finalTitleKey = sourceTitleKey_(finalUrl, srcLabel, it.title);
          if (seen[finalKey] || seen[finalTitleKey]) {
            seen[key] = true;
            return;
          }
          // После резолва могла вскрыться регионалка — отсекаем и её
          if (isRegionalFinding_({ url: finalUrl, src: srcLabel, title: it.title })) {
            seen[key] = true; return;
          }
          hits.push({ src: srcLabel, title: it.title, url: finalUrl,
                      note: detectTone_(it.title, toneWords) + ' ' + (v.matched || []).join(', '),
                      pub: it.pubDate });
          seen[finalKey] = true;
          seen[finalTitleKey] = true;
          gnFound++;
        } else if (v.status === 'maybe') {
          var maybeTitleKey = sourceTitleKey_(it.url, srcLabel, it.title);
          if (seen[maybeTitleKey]) { seen[key] = true; return; }
          maybes.push({ src: srcLabel, title: it.title, url: it.url,
                        note: v.reason || '', pub: it.pubDate });
          seen[maybeTitleKey] = true;
        }
        seen[key] = true;
      });
    } catch (e) {
      skoLog_('Google News ошибка', e.message || String(e));
    }
  }
    skoLog_('Google News', 'Найдено через Google: ' + gnFound);

  writeRows_(CFG.FINDINGS, hits);
  writeRows_(CFG.MAYBE, maybes);
  saveSeen_(seen);

  // Мгновенные уведомления коллегам в Telegram-канал
  sendFindingsToTelegram_(hits, 'СКО в СМИ');

  var elapsedSec = Math.round((Date.now() - started) / 1000);
  skoLog_('Готово', 'Находок: ' + hits.length + ', на проверку: ' + maybes.length +
    ' | длительность: ' + elapsedSec + ' сек');

  return {
    message: '✅ Проверка завершена\n\n' +
      'Просмотрено ранее не виденных материалов: ' + checkedNew + '\n' +
      '🎯 Упоминаний СКО: ' + hits.length + '\n' +
      '❓ На проверку: ' + maybes.length + '\n\n' +
      'По сайтам (новых): ' + siteReport.join(' | ') + '\n' +
      'Через Google News: ' + gnFound + '\n\n' +
      'Смотри листы НАХОДКИ и НА ПРОВЕРКУ.',
    hits: hits.length,
    maybes: maybes.length
  };
}


// ============================================================
//  ДИАГНОСТИКА ИСТОЧНИКОВ
//  Честный тест ИЗ APPS SCRIPT: какой сайт реально отдаёт контент боту.
// ============================================================
function diagnoseSources() {
  var ui = SpreadsheetApp.getUi();
  var started = Date.now();
  var sources = loadSources_();
  if (!sources.length) { ui.alert('Лист ИСТОЧНИКИ пуст.'); return; }

  var lines = [];
  var okCount = 0, failCount = 0;

  for (var i = 0; i < sources.length; i++) {
    if (Date.now() - started > CFG.MAX_RUNTIME - CFG.SAFETY_STOP) {
      lines.push('… остальные не проверены (лимит времени)');
      break;
    }
    var src = sources[i];
    var res = fetchWithFallback_(src.url);

    if (!res.ok) {
      lines.push('✗ ' + (src.name || src.url) + ' — не открылся');
      skoLog_('Диагностика', src.url + ' → НЕ ОТКРЫЛСЯ');
      failCount++;
      continue;
    }

    var items = extractItems_(res.body, res.url);
    var usedFallback = res.url !== src.url;

    if (items.length === 0) {
      lines.push('⚠ ' + (src.name || src.url) + ' — открылся, но 0 заголовков (вероятно JS-лента)');
      skoLog_('Диагностика', src.url + ' → открылся, 0 заголовков');
      failCount++;
    } else {
      lines.push('✓ ' + (src.name || src.url) + ' — ' + items.length + ' заголовков' +
                 (usedFallback ? ' (через ' + res.url + ')' : ''));
      skoLog_('Диагностика', src.url + ' → ' + items.length + ' заголовков' +
              (usedFallback ? ', фолбэк: ' + res.url : ''));
      okCount++;
    }
  }

  ui.alert(
    '🔍 Диагностика источников\n\n' +
    'Работают: ' + okCount + ' | Проблемные: ' + failCount + '\n\n' +
    lines.join('\n') + '\n\n' +
    'Подробности — на листе ЖУРНАЛ.\n' +
    'Проблемные сайты можно удалить с листа ИСТОЧНИКИ или заменить URL на прямую ленту новостей.'
  );
}


// ============================================================
//  ЗАПИСЬ РЕЗУЛЬТАТОВ
// ============================================================
function writeRows_(sheetName, rows) {
  if (!rows || !rows.length) return;
  var sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) return;

  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'dd.MM HH:mm');
  var data = rows.map(function(r) {
    var pubTxt = '';
    if (r.pub) {
      try { pubTxt = Utilities.formatDate(r.pub, tz, 'dd.MM.yyyy HH:mm'); }
      catch (e) { pubTxt = ''; }
    }
    return [stamp, pubTxt, r.src, r.title, r.url, r.note];
  });

  sh.insertRowsAfter(1, data.length);
  sh.getRange(2, 1, data.length, 6).setValues(data);
  sh.getRange(2, 5, data.length, 1).setFontColor('#1155CC');

  // Самоочистка: новые сверху, значит старейшие — внизу. Держим лимит.
  var last = sh.getLastRow();
  if (last > CFG.FINDINGS_MAX + 60) {
    sh.deleteRows(CFG.FINDINGS_MAX + 1, last - CFG.FINDINGS_MAX);
  }
}


// ============================================================
//  ПАМЯТЬ ССЫЛОК МЕЖДУ ЗАПУСКАМИ — НА СКРЫТЫХ ЛИСТАХ
//
//  КРИТИЧНО: раньше память жила в PropertiesService, но у него лимит
//  9 КБ на значение, а 3000 ссылок весят ~180 КБ. Запись ТИХО ПАДАЛА,
//  память не сохранялась — и каждый прогон показывал всё "новым":
//  отсюда дубли, старые новости и повторные регионалки.
//  Листы таблицы лимитов не имеют. Листы скрыты от глаз.
// ============================================================
var __seenBaseline = {};   // что было в памяти на старте прогона (для дозаписи только нового)

function seenPolicy_(name) {
  if (name === '_ПАМЯТЬ_КАНАЛА') return { max: 50000, days: 365 };
  if (name === '_ПАМЯТЬ_ПАБЛИКИ') return { max: 25000, days: 120 };
  if (name === '_ПАМЯТЬ_ПОЗИТИВ') return { max: 15000, days: 120 };
  return { max: CFG.SEEN_MAX, days: 45 };
}

function seenSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.hideSheet();
  }
  return sh;
}

function loadSeenSheet_(name) {
  var sh = seenSheet_(name);
  var map = {};
  var last = sh.getLastRow();
  var policy = seenPolicy_(name);

  // Старые строки находятся сверху, поэтому сначала ограничиваем объём
  // чтения. Это не база публикаций: остаются только технические ключи.
  if (last > policy.max + 500) {
    sh.deleteRows(1, last - policy.max);
    last = sh.getLastRow();
  }
  if (last >= 1) {
    var vals = sh.getRange(1, 1, last, 2).getValues();
    var cutoff = Date.now() - policy.days * 24 * 60 * 60 * 1000;
    for (var i = 0; i < vals.length; i++) {
      var k = (vals[i][0] || '').toString();
      var stamp = vals[i][1];
      // Старый формат был без даты. Не выбрасываем его при обновлении.
      if (k && (!(stamp instanceof Date) || stamp.getTime() >= cutoff)) map[k] = true;
    }
  }
  __seenBaseline[name] = {};
  Object.keys(map).forEach(function(k) { __seenBaseline[name][k] = true; });
  return map;
}

function saveSeenSheet_(name, map) {
  var sh = seenSheet_(name);
  var base = __seenBaseline[name] || {};
  var fresh = Object.keys(map).filter(function(k) { return !base[k]; });
  if (fresh.length) {
    var now = new Date();
    var rows = fresh.map(function(k) { return [k, now]; });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
    if (!__seenBaseline[name]) __seenBaseline[name] = {};
    fresh.forEach(function(k) { __seenBaseline[name][k] = true; });
  }
  // Обрезка старья, чтобы лист не рос бесконечно
  var total = sh.getLastRow();
  var policy = seenPolicy_(name);
  if (total > policy.max + 500) {
    sh.deleteRows(1, total - policy.max);
  }
}

// Совместимость со старыми вызовами основного мониторинга
function loadSeen_() { return loadSeenSheet_('_ПАМЯТЬ_СМИ'); }
function saveSeen_(map) { saveSeenSheet_('_ПАМЯТЬ_СМИ', map); }


// ============================================================
//  УТИЛИТЫ
// ============================================================
function getParts_(url) {
  var m = String(url || '').match(/^(https?):\/\/([^\/?#]+)([^?#]*)?/i);
  if (!m) return null;
  return { protocol: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] || '/' };
}

function hostOf_(url) {
  var p = getParts_(url);
  return p ? p.host.replace(/^www\./, '') : url;
}

// Ключ для памяти ссылок: без протокола, www, завершающего слэша
// и трекинг-параметров (utm_*, fbclid и т.п.) — чтобы одна и та же
// статья, пришедшая разными путями, считалась ОДНОЙ.
function urlKey_(url) {
  var raw = String(url || '').trim().replace(/&amp;/g, '&').replace(/#.*$/, '');
  raw = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

  var qPos = raw.indexOf('?');
  var base = qPos === -1 ? raw : raw.slice(0, qPos);
  var query = qPos === -1 ? '' : raw.slice(qPos + 1);

  // Telegram иногда выдаёт один канал как t.me/name и t.me/s/name.
  base = base.replace(/^t\.me\/s\//i, 't.me/');
  base = base.replace(/\/$/, '');

  var kept = [];
  query.split('&').forEach(function(part) {
    if (!part) return;
    var eq = part.indexOf('=');
    var key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    if (/^utm_/.test(key) ||
        /^(fbclid|yclid|gclid|igsh|igshid|mibextid|ref|ref_src|from|source|share|_r|_t)$/.test(key)) return;
    kept.push(part);
  });
  kept.sort();
  return (base + (kept.length ? '?' + kept.join('&') : '')).toLowerCase();
}

// Нормализация заголовка для сравнения:
// - отрезаем хвост " - Источник", который добавляет Google News
//   (иначе "В СКО завод" и "В СКО завод - Казинформ" = разные ключи);
// - убираем даты и время, вшитые в заголовок некоторыми сайтами;
// - оставляем первые 10 слов.
function normalizeTitleForKey_(title) {
  var t = String(title || '').toLowerCase();
  t = t.replace(/\s*[-–—]\s*[^-–—]{2,45}\s*$/, ' ');          // хвост источника
  t = t.replace(/\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/g, ' ');      // 20.07.2026
  t = t.replace(/\d{1,2}:\d{2}/g, ' ');                        // 11:17
  t = t.replace(/\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(\s+20\d{2})?/g, ' ');
  t = t.replace(/[^0-9a-zа-яёәғқңөұүһі\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').slice(0, 10).join(' ');
}

// ГЛОБАЛЬНЫЙ ключ заголовка — БЕЗ домена. Ловит одну и ту же новость,
// пришедшую разными путями (Google News / прямой обход / другой адрес).
function globalTitleKey_(title) {
  return 'gt|' + normalizeTitleForKey_(title);
}

// Заголовок считается дублем только внутри одного СМИ. Если Google News
// не раскрыл исходный домен, используем имя источника из RSS, а не общий
// news.google.com. Так одинаковый текст у двух разных изданий не теряется.
function sourceTitleKey_(url, sourceName, title) {
  var host = hostOf_(url);
  if (/^news\.google\./i.test(host) && sourceName) {
    host = 'source:' + String(sourceName).toLowerCase()
      .replace(/[^0-9a-zа-яёәғқңөұүһі]+/gi, '_')
      .replace(/^_+|_+$/g, '');
  }
  return titleKey_(host, title);
}

// Ключ по заголовку: сайт + первые 8 слов заголовка без знаков.
// Вторая линия защиты: та же новость под другим URL не пройдёт.
function titleKey_(host, title) {
  var t = String(title || '').toLowerCase()
    .replace(/[^0-9a-zа-яёәғқңөұүһі\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 8).join(' ');
  return 't|' + host + '|' + t;
}

function sameHost_(a, b) {
  var pa = getParts_(a), pb = getParts_(b);
  if (!pa || !pb) return false;
  return pa.host.replace(/^www\./, '') === pb.host.replace(/^www\./, '');
}

function absUrl_(raw, base) {
  if (!raw) return '';
  var v = String(raw).trim().replace(/&amp;/g, '&').replace(/#.*$/, '');
  if (!v || /^(mailto:|tel:|javascript:)/i.test(v)) return '';
  if (/^https?:\/\//i.test(v)) return v;
  var p = getParts_(base);
  if (!p) return '';
  if (/^\/\//.test(v)) return p.protocol + ':' + v;
  if (v.charAt(0) === '/') return p.protocol + '://' + p.host + v;
  return p.protocol + '://' + p.host + '/' + v;
}

function strip_(html) { return String(html || '').replace(/<[^>]+>/g, ' '); }

function clean_(s) {
  return decodeEnt_(String(s || '')).replace(/\s+/g, ' ').trim();
}

function decodeEnt_(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&ndash;/g, '-').replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, function(_, c) { return String.fromCharCode(Number(c)); });
}

function tagVal_(block, tag) {
  var re = new RegExp('<[^:>]*:?' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/[^:>]*:?' + tag + '>', 'i');
  var m = String(block || '').match(re);
  return m ? decodeEnt_(m[1]) : '';
}

function attrVal_(block, tag, attr) {
  var re = new RegExp('<[^:>]*:?' + tag + '\\b[^>]*' + attr + '=["\']([^"\']+)["\']', 'i');
  var m = String(block || '').match(re);
  return m ? decodeEnt_(m[1]) : '';
}


// ============================================================
//  АВТОПРОВЕРКА ПО ТАЙМЕРУ (работает и ночью, когда ты спишь)
// ============================================================
function enableAutoCheck() {
  var ui = SpreadsheetApp.getUi();

  // Убираем старые триггеры, чтобы не задваивались
  removeAutoTriggers_();

  // Рабочий режим: каждые 30 минут — баланс оперативности и нагрузки.
  // Ночью (23:00-06:00) срабатывает не чаще раза в час — новостей нет,
  // а суточная квота выполнения экономится.
  ScriptApp.newTrigger('runSkoCheckSilent')
    .timeBased()
    .everyMinutes(30)
    .create();

  // Доставка Telegram живёт отдельно от тяжёлого обхода сайтов. Если
  // Telegram временно недоступен, очередь повторит попытку через 10 минут.
  ScriptApp.newTrigger('flushTelegramQueueSilent_')
    .timeBased()
    .everyMinutes(10)
    .create();

  ScriptApp.newTrigger('checkPythonHeartbeatSilent_')
    .timeBased()
    .everyHours(1)
    .create();

  // Еженедельный автобэкап всей таблицы (понедельник, утро)
  ScriptApp.newTrigger('makeWeeklyBackup_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();

  skoLog_('Автопроверка', 'ВКЛЮЧЕНА (каждые 30 мин днём, раз в час ночью)');
  notifyAdmin_('🟢 Мониторинг включён: проверка каждые 30 минут днём, раз в час ночью.');
  ui.alert(
    '⏰ Автопроверка ВКЛЮЧЕНА.\n\n' +
    'Бот проверяет источники каждые 30 минут днём (06:00-23:00)\nи раз в час ночью — круглосуточно,\n' +
    'даже когда таблица закрыта и компьютер выключен (работает на серверах Google).\n\n' +
    'Новые находки будут появляться на листах НАХОДКИ и НА ПРОВЕРКУ.\n' +
    'Открой таблицу с телефона или компа в любой момент — свежее сверху.'
  );
}

function disableAutoCheck() {
  var removed = removeAutoTriggers_();
  skoLog_('Автопроверка', 'ВЫКЛЮЧЕНА');
  if (removed > 0) notifyAdmin_('🔴 Автопроверка выключена.');
  SpreadsheetApp.getUi().alert(removed > 0
    ? '⏸ Автопроверка выключена.'
    : 'Автопроверка и не была включена.');
}

function removeAutoTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runSkoCheckSilent' || fn === 'flushTelegramQueueSilent_' ||
        fn === 'checkPythonHeartbeatSilent_' || fn === 'makeWeeklyBackup_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

// Еженедельная копия всей таблицы — страховка от случайной порчи.
// Держим 4 последних бэкапа, старые удаляются сами.
function makeWeeklyBackup_() {
  try {
    var ss = SpreadsheetApp.getActive();
    var file = DriveApp.getFileById(ss.getId());
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    file.makeCopy('Бэкап мониторинга ' + stamp);

    // Чистим старые бэкапы, оставляя 4 свежих
    var it = DriveApp.searchFiles('title contains "Бэкап мониторинга"');
    var backups = [];
    while (it.hasNext()) backups.push(it.next());
    backups.sort(function(a, b) { return b.getDateCreated() - a.getDateCreated(); });
    for (var i = 4; i < backups.length; i++) backups[i].setTrashed(true);

    skoLog_('Бэкап', 'Создан: Бэкап мониторинга ' + stamp);
  } catch (e) {
    skoLog_('Бэкап ошибка', e.message || String(e));
    notifyAdmin_('⚠️ Еженедельный бэкап не создался: ' + tgEsc_(e.message || String(e)));
  }
}


// ============================================================
//  МОБИЛЬНАЯ ВЕРСИЯ (Web App)
//  Публикация: Развернуть → Новое развёртывание → Веб-приложение →
//  Выполнять как "Я" → Доступ "Все у кого есть ссылку" → URL /exec.
//  Открой URL на телефоне → "Добавить на экран Домой".
// ============================================================
function doGet(e) {
  var api = e && e.parameter && e.parameter.api;

  // API-режим: страница общается через обычные GET-запросы —
  // работает в ЛЮБОМ браузере (Яндекс.Браузер блокировал google.script.run
  // из-за сторонних куки; прямым запросам куки не нужны).
  if (api === 'data') {
    var payload = mobileGetFindings(30);
    payload.auto = mobileGetAutoStatus().enabled;
    payload.lastRun = getLastRunStamp_();
    return ContentService.createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (api === 'run') {
    return ContentService.createTextOutput(JSON.stringify(mobileRunCheck()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (api === 'yt') {
    return ContentService.createTextOutput(JSON.stringify(mobileRunYoutube()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var execUrl = ScriptApp.getService().getUrl();
  return HtmlService
    .createHtmlOutput(buildSkoMobileHtml_(execUrl))
    .setTitle('Мониторинг СКО')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

// Счётчик провалов источников: 3 подряд → личный алерт владельцу (один раз).
// Хранится в Properties (объект маленький — лимит 9 КБ не грозит).
function loadFailCounts_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('src_fail_counts');
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveFailCounts_(m) {
  try {
    PropertiesService.getScriptProperties().setProperty('src_fail_counts', JSON.stringify(m));
  } catch (e) {}
}
// Источники, отключённые на сутки из-за постоянных отказов
function deadSources_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('dead_sources');
    var obj = raw ? JSON.parse(raw) : {};
    var now = Date.now();
    var alive = {};
    Object.keys(obj).forEach(function(k) {
      if (obj[k] > now) alive[k] = obj[k];   // ещё в отключке
    });
    return alive;
  } catch (e) { return {}; }
}
function markDead_(name) {
  try {
    var obj = deadSources_();
    obj[name] = Date.now() + 24 * 60 * 60 * 1000;   // пауза на сутки
    PropertiesService.getScriptProperties().setProperty('dead_sources', JSON.stringify(obj));
  } catch (e) {}
}

function trackSourceFail_(name) {
  var m = loadFailCounts_();
  m[name] = (m[name] || 0) + 1;
  // 5 провалов подряд — источник отключается на сутки, чтобы не тратить
  // время каждого прогона на заведомо мёртвый сайт
  if (m[name] >= 5) {
    markDead_(name);
    skoLog_('Источник отключён на сутки', name + ' (5 отказов подряд)');
  }
  if (m[name] === 3) {
    notifyAdmin_('🩺 <b>Источник заболел</b>\n«' + tgEsc_(name) +
      '» не отвечает уже 3 проверки подряд.\n' +
      'Проверь URL на листе ИСТОЧНИКИ или замени его G-лентой ' +
      '(news.google.com/rss/search?q=site:домен).');
  }
  saveFailCounts_(m);
}
function trackSourceOk_(name) {
  var m = loadFailCounts_();
  if (m[name]) { delete m[name]; saveFailCounts_(m); }
  // Источник ожил — снимаем отключку
  try {
    var d = deadSources_();
    if (d[name]) {
      delete d[name];
      PropertiesService.getScriptProperties().setProperty('dead_sources', JSON.stringify(d));
    }
  } catch (e) {}
}

// Ручной сброс отключённых источников (после правки URL на листе)
function reviveDeadSources() {
  PropertiesService.getScriptProperties().deleteProperty('dead_sources');
  PropertiesService.getScriptProperties().deleteProperty('src_fail_counts');
  SpreadsheetApp.getUi().alert('✅ Все источники снова активны — отключённые вернулись в проверку.');
}

// Время последней завершённой проверки — из журнала
function getLastRunStamp_() {
  try {
    var log = SpreadsheetApp.getActive().getSheetByName(CFG.LOG);
    if (!log || log.getLastRow() < 2) return '';
    var n = Math.min(60, log.getLastRow() - 1);
    var rows = log.getRange(log.getLastRow() - n + 1, 1, n, 2).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if ((rows[i][1] || '').toString() === 'Готово') {
        return Utilities.formatDate(new Date(rows[i][0]), Session.getScriptTimeZone(), 'dd.MM HH:mm');
      }
    }
  } catch (err) {}
  return '';
}

// Вызывается с мобильной страницы
function mobileRunCheck() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { message: 'Проверка уже идёт — подожди минуту.' };
  try {
    var r = runSkoCheckCore_();
    return { message: r.message };
  } catch (err) {
    skoLog_('Ошибка (моб)', err && err.stack ? err.stack : String(err));
    return { message: 'Ошибка: ' + (err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

// Свежие находки для мобильного списка
function mobileGetFindings(limit) {
  limit = limit || 25;
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG.FINDINGS);
  if (!sh || sh.getLastRow() < 2) return { rows: [] };
  var n = Math.min(limit, sh.getLastRow() - 1);
  var data = sh.getRange(2, 1, n, 6).getDisplayValues();
  return {
    rows: data.map(function(r) {
      return { time: r[0], pub: r[1], src: r[2], title: r[3], url: r[4], note: r[5] };
    }).filter(function(r) { return r.title; })
  };
}

function mobileRunYoutube() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { message: 'Другая проверка уже идёт.' };
  try {
    return { message: runYoutubeCheckCore_().message };
  } catch (err) {
    return { message: 'Ошибка: ' + (err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function mobileGetAutoStatus() {
  var on = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'runSkoCheckSilent';
  });
  return { enabled: on };
}

function buildSkoMobileHtml_(execUrl) {
  var html = `<!DOCTYPE html>
<html><head><base target="_blank">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'SF Pro Text', Roboto, Arial, sans-serif;
    background: linear-gradient(180deg, #0B1F3A 0%, #123156 100%);
    min-height: 100vh; color: #fff; padding: 18px 14px 60px;
  }
  .head { text-align:center; margin-bottom: 14px; }
  .head h1 { font-size: 21px; font-weight: 800; }
  .head .sub { font-size: 12px; opacity: 0.65; margin-top: 3px; }
  #auto {
    display: flex; align-items: center; justify-content: center; gap: 7px;
    font-size: 12.5px; background: rgba(255,255,255,0.07);
    border-radius: 20px; padding: 7px 14px; margin: 0 auto 16px; width: fit-content;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6B7A8D; }
  .dot.on { background: #2ECC71; box-shadow: 0 0 8px #2ECC71; }
  .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-bottom: 14px; }
  button {
    padding: 15px 10px; font-size: 14.5px; font-weight: 700; border: none;
    border-radius: 14px; color: #fff; cursor: pointer;
  }
  button:active { opacity: 0.75; }
  button:disabled { opacity: 0.45; }
  .b-sites { background: linear-gradient(135deg, #1B8A3E, #27AE60); grid-column: 1 / -1; padding: 17px; font-size: 16px; }
  .b-yt    { background: linear-gradient(135deg, #B23B3B, #E74C3C); }
  .b-rel   { background: rgba(255,255,255,0.12); }
  #status {
    margin-bottom: 14px; padding: 13px 14px; background: rgba(255,255,255,0.07);
    border-radius: 13px; white-space: pre-wrap; font-size: 13px; line-height: 1.5;
    border-left: 3px solid #2E86DE;
  }
  .spin {
    display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff; border-radius: 50%; animation: sp 0.8s linear infinite;
    vertical-align: -2px; margin-right: 7px;
  }
  @keyframes sp { to { transform: rotate(360deg); } }
  .sect { font-size: 13px; opacity: 0.6; margin: 4px 2px 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; }
  .card {
    background: rgba(255,255,255,0.08); border-radius: 14px;
    padding: 13px 14px; margin-bottom: 9px; border: 1px solid rgba(255,255,255,0.06);
  }
  .card-title { font-size: 14.5px; line-height: 1.4; margin-bottom: 8px; font-weight: 600; }
  .card-title a { color: #9CC3FF; text-decoration: none; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .badge { font-size: 10.5px; padding: 3px 9px; border-radius: 10px; background: rgba(46,134,222,0.25); color: #AFD4FF; }
  .badge.src { background: rgba(255,255,255,0.12); color: #D8E1EC; }
  .badge.time { background: transparent; color: #8B9AAC; padding-left: 0; }
  .copy { margin-top: 9px; width: 100%; padding: 9px; font-size: 13px; font-weight: 600;
          border-radius: 10px; background: rgba(46,134,222,0.35); color: #CFE4FF; }
  .copy.done { background: rgba(46,204,113,0.35); color: #C8F5DC; }
  .empty { text-align: center; opacity: 0.55; padding: 26px 10px; font-size: 14px; }
</style></head><body>

<div class="head">
  <h1>📡 Мониторинг СКО</h1>
  <div class="sub">республиканские СМИ и телеканалы</div>
</div>

<div id="auto"><span class="dot" id="dot"></span><span id="autotext">Подключаюсь…</span></div>

<div class="btns">
  <button class="b-sites" id="bRun">▶ Проверить все источники</button>
  <button class="b-yt" id="bYt">📺 YouTube-каналы</button>
  <button class="b-rel" id="bRel">🔄 Обновить</button>
</div>

<div id="status"><span class="spin"></span>Загружаю свежие находки…</div>
<div class="sect">Свежие находки</div>
<div id="list"></div>

<script>
var API = API_URL_PLACEHOLDER;

function setBusy(b) {
  ['bRun','bYt','bRel'].forEach(function(id){ document.getElementById(id).disabled = b; });
}
function setStatus(html) { document.getElementById('status').innerHTML = html; }

function apiGet(action, timeoutMs) {
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 30000);
  return fetch(API + '?api=' + action, { signal: ctrl.signal, redirect: 'follow' })
    .then(function(r){ clearTimeout(t); return r.json(); });
}

function loadData() {
  setStatus('<span class="spin"></span>Загружаю свежие находки…');
  apiGet('data', 25000).then(function(d){
    var dot = document.getElementById('dot');
    var at = document.getElementById('autotext');
    dot.className = d.auto ? 'dot on' : 'dot';
    at.innerText = (d.auto ? 'Автопроверка ВКЛ (каждые 30 мин)' : 'Автопроверка ВЫКЛ') +
      (d.lastRun ? ' • посл. проверка: ' + d.lastRun : '');

    var list = document.getElementById('list');
    list.innerHTML = '';
    if (!d.rows || !d.rows.length) {
      list.innerHTML = '<div class="empty">Пока находок нет.</div>';
      setStatus('Готово. Находок в таблице пока нет.');
      return;
    }
    setStatus('Найдено упоминаний: ' + d.rows.length + ' (новые сверху)');
    d.rows.forEach(function(f){
      var card = document.createElement('div');
      card.className = 'card';
      var t = document.createElement('div');
      t.className = 'card-title';
      var a = document.createElement('a');
      a.href = f.url; a.innerText = f.title;
      t.appendChild(a); card.appendChild(t);
      var b = document.createElement('div');
      b.className = 'badges';
      var s1 = document.createElement('span'); s1.className='badge src'; s1.innerText = f.src; b.appendChild(s1);
      if (f.note) { var s2 = document.createElement('span'); s2.className='badge'; s2.innerText = f.note; b.appendChild(s2); }
      var s3 = document.createElement('span'); s3.className='badge time';
      s3.innerText = f.pub ? ('📅 ' + f.pub) : ('найдено ' + f.time);
      b.appendChild(s3);
      card.appendChild(b);
      var cb = document.createElement('button');
      cb.className = 'copy'; cb.innerText = '📋 Скопировать ссылку';
      cb.onclick = function(ev){
        ev.preventDefault();
        navigator.clipboard.writeText(f.url).then(function(){
          cb.innerText = '✓ Скопировано!'; cb.className = 'copy done';
          setTimeout(function(){ cb.innerText = '📋 Скопировать ссылку'; cb.className = 'copy'; }, 1600);
        });
      };
      card.appendChild(cb);
      list.appendChild(card);
    });
  }).catch(function(e){
    setStatus('⚠️ Не удалось загрузить: ' + e.message +
      '\n\nПроверь интернет и открой страницу заново.\n' +
      'Если не помогает — на компьютере обнови развёртывание (Новая версия).');
  });
}

function runAction(action, label) {
  setStatus('<span class="spin"></span>' + label + ' Обычно 1-3 минуты, не закрывай страницу.');
  setBusy(true);
  apiGet(action, 300000).then(function(r){
    setStatus((r && r.message) ? r.message : 'Готово.');
    setBusy(false);
    loadData();
  }).catch(function(e){
    // Даже если браузер оборвал ожидание — скрипт на сервере ПРОДОЛЖАЕТ работать
    setStatus('⏳ Проверка запущена на сервере и продолжается.\nОбнови список через 2-3 минуты кнопкой «Обновить».');
    setBusy(false);
  });
}

document.getElementById('bRun').onclick = function(){ runAction('run', '▶ Проверяю все источники…'); };
document.getElementById('bYt').onclick = function(){ runAction('yt', '📺 Проверяю YouTube-каналы…'); };
document.getElementById('bRel').onclick = loadData;

loadData();
</script>
</body></html>`;
  return html.replace('API_URL_PLACEHOLDER', JSON.stringify(execUrl || ''));
}


// ============================================================
//  МОДУЛЬ YOUTUBE: телеканалы (№36-42)
//
//  Использует официальный YouTube Data API v3 (бесплатная квота
//  10 000 единиц/сутки). Один прогон 7 каналов ≈ 700-750 единиц,
//  так что 3-4 проверки в день — с большим запасом.
//  Ключ создаётся в Google Cloud Console → APIs → YouTube Data API v3.
// ============================================================
function setYoutubeKey() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'YouTube API ключ',
    'Вставь свой ключ YouTube Data API v3.\nОн сохранится в защищённом хранилище скрипта (не в ячейках).',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var key = resp.getResponseText().toString().trim();
  if (!key) { ui.alert('Ключ пустой — не сохранён.'); return; }
  PropertiesService.getScriptProperties().setProperty('YOUTUBE_API_KEY', key);
  ui.alert('✅ Ключ сохранён. Теперь можно запускать «📺 Проверить YouTube-каналы».');
}


function runYoutubeCheck() {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) { ui.alert('Другая проверка уже идёт.'); return; }
  try {
    var r = runYoutubeCheckCore_();
    ui.alert(r.message);
  } catch (err) {
    skoLog_('YouTube ошибка', err && err.stack ? err.stack : String(err));
    ui.alert('Ошибка: ' + (err.message || err) + '\n\nСмотри лист ЖУРНАЛ.');
  } finally {
    lock.releaseLock();
  }
}


function runYoutubeCheckCore_() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
  if (!apiKey) return { message: 'Сначала вставь YouTube API ключ (меню «📺 Вставить YouTube API ключ»).' };

  var dict = loadDictionary_();
  var stopWords = loadStopWords_();
  if (!dict.length) return { message: 'Словарь пуст. Запусти «1. Настроить таблицу».' };

  var seen = loadSeen_();
  var hits = [], maybes = [];
  var checkedNew = 0;
  var perChannel = [];

  for (var i = 0; i < YT_CHANNELS.length; i++) {
    var ch = YT_CHANNELS[i];
    try {
      var channelId = resolveChannelId_(ch.handle, apiKey);
      if (!channelId) {
        skoLog_('YouTube канал не найден', ch.handle);
        perChannel.push(ch.name + ':✗');
        continue;
      }

      // Последние видео канала (search.list по channelId, order=date)
      var url = 'https://www.googleapis.com/youtube/v3/search' +
        '?part=snippet&channelId=' + encodeURIComponent(channelId) +
        '&order=date&maxResults=25&type=video&key=' + encodeURIComponent(apiKey);
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) {
        skoLog_('YouTube API HTTP', ch.name + ' → ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
        perChannel.push(ch.name + ':✗');
        continue;
      }

      var data = JSON.parse(resp.getContentText());
      var newCount = 0;
      var ytFreshLimit = new Date(Date.now() - 48 * 60 * 60 * 1000);   // видео не старше 2 суток
      (data.items || []).forEach(function(item) {
        var vid = item.id && item.id.videoId;
        if (!vid) return;
        var vurl = 'https://www.youtube.com/watch?v=' + vid;
        var key = urlKey_(vurl);
        if (seen[key]) return;

        // ФИЛЬТР СВЕЖЕСТИ: раньше его тут НЕ БЫЛО — канал получал видео
        // любой давности. Теперь берём только последние 48 часов.
        var pubAt = null;
        if (item.snippet && item.snippet.publishedAt) {
          pubAt = new Date(item.snippet.publishedAt);
          if (isNaN(pubAt.getTime())) pubAt = null;
        }
        if (pubAt && pubAt < ytFreshLimit) { seen[key] = true; return; }

        newCount++; checkedNew++;

        var title = (item.snippet && item.snippet.title) || '';
        var desc  = (item.snippet && item.snippet.description) || '';
        var v = checkTextForSko_(decodeEnt_(title) + ' ' + decodeEnt_(desc), dict, stopWords);
        if (v.status === 'hit') {
          hits.push({ src: ch.name, title: decodeEnt_(title), url: vurl,
                      note: (v.matched || []).join(', '), pub: pubAt });
        } else if (v.status === 'maybe') {
          maybes.push({ src: ch.name, title: decodeEnt_(title), url: vurl,
                        note: v.reason || '', pub: pubAt });
        }
        seen[key] = true;
      });
      perChannel.push(ch.name + ':' + newCount);

    } catch (e) {
      skoLog_('YouTube канал ошибка', ch.name + ': ' + (e.message || e));
      perChannel.push(ch.name + ':✗');
    }
  }

  writeRows_(CFG.FINDINGS, hits);
  writeRows_(CFG.MAYBE, maybes);
  saveSeen_(seen);

  sendFindingsToTelegram_(hits, 'СКО на ТВ (YouTube)');

  skoLog_('YouTube готово', 'Находок: ' + hits.length + ', на проверку: ' + maybes.length);

  return {
    message: '📺 Проверка YouTube завершена\n\n' +
      'Новых видео проверено: ' + checkedNew + '\n' +
      '🎯 Упоминаний СКО: ' + hits.length + '\n' +
      '❓ На проверку: ' + maybes.length + '\n\n' +
      'По каналам (новых): ' + perChannel.join(' | '),
    hits: hits.length
  };
}


// Резолвим @handle → channelId. Результат кэшируем в Script Properties,
// чтобы не тратить квоту API при каждом запуске (100 единиц за поиск).
function resolveChannelId_(handle, apiKey) {
  var props = PropertiesService.getScriptProperties();
  var cacheKey = 'yt_id_' + handle;
  var cached = props.getProperty(cacheKey);
  if (cached) return cached;

  // Основной путь: channels.list с forHandle (дёшево — 1 единица)
  var url = 'https://www.googleapis.com/youtube/v3/channels' +
    '?part=id&forHandle=' + encodeURIComponent(handle.replace(/^@/, '')) +
    '&key=' + encodeURIComponent(apiKey);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() === 200) {
    var data = JSON.parse(resp.getContentText());
    if (data.items && data.items.length) {
      var id = data.items[0].id;
      props.setProperty(cacheKey, id);
      return id;
    }
  }

  // Запасной путь: search.list (дороже — 100 единиц)
  var url2 = 'https://www.googleapis.com/youtube/v3/search' +
    '?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(handle) +
    '&key=' + encodeURIComponent(apiKey);
  var resp2 = UrlFetchApp.fetch(url2, { muteHttpExceptions: true });
  if (resp2.getResponseCode() === 200) {
    var data2 = JSON.parse(resp2.getContentText());
    if (data2.items && data2.items.length) {
      var id2 = data2.items[0].snippet && data2.items[0].snippet.channelId;
      if (id2) { props.setProperty(cacheKey, id2); return id2; }
    }
  }

  return null;
}


// ============================================================
//  ПОЗИТИВ ИЗ РЕГИОНАЛЬНЫХ СМИ
//  Логика по определению пользователя: позитив = всё, где НЕТ
//  негативных маркеров (лист НЕГАТИВ-СЛОВА, дополняется).
// ============================================================
function runPositiveCheck() {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) { ui.alert('Другая проверка уже идёт.'); return; }
  try {
    var r = runPositiveCheckCore_();
    ui.alert(r.message);
  } catch (err) {
    skoLog_('Позитив ошибка', err && err.stack ? err.stack : String(err));
    ui.alert('Ошибка: ' + (err.message || err));
  } finally {
    lock.releaseLock();
  }
}

function runPositiveCheckCore_() {
  var ss = SpreadsheetApp.getActive();
  var srcSheet = ss.getSheetByName(CFG_REGIONAL_SHEET);
  if (!srcSheet || srcSheet.getLastRow() < 2) {
    return { message: 'Лист РЕГИОНАЛЬНЫЕ пуст. Запусти «1. Настроить таблицу».' };
  }
  var sources = srcSheet.getRange(2, 1, srcSheet.getLastRow() - 1, 2).getValues()
    .map(function(r) { return { url: (r[0]||'').toString().trim(), name: (r[1]||'').toString().trim() }; })
    .filter(function(s) { return /^https?:\/\//i.test(s.url); });

  var negSheet = ss.getSheetByName(CFG_NEG_SHEET);
  var negWords = (negSheet && negSheet.getLastRow() >= 2)
    ? negSheet.getRange(2, 1, negSheet.getLastRow() - 1, 1).getValues()
        .map(function(r) { return (r[0]||'').toString().trim().toLowerCase(); })
        .filter(function(w) { return w.length >= 3; })
    : [];

  var seen = loadSeenSheet_('_ПАМЯТЬ_ПОЗИТИВ');

  var positives = [];
  var checkedNew = 0, filtered = 0;
  var report = [];

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var res = fetchWithFallback_(src.url);
    if (!res.ok) { report.push(src.name + ':✗'); skoLog_('Позитив: сайт не отдал', src.name); continue; }

    var items = extractItems_(res.body, res.url);
    var cnt = 0;
    items.forEach(function(it) {
      var key = it.url.replace(/\/$/, '').toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      checkedNew++;

      var low = (it.title + ' ' + (it.extra || '')).toLowerCase();
      var isNegative = negWords.some(function(w) { return low.indexOf(w) !== -1; });
      if (isNegative) { filtered++; return; }

      positives.push({ src: src.name || hostOf_(src.url), title: it.title, url: it.url });
      cnt++;
    });
    report.push(src.name + ':+' + cnt);
  }

  // Пишем в лист ПОЗИТИВ (4 колонки)
  if (positives.length) {
    var sh = ss.getSheetByName(CFG_POSITIVE_SHEET);
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM HH:mm');
    var rows = positives.map(function(p) { return [stamp, p.src, p.title, p.url]; });
    sh.insertRowsAfter(1, rows.length);
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
    sh.getRange(2, 4, rows.length, 1).setFontColor('#1155CC');

    var lastP = sh.getLastRow();
    if (lastP > CFG.FINDINGS_MAX + 60) {
      sh.deleteRows(CFG.FINDINGS_MAX + 1, lastP - CFG.FINDINGS_MAX);
    }
  }

  saveSeenSheet_('_ПАМЯТЬ_ПОЗИТИВ', seen);

  skoLog_('Позитив готово', 'Новых: ' + checkedNew + ', позитивных: ' + positives.length + ', отсеяно: ' + filtered);

  return {
    message: '🌿 Сбор позитива завершён\n\n' +
      'Проверено новых материалов: ' + checkedNew + '\n' +
      '✅ Позитивных: ' + positives.length + '\n' +
      '🚫 Отсеяно как негатив/нейтрал: ' + filtered + '\n\n' +
      'По сайтам: ' + report.join(' | ') + '\n\n' +
      'Смотри лист ПОЗИТИВ (новые сверху).',
    found: positives.length
  };
}


// ============================================================
//  ГЛУБОКИЙ ПОИСК ПО АРХИВУ САЙТА — ТРИ МЕТОДА
//
//  1. SITEMAP.XML — карта сайта для поисковиков: полный список
//     статей с датами. Самый быстрый и полный способ, если есть.
//  2. ПАГИНАЦИЯ /page/N/ — листаем страницы вглубь с возможностью
//     продолжить с места остановки.
//  3. WAYBACK MACHINE (archive.org CDX API) — интернет-архив хранит
//     историю почти всех сайтов. Отдаёт список сохранённых URL за
//     любой период. Работает даже если сайт закрыл архив или умер.
//
//  Ключевое слово ищется в URL статьи (адреса транслитерированы:
//  "паводки" → pavodki) и в заголовке страницы.
// ============================================================

// Транслитерация для поиска в URL: "паводки" -> "pavodki"
function translitRu_(s) {
  var map = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh',
    'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p',
    'р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh',
    'щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'};
  return (s || '').toLowerCase().split('').map(function(ch) {
    return map[ch] !== undefined ? map[ch] : ch;
  }).join('');
}

function startDeepSearch() {
  var ui = SpreadsheetApp.getUi();

  // Сайты берём СРАЗУ ВСЕ с листа РЕГИОНАЛЬНЫЕ — по очереди пройдём каждый
  var ss = SpreadsheetApp.getActive();
  var regSheet = ss.getSheetByName(CFG_REGIONAL_SHEET);
  if (!regSheet || regSheet.getLastRow() < 2) {
    ui.alert('Лист РЕГИОНАЛЬНЫЕ пуст. Добавь сайты и запусти снова.');
    return;
  }
  var sites = regSheet.getRange(2, 1, regSheet.getLastRow() - 1, 2).getValues()
    .map(function(r) { return { url: (r[0]||'').toString().trim(), name: (r[1]||'').toString().trim() }; })
    .filter(function(s) { return /^https?:\/\//i.test(s.url); });
  if (!sites.length) { ui.alert('На листе РЕГИОНАЛЬНЫЕ нет корректных URL.'); return; }

  var r2 = ui.prompt('Глубокий поиск 1/2',
    'Ключевое слово или фраза (например: паводки):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var keyword = r2.getResponseText().trim();
  if (!keyword) { ui.alert('Слово пустое.'); return; }

  var r3 = ui.prompt('Глубокий поиск 2/2',
    'Год или период (примеры: 2024, 2024-2025). Пусто = без ограничения:', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var period = r3.getResponseText().trim();

  var yearFrom = null, yearTo = null;
  if (period) {
    var pm = period.match(/^(\d{4})(?:\s*[-–]\s*(\d{4}))?$/);
    if (!pm) { ui.alert('Период не понят. Формат: 2024 или 2024-2025.'); return; }
    yearFrom = parseInt(pm[1], 10);
    yearTo = pm[2] ? parseInt(pm[2], 10) : yearFrom;
  }

  var state = {
    sites: sites,               // весь список регионалок
    siteIndex: 0,               // какой сайт сейчас в работе
    keyword: keyword, yearFrom: yearFrom, yearTo: yearTo,
    phase: 'sitemap',
    page: 1,
    sitemapQueue: [],
    sitemapStarted: false,
    totalFound: 0
  };
  // site — текущий, для совместимости с фазами
  state.site = sites[0].url;

  PropertiesService.getScriptProperties().setProperty(CFG_DEEP_STATE_KEY, JSON.stringify(state));

  ui.alert('🕳 Поиск настроен:\n\nСайтов в очереди: ' + sites.length +
    ' (' + sites.map(function(s){return s.name || hostOf_(s.url);}).join(', ') + ')' +
    '\nСлово: ' + keyword +
    '\nПериод: ' + (period || 'весь архив') +
    '\n\nПройду каждый сайт тремя методами: sitemap → пагинация → веб-архив.' +
    '\nЕсли прогон не успеет всё — жми «Продолжить».');

  deepSearchRun_();
}

function continueDeepSearch() {
  var raw = PropertiesService.getScriptProperties().getProperty(CFG_DEEP_STATE_KEY);
  if (!raw) { SpreadsheetApp.getUi().alert('Нет активного поиска. Сначала «Начать».'); return; }
  deepSearchRun_();
}

function resetDeepSearch() {
  PropertiesService.getScriptProperties().deleteProperty(CFG_DEEP_STATE_KEY);
  SpreadsheetApp.getUi().alert('Глубокий поиск сброшен.');
}


function deepSearchRun_() {
  var started = Date.now();
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) { ui.alert('Другая задача уже идёт.'); return; }

  try {
    var state = JSON.parse(PropertiesService.getScriptProperties().getProperty(CFG_DEEP_STATE_KEY));
    var found = [];
    var progress = '';

    // Фазы идут по цепочке для ТЕКУЩЕГО сайта; когда сайт исчерпан —
    // переходим к следующему из списка, начиная снова с sitemap.
    var siteName = (state.sites && state.sites[state.siteIndex])
      ? (state.sites[state.siteIndex].name || hostOf_(state.site)) : hostOf_(state.site);

    if (state.phase === 'sitemap') {
      var res = deepPhaseSitemap_(state, found, started);
      progress = '[' + siteName + '] ' + res.progress;
      if (res.exhausted) state.phase = 'pagination';
    }
    else if (state.phase === 'pagination') {
      var res2 = deepPhasePagination_(state, found, started);
      progress = '[' + siteName + '] ' + res2.progress;
      if (res2.exhausted) state.phase = 'wayback';
    }
    else if (state.phase === 'wayback') {
      var res3 = deepPhaseWayback_(state, found, started);
      progress = '[' + siteName + '] ' + res3.progress;
      if (res3.exhausted) {
        // Текущий сайт полностью пройден — следующий из очереди
        state.siteIndex++;
        if (state.sites && state.siteIndex < state.sites.length) {
          state.site = state.sites[state.siteIndex].url;
          state.phase = 'sitemap';
          state.page = 1;
          state.sitemapQueue = [];
          state.sitemapStarted = false;
          progress += '\n→ Следующий сайт: ' + (state.sites[state.siteIndex].name || state.site);
        } else {
          state.phase = 'done';
        }
      }
    }

    // Пишем найденное
    if (found.length) {
      var sh = SpreadsheetApp.getActive().getSheetByName(CFG_DEEP_SHEET);
      var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM HH:mm');
      var rows = found.map(function(f) { return [stamp, f.date || '', f.title, f.url, f.how]; });
      sh.insertRowsAfter(1, rows.length);
      sh.getRange(2, 1, rows.length, 5).setValues(rows);
      sh.getRange(2, 4, rows.length, 1).setFontColor('#1155CC');

      var lastD = sh.getLastRow();
      if (lastD > 3000 + 60) {           // архиву даём больше — это рабочие результаты
        sh.deleteRows(3001, lastD - 3000);
      }
    }

    state.totalFound += found.length;
    var isDone = state.phase === 'done';

    if (isDone) {
      PropertiesService.getScriptProperties().deleteProperty(CFG_DEEP_STATE_KEY);
    } else {
      PropertiesService.getScriptProperties().setProperty(CFG_DEEP_STATE_KEY, JSON.stringify(state));
    }

    skoLog_('Глубокий поиск', progress + ' | найдено за прогон: ' + found.length);

    ui.alert(
      (isDone ? '🏁 Глубокий поиск ЗАВЕРШЁН' : '⏸ Прогон завершён — можно продолжать') + '\n\n' +
      progress + '\n' +
      'Найдено за этот прогон: ' + found.length + '\n' +
      'Всего с начала поиска: ' + state.totalFound + '\n\n' +
      (isDone ? 'Результаты на листе АРХИВ-ПОИСК.'
              : 'Жми «🕳 Глубокий поиск: продолжить» для следующего прогона.\nРезультаты копятся на листе АРХИВ-ПОИСК.')
    );

  } catch (err) {
    skoLog_('Глубокий поиск ошибка', err && err.stack ? err.stack : String(err));
    ui.alert('Ошибка: ' + (err.message || err));
  } finally {
    lock.releaseLock();
  }
}


// ---------- ФАЗА 1: SITEMAP ----------
function deepPhaseSitemap_(state, found, started) {
  var kw = state.keyword.toLowerCase();
  var kwTr = translitRu_(state.keyword).replace(/\s+/g, '-');
  var kwTr2 = translitRu_(state.keyword).replace(/\s+/g, '_');
  var p = getParts_(state.site);
  var root = p.protocol + '://' + p.host;

  // Первый заход: ищем саму карту
  if (!state.sitemapQueue.length && !state.sitemapStarted) {
    state.sitemapStarted = true;
    var candidates = [root + '/sitemap.xml', root + '/sitemap_index.xml',
                      root + '/sitemap-index.xml', root + '/wp-sitemap.xml'];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var r = UrlFetchApp.fetch(candidates[i], { muteHttpExceptions: true, followRedirects: true });
        if (r.getResponseCode() === 200 && /<(urlset|sitemapindex)/i.test(r.getContentText().slice(0, 500))) {
          state.sitemapQueue.push(candidates[i]);
          break;
        }
      } catch (e) {}
    }
    if (!state.sitemapQueue.length) {
      return { progress: 'Sitemap не найден — переключаюсь на пагинацию', exhausted: true };
    }
  }

  var processed = 0;
  while (state.sitemapQueue.length && Date.now() - started < CFG.MAX_RUNTIME - CFG.SAFETY_STOP) {
    var smUrl = state.sitemapQueue.shift();
    var xml;
    try {
      var resp = UrlFetchApp.fetch(smUrl, { muteHttpExceptions: true, followRedirects: true });
      if (resp.getResponseCode() !== 200) continue;
      xml = resp.getContentText();
    } catch (e) { continue; }
    processed++;

    // Вложенные карты (sitemapindex)
    var subMaps = xml.match(/<sitemap>[\s\S]*?<\/sitemap>/gi) || [];
    subMaps.forEach(function(block) {
      var loc = tagVal_(block, 'loc');
      if (!loc) return;
      // Если в имени под-карты есть год — фильтруем сразу
      if (state.yearFrom) {
        var ym = loc.match(/(20\d{2})/);
        if (ym) {
          var y = parseInt(ym[1], 10);
          if (y < state.yearFrom || y > state.yearTo) return;
        }
      }
      state.sitemapQueue.push(loc);
    });

    // Статьи (urlset)
    var urls = xml.match(/<url>[\s\S]*?<\/url>/gi) || [];
    urls.forEach(function(block) {
      var loc = tagVal_(block, 'loc');
      if (!loc) return;
      var lastmod = tagVal_(block, 'lastmod') || '';
      var year = null;
      var ym = (lastmod || loc).match(/(20\d{2})/);
      if (ym) year = parseInt(ym[1], 10);
      if (state.yearFrom && year && (year < state.yearFrom || year > state.yearTo)) return;

      var locLow = loc.toLowerCase();
      if (locLow.indexOf(kwTr) !== -1 || locLow.indexOf(kwTr2) !== -1 ||
          locLow.indexOf(encodeURIComponent(kw)) !== -1) {
        found.push({
          date: lastmod ? lastmod.slice(0, 10) : (year || ''),
          title: decodeURIComponent(loc.split('/').filter(Boolean).pop() || loc),
          url: loc,
          how: 'sitemap'
        });
      }
    });
  }

  var exhausted = state.sitemapQueue.length === 0;
  return {
    progress: 'Фаза SITEMAP: обработано карт за прогон: ' + processed +
      (exhausted ? ' — карта пройдена ПОЛНОСТЬЮ' : ', осталось в очереди: ' + state.sitemapQueue.length),
    exhausted: exhausted
  };
}


// ---------- ФАЗА 2: ПАГИНАЦИЯ ----------
function deepPhasePagination_(state, found, started) {
  var kw = state.keyword.toLowerCase();
  var PAGES = 10;
  var startPage = state.page;
  var done = 0;
  var emptyStreak = 0;

  for (var pnum = startPage; pnum < startPage + PAGES; pnum++) {
    if (Date.now() - started > CFG.MAX_RUNTIME - CFG.SAFETY_STOP) break;
    var pageUrl = state.site.replace(/\/$/, '') + (pnum === 1 ? '/' : '/page/' + pnum + '/');
    var resp;
    try {
      resp = UrlFetchApp.fetch(pageUrl, { muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' } });
    } catch (e) { emptyStreak++; done++; continue; }
    if (resp.getResponseCode() >= 400) { emptyStreak++; done++; state.page = pnum + 1; if (emptyStreak >= 2) return { progress: 'Фаза ПАГИНАЦИЯ: архив закончился на стр. ' + pnum, exhausted: true }; continue; }

    var items = extractFromHtml_(resp.getContentText(), state.site);
    if (!items.length) { emptyStreak++; } else { emptyStreak = 0; }

    items.forEach(function(it) {
      if (it.title.toLowerCase().indexOf(kw) !== -1) {
        found.push({ date: '', title: it.title, url: it.url, how: 'страница ' + pnum });
      }
    });
    done++;
    state.page = pnum + 1;
    Utilities.sleep(300);
  }

  // Считаем пагинацию исчерпанной после 60 страниц (или раньше по 404) —
  // чтобы поиск сам переходил к веб-архиву и следующему сайту
  var exhausted = state.page > 60;
  return {
    progress: 'Фаза ПАГИНАЦИЯ: страницы ' + startPage + '-' + (state.page - 1) + ' пройдены' +
      (exhausted ? ' (лимит 60 стр. — дальше веб-архив)' : ''),
    exhausted: exhausted
  };
}


// ---------- ФАЗА 3: WAYBACK MACHINE ----------
function deepPhaseWayback_(state, found, started) {
  var kwTr = translitRu_(state.keyword).replace(/\s+/g, '-');
  var kwTr2 = translitRu_(state.keyword).replace(/\s+/g, '_');
  var host = getParts_(state.site).host.replace(/^www\./, '');

  var url = 'https://web.archive.org/cdx/search/cdx?url=' + encodeURIComponent(host + '/*') +
    '&output=json&fl=timestamp,original&collapse=urlkey&limit=3000' +
    (state.yearFrom ? '&from=' + state.yearFrom + '0101&to=' + state.yearTo + '1231' : '');

  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      return { progress: 'Wayback недоступен (HTTP ' + resp.getResponseCode() + ')', exhausted: true };
    }
    var data = JSON.parse(resp.getContentText());
    var count = 0;
    for (var i = 1; i < data.length; i++) {   // [0] — заголовки
      var ts = data[i][0], orig = data[i][1];
      var low = (orig || '').toLowerCase();
      if (low.indexOf(kwTr) !== -1 || low.indexOf(kwTr2) !== -1) {
        found.push({
          date: ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8),
          title: decodeURIComponent(orig.split('/').filter(Boolean).pop() || orig),
          url: orig,
          how: 'веб-архив'
        });
        count++;
      }
    }
    return { progress: 'Фаза WAYBACK: проверено ' + (data.length - 1) + ' архивных URL, совпадений: ' + count, exhausted: true };
  } catch (e) {
    return { progress: 'Wayback ошибка: ' + (e.message || e), exhausted: true };
  }
}


// ============================================================
//  МОНИТОРИНГ МЕСТНЫХ ПАБЛИКОВ — «ЗЕРКАЛЬНЫЙ» МЕТОД
//
//  Instagram закрыт для ботов (API только для бизнеса, парсинг
//  банится за минуты). Обход: крупные паблики дублируют контент
//  в Telegram, а у ТГ-каналов есть ОТКРЫТАЯ веб-версия t.me/s/имя —
//  читается простым запросом, без API, без регистрации, стабильно.
//  Посты проверяются словарём СКО? Нет — паблики и так местные,
//  поэтому просто собираем свежие посты со ссылками.
// ============================================================
function runPublicsCheck() {
  var ui = SpreadsheetApp.getUi();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) { ui.alert('Другая проверка уже идёт.'); return; }
  try {
    var r = runPublicsCheckCore_();
    ui.alert(r.message);
  } catch (err) {
    skoLog_('Паблики ошибка', err && err.stack ? err.stack : String(err));
    ui.alert('Ошибка: ' + (err.message || err));
  } finally {
    lock.releaseLock();
  }
}

function runPublicsCheckCore_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG_PUBLICS_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    return { message: 'Лист ПАБЛИКИ пуст. Впиши Telegram-зеркала пабликов.' };
  }
  var channels = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues()
    .map(function(r) {
      var raw = (r[0] || '').toString().trim();
      // Принимаем: имя, @имя, t.me/имя, https://t.me/имя, t.me/s/имя
      var name = raw.replace(/^https?:\/\//i, '').replace(/^t\.me\/(s\/)?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
      return { channel: name, title: (r[1] || '').toString().trim() || name };
    })
    .filter(function(x) { return x.channel && /^[A-Za-z0-9_]{4,}$/.test(x.channel); });

  if (!channels.length) return { message: 'Не распознано ни одного имени канала. Формат: имя_канала или t.me/имя_канала.' };

  var seen = loadSeenSheet_('_ПАМЯТЬ_ПАБЛИКИ');

  var found = [];
  var report = [];

  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var url = 'https://t.me/s/' + ch.channel;
    var resp;
    try {
      resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0' } });
    } catch (e) {
      skoLog_('Паблик недоступен', ch.channel + ': ' + e.message);
      report.push(ch.title + ':✗');
      continue;
    }
    if (resp.getResponseCode() >= 400) {
      skoLog_('Паблик HTTP', ch.channel + ' → ' + resp.getResponseCode() + ' (канал приватный или имя неверное)');
      report.push(ch.title + ':✗');
      continue;
    }

    var html = resp.getContentText();
    // Посты в веб-версии: блоки tgme_widget_message с data-post="канал/номер"
    var re = /data-post="([^"]+)"[\s\S]*?tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/gi;
    var m, cnt = 0;
    while ((m = re.exec(html)) !== null) {
      var postId = m[1];                                   // имя/1234
      var postUrl = 'https://t.me/' + postId;
      var key = postUrl.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;

      var text = clean_(strip_(m[2]));
      if (!text || text.length < 15) continue;
      var title = text.length > 140 ? text.slice(0, 140) + '…' : text;

      found.push({ src: ch.title, title: title, url: postUrl, note: 'Telegram-зеркало' });
      cnt++;
    }
    report.push(ch.title + ':+' + cnt);
    Utilities.sleep(250);
  }

  // Пишем в общий лист НАХОДКИ (5 колонок — тот же формат)
  writeRows_(CFG.FINDINGS, found);

  saveSeenSheet_('_ПАМЯТЬ_ПАБЛИКИ', seen);

  skoLog_('Паблики готово', 'Новых постов: ' + found.length);

  return {
    message: '📲 Проверка пабликов завершена\n\n' +
      'Новых постов: ' + found.length + '\n' +
      'По каналам: ' + report.join(' | ') + '\n\n' +
      '✗ = канал не открылся: либо имя неверное, либо канал приватный.\n' +
      'Найденные посты — на листе НАХОДКИ.',
    found: found.length
  };
}


// ============================================================
//  TELEGRAM-УВЕДОМЛЕНИЯ
//
//  Каждая находка мониторинга улетает сообщением в Telegram-канал
//  (или группу) в момент обнаружения. Подписанные коллеги получают
//  пуш мгновенно — с любого телефона, iPhone или Android.
//
//  Настройка (5 минут, бесплатно):
//  1. В Telegram напиши боту @BotFather → /newbot → придумай имя.
//     BotFather выдаст ТОКЕН вида 1234567:AAaa... — скопируй его.
//  2. Создай канал (например "Мониторинг СКО") и добавь своего бота
//     в администраторы канала (право "Публикация сообщений").
//  3. Меню → "✈️ Настроить Telegram-уведомления" → вставь токен и
//     @имя_канала (или пригласи коллег в канал — они будут получать всё).
// ============================================================

function setupTelegram() {
  var ui = SpreadsheetApp.getUi();

  var r1 = ui.prompt(
    'Telegram: шаг 1/2 — токен бота',
    'Вставь токен от @BotFather (вид: 1234567890:AAaa-Bbb...).\nХранится в защищённом хранилище скрипта.',
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var token = r1.getResponseText().toString().trim();
  if (!/^\d+:[\w-]+$/.test(token)) { ui.alert('Токен не похож на настоящий. Проверь и попробуй снова.'); return; }

  var r2 = ui.prompt(
    'Telegram: шаг 2/2 — куда слать',
    'Укажи @имя_канала (например @sko_monitoring).\nБот должен быть админом канала с правом публикации!',
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var chat = r2.getResponseText().toString().trim();
  if (!chat) { ui.alert('Канал не указан.'); return; }
  if (chat.charAt(0) !== '@' && !/^-?\d+$/.test(chat)) chat = '@' + chat;

  var props = PropertiesService.getScriptProperties();
  props.setProperty('TG_TOKEN', token);
  props.setProperty('TG_CHAT', chat);

  ui.alert('✅ Сохранено.\n\nТеперь нажми "✈️ Тест Telegram" — в канал должно прийти пробное сообщение.');
}

function setupNegativeTelegram() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) {
    ui.alert('Сначала настрой основного Telegram-бота. Для обоих каналов используется один бот.');
    return;
  }
  var response = ui.prompt(
    'Канал «Ежедневный мониторинг»',
    'Укажи @имя_канала или его числовой chat_id.\nБот должен быть администратором канала.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var chat = response.getResponseText().toString().trim();
  if (!chat) return;
  if (chat.charAt(0) !== '@' && !/^-?\d+$/.test(chat)) chat = '@' + chat;
  PropertiesService.getScriptProperties().setProperty('TG_NEG_CHAT', chat);

  var result = sendTelegramDetailed_(
    '<b>Канал «Ежедневный мониторинг» подключён</b>\n\nСюда будут поступать жалобы и происшествия из городских пабликов.',
    {},
    chat
  );
  ui.alert(result.ok
    ? 'Канал подключён, пробное сообщение отправлено.'
    : 'Канал сохранён, но тест не прошёл: ' + (result.error || 'неизвестная ошибка'));
}

function setupMonitorBridge() {
  var ui = SpreadsheetApp.getUi();
  var execUrl = ScriptApp.getService().getUrl();
  if (!execUrl) {
    ui.alert('Сначала разверни Apps Script как веб-приложение с доступом «Все».');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('MONITOR_WEBHOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('MONITOR_WEBHOOK_SECRET', secret);
  }
  ui.alert(
    'Python-помощник готов к подключению.\n\n' +
    'Адрес:\n' + execUrl + '\n\n' +
    'Секрет:\n' + secret + '\n\n' +
    'Эти два значения понадобятся один раз при включении бесплатного расписания.'
  );
}

// Служебная настройка через Apps Script Execution API. Она доступна только
// владельцу проекта (executionApi.access = MYSELF) и не раскрывает токен бота.
function configureDeploymentBridge(secret, webAppUrl) {
  secret = String(secret || '').trim();
  webAppUrl = String(webAppUrl || '').trim();
  if (!/^[A-Za-z0-9_-]{48,128}$/.test(secret)) {
    throw new Error('Некорректный секрет моста.');
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(webAppUrl)) {
    throw new Error('Некорректный адрес веб-приложения.');
  }

  var props = PropertiesService.getScriptProperties();
  props.setProperty('MONITOR_WEBHOOK_SECRET', secret);
  props.setProperty('PY_MONITOR_ACTIVE', '1');

  var token = props.getProperty('TG_TOKEN');
  var webhookOk = false;
  var webhookError = '';
  if (token) {
    try {
      var response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ url: webAppUrl, allowed_updates: ['message'] }),
        muteHttpExceptions: true
      });
      var parsed = JSON.parse(response.getContentText() || '{}');
      webhookOk = response.getResponseCode() === 200 && parsed.ok === true;
      webhookError = webhookOk ? '' : (parsed.description || ('HTTP ' + response.getResponseCode()));
    } catch (e) {
      webhookError = e.message || String(e);
    }
  }

  skoLog_('Развёртывание', 'Python мост настроен; TG webhook: ' + (webhookOk ? 'OK' : webhookError || 'нет токена'));
  return {
    ok: true,
    webAppUrl: webAppUrl,
    telegramConfigured: !!token,
    telegramWebhookOk: webhookOk,
    telegramError: webhookError
  };
}

function disableTelegram() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('TG_TOKEN');
  props.deleteProperty('TG_CHAT');
  props.deleteProperty('TG_NEG_CHAT');
  SpreadsheetApp.getUi().alert('Telegram-уведомления отключены.');
}

function testTelegram() {
  var ui = SpreadsheetApp.getUi();
  var ok = sendTelegram_('<b>✅ Мониторинг СКО подключён!</b>\n\nСюда будут автоматически приходить все упоминания области в СМИ:\n📰 заголовок и источник\n🗓 дата и время публикации\n🔎 что именно найдено\n🖼 превью статьи с картинкой\n\n<i>Проверка каждые 30 минут, круглосуточно.</i>');
  ui.alert(ok
    ? '✅ Отправлено! Проверь канал.'
    : '❌ Не отправилось. Проверь:\n1. Токен верный?\n2. Бот добавлен в АДМИНЫ канала?\n3. Имя канала с @ и без ошибок?\n\nДетали — на листе ЖУРНАЛ.');
}

// Низкоуровневая отправка с подробным результатом для надёжной очереди.
function sendTelegramDetailed_(text, opts, chatOverride) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TG_TOKEN');
  var chat = chatOverride || props.getProperty('TG_CHAT');
  if (!token || !chat) return { ok: false, status: 0, retryAfter: 0, error: 'Telegram не настроен' };

  var payload = {
    chat_id: chat,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: false
  };
  if (opts && opts.linkPreviewUrl) {
    // Явно указываем, какую ссылку разворачивать в превью (с картинкой),
    // и просим показывать превью крупно — как в настоящих новостных пабликах
    payload.link_preview_options = {
      is_disabled: false,
      url: opts.linkPreviewUrl,
      prefer_large_media: true,
      show_above_text: false
    };
    delete payload.disable_web_page_preview;
  }

  try {
    var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var status = resp.getResponseCode();
    var body = resp.getContentText();
    var parsed = {};
    try { parsed = JSON.parse(body); } catch (eJson) {}
    if (status === 200 && parsed.ok !== false) {
      return {
        ok: true,
        status: status,
        retryAfter: 0,
        messageId: parsed.result && parsed.result.message_id
      };
    }
    var retryAfter = parsed.parameters && Number(parsed.parameters.retry_after) || 0;
    var errorText = parsed.description || body || ('HTTP ' + status);
    skoLog_('Telegram ошибка', ('HTTP ' + status + ': ' + errorText).slice(0, 300));
    return { ok: false, status: status, retryAfter: retryAfter, error: errorText };
  } catch (e) {
    skoLog_('Telegram ошибка', e.message || String(e));
    return { ok: false, status: 0, retryAfter: 0, error: e.message || String(e) };
  }
}

// Совместимость с тестом Telegram и остальными функциями старого кода.
function sendTelegram_(text, opts) {
  return sendTelegramDetailed_(text, opts).ok;
}

function telegramChatForFlow_(flow) {
  var props = PropertiesService.getScriptProperties();
  if (String(flow || '').toLowerCase().indexOf('negative') !== -1 ||
      String(flow || '').toLowerCase().indexOf('негатив') !== -1 ||
      String(flow || '').toLowerCase().indexOf('ежеднев') !== -1) {
    return props.getProperty('TG_NEG_CHAT') || '';
  }
  return props.getProperty('TG_CHAT') || '';
}

// Экранирование для HTML-режима Telegram
function tgEsc_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Хэштег из имени источника: "Kazinform рус" -> #Kazinform_рус
function tgTag_(src) {
  var t = String(src || '').trim().replace(/[^\wа-яёА-ЯЁ]+/g, '_').replace(/^_+|_+$/g, '');
  return t ? '#' + t : '';
}

var TG_QUEUE_SHEET = '_ОЧЕРЕДЬ_КАНАЛА';
var TG_QUEUE_HEADERS = [
  'ID', 'Создано', 'Обновлено', 'Статус', 'Попыток', 'Следующая попытка',
  'Источник', 'Заголовок', 'URL', 'Примечание', 'Опубликовано', 'Поток',
  'URL ключ', 'Ключ источника+заголовка', 'Последняя ошибка'
];

function telegramQueueSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(TG_QUEUE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(TG_QUEUE_SHEET);
    sh.getRange(1, 1, 1, TG_QUEUE_HEADERS.length).setValues([TG_QUEUE_HEADERS]);
    sh.setFrozenRows(1);
    sh.hideSheet();
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, TG_QUEUE_HEADERS.length).setValues([TG_QUEUE_HEADERS]);
  }
  return sh;
}

function asDateOrBlank_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  var d = new Date(value);
  return isNaN(d.getTime()) ? '' : d;
}

function enqueueTelegramFindings_(findings, headerLabel) {
  if (!findings || !findings.length) return 0;
  var props = PropertiesService.getScriptProperties();
  // Даже если канал ещё не указан, сохраняем находку в очереди: после
  // настройки она будет доставлена, а не потеряется.
  if (!props.getProperty('TG_TOKEN')) return 0;

  var tgSeen = loadSeenSheet_('_ПАМЯТЬ_КАНАЛА');
  var sh = telegramQueueSheet_();
  var queuedUrl = {};
  var queuedTitle = {};
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 13, sh.getLastRow() - 1, 2).getValues().forEach(function(r) {
      if (r[0]) queuedUrl[String(r[0])] = true;
      if (r[1]) queuedTitle[String(r[1])] = true;
    });
  }

  var staleCut = Date.now() - 6 * 60 * 60 * 1000;
  var skippedStale = 0;
  var rows = [];
  findings.slice().sort(function(a, b) {
    var ta = asDateOrBlank_(a.pub); ta = ta ? ta.getTime() : 0;
    var tb = asDateOrBlank_(b.pub); tb = tb ? tb.getTime() : 0;
    return tb - ta;
  }).forEach(function(f) {
    var negativeFlow = String(headerLabel || '').toLowerCase().indexOf('negative') !== -1 ||
      String(headerLabel || '').toLowerCase().indexOf('негатив') !== -1 ||
      String(headerLabel || '').toLowerCase().indexOf('ежеднев') !== -1;
    if (!negativeFlow && isRegionalFinding_(f)) return;
    var published = asDateOrBlank_(f.pub);
    if (published && published.getTime() < staleCut) { skippedStale++; return; }

    var uk = urlKey_(f.url);
    var tk = sourceTitleKey_(f.url, f.src, f.title);
    if (!uk || tgSeen[uk] || tgSeen[tk] || queuedUrl[uk] || queuedTitle[tk]) return;

    var now = new Date();
    rows.push([
      'q|' + uk, now, now, 'pending', 0, now,
      f.src || '', f.title || '', f.url || '', f.note || '', published,
      headerLabel || '', uk, tk, ''
    ]);
    queuedUrl[uk] = true;
    queuedTitle[tk] = true;
  });

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, TG_QUEUE_HEADERS.length).setValues(rows);
    skoLog_('Telegram очередь', 'Добавлено: ' + rows.length);
  }
  if (skippedStale) skoLog_('Не в канал (старше 6 ч)', String(skippedStale));
  return rows.length;
}

function formatTelegramFinding_(f) {
  var tz = Session.getScriptTimeZone();
  var pub = asDateOrBlank_(f.pub);
  var pubTxt = '';
  var ageTxt = '';
  if (pub) {
    try {
      var hhmm = Utilities.formatDate(pub, tz, 'HH:mm');
      pubTxt = hhmm === '00:00'
        ? Utilities.formatDate(pub, tz, 'dd.MM.yyyy')
        : Utilities.formatDate(pub, tz, 'dd.MM.yyyy в HH:mm');
      var mins = Math.round((Date.now() - pub.getTime()) / 60000);
      if (hhmm !== '00:00' && mins >= 0) {
        if (mins < 60) ageTxt = '🔥 ' + mins + ' мин назад';
        else if (mins < 180) ageTxt = '⏱ ' + Math.round(mins / 60) + ' ч назад';
        else ageTxt = '🕗 ' + Math.round(mins / 60) + ' ч назад';
      }
    } catch (e) {}
  }
  var sentTxt = Utilities.formatDate(new Date(), tz, 'dd.MM HH:mm');
  return '<b>' + tgEsc_(f.title) + '</b>\n\n' +
    '📰 ' + tgEsc_(f.src) +
    (pubTxt ? '\n🗓 Опубликовано: ' + pubTxt : '') +
    (ageTxt ? '  •  ' + ageTxt : '') +
    (f.note ? '\n🔎 Найдено: ' + tgEsc_(f.note) : '') +
    '\n\n<a href="' + tgEsc_(f.url) + '">➜ Читать материал</a>\n\n' +
    tgTag_(f.src) + ' • <i>мониторинг ' + sentTxt + '</i>';
}

function flushTelegramQueue_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TG_TOKEN')) return 0;
  var sh = telegramQueueSheet_();
  if (sh.getLastRow() < 2) return 0;

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TG_QUEUE_HEADERS.length).getValues();
  var tgSeen = loadSeenSheet_('_ПАМЯТЬ_КАНАЛА');
  var nowMs = Date.now();
  var sent = 0;
  var processed = 0;
  var maxPerRun = 12;

  for (var i = 0; i < rows.length && processed < maxPerRun; i++) {
    var r = rows[i];
    var sheetRow = i + 2;
    var state = String(r[3] || 'pending');
    var updated = asDateOrBlank_(r[2]);
    if (state === 'sending' && updated && nowMs - updated.getTime() > 15 * 60 * 1000) state = 'retry';
    if (state !== 'pending' && state !== 'retry') continue;

    var nextAttempt = asDateOrBlank_(r[5]);
    if (nextAttempt && nextAttempt.getTime() > nowMs) continue;
    var uk = String(r[12] || urlKey_(r[8]));
    var tk = String(r[13] || sourceTitleKey_(r[8], r[6], r[7]));
    if (tgSeen[uk] || tgSeen[tk]) {
      sh.getRange(sheetRow, 3, 1, 4).setValues([[new Date(), 'skipped', r[4] || 0, '']]);
      continue;
    }

    var attempts = Number(r[4] || 0) + 1;
    processed++;
    sh.getRange(sheetRow, 3, 1, 4).setValues([[new Date(), 'sending', attempts, '']]);
    SpreadsheetApp.flush();

    var finding = { src: r[6], title: r[7], url: r[8], note: r[9], pub: r[10] };
    var targetChat = telegramChatForFlow_(r[11]);
    if (!targetChat) {
      sh.getRange(sheetRow, 3, 1, 4).setValues([[new Date(), 'retry', attempts, new Date(Date.now() + 60 * 60 * 1000)]]);
      sh.getRange(sheetRow, 15).setValue('Канал для потока не настроен');
      continue;
    }
    var result = sendTelegramDetailed_(formatTelegramFinding_(finding), { linkPreviewUrl: finding.url }, targetChat);
    if (result.ok) {
      sh.getRange(sheetRow, 3, 1, 4).setValues([[new Date(), 'sent', attempts, '']]);
      sh.getRange(sheetRow, 15).setValue('');
      tgSeen[uk] = true;
      tgSeen[tk] = true;
      saveSeenSheet_('_ПАМЯТЬ_КАНАЛА', tgSeen);
      sent++;
    } else {
      var waitSeconds = result.retryAfter || Math.min(6 * 60 * 60, Math.pow(2, Math.min(attempts, 6)) * 5 * 60);
      var retryAt = new Date(Date.now() + waitSeconds * 1000);
      sh.getRange(sheetRow, 3, 1, 4).setValues([[new Date(), 'retry', attempts, retryAt]]);
      sh.getRange(sheetRow, 15).setValue(String(result.error || ('HTTP ' + result.status)).slice(0, 500));
      // При rate limit дальнейшие сообщения сейчас тоже не пройдут.
      if (result.status === 429) break;
    }
    if (processed < maxPerRun) Utilities.sleep(1500);
  }

  if (sent) skoLog_('Telegram доставлено', String(sent));
  cleanupTelegramQueue_();
  return sent;
}

function cleanupTelegramQueue_() {
  var sh = telegramQueueSheet_();
  if (sh.getLastRow() <= 600) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TG_QUEUE_HEADERS.length).getValues();
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var active = [];
  var terminal = [];
  rows.forEach(function(r) {
    var state = String(r[3] || 'pending');
    var updated = asDateOrBlank_(r[2]);
    var done = state === 'sent' || state === 'skipped';
    if (!done) active.push(r);
    else if (!updated || updated.getTime() >= cutoff) terminal.push(r);
  });
  var room = Math.max(0, 1999 - active.length);
  if (terminal.length > room) terminal = terminal.slice(terminal.length - room);
  var kept = active.concat(terminal);
  sh.clearContents();
  sh.getRange(1, 1, 1, TG_QUEUE_HEADERS.length).setValues([TG_QUEUE_HEADERS]);
  if (kept.length) sh.getRange(2, 1, kept.length, TG_QUEUE_HEADERS.length).setValues(kept);
}

function flushTelegramQueueSilent_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    flushTelegramQueue_();
  } catch (e) {
    skoLog_('Telegram очередь ошибка', e.message || String(e));
  } finally {
    lock.releaseLock();
  }
}

// Находки сначала попадают в очередь. В память канала они записываются
// только после ответа Telegram 200 OK.
function sendFindingsToTelegram_(findings, headerLabel) {
  enqueueTelegramFindings_(findings, headerLabel);
  flushTelegramQueue_();
}


// ============================================================
//  ЛИЧНОЕ МЕНЮ БОТА В TELEGRAM
//
//  Канал — чистая витрина новостей для всех.
//  Личка с ботом — твой пульт: проверка СМИ/YouTube/позитива,
//  сводка за сегодня, статус — всё кнопками с телефона.
//
//  Управлять может ТОЛЬКО владелец: первый, кто напишет боту
//  /start, назначается хозяином (сохраняется chat_id).
//  Остальным бот вежливо отказывает и зовёт в канал.
//
//  Включение: меню → "✈️ Включить ЛИЧНОЕ меню бота"
//  (требуется активное развёртывание Web App с доступом "Все").
// ============================================================

function enableTgBotMenu() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) { ui.alert('Сначала настрой Telegram (токен) через «✈️ Настроить Telegram-уведомления».'); return; }

  var execUrl = ScriptApp.getService().getUrl();
  if (!execUrl) {
    ui.alert('Не найдено активное развёртывание Web App.\nСделай: Развернуть → Управление развёртываниями → активное веб-приложение (доступ «Все»).');
    return;
  }

  try {
    var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ url: execUrl, allowed_updates: ['message'] }),
      muteHttpExceptions: true
    });
    var body = resp.getContentText();
    if (resp.getResponseCode() === 200 && body.indexOf('"ok":true') !== -1) {
      skoLog_('TG меню', 'Вебхук установлен');
      ui.alert('✅ Личное меню включено!\n\nОткрой своего бота в Telegram и напиши ему /start.\nПервый написавший становится владельцем — это будешь ты.');
    } else {
      skoLog_('TG меню ошибка', body.slice(0, 300));
      ui.alert('❌ Не получилось: ' + body.slice(0, 200));
    }
  } catch (e) {
    ui.alert('Ошибка: ' + e.message);
  }
}

// Личное сообщение владельцу (алерты о здоровье системы).
// Молчит, если владелец ещё не назначен (/start в личке бота).
function notifyAdmin_(text) {
  var admin = PropertiesService.getScriptProperties().getProperty('TG_ADMIN');
  if (!admin) return;
  sendTgChat_(admin, text);
}

// Диагностика личного меню: показывает, куда смотрит вебхук
// и какую ошибку видит Telegram — вместо гаданий.
function diagnoseWebhook() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) { ui.alert('Токен не сохранён. Сначала «✈️ Настроить Telegram-уведомления».'); return; }

  try {
    var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo',
      { muteHttpExceptions: true });
    var data = JSON.parse(resp.getContentText());
    var info = data.result || {};
    var current = ScriptApp.getService().getUrl() || '(развёртывание не найдено)';

    var lines = [];
    lines.push('Вебхук у Telegram: ' + (info.url ? info.url.slice(0, 80) + '…' : '❌ НЕ УСТАНОВЛЕН'));
    lines.push('');
    lines.push('Наш актуальный адрес: ' + (current !== '(развёртывание не найдено)' ? current.slice(0, 80) + '…' : current));
    lines.push('');
    if (!info.url) {
      lines.push('➡ Вебхук не установлен. Нажми «✈️ Включить ЛИЧНОЕ меню бота».');
    } else if (current && info.url !== current) {
      lines.push('⚠ АДРЕСА НЕ СОВПАДАЮТ: вебхук смотрит на СТАРОЕ развёртывание!');
      lines.push('➡ Нажми «✈️ Включить ЛИЧНОЕ меню бота» — переустановлю на актуальный.');
    } else {
      lines.push('✓ Адрес совпадает.');
    }
    if (info.last_error_message) {
      lines.push('');
      lines.push('Последняя ошибка Telegram: ' + info.last_error_message);
      if (/403|401|unauthorized|forbidden/i.test(info.last_error_message)) {
        lines.push('➡ Похоже, доступ развёртывания не «Все». Исправь в настройках развёртывания.');
      }
    }
    if (typeof info.pending_update_count === 'number' && info.pending_update_count > 0) {
      lines.push('');
      lines.push('Ожидают доставки: ' + info.pending_update_count + ' сообщений (твои /start в очереди).');
    }
    ui.alert('✈️ Статус вебхука\n\n' + lines.join('\n'));
  } catch (e) {
    ui.alert('Ошибка проверки: ' + e.message);
  }
}

// Универсальная отправка в конкретный чат (личка)
function sendTgChat_(chatId, text, keyboard) {
  var token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) return false;
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (keyboard) payload.reply_markup = keyboard;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    return true;
  } catch (e) { return false; }
}

function tgMainKeyboard_() {
  return {
    keyboard: [
      ['▶ Проверить СМИ', '📺 YouTube'],
      ['🌿 Позитив', '📊 Сводка за сегодня'],
      ['⏰ Статус']
    ],
    resize_keyboard: true
  };
}

function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function dailyMonitorSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG_DAILY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG_DAILY_SHEET);
    sh.getRange(1, 1, 1, 10).setValues([[
      'Получено', 'Дата публикации', 'Источник', 'Площадка', 'Категория',
      'Заголовок', 'Ссылка', 'Кратко', 'Релевантность', 'Статус'
    ]]);
    sh.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#B23B3B').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    [110, 145, 170, 100, 170, 420, 300, 420, 120, 150].forEach(function(w, i) {
      sh.setColumnWidth(i + 1, w);
    });
  }
  return sh;
}

function writeDailyMonitorRows_(items) {
  if (!items.length) return;
  var sh = dailyMonitorSheet_();
  var rows = items.map(function(item) {
    var p = item.publication || {};
    var a = item.analysis || {};
    var pub = p.published_at ? new Date(p.published_at) : '';
    return [
      new Date(), pub, p.source_name || '', p.platform || '', a.category || '',
      p.title || '', p.url || '', a.summary || '', Number(a.confidence || 0),
      a.needs_review ? 'Требует проверки' : 'Релевантно'
    ];
  });
  sh.insertRowsAfter(1, rows.length);
  sh.getRange(2, 1, rows.length, 10).setValues(rows);
  sh.getRange(2, 7, rows.length, 1).setFontColor('#1155CC');
  if (sh.getLastRow() > CFG.FINDINGS_MAX + 60) {
    sh.deleteRows(CFG.FINDINGS_MAX + 1, sh.getLastRow() - CFG.FINDINGS_MAX);
  }
}

function handleExternalIngest_(payload) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('MONITOR_WEBHOOK_SECRET');
  if (!expected || !payload || payload.secret !== expected) {
    return { ok: false, error: 'unauthorized' };
  }
  var items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
  var bridgeSeen = loadSeenSheet_('_ПАМЯТЬ_МОСТА');
  var channelSeen = loadSeenSheet_('_ПАМЯТЬ_КАНАЛА');
  var main = [];
  var negative = [];
  var accepted = 0;

  items.forEach(function(item) {
    var p = item.publication || {};
    var a = item.analysis || {};
    if (!p.url || !p.title) return;
    var uk = urlKey_(p.url);
    var tk = sourceTitleKey_(p.url, p.source_name || '', p.title);
    if (bridgeSeen[uk] || bridgeSeen[tk]) return;
    if (p.workflow === 'sko_mentions' && (channelSeen[uk] || channelSeen[tk])) {
      bridgeSeen[uk] = true;
      bridgeSeen[tk] = true;
      return;
    }

    var pub = p.published_at ? new Date(p.published_at) : null;
    var finding = {
      src: p.source_name || p.platform || 'Python',
      title: p.title,
      url: p.url,
      pub: pub && !isNaN(pub.getTime()) ? pub : null,
      note: (a.category || '') + ' | ' + Math.round(Number(a.confidence || 0) * 100) + '%'
    };
    if (p.workflow === 'akimat_negative') negative.push({ item: item, finding: finding });
    else if (p.workflow === 'sko_mentions' && !isRegionalFinding_(finding)) main.push({ item: item, finding: finding });
    else return;

    bridgeSeen[uk] = true;
    bridgeSeen[tk] = true;
    accepted++;
  });

  if (main.length) {
    writeRows_(CFG.FINDINGS, main.map(function(x) { return x.finding; }));
    enqueueTelegramFindings_(main.map(function(x) { return x.finding; }), 'sko_mentions');
  }
  if (negative.length) {
    writeDailyMonitorRows_(negative.map(function(x) { return x.item; }));
    enqueueTelegramFindings_(negative.map(function(x) { return x.finding; }), 'akimat_negative');
  }
  saveSeenSheet_('_ПАМЯТЬ_МОСТА', bridgeSeen);
  flushTelegramQueue_();
  skoLog_('Python мост', 'Принято: ' + accepted + ', СКО: ' + main.length + ', негатив: ' + negative.length);
  return { ok: true, accepted: accepted, main: main.length, negative: negative.length };
}

function handleExternalHeartbeat_(payload) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('MONITOR_WEBHOOK_SECRET');
  if (!expected || !payload || payload.secret !== expected) {
    return { ok: false, error: 'unauthorized' };
  }
  props.setProperty('PY_LAST_HEARTBEAT', String(Date.now()));
  props.setProperty('PY_MONITOR_ACTIVE', '1');
  props.setProperty('PY_LAST_REPORT', JSON.stringify(payload.report || {}).slice(0, 4000));
  return { ok: true, received_at: new Date().toISOString() };
}

function stopExternalMainDelivery_(payload) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('MONITOR_WEBHOOK_SECRET');
  if (!expected || !payload || payload.secret !== expected) {
    return { ok: false, error: 'unauthorized' };
  }

  var sh = telegramQueueSheet_();
  var cancelled = 0;
  if (sh.getLastRow() >= 2) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, TG_QUEUE_HEADERS.length).getValues();
    rows.forEach(function(r, index) {
      var state = String(r[3] || 'pending');
      var flow = String(r[11] || '');
      if (flow !== 'sko_mentions' || (state !== 'pending' && state !== 'retry' && state !== 'sending')) return;
      sh.getRange(index + 2, 3, 1, 4).setValues([[new Date(), 'cancelled', r[4] || 0, '']]);
      sh.getRange(index + 2, 15).setValue('Отменено: внешний фильтр остановлен');
      cancelled++;
    });
  }
  props.setProperty('PY_MONITOR_ACTIVE', '0');
  skoLog_('Python мост остановлен', 'Отменено сообщений: ' + cancelled);
  return { ok: true, cancelled: cancelled };
}

function handleHistoricalResults_(payload) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('MONITOR_WEBHOOK_SECRET');
  if (!expected || !payload || payload.secret !== expected) {
    return { ok: false, error: 'unauthorized' };
  }
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CFG_SEARCH_SHEET);
  if (!sh) sh = ss.insertSheet(CFG_SEARCH_SHEET);
  var headers = ['Запрос', 'Период', 'Дата', 'Источник', 'Заголовок', 'Ссылка', 'Кратко', 'Релевантность', 'Метод'];
  if (payload.replace || sh.getLastRow() === 0) {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#4527A0').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    [260, 190, 110, 180, 420, 300, 420, 120, 150].forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });
  }
  var items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
  var period = (payload.date_from || '') + ' — ' + (payload.date_to || '');
  var rows = items.map(function(item) {
    return [
      payload.query || '', period, (item.published_at || '').slice(0, 10),
      item.source || '', item.title || '', item.url || '', item.summary || '',
      Number(item.relevance || 0), item.method || ''
    ];
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    sh.getRange(sh.getLastRow() - rows.length + 1, 6, rows.length, 1).setFontColor('#1155CC');
  }
  return { ok: true, accepted: rows.length };
}

function checkPythonHeartbeatSilent_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PY_MONITOR_ACTIVE') !== '1') return;
  var last = Number(props.getProperty('PY_LAST_HEARTBEAT') || 0);
  if (last && Date.now() - last <= 3 * 60 * 60 * 1000) return;
  var alerted = Number(props.getProperty('PY_LAST_ALERT') || 0);
  if (alerted && Date.now() - alerted < 12 * 60 * 60 * 1000) return;
  props.setProperty('PY_LAST_ALERT', String(Date.now()));
  notifyAdmin_(
    '<b>Python-помощник давно не выходил на связь</b>\n\n' +
    'Основной Google-мониторинг продолжает работать. Проверь последнее выполнение GitHub Actions.'
  );
  skoLog_('Python watchdog', 'Нет heartbeat более 3 часов');
}

// Приём сообщений от Telegram (вебхук)
function doPost(e) {
  try {
    var upd = JSON.parse(e.postData.contents);

    // Защищённый приём результатов бесплатного Python-помощника.
    if (upd && upd.action === 'ingest') return jsonOutput_(handleExternalIngest_(upd));
    if (upd && upd.action === 'heartbeat') return jsonOutput_(handleExternalHeartbeat_(upd));
    if (upd && upd.action === 'historical') return jsonOutput_(handleHistoricalResults_(upd));
    if (upd && upd.action === 'stop_external_main') return jsonOutput_(stopExternalMainDelivery_(upd));

    // ЗАЩИТА ОТ ПОВТОРОВ: Telegram ретраит команду, если вебхук отвечает
    // медленно (наши проверки идут 1-3 мин). Помним ID обработанных
    // сообщений в кэше 6 часов — повторы игнорируем, иначе одна кнопка
    // запустила бы 2-3 проверки подряд.
    if (upd && typeof upd.update_id !== 'undefined') {
      var cache = CacheService.getScriptCache();
      var ukey = 'tg_upd_' + upd.update_id;
      if (cache.get(ukey)) return ContentService.createTextOutput('ok');
      cache.put(ukey, '1', 21600);
    }

    if (upd && upd.message) handleTgMessage_(upd.message);
  } catch (err) {
    skoLog_('TG вебхук ошибка', (err && err.message) || String(err));
  }
  return ContentService.createTextOutput('ok');
}

function handleTgMessage_(msg) {
  var chatId = msg.chat && msg.chat.id;
  var text = (msg.text || '').trim();
  if (!chatId || !text) return;

  var props = PropertiesService.getScriptProperties();
  var admin = props.getProperty('TG_ADMIN');

  // Первый /start назначает владельца
  if (!admin) {
    if (/^\/start/.test(text)) {
      props.setProperty('TG_ADMIN', String(chatId));
      sendTgChat_(chatId,
        '👋 Привет! Ты назначен <b>владельцем</b> бота мониторинга СКО.\n\n' +
        'Управляй кнопками внизу — всё как в меню таблицы, только с телефона.',
        tgMainKeyboard_());
    }
    return;
  }

  // Чужим — вежливый отказ
  if (String(chatId) !== admin) {
    sendTgChat_(chatId, 'Это служебный бот мониторинга. Все новости — в канале «Мониторинг СКО».');
    return;
  }

  // === Команды владельца ===
  if (/^\/start/.test(text)) {
    sendTgChat_(chatId, 'Пульт на связи. Выбирай действие 👇', tgMainKeyboard_());
    return;
  }

  if (text === '▶ Проверить СМИ' || text === '/check') {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) { sendTgChat_(chatId, '⏳ Проверка уже идёт — подожди пару минут.'); return; }
    try {
      sendTgChat_(chatId, '⏳ Запускаю проверку всех источников…\nОбычно 1-3 минуты. Находки придут в канал, итог — сюда.');
      var r = runSkoCheckCore_();
      sendTgChat_(chatId, tgEsc_(r.message).slice(0, 3800), tgMainKeyboard_());
    } catch (err) {
      sendTgChat_(chatId, '❌ Ошибка: ' + tgEsc_(err.message || String(err)));
    } finally { lock.releaseLock(); }
    return;
  }

  if (text === '📺 YouTube' || text === '/yt') {
    var lock2 = LockService.getScriptLock();
    if (!lock2.tryLock(1000)) { sendTgChat_(chatId, '⏳ Другая проверка уже идёт.'); return; }
    try {
      sendTgChat_(chatId, '⏳ Проверяю YouTube-каналы…');
      var r2 = runYoutubeCheckCore_();
      sendTgChat_(chatId, tgEsc_(r2.message).slice(0, 3800), tgMainKeyboard_());
    } catch (err) {
      sendTgChat_(chatId, '❌ Ошибка: ' + tgEsc_(err.message || String(err)));
    } finally { lock2.releaseLock(); }
    return;
  }

  if (text === '🌿 Позитив' || text === '/positive') {
    var lock3 = LockService.getScriptLock();
    if (!lock3.tryLock(1000)) { sendTgChat_(chatId, '⏳ Другая проверка уже идёт.'); return; }
    try {
      sendTgChat_(chatId, '⏳ Собираю позитив по региональным СМИ…');
      var r3 = runPositiveCheckCore_();
      sendTgChat_(chatId, tgEsc_(r3.message).slice(0, 3800), tgMainKeyboard_());
    } catch (err) {
      sendTgChat_(chatId, '❌ Ошибка: ' + tgEsc_(err.message || String(err)));
    } finally { lock3.releaseLock(); }
    return;
  }

  if (text === '📊 Сводка за сегодня' || text === '/today') {
    sendTgChat_(chatId, buildDailySummary_(), tgMainKeyboard_());
    return;
  }

  if (text === '⏰ Статус' || text === '/status') {
    var auto = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === 'runSkoCheckSilent';
    });
    var last = getLastRunStamp_();
    sendTgChat_(chatId,
      '⏰ <b>Статус мониторинга</b>\n\n' +
      'Автопроверка: ' + (auto ? '🟢 включена (30 мин днём / 1 час ночью)' : '🔴 ВЫКЛЮЧЕНА') + '\n' +
      (last ? 'Последняя проверка: ' + last : 'Проверок ещё не было') + '\n' +
      'Найдено сегодня: ' + countTodayFindings_(),
      tgMainKeyboard_());
    return;
  }

  sendTgChat_(chatId, 'Не понял команду. Пользуйся кнопками внизу 👇', tgMainKeyboard_());
}

// Сводка за сегодня из листа НАХОДКИ — готовый текст для пересылки
function buildDailySummary_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG.FINDINGS);
  if (!sh || sh.getLastRow() < 2) return 'Сегодня находок пока нет.';

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM');
  var n = Math.min(200, sh.getLastRow() - 1);
  var rows = sh.getRange(2, 1, n, 6).getDisplayValues();

  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var found = (rows[i][0] || '').toString();
    if (found.indexOf(today) !== 0) continue;
    var title = rows[i][3], url = rows[i][4], src = rows[i][2];
    if (!title) continue;
    items.push('• <b>' + tgEsc_(title) + '</b>\n  ' + tgEsc_(src) + ' — ' + tgEsc_(url));
    if (items.length >= 20) break;
  }

  if (!items.length) return '📊 Сводка за ' + today + ': упоминаний СКО пока не найдено.';

  return '📊 <b>Мониторинг СМИ за ' + today + '</b>\n' +
    'Найдено упоминаний СКО: ' + items.length + '\n\n' +
    items.join('\n\n');
}

function countTodayFindings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(CFG.FINDINGS);
  if (!sh || sh.getLastRow() < 2) return 0;
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM');
  var n = Math.min(300, sh.getLastRow() - 1);
  var col = sh.getRange(2, 1, n, 1).getDisplayValues();
  var cnt = 0;
  for (var i = 0; i < col.length; i++) {
    if ((col[i][0] || '').toString().indexOf(today) === 0) cnt++;
  }
  return cnt;
}
