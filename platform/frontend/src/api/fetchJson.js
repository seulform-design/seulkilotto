export async function fetchJson(path, init) {
    const res = await fetch(path, {
        headers: { Accept: 'application/json', ...init?.headers },
        ...init,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API 오류 (${res.status}): ${text}`);
    }
    return res.json();
}
