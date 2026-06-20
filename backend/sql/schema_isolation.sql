-- =============================================================================
--  데이터셋 격리 스키마 (Enterprise Lottery Data Isolation)
--  Historical READ-ONLY vs Current SANDBOX
-- =============================================================================

-- Historical: 롤오버 후 확정 아카이브 (토요일 배치 유일 쓰기 윈도우)
CREATE TABLE IF NOT EXISTS historical_round_archive (
    round_no        INTEGER PRIMARY KEY,
    photo_entries   JSONB        NOT NULL DEFAULT '[]',
    derived_recs    JSONB        NOT NULL DEFAULT '[]',
    rule_snapshots  JSONB        NOT NULL DEFAULT '[]',
    backtest        JSONB        NOT NULL DEFAULT '{}',
    archived_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rollover_batch_log (
    round_no        INTEGER PRIMARY KEY,
    status          TEXT         NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
    completed_at    TIMESTAMPTZ,
    backtest_hits   SMALLINT,
    error_message   TEXT
);

COMMENT ON TABLE historical_round_archive IS 'N회차 확정 스냅숏 — IMMUTABLE after insert';
COMMENT ON TABLE rollover_batch_log IS '토요일 롤오버 멱등성 가드';

-- Current: 진행 중 N회차 샌드박스 (단일 행 — round_no PK)
CREATE TABLE IF NOT EXISTS current_sandbox_state (
    round_no        INTEGER PRIMARY KEY,
    frozen          BOOLEAN      NOT NULL DEFAULT FALSE,
    write_enabled   BOOLEAN      NOT NULL DEFAULT TRUE,
    frozen_at       TIMESTAMPTZ,
    initialized_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS current_derived_recommendation (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    round_no        INTEGER      NOT NULL REFERENCES current_sandbox_state(round_no),
    engine          TEXT         NOT NULL,
    payload         JSONB        NOT NULL,
    rule_snapshot   JSONB        NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS current_photo_entry (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    round_no        INTEGER      NOT NULL REFERENCES current_sandbox_state(round_no),
    entry           JSONB        NOT NULL,
    analyzed_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_current_derived_round ON current_derived_recommendation (round_no DESC);
CREATE INDEX IF NOT EXISTS idx_current_photo_round ON current_photo_entry (round_no DESC);

-- Historical draws: 런타임 UPDATE 금지 (앱 레벨 + 선택적 DB 트리거)
CREATE OR REPLACE FUNCTION fn_block_historical_draw_update()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND current_setting('app.rollover_window', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Historical lotto_history is READ-ONLY outside rollover window';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_historical_draw_update ON lotto_history;
CREATE TRIGGER trg_block_historical_draw_update
    BEFORE UPDATE ON lotto_history
    FOR EACH ROW EXECUTE FUNCTION fn_block_historical_draw_update();
