"""자동 파이프라인 작업 실행기 — 잠금·재시도·오류 종류 기록·독립 작업 단위.

흐름(PHASE 13)
-------------
daily_pipeline()
  1. sync_rounds        : 유튜브 RSS/API 수집 → 공식 최신 회차 확인 → 누락 회차 공식 조회·검증 → 정식 저장·CSV
  2. (신규 회차가 있을 때) on_new_rounds:
       stats_refresh      : 회차 통계·전체 이력 백테스트·티켓 백테스트 재계산(데이터 시그니처 캐시)
       backtest_log       : 신규 회차에 대한 전략별 예측(그 회차 이전 데이터만) 저장·채점
       learning_engines   : 6종 학습 엔진 — 입력(보관 용지) 시그니처가 바뀐 경우에만 재학습
  각 작업은 독립적으로 실패해도 다음 작업은 계속된다. 모든 실행은 reg_jobs 에 기록.

잠금: reg_locks(이름·만료) — 다중 워커/중복 스케줄에서도 같은 작업이 동시에 돌지 않는다.
만료(기본 30분)가 지난 잠금은 고아로 보고 회수한다(서버 재시작 후 자가 복구).
"""
from __future__ import annotations

import logging
import os
import socket
import time
import traceback
import uuid
from typing import Any, Callable, Dict, List, Optional

from . import db

logger = logging.getLogger(__name__)
_OWNER = f"{socket.gethostname()}:{os.getpid()}"

LEARNING_ENGINES = {
    "feature_learning": "Feature 학습",
    "nested_cv": "Nested CV",
    "shap_drift": "SHAP/Drift",
    "pattern_mining": "Pattern Mining",
    "round_learning": "Round 학습",
    "overlap_learning": "Overlap 학습",
}
STATS_ENGINES = {
    "window_stats": "표본 크기별 통계",
    "full_history_backtest": "전체 이력 백테스트",
    "ticket_backtest": "6개 1장 백테스트",
}
# 상태 어휘(PHASE 5)
S_IDLE, S_COLLECT, S_VERIFY, S_TRAIN, S_DONE, S_FAIL, S_NODATA, S_REVERIFY = (
    "대기", "데이터 수집", "데이터 검증", "학습 중", "완료", "실패", "데이터 부족", "재검증 필요")


# ─────────────────────────────── 잠금 ───────────────────────────────

def acquire_lock(name: str, ttl_sec: float = 1800.0) -> bool:
    now = time.time()
    with db.transaction() as c:
        c.execute("DELETE FROM reg_locks WHERE name = ? AND expires_at < ?", (name, now))  # 고아 잠금 회수
        try:
            c.execute("INSERT INTO reg_locks (name, owner, expires_at) VALUES (?,?,?)", (name, _OWNER, now + ttl_sec))
        except Exception:  # noqa: BLE001 — PK 충돌 = 다른 실행이 보유 중
            return False
    return True


def release_locks_from_previous_containers() -> int:
    """부팅 시 — 이전 컨테이너(다른 호스트명)가 남긴 잠금을 회수(재배포로 프로세스가 사라져 영구 '실행 중' 방지).
    운영은 단일 인스턴스라 다른 호스트의 잠금 = 죽은 프로세스의 잠금."""
    host = socket.gethostname()
    rows = db.query("SELECT name, owner FROM reg_locks")
    stale = [n for n, o in rows if not str(o).startswith(host + ":")]
    with db.transaction() as c:
        for n in stale:
            c.execute("DELETE FROM reg_locks WHERE name = ?", (n,))
        # 같은 이유로 'running' 으로 멈춘 작업 기록을 중단 처리(재시도 대상임을 표시)
        c.execute("UPDATE reg_jobs SET status = 'aborted_restart', finished_at = ? WHERE status = 'running'",
                  (db.now_iso(),))
    return len(stale)


def release_lock(name: str) -> None:
    with db.transaction() as c:
        c.execute("DELETE FROM reg_locks WHERE name = ? AND owner = ?", (name, _OWNER))


def _classify_error(exc: BaseException) -> str:
    kind = getattr(exc, "kind", None)
    if kind:
        return str(kind)
    name = type(exc).__name__.lower()
    if "timeout" in name:
        return "timeout"
    if "connection" in name or "urlerror" in name:
        return "network"
    return "error"


