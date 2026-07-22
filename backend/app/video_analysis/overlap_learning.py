"""줄겹침(2·3·4번호) 패턴 역산 학습 — 보관 회차 용지 + 실제 당첨 대조.

'다른 줄에도 겹침' 조합이 **어떤 구조일 때 실제 당첨번호를 담았는지**를 회차별로
역산해 누적 학습한다. 보관 배치는 추첨 전 등록분이라 예측 누수가 없다.

측정 방식(정직한 지표):
  - 각 겹침 조합(size k)에 대해 당첨번호와의 겹침 수 overlap = |combo ∩ 당첨6|
  - 무작위 기대값 = k × 6/45  (조합이 어떻든 균등 무작위면 이 값)
  - lift 구간(우연 대비 초과 정도)별로 평균 overlap 을 모아 기대값과 비교
  → "lift 가 높은 겹침 조합이 실제로 당첨을 더 많이 담았는가?" 에 답한다.

⚠️ 로또는 i.i.d. 균등난수 → 기대 결과는 **모든 구간에서 lift_vs_chance ≈ 1.0**(평탄).
표본(회차 수)이 적으면 편차는 우연이다. 확률(1/8,145,060)은 변하지 않는다.
회차가 쌓일수록 자동으로 표본이 늘어난다(호출 시마다 전체 보관 배치를 재집계).
"""
from __future__ import annotations

from typing import Any, Dict, List

BASE_RATE = 6.0 / 45.0  # 임의 번호가 당첨 6개에 속할 확률

# lift(우연 대비 동시출현 초과) 구간 — 겹침 조합의 '의도적 묶임' 강도.
LIFT_BUCKETS: List[tuple[str, float, float]] = [
    ("lift <1.0 (우연 이하)", -1e9, 1.0),
    ("lift 1.0~1.5", 1.0, 1.5),
    ("lift 1.5~2.5", 1.5, 2.5),
    ("lift 2.5+", 2.5, 1e9),
]


def _bucket_of_lift(lift: float) -> str:
    for label, lo, hi in LIFT_BUCKETS:
        if lo <= lift < hi:
            return label
    return LIFT_BUCKETS[-1][0]


def _as_lines(number_lines: List[List[int]], tag: str) -> List[Dict[str, Any]]:
    """find_cross_line_combos 가 요구하는 형태로 변환.

    ⚠️ line_id 가 없으면 내부에서 unique_ids 가 비어 **모든 조합이 걸러진다**
    (min_line_repeat 미달 처리). 반드시 고유 id 를 부여해야 한다.
    """
    out: List[Dict[str, Any]] = []
    for i, ln in enumerate(number_lines):
        nums = sorted({int(n) for n in ln if 1 <= int(n) <= 45})
        if len(nums) < 2:
            continue
        out.append(
            {
                "numbers": nums,
                "line_id": f"{tag}-{i}",
                "sheet_index": i // 5,
                "image_index": i // 5 + 1,
                "line_index": i % 5,
                "line_label": "ABCDE"[i % 5],
            }
        )
    return out


def _combos_for_lines(number_lines: List[List[int]], tag: str) -> List[Dict[str, Any]]:
    from .line_overlap_patterns import find_cross_line_combos

    lines = _as_lines(number_lines, tag)
    if len(lines) < 2:
        return []
    return find_cross_line_combos(lines, sizes=(2, 3, 4), min_line_repeat=2)


def combo_strength_by_number(number_lines: List[List[int]], tag: str = "s") -> Dict[int, float]:
    """번호별 '조합 강도' — 사용자 가설 정량화.

    '어떤 번호가 여러 줄에 반복 등장하고(line_count) 우연 이상으로 묶였을 때(lift)
    당첨 후보인가?' 를 검증하기 위한 신호. 각 번호 n 에 대해, n 을 포함하고 우연을
    초과(lift>1)하는 겹침 조합들의 (lift-1) × line_count 를 합산한다. 즉 '의도적으로
    함께 묶인 정도 × 반복 줄 수' 의 총량이다. lift≤1(우연 이하)은 신호 0 으로 배제.
    """
    combos = _combos_for_lines(number_lines, tag)
    score: Dict[int, float] = {n: 0.0 for n in range(1, 46)}
    for c in combos:
        lift = float(c.get("lift") or 0.0)
        lc = int(c.get("line_count") or 0)
        excess = max(0.0, lift - 1.0)
        if excess <= 0 or lc <= 0:
            continue
        w = excess * lc
        for n in c.get("numbers") or []:
            ni = int(n)
            if 1 <= ni <= 45:
                score[ni] += w
    return score


