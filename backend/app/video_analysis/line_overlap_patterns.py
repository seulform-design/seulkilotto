"""게임 줄(한 줄) 단위 겹침 — 당첨번호 대비 일치 개수 + 다른 줄 조합."""
from __future__ import annotations

from collections import Counter, defaultdict
from itertools import combinations
from typing import Any, Dict, Iterable, List, Set

from .sheet_grid import filter_marked_numbers_for_combo

GAME_LINE_LABELS = ("A", "B", "C", "D", "E")
PRIZE_TIER_LABELS = {
    6: "1등(6개 일치)",
    5: "3등(5개 일치)",  # 5개+보너스면 2등 — score_lines_vs_reference 에서 보너스로 분기
    4: "4등(4개 일치)",
    3: "5등(3개 일치)",
    2: "2개 일치",
}


def _prize_tier_label(overlap: int, bonus_hit: bool) -> str:
    """일치 개수 → 등수. 5개 일치는 보너스 여부로 2등/3등 구분."""
    if overlap == 5:
        return "2등(5개+보너스)" if bonus_hit else "3등(5개 일치)"
    return PRIZE_TIER_LABELS.get(overlap, f"{overlap}개 일치")


def _line_numbers(detail: Dict[str, Any], line: Dict[str, Any] | None = None) -> Set[int]:
    if line:
        if line.get("source_layout") in ("receipt_5x6", "manual_5x6"):
            return {int(n) for n in line.get("numbers") or [] if 1 <= int(n) <= 45}
        scores = line.get("mark_scores") or {}
        if scores:
            return filter_marked_numbers_for_combo(scores, max_numbers=12, soft_cap=10)
        return {int(n) for n in line.get("numbers") or [] if 1 <= int(n) <= 45}
    scores = detail.get("mark_scores") or {}
    if scores:
        return filter_marked_numbers_for_combo(scores, max_numbers=12, soft_cap=10)
    return {int(n) for n in detail.get("numbers") or [] if 1 <= int(n) <= 45}


def _assign_image_indices(sheet_details: List[Dict[str, Any]]) -> None:
    """source_image 기준 이미지 번호 — [이미지 1], [이미지 2] ..."""
    seen: Dict[str, int] = {}
    for idx, detail in enumerate(sheet_details):
        if detail.get("image_index"):
            continue
        key = str(detail.get("source_image") or "").strip()
        if not key:
            key = f"__sheet_{idx}"
        if key not in seen:
            seen[key] = len(seen) + 1
        detail["image_index"] = seen[key]
        detail["image_label"] = f"이미지 {seen[key]}"


def _format_line_location(line: Dict[str, Any]) -> str:
    img = line.get("image_label") or f"이미지 {int(line.get('image_index', line.get('sheet_index', 0) + 1))}"
    label = str(line.get("line_label") or "A")
    sub = int(line.get("sub_sheet_index", 0))
    if sub > 0:
        return f"[{img}·용지{sub + 1}]의 {label}줄"
    return f"[{img}]의 {label}줄"


def _make_line_id(
    image_index: int,
    sheet_index: int,
    line_label: str,
    *,
    sub_sheet_index: int = 0,
) -> str:
    return f"i{image_index}-s{sheet_index}-sub{sub_sheet_index}-{line_label}"


def extract_betting_lines(sheet_details: List[Dict[str, Any]] | None) -> List[Dict[str, Any]]:
    """용지별 게임 줄 추출 — A~E 줄 + 이미지 번호."""
    lines: List[Dict[str, Any]] = []
    if not sheet_details:
        return lines

    details = list(sheet_details)
    _assign_image_indices(details)

    for sheet_idx, detail in enumerate(details):
        image_index = int(detail.get("image_index") or sheet_idx + 1)
        image_label = str(detail.get("image_label") or f"이미지 {image_index}")
        sub_sheet_index = int(detail.get("sub_sheet_index", 0))
        sub_lines = detail.get("lines") or []
        if sub_lines:
            for line_idx, sub in enumerate(sub_lines):
                nums = _line_numbers(detail, sub)
                if len(nums) < 2:
                    continue
                label = str(sub.get("label") or GAME_LINE_LABELS[line_idx % len(GAME_LINE_LABELS)])
                row = {
                    "sheet_index": sheet_idx,
                    "image_index": image_index,
                    "image_label": image_label,
                    "sub_sheet_index": sub_sheet_index,
                    "line_index": int(sub.get("line_index", line_idx)),
                    "line_label": label,
                    "numbers": sorted(nums),
                    "source_image": detail.get("source_image", ""),
                }
                row["line_id"] = _make_line_id(
                    image_index, sheet_idx, label, sub_sheet_index=sub_sheet_index
                )
                row["location"] = _format_line_location(row)
                lines.append(row)
            continue

        nums = _line_numbers(detail)
        if len(nums) < 2:
            continue
        row = {
            "sheet_index": sheet_idx,
            "image_index": image_index,
            "image_label": image_label,
            "sub_sheet_index": sub_sheet_index,
            "line_index": 0,
            "line_label": "A",
            "numbers": sorted(nums),
            "source_image": detail.get("source_image", ""),
        }
        row["line_id"] = _make_line_id(image_index, sheet_idx, "A", sub_sheet_index=sub_sheet_index)
        row["location"] = _format_line_location(row)
        lines.append(row)
    return lines


