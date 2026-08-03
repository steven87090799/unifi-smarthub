'use strict';

(function exposeUpsPresenter(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SmartHubUps = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
    const SOURCE_LABELS = Object.freeze({
        ppb: 'PPB',
        nut: 'NUT',
        pwrstat: 'PWRSTAT',
        pmset: 'PMSET',
        unreachable: '未連接'
    });

    function sourceLabel(source) {
        return SOURCE_LABELS[source] || (source ? String(source).toUpperCase() : '未連接');
    }

    function presentUpsHealth(status = {}) {
        const requested = String(status.fetchHealth || 'unknown').toLowerCase();
        const reconfiguring = status.reconfiguring === true;
        const lastKnownSource = status.lastKnownSource
            || status.lastKnown?.actualSource
            || status.lastKnown?.source
            || null;
        const currentSource = status.actualSource
            || (requested === 'healthy' ? status.source : null)
            || null;
        const fetchHealth = reconfiguring
            ? (lastKnownSource ? 'degraded' : 'unknown')
            : ['healthy', 'degraded', 'offline', 'unknown'].includes(requested) ? requested : 'unknown';
        const source = fetchHealth === 'healthy'
            ? currentSource || 'unreachable'
            : fetchHealth === 'degraded'
                ? lastKnownSource || 'unreachable'
                : 'unreachable';
        const presentation = {
            healthy: { tone: 'healthy', label: '正常' },
            degraded: { tone: 'degraded', label: '資料暫時延遲' },
            offline: { tone: 'offline', label: '來源失聯' },
            unknown: { tone: 'unknown', label: reconfiguring ? '設定更新中' : '尚未取樣' }
        }[fetchHealth];
        return Object.freeze({
            state: fetchHealth,
            tone: presentation.tone,
            label: presentation.label,
            source,
            sourceLabel: sourceLabel(source),
            currentSource,
            lastKnownSource,
            dataIsStale: status.dataIsStale === true || fetchHealth !== 'healthy',
            reconfiguring
        });
    }

    return Object.freeze({ presentUpsHealth, sourceLabel });
});
