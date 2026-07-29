from sko_monitor.analyzers.analyzer import PublicationAnalyzer
from sko_monitor.analyzers.semantic import SemanticScorer
from sko_monitor.models import Publication

analyzer = PublicationAnalyzer(SemanticScorer("unused", enabled=False))


def item(workflow: str, text: str) -> Publication:
    return Publication(
        source_id="test",
        source_name="Test",
        platform="telegram",
        workflow=workflow,
        url="https://t.me/test/1",
        title=text,
        text=text,
    )


def test_sko_mention_is_relevant() -> None:
    result = analyzer.analyze(item("sko_mentions", "Аким Северо-Казахстанской области посетил завод"))
    assert result.relevant
    assert result.confidence >= 0.9


def test_same_meaning_in_kazakh_is_relevant() -> None:
    result = analyzer.analyze(item("sko_mentions", "Солтүстік Қазақстан облысында жаңа мектеп ашылды"))
    assert result.relevant


def test_kamchatka_is_not_sko() -> None:
    result = analyzer.analyze(item("sko_mentions", "Новости Петропавловска-Камчатского"))
    assert not result.relevant


def test_semantic_similarity_cannot_replace_sko_geography() -> None:
    class AlwaysSimilar:
        @staticmethod
        def score(_workflow: str, _text: str) -> float:
            return 0.99

    result = PublicationAnalyzer(AlwaysSimilar()).analyze(
        item("sko_mentions", "В Павлодарской области открыли новую школу")
    )
    assert not result.relevant
    assert result.needs_review
    assert result.confidence < 0.5


def test_other_region_does_not_cancel_explicit_sko_mention() -> None:
    result = analyzer.analyze(item("sko_mentions", "Шторм ожидается в Павлодарской области и СКО"))
    assert result.relevant


def test_truncated_speed_is_not_sko_abbreviation() -> None:
    result = analyzer.analyze(
        item("sko_mentions", "В Алматинской области мопедист ехал на полной ско…")
    )
    assert not result.relevant


def test_ambiguous_kyzylzhar_in_aktobe_is_not_sko() -> None:
    result = analyzer.analyze(
        item(
            "sko_mentions",
            "В Актюбинской области скот погиб в Кызылжарском сельском округе",
        )
    )
    assert not result.relevant


def test_sko_village_without_oblast_name_is_relevant() -> None:
    result = analyzer.analyze(item("sko_mentions", "В селе Пресноредуть открыли медпункт"))
    assert result.relevant


def test_same_village_name_in_another_region_is_not_sko() -> None:
    result = analyzer.analyze(
        item("sko_mentions", "В Акмолинской области обновили школу в селе Полтавка")
    )
    assert not result.relevant


def test_regional_institution_is_relevant() -> None:
    result = analyzer.analyze(item("sko_mentions", "На предприятии ЗИКСТО запустили новый цех"))
    assert result.relevant


def test_late_sko_reference_does_not_make_another_region_story_relevant() -> None:
    text = (
        "Правительство выделило средства на дамбу озера Алаколь. "
        + "Подробности проекта и туристического развития озера. " * 20
        + "За два года дамбы строили также в Северо-Казахстанской области."
    )
    publication = Publication(
        source_id="test",
        source_name="Test",
        platform="website",
        workflow="sko_mentions",
        url="https://example.test/alakol",
        title="Правительство выделило средства на дамбу озера Алаколь",
        text=text,
    )
    result = analyzer.analyze(publication)
    assert not result.relevant


def test_northern_kazakhstan_without_sko_marker_is_not_precise_enough() -> None:
    result = analyzer.analyze(item("sko_mentions", "Центр Северного Казахстана - Кокшетау"))
    assert not result.relevant


def test_akimat_road_complaint_is_negative() -> None:
    result = analyzer.analyze(
        item("akimat_negative", "Жители жалуются на разбитую дорогу и просят акимат принять меры")
    )
    assert result.relevant
    assert result.category == "дороги"
    assert result.tone == "негативная"


def test_unrelated_local_ad_is_not_negative() -> None:
    result = analyzer.analyze(item("akimat_negative", "Сегодня скидка на новую коллекцию одежды"))
    assert not result.relevant
    assert not result.needs_review


def test_fire_sports_news_is_not_an_incident() -> None:
    result = analyzer.analyze(
        item(
            "akimat_negative",
            "Команда ДЧС СКО стала призером Кубка МЧС по пожарно-спасательному спорту",
        )
    )
    assert not result.relevant


