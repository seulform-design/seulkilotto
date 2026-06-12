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
import { useCallback, useEffect, useState } from 'react';

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

function safeWrite(list: Favorite[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota 초과 등 — silent fail. 다른 탭의 동기화는 storage event 로 처리 */
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
}

export function useFavorites(): UseFavoritesResult {
  const [list, setList] = useState<Favorite[]>(safeRead);

  // 멀티 탭 storage 이벤트 동기화
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setList(safeRead());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const has = useCallback(
    (numbers: number[]) => {
      const key = sortedKey(numbers);
      return list.some((f) => sortedKey(f.numbers) === key);
    },
    [list]
  );

  const add: UseFavoritesResult['add'] = useCallback(
    ({ numbers, label, source = 'unknown', note }) => {
      if (!Array.isArray(numbers) || numbers.length !== 6) {
        return { ok: false as const, reason: 'invalid' as const };
      }
      const valid = numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 45);
      if (!valid) return { ok: false as const, reason: 'invalid' as const };

      const sorted = [...numbers].sort((a, b) => a - b);
      const next = (() => {
        const exists = list.some((f) => sortedKey(f.numbers) === sortedKey(sorted));
        if (exists) return null;
        const id = makeId();
        const fav: Favorite = {
          id,
          numbers: sorted,
          label: label?.trim() || `조합 ${list.length + 1}`,
          source,
          createdAt: Date.now(),
          note,
        };
        return { id, list: [...list, fav] };
      })();

      if (!next) return { ok: false as const, reason: 'duplicate' as const };
      setList(next.list);
      safeWrite(next.list);
      return { ok: true as const, id: next.id };
    },
    [list]
  );

  const remove = useCallback(
    (id: string) => {
      const next = list.filter((f) => f.id !== id);
      setList(next);
      safeWrite(next);
    },
    [list]
  );

  const update = useCallback(
    (id: string, patch: Partial<Pick<Favorite, 'label' | 'note'>>) => {
      const next = list.map((f) => (f.id === id ? { ...f, ...patch } : f));
      setList(next);
      safeWrite(next);
    },
    [list]
  );

  const clear = useCallback(() => {
    setList([]);
    safeWrite([]);
  }, []);

  return { list, has, add, remove, update, clear };
}
