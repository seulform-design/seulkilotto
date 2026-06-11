"""EPO — Expected Payout Optimization 모듈.

본 모듈은 "당첨 확률 향상"을 시도하지 않는다 (수학적으로 불가능).
대신 다음 세 목표를 달성한다:

  (1) 역사적으로 1등 조합에서 관측된 경험적 분포에 정렬된 조합만 생성
      → 통계적으로 '가장 그럴듯한(most-plausible)' 후보 선별
  (2) 인기 픽 회피(공유 잭팟 회피) 및 다중 티켓 다양성 최대화
      → 기대 수익(Expected Payout) 최적화
  (3) 자기 검증(backtest) 이 실패하면 EPO 비활성 + Fallback 모드 전환
      → 필터가 실제 1등 조합을 과도하게 배제하지 않도록 안전망

모든 응답은 honesty meta 와 함께 반환되며, 사용자에게
"당첨 확률은 변하지 않는다"는 사실이 명시된다.
"""
from .backtest import BacktestResult, evaluate_filters, loose_fallback_predicates
from .engine import ENGINE_VERSION, DISCLAIMER, EpoConfig, EpoResult, run
from .historical_stats import HistoricalProfile, compute_profile

__all__ = [
    "BacktestResult",
    "DISCLAIMER",
    "ENGINE_VERSION",
    "EpoConfig",
    "EpoResult",
    "HistoricalProfile",
    "compute_profile",
    "evaluate_filters",
    "loose_fallback_predicates",
    "run",
]
