import type {
  ClassicRecommendResponse,
  GenerateResponse,
  PredictionSignalNumber,
  PredictionSignalsResponse,
  RoundRecommendResponse,
  TemperatureItem,
} from '../api/v1Api';
import { acValue, maxConsecutiveRun, oddCount, sumTotal } from './comboMetrics';

export type FortuneMethod = 'unified' | 'machine' | 'classic' | 'smart' | 'lucky';

export const FORTUNE_METHODS: {
  id: FortuneMethod;
  emoji: string;
  label: string;
  desc: string;
}[] = [
  {
    id: 'unified',
    emoji: '🧓',
    label: '할매 통합',
    desc: '추첨기·후속·용지·평행회차 신호를 한곳에 모아 뽑기',
  },
  {
    id: 'machine',
    emoji: '🎰',
    label: '추첨기 할매',
    desc: '다음 회차 호기 패턴으로 5게임',
  },
  {
    id: 'classic',
    emoji: '📐',
    label: '수학자 할매',
    desc: '윌슨·가우스·페르마 블렌드',
  },
  {
    id: 'smart',
    emoji: '🤖',
    label: '스마트 할매',
    desc: '미출현 가중치 + 기본 필터',
  },
  {
    id: 'lucky',
    emoji: '✨',
    label: '행운 할매',
    desc: '뜨거운 번호와 오래 숨은 번호를 섞기',
  },
];

export interface FortuneCombo {
  numbers: number[];
  hint?: string;
}

export interface FortunePickResult {
  method: FortuneMethod;
  methodLabel: string;
  fortuneMessage: string;
  targetRound: number;
  targetDrawDate?: string;
  combos: FortuneCombo[];
}

const FORTUNE_MESSAGES = [
  '오늘은 숫자가 말을 걸어오는 날이야. 마음 편히 골라봐.',
  '할매가 통계랑 운을 한 번 섞어봤어. 행운이 따라줄 거야.',
  '무리하게 집착하지 말고, 가볍게 한 장만 사보는 것도 좋아.',
  '뜨거운 번호랑 오래 쉰 번호를 골고루 넣었단다. 균형이 중요해.',
  '로또는 재미로! 너무 크게 기대하지 말고 즐겁게 가져가렴.',
  '이번 주엔 차분한 조합이 나왔어. 천천히 골라봐.',
  '할매 눈에 괜찮은 숫자들이야. 네 마음에 드는 줄 골라.',
];

function passesBasicFilters(combo: number[]): boolean {
  if (combo.length !== 6) return false;
  const sum = sumTotal(combo);
  if (sum < 90 || sum > 195) return false;
  const oc = oddCount(combo);
  if (oc === 0 || oc === 6) return false;
  if (maxConsecutiveRun(combo) >= 4) return false;
  if (acValue(combo) < 5) return false;
  return true;
}

function comboKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join('-');
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), s | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPickWithoutReplacement(
  pool: { number: number; weight: number }[],
  k: number,
  rng: () => number
): number[] | null {
  const available = pool.map((p) => ({ ...p }));
  const out: number[] = [];
  for (let i = 0; i < k; i += 1) {
    const total = available.reduce((s, p) => s + Math.max(p.weight, 0.01), 0);
    if (total <= 0 || available.length === 0) return null;
    let r = rng() * total;
    let pickedIdx = 0;
    for (let j = 0; j < available.length; j += 1) {
      r -= Math.max(available[j].weight, 0.01);
      if (r <= 0) {
        pickedIdx = j;
        break;
      }
    }
    out.push(available[pickedIdx].number);
    available.splice(pickedIdx, 1);
  }
  return out;
}

function buildCombosFromPool(
  pool: { number: number; weight: number }[],
  count: number,
  seed: number
): number[][] {
  const rng = mulberry32(seed);
  const seen = new Set<string>();
  const out: number[][] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 80) {
    attempts += 1;
    const raw = weightedPickWithoutReplacement(pool, 6, rng);
    if (!raw) break;
    const combo = [...raw].sort((a, b) => a - b);
    if (!passesBasicFilters(combo)) continue;
    const key = comboKey(combo);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  return out;
}