def run_job(name: str, fn: Callable[[], Dict[str, Any]], *, retries: int = 2, backoff: float = 5.0,
            lock: bool = True, retry_on: tuple = ("network", "timeout", "http", "api_error", "error")) -> Dict[str, Any]:
    """작업 1개 실행 — 잠금, 재시도(일시 오류만), 시도별 기록."""
    if lock and not acquire_lock(f"job:{name}"):
        rec = {"name": name, "status": "skipped_locked", "message": "같은 작업이 이미 실행 중 — 중복 실행 차단"}
        _record(name, "skipped_locked", 0, None, None, rec)
        return rec
    try:
        attempt = 0
        while True:
            attempt += 1
            jid = uuid.uuid4().hex
            started = db.now_iso()
            _write_job(jid, name, "running", attempt, started)
            try:
                detail = fn() or {}
                _write_job(jid, name, "success", attempt, started, finished=db.now_iso(), detail=detail)
                return {"name": name, "status": "success", "attempt": attempt, "detail": detail}
            except Exception as exc:  # noqa: BLE001
                kind = _classify_error(exc)
                _write_job(jid, name, "failed", attempt, started, finished=db.now_iso(), error_kind=kind,
                           error=f"{exc}"[:1000], detail={"trace": traceback.format_exc()[-1500:]})
                logger.warning("[pipeline] %s 실패(%s, 시도 %d): %s", name, kind, attempt, exc)
                if attempt > retries or kind not in retry_on:
                    return {"name": name, "status": "failed", "attempt": attempt, "error_kind": kind, "error": str(exc)}
                time.sleep(backoff * attempt)
    finally:
        if lock:
            release_lock(f"job:{name}")


def _write_job(jid, name, status, attempt, started, *, finished=None, error_kind=None, error=None, detail=None):
    try:
        with db.transaction() as c:
            c.execute(
                "INSERT INTO reg_jobs (id,name,status,attempt,started_at,finished_at,error_kind,error,detail_json) "
                "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET status=excluded.status, "
                "finished_at=excluded.finished_at, error_kind=excluded.error_kind, error=excluded.error, "
                "detail_json=excluded.detail_json",
                (jid, name, status, attempt, started, finished, error_kind, error, db.dumps(detail) if detail else None),
            )
    except Exception:  # noqa: BLE001 — 기록 실패가 작업을 막지 않게
        logger.exception("job 기록 실패")


def _record(name, status, attempt, error_kind, error, detail):
    _write_job(uuid.uuid4().hex, name, status, attempt, db.now_iso(), finished=db.now_iso(),
               error_kind=error_kind, error=error, detail=detail)


# ─────────────────────────────── 엔진 상태 ───────────────────────────────

def set_engine(engine: str, category: str, status: str, **kw: Any) -> None:
    cols = {"category": category, "status": status, **kw}
    if "summary" in cols:
        cols["summary_json"] = db.dumps(cols.pop("summary"))
    with db.transaction() as c:
        c.execute("INSERT INTO reg_engines (engine, category, status) VALUES (?,?,?) ON CONFLICT (engine) DO NOTHING",
                  (engine, category, status))
        sets = ", ".join(f"{k} = ?" for k in cols)
        c.execute(f"UPDATE reg_engines SET {sets} WHERE engine = ?", (*cols.values(), engine))


def engines() -> List[Dict[str, Any]]:
    rows = db.query("SELECT engine,category,status,input_signature,last_round,last_run_at,duration_sec,summary_json,"
                    "error,attempts,algorithm_version FROM reg_engines ORDER BY category, engine")
    labels = {**LEARNING_ENGINES, **STATS_ENGINES}
    return [{"engine": r[0], "label": labels.get(r[0], r[0]), "category": r[1], "status": r[2],
             "input_signature": r[3], "last_round": r[4], "last_run_at": r[5], "duration_sec": r[6],
             "summary": db.loads(r[7]), "error": r[8], "attempts": r[9], "algorithm_version": r[10]} for r in rows]


def _engine_row(engine: str) -> Optional[Dict[str, Any]]:
    for e in engines():
        if e["engine"] == engine:
            return e
    return None


# ─────────────────────────────── 1. 회차 동기화 ───────────────────────────────

