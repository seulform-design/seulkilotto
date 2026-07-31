/** 용지분석 딥링크 — 상단 구탭(종합/추첨기) → 용지분석 포커스. */

export const PHOTO_FOCUS_KEY = 'lotto:photo:focus:v1';

export type PhotoFocus = 'composite' | 'machine' | 'recommend' | null;

export function setPhotoFocus(focus: PhotoFocus): void {
  if (typeof window === 'undefined') return;
  try {
    if (!focus) {
      window.localStorage.removeItem(PHOTO_FOCUS_KEY);
      return;
    }
    window.localStorage.setItem(PHOTO_FOCUS_KEY, focus);
  } catch {
    /* ignore */
  }
}

/** 읽고 즉시 지움(한 번만 스크롤/펼침). */
export function takePhotoFocus(): PhotoFocus {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PHOTO_FOCUS_KEY);
    window.localStorage.removeItem(PHOTO_FOCUS_KEY);
    if (raw === 'composite' || raw === 'machine' || raw === 'recommend') return raw;
  } catch {
    /* ignore */
  }
  return null;
}

/** composite → ③ Venus · machine → ④ 호기 · 그 외 → ③ 번호추천 */
export function scrollToPhotoRecommend(opts?: { embed?: 'composite' | 'machine' }): void {
  if (typeof window === 'undefined') return;
  const id =
    opts?.embed === 'composite'
      ? 'photo-embed-composite'
      : opts?.embed === 'machine'
        ? 'engine-machine-patterns'
        : 'photo-section-recommend';
  window.requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 72; // sticky 탭 여유
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
}