function pickFortuneMessage(seed: number): string {
  return FORTUNE_MESSAGES[seed % FORTUNE_MESSAGES.length];
}

function poolFromSignals(signals: PredictionSignalNumber[]): { number: number; weight: number }[] {
  return signals
    .filter((s) => s.grade !== 'X')
    .slice(0, 28)
    .map((s, idx) => ({
      number: s.number,
      weight: Math.max(s.score, 1) * (1 - idx * 0.02),
    }));
}

export function buildUnifiedFortune(
  signals: PredictionSignalsResponse,
  seed: number
): FortunePickResult {
  const pool = poolFromSignals(signals.ranked_numbers ?? []);
  const fallback = (signals.strong_candidates ?? []).map((n, idx) => ({
    number: n,
    weight: 20 - idx,
  }));
  const combos = buildCombosFromPool(pool.length >= 12 ? pool : fallback, 5, seed).map(
    (numbers, idx) => ({
      numbers,
      hint: idx === 0 ? '통합 신호 1순위 조합' : `통합 신호 ${idx + 1}번째`,
    })
  );
  const method = FORTUNE_METHODS.find((m) => m.id === 'unified')!;
  return {
    method: 'unified',
    methodLabel: method.label,
    fortuneMessage: pickFortuneMessage(seed),
    targetRound: signals.target_round,
    targetDrawDate: signals.target_draw_date,
    combos,
  };
}

export function buildLuckyFortune(
  items: TemperatureItem[],
  targetRound: number,
  seed: number
): FortunePickResult {
  const hot = items.filter((i) => i.tier === 'hot' || i.tier === 'warm').slice(0, 18);
  const cold = items.filter((i) => i.tier === 'cold' || i.tier === 'frozen').slice(0, 18);
  const neutral = items.filter((i) => i.tier === 'neutral').slice(0, 12);
  const pool = [
    ...hot.map((i, idx) => ({ number: i.number, weight: 14 - idx * 0.3 })),
    ...cold.map((i, idx) => ({ number: i.number, weight: 10 - idx * 0.25 })),
    ...neutral.map((i, idx) => ({ number: i.number, weight: 6 - idx * 0.15 })),
  ];
  const combos = buildCombosFromPool(pool, 5, seed).map((numbers, idx) => ({
    numbers,
    hint: idx % 2 === 0 ? '뜨거운+차가운 균형' : '행운 믹스',
  }));
  const method = FORTUNE_METHODS.find((m) => m.id === 'lucky')!;
  return {
    method: 'lucky',
    methodLabel: method.label,
    fortuneMessage: pickFortuneMessage(seed + 3),
    targetRound,
    combos,
  };
}

function mapApiCombos(
  combos: { numbers: number[]; pattern_label?: string | null; pattern?: string | null }[],
  method: FortuneMethod,
  targetRound: number,
  targetDrawDate: string | undefined,
  seed: number
): FortunePickResult {
  const meta = FORTUNE_METHODS.find((m) => m.id === method)!;
  return {
    method,
    methodLabel: meta.label,
    fortuneMessage: pickFortuneMessage(seed),
    targetRound,
    targetDrawDate,
    combos: combos.map((c, idx) => ({
      numbers: c.numbers,
      hint: c.pattern_label ?? c.pattern ?? `${meta.label} ${idx + 1}게임`,
    })),
  };
}

export function fromRoundRecommend(
  data: RoundRecommendResponse,
  seed: number
): FortunePickResult {
  return mapApiCombos(
    data.combinations,
    'machine',
    data.next_round,
    data.next_draw_date,
    seed
  );
}

export function fromClassicRecommend(
  data: ClassicRecommendResponse,
  seed: number
): FortunePickResult {
  return mapApiCombos(
    data.combinations,
    'classic',
    data.next_round,
    data.next_draw_date,
    seed
  );
}

export function fromSmartGenerate(
  data: GenerateResponse,
  targetRound: number,
  seed: number
): FortunePickResult {
  return mapApiCombos(data.combinations, 'smart', targetRound, undefined, seed);
}
