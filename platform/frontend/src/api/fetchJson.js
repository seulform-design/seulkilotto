export async function fetchJson(path, init) {
    const res = await fetch(path, {
        headers: { Accept: 'application/json', ...init?.headers },
        ...init,
    });
    if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
            const j = JSON.parse(text);
            if (j.detail)
                detail = j.detail;
        }
        catch {
            /* raw text */
        }
        if (res.status === 524 || detail.includes('524') || detail.includes('timeout occurred')) {
            throw new Error('Cloudflare 터널 시간 초과(524). http://localhost:4173 에서 하거나 잠시 후 다시 시도하세요.');
        }
        if (detail.startsWith('<!DOCTYPE') || detail.startsWith('<html')) {
            throw new Error(`서버 응답 오류 (${res.status}). 터널 연결이 끊겼을 수 있습니다. localhost:4173 을 사용해 보세요.`);
        }
        throw new Error(`API 오류 (${res.status}): ${detail.slice(0, 300)}`);
    }
    return res.json();
}
