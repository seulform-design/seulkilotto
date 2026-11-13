"""회차별 예측 영구 기록 + 공식 결과 자동 평가 (round_prediction_history / round_prediction_evaluation).

두 모드를 엄격히 구분한다(prediction_type)
-----------------------------------------
- live               : 추첨 '전'에 저장한 사전 예측. 추첨일 20:00 KST(cutoff) 이후에는 생성 거부, 저장 후 수정 불가.
- backtest           : 과거 회차를 walk-forward 로 재현 — 회차 R 예측에는 R 이전 회차만 사용. 생성 시각은 '지금'이며
                       사전 예측이 아니다(화면에서 별도 표기).
- historical_replay  : 보관 용지(추첨 전 동결분, frozen_at)로 그 회차 번호를 재현 — 입력은 사전 데이터지만 기록은 사후.

예측 1건 = 6개 번호 1조합(prediction_rank 로 같은 엔진·회차의 여러 조합 구분). 모든 엔진을 '회차당 1조합'으로
맞춰 동일 조건에서 비교한다(무작위 기준선도 같은 회차·같은 조합 수).
"""
from __future__ import annotations

import hashlib
import math
import random
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import db

FEATURE_VERSION = "draw-features-1.0"
PRED_TABLES = [
    """CREATE TABLE IF NOT EXISTS round_prediction_history (
        prediction_id TEXT PRIMARY KEY,
        draw_round INTEGER NOT NULL,
        prediction_created_at TEXT NOT NULL,
        prediction_cutoff_at TEXT,
        engine_version TEXT NOT NULL,
        model_version TEXT,
        feature_version TEXT,
        training_data_range TEXT,
        training_sample_count INTEGER,
        prediction_method TEXT NOT NULL,
        predicted_numbers TEXT NOT NULL,
        prediction_rank INTEGER NOT NULL,
        prediction_score REAL,
        prediction_type TEXT NOT NULL,
        ensemble_weight_version TEXT,
        prediction_status TEXT NOT NULL,
        source_note TEXT
    )""",
    """CREATE UNIQUE INDEX IF NOT EXISTS ux_pred_unique
        ON round_prediction_history (draw_round, prediction_method, prediction_type, prediction_rank, engine_version)""",
    "CREATE INDEX IF NOT EXISTS ix_pred_round ON round_prediction_history (draw_round)",
    """CREATE TABLE IF NOT EXISTS round_prediction_evaluation (
        evaluation_id TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL UNIQUE,
        draw_round INTEGER NOT NULL,
        official_winning_numbers TEXT NOT NULL,
        bonus_number INTEGER NOT NULL,
        matched_numbers TEXT NOT NULL,
        match_count INTEGER NOT NULL,
        bonus_matched INTEGER NOT NULL,
        prize_tier INTEGER,
        evaluated_at TEXT NOT NULL,
        evaluation_source TEXT NOT NULL,
        evaluation_status TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS ix_eval_round ON round_prediction_evaluation (draw_round)",
]
_READY: Dict[str, bool] = {}

METHOD_LABELS = {
    "stats_hot": "회차통계 · 핫(누적 최다)",
    "stats_cold": "회차통계 · 콜드(누적 최소)",
    "stats_overdue": "회차통계 · 미출(오래 안 나옴)",
    "stats_recent": "회차통계 · 최근 출현",
    "stats_pair_hot": "회차통계 · 직전 동반 최다",
    "stats_last_avoid": "회차통계 · 직전 회피",
    "engine_machine": "추첨기 엔진",
    "engine_classic": "클래식 엔진",
    "engine_parallel": "평행회차 엔진",
    "engine_decade": "구간미출 엔진",
    "ensemble": "앙상블(번호추천)",
    "v3_round_learning": "V3 다회차 용지(자동+반자동 지지)",
    "sheet_auto": "보관 자동 용지 지지 top6",
    "sheet_semi": "보관 반자동 용지 지지 top6",
    "youtube_auto": "유튜브 자동 용지 빈도 top6",
    "youtube_semi": "유튜브 반자동 용지 빈도 top6",
    "youtube_v3_support": "V3 용지 학습 · 유튜브 용지 지지 top6",
    "random_baseline": "무작위 기준선",
    "v12_integrated": "V12 통합 후보(10조합: 핵심3·분산4·실험3)",
}


def _ensure() -> None:
    key = db.backend()
    if _READY.get(key):
        return
    with db.transaction() as c:
        for stmt in PRED_TABLES:
            c.execute(stmt)
    _READY[key] = True


def reset_for_tests() -> None:
    _READY.clear()


def draw_cutoff(round_no: int) -> datetime:
    """추첨일 20:00 KST(=11:00 UTC) — 이 시각 이후엔 live 예측 생성 거부."""
    d = date(2002, 12, 7) + timedelta(days=7 * (int(round_no) - 1))
    return datetime(d.year, d.month, d.day, 11, 0, tzinfo=timezone.utc)


def _pid(rnd: int, method: str, ptype: str, rank: int, ver: str) -> str:
    return hashlib.sha1(f"{rnd}|{method}|{ptype}|{rank}|{ver}".encode()).hexdigest()[:24]


def _valid(nums: Sequence[int]) -> bool:
    return len(nums) == 6 and len(set(nums)) == 6 and all(1 <= int(n) <= 45 for n in nums)


def save_prediction(c, *, rnd: int, method: str, ptype: str, numbers: Sequence[int], engine_version: str,
                    rank: int = 1, score: Optional[float] = None, created_at: Optional[str] = None,
                    cutoff_at: Optional[str] = None, training_range: Optional[str] = None,
                    training_count: Optional[int] = None, model_version: Optional[str] = None,
                    ensemble_weight_version: Optional[str] = None, note: Optional[str] = None) -> bool:
    """중복이면 저장 안 함(기존 기록 불변). 새로 저장했으면 True."""
    nums = sorted(int(n) for n in numbers)
    if not _valid(nums):
        return False
    pid = _pid(rnd, method, ptype, rank, engine_version)
    if c.execute("SELECT 1 FROM round_prediction_history WHERE prediction_id = ?", (pid,)):
        return False
    c.execute(
        "INSERT INTO round_prediction_history (prediction_id,draw_round,prediction_created_at,prediction_cutoff_at,"
        "engine_version,model_version,feature_version,training_data_range,training_sample_count,prediction_method,"
        "predicted_numbers,prediction_rank,prediction_score,prediction_type,ensemble_weight_version,prediction_status,"
        "source_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, int(rnd), created_at or db.now_iso(), cutoff_at, engine_version, model_version, FEATURE_VERSION,
         training_range, training_count, method, db.dumps(nums), int(rank), score, ptype, ensemble_weight_version,
         "pending_evaluation", note),
    )
    return True


# ─────────────────────────────── 생성: backtest ───────────────────────────────

def backtest_stats(first: int = 51) -> Dict[str, Any]:
    """회차통계 6전략 + 무작위 기준선 — 전 회차 walk-forward(회차 R 은 R 이전만)."""
    from ..stats_engine.backtest import ALGORITHM_VERSION, STRATEGY_LABELS, _rankings
    from ..stats_engine.draws import load_draws

    _ensure()
    draws = load_draws()
    freq = [0] * 46
    last_seen = [0] * 46
    pair = [[0] * 46 for _ in range(46)]
    written = 0
    with db.transaction() as c:
        have = {(int(r[0]), r[1]) for r in c.execute(
            "SELECT draw_round, prediction_method FROM round_prediction_history WHERE prediction_type = 'backtest'")}
        for idx, d in enumerate(draws):
            if d.round >= first and idx > 0:
                ranks = _rankings(freq, last_seen, pair, list(draws[idx - 1].numbers), idx)
                rng_range = f"{draws[0].round}-{draws[idx - 1].round}"
                for s in STRATEGY_LABELS:
                    m = f"stats_{s}"
                    if (d.round, m) in have:
                        continue
                    written += save_prediction(c, rnd=d.round, method=m, ptype="backtest", numbers=ranks[s][:6],
                                               engine_version=ALGORITHM_VERSION, training_range=rng_range,
                                               training_count=idx)
                if (d.round, "random_baseline") not in have:
                    rng = random.Random(f"baseline-{d.round}")  # 회차별 고정 시드(재현 가능)
                    written += save_prediction(c, rnd=d.round, method="random_baseline", ptype="backtest",
                                               numbers=rng.sample(range(1, 46), 6), engine_version="random-1.0",
                                               training_range="none", training_count=0)
            for w in d.numbers:
                freq[w] += 1
                last_seen[w] = idx + 1
            for i in range(6):
                for j in range(i + 1, 6):
                    a, b = d.numbers[i], d.numbers[j]
                    pair[a][b] += 1
                    pair[b][a] += 1
    return {"written": written}


def backtest_engines(last_n: int = 100, sources: Iterable[str] = ("machine", "classic", "parallel", "decade")) -> Dict[str, Any]:
    """기존 추천 엔진(추첨기·클래식·평행·구간미출) — 최근 last_n 회 walk-forward(무거움: 회차당 ~0.5s×엔진)."""
    from ..database import load_history
    from ..prediction_signals import RULES_VERSION, _source_top_numbers

    _ensure()
    df = load_history().sort_values("round")
    rounds = [int(r) for r in df["round"].tolist()][-int(last_n):]
    have = {(int(r[0]), r[1]) for r in db.query(
        "SELECT draw_round, prediction_method FROM round_prediction_history WHERE prediction_type = 'backtest'")}
    written = 0
    for r in rounds:
        prior = df[df["round"] < r]
        if len(prior) < 50:
            continue
        for src in sources:
            m = f"engine_{src}"
            if (r, m) in have:
                continue
            top = _source_top_numbers(prior, src, r, 6)
            if len(top) < 6:
                continue
            with db.transaction() as c:
                written += save_prediction(c, rnd=r, method=m, ptype="backtest", numbers=top[:6],
                                           engine_version=f"signals-{RULES_VERSION}",
                                           training_range=f"{int(prior['round'].min())}-{int(prior['round'].max())}",
                                           training_count=len(prior))
    return {"written": written, "rounds": [rounds[0], rounds[-1]] if rounds else []}


def backtest_ensemble(last_n: int = 100, time_budget_sec: float = 900.0) -> Dict[str, Any]:
    """앙상블(번호추천) 5조합 — 회차 R 은 R 이전 당첨 이력만(intent=review: 신호도 R 이전만 사용).
    회차당 수십 초라 시간 예산 안에서 최근 회차부터 채우고, 다음 실행이 이어서 채운다."""
    import time as _t

    from ..analytics import ENSEMBLE_ALGORITHM_VERSION, generate_ensemble_sets
    from ..database import load_history

    _ensure()
    t0 = _t.time()
    df = load_history().sort_values("round")
    rounds = [int(r) for r in df["round"].tolist()][-int(last_n):]
    have = {int(r[0]) for r in db.query("SELECT DISTINCT draw_round FROM round_prediction_history "
                                         "WHERE prediction_type = 'backtest' AND prediction_method = 'ensemble'")}
    todo = [r for r in reversed(rounds) if r not in have]
    written, done, errors = 0, [], []
    for r in todo:
        if _t.time() - t0 > time_budget_sec:
            break
        prior = df[df["round"] < r]
        if len(prior) < 50:
            continue
        try:
            res = generate_ensemble_sets(prior, n_sets=5, seed=r, target_round=r, intent="review")
        except Exception as exc:  # noqa: BLE001
            errors.append({"round": r, "error": str(exc)[:160]})
            continue
        with db.transaction() as c:
            for i, comb in enumerate(res.get("combinations", [])[:5], start=1):
                written += save_prediction(c, rnd=r, method="ensemble", ptype="backtest", numbers=comb["numbers"], rank=i,
                                           engine_version=f"{ENSEMBLE_ALGORITHM_VERSION}-wf",
                                           training_range=f"{int(prior['round'].min())}-{int(prior['round'].max())}",
                                           training_count=len(prior),
                                           ensemble_weight_version=db.dumps(res.get("engine_weights")),
                                           note="사후 백테스트: 대상 회차 이전 당첨 이력만 입력")
        done.append(r)
    return {"written": written, "rounds_done": len(done), "remaining": max(0, len(todo) - len(done)),
            "errors": errors[:5], "seconds": round(_t.time() - t0, 1)}


def replay_archived_sheets() -> Dict[str, Any]:
    """보관 용지(추첨 전 동결분)로 V3·자동·반자동 지지 top6 재현 — 입력은 사전, 기록은 사후(historical_replay)."""
    from ..video_analysis.round_learning import _number_support, _rank_key
    from ..video_analysis.store import _load_historical_raw, _manual_saved_lines

    _ensure()
    hist = _load_historical_raw()
    batches = hist.get("archived_current_rounds") or []
    written = 0
    rounds = []
    with db.transaction() as c:
        for b in batches:
            rnd = b.get("round_no")
            if rnd is None:
                continue
            rnd = int(rnd)
            entries = list(b.get("entries") or [])
            auto = _manual_saved_lines(entries, "자동", include_photo=True)
            semi = _manual_saved_lines(entries, "반자동", include_photo=True)
            if not auto and not semi:
                continue
            rounds.append(rnd)
            for method, a, s_ in (("v3_round_learning", auto, semi), ("sheet_auto", auto, []), ("sheet_semi", [], semi)):
                if not a and not s_:
                    continue
                sup = _number_support(a, s_)
                top = sorted(range(1, 46), key=lambda n: _rank_key(sup[n]))[:6]
                written += save_prediction(c, rnd=rnd, method=method, ptype="historical_replay", numbers=top,
                                           engine_version="round-learning-support-1", cutoff_at=b.get("frozen_at"),
                                           training_range=f"round {rnd} sheets only", training_count=len(a) + len(s_),
                                           note=f"보관 용지 동결 시각 {b.get('frozen_at')} — 자동 {len(a)}줄·반자동 {len(s_)}줄")
    return {"written": written, "rounds": sorted(rounds)}


def _save_revision(c, *, rnd: int, method: str, numbers: Sequence[int], base_version: str, n_lines: int,
                   **kw) -> bool:
    """같은 회차·방식의 '최신 개정본'만 집계에 쓰이게 저장. 용지 줄 수가 늘면 새 개정본(version@n줄)을 저장하고
    이전 개정본은 prediction_status='superseded' 로 표시(번호·생성 시각은 그대로 보존 — 삭제·덮어쓰기 없음)."""
    ptype = "live" if datetime.now(timezone.utc) < draw_cutoff(rnd) else "historical_replay"
    ver = f"{base_version}@n{n_lines}"
    prev = c.execute("SELECT prediction_id, engine_version, training_sample_count FROM round_prediction_history "
                     "WHERE draw_round = ? AND prediction_method = ? AND prediction_status <> 'superseded'", (int(rnd), method))
    if any((r[1] == ver) or (r[1] == base_version and int(r[2] or 0) >= n_lines) for r in prev):
        return False  # 같은(또는 더 많은) 줄 수로 이미 저장됨
    if not save_prediction(c, rnd=rnd, method=method, ptype=ptype, numbers=numbers, engine_version=ver,
                           training_count=n_lines, cutoff_at=draw_cutoff(rnd).isoformat(), **kw):
        return False
    for r in prev:
        c.execute("UPDATE round_prediction_history SET prediction_status = 'superseded' WHERE prediction_id = ?", (r[0],))
    return True


def youtube_ticket_predictions() -> Dict[str, Any]:
    """유튜브 확정 용지(회차 인쇄 또는 제목+추첨 주간 확인)의 번호 빈도 top6 — 자동/반자동 분리 + V3 지지 점수.
    용지가 새로 판독될 때마다 최신 줄 수로 개정본을 저장한다(추첨 전이면 사전 예측). 이전 개정본은 보존·표시만."""
    from ..video_analysis.round_learning import _number_support, _rank_key

    _ensure()
    written = 0
    both: Dict[int, Dict[str, List[List[int]]]] = {}
    with db.transaction() as c:
        for method, table in (("youtube_auto", "ticket_auto_data"), ("youtube_semi", "ticket_semi_auto_data")):
            rows = c.execute(f"SELECT draw_round, numbers FROM {table} WHERE verification_status = 'accepted' "
                             "AND round_status IN ('ticket_printed', 'title_date_confirmed')")
            by: Dict[int, List[List[int]]] = {}
            for rnd, nums in rows:
                by.setdefault(int(rnd), []).append(db.loads(nums))
            for rnd, lines in by.items():
                both.setdefault(rnd, {"auto": [], "semi": []})["auto" if method == "youtube_auto" else "semi"] = lines
                cnt = [0] * 46
                for ln in lines:
                    for n in ln:
                        cnt[n] += 1
                top = sorted(range(1, 46), key=lambda n: (-cnt[n], n))[:6]
                written += _save_revision(c, rnd=rnd, method=method, numbers=top, base_version="yt-ticket-freq-1",
                                          n_lines=len(lines), note=f"유튜브 관찰 용지 {len(lines)}줄(구매 완료 미확인)")
        # V3 용지 학습(자동+반자동 지지 점수)을 유튜브 용지에 그대로 적용 — 이번 회차(추첨 전)면 사전 예측(live)으로 기록
        for rnd, g in both.items():
            sup = _number_support(g["auto"], g["semi"])
            top = sorted(range(1, 46), key=lambda n: _rank_key(sup[n]))[:6]
            written += _save_revision(c, rnd=rnd, method="youtube_v3_support", numbers=top,
                                      base_version="round-learning-support-1", n_lines=len(g["auto"]) + len(g["semi"]),
                                      training_range=f"round {rnd} youtube sheets only",
                                      note=f"유튜브 용지 자동 {len(g['auto'])}줄·반자동 {len(g['semi'])}줄에 V3 지지 점수 적용")
    return {"written": written}


# ─────────────────────────────── 생성: live ───────────────────────────────

def create_live(next_round: int, *, include_ensemble: bool = True, now: Optional[datetime] = None) -> Dict[str, Any]:
    """다음 회차 사전 예측 — cutoff 이전에만, 한 번 저장되면 변경 불가(ON 중복 무시)."""
    from ..database import load_history
    from ..prediction_signals import RULES_VERSION, _source_top_numbers
    from ..stats_engine.backtest import ALGORITHM_VERSION, STRATEGY_LABELS, _rankings
    from ..stats_engine.draws import load_draws

    _ensure()
    now = now or datetime.now(timezone.utc)
    cutoff = draw_cutoff(next_round)
    if now >= cutoff:
        return {"status": "refused_after_cutoff", "round": next_round, "cutoff": cutoff.isoformat()}
    draws = [d for d in load_draws() if d.round < next_round]
    if not draws or draws[-1].round != next_round - 1:
        return {"status": "refused_missing_previous_round", "round": next_round}
    freq = [0] * 46
    last_seen = [0] * 46
    pair = [[0] * 46 for _ in range(46)]
    for idx, d in enumerate(draws):
        for w in d.numbers:
            freq[w] += 1
            last_seen[w] = idx + 1
        for i in range(6):
            for j in range(i + 1, 6):
                a, b = d.numbers[i], d.numbers[j]
                pair[a][b] += 1
                pair[b][a] += 1
    ranks = _rankings(freq, last_seen, pair, list(draws[-1].numbers), len(draws))
    rng_range = f"{draws[0].round}-{draws[-1].round}"
    written = 0
    with db.transaction() as c:
        for s in STRATEGY_LABELS:
            written += save_prediction(c, rnd=next_round, method=f"stats_{s}", ptype="live", numbers=ranks[s][:6],
                                       engine_version=ALGORITHM_VERSION, cutoff_at=cutoff.isoformat(),
                                       training_range=rng_range, training_count=len(draws))
        rng = random.Random(f"baseline-{next_round}")
        written += save_prediction(c, rnd=next_round, method="random_baseline", ptype="live",
                                   numbers=rng.sample(range(1, 46), 6), engine_version="random-1.0",
                                   cutoff_at=cutoff.isoformat(), training_range="none", training_count=0)
    df = load_history()
    prior = df[df["round"] < next_round]
    for src in ("machine", "classic", "parallel", "decade"):
        top = _source_top_numbers(prior, src, next_round, 6)
        with db.transaction() as c:
            written += save_prediction(c, rnd=next_round, method=f"engine_{src}", ptype="live", numbers=top[:6],
                                       engine_version=f"signals-{RULES_VERSION}", cutoff_at=cutoff.isoformat(),
                                       training_range=rng_range, training_count=len(prior))
    # V7: V6에서 홀드아웃 승인(promoted)된 개선 모델만 '추가' 방식으로 적용(원본 전략은 그대로 유지)
    try:
        from . import reverse_analysis as _rv

        for ap in _rv.approved_models():
            with db.transaction() as c:
                written += save_prediction(c, rnd=next_round, method=f"v6_{ap['candidate']}", ptype="live",
                                           numbers=_rv.candidate_pick(ap["candidate"], draws),
                                           engine_version=f"v6-{ap['version_id'][:8]}", cutoff_at=cutoff.isoformat(),
                                           training_range=rng_range, training_count=len(draws))
    except Exception:  # noqa: BLE001 — 승인 모델 적용 실패가 기존 예측을 막지 않게
        pass
    ens_note = None
    if include_ensemble:
        try:
            from ..analytics import ENSEMBLE_ALGORITHM_VERSION, generate_ensemble_sets

            r = generate_ensemble_sets(prior, n_sets=5, seed=next_round, target_round=next_round)
            with db.transaction() as c:
                for i, comb in enumerate(r.get("combinations", [])[:5], start=1):
                    written += save_prediction(
                        c, rnd=next_round, method="ensemble", ptype="live", numbers=comb["numbers"], rank=i,
                        engine_version=ENSEMBLE_ALGORITHM_VERSION, cutoff_at=cutoff.isoformat(),
                        training_range=rng_range, training_count=len(prior),
                        ensemble_weight_version=db.dumps(r.get("engine_weights")),
                        score=(comb.get("coselection") or {}).get("avoidance_score"))
        except Exception as exc:  # noqa: BLE001
            ens_note = f"ensemble 실패: {exc}"
    return {"status": "ok", "round": next_round, "written": written, "cutoff": cutoff.isoformat(), "note": ens_note}


# ─────────────────────────────── 평가 ───────────────────────────────

def evaluate_pending() -> Dict[str, Any]:
    """공식 당첨번호(레지스트리 검증분 우선, 없으면 CSV)가 있는 회차의 미평가 예측을 채점."""
    from ..stats_engine.draws import load_draws
    from ..stats_engine.probability import prize_rank

    _ensure()
    win = {d.round: d for d in load_draws()}
    verified = {int(r[0]) for r in db.query("SELECT round FROM reg_draws WHERE verification_status = 'official_verified'")}
    rows = db.query("SELECT h.prediction_id, h.draw_round, h.predicted_numbers FROM round_prediction_history h "
                    "LEFT JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
                    "WHERE e.prediction_id IS NULL")
    done = 0
    with db.transaction() as c:
        for pid, rnd, nums_s in rows:
            d = win.get(int(rnd))
            if d is None:
                continue
            nums = db.loads(nums_s)
            matched = sorted(set(nums) & set(d.numbers))
            c.execute(
                "INSERT INTO round_prediction_evaluation (evaluation_id,prediction_id,draw_round,official_winning_numbers,"
                "bonus_number,matched_numbers,match_count,bonus_matched,prize_tier,evaluated_at,evaluation_source,"
                "evaluation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (prediction_id) DO NOTHING",
                (uuid.uuid4().hex, pid, int(rnd), db.dumps(list(d.numbers)), d.bonus, db.dumps(matched), len(matched),
                 int(d.bonus in nums), prize_rank(nums, d.numbers, d.bonus), db.now_iso(),
                 "official_verified" if int(rnd) in verified else "history_csv", "evaluated"),
            )
            c.execute("UPDATE round_prediction_history SET prediction_status = 'evaluated' WHERE prediction_id = ? "
                      "AND prediction_status <> 'superseded'", (pid,))
            done += 1
    return {"evaluated": done}


# ─────────────────────────────── 조회·성능 ───────────────────────────────

def round_detail(rnd: int) -> Dict[str, Any]:
    from ..stats_engine.draws import load_draws

    _ensure()
    d = next((x for x in load_draws() if x.round == int(rnd)), None)
    rows = db.query(
        "SELECT h.prediction_id,h.prediction_method,h.prediction_type,h.prediction_rank,h.predicted_numbers,"
        "h.prediction_created_at,h.prediction_cutoff_at,h.engine_version,h.training_data_range,h.training_sample_count,"
        "h.source_note,e.matched_numbers,e.match_count,e.bonus_matched,e.prize_tier,e.evaluation_source,h.prediction_status "
        "FROM round_prediction_history h LEFT JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
        "WHERE h.draw_round = ? ORDER BY h.prediction_type, h.prediction_method, h.prediction_rank", (int(rnd),))
    items = []
    for r in rows:
        created, cutoff = r[5], r[6]
        pre_draw = None
        try:
            if cutoff:
                pre_draw = datetime.fromisoformat(created) < datetime.fromisoformat(cutoff)
        except ValueError:
            pre_draw = None
        items.append({"prediction_id": r[0], "method": r[1], "label": METHOD_LABELS.get(r[1], r[1]), "type": r[2],
                      "rank": r[3], "numbers": db.loads(r[4]), "created_at": created, "cutoff_at": cutoff,
                      "created_before_cutoff": pre_draw, "engine_version": r[7], "training_range": r[8],
                      "training_count": r[9], "note": r[10], "matched": db.loads(r[11]) if r[11] else None,
                      "match_count": r[12], "bonus_matched": bool(r[13]) if r[13] is not None else None,
                      "prize_tier": r[14], "evaluation_source": r[15], "superseded": r[16] == "superseded"})
    return {"round": int(rnd), "winning": list(d.numbers) if d else None, "bonus": d.bonus if d else None,
            "draw_date": d.draw_date if d else None, "predictions": items}


def _norm_sf(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))


def performance(ptype: str = "backtest", first_round: Optional[int] = None, last_round: Optional[int] = None,
                common_only: bool = False) -> Dict[str, Any]:
    """엔진별 일치 분포·등수·평균·CI·무작위 대비 z — 같은 회차 집합에서 비교(공통 회차 표기)."""
    _ensure()
    sql = ("SELECT h.prediction_method, e.draw_round, e.match_count, e.bonus_matched, e.prize_tier "
           "FROM round_prediction_history h JOIN round_prediction_evaluation e ON e.prediction_id = h.prediction_id "
           "WHERE h.prediction_type = ? AND h.prediction_rank = 1 AND h.prediction_status <> 'superseded'")
    params: List[Any] = [ptype]
    if first_round:
        sql += " AND e.draw_round >= ?"
        params.append(int(first_round))
    if last_round:
        sql += " AND e.draw_round <= ?"
        params.append(int(last_round))
    rows = db.query(sql, tuple(params))
    by: Dict[str, List[Tuple[int, int, int, Optional[int]]]] = {}
    for m, rnd, mc, bm, pt in rows:
        by.setdefault(m, []).append((int(rnd), int(mc), int(bm), pt))
    common_rounds: Optional[List[int]] = None
    if common_only and by:
        # 모든 엔진이 예측을 가진 회차만 — 같은 회차·같은 조합 수 조건 비교
        sets = [set(r for r, *_ in v) for v in by.values()]
        inter = set.intersection(*sets) if sets else set()
        common_rounds = sorted(inter)
        by = {m: [x for x in v if x[0] in inter] for m, v in by.items()}
    exp_mean = 0.8
    var1 = 6 * (6 / 45) * (39 / 45) * (39 / 44)  # 1장 일치 수 분산(초기하)
    methods = [m for m in by if m != "random_baseline"]
    alpha_b = 0.05 / max(1, len(methods))
    out = []
    for m, recs in by.items():
        n = len(recs)
        dist = [0] * 7
        five_b = 0
        tiers: Dict[str, int] = {}
        for _r, mc, bm, pt in recs:
            dist[mc] += 1
            if mc == 5 and bm:
                five_b += 1
            if pt:
                tiers[str(pt)] = tiers.get(str(pt), 0) + 1
        mean = sum(k * dist[k] for k in range(7)) / n if n else 0.0
        se = math.sqrt(var1 / n) if n else 0.0
        z = (mean - exp_mean) / se if se else 0.0
        p = _norm_sf(z)
        out.append({
            "method": m, "label": METHOD_LABELS.get(m, m), "rounds": n,
            "first_round": min(r for r, *_ in recs) if recs else None,
            "last_round": max(r for r, *_ in recs) if recs else None,
            "combos_per_round": 1, "total_games": n,
            "match_rates": {str(k): round(dist[k] / n, 4) if n else 0 for k in range(7)},
            "five_plus_bonus_rate": round(five_b / n, 5) if n else 0,
            "match_counts": dist, "prize_counts": tiers,
            "mean_matches": round(mean, 4), "ci95": [round(mean - 1.96 * se, 4), round(mean + 1.96 * se, 4)],
            "max_match": max((mc for _r, mc, *_ in recs), default=0),
            "rate_3plus": round(sum(dist[3:]) / n, 4) if n else 0,
            "rate_4plus": round(sum(dist[4:]) / n, 4) if n else 0,
            "rate_5plus": round(sum(dist[5:]) / n, 5) if n else 0,
            "vs_random_mean_diff": round(mean - exp_mean, 4), "z": round(z, 3), "p_value": round(p, 4),
            "significant_bonferroni": bool(n >= 30 and p < alpha_b and mean > exp_mean),
            "small_sample": n < 30,
        })
    out.sort(key=lambda x: (-x["rounds"], -x["mean_matches"]))
    from ..stats_engine.probability import match_pmf

    pmf = [float(x) for x in match_pmf()]
    return {
        "prediction_type": ptype,
        "common_only": common_only,
        "common_rounds": ([common_rounds[0], common_rounds[-1], len(common_rounds)] if common_rounds else None),
        "theoretical": {"kind": "mathematical", "mean_matches": exp_mean,
                        "match_rates": {str(k): round(pmf[k], 6) for k in range(7)},
                        "rate_3plus": round(sum(pmf[3:]), 5), "rate_4plus": round(sum(pmf[4:]), 6),
                        "jackpot_per_combo": "1/8,145,060"},
        "methods": out,
        "multiple_testing": {"n_methods": len(methods), "bonferroni_alpha": round(alpha_b, 5)},
        "honesty": ("과거 기록(관측 성적)이며 미래 당첨확률을 바꾸지 않습니다. 30회 미만 표본은 비교 결론을 내리지 않습니다. "
                    "backtest·historical_replay 는 사후에 생성된 기록이고, 사전 예측은 live 뿐입니다."),
    }


def search(method: Optional[str] = None, ptype: Optional[str] = None, min_match: Optional[int] = None,
           limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    _ensure()
    sql = ("SELECT h.draw_round,h.prediction_method,h.prediction_type,h.prediction_rank,h.predicted_numbers,"
           "e.match_count,e.prize_tier,e.bonus_matched FROM round_prediction_history h LEFT JOIN round_prediction_evaluation e "
           "ON e.prediction_id = h.prediction_id WHERE 1=1")
    params: List[Any] = []
    if method:
        sql += " AND h.prediction_method = ?"
        params.append(method)
    if ptype:
        sql += " AND h.prediction_type = ?"
        params.append(ptype)
    if min_match is not None:
        sql += " AND e.match_count >= ?"
        params.append(int(min_match))
    sql += f" ORDER BY h.draw_round DESC, h.prediction_method LIMIT {int(limit)} OFFSET {int(offset)}"
    return [{"round": r[0], "method": r[1], "label": METHOD_LABELS.get(r[1], r[1]), "type": r[2], "rank": r[3],
             "numbers": db.loads(r[4]), "match_count": r[5], "prize_tier": r[6],
             "bonus_matched": bool(r[7]) if r[7] is not None else None} for r in db.query(sql, tuple(params))]


def summary() -> Dict[str, Any]:
    _ensure()
    rows = db.query("SELECT prediction_type, COUNT(*), MIN(draw_round), MAX(draw_round) FROM round_prediction_history "
                    "GROUP BY prediction_type")
    ev = db.query("SELECT COUNT(*) FROM round_prediction_evaluation")
    return {"by_type": {r[0]: {"count": int(r[1]), "first_round": r[2], "last_round": r[3]} for r in rows},
            "evaluated": int(ev[0][0]) if ev else 0}


def run_all(engine_rounds: int = 100) -> Dict[str, Any]:
    """정기 작업: 백테스트 보충 → 보관/유튜브 용지 재현 → 다음 회차 live → 평가."""
    from ..stats_engine.draws import load_draws

    out: Dict[str, Any] = {"stats": backtest_stats()}
    import os

    ens_budget = float(os.environ.get("ENSEMBLE_BACKTEST_BUDGET_SEC", "900"))
    for name, fn in (("engines", lambda: backtest_engines(engine_rounds)), ("archived", replay_archived_sheets),
                     ("youtube", youtube_ticket_predictions),
                     ("ensemble_backtest", lambda: backtest_ensemble(engine_rounds, ens_budget))):
        try:
            out[name] = fn()
        except Exception as exc:  # noqa: BLE001
            out[name] = {"error": str(exc)[:300]}
    draws = load_draws()
    if draws:
        try:
            out["live"] = create_live(draws[-1].round + 1)
        except Exception as exc:  # noqa: BLE001
            out["live"] = {"error": str(exc)[:300]}
    out["evaluate"] = evaluate_pending()
    return out


# ─────────────────────────────── 엔진 중복 추천 번호 순위 ───────────────────────────────

CONSENSUS_EXCLUDE = {"random_baseline", "v12_integrated"}  # 무작위·(엔진 추천을 다시 합친) V12 는 중복 집계에서 제외


def consensus_ranking(rnd: int) -> Dict[str, Any]:
    """선택 회차에서 여러 엔진이 함께 고른 번호 순위 + 전체 회차에서 'k개 엔진이 고른 번호'의 실제 적중률.

    중복 수는 '엔진들이 같은 과거 데이터로 비슷하게 계산했다'는 뜻이며 당첨 확률이 아니다 — 그래서 전체 회차
    실측(같은 중복 수 번호가 실제로 몇 % 당첨됐는지)을 무작위 6/45=13.3% 와 나란히 보여 준다."""
    import math

    from ..stats_engine.draws import load_draws

    _ensure()
    win = {d.round: set(d.numbers) for d in load_draws()}
    rows = db.query("SELECT draw_round, prediction_method, prediction_type, predicted_numbers FROM round_prediction_history "
                    "WHERE prediction_rank = 1 AND prediction_type IN ('backtest', 'live') AND prediction_status <> 'superseded'")
    by: Dict[Tuple[str, int], Dict[str, List[int]]] = {}
    for r, m, t, nums in rows:
        if m in CONSENSUS_EXCLUDE or m.startswith("v6_"):
            continue
        by.setdefault((t, int(r)), {})[m] = [int(x) for x in db.loads(nums)]

    def rank_round(t: str, r: int) -> Optional[Dict[str, Any]]:
        preds = by.get((t, r))
        if not preds:
            return None
        sel: Dict[int, List[str]] = {}
        for m, nums in preds.items():
            for n in nums:
                sel.setdefault(n, []).append(m)
        ranked = sorted(sel.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        w = win.get(r)
        items, pos, prev = [], 0, None
        for i, (n, ms) in enumerate(ranked, start=1):
            if len(ms) != prev:
                pos, prev = i, len(ms)
            items.append({"rank": pos, "number": n, "engines": len(ms), "methods": sorted(ms),
                          "labels": [METHOD_LABELS.get(m, m) for m in sorted(ms)], "drawn": (n in w) if w else None})
        top = [x for x in items if x["engines"] >= 2]
        return {"type": t, "round": r, "engine_count": len(preds), "numbers": items,
                "multi_engine_numbers": [x["number"] for x in top],
                "multi_engine_hits": sum(1 for x in top if x["drawn"]) if w else None, "result_known": w is not None}

    # 회차별 기준(2026-11-14): 임의의 '직전 100회' 창을 없애고, 회차마다 그 회차 자체의 중복 수별 선택·당첨을 한 줄씩 기록한다.
    # 누적 비율은 '선택 회차 이전 모든 회차' 행들의 합(미래 회차 미포함). 엔진이 2개 이상 기록된 백테스트 회차만 사용.
    def lv_key(k: int) -> str:
        return "5+" if k >= 5 else str(k)

    def round_row(r: int, preds: Dict[str, List[int]], w: Optional[set]) -> Dict[str, Any]:
        cnt: Dict[int, int] = {}
        for nums in preds.values():
            for n in nums:
                cnt[n] = cnt.get(n, 0) + 1
        mx = max(cnt.values())
        tops = sorted([n for n, k in cnt.items() if k >= 3 or (k == mx and k >= 2)])
        levels_r: Dict[str, List[int]] = {}
        for n, k in cnt.items():
            if k < 2:
                continue
            v = levels_r.setdefault(lv_key(k), [0, 0])
            v[0] += 1
            v[1] += int(bool(w) and n in w)
        multi = [n for n, k in cnt.items() if k >= 2]
        return {"round": r, "engines": len(preds), "max_overlap": mx, "result_known": w is not None,
                "levels": {k: {"picks": v[0], "hits": v[1] if w else None} for k, v in sorted(levels_r.items())},
                "multi_picks": len(multi), "multi_hits": sum(1 for n in multi if n in w) if w else None,
                "top_numbers": tops, "top_hits": sorted(n for n in tops if w and n in w),
                "winning": sorted(w) if w else None}, cnt, tops

    past = sorted(r for (t, r) in by if t == "backtest" and r in win and r < int(rnd) and len(by[(t, r)]) >= 2)
    W = None
    lvl: Dict[int, List[int]] = {}
    num_top: Dict[int, List[int]] = {}
    history = []
    for r in past:
        row, cnt, tops = round_row(r, by[("backtest", r)], win[r])
        for n, k in cnt.items():
            v = lvl.setdefault(min(k, 6), [0, 0])
            v[0] += 1
            v[1] += int(n in win[r])
        for n in tops:
            s_ = num_top.setdefault(n, [0, 0, [], []])
            s_[0] += 1
            s_[1] += int(n in win[r])
            s_[2 if n in win[r] else 3].append(r)
        history.append(row)
    # 선택 회차 자체의 중복 수별 결과(그 회차 한 회만)
    this_round = None
    for t in ("backtest", "live"):
        if by.get((t, int(rnd))) and len(by[(t, int(rnd))]) >= 2:
            this_round = dict(round_row(int(rnd), by[(t, int(rnd))], win.get(int(rnd)))[0], type=t)
            break
    p0 = 6 / 45
    levels = []
    for k in sorted(lvl):
        n, h = lvl[k]
        rate = h / n
        se = math.sqrt(rate * (1 - rate) / n) if n else 0
        z = (h - n * p0) / math.sqrt(n * p0 * (1 - p0)) if n else 0
        levels.append({"engines": f"{k}개 이상" if k == 6 else f"{k}개", "picks": n, "hits": h, "hit_rate": round(rate, 4),
                       "ci95": [round(max(0, rate - 1.96 * se), 4), round(rate + 1.96 * se, 4)], "random_rate": round(p0, 4),
                       "lift": round(rate / p0, 3), "p_two_sided": round(math.erfc(abs(z) / math.sqrt(2)), 4)})
    alpha = 0.05 / max(1, len(levels))
    sig = [x for x in levels if x["p_two_sided"] < alpha and x["picks"] >= 100]
    all_rank = sorted(({"number": n, "times_top": v[0], "hits": v[1], "hit_rate": round(v[1] / v[0], 4),
                        "hit_rounds": v[2][-8:], "miss_rounds": v[3]}
                       for n, v in num_top.items()), key=lambda x: (-x["times_top"], x["number"]))
    # 선택 회차에서 중복된 번호 각각의 '이전 회차들에서 중복 상위였을 때 실제 당첨' 회차별 기록
    sel = rank_round("backtest", int(rnd)) or rank_round("live", int(rnd))
    track = []
    if sel:
        nt = dict((x["number"], x) for x in all_rank)
        for x in sel["numbers"]:
            if x["engines"] < 2:
                continue
            rec = nt.get(x["number"], {"times_top": 0, "hits": 0, "hit_rate": None, "hit_rounds": [], "miss_rounds": []})
            track.append({"number": x["number"], "engines_now": x["engines"], "past_times_top": rec["times_top"],
                          "past_hits": rec["hits"], "past_hit_rate": rec["hit_rate"], "drawn": x["drawn"],
                          "hit_rounds": list(reversed(rec["hit_rounds"])), "recent_miss_rounds": list(reversed(rec["miss_rounds"][-8:])),
                          "miss_count": len(rec["miss_rounds"])})
    rng_txt = f"{past[0]}~{past[-1]}회" if past else "-"
    out = {"round": int(rnd), "backtest": rank_round("backtest", int(rnd)), "live": rank_round("live", int(rnd)),
           "this_round": this_round,
           "all_rounds": {"basis": "per_round_rows", "window": W, "range": rng_txt, "rounds": len(past),
                          "by_engine_count": levels, "bonferroni_alpha": round(alpha, 4),
                          "top_consensus_numbers": all_rank[:15], "selected_round_track": track,
                          "per_round": list(reversed(history[-30:])),  # 화면은 선택 회차만 사용 — 응답 경량화
                          "recent_history": list(reversed(history[-15:])),
                          "verdict": (f"{rnd}회 이전 {len(past)}개 회차 합계 기준, 중복 수가 많은 번호의 실제 적중률이 무작위 13.3%와 보정 후 다른 수준이 있음"
                                      f"({', '.join(x['engines'] for x in sig)}) — 재현 확인 필요" if sig else
                                      f"{rnd}회 이전 {len(past)}개 회차 합계 기준, 여러 엔진이 겹쳐 고른 번호의 실제 적중률은 무작위(13.3%)와 "
                                      "통계적으로 같습니다 — 중복은 엔진들이 같은 과거 데이터로 비슷하게 계산한 결과입니다.")},
           "note": "순위는 '몇 개 엔진이 함께 골랐는지'이며 당첨 확률 순위가 아닙니다. 모든 번호의 당첨 확률은 6/45로 같습니다."}
    return out
