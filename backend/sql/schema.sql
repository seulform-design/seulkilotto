-- =============================================================================
--  로또 분석기 (Lotto Analyzer) - PostgreSQL DDL
--  파일명: schema.sql
--  설명: 역대 로또 당첨 데이터를 저장하는 핵심 테이블 및 성능 최적화 인덱스 정의
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) lotto_history : 회차별 당첨 결과 마스터 테이블
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lotto_history (
    round           INTEGER      PRIMARY KEY,                 -- 회차 (PK, 1부터 증가)
    draw_date       DATE         NOT NULL,                    -- 추첨일
    num1            SMALLINT     NOT NULL CHECK (num1 BETWEEN 1 AND 45),
    num2            SMALLINT     NOT NULL CHECK (num2 BETWEEN 1 AND 45),
    num3            SMALLINT     NOT NULL CHECK (num3 BETWEEN 1 AND 45),
    num4            SMALLINT     NOT NULL CHECK (num4 BETWEEN 1 AND 45),
    num5            SMALLINT     NOT NULL CHECK (num5 BETWEEN 1 AND 45),
    num6            SMALLINT     NOT NULL CHECK (num6 BETWEEN 1 AND 45),
    bonus           SMALLINT     NOT NULL CHECK (bonus BETWEEN 1 AND 45),  -- 보너스 번호
    first_prize_amount  BIGINT   NOT NULL DEFAULT 0,          -- 1등 1게임당 당첨 금액(원)
    first_winner_count  INTEGER  NOT NULL DEFAULT 0,          -- 1등 당첨자 수
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- 당첨번호 6개가 1~45 범위 내에서 서로 중복되지 않도록 데이터 무결성 보장
    CONSTRAINT chk_distinct_numbers CHECK (
        num1 <> num2 AND num1 <> num3 AND num1 <> num4 AND num1 <> num5 AND num1 <> num6 AND
        num2 <> num3 AND num2 <> num4 AND num2 <> num5 AND num2 <> num6 AND
        num3 <> num4 AND num3 <> num5 AND num3 <> num6 AND
        num4 <> num5 AND num4 <> num6 AND
        num5 <> num6
    )
);

COMMENT ON TABLE  lotto_history IS '역대 로또 회차별 당첨 결과';
COMMENT ON COLUMN lotto_history.round IS '회차 번호 (Primary Key)';
COMMENT ON COLUMN lotto_history.first_prize_amount IS '1등 1게임당 실수령 당첨 금액(원)';


-- -----------------------------------------------------------------------------
-- 2) 인덱스 (대용량 조회 성능 최적화)
-- -----------------------------------------------------------------------------

-- (a) "최근 N회차" 조회를 위한 정렬 인덱스.
--     ORDER BY round DESC LIMIT N / draw_date 범위 조회 시 인덱스 풀스캔 회피.
CREATE INDEX IF NOT EXISTS idx_lotto_round_desc
    ON lotto_history (round DESC);

CREATE INDEX IF NOT EXISTS idx_lotto_draw_date
    ON lotto_history (draw_date DESC);

-- (b) 번호별 빈도 분석을 가속하기 위한 정규화 뷰/테이블.
--     원본 테이블은 와이드(6개 컬럼) 구조라 번호별 집계가 비효율적이므로,
--     (round, position, number) 형태의 롱(long) 테이블로 펼쳐서 집계 성능을 확보한다.
CREATE TABLE IF NOT EXISTS lotto_draw_numbers (
    round       INTEGER  NOT NULL REFERENCES lotto_history(round) ON DELETE CASCADE,
    position    SMALLINT NOT NULL,        -- 1~6 (당첨번호 순번), 0 = 보너스
    number      SMALLINT NOT NULL CHECK (number BETWEEN 1 AND 45),
    PRIMARY KEY (round, position)
);

-- 번호별 출현 빈도 집계(WHERE number = ? GROUP BY)를 위한 핵심 인덱스
CREATE INDEX IF NOT EXISTS idx_draw_numbers_number
    ON lotto_draw_numbers (number);

-- 특정 회차 범위 + 번호 동시 조회를 위한 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_draw_numbers_round_number
    ON lotto_draw_numbers (round, number);


-- -----------------------------------------------------------------------------
-- 3) 트리거: lotto_history INSERT 시 lotto_draw_numbers 자동 동기화
--    (애플리케이션에서 별도 INSERT 하지 않아도 롱 테이블이 항상 일관성을 유지)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sync_draw_numbers()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM lotto_draw_numbers WHERE round = NEW.round;
    INSERT INTO lotto_draw_numbers (round, position, number) VALUES
        (NEW.round, 1, NEW.num1),
        (NEW.round, 2, NEW.num2),
        (NEW.round, 3, NEW.num3),
        (NEW.round, 4, NEW.num4),
        (NEW.round, 5, NEW.num5),
        (NEW.round, 6, NEW.num6),
        (NEW.round, 0, NEW.bonus);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_draw_numbers ON lotto_history;
CREATE TRIGGER trg_sync_draw_numbers
    AFTER INSERT OR UPDATE ON lotto_history
    FOR EACH ROW EXECUTE FUNCTION fn_sync_draw_numbers();


-- -----------------------------------------------------------------------------
-- 4) 샘플 데이터 (테스트용)
-- -----------------------------------------------------------------------------
INSERT INTO lotto_history
    (round, draw_date, num1, num2, num3, num4, num5, num6, bonus, first_prize_amount, first_winner_count)
VALUES
    (1100, '2024-01-06',  3,  9, 11, 21, 30, 44, 27, 2350000000, 12),
    (1101, '2024-01-13',  5,  7, 14, 22, 33, 41, 18, 1980000000, 14),
    (1102, '2024-01-20',  1, 12, 19, 25, 38, 45,  6, 3010000000,  9)
ON CONFLICT (round) DO NOTHING;
