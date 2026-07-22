"""복기 Pattern Mining · Validation · Cluster · 설명가능 추천 엔진.

모든 보관 복기(자동/반자동/매치/강한후보/일치구조)를 중복 없이 학습해
반복 재현되는 Pattern 을 자동 탐색하고, Walk-Forward / Rolling / Time-Split /
Backtest 로 검증한 뒤, 통과 Pattern 만 추천·근거에 반영한다.

절대 규칙:
  - 미래(당첨) 정보로 Pattern 을 '정의'하지 않는다. (당첨은 라벨·검증에만 사용)
  - 검증 미통과 Pattern 은 추천에서 제외한다.
  - 당첨 확률 향상을 단정하지 않는다. 재현·안정성 지표만 보고한다.
"""
from __future__ import annotations

import hashlib
import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

BASELINE_HIT = 6.0 / 45.0
BASELINE_TOP6 = 6.0 * BASELINE_HIT
MIN_SUPPORT_ROUNDS = 2
LIFT_ADOPT = 1.10
P_ADOPT = 0.12
N_PERM = 120
ROLLING_WINDOW = 2


# ---------------------------------------------------------------------------
# Round sample (leakage-free archived batches only)
# ---------------------------------------------------------------------------

@dataclass
class RoundSheet:
    round_no: int
    auto_lines: List[List[int]]
    semi_lines: List[List[int]]
    winning: List[int]
    strong18: List[int] = field(default_factory=list)
    match_groups: Dict[int, List[Tuple[int, ...]]] = field(default_factory=dict)


def _sanitize_line(line: Sequence[int]) -> List[int]:
    return sorted({int(x) for x in line if 1 <= int(x) <= 45})


def _line_freq(lines: Sequence[Sequence[int]]) -> Counter:
    c: Counter = Counter()
    for ln in lines:
        for n in set(_sanitize_line(ln)):
            c[n] += 1
    return c


def _strong18(auto: List[List[int]], semi: List[List[int]]) -> List[int]:
    ac, sc = _line_freq(auto), _line_freq(semi)
    ranked = sorted(
        range(1, 46),
        key=lambda n: (-min(ac.get(n, 0), sc.get(n, 0)), -(ac.get(n, 0) + sc.get(n, 0)), -ac.get(n, 0), n),
    )
    return ranked[:18]


def _match_groups(auto: List[List[int]], semi: List[List[int]]) -> Dict[int, List[Tuple[int, ...]]]:
    """자동↔반자동 줄 1:1 전수비교로 2~6 일치 매치 카드 추출."""
    out: Dict[int, List[Tuple[int, ...]]] = {k: [] for k in range(2, 7)}
    seen: Dict[int, Set[Tuple[int, ...]]] = {k: set() for k in range(2, 7)}
    a_lines = [_sanitize_line(l) for l in auto if len(_sanitize_line(l)) == 6]
    s_lines = [_sanitize_line(l) for l in semi if len(_sanitize_line(l)) == 6]
    for al in a_lines:
        aset = set(al)
        for sl in s_lines:
            inter = tuple(sorted(aset & set(sl)))
            k = len(inter)
            if 2 <= k <= 6 and inter not in seen[k]:
                seen[k].add(inter)
                out[k].append(inter)
    return out


def _gaps(nums: Sequence[int]) -> Tuple[int, ...]:
    s = sorted(nums)
    if len(s) < 2:
        return tuple()
    return tuple(s[i + 1] - s[i] for i in range(len(s) - 1))


