'use strict';

const express = require('express');
const path = require('node:path');
const { setFrontendSecurityHeaders } = require('./frontend-asset-routes');

function registerPanelAuthRoutes(app, { rootDir, security }) {
    if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
        throw new TypeError('Express app is required');
    }
    if (!security || typeof security.login !== 'function' || typeof security.authenticate !== 'function') {
        throw new TypeError('Panel security boundary is required');
    }

    const publicDir = path.join(rootDir, 'public');
    const sendPublicFile = (relativePath, cacheControl = 'no-cache') => (_req, res, next) => {
        setFrontendSecurityHeaders(res);
        res.setHeader('Cache-Control', cacheControl);
        res.sendFile(path.join(publicDir, relativePath), error => error ? next(error) : undefined);
    };

    app.get('/login', sendPublicFile('login.html', 'no-store'));
    app.get('/assets/login.css', sendPublicFile(path.join('assets', 'login.css')));
    app.get('/js/login.js', sendPublicFile(path.join('js', 'login.js')));
    app.get('/api/auth/status', security.status);
    app.post('/api/auth/login', express.json({ limit: '8kb', strict: true }), security.login);
    app.post('/api/auth/logout', security.logout);
}

module.exports = { registerPanelAuthRoutes };