def _adaptive_cross_line_min(line_count: int, combo_size: int) -> int:
    if line_count < 4:
        return 2
    if combo_size == 2:
        return max(2, min(5, line_count // 8))
    if combo_size == 3:
        return max(2, min(5, line_count // 7))
    return max(2, min(4, line_count // 6))


def find_cross_line_combos(
    lines: List[Dict[str, Any]],
    *,
    sizes: Iterable[int] = (2, 3, 4),
    min_line_repeat: int = 2,
) -> List[Dict[str, Any]]:
    """여러 게임 줄에 함께 나타난 2·3·4번호 조합.

    각 조합에 '우연 대비 초과' 지표를 함께 계산한다:
      expected = 각 번호의 줄 출현 빈도로부터 독립가정 기대 동시출현 수
                 = ∏(freq_i) / N^(size-1)
      lift     = 관측 / 기대  (>1 이면 우연보다 자주 함께 등장 = 의도적 묶음)
      z        = (관측 - 기대) / √기대  (표본 크기 반영)
    대량 자동 용지에서는 인기번호끼리 우연히 겹쳐 노이즈가 범람하는데, lift/z 로
    '실제로 함께 묶인' 조합만 가려낼 수 있다."""
    combo_hits: Dict[tuple[int, ...], List[Dict[str, Any]]] = defaultdict(list)
    # 번호별 '고유 줄' 출현 빈도 (기대 동시출현 계산용)
    num_line_ids: Dict[int, Set[str]] = defaultdict(set)
    all_line_ids: Set[str] = set()

    for line in lines:
        nums = sorted({int(n) for n in line.get("numbers") or [] if 1 <= int(n) <= 45})
        if len(nums) < 2:
            continue
        lid = str(line.get("line_id") or f"{line.get('image_index')}-{line.get('line_label')}")
        all_line_ids.add(lid)
        for n in nums:
            num_line_ids[n].add(lid)
        meta = {
            "sheet_index": int(line.get("sheet_index", 0)),
            "image_index": int(line.get("image_index", line.get("sheet_index", 0) + 1)),
            "image_label": str(line.get("image_label") or f"이미지 {line.get('image_index', 1)}"),
            "line_index": int(line.get("line_index", 0)),
            "line_label": str(line.get("line_label") or "A"),
            "line_id": str(line.get("line_id") or ""),
            "location": _format_line_location(line),
        }
        for size in sizes:
            if len(nums) < size:
                continue
            for combo in combinations(nums, size):
                combo_hits[tuple(combo)].append(meta)

    total_lines = max(1, len(all_line_ids))
    freq = {n: len(ids) for n, ids in num_line_ids.items()}

    out: List[Dict[str, Any]] = []
    for combo, appearances in combo_hits.items():
        unique_ids = {a["line_id"] for a in appearances if a["line_id"]}
        if len(unique_ids) < min_line_repeat:
            continue
        deduped: Dict[str, Dict[str, Any]] = {}
        for a in appearances:
            lid = a.get("line_id") or f"{a.get('image_index')}-{a.get('line_label')}"
            deduped[lid] = a
        unique_apps = list(deduped.values())
        locations = [a["location"] for a in unique_apps if a.get("location")]
        sheet_indices = sorted({a["sheet_index"] for a in unique_apps})
        image_indices = sorted({a["image_index"] for a in unique_apps})
        obs = len(unique_apps)
        # 기대 동시출현 & 우연 대비 초과
        prod = 1.0
        for n in combo:
            prod *= freq.get(int(n), 0)
        expected = prod / (total_lines ** (len(combo) - 1)) if total_lines else 0.0
        lift = round(obs / expected, 2) if expected > 0 else float(obs)
        z = round((obs - expected) / (expected ** 0.5), 2) if expected > 0 else float(obs)
        out.append(
            {
                "numbers": list(combo),
                "size": len(combo),
                "line_count": obs,
                "repeat_count": obs,
                "appearance_count": obs,
                "expected": round(expected, 2),
                "lift": lift,
                "z": z,
                "sheet_indices": sheet_indices,
                "image_indices": image_indices,
                "locations": locations,
                "lines": unique_apps,
                "label": f"{len(combo)}번호 줄겹침",
            }
        )
    out.sort(key=lambda x: (-x["line_count"], -x["size"], x["numbers"]))
    return out


def score_lines_vs_reference(
    lines: List[Dict[str, Any]],
    reference_numbers: Iterable[int],
    *,
    bonus: int | None = None,
) -> List[Dict[str, Any]]:
    """각 게임 줄 vs 기준번호(당첨·복기) — 로또 당첨처럼 2·3·4·5·6개 일치."""
    ref = {int(n) for n in reference_numbers if 1 <= int(n) <= 45}
    if not ref:
        return []

    hits: List[Dict[str, Any]] = []
    for line in lines:
        nums = {int(n) for n in line.get("numbers") or [] if 1 <= int(n) <= 45}
        if len(nums) < 2:
            continue
        matched = sorted(nums & ref)
        overlap = len(matched)
        if overlap < 2:
            continue
        # 보너스 번호는 당첨 6개(ref)에 포함되지 않으므로 'in ref' 를 요구하면
        # 항상 False 가 되어 2등이 절대 잡히지 않았다. 줄에 보너스 번호가 있으면 hit.
        bonus_hit = bool(bonus and int(bonus) in nums)
        hits.append(
            {
                "sheet_index": int(line.get("sheet_index", 0)),
                "line_index": int(line.get("line_index", 0)),
                "line_label": str(line.get("line_label") or "A"),
                "line_id": str(line.get("line_id") or ""),
                "line_numbers": sorted(nums),
                "overlap_count": overlap,
                "matching_numbers": matched,
                "prize_tier": _prize_tier_label(overlap, bonus_hit),
                "bonus_match": bonus_hit,
                "source_image": line.get("source_image", ""),
            }
        )
    hits.sort(key=lambda x: (-x["overlap_count"], x["sheet_index"], x["line_index"]))
    return hits


def _tier_buckets(matches: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    buckets: Dict[str, List[Dict[str, Any]]] = {str(k): [] for k in (6, 5, 4, 3, 2)}
    for m in matches:
        key = str(int(m.get("overlap_count", 0)))
        if key in buckets:
            buckets[key].append(m)
    return buckets


def _split_cross_by_size(cross: List[Dict[str, Any]]) -> tuple[List[Dict], List[Dict], List[Dict]]:
    pairs = [c for c in cross if c["size"] == 2]
    triples = [c for c in cross if c["size"] == 3]
    quads = [c for c in cross if c["size"] == 4]
    return pairs, triples, quads


def _build_cross_analysis_opinion(
    pairs: List[Dict[str, Any]],
    triples: List[Dict[str, Any]],
    lines: List[Dict[str, Any]],
) -> str:
    """교차 분석 종합 의견."""
    if not pairs and not triples:
        return "2회 이상 함께 움직인 2·3번호 세트가 없습니다. 더 많은 이미지·게임 줄(A~E) 데이터가 필요합니다."

    pair_counter: Counter = Counter()
    line_activity: Counter = Counter()
    image_activity: Counter = Counter()

    for item in pairs[:10]:
        for n in item.get("numbers") or []:
            pair_counter[int(n)] += int(item.get("appearance_count", 2))
    for item in triples[:8]:
        for n in item.get("numbers") or []:
            pair_counter[int(n)] += int(item.get("appearance_count", 2)) * 2

    for item in (triples + pairs)[:15]:
        for loc in item.get("locations") or []:
            line_activity[loc] += 1
        for img in item.get("image_indices") or []:
            image_activity[int(img)] += 1

    hot_nums = [n for n, _ in pair_counter.most_common(5)]
    hot_lines = [loc for loc, _ in line_activity.most_common(3)]
    hot_images = [f"이미지 {idx}" for idx, _ in image_activity.most_common(3)]

    parts: List[str] = []
    if triples:
        top = triples[0]
        parts.append(
            f"핵심 3인조 {top['numbers']}가 {top.get('appearance_count', 0)}개 줄에서 세트로 반복됩니다."
        )
    if pairs:
        top2 = pairs[0]
        parts.append(
            f"가장 많이 묶인 2인조는 {top2['numbers']} ({top2.get('appearance_count', 0)}회)입니다."
        )
    if hot_nums:
        parts.append(f"자주 함께 움직인 번호: {hot_nums}")
    if hot_images:
        parts.append(f"겹침이 많은 이미지: {', '.join(hot_images)}")
    if hot_lines:
        parts.append(f"겹침이 많은 위치: {', '.join(hot_lines[:3])}")
    return " ".join(parts)


def build_cross_line_analysis_report(
    lines: List[Dict[str, Any]],
    *,
    min_repeat: int = 2,
    pair_limit: int | None = None,
    triple_limit: int | None = None,
) -> Dict[str, Any]:
    """
    이미지·A~E 줄 교차 분석 리포트.
    동일/다른 이미지·다른 줄에서 2·3번호 세트가 2회 이상 같이 나온 경우.

    pair_limit / triple_limit:
      None (기본) — 전체 결과 노출 (사용자 요청). 프론트엔드 측에서
      스크롤 컨테이너 + 가상화로 처리.
      정수 — 상위 N개만. 외부에서 명시한 제한이 있을 때만.
    """
    raw_pairs = find_cross_line_combos(lines, sizes=(2,), min_line_repeat=min_repeat)
    raw_triples = find_cross_line_combos(lines, sizes=(3,), min_line_repeat=min_repeat)
    pairs = raw_pairs[:pair_limit] if pair_limit is not None else raw_pairs
    triples = raw_triples[:triple_limit] if triple_limit is not None else raw_triples
    opinion = _build_cross_analysis_opinion(pairs, triples, lines)

    def _section_triples() -> str:
        if not triples:
            return "■ 1. [3개 세트] 다른 줄에서도 똑같이 겹치는 3인조 조합 (최다 빈도 순)\n- 없음"
        rows = ["■ 1. [3개 세트] 다른 줄에서도 똑같이 겹치는 3인조 조합 (최다 빈도 순)"]
        for item in triples:
            nums = item["numbers"]
            cnt = item.get("appearance_count", item.get("line_count", 0))
            locs = ", ".join(item.get("locations") or [])
            rows.append(f"- [{', '.join(str(n) for n in nums)}] 세트 (총 {cnt}회 등장)")
            rows.append(f"  * 위치: {locs}")
        return "\n".join(rows)

    def _section_pairs() -> str:
        if not pairs:
            return "■ 2. [2개 세트] 다른 줄에서도 똑같이 겹치는 2인조 조합 (최다 빈도 순)\n- 없음"
        rows = ["■ 2. [2개 세트] 다른 줄에서도 똑같이 겹치는 2인조 조합 (최다 빈도 순)"]
        for item in pairs:
            nums = item["numbers"]
            cnt = item.get("appearance_count", item.get("line_count", 0))
            locs = ", ".join(item.get("locations") or [])
            rows.append(f"- [{', '.join(str(n) for n in nums)}] 세트 (총 {cnt}회 등장)")
            rows.append(f"  * 위치: {locs}")
        return "\n".join(rows)

    section_summary = f"■ 3. 교차 분석 종합 의견\n- {opinion}"
    label_counts: Dict[str, int] = dict(Counter(str(l.get("line_label") or "A") for l in lines))

    return {
        "triple_sets": triples,
        "pair_sets": pairs,
        "summary_opinion": opinion,
        "min_repeat": min_repeat,
        "line_count": len(lines),
        "image_count": len({l.get("image_index") for l in lines}),
        "line_label_counts": label_counts,
        "formatted_text": "\n\n".join([_section_triples(), _section_pairs(), section_summary]),
        "sections": {
            "triples": _section_triples(),
            "pairs": _section_pairs(),
            "summary": section_summary,
        },
    }


def _line_overlap_candidates(
    same_line: List[Dict[str, Any]],
    cross: List[Dict[str, Any]],
    *,
    limit: int = 18,
) -> List[int]:
    """강한 후보 — 기준일치는 일치수², 교차조합은 '우연 대비 초과(lift)'로 가중.
    과거엔 line_count 로 가중해 인기번호 노이즈가 후보를 잠식했다. lift 가중으로
    실제 의도적 묶음만 후보에 반영한다."""
    scores: Counter = Counter()
    for m in same_line:
        weight = int(m.get("overlap_count", 2)) ** 2
        for n in m.get("matching_numbers") or []:
            scores[int(n)] += weight
    for c in cross:
        size = int(c.get("size", 2))
        lift = float(c.get("lift", 1.0) or 1.0)
        # lift 기반 가중(우연 대비 초과분). lift<=1 은 노이즈 → 가중 0.
        excess = max(0.0, lift - 1.0)
        weight = size * (1.0 + 2.0 * excess)
        for n in c.get("numbers") or []:
            scores[int(n)] += weight
    return [n for n, _ in scores.most_common(limit)]


# 표시 최소 겹침 — 사용자 요청: 누적 화면은 '최소 2줄까지' 모든 겹침을 노출.
# (과거엔 적응형 줄수 기준으로 2~4줄 겹침을 잘라 일부만 보였다.)
_DISPLAY_MIN_REPEAT = 2
# '우연 대비 초과' 유의 기준 — 표시는 안 자르되, 강한후보(당첨 신호) 산출에는
# 이 기준을 넘는 실제 묶음만 반영해 인기번호 노이즈를 배제한다.
_SIG_Z_MIN = 2.0
_SIG_LIFT_MIN = 1.3
# 다중비교 경고용 baseline — 45C2=990 쌍을 z≥2.0(단측 p≈0.0228)로 전수 검정하면
# 순수 우연만으로도 ≈23쌍이 '유의'하게 뜬다. 즉 z≥2.0 단독으로는 신호와 노이즈를
# 구분하지 못한다(다중비교 미보정). 이 값을 노출해 사용자가 강한후보 수를 우연
# 기대치와 직접 대조할 수 있게 한다.
_PAIR_UNIVERSE = 45 * 44 // 2  # 990
_EXPECTED_SIG_PAIRS_BY_CHANCE = round(_PAIR_UNIVERSE * 0.0228)  # ≈ 23


def _significance_subset(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """강한후보 산출용 — 우연 대비 유의(z·lift)한 조합만. 표시 목록엔 영향 없음."""
    sig = [
        c for c in items
        if float(c.get("z", 0)) >= _SIG_Z_MIN and float(c.get("lift", 0)) >= _SIG_LIFT_MIN
    ]
    # 유의 조합이 거의 없으면(균질 데이터) 상위 z 로 최소 보완
    if len(sig) < 5:
        sig = sorted(items, key=lambda c: (-float(c.get("z", 0)), -c["line_count"]))[:20]
    return sig


def analyze_line_overlap_patterns(
    sheet_details: List[Dict[str, Any]] | None,
    reference_numbers: Iterable[int] | None = None,
    *,
    intent: str = "current_round",
    bonus: int | None = None,
    min_cross_line_repeat: int | None = None,
) -> Dict[str, Any]:
    """
    게임 줄 단위 분석.
    - same_line_matches: 기준번호와 줄별 2·3·4·5·6개 일치 (당첨 방식)
    - cross_line_combos: 다른 줄에도 함께 나온 2·3·4번호 조합
    """
    lines = extract_betting_lines(sheet_details)
    ref = sorted({int(n) for n in (reference_numbers or []) if 1 <= int(n) <= 45})
    line_count = len(lines)
    sheet_count = len({l["sheet_index"] for l in lines})

    same_line = score_lines_vs_reference(lines, ref, bonus=bonus) if ref else []
    tiers = _tier_buckets(same_line)

    cross_report = build_cross_line_analysis_report(lines, min_repeat=2)

    # 표시 최소 겹침 — 사용자 요청대로 '최소 2줄까지' 모든 겹침 노출(자르지 않음).
    # 외부에서 min_cross_line_repeat 를 명시하면 그 값을 따른다.
    disp_min = _DISPLAY_MIN_REPEAT if min_cross_line_repeat is None else int(min_cross_line_repeat)
    raw_cross = find_cross_line_combos(lines, sizes=(2, 3, 4), min_line_repeat=disp_min)

    # 표시 목록: 2줄 이상 모든 조합(빈도순). find_cross_line_combos 가 이미
    # line_count desc 정렬 + expected/lift/z 주석을 달아 반환한다.
    pairs = [c for c in raw_cross if c["size"] == 2]
    triples = [c for c in raw_cross if c["size"] == 3]
    quads = [c for c in raw_cross if c["size"] == 4]

    # 강한 후보(당첨 신호)는 '우연 대비 초과' 유의 조합만 반영 — 인기번호 노이즈 배제.
    sig_pairs = _significance_subset(pairs)
    sig_triples = _significance_subset(triples)
    sig_quads = _significance_subset(quads)
    sig_active = len(pairs) > 40  # 대량 노이즈 영역 여부(표시 문구용)

    cross = pairs + triples + quads
    strong = _line_overlap_candidates(same_line, sig_pairs + sig_triples + sig_quads)

    avg_marks = round(sum(len(l["numbers"]) for l in lines) / line_count, 1) if line_count else 0.0
    verification = {
        "sheets_analyzed": sheet_count,
        "physical_sheets_detected": sheet_count,
        "lines_analyzed": line_count,
        "avg_marks_per_line": avg_marks,
        "pair_min_repeat": disp_min,
        "triple_min_repeat": disp_min,
        "quad_min_repeat": disp_min,
        "raw_pair_candidates": len(pairs),
        "raw_triple_candidates": len(triples),
        "raw_quad_candidates": len(quads),
        "significant_pairs": len(pairs),
        "significant_triples": len(triples),
        "significant_quads": len(quads),
        # 표시는 자르지 않음(2줄+ 전체). 강한후보만 우연대비 유의 조합으로 산출.
        "signal_pairs": len(sig_pairs),
        "signal_triples": len(sig_triples),
        "expected_sig_pairs_by_chance": _EXPECTED_SIG_PAIRS_BY_CHANCE,
        "significance_active": sig_active,
        "same_line_tier_counts": {k: len(v) for k, v in tiers.items() if v},
        "criteria": (
            f"게임 줄 {line_count}개 · 줄당 표시 평균 {avg_marks}개 · 기준번호 {len(ref)}개 · "
            f"줄간 2·3·4번호 {disp_min}줄+ 전체 표시 · "
            f"강한후보는 우연 대비 초과(z≥{_SIG_Z_MIN}·lift≥{_SIG_LIFT_MIN}) {len(sig_pairs)}쌍 반영 "
            f"· ⚠순수 우연 기대 ≈{_EXPECTED_SIG_PAIRS_BY_CHANCE}쌍(다중비교 미보정) — 예측용 아님"
        ),
    }

    parts: List[str] = []
    if line_count:
        parts.append(f"게임 줄 {line_count}개 (용지 {sheet_count}장)")
    if ref:
        tier_bits = []
        for k in ("6", "5", "4", "3", "2"):
            if tiers.get(k):
                tier_bits.append(f"{k}개일치 {len(tiers[k])}줄")
        if tier_bits:
            parts.append("기준번호 일치 · " + ", ".join(tier_bits))
        elif intent == "review":
            parts.append("기준번호 2개 이상 일치 줄 없음")
    if pairs:
        top = pairs[0]
        parts.append(f"줄간 2번호 {len(pairs)}건 (최다 {top['numbers']} ×{top['line_count']}줄)")
    if triples:
        top = triples[0]
        parts.append(f"줄간 3번호 {len(triples)}건 (최다 {top['numbers']} ×{top['line_count']}줄)")
    if quads:
        top = quads[0]
        parts.append(f"줄간 4번호 {len(quads)}건 (최다 {top['numbers']} ×{top['line_count']}줄)")
    if not parts:
        parts.append("분석할 게임 줄이 부족합니다")

    prefix = "복기 당첨 줄겹침" if intent == "review" else "이번회차 줄겹침"
    return {
        "summary": f"{prefix} · " + " · ".join(parts),
        "analysis_mode": "line_overlap",
        "line_count": line_count,
        "sheet_count": sheet_count,
        "reference_numbers": ref,
        "same_line_matches": same_line,
        "same_line_by_tier": tiers,
        "cross_line_combos": pairs + triples,
        "cross_line_analysis": cross_report,
        "pair_duplicates": pairs,
        "triple_duplicates": triples,
        "quad_duplicates": quads,
        "strong_candidates": strong,
        "min_repeat": 2,
        "combo_verification": verification,
    }
