from __future__ import annotations

import re
from dataclasses import dataclass


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("ё", "е")).strip()


SKO_STRONG = {
    "северо-казахстанск": "Северо-Казахстанская область",
    "солтүстік қазақстан": "Солтүстік Қазақстан",
    "north kazakhstan": "North Kazakhstan",
    "петропавловск": "Петропавловск",
    "петропавл": "Петропавл",
    "petropavlovsk": "Petropavlovsk",
    "petropavl": "Petropavl",
}

SKO_DISTRICTS = {
    "айыртауск": "Айыртауский район",
    "айыртау ауданы": "Айыртау ауданы",
    "акжарск": "Акжарский район",
    "ақжар ауданы": "Ақжар ауданы",
    "аккайынск": "Аккайынский район",
    "аққайың ауданы": "Аққайың ауданы",
    "кызылжарск": "Кызылжарский район",
    "қызылжар ауданы": "Қызылжар ауданы",
    "мамлютск": "Мамлютский район",
    "тайыншинск": "Тайыншинский район",
    "тимирязевск": "Тимирязевский район",
    "уалихановск": "Уалихановский район",
    "магжана жумабаева": "район Магжана Жумабаева",
    "мағжан жұмабаев": "Мағжан Жұмабаев ауданы",
    "габита мусрепова": "район Габита Мусрепова",
    "ғабит мүсірепов": "Ғабит Мүсірепов ауданы",
    "шал акына": "район Шал акына",
    "шал ақын": "Шал ақын ауданы",
    "жамбылский район": "Жамбылский район СКО",
    "жамбыл ауданы": "Жамбыл ауданы",
    "есильский район": "Есильский район СКО",
    "есіл ауданы": "Есіл ауданы",
}

SKO_PLACES = {
    "саумалкол": "Саумалколь",
    "талшик": "Талшик",
    "смирново": "Смирново",
    "явленк": "Явленка",
    "пресновк": "Пресновка",
    "бишкул": "Бишкуль",
    "мамлютк": "Мамлютка",
    "булаево": "Булаево",
    "новоишимск": "Новоишимское",
    "тайынш": "Тайынша",
    "тимирязево": "Тимирязево",
    "кишкенекол": "Кишкенеколь",
    "сергеевк": "Сергеевка",
}

SKO_STOP = (
    "петропавловск-камчат",
    "петропавловка",
)

AMBIGUOUS_DISTRICTS = {
    "кызылжарск",
    "жамбылский район",
    "жамбыл ауданы",
    "есильский район",
    "есіл ауданы",
}

OTHER_REGION_MARKERS = (
    "акмолинск",
    "актюбинск",
    "алматинск",
    "атырауск",
    "восточно-казахстанск",
    "жамбылск",
    "жетысу",
    "западно-казахстанск",
    "карагандинск",
    "костанайск",
    "кызылординск",
    "мангистауск",
    "павлодарск",
    "туркестанск",
    "улытау",
    "абайск",
)

NEGATIVE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "дороги": (
        "ямы",
        "яма",
        "разбит",
        "асфальт",
        "бездорож",
        "не чистят снег",
        "гололед",
        "тротуар",
        "грейдер",
        "жол нашар",
        "шұңқыр",
    ),
    "ЖКХ": (
        "нет воды",
        "без воды",
        "отключили воду",
        "прорыв",
        "канализац",
        "затопило подвал",
        "нет отопления",
        "холодные батареи",
        "нет света",
        "отключение электр",
        "аварийные сети",
        "су жоқ",
        "жарық жоқ",
        "жылу жоқ",
    ),
    "благоустройство": (
        "мусор",
        "свалка",
        "не вывозят",
        "грязь",
        "вонь",
        "контейнер",
        "разбитая площадка",
        "нет освещения",
        "фонари не горят",
        "сорняк",
        "қоқыс",
    ),
    "животные": (
        "бродячие собак",
        "бездомные собак",
        "собаки напали",
        "отлов собак",
        "стая собак",
        "қаңғыбас ит",
        "ит қапты",
    ),
    "паводок и подтопление": (
        "паводок",
        "подтоплен",
        "затопило",
        "талая вода",
        "вода во дворе",
        "дамба",
        "наводнен",
        "су басты",
        "тасқын",
    ),
    "транспорт": (
        "автобус не",
        "нет автобуса",
        "маршрут",
        "остановка",
        "общественный транспорт",
        "переполненный автобус",
        "автобус жүрмейді",
    ),
    "экология": (
        "дым",
        "выброс",
        "загрязнен",
        "неприятный запах",
        "мертвая рыба",
        "вырубка",
        "экология",
        "ауа ластан",
    ),
    "происшествие": (
        "дтп",
        "авария",
        "пожар",
        "возгорание",
        "погиб",
        "пострадал",
        "обрушение",
        "нападение",
        "драка",
        "травм",
        "пропал",
        "эвакуац",
        "апат",
        "өрт",
    ),
}