def sync_rounds(max_new: int = 20) -> Dict[str, Any]:
    from . import official, registry, youtube

    out: Dict[str, Any] = {"errors": []}
    seed = registry.seed_from_csv()
    out["seeded"] = seed
    restored = registry.restore_csv_from_registry()
    out["csv_restored"] = restored

    # 유튜브 수집(실패해도 계속 — 공식이 최종 기준)
    csv_latest = max(registry.read_csv_rows() or {0: None})
    try:
        yt = youtube.discover(round_hint=csv_latest + 1)
        out["youtube_videos"] = registry.record_youtube(yt["videos"])
        out["youtube_result_videos"] = sum(1 for v in yt["videos"] if v.extracted.get("kind") == "result")
        out["errors"].extend({"stage": "youtube", **e} for e in yt["errors"] if e["kind"] != "no_api_key")
        out["youtube_api"] = "rss_only" if any(e["kind"] == "no_api_key" for e in yt["errors"]) else "api+rss"
    except Exception as exc:  # noqa: BLE001
        out["errors"].append({"stage": "youtube", "kind": _classify_error(exc), "error": str(exc)})

    # 공식 최신 회차
    try:
        latest = official.fetch_latest_round(csv_latest)
        out["official_latest"] = latest
    except official.OfficialError as exc:
        out["errors"].append({"stage": "official_latest", "kind": exc.kind, "error": str(exc)})
        out["official_latest"] = None
        out["results"] = []
        # 공식 접근 불가 — 유튜브가 알린 신규 회차는 미검증 스테이징만
        for rnd in sorted({v["round"] for v in _youtube_rounds_after(csv_latest)})[:max_new]:
            out["results"].append(registry.ingest_round(rnd, None, official_error=exc.kind))
        out["new_rounds"] = []
        return out

    results = []
    new_rounds: List[int] = []
    for rnd in range(csv_latest + 1, min(latest, csv_latest + max_new) + 1):
        try:
            off = official.fetch_round(rnd)
        except official.OfficialError as exc:
            if exc.kind == "not_published":
                results.append({"round": rnd, "status": "not_published"})
                break  # 아직 발표 전 — 이전 데이터 유지
            results.append(registry.ingest_round(rnd, None, official_error=exc.kind))
            continue
        res = registry.ingest_round(rnd, off, secondary=_secondary(rnd))
        results.append(res)
        if res["status"] == "committed":
            new_rounds.append(rnd)
    out["results"] = results
    out["new_rounds"] = new_rounds
    return out


def _youtube_rounds_after(rnd: int) -> List[Dict[str, Any]]:
    rows = db.query("SELECT DISTINCT round FROM reg_youtube WHERE kind='result' AND round > ?", (int(rnd),))
    return [{"round": int(r[0])} for r in rows if r[0]]


def _secondary(rnd: int) -> Optional[Dict[str, Any]]:
    """기존 보조 크롤러(lottis.kr) — 교차 확인용(실패해도 무시)."""
    if os.environ.get("INGEST_DISABLE_SECONDARY"):
        return None
    try:
        from ..round_upgrade import _crawl_module

        mod = _crawl_module()
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            payload = mod.fetch_lottis_round(rnd, timeout=10.0)
        if not payload:
            return None
        row = mod.parse_row(payload) if "drwtNo1" in payload else payload
        nums = sorted(int(row[f"num{i}"]) for i in range(1, 7))
        return {"source": "lottis.kr", "numbers": nums, "bonus": int(row["bonus"]), "draw_date": row.get("draw_date")}
    except Exception:  # noqa: BLE001
        return None


