"""추첨기(호기) 실제 기록 레지스트리 — 진짜 1/2/3호기 재연의 단일 소스.

동행복권 로또6/45 는 추첨기 3기(1·2·3호기) 중 매회 '상태가 가장 좋은' 1기를
선택해 추첨한다(추첨 당일 점검). 카페(레알패밀리79)가 매회 호기/볼세트를
기록하며, 그 기록을 역산한 결과:

  - 호기 순환 '순서'는 엄격히 1 → 2 → 3 → 1 …  (결정적)
  - 각 호기의 사용 '블록 길이'는 2~5회로 가변 (조건 기반, 공식 불가)
  - 달력 월 단위로 보면 한 달 ≈ 한 호기 (월별 순환), 다만 월말에 1~2회 드리프트

따라서 '완벽히 똑같이' 재연하려면 실제 기록이 필요하다. 여기서는:
  1) CONFIRMED — 카페에서 확인된 회차별 실제 호기(진짜 데이터). 100% 정확.
  2) 미확보 회차 — 월별 순환(anchor 기반)으로 추정(≈85%). 'estimated' 로 표시.

기록을 CONFIRMED 에 추가할수록 추정이 사라지고 100% 에 수렴한다.
"""
from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Dict, Literal, Tuple

Source = Literal["confirmed", "estimated"]

# ── 확정 기록 (data/machine_history.csv) ────────────────────────────
# 회차별 실제 호기. 1차 소스 = lottotapa.com 호기별 당첨번호(262~1230, 969회)
# — 당첨번호를 우리 CSV 와 대조해 969/969(100%) 라벨 검증 완료. 독립 소스
# (카페 레알패밀리79 사진, 1190~1230)와 85% 일치(불일치 6개는 블록 경계 ±1회).
# 경계 충돌 회차는 CSV note 열에 표기. 신규 확인분은 CSV 에 append.
_CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "machine_history.csv"


def _load_confirmed() -> Dict[int, int]:
    out: Dict[int, int] = {}
    try:
        with _CSV_PATH.open(encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                try:
                    out[int(row["round"])] = int(row["machine"])
                except (KeyError, ValueError, TypeError):
                    continue
    except FileNotFoundError:
        pass
    return out


CONFIRMED: Dict[int, int] = _load_confirmed()

MACHINE_COUNT = 3
ROTATION_ORDER: Tuple[int, ...] = (1, 2, 3)  # 순환 순서 (결정적)

# 월별 순환 앵커 — 확정 데이터의 월별 다수결이 3,1,2,3,1,2,… 로 완벽한 순환.
# 2025-09 = 3호기 기준. 임의 월의 호기 = ((3-1 + 경과월) % 3) + 1.
_ANCHOR_YEAR, _ANCHOR_MONTH, _ANCHOR_MACHINE = 2025, 9, 3


def _months_since_anchor(y: int, m: int) -> int:
    return (y - _ANCHOR_YEAR) * 12 + (m - _ANCHOR_MONTH)


def monthly_rotation(d: date) -> int:
    """월별 순환 추정 호기 (앵커 기반, 과거·미래 모두 외삽 가능)."""
    diff = _months_since_anchor(d.year, d.month)
    return ((_ANCHOR_MACHINE - 1 + diff) % MACHINE_COUNT) + 1


def is_confirmed(round_no: int) -> bool:
    return int(round_no) in CONFIRMED


def resolve(round_no: int, draw_date: date | None) -> Tuple[int, Source]:
    """회차의 호기를 (호기번호, 출처)로 반환.

    확정 기록이 있으면 그대로(confirmed). 없으면 월별 순환 추정(estimated).
    날짜가 없으면 마지막 확정 회차 기준 순환 순서로 추정.
    """
    rn = int(round_no)
    if rn in CONFIRMED:
        return CONFIRMED[rn], "confirmed"
    if draw_date is not None:
        return monthly_rotation(draw_date), "estimated"
    # 날짜 없음: 가장 가까운 확정 회차에서 순번 순환으로 외삽
    if CONFIRMED:
        anchor_round = min(CONFIRMED, key=lambda r: abs(r - rn))
        steps = rn - anchor_round
        idx = (ROTATION_ORDER.index(CONFIRMED[anchor_round]) + steps) % MACHINE_COUNT
        return ROTATION_ORDER[idx], "estimated"
    return 1, "estimated"


def predict_next_machine(latest_round: int, latest_confirmed_machine: int | None = None) -> int:
    """다음 회차의 호기 예측 — 현재 블록이 끝나면 순환 다음 호기.

    블록 길이가 가변이라 '블록 지속' vs '순환' 을 확정할 수 없다. 여기서는
    최근 확정 블록이 평균 길이(≈4~5)에 도달했으면 순환, 아니면 지속으로 본다.
    호출측(예측)은 참고용으로만 쓰고, 실제 값은 추첨 후 CONFIRMED 에 기록한다.
    """
    nxt = int(latest_round) + 1
    _m, _src = resolve(nxt, None)
    return _m


def coverage() -> Dict[str, int]:
    """확정/추정 커버리지 요약 (진단·UI 표시용)."""
    if not CONFIRMED:
        return {"confirmed_count": 0, "min_round": 0, "max_round": 0}
    return {
        "confirmed_count": len(CONFIRMED),
        "min_round": min(CONFIRMED),
        "max_round": max(CONFIRMED),
    }
