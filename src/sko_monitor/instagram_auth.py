from __future__ import annotations

from pathlib import Path


def create_session(username: str, destination: Path) -> Path:
    try:
        import instaloader
    except ImportError as exc:
        raise RuntimeError("Install the optional 'instagram' dependencies first") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    loader = instaloader.Instaloader(quiet=False)
    loader.interactive_login(username)
    loader.save_session_to_file(str(destination))
    return destination
