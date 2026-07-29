'use strict';

(function exposeActionDispatcher(global) {
    function escapeAttribute(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function create({ actions, adminActions = [], getRole = () => 'unknown' } = {}) {
        if (!actions || typeof actions !== 'object') throw new TypeError('actions are required');
        const adminOnly = new Set(adminActions);
        return event => {
            const target = event?.target?.closest?.('[data-action]');
            if (!target) return false;
            const action = target.dataset.action;
            const handler = actions[action];
            if (typeof handler !== 'function') return false;
            if (adminOnly.has(action) && getRole() !== 'admin') return false;
            handler(Object.freeze({ ...target.dataset }), target, event);
            return true;
        };
    }

    global.SmartHubActionDispatcher = Object.freeze({ create, escapeAttribute });
})(window);
