"""통합 예측 신호 — 추첨기·후속출현·클래식·용지(강한후보) 규칙 기반 점수."""
from __future__ import annotations

import time
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

from .classic_methods import analyze_all_classic, build_classic_recommendation
from .database import load_history
from .machine_analytics import build_round_recommendation, predict_next_round
from .post_occurrence_engine import run_post_occurrence_analysis
from .parallel_round_analysis import analyze_parallel_rounds
from .video_analysis.store import build_accumulated, store_signature

RULES_VERSION = "1.1"
STRONG_LIMIT = 18

# ── 결과 캐시 ────────────────────────────────────────────────────
# 신호 계산은 추첨이력(회차) + 용지 저장소에만 의존하고 결정적이라,
# (intent, seed, latest_round, 저장소 시그니처) 가 같으면 재사용한다.
# 회차는 주 1회, 시그니처는 저장/삭제 시에만 바뀌므로 대부분 캐시 적중 →
# 14~16초 전수 재계산이 반복/동시 호출에서 사라진다(타임아웃·에러 방지).
_SIGNAL_CACHE: Dict[Tuple[Any, ...], Tuple[float, Dict[str, Any]]] = {}
_SIGNAL_CACHE_MAX = 12
_SIGNAL_CACHE_TTL_SEC = 900  # 15분 안전망 (시그니처가 무효화 못 잡는 경우 대비)

# 출처별 가중치 (규칙 문서화 — 프론트와 동기화)
SOURCE_WEIGHTS: Dict[str, float] = {
    # machine-hot/synergy 는 역신호(z −2.7/−3.6)로 확인되어 합산에서 제외.
    # 평균회귀(미출현+저빈도) 풀로 대체 — 양전환 검증(lift +0.08).
    "machine-reversion": 7.5,
    "post-S": 12.0,
    "post-A": 8.0,
    "post-top20": 6.0,
    "classic-wilson": 5.0,
    "classic-huygens": 4.5,
    "classic-fermat": 4.0,
    "classic-blend": 7.0,
    "photo-line-overlap": 10.0,
    "photo-vote": 8.0,
    "photo-pair": 4.0,
    "photo-triple": 6.0,
    "parallel-strong": 9.0,
    "parallel-expected": 5.0,
    "parallel-fixed": 11.0,
    # 구간별 미출현(보너스포함) — 수기 '주초관심수' 방식 역산 이식.
    # 8회차 검증: 당첨 커버 3.50/6 (무작위 3.07) — 실효 신호원.
    "decade-gap": 8.5,
}


def _bump(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    n: int,
    weight: float,
    source: str,
) -> None:
    if not (1 <= int(n) <= 45):
        return
    num = int(n)
    scores[num] = scores.get(num, 0.0) + weight
    if source not in sources[num]:
        sources[num].append(source)


def _rank_decay(rank: int, base: float, decay: float = 0.85) -> float:
    return base * (decay ** rank)


def _consensus_grade(source_count: int, excluded: bool) -> str:
    if excluded:
        return "X"
    if source_count >= 4:
        return "S"
    if source_count >= 3:
        return "A"
    if source_count >= 2:
        return "B"
    if source_count >= 1:
        return "C"
    return "C"


def _category_set(source_ids: List[str]) -> int:
    cats = set()
    for sid in source_ids:
        if sid.startswith("machine"):
            cats.add("machine")
        elif sid.startswith("post"):
            cats.add("post")
        elif sid.startswith("classic"):
            cats.add("classic")
        elif sid.startswith("photo"):
            cats.add("photo")
        elif sid.startswith("parallel"):
            cats.add("parallel")
        elif sid.startswith("decade"):
            cats.add("decade")
    return len(cats)


