"""평행회차 분석 — 동일 끝2자리 회차군(29, 129, 229…) 당첨 패턴."""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from .database import NUMBER_COLUMNS, load_history
from .data_meta import effective_current_round

DECADE_RANGES: List[Tuple[str, int, int]] = [
    ("단번대", 1, 9),
    ("10번대", 10, 19),
    ("20번대", 20, 29),
    ("30번대", 30, 39),
    ("40번대", 40, 45),
]


def parallel_suffix(round_no: int) -> int:
    """평행 회차군 식별자 — 끝 2자리 (1229 → 29)."""
    return int(round_no) % 100


def find_parallel_rounds(df: pd.DataFrame, target_round: int) -> List[int]:
    """대상 회차와 같은 끝2자리를 가진 과거 추첨 회차 (미추첨 대상 제외)."""
    suffix = parallel_suffix(target_round)
    rounds = sorted(
        int(r)
        for r in df["round"].astype(int).tolist()
        if int(r) % 100 == suffix and int(r) < int(target_round)
    )
    return rounds


def _decade_label(n: int) -> str:
    for label, lo, hi in DECADE_RANGES:
        if lo <= n <= hi:
            return label
    return "기타"


def _travel_scores(draws: List[Dict[str, Any]]) -> Dict[int, float]:
    """연속 평행회차에서 동일 번호·동일 자리 재출현 가중."""
    scores: Dict[int, float] = defaultdict(float)
    for i in range(len(draws) - 1):
        a = draws[i]["numbers"]
        b = draws[i + 1]["numbers"]
        shared = set(a) & set(b)
        for n in shared:
            scores[n] += 5.0
        for pos in range(min(len(a), len(b))):
            if a[pos] == b[pos]:
                scores[a[pos]] += 3.0
    return dict(scores)


def _split_strong_expected(
    decade_nums: List[Tuple[int, float]],
    strong_n: int = 3,
    expected_n: int = 3,
) -> Tuple[List[int], List[int]]:
    ranked = sorted(decade_nums, key=lambda x: (-x[1], -x[0]))
    strong = [n for n, _ in ranked[:strong_n]]
    expected = [n for n, _ in ranked[strong_n : strong_n + expected_n] if n not in strong]
    return strong, expected


def analyze_parallel_rounds(
    df: pd.DataFrame,
    target_round: Optional[int] = None,
) -> Dict[str, Any]:
    """
    평행회차 분석.
    - 동일 끝2자리 회차 당첨번호 표
    - 구간별 평행강수 / 기대수
    - 끝수 빈도
    - 평행 고정수 추천 (parallel_strong 상위 3 — 사용자 반자동 입력 아님)
    """
    if df.empty:
        return {"error": "당첨 데이터가 없습니다."}

    latest = int(df["round"].max())
    target = int(target_round) if target_round else effective_current_round(latest)
    suffix = parallel_suffix(target)
    parallel_list = find_parallel_rounds(df, target)

    if not parallel_list:
        return {
            "target_round": target,
            "suffix": suffix,
            "suffix_label": f"끝2자리 {suffix:02d}회차군",
            "parallel_rounds": [],
            "draw_table": [],
            "error": f"{target}회와 평행인 과거 추첨 데이터가 없습니다.",
        }

    draw_table: List[Dict[str, Any]] = []
    freq: Counter = Counter()
    ending: Counter = Counter()
    bonus_freq: Counter = Counter()

    sub = df[df["round"].astype(int).isin(parallel_list)].sort_values("round")
    for _, row in sub.iterrows():
        nums = sorted(int(row[c]) for c in NUMBER_COLUMNS)
        bonus = int(row["bonus"])
        rnd = int(row["round"])
        draw_table.append(
            {
                "round": rnd,
                "numbers": nums,
                "bonus": bonus,
                "draw_date": str(row.get("draw_date", "")),
            }
        )
        for n in nums:
            freq[n] += 1
            ending[n % 10] += 1
        bonus_freq[bonus] += 1
        ending[bonus % 10] += 1

    travel = _travel_scores(draw_table)

    combined: Dict[int, float] = {}
    for n in range(1, 46):
        combined[n] = freq.get(n, 0) * 2.0 + travel.get(n, 0.0)

    by_decade: Dict[str, Dict[str, Any]] = {}
    for label, lo, hi in DECADE_RANGES:
        bucket = [(n, combined.get(n, 0.0)) for n in range(lo, hi + 1)]
        strong, expected = _split_strong_expected(bucket)
        by_decade[label] = {
            "range": [lo, hi],
            "strong": strong,
            "expected": expected,
            "freq_top": sorted(
                [(n, freq.get(n, 0)) for n in range(lo, hi + 1)],
                key=lambda x: (-x[1], -x[0]),
            )[:5],
        }

    ending_digits = [
        {"digit": d, "count": c}
        for d, c in ending.most_common(10)
        if c > 0
    ]

    ranked_all = sorted(combined.items(), key=lambda x: (-x[1], -x[0]))
    parallel_strong = [n for n, s in ranked_all if s > 0][:12]
    parallel_expected = [n for n, s in ranked_all[len(parallel_strong) : len(parallel_strong) + 10] if s > 0]

    semi_auto_fixed = parallel_strong[:3]

    travel_highlights = []
    for n, score in sorted(travel.items(), key=lambda x: (-x[1], -x[0]))[:8]:
        appearances = []
        for d in draw_table:
            if n in d["numbers"]:
                appearances.append(
                    {
                        "round": d["round"],
                        "position": d["numbers"].index(n) + 1,
                    }
                )
        travel_highlights.append(
            {"number": n, "travel_score": round(score, 1), "appearances": appearances}
        )

    # semi_auto_fixed(평행 고정수 추천)는 프론트에서 별도 표기하므로 summary 에는 미포함.
    parts = [
        f"{target}회 평행군(끝{suffix:02d}) {len(parallel_list)}회차",
        f"강수 {len(parallel_strong)}개",
    ]

    return {
        "target_round": target,
        "suffix": suffix,
        "suffix_label": f"끝2자리 {suffix:02d}회차군",
        "parallel_rounds": parallel_list,
        "parallel_count": len(parallel_list),
        "draw_table": draw_table,
        "by_decade": by_decade,
        "ending_digits": ending_digits,
        "parallel_strong": parallel_strong,
        "parallel_expected": parallel_expected,
        "semi_auto_fixed_hint": semi_auto_fixed,
        "travel_highlights": travel_highlights,
        "bonus_freq": [{"number": n, "count": c} for n, c in bonus_freq.most_common(5)],
        "summary": " · ".join(parts),
        "disclaimer": (
            "평행회차 분석은 동일 끝2자리 회차의 과거 당첨 패턴 관찰입니다. "
            "반자동 2~3개 고정 후보 참고용이며 당첨 확률을 바꾸지 않습니다."
        ),
    }
