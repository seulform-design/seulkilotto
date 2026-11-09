"""검증된 회차 데이터 + 데이터 시그니처 + 원본 무결성 검사.

모든 회차 통계는 이 모듈의 `load_draws()` 결과(회차 오름차순, 중복 없음, 본번호 6개
1~45 상호 상이, 보너스는 본번호와 분리·상이)만을 입력으로 쓴다. 같은 원본 → 같은 리스트
→ 같은 `data_signature` 이므로 통계는 원본에서 결정론적으로 재현된다.
"""
from __future__ import annotations

import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

NUMBER_COLUMNS = [f"num{i}" for i in range(1, 7)]


@dataclass(frozen=True)
class Draw:
    round: int
    draw_date: str
    numbers: Tuple[int, ...]  # 본번호 6개, 오름차순
    bonus: int                # 보너스(본번호와 분리 — 통계 빈도에 섞지 않는다)


def draws_from_df(df: Optional[pd.DataFrame]) -> List[Draw]:
    """DataFrame → 검증된 Draw 리스트(회차 오름차순, 중복 회차는 마지막 우선)."""
    if df is None or getattr(df, "empty", True):
        return []
    by_round: Dict[int, Draw] = {}
    for row in df.itertuples(index=False):
        try:
            rnd = int(getattr(row, "round"))
            nums = tuple(sorted(int(getattr(row, c)) for c in NUMBER_COLUMNS))
            bonus = int(getattr(row, "bonus"))
        except (TypeError, ValueError, AttributeError):
            continue
        if len(set(nums)) != 6 or not all(1 <= n <= 45 for n in nums):
            continue
        if not (1 <= bonus <= 45) or bonus in nums:
            continue
        by_round[rnd] = Draw(rnd, str(getattr(row, "draw_date", ""))[:10], nums, bonus)
    return [by_round[r] for r in sorted(by_round)]


def load_draws() -> List[Draw]:
    from ..database import load_history

    return draws_from_df(load_history())


def data_signature(draws: List[Draw]) -> str:
    """원본 회차 내용의 해시 — 과거 회차 번호가 정정돼도 바뀐다(최신 회차만 보는 키보다 안전)."""
    h = hashlib.sha256()
    for d in draws:
        h.update(f"{d.round}:{','.join(map(str, d.numbers))}+{d.bonus};".encode())
    return h.hexdigest()[:16]


def history_signature() -> str:
    """현재 이력의 시그니처(캐시 키용). 로드 실패 시 빈 문자열."""
    try:
        return data_signature(load_draws())
    except Exception:  # noqa: BLE001
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# 무결성 검사 — 로더가 조용히 버리는/덮어쓰는 문제를 원본 수준에서 드러낸다.
# ─────────────────────────────────────────────────────────────────────────────

def check_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """원본 행(dict: round, draw_date, num1..6, bonus) 목록의 무결성 리포트."""
    issues: Dict[str, List[Any]] = {
        "unparseable": [],
        "duplicate_rounds": [],
        "out_of_range": [],
        "duplicate_numbers": [],
        "bonus_invalid": [],
        "bonus_in_main": [],
        "missing_rounds": [],
        "date_not_monotonic": [],
    }
    seen: Dict[int, int] = {}
    valid: List[Tuple[int, str]] = []
    for idx, raw in enumerate(rows):
        try:
            rnd = int(raw["round"])
            nums = [int(raw[c]) for c in NUMBER_COLUMNS]
            bonus = int(raw["bonus"])
        except (KeyError, TypeError, ValueError):
            issues["unparseable"].append(idx)
            continue
        seen[rnd] = seen.get(rnd, 0) + 1
        bad = False
        if not all(1 <= n <= 45 for n in nums):
            issues["out_of_range"].append(rnd); bad = True
        if len(set(nums)) != 6:
            issues["duplicate_numbers"].append(rnd); bad = True
        if not (1 <= bonus <= 45):
            issues["bonus_invalid"].append(rnd); bad = True
        elif bonus in nums:
            issues["bonus_in_main"].append(rnd); bad = True
        if not bad:
            valid.append((rnd, str(raw.get("draw_date") or "")[:10]))
    issues["duplicate_rounds"] = sorted(r for r, c in seen.items() if c > 1)
    rounds = sorted(seen)
    if rounds:
        have = set(rounds)
        issues["missing_rounds"] = [r for r in range(rounds[0], rounds[-1] + 1) if r not in have]
    valid.sort()
    for (r1, d1), (r2, d2) in zip(valid, valid[1:]):
        if d1 and d2 and d2 <= d1:
            issues["date_not_monotonic"].append(r2)
    n_issues = sum(len(v) for v in issues.values())
    return {
        "ok": n_issues == 0,
        "row_count": len(rows),
        "valid_rows": len(valid),
        "first_round": rounds[0] if rounds else None,
        "last_round": rounds[-1] if rounds else None,
        "issue_count": n_issues,
        "issues": issues,
    }


def check_draw_sums(draws: List[Draw]) -> Dict[str, Any]:
    """집계 합계 검증 — 본번호 빈도 합 = 6×회차수, 보너스 합 = 회차수."""
    main = [0] * 46
    bonus = [0] * 46
    for d in draws:
        for n in d.numbers:
            main[n] += 1
        bonus[d.bonus] += 1
    return {
        "rounds": len(draws),
        "main_total": sum(main),
        "main_expected": 6 * len(draws),
        "bonus_total": sum(bonus),
        "bonus_expected": len(draws),
        "ok": sum(main) == 6 * len(draws) and sum(bonus) == len(draws),
    }


def integrity_report() -> Dict[str, Any]:
    """현재 데이터 소스(CSV 원본 + 로드 결과)의 무결성."""
    from ..database import CSV_DATA_PATH, get_last_data_source

    draws = load_draws()
    out: Dict[str, Any] = {
        "data_source": get_last_data_source(),
        "loaded_rounds": len(draws),
        "latest_round": draws[-1].round if draws else None,
        "data_signature": data_signature(draws),
        "sums": check_draw_sums(draws),
    }
    path = Path(CSV_DATA_PATH)
    if path.is_file():
        with path.open("r", encoding="utf-8", newline="") as fp:
            rows = list(csv.DictReader(fp))
        out["csv"] = check_rows(rows)
    else:
        out["csv"] = None
    # 로드된 데이터 자체의 연속성(누락 회차)
    if draws:
        have = {d.round for d in draws}
        out["loaded_missing_rounds"] = [
            r for r in range(draws[0].round, draws[-1].round + 1) if r not in have
        ]
    else:
        out["loaded_missing_rounds"] = []
    out["ok"] = bool(
        out["sums"]["ok"]
        and not out["loaded_missing_rounds"]
        and (out["csv"] is None or out["csv"]["ok"])
    )
    return out
