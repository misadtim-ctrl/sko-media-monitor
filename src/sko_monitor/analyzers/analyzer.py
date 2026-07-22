from __future__ import annotations

from ..models import Analysis, Publication
from .rules import score_negative, score_sko
from .semantic import SemanticScorer, compact_summary


class PublicationAnalyzer:
    def __init__(self, semantic: SemanticScorer) -> None:
        self.semantic = semantic

    def analyze(self, publication: Publication) -> Analysis:
        text = publication.searchable_text()
        if publication.workflow == "akimat_negative":
            rules = score_negative(text)
            semantic = self.semantic.score(publication.workflow, text)
            score = max(rules.score, semantic)
            # Meaning similarity may help an analyst inspect a candidate, but
            # it must never turn ordinary local content into a channel alert.
            relevant = rules.score >= 0.58
            needs_review = not relevant and semantic >= 0.72
            category = rules.category if rules.score else "возможная жалоба"
            tone = "негативная" if relevant or needs_review else "нейтральная"
        elif publication.workflow == "sko_mentions":
            # Semantic similarity identifies subject matter, not geography. A
            # publication may be about the same kind of event in Pavlodar or
            # Almaty, so only explicit SKO evidence can authorize delivery.
            rules = score_sko(publication.geographic_text())
            semantic = self.semantic.score(publication.workflow, text)
            relevant = rules.score >= 0.72
            needs_review = not relevant and semantic >= 0.72
            score = rules.score if relevant else min(semantic, 0.49)
            category = "упоминание СКО"
            negative = score_negative(text)
            tone = "негативная" if negative.score >= 0.58 else "нейтральная"
        else:
            rules = score_sko(text)
            score = rules.score
            relevant = True
            needs_review = False
            category = "региональная новость"
            tone = "негативная" if score_negative(text).score >= 0.58 else "нейтральная"

        return Analysis(
            relevant=relevant,
            confidence=round(min(1.0, max(0.0, score)), 3),
            category=category,
            tone=tone,
            summary=compact_summary(publication.text or publication.title),
            matched=rules.matched,
            places=rules.places,
            needs_review=needs_review,
        )
