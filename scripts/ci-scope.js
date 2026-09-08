'use strict';

const fs = require('node:fs');

const DOCS_ONLY = /^(?:[^/]+\.(?:md|html)$|docs\/|AGENTS\.md$|CLAUDE\.md$|CONTEXT\.md$|EXCLUDE-FILES\.md$|\.claudeignore$|\.codexignore$)/u;
const TEST_FILE = /^test\//u;
const JAVASCRIPT_FILE = /\.(?:cjs|js|mjs)$/u;
const CSS_OR_FRONTEND_FILE = /^(?:public\/|.*\.css$)/u;
const RUNTIME_FILE = /^(?:Dockerfile(?:\..*)?$|docker-compose(?:\..*)?\.ya?ml$|server\.js$|server\/|public\/|db\.js$|activity-lease\.js$|observability\/|nas-monitor\/|scripts\/|package\.json$|package-lock\.json$|\.env\.example$|\.github\/workflows\/|\.github\/dependabot\.yml$|\.gitleaks\.toml$)/u;
const AUDIT_FILE = /^(?:Dockerfile(?:\..*)?$|nas-monitor\/Dockerfile$|package\.json$|package-lock\.json$|\.github\/workflows\/|\.github\/dependabot\.yml$)/u;

function readChangedFiles(filePath) {
    if (!filePath) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/u)
        .map(value => value.trim())
        .filter(Boolean);
}

function classifyChanges(files) {
    const changed = [...new Set(files)];
    const docsOnly = changed.length > 0 && changed.every(file => DOCS_ONLY.test(file));
    const hasRuntime = changed.some(file => RUNTIME_FILE.test(file));
    const hasTests = changed.some(file => TEST_FILE.test(file));
    const hasJavaScript = changed.some(file => JAVASCRIPT_FILE.test(file));
    const hasFrontend = changed.some(file => CSS_OR_FRONTEND_FILE.test(file));
    const hasAuditInput = changed.some(file => AUDIT_FILE.test(file));
    const hasUnknown = changed.some(file => !DOCS_ONLY.test(file)
        && !TEST_FILE.test(file)
        && !JAVASCRIPT_FILE.test(file)
        && !CSS_OR_FRONTEND_FILE.test(file)
        && !RUNTIME_FILE.test(file));
    const fullGate = changed.length === 0 || hasUnknown;

    return {
        changed_count: changed.length,
        docs_only: docsOnly,
        run_docs: docsOnly,
        run_tests: !docsOnly && (hasRuntime || hasTests || fullGate),
        run_js: !docsOnly && (hasJavaScript || hasRuntime || fullGate),
        run_css: !docsOnly && (hasFrontend || fullGate),
        run_audit: !docsOnly && (hasAuditInput || fullGate),
        run_runtime: !docsOnly && (hasRuntime || fullGate),
        run_current_secret_scan: true,
        run_history_secret_scan: !docsOnly && (hasRuntime || fullGate)
    };
}

function emitScope(scope) {
    for (const [key, value] of Object.entries(scope)) {
        console.log(`${key}=${typeof value === 'boolean' ? String(value) : value}`);
    }
}

if (require.main === module) {
    const files = readChangedFiles(process.argv[2]);
    const scope = classifyChanges(files);
    process.stderr.write(`CI scope: ${JSON.stringify(scope)}\n`);
    emitScope(scope);
}

module.exports = { classifyChanges, readChangedFiles };