def _apply_machine_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    machine_payload: Dict[str, Any],
) -> Dict[str, Any]:
    stats = machine_payload.get("stats") or {}
    hot = stats.get("hot_top5") or []
    reversion = stats.get("reversion_top10") or []
    # 핫추종(machine-hot)·궁합쌍(machine-synergy)은 100회차 백테스트에서 유의한
    # 역신호(z −2.7 / −3.6)라 신호 합산에서 제거하고, 평균회귀 풀(미출현+저빈도)로
    # 대체한다(개선판 lift +0.08 로 양전환 검증). 핫/궁합은 아래 payload 로 표시만.
    for rank, n in enumerate(reversion[:10]):
        _bump(scores, sources, n, _rank_decay(rank, SOURCE_WEIGHTS["machine-reversion"]), "machine-reversion")
    return {
        "available": bool(hot),
        "machine_id": machine_payload.get("machine_id"),
        "auto_machine_id": machine_payload.get("auto_machine_id"),
        "hot_top5": hot,
        "cold_top5": stats.get("cold_top5") or [],
        "next_round": machine_payload.get("next_round"),
    }


def _apply_post_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    post_payload: Dict[str, Any],
) -> Dict[str, Any]:
    grades = post_payload.get("grades") or {}
    for n in grades.get("S") or []:
        _bump(scores, sources, n, SOURCE_WEIGHTS["post-S"], "post-S")
    for n in grades.get("A") or []:
        _bump(scores, sources, n, SOURCE_WEIGHTS["post-A"], "post-A")
    top20 = post_payload.get("top20_numbers") or []
    if not grades.get("S"):
        for rank, item in enumerate(top20[:10]):
            n = item.get("number") if isinstance(item, dict) else item
            if n is not None:
                _bump(
                    scores,
                    sources,
                    n,
                    _rank_decay(rank, SOURCE_WEIGHTS["post-top20"]),
                    "post-top20",
                )
    return {
        "available": post_payload.get("analysis_status") == "ok",
        "trigger_round": (post_payload.get("meta") or {}).get("trigger_round"),
        "grades": grades,
        "top20_count": len(top20),
    }


def _apply_classic_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    classic_payload: Dict[str, Any],
) -> Dict[str, Any]:
    patterns = classic_payload.get("pattern_analysis") or {}
    wilson = patterns.get("wilson") or {}
    for rank, item in enumerate((wilson.get("top10") or [])[:8]):
        n = item.get("number")
        if n is not None:
            _bump(
                scores,
                sources,
                n,
                _rank_decay(rank, SOURCE_WEIGHTS["classic-wilson"]),
                "classic-wilson",
            )
    huygens = patterns.get("huygens") or {}
    for rank, item in enumerate((huygens.get("top10") or [])[:6]):
        n = item.get("number")
        if n is not None:
            _bump(
                scores,
                sources,
                n,
                _rank_decay(rank, SOURCE_WEIGHTS["classic-huygens"]),
                "classic-huygens",
            )
    fermat = patterns.get("fermat") or {}
    for rank, item in enumerate((fermat.get("top_pairs") or [])[:5]):
        pair = item.get("pair") or item.get("numbers") or []
        for n in pair:
            _bump(
                scores,
                sources,
                n,
                _rank_decay(rank, SOURCE_WEIGHTS["classic-fermat"]),
                "classic-fermat",
            )
    combo_nums: Counter = Counter()
    for combo in classic_payload.get("combinations") or []:
        for n in combo.get("numbers") or []:
            combo_nums[int(n)] += 1
    for n, cnt in combo_nums.most_common(12):
        _bump(scores, sources, n, SOURCE_WEIGHTS["classic-blend"] * min(cnt, 3), "classic-blend")
    return {
        "available": bool(classic_payload.get("combinations")),
        "method": classic_payload.get("method"),
        "combo_count": len(classic_payload.get("combinations") or []),
    }


