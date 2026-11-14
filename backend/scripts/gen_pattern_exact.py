"""가능한 모든 당첨 조합 C(45,6) = 8,145,060개를 전수 열거해 패턴별 '정확한' 조합 수를 계산한다.

출력: backend/app/ingest/pattern_exact.json (draw_atlas 가 런타임에 읽는다 — 운영에서 800만 개를 다시 돌리지 않음).
재현: python backend/scripts/gen_pattern_exact.py   (약 10~20초, numpy 만 필요)

모든 조합은 똑같이 1/8,145,060 이다. 여기서 세는 것은 '그 패턴에 속한 조합이 몇 개인가'이며,
패턴 확률 = 조합 수 / 8,145,060. 흔한 패턴은 '조합이 많아서' 자주 나올 뿐, 그 안의 한 조합이 더 잘 나오지 않는다.
"""
from __future__ import annotations

import itertools
import json
from collections import Counter
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[1] / "app" / "ingest" / "pattern_exact.json"
PRIMES = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43}


def features(C: np.ndarray) -> dict:
    """C: (N,6) 오름차순 번호(1~45). draw_atlas.features() 와 같은 정의(테스트로 일치 확인)."""
    d = np.diff(C, axis=1)
    out = {
        "sum": C.sum(1),
        "odd": (C % 2).sum(1),
        "low": (C <= 22).sum(1),
        "consec": (d == 1).sum(1),
        "prime": np.isin(C, list(PRIMES)).sum(1),
    }
    # AC 값: 서로 다른 (큰수-작은수) 차이의 개수 − 5
    diffs = np.stack([C[:, j] - C[:, i] for i, j in itertools.combinations(range(6), 2)], 1)
    diffs.sort(1)
    out["ac"] = (np.diff(diffs, axis=1) != 0).sum(1) + 1 - 5
    dec = np.minimum((C - 1) // 10, 4)  # 1-10,11-20,21-30,31-40,41-45
    dc = np.stack([(dec == k).sum(1) for k in range(5)], 1)
    out["decades_used"] = (dc > 0).sum(1)
    out["decade_max"] = dc.max(1)
    last = C % 10
    lc = np.stack([(last == k).sum(1) for k in range(10)], 1)
    out["last_digits"] = (lc > 0).sum(1)
    out["sum_bucket"] = np.minimum(np.maximum((out["sum"] - 1) // 20, 3), 11)  # ~79, 80~99, …, 220~
    return out


def class_key_arr(f: dict) -> np.ndarray:
    """결합 패턴 클래스: 홀수·저번호·연속쌍(0/1/2+)·AC(≤6/7/8/9/10)·합계 구간."""
    cons = np.minimum(f["consec"], 2)
    ac = np.clip(f["ac"], 6, 10) - 6
    sb = f["sum_bucket"] - 3
    return (((f["odd"] * 7 + f["low"]) * 3 + cons) * 5 + ac) * 9 + sb


def main() -> None:
    C = np.array(list(itertools.combinations(range(1, 46), 6)), dtype=np.int16)
    N = len(C)
    assert N == 8145060
    f = features(C)
    dist = {k: {str(int(v)): int(c) for v, c in sorted(Counter(map(int, a)).items())}
            for k, a in f.items() if k != "sum_bucket"}
    keys = class_key_arr(f)
    cc = Counter(map(int, keys))
    # 전형도(typicality): 이 클래스보다 '조합 수가 적거나 같은' 클래스들의 확률 질량 합 — 0에 가까울수록 희귀 패턴
    sizes = sorted(cc.values())
    cum, acc = {}, 0
    for s, n in sorted(Counter(sizes).items()):
        acc += s * n
        cum[s] = acc / N
    json.dump({"total": N, "version": "pattern-exact-1.0", "dist": dist,
               "class_counts": {str(k): v for k, v in sorted(cc.items())},
               "typicality_by_size": {str(k): round(v, 8) for k, v in cum.items()}},
              OUT.open("w", encoding="utf-8"), separators=(",", ":"))
    print("ok", N, "classes", len(cc), OUT.stat().st_size)


if __name__ == "__main__":
    main()