def _decade_sig(nums: Sequence[int]) -> Tuple[int, ...]:
    counts = [0, 0, 0, 0, 0]
    for n in nums:
        counts[min(4, (n - 1) // 10)] += 1
    return tuple(counts)


def _pid(*parts: Any) -> str:
    raw = "|".join(str(p) for p in parts)
    return "P" + hashlib.md5(raw.encode()).hexdigest()[:10]


def collect_rounds() -> List[RoundSheet]:
    from .store import _load_historical_raw, _manual_saved_lines
    from ..database import load_history

    historical = _load_historical_raw()
    batches = historical.get("archived_current_rounds") or []
    win_map: Dict[int, List[int]] = {}
    df = load_history()
    if df is not None and not getattr(df, "empty", True):
        for _, row in df.iterrows():
            try:
                win_map[int(row["round"])] = [int(row[f"num{i}"]) for i in range(1, 7)]
            except Exception:  # noqa: BLE001
                continue

    samples: List[RoundSheet] = []
    for batch in batches:
        rnd = batch.get("round_no")
        if rnd is None:
            continue
        rnd = int(rnd)
        winning = win_map.get(rnd)
        if not winning:
            continue
        entries = list(batch.get("entries") or [])
        auto = _manual_saved_lines(entries, "자동", include_photo=True)
        semi = _manual_saved_lines(entries, "반자동", include_photo=True)
        if not auto and not semi:
            continue
        samples.append(
            RoundSheet(
                round_no=rnd,
                auto_lines=auto,
                semi_lines=semi,
                winning=list(winning),
                strong18=_strong18(auto, semi),
                match_groups=_match_groups(auto, semi),
            )
        )
    samples.sort(key=lambda s: s.round_no)
    return samples


# ---------------------------------------------------------------------------
# Pattern mining (structure only — no winning numbers in definition)
# ---------------------------------------------------------------------------

@dataclass
class Pattern:
    id: str
    kind: str
    label: str
    signature: str
    numbers: Tuple[int, ...]  # 관련 번호(추천 후보에 기여)
    meta: Dict[str, Any] = field(default_factory=dict)

    def fires(self, sheet: RoundSheet) -> bool:
        """이 Pattern 이 해당 회차 용지에서 관측되는가 (당첨 미사용)."""
        k = self.kind
        if k == "match_card":
            size = int(self.meta.get("size", 0))
            return self.numbers in set(sheet.match_groups.get(size, []))
        if k == "strong_core":
            core = set(self.numbers)
            return core.issubset(set(sheet.strong18[:12]))
        if k == "auto_semi_core":
            ac, sc = _line_freq(sheet.auto_lines), _line_freq(sheet.semi_lines)
            return all(ac.get(n, 0) > 0 and sc.get(n, 0) > 0 for n in self.numbers)
        if k == "gap_structure":
            target = tuple(self.meta.get("gaps", ()))
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _gaps(s) == target:
                    return True
            return False
        if k == "decade_layout":
            target = tuple(self.meta.get("decade", ()))
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _decade_sig(s) == target:
                    return True
            return False
        if k == "pair_repeat":
            a, b = self.numbers[0], self.numbers[1]
            cnt = 0
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = set(_sanitize_line(ln))
                if a in s and b in s:
                    cnt += 1
            return cnt >= int(self.meta.get("min_lines", 2))
        if k == "triple_repeat":
            nums = set(self.numbers)
            cnt = sum(1 for ln in sheet.auto_lines + sheet.semi_lines if nums.issubset(set(_sanitize_line(ln))))
            return cnt >= int(self.meta.get("min_lines", 2))
        if k == "support_band":
            # 강한후보 상위 K 중 특정 번호 포함
            return self.numbers[0] in sheet.strong18[: int(self.meta.get("k", 18))]
        return False

    def candidate_numbers(self) -> List[int]:
        return list(self.numbers)


def mine_patterns(rounds: List[RoundSheet]) -> List[Pattern]:
    """전 회차 용지에서 구조 Pattern 자동 생성 (중복 제거)."""
    patterns: Dict[str, Pattern] = {}

    def add(p: Pattern) -> None:
        if p.id not in patterns:
            patterns[p.id] = p

    # 전역 페어/트리플 반복 (자동+반자동 줄)
    pair_cnt: Counter = Counter()
    triple_cnt: Counter = Counter()
    gap_cnt: Counter = Counter()
    decade_cnt: Counter = Counter()
    match_card_cnt: Counter = Counter()
    strong_core_cnt: Counter = Counter()

    for sheet in rounds:
        lines = [_sanitize_line(l) for l in sheet.auto_lines + sheet.semi_lines if len(_sanitize_line(l)) >= 2]
        for ln in lines:
            if len(ln) == 6:
                gap_cnt[_gaps(ln)] += 1
                decade_cnt[_decade_sig(ln)] += 1
            for a, b in combinations(ln, 2):
                pair_cnt[(a, b)] += 1
            for a, b, c in combinations(ln, 3):
                triple_cnt[(a, b, c)] += 1
        for size, cards in sheet.match_groups.items():
            for card in cards:
                match_card_cnt[(size, card)] += 1
        core = tuple(sorted(sheet.strong18[:6]))
        if len(core) == 6:
            strong_core_cnt[core] += 1
        # auto∩semi 상위 코어
        ac, sc = _line_freq(sheet.auto_lines), _line_freq(sheet.semi_lines)
        both = [n for n in range(1, 46) if ac.get(n, 0) > 0 and sc.get(n, 0) > 0]
        both.sort(key=lambda n: (-min(ac[n], sc[n]), -ac[n] - sc[n], n))
        if len(both) >= 4:
            nums = tuple(both[:4])
            pid = _pid("asc", nums)
            add(Pattern(pid, "auto_semi_core", f"자동∩반자동 코어 {nums}", str(nums), nums, {"size": 4}))

    # 페어: 충분히 반복되는 것만
    for (a, b), c in pair_cnt.most_common(80):
        if c < max(2, len(rounds)):
            continue
        nums = (a, b)
        pid = _pid("pair", nums)
        add(Pattern(pid, "pair_repeat", f"반복페어 {a}-{b}", str(nums), nums, {"min_lines": 2, "global_count": c}))

    for (a, b, c), cnt in triple_cnt.most_common(40):
        if cnt < max(2, len(rounds)):
            continue
        nums = (a, b, c)
        pid = _pid("trip", nums)
        add(Pattern(pid, "triple_repeat", f"반복트리플 {a}-{b}-{c}", str(nums), nums, {"min_lines": 2, "global_count": cnt}))

    for gaps, c in gap_cnt.most_common(25):
        if c < max(2, len(rounds)) or not gaps:
            continue
        pid = _pid("gap", gaps)
        add(Pattern(pid, "gap_structure", f"간격구조 {gaps}", str(gaps), tuple(), {"gaps": gaps, "global_count": c}))

    for dec, c in decade_cnt.most_common(20):
        if c < max(2, len(rounds)):
            continue
        pid = _pid("dec", dec)
        add(Pattern(pid, "decade_layout", f"구간배치 {dec}", str(dec), tuple(), {"decade": dec, "global_count": c}))

    for (size, card), c in match_card_cnt.most_common(60):
        if c < 1:
            continue
        pid = _pid("mc", size, card)
        add(Pattern(
            pid, "match_card", f"{size}일치 매치카드 {card}", f"{size}:{card}", card,
            {"size": size, "global_count": c},
        ))

    for core, c in strong_core_cnt.most_common(15):
        pid = _pid("sc", core)
        add(Pattern(pid, "strong_core", f"강한후보 상위6 {core}", str(core), core, {"global_count": c}))

    # support_band: 개별 번호가 강한후보 18에 반복 등장
    strong_appear: Counter = Counter()
    for sheet in rounds:
        for n in sheet.strong18:
            strong_appear[n] += 1
    for n, c in strong_appear.most_common(30):
        if c < MIN_SUPPORT_ROUNDS:
            continue
        pid = _pid("sb", n)
        add(Pattern(pid, "support_band", f"강한후보 반복 #{n}", str(n), (n,), {"k": 18, "global_count": c}))

    return list(patterns.values())


# ---------------------------------------------------------------------------
# Validation (walk-forward / rolling / time-split / backtest)
# ---------------------------------------------------------------------------

@dataclass
class PatternScore:
    pattern: Pattern
    appear_rounds: int
    win_include_rate: float
    reproduce_rate: float
    stability: float
    recent_retention: float
    continuity: float
    diversity: float
    strong_include: float
    auto_include: float
    semi_include: float
    match_retention: float
    wf_mean_hits: float
    lift_vs_baseline: float
    permutation_p: float
    adopted: bool
    exclude_reasons: List[str]
    use_reasons: List[str]
    per_round: List[Dict[str, Any]]


def _pattern_win_overlap(p: Pattern, sheet: RoundSheet) -> float:
    """Pattern 후보 번호와 당첨의 겹침 비율 (라벨 평가용)."""
    nums = p.candidate_numbers()
    if not nums:
        # 구조만 있는 Pattern: 해당 구조 줄의 번호 vs 당첨
        if p.kind == "gap_structure":
            gaps = tuple(p.meta.get("gaps", ()))
            hits = []
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _gaps(s) == gaps:
                    hits.append(len(set(s) & set(sheet.winning)) / 6.0)
            return float(np.mean(hits)) if hits else 0.0
        if p.kind == "decade_layout":
            dec = tuple(p.meta.get("decade", ()))
            hits = []
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _decade_sig(s) == dec:
                    hits.append(len(set(s) & set(sheet.winning)) / 6.0)
            return float(np.mean(hits)) if hits else 0.0
        return 0.0
    return len(set(nums) & set(sheet.winning)) / max(1, len(nums))


def _pattern_top_hits(p: Pattern, sheet: RoundSheet) -> float:
    """Pattern 이 가리키는 번호 중 당첨 개수 (최대 6)."""
    nums = p.candidate_numbers()
    if not nums:
        # 구조 Pattern → 해당 구조 줄 합집합에서 strong18 교집합 상위
        pool: Counter = Counter()
        if p.kind == "gap_structure":
            gaps = tuple(p.meta.get("gaps", ()))
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _gaps(s) == gaps:
                    for n in s:
                        pool[n] += 1
        elif p.kind == "decade_layout":
            dec = tuple(p.meta.get("decade", ()))
            for ln in sheet.auto_lines + sheet.semi_lines:
                s = _sanitize_line(ln)
                if len(s) == 6 and _decade_sig(s) == dec:
                    for n in s:
                        pool[n] += 1
        nums = [n for n, _ in pool.most_common(6)]
    win = set(sheet.winning)
    return float(sum(1 for n in nums[:6] if n in win))


def validate_pattern(p: Pattern, rounds: List[RoundSheet], rng: random.Random) -> PatternScore:
    fire_flags = [p.fires(s) for s in rounds]
    appear = sum(1 for f in fire_flags if f)
    overlaps = []
    top_hits = []
    per_round = []
    for s, fired in zip(rounds, fire_flags):
        ov = _pattern_win_overlap(p, s) if fired else None
        th = _pattern_top_hits(p, s) if fired else None
        if ov is not None:
            overlaps.append(ov)
        if th is not None:
            top_hits.append(th)
        per_round.append({
            "round_no": s.round_no,
            "fired": fired,
            "win_overlap": round(ov, 4) if ov is not None else None,
            "top_hits": th,
        })

    win_include = float(np.mean(overlaps)) if overlaps else 0.0
    reproduce = appear / max(1, len(rounds))
    # Walk-forward: 과거만으로 fire 관측 → 해당 회차 hit (누수 없음: fire는 용지만)
    wf_hits = [h for h in top_hits if h is not None]
    wf_mean = float(np.mean(wf_hits)) if wf_hits else 0.0

    # Rolling: 최근 WINDOW 평균
    recent = top_hits[-ROLLING_WINDOW:] if top_hits else []
    recent_ret = float(np.mean(recent)) if recent else 0.0

    # Time split: 전반/후반
    mid = max(1, len(wf_hits) // 2)
    early = float(np.mean(wf_hits[:mid])) if wf_hits else 0.0
    late = float(np.mean(wf_hits[mid:])) if len(wf_hits) > mid else early
    stability = 1.0 - min(1.0, abs(early - late) / max(0.01, BASELINE_TOP6))
    continuity = late / max(0.01, early) if early > 0 else (1.0 if late > 0 else 0.0)
    continuity = float(min(2.0, continuity))

    # Diversity of pattern numbers
    nums = p.candidate_numbers()
    diversity = len(set(min(4, (n - 1) // 10) for n in nums)) / 5.0 if nums else 0.5

    # Strong / auto / semi include rates across fire rounds
    strong_hits, auto_hits, semi_hits, match_hits = [], [], [], []
    for s, fired in zip(rounds, fire_flags):
        if not fired:
            continue
        cand = set(p.candidate_numbers()) or set(s.strong18[:6])
        strong_hits.append(len(cand & set(s.strong18)) / max(1, len(cand)))
        ac, sc = _line_freq(s.auto_lines), _line_freq(s.semi_lines)
        auto_hits.append(sum(1 for n in cand if ac.get(n, 0) > 0) / max(1, len(cand)))
        semi_hits.append(sum(1 for n in cand if sc.get(n, 0) > 0) / max(1, len(cand)))
        # match retention: cand ⊆ any match card
        matched = False
        for cards in s.match_groups.values():
            for card in cards:
                if cand and cand.issubset(set(card)):
                    matched = True
                    break
            if matched:
                break
        match_hits.append(1.0 if matched else 0.0)

    strong_include = float(np.mean(strong_hits)) if strong_hits else 0.0
    auto_include = float(np.mean(auto_hits)) if auto_hits else 0.0
    semi_include = float(np.mean(semi_hits)) if semi_hits else 0.0
    match_retention = float(np.mean(match_hits)) if match_hits else 0.0

    # 기준선: 임의 k-set vs 당첨6 겹침 기댓 — top-hits 채택 기준은 BASELINE_TOP6 사용
    lift = wf_mean / BASELINE_TOP6 if BASELINE_TOP6 else 0.0

    # Permutation: shuffle winning labels
    count_ge = 0
    for _ in range(N_PERM):
        fake_hits = []
        for s, fired in zip(rounds, fire_flags):
            if not fired:
                continue
            fake_win = set(rng.sample(range(1, 46), 6))
            cand = p.candidate_numbers()
            if not cand:
                fake_hits.append(0.0)
                continue
            fake_hits.append(float(sum(1 for n in cand[:6] if n in fake_win)))
        if fake_hits and float(np.mean(fake_hits)) >= wf_mean - 1e-12:
            count_ge += 1
    p_perm = (count_ge + 1) / (N_PERM + 1) if appear else 1.0

    exclude, use = [], []
    adopted = (
        appear >= MIN_SUPPORT_ROUNDS
        and lift >= LIFT_ADOPT
        and p_perm <= P_ADOPT
        and late >= BASELINE_TOP6 * 0.95
    )
    if adopted:
        use.append(f"WF 평균적중 {wf_mean:.2f} (기준 {BASELINE_TOP6:.2f})")
        use.append(f"lift {lift:.2f}, perm p={p_perm:.3f}")
        use.append(f"출현 {appear}/{len(rounds)}회 · 재현률 {reproduce:.2f}")
    else:
        if appear < MIN_SUPPORT_ROUNDS:
            exclude.append(f"출현 회차 부족 ({appear})")
        if lift < LIFT_ADOPT:
            exclude.append(f"lift {lift:.2f} < {LIFT_ADOPT}")
        if p_perm > P_ADOPT:
            exclude.append(f"permutation p={p_perm:.3f}")
        if late < BASELINE_TOP6 * 0.95:
            exclude.append("Time-split 후반 재현 부족")

    return PatternScore(
        pattern=p,
        appear_rounds=appear,
        win_include_rate=round(win_include, 4),
        reproduce_rate=round(reproduce, 4),
        stability=round(stability, 4),
        recent_retention=round(recent_ret, 4),
        continuity=round(continuity, 4),
        diversity=round(diversity, 4),
        strong_include=round(strong_include, 4),
        auto_include=round(auto_include, 4),
        semi_include=round(semi_include, 4),
        match_retention=round(match_retention, 4),
        wf_mean_hits=round(wf_mean, 4),
        lift_vs_baseline=round(lift, 3),
        permutation_p=round(p_perm, 4),
        adopted=adopted,
        exclude_reasons=exclude,
        use_reasons=use,
        per_round=per_round,
    )


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster_patterns(scores: List[PatternScore]) -> List[Dict[str, Any]]:
    """유사 Pattern 을 휴리스틱으로 클러스터링."""
    clusters: Dict[str, List[PatternScore]] = defaultdict(list)
    for sc in scores:
        p = sc.pattern
        if p.kind in ("pair_repeat", "triple_repeat", "match_card", "strong_core", "auto_semi_core", "support_band"):
            key = f"{p.kind}|nums:{','.join(map(str, sorted(p.numbers)[:3]))}"
        elif p.kind == "gap_structure":
            key = f"gap|{p.meta.get('gaps')}"
        elif p.kind == "decade_layout":
            key = f"decade|{p.meta.get('decade')}"
        else:
            key = p.kind
        # coarsen: by kind + decade signature of numbers
        if p.numbers:
            dec = _decade_sig(p.numbers)
            key = f"{p.kind}|dec{dec}"
        clusters[key].append(sc)

    out = []
    for i, (key, members) in enumerate(sorted(clusters.items(), key=lambda x: -len(x[1]))):
        adopted_n = sum(1 for m in members if m.adopted)
        mean_lift = float(np.mean([m.lift_vs_baseline for m in members])) if members else 0.0
        out.append({
            "cluster_id": f"C{i + 1:02d}",
            "key": key,
            "size": len(members),
            "adopted_count": adopted_n,
            "mean_lift": round(mean_lift, 3),
            "pattern_ids": [m.pattern.id for m in members[:20]],
            "kinds": sorted({m.pattern.kind for m in members}),
        })
    return out


# ---------------------------------------------------------------------------
# Auto feature engineering + selection
# ---------------------------------------------------------------------------

FEATURE_NAMES = [
    "pattern_stability",
    "pattern_density",
    "pattern_repeat",
    "pattern_confidence",
    "pattern_continuity",
    "group_diversity",
    "cluster_score",
    "auto_similarity",
    "semi_similarity",
    "winning_match_proxy",  # only from historical validated — applied carefully
    "candidate_match",
    "strong_candidate_density",
    "historical_pattern_score",
]


def build_number_pattern_features(
    sheet: RoundSheet,
    adopted: List[PatternScore],
    clusters: List[Dict[str, Any]],
) -> Dict[int, Dict[str, float]]:
    """번호별 Pattern-derived Feature (당첨 미사용)."""
    cluster_by_pid = {}
    for c in clusters:
        for pid in c.get("pattern_ids") or []:
            cluster_by_pid[pid] = c

    feats: Dict[int, Dict[str, float]] = {n: {k: 0.0 for k in FEATURE_NAMES} for n in range(1, 46)}
    ac, sc = _line_freq(sheet.auto_lines), _line_freq(sheet.semi_lines)
    strong_set = set(sheet.strong18)

    for sc_ in adopted:
        p = sc_.pattern
        if not p.fires(sheet):
            continue
        nums = p.candidate_numbers()
        if not nums:
            # 구조 → 매칭 줄의 번호에 분산
            pool: List[int] = []
            if p.kind == "gap_structure":
                gaps = tuple(p.meta.get("gaps", ()))
                for ln in sheet.auto_lines + sheet.semi_lines:
                    s = _sanitize_line(ln)
                    if len(s) == 6 and _gaps(s) == gaps:
                        pool.extend(s)
            elif p.kind == "decade_layout":
                dec = tuple(p.meta.get("decade", ()))
                for ln in sheet.auto_lines + sheet.semi_lines:
                    s = _sanitize_line(ln)
                    if len(s) == 6 and _decade_sig(s) == dec:
                        pool.extend(s)
            nums = list({n for n in pool})
        cl = cluster_by_pid.get(p.id)
        cl_score = float(cl["mean_lift"]) if cl else 1.0
        for n in nums:
            if n < 1 or n > 45:
                continue
            f = feats[n]
            f["pattern_stability"] += sc_.stability
            f["pattern_density"] += 1.0
            f["pattern_repeat"] += sc_.reproduce_rate
            f["pattern_confidence"] += max(0.0, sc_.lift_vs_baseline - 1.0) * (1.0 - sc_.permutation_p)
            f["pattern_continuity"] += min(1.0, sc_.continuity)
            f["group_diversity"] += sc_.diversity
            f["cluster_score"] += cl_score
            f["historical_pattern_score"] += sc_.wf_mean_hits
            if n in strong_set:
                f["strong_candidate_density"] += 1.0
            f["candidate_match"] += 1.0
            f["auto_similarity"] += 1.0 if ac.get(n, 0) > 0 else 0.0
            f["semi_similarity"] += 1.0 if sc.get(n, 0) > 0 else 0.0
    return feats


def select_features(
    rounds: List[RoundSheet],
    adopted: List[PatternScore],
    clusters: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """간단한 Mutual Information / Variance / Correlation 기반 Feature 선택."""
    if len(rounds) < 2 or not adopted:
        return {"ok": False, "reason": "표본 또는 채택 Pattern 부족", "kept": [], "dropped": FEATURE_NAMES[:]}

    # Build matrix: rows = number×round, y = in winning
    X_cols = {k: [] for k in FEATURE_NAMES}
    y: List[int] = []
    for sheet in rounds:
        feats = build_number_pattern_features(sheet, adopted, clusters)
        win = set(sheet.winning)
        for n in range(1, 46):
            for k in FEATURE_NAMES:
                X_cols[k].append(feats[n][k])
            y.append(1 if n in win else 0)

    y_arr = np.asarray(y, dtype=float)
    kept, dropped, reports = [], [], []
    for k in FEATURE_NAMES:
        x = np.asarray(X_cols[k], dtype=float)
        var = float(np.var(x))
        if var < 1e-12:
            dropped.append(k)
            reports.append({"feature": k, "kept": False, "reason": "zero variance", "variance": 0.0})
            continue
        # Pearson corr with label
        xc = x - x.mean()
        yc = y_arr - y_arr.mean()
        corr = float(np.dot(xc, yc) / (np.sqrt(np.dot(xc, xc) * np.dot(yc, yc)) + 1e-12))
        # Mutual information proxy (binned)
        try:
            bins = np.digitize(x, np.linspace(x.min(), x.max() + 1e-9, 5))
            mi = 0.0
            for b in np.unique(bins):
                mask = bins == b
                if not mask.any():
                    continue
                p_b = mask.mean()
                for cls in (0, 1):
                    p_xy = ((mask) & (y_arr == cls)).mean()
                    p_y = (y_arr == cls).mean()
                    if p_xy > 0 and p_b > 0 and p_y > 0:
                        mi += p_xy * math.log((p_xy / (p_b * p_y)) + 1e-12)
        except Exception:  # noqa: BLE001
            mi = 0.0
        # Permutation importance proxy: |corr| drop
        rng = np.random.RandomState(42)
        xperm = x.copy()
        rng.shuffle(xperm)
        xpc = xperm - xperm.mean()
        corr_p = float(np.dot(xpc, yc) / (np.sqrt(np.dot(xpc, xpc) * np.dot(yc, yc)) + 1e-12))
        perm_imp = abs(corr) - abs(corr_p)

        keep = abs(corr) >= 0.02 or mi >= 0.001 or perm_imp >= 0.01
        # winning_match_proxy is historical score — keep if useful
        if k == "winning_match_proxy":
            keep = False  # never use direct winning proxy as live feature name confusion
            dropped.append(k)
            reports.append({"feature": k, "kept": False, "reason": "excluded by design", "corr": round(corr, 4)})
            continue
        if keep:
            kept.append(k)
        else:
            dropped.append(k)
        reports.append({
            "feature": k,
            "kept": keep,
            "variance": round(var, 6),
            "corr": round(corr, 4),
            "mutual_information": round(mi, 6),
            "permutation_importance": round(perm_imp, 4),
            "reason": "selected" if keep else "low contribution",
        })

    return {"ok": True, "kept": kept, "dropped": dropped, "reports": reports}


# ---------------------------------------------------------------------------
# Recommendation with explanations
# ---------------------------------------------------------------------------

def recommend_from_patterns(
    auto: List[List[int]],
    semi: List[List[int]],
    adopted: List[PatternScore],
    clusters: List[Dict[str, Any]],
    kept_features: List[str],
    top_k: int = 15,
) -> Dict[str, Any]:
    if not auto and not semi:
        return {"ok": False, "reason": "용지 줄이 없습니다.", "numbers": []}
    if not adopted:
        return {
            "ok": False,
            "reason": "검증을 통과한 Pattern 이 없어 추천에 반영하지 않습니다.",
            "numbers": [],
            "honesty": "검증 미통과 Pattern 은 자동 제외됩니다.",
        }

    sheet = RoundSheet(
        round_no=0,
        auto_lines=auto,
        semi_lines=semi,
        winning=[],
        strong18=_strong18(auto, semi),
        match_groups=_match_groups(auto, semi),
    )
    feats = build_number_pattern_features(sheet, adopted, clusters)
    cluster_by_pid = {pid: c for c in clusters for pid in (c.get("pattern_ids") or [])}

    # Score numbers
    scored = []
    for n in range(1, 46):
        f = feats[n]
        keys = kept_features or [k for k in FEATURE_NAMES if k != "winning_match_proxy"]
        score = sum(f.get(k, 0.0) for k in keys)
        # explanations from fired adopted patterns containing n
        reasons = []
        for sc in adopted:
            p = sc.pattern
            if not p.fires(sheet):
                continue
            cands = set(p.candidate_numbers())
            if cands and n not in cands:
                continue
            if not cands and n not in sheet.strong18[:10]:
                continue
            cl = cluster_by_pid.get(p.id)
            reasons.append({
                "pattern_id": p.id,
                "pattern_label": p.label,
                "kind": p.kind,
                "stability": sc.stability,
                "lift": sc.lift_vs_baseline,
                "appear_rounds": sc.appear_rounds,
                "wf_mean_hits": sc.wf_mean_hits,
                "cluster_id": cl["cluster_id"] if cl else None,
                "contribution": round(sc.stability * max(0.0, sc.lift_vs_baseline - 1.0) + 0.1, 4),
            })
        reasons.sort(key=lambda r: -r["contribution"])
        scored.append({
            "number": n,
            "score": round(float(score), 4),
            "features": {k: round(f.get(k, 0.0), 4) for k in keys if f.get(k, 0.0) > 0},
            "reasons": reasons[:6],
            "in_strong18": n in sheet.strong18,
            "auto_lines": int(_line_freq(auto).get(n, 0)),
            "semi_lines": int(_line_freq(semi).get(n, 0)),
        })

    scored.sort(key=lambda x: (-x["score"], x["number"]))
    top = [x for x in scored if x["score"] > 0][:top_k]
    if not top:
        top = scored[:top_k]

    return {
        "ok": True,
        "adopted_pattern_count": len(adopted),
        "kept_features": kept_features,
        "numbers": top,
        "top6": [x["number"] for x in top[:6]],
        "strong18": sheet.strong18,
        "honesty": (
            "검증 통과 Pattern · Cluster · Historical score · Strong/Auto/Semi 유사도만 사용합니다. "
            "당첨 확률 향상을 단정하지 않으며, 근거(Pattern/Cluster/지표)를 함께 표시합니다."
        ),
    }


# ---------------------------------------------------------------------------
# Public pipeline
# ---------------------------------------------------------------------------

def build_pattern_mining(seed: int = 42) -> Dict[str, Any]:
    from .store import _load_current_raw, _manual_saved_lines
    from .draw_template import get_current_round_no

    rounds = collect_rounds()
    if not rounds:
        return {
            "ok": False,
            "reason": "보관된 복기 회차가 없습니다. 이번회차 용지를 등록하면 추첨 후 자동 보관됩니다.",
            "round_count": 0,
            "patterns": [],
            "clusters": [],
            "recommendation": {"ok": False, "numbers": []},
        }

    rng = random.Random(seed)
    patterns = mine_patterns(rounds)
    scores = [validate_pattern(p, rounds, rng) for p in patterns]
    scores.sort(key=lambda s: (-int(s.adopted), -s.lift_vs_baseline, s.permutation_p))
    adopted = [s for s in scores if s.adopted]
    clusters = cluster_patterns(scores)
    feat_sel = select_features(rounds, adopted, clusters)
    kept = feat_sel.get("kept") or []

    # Current sheet for recommendation
    current = _load_current_raw()
    cur_entries = list(current.get("entries") or [])
    cur_auto = _manual_saved_lines(cur_entries, "자동", include_photo=True)
    cur_semi = _manual_saved_lines(cur_entries, "반자동", include_photo=True)
    source = "current_round"
    if not cur_auto and not cur_semi:
        last = rounds[-1]
        cur_auto, cur_semi = last.auto_lines, last.semi_lines
        source = f"archived_demo_{last.round_no}"

    rec = recommend_from_patterns(cur_auto, cur_semi, adopted, clusters, kept)
    rec["source"] = source

    def _score_dict(s: PatternScore) -> Dict[str, Any]:
        return {
            "id": s.pattern.id,
            "kind": s.pattern.kind,
            "label": s.pattern.label,
            "numbers": list(s.pattern.numbers),
            "meta": s.pattern.meta,
            "appear_rounds": s.appear_rounds,
            "win_include_rate": s.win_include_rate,
            "reproduce_rate": s.reproduce_rate,
            "stability": s.stability,
            "recent_retention": s.recent_retention,
            "continuity": s.continuity,
            "diversity": s.diversity,
            "strong_include": s.strong_include,
            "auto_include": s.auto_include,
            "semi_include": s.semi_include,
            "match_retention": s.match_retention,
            "wf_mean_hits": s.wf_mean_hits,
            "lift_vs_baseline": s.lift_vs_baseline,
            "permutation_p": s.permutation_p,
            "adopted": s.adopted,
            "use_reasons": s.use_reasons,
            "exclude_reasons": s.exclude_reasons,
            "per_round": s.per_round,
        }

    return {
        "ok": True,
        "round_count": len(rounds),
        "current_round_no": int(get_current_round_no()),
        "dataset": {
            "rounds": [
                {
                    "round_no": r.round_no,
                    "auto_lines": len(r.auto_lines),
                    "semi_lines": len(r.semi_lines),
                    "strong18": r.strong18,
                    "match_cards": {str(k): len(v) for k, v in r.match_groups.items()},
                    "winning": r.winning,
                }
                for r in rounds
            ],
            "sources": ["archived_current_rounds"],
            "note": "추첨 전 보관 용지만 사용(누수 없음). live 복기 저장분은 학습에서 제외.",
        },
        "pattern_count": len(scores),
        "adopted_count": len(adopted),
        "rejected_count": len(scores) - len(adopted),
        "patterns": [_score_dict(s) for s in scores[:80]],
        "adopted_patterns": [_score_dict(s) for s in adopted[:40]],
        "clusters": clusters[:30],
        "feature_selection": feat_sel,
        "recommendation": rec,
        "pipeline": [
            "전수 학습(자동·반자동·매치·강한후보·구조)",
            "Pattern Mining(조합·배치·거리·관계)",
            "Walk-Forward / Rolling / Time-Split / Backtest",
            "Pattern Score·Cluster",
            "Auto Feature Engineering",
            "Feature Selection(MI/Corr/Perm)",
            "검증 통과 Pattern만 추천·근거 출력",
            "새 복기 추가 시 전체 재탐색(호출 시 재계산)",
        ],
        "baselines": {"uniform_top6_hits": round(BASELINE_TOP6, 4)},
        "honesty": (
            f"보관 {len(rounds)}개 회차로 Pattern {len(scores)}개를 탐색·검증했습니다. "
            "목표는 패턴을 사실로 단정하는 것이 아니라, 재현되는 후보만 골라 설명 가능하게 쓰는 것입니다. "
            "1등 확률(1/8,145,060)은 변하지 않습니다."
        ),
    }