def _apply_photo_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    excluded: Dict[int, List[str]],
    intent: str,
    accumulated: Dict[str, Any],
) -> Dict[str, Any]:
    slice_out = (accumulated.get("by_intent") or {}).get(intent) or {}
    fp = slice_out.get("final_predictions") or {}
    combo = slice_out.get("accumulated_combo_patterns") or {}

    for rank, n in enumerate(combo.get("strong_candidates") or []):
        _bump(
            scores,
            sources,
            n,
            _rank_decay(rank, SOURCE_WEIGHTS["photo-line-overlap"]),
            "photo-line-overlap",
        )
    for rank, n in enumerate(fp.get("strong_candidates") or []):
        _bump(scores, sources, n, _rank_decay(rank, SOURCE_WEIGHTS["photo-vote"]), "photo-vote")
    for item in (combo.get("pair_duplicates") or [])[:12]:
        w = SOURCE_WEIGHTS["photo-pair"] * min(int(item.get("repeat_count") or item.get("line_count") or 1), 5)
        for n in item.get("numbers") or []:
            _bump(scores, sources, n, w, "photo-pair")
    for item in (combo.get("triple_duplicates") or [])[:8]:
        w = SOURCE_WEIGHTS["photo-triple"] * min(int(item.get("repeat_count") or item.get("line_count") or 1), 4)
        for n in item.get("numbers") or []:
            _bump(scores, sources, n, w, "photo-triple")

    for n in fp.get("excluded_candidates") or []:
        if 1 <= int(n) <= 45:
            excluded[int(n)].append("photo-excluded")

    return {
        "available": bool(slice_out.get("total_analyses")),
        "intent": intent,
        "total_analyses": slice_out.get("total_analyses", 0),
        "ticket_round": slice_out.get("ticket_round"),
        "line_strong_count": len(combo.get("strong_candidates") or []),
        "vote_strong_count": len(fp.get("strong_candidates") or []),
    }


def _apply_parallel_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    df,
    target_round: int,
) -> Dict[str, Any]:
    payload = analyze_parallel_rounds(df, target_round=target_round)
    if not payload.get("draw_table"):
        return {"available": False, "suffix": payload.get("suffix")}

    for rank, n in enumerate(payload.get("parallel_strong") or []):
        _bump(
            scores,
            sources,
            n,
            _rank_decay(rank, SOURCE_WEIGHTS["parallel-strong"]),
            "parallel-strong",
        )
    for rank, n in enumerate(payload.get("parallel_expected") or []):
        _bump(
            scores,
            sources,
            n,
            _rank_decay(rank, SOURCE_WEIGHTS["parallel-expected"]),
            "parallel-expected",
        )
    for rank, n in enumerate(payload.get("semi_auto_fixed_hint") or []):
        _bump(
            scores,
            sources,
            n,
            _rank_decay(rank, SOURCE_WEIGHTS["parallel-fixed"]),
            "parallel-fixed",
        )

    return {
        "available": True,
        "suffix": payload.get("suffix"),
        "suffix_label": payload.get("suffix_label"),
        "parallel_count": payload.get("parallel_count", 0),
        "parallel_rounds": (payload.get("parallel_rounds") or [])[-5:],
        "parallel_strong": (payload.get("parallel_strong") or [])[:6],
        "semi_auto_fixed_hint": payload.get("semi_auto_fixed_hint") or [],
        "ending_digits": (payload.get("ending_digits") or [])[:5],
        "summary": payload.get("summary"),
    }


# ── 구간별 미출현(보너스포함) 신호 — 수기 '주초관심수' 역산 이식 ──────
# 수기 분석가의 '주초관심수' 표를 9회차 역산한 결과: 각 10단위 구간(1~10,
# 11~20, 21~30, 31~40, 41~45)에서 '보너스 포함 미출현 간격'이 큰 번호를
# 상위로 뽑고 구간을 고루 대표시키는 방식. 8회차 검증에서 당첨 6개 중 평균
# 3.50개 커버(무작위 3.07). 여기서는 구간별 상위 K를 순위감쇠 가점한다.
_DECADE_BANDS: Tuple[Tuple[int, int, int], ...] = (
    (1, 10, 5),    # (구간 시작, 끝, 뽑을 개수)
    (11, 20, 5),
    (21, 30, 5),
    (31, 40, 5),
    (41, 45, 3),
)


