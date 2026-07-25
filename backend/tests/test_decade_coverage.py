"""구간(10단위) 균형 커버리지 보정 회귀 테스트.

복기 커버리지의 '넓은 그물'(expand18)이 티켓에 후보가 있는 5개 구간을 모두 커버하도록
보정하는지, core ⊂ expand 가 유지되는지, 티켓에 아예 없는 구간은 억지로 채우지 않는지
검증한다. 확률을 올리지 않는 '커버리지 폭' 보정이므로, 보장하는 것은 오직 '구간 누락 없음'.
"""
from app.video_analysis.review_verification import (
    DECADE_LABELS,
    _balance_expand,
    _decade,
    _decade_balance_info,
)


def _decades_of(nums):
    return {_decade(n) for n in nums}


def test_balance_expand_covers_all_present_decades():
    # 랭킹 상위18이 저번대(1~18)에 쏠려 21~45 구간을 통째로 놓친 상황.
    order = list(range(1, 46))
    core = [1, 2, 3, 4, 5, 6]
    present = set(range(1, 46))  # 모든 구간에 티켓 후보 있음
    bal = _balance_expand(order, core, present, 18)
    assert len(bal) == 18
    assert set(core).issubset(set(bal)), "core 는 항상 expand 에 포함(core ⊂ expand)"
    assert _decades_of(bal) == {0, 1, 2, 3, 4}, "후보 있는 5개 구간 모두 커버"


def test_balance_expand_skips_empty_decade():
    # 41~45 구간이 티켓에 아예 없음 → 억지로 채우지 않는다(정직한 한계).
    order = list(range(1, 46))
    core = [1, 2, 3, 4, 5, 6]
    present = set(range(1, 41))  # 41~45 없음
    bal = _balance_expand(order, core, present, 18)
    assert 4 not in _decades_of([n for n in bal if n in present])
    # 41~45 에서 억지 phantom 이 들어갔더라도 present 아닌 번호로만(진단서 empty 로 표기)
    info = _decade_balance_info(bal, order[:18], present)
    assert "41~45" in info["empty_decades"]


def test_balance_expand_preserves_core_even_when_concentrated():
    # core 가 한 구간에 몰려도 다른 구간 대표를 추가하며 core 를 버리지 않는다.
    order = [1, 2, 3, 4, 5, 6] + [n for n in range(7, 46)]
    core = [1, 2, 3, 4, 5, 6]  # 전부 1~10 구간
    present = set(range(1, 46))
    bal = _balance_expand(order, core, present, 18)
    assert set(core).issubset(set(bal))
    assert _decades_of(bal) == {0, 1, 2, 3, 4}


def test_decade_balance_info_reports_filled():
    order = list(range(1, 46))
    raw = order[:18]  # 1~18 → 21~45 구간 누락
    present = set(range(1, 46))
    bal = _balance_expand(order, order[:6], present, 18)
    info = _decade_balance_info(bal, raw, present)
    # raw 가 놓쳤다가 보정으로 채운 구간이 보고돼야 한다.
    for lbl in ("21~30", "31~40", "41~45"):
        assert lbl in info["filled_decades"]
    assert info["empty_decades"] == []
    assert sum(info["spread"].values()) == 18
