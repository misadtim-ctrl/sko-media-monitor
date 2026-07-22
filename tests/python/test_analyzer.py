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