def _apply_decade_gap_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    df,
) -> Dict[str, Any]:
    from .gap_utils import last_seen_gaps

    gaps = last_seen_gaps(df, include_bonus=True)
    base = SOURCE_WEIGHTS["decade-gap"]
    table: Dict[str, List[Dict[str, int]]] = {}
    for lo, hi, k in _DECADE_BANDS:
        band = sorted(range(lo, hi + 1), key=lambda n: (-gaps[n], n))[:k]
        table[f"{lo}-{hi}"] = [{"number": n, "gap": gaps[n]} for n in band]
        for rank, n in enumerate(band):
            _bump(scores, sources, n, _rank_decay(rank, base), "decade-gap")

    pool = [item["number"] for band in table.values() for item in band]
    return {
        "available": True,
        "include_bonus": True,
        "pool": pool,
        "pool_size": len(pool),
        "table": table,
        "summary": (
            "구간별 미출현(보너스포함) 상위 — 각 10단위 구간에서 오래 안 나온 "
            "번호를 고루 뽑는 수기 '주초관심수' 방식(역산 이식)."
        ),
    }


# ── 신호원별 적중률 백테스트 (복기 탭) ────────────────────────────
# 각 통계 신호원이 과거 회차들을 얼마나 잘 맞췄는지 walk-forward 로 측정.
# 회차 R 평가에는 R 직전까지의 데이터만 사용(미래 누수 방지). 후속출현(post)은
# 회차마다 자체 λ 최적화(≈20s)가 들어가 N회차 반복이 비현실적이라 제외한다.
_ACCURACY_CACHE: Dict[Tuple[Any, ...], Tuple[float, Dict[str, Any]]] = {}
_ACCURACY_CACHE_TTL_SEC = 24 * 3600  # 회차는 주 1회 변경 → 길게 캐시
_BACKTEST_SOURCES = ("machine", "classic", "parallel", "decade")
_BACKTEST_TOP_K = 10
_NUM_COLS = ("num1", "num2", "num3", "num4", "num5", "num6")


def _round_winning_map(df) -> Dict[int, set]:
    cols = [c for c in _NUM_COLS if c in df.columns]
    out: Dict[int, set] = {}
    for _, row in df.iterrows():
        out[int(row["round"])] = {int(row[c]) for c in cols}
    return out


def _source_top_numbers(df_prior, source: str, target_round: int, top_k: int) -> List[int]:
    scores: Dict[int, float] = defaultdict(float)
    srcs: Dict[int, List[str]] = defaultdict(list)
    try:
        if source == "machine":
            _, _, auto_machine = predict_next_round(df_prior)
            _apply_machine_signals(scores, srcs, build_round_recommendation(df_prior, machine_id=auto_machine, with_backtest=False))
        elif source == "classic":
            _apply_classic_signals(scores, srcs, build_classic_recommendation(df_prior, method="blend"))
        elif source == "parallel":
            _apply_parallel_signals(scores, srcs, df_prior, target_round)
        elif source == "decade":
            _apply_decade_gap_signals(scores, srcs, df_prior)
    except Exception:  # noqa: BLE001
        return []
    ranked = sorted((n for n in scores if scores[n] > 0), key=lambda n: -scores[n])
    return ranked[:top_k]


