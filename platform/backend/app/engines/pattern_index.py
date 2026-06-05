"""Pair/Triple 패턴 인덱스 — 조건부 확률·PMI·Lift·Survival."""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from typing import Dict, List, Optional, Tuple

from app.engines.common import ALL_NUMBERS, pair_key, pmi, serialize_top, triple_key
from app.engines.draw_frame import row_numbers


@dataclass
class PatternIndex:
    """메모리 내 전체 패턴 통계 (DB 적재 전 계산용)."""
    total_draws: int = 0
    number_freq: Counter = field(default_factory=Counter)
    pair_occurrence: Counter = field(default_factory=Counter)
    triple_occurrence: Counter = field(default_factory=Counter)
    pair_next: Dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    triple_next: Dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    pair_survival: Dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    triple_survival: Dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    number_survival: Dict[int, Dict[int, Counter]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(Counter))
    )

    def build(self, df) -> "PatternIndex":
        ordered = df.sort_values("round_no")
        rounds = [row_numbers(r) for _, r in ordered.iterrows()]
        self.total_draws = len(rounds)
        for nums in rounds:
            for n in nums:
                self.number_freq[n] += 1
            for p in combinations(nums, 2):
                self.pair_occurrence[pair_key(*p)] += 1
            for t in combinations(nums, 3):
                self.triple_occurrence[triple_key(*t)] += 1

        for i in range(len(rounds) - 1):
            curr, nxt = set(rounds[i]), rounds[i + 1]
            for p in combinations(rounds[i], 2):
                pk = pair_key(*p)
                for n in nxt:
                    self.pair_next[pk][n] += 1
                surv = len(set(p) & set(nxt))
                self.pair_survival[pk][surv] += 1
            for t in combinations(rounds[i], 3):
                tk = triple_key(*t)
                for n in nxt:
                    self.triple_next[tk][n] += 1
                self.triple_survival[tk][len(set(t) & set(nxt))] += 1
            for n in rounds[i]:
                for lag in (1, 2, 3, 5, 10):
                    if i + lag < len(rounds):
                        hit = 1 if n in set(rounds[i + lag]) else 0
                        self.number_survival[n][lag][hit] += 1
        return self

    def conditional_pair(self, a: int, b: int, top_k: int = 15) -> Dict:
        pk = pair_key(a, b)
        occ = self.pair_occurrence.get(pk, 0)
        next_c = self.pair_next.get(pk, Counter())
        trials = sum(next_c.values()) or 1
        top = []
        for num, cnt in next_c.most_common(top_k):
            top.append(
                {
                    "number": num,
                    "count": cnt,
                    "probability": round(cnt / trials, 4),
                    "p_conditional": round(cnt / max(occ, 1), 4),
                }
            )
        support_ab = occ / max(self.total_draws, 1)
        support_a = self.number_freq[a] / max(self.total_draws * 6, 1)
        support_b = self.number_freq[b] / max(self.total_draws * 6, 1)
        conf = top[0]["probability"] if top else 0.0
        lift = conf / support_b if support_b else 0.0
        return {
            "pair": pk,
            "occurrence_count": occ,
            "support": round(support_ab, 6),
            "confidence": round(conf, 4),
            "lift": round(lift, 4),
            "pmi": round(pmi(support_ab, support_a, support_b), 4),
            "top_next_numbers": top,
            "evidence": f"P(n|{pk}) from {occ} co-occurrence rounds, {trials} next-number events",
            "disclaimer": "과거 조건부 빈도이며 미래 당첨을 보장하지 않습니다.",
        }

    def conditional_triple(self, a: int, b: int, c: int, top_k: int = 15) -> Dict:
        tk = triple_key(a, b, c)
        occ = self.triple_occurrence.get(tk, 0)
        next_c = self.triple_next.get(tk, Counter())
        trials = sum(next_c.values()) or 1
        top = [
            {
                "number": num,
                "count": cnt,
                "probability": round(cnt / trials, 4),
            }
            for num, cnt in next_c.most_common(top_k)
        ]
        return {
            "triple": tk,
            "occurrence_count": occ,
            "top_next_numbers": top,
            "evidence": f"P(next|{tk}) from {occ} triple hits",
            "disclaimer": "과거 데이터 기반 조건부 통계입니다.",
        }

    def pair_survival_stats(self, a: int, b: int) -> Dict:
        pk = pair_key(a, b)
        dist = self.pair_survival.get(pk, Counter())
        total = sum(dist.values()) or 1
        return {
            "pair": pk,
            "distribution": {str(k): v for k, v in sorted(dist.items())},
            "survival_rate": round(dist.get(1, 0) / total + dist.get(2, 0) / total, 4),
            "reappear_both": round(dist.get(2, 0) / total, 4),
            "evidence": f"Next-draw retention after {pk} appeared",
        }

    def number_survival_stats(self, number: Optional[int] = None) -> Dict:
        out = {}
        targets = [number] if number else ALL_NUMBERS[:10]
        for n in (targets if number else ALL_NUMBERS):
            lags = {}
            for lag, cnt in self.number_survival[n].items():
                hits = cnt.get(1, 0)
                total = hits + cnt.get(0, 0)
                lags[f"lag_{lag}"] = round(hits / total, 4) if total else 0.0
            out[n] = lags
        return {"numbers": out if number else dict(list(out.items())[:45])}

    def to_pair_stats_rows(self):
        from app.models.patterns import PairPatternStat

        rows = []
        for (pk, occ) in self.pair_occurrence.items():
            a, b = map(int, pk.split("-"))
            next_c = self.pair_next[pk]
            trials = sum(next_c.values()) or 1
            support_ab = occ / max(self.total_draws, 1)
            top_prob = next_c.most_common(1)[0][1] / trials if next_c else 0
            surv = self.pair_survival.get(pk, Counter())
            stotal = sum(surv.values()) or 1
            rows.append(
                PairPatternStat(
                    num_a=a,
                    num_b=b,
                    pair_key=pk,
                    occurrence_count=occ,
                    support=support_ab,
                    confidence=top_prob,
                    lift=top_prob,
                    pmi=0.0,
                    top_next_numbers=serialize_top(next_c),
                    survival_rate=(surv.get(1, 0) + surv.get(2, 0)) / stotal,
                    hit_rate=top_prob,
                    pattern_score=min(100, occ * 2 + top_prob * 50),
                )
            )
        return rows