def test_utility_modernisation_without_complaint_is_not_negative() -> None:
    result = analyzer.analyze(
        item(
            "akimat_negative",
            "В Петропавловске обсудили модернизацию коммунальной инфраструктуры и канализации",
        )
    )
    assert not result.relevant


def test_short_negative_marker_does_not_match_inside_word() -> None:
    result = analyzer.analyze(
        item(
            "akimat_negative",
            "На площадке SKO HUB встретились IT-компании и молодые специалисты",
        )
    )
    assert not result.relevant


def test_actual_fire_is_an_incident() -> None:
    result = analyzer.analyze(
        item(
            "akimat_negative",
            "В Уалихановском районе при пожаре выгорело 45 гектаров степи",
        )
    )
    assert result.relevant
    assert result.category == "происшествие"


def test_semantic_similarity_cannot_publish_negative_without_rules() -> None:
    class AlwaysSimilar:
        @staticmethod
        def score(_workflow: str, _text: str) -> float:
            return 0.99

    result = PublicationAnalyzer(AlwaysSimilar()).analyze(
        item("akimat_negative", "В городе открылась новая кофейня")
    )
    assert not result.relevant
    assert result.needs_review


def _complaint(text: str):
    from datetime import UTC, datetime

    from sko_monitor.analyzers import PublicationAnalyzer
    from sko_monitor.analyzers.semantic import SemanticScorer
    from sko_monitor.models import Publication

    analyzer = PublicationAnalyzer(SemanticScorer("", False))
    return analyzer.analyze(
        Publication(
            source_id="x",
            source_name="Паблик",
            platform="instagram",
            workflow="akimat_negative",
            url="https://www.instagram.com/p/X/",
            title=text[:70],
            text=text,
            published_at=datetime.now(UTC),
        )
    )


def test_complaint_survives_words_inserted_into_the_marker() -> None:
    # «нет воды» искалось дословно, поэтому живая формулировка проходила мимо.
    assert _complaint("В Петропавловске третьи сутки нет холодной воды").relevant
    assert _complaint("Опять отключили горячую воду без предупреждения").relevant


def test_resident_voice_reaches_the_channel() -> None:
    # Так жалоба звучит у самого жителя: без слова «жалоба», зато с «третий
    # год» и «опасно». Эти обороты сняты с живых постов пабликов СКО.
    road = _complaint(
        "Жители Троицкого не дождались обещанного ремонта дороги, третий год ходят по грязи"
    )
    assert road.relevant and road.category == "дороги"

    sidewalk = _complaint(
        "Здравствуйте. Опасно проходить этот участок тротуара особенно с детьми. "
        "Побелить побелили, но в порядок не привели. Падение плиты может чревато "
        "обойтись. Тротуар по Муканова"
    )
    assert sidewalk.relevant and sidewalk.category == "дороги"


def test_volunteer_news_no_longer_trips_on_the_word_container() -> None:
    # Голое слово «контейнер» ловило новость про раздельный сбор мусора.
    analysis = _complaint(
        "В Северо-Казахстанской области волонтёрское движение объединяет более 10 тысяч "
        "человек, действуют свыше 50 организаций, установлены контейнеры для раздельного сбора"
    )
    assert not analysis.relevant and not analysis.needs_review


def test_ordinary_city_news_is_still_dropped() -> None:
    for text in (
        "В Петропавловске ярко прошел международный праздник Сабантуй",
        "Кызылжар обыграл Жетысу в 19-м туре КПЛ",
        "Продам квартиру в центре, 3 комнаты, недорого",
    ):
        analysis = _complaint(text)
        assert not analysis.relevant and not analysis.needs_review, text


def test_pretty_courtyard_post_is_not_a_road_complaint() -> None:
    # Голый корень «дорог» ловил «дорожки» и «дорогие»: пост про красивый двор
    # уходил на проверку. Маркер сужен до связок по смыслу.
    analysis = _complaint(
        "Есть в Петропавловске место, где будто оживает сказка. Обычный двор "
        "превратился в маленький мир красоты, повсюду цветы, яркие краски, "
        "дорожки и скульптуры сказочных героев"
    )
    assert not analysis.relevant and not analysis.needs_review


def test_road_surface_complaint_still_reaches_the_channel() -> None:
    assert _complaint("Дорожное покрытие на Жумабаева полностью разбито").relevant