def backtest_signal_accuracy(df, latest_round: int, *, rounds: int = 12, top_k: int = _BACKTEST_TOP_K) -> Dict[str, Any]:
    cache_key = (latest_round, rounds, top_k)
    now = time.monotonic()
    cached = _ACCURACY_CACHE.get(cache_key)
    if cached is not None and now - cached[0] < _ACCURACY_CACHE_TTL_SEC:
        return cached[1]

    win = _round_winning_map(df)
    all_rounds = sorted(win.keys())
    if not all_rounds:
        return {"available": False, "by_source": {}, "rounds": 0}
    # 충분한 prior 데이터(≥50회차)가 있는 최근 rounds 회차만 평가
    floor_round = all_rounds[0] + 50
    test_rounds = [r for r in all_rounds if r >= floor_round][-rounds:]
    random_baseline = round(top_k * 6 / 45, 3)  # top_k개 중 기대 적중 수

    per_source: Dict[str, Any] = {}
    for src in _BACKTEST_SOURCES:
        total_hits = 0
        n = 0
        rounds_3plus = 0
        per_round: List[Dict[str, Any]] = []
        for r in test_rounds:
            prior = df[df["round"] < r]
            if len(prior) < 50:
                continue
            top = _source_top_numbers(prior, src, r, top_k)
            if not top:
                continue
            actual = win.get(r, set())
            hits = len(set(top) & actual)
            total_hits += hits
            n += 1
            if hits >= 3:
                rounds_3plus += 1
            per_round.append({"round": r, "hits": hits, "predicted": top})
        avg_hits = round(total_hits / n, 3) if n else 0.0
        per_source[src] = {
            "available": n > 0,
            "rounds_tested": n,
            "avg_hits": avg_hits,
            "lift_vs_random": round(avg_hits - random_baseline, 3),
            "rounds_3plus": rounds_3plus,
            "per_round": per_round,
        }

    avail = {k: v for k, v in per_source.items() if v["available"]}
    weakest = min(avail, key=lambda k: avail[k]["avg_hits"]) if avail else None
    strongest = max(avail, key=lambda k: avail[k]["avg_hits"]) if avail else None
    result = {
        "available": bool(avail),
        "rounds": len(test_rounds),
        "top_k": top_k,
        "random_baseline": random_baseline,
        "by_source": per_source,
        "weakest_source": weakest,
        "strongest_source": strongest,
        "excluded_sources": ["post_occurrence"],
        "note": (
            "각 신호원이 과거 회차를 맞춘 정도(walk-forward). avg_hits 가 "
            f"무작위 기대치({random_baseline})보다 낮으면 약한 신호 → 이번회차 "
            "가중치를 낮추는 보정 참고. 후속출현은 회차마다 자체 최적화 비용이 "
            "커 백테스트에서 제외."
        ),
    }
    _ACCURACY_CACHE[cache_key] = (now, result)
    if len(_ACCURACY_CACHE) > 8:
        oldest = min(_ACCURACY_CACHE, key=lambda k: _ACCURACY_CACHE[k][0])
        _ACCURACY_CACHE.pop(oldest, None)
    return result