def verify_history(first: int = 1, last: Optional[int] = None, max_rounds: int = 300) -> Dict[str, Any]:
    """기존 회차를 공식과 대조(덮어쓰기 없음) — 실행당 최대 max_rounds 회차씩 '미대조 최신 회차부터'
    점진 감사한다(운영에서 대량 연속 요청 타임아웃 대응). 부분 성공도 진행분은 저장된다."""
    from . import official, registry

    registry.seed_from_csv()
    last = last or max(registry.read_csv_rows() or {0: None})
    pending = sorted((int(r[0]) for r in db.query(
        "SELECT round FROM reg_draws WHERE verification_status = ? AND round BETWEEN ? AND ?",
        (registry.STATUS_LEGACY, int(first), int(last)))), reverse=True)[:max_rounds]
    if not pending:
        return {"newly_verified": 0, "remaining": 0, "message": "미대조 회차 없음"}
    failures: List[Dict[str, Any]] = []
    offs = official.fetch_range(min(pending), max(pending), failures=failures)
    offs = {k: v for k, v in offs.items() if k in set(pending)}
    res = registry.verify_existing(offs)
    remaining = db.query("SELECT COUNT(*) FROM reg_draws WHERE verification_status = ?", (registry.STATUS_LEGACY,))
    res.update(official_fetched=len(offs), range=[min(pending), max(pending)], failed_windows=failures[:10],
               failed_window_count=len(failures), remaining=int(remaining[0][0]) if remaining else None)
    if not offs and failures:
        raise official.OfficialError(failures[0]["kind"], f"공식 대조 전부 실패({len(failures)}창): {failures[0]['error']}")
    return res


def verify_round(round_no: int) -> Dict[str, Any]:
    """단일 회차 공식 대조(덮어쓰기 없음) — 네트워크 오류와 데이터 불일치를 구분해 반환."""
    from . import official, registry

    registry.seed_from_csv()
    try:
        off = official.fetch_round(int(round_no))
    except official.OfficialError as exc:
        return {"round": round_no, "ok": False, "error_class": "network" if exc.kind in ("network", "http", "blocked") else "data",
                "kind": exc.kind, "error": str(exc)}
    res = registry.verify_existing({off.round: off})
    return {"round": round_no, "ok": not res["conflicts"], "error_class": "data" if res["conflicts"] else None, **res}


def verify_all_history() -> Dict[str, Any]:
    """남은 미대조 회차를 끝까지(300회차 단위 반복) — 각 묶음 실패는 기록하고 계속."""
    total = {"newly_verified": 0, "conflicts": [], "failed_windows": 0, "batches": 0}
    for _ in range(10):
        r = verify_history(max_rounds=300)
        total["batches"] += 1
        total["newly_verified"] += r.get("newly_verified", 0)
        total["conflicts"] += r.get("conflicts", [])
        total["failed_windows"] += r.get("failed_window_count", 0)
        total["remaining"] = r.get("remaining", 0)
        if not r.get("remaining") or not r.get("newly_verified"):
            break
    return total


retry_failed_history = verify_history  # 미대조(실패 포함) 회차만 다시 시도 — 동일 로직(점진·멱등)


def last_successful_verification() -> Dict[str, Any]:
    rows = db.query("SELECT name, finished_at, detail_json FROM reg_jobs WHERE status = 'success' AND name IN "
                    "('verify_history','sync_rounds') ORDER BY finished_at DESC LIMIT 2")
    last = db.query("SELECT MAX(last_verified_at) FROM reg_draws WHERE verification_status = 'official_verified'")
    return {"jobs": [{"name": r[0], "finished_at": r[1]} for r in rows],
            "last_round_verified_at": last[0][0] if last else None}


# ─────────────────────────────── 2. 신규 회차 후속 작업 ───────────────────────────────

def stats_refresh() -> Dict[str, Any]:
    from ..stats_engine import cache as stats_cache
    from ..stats_engine.backtest import build_full_history_backtest, build_ticket_backtest
    from ..stats_engine.draws import history_signature
    from ..stats_engine.windows import build_window_stats

    sig = history_signature()
    out = {}
    for name, fn, ver in (("window_stats", build_window_stats, "window-stats-1.0"),
                          ("full_history_backtest", build_full_history_backtest, "full-history-backtest-2.0"),
                          ("ticket_backtest", build_ticket_backtest, "ticket-backtest-1.0")):
        prev = _engine_row(name)
        if prev and prev["input_signature"] == sig and prev["status"] == S_DONE:
            out[name] = "skip(same data)"
            fn()  # 캐시 프리워밍만
            continue
        set_engine(name, "draw_data", S_TRAIN)
        t0 = time.time()
        try:
            r = fn()
            summ = {"tested_rounds": r.get("tested_rounds"), "any_beats_random": r.get("any_beats_random"),
                    "latest_round": r.get("latest_round") or r.get("last_tested_round")}
            if name == "window_stats":
                summ["any_significant"] = (r.get("multiple_testing") or {}).get("any_significant")
            set_engine(name, "draw_data", S_DONE, input_signature=sig, last_run_at=db.now_iso(),
                       duration_sec=round(time.time() - t0, 2), summary=summ, error=None, algorithm_version=ver,
                       last_round=summ.get("latest_round"))
            out[name] = "ok"
        except Exception as exc:  # noqa: BLE001
            set_engine(name, "draw_data", S_FAIL, error=str(exc)[:500], last_run_at=db.now_iso())
            out[name] = f"failed: {exc}"
    # 점진 갱신 정합성: 캐시를 비우고 전체 재계산한 결과와 일치하는지 주기 검사
    out["consistency"] = check_incremental_consistency()
    stats_cache.info()
    return out


