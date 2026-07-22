from __future__ import annotations

import asyncio
import mimetypes
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from ..config import Settings
from ..models import Publication


class MediaAnalyzer:
    """Optional local OCR/transcription; every downloaded file is temporary."""

    def __init__(self, client: httpx.AsyncClient, settings: Settings) -> None:
        self.client = client
        self.settings = settings

    async def enrich(self, publication: Publication) -> Publication:
        if not self.settings.enable_media_analysis:
            return publication
        ocr_parts: list[str] = []
        transcript = ""
        with tempfile.TemporaryDirectory(prefix="sko-media-") as temp_name:
            temp = Path(temp_name)
            for index, url in enumerate(publication.media_urls[:2]):
                downloaded = await self._download(url, temp / f"media-{index}")
                if not downloaded:
                    continue
                kind = self._kind(downloaded)
                if kind == "image":
                    text = await asyncio.to_thread(self._ocr, downloaded)
                    if text:
                        ocr_parts.append(text)
                elif kind == "video" and self.settings.enable_video_analysis:
                    frames = await asyncio.to_thread(self._frames, downloaded, temp / f"frames-{index}")
                    for frame in frames[:8]:
                        text = await asyncio.to_thread(self._ocr, frame)
                        if text:
                            ocr_parts.append(text)
                    transcript = transcript or await asyncio.to_thread(self._transcribe, downloaded)

            if self.settings.enable_video_analysis and publication.platform in {"youtube", "instagram"}:
                remote_video = await asyncio.to_thread(self._download_with_ytdlp, publication.url, temp)
                if remote_video:
                    frames = await asyncio.to_thread(self._frames, remote_video, temp / "remote-frames")
                    for frame in frames[:8]:
                        text = await asyncio.to_thread(self._ocr, frame)
                        if text:
                            ocr_parts.append(text)
                    transcript = transcript or await asyncio.to_thread(self._transcribe, remote_video)

        if ocr_parts:
            publication.metadata["ocr_text"] = " ".join(dict.fromkeys(ocr_parts))[:12000]
        if transcript:
            publication.metadata["transcript"] = transcript[:20000]
        return publication

    async def _download(self, url: str, destination: Path) -> Path | None:
        try:
            async with self.client.stream("GET", url, follow_redirects=True) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").split(";", 1)[0]
                suffix = (
                    mimetypes.guess_extension(content_type) or Path(url.split("?", 1)[0]).suffix or ".bin"
                )
                path = destination.with_suffix(suffix)
                size = 0
                with path.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > 30 * 1024 * 1024:
                            return None
                        handle.write(chunk)
                return path
        except (httpx.HTTPError, OSError):
            return None

    @staticmethod
    def _kind(path: Path) -> str:
        mime, _ = mimetypes.guess_type(path)
        if mime and mime.startswith("image/"):
            return "image"
        if mime and mime.startswith("video/"):
            return "video"
        return "unknown"

    @staticmethod
    def _ocr(path: Path) -> str:
        try:
            import pytesseract
            from PIL import Image, ImageEnhance, ImageOps
        except ImportError:
            return ""
        try:
            with Image.open(path) as image:
                image = ImageOps.grayscale(image)
                image = ImageEnhance.Contrast(image).enhance(1.7)
                try:
                    return " ".join(pytesseract.image_to_string(image, lang="rus+kaz+eng").split())
                except pytesseract.TesseractError:
                    return " ".join(pytesseract.image_to_string(image, lang="eng").split())
        except Exception:
            return ""

    @staticmethod
    def _frames(video: Path, output_dir: Path) -> list[Path]:
        if not shutil.which("ffmpeg"):
            return []
        output_dir.mkdir(parents=True, exist_ok=True)
        pattern = output_dir / "frame-%03d.jpg"
        command = [
            "ffmpeg",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-vf",
            "fps=1/12,scale='min(1280,iw)':-2",
            "-frames:v",
            "12",
            str(pattern),
        ]
        try:
            subprocess.run(command, check=True, timeout=180)
        except (subprocess.SubprocessError, OSError):
            return []
        return sorted(output_dir.glob("frame-*.jpg"))

    @staticmethod
    def _transcribe(video: Path) -> str:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            return ""
        try:
            model = WhisperModel("small", device="cpu", compute_type="int8")
            segments, _ = model.transcribe(str(video), language=None, vad_filter=True)
            return " ".join(segment.text.strip() for segment in segments).strip()
        except Exception:
            return ""

    @staticmethod
    def _download_with_ytdlp(url: str, temp: Path) -> Path | None:
        executable = shutil.which("yt-dlp")
        if not executable:
            return None
        template = str(temp / "remote.%(ext)s")
        command = [
            executable,
            "--no-playlist",
            "--max-filesize",
            "30M",
            "--format",
            "worstvideo[height<=720]+worstaudio/worst[height<=720]",
            "--output",
            template,
            url,
        ]
        try:
            subprocess.run(
                command,
                check=True,
                timeout=240,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except (subprocess.SubprocessError, OSError):
            return None
        return next((path for path in temp.glob("remote.*") if path.is_file()), None)
