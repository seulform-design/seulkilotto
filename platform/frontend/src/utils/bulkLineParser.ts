/**
 * 대량 줄 입력 파서.
 *
 * 사용자가 텍스트 영역에 붙여넣은 다중 줄을 6개 번호 배열로 변환한다.
 * 허용되는 입력 형태(같은 텍스트 안에 섞여도 OK):
 *
 *   1 2 3 4 5 6
 *   1,2,3,4,5,6
 *   1, 2, 3, 4, 5, 6
 *   1;2;3;4;5;6
 *   1|2|3|4|5|6
 *   1\t2\t3\t4\t5\t6     (스프레드시트 복사)
 *   A: 1 2 3 4 5 6        (라벨 자동 무시)
 *   1) 7,8,9,10,11,12     (라벨 자동 무시)
 *   # 주석                 (무시)
 *   // 주석                (무시)
 *   (빈 줄)               (무시)
 *
 * 검증 규칙:
 *   - 한 줄에 정확히 6개의 정수
 *   - 모든 정수가 1~45 범위
 *   - 중복 없음
 *   - 위 조건 어긋나면 ParseError 에 reason 과 함께 기록
 */

export interface ParsedLine {
  /** 원본 텍스트에서의 줄 번호 (1-based) */
  lineNum: number;
  raw: string;
  numbers: number[];
}

export interface ParseError {
  lineNum: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  parsed: ParsedLine[];
  errors: ParseError[];
  totalLines: number;
  /** 빈 줄/주석 제외하고 실제로 파싱 시도한 라인 수 */
  attemptedLines: number;
}

const TOKEN_SEP = /[\s,;|/]+/;

export function parseBulkLines(text: string): ParseResult {
  const rawLines = text.split(/\r?\n/);
  const parsed: ParsedLine[] = [];
  const errors: ParseError[] = [];
  let attempted = 0;

  rawLines.forEach((raw, idx) => {
    const lineNum = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) return;

    attempted += 1;

    // 토큰 분리 후 순수 정수 토큰만 추출 (라벨/구두점 자동 제거)
    const tokens = trimmed
      .split(TOKEN_SEP)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const numericTokens = tokens.filter((t) => /^\d+$/.test(t));

    if (numericTokens.length !== 6) {
      errors.push({
        lineNum,
        raw,
        reason:
          numericTokens.length < 6
            ? `숫자 6개 필요 (${numericTokens.length}개 검출)`
            : `숫자 6개만 허용 (${numericTokens.length}개 검출)`,
      });
      return;
    }

    const nums = numericTokens.map((t) => Number(t));
    const outOfRange = nums.filter((n) => n < 1 || n > 45);
    if (outOfRange.length > 0) {
      errors.push({
        lineNum,
        raw,
        reason: `1~45 범위 벗어남: ${outOfRange.join(', ')}`,
      });
      return;
    }

    if (new Set(nums).size !== 6) {
      errors.push({ lineNum, raw, reason: '중복된 번호 포함' });
      return;
    }

    parsed.push({
      lineNum,
      raw,
      numbers: [...nums].sort((a, b) => a - b),
    });
  });

  return {
    parsed,
    errors,
    totalLines: rawLines.length,
    attemptedLines: attempted,
  };
}