def check_incremental_consistency() -> Dict[str, Any]:
    """캐시된(점진) 윈도우 통계 == 캐시 없이 원본에서 전체 재계산한 값인지 검사."""
    from ..stats_engine.draws import load_draws
    from ..stats_engine.windows import build_window_stats

    cached = build_window_stats()
    fresh = build_window_stats(draws=load_draws())
    a = [(w["window"], [n["count"] for n in w.get("numbers", [])]) for w in cached["windows"]]
    b = [(w["window"], [n["count"] for n in w.get("numbers", [])]) for w in fresh["windows"]]
    return {"consistent": a == b, "checked_at": db.now_iso()}


BACKTEST_LOG_VERSION = "strategy-ranks-1.0"


def backtest_log(rounds: Optional[List[int]] = None, last_n: int = 0) -> Dict[str, Any]:
    """회차별 전략 예측(그 회차 이전 데이터만)을 저장·채점. 이미 저장된 (회차,전략,버전)은 건너뜀."""
    from ..stats_engine.backtest import STRATEGY_LABELS, _rankings
    from ..stats_engine.draws import load_draws
    from ..stats_engine.probability import prize_rank

    draws = load_draws()
    idx_by_round = {d.round: i for i, d in enumerate(draws)}
    targets = list(rounds or [])
    if last_n:
        targets += [d.round for d in draws[-last_n:]]
    targets = sorted({r for r in targets if r in idx_by_round and idx_by_round[r] >= 50})
    have = {(int(r[0]), r[1]) for r in db.query(
        "SELECT round, strategy FROM reg_backtest_log WHERE algorithm_version = ?", (BACKTEST_LOG_VERSION,))}
    written = 0
    with db.transaction() as c:
        for rnd in targets:
            i = idx_by_round[rnd]
            prior = draws[:i]  # ⚠️ 해당 회차 이전만
            freq = [0] * 46
            last_seen = [0] * 46
            pair = [[0] * 46 for _ in range(46)]
            for j, d in enumerate(prior):
                for w in d.numbers:
                    freq[w] += 1
                    last_seen[w] = j + 1
                for a in range(6):
                    for b in range(a + 1, 6):
                        x, y = d.numbers[a], d.numbers[b]
                        pair[x][y] += 1
                        pair[y][x] += 1
            ranks = _rankings(freq, last_seen, pair, list(prior[-1].numbers), len(prior))
            actual = draws[i]
            for s in STRATEGY_LABELS:
                if (rnd, s) in have:
                    continue
                pick = sorted(ranks[s][:6])
                m = len(set(pick) & set(actual.numbers))
                c.execute(
                    "INSERT INTO reg_backtest_log (round,strategy,algorithm_version,generated_at,data_first_round,"
                    "data_last_round,predicted_json,actual_json,bonus,matches,bonus_match,prize_rank) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (round, strategy, algorithm_version) DO NOTHING",
                    (rnd, s, BACKTEST_LOG_VERSION, db.now_iso(), prior[0].round, prior[-1].round, db.dumps(pick),
                     db.dumps(list(actual.numbers)), actual.bonus, m, int(actual.bonus in pick),
                     prize_rank(pick, actual.numbers, actual.bonus)),
                )
                written += 1
    return {"rounds": targets[-5:], "written": written, "algorithm_version": BACKTEST_LOG_VERSION}


