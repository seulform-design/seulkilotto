/**
 * 즐겨찾기 상태 훅 — localStorage 기반 영속성.
 *
 * 키: 'lotto:favorites:v1'
 * 형태: Favorite[]
 *
 * 설계 결정:
 *  - SSR 안전: typeof window 체크
 *  - 멀티 탭 동기: storage 이벤트 구독
 *  - 멱등성: 같은 numbers 6-tuple 은 중복 저장 차단 (사용자 의도 명시)
 *  - 페이로드 작음: localStorage 5MB 한도 안에서 수만 건도 안전
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'lotto:favorites:v1';

export type FavoriteSource =
  | 'generator'
  | 'smart'
  | 'epo'
  | 'classic'
  | 'recommend'
  | 'manual'
  | 'unknown';

export interface Favorite {
  id: string;
  numbers: number[];
  label: string;
  source: FavoriteSource;
  createdAt: number;
  note?: string;
}

function safeRead(): Favorite[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is Favorite =>
        !!f &&
        typeof f === 'object' &&
        Array.isArray((f as Favorite).numbers) &&
        (f as Favorite).numbers.length === 6 &&
        typeof (f as Favorite).id === 'string'
    );
  } catch {
    return [];
  }
}

/** 저장 성공 여부를 반환한다. quota 초과 등 실패 시 false (호출부가 경고 노출). */
function safeWrite(list: Favorite[]): boolean {
  if (typeof window === 'undefined') return true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sortedKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).join('-');
}

export interface UseFavoritesResult {
  list: Favorite[];
  has: (numbers: number[]) => boolean;
  add: (input: { numbers: number[]; label?: string; source?: FavoriteSource; note?: string }) =>
    | { ok: true; id: string }
    | { ok: false; reason: 'duplicate' | 'invalid' };
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Pick<Favorite, 'label' | 'note'>>) => void;
  clear: () => void;
  /** 직전 저장이 quota 초과 등으로 실패했는지 — true 면 UI 에서 경고 노출 권장. */
  persistError: boolean;
}

export function useFavorites(): UseFavoritesResult {
  const [list, setList] = useState<Favorite[]>(safeRead);
  const [persistError, setPersistError] = useState(false);

  // 최신 list 참조 — 콜백이 stale 클로저 없이 현재 값을 읽도록.
  const listRef = useRef(list);
  listRef.current = list;
  const skipFirstPersist = useRef(true);

  // 영속 — list 변경 시마다 저장(항상 최신 상태 기록). 초기 로드분은 재기록 불필요.
  // 실패(quota) 시 persistError 로 표면화해 '저장이 안 됐는데 됐다고 보이는' 유실 방지.
  useEffect(() => {
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    setPersistError(!safeWrite(list));
  }, [list]);

  // 멀티 탭 storage 이벤트 동기화
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        skipFirstPersist.current = true; // 외부 변경 반영분은 되쓰지 않음
        setList(safeRead());
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const has = useCallback((numbers: number[]) => {
    const key = sortedKey(numbers);
    return listRef.current.some((f) => sortedKey(f.numbers) === key);
  }, []);

  const add: UseFavoritesResult['add'] = useCallback(({ numbers, label, source = 'unknown', note }) => {
    if (!Array.isArray(numbers) || numbers.length !== 6) {
      return { ok: false as const, reason: 'invalid' as const };
    }
    const valid = numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 45);
    if (!valid) return { ok: false as const, reason: 'invalid' as const };

    const sorted = [...numbers].sort((a, b) => a - b);
    if (listRef.current.some((f) => sortedKey(f.numbers) === sortedKey(sorted))) {
      return { ok: false as const, reason: 'duplicate' as const };
    }
    const id = makeId();
    const fav: Favorite = {
      id,
      numbers: sorted,
      label: label?.trim() || `조합 ${listRef.current.length + 1}`,
      source,
      createdAt: Date.now(),
      note,
    };
    // 함수형 업데이터 — 같은 틱 연속 호출에도 이전 항목을 잃지 않는다.
    setList((prev) => [...prev, fav]);
    return { ok: true as const, id };
  }, []);

  const remove = useCallback((id: string) => {
    setList((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const update = useCallback((id: string, patch: Partial<Pick<Favorite, 'label' | 'note'>>) => {
    setList((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const clear = useCallback(() => {
    setList([]);
  }, []);

  return { list, has, add, remove, update, clear, persistError };
}
