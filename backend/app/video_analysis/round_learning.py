"""다회차 용지 학습 — 보관된 과거 회차 용지 + 실제 당첨번호로 캘리브레이션.

롤오버로 보관된 각 회차의 '이번회차 용지'는 그 회차가 추첨되기 전에 등록된 것이므로
누수가 없다(예측 시점 정보만 사용). 각 회차마다:
  - 내 용지에서 번호별 자동/반자동 등장 줄 수(=양쪽 지지)를 계산
  - 그 회차 실제 당첨번호와 대조해 '지지 구간별 적중률' 을 집계
여러 회차를 합산해 "양쪽 지지가 높은 번호가 실제로 더 자주 당첨됐는가" 를 측정한다.

⚠️ 정직성: 로또는 i.i.d. 균등난수다. 기대 결과는 '구간과 무관하게 적중률 ≈ 13.3%
(6/45)' 즉 평탄한 캘리브레이션이다. 이 도구의 값어치는 신호가 있다고 우기는 게
아니라, 내 용지 구조가 실제로 예측력이 있는지 **정직하게 측정**하는 데 있다.
확률(1/8,145,060)은 어떤 학습으로도 변하지 않는다.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List

BASELINE_HIT_RATE = 6.0 / 45.0  # 임의 번호가 당첨 6개에 들 확률

# 양쪽 지지 '회차 내 순위' 구간.
# ⚠️ 절대 줄 수(예: 30줄+)로 나누면 용지가 수백 줄일 때 거의 모든 번호가 한 구간에
# 몰려 변별력이 사라진다(실측: 90개 중 78개가 '30줄+'). 회차마다 45개 번호를 지지
# 순위로 세워 상대 구간으로 나눠야 데이터 규모와 무관하게 비교가 성립한다.
RANK_BUCKETS: List[tuple[str, int, int]] = [
    ("지지 1~6위", 1, 6),
    ("지지 7~12위", 7, 12),
    ("지지 13~20위", 13, 20),
    ("지지 21~30위", 21, 30),
    ("지지 31~45위", 31, 45),
]


def _rank_key(s: Dict[str, int]) -> tuple:
    """지지 순위 정렬 키.

    1순위 양쪽 지지(min), 2순위 **총 등장(auto+semi)**, 3순위 자동, 마지막이 번호.
    ⚠️ 총 등장을 넣지 않으면 지지 0 인 번호가 대량으로 동률이 되어 **번호 값 순서**로
    구간이 갈린다(측정이 아니라 인덱스 편향이 lift 로 둔갑). 한쪽만 등록한 경우에도
    실제 등장량으로 서열이 잡히게 한다.
    """
    return (-s["support"], -(s["auto"] + s["semi"]), -s["auto"], s.get("number", 0))


def _bucket_of_rank(rank: int) -> str:
    for label, lo, hi in RANK_BUCKETS:
        if lo <= rank <= hi:
            return label
    return RANK_BUCKETS[-1][0]


def _number_support(auto_lines: List[List[int]], semi_lines: List[List[int]]) -> Dict[int, Dict[str, int]]:
    """번호별 자동/반자동 등장 줄 수(줄 단위 중복 제거)."""
    auto_c: Counter = Counter()
    semi_c: Counter = Counter()
    for ln in auto_lines:
        for n in set(int(x) for x in ln if 1 <= int(x) <= 45):
            auto_c[n] += 1
    for ln in semi_lines:
        for n in set(int(x) for x in ln if 1 <= int(x) <= 45):
            semi_c[n] += 1
    out: Dict[int, Dict[str, int]] = {}
    for n in range(1, 46):
        a = auto_c.get(n, 0)
        s = semi_c.get(n, 0)
        out[n] = {"number": n, "auto": a, "semi": s, "support": min(a, s)}
    return out


def build_round_learning() -> Dict[str, Any]:
    """보관된 모든 과거 회차로 지지-적중 캘리브레이션을 만들고 이번회차에 적용."""
    from .store import _load_historical_raw, _load_current_raw, _manual_saved_lines
    from .draw_template import get_current_round_no

    historical = _load_historical_raw()
    batches = historical.get("archived_current_rounds") or []
    if not batches:
        return {
            "ok": False,
            "reason": "보관된 과거 회차 용지가 없습니다. 이번회차 용지를 등록하면 추첨 후 자동 보관됩니다.",
            "round_count": 0,
        }

    from ..database import load_history

    df = load_history()
    win_by_round: Dict[int, List[int]] = {}
    if not df.empty:
        for _, row in df.iterrows():
            try:
                win_by_round[int(row["round"])] = [int(row[f"num{i}"]) for i in range(1, 7)]
            except Exception:  # noqa: BLE001
                continue

    rounds_out: List[Dict[str, Any]] = []
    # 구간별 누적 (played=그 구간에 든 번호 수, won=그중 실제 당첨된 수)
    bucket_stats: Dict[str, Dict[str, int]] = {
        label: {"played": 0, "won": 0} for label, _, _ in RANK_BUCKETS
    }

    for batch in batches:
        rnd = batch.get("round_no")
        if rnd is None:
            continue
        rnd = int(rnd)
        winning = win_by_round.get(rnd)
        if not winning:
            continue  # 아직 추첨 결과가 없으면 학습 제외
        entries = list(batch.get("entries") or [])
        auto_lines = _manual_saved_lines(entries, "자동")
        semi_lines = _manual_saved_lines(entries, "반자동")
        if not auto_lines and not semi_lines:
            continue
        sup = _number_support(auto_lines, semi_lines)
        win_set = set(winning)
        # 회차 내 지지 순위(1=가장 강함)로 상대 구간 부여.
        ranked = sorted(range(1, 46), key=lambda n: _rank_key(sup[n]))
        for idx, n in enumerate(ranked, start=1):
            b = _bucket_of_rank(idx)
            bucket_stats[b]["played"] += 1
            if n in win_set:
                bucket_stats[b]["won"] += 1
        top6 = ranked[:6]
        rounds_out.append(
            {
                "round_no": rnd,
                "winning_numbers": winning,
                "auto_line_count": len(auto_lines),
                "semi_line_count": len(semi_lines),
                "top6_by_support": top6,
                "top6_hits": len([n for n in top6 if n in win_set]),
                "frozen_at": batch.get("frozen_at"),
            }
        )

    if not rounds_out:
        return {
            "ok": False,
            "reason": "추첨 결과가 확정된 보관 회차가 없습니다.",
            "round_count": 0,
        }

    calibration: List[Dict[str, Any]] = []
    for label, _, _ in RANK_BUCKETS:
        st = bucket_stats[label]
        played = st["played"]
        won = st["won"]
        rate = (won / played) if played else 0.0
        calibration.append(
            {
                "bucket": label,
                "played": played,
                "won": won,
                "hit_rate": round(rate, 4),
                "baseline": round(BASELINE_HIT_RATE, 4),
                "lift": round(rate / BASELINE_HIT_RATE, 2) if played and BASELINE_HIT_RATE else 0.0,
            }
        )

    # 이번회차 적용 — 현재 샌드박스 용지의 지지 구간에 학습 lift 를 곱해 점수화.
    current = _load_current_raw()
    cur_entries = list(current.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동")
    cur_semi = _manual_saved_lines(cur_entries, "반자동")
    lift_of = {c["bucket"]: c["lift"] for c in calibration}
    current_scores: List[Dict[str, Any]] = []
    # 한쪽(자동만/반자동만)만 등록하면 support=min(auto,semi)=0 이라 전 번호가 걸러져
    # '이번회차 용지 없음' 이라는 **거짓 안내**가 떴다. 등장 자체가 있으면 포함한다.
    one_sided = bool(cur_auto) != bool(cur_semi)
    if cur_auto or cur_semi:
        cur_sup = _number_support(cur_auto, cur_semi)
        cur_ranked = sorted(range(1, 46), key=lambda n: _rank_key(cur_sup[n]))
        for idx, n in enumerate(cur_ranked, start=1):
            s = cur_sup[n]
            if s["auto"] + s["semi"] <= 0:  # 아예 등장하지 않은 번호만 제외
                continue
            b = _bucket_of_rank(idx)
            lift = lift_of.get(b, 1.0)
            current_scores.append(
                {
                    "number": n,
                    "auto": s["auto"],
                    "semi": s["semi"],
                    "support": s["support"],
                    "rank": idx,
                    "bucket": b,
                    "learned_lift": lift,
                    # 학습 점수 = 지지 순위 역가중 × 그 구간의 실측 lift.
                    "score": round((46 - idx) * lift, 2),
                }
            )
        current_scores.sort(key=lambda x: (-x["score"], x["rank"], x["number"]))
        current_scores = current_scores[:15]

    total_top6_hits = sum(r["top6_hits"] for r in rounds_out)
    expected_top6 = round(len(rounds_out) * 6 * BASELINE_HIT_RATE, 2)
    flat = all(abs(c["lift"] - 1.0) < 0.35 for c in calibration if c["played"] >= 20)

    return {
        "ok": True,
        "round_count": len(rounds_out),
        "rounds": sorted(rounds_out, key=lambda r: -r["round_no"]),
        "calibration": calibration,
        "current_round_no": int(get_current_round_no()),
        "current_scores": current_scores,
        # 이번회차가 한쪽(자동만/반자동만)만 등록된 상태인지 — 양쪽 지지 지표가
        # 0 이 되므로 UI 가 '데이터 없음' 대신 정확한 사유를 안내해야 한다.
        "current_one_sided": one_sided,
        "current_auto_lines": len(cur_auto),
        "current_semi_lines": len(cur_semi),
        "summary": {
            "total_top6_hits": total_top6_hits,
            "expected_top6_hits": expected_top6,
            "rounds": len(rounds_out),
            "calibration_flat": flat,
        },
        "honesty": (
            "보관 회차 용지는 추첨 전 등록분이라 누수가 없습니다. "
            "다만 로또는 균등 무작위이므로 구간별 적중률은 기대상 평탄(≈13.3%)합니다. "
            f"현재 {len(rounds_out)}개 회차 표본은 통계적으로 매우 작아 lift 는 우연일 수 있습니다. "
            "1등 확률(1/8,145,060)은 어떤 학습으로도 변하지 않습니다."
        ),
    }
