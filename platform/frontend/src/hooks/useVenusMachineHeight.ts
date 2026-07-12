import { useEffect, useState } from 'react';

/**
 * venus-machine.html 이 postMessage 로 보고하는 실제 콘텐츠 높이를 구독한다.
 *
 * 물리 추첨기 iframe 은 캔버스(고정 480×600)+호기선택+상태+타이머+컨트롤을 세로로
 * 쌓아 실제 높이가 ~780px 인데, 부모가 고정 720px 를 잡으면 body{overflow:hidden}
 * 때문에 하단 [추첨 시작] 컨트롤이 잘려 안 보였다. iframe 이 스스로 높이를 보고하고
 * 부모가 그에 맞춰 늘리면 회차/레이아웃이 바뀌어도 다시 잘리지 않는다.
 *
 * @param fallback 메시지 도착 전 기본 높이(px). 기본 800 은 컨트롤이 보이는 안전값.
 */
export function useVenusMachineHeight(fallback = 800): number {
  const [height, setHeight] = useState(fallback);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; height?: unknown } | null;
      if (d && d.type === 'venus-machine-height' && typeof d.height === 'number') {
        // 여백 8px 여유 + 상·하한 클램프(오동작·악성 값 방어).
        setHeight(Math.max(600, Math.min(1000, Math.ceil(d.height) + 8)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return height;
}
