from pathlib import Path

import instaloader

from sko_monitor import instagram_auth


class FakeLoader:
    def __init__(self) -> None:
        self.passwords: list[str] = []
        self.saved_to = ""

    def login(self, _username: str, password: str) -> None:
        self.passwords.append(password)
        if password == "wrong":
            raise instaloader.exceptions.BadCredentialsException("wrong password")

    def save_session_to_file(self, destination: str) -> None:
        self.saved_to = destination


def test_macos_login_retries_bad_password(tmp_path, monkeypatch) -> None:
    loader = FakeLoader()
    answers = iter(("wrong", "correct"))
    messages: list[str] = []
    monkeypatch.setattr(instaloader, "Instaloader", lambda quiet: loader)
    monkeypatch.setattr(instagram_auth, "_macos_prompt", lambda _message, hidden: next(answers))
    monkeypatch.setattr(instagram_auth, "_macos_message", messages.append)
    destination = tmp_path / "session"

    result = instagram_auth.create_session("user", destination, macos_dialog=True)

    assert result == Path(destination)
    assert loader.passwords == ["wrong", "correct"]
    assert loader.saved_to == str(destination)
    assert len(messages) == 1
