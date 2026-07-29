"""Разбор картинок и видео средствами самой macOS.

Городские паблики всё чаще публикуют жалобу одним видео без подписи: текст
жалобы виден только на кадрах. Обычный путь для этого требует Homebrew с
ffmpeg и tesseract, то есть пароля администратора. На Mac те же две задачи
умеет сама система — Vision распознаёт текст (включая русский), а
AVFoundation достаёт кадры, — и обе доступны из Python через pyobjc без прав
администратора и без сторонних бинарников.

Модуль намеренно молчалив: если что-то недоступно, возвращается пустой
результат, а вызывающий код откатывается на tesseract и ffmpeg.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

LOGGER = logging.getLogger("sko_monitor.analyzers.macos_media")

# Языки распознавания. Казахского в Vision нет, но городские паблики СКО пишут
# по-русски, а латиница подхватывается английской моделью.
RECOGNITION_LANGUAGES = ["ru-RU", "en-US"]


def available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Quartz  # noqa: F401
        import Vision  # noqa: F401
    except ImportError:
        return False
    return True


def recognise_text(path: Path) -> str:
    """Возвращает текст с картинки. Пустая строка означает «не смогли»."""
    if not available():
        return ""
    try:
        import Quartz
        import Vision
        from Foundation import NSURL
    except ImportError:
        return ""
    try:
        url = NSURL.fileURLWithPath_(str(path))
        source = Quartz.CGImageSourceCreateWithURL(url, None)
        if source is None or Quartz.CGImageSourceGetCount(source) == 0:
            return ""
        image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
        if image is None:
            return ""
        request = Vision.VNRecognizeTextRequest.alloc().init()
        # Точный режим: на кадрах жалоб текст часто мелкий и на пёстром фоне,
        # быстрый режим такое теряет.
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(RECOGNITION_LANGUAGES)
        request.setUsesLanguageCorrection_(True)
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
        ok, error = handler.performRequests_error_([request], None)
        if not ok:
            LOGGER.debug("Vision не справился с %s: %s", path.name, error)
            return ""
        lines: list[str] = []
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if candidates:
                lines.append(str(candidates[0].string()))
        return " ".join(" ".join(lines).split())
    except Exception as exc:  # pragma: no cover - зависит от версии macOS
        LOGGER.debug("Vision недоступен для %s: %s", path.name, exc)
        return ""


def video_frames(video: Path, output_dir: Path, count: int = 6) -> list[Path]:
    """Достаёт равномерные кадры из видео. Пустой список — откат на ffmpeg."""
    if not available():
        return []
    try:
        import AVFoundation
        import Quartz
        from Foundation import NSURL
    except ImportError:
        return []
    try:
        asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(
            NSURL.fileURLWithPath_(str(video)), None
        )
        duration = AVFoundation.CMTimeGetSeconds(asset.duration())
        if not duration or duration <= 0:
            return []
        generator = AVFoundation.AVAssetImageGenerator.assetImageGeneratorWithAsset_(asset)
        generator.setAppliesPreferredTrackTransform_(True)
        # Небольшой допуск по времени: точный кадр не нужен, а поиск ключевого
        # кадра рядом заметно быстрее.
        generator.setRequestedTimeToleranceBefore_(AVFoundation.CMTimeMake(1, 2))
        generator.setRequestedTimeToleranceAfter_(AVFoundation.CMTimeMake(1, 2))
        output_dir.mkdir(parents=True, exist_ok=True)
        frames: list[Path] = []
        for index in range(count):
            # Края пропускаем: там заставка и финальная плашка паблика.
            position = duration * (index + 1) / (count + 1)
            time = AVFoundation.CMTimeMakeWithSeconds(position, 600)
            # Число возвращаемых значений зависит от версии pyobjc: на одних
            # это (кадр, фактическое время), на других добавляется ошибка.
            # Поэтому берём первый элемент, а не распаковываем жёстко.
            result = generator.copyCGImageAtTime_actualTime_error_(time, None, None)
            image = result[0] if isinstance(result, tuple) else result
            if image is None:
                LOGGER.debug("Кадр %d не извлёкся: %s", index, result)
                continue
            target = output_dir / f"frame-{index:02d}.png"
            url = NSURL.fileURLWithPath_(str(target))
            destination = Quartz.CGImageDestinationCreateWithURL(url, "public.png", 1, None)
            if destination is None:
                continue
            Quartz.CGImageDestinationAddImage(destination, image, None)
            if Quartz.CGImageDestinationFinalize(destination):
                frames.append(target)
        return frames
    except Exception as exc:  # pragma: no cover - зависит от версии macOS
        LOGGER.debug("AVFoundation не смог разобрать %s: %s", video.name, exc)
        return []
