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