def build_prediction_signals(
    *,
    intent: str = "current_round",
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """
    5개 신호 통합:
    - 추첨기 추천 (machine)
    - 후속출현 통계 (post)
    - 클래식 추천 (classic blend + wilson/huygens/fermat)
    - 용지 분석 intent 슬라이스 (photo line_overlap + votes)
    - 평행회차 분석 (동일 끝2자리 회차군)
    """
    if intent not in ("review", "current_round"):
        intent = "current_round"

    df = load_history()
    if df.empty:
        return {"error": "당첨 데이터가 없습니다."}

    latest_round = int(df["round"].max())

    # 캐시 조회 — 같은 입력이면 즉시 반환 (반복·동시 호출 시 재계산 회피)
    cache_key = (intent, seed, latest_round, store_signature())
    now = time.monotonic()
    cached = _SIGNAL_CACHE.get(cache_key)
    if cached is not None and now - cached[0] < _SIGNAL_CACHE_TTL_SEC:
        return cached[1]

    next_round, next_date, auto_machine = predict_next_round(df)

    scores: Dict[int, float] = defaultdict(float)
    sources: Dict[int, List[str]] = defaultdict(list)
    excluded: Dict[int, List[str]] = defaultdict(list)
    accumulated = build_accumulated()
    photo_src = _apply_photo_signals(scores, sources, excluded, intent, accumulated)
    # 통계 4신호(추첨기·후속·클래식·평행)는 복기/이번회차 모두 최신 전체
    # 데이터로 계산한다. 복기 탭은 이 통계예측 + 신호원별 적중률(백테스트)을
    # 함께 보고 약한 신호를 이번회차 보정에 활용한다.
    machine_payload = build_round_recommendation(df, machine_id=auto_machine, seed=seed, with_backtest=False)
    post_payload = run_post_occurrence_analysis(df, trigger_round=latest_round)
    classic_payload = build_classic_recommendation(df, method="blend", seed=seed)
    machine_src = _apply_machine_signals(scores, sources, machine_payload)
    post_src = _apply_post_signals(scores, sources, post_payload)
    classic_src = _apply_classic_signals(scores, sources, classic_payload)
    parallel_src = _apply_parallel_signals(scores, sources, df, next_round)
    decade_src = _apply_decade_gap_signals(scores, sources, df)

    ranked: List[Dict[str, Any]] = []
    for n in range(1, 46):
        src_list = sources.get(n, [])
        exc = excluded.get(n, [])
        cat_count = _category_set(src_list)
        grade = _consensus_grade(cat_count, bool(exc))
        ranked.append(
            {
                "number": n,
                "score": round(scores.get(n, 0.0), 2),
                "source_count": cat_count,
                "signal_count": len(src_list),
                "sources": src_list,
                "excluded_by": exc,
                "grade": grade,
            }
        )

    ranked.sort(key=lambda x: (-x["score"], -x["source_count"], -x["number"]))
    strong_candidates = [
        x["number"]
        for x in ranked
        if not x["excluded_by"] and x["score"] > 0
    ][:STRONG_LIMIT]
    excluded_candidates = [n for n, exc in excluded.items() if exc][:12]
    strong_details = [item for item in ranked if item["number"] in strong_candidates][:STRONG_LIMIT]
    excluded_details = [item for item in ranked if item["number"] in excluded_candidates][:12]

    by_grade: Dict[str, List[int]] = {"S": [], "A": [], "B": [], "C": [], "X": []}
    for item in ranked:
        by_grade[item["grade"]].append(item["number"])

    out = {
        "rules_version": RULES_VERSION,
        "target_round": next_round,
        "target_draw_date": next_date,
        "latest_round": latest_round,
        "intent": intent,
        "machine_id": machine_src.get("machine_id"),
        "source_weights": SOURCE_WEIGHTS,
        "strong_candidates": strong_candidates,
        "excluded_candidates": excluded_candidates,
        "strong_details": strong_details,
        "excluded_details": excluded_details,
        "ranked_numbers": ranked[:25],
        "by_grade": by_grade,
        "sources": {
            "machine": machine_src,
            "post_occurrence": post_src,
            "classic": classic_src,
            "photo_sheet": photo_src,
            "parallel_round": parallel_src,
            "decade_gap": decade_src,
        },
        "disclaimer": (
            "강한 후보는 5개 독립 통계 신호의 가중 합산입니다. "
            "수학적 1등 확률(1/8,145,060)은 변하지 않습니다."
        ),
    }

    # 복기 탭: 신호원별 적중률 백테스트 동봉 (자체 캐시 → 사진 저장과 무관)
    if intent == "review":
        out["signal_accuracy"] = backtest_signal_accuracy(df, latest_round)

    # 캐시 저장 (크기 제한 — 가장 오래된 항목 제거)
    _SIGNAL_CACHE[cache_key] = (now, out)
    if len(_SIGNAL_CACHE) > _SIGNAL_CACHE_MAX:
        oldest = min(_SIGNAL_CACHE, key=lambda k: _SIGNAL_CACHE[k][0])
        _SIGNAL_CACHE.pop(oldest, None)
    return out
