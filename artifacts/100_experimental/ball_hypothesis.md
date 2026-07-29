# Experimental — Ball Artifact 설계 (점수 주입 금지)

> 상태: `experimental`  
> 승격 조건: 볼 단위 실측 데이터 + Validation 통과

## 목적

번호별 볼(무게·마모·호기 사용)이 장기 분포를 편향시키는지 **가설**로만 관리한다.

## 데이터 계약 (미확보)

| 필드 | 설명 |
|------|------|
| ball_id / number | 1–45 |
| mass_g | 무게 |
| diameter_mm | 직경 |
| wear_index | 마모도 |
| machine_id | 사용 호기 |
| draw_count | 사용 회수 |

현재 저장소에는 **없음** → UI `LottoBall` 표시만 존재.

## 금지

- V1–V4 / L1–L9 / 히어로 점수 경로 연결
- “마모 볼이 잘 나온다”를 사실로 표시

## 다음

공식 스펙·측정치가 생기면 `artifacts/04_ball/` 로 승격 검토.