def _summarize(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """겹침 조합 기록 → 크기별·lift구간별 평균 당첨 겹침 집계."""
    by_size: Dict[str, Dict[str, Any]] = {}
    by_bucket: Dict[tuple[int, str], Dict[str, float]] = {}

    for r in records:
        k = int(r["size"])
        ov = float(r["overlap"])
        exp = k * BASE_RATE
        s = by_size.setdefault(
            str(k), {"size": k, "combos": 0, "overlap_sum": 0.0, "expected": round(exp, 4), "fully_winning": 0}
        )
        s["combos"] += 1
        s["overlap_sum"] += ov
        if ov >= k:
            s["fully_winning"] += 1

        key = (k, _bucket_of_lift(float(r.get("lift") or 0.0)))
        b = by_bucket.setdefault(key, {"combos": 0.0, "overlap_sum": 0.0})
        b["combos"] += 1
        b["overlap_sum"] += ov

    size_out: List[Dict[str, Any]] = []
    for s in by_size.values():
        n = max(1, s["combos"])
        mean_ov = s["overlap_sum"] / n
        size_out.append(
            {
                "size": s["size"],
                "combos": s["combos"],
                "mean_overlap": round(mean_ov, 4),
                "expected": s["expected"],
                "lift_vs_chance": round(mean_ov / s["expected"], 2) if s["expected"] else 0.0,
                "fully_winning": s["fully_winning"],
            }
        )
    size_out.sort(key=lambda x: x["size"])

    bucket_out: List[Dict[str, Any]] = []
    for (k, label), b in by_bucket.items():
        n = max(1.0, b["combos"])
        mean_ov = b["overlap_sum"] / n
        exp = k * BASE_RATE
        bucket_out.append(
            {
                "size": k,
                "bucket": label,
                "combos": int(b["combos"]),
                "mean_overlap": round(mean_ov, 4),
                "expected": round(exp, 4),
                "lift_vs_chance": round(mean_ov / exp, 2) if exp else 0.0,
            }
        )
    bucket_out.sort(key=lambda x: (x["size"], x["bucket"]))
    return {"by_size": size_out, "by_lift_bucket": bucket_out}


def _compare_signals_across_rounds(
    batches: List[Dict[str, Any]], win_by_round: Dict[int, List[int]]
) -> Dict[str, Any]:
    """번호 선정 신호들을 회차 평균 당첨 커버리지로 정면 비교.

    비교 신호:
      - support     : 양쪽 지지(min(자동줄,반자동줄))  — 단순 반복 빈도 기준선
      - combo_strength: 반복줄 × lift(우연 초과)          — 사용자 가설
      - random_expected: 무작위 기준선(top-K 에서 K×6/45)
    """
    from .store import _manual_saved_lines

    KS = [6, 10, 18]
    acc: Dict[str, Dict[int, float]] = {
        "support": {k: 0.0 for k in KS},
        "combo_strength": {k: 0.0 for k in KS},
    }
    rounds_used = 0
    for batch in batches:
        rnd = batch.get("round_no")
        if rnd is None:
            continue
        rnd = int(rnd)
        winning = win_by_round.get(rnd)
        if not winning:
            continue
        win_set = set(winning)
        entries = list(batch.get("entries") or [])
        auto = _manual_saved_lines(entries, "자동", include_photo=True)
        semi = _manual_saved_lines(entries, "반자동", include_photo=True)
        if len(auto) < 2:
            continue
        ac = _line_freq(auto)
        sc = _line_freq(semi)
        support = {n: float(min(ac.get(n, 0), sc.get(n, 0))) for n in range(1, 46)}
        combo = combo_strength_by_number(auto, f"cmp{rnd}")
        rounds_used += 1
        for key, vals in (("support", support), ("combo_strength", combo)):
            ranked = _rank_signal(vals)
            pos = {n: ranked.index(n) + 1 for n in range(1, 46)}
            for k in KS:
                acc[key][k] += sum(1 for n in winning if pos[n] <= k)
        _ = win_set  # 명시적 사용(가독성)

    if rounds_used == 0:
        return {"rounds": 0}

    out_signals = []
    for key in ("support", "combo_strength"):
        out_signals.append(
            {
                "key": key,
                "label": _SIG_CMP_LABELS[key],
                "mean_top6": round(acc[key][6] / rounds_used, 2),
                "mean_top10": round(acc[key][10] / rounds_used, 2),
                "mean_top18": round(acc[key][18] / rounds_used, 2),
            }
        )
    baseline = {k: round(k * 6.0 / 45.0, 2) for k in KS}
    # 가설이 기준선(support)보다 유의미하게 나은가? (표본이 작으니 '유의'는 큰 격차만)
    supp = next(s for s in out_signals if s["key"] == "support")
    cs = next(s for s in out_signals if s["key"] == "combo_strength")
    verdict = (
        "combo_strength 가 support 를 앞섬"
        if cs["mean_top18"] > supp["mean_top18"] + 0.5
        else "combo_strength 가 support 대비 우위 없음"
    )
    return {
        "rounds": rounds_used,
        "signals": out_signals,
        "random_baseline": {"top6": baseline[6], "top10": baseline[10], "top18": baseline[18]},
        "verdict": verdict,
    }


_SIG_CMP_LABELS = {"support": "양쪽 지지(반복 빈도)", "combo_strength": "조합 강도(반복줄×lift)"}


def build_overlap_learning() -> Dict[str, Any]:
    """보관된 모든 회차의 겹침 조합을 실제 당첨과 대조해 누적 학습."""
    from .store import _load_historical_raw, _load_current_raw, _manual_saved_lines
    from ..database import load_history
    from .draw_template import get_current_round_no

    historical = _load_historical_raw()
    batches = historical.get("archived_current_rounds") or []
    if not batches:
        return {"ok": False, "reason": "보관된 과거 회차 용지가 없습니다.", "round_count": 0}

    df = load_history()
    win_by_round: Dict[int, List[int]] = {}
    if not df.empty:
        for _, row in df.iterrows():
            try:
                win_by_round[int(row["round"])] = [int(row[f"num{i}"]) for i in range(1, 7)]
            except Exception:  # noqa: BLE001
                continue

    all_records: List[Dict[str, Any]] = []
    rounds_out: List[Dict[str, Any]] = []

    for batch in batches:
        rnd = batch.get("round_no")
        if rnd is None:
            continue
        rnd = int(rnd)
        winning = win_by_round.get(rnd)
        if not winning:
            continue
        win_set = set(winning)
        entries = list(batch.get("entries") or [])
        # 겹침 분석 기준은 '자동 누적'(UI 의 다른 줄에도 겹침과 동일 기준).
        auto_lines = _manual_saved_lines(entries, "자동", include_photo=True)
        combos = _combos_for_lines(auto_lines, f"r{rnd}")
        if not combos:
            continue

        rec_for_round: List[Dict[str, Any]] = []
        for c in combos:
            nums = [int(n) for n in (c.get("numbers") or [])]
            k = int(c.get("size") or len(nums))
            if k < 2:
                continue
            overlap = len(set(nums) & win_set)
            rec = {
                "size": k,
                "overlap": overlap,
                "lift": float(c.get("lift") or 0.0),
                "z": float(c.get("z") or 0.0),
                "line_count": int(c.get("line_count") or 0),
            }
            rec_for_round.append(rec)
            all_records.append(rec)

        summ = _summarize(rec_for_round)
        rounds_out.append(
            {
                "round_no": rnd,
                "winning_numbers": winning,
                "auto_line_count": len(auto_lines),
                "combo_count": len(rec_for_round),
                "by_size": summ["by_size"],
            }
        )

    if not all_records:
        return {
            "ok": False,
            "reason": "추첨 결과가 확정된 보관 회차의 겹침 조합이 없습니다.",
            "round_count": 0,
        }

    # ── 신호 정면 비교(회차 평균) ── 사용자 가설('조합강도')이 단순 빈도(support)를
    # 이기는가? 각 회차마다 번호를 각 신호로 세워 당첨 top-K 커버리지를 재고, 회차
    # 평균을 낸다. **단일 회차 우연을 배제하고 회차 평균으로 판정하는 것이 핵심.**
    signal_comparison = _compare_signals_across_rounds(batches, win_by_round)

    learned = _summarize(all_records)
    lift_of: Dict[tuple[int, str], float] = {
        (b["size"], b["bucket"]): b["lift_vs_chance"] for b in learned["by_lift_bucket"]
    }

    # ── 이번회차 적용 — 학습된 (크기, lift구간) 가중치로 겹침 조합을 채점 ──
    current = _load_current_raw()
    cur_entries = list(current.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_combos = _combos_for_lines(cur_auto, "cur")
    number_score: Dict[int, float] = {}
    number_support: Dict[int, int] = {}
    for c in cur_combos:
        nums = [int(n) for n in (c.get("numbers") or [])]
        k = int(c.get("size") or len(nums))
        if k < 2:
            continue
        w = lift_of.get((k, _bucket_of_lift(float(c.get("lift") or 0.0))), 1.0)
        if w <= 0:
            continue
        # 큰 조합일수록 신호가 강하다고 보고 size 가중을 살짝 준다.
        weight = w * (1 + 0.25 * (k - 2))
        for n in nums:
            number_score[n] = number_score.get(n, 0.0) + weight
            number_support[n] = number_support.get(n, 0) + 1

    current_scores = sorted(
        (
            {
                "number": n,
                "score": round(s, 2),
                "combo_support": number_support.get(n, 0),
            }
            for n, s in number_score.items()
        ),
        key=lambda x: (-x["score"], -x["combo_support"], x["number"]),
    )[:15]

    # '신호 없음(평탄)' 판정은 **표본이 큰 크기별 집계**로 한다.
    # ⚠️ lift 구간별은 소표본 버킷(수십 건)이 쉽게 크게 흔들려, 그걸 기준으로 삼으면
    # 우연한 편차 하나 때문에 '신호 있음' 으로 오판돼 사용자를 오도한다.
    _sized = [s for s in learned["by_size"] if s["combos"] >= 100]
    flat = bool(_sized) and all(abs(s["lift_vs_chance"] - 1.0) <= 0.25 for s in _sized)

    return {
        "ok": True,
        "round_count": len(rounds_out),
        "rounds": sorted(rounds_out, key=lambda r: -r["round_no"]),
        "by_size": learned["by_size"],
        "by_lift_bucket": learned["by_lift_bucket"],
        "total_combos": len(all_records),
        "current_round_no": int(get_current_round_no()),
        "current_combo_count": len(cur_combos),
        "current_scores": current_scores,
        "calibration_flat": flat,
        "signal_comparison": signal_comparison,
        "honesty": (
            "보관 회차 용지는 추첨 전 등록분이라 누수가 없습니다. "
            "무작위 게임에서는 모든 구간의 lift_vs_chance 가 1.0 근처(평탄)로 나오는 것이 정상이며, "
            f"현재 {len(rounds_out)}개 회차 표본은 통계적으로 매우 작아 편차는 우연일 수 있습니다. "
            "회차가 쌓일수록 자동으로 표본이 늘어납니다. "
            "1등 확률(1/8,145,060)은 어떤 학습으로도 변하지 않습니다."
        ),
    }