def backtest_log_summary() -> Dict[str, Any]:
    rows = db.query("SELECT strategy, COUNT(*), AVG(matches), SUM(CASE WHEN matches>=3 THEN 1 ELSE 0 END), "
                    "MIN(round), MAX(round), MAX(generated_at) FROM reg_backtest_log WHERE algorithm_version = ? "
                    "GROUP BY strategy", (BACKTEST_LOG_VERSION,))
    return {"algorithm_version": BACKTEST_LOG_VERSION, "random_expected_mean": 0.8,
            "strategies": [{"strategy": r[0], "rounds": int(r[1]), "mean_matches": round(float(r[2] or 0), 4),
                            "three_plus": int(r[3] or 0), "first_round": r[4], "last_round": r[5], "updated_at": r[6]}
                           for r in rows]}


def _learning_inputs() -> Dict[str, Any]:
    from ..video_analysis.feature_learning_engine import collect_round_samples
    from ..video_analysis.store import store_signature
    from ..stats_engine.draws import history_signature

    samples = collect_round_samples()
    return {"samples": len(samples), "rounds": sorted({s.round_no for s in samples}),
            "signature": f"{store_signature()}|{history_signature()}|n={len(samples)}"}


def learning_engines(force: bool = False) -> Dict[str, Any]:
    """6종 학습 엔진 — 입력은 '보관 용지(자동/반자동) + 실제 당첨'. 회차 데이터만으로는 학습 불가.

    - 보관 표본 0 → 데이터 부족(자동 실행 차단)
    - 입력 시그니처 동일 → 중복 학습 방지(이전 결과 유지)
    - 그 외 → 실행·결과 요약 저장
    """
    from ..video_analysis.feature_learning_engine import build_feature_learning, collect_round_samples
    from ..video_analysis.nested_cv import run_nested_feature_cv
    from ..video_analysis.overlap_learning import build_overlap_learning
    from ..video_analysis.pattern_mining_engine import build_pattern_mining
    from ..video_analysis.round_learning import build_round_learning
    from ..video_analysis.shap_drift_stub import build_shap_drift_report

    inp = _learning_inputs()
    runners: Dict[str, Callable[[], Any]] = {
        "feature_learning": lambda: build_feature_learning(seed=42, apply_intent="current_round"),
        "nested_cv": lambda: run_nested_feature_cv(collect_round_samples(), seed=42),
        "shap_drift": lambda: build_shap_drift_report(collect_round_samples(), seed=42),
        "pattern_mining": lambda: build_pattern_mining(seed=42, apply_intent="current_round"),
        "round_learning": lambda: build_round_learning(apply_intent="current_round"),
        "overlap_learning": lambda: build_overlap_learning(apply_intent="current_round"),
    }
    out: Dict[str, Any] = {"input_samples": inp["samples"], "input_rounds": inp["rounds"][-5:]}
    for name, fn in runners.items():
        prev = _engine_row(name)
        if inp["samples"] == 0:
            set_engine(name, "sheet_dependent", S_NODATA, input_signature=inp["signature"], last_run_at=db.now_iso(),
                       summary={"reason": "보관 용지(자동/반자동) 표본 0 — 당첨번호만으로는 학습 불가", "samples": 0},
                       error=None)
            out[name] = S_NODATA
            continue
        if not force and prev and prev["input_signature"] == inp["signature"] and prev["status"] == S_DONE:
            out[name] = "skip(same input)"
            continue
        set_engine(name, "sheet_dependent", S_TRAIN, attempts=(prev or {}).get("attempts", 0) + 1)
        t0 = time.time()
        try:
            res = fn() or {}
            summ = {k: res.get(k) for k in ("ok", "n_rounds", "verdict", "scoring_allowed", "reason", "status")
                    if isinstance(res, dict) and k in res and not isinstance(res.get(k), (list, dict))}
            if isinstance(res, dict) and isinstance(res.get("rounds"), list):
                summ["result_rounds"] = len(res["rounds"])
            summ["samples"] = inp["samples"]
            summ["sample_rounds"] = [inp["rounds"][0], inp["rounds"][-1]] if inp["rounds"] else []
            set_engine(name, "sheet_dependent", S_DONE, input_signature=inp["signature"], last_run_at=db.now_iso(),
                       duration_sec=round(time.time() - t0, 2), summary=summ, error=None,
                       last_round=inp["rounds"][-1] if inp["rounds"] else None)
            out[name] = S_DONE
        except Exception as exc:  # noqa: BLE001
            set_engine(name, "sheet_dependent", S_FAIL, error=str(exc)[:500], last_run_at=db.now_iso(),
                       duration_sec=round(time.time() - t0, 2))
            out[name] = f"{S_FAIL}: {exc}"
    return out


