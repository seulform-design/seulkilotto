"""FP-Growth 연관규칙 마이닝 (mlxtend) — 현재 회차 → 다음 회차."""
from __future__ import annotations

from itertools import combinations
from typing import Dict, List, Set

import pandas as pd

from app.engines.draw_frame import row_numbers


def _build_transactions(df: pd.DataFrame) -> List[frozenset]:
    """트랜잭션: 당회차 번호(P_n) + 다음회차 번호(N_n) 동시 아이템."""
    ordered = df.sort_values("round_no")
    rounds = [row_numbers(r) for _, r in ordered.iterrows()]
    # 성능: 최근 200회차만 사용 (API 응답·재현성 균형)
    if len(rounds) > 201:
        rounds = rounds[-201:]
    txs: List[frozenset] = []
    for i in range(len(rounds) - 1):
        curr, nxt = rounds[i], rounds[i + 1]
        items: Set[str] = set()
        for n in curr:
            items.add(f"P_{n}")
        for a, b in combinations(sorted(curr), 2):
            items.add(f"PP_{a}_{b}")
        for n in nxt:
            items.add(f"N_{n}")
        txs.append(frozenset(items))
    return txs


def mine_fpgrowth_rules(
    df: pd.DataFrame,
    min_support: float = 0.02,
    min_confidence: float = 0.15,
    max_rules: int = 100,
) -> Dict:
    """
    FP-Growth로 {PP_a_b} → {N_x} 형태 규칙 추출.
    min_support: 트랜잭션 대비 (0~1).
    """
    try:
        from mlxtend.frequent_patterns import association_rules, fpgrowth
        from mlxtend.preprocessing import TransactionEncoder
    except ImportError:
        return _fallback_rules(df, min_support, max_rules)

    txs = _build_transactions(df)
    if len(txs) < 20:
        return {"rules": [], "error": "데이터 부족", "method": "fpgrowth"}

    te = TransactionEncoder()
    te_ary = te.fit(txs).transform(txs)
    ohe = pd.DataFrame(te_ary, columns=te.columns_)
    freq = fpgrowth(ohe, min_support=min_support, use_colnames=True)
    if freq.empty:
        return {"rules": [], "method": "fpgrowth", "itemsets": 0}

    rules_df = association_rules(
        freq, metric="confidence", min_threshold=min_confidence, num_itemsets=len(freq)
    )
    if rules_df.empty:
        return {"rules": [], "method": "fpgrowth", "itemsets": len(freq)}

    out_rules = []
    for _, row in rules_df.sort_values("lift", ascending=False).head(max_rules).iterrows():
        ant = [str(x) for x in row["antecedents"]]
        con = [str(x) for x in row["consequents"]]
        if not any(x.startswith("PP_") for x in ant):
            continue
        if not any(x.startswith("N_") for x in con):
            continue
        out_rules.append(
            {
                "antecedent": ant,
                "consequent": con,
                "support": round(float(row["support"]), 4),
                "confidence": round(float(row["confidence"]), 4),
                "lift": round(float(row["lift"]), 4),
                "evidence": "FP-Growth: pair in draw t → number in draw t+1",
            }
        )

    return {
        "method": "fpgrowth",
        "transactions": len(txs),
        "frequent_itemsets": len(freq),
        "rules": out_rules,
        "parameters": {"min_support": min_support, "min_confidence": min_confidence},
        "disclaimer": "과거 연관규칙이며 독립시행에서 미래 예측 보장 없음",
    }


def _fallback_rules(df: pd.DataFrame, min_support: float, max_rules: int) -> Dict:
    """mlxtend 미설치 시 pair→next 단순 규칙."""
    from app.engines.pattern_index import PatternIndex

    idx = PatternIndex().build(df)
    rules = []
    for pk, occ in idx.pair_occurrence.most_common(max_rules):
        if occ / max(idx.total_draws, 1) < min_support:
            continue
        cond = idx.conditional_pair(*map(int, pk.split("-")))
        for t in cond.get("top_next_numbers", [])[:1]:
            rules.append(
                {
                    "antecedent": [f"PP_{pk.replace('-', '_')}"],
                    "consequent": [f"N_{t['number']}"],
                    "support": cond["support"],
                    "confidence": t["probability"],
                    "lift": cond["lift"],
                    "evidence": "fallback pair→next",
                }
            )
    return {"method": "fallback_pair", "rules": rules, "disclaimer": "mlxtend 미설치"}
