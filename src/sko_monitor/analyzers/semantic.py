from __future__ import annotations

from functools import lru_cache

PROTOTYPES = {
    "sko_mentions": [
        "Новость о Северо-Казахстанской области и событиях в СКО",
        "Материал о Петропавловске, районах и селах Северного Казахстана",
        "Событие с участием акима или жителей Северо-Казахстанской области",
        "Солтүстік Қазақстан облысы мен Петропавл қаласы туралы жаңалық",
    ],
    "akimat_negative": [
        "Жители жалуются на разбитые дороги и просят акимат принять меры",
        "Проблемы с водой, отоплением, электричеством или канализацией",
        "Жалоба на мусор, свалку, бродячих собак или плохое благоустройство",
        "Сообщение о пожаре, аварии, подтоплении или другом происшествии",
        "Тұрғындар жол, су, жарық, қоқыс мәселесіне шағымданды",
    ],
}


class SemanticScorer:
    def __init__(self, model_name: str, enabled: bool) -> None:
        self.model_name = model_name
        self.enabled = enabled
        self._model = None
        self._vectors = None

    def score(self, workflow: str, text: str) -> float:
        if not self.enabled or not text.strip() or workflow not in PROTOTYPES:
            return 0.0
        try:
            self._ensure_loaded()
        except Exception:
            # Monitoring must continue with the high-recall rule layer if the
            # model cache or model host is temporarily unavailable.
            self.enabled = False
            return 0.0
        vectors = self._vectors[workflow]
        query = self._model.encode([text[:8000]], normalize_embeddings=True)
        similarities = query @ vectors.T
        return float(similarities.max())

    def similarity(self, query: str, text: str) -> float:
        if not self.enabled or not query.strip() or not text.strip():
            return 0.0
        try:
            self._ensure_loaded()
        except Exception:
            self.enabled = False
            return 0.0
        vectors = self._model.encode([query[:2000], text[:12000]], normalize_embeddings=True)
        return float(vectors[0] @ vectors[1].T)

    def similarities(self, query: str, texts: list[str]) -> list[float]:
        if not self.enabled or not query.strip() or not texts:
            return [0.0] * len(texts)
        try:
            self._ensure_loaded()
        except Exception:
            self.enabled = False
            return [0.0] * len(texts)
        query_vector = self._model.encode([query[:2000]], normalize_embeddings=True)[0]
        document_vectors = self._model.encode(
            [text[:12000] for text in texts],
            normalize_embeddings=True,
            batch_size=32,
            show_progress_bar=False,
        )
        return [float(vector @ query_vector.T) for vector in document_vectors]

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise RuntimeError("ENABLE_SEMANTIC is on, but sentence-transformers is not installed") from exc
        self._model = SentenceTransformer(self.model_name)
        self._vectors = {
            workflow: self._model.encode(texts, normalize_embeddings=True)
            for workflow, texts in PROTOTYPES.items()
        }


@lru_cache(maxsize=512)
def compact_summary(text: str, limit: int = 320) -> str:
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    cut = clean[:limit].rsplit(" ", 1)[0]
    return cut + "…"
