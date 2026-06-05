import { fetchJson } from './fetchJson';
export const v1Api = {
    getMeta: () => fetchJson('/api/v1/meta'),
    getLatestDraw: () => fetchJson('/api/v1/history/latest'),
    getFrequency: (recentN) => fetchJson(`/api/v1/stats/frequency${recentN ? `?recent_n=${recentN}` : ''}`),
    analyzeCombination: (numbers) => fetchJson('/api/v1/analyze/combination', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numbers }),
    }),
    generateWeighted: (params) => {
        const q = new URLSearchParams();
        if (params.nSets)
            q.set('n_sets', String(params.nSets));
        if (params.lookback)
            q.set('lookback', String(params.lookback));
        if (params.excludeConsecutive !== undefined) {
            q.set('exclude_consecutive', String(params.excludeConsecutive));
        }
        return fetchJson(`/api/v1/generate/weights?${q.toString()}`);
    },
    getRoundRecommend: (machine) => {
        const q = new URLSearchParams();
        if (machine)
            q.set('machine', String(machine));
        const qs = q.toString();
        return fetchJson(`/api/v1/recommend/round${qs ? `?${qs}` : ''}`);
    },
    getClassicRecommend: (method = 'blend') => fetchJson(`/api/v1/recommend/classic?method=${method}`),
    getPatterns: (recentN) => fetchJson(`/api/v1/analyze/patterns${recentN ? `?recent_n=${recentN}` : ''}`),
    getUpgradeStatus: () => fetchJson('/api/v1/data/upgrade-status'),
    runUpgrade: () => fetchJson('/api/v1/data/upgrade', { method: 'POST' }),
    listRounds: (limit = 30, offset = 0) => fetchJson(`/api/v1/history/rounds?limit=${limit}&offset=${offset}`),
    getRound: (round) => fetchJson(`/api/v1/history/${round}`),
};
