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
    "machine-hot": 8.0,
    "machine-synergy": 3.5,
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
    return len(cats)


def _apply_machine_signals(
    scores: Dict[int, float],
    sources: Dict[int, List[str]],
    machine_payload: Dict[str, Any],
) -> Dict[str, Any]:
    stats = machine_payload.get("stats") or {}
    hot = stats.get("hot_top5") or []
    synergy = stats.get("synergy_top3") or []
    for rank, item in enumerate(hot[:5]):
        n = item.get("number") if isinstance(item, dict) else None
        if n is not None:
            _bump(scores, sources, n, _rank_decay(rank, SOURCE_WEIGHTS["machine-hot"]), "machine-hot")
    for item in synergy:
        pair = item.get("pair") or []
        for n in pair:
            _bump(scores, sources, n, SOURCE_WEIGHTS["machine-synergy"], "machine-synergy")
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
    latest_row = df.sort_values("round").iloc[-1]
    latest_draw_date = str(latest_row["draw_date"])
    review_mode = intent == "review"

    scores: Dict[int, float] = defaultdict(float)
    sources: Dict[int, List[str]] = defaultdict(list)
    excluded: Dict[int, List[str]] = defaultdict(list)
    accumulated = build_accumulated()
    photo_src = _apply_photo_signals(scores, sources, excluded, intent, accumulated)
    if review_mode:
        machine_src = {"available": False, "reason": "review_mode"}
        post_src = {"available": False, "reason": "review_mode"}
        classic_src = {"available": False, "reason": "review_mode"}
        parallel_src = {"available": False, "reason": "review_mode"}
    else:
        machine_payload = build_round_recommendation(df, machine_id=auto_machine, seed=seed)
        post_payload = run_post_occurrence_analysis(df, trigger_round=latest_round)
        classic_payload = build_classic_recommendation(df, method="blend", seed=seed)
        machine_src = _apply_machine_signals(scores, sources, machine_payload)
        post_src = _apply_post_signals(scores, sources, post_payload)
        classic_src = _apply_classic_signals(scores, sources, classic_payload)
        parallel_src = _apply_parallel_signals(scores, sources, df, next_round)

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
        "target_round": latest_round if review_mode else next_round,
        "target_draw_date": latest_draw_date if review_mode else next_date,
        "latest_round": latest_round,
        "intent": intent,
        "machine_id": machine_src.get("machine_id") if not review_mode else None,
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
        },
        "disclaimer": (
            "강한 후보는 5개 독립 통계 신호의 가중 합산입니다. "
            "수학적 1등 확률(1/8,145,060)은 변하지 않습니다."
        ),
    }

    # 캐시 저장 (크기 제한 — 가장 오래된 항목 제거)
    _SIGNAL_CACHE[cache_key] = (now, out)
    if len(_SIGNAL_CACHE) > _SIGNAL_CACHE_MAX:
        oldest = min(_SIGNAL_CACHE, key=lambda k: _SIGNAL_CACHE[k][0])
        _SIGNAL_CACHE.pop(oldest, None)
    return out
