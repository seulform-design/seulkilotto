"""스마트 조합 생성 테스트."""
import pandas as pd

from app.analytics import generate_smart_sets
from app.database import NUMBER_COLUMNS


def _df(n: int = 80) -> pd.DataFrame:
    rows = []
    for i in range(n):
        base = (i * 5) % 35 + 1
        nums = sorted({base, base + 3, base + 7, base + 11, base + 19, base + 23})
        while len(nums) < 6:
            nums.append((nums[-1] % 45) + 1)
        nums = sorted(set(nums))[:6]
        rows.append(
            {
                "round": 1100 + i,
                "draw_date": f"2024-03-{(i % 28) + 1:02d}",
                **{NUMBER_COLUMNS[j]: nums[j] for j in range(6)},
                "bonus": 45 if 45 not in nums else 44,
            }
        )
    return pd.DataFrame(rows)


def test_smart_generates_with_filters():
    out = generate_smart_sets(_df(), n_sets=3, seed=99)
    assert len(out["combinations"]) >= 1
    for c in out["combinations"]:
        assert 100 <= c["sum_total"] <= 175
        assert c["odd_count"] in (2, 3, 4)
        assert "rarity_score" in c


def test_smart_low_overlap():
    out = generate_smart_sets(_df(), n_sets=3, max_overlap=2, seed=42)
    combos = [c["numbers"] for c in out["combinations"]]
    for i in range(len(combos)):
        for j in range(i + 1, len(combos)):
            overlap = len(set(combos[i]) & set(combos[j]))
            assert overlap <= 2
