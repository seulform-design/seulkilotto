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
    generateSmart: (params) => {
        const q = new URLSearchParams();
        if (params.nSets)
            q.set('n_sets', String(params.nSets));
        if (params.lookback)
            q.set('lookback', String(params.lookback));
        if (params.excludeConsecutive !== undefined) {
            q.set('exclude_consecutive', String(params.excludeConsecutive));
        }
        if (params.maxOverlap !== undefined)
            q.set('max_overlap', String(params.maxOverlap));
        return fetchJson(`/api/v1/generate/smart?${q.toString()}`);
    },
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
    getPostOccurrenceAnalysis: (params) => {
        const q = new URLSearchParams();
        if (params?.roundNo)
            q.set('round_no', String(params.roundNo));
        if (params?.numbers?.length)
            q.set('numbers', params.numbers.join(','));
        if (params?.bonus != null)
            q.set('bonus', String(params.bonus));
        const qs = q.toString();
        return fetchJson(`/api/v1/post-occurrence/analysis${qs ? `?${qs}` : ''}`);
    },
    analyzeManualSlips: async (slips, opts = {}) => fetchJson('/api/v1/photo-analysis/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            sheet_intent: opts.sheetIntent ?? 'current_round',
            persist: opts.persist ?? true,
            allow_duplicate: false,
            slips: slips.map((slip) => ({
                name: slip.name ?? '',
                lines: slip.lines.map((line) => ({
                    label: line.label,
                    numbers: line.numbers,
                })),
            })),
        }),
    }),
    analyzePhotos: async (files, opts = {}) => {
        const form = new FormData();
        files.forEach((f) => form.append('files', f));
        form.append('sheet_intent', opts.sheetIntent ?? 'current_round');
        form.append('persist', String(opts.persist ?? true));
        form.append('allow_duplicate', 'false');
        return fetchJson('/api/v1/photo-analysis/analyze', {
            method: 'POST',
            body: form,
        });
    },
    getPhotoAnalysisAccumulated: () => fetchJson('/api/v1/photo-analysis/accumulated'),
    getPhotoVisionConfig: () => fetchJson('/api/v1/photo-analysis/vision-config'),
    savePhotoVisionConfig: (apiKey, model = 'gpt-4o-mini') => fetchJson('/api/v1/photo-analysis/vision-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, model }),
    }),
    disablePhotoVisionConfig: () => fetchJson('/api/v1/photo-analysis/vision-config', { method: 'DELETE' }),
    clearPhotoAnalysisStore: () => fetchJson('/api/v1/photo-analysis/store', {
        method: 'DELETE',
    }),
    deletePhotoAnalysisEntry: (entryId) => fetchJson(`/api/v1/photo-analysis/store/${entryId}`, { method: 'DELETE' }),
};
