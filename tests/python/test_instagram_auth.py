from pathlib import Path
from types import SimpleNamespace

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


def test_macos_login_opens_checkpoint_and_retries(tmp_path, monkeypatch) -> None:
    loader = FakeLoader()
    attempts = 0

    def login(_username: str, password: str) -> None:
        nonlocal attempts
        attempts += 1
        loader.passwords.append(password)
        if attempts == 1:
            raise instaloader.exceptions.LoginException(
                "Login: Checkpoint required. Point your browser to "
                "/auth_platform/?apc=verification-token - follow the instructions, then retry."
            )

    checkpoints: list[str] = []
    loader.login = login
    monkeypatch.setattr(instaloader, "Instaloader", lambda quiet: loader)
    monkeypatch.setattr(instagram_auth, "_macos_prompt", lambda _message, hidden: "correct")
    monkeypatch.setattr(instagram_auth, "_macos_confirm_checkpoint", checkpoints.append)

    instagram_auth.create_session("user", tmp_path / "session", macos_dialog=True)

    assert attempts == 2
    assert checkpoints == [
        "https://www.instagram.com/auth_platform/?apc=verification-token"
    ]


def test_browser_session_is_saved_without_network_login(tmp_path, monkeypatch) -> None:
    loader = FakeLoader()

    def cookie_loader(domain_name: str) -> list[SimpleNamespace]:
        assert domain_name == "instagram.com"
        return [
            SimpleNamespace(name="sessionid", value="session-cookie", domain=".instagram.com"),
            SimpleNamespace(name="csrftoken", value="csrf-cookie", domain=".instagram.com"),
        ]

    monkeypatch.setattr(instaloader, "Instaloader", lambda quiet: loader)
    monkeypatch.setattr(instagram_auth, "_macos_message", lambda _message: None)
    import browser_cookie3

    monkeypatch.setattr(browser_cookie3, "chrome", cookie_loader)
    updated: list[dict[str, str]] = []
    loader.context = SimpleNamespace(update_cookies=updated.append, username=None)

    destination = tmp_path / "session"
    result = instagram_auth.create_browser_session("user", destination, "chrome")

    assert result == destination
    assert loader.context.username == "user"
    assert updated == [{"sessionid": "session-cookie", "csrftoken": "csrf-cookie"}]
    assert loader.saved_to == str(destination)