COMPLAINT_MARKERS = (
    "жалоб",
    "жалуются",
    "принять меры",
    "обратите внимание",
    "когда решат",
    "сколько можно",
    "никто не реагирует",
    "акимат",
    "безобразие",
    "возмущены",
    "помогите",
    "не могут",
    "не работает",
    "не убирают",
    "не ремонтируют",
    "шағым",
    "көмектесіңіз",
    "әкімдік",
    "шара қолдан",
)


@dataclass(slots=True)
class RuleScore:
    score: float
    category: str
    matched: list[str]
    places: list[str]


def score_sko(text: str) -> RuleScore:
    low = normalize(text)
    if any(stop in low for stop in SKO_STOP) or ("петропавловск" in low and "камчат" in low):
        return RuleScore(0.0, "другой регион", [], [])
    matched: list[str] = []
    places: list[str] = []
    for marker, label in SKO_STRONG.items():
        if marker == "петропавл" and "петропавловск-камчат" in low:
            continue
        if marker in low:
            matched.append(label)
            places.append(label)
    explicit_sko = bool(re.search(r"(?<![А-Яа-яA-Za-z])СКО(?![А-Яа-яA-Za-z])", text))
    contextual_sko = bool(
        re.search(
            r"(?<![а-яa-z])(?:в|из|по|для|акимат|аким|жители|дчс)\s+ско(?![а-яa-z])",
            low,
        )
    )
    if explicit_sko or contextual_sko:
        matched.append("СКО")
    has_explicit_region = bool(matched)
    has_other_region = any(marker in low for marker in OTHER_REGION_MARKERS)
    for marker, label in SKO_DISTRICTS.items():
        if marker in low:
            if marker in AMBIGUOUS_DISTRICTS and has_other_region and not has_explicit_region:
                continue
            matched.append(label)
            places.append(label)
    for marker, label in SKO_PLACES.items():
        if marker in low:
            matched.append(label)
            places.append(label)
    matched = list(dict.fromkeys(matched))
    places = list(dict.fromkeys(places))
    if any(label in matched for label in SKO_STRONG.values()) or "СКО" in matched:
        score = 0.96
    elif any(label in matched for label in SKO_DISTRICTS.values()):
        score = 0.86
    elif matched:
        score = 0.72
    else:
        score = 0.0
    return RuleScore(score, "упоминание СКО", matched[:8], places[:6])


def score_negative(text: str) -> RuleScore:
    low = normalize(text)
    category_scores: dict[str, int] = {}
    matched: list[str] = []
    for category, markers in NEGATIVE_CATEGORIES.items():
        hits = [marker for marker in markers if marker in low]
        if hits:
            category_scores[category] = len(hits)
            matched.extend(hits)
    if not category_scores:
        return RuleScore(0.0, "прочее", [], [])
    category = max(category_scores, key=category_scores.get)
    complaint_hits = [marker for marker in COMPLAINT_MARKERS if marker in low]
    matched.extend(complaint_hits)
    base = 0.62 if category == "происшествие" else 0.58
    score = min(
        0.98,
        base + 0.08 * min(3, category_scores[category] - 1) + 0.12 * min(2, len(complaint_hits)),
    )
    places = score_sko(text).places
    return RuleScore(score, category, list(dict.fromkeys(matched))[:8], places)
