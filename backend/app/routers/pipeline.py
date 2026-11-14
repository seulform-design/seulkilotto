"""자동 수집·검증 파이프라인 API (/api/v1/pipeline).

읽기(GET)는 누구나, 실행(POST)은 UPGRADE_API_KEY 가 설정돼 있으면 X-Upgrade-Key 필요.
무거운 실행은 백그라운드 스레드에서 돌고 즉시 202 형태로 응답한다(게이트웨이 60초 제한 회피).
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Query

from ..config import settings
from ..json_utils import to_jsonable

router = APIRouter(prefix="/api/v1/pipeline", tags=["pipeline"])
_RUNNING: Dict[str, threading.Thread] = {}


def _auth(key: Optional[str]) -> None:
    from ..security import key_matches

    if not key_matches(key):
        raise HTTPException(status_code=401, detail="X-Upgrade-Key 가 필요합니다.")


def _bg(name: str, fn) -> Dict[str, Any]:
    t = _RUNNING.get(name)
    if t is not None and t.is_alive():
        return {"started": False, "reason": "이미 실행 중", "job": name}
    th = threading.Thread(target=fn, name=f"pipeline-{name}", daemon=True)
    _RUNNING[name] = th
    th.start()
    return {"started": True, "job": name, "note": "백그라운드 실행 — /api/v1/pipeline/status 에서 진행 확인"}


@router.get("/status")
def get_status():
    """최신 회차·마지막 수집/검증 시각·작업별 최근 상태·최근 오류·6종 학습 엔진·백테스트 로그 요약."""
    from ..ingest import db, jobs

    try:
        st = jobs.status()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"파이프라인 상태 조회 실패: {exc}") from exc
    st["storage"] = {"backend": db.backend(),
                     "persistent": db.backend() == "postgres",
                     "note": ("운영 Postgres(재배포에도 영구)" if db.backend() == "postgres"
                              else "로컬 SQLite(draw_registry.db, WAL) — 컨테이너에서는 재배포 시 초기화")}
    st["running"] = [k for k, t in _RUNNING.items() if t.is_alive()]
    try:
        from ..video_analysis.store import _load_historical_raw
        from ..video_analysis.ticket_source import summary as _ts

        st["ticket_learning_source"] = _ts(_load_historical_raw())
    except Exception as exc:  # noqa: BLE001
        st["ticket_learning_source"] = {"error": str(exc)[:200]}
    return to_jsonable(st)


@router.post("/run")
def post_run(x_upgrade_key: Optional[str] = Header(default=None), followups: bool = Query(False)):
    """일일 파이프라인 1회 실행(수집→공식 검증→저장→후속 작업). 백그라운드."""
    _auth(x_upgrade_key)
    from ..round_upgrade import upgrade_rounds
    from ..ingest import jobs

    if followups:
        return _bg("daily_pipeline", lambda: jobs.daily_pipeline(force_followups=True))
    return _bg("daily_pipeline", upgrade_rounds)


@router.post("/verify-history")
def post_verify_history(x_upgrade_key: Optional[str] = Header(default=None)):
    """전 회차 공식 대조 감사(덮어쓰기 없음)."""
    _auth(x_upgrade_key)
    from ..ingest import jobs

    return _bg("verify_history", lambda: jobs.run_job("verify_history", jobs.verify_history))


@router.post("/learning/run")
def post_learning(x_upgrade_key: Optional[str] = Header(default=None), force: bool = Query(False)):
    """6종 학습 엔진 수동 실행(자동 실행과 동일 로직, force=true 면 같은 입력이어도 재실행)."""
    _auth(x_upgrade_key)
    from ..ingest import jobs

    return _bg("learning_engines", lambda: jobs.run_job("learning_engines", lambda: jobs.learning_engines(force=force)))


@router.post("/tickets/scan")
def post_ticket_scan(x_upgrade_key: Optional[str] = Header(default=None), limit: int = Query(8, ge=1, le=30)):
    """유튜브 용지 영상 공개 썸네일 OCR(자동/반자동) — 백그라운드."""
    _auth(x_upgrade_key)
    from ..ingest import jobs, tickets

    return _bg("ticket_scan", lambda: jobs.run_job("ticket_scan", lambda: tickets.scan(limit=limit), retries=1))


@router.get("/staging")
def get_staging(status: Optional[str] = Query(None), limit: int = Query(50, ge=1, le=500)):
    """검토 대기·미검증·불일치 회차(정식 테이블과 분리 보관)."""
    from ..ingest import registry

    return to_jsonable({"items": registry.staging(status, limit)})


@router.get("/draws/{round_no}")
def get_draw(round_no: int):
    from ..ingest import registry

    d = registry.get_draw(round_no)
    if not d:
        raise HTTPException(status_code=404, detail="레지스트리에 없는 회차")
    d["youtube"] = registry.youtube_for_round(round_no)
    return to_jsonable(d)


@router.get("/youtube")
def get_youtube(round_no: Optional[int] = Query(None, alias="round"), limit: int = Query(30, ge=1, le=200)):
    from ..ingest import db

    sql = ("SELECT video_id,channel_title,title,url,published_at,round,draw_date,numbers_json,bonus,confidence,kind,"
           "text_source,collected_at FROM reg_youtube")
    params: tuple = ()
    if round_no:
        sql += " WHERE round = ?"
        params = (round_no,)
    sql += " ORDER BY published_at DESC LIMIT " + str(int(limit))
    cols = ["video_id", "channel", "title", "url", "published_at", "round", "draw_date", "numbers", "bonus",
            "confidence", "kind", "text_source", "collected_at"]
    items = []
    for r in db.query(sql, params):
        it = dict(zip(cols, r))
        it["numbers"] = db.loads(it["numbers"])
        items.append(it)
    return {"items": items}


@router.get("/tickets")
def get_tickets(limit: int = Query(50, ge=1, le=500)):
    """유튜브 용지 데이터(자동/반자동 분리) 분석 + 최근 추출 줄."""
    from ..ingest import db, tickets

    rows = db.query("SELECT id,round,video_id,video_url,pick_type,game_label,numbers_json,ocr_confidence,"
                    "type_confidence,status,collected_at FROM reg_tickets ORDER BY collected_at DESC LIMIT " + str(int(limit)))
    cols = ["id", "round", "video_id", "video_url", "pick_type", "game_label", "numbers", "ocr_confidence",
            "type_confidence", "status", "collected_at"]
    recent = []
    for r in rows:
        it = dict(zip(cols, r))
        it["numbers"] = db.loads(it["numbers"])
        recent.append(it)
    return to_jsonable({"analysis": tickets.analysis(), "recent": recent})


@router.get("/coselection-calibration")
def get_coselection_calibration():
    """공동선택 회피 점수 실측 검증 — 공식 판매액·등수별 당첨자 수 기반."""
    from ..stats_engine.coselection_calibration import calibrate_from_registry

    return to_jsonable(calibrate_from_registry())


@router.get("/backtest-log")
def get_backtest_log(strategy: Optional[str] = Query(None), limit: int = Query(30, ge=1, le=500)):
    """회차별 예측 기록(그 회차 이전 데이터만으로 생성) — 생성 시각·데이터 범위·버전·예측·실제·일치."""
    from ..ingest import db, jobs

    sql = ("SELECT round,strategy,algorithm_version,generated_at,data_first_round,data_last_round,predicted_json,"
           "actual_json,bonus,matches,bonus_match,prize_rank FROM reg_backtest_log")
    params: tuple = ()
    if strategy:
        sql += " WHERE strategy = ?"
        params = (strategy,)
    sql += " ORDER BY round DESC LIMIT " + str(int(limit))
    cols = ["round", "strategy", "algorithm_version", "generated_at", "data_first_round", "data_last_round",
            "predicted", "actual", "bonus", "matches", "bonus_match", "prize_rank"]
    items = []
    for r in db.query(sql, params):
        it = dict(zip(cols, r))
        it["predicted"] = db.loads(it["predicted"])
        it["actual"] = db.loads(it["actual"])
        items.append(it)
    return {"summary": jobs.backtest_log_summary(), "items": items}


@router.get("/source-check")
def get_source_check(round_no: Optional[int] = Query(None, alias="round")):
    """외부 출처 접근 진단 — 동행복권 공식 / 유튜브 RSS / 보조(lottis). 실패는 오류 종류로 구분."""
    import time as _t

    from ..ingest import official, youtube
    from ..ingest.jobs import _secondary
    from ..ingest.registry import read_csv_rows

    rnd = round_no or max(read_csv_rows() or {0: None})
    out: Dict[str, Any] = {"round": rnd}
    t0 = _t.time()
    try:
        d = official.fetch_round(rnd, retries=0)
        out["official"] = {"ok": True, "numbers": d.numbers, "bonus": d.bonus, "draw_date": d.draw_date}
    except official.OfficialError as exc:
        out["official"] = {"ok": False, "kind": exc.kind, "error": str(exc)}
    out["official"]["seconds"] = round(_t.time() - t0, 2)
    t0 = _t.time()
    try:
        vids = youtube.fetch_channel_feed("UCEk3VwaA6e4H9TW1vSXOjDA", "동행복권(공식)")
        out["youtube_rss"] = {"ok": True, "videos": len(vids)}
    except youtube.YouTubeError as exc:
        out["youtube_rss"] = {"ok": False, "kind": exc.kind, "error": str(exc)}
    out["youtube_rss"]["seconds"] = round(_t.time() - t0, 2)
    out["youtube_api_key"] = bool(__import__("os").environ.get("YOUTUBE_API_KEY"))
    t0 = _t.time()
    sec = _secondary(rnd)
    out["secondary_lottis"] = {"ok": bool(sec), **(sec or {}), "seconds": round(_t.time() - t0, 2)}
    return out


# ─────────────────────────── 기준(Seed) 영상 기반 용지 수집 ───────────────────────────

@router.get("/seeds/dashboard")
def get_seed_dashboard():
    """기준 영상·유사 영상 발견/중복/용지 탐지·자동/반자동 수·회차 미확정·OCR 오류·6종 엔진 반영 현황."""
    from ..ingest import seeds

    return to_jsonable(seeds.dashboard())


@router.post("/seeds/register")
def post_seed_register(url: str = Query(..., description="YouTube 영상 URL 또는 ID"),
                       x_upgrade_key: Optional[str] = Header(default=None)):
    _auth(x_upgrade_key)
    from ..ingest import seeds

    try:
        return to_jsonable(seeds.register_seed(url))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/seeds/run")
def post_seed_run(x_upgrade_key: Optional[str] = Header(default=None)):
    """기준 영상 → 유사 영상 탐색 → 썸네일 용지 판독 → DB → 학습 연결(백그라운드)."""
    _auth(x_upgrade_key)
    from ..ingest import jobs, seeds

    return _bg("seed_daily", lambda: jobs.run_job("seed_daily", seeds.daily, retries=1))


@router.get("/seeds/videos")
def get_seed_videos(category: Optional[str] = Query(None), limit: int = Query(50, ge=1, le=500)):
    from ..ingest import db

    sql = ("SELECT video_id,channel_title,title,published_at,similarity_score,video_category,duplicate_group_id,"
           "collection_status,round_hint,discovered_via,processed_at,error FROM youtube_discovered_videos")
    params: tuple = ()
    if category:
        sql += " WHERE video_category = ?"
        params = (category,)
    sql += " ORDER BY processed_at DESC LIMIT " + str(int(limit))
    cols = ["video_id", "channel", "title", "published_at", "similarity", "category", "duplicate_of", "status",
            "round_hint", "via", "processed_at", "error"]
    return {"items": [dict(zip(cols, r)) for r in db.query(sql, params)]}


@router.get("/seeds/tickets")
def get_seed_tickets(pick_type: str = Query("auto", pattern="^(auto|semi_auto)$"), limit: int = Query(50, ge=1, le=500)):
    """자동/반자동 용지 데이터(분리 테이블) + 실제 당첨과의 일치(추첨 완료 회차·회차 확정분만)."""
    from ..ingest import db
    from ..stats_engine.draws import load_draws
    from ..stats_engine.probability import prize_rank

    table = "ticket_auto_data" if pick_type == "auto" else "ticket_semi_auto_data"
    rows = db.query(f"SELECT ticket_id,video_id,draw_round,round_status,game_index,numbers,confidence,type_confidence,"
                    f"verification_status,created_at FROM {table} ORDER BY created_at DESC LIMIT " + str(int(limit)))
    win = {d.round: d for d in load_draws()}
    items = []
    for r in rows:
        nums = db.loads(r[5])
        it = {"ticket_id": r[0], "video_id": r[1], "draw_round": r[2], "round_status": r[3], "game": r[4],
              "numbers": nums, "ocr_confidence": r[6], "type_confidence": r[7], "status": r[8], "created_at": r[9],
              "observed_only": True}
        d = win.get(r[2])
        if d and r[3] in ("ticket_printed", "title_date_confirmed"):
            it["matches"] = len(set(nums) & set(d.numbers))
            it["prize_rank"] = prize_rank(nums, d.numbers, d.bonus)
        else:
            it["matches"] = None  # 미추첨 회차 또는 회차 미확정
        items.append(it)
    return {"pick_type": pick_type, "items": items,
            "note": "영상에 보인 용지(관찰 데이터) — 실제 구매 완료 여부는 확인되지 않았습니다."}


@router.get("/youtube-api-check")
def get_youtube_api_check():
    """YouTube Data API 진단 — 키 존재·형식, 실제 호출 결과를 오류 코드로 분류(키 값은 노출하지 않음)."""
    import json as _json
    import os as _os
    import urllib.error
    import urllib.parse
    import urllib.request

    key = (_os.environ.get("YOUTUBE_API_KEY") or "").strip()
    out: Dict[str, Any] = {"env_var": "YOUTUBE_API_KEY", "present": bool(key),
                           "format_ok": bool(key) and key.startswith("AIza") and len(key) == 39}
    if not key:
        out.update(status="missing_key", detail="환경변수 YOUTUBE_API_KEY 없음 — RSS/oEmbed/공개 썸네일 경로만 동작")
        return out
    url = "https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(
        {"part": "snippet", "id": "LSYXNhnsvtc", "key": key})
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as r:
            j = _json.loads(r.read().decode("utf-8"))
        out.update(status="ok", http=200, items=len(j.get("items", [])))
    except urllib.error.HTTPError as exc:
        reason = ""
        try:
            body = _json.loads(exc.read().decode("utf-8"))
            errs = (body.get("error") or {}).get("errors") or [{}]
            reason = errs[0].get("reason", "") or (body.get("error") or {}).get("status", "")
        except Exception:  # noqa: BLE001
            pass
        kind = {"keyInvalid": "invalid_key", "badRequest": "invalid_key", "accessNotConfigured": "api_disabled",
                "SERVICE_DISABLED": "api_disabled", "quotaExceeded": "quota_exceeded", "dailyLimitExceeded": "quota_exceeded",
                "ipRefererBlocked": "key_restriction", "forbidden": "key_restriction_or_project"}.get(reason, "http_error")
        out.update(status=kind, http=exc.code, reason=reason)
    except Exception as exc:  # noqa: BLE001
        out.update(status="network", detail=str(exc)[:200])
    return out


# ─────────────────────────── 회차별 예측 기록·평가 ───────────────────────────

@router.get("/predictions/summary")
def get_predictions_summary():
    from ..ingest import predictions as P

    return P.summary()


@router.get("/predictions/round/{round_no}")
def get_prediction_round(round_no: int):
    """특정 회차: 엔진별 예측 번호·생성 시각·데이터 범위·버전 + 실제 당첨·일치·등수."""
    from ..ingest import predictions as P

    return to_jsonable(P.round_detail(round_no))


@router.get("/predictions/performance")
def get_prediction_performance(ptype: str = Query("backtest", pattern="^(backtest|live|historical_replay)$"),
                               first_round: Optional[int] = Query(None), last_round: Optional[int] = Query(None),
                               common: bool = Query(True, description="모든 엔진이 예측한 공통 회차만 비교")):
    from ..ingest import predictions as P

    return to_jsonable(P.performance(ptype, first_round, last_round, common_only=common))


@router.get("/predictions/search")
def get_prediction_search(method: Optional[str] = Query(None), ptype: Optional[str] = Query(None),
                          min_match: Optional[int] = Query(None, ge=0, le=6),
                          limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)):
    from ..ingest import predictions as P

    return {"items": P.search(method, ptype, min_match, limit, offset), "labels": P.METHOD_LABELS}


@router.post("/predictions/run")
def post_predictions_run(x_upgrade_key: Optional[str] = Header(default=None),
                         engine_rounds: int = Query(100, ge=10, le=1200)):
    """백테스트 보충·용지 재현·다음 회차 사전 예측(cutoff 전만)·평가 — 백그라운드."""
    _auth(x_upgrade_key)
    from ..ingest import jobs
    from ..ingest import predictions as P

    return _bg("predictions", lambda: jobs.run_job("predictions", lambda: P.run_all(engine_rounds=engine_rounds), retries=1))


@router.post("/predictions/backfill")
def post_predictions_backfill(x_upgrade_key: Optional[str] = Header(default=None),
                              budget_sec: float = Query(900, ge=60, le=3000)):
    """전 회차 통일 백필 1회(매시간 자동 실행과 동일) — 백그라운드."""
    _auth(x_upgrade_key)
    from ..ingest import jobs
    from ..ingest import predictions as P

    return _bg("prediction_backfill", lambda: jobs.run_job("prediction_backfill", lambda: P.backfill_all(budget_sec), retries=0))


@router.get("/predictions/coverage")
def get_predictions_coverage():
    """엔진별 사후 백테스트 범위(51회~최신 통일 진행률)."""
    from ..ingest import predictions as P

    P._ensure()
    return to_jsonable(P.coverage())


@router.get("/official/health")
def get_official_health(round_no: int = Query(1, alias="round", ge=1)):
    """공식 출처 단계별 진단(DNS·TCP·TLS·HTTP·파싱) + 마지막 정상 검증 시각."""
    from ..ingest import jobs, official

    return {"source_health": official.source_health(round_no), "last_successful_verification": jobs.last_successful_verification()}


@router.post("/official/verify-round/{round_no}")
def post_verify_round(round_no: int, x_upgrade_key: Optional[str] = Header(default=None)):
    _auth(x_upgrade_key)
    from ..ingest import jobs

    return jobs.verify_round(round_no)


@router.post("/official/verify-all")
def post_verify_all(x_upgrade_key: Optional[str] = Header(default=None)):
    _auth(x_upgrade_key)
    from ..ingest import jobs

    return _bg("verify_all_history", lambda: jobs.run_job("verify_all_history", jobs.verify_all_history, retries=0))


# ─────────────────────────── 전 회차 YouTube 수집 ───────────────────────────

@router.get("/youtube/diagnose")
def get_youtube_diagnose():
    """키 상태(값 비노출) + 키 없는 접속 시험(네트워크) + (키 있으면) search/videos/channels/playlistItems 실제 시험."""
    from ..ingest import yt_collect

    return to_jsonable(yt_collect.diagnose())


@router.get("/youtube/coverage")
def get_youtube_coverage():
    from ..ingest import yt_collect

    return to_jsonable(yt_collect.coverage())


@router.get("/youtube/round/{round_no}")
def get_youtube_round(round_no: int):
    from ..ingest import yt_collect

    return to_jsonable(yt_collect.round_detail(round_no))


@router.post("/youtube/run")
def post_youtube_run(x_upgrade_key: Optional[str] = Header(default=None), max_jobs: int = Query(80, ge=1, le=90)):
    """회차 작업 보충 → 검색(할당량 내) → 메타데이터 → 채널 스캔 — 백그라운드."""
    _auth(x_upgrade_key)
    from ..ingest import jobs, yt_collect

    return _bg("youtube_collect", lambda: jobs.run_job("youtube_collect", lambda: yt_collect.daily(max_jobs), retries=0))


# ─────────────────────────── 엔진 감사·공통번호·앙상블 검증 ───────────────────────────

@router.get("/audit/report")
def get_audit_report():
    """엔진 성능 순위(기간별)·저성과 진단·공통번호(V5)·독립성·앙상블(V7)·버전·감사(V8) + 최종 질문 답변."""
    from ..ingest import engine_audit as A

    return to_jsonable(A.full_report())


@router.get("/audit/numbers")
def get_audit_numbers():
    """V6 번호별 통계(기간별 출현·z·변동성·Bonferroni) + 엔진 선택 이력."""
    from ..ingest import engine_audit as A

    cons = A.consensus()
    return to_jsonable({"stats": A.number_stats(), "selection": cons["number_selection"],
                        "latest_consensus": cons["latest_consensus"]})


@router.get("/audit/number/{n}")
def get_audit_number(n: int):
    from ..ingest import engine_audit as A

    if not 1 <= n <= 45:
        raise HTTPException(status_code=400, detail="1~45")
    return A.number_detail(n)


@router.post("/audit/run")
def post_audit_run(x_upgrade_key: Optional[str] = Header(default=None), experiment: bool = Query(False)):
    _auth(x_upgrade_key)
    from ..ingest import engine_audit as A
    from ..ingest import jobs

    def _go():
        out = {"audit": A.run_audit()}
        if experiment:
            out["experiment"] = A.improvement_experiment()
        return out

    return _bg("engine_audit", lambda: jobs.run_job("engine_audit", _go, retries=0))


# ─────────────────────────── 회차별 후보군 성적 감사(전 회차) ───────────────────────────

@router.get("/round-audit/report")
def get_round_audit_report():
    """후보군(엔진)별 전 회차 성적 · 무작위 대비 하락 판정(Bonferroni) · 원인 진단 · 자동 보정(투표 제외)."""
    from ..ingest import round_audit as RA

    rep = RA.last_report()
    if rep is None:
        raise HTTPException(status_code=404, detail="아직 감사 기록이 없습니다 — POST /round-audit/run")
    return to_jsonable(rep)


@router.get("/round-audit/table")
def get_round_audit_table(limit: int = Query(60, ge=5, le=300)):
    """회차별 후보군 성적표(회차 × 후보군 최고 일치 수)."""
    from ..ingest import round_audit as RA

    return to_jsonable(RA.round_table(limit))


@router.get("/round-audit/misses")
def get_round_audit_misses():
    """놓친 당첨번호 역추적 · 당첨 패턴 학습(두 기간 재현 시만 채택) · 엔진 선택 편향."""
    from ..ingest import reverse_analysis as R

    rep = R.last_report("miss_analysis")
    if rep is None:
        raise HTTPException(status_code=404, detail="아직 역추적 기록이 없습니다 — POST /round-audit/run")
    return to_jsonable(rep)


@router.get("/round-audit/consensus-learning")
def get_round_audit_consensus_learning():
    """중복 추천 번호를 잡은 회차 vs 못 잡은 회차 비교 · 두 기간 재현 규칙 · 엔진별 약점/강점 조건."""
    from ..ingest import reverse_analysis as R

    rep = R.last_report("consensus_learning")
    if rep is None:
        raise HTTPException(status_code=404, detail="아직 학습 기록이 없습니다 — POST /round-audit/run")
    return to_jsonable(rep)


@router.post("/round-audit/run")
def post_round_audit_run(x_upgrade_key: Optional[str] = Header(default=None),
                         engine_rounds: int = Query(200, ge=50, le=600),
                         ensemble_budget_sec: float = Query(0, ge=0, le=3000)):
    """전 회차 후보 백필(엔진 walk-forward·V12 10조합·선택 시 앙상블) → 공식 결과 채점 → 감사(백그라운드)."""
    _auth(x_upgrade_key)
    from ..ingest import jobs
    from ..ingest import master_engine as M
    from ..ingest import predictions as P
    from ..ingest import round_audit as RA

    def _go():
        out = {"engines": P.backtest_engines(engine_rounds), "v12": {}}
        wf = M.v12_walk_forward(engine_rounds)
        out["v12"] = {"status": wf["status"], "stored": wf.get("stored_backtest_predictions")}
        if ensemble_budget_sec:
            out["ensemble"] = P.backtest_ensemble(engine_rounds, ensemble_budget_sec)
        out["evaluate"] = P.evaluate_pending()
        ra = RA.audit()
        out["audit"] = {"summary": ra["summary"], "actions": ra["actions"]}
        ma = RA.miss_analysis()
        out["miss_analysis"] = {"adopted": ma.get("adopted_patterns"), "coverage": ma.get("coverage")}
        cl = RA.consensus_learning()
        out["consensus_learning"] = {"rules": cl.get("adopted_rules"), "engine_weak": cl.get("engine_weak")}
        return out

    return _bg("round_audit", lambda: jobs.run_job("round_audit", _go, retries=0))


# ─────────────────────────── V5 역분석 · V6 자동 보정 · V7 자기개선 ───────────────────────────

@router.get("/reverse/report")
def get_reverse_report():
    """마지막으로 저장된 V5(고성과·저성과 역분석)·V6(보정 후보 검증)·V7(자기개선 루프)·모듈 재검증·확률 검증."""
    from ..ingest import reverse_analysis as R

    return to_jsonable(R.full_report())


@router.post("/reverse/run")
def post_reverse_run(x_upgrade_key: Optional[str] = Header(default=None)):
    """V7 루프 1회(강제) + V1~V4-A 모듈 재검증 — 백그라운드. 기존 모델은 덮어쓰지 않는다."""
    _auth(x_upgrade_key)
    from ..ingest import jobs
    from ..ingest import reverse_analysis as R

    return _bg("self_optimize", lambda: jobs.run_job("self_optimize", R.run_all, retries=0))


# ─────────────────────────── 통합 마스터 엔진 V8~V12 ───────────────────────────

@router.get("/master/report")
def get_master_report():
    """엔진 진단·V8 누수·V9 신뢰도·V10 번호 편향·V11 무작위 시뮬레이션·V12 현재 회차 후보/검증(마지막 저장본)."""
    from ..ingest import master_engine as M

    return to_jsonable(M.full_report())


@router.post("/master/run")
def post_master_run(x_upgrade_key: Optional[str] = Header(default=None)):
    """통합 실행(백그라운드): 진단 → 대조 → 누수 → 역분석 → 수정 → V9~V11 → V12 검증 → 현재 회차 후보(cutoff 전만 저장)."""
    _auth(x_upgrade_key)
    from ..ingest import jobs
    from ..ingest import master_engine as M

    return _bg("master_engine", lambda: jobs.run_job("master_engine", M.run_master, retries=0))


@router.get("/atlas/report")
def get_pattern_atlas():
    """전 회차 당첨 패턴 아틀라스: 회차별 조합 순번(1~8,145,060)·패턴 클래스·정확 확률 vs 관측·walk-forward 검증."""
    from ..ingest import draw_atlas as DA

    return to_jsonable(DA.report())


@router.get("/predictions/consensus/{round_no}")
def get_prediction_consensus(round_no: int):
    """선택 회차의 엔진 중복 추천 번호 순위(백테스트·사전 예측) + 전체 회차 중복 수별 실제 적중률."""
    from ..ingest import predictions as P

    return to_jsonable(P.consensus_ranking(round_no))