# ─────────────────────────────── 3. 통합 파이프라인 ───────────────────────────────

def daily_pipeline(force_followups: bool = False) -> Dict[str, Any]:
    """PHASE 13 — 독립 작업 단위의 연결. 상위 잠금으로 파이프라인 전체 중복 실행 방지."""
    if not acquire_lock("pipeline:daily", ttl_sec=3600):
        return {"status": "skipped_locked"}
    try:
        report: Dict[str, Any] = {"started_at": db.now_iso()}
        sync = run_job("sync_rounds", sync_rounds, retries=2)
        report["sync_rounds"] = sync
        new_rounds = ((sync.get("detail") or {}).get("new_rounds")) or []
        # 기존 회차 중 아직 공식 대조 전(legacy)이 있으면 전수 감사 1회(덮어쓰기 없음)
        legacy = db.query("SELECT COUNT(*) FROM reg_draws WHERE verification_status = 'legacy_unverified'")
        if legacy and int(legacy[0][0] or 0) > 0:
            report["verify_history"] = run_job("verify_history", verify_history, retries=1)
        first_run = not engines() or not db.query("SELECT 1 FROM reg_backtest_log LIMIT 1")
        if new_rounds or force_followups or first_run:
            report["stats_refresh"] = run_job("stats_refresh", stats_refresh, retries=1)
            report["backtest_log"] = run_job(
                "backtest_log",
                lambda: backtest_log(rounds=new_rounds, last_n=100000 if first_run else (0 if new_rounds else 10)),
                retries=1)
            report["learning_engines"] = run_job("learning_engines", learning_engines, retries=1)
            report["ensemble_check"] = run_job("ensemble_check", ensemble_check, retries=0)
        else:
            report["followups"] = "신규 회차 없음 — 후속 작업 생략(이전 결과 유지)"
        # 회차별 예측 기록(매일): 백테스트 보충·다음 회차 사전 예측(cutoff 전만)·공식 결과 자동 평가
        from . import predictions as _pred

        report["predictions"] = run_job("predictions", lambda: _pred.run_all(engine_rounds=100), retries=1)
        # V8 자동 감사(매일) — 경고만 기록, 자동 교체 없음. 개선 실험은 신규 회차가 있을 때만(과도한 재학습 방지)
        from . import engine_audit as _audit

        report["engine_audit"] = run_job("engine_audit", _audit.run_audit, retries=0)
        if new_rounds:
            report["improvement_experiment"] = run_job("improvement_experiment", _audit.improvement_experiment, retries=0)
        report["finished_at"] = db.now_iso()
        return report
    finally:
        release_lock("pipeline:daily")


def ensemble_check() -> Dict[str, Any]:
    """앙상블 검증 — 생성 조합 유효성(6개·1~45·중복 없음·조합 중복 없음) + 확률 표기."""
    from ..analytics import generate_ensemble_sets
    from ..database import load_history

    r = generate_ensemble_sets(load_history(), n_sets=10, seed=42)
    sets = [tuple(c["numbers"]) for c in r["combinations"]]
    ok = (len(sets) == len(set(sets)) and all(len(s) == 6 and len(set(s)) == 6 and all(1 <= n <= 45 for n in s) for s in sets))
    return {"valid": ok, "sets": len(sets), "target_round": r.get("target_round"),
            "probability": r.get("probability", {}).get("jackpot_probability"),
            "weights": r.get("engine_weights"), "params": r.get("params")}


def status() -> Dict[str, Any]:
    from . import registry

    jobs = db.query("SELECT name,status,attempt,started_at,finished_at,error_kind,error FROM reg_jobs "
                    "ORDER BY started_at DESC LIMIT 40")
    last_by_name: Dict[str, Any] = {}
    errors = []
    for r in jobs:
        rec = {"name": r[0], "status": r[1], "attempt": r[2], "started_at": r[3], "finished_at": r[4],
               "error_kind": r[5], "error": r[6]}
        last_by_name.setdefault(r[0], rec)
        if r[1] == "failed" and len(errors) < 8:
            errors.append(rec)
    return {"registry": registry.summary(), "jobs": last_by_name, "recent_errors": errors,
            "engines": engines(), "backtest_log": backtest_log_summary()}
