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
    if settings.UPGRADE_API_KEY and key != settings.UPGRADE_API_KEY:
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
