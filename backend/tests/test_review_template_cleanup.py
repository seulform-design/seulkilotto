"""복기 사진 템플릿 오염 방지 — marked_numbers 가 1~45 전부로 부풀지 않아야 한다.

회귀 방지: merge_review_templates 가 득표 임계 없이 전 번호를 union 하던 버그로
복기 용지가 쌓일수록 marked_numbers=[1..45] 오염이 발생했다(이번회차 적용 시
모든 조합 매칭 → 무의미). 2표 이상 우선 + 상위 12 캡으로 제한한다.
"""
from app.video_analysis.position_template import merge_review_templates


def _tpl(nums, rnd=None):
    return {"marked_numbers": list(nums), "ticket_round": rnd, "positions": {}}


def test_merge_does_not_balloon_to_all_45():
    # 여러 용지가 제각각 다른 번호를 담아도(합집합이 1~45 전체라도)
    # 2표 이상만 남겨 marked_numbers 가 폭주하지 않아야 한다.
    templates = [
        _tpl([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "1231"),
        _tpl([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], "1231"),
        _tpl([25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36], "1231"),
        _tpl([37, 38, 39, 40, 41, 42, 43, 44, 45, 1, 2, 3], "1231"),
    ]
    out = merge_review_templates(templates)
    assert len(out["marked_numbers"]) <= 12, "marked_numbers 가 12 초과로 부풀면 오염"
    assert out["marked_numbers"] != list(range(1, 46)), "1~45 전부는 오염"
    # 2표(1,2,3 은 1번·4번 용지 모두 등장) 우선 반영.
    assert set([1, 2, 3]).issubset(set(out["marked_numbers"]))
    # 단수 ticket_round 도 채워져야 함(빈 회차 방지).
    assert out["ticket_round"] == "1231"
    assert out["source"] == "photo_review"


def test_merge_two_vote_threshold():
    # 2개 템플릿에 공통으로 등장한 번호만 강조(>=2표), 충분하면 캡 불필요.
    templates = [
        _tpl([5, 10, 15, 20, 25, 30], "1232"),
        _tpl([5, 10, 15, 20, 25, 30], "1232"),
        _tpl([5, 10, 40], "1232"),
    ]
    out = merge_review_templates(templates)
    # 5,10,15,20,25,30 은 2표+, 40 은 1표 → 제외.
    assert set(out["marked_numbers"]) == {5, 10, 15, 20, 25, 30}


def test_merge_empty():
    assert merge_review_templates([]) == {}
