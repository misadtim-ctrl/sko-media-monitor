from __future__ import annotations

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


def create_session(username: str, destination: Path, *, macos_dialog: bool = False) -> Path:
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
    loader.save_session_to_file(str(destination))
    return destination
