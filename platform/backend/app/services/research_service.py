"""연구 플랫폼 통합 Service Layer."""
from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from app.engines.backtest_engine import walk_forward_backtest
from app.data.csv_loader import load_csv_dataframe
from app.engines.common import ALL_NUMBERS, calc_ac, pair_key, triple_key
from app.engines.draw_frame import draws_to_frame, row_numbers
from app.engines.fpgrowth_engine import mine_fpgrowth_rules
from app.engines.pair_matrix import build_pair_matrix
from app.engines.triple_matrix import build_triple_matrix
from app.engines.feature_builder import build_features_for_draws
from app.engines.pattern_index import PatternIndex
from app.engines.recommendation_engine import generate_recommendations
from app.engines.repeat_neighbor import analyze_neighbor, analyze_repeat
from app.engines.scoring_engine import score_numbers
from app.repositories.draw_repository import DrawRepository
from app.services.cache import cache_get, cache_set


class ResearchService:
    def __init__(self, db: Session):
        self.repo = DrawRepository(db)
        self._index: Optional[PatternIndex] = None
        self._df: Optional[pd.DataFrame] = None
        self._source: str = "unknown"

    def _load_df(self) -> pd.DataFrame:
        if self._df is not None:
            return self._df
        draws = self.repo.get_all_ordered()
        if draws:
            self._df = draws_to_frame(draws)
            from app.config import settings

            self._source = "sqlite" if settings.DATABASE_URL.startswith("sqlite") else "postgresql"
        else:
            csv_df = load_csv_dataframe()
            if csv_df is None or csv_df.empty:
                raise ValueError(
                    "lotto_draws 데이터가 없습니다. seed_from_csv.py 또는 CSV 경로를 확인하세요."
                )
            self._df = csv_df
            self._source = "csv_fallback"
        return self._df

    def _index_cached(self) -> PatternIndex:
        if self._index is None:
            cached = cache_get("pattern_index_meta")
            self._index = PatternIndex().build(self._load_df())
            if not cached:
                cache_set("pattern_index_meta", {"total": self._index.total_draws})
        return self._index

    def latest_kpi(self) -> Dict:
        df = self._load_df()
        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else None
        nums = row_numbers(latest)
        prev_set = set(row_numbers(prev)) if prev is not None else set()
        return {
            "latest_round": int(latest["round_no"]),
            "draw_date": str(latest["draw_date"]),
            "numbers": nums,
            "bonus": int(latest["bonus"]),
            "ac": round(calc_ac(nums), 4),
            "repeat_count": len(set(nums) & prev_set) if prev is not None else 0,
            "neighbor_count": sum(
                1 for x in nums if (x - 1) in prev_set or (x + 1) in prev_set
            )
            if prev is not None
            else 0,
            "machine_no": int(latest.get("machine_no", 1)),
            "disclaimer": "KPI는 최신 회차 요약이며 예측이 아닙니다.",
        }

    def machine_analysis(self) -> Dict:
        df = self._load_df()
        out = {}
        for m in sorted(df["machine_no"].unique()):
            sub = df[df["machine_no"] == m]
            feats = build_features_for_draws(sub)
            out[int(m)] = {
                "draw_count": len(sub),
                "avg_sum": round(float(sub.apply(lambda r: sum(row_numbers(r)), axis=1).mean()), 1),
                "avg_ac": round(float(np.mean([f.ac_value for f in feats])), 3),
                "avg_repeat": round(float(np.mean([f.repeat_count for f in feats])), 3),
                "avg_neighbor": round(float(np.mean([f.neighbor_count for f in feats])), 3),
            }
        return {"machines": out, "evidence": "호기별 과거 집계"}

    def repeat_analysis(self) -> Dict:
        return analyze_repeat(self._load_df())

    def neighbor_analysis(self) -> Dict:
        return analyze_neighbor(self._load_df())

    def ac_analysis(self) -> Dict:
        df = self._load_df()
        acs = [calc_ac(row_numbers(r)) for _, r in df.iterrows()]
        return {
            "formula": "unique_differences / (n-1)",
            "mean": round(float(np.mean(acs)), 4),
            "std": round(float(np.std(acs)), 4),
            "distribution": {
                "min": round(float(min(acs)), 4),
                "max": round(float(max(acs)), 4),
            },
        }

    def pair_detail(self, number: int) -> Dict:
        idx = self._index_cached()
        pairs = []
        for n in ALL_NUMBERS:
            if n == number:
                continue
            pk = pair_key(number, n)
            occ = idx.pair_occurrence.get(pk, 0)
            if occ:
                pairs.append(self.conditional_pair(number, n))
        pairs.sort(key=lambda x: -x["occurrence_count"])
        return {"number": number, "pairs": pairs[:20]}

    def conditional_pair(self, a: int, b: int) -> Dict:
        return self._index_cached().conditional_pair(a, b)

    def conditional_triple(self, a: int, b: int, c: int) -> Dict:
        return self._index_cached().conditional_triple(a, b, c)

    def pair_survival(self, a: int, b: int) -> Dict:
        return self._index_cached().pair_survival_stats(a, b)

    def triple_survival(self, a: int, b: int, c: int) -> Dict:
        idx = self._index_cached()
        tk = triple_key(a, b, c)
        dist = idx.triple_survival.get(tk, {})
        total = sum(dist.values()) or 1
        return {"triple": tk, "keep_distribution": {str(k): v for k, v in dist.items()}, "avg_keep": round(
            sum(k * v for k, v in dist.items()) / total, 4
        )}

    def survival_numbers(self, number: int | None = None) -> Dict:
        return self._index_cached().number_survival_stats(number)

    def association_rules(
        self,
        min_support: float = 0.02,
        min_confidence: float = 0.15,
        method: str = "fpgrowth",
    ) -> Dict:
        if method == "fpgrowth":
            return mine_fpgrowth_rules(
                self._load_df(),
                min_support=min_support,
                min_confidence=min_confidence,
            )
        idx = self._index_cached()
        rules = []
        for pk, occ in idx.pair_occurrence.most_common(30):
            if occ / max(idx.total_draws, 1) < min_support:
                continue
            cond = idx.conditional_pair(*map(int, pk.split("-")))
            if cond["top_next_numbers"]:
                top = cond["top_next_numbers"][0]
                rules.append(
                    {
                        "antecedent": pk.split("-"),
                        "consequent": [top["number"]],
                        "support": cond["support"],
                        "confidence": top["probability"],
                        "lift": cond["lift"],
                    }
                )
        return {"rules": rules, "method": "pair→next top-1 rule", "disclaimer": "과거 연관 빈도"}

    def triple_matrix(
        self,
        mode: str = "top",
        anchor: int | None = None,
        metric: str = "cooccurrence",
        limit: int = 50,
    ) -> Dict:
        out = build_triple_matrix(self._index_cached(), mode=mode, anchor=anchor, metric=metric, limit=limit)
        out["data_source"] = getattr(self, "_source", "unknown")
        return out

    def markov_transitions(self) -> Dict:
        df = self._load_df()
        feats = build_features_for_draws(df)
        states = [(f.repeat_count, f.neighbor_count, round(f.ac_value, 1)) for f in feats]
        trans = {}
        for i in range(len(states) - 1):
            a, b = states[i], states[i + 1]
            key = str(a)
            trans.setdefault(key, {})
            trans[key][str(b)] = trans[key].get(str(b), 0) + 1
        return {"transition_sample": dict(list(trans.items())[:5]), "evidence": "Feature state Markov"}

    def pattern_score(self, pair: str | None = None) -> Dict:
        idx = self._index_cached()
        if pair:
            a, b = map(int, pair.split("-"))
            pk = pair_key(a, b)
            occ = idx.pair_occurrence.get(pk, 0)
            recency = occ / max(idx.total_draws, 1)
            score = min(100, occ * 1.5 + recency * 40)
            return {"pair": pk, "pattern_score": round(score, 1), "hit_rate": round(recency, 4)}
        top = []
        for pk, occ in idx.pair_occurrence.most_common(10):
            top.append({"pair": pk, "pattern_score": min(100, occ * 2), "occurrence": occ})
        return {"top_pairs": top}

    def pattern_decay(self, window: int = 30) -> Dict:
        df = self._load_df()
        full = analyze_repeat(df)
        recent = analyze_repeat(df.tail(window))
        delta = recent["overall_rate"] - full["overall_rate"]
        status = "상승" if delta > 0.02 else "붕괴" if delta < -0.02 else "유지"
        return {
            "metric": "repeat_rate",
            "full": full["overall_rate"],
            "recent_30": recent["overall_rate"],
            "delta": round(delta, 4),
            "status": status,
        }

    def statistical_validation(self) -> Dict:
        from scipy import stats

        df = self._load_df()
        obs = np.zeros(45)
        for _, r in df.iterrows():
            for n in row_numbers(r):
                obs[n] += 1
        exp = np.full(45, obs.sum() / 45)
        chi2, p = stats.chisquare(obs[1:], exp[1:])
        return {
            "test": "chi_square_uniformity",
            "p_value": round(float(p), 6),
            "is_random_like": p > 0.05,
            "interpretation": "p>0.05 이면 번호 출현은 균등에 가깝다(우연 범위)",
            "disclaimer": "장기 독립시행에서는 패턴 유의가 나올 수 있음",
        }

    def backtest(self) -> Dict:
        return walk_forward_backtest(self._load_df())

    def monte_carlo(self, n_sim: int = 100_000) -> Dict:
        from app.config import settings
        import random

        rng = random.Random(settings.GLOBAL_SEED)
        sums = []
        for _ in range(min(n_sim, 100_000)):
            picks = rng.sample(ALL_NUMBERS, 6)
            sums.append(sum(picks))
        return {
            "simulations": min(n_sim, 100_000),
            "sum_mean": round(float(np.mean(sums)), 2),
            "sum_std": round(float(np.std(sums)), 2),
            "evidence": "무작위 6개 추출 분포(이론 기준선)",
        }

    def score_ranking(self) -> Dict:
        return {"ranking": score_numbers(self._load_df(), self._index_cached())}

    def recommend(self, n_sets: int = 5, seed: int | None = None) -> Dict:
        return generate_recommendations(self._load_df(), n_sets=n_sets, seed=seed)

    def pair_matrix(self, metric: str = "cooccurrence") -> Dict:
        allowed = ("cooccurrence", "lift", "pmi", "conditional")
        m = metric if metric in allowed else "cooccurrence"
        out = build_pair_matrix(self._index_cached(), m)
        out["data_source"] = getattr(self, "_source", "unknown")
        return out

    def data_status(self) -> Dict:
        try:
            df = self._load_df()
            return {
                "ok": True,
                "source": self._source,
                "row_count": len(df),
                "latest_round": int(df["round_no"].max()),
            }
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def rebuild_pattern_stats(self, db: Session) -> int:
        """pair_pattern_stats 테이블 재구축."""
        from app.models.patterns import PairPatternStat

        idx = PatternIndex().build(self._load_df())
        db.query(PairPatternStat).delete()
        rows = idx.to_pair_stats_rows()
        db.add_all(rows)
        db.commit()
        return len(rows)
