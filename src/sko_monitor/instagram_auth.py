from __future__ import annotations

import re
import subprocess
from pathlib import Path


def _macos_prompt(message: str, *, hidden: bool) -> str:
    hidden_clause = " with hidden answer" if hidden else ""
    script = (
        f'text returned of (display dialog "{message}" default answer ""'
        f'{hidden_clause} buttons {{"Отмена", "Продолжить"}} '
        'default button "Продолжить" cancel button "Отмена")'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.rstrip("\n")


def _macos_message(message: str) -> None:
    subprocess.run(
        ["osascript", "-e", f'display alert "{message}" as warning'],
        check=False,
        capture_output=True,
        text=True,
    )


def _checkpoint_url(error: Exception) -> str:
    match = re.search(r"Point your browser to (/auth_platform/\?\S+) - follow", str(error))
    if not match:
        return ""
    return f"https://www.instagram.com{match.group(1)}"


def _macos_confirm_checkpoint(url: str) -> None:
    subprocess.run(["open", url], check=True, capture_output=True, text=True)
    subprocess.run(
        [
            "osascript",
            "-e",
            'display dialog "Instagram открыл страницу защиты. Разрешите вход в браузере, '
            'затем вернитесь сюда." buttons {"Отмена", "Я подтвердил вход"} '
            'default button "Я подтвердил вход" cancel button "Отмена"',
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def create_browser_session(username: str, destination: Path, browser: str) -> Path:
    try:
        import browser_cookie3
        import instaloader
    except ImportError as exc:
        raise RuntimeError("Install the optional Instagram browser dependencies first") from exc
    browser_loader = getattr(browser_cookie3, browser, None)
    if not browser_loader:
        raise RuntimeError(f"Unsupported browser: {browser}")
    cookies = {
        cookie.name: cookie.value
        for cookie in browser_loader(domain_name="instagram.com")
        if "instagram.com" in cookie.domain
    }
    if not cookies.get("sessionid"):
        raise RuntimeError(f"Instagram login cookie was not found in {browser}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    loader = instaloader.Instaloader(quiet=False)
    loader.context.update_cookies(cookies)
    loader.context.username = username
    loader.save_session_to_file(str(destination))
    return destination


def create_session(
    username: str,
    destination: Path,
    *,
    macos_dialog: bool = False,
    browser: str = "",
) -> Path:
    if browser:
        try:
            return create_browser_session(username, destination, browser)
        except Exception:
            if not macos_dialog:
                raise
            _macos_message(
                f"Не удалось взять готовый вход из {browser}. Перехожу к обычному входу."
            )
    try:
        import instaloader
    except ImportError as exc:
        raise RuntimeError("Install the optional 'instagram' dependencies first") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    loader = instaloader.Instaloader(quiet=False)
    if not macos_dialog:
        loader.interactive_login(username)
    else:
        while True:
            password = _macos_prompt(
                f"Введите пароль Instagram для @{username}. Поле будет ждать без ограничения времени.",
                hidden=True,
            )
            try:
                loader.login(username, password)
                break
            except instaloader.exceptions.BadCredentialsException:
                _macos_message("Instagram отклонил пароль. Проверьте раскладку и попробуйте ещё раз.")
            except instaloader.exceptions.TwoFactorAuthRequiredException:
                while True:
                    code = _macos_prompt("Введите код подтверждения Instagram", hidden=False)
                    try:
                        loader.two_factor_login(code.strip())
                        break
                    except instaloader.exceptions.BadCredentialsException:
                        _macos_message("Код не подошёл. Введите новый код подтверждения.")
                break
            except instaloader.exceptions.LoginException as exc:
                checkpoint_url = _checkpoint_url(exc)
                if not checkpoint_url:
                    raise
                _macos_confirm_checkpoint(checkpoint_url)
    loader.save_session_to_file(str(destination))
    return destination
