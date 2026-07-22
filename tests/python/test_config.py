from sko_monitor.config import Settings, project_root


def test_project_root_uses_checkout_working_directory(tmp_path, monkeypatch) -> None:
    registry = tmp_path / "config" / "sources.json"
    registry.parent.mkdir()
    registry.write_text('{"sources": []}', encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("SOURCE_REGISTRY", raising=False)

    assert project_root() == tmp_path
    assert Settings.from_env().registry_path == registry
