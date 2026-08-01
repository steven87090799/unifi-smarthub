        /* ==================== API security boundary ==================== */
        const nativeFetch = window.fetch.bind(window);
        let panelSecurityContextPromise = null;
        let panelAuthRedirecting = false;
        function panelLoginUrl() {
            const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            const returnPath = /^\/(?!\/)/.test(current) ? current : '/';
            return `/login?return=${encodeURIComponent(returnPath)}`;
        }
        function redirectToPanelLogin() {
            if (panelAuthRedirecting) return;
            panelAuthRedirecting = true;
            window.location.replace(panelLoginUrl());
        }
        async function redirectIfUnauthorized(response, url) {
            if (response.status !== 401 || url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return response;
            const failure = await response.clone().json().catch(() => ({}));
            if (!failure.code || String(failure.code).startsWith('API-AUTH-')) redirectToPanelLogin();
            return response;
        }
        async function logoutPanel() {
            const button = document.getElementById('panel-logout');
            if (button) button.disabled = true;
            try {
                await nativeFetch('/api/auth/logout', {
                    method: 'POST', credentials: 'same-origin', cache: 'no-store'
                });
            } catch { /* 即使網路中斷也回登入頁，避免保留過期 UI */ }
            panelSecurityContextPromise = null;
            window.location.replace('/login');
        }
        async function loadPanelSecurityContext(force = false) {
            if (force) panelSecurityContextPromise = null;
            if (!panelSecurityContextPromise) {
                panelSecurityContextPromise = nativeFetch('/api/security/csrf', {
                    credentials: 'same-origin', cache: 'no-store'
                }).then(async response => {
                    if (!response.ok) throw new Error(`Security bootstrap failed (${response.status})`);
                    const context = await response.json();
                    document.documentElement.dataset.panelRole = context.role || 'unknown';
                    return context;
                }).catch(error => {
                    panelSecurityContextPromise = null;
                    throw error;
                });
            }
            return panelSecurityContextPromise;
        }
        window.fetch = async function secureFetch(input, init = {}) {
            const request = input instanceof Request ? input : null;
            const url = new URL(request ? request.url : String(input), window.location.href);
            const method = String(init.method || request?.method || 'GET').toUpperCase();
            const protectedWrite = url.origin === window.location.origin && url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (!protectedWrite) {
                const response = await nativeFetch(input, init);
                return redirectIfUnauthorized(response, url);
            }
            const send = async forceRefresh => {
                const security = await loadPanelSecurityContext(forceRefresh);
                const headers = new Headers(request?.headers || undefined);
                new Headers(init.headers || undefined).forEach((value, key) => headers.set(key, value));
                headers.set('X-SmartHub-CSRF', security.csrfToken);
                return nativeFetch(input, { ...init, method, headers, credentials: init.credentials || 'same-origin' });
            };
            let response = await send(false);
            if (response.status === 403) {
                const failure = await response.clone().json().catch(() => ({}));
                if (failure.code === 'API-CSRF-001') response = await send(true);
            }
            return redirectIfUnauthorized(response, url);
        };

        /* ==================== Debug 工具 ==================== */
        // 前端除錯日誌：localStorage.debug='0' 可關閉。統一格式方便過濾: [HH:MM:SS][模組] 訊息
        function dbg(module, ...args) {
            if (localStorage.getItem('debug') === '0') return;
            console.debug(`[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}][${module}]`, ...args);
        }

        // 所有 API／裝置／使用者可控字串進入 HTML template 前都必須轉義。
        function escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[ch]);
        }
        const escapeActionData = window.SmartHubActionDispatcher.escapeAttribute;

        /* ==================== 版面編輯 (全站區塊 + 導航列拖曳排序，存 localStorage) ==================== */
        let layoutEditing = false, dragEl = null;

        // 可排序容器 = 各頁 section 頂層 + 任何標記 data-drag 的內部容器 (巢狀：大卡內區塊、grid 內卡片)
        function layoutContainers() {
            const list = [...document.querySelectorAll('main > section')];
            document.querySelectorAll('main [data-drag]').forEach((el, i) => {
                if (!el.dataset.dragKey) el.dataset.dragKey = el.id || 'dragc-' + i;
                list.push(el);
            });
            return list;
        }
        const layoutKeyOf = c => c.tagName === 'SECTION' ? c.id : c.dataset.dragKey;

        // 為每個容器的直屬區塊與導航項目配發穩定 ID
        function layoutTagAll() {
            layoutContainers().forEach(c => {
                const key = layoutKeyOf(c);
                [...c.children].forEach((el, i) => { if (!el.dataset.bid) el.dataset.bid = key + '-b' + i; });
            });
            [...document.querySelector('aside nav').children].forEach((el, i) => {
                if (!el.dataset.bid) el.dataset.bid = el.dataset.page ? 'nav-' + el.dataset.page : 'nav-g' + i;
            });
        }

        // 套用已儲存的排序；若區塊集合與現版 DOM 不符 (改版新增/移除區塊) 則忽略該容器的舊排序
        function layoutApplySaved() {
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem('layoutOrder.v1')) || {}; } catch (error) { console.debug('Saved layout is invalid', error); }
            layoutContainers().forEach(c => {
                const order = saved[layoutKeyOf(c)];
                if (!Array.isArray(order)) return;
                const map = {};[...c.children].forEach(el => map[el.dataset.bid] = el);
                if (order.length !== Object.keys(map).length || order.some(id => !map[id])) { dbg('Layout', layoutKeyOf(c), '排序與現版不符，略過'); return; }
                order.forEach(id => c.appendChild(map[id]));
            });
            const nav = document.querySelector('aside nav');
            const navOrder = saved.__nav;
            if (Array.isArray(navOrder)) {
                const map = {};[...nav.children].forEach(el => map[el.dataset.bid] = el);
                if (navOrder.length === Object.keys(map).length && navOrder.every(id => map[id])) navOrder.forEach(id => nav.appendChild(map[id]));
            }
        }

        function layoutSave() {
            const saved = {};
            layoutContainers().forEach(c => saved[layoutKeyOf(c)] = [...c.children].map(el => el.dataset.bid));
            saved.__nav = [...document.querySelector('aside nav').children].map(el => el.dataset.bid);
            localStorage.setItem('layoutOrder.v1', JSON.stringify(saved));
            persistUiPreference('layoutOrder.v1', saved);
            dbg('Layout', '排序已儲存');
        }

        function layoutBindDrag(container) {
            [...container.children].forEach(el => {
                el.draggable = layoutEditing;
                if (el.dataset.layoutDragBound) return;
                el.dataset.layoutDragBound = 'true';
                // stopPropagation：巢狀容器中，拖內層卡片不可連動外層
                el.addEventListener('dragstart', e => {
                    if (!layoutEditing) return;
                    e.stopPropagation();
                    dragEl = el;
                    e.dataTransfer.effectAllowed = 'move';
                    setTimeout(() => el.classList.add('drag-ghost'), 0);
                });
                el.addEventListener('dragend', e => {
                    if (!layoutEditing) return;
                    e.stopPropagation();
                    el.classList.remove('drag-ghost');
                    dragEl = null;
                    layoutSave();
                });
                el.addEventListener('dragover', e => {
                    if (!layoutEditing) return;
                    e.preventDefault();
                    if (!dragEl || dragEl === el || dragEl.parentElement !== el.parentElement) return;
                    e.stopPropagation();
                    const r = el.getBoundingClientRect();
                    // grid 橫向排列的卡片以 X 軸判斷插入點，直向堆疊用 Y 軸
                    const pr = el.parentElement.getBoundingClientRect();
                    const horiz = getComputedStyle(el.parentElement).display.includes('grid') && r.width < pr.width * 0.9;
                    const before = horiz ? (e.clientX - r.left) < r.width / 2 : (e.clientY - r.top) < r.height / 2;
                    el.parentElement.insertBefore(dragEl, before ? el : el.nextSibling);
                });
            });
        }

        function toggleLayoutEdit() {
            layoutEditing = !layoutEditing;
            document.body.classList.toggle('layout-edit', layoutEditing);
            layoutContainers().forEach(c => layoutBindDrag(c));
            layoutBindDrag(document.querySelector('aside nav'));
            document.getElementById('layout-edit-btn').classList.toggle('text-blue-400', layoutEditing);
            document.getElementById('layout-edit-btn').classList.toggle('border-blue-500', layoutEditing);
            refreshPinButtons();
            if (layoutEditing) showToast('🧩 版面編輯中：拖曳排序；其他分頁的區塊右上角有「＋總覽」可複製到總覽頁，再按一次 🧩 完成');
            else { layoutSave(); showToast('✅ 版面已儲存 (此瀏覽器)'); }
        }
        function resetLayout() { localStorage.removeItem('layoutOrder.v1'); showToast('版面已重置，重新載入中...'); setTimeout(() => location.reload(), 600); }

        /* ========== 釘選區塊到總覽 (跨分頁即時鏡像複製) ========== */
        // 原理：不搬移原區塊(避免破壞原頁與 id-based 更新)，而是在總覽放一份「鏡像」。
        // 來源 DOM 變更時才更新鏡像；不建立固定輪詢器，避免背景耗用與 observer/timer 洩漏。
        function loadPinned() { try { return JSON.parse(localStorage.getItem('pinnedBlocks.v1')) || []; } catch { return []; } }
        function savePinned(arr) { localStorage.setItem('pinnedBlocks.v1', JSON.stringify(arr)); persistUiPreference('pinnedBlocks.v1', arr); }
        const pinnedObservers = window.SmartHubFrontendLifecycle.createObserverRegistry();
        function disconnectPinnedObservers() {
            pinnedObservers.disconnectAll();
        }
        function pageTitleOfBid(bid) {
            const src = document.querySelector(`[data-bid="${bid}"]`);
            const sec = src && src.closest('main > section');
            const nav = sec && document.querySelector(`aside nav [data-page="${sec.id.replace('page-', '')}"]`);
            return nav ? (nav.textContent || '').trim().replace(/\s+/g, ' ') : '';
        }
        function pinBlock(bid) {
            const arr = loadPinned();
            if (arr.includes(bid)) { showToast('這個區塊已在總覽'); return; }
            arr.push(bid); savePinned(arr); renderPinned();
            showToast('✅ 已加到總覽（總覽頁頂端）');
        }
        function unpinBlock(bid) { savePinned(loadPinned().filter(b => b !== bid)); renderPinned(); }
        function renderPinned() {
            const wrap = document.getElementById('ov-pinned'); if (!wrap) return;
            disconnectPinnedObservers();
            const arr = loadPinned();
            wrap.replaceChildren();
            arr.forEach(bid => {
                const src = document.querySelector(`[data-bid="${bid}"]`);
                if (!src) return; // 來源不存在(改版) → 略過
                const holder = document.createElement('div');
                holder.className = 'relative rounded-2xl';
                holder.dataset.mirrorOf = bid;
                const badge = document.createElement('div');
                badge.className = 'pin-badge flex items-center justify-between mb-1 px-1';
                const t = pageTitleOfBid(bid);
                badge.innerHTML = `<span class="text-[9px] text-blue-400/80 font-bold uppercase tracking-wider">📌 釘選自 ${t || '其他分頁'}</span>`;
                const rm = document.createElement('button');
                rm.className = 'text-[9px] text-slate-500 hover:text-red-400 font-bold';
                rm.textContent = '✕ 移除';
                rm.addEventListener('click', () => unpinBlock(bid));
                badge.appendChild(rm);
                const mirror = document.createElement('div');
                mirror.className = 'pinned-mirror';
                holder.appendChild(badge); holder.appendChild(mirror);
                wrap.appendChild(holder);
            });
            syncPinned();
        }
        function updatePinnedMirror(holder) {
            const src = document.querySelector(`[data-bid="${holder.dataset.mirrorOf}"]`);
            const mirror = holder.querySelector('.pinned-mirror');
            if (!src || !mirror) return;
            mirror.replaceChildren(...[...src.childNodes].map(node => node.cloneNode(true)));
            mirror.className = `pinned-mirror ${src.className}`;
            mirror.inert = true;
            mirror.setAttribute('aria-hidden', 'true');
            mirror.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
            mirror.querySelectorAll('.pin-add-btn').forEach(e => e.remove());
            mirror.querySelectorAll('button, a, input, select, textarea, form, [data-action], [tabindex], [onclick]').forEach(control => {
                control.removeAttribute('data-action');
                control.removeAttribute('tabindex');
                control.removeAttribute('onclick');
                if (control.matches('a')) control.removeAttribute('href');
                if (control.matches('button, input, select, textarea')) control.disabled = true;
            });
            const sc = src.querySelectorAll('canvas'), mc = mirror.querySelectorAll('canvas');
            sc.forEach((c, i) => { try { const d = mc[i]; if (d && c.width) { d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); } } catch (error) { console.debug('Pinned chart copy failed', error); } });
        }
        function observePinnedSource(_bid, src, holder) {
            pinnedObservers.observe(holder, src, () => updatePinnedMirror(holder), {
                childList: true, characterData: true, attributes: true, subtree: true
            });
        }
        function syncPinned() {
            if (document.visibilityState !== 'visible' || document.getElementById('page-overview')?.classList.contains('hidden')) return;
            document.querySelectorAll('#ov-pinned [data-mirror-of]').forEach(holder => {
                const src = document.querySelector(`[data-bid="${holder.dataset.mirrorOf}"]`);
                if (!src) return;
                updatePinnedMirror(holder);
                observePinnedSource(holder.dataset.mirrorOf, src, holder);
            });
        }
        window.addEventListener('pagehide', () => {
            disconnectPinnedObservers();
            disconnectNasSse();
        });
        window.addEventListener('pageshow', () => {
            if (document.visibilityState !== 'visible') return;
            if (currentPage === 'overview') syncPinned();
            if (currentPage === 'nas') hydratePage('nas', { force: true, only: ['nasAlertConfig'], generation: navigationGeneration });
        });

        // 編輯模式時，為各分頁(除總覽外)的每個區塊注入「+ 加到總覽」按鈕
        function refreshPinButtons() {
            document.querySelectorAll('.pin-add-btn').forEach(b => b.remove());
            if (!layoutEditing) return;
            layoutTagAll();
            document.querySelectorAll('main > section:not(#page-overview) [data-bid]').forEach(el => {
                if (el.closest('#ov-pinned')) return;
                if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
                const btn = document.createElement('button');
                btn.className = 'pin-add-btn';
                btn.title = '加到總覽';
                btn.textContent = '＋總覽';
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    e.preventDefault();
                    pinBlock(el.dataset.bid);
                });
                el.appendChild(btn);
            });
        }
        // 編輯模式時攔截主內容區點擊，避免拖曳時誤觸卡片跳頁
        document.addEventListener('click', e => {
            // 總覽釘選的新增與移除按鈕都要放行，否則編輯模式的防誤觸攔截會吃掉點擊。
            if (layoutEditing && e.target.closest('.pin-add-btn, .pin-badge button')) return;
            if (layoutEditing && e.target.closest('main > section')) { e.stopPropagation(); e.preventDefault(); }
        }, true);

        /* ==================== 共用 UI / Chart System ==================== */
        const compactNumberFormatter = new Intl.NumberFormat('zh-TW', { notation: 'compact', maximumFractionDigits: 1 });
        const preciseNumberFormatter = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });

        function compactNumber(value) {
            const number = Number(value);
            if (!Number.isFinite(number)) return value == null ? '--' : String(value);
            return Math.abs(number) >= 1000 ? compactNumberFormatter.format(number) : preciseNumberFormatter.format(number);
        }

        function chartUnit(dataset) {
            const label = String(dataset?.label || '').toLowerCase();
            if (label.includes('°c') || label.includes('溫度')) return '°C';
            if (label.includes('rpm') || label.includes('風扇')) return ' RPM';
            if (label.includes('延遲') || label.includes('(ms)')) return ' ms';
            if (label.includes('mbps') || label.includes('下載') || label.includes('上傳')) return ' Mbps';
            if (label.includes('gb')) return ' GB';
            if (label.includes('(v)') || label.includes('電壓') || label.includes('市電') || label.includes('ups 輸出')) return ' V';
            if (label.includes('%') || label.includes('cpu') || label.includes('記憶體') || label.includes('負載') || label.includes('電池')) return '%';
            return '';
        }

        function formatChartValue(value, dataset) {
            const raw = value && typeof value === 'object' ? (value.y ?? value.r ?? value.x) : value;
            return `${compactNumber(raw)}${chartUnit(dataset)}`;
        }

        function chartPointBudget() { return window.innerWidth < 640 ? 72 : 180; }

        // 多欄位、峰值優先的視覺降採樣。統計仍使用原始資料，僅降低 canvas 繪製點數。
        function downsampleRows(rows, keys = [], target = chartPointBudget()) {
            if (!Array.isArray(rows) || rows.length <= target || target < 4) return rows || [];
            const numericKeys = keys.filter(key => rows.some(row => Number.isFinite(Number(row?.[key]))));
            if (!numericKeys.length) {
                const stride = (rows.length - 1) / (target - 1);
                return Array.from({ length: target }, (_, index) => rows[Math.round(index * stride)]);
            }
            const ranges = Object.fromEntries(numericKeys.map(key => {
                const values = rows.map(row => Number(row?.[key])).filter(Number.isFinite);
                return [key, Math.max(1, Math.max(...values) - Math.min(...values))];
            }));
            const selected = [rows[0]];
            const stride = (rows.length - 2) / (target - 2);
            for (let bucket = 0; bucket < target - 2; bucket++) {
                const start = Math.max(1, Math.floor(1 + bucket * stride));
                const end = Math.min(rows.length - 1, Math.ceil(1 + (bucket + 1) * stride));
                const before = rows[Math.max(0, start - 1)];
                const after = rows[Math.min(rows.length - 1, end)];
                let bestIndex = start;
                let bestScore = -1;
                for (let index = start; index < end; index++) {
                    const ratio = end === start ? 0 : (index - start + 1) / (end - start + 1);
                    const score = numericKeys.reduce((maxScore, key) => {
                        const current = Number(rows[index]?.[key]);
                        const left = Number(before?.[key]);
                        const right = Number(after?.[key]);
                        if (![current, left, right].every(Number.isFinite)) return maxScore;
                        const expected = left + (right - left) * ratio;
                        return Math.max(maxScore, Math.abs(current - expected) / ranges[key]);
                    }, 0);
                    if (score > bestScore) { bestScore = score; bestIndex = index; }
                }
                selected.push(rows[bestIndex]);
            }
            selected.push(rows[rows.length - 1]);
            return selected;
        }

        function uiExternalTooltip({ chart, tooltip }) {
            const host = chart.canvas.parentElement;
            if (!host) return;
            host.classList.add('chart-host');
            let element = host.querySelector('.chart-tooltip');
            if (!element) {
                element = document.createElement('div');
                element.className = 'chart-tooltip';
                element.setAttribute('role', 'tooltip');
                host.appendChild(element);
            }
            if (!tooltip || tooltip.opacity === 0) { element.style.opacity = '0'; return; }
            const points = (tooltip.dataPoints || []).filter(point => point.raw != null);
            const visible = points.slice(0, 4);
            const rows = visible.map(point => {
                const color = point.dataset.borderColor || point.dataset.backgroundColor || '#94a3b8';
                return `<div class="chart-tooltip-row"><span class="chart-tooltip-dot" style="background:${escapeHtml(Array.isArray(color) ? color[point.dataIndex] : color)}"></span><span class="chart-tooltip-label">${escapeHtml(point.dataset.label || '數值')}</span><span class="chart-tooltip-value">${escapeHtml(formatChartValue(point.parsed, point.dataset))}</span></div>`;
            }).join('');
            const more = points.length > 4 ? `<div class="chart-tooltip-more">另有 ${points.length - 4} 項，點擊資料點查看完整明細</div>` : '<div class="chart-tooltip-more">點擊可固定完整明細</div>';
            element.innerHTML = `<div class="chart-tooltip-title">${escapeHtml(tooltip.title?.[0] || '')}</div>${rows}${more}`;
            element.style.opacity = '1';
            const half = Math.min(150, element.offsetWidth / 2 || 100);
            const left = Math.max(half + 6, Math.min(host.clientWidth - half - 6, tooltip.caretX));
            element.style.left = `${left}px`;
            element.style.top = `${Math.max(26, tooltip.caretY)}px`;
        }

        function ensureChartDetailPanel(chart) {
            const host = chart.canvas.parentElement;
            if (!host) return null;
            const id = `chart-detail-${chart.canvas.id || chart.id}`;
            let panel = document.getElementById(id);
            if (!panel) {
                panel = document.createElement('div');
                panel.id = id;
                panel.className = 'chart-detail-panel';
                panel.setAttribute('role', 'region');
                panel.setAttribute('aria-live', 'polite');
                host.insertAdjacentElement('afterend', panel);
            }
            return panel;
        }

        function showChartDetail(chart, dataIndex) {
            const panel = ensureChartDetailPanel(chart);
            if (!panel) return;
            const label = chart.data.labels?.[dataIndex] ?? `資料點 ${dataIndex + 1}`;
            const items = chart.data.datasets.map((dataset, datasetIndex) => ({
                label: dataset.label || `系列 ${datasetIndex + 1}`,
                value: dataset.data?.[dataIndex],
                color: Array.isArray(dataset.borderColor) ? dataset.borderColor[dataIndex] : (dataset.borderColor || dataset.backgroundColor || '#94a3b8'),
                dataset
            })).filter(item => item.value != null);
            panel.innerHTML = `<div class="chart-detail-head"><div><p class="chart-detail-title">${escapeHtml(label)}</p><p class="text-[10px] text-slate-500 mt-0.5">已固定資料點 · 可切換上方系列比較</p></div><button type="button" class="chart-detail-close" aria-label="關閉資料點明細">✕</button></div><div class="chart-detail-grid">${items.map(item => `<div class="chart-detail-item"><div class="chart-detail-label"><span class="chart-tooltip-dot" style="background:${escapeHtml(item.color)}"></span>${escapeHtml(item.label)}</div><div class="chart-detail-value">${escapeHtml(formatChartValue(item.value, item.dataset))}</div></div>`).join('')}</div>`;
            panel.classList.add('is-open');
            if (!panel.dataset.closeActionBound) {
                panel.dataset.closeActionBound = 'true';
                panel.addEventListener('click', event => {
                    if (event.target.closest('.chart-detail-close')) panel.classList.remove('is-open');
                });
            }
        }

        function renderHtmlChartLegend(chart) {
            if (!chart.$htmlLegendEnabled || chart.data.datasets.length < 2) return;
            const host = chart.canvas.parentElement;
            if (!host) return;
            const legendId = `chart-legend-${chart.canvas.id || chart.id}`;
            let toolbar = document.getElementById(legendId);
            if (!toolbar) {
                toolbar = document.createElement('div');
                toolbar.id = legendId;
                toolbar.className = 'chart-legend-toolbar';
                toolbar.setAttribute('aria-label', '圖表系列切換');
                host.insertAdjacentElement('beforebegin', toolbar);
            }
            const signature = chart.data.datasets.map(dataset => `${dataset.label}|${dataset.borderColor}`).join('::');
            if (toolbar.dataset.signature !== signature) {
                toolbar.dataset.signature = signature;
                toolbar.innerHTML = '';
                chart.data.datasets.forEach((dataset, index) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.dataset.datasetIndex = index;
                    button.innerHTML = `<span class="chart-legend-swatch" style="background:${escapeHtml(Array.isArray(dataset.borderColor) ? dataset.borderColor[0] : (dataset.borderColor || dataset.backgroundColor || '#94a3b8'))}"></span><span>${escapeHtml(dataset.label || `系列 ${index + 1}`)}</span>`;
                    button.addEventListener('click', () => {
                        chart.setDatasetVisibility(index, !chart.isDatasetVisible(index));
                        chart.update();
                    });
                    toolbar.appendChild(button);
                });
            }
            toolbar.querySelectorAll('button').forEach(button => {
                const index = Number(button.dataset.datasetIndex);
                button.setAttribute('aria-pressed', chart.isDatasetVisible(index) ? 'true' : 'false');
            });
        }

        // 這層不是假資料：只把已取得的 dataset 用遮罩由左至右揭露。
        // 讓一次真實更新在約 1.2 秒內有明確的「曲線被畫出來」感，而不增加 API 或 DB 頻率。
        const chartRevealPlugin = {
            id: 'chartReveal',
            beforeDatasetsDraw(chart) {
                const reveal = chart.$uiReveal;
                if (!reveal || !chart.chartArea) return;
                const elapsed = Math.min(1, (performance.now() - reveal.startedAt) / reveal.duration);
                const progress = 1 - Math.pow(1 - elapsed, 3);
                const { left, right, top, bottom } = chart.chartArea;
                const ctx = chart.ctx;
                ctx.save();
                ctx.beginPath();
                if (chart.config.type === 'bar') {
                    const revealTop = bottom - (bottom - top) * progress;
                    ctx.rect(left - 2, revealTop - 2, right - left + 4, bottom - revealTop + 4);
                } else {
                    const revealRight = left + (right - left) * progress;
                    ctx.rect(left - 2, top - 2, revealRight - left + 4, bottom - top + 4);
                }
                ctx.clip();
                reveal.clipped = true;
            },
            afterDatasetsDraw(chart) {
                const reveal = chart.$uiReveal;
                if (reveal?.clipped) {
                    chart.ctx.restore();
                    reveal.clipped = false;
                }
            }
        };

        const smartChartUxPlugin = {
            id: 'smartChartUx',
            beforeInit(chart) {
                const host = chart.canvas.parentElement;
                if (host) host.classList.add('chart-host', 'chart-loading');
                chart.canvas.setAttribute('role', 'img');
                chart.canvas.setAttribute('tabindex', '0');
                chart.canvas.setAttribute('aria-label', `${chart.data.datasets.map(dataset => dataset.label).filter(Boolean).join('、') || '資料'}圖表；滑過查看摘要，點擊資料點固定完整明細`);
                const legendConfig = chart.config.options?.plugins?.legend;
                const compactLegend = ['nasHeroChart'].includes(chart.canvas.id);
                chart.$htmlLegendEnabled = chart.config.type !== 'doughnut' && chart.data.datasets.length > 1 && !compactLegend;
                if (chart.$htmlLegendEnabled && legendConfig) legendConfig.display = false;
                chart.canvas.addEventListener('click', event => {
                    const points = chart.getElementsAtEventForMode(event, 'nearest', { intersect: false }, true);
                    if (points.length) showChartDetail(chart, points[0].index);
                });
            },
            beforeUpdate(chart) {
                const scales = chart.config.options?.scales || {};
                const mobile = window.innerWidth < 640;
                Object.entries(scales).forEach(([axisId, scale]) => {
                    scale.ticks ||= {};
                    scale.ticks.autoSkip = true;
                    scale.ticks.padding ??= 7;
                    if (axisId.toLowerCase().startsWith('x')) {
                        scale.ticks.maxTicksLimit = Math.min(scale.ticks.maxTicksLimit || 10, mobile ? 4 : 10);
                        scale.ticks.maxRotation = 0;
                        scale.ticks.minRotation = 0;
                    } else {
                        scale.ticks.maxTicksLimit = Math.min(scale.ticks.maxTicksLimit || 7, mobile ? 5 : 7);
                    }
                });
            },
            afterUpdate(chart) { renderHtmlChartLegend(chart); },
            afterRender(chart) { chart.canvas.parentElement?.classList.remove('chart-loading'); },
            afterDraw(chart) {
                if (!['line', 'bar'].includes(chart.config.type)) return;
                const active = chart.getActiveElements();
                if (!active.length || !chart.chartArea) return;
                const x = active[0].element.x;
                const ctx = chart.ctx;
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, chart.chartArea.top);
                ctx.lineTo(x, chart.chartArea.bottom);
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = 'rgba(148, 163, 184, .5)';
                ctx.stroke();
                ctx.restore();
            }
        };

        Chart.defaults.color = '#94a3b8';
        Chart.defaults.font.family = "'Noto Sans TC', sans-serif";
        Chart.defaults.font.size = 11;
        Chart.defaults.animation.duration = 240;
        Chart.defaults.animation.easing = 'easeOutQuart';
        Chart.defaults.interaction.mode = 'index';
        Chart.defaults.interaction.intersect = false;
        Chart.defaults.elements.line.borderWidth = 1.8;
        Chart.defaults.elements.point.radius = 0;
        Chart.defaults.elements.point.hoverRadius = 5;
        Chart.defaults.elements.point.hitRadius = 14;
        Chart.defaults.plugins.tooltip.enabled = false;
        Chart.defaults.plugins.tooltip.external = uiExternalTooltip;
        Chart.defaults.plugins.legend.labels.usePointStyle = true;
        Chart.defaults.plugins.legend.labels.pointStyle = 'line';
        Chart.defaults.plugins.legend.labels.padding = 14;
        if (Chart.defaults.scales?.linear?.ticks) Chart.defaults.scales.linear.ticks.callback = value => compactNumber(value);
        Chart.register(chartRevealPlugin, smartChartUxPlugin);

        // 歷史圖只在首次顯示、切換範圍或重新進入頁面時播放進場動畫。
        // 背景輪詢仍使用無動畫更新，避免畫面反覆跳動與不必要的繪製負擔。
        function chartHasRenderableData(chart) {
            return chart?.data?.datasets?.some(dataset => Array.isArray(dataset.data) && dataset.data.some(value => value != null));
        }

        function requestChartReplay(...charts) {
            charts.filter(Boolean).forEach(chart => { chart.$uiReplayNext = true; });
        }

        function playChartReveal(chart) {
            if (!chart || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
            const host = chart.canvas.parentElement;
            chart.$uiReveal = { startedAt: performance.now(), duration: 1200, clipped: false };
            host?.classList.add('chart-reveal-active');
            const paint = () => {
                const reveal = chart.$uiReveal;
                if (!reveal) return;
                chart.draw();
                if (performance.now() - reveal.startedAt < reveal.duration) {
                    requestAnimationFrame(paint);
                } else {
                    chart.$uiReveal = null;
                    host?.classList.remove('chart-reveal-active');
                    chart.draw();
                }
            };
            requestAnimationFrame(paint);
        }

        function updateChartWithEntrance(chart) {
            if (!chart) return;
            const hasData = chartHasRenderableData(chart);
            const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const shouldAnimate = hasData && !reduceMotion && (!chart.$uiEntrancePlayed || chart.$uiReplayNext);
            if (!shouldAnimate) {
                chart.update('none');
                return;
            }

            chart.$uiReplayNext = false;
            chart.$uiEntrancePlayed = true;
            chart.options.animation = { duration: 420, easing: 'easeOutQuart' };
            // 動態 dataset（例如 NAS 硬碟清單）要先建立對應 controller，
            // 否則 Chart.js 在 reset 階段可能遇到尚未初始化的 meta。
            chart.update('none');
            chart.reset();
            chart.update();
            playChartReveal(chart);
        }

        function replayPageChartEntrances(page) {
            const pageCharts = {
                overview: [trendChart, ovHourlyChart],
                security: [secHourlyChart],
                ucg: [hwChart, ucgHistChart],
                nas: [nasHeroChart, nasSystemChart, nasTrafficChart, nasStorageChart, nasTempChart],
                wiim: [wiimChart],
                ups: [upsHeroChart, upsVoltChart, upsLoadChart],
                linuxhost: [lnxChart]
            }[page] || [];
            const readyCharts = pageCharts.filter(chart => chartHasRenderableData(chart));
            requestChartReplay(...readyCharts);
            readyCharts.forEach(updateChartWithEntrance);
        }

        function syncLoadingState(element) {
            if (!(element instanceof HTMLElement) || !element.matches('main p')) return;
            const text = element.textContent.trim();
            const loading = text.length < 32 && /^(載入|讀取|分析|偵測|等待|連線).*(中|\.\.\.|…)$/.test(text);
            element.classList.toggle('ui-loading-state', loading);
            element.classList.toggle('ui-empty-state', !loading && text.length < 80 && /^(尚無|無.*資料|暫無|沒有|無容器)/.test(text));
            element.classList.toggle('ui-error-state', !loading && text.length < 100 && /^(讀取失敗|載入失敗|分析失敗|無法讀取|連線失敗)/.test(text));
        }

        function setDialogState(id, open) {
            const modal = document.getElementById(id);
            if (!modal) return;
            modal.setAttribute('aria-hidden', open ? 'false' : 'true');
            if (open) {
                modal._returnFocus = document.activeElement;
                requestAnimationFrame(() => modal.querySelector('button')?.focus());
            } else if (modal._returnFocus?.focus) {
                modal._returnFocus.focus();
                modal._returnFocus = null;
            }
        }

        function persistUiPreference(key, value) {
            fetch('/api/ui-preferences', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: { [key]: value } })
            }).catch(() => { /* 離線時保留瀏覽器版本，下一次操作再同步 */ });
        }
        async function restoreUiPreferences() {
            try {
                const response = await fetch('/api/ui-preferences');
                if (!response.ok) return;
                const saved = (await response.json()).preferences || {};
                let changed = false;
                Object.entries(saved).forEach(([key, value]) => {
                    const next = typeof value === 'string' ? value : JSON.stringify(value);
                    if (localStorage.getItem(key) !== next) { localStorage.setItem(key, next); changed = true; }
                });
                if (changed) location.reload();
            } catch { /* 沒有後端時沿用瀏覽器本機偏好 */ }
        }
        function initUiSystem() {
            document.querySelectorAll('button:not([type])').forEach(button => { button.type = 'button'; });
            document.querySelector('.nav-btn[data-page="overview"]')?.setAttribute('aria-current', 'page');
            document.querySelector('header button[aria-controls="sidebar"]')?.setAttribute('aria-expanded', 'false');
            document.getElementById('sidebar')?.setAttribute('aria-hidden', window.innerWidth < 1024 ? 'true' : 'false');
            document.querySelectorAll('main table').forEach(table => {
                const region = table.parentElement;
                if (!region) return;
                region.classList.add('table-scroll-region');
                region.tabIndex = 0;
                const section = table.closest('section');
                region.setAttribute('aria-label', `${PAGE_META[section?.id?.replace('page-', '')]?.[0] || 'SmartHub'} 資料表，可水平捲動`);
            });
            document.querySelectorAll('.kpi-card, main [onclick].rounded-2xl, main [onclick].rounded-xl').forEach(element => {
                if (element.matches('button, a, input')) return;
                element.setAttribute('role', 'button');
                element.tabIndex = 0;
                element.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); element.click(); }
                });
            });
            document.querySelectorAll('main p').forEach(syncLoadingState);
            const observer = new MutationObserver(mutations => mutations.forEach(mutation => {
                const element = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
                if (element?.matches?.('p')) syncLoadingState(element);
                element?.querySelectorAll?.('p').forEach(syncLoadingState);
            }));
            observer.observe(document.querySelector('main'), { childList: true, characterData: true, subtree: true });
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                if (!document.getElementById('client-modal').classList.contains('hidden')) closeClientDetail();
                else if (!document.getElementById('smart-modal').classList.contains('hidden')) closeDiskSmart();
                else if (!document.getElementById('docker-log-modal').classList.contains('hidden')) closeDockerLog();
            });
            restoreUiPreferences();
        }

        function refreshChartTheme(theme) {
            const light = theme === 'light';
            const muted = light ? '#475569' : '#94a3b8';
            const grid = light ? 'rgba(100,116,139,.18)' : 'rgba(51,65,85,.28)';
            Chart.defaults.color = muted;
            Chart.defaults.borderColor = grid;
            Object.values(Chart.instances || {}).forEach(chart => {
                const legendLabels = chart.config.options?.plugins?.legend?.labels;
                if (legendLabels) legendLabels.color = muted;
                Object.values(chart.config.options?.scales || {}).forEach(scale => {
                    if (scale.ticks && ['#64748b', '#94a3b8', '#cbd5e1'].includes(String(scale.ticks.color))) scale.ticks.color = muted;
                    if (scale.grid && scale.grid.display !== false) scale.grid.color = grid;
                });
                chart.update('none');
            });
        }

        /* ==================== 全域狀態 ==================== */
        let allClients = [];
        let allThreats = [];
        let activeTimeRangeDays = 30;
        let loggedThreatIds = new Set();
        let lastThreatId = null;
        let lastIpsToastTs = 0; // 即使有多筆不同的新威脅，同一波最多每 15 秒跳一次通知泡泡，避免看起來「卡住不消失」
        let hwChart = null, threatChart = null, trendChart = null, ovHourlyChart = null, secHourlyChart = null;
        let nasSystemChart = null, nasTrafficChart = null, nasStorageChart = null, nasTempChart = null;
        let nasDiskMeta = {};
        let nasHeroChart = null, nasHeroLabels = [], nasHeroTempData = [], nasHeroUsageData = [];
        let upsHeroChart = null, upsHeroBattData = [], upsHeroVoltData = [], upsHeroLabels = [];

        // Hero 圖只用真實歷史樣本預填，避免以 0 佔位而產生右側突然跳起的假曲線。
        function seedHeroChart(chart, labels, seriesList, rows, valueFns) {
            if (!chart || chart.$realHistorySeeded || !Array.isArray(rows)) return false;
            const usable = rows.filter(row => valueFns.every(getValue => {
                const value = getValue(row);
                return value != null && Number.isFinite(Number(value));
            })).slice(-12);
            if (usable.length < 2) return false;
            labels.splice(0, labels.length, ...usable.map(row => new Date(row.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })));
            seriesList.forEach((series, index) => series.splice(0, series.length, ...usable.map(row => Number(valueFns[index](row)))));
            chart.$realHistorySeeded = true;
            requestChartReplay(chart);
            updateChartWithEntrance(chart);
            return true;
        }
        function initNasHeroChart() {
            const c = document.getElementById('nasHeroChart'); if (!c) return;
            nasHeroChart = new Chart(c, {
                type: 'line', data: { labels: nasHeroLabels, datasets: [
                    { label: '溫度 °C', data: nasHeroTempData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.05)', fill: true, yAxisID: 'yTemp', tension: 0.3, pointRadius: 0 },
                    { label: '負載 %', data: nasHeroUsageData, borderColor: '#64748b', borderDash: [3, 3], fill: false, yAxisID: 'yUsage', tension: 0.3, pointRadius: 0 }
                ] },
                options: {
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        yTemp: { position: 'left', ticks: { color: '#64748b', font: { size: 8 } }, grid: { color: 'rgba(30,41,59,0.4)' } },
                        yUsage: { position: 'right', min: 0, max: 100, ticks: { display: false }, grid: { display: false } }
                    }
                }
            });
        }
        function initUpsHeroChart() {
            const c = document.getElementById('upsHeroChart'); if (!c) return;
            upsHeroChart = new Chart(c, {
                type: 'line', data: { labels: upsHeroLabels, datasets: [
                    { label: '電池電量 (%)', data: upsHeroBattData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.05)', fill: true, yAxisID: 'yBatt', tension: 0.3, pointRadius: 0 },
                    { label: '輸出電壓 (V)', data: upsHeroVoltData, borderColor: '#f59e0b', borderDash: [3, 3], fill: false, yAxisID: 'yVolt', tension: 0.3, pointRadius: 0 }
                ] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: true, labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 9 } } },
                        tooltip: {
                            callbacks: {
                                label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}${ctx.dataset.yAxisID === 'yBatt' ? '%' : 'V'}`
                            }
                        }
                    },
                    scales: {
                        x: { display: false },
                        yBatt: { position: 'left', min: 0, max: 100, ticks: { color: '#3b82f6', font: { size: 8 }, callback: v => v + '%' }, grid: { color: 'rgba(30,41,59,0.4)' } },
                        yVolt: { position: 'right', ticks: { color: '#f59e0b', font: { size: 8 }, callback: v => v + 'V' }, grid: { display: false } }
                    }
                }
            });
        }
        let upsVoltChart = null, upsLoadChart = null, upsRangeHours = 24, upsLoadRangeHours = 24;
        let trendHours = 24;
        let autoDefenseOn = false;
        const THREAT_CATS = ['Web Exploit', 'Brute Force', 'Scanner', 'Malware', 'DoS', 'Manual Block'];
        const CAT_COLORS = { 'Web Exploit': '#ef4444', 'Brute Force': '#f59e0b', 'Scanner': '#3b82f6', 'Malware': '#10b981', 'DoS': '#8b5cf6', 'Manual Block': '#ec4899' };
        let chartLabels = [];
        let tempChartData = [];
        let usageChartData = [];

        const PAGE_META = {
            overview: ['總覽 Overview', '全系統健康狀態一覽'],
            clients: ['客戶端 Clients', '連線終端管理、流量排行與封鎖歷史'],
            security: ['資安 Security', 'IPS/IDS 威脅監看（純監看，不影響主控台設定）'],
            wifi: ['WiFi 射頻', 'SSID 廣播控制與訪客憑證'],
            cloud: ['雲端站點 Cloud', 'UniFi Site Manager 多站點監控'],
            ucg: ['UCG 閘道器', 'UCG-Ultra 處理器溫度、核心負載與硬體資源 (SSH 真實數據)'],
            nas: ['NAS 儲存', 'UGREEN UGOS Pro 儲存與硬體監控'],
            wiim: ['WiiM 音響', 'WiiM Amp 音訊串流與硬體監控'],
            ups: ['UPS 電源', 'CyberPower 不斷電系統 — 電壓紀錄與斷電事件 (NUT)'],
            adguard: ['AdGuard DNS', 'AdGuard Home 全網 DNS 廣告與追蹤攔截統計'],
            linuxhost: ['Linux 小主機', 'Home Assistant 主機 SSH 硬體監控 (真實數據)'],
            tools: ['工具 Tools', '網速測試與 PoE 管理'],
            notify: ['通知推播', '威脅與 NAS 警報自動推播到 Discord / Telegram / Webhook'],
            settings: ['設定 Settings', '調整所有輪詢間隔、主題、定期報表']
        };

        /* ==================== 導航 ==================== */
        let currentPage = 'overview';
        let navigationGeneration = 0;
        function navigate(page) {
            const generation = ++navigationGeneration;
            currentPage = page;
            // 重新觸發分頁進場動畫
            const target = document.getElementById('page-' + page);
            if (target) { target.style.animation = 'none'; void target.offsetWidth; target.style.animation = ''; }
            Object.keys(PAGE_META).forEach(p => {
                const sec = document.getElementById('page-' + p);
                if (sec) sec.classList.toggle('hidden', p !== page);
                const btn = document.querySelector(`.nav-btn[data-page="${p}"]`);
                if (btn) {
                    btn.className = `nav-btn ${p === page ? 'nav-active' : 'nav-idle'} w-full flex items-center gap-3 px-5 py-2.5 text-xs font-bold transition text-left`;
                    btn.setAttribute('aria-current', p === page ? 'page' : 'false');
                }
            });
            document.getElementById('page-title').innerText = PAGE_META[page][0];
            document.getElementById('page-subtitle').innerText = PAGE_META[page][1];
            toggleSidebar(false);
            if (page !== 'nas') disconnectNasSse();
            if (page !== 'overview') disconnectPinnedObservers();
            if (page === 'overview') syncPinned();
            sendHeartbeat(true);
            hydratePage(page, { generation }).then(() => { if (currentPage === page && generation === navigationGeneration) applyPolling(true); });
            applyPolling();
            requestAnimationFrame(() => {
                [hwChart, threatChart, trendChart, ovHourlyChart, secHourlyChart, nasSystemChart, nasTrafficChart, nasStorageChart, nasTempChart, upsVoltChart, upsLoadChart, wiimChart, ucgHistChart, nasHeroChart, upsHeroChart].forEach(c => c && c.resize());
                replayPageChartEntrances(page);
            });
            window.scrollTo({ top: 0 });
        }

        function toggleSidebar(open) {
            document.getElementById('sidebar').classList.toggle('-translate-x-full', !open);
            document.getElementById('sidebar-backdrop').classList.toggle('hidden', !open);
            const trigger = document.querySelector('header button[aria-controls="sidebar"]');
            if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
            document.getElementById('sidebar').setAttribute('aria-hidden', window.innerWidth < 1024 && !open ? 'true' : 'false');
        }

        const OVERVIEW_FLIP_NUMBER_IDS = [
            'kpi-clients', 'kpi-threats', 'kpi-temp', 'kpi-nas-temp', 'kpi-wiim-temp',
            'ov-ucg-temp', 'ov-nas-temp', 'ov-wiim-temp', 'sec-score'
        ];
        function initOverviewFlipNumbers() {
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
            OVERVIEW_FLIP_NUMBER_IDS.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.classList.add('metric-flip-value');
                el.dataset.flipValue = el.textContent.trim();
                new MutationObserver(() => {
                    const next = el.textContent.trim();
                    if (next === el.dataset.flipValue) return;
                    el.dataset.flipValue = next;
                    el.classList.remove('metric-flip-up');
                    void el.offsetWidth;
                    el.classList.add('metric-flip-up');
                }).observe(el, { childList: true, characterData: true, subtree: true });
            });
        }

        /* ==================== 初始化 ==================== */
        window.addEventListener('load', () => {
            initUiSystem();
            initOverviewFlipNumbers();
            layoutTagAll();
            layoutApplySaved();
            renderPinned();
            initChart();
            initThreatPieChart();
            initTrendChart();
            initHourlyCharts();
            initNasCharts();
            initUpsCharts();
            initUcgHistChart();
            initNasHeroChart();
            initUpsHeroChart();
            initWorldMap();
            initWiimSrcDrag();
            setTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');
            checkLastSpeedtest();
            Promise.allSettled([fetchAppSettings(), fetchCritAlerts(), fetchSystemStatus()])
                .finally(() => hydratePage('overview').finally(() => { sendHeartbeat(true); applyPolling(); }));
        });

        /* ==================== 前端輪詢管理（間隔由 /api/settings 提供） ==================== */
        const POLL_JOBS = {
            adguard: { fn: () => Promise.all([fetchAdguard(), fetchAdgLog(), fetchAdguardServicePolicies()]) },
            linuxMon: { fn: () => Promise.all([fetchLinux(), fetchLnxChart()]) },
            critAlerts: { fn: () => fetchCritAlerts() }, hardware: { fn: () => fetchHardware() },
            ucgHist: { fn: () => fetchUcgHist() }, ucgSpikes: { fn: () => fetchUcgSpikes() }, switches: { fn: () => fetchSwitchMatrix() },
            wifi: { fn: () => fetchWiFiNetworks() }, blockHistory: { fn: () => fetchBlockHistory() },
            unifiTelemetry: { fn: () => fetchUnifiDeviceTelemetry() },
            clients: { fn: () => fetchClients() }, threats: { fn: () => fetchThreats() },
            cloud: { fn: () => Promise.all([fetchCloudSites(), fetchCloudDevices(), fetchCloudHosts(), fetchCloudSdwan()]) },
            isp: { fn: () => fetchIspMetrics() }, nas: { fn: () => fetchNas() },
            nasAdvanced: { fn: ({ generation = navigationGeneration } = {}) => Promise.all([fetchNasAdvanced(), fetchNasCharts(), fetchNasAlerts({ generation }), fetchNasSleepStats()]) },
            docker: { fn: () => fetchNasDocker() }, trend: { fn: () => fetchTrends() },
            notifLog: { fn: () => Promise.all([fetchNotifLog(), fetchWebPushState()]) },
            reportLog: { fn: () => fetchReportLog() }, systemStatus: { fn: () => fetchSystemStatus() }, security: { fn: () => Promise.all([fetchSecuritySettings(), fetchBlockHistory()]) },
            settings: { fn: () => fetchAppSettings() }, connections: { fn: () => Promise.all([fetchConnections(), fetchConfigBackupStatus()]) },
            wiimDeviceInfo: { fn: () => fetchWiimDeviceInfo() },
            wiimSystem: { fn: () => fetchWiimSystem() }, wiimPlayback: { fn: () => fetchWiimPlayback() },
            ups: { fn: () => fetchUps({ includeHistory: false }) }, upsHistory: { fn: () => fetchUps() }, ppbEvents: { fn: () => fetchPpbEvents() },
            nasAlertConfig: { fn: async ({ generation = navigationGeneration } = {}) => {
                const configured = await fetchAlertConfig({ generation });
                if (generation !== navigationGeneration || currentPage !== 'nas' || document.visibilityState !== 'visible') {
                    disconnectNasSse();
                    return { configured, stale: true };
                }
                if (configured) connectNasSse(generation); else disconnectNasSse();
                return { configured };
            } },
            heartbeat: { fn: () => sendHeartbeat() }
        };
        const COMMON_POLL_JOBS = new Set(['critAlerts', 'heartbeat']);
        const PAGE_POLL_JOBS = {
            overview: ['hardware', 'clients', 'threats', 'trend', 'isp', 'nas', 'wiimSystem', 'ups'],
            clients: ['clients'], security: ['threats', 'security'], wifi: [], cloud: ['cloud', 'isp'],
            ucg: ['hardware', 'ucgHist', 'ucgSpikes', 'switches', 'unifiTelemetry'],
            nas: ['nas', 'nasAdvanced', 'docker'], wiim: ['wiimSystem', 'wiimPlayback'],
            ups: ['ups', 'upsHistory', 'ppbEvents'], adguard: ['adguard'], linuxhost: ['linuxMon'], tools: [],
            notify: ['notifLog'], settings: ['reportLog', 'systemStatus', 'security']
        };
        const PAGE_ACTIVITY_SCOPES = {
            overview: ['trend', 'ucg', 'nas', 'wiim', 'ups'], clients: ['trend'], security: ['trend'],
            cloud: ['trend'], ucg: ['ucg', 'unifi-device-telemetry'], nas: ['nas'], wiim: ['wiim'], ups: ['ups'], linuxhost: ['linux']
        };
        const PAGE_HYDRATION = {
            overview: ['hardware', 'clients', 'threats', 'trend', 'isp', 'nas', 'wiimSystem', 'ups'],
            clients: ['clients'], security: ['threats', 'security'], wifi: ['wifi'], cloud: ['cloud'],
            ucg: ['hardware', 'ucgHist', 'ucgSpikes', 'switches', 'unifiTelemetry'],
            nas: ['nas', 'nasAdvanced', 'nasAlertConfig', 'docker'], wiim: ['wiimDeviceInfo'],
            ups: ['upsHistory', 'ppbEvents'], adguard: ['adguard'], linuxhost: ['linuxMon'], tools: [],
            notify: ['notifLog'], settings: ['reportLog', 'systemStatus', 'security', 'settings', 'connections']
        };
        let wiimPageInitialized = false;
        function validatePollJobReferences() {
            const missing = new Set();
            [PAGE_POLL_JOBS, PAGE_HYDRATION].forEach(map => Object.values(map).forEach(keys => keys.forEach(key => {
                if (!Object.hasOwn(POLL_JOBS, key)) missing.add(key);
            })));
            if (missing.size) throw new Error(`Unknown polling job(s): ${[...missing].join(', ')}`);
        }
        validatePollJobReferences();
        const frontendLifecycle = window.SmartHubFrontendLifecycle;
        if (!frontendLifecycle) throw new Error('Frontend lifecycle helper is unavailable');
        const hydrationCoordinator = frontendLifecycle.createHydrationCoordinator({
            pages: PAGE_HYDRATION,
            runJob: (key, context) => {
                if (key === 'wiimDeviceInfo' && !wiimPageInitialized) {
                    wiimPageInitialized = true;
                    initWiimPage();
                }
                return POLL_JOBS[key].fn(context);
            },
            onError: (error, { page, key }) => dbg('Poll', `頁面 ${page} 的 ${key} 載入失敗`, error)
        });
        const hydrationInFlight = { has: page => hydrationCoordinator.isInFlight(page) };
        function hydratePage(page, { force = false, only = null, generation = navigationGeneration } = {}) {
            if (!force && hydrationCoordinator.isLoaded(page)) {
                if (page === 'nas') return hydrationCoordinator.hydratePage(page, { force: true, only: ['nasAlertConfig'], generation });
                return Promise.resolve({ loaded: true, skipped: true, results: [] });
            }
            return hydrationCoordinator.hydratePage(page, { force, only, generation });
        }
        let pollTimers = {};
        let pollStartTimers = {};
        const pollRunning = new Set();
        let frontendPollingSettings = null;
        const DEFAULT_CONNECTION_CLEARABLE_FIELDS = new Set([
            'UNIFI_CONTROLLER_CA_FILE', 'UNIFI_NETWORK_API_URL', 'UNIFI_NETWORK_CA_FILE',
            'NAS_CA_FILE', 'WIIM_IP', 'PPB_CA_FILE', 'ADGUARD_CA_FILE'
        ]);
        let connectionClearableFields = new Set(DEFAULT_CONNECTION_CLEARABLE_FIELDS);
        function getEffectivePollSec(key) {
            if (!frontendPollingSettings) return null;
            if (key === 'heartbeat') return frontendPollingSettings.heartbeatSec;
            if (key === 'ups') return frontendPollingSettings.upsFrontendPollSec;
            if (key === 'upsHistory') return frontendPollingSettings.upsHistoryFrontendPollSec;
            if (key === 'ppbEvents') return frontendPollingSettings.upsPpbEventsFrontendPollSec;
            return frontendPollingSettings.deviceActiveFrontendPollSec;
        }
        async function runPollJob(key, job) {
            if (pollRunning.has(key)) return;
            pollRunning.add(key);
            try { await job.fn(); }
            catch (error) { dbg('Poll', `${key} 輪詢失敗`, error); return { ok: false, error }; }
            finally {
                pollRunning.delete(key);
                if (currentPage === 'overview') syncPinned();
            }
        }
        function applyPolling(runNow = false) {
            Object.entries(POLL_JOBS).forEach(([k, j]) => {
                clearInterval(pollTimers[k]);
                clearTimeout(pollStartTimers[k]);
                delete pollTimers[k];
                delete pollStartTimers[k];
                const pageJobs = PAGE_POLL_JOBS[currentPage] || [];
                if (!frontendLifecycle.shouldSchedulePollJob({
                    isVisible: document.visibilityState === 'visible',
                    configured: Boolean(frontendPollingSettings),
                    hydrationPending: hydrationInFlight.has(currentPage),
                    common: COMMON_POLL_JOBS.has(k),
                    pageJobs,
                    key: k
                })) return;
                const run = () => runPollJob(k, j);
                if (runNow) pollStartTimers[k] = setTimeout(run, 0);
                pollTimers[k] = setInterval(run, getEffectivePollSec(k) * 1000);
            });
        }

        const heartbeatSessionId = (() => {
            const key = 'smarthub.heartbeat-session.v1';
            try {
                let value = sessionStorage.getItem(key);
                if (!value) {
                    value = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9._:-]/g, '');
                    sessionStorage.setItem(key, value);
                }
                return value;
            } catch { return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
        })();
        let heartbeatSequence = 0;
        function nextHeartbeatSequence() {
            heartbeatSequence = heartbeatSequence >= Number.MAX_SAFE_INTEGER ? 1 : heartbeatSequence + 1;
            return heartbeatSequence;
        }

        async function sendHeartbeat(focus = false) {
            if (document.visibilityState !== 'visible') return;
            const scopes = PAGE_ACTIVITY_SCOPES[currentPage] || [];
            const query = '?scope=' + encodeURIComponent(scopes.join(',')) + `&session=${encodeURIComponent(heartbeatSessionId)}&seq=${nextHeartbeatSequence()}` + (focus ? '&focus=1' : '');
            try { await fetch('/api/heartbeat' + query); } catch (e) { /* 靜默 */ }
        }
        function releaseDeviceFocus() {
            fetch(`/api/heartbeat?scope=&focus=1&session=${encodeURIComponent(heartbeatSessionId)}&seq=${nextHeartbeatSequence()}`).catch(() => { /* 靜默 */ });
        }
        document.addEventListener('visibilitychange', () => {
            applyPolling();
            if (document.visibilityState === 'visible') {
                sendHeartbeat(true);
                if (currentPage === 'overview') syncPinned();
                if (currentPage === 'nas') {
                    hydratePage('nas', {
                        force: true,
                        only: ['nasAlertConfig'],
                        generation: navigationGeneration
                    }).then(() => { if (currentPage === 'nas') applyPolling(true); });
                }
            } else {
                releaseDeviceFocus();
                disconnectPinnedObservers();
                disconnectNasSse();
            }
        });

        // 共用小圖示 (線條 SVG，取代 emoji)
        const _ic = (paths, extra = '') => `<svg class="w-3 h-3 inline-block ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
        const ICON_WIFI = _ic('<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/>');
        const ICON_LAN = _ic('<rect x="6" y="3" width="12" height="12" rx="2"/><line x1="9" y1="7" x2="9" y2="10"/><line x1="12" y1="7" x2="12" y2="10"/><line x1="15" y1="7" x2="15" y2="10"/><path d="M12 15v6"/>');
        const ICON_DOWN = _ic('<line x1="12" y1="4" x2="12" y2="20"/><polyline points="6 14 12 20 18 14"/>');
        const ICON_UP = _ic('<line x1="12" y1="20" x2="12" y2="4"/><polyline points="6 10 12 4 18 10"/>');

        /* WiiM 輸入源順序：可拖曳排序，存於本機瀏覽器 */
        let wiimDragChip = null;
        function initWiimSrcDrag() {
            const first = document.querySelector('.wiim-src-chip'); if (!first) return;
            const wrap = first.parentElement;
            const saved = JSON.parse(localStorage.getItem('wiimSrcOrder.v1') || 'null');
            if (Array.isArray(saved)) saved.forEach(k => { const el = wrap.querySelector(`[data-src="${k}"]`); if (el) wrap.appendChild(el); });
            wrap.querySelectorAll('.wiim-src-chip').forEach(ch => {
                ch.draggable = true;
                ch.title = '可拖曳調整順序';
                ch.addEventListener('dragstart', e => { e.stopPropagation(); wiimDragChip = ch; e.dataTransfer.effectAllowed = 'move'; });
                ch.addEventListener('dragover', e => {
                    e.preventDefault(); e.stopPropagation();
                    if (!wiimDragChip || wiimDragChip === ch) return;
                    const r = ch.getBoundingClientRect();
                    wrap.insertBefore(wiimDragChip, e.clientX < r.left + r.width / 2 ? ch : ch.nextSibling);
                });
                ch.addEventListener('dragend', e => {
                    e.stopPropagation(); wiimDragChip = null;
                    const order = [...wrap.querySelectorAll('.wiim-src-chip')].map(x => x.dataset.src);
                    localStorage.setItem('wiimSrcOrder.v1', JSON.stringify(order));
                    persistUiPreference('wiimSrcOrder.v1', order);
                });
            });
        }

        /* 側邊欄 UPS 狀態 (顯示目前使用的資料來源) */
        async function refreshSideUps() {
            try {
                const s = await (await fetch('/api/ups/status')).json();
                const ok = s.source && s.source !== 'unreachable';
                const dot = document.getElementById('side-ups-dot');
                const st = document.getElementById('side-ups-state');
                if (dot) dot.className = `w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`;
                if (st) st.textContent = ok ? s.source : '未連接';
            } catch (error) { console.debug('Sidebar UPS refresh failed', error); }
        }

        let toastSec = 10;      // 顯示秒數，於設定頁調整 (伺服器端保存)
        let toastTimer = null;
        function showToast(msg, isError = false) {
            const t = document.getElementById('toast');
            document.getElementById('toast-text').innerText = msg;
            t.className = `fixed bottom-6 right-6 px-4 py-2.5 bg-slate-900 border ${isError ? 'border-red-900/60 text-red-200' : 'border-blue-900/60 text-blue-200'} text-xs rounded-xl shadow-2xl transition-all duration-300 z-[60] transform translate-y-0 opacity-100`;
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                // 必須先移除顯示用 class：Tailwind CDN 生成順序可能讓 opacity-100 蓋過 opacity-0，同時掛兩個會導致永遠不消失
                t.classList.remove('translate-y-0', 'opacity-100');
                t.classList.add('translate-y-2', 'opacity-0', 'pointer-events-none');
            }, Math.max(1, toastSec) * 1000);
        }

        /* ==================== 圖表初始化 ==================== */
        function initChart() {
            hwChart = new Chart(document.getElementById('hardwareChart').getContext('2d'), {
                type: 'line',
                data: {
                    labels: chartLabels,
                    datasets: [
                        { label: '溫度 °C', data: tempChartData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.05)', fill: true, yAxisID: 'yTemp', tension: 0.3 },
                        { label: '負載 %', data: usageChartData, borderColor: '#64748b', borderDash: [3, 3], fill: false, yAxisID: 'yUsage', tension: 0.3 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { display: false },
                        yTemp: { min: 30, max: 100, ticks: { color: '#64748b', callback: v => v + '°C' } },
                        yUsage: { min: 0, max: 100, position: 'right', ticks: { color: '#64748b', callback: v => v + '%' } }
                    }
                }
            });
        }

        function initThreatPieChart() {
            threatChart = new Chart(document.getElementById('threatPieChart').getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: ['Web Exploit', 'Brute Force', 'Scanner', 'Malware', 'DoS', 'Manual Block'],
                    datasets: [{ data: [0, 0, 0, 0, 0, 0], backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899'], borderWidth: 1, borderColor: '#020617' }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1', boxWidth: 20, boxHeight: 2, font: { size: 10, weight: 'bold' } } } },
                    cutout: '65%'
                }
            });
        }

        function initTrendChart() {
            trendChart = new Chart(document.getElementById('trendChart').getContext('2d'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: '線上客戶端', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.06)', fill: true, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'yCount' },
                        { label: '24H 威脅數', data: [], borderColor: '#ef4444', fill: false, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'yCount' },
                        { label: 'ISP 延遲 (ms)', data: [], borderColor: '#10b981', borderDash: [4, 3], fill: false, tension: 0.3, pointRadius: 0, spanGaps: true, yAxisID: 'yMs' }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 10 } } } },
                    scales: {
                        x: { ticks: { color: '#64748b', maxTicksLimit: 10, font: { size: 9 } }, grid: { color: 'rgba(30,41,59,0.4)' } },
                        yCount: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(30,41,59,0.4)' } },
                        yMs: { beginAtZero: true, position: 'right', ticks: { color: '#10b981', font: { size: 9 }, callback: v => compactNumber(v) + ' ms' }, grid: { display: false } }
                    }
                }
            });
        }

        function initHourlyCharts() {
            const baseOpts = (stacked) => ({
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: stacked, labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 8 } } } },
                scales: {
                    x: { stacked, ticks: { color: '#64748b', font: { size: 8 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
                    y: { stacked, beginAtZero: true, ticks: { color: '#64748b', font: { size: 8 }, precision: 0 }, grid: { color: 'rgba(30,41,59,0.4)' } }
                }
            });
            // 總覽速覽：單色柱狀
            ovHourlyChart = new Chart(document.getElementById('ovHourlyChart').getContext('2d'), {
                type: 'bar',
                data: { labels: [], datasets: [{ data: [], backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 3 }] },
                options: baseOpts(false)
            });
            // 資安頁：依類別堆疊
            secHourlyChart = new Chart(document.getElementById('secHourlyChart').getContext('2d'), {
                type: 'bar',
                data: { labels: [], datasets: THREAT_CATS.map(c => ({ label: c, data: [], backgroundColor: CAT_COLORS[c], borderRadius: 2 })) },
                options: baseOpts(true)
            });
        }

        /* ==================== 歷史趨勢 ==================== */
        function setTrendRange(hours) {
            trendHours = hours;
            document.querySelectorAll('.trend-range-btn').forEach(button => {
                const selected = Number(button.dataset.trendHours) === hours;
                button.className = `trend-range-btn shrink-0 whitespace-nowrap px-2 py-1 rounded-md font-bold transition ${selected ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
            });
            requestChartReplay(trendChart);
            fetchTrends();
        }

        async function fetchTrends() {
            try {
                const res = await fetch('/api/history?hours=' + trendHours);
                if (!res.ok) throw new Error();
                const rawHistory = (await res.json()).history || [];
                const trendKeys = ['clients', 'threats24h', 'latency'];
                const hasFiniteTrendValue = (point, key) => point?.[key] != null && point[key] !== '' && Number.isFinite(Number(point[key]));
                // 一筆 trend 會合併多個來源；任一來源短暫失敗時保留在歷史供診斷，
                // 但不讓 null 成為圖上的斷線或被視覺化成虛構數值。
                const completeHistory = rawHistory.filter(point => trendKeys.every(key => hasFiniteTrendValue(point, key)));
                const omitted = rawHistory.length - completeHistory.length;
                const hist = downsampleRows(completeHistory, trendKeys);
                const quality = document.getElementById('trend-data-quality');
                if (quality) quality.textContent = omitted ? `· 已略過 ${omitted} 筆不完整樣本` : '· 資料完整';
                const fmt = trendHours > 24
                    ? p => new Date(p.t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit' })
                    : p => new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
                trendChart.data.labels = hist.map(fmt);
                trendChart.data.datasets[0].data = hist.map(p => p.clients);
                trendChart.data.datasets[1].data = hist.map(p => p.threats24h);
                trendChart.data.datasets[2].data = hist.map(p => p.latency);
                updateChartWithEntrance(trendChart);
            } catch (e) { console.error('Trends fetch failed'); }
        }

        /* ==================== 威脅世界地圖 ==================== */
        let worldFeatures = null, geoPathFn = null, mapProjection = null;
        const COUNTRY_ALIASES = { 'USA': 'United States of America', 'United States': 'United States of America', 'UK': 'United Kingdom', 'Korea': 'South Korea' };
        const COUNTRY_COORDS = {
            'Germany': [10.4, 51.1], 'Russia': [55, 58], 'China': [104, 35], 'Ukraine': [31, 49],
            'Netherlands': [5.3, 52.1], 'USA': [-98, 39], 'United States': [-98, 39], 'North Korea': [127, 40],
            'Taiwan': [121, 23.7], 'Japan': [138, 36], 'Brazil': [-52, -11], 'India': [78, 21],
            'France': [2.2, 46.6], 'Vietnam': [106, 16], 'South Korea': [127.8, 36.5], 'United Kingdom': [-2, 54]
        };

        async function initWorldMap() {
            try {
                const world = await (await fetch('/vendor/world-atlas/2.0.2/countries-110m.json')).json();
                const countries = topojson.feature(world, world.objects.countries);
                const svg = d3.select('#threat-map');
                mapProjection = d3.geoEquirectangular().fitSize([800, 400], countries);
                geoPathFn = d3.geoPath(mapProjection);
                svg.append('g').selectAll('path').data(countries.features).join('path')
                    .attr('d', geoPathFn).attr('fill', '#1e293b').attr('stroke', '#334155').attr('stroke-width', 0.4);
                worldFeatures = countries.features;
                svg.append('g').attr('id', 'map-points');
                updateWorldMap();
            } catch (e) {
                document.getElementById('map-fallback').classList.remove('hidden');
            }
        }

        function updateWorldMap() {
            if (!mapProjection || !worldFeatures) return;
            const sinceTs = parseInt(localStorage.getItem('secStatsResetTs') || '0', 10);
            const mapThreats = sinceTs ? allThreats.filter(t => new Date(t.datetime).getTime() >= sinceTs) : allThreats;
            const counts = {}, coords = {};
            mapThreats.forEach(t => {
                const c = t.src_country || 'Unknown';
                if (c === 'Unknown') return;
                counts[c] = (counts[c] || 0) + 1;
                // UCG 警報自帶經緯度 (srcipGeo)，優先使用
                if (coords[c] === undefined && t.src_lat != null && t.src_lon != null) coords[c] = [t.src_lon, t.src_lat];
            });
            const pts = [];
            Object.entries(counts).forEach(([country, n]) => {
                let xy = null;
                if (coords[country]) xy = mapProjection(coords[country]);
                if (!xy || isNaN(xy[0])) {
                    const name = COUNTRY_ALIASES[country] || country;
                    const feat = worldFeatures.find(f => f.properties.name === name);
                    if (feat) xy = geoPathFn.centroid(feat);
                    else if (COUNTRY_COORDS[country]) xy = mapProjection(COUNTRY_COORDS[country]);
                }
                if (xy && !isNaN(xy[0])) pts.push({ x: xy[0], y: xy[1], n, country });
            });
            const g = d3.select('#map-points');
            g.selectAll('*').remove();
            pts.forEach(p => {
                const r = 4 + Math.min(p.n * 1.5, 12);
                g.append('circle').attr('cx', p.x).attr('cy', p.y).attr('r', r)
                    .attr('fill', 'rgba(239,68,68,0.25)').attr('stroke', '#ef4444').attr('stroke-width', 1).attr('class', 'map-pulse');
                g.append('circle').attr('cx', p.x).attr('cy', p.y).attr('r', 2).attr('fill', '#ef4444');
                g.append('text').attr('x', p.x + r + 3).attr('y', p.y + 3)
                    .attr('fill', '#94a3b8').attr('font-size', '9px').attr('font-weight', 'bold')
                    .text(`${p.country} (${p.n})`);
            });
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
            document.getElementById('map-top-countries').innerHTML = top.map(([c, n], i) => `<span class="mono">#${i + 1} ${escapeHtml(c)} ×${n}</span>`).join('<br>');
        }

        /* ==================== 硬體 (真實數據) ==================== */
        async function fetchHardware() {
            try {
                const res = await fetch('/api/hardware');
                if (!res.ok) throw new Error('API Error');
                const data = await res.json();
                document.getElementById('side-ucg-dot').className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';

                if (data.cpuTemp) {
                    document.getElementById('cpu-temp').innerText = data.cpuTemp;
                    document.getElementById('cpu-temp-f').innerText = `/ ${Math.round(data.cpuTemp * 1.8 + 32)}°F`;
                    document.getElementById('kpi-temp').innerText = data.cpuTemp;
                    // 總覽雙設備體檢 — UCG 溫度
                    const tc = tempColor(data.cpuTemp);
                    const ucgTempEl = document.getElementById('ov-ucg-temp');
                    if (ucgTempEl) { ucgTempEl.innerText = data.cpuTemp; ucgTempEl.style.color = tc; }
                    const ucgTempStatus = document.getElementById('ov-ucg-temp-status');
                    if (ucgTempStatus) { ucgTempStatus.innerText = tempLabel(data.cpuTemp); ucgTempStatus.style.color = tc; }
                    const isHot = data.cpuTemp >= 75;
                    document.getElementById('kpi-temp-sub').innerText = isHot ? '⚠️ 高溫警告' : '溫度正常';
                    const card = document.getElementById('card-hardware');
                    if (isHot) {
                        card.classList.add('border-red-700/60');
                        document.getElementById('temp-indicator-dot').className = 'inline-block w-2 h-2 rounded-full bg-red-500 animate-ping';
                        document.getElementById('temp-status-text').innerText = '高溫警告';
                    } else {
                        card.classList.remove('border-red-700/60');
                        document.getElementById('temp-indicator-dot').className = 'inline-block w-2 h-2 rounded-full bg-blue-500';
                        document.getElementById('temp-status-text').innerText = '正常運作中';
                    }
                }
                if (data.uptime) {
                    document.getElementById('sys-uptime').innerText = data.uptime;
                    const u = document.getElementById('ov-ucg-uptime'); if (u) u.innerText = data.uptime;
                }
                // 總覽雙設備體檢 — UCG CPU/記憶體 + 上線徽章
                const setV = (id, v) => { const e = document.getElementById(id); if (e) e.innerText = v; };
                const setBar = (id, v) => { const e = document.getElementById(id); if (e) e.style.width = (v || 0) + '%'; };
                setV('ov-ucg-cpu', (data.cpuUsage != null ? data.cpuUsage : '--') + '%');
                setBar('ov-ucg-cpu-bar', data.cpuUsage);
                if (data.memUsagePct != null) { setV('ov-ucg-mem', data.memUsagePct + '%'); setBar('ov-ucg-mem-bar', data.memUsagePct); }
                setOverviewStatusDot('ov-ucg-badge', 'ok', '連線正常');

                document.getElementById('cpu-usage').innerText = data.cpuUsage + '%';
                if (data.cores && data.cores.length) {
                    const grid = document.getElementById('core-grid');
                    grid.innerHTML = data.cores.map((val, i) => `
                    <div>
                        <div class="flex justify-between text-slate-400 mb-0.5"><span>Core ${i}</span><span class="mono">${val}%</span></div>
                        <div class="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800"><div class="bg-blue-500 h-full transition-all duration-300" style="width: ${val}%;"></div></div>
                    </div>`).join('');
                }

                document.getElementById('mem-usage-str').innerText = `${data.memStr} (${data.memUsagePct}%)`;
                document.getElementById('mem-bar').style.width = data.memUsagePct + '%';
                if (data.emmcStr) {
                    document.getElementById('emmc-usage-str').innerText = `${data.emmcStr} (${data.emmcUsagePct}%)`;
                    document.getElementById('emmc-bar').style.width = data.emmcUsagePct + '%';
                }

                // WAN 狀態 KPI（網埠明細已整合到下方的「全網路裝置埠對照」卡）
                if (data.interfaces) {
                    const wan = data.interfaces.find(i => i.name.startsWith('WAN'));
                    if (wan) {
                        const up = wan.status === 'connected';
                        document.getElementById('kpi-wan').innerText = up ? '正常連線' : '離線';
                        document.getElementById('kpi-wan').className = `text-2xl font-black mt-2 ${up ? 'text-emerald-400' : 'text-red-400'}`;
                        document.getElementById('kpi-wan-dot').className = `w-2 h-2 rounded-full ${up ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`;
                    }
                }

                if (data.cpuTemp != null && data.cpuUsage != null) {
                    if (tempChartData.length >= 12) { tempChartData.shift(); usageChartData.shift(); chartLabels.shift(); }
                    tempChartData.push(data.cpuTemp);
                    usageChartData.push(data.cpuUsage);
                    chartLabels.push(new Date().toLocaleTimeString());
                    updateChartWithEntrance(hwChart);
                }
            } catch (e) {
                document.getElementById('side-ucg-dot').className = 'w-1.5 h-1.5 rounded-full bg-red-500';
                setOverviewStatusDot('ov-ucg-badge', 'error', '連線失敗');
                console.error('Hardware fetch failed', e);
            }
        }

        const DEV_TYPE_LABEL = { udm: '閘道器', usw: '交換器', uap: '無線 AP' };
        async function fetchSwitchMatrix() {
            const wrap = document.getElementById('switch-matrix');
            try {
                const res = await fetch('/api/network/switches');
                if (!res.ok) throw new Error();
                const { devices } = await res.json();
                if (!devices || !devices.length) { wrap.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">無法取得裝置清單</p>'; return; }
                wrap.innerHTML = devices.map(d => `
                <div>
                    <p class="text-[11px] font-bold text-slate-300 mb-2">${escapeHtml(d.name)} <span class="text-slate-600 font-normal">（${escapeHtml(DEV_TYPE_LABEL[d.type] || d.type)} · ${escapeHtml(d.model)}）</span></p>
                    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                        ${d.ports.map(p => `
                            <div class="flex items-center justify-between p-2.5 bg-slate-950/40 rounded-xl border border-slate-850">
                                <div class="flex items-center gap-2 min-w-0">
                                    <div class="w-2 h-2 rounded-full shrink-0 ${p.up ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}"></div>
                                    <div class="min-w-0">
                                        <p class="text-[11px] font-bold text-slate-200">Port ${escapeHtml(p.port_idx)}${p.is_uplink ? ' (上聯)' : ''}${p.poe ? ' ⚡PoE' : ''}</p>
                                        <p class="text-[9px] text-slate-500 truncate">${escapeHtml(p.client ? p.client.name : (p.up ? '已連線 (無客戶端紀錄)' : '無連線'))}</p>
                                    </div>
                                </div>
                                <div class="text-right shrink-0 ml-2">
                                    <p class="text-[9px] text-slate-400 mono">${p.speedMbps ? (p.speedMbps >= 1000 ? (p.speedMbps / 1000) + 'G' : p.speedMbps + 'M') : '--'}</p>
                                    ${p.up ? `<p class="text-[8px] text-slate-500 mono">↓${p.rxMbps} ↑${p.txMbps}</p>` : ''}
                                </div>
                            </div>`).join('')}
                    </div>
                </div>`).join('');
            } catch (e) {
                // 只有在還沒成功渲染過時才顯示提示 (避免暫時性斷線清空已顯示的內容)
                if (!wrap.querySelector('.grid')) wrap.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">連線中，稍候自動重試…</p>';
                console.error('Switch matrix fetch failed', e);
            }
        }

        const UNIFI_TEMPERATURE_STATUS = Object.freeze({
            supported: '支援', unsupported: '不支援', not_configured: '未設定', offline: '離線',
            stale: '資料過期', authentication_failed: '驗證失敗', host_key_mismatch: 'Host Key 不符',
            timeout: '逾時', unavailable: '暫時無法取得'
        });
        function telemetryNumber(value, suffix = '', digits = 0) {
            return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
                ? `${Number(value).toFixed(digits)}${suffix}`
                : '--';
        }
        function telemetryTimestamp(value) {
            const parsed = Date.parse(value || '');
            return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-TW') : '--';
        }
        function telemetryBytes(value) {
            const number = Number(value);
            if (value === null || value === undefined || !Number.isFinite(number) || number < 0) return '--';
            if (number >= 1024 ** 3) return `${(number / 1024 ** 3).toFixed(1)} GiB`;
            if (number >= 1024 ** 2) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
            if (number >= 1024) return `${(number / 1024).toFixed(1)} KiB`;
            return `${number} B`;
        }
        function renderUnifiTelemetryDevice(device, snapshotStale) {
            const temperature = device?.temperature || {};
            const stale = snapshotStale || device?.freshness?.stale || temperature.stale;
            const statusLabel = UNIFI_TEMPERATURE_STATUS[temperature.status] || '不支援';
            const temperatureText = temperature.status === 'supported' && Number.isFinite(Number(temperature.value)) && !stale
                ? `${Number(temperature.value).toFixed(1)}°C`
                : `${statusLabel}${stale && temperature.status !== 'stale' ? ' · 舊值未採用' : ''}`;
            const radios = Array.isArray(device?.radios) ? device.radios : [];
            const vaps = Array.isArray(device?.vaps) ? device.vaps : [];
            const radioSummary = radios.length
                ? radios.map(radio => `${escapeHtml(radio.band || radio.name || 'Radio')} Ch ${escapeHtml(radio.channel ?? '--')} · ${telemetryNumber(radio.utilizationPercent, '%')}`).join('<br>')
                : '無射頻資料';
            const vapSummary = vaps.length
                ? vaps.map(vap => `${escapeHtml(vap.ssid || '隱藏 SSID')} · ${vap.up ? 'Up' : 'Down'} · ${telemetryNumber(vap.clientCount)} 台`).join('<br>')
                : '無 SSID/VAP 資料';
            const traffic = device?.traffic || {};
            const packets = `${telemetryNumber(traffic.rxPackets)} / ${telemetryNumber(traffic.txPackets)}`;
            const errors = `${telemetryNumber(traffic.rxErrors)} / ${telemetryNumber(traffic.txErrors)} / ${telemetryNumber(traffic.rxDropped)} / ${telemetryNumber(traffic.txDropped)}`;
            const stateClass = device?.online ? 'text-emerald-400' : 'text-red-400';
            return `<article class="rounded-xl border ${stale ? 'border-amber-500/30' : 'border-slate-800/70'} bg-slate-950/45 p-4">
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0"><p class="text-xs font-bold text-slate-200 truncate">${escapeHtml(device?.name || device?.id || '未知設備')}</p>
                    <p class="text-[9px] text-slate-500 mono truncate">${escapeHtml(device?.model || '--')} · ${escapeHtml(device?.firmware || '--')} · ${escapeHtml(device?.ip || '--')}</p></div>
                    <span class="text-[9px] font-bold ${stateClass}">${device?.online ? 'Online' : 'Offline'}</span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-[10px]">
                    <div><p class="text-slate-600">溫度</p><p class="font-bold ${temperature.status === 'supported' && !stale ? 'text-cyan-300' : 'text-slate-400'}">${escapeHtml(temperatureText)}</p></div>
                    <div><p class="text-slate-600">CPU</p><p class="text-slate-300 mono">${telemetryNumber(device?.cpu?.value, '%', 1)}</p></div>
                    <div><p class="text-slate-600">用戶端</p><p class="text-slate-300 mono">${telemetryNumber(device?.clientCount)}</p></div>
                    <div><p class="text-slate-600">上聯</p><p class="text-slate-300 mono">${escapeHtml(device?.uplink?.state || '--')} · ${telemetryNumber(device?.uplink?.speedMbps, ' Mbps')} · ${escapeHtml(device?.uplink?.duplex || '--')}</p></div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-800/60 text-[9px] text-slate-500">
                    <p>Radio：<span class="text-slate-400">${radioSummary}</span></p>
                    <p>SSID/VAP：<span class="text-slate-400">${vapSummary}</span></p>
                    <p class="sm:col-span-2">RX/TX 封包：<span class="text-slate-400 mono">${packets}</span> · 錯誤/丟棄 RX/TX：<span class="text-slate-400 mono">${errors}</span></p>
                </div>
                <p class="text-[9px] text-slate-600 mt-2">流量 RX/TX：${escapeHtml(telemetryBytes(traffic.rxBytes))} / ${escapeHtml(telemetryBytes(traffic.txBytes))} · Uptime：${telemetryNumber(device?.uptimeSeconds, ' 秒')} · 溫度來源：${escapeHtml(temperature.source || '無')} · 取樣：${escapeHtml(telemetryTimestamp(temperature.sampledAt))}${device?.freshness?.errorReason ? ` · ${escapeHtml(device.freshness.errorReason)}` : ''}</p>
            </article>`;
        }
        async function fetchUnifiDeviceTelemetry() {
            const wrap = document.getElementById('unifi-telemetry-devices');
            if (!wrap) return;
            try {
                const [snapshotResponse, historyResponse] = await Promise.all([
                    fetch('/api/network/devices/telemetry'),
                    fetch('/api/network/devices/telemetry/history?hours=24')
                ]);
                if (!snapshotResponse.ok || !historyResponse.ok) throw new Error('telemetry request failed');
                const snapshot = await snapshotResponse.json();
                const historyPayload = await historyResponse.json();
                const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
                wrap.innerHTML = devices.length
                    ? devices.map(device => renderUnifiTelemetryDevice(device, snapshot.stale)).join('')
                    : '<p class="text-xs text-slate-500 text-center py-6 xl:col-span-2">Controller 尚未回傳設備資料</p>';
                const state = document.getElementById('unifi-telemetry-state');
                if (state) {
                    state.textContent = snapshot.stale ? 'STALE · 保留最後成功資料' : 'FRESH';
                    state.className = `inline-block px-2 py-1 rounded-full border ${snapshot.stale ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`;
                }
                const last = document.getElementById('unifi-telemetry-last-success');
                if (last) last.textContent = `最後成功：${telemetryTimestamp(snapshot.lastSuccessfulAt)}`;
                const rows = (Array.isArray(historyPayload.data) ? historyPayload.data : [])
                    .filter(row => row.temperatureStatus === 'supported' && Number.isFinite(Number(row.temperature)))
                    .slice(-100).reverse();
                const history = document.getElementById('unifi-telemetry-history');
                const count = document.getElementById('unifi-telemetry-history-count');
                if (count) count.textContent = `${rows.length} 點`;
                if (history) history.innerHTML = rows.length ? rows.map(row => `<div class="flex items-center justify-between gap-3 rounded-lg bg-slate-950/40 border border-slate-800/50 px-3 py-2 text-[9px]">
                    <span class="text-slate-400 truncate">${escapeHtml(row.name || row.deviceId)}</span>
                    <span class="text-slate-600">${escapeHtml(telemetryTimestamp(row.collectedAt))}</span>
                    <span class="text-cyan-300 font-bold mono">${telemetryNumber(row.temperature, '°C', 1)}</span>
                </div>`).join('') : '<p class="text-[10px] text-slate-500">尚無可用的真實溫度紀錄</p>';
            } catch (error) {
                if (!wrap.querySelector('article')) wrap.innerHTML = '<p class="text-xs text-amber-400 text-center py-6 xl:col-span-2">遙測快照暫時無法讀取，稍後自動重試</p>';
                console.error('UniFi device telemetry fetch failed', error);
            }
        }

        // 溫度配色與標籤 (共用於總覽雙設備體檢)
        function tempColor(t) { return t == null ? '#64748b' : t >= 75 ? '#ef4444' : t >= 65 ? '#f59e0b' : t >= 55 ? '#3b82f6' : '#10b981'; }
        function tempLabel(t) { return t == null ? '--' : t >= 75 ? '過熱' : t >= 65 ? '偏高' : t >= 55 ? '正常' : '涼爽'; }
        function setOverviewStatusDot(id, state, label) {
            const dot = document.getElementById(id);
            if (!dot) return;
            const color = state === 'ok' ? 'bg-emerald-400' : state === 'error' ? 'bg-red-500' : 'bg-amber-400';
            dot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${color}`;
            dot.title = label;
            dot.setAttribute('aria-label', label);
            dot.textContent = '';
        }

        /* ==================== 客戶端 ==================== */
        async function fetchClients() {
            try {
                const res = await fetch('/api/clients');
                if (!res.ok) throw new Error();
                allClients = (await res.json()).clients || [];
                const refreshSeconds = frontendPollingSettings?.deviceActiveFrontendPollSec || 5;
                const updatedAt = new Date().toLocaleTimeString('zh-TW', { hour12: false });
                const intervalText = refreshSeconds < 60 ? `${refreshSeconds} 秒` : `${refreshSeconds / 60} 分鐘`;
                const refreshEl = document.getElementById('client-refresh-interval');
                const trafficRefreshEl = document.getElementById('traffic-refresh-interval');
                const updatedEl = document.getElementById('client-last-updated');
                if (refreshEl) refreshEl.textContent = `更新頻率：${intervalText}`;
                if (trafficRefreshEl) trafficRefreshEl.textContent = `每 ${intervalText}更新`;
                if (updatedEl) updatedEl.textContent = `上次更新：${updatedAt}`;
                filterClients();
                renderTrafficTop5();
                const blockedCount = allClients.filter(c => c.blocked).length;
                document.getElementById('kpi-clients').innerText = allClients.length - blockedCount;
                const ovClients = document.getElementById('ov-ucg-clients'); if (ovClients) ovClients.innerText = (allClients.length - blockedCount) + ' 台';
                document.getElementById('kpi-clients-sub').innerText = `封鎖中 ${blockedCount} 台`;
            } catch (e) { console.error('Clients fetch failed'); }
        }

        function filterClients() {
            const term = document.getElementById('clientSearch').value.toLowerCase();
            const filtered = allClients.filter(c => c.name.toLowerCase().includes(term) || c.ip.toLowerCase().includes(term) || c.mac.toLowerCase().includes(term));
            const tbody = document.getElementById('client-table-body');
            if (!tbody.dataset.eventsDelegated) {
                tbody.dataset.eventsDelegated = 'true';
                tbody.addEventListener('click', event => {
                    const row = event.target.closest('tr[data-client-mac]');
                    if (!row) return;
                    const client = allClients.find(item => item.mac === row.dataset.clientMac);
                    if (!client) return;
                    const action = event.target.closest('[data-client-action]')?.dataset.clientAction;
                    if (action === 'rename') renameClient(client.mac);
                    else if (action === 'block') toggleBlock(client.mac, !client.blocked);
                    else showClientDetail(client.mac);
                });
                tbody.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    if (event.target.closest('button')) return;
                    const row = event.target.closest('tr[data-client-mac]');
                    if (!row) return;
                    event.preventDefault();
                    showClientDetail(row.dataset.clientMac);
                });
            }
            tbody.innerHTML = '';
            document.getElementById('client-count').innerText = filtered.length;
            filtered.forEach(c => {
                const tr = document.createElement('tr');
                tr.className = `hover:bg-slate-800/15 cursor-pointer ${c.blocked ? 'opacity-50' : ''}`;
                tr.dataset.clientMac = c.mac;
                tr.tabIndex = 0;
                tr.setAttribute('role', 'button');
                tr.setAttribute('aria-label', `查看 ${c.name || c.ip} 的客戶端詳情`);
                tr.innerHTML = `
                <td class="py-3 pl-2"><div><p class="font-bold ${c.blocked ? 'text-red-400 line-through' : 'text-slate-200'} flex items-center gap-1.5">${escapeHtml(c.name)}${c.aliased ? '<span class="text-[8px] px-1 py-0.5 bg-blue-500/15 text-blue-400 border border-blue-500/25 rounded font-normal">自訂</span>' : ''}<button type="button" data-client-action="rename" title="自訂名稱" class="text-slate-600 hover:text-blue-400 transition"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7m-1.5-9.5a2.12 2.12 0 013 3L12 18l-4 1 1-4 9.5-9.5z"/></svg></button></p><p class="text-[9px] text-slate-500 mono">${escapeHtml(c.mac)} | ${escapeHtml(c.ip)}</p></div></td>
                <td>${c.is_wifi ? `<span class="text-blue-400 font-semibold inline-flex items-center gap-1">${ICON_WIFI} Wi-Fi (${escapeHtml(c.wifi_signal)}dBm)</span>` : `<span class="text-emerald-400 font-semibold inline-flex items-center gap-1">${ICON_LAN} LAN</span>`}</td>
                <td class="mono text-slate-400"><span class="inline-flex items-center gap-0.5">${ICON_DOWN} ${(c.rx_bytes / 1048576).toFixed(1)}MB</span> / <span class="inline-flex items-center gap-0.5">${ICON_UP} ${(c.tx_bytes / 1048576).toFixed(1)}MB</span></td>
                <td class="text-right py-3 pr-2"><button type="button" data-client-action="block" class="px-2.5 py-1.5 ${c.blocked ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} text-white font-bold rounded-lg text-[10px] transition">${c.blocked ? '解封' : '斷網'}</button></td>`;
                tbody.appendChild(tr);
            });
        }

        function renderTrafficTop5() {
            const top = [...allClients].sort((a, b) => (b.rx_bytes + b.tx_bytes) - (a.rx_bytes + a.tx_bytes));
            const max = top.length ? (top[0].rx_bytes + top[0].tx_bytes) : 1;
            const cnt = document.getElementById('traffic-rank-count'); if (cnt) cnt.textContent = top.length ? `(${top.length} 台)` : '';
            // 前三名有專屬色，其餘統一灰藍
            const colors = ['bg-blue-500', 'bg-indigo-500', 'bg-emerald-500'];
            document.getElementById('traffic-top5').innerHTML = top.map((c, i) => {
                const total = c.rx_bytes + c.tx_bytes;
                const gb = total / 1073741824;
                const label = gb >= 1 ? gb.toFixed(2) + ' GB' : (total / 1048576).toFixed(1) + ' MB';
                return `
                <div>
                    <div class="flex justify-between text-[11px] mb-1">
                        <span class="font-bold text-slate-300 truncate max-w-[140px]">#${i + 1} ${escapeHtml(c.name)}</span>
                        <span class="mono text-slate-400">${label}</span>
                    </div>
                    <div class="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                        <div class="${colors[i] || 'bg-slate-500'} h-full rounded-full transition-all duration-700" style="width: ${Math.max(total / max * 100, 3)}%;"></div>
                    </div>
                </div>`;
            }).join('') || '<p class="text-xs text-slate-500 text-center py-4">無客戶端資料</p>';
        }

        async function renameClient(mac) {
            const c = allClients.find(x => x.mac === mac);
            const cur = c ? (c.aliased ? c.name : '') : '';
            const name = prompt(`自訂「${c ? (c.original_name || c.name) : mac}」的顯示名稱\n(留空 = 恢復原始名稱)`, cur);
            if (name === null) return;
            try {
                const r = await fetch('/api/client-aliases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mac, name }) });
                if (!r.ok) throw new Error();
                showToast(name.trim() ? `已命名為「${name.trim()}」` : '已恢復原始名稱');
                fetchClients();
            } catch { showToast('儲存失敗', true); }
        }
        async function toggleBlock(mac, state) {
            try {
                const target = allClients.find(c => c.mac === mac);
                const res = await fetch('/api/device/restrict', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: mac, blockState: state, deviceName: target ? target.name : 'Unknown Device' }) });
                const rj = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(rj.error || '操作失敗');
                showToast(`已成功下達 ${state ? '阻斷' : '解封'} 命令`);
                fetchClients();
                fetchBlockHistory();
                closeClientDetail();
            } catch (e) { showToast(e.message || '操作失敗', true); }
        }

        function showClientDetail(mac) {
            const c = allClients.find(x => x.mac === mac);
            if (!c) return;
            document.getElementById('cd-title').innerText = c.name || '客戶端詳情';
            const row = (label, val, html = false) => `<div class="flex justify-between text-xs border-b border-slate-800/50 pb-2"><span class="text-slate-500">${escapeHtml(label)}</span><span class="text-slate-200 font-semibold mono text-right break-all">${html ? val : escapeHtml(val)}</span></div>`;
            const totalMB = (c.rx_bytes + c.tx_bytes) / 1048576;
            document.getElementById('cd-body').innerHTML =
                row('設備名稱', c.name || '未知') +
                row('MAC 位址', c.mac) +
                row('IP 位址', c.ip) +
                row('連線方式', c.is_wifi ? `Wi-Fi (訊號 ${c.wifi_signal} dBm)` : '有線 LAN') +
                row('下載量 (Rx)', (c.rx_bytes / 1048576).toFixed(1) + ' MB') +
                row('上傳量 (Tx)', (c.tx_bytes / 1048576).toFixed(1) + ' MB') +
                row('累計流量', (totalMB >= 1024 ? (totalMB / 1024).toFixed(2) + ' GB' : totalMB.toFixed(1) + ' MB')) +
                row('存取狀態', c.blocked ? '<span class="text-red-400">已封鎖</span>' : '<span class="text-emerald-400">正常連線</span>', true) +
                `<button type="button" id="client-detail-block" class="w-full mt-2 py-2.5 ${c.blocked ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} text-white font-bold rounded-xl text-xs transition">${c.blocked ? '解除封鎖' : '斷網封鎖此設備'}</button>`;
            document.getElementById('client-detail-block').addEventListener('click', () => toggleBlock(c.mac, !c.blocked));
            const m = document.getElementById('client-modal');
            m.classList.remove('hidden'); m.classList.add('flex');
            setDialogState('client-modal', true);
        }
        function closeClientDetail() {
            const m = document.getElementById('client-modal');
            m.classList.add('hidden'); m.classList.remove('flex');
            setDialogState('client-modal', false);
        }

        function closeDiskSmart() {
            const m = document.getElementById('smart-modal');
            m.classList.add('hidden'); m.classList.remove('flex');
            setDialogState('smart-modal', false);
        }
        // 常見 SMART 屬性的白話說明（滑鼠停留可看）
        const SMART_HINT = {
            5: '已被重新映射的壞扇區數量，非 0 且持續增加代表碟片開始老化',
            9: '硬碟累計通電時間',
            194: '目前碟溫',
            197: '等待重映射的可疑扇區，非 0 要留意',
            198: '無法讀取且無法修正的扇區，非 0 通常代表已有壞軌',
            199: '傳輸線路上的 CRC 錯誤，偏高多半是 SATA 線或接觸問題',
            1: '底層讀取錯誤率（Seagate 原始值偏大屬正常，看 value/worst 是否高於門檻即可）',
            241: 'LBA 寫入總量（可推估寫入壽命）',
            242: 'LBA 讀取總量'
        };
        // 點擊硬碟前先警告：讀取 SMART 會喚醒休眠中的機械碟
        function confirmDiskSmart(dev, name, sleeping) {
            const isSsd = /m\.2|nvme|ssd/i.test(name);
            // SSD 不會因讀取 SMART 而「喚醒」(本來就常駐)，直接看
            if (isSsd) return showDiskSmart(dev, name);
            const msg = sleeping
                ? `「${name}」目前正在休眠 💤\n\n讀取 SMART 詳情會喚醒這顆機械硬碟並中斷它的省電休眠。\n\n確定要喚醒並查看嗎？`
                : `讀取「${name}」的 SMART 詳情會對硬碟發出 SMART 指令。\n此碟目前運轉中，影響不大，但仍會產生一次存取。\n\n確定要查看嗎？`;
            if (confirm(msg)) showDiskSmart(dev, name);
        }
        async function showDiskSmart(dev, name) {
            const m = document.getElementById('smart-modal');
            m.classList.remove('hidden'); m.classList.add('flex');
            setDialogState('smart-modal', true);
            document.getElementById('smart-title').textContent = `${name} — SMART 詳情`;
            const body = document.getElementById('smart-body');
            body.innerHTML = '<p class="text-xs text-slate-500 text-center py-8">讀取中...</p>';

            try {
                // 有 dev 用 dev；只有名稱時傳 name 由後端即時對照 (此時使用者已確認要存取硬碟)
                const q = dev ? 'dev=' + encodeURIComponent(dev) : 'name=' + encodeURIComponent(name);
                const r = await (await fetch('/api/nas/disk-smart?' + q)).json();
                if (r.error) throw new Error(r.error);
                const s = r.smart || {};
                const rows = (s.report || []);
                // 整體判定：任何屬性 status 非 1（或 value 已跌破 thresh）就標警告
                const bad = rows.filter(a => (a.status && a.status !== 1) || (a.thresh > 0 && a.value <= a.thresh));
                const overall = bad.length ? `⚠ ${bad.length} 項屬性需注意` : '✓ 全部屬性正常';
                const tempAttr = rows.find(a => a.id === 194);
                const pohAttr = rows.find(a => a.id === 9);
                body.innerHTML = `
                <div class="flex flex-wrap gap-2 mb-4">
                    <span class="px-3 py-1.5 rounded-lg text-xs font-bold ${bad.length ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}">${overall}</span>
                    ${tempAttr ? `<span class="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300">目前溫度 ${escapeHtml(tempAttr.value)}°C</span>` : ''}
                    ${pohAttr ? `<span class="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-300">通電 ${escapeHtml((pohAttr.raw ?? 0).toLocaleString())} 小時</span>` : ''}
                    ${s.last && s.last.status != null ? `<span class="px-3 py-1.5 rounded-lg text-xs bg-slate-800 text-slate-400">上次自我測試狀態碼 ${escapeHtml(s.last.status)}</span>` : ''}
                </div>
                <div class="overflow-x-auto">
                <table class="w-full text-[10px] mono">
                    <thead><tr class="text-slate-500 border-b border-slate-800 text-left">
                        <th class="py-1.5 pr-2">ID</th><th class="pr-2">屬性</th><th class="pr-2 text-right">Value</th><th class="pr-2 text-right">Worst</th><th class="pr-2 text-right">門檻</th><th class="pr-2 text-right">原始值</th><th class="text-center">狀態</th>
                    </tr></thead>
                    <tbody>
                    ${rows.map(a => {
                    const attrBad = (a.status && a.status !== 1) || (a.thresh > 0 && a.value <= a.thresh);
                    const hint = SMART_HINT[a.id];
                    return `<tr class="border-b border-slate-850/60 ${attrBad ? 'bg-red-500/5' : ''}">
                            <td class="py-1.5 pr-2 text-slate-500">${escapeHtml(a.id)}</td>
                            <td class="pr-2 text-slate-300" ${hint ? `title="${hint}"` : ''}>${escapeHtml(a.label || a.name)}${hint ? ' <span class="text-slate-600">ⓘ</span>' : ''}</td>
                            <td class="pr-2 text-right text-slate-300">${escapeHtml(a.value)}</td>
                            <td class="pr-2 text-right text-slate-500">${escapeHtml(a.worst)}</td>
                            <td class="pr-2 text-right text-slate-500">${escapeHtml(a.thresh)}</td>
                            <td class="pr-2 text-right text-slate-400">${escapeHtml((a.raw ?? '').toLocaleString?.() ?? a.raw ?? '')}</td>
                            <td class="text-center">${attrBad ? '<span class="text-red-400">⚠</span>' : '<span class="text-emerald-500">✓</span>'}</td>
                        </tr>`;
                }).join('')}
                    </tbody>
                </table>
                </div>
                <p class="text-[9px] text-slate-600 mt-3 leading-relaxed">Value/Worst 是硬碟廠商正規化後的健康分數（越高越好），跌到「門檻」以下才算異常；原始值(Raw)是實際計數。滑鼠停在有 ⓘ 的屬性上可看白話解釋。資料即時取自 NAS 的 UGOS SMART。</p>`;
            } catch (e) {
                body.innerHTML = `<p class="text-xs text-red-400 text-center py-8">讀取 SMART 失敗：${escapeHtml(e.message)}</p>`;
            }
        }

        async function fetchBlockHistory() {
            try {
                const res = await fetch('/api/block-history');
                if (!res.ok) throw new Error();
                const history = (await res.json()).history || [];
                document.getElementById('block-history-count').innerText = history.length;
                const list = document.getElementById('block-history-list');
                if (history.length === 0) {
                    list.innerHTML = '<p class="text-xs text-slate-500 py-4">尚無封鎖紀錄</p>';
                    return;
                }
                list.innerHTML = history.map(h => {
                    const isBlock = h.action === 'block';
                    return `
                <div class="relative">
                    <span class="absolute -left-[26px] top-1 w-2.5 h-2.5 rounded-full ${isBlock ? 'bg-red-500' : 'bg-emerald-500'} ring-4 ring-slate-900"></span>
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 bg-slate-950/50 border border-slate-800/60 rounded-xl px-4 py-2.5">
                        <div>
                            <span class="text-xs font-bold ${isBlock ? 'text-red-400' : 'text-emerald-400'}">${isBlock ? '🚫 斷網封鎖' : '✅ 解除封鎖'}</span>
                            <span class="text-xs text-slate-200 font-semibold ml-2">${escapeHtml(h.name)}</span>
                            <span class="text-[9px] text-slate-500 mono ml-2">${escapeHtml(h.mac)}</span>
                        </div>
                        <span class="text-[9px] text-slate-500 mono">${new Date(h.datetime).toLocaleString('zh-TW')}</span>
                    </div>
                </div>`;
                }).join('');
            } catch (e) { /* 靜默失敗 */ }
        }

        /* ==================== WiFi ==================== */
        async function fetchWiFiNetworks() {
            try {
                const res = await fetch('/api/wifi-networks');
                if (!res.ok) throw new Error();
                const networks = (await res.json()).networks || [];
                const list = document.getElementById('wifi-list');
                list.innerHTML = networks.map((net, index) => `
                    <div class="flex items-center justify-between p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/60 ${net.enabled ? '' : 'opacity-50'}">
                        <div><p class="text-xs font-bold">${escapeHtml(net.name)}</p></div>
                        <label class="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" ${net.enabled ? 'checked' : ''} data-wifi-index="${index}" class="sr-only peer">
                            <div class="w-9 h-5 bg-slate-850 rounded-full peer peer-checked:after:translate-x-full after:absolute after:top-[2px] after:left-[2px] after:bg-slate-400 after:rounded-full after:h-4 after:w-4 peer-checked:bg-blue-600 transition-all"></div>
                        </label>
                    </div>`).join('');
                list.querySelectorAll('[data-wifi-index]').forEach(input => {
                    input.addEventListener('change', () => {
                        const net = networks[Number(input.dataset.wifiIndex)];
                        if (net) toggleWiFi(net._id, input.checked);
                    });
                });
            } catch (e) { console.error('WiFi fetch failed'); }
        }

        async function toggleWiFi(id, state) {
            try {
                await fetch(`/api/wifi-networks/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: state }) });
                showToast('WiFi 設定已更新');
                fetchWiFiNetworks();
            } catch (e) { showToast('WiFi 更新失敗', true); }
        }

        let guestQrObjectUrl = null;
        async function updateGuestQR() {
            if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可產生 WiFi QR', true);
            const ssid = document.getElementById('v-ssid').value, pass = document.getElementById('v-pass').value;
            if (!ssid) return;
            const img = document.getElementById('qr-img');
            try {
                const response = await fetch('/api/wifi/qr', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ssid, password: pass })
                });
                if (!response.ok) {
                    const result = await response.json().catch(() => ({}));
                    throw new Error(result.error || `HTTP ${response.status}`);
                }
                const blob = await response.blob();
                if (guestQrObjectUrl) URL.revokeObjectURL(guestQrObjectUrl);
                guestQrObjectUrl = URL.createObjectURL(blob);
                img.src = guestQrObjectUrl;
                img.classList.remove('hidden');
            } catch (error) { showToast(`QR 產生失敗：${error.message}`, true); }
        }

        /* ==================== 雲端 Site Manager ==================== */
        function switchCloudTab(tab) {
            ['sites', 'devices', 'hosts', 'sdwan'].forEach(t => {
                const btn = document.getElementById(`tab-${t}`);
                const content = document.getElementById(`cloud-${t}-content`);
                if (t === tab) {
                    btn.className = 'cloud-tab px-3 py-2 rounded-lg bg-blue-600 text-white text-[10px] font-bold whitespace-nowrap transition';
                    btn.setAttribute('aria-selected', 'true');
                    content.classList.remove('hidden');
                } else {
                    btn.className = 'cloud-tab px-3 py-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/70 text-[10px] font-bold whitespace-nowrap transition';
                    btn.setAttribute('aria-selected', 'false');
                    content.classList.add('hidden');
                }
            });
        }

        async function fetchCloudSites() {
            try {
                const res = await fetch('/api/cloud/sites');
                if (!res.ok) throw new Error();
                const result = await res.json();
                const sites = result.data || [];
                ['cloud-status-badge', 'cloud-status-badge-sec'].forEach(id => {
                    const badge = document.getElementById(id);
                    if (badge) {
                        if (['not_configured', 'error', 'fallback', 'fallback_on_error'].includes(result.source)) {
                            badge.innerText = 'SITE MANAGER: 未設定';
                            badge.classList.remove('bg-blue-500/10', 'text-blue-400', 'border-blue-500/20');
                            badge.classList.add('bg-amber-500/10', 'text-amber-400', 'border-amber-500/20');
                        } else {
                            badge.innerText = 'SITE MANAGER: ONLINE';
                            badge.classList.remove('bg-amber-500/10', 'text-amber-400', 'border-amber-500/20');
                            badge.classList.add('bg-blue-500/10', 'text-blue-400', 'border-blue-500/20');
                        }
                    }
                });
                const container = document.getElementById('cloud-sites-content');
                container.innerHTML = sites.length ? '' : (result.source === 'not_configured' ? '<div class="text-center py-6 px-4"><p class="text-xs text-amber-400 font-bold mb-1.5">尚未設定 Site Manager API Key</p><p class="text-[10px] text-slate-500 leading-relaxed">這是選用的官方雲端功能。至 <span class="text-slate-300">unifi.ui.com → API</span> 申請 API Key，貼到本站「設定 → 設備連線設定 → UniFi API Key」即可啟用雲端站點/託管設備/ISP 品質/SD-WAN 資訊。不設定不影響本地功能。</p></div>' : '<p class="text-xs text-slate-500 text-center py-4">無可用站點</p>');
                sites.forEach(site => {
                    const desc = site.meta ? site.meta.desc : site.name;
                    const totalDev = site.statistics && site.statistics.counts ? site.statistics.counts.totalDevice : 0;
                    const wanUptime = site.statistics && site.statistics.percentages ? site.statistics.percentages.wanUptime : 100;
                    container.innerHTML += `
                    <div class="p-2 bg-slate-900/40 border border-slate-800/40 rounded-lg flex justify-between items-center text-[10px]">
                        <div>
                            <p class="font-bold text-slate-200">${escapeHtml(desc)}</p>
                            <p class="text-[9px] text-slate-500">時區: ${escapeHtml(site.meta ? site.meta.timezone : 'Asia/Taipei')}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-slate-300 font-semibold">${totalDev} 台設備</p>
                            <p class="text-[9px] text-emerald-400 font-mono">WAN Uptime: ${wanUptime}%</p>
                        </div>
                    </div>`;
                });
            } catch (e) { console.error('Fetch cloud sites failed', e); }
        }

        async function fetchCloudDevices() {
            try {
                const res = await fetch('/api/cloud/devices');
                if (!res.ok) throw new Error();
                const result = await res.json();
                const groups = result.data || [];
                const devices = groups.flatMap(group => Array.isArray(group.devices)
                    ? group.devices.map(device => ({ ...device, hostName: group.hostName || '' }))
                    : [group]
                ).filter(device => device && (device.name || device.model || device.ip || device.mac));
                const container = document.getElementById('cloud-devices-content');
                container.innerHTML = devices.length ? '' : result.source === 'not_configured'
                    ? '<p class="text-[10px] text-amber-400/80 text-center py-6">尚未設定 Site Manager API Key</p>'
                    : result.source === 'error'
                        ? '<p class="text-[10px] text-red-400/80 text-center py-6">設備資料暫時無法取得</p>'
                        : '<p class="text-[10px] text-slate-500 text-center py-6">API 已連線，目前沒有託管設備</p>';
                devices.forEach(dev => {
                    const isOnline = dev.status === 'online';
                    const modelVersion = [dev.model, dev.version ? `v${dev.version}` : null].filter(Boolean).join(' · ');
                    container.innerHTML += `
                    <div class="p-3 bg-slate-900/40 border border-slate-800/40 rounded-lg flex justify-between items-center gap-4 text-[10px]">
                        <div class="min-w-0">
                            <p class="font-bold text-slate-200 truncate">${escapeHtml(dev.name || dev.model || '未命名設備')}</p>
                            <p class="text-[9px] text-slate-500 font-mono truncate">${escapeHtml(modelVersion || dev.mac || '')}</p>
                            ${dev.hostName ? `<p class="text-[9px] text-slate-600 mt-0.5">控制主機：${escapeHtml(dev.hostName)}</p>` : ''}
                        </div>
                        <div class="text-right shrink-0">
                            <p class="font-mono text-slate-300">${escapeHtml(dev.ip || '尚未取得 IP')}</p>
                            <p class="text-[9px] ${isOnline ? 'text-emerald-400' : 'text-red-400'} font-bold uppercase tracking-wider">${escapeHtml(dev.status || 'unknown')}</p>
                        </div>
                    </div>`;
                });
            } catch (e) { console.error('Fetch cloud devices failed', e); }
        }

        async function fetchCloudHosts() {
            try {
                const res = await fetch('/api/cloud/hosts');
                if (!res.ok) throw new Error();
                const hosts = (await res.json()).data || [];
                const container = document.getElementById('cloud-hosts-content');
                container.innerHTML = hosts.length ? '' : '<p class="text-[10px] text-amber-400/80 text-center py-4">未設定 Site Manager API Key — 於 設定 → 設備連線設定 填入後啟用</p>';
                hosts.forEach(host => {
                    const name = host.reportedState ? host.reportedState.name : 'Unknown Host';
                    const state = host.reportedState ? host.reportedState.state : 'offline';
                    const isOnline = state === 'connected' || state === 'online';
                    container.innerHTML += `
                    <div class="p-2 bg-slate-900/40 border border-slate-800/40 rounded-lg flex justify-between items-center text-[10px]">
                        <div>
                            <p class="font-bold text-slate-200">${escapeHtml(name)}</p>
                            <p class="text-[9px] text-slate-500 font-mono">類型: ${escapeHtml(host.type)} | Hardware ID: ${escapeHtml(host.hardwareId ? host.hardwareId.substring(0, 8) : '')}...</p>
                        </div>
                        <div class="text-right">
                            <p class="font-mono text-slate-300">${escapeHtml(host.ipAddress || 'Unknown')}</p>
                            <p class="text-[9px] ${isOnline ? 'text-emerald-400' : 'text-red-400'} font-bold uppercase tracking-wider">${escapeHtml(state)}</p>
                        </div>
                    </div>`;
                });
            } catch (e) { console.error('Fetch cloud hosts failed', e); }
        }

        async function fetchCloudSdwan() {
            try {
                const res = await fetch('/api/cloud/sdwan');
                if (!res.ok) throw new Error();
                const result = await res.json();
                const configs = result.data || [];
                const container = document.getElementById('cloud-sdwan-content');
                container.innerHTML = configs.length ? '' : result.source === 'not_configured'
                    ? '<p class="text-[10px] text-amber-400/80 text-center py-6">尚未設定 Site Manager API Key</p>'
                    : result.source === 'error'
                        ? '<p class="text-[10px] text-red-400/80 text-center py-6">SD-WAN 資料暫時無法取得</p>'
                        : '<div class="text-center py-6"><p class="text-xs font-bold text-slate-300">目前沒有 SD-WAN VPN</p><p class="text-[9px] text-slate-500 mt-1">Site Manager API 已連線；尚未建立 SD-WAN 設定</p></div>';
                configs.forEach(cfg => {
                    container.innerHTML += `
                    <div class="p-2 bg-slate-900/40 border border-slate-800/40 rounded-lg flex justify-between items-center text-[10px]">
                        <div>
                            <p class="font-bold text-slate-200">${escapeHtml(cfg.name)}</p>
                            <p class="text-[9px] text-slate-500">類型: ${escapeHtml(cfg.type)}</p>
                        </div>
                        <span class="px-2 py-0.5 rounded text-[8px] bg-blue-950 text-blue-400 border border-blue-900/40 font-bold">CONNECTED</span>
                    </div>`;
                });
            } catch (e) { console.error('Fetch cloud SD-WAN configs failed', e); }
        }

        async function fetchIspMetrics() {
            try {
                const res = await fetch('/api/cloud/isp-metrics');
                if (!res.ok) throw new Error();
                const metrics = (await res.json()).data || {};
                const ispName = metrics.ispName || 'Unknown ISP';
                const ispDisplayName = /chunghwa/i.test(ispName) && !/中華電信/.test(ispName)
                    ? `${ispName}（中華電信）`
                    : ispName;
                document.getElementById('isp-name').innerText = ispDisplayName;
                document.getElementById('isp-latency').innerText = (metrics.latency || '--') + ' ms';
                document.getElementById('isp-loss').innerText = (metrics.packetLoss != null ? metrics.packetLoss.toFixed(2) : '--') + ' %';
                document.getElementById('isp-speed-down').innerText = (metrics.downloadSpeedMbps || '--') + ' Mbps';
                document.getElementById('isp-speed-up').innerText = (metrics.uploadSpeedMbps || '--') + ' Mbps';
                document.getElementById('kpi-wan-sub').innerText = `延遲 ${metrics.latency || '--'} ms · ${ispDisplayName}`;
            } catch (e) { console.error('Fetch ISP metrics failed', e); }
        }

        /* ==================== 威脅 ==================== */
        function setThreatTimeFilter(days) {
            activeTimeRangeDays = days;
            [1, 3, 7, 30].forEach(f => {
                const btn = document.getElementById(`btn-filter-${f}`);
                if (btn) btn.className = f === days
                    ? 'px-2.5 py-1 rounded-md font-bold bg-blue-600 text-white transition'
                    : 'px-2.5 py-1 rounded-md font-bold text-slate-450 hover:text-slate-200 transition';
            });
            renderThreatTable();
        }

        // 套用時間 / 搜尋 / 危險度 / 類別四重篩選
        function getFilteredThreats() {
            const cutoffTime = Date.now() - activeTimeRangeDays * 86400000;
            const term = (document.getElementById('threatSearch')?.value || '').toLowerCase();
            const sev = document.getElementById('threatSeverity')?.value || '';
            const cat = document.getElementById('threatCategory')?.value || '';
            return allThreats.filter(t => {
                if (new Date(t.datetime).getTime() < cutoffTime) return false;
                if (sev && t.severity !== sev) return false;
                if (cat && t.category !== cat) return false;
                if (term) {
                    const hay = `${t.src_ip} ${t.src_country} ${t.target_ip} ${t.target_device} ${t.msg} ${t.category} ${t.port}`.toLowerCase();
                    if (!hay.includes(term)) return false;
                }
                return true;
            });
        }

        let threatBlockState = null;

        function renderThreatTable() {
            const tbody = document.getElementById('threat-table-body');
            if (!tbody) return;
            const filtered = getFilteredThreats();
            const countEl = document.getElementById('threat-result-count');
            if (countEl) countEl.innerText = `— 顯示 ${filtered.length} 筆`;
            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-500 font-medium">依目前條件無符合的威脅事件</td></tr>`;
                return;
            }
            tbody.innerHTML = filtered.map(t => {
                const timeStr = new Date(t.datetime).toLocaleString('zh-TW', { hour12: false });
                const sevColor = t.severity === 'HIGH' ? 'bg-red-950/80 text-red-400 border-red-900/40' : 'bg-amber-950/80 text-amber-400 border-amber-900/40';
                const catColor = CAT_COLORS[t.category] || '#64748b';
                const canBlock = document.documentElement.dataset.panelRole === 'admin'
                    && t.src_ip && t.src_ip !== '-' && /^\d+\.\d+\.\d+\.\d+$/.test(t.src_ip);
                return `
                <tr class="hover:bg-slate-900/40 transition border-b border-slate-850/30">
                    <td class="py-2.5 mono text-[10px] text-slate-400">${escapeHtml(timeStr)}</td>
                    <td class="py-2.5"><span class="px-2 py-0.5 rounded text-[8px] border font-bold uppercase tracking-wider" style="color:${catColor};border-color:${catColor}44;background:${catColor}18;">${escapeHtml(t.category)}</span></td>
                    <td class="py-2.5"><span class="px-1.5 py-0.5 rounded text-[8px] border font-bold ${sevColor}">${escapeHtml(t.severity || '-')}</span></td>
                    <td class="py-2.5 mono text-[11px] text-slate-200">${escapeHtml(t.src_ip)} <span class="text-[9px] text-slate-500">(${escapeHtml(t.src_country)})</span></td>
                    <td class="py-2.5 mono text-[11px] text-slate-300">${escapeHtml(t.target_ip)} <span class="text-[9px] text-slate-500">(${escapeHtml(t.target_device)})</span></td>
                    <td class="py-2.5 text-[11px] text-slate-450 truncate max-w-xs" title="${escapeHtml(t.msg)}">${escapeHtml(t.msg)}</td>
                    <td class="py-2.5 mono text-[10px] text-slate-400">${escapeHtml(t.port)}</td>
                    <td class="py-2.5 text-right whitespace-nowrap">
                        <span class="font-black text-red-500 text-[10px] uppercase tracking-wider">${escapeHtml(t.action_taken)}</span>
                        ${canBlock ? `<button data-action="copy-src-ip" data-ip="${escapeActionData(t.src_ip)}" title="複製來源 IP" class="ml-1.5 text-slate-500 hover:text-blue-400 align-middle"><svg class="w-3 h-3 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 002 2v8a2 2 0 002 2z"/></svg></button><button data-action="threat-block" data-ip="${escapeActionData(t.src_ip)}" title="加入有期限的 UniFi 封鎖清單" class="ml-1.5 px-1.5 py-0.5 rounded border border-red-900/60 text-[9px] font-bold text-red-400 hover:bg-red-950/60">臨時封鎖</button>` : ''}
                    </td>
                </tr>`;
            }).join('');
        }

        function copySrcIp(ip) {
            navigator.clipboard?.writeText(ip).then(() => showToast(`已複製來源 IP: ${ip}`)).catch(() => { });
        }

        function renderThreatBlocks() {
            const panel = document.getElementById('threat-block-panel');
            const status = document.getElementById('threat-block-status');
            const list = document.getElementById('threat-block-list');
            if (!panel || !status || !list) return;
            const admin = document.documentElement.dataset.panelRole === 'admin';
            panel.classList.toggle('hidden', !admin);
            if (!admin) return;
            const state = threatBlockState;
            if (!state) {
                status.textContent = '讀取中…';
                list.innerHTML = '';
                return;
            }
            const configured = state.configuration?.configured === true;
            const health = state.reconcile?.status || 'pending';
            status.textContent = configured ? `Integration API · ${health}` : 'Integration API 尚未設定';
            status.className = `text-[10px] mono ${!configured || health === 'degraded' ? 'text-amber-400' : 'text-emerald-400'}`;
            const blocks = (state.blocks || []).filter(block => block.desiredState === 'active');
            list.innerHTML = blocks.length ? blocks.map(block => `
                <div class="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800/70 bg-slate-900/60 px-3 py-2">
                    <span class="mono text-xs text-slate-200">${escapeHtml(block.ip)}</span>
                    <span class="text-[9px] ${block.syncState === 'applied' ? 'text-emerald-400' : 'text-amber-400'}">${escapeHtml(block.syncState)}</span>
                    <span class="text-[9px] text-slate-500">到期 ${escapeHtml(new Date(block.expiresAt).toLocaleString('zh-TW', { hour12: false }))}</span>
                    <button data-action="threat-unblock" data-id="${escapeActionData(block.id)}" data-ip="${escapeActionData(block.ip)}" class="ml-auto text-[9px] font-bold text-red-400 hover:text-red-300">提前移除</button>
                </div>`).join('') : '<p class="text-[10px] text-slate-600">目前沒有有效的臨時來源 IP 封鎖。</p>';
        }

        async function fetchThreatBlocks() {
            try {
                const security = await loadPanelSecurityContext();
                renderThreatTable();
                if (security.role !== 'admin') return renderThreatBlocks();
                const response = await fetch('/api/security/threat-blocks', { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                threatBlockState = await response.json();
                renderThreatBlocks();
            } catch (error) {
                dbg('ThreatBlock', '讀取失敗', error);
            }
        }

        async function requestThreatBlock(ip) {
            const raw = prompt(`封鎖 ${ip} 幾分鐘？（15 到 43200）`, '1440');
            if (raw === null) return;
            const expiresInMinutes = Number(raw);
            if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 15 || expiresInMinutes > 43200) {
                return showToast('到期時間必須是 15 到 43200 分鐘的整數', true);
            }
            if (!confirm(`確認將公網來源 ${ip} 加入 SmartHub 專用 UniFi 封鎖清單？\n\n到期：${new Date(Date.now() + expiresInMinutes * 60000).toLocaleString('zh-TW')}\n到期後系統會自動移除。`)) return;
            try {
                const response = await fetch('/api/security/threat-blocks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ip, expiresInMinutes, confirmation: 'BLOCK_EXTERNAL_IP' })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                showToast(result.applied ? `已套用 ${ip} 的臨時封鎖` : `已保存 ${ip}；UniFi 暫時無法同步，將自動重試`, !result.applied);
                await fetchThreatBlocks();
            } catch (error) { showToast(`封鎖失敗：${error.message}`, true); }
        }

        async function removeThreatBlock(id, ip) {
            if (!confirm(`確認提前移除 ${ip} 的 UniFi 臨時封鎖？`)) return;
            try {
                const response = await fetch(`/api/security/threat-blocks/${encodeURIComponent(id)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirmation: 'REMOVE_EXTERNAL_IP_BLOCK' })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                showToast(result.applied ? `已移除 ${ip}` : `已保存移除要求；UniFi 恢復後會自動重試`, !result.applied);
                await fetchThreatBlocks();
            } catch (error) { showToast(`移除失敗：${error.message}`, true); }
        }

        function exportThreatsCSV() {
            const rows = getFilteredThreats();
            if (!rows.length) return showToast('無資料可匯出', true);
            const header = ['datetime', 'category', 'severity', 'src_ip', 'src_country', 'target_ip', 'target_device', 'msg', 'port', 'action_taken'];
            const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const csv = [header.join(',')].concat(rows.map(t => header.map(h => esc(t[h])).join(','))).join('\n');
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `threats_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast(`已匯出 ${rows.length} 筆威脅事件`);
        }

        // 依威脅計算安全評分 (0-100)：以 24h 內事件數與嚴重度加權扣分
        // 回傳評分明細，讓分數高低有可解釋的依據
        function securityScoreDetail(threats) {
            const dayAgo = Date.now() - 86400000;
            const recent = threats.filter(t => new Date(t.datetime).getTime() >= dayAgo);
            let penalty = 0, high = 0, medium = 0, low = 0, boosted = 0;
            recent.forEach(t => {
                const base = t.severity === 'HIGH' ? 4 : t.severity === 'MEDIUM' ? 2 : 1;
                if (t.severity === 'HIGH') high++; else if (t.severity === 'MEDIUM') medium++; else low++;
                const catMul = (t.category === 'Malware' || t.category === 'DoS') ? 1.5 : 1;
                if (catMul > 1) boosted++;
                penalty += base * catMul;
            });
            const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
            return { score, count: recent.length, high, medium, low, boosted, penalty: Math.round(penalty) };
        }
        function computeSecurityScore(threats) { return securityScoreDetail(threats).score; }
        function resetSecStats() {
            localStorage.setItem('secStatsResetTs', Date.now());
            showToast('✅ 已歸零：Top 統計與地圖只看之後的新事件');
            updateSecurityAnalytics(allThreats); updateWorldMap();
        }

        function gradeFor(score) {
            if (score >= 90) return { label: '優良 (A)', color: '#10b981' };
            if (score >= 75) return { label: '良好 (B)', color: '#3b82f6' };
            if (score >= 60) return { label: '普通 (C)', color: '#f59e0b' };
            if (score >= 40) return { label: '警戒 (D)', color: '#f97316' };
            return { label: '危險 (F)', color: '#ef4444' };
        }

        function renderTopBreakdown(elId, counts, colorFn) {
            const el = document.getElementById(elId);
            if (!el) return;
            const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
            if (!entries.length) { el.innerHTML = '<p class="text-xs text-slate-500 py-3">無資料</p>'; return; }
            const max = entries[0][1];
            el.innerHTML = entries.map(([k, v]) => `
            <div>
                <div class="flex justify-between text-[10px] mb-1">
                    <span class="text-slate-300 font-semibold truncate max-w-[150px]">${escapeHtml(k)}</span>
                    <span class="mono text-slate-400">${v} 次</span>
                </div>
                <div class="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden border border-slate-800">
                    <div class="h-full rounded-full transition-all duration-700" style="width:${Math.max(v / max * 100, 4)}%;background:${colorFn ? colorFn(k) : '#3b82f6'};"></div>
                </div>
            </div>`).join('');
        }

        function updateSecurityAnalytics(threats) {
            const dayAgo = Date.now() - 86400000;
            const recent = threats.filter(t => new Date(t.datetime).getTime() >= dayAgo);
            const highCount = threats.filter(t => t.severity === 'HIGH').length;
            const countries = new Set(threats.map(t => t.src_country).filter(c => c && c !== 'Unknown'));
            const blockedNow = allClients.filter(c => c.blocked).length;
            const detail = securityScoreDetail(threats);
            const score = detail.score;
            const grade = gradeFor(score);

            // 總覽評分環
            const ring = document.getElementById('sec-score-ring');
            if (ring) {
                ring.style.strokeDashoffset = 283 - (283 * score / 100);
                ring.style.stroke = grade.color;
            }
            const setTxt = (id, v) => { const e = document.getElementById(id); if (e) e.innerText = v; };
            setTxt('sec-score', score);
            const grEl = document.getElementById('sec-score-grade');
            if (grEl) { grEl.innerText = grade.label; grEl.style.color = grade.color; }
            // 評分依據說明 (總覽 + 資安頁)
            const explainTxt = detail.count === 0
                ? '滿分 100。過去 24 小時無攔截事件，未扣分。'
                : `滿分 100，扣 ${detail.penalty} 分。<br>24H 共 ${detail.count} 起（高危 ${detail.high}·中 ${detail.medium}·低 ${detail.low}${detail.boosted ? `，其中 ${detail.boosted} 起 Malware/DoS 加重` : ''}）。`;
            const ovExplain = document.getElementById('ov-score-explain'); if (ovExplain) ovExplain.innerHTML = explainTxt;
            const secExplain = document.getElementById('sec-score-explain'); if (secExplain) secExplain.innerHTML = explainTxt;
            setTxt('ov-threat-24h', `${recent.length} 次攔截`);

            // 資安頁 KPI 列
            setTxt('sec-kpi-24h', recent.length);
            setTxt('sec-kpi-total', threats.length);
            setTxt('sec-kpi-high', highCount);
            setTxt('sec-kpi-countries', countries.size);
            setTxt('sec-kpi-blocked', blockedNow);
            setTxt('kpi-threats', recent.length);
            const scoreEl = document.getElementById('sec-kpi-score');
            if (scoreEl) { scoreEl.innerText = score; scoreEl.style.color = grade.color; }
            const gradeEl2 = document.getElementById('sec-kpi-grade');
            if (gradeEl2) { gradeEl2.innerText = grade.label; gradeEl2.style.color = grade.color; }

            // 多維度 Top 分析 (可用「歸零重新統計」排除舊事件，預設看全部)
            const sinceTs = parseInt(localStorage.getItem('secStatsResetTs') || '0', 10);
            const sinceLbl = document.getElementById('sec-stats-since');
            if (sinceLbl) sinceLbl.textContent = sinceTs ? ` · 統計自 ${new Date(sinceTs).toLocaleString('zh-TW')}` : '';
            const statsThreats = sinceTs ? threats.filter(t => new Date(t.datetime).getTime() >= sinceTs) : threats;
            const bySrc = {}, byTarget = {}, byPort = {};
            statsThreats.forEach(t => {
                if (t.src_ip) bySrc[`${t.src_ip} (${t.src_country})`] = (bySrc[`${t.src_ip} (${t.src_country})`] || 0) + 1;
                if (t.target_device) byTarget[t.target_device] = (byTarget[t.target_device] || 0) + 1;
                if (t.port) byPort[t.port] = (byPort[t.port] || 0) + 1;
            });
            renderTopBreakdown('sec-top-srcip', bySrc, () => '#ef4444');
            renderTopBreakdown('sec-top-target', byTarget, () => '#f59e0b');
            renderTopBreakdown('sec-top-port', byPort, () => '#3b82f6');

            // 每小時趨勢 (過去 24 小時)
            const hourLabels = [], hourBuckets = [];
            const now = new Date();
            for (let i = 23; i >= 0; i--) {
                const d = new Date(now.getTime() - i * 3600000);
                hourLabels.push(d.getHours() + ':00');
                hourBuckets.push({ start: new Date(d).setMinutes(0, 0, 0), byCat: {} });
            }
            recent.forEach(t => {
                const ts = new Date(t.datetime).setMinutes(0, 0, 0);
                const b = hourBuckets.find(h => h.start === ts);
                if (b) b.byCat[t.category] = (b.byCat[t.category] || 0) + 1;
            });
            if (ovHourlyChart) {
                ovHourlyChart.data.labels = hourLabels;
                ovHourlyChart.data.datasets[0].data = hourBuckets.map(b => Object.values(b.byCat).reduce((a, c) => a + c, 0));
                updateChartWithEntrance(ovHourlyChart);
            }
            if (secHourlyChart) {
                secHourlyChart.data.labels = hourLabels;
                THREAT_CATS.forEach((cat, i) => { secHourlyChart.data.datasets[i].data = hourBuckets.map(b => b.byCat[cat] || 0); });
                updateChartWithEntrance(secHourlyChart);
            }

            // 最新事件流 (總覽)
            const stream = document.getElementById('ov-recent-threats');
            if (stream) {
                const top = threats.slice(0, 6);
                stream.innerHTML = top.length ? top.map(t => {
                    const c = CAT_COLORS[t.category] || '#64748b';
                    return `
                <div class="flex items-center gap-2 text-[10px] border-b border-slate-800/40 pb-1.5">
                    <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${c};"></span>
                    <span class="mono text-slate-300 shrink-0">${escapeHtml(t.src_ip)}</span>
                    <span class="text-slate-500 truncate flex-grow">${escapeHtml(t.category)} · ${escapeHtml(t.src_country)}</span>
                    <span class="text-slate-600 mono shrink-0">${new Date(t.datetime).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>`;
                }).join('') : '<p class="text-xs text-slate-500 text-center py-4">尚無事件</p>';
            }
        }

        function populateCategoryFilter(threats) {
            const sel = document.getElementById('threatCategory');
            if (!sel) return;
            const cats = [...new Set(threats.map(t => t.category).filter(Boolean))];
            const cur = sel.value;
            sel.innerHTML = '<option value="">全部類別</option>' + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
            if (cats.includes(cur)) sel.value = cur;
        }

        async function fetchThreats() {
            try {
                const res = await fetch('/api/threats');
                if (!res.ok) throw new Error();
                const threats = (await res.json()).threats || [];
                allThreats = threats;
                populateCategoryFilter(threats);
                renderThreatTable();
                updateWorldMap();
                updateSecurityAnalytics(threats);

                const consoleDiv = document.getElementById('log-console');
                let hasNewThreat = false;
                [...threats].reverse().forEach(t => {
                    if (!loggedThreatIds.has(t.id)) {
                        loggedThreatIds.add(t.id);
                        hasNewThreat = true;
                        const logLine = document.createElement('p');
                        logLine.className = 'text-red-400';
                        logLine.innerText = `[${new Date(t.datetime).toISOString()}] [suricata] [ALERT] [${t.category}] Source: ${t.src_ip} (${t.src_country}) -> Target: ${t.target_ip} (${t.target_device}) | Msg: ${t.msg} | Action: ${t.action_taken}`;
                        consoleDiv.appendChild(logLine);
                    }
                });
                if (hasNewThreat) consoleDiv.scrollTop = consoleDiv.scrollHeight;

                const counts = { 'Web Exploit': 0, 'Brute Force': 0, 'Scanner': 0, 'Malware': 0, 'DoS': 0, 'Manual Block': 0 };
                threats.forEach(t => { if (counts[t.category] !== undefined) counts[t.category]++; });
                threatChart.data.datasets[0].data = Object.values(counts);
                threatChart.update();

                if (threats.length > 0) {
                    const t0 = threats[0];
                    const timeStr = new Date(t0.datetime).toLocaleString('zh-TW', { hour12: false });
                    // 資安頁置頂橫幅
                    document.getElementById('threat-source').innerText = `來源 IP: ${t0.src_ip} (${t0.src_country})`;
                    document.getElementById('threat-type').innerText = `特徵: ${t0.msg}`;
                    document.getElementById('threat-time').innerText = timeStr;
                    // 總覽簡易警報橫幅
                    const setTxt2 = (id, v) => { const e = document.getElementById(id); if (e) e.innerText = v; };
                    setTxt2('ov-latest-ip', `來源 IP: ${t0.src_ip} (${t0.src_country})`);
                    setTxt2('ov-latest-msg', `特徵: ${t0.msg}`);
                    setTxt2('ov-latest-time', timeStr);
                    if (t0.id !== lastThreatId) {
                        lastThreatId = t0.id;
                        if (Date.now() - lastIpsToastTs > 15000) {
                            lastIpsToastTs = Date.now();
                            showToast(`🔥 IPS 攔截: 來自 ${t0.src_ip} 的 ${t0.category}`, true);
                        }
                    }
                }
                fetchThreatBlocks();
            } catch (e) { console.error('Threats fetch failed', e); }
        }

        /* ==================== 自動防禦聯動 ==================== */
        async function fetchSecuritySettings() {
            try {
                const s = await (await fetch('/api/security/settings')).json();
                autoDefenseOn = !!s.autoDefense;
                const toggle = document.getElementById('auto-defense-toggle');
                if (toggle) toggle.checked = autoDefenseOn;
                const dot = document.getElementById('ov-autodef-dot');
                const txt = document.getElementById('ov-autodef-text');
                if (dot) dot.className = `w-1.5 h-1.5 rounded-full ${autoDefenseOn ? 'bg-amber-500 animate-pulse' : 'bg-slate-600'}`;
                if (txt) txt.innerText = autoDefenseOn ? '自動防禦：啟用中' : '自動防禦：關閉';
            } catch (e) { /* 靜默 */ }
        }

        async function toggleAutoDefense(on) {
            try {
                const res = await fetch('/api/security/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoDefense: on }) });
                if (!res.ok) throw new Error();
                showToast(on ? '⚡ 自動防禦聯動已啟用' : '自動防禦聯動已關閉');
                fetchSecuritySettings();
            } catch (e) {
                showToast('設定更新失敗', true);
                document.getElementById('auto-defense-toggle').checked = autoDefenseOn;
            }
        }

        /* ==================== NAS (UGREEN) ==================== */
        // 在未知巢狀結構中依鍵名尋找 (大小寫不敏感)
        function nFind(obj, keys, depth = 0) {
            if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
            const lower = keys.map(k => k.toLowerCase());
            for (const k of Object.keys(obj)) {
                if (lower.includes(k.toLowerCase())) return obj[k];
            }
            for (const k of Object.keys(obj)) {
                const r = nFind(obj[k], keys, depth + 1);
                if (r !== undefined) return r;
            }
            return undefined;
        }
        function asNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
        function fmtBps(bps) {
            if (bps == null) return '--';
            const mbps = bps * 8 / 1e6;
            return mbps >= 1 ? mbps.toFixed(1) + ' Mbps' : (bps / 1024).toFixed(0) + ' KB/s';
        }

        let nasDiskStatic = null; // disk/list 的靜態資訊 (型號/容量/通電時數/dev_name)
        function getNasVolumeAliases() {
            try { return JSON.parse(localStorage.getItem('nasVolumeAliases.v1')) || {}; } catch { return {}; }
        }
        function saveNasVolumeAlias(key, value) {
            const aliases = getNasVolumeAliases();
            const name = String(value || '').trim().slice(0, 30);
            if (name) aliases[key] = name;
            else delete aliases[key];
            localStorage.setItem('nasVolumeAliases.v1', JSON.stringify(aliases));
            showToast(name ? `已儲存名稱「${name}」` : '已清除自訂名稱');
        }

        async function fetchNas() {
            try {
                const [ovRes, diskRes, volRes, upsRes] = await Promise.all([
                    fetch('/api/nas/overview'), fetch('/api/nas/disks'), fetch('/api/nas/volumes'), fetch('/api/nas/ups')
                ]);
                const ov = await ovRes.json();
                const vols = (await volRes.json()).volumes || [];
                const ups = (await upsRes.json()).ups || {};
                // 硬碟卡：溫度/休眠狀態取自 get_all(免喚醒)；型號/容量/通電時數來自 disk/list。
                // disk/list 實測回應時間僅 0.00005 秒 (UGOS 內部記憶體快取，非即時 SMART 查詢)，
                // 不會喚醒休眠硬碟，可安全定期呼叫。真正會發 SMART 指令、有喚醒風險的是 smart/info，
                // 那支僅在你點擊「看 SMART」時才呼叫 (且有確認彈窗)。
                nasDiskStatic = (await diskRes.json()).disks || nasDiskStatic || [];
                const lite = ov.disksLite || [];
                const staticBy = {}; (nasDiskStatic || []).forEach(d => { staticBy[d.name] = d; });
                const disks = lite.map(l => ({ ...(staticBy[l.name] || {}), name: l.name, temperature: l.temperature, sleeping: l.sleeping, status: (staticBy[l.name] || {}).status || 'good' }));

                // 風扇轉速 (取自 get_all 的 overview.cpu_fan/device_fan，藏得很深)：
                // 接在「溫度狀態」文字後面小小顯示即可，不需要獨立一整張 KPI 卡
                const fans = ov.fans || [];
                const fanHero = document.getElementById('nas-hero-fan');
                const fanIcon = '<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>';
                if (fanHero) {
                    fanHero.innerHTML = fans.length
                        ? '· ' + fans.map(f => `<span class="inline-flex items-center gap-0.5 ${f.status === 'normal' ? 'text-slate-500' : 'text-red-400'}">${fanIcon}${f.rpm != null ? f.rpm.toLocaleString() : '--'} RPM</span>`).join('　')
                        : '';
                }

                // 狀態徽章與側邊欄：區分「未設定」(沒填帳密) 與「離線」(填了但連不上，例如 NAS 關機/重開中)
                const badge = document.getElementById('nas-status-badge');
                const isReal = ov.source === 'nas_api';
                const isOffline = ov.source === 'error';
                const label = isReal ? 'ONLINE' : isOffline ? '離線' : '未設定';
                const cls = isReal ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : isOffline ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20';
                badge.innerText = `NAS: ${label}`;
                badge.className = `px-3 py-1 rounded-full text-xs font-bold mono uppercase tracking-wider border ${cls}`;
                document.getElementById('side-nas-dot').className = `w-1.5 h-1.5 rounded-full ${isReal ? 'bg-emerald-500' : isOffline ? 'bg-red-500' : 'bg-amber-500'}`;
                document.getElementById('side-nas-state').innerText = isReal ? 'online' : isOffline ? '離線' : '未設定';
                setOverviewStatusDot('ov-nas-badge', isReal ? 'ok' : isOffline ? 'error' : 'warning', label);

                // 總覽雙設備體檢 — NAS 硬碟健康 + 儲存使用率
                const goodDisks = disks.filter(d => { const h = String(nFind(d, ['status', 'health', 'health_status']) || '').toLowerCase(); return h.includes('good') || h === 'normal' || h === 'ok'; }).length;
                const ovNasDisk = document.getElementById('ov-nas-disk');
                if (ovNasDisk && disks.length) { ovNasDisk.innerText = `${goodDisks}/${disks.length} 良好`; ovNasDisk.style.color = goodDisks === disks.length ? '#10b981' : '#f59e0b'; }
                let usedG = 0, totalG = 0;
                vols.forEach(v => { usedG += asNum(nFind(v, ['used_gb', 'used'])) || 0; totalG += asNum(nFind(v, ['total_gb', 'total', 'size_gb'])) || 0; });
                const ovNasStorage = document.getElementById('ov-nas-storage');
                if (ovNasStorage && totalG) { const pct = Math.round(usedG / totalG * 100); ovNasStorage.innerText = pct + '%'; ovNasStorage.style.color = pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : '#cbd5e1'; }

                // 機型資訊
                const info = ov.info || {};
                const model = nFind(info, ['model']) || 'UGREEN NAS';
                const fw = nFind(info, ['firmware_version', 'firmware', 'version']) || '';
                const cpuModel = nFind(info, ['cpu_model', 'cpu_name']) || '';
                document.getElementById('nas-model-line').innerText = `${model}${fw ? ' · ' + fw : ''}${cpuModel ? ' · ' + cpuModel : ''}`;

                // 遙測
                const stats = ov.stats || {};
                const cpuObj = nFind(stats, ['cpu']);
                const cpuUsage = typeof cpuObj === 'number' ? cpuObj : asNum(nFind(cpuObj || {}, ['usage', 'used_rate', 'usage_rate', 'percent', 'used_percent']));
                const cpuTemp = asNum(nFind(cpuObj || {}, ['temperature', 'temp']));
                document.getElementById('nas-cpu').innerText = cpuUsage != null ? Math.round(cpuUsage) : '--';
                document.getElementById('nas-cpu-temp').innerText = cpuTemp != null ? cpuTemp + '°C' : '--°C';
                document.getElementById('nas-cpu-bar').style.width = (cpuUsage || 0) + '%';
                // NAS 處理器熱區卡 (仿 UCG 風格)
                const nasHeroTempEl = document.getElementById('nas-hero-temp');
                if (nasHeroTempEl) {
                    nasHeroTempEl.textContent = cpuTemp != null ? cpuTemp : '--';
                    nasHeroTempEl.className = `text-5xl font-black tracking-tight mono ${tempColor(cpuTemp) === '#ef4444' ? 'text-red-500' : 'text-emerald-500'}`;
                    document.getElementById('nas-hero-usage').textContent = (cpuUsage != null ? Math.round(cpuUsage) : '--') + '%';
                    document.getElementById('nas-hero-temp-status').textContent = tempLabel(cpuTemp);
                    document.getElementById('nas-hero-dot').style.background = tempColor(cpuTemp);
                    if (cpuTemp != null && cpuUsage != null) {
                        if (nasHeroTempData.length >= 12) { nasHeroTempData.shift(); nasHeroUsageData.shift(); nasHeroLabels.shift(); }
                        nasHeroTempData.push(cpuTemp);
                        nasHeroUsageData.push(cpuUsage);
                        nasHeroLabels.push(new Date().toLocaleTimeString());
                        updateChartWithEntrance(nasHeroChart);
                    }
                }
                // 總覽雙設備體檢 — NAS 溫度/CPU + KPI
                const ovNasTemp = document.getElementById('ov-nas-temp');
                if (ovNasTemp) { ovNasTemp.innerText = cpuTemp != null ? cpuTemp : '--'; ovNasTemp.style.color = tempColor(cpuTemp); }
                const ovNasTempStatus = document.getElementById('ov-nas-temp-status');
                if (ovNasTempStatus) { ovNasTempStatus.innerText = tempLabel(cpuTemp); ovNasTempStatus.style.color = tempColor(cpuTemp); }
                const kpiNasTemp = document.getElementById('kpi-nas-temp'); if (kpiNasTemp) kpiNasTemp.innerText = cpuTemp != null ? cpuTemp : '--';
                const ovNasCpu = document.getElementById('ov-nas-cpu'); if (ovNasCpu) ovNasCpu.innerText = (cpuUsage != null ? Math.round(cpuUsage) : '--') + '%';
                const ovNasCpuBar = document.getElementById('ov-nas-cpu-bar'); if (ovNasCpuBar) ovNasCpuBar.style.width = (cpuUsage || 0) + '%';

                const memObj = nFind(stats, ['memory', 'mem', 'ram']) || {};
                let memPct = asNum(nFind(memObj, ['usage', 'used_rate', 'usage_rate', 'percent', 'used_percent']));
                const memTotal = asNum(nFind(memObj, ['total_mb', 'total']));
                const memUsed = asNum(nFind(memObj, ['used_mb', 'used']));
                if (memPct == null && memTotal && memUsed) memPct = Math.round(memUsed / memTotal * 100);
                document.getElementById('nas-mem').innerText = memPct != null ? Math.round(memPct) : '--';
                document.getElementById('nas-mem-bar').style.width = (memPct || 0) + '%';
                const ovNasMem = document.getElementById('ov-nas-mem'); if (ovNasMem) ovNasMem.innerText = (memPct != null ? Math.round(memPct) : '--') + '%';
                const ovNasMemBar = document.getElementById('ov-nas-mem-bar'); if (ovNasMemBar) ovNasMemBar.style.width = (memPct || 0) + '%';
                if (memTotal && memUsed) {
                    const toG = v => v > 131072 ? (v / 1073741824).toFixed(1) : (v / 1024).toFixed(1); // bytes 或 MB 自動判斷
                    document.getElementById('nas-mem-str').innerText = `${toG(memUsed)} GB / ${toG(memTotal)} GB`;
                    const heroMemStr = document.getElementById('nas-hero-mem-str');
                    if (heroMemStr) heroMemStr.textContent = `${toG(memUsed)} GB / ${toG(memTotal)} GB`;
                }

                const netObj = nFind(stats, ['network', 'net']) || {};
                const up = asNum(nFind(netObj, ['upload_bps', 'up_speed', 'send_speed', 'upload_speed', 'tx_speed']));
                const down = asNum(nFind(netObj, ['download_bps', 'down_speed', 'recv_speed', 'download_speed', 'rx_speed']));
                document.getElementById('nas-net-up').innerText = fmtBps(up);
                document.getElementById('nas-net-down').innerText = fmtBps(down);
                if (document.getElementById('nas-hero-mem-str')) {
                    document.getElementById('nas-hero-mem-bar').style.width = (memPct || 0) + '%';
                    document.getElementById('nas-hero-net-down').textContent = fmtBps(down);
                    document.getElementById('nas-hero-net-up').textContent = fmtBps(up);
                }

                // UPS
                const upsPresent = nFind(ups, ['present', 'exist', 'connected']);
                const battery = asNum(nFind(ups, ['battery_percent', 'battery', 'charge', 'battery_level']));
                const runtime = asNum(nFind(ups, ['runtime_min', 'runtime', 'battery_runtime']));
                const upsModel = nFind(ups, ['model', 'name']) || '';
                document.getElementById('nas-ups-batt').innerText = battery != null ? Math.round(battery) : '--';
                document.getElementById('nas-ups-info').innerText = upsPresent === false ? '未偵測到 UPS'
                    : `${upsModel}${runtime != null ? ' · 可撐 ' + Math.round(runtime) + ' 分鐘' : ''}`;
                const nasHeroUpsEl = document.getElementById('nas-hero-ups');
                if (nasHeroUpsEl) nasHeroUpsEl.textContent = battery != null ? Math.round(battery) + '%' : '--';

                // 硬碟
                const diskList = document.getElementById('nas-disk-list');
                diskList.innerHTML = disks.length ? '' : '<p class="text-xs text-slate-500 text-center py-4">無硬碟資料</p>';
                // 建立「硬碟名稱 → 型號/容量」對照，供溫度歷史圖的圖例使用 (讓 硬碟1/2/3 能分辨是哪顆)
                nasDiskMeta = {};
                disks.forEach(d => {
                    const nm = nFind(d, ['name', 'label']);
                    const md = nFind(d, ['model']) || '';
                    const sg = asNum(nFind(d, ['size_gb']));
                    const szStr = sg ? (sg >= 1000 ? (sg / 1000).toFixed(0) + 'TB' : sg + 'GB') : '';
                    // 品牌辨識：ST 開頭視為 Seagate、WD 視為 WD，其餘取關鍵字，讓標籤簡潔又能分辨
                    let brand = (md.match(/seagate|samsung|kioxia|western digital|wd|toshiba|crucial|micron|intel|sandisk/i) || [])[0] || '';
                    if (!brand && /^st\d/i.test(md)) brand = 'Seagate';
                    if (!brand && /^wd/i.test(md)) brand = 'WD';
                    if (!brand) brand = md.split(/[\s-]/)[0];
                    brand = brand.replace(/western digital/i, 'WD');
                    if (nm) nasDiskMeta[nm] = [szStr, brand].filter(Boolean).join(' ');
                });
                disks.forEach((d, index) => {
                    const name = nFind(d, ['name', 'label']) || 'Disk';
                    const dModel = nFind(d, ['model']) || '';
                    const dev = nFind(d, ['dev_name']) || '';
                    const temp = asNum(nFind(d, ['temperature', 'temp']));
                    const health = nFind(d, ['status', 'health', 'health_status']) || 'Unknown';
                    const good = String(health).toLowerCase().includes('good') || String(health).toLowerCase() === 'normal';
                    const sizeGb = asNum(nFind(d, ['size_gb']));
                    const sizeStr = sizeGb ? (sizeGb >= 1000 ? (sizeGb / 1000).toFixed(1) + ' TB' : sizeGb + ' GB') : '';
                    const poh = asNum(nFind(d, ['power_on_hours']));
                    const isSsd = /ssd|nvme|m\.2/i.test(dModel + ' ' + name);
                    const sleeping = d.sleeping === true;
                    const tColor = temp == null ? '#64748b' : temp >= 55 ? '#ef4444' : temp >= 48 ? '#f59e0b' : '#10b981';
                    // 休眠/運轉徽章
                    const stateBadge = sleeping
                        ? '<span class="px-1.5 py-0.5 rounded text-[8px] border font-bold bg-slate-700/40 text-slate-400 border-slate-600/40">💤 休眠中</span>'
                        : '<span class="px-1.5 py-0.5 rounded text-[8px] border font-bold bg-blue-500/10 text-blue-400 border-blue-500/20">● 運轉中</span>';
                    // 線條 SVG 硬碟圖示 (SSD/HDD 兩款)
                    const icon = isSsd
                        ? '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="12" rx="2"/><line x1="7" y1="10" x2="7" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/><circle cx="16.5" cy="12" r="1.3" fill="currentColor" stroke="none"/></svg>'
                        : '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/><line x1="17.5" y1="6.5" x2="13.7" y2="10.3"/></svg>';
                    diskList.innerHTML += `
                    <button type="button" data-disk-index="${index}" class="w-full text-left flex items-center justify-between p-3 bg-slate-900/40 rounded-xl border border-slate-800/50 hover:border-blue-500/40 hover:bg-slate-900/70 transition group">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${good ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}">${icon}</div>
                            <div class="min-w-0">
                                <p class="text-xs font-bold text-slate-200 truncate">${escapeHtml(name)} <span class="text-slate-600 font-normal">${sizeStr}</span></p>
                                <p class="text-[9px] text-slate-500 mono truncate">${escapeHtml(dModel)}${poh != null ? ' · 通電 ' + poh.toLocaleString() + ' 小時' : ''}</p>
                                <div class="mt-1">${stateBadge}</div>
                            </div>
                        </div>
                        <div class="text-right shrink-0 ml-2">
                            <span class="px-2 py-0.5 rounded text-[9px] border font-bold uppercase ${good ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}">${good ? '健康' : escapeHtml(health)}</span>
                            <p class="text-[10px] mono mt-0.5" style="color:${tColor}">${sleeping ? '<span class="text-slate-500">休眠</span>' : (temp != null ? temp + '°C' : '')}</p>
                            <p class="text-[8px] text-slate-600 group-hover:text-blue-400 transition mt-0.5">點擊看 SMART ›</p>
                        </div>
                    </button>`;
                });
                diskList._smarthubDisks = disks;
                if (!diskList.dataset.diskActionBound) {
                    diskList.dataset.diskActionBound = 'true';
                    diskList.addEventListener('click', event => {
                        const button = event.target.closest('[data-disk-index]');
                        const disk = button ? diskList._smarthubDisks?.[Number(button.dataset.diskIndex)] : null;
                        if (!disk) return;
                        confirmDiskSmart(
                            nFind(disk, ['dev_name']) || '',
                            nFind(disk, ['name', 'label']) || 'Disk',
                            disk.sleeping === true
                        );
                    });
                }

                // 儲存區
                const volList = document.getElementById('nas-volume-list');
                const editingVolumeAlias = volList.contains(document.activeElement) && document.activeElement.matches('[data-volume-alias-key]');
                if (!editingVolumeAlias) {
                    volList.innerHTML = vols.length ? '' : '<p class="text-xs text-slate-500 text-center py-4">無儲存區資料</p>';
                    const volumeAliases = getNasVolumeAliases();
                    vols.forEach(v => {
                    const name = nFind(v, ['name', 'label']) || 'Volume';
                    const volumeKey = String(name);
                    const customName = volumeAliases[volumeKey] || '';
                    const raid = nFind(v, ['raid', 'raid_type', 'level']) || '';
                    const fsType = nFind(v, ['fs', 'fs_type', 'filesystem']) || '';
                    let total = asNum(nFind(v, ['total_gb', 'total', 'size', 'total_size']));
                    let used = asNum(nFind(v, ['used_gb', 'used', 'used_size']));
                    // bytes → GB 自動判斷
                    if (total > 1e7) { total = total / 1073741824; used = used != null ? used / 1073741824 : null; }
                    const pct = total && used != null ? Math.round(used / total * 100) : 0;
                    volList.innerHTML += `
                    <div>
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-[11px] mb-1.5">
                            <span class="font-bold text-slate-200 flex items-center gap-2 min-w-0">${escapeHtml(name)}
                                <input type="text" maxlength="30" data-volume-alias-key="${escapeHtml(volumeKey)}" value="${escapeHtml(customName)}" placeholder="自訂名稱"
                                    class="w-28 px-2 py-1 rounded-md bg-slate-900/80 border border-slate-700/70 text-[9px] font-normal text-blue-300 placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
                                    aria-label="${escapeHtml(name)} 自訂名稱">
                                <span class="text-[9px] text-slate-500 mono">${escapeHtml(raid)} ${escapeHtml(fsType)}</span>
                            </span>
                            <span class="mono text-slate-400">${used != null ? used.toFixed(0) : '--'} GB / ${total ? total.toFixed(0) : '--'} GB (${pct}%)</span>
                        </div>
                        <div class="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800 p-0.5">
                            <div class="${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'} h-full rounded-full transition-all duration-700" style="width: ${pct}%;"></div>
                        </div>
                    </div>`;
                    });
                    if (!volList.dataset.aliasActionBound) {
                        volList.dataset.aliasActionBound = 'true';
                        volList.addEventListener('change', event => {
                            const input = event.target.closest('[data-volume-alias-key]');
                            if (input) saveNasVolumeAlias(input.dataset.volumeAliasKey, input.value);
                        });
                        volList.addEventListener('keydown', event => {
                            if (event.key === 'Enter' && event.target.matches('[data-volume-alias-key]')) event.target.blur();
                        });
                    }
                }

                // 原始資料
                document.getElementById('nas-raw').innerText = JSON.stringify({ overview: ov, disks, volumes: vols, ups }, null, 2);
            } catch (e) {
                document.getElementById('side-nas-dot').className = 'w-1.5 h-1.5 rounded-full bg-red-500';
                document.getElementById('side-nas-state').innerText = 'error';
                setOverviewStatusDot('ov-nas-badge', 'error', '連線失敗');
                console.error('NAS fetch failed', e);
            }
        }

        /* ==================== NAS 進階 (系統 B) ==================== */
        function initNasCharts() {
            const lineOpts = (extra = {}) => ({
                responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 9 } } } },
                scales: Object.assign({
                    x: { ticks: { color: '#64748b', font: { size: 8 }, maxTicksLimit: 8 }, grid: { display: false } },
                    y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 8 } }, grid: { color: 'rgba(30,41,59,0.4)' } }
                }, extra)
            });
            nasSystemChart = new Chart(document.getElementById('nasSystemChart'), {
                type: 'line', data: {
                    labels: [], datasets: [
                        { label: 'CPU %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.06)', fill: true, tension: 0.3, pointRadius: 0 },
                        { label: '記憶體 %', data: [], borderColor: '#8b5cf6', fill: false, tension: 0.3, pointRadius: 0 },
                        { label: '溫度 °C', data: [], borderColor: '#f59e0b', borderDash: [4, 3], fill: false, tension: 0.3, pointRadius: 0 },
                        { label: '風扇 RPM', data: [], borderColor: '#94a3b8', borderDash: [2, 2], fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'yFan', spanGaps: true }
                    ]
                }, options: lineOpts({ yFan: { position: 'right', ticks: { color: '#94a3b8', font: { size: 8 }, callback: v => v + ' RPM' }, grid: { display: false } } })
            });
            nasTrafficChart = new Chart(document.getElementById('nasTrafficChart'), {
                type: 'line', data: {
                    labels: [], datasets: [
                        { label: '下載', data: [], borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.06)', fill: true, tension: 0.3, pointRadius: 0 },
                        { label: '上傳', data: [], borderColor: '#3b82f6', fill: false, tension: 0.3, pointRadius: 0 }
                    ]
                }, options: lineOpts({ y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 8 }, callback: v => compactNumber(v) + ' Mbps' }, grid: { color: 'rgba(30,41,59,0.4)' } } })
            });
            nasStorageChart = new Chart(document.getElementById('nasStorageChart'), {
                type: 'line', data: {
                    labels: [], datasets: [
                        { label: '已用 GB', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', fill: true, tension: 0.2, pointRadius: 0 }
                    ]
                }, options: lineOpts({ y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 8 }, callback: v => compactNumber(v) + ' GB' }, grid: { color: 'rgba(30,41,59,0.4)' } } })
            });
            nasTempChart = new Chart(document.getElementById('nasTempChart'), {
                type: 'line', data: { labels: [], datasets: [] }, options: {
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 8 } } } },
                    scales: {
                        x: { ticks: { color: '#64748b', font: { size: 8 }, maxTicksLimit: 8 }, grid: { display: false } },
                        y: { ticks: { color: '#f59e0b', font: { size: 8 }, callback: v => v + '°C' }, grid: { color: 'rgba(30,41,59,0.4)' } }
                    }
                }
            });
        }
        const NAS_DISK_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#eab308'];
        const hiddenTempDisks = new Set();

        async function fetchNasAdvanced() {
            try {
                const [dt, ts, sf] = await Promise.all([
                    fetch('/api/nas/downtime').then(r => r.json()),
                    fetch('/api/nas/traffic-summary').then(r => r.json()),
                    fetch('/api/nas/storage-forecast').then(r => r.json())
                ]);
                const d = dt.data || {}, t = ts.data || {}, f = sf.data || {};
                const setT = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
                setT('nas-uptime-pct', `${d.uptime_percent ?? '--'}<span class="text-sm text-slate-500">%</span>`);
                setT('nas-uptime-sub', `近30天離線 ${d.downtime_events ?? 0} 次 / ${d.total_downtime_min ?? 0} 分鐘`);
                setT('nas-traffic-today', `${t.today_gb ?? '--'}<span class="text-sm text-slate-500"> GB</span>`);
                setT('nas-traffic-sub', `↓ ${t.today_down_gb ?? '--'} / ↑ ${t.today_up_gb ?? '--'} GB`);
                setT('nas-traffic-week', t.week_gb ?? '--');
                setT('nas-traffic-month', t.month_gb ?? '--');
                setT('nas-forecast-days', `${f.days_until_full ?? '--'}<span class="text-sm text-slate-500"> 天</span>`);
                setT('nas-forecast-sub', `日均成長 ${f.daily_growth_gb ?? '--'} GB · 已用 ${f.current_used_percent ?? '--'}%`);
                setT('nas-forecast-date', f.projected_full_date ?? '--');
            } catch (e) { console.error('NAS advanced fetch failed', e); }
        }

        let nasHistWinMin = 1440; // 系統/流量/溫度三張圖共用的範圍 (分鐘)；儲存趨勢圖固定看 30 天
        function setNasHistWin(minutes, btn) {
            nasHistWinMin = minutes;
            document.querySelectorAll('.nas-hist-win-btn').forEach(b => b.className = 'nas-hist-win-btn px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition active:scale-95 text-[10px]');
            if (btn) btn.className = 'nas-hist-win-btn px-2.5 py-1 bg-blue-600/20 border border-blue-500/30 text-blue-400 rounded-lg transition font-bold active:scale-95 text-[10px]';
            requestChartReplay(nasSystemChart, nasTrafficChart, nasStorageChart, nasTempChart);
            fetchNasCharts();
        }
        async function fetchNasCharts() {
            const fmtH = arr => arr.map(p => new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: nasHistWinMin <= 30 ? '2-digit' : undefined }));
            const fmtD = arr => arr.map(p => new Date(p.t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }));
            const hrs = nasHistWinMin / 60;
            const rangeLbl = document.getElementById('nas-hist-rangelbl');
            if (rangeLbl) rangeLbl.textContent = nasHistWinMin >= 60 ? `近 ${nasHistWinMin / 60} 小時` : `近 ${nasHistWinMin} 分`;
            try {
                const rawSys = (await (await fetch(`/api/nas/system-history?hours=${hrs}`)).json()).data || [];
                seedHeroChart(nasHeroChart, nasHeroLabels, [nasHeroTempData, nasHeroUsageData], rawSys, [
                    point => point.temperature, point => point.cpu
                ]);
                const sys = downsampleRows(rawSys, ['cpu', 'memory', 'temperature', 'fan_rpm']);
                nasSystemChart.data.labels = fmtH(sys);
                nasSystemChart.data.datasets[0].data = sys.map(p => p.cpu);
                nasSystemChart.data.datasets[1].data = sys.map(p => p.memory);
                nasSystemChart.data.datasets[2].data = sys.map(p => p.temperature);
                nasSystemChart.data.datasets[3].data = sys.map(p => p.fan_rpm);
                updateChartWithEntrance(nasSystemChart);
                document.getElementById('nas-sys-cnt') && (document.getElementById('nas-sys-cnt').textContent = rawSys.length > sys.length ? `${rawSys.length} 點 · 繪製 ${sys.length}` : `${sys.length} 點`);

                const rawTraffic = (await (await fetch(`/api/nas/traffic-history?hours=${hrs}`)).json()).data || [];
                const tr = downsampleRows(rawTraffic, ['download_mbps', 'upload_mbps']);
                nasTrafficChart.data.labels = fmtH(tr);
                nasTrafficChart.data.datasets[0].data = tr.map(p => p.download_mbps);
                nasTrafficChart.data.datasets[1].data = tr.map(p => p.upload_mbps);
                updateChartWithEntrance(nasTrafficChart);

                const rawStorage = (await (await fetch('/api/nas/storage-history?hours=720')).json()).data || [];
                const st = downsampleRows(rawStorage, ['used_gb']);
                nasStorageChart.data.labels = fmtD(st);
                nasStorageChart.data.datasets[0].data = st.map(p => p.used_gb);
                updateChartWithEntrance(nasStorageChart);

                const tpRes = await (await fetch(`/api/nas/temperature-history?hours=${hrs}`)).json();
                const rawTemps = (tpRes.data || []).slice().sort((a, b) => new Date(a.t) - new Date(b.t));
                const diskNames = tpRes.diskNames || [];
                // Chart.js 在替換 datasets 時會忘記 legend toggle 的狀態；以硬碟名稱保存，下一輪輪詢也不會復活。
                nasTempChart.data.datasets.forEach((dataset, index) => {
                    if (!dataset.$diskName) return;
                    if (nasTempChart.isDatasetVisible(index)) hiddenTempDisks.delete(dataset.$diskName);
                    else hiddenTempDisks.add(dataset.$diskName);
                });
                const tempKeys = diskNames.map((_, index) => `__disk${index}`);
                const tempRows = rawTemps.map(point => ({ ...point, ...Object.fromEntries(diskNames.map((name, index) => [tempKeys[index], (point.disks || {})[name] ?? null])) }));
                const tp = downsampleRows(tempRows, tempKeys);
                nasTempChart.data.labels = fmtH(tp);
                nasTempChart.data.datasets = diskNames.map((name, i) => ({
                    $diskName: name,
                    label: nasDiskMeta[name] ? `${name} (${nasDiskMeta[name]})` : name,
                    data: tp.map(p => (p.disks || {})[name] ?? null),
                    borderColor: NAS_DISK_COLORS[i % NAS_DISK_COLORS.length], fill: false, tension: 0.3, pointRadius: 0, spanGaps: false,
                    hidden: hiddenTempDisks.has(name)
                }));
                nasTempChart.data.datasets.forEach((dataset, index) => {
                    nasTempChart.setDatasetVisibility(index, !hiddenTempDisks.has(dataset.$diskName));
                });
                updateChartWithEntrance(nasTempChart);

                // 尚未累積足夠歷史時提示（自建取樣器需要時間累積）
                const note = document.getElementById('nas-charts-note');
                if (note) note.classList.toggle('hidden', rawTemps.length >= 2);
            } catch (e) { console.error('NAS charts fetch failed', e); }
        }

        async function fetchNasDocker() {
            try {
                const response = await fetch('/api/nas/docker');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const payload = await response.json();
                const containers = payload.containers || [];
                const running = containers.filter(c => c.state === 'running').length;
                document.getElementById('nas-docker-running').innerText = running;
                const total = Number.isInteger(payload.total) ? payload.total : containers.length;
                document.getElementById('nas-docker-sub').innerText = payload.truncated
                    ? `顯示 ${containers.length}/${total} 個容器（已達安全上限）`
                    : `共 ${total} 個容器`;
                document.getElementById('nas-docker-count').innerText = `— ${running}/${containers.length} 運行中`;
                const tbody = document.getElementById('nas-docker-list');
                const emptyMessage = payload.source === 'not_configured'
                    ? '尚未設定 Docker Monitor；請依 docs/operations/NAS-DOCKER-MONITOR-SETUP.md 部署'
                    : '目前沒有容器';
                tbody.innerHTML = containers.length ? containers.map((c, index) => {
                    const on = c.state === 'running';
                    const cpuPct = Number.isFinite(Number(c.cpu_percent)) ? Number(c.cpu_percent) : 0;
                    const memUsage = Number.isFinite(Number(c.mem_usage_mb)) ? Number(c.mem_usage_mb) : 0;
                    const memLimit = Number.isFinite(Number(c.mem_limit_mb)) ? Number(c.mem_limit_mb) : 0;
                    const memPct = memLimit > 0 ? Math.round(memUsage / memLimit * 100) : 0;
                    const pids = Number(c.pids || 0);
                    const health = c.health || (/\(([^)]+)\)/.exec(c.status || '')?.[1] || '');
                    const fmtDate = value => {
                        const date = value ? new Date(value) : null;
                        return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-TW', { hour12: false }) : '--';
                    };
                    const networks = (c.networks || []).map(n => `${n.name}${n.ip_address ? ` ${n.ip_address}` : ''}`).join(' · ') || '--';
                    const ports = (c.ports || []).map(p => p.host ? `${p.host} → ${p.container}` : p.container).join(' · ') || '無公開連接埠';
                    const mounts = (c.mounts || []).map(m => `${m.destination}${m.read_write ? '' : ' (唯讀)'}`).join(' · ') || '無掛載';
                    const allowedActions = new Set(Array.isArray(c.allowed_actions) ? c.allowed_actions : []);
                    const actionButtons = [];
                    if (on && allowedActions.has('restart')) actionButtons.push('<button type="button" data-docker-index="' + index + '" data-docker-action="restart" class="px-2 py-1 bg-blue-600/80 hover:bg-blue-600 text-white text-[9px] font-bold rounded">重啟</button>');
                    if (on && allowedActions.has('stop')) actionButtons.push('<button type="button" data-docker-index="' + index + '" data-docker-action="stop" class="px-2 py-1 bg-red-600/80 hover:bg-red-600 text-white text-[9px] font-bold rounded ml-1">停止</button>');
                    if (!on && allowedActions.has('start')) actionButtons.push('<button type="button" data-docker-index="' + index + '" data-docker-action="start" class="px-2 py-1 bg-emerald-600/80 hover:bg-emerald-600 text-white text-[9px] font-bold rounded">啟動</button>');
                    return `
                    <tr class="hover:bg-slate-900/30">
                        <td class="py-2.5 pr-3"><p class="font-bold text-slate-200">${escapeHtml(c.name)}</p><p class="text-[9px] text-slate-500 mono truncate max-w-[220px]">${escapeHtml(c.image)}</p><p class="text-[8px] text-slate-700 mono">ID ${escapeHtml(String(c.id || '').slice(0, 12))}${c.compose_service ? ` · ${escapeHtml(c.compose_service)}` : ''}</p></td>
                        <td class="py-2.5 pr-3"><span class="px-2 py-0.5 rounded text-[9px] border font-bold ${on ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-700/30 text-slate-500 border-slate-700/40'}">${on ? '運行中' : '已停止'}</span>${health ? `<span class="ml-1 text-[8px] ${health === 'healthy' ? 'text-emerald-400' : health === 'unhealthy' ? 'text-red-400' : 'text-slate-500'}">${escapeHtml(health)}</span>` : ''}<p class="text-[8px] text-slate-600 mt-0.5">重啟 ${Number(c.restart_count || 0)} 次 · ${c.oom_killed ? '<span class="text-red-400">OOM</span>' : '無 OOM'}</p></td>
                        <td class="py-2.5 pr-3 mono text-[10px] text-slate-300">${on ? `${cpuPct}%<p class="text-[8px] text-slate-600 mt-0.5">${pids} PID</p>` : '-'}</td>
                        <td class="py-2.5 pr-3 mono text-[10px] text-slate-300">${on ? `${memUsage} / ${memLimit} MB <span class="text-slate-600">(${memPct}%)</span>` : '-'} </td>
                        <td class="py-2.5 pr-3 mono text-[9px] text-slate-400"><p>↓ ${diagBytes(c.network_rx_bytes)} · ↑ ${diagBytes(c.network_tx_bytes)}</p><p class="text-slate-600 mt-0.5">讀 ${diagBytes(c.block_read_bytes)} · 寫 ${diagBytes(c.block_write_bytes)}</p></td>
                        <td class="py-2.5 text-right whitespace-nowrap">
                            ${actionButtons.join('')}
                            ${c.logs_allowed === true ? `<button type="button" data-docker-index="${index}" data-docker-action="logs" class="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-[9px] font-bold rounded ml-1">日誌</button>` : ''}
                        </td>
                    </tr>
                    <tr class="text-[8px] text-slate-600 bg-slate-950/20">
                        <td colspan="6" class="pb-2.5 pt-1 px-2">
                            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-5 gap-y-1">
                                <span>建立：<span class="mono text-slate-500">${escapeHtml(fmtDate(c.created_at))}</span></span>
                                <span>啟動：<span class="mono text-slate-500">${escapeHtml(fmtDate(c.started_at))}</span></span>
                                <span>重啟策略：<span class="mono text-slate-500">${escapeHtml(c.restart_policy || 'no')}</span></span>
                                <span class="truncate" title="${escapeHtml(networks)}">網路：<span class="mono text-slate-500">${escapeHtml(networks)}</span></span>
                                <span class="truncate" title="${escapeHtml(ports)}">連接埠：<span class="mono text-slate-500">${escapeHtml(ports)}</span></span>
                                <span class="truncate" title="${escapeHtml(mounts)}">掛載：<span class="mono text-slate-500">${escapeHtml(mounts)}</span></span>
                            </div>
                        </td>
                    </tr>`;
                }).join('') : `<tr><td colspan="6" class="text-center py-4 text-slate-500">${emptyMessage}</td></tr>`;
                tbody._smarthubContainers = containers;
                if (!tbody.dataset.dockerActionBound) {
                    tbody.dataset.dockerActionBound = 'true';
                    tbody.addEventListener('click', event => {
                        const button = event.target.closest('[data-docker-index]');
                        const c = button ? tbody._smarthubContainers?.[Number(button.dataset.dockerIndex)] : null;
                        if (!c) return;
                        if (button.dataset.dockerAction === 'logs') showDockerLog(c.id, c.name);
                        else dockerAction(c.id, button.dataset.dockerAction);
                    });
                }
            } catch (e) { console.error('NAS docker fetch failed', e); }
        }

        async function dockerAction(id, action) {
            const labels = { start: '啟動', stop: '停止', restart: '重啟' };
            try {
                const res = await fetch(`/api/nas/docker/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (res.status === 504 && data.error === 'action_result_unknown' && data.ambiguous === true) {
                        showToast('操作結果不明；已重新整理狀態，請勿直接重試', true);
                        setTimeout(fetchNasDocker, 200);
                        return;
                    }
                    throw new Error();
                }
                showToast(`已對容器下達${labels[action]}指令`);
                setTimeout(fetchNasDocker, 800);
            } catch (e) { showToast('容器操作失敗', true); }
        }

        async function showDockerLog(id, name) {
            document.getElementById('docker-log-title').innerText = `容器日誌 — ${name}`;
            document.getElementById('docker-log-body').innerText = '載入中...';
            document.getElementById('docker-log-modal').classList.remove('hidden');
            document.getElementById('docker-log-modal').classList.add('flex');
            setDialogState('docker-log-modal', true);
            try {
                const data = await (await fetch(`/api/nas/docker/${encodeURIComponent(id)}/logs?lines=1000`)).json();
                document.getElementById('docker-log-body').innerText = data.logs || '(無日誌)';
            } catch (e) { document.getElementById('docker-log-body').innerText = '日誌讀取失敗'; }
        }
        async function copyDockerLog() {
            const text = document.getElementById('docker-log-body')?.innerText || '';
            if (!text || text === '載入中...') return showToast('日誌尚未載入', true);
            try {
                await navigator.clipboard.writeText(text);
                showToast(`已複製全部 ${text.split('\n').length} 行日誌`);
            } catch {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed'; textarea.style.opacity = '0';
                document.body.appendChild(textarea); textarea.select();
                const copied = document.execCommand('copy'); textarea.remove();
                showToast(copied ? '已複製全部日誌' : '複製失敗', !copied);
            }
        }
        function closeDockerLog() {
            document.getElementById('docker-log-modal').classList.add('hidden');
            document.getElementById('docker-log-modal').classList.remove('flex');
            setDialogState('docker-log-modal', false);
        }

        const NAS_LOG_MODULE_LABEL = { login: '登入', storage_manager: '儲存管理', snapshot: '快照', system: '系統', network: '網路', file_manager: '檔案管理', app_center: '應用中心', usb: 'USB', backup: '備份' };
        async function fetchNasAlerts({ generation = navigationGeneration } = {}) {
            const list = document.getElementById('nas-alert-list');
            const colorMap = { critical: 'text-red-400 border-red-500/30 bg-red-500/5', error: 'text-red-400 border-red-500/30 bg-red-500/5', warning: 'text-amber-400 border-amber-500/30 bg-amber-500/5', info: 'text-slate-400 border-slate-700/40 bg-slate-900/30' };
            const active = () => generation === navigationGeneration && currentPage === 'nas' && document.visibilityState === 'visible';
            try {
                // 優先：選配的 NAS Monitor 警報 (可確認/清除)
                const events = (await (await fetch('/api/nas/alerts')).json()).events || [];
                if (!active()) return;
                if (events.length) {
                    const unack = events.filter(e => !e.acknowledged).length;
                    document.getElementById('nas-alert-count').innerText = `— ${unack} 則待確認 / 共 ${events.length} 則`;
                    list.innerHTML = events.map((a, index) => {
                        const cls = colorMap[a.level] || colorMap.info;
                        return `
                        <div class="flex items-center gap-3 p-3 rounded-lg border ${cls} ${a.acknowledged ? 'opacity-50' : ''}">
                            <span class="text-[9px] font-black uppercase tracking-wider shrink-0 w-16">${escapeHtml(a.level)}</span>
                            <div class="flex-grow min-w-0">
                                <p class="text-[11px] text-slate-200 truncate">${escapeHtml(a.message)}</p>
                                <p class="text-[9px] text-slate-500 mono">${escapeHtml(a.metric)} · ${escapeHtml(new Date(a.datetime).toLocaleString('zh-TW'))}</p>
                            </div>
                            ${a.acknowledged ? '<span class="text-[9px] text-slate-500 shrink-0">已確認</span>' : `<button type="button" data-alert-index="${index}" class="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-[9px] font-bold rounded shrink-0">確認</button>`}
                        </div>`;
                    }).join('');
                    list._smarthubAlerts = events;
                    if (!list.dataset.alertActionBound) {
                        list.dataset.alertActionBound = 'true';
                        list.addEventListener('click', event => {
                            const button = event.target.closest('[data-alert-index]');
                            const alert = button ? list._smarthubAlerts?.[Number(button.dataset.alertIndex)] : null;
                            if (alert) ackAlert(alert.id);
                        });
                    }
                    return;
                }
                // 回退：UGOS 內建日誌中心 (真實系統事件)
                const hideSelf = document.getElementById('nas-log-hideself')?.checked !== false;
                const r = await (await fetch('/api/nas/logs?size=120' + (hideSelf ? '&hideSelf=1' : ''))).json();
                if (!active()) return;
                const logsAll = r.logs || [];
                // 級別統計晶片 (依近期日誌計數，點擊篩選)
                const counts = { all: logsAll.length };
                logsAll.forEach(l => counts[l.level] = (counts[l.level] || 0) + 1);
                const LVL_META = [
                    ['all', '全部', 'bg-blue-600 text-white', 'text-slate-400'],
                    ['info', 'INFO', 'bg-slate-600 text-white', 'text-slate-500'],
                    ['warning', '⚠ 警告', 'bg-amber-600 text-white', 'text-amber-500'],
                    ['error', '❌ 錯誤', 'bg-red-600 text-white', 'text-red-400'],
                    ['critical', '🚨 嚴重', 'bg-red-700 text-white', 'text-red-400']
                ];
                const tabsEl = document.getElementById('nas-log-level-tabs');
                if (tabsEl) tabsEl.innerHTML = LVL_META.map(([k, label, onCls, offCls]) =>
                    `<button data-action="nas-log-filter" data-filter="${escapeActionData(k)}" class="px-2 py-0.5 rounded font-bold transition ${nasLogFilter === k ? onCls : offCls + ' hover:text-slate-200'}">${label} ${counts[k] || 0}</button>`).join('');
                let logs = nasLogFilter === 'all' ? logsAll : logsAll.filter(l => l.level === nasLogFilter);
                const sev = logsAll.filter(l => l.level !== 'info').length;
                document.getElementById('nas-alert-count').innerText = r.total ? `— 共 ${r.total.toLocaleString()} 筆${sev ? `，⚠ 近期 ${sev} 筆需注意` : '，近期全部正常'}` : '';
                list.innerHTML = logs.length ? '' : '<p class="text-xs text-slate-500 text-center py-4">此篩選下無日誌</p>';
                const icon = { critical: '🚨', error: '❌', warning: '⚠️' };
                logs.forEach(l => {
                    const cls = colorMap[l.level] || colorMap.info;
                    const severe = l.level !== 'info';
                    const mod = NAS_LOG_MODULE_LABEL[l.module] || l.module;
                    list.innerHTML += `
                    <div class="nas-event-row grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 p-2.5 rounded-lg border ${cls}">
                        <span class="text-[9px] font-black uppercase tracking-wider whitespace-nowrap ${severe ? '' : 'opacity-60'}">${icon[l.level] || ''}${escapeHtml(l.level)}</span>
                        <div class="flex-grow min-w-0">
                            <p class="text-[11px] ${severe ? 'font-bold' : ''} text-slate-200 truncate" title="${escapeHtml(l.content)}">${escapeHtml(l.content)}</p>
                            <p class="text-[9px] text-slate-500 mono">${escapeHtml(mod)} · ${escapeHtml(l.operator)} · ${escapeHtml(new Date(l.ts).toLocaleString('zh-TW'))}</p>
                        </div>
                    </div>`;
                });
            } catch (e) { console.error('NAS alerts fetch failed', e); }
        }

        let nasLogFilter = 'all';
        function setNasLogFilter(f) { nasLogFilter = f; fetchNasAlerts(); }

        /* ==================== NAS Monitor 警報閾值設定 (系統 B 選配) ==================== */
        async function fetchAlertConfig({ generation = navigationGeneration } = {}) {
            const card = document.getElementById('nas-alert-config-card');
            try {
                const d = await (await fetch('/api/nas/alerts/config')).json();
                if (generation !== navigationGeneration || currentPage !== 'nas' || document.visibilityState !== 'visible') return false;
                if (d.source === 'not_configured') { card.classList.add('hidden'); return false; }
                card.classList.remove('hidden');
                const rows = d.config || [];
                const list = document.getElementById('nas-alert-config-list');
                list.replaceChildren();
                if (!rows.length) {
                    const empty = document.createElement('p');
                    empty.className = 'text-xs text-slate-500 text-center py-2';
                    empty.textContent = '尚無自訂閾值，全部使用系統預設值';
                    list.appendChild(empty);
                } else rows.forEach(c => {
                    const row = document.createElement('div');
                    row.className = 'flex items-center gap-2 text-[11px] bg-slate-900/40 rounded-lg px-3 py-2';
                    const metric = document.createElement('span');
                    metric.className = 'font-bold text-slate-200 w-32 truncate mono';
                    metric.textContent = c.metric ?? '--';
                    const condition = document.createElement('span');
                    condition.className = 'text-slate-500';
                    condition.textContent = c.condition === 'below' ? '低於' : '高於';
                    const threshold = document.createElement('span');
                    threshold.className = 'text-amber-400 font-bold mono';
                    threshold.textContent = c.threshold ?? '--';
                    const actions = document.createElement('span');
                    actions.className = 'ml-auto flex items-center gap-2';
                    const state = document.createElement('span');
                    state.className = c.enabled === false ? 'text-slate-600' : 'text-emerald-500';
                    state.textContent = c.enabled === false ? '已停用' : '啟用中';
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'text-slate-500 hover:text-red-400 transition';
                    remove.title = '刪除';
                    remove.textContent = '刪除';
                    remove.dataset.action = 'nas-alert-delete';
                    remove.dataset.metric = String(c.metric ?? '');
                    actions.append(state, remove);
                    row.append(metric, condition, threshold, actions);
                    list.appendChild(row);
                });
                return true;
            } catch { card.classList.add('hidden'); return false; }
        }
        async function saveAlertConfig() {
            const metric = document.getElementById('nac-metric').value.trim();
            const threshold = parseFloat(document.getElementById('nac-threshold').value);
            if (!metric || isNaN(threshold)) return showToast('請填寫指標名稱與門檻值', true);
            try {
                const r = await fetch('/api/nas/alerts/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metric, threshold, condition: document.getElementById('nac-op').value, enabled: true }) });
                if (!r.ok) throw new Error();
                showToast('警報閾值已儲存');
                document.getElementById('nac-metric').value = ''; document.getElementById('nac-threshold').value = '';
                fetchAlertConfig();
            } catch { showToast('儲存失敗', true); }
        }
        async function deleteAlertConfig(metric) {
            if (!confirm(`刪除「${metric}」的警報閾值設定？`)) return;
            try {
                await fetch(`/api/nas/alerts/config/${encodeURIComponent(metric)}`, { method: 'DELETE' });
                showToast('已刪除');
                fetchAlertConfig();
            } catch { showToast('刪除失敗', true); }
        }

        /* ==================== NAS Monitor 即時推送 (SSE)：連線正常時新警報立即刷新，不需等輪詢 ==================== */
        let nasSse = null;
        let nasSseGeneration = 0;
        const nasSseLifecycle = window.SmartHubFrontendLifecycle.createScopedResource({
            canStart: generation => generation === navigationGeneration
                && currentPage === 'nas' && document.visibilityState === 'visible',
            close: stream => stream?.close?.()
        });
        function connectNasSse(generation = navigationGeneration) {
            if (nasSse || !nasSseLifecycle.connect(generation, requestedGeneration => {
                const dot = document.getElementById('nas-sse-dot');
                const stream = new EventSource('/api/nas/stream');
                const streamGeneration = ++nasSseGeneration;
                nasSse = stream;
                const active = () => nasSse === stream && streamGeneration === nasSseGeneration
                    && nasSseLifecycle.isCurrent(stream, requestedGeneration);
                stream.addEventListener('open', () => {
                    if (!active()) return;
                    if (dot) { dot.textContent = '● 即時'; dot.className = 'text-[9px] text-emerald-500 normal-case'; }
                });
                stream.addEventListener('error', () => {
                    if (!active()) return;
                    if (dot) { dot.textContent = '○ 離線 (輪詢中)'; dot.className = 'text-[9px] text-slate-600 normal-case'; }
                });
                stream.addEventListener('message', () => { if (active()) fetchNasAlerts({ generation: requestedGeneration }); }); // SSE 只加速刷新，輪詢仍是保底
                return stream;
            })) return;
        }
        function disconnectNasSse() {
            nasSseGeneration++;
            nasSseLifecycle.disconnect();
            nasSse = null;
            const dot = document.getElementById('nas-sse-dot');
            if (dot) { dot.textContent = '○ 未連線'; dot.className = 'text-[9px] text-slate-600 normal-case'; }
        }

        async function fetchNasSleepStats() {
            const el = document.getElementById('nas-sleep-stats');
            if (!el) return;
            try {
                const r = await (await fetch('/api/nas/sleep-stats')).json();
                const days = r.days || [];
                const awakeSessions = r.awakeSessions || [];
                if (!days.length) { el.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">尚無休眠紀錄（機械碟近期可能持續運轉，或日誌不足）</p>'; return; }
                const bar = pct => {
                    const c = pct >= 60 ? 'bg-emerald-500' : pct >= 30 ? 'bg-amber-500' : 'bg-red-500';
                    return `<div class="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden border border-slate-800"><div class="${c} h-full" style="width:${pct}%"></div></div>`;
                };
                const today = new Date().toLocaleDateString('en-CA');
                const completeDays = days.filter(day => day.day !== today);
                const recent = completeDays.slice(0, 7);
                const previous = completeDays.slice(7, 14);
                const aggregate = period => {
                    const drives = {}, wakeMoments = new Set(), hourCounts = Array(24).fill(0), timeCounts = {};
                    period.forEach(day => {
                        day.drives.forEach(drive => {
                            const row = drives[drive.name] ||= { name: drive.name, sleepHours: 0, monitoredDays: 0, sessions: 0, longestMin: 0 };
                            row.sleepHours += Number(drive.sleepHours || 0); row.monitoredDays++; row.sessions += Number(drive.sessions || 0); row.longestMin = Math.max(row.longestMin, Number(drive.longestMin || 0));
                        });
                        day.wakes.forEach(wake => wakeMoments.add(`${day.day} ${wake.time}`));
                    });
                    wakeMoments.forEach(moment => {
                        const time = moment.slice(-5), hour = Number(time.slice(0, 2));
                        if (Number.isInteger(hour) && hour >= 0 && hour < 24) hourCounts[hour]++;
                        timeCounts[time] = (timeCounts[time] || 0) + 1;
                    });
                    const rows = Object.values(drives).map(row => ({
                        ...row,
                        awakeHours: Math.max(0, row.monitoredDays * 24 - row.sleepHours),
                        sleepPct: row.monitoredDays ? Math.round(row.sleepHours / (row.monitoredDays * 24) * 100) : 0,
                        avgSessionMin: row.sessions ? Math.round(row.sleepHours * 60 / row.sessions) : 0
                    }));
                    const totalSleep = rows.reduce((sum, row) => sum + row.sleepHours, 0);
                    const driveDays = rows.reduce((sum, row) => sum + row.monitoredDays, 0);
                    return {
                        rows, totalSleep, totalAwake: rows.reduce((sum, row) => sum + row.awakeHours, 0),
                        avgSleepPerDriveDay: driveDays ? totalSleep / driveDays : 0,
                        wakeIncidents: wakeMoments.size, hourCounts, timeCounts
                    };
                };
                const current = aggregate(recent.length ? recent : days.slice(0, 1));
                const prior = aggregate(previous);
                const delta = prior.avgSleepPerDriveDay ? current.avgSleepPerDriveDay - prior.avgSleepPerDriveDay : null;
                const peakHour = current.hourCounts.reduce((best, count, hour) => count > best.count ? { hour, count } : best, { hour: 0, count: 0 });
                const topTimes = Object.entries(current.timeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
                const recentDaySet = new Set((recent.length ? recent : days.slice(0, 1)).map(day => day.day));
                const periodAwakeSessions = awakeSessions.filter(session => recentDaySet.has(new Date(session.start * 1000).toLocaleDateString('en-CA')));
                const longestAwake = periodAwakeSessions.reduce((best, row) => Number(row.durationMin || 0) > Number(best?.durationMin || 0) ? row : best, null);
                const fmtMin = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}時${minutes % 60}分` : `${minutes}分`;
                const hourMax = Math.max(1, ...current.hourCounts);
                const periodLabel = `近 ${recent.length || 1} 個完整日`;
                const summary = `
                    <div class="mb-5 p-4 rounded-xl bg-slate-900/45 border border-slate-800/60">
                        <div class="flex flex-wrap justify-between items-end gap-2 mb-3">
                            <div><p class="text-[11px] font-bold text-slate-200">跨日統計摘要</p><p class="text-[8px] text-slate-600 mt-0.5">${periodLabel}；今日尚未結束，不納入週期比較</p></div>
                            <p class="text-[8px] text-slate-600">資料涵蓋 ${days[days.length - 1].day} ～ ${days[0].day}</p>
                        </div>
                        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 mb-4">
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">硬碟合計休眠</p><p class="text-sm font-black mono text-emerald-400 mt-1">${current.totalSleep.toFixed(1)} 小時</p></div>
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">硬碟合計運轉</p><p class="text-sm font-black mono text-amber-400 mt-1">${current.totalAwake.toFixed(1)} 小時</p></div>
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">獨立喚醒時刻</p><p class="text-sm font-black mono text-blue-400 mt-1">${current.wakeIncidents} 次</p><p class="text-[8px] text-slate-600">平均 ${(current.wakeIncidents / Math.max(1, recent.length)).toFixed(1)} 次/日</p></div>
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">與前期比較</p><p class="text-sm font-black mono ${delta == null ? 'text-slate-500' : delta >= 0 ? 'text-emerald-400' : 'text-amber-400'} mt-1">${delta == null ? '資料不足' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 小時/日`}</p><p class="text-[8px] text-slate-600">平均每顆休眠 · 前期 ${previous.length} 日</p></div>
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">最常喚醒時段</p><p class="text-sm font-black mono text-violet-400 mt-1">${String(peakHour.hour).padStart(2, '0')}:00–${String(peakHour.hour).padStart(2, '0')}:59</p><p class="text-[8px] text-slate-600">${peakHour.count} 個獨立時刻</p></div>
                            <div class="p-3 rounded-lg bg-slate-950/50"><p class="text-[8px] text-slate-500">最長連續運轉</p><p class="text-sm font-black mono text-rose-400 mt-1">${longestAwake ? fmtMin(longestAwake.durationMin) : '--'}</p><p class="text-[8px] text-slate-600">${longestAwake ? `${escapeHtml(longestAwake.drive)}${longestAwake.ongoing ? ' · 目前仍運轉' : ''}` : '尚無完整配對'}</p></div>
                        </div>
                        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                            <div>
                                <p class="text-[9px] font-bold text-slate-400 mb-2">各硬碟週期統計</p>
                                <div class="space-y-2">${current.rows.map(row => `<div class="p-2.5 rounded-lg bg-slate-950/40"><div class="flex justify-between gap-3"><span class="font-bold text-[10px] text-slate-300">${escapeHtml(row.name)}</span><span class="mono text-[9px] text-slate-400">休眠 ${row.sleepHours.toFixed(1)}h · 運轉 ${row.awakeHours.toFixed(1)}h · ${row.sleepPct}%</span></div><p class="text-[8px] text-slate-600 mt-1">休眠 ${row.sessions} 次 · 平均 ${fmtMin(row.avgSessionMin)} · 最長 ${fmtMin(row.longestMin)}</p><div class="mt-1.5">${bar(row.sleepPct)}</div></div>`).join('')}</div>
                            </div>
                            <div>
                                <p class="text-[9px] font-bold text-slate-400 mb-2">每小時喚醒分布</p>
                                <div class="h-20 flex items-end gap-1 px-1 border-b border-slate-800">${current.hourCounts.map((count, hour) => `<div class="flex-1 bg-blue-500/70 hover:bg-blue-400 rounded-t-sm min-h-[2px]" style="height:${Math.max(2, count / hourMax * 100)}%" title="${String(hour).padStart(2, '0')}:00 · ${count} 次"></div>`).join('')}</div>
                                <div class="flex justify-between text-[7px] text-slate-700 mt-1"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
                                <p class="text-[8px] text-slate-600 mt-2">常見精確時刻：${topTimes.length ? topTimes.map(([time, count]) => `${time}（${count}天）`).join(' · ') : '尚無資料'}</p>
                                <div class="mt-3"><p class="text-[9px] font-bold text-slate-400 mb-1.5">最近運轉區段</p><div class="space-y-1 max-h-24 overflow-y-auto terminal-scroll">${periodAwakeSessions.slice(0, 8).map(session => `<div class="flex justify-between gap-3 text-[8px]"><span class="text-slate-500">${escapeHtml(session.drive)} · ${new Date(session.start * 1000).toLocaleString('zh-TW', { hour12: false })}</span><span class="mono ${session.ongoing ? 'text-amber-400' : 'text-slate-400'}">${fmtMin(session.durationMin)}${session.ongoing ? ' · 進行中' : ''}</span></div>`).join('') || '<p class="text-[8px] text-slate-600">尚無可配對的喚醒→休眠區段</p>'}</div></div>
                            </div>
                        </div>
                    </div>`;
                el.innerHTML = summary + days.map(d => `
                    <div class="mb-3 pb-3 border-b border-slate-800/50 last:border-0">
                        <p class="text-[11px] font-bold text-slate-300 mb-1.5">${d.day} <span class="text-slate-600 font-normal">· 喚醒 ${d.wakes.length} 次</span></p>
                        <div class="space-y-1.5">
                        ${d.drives.map(dr => `
                            <div class="flex items-center gap-2 text-[10px]">
                                <span class="text-slate-300 font-bold w-14 shrink-0">${dr.name}</span>
                                <span class="mono text-slate-400 w-32 shrink-0">睡 ${dr.sleepHours}h (${dr.sleepPct}%)</span>
                                <div class="flex-grow">${bar(dr.sleepPct)}</div>
                                <span class="mono text-slate-500 w-40 shrink-0 text-right">${dr.sessions}次 · 均${dr.avgMin}分 · 最長${dr.longestMin}分</span>
                            </div>`).join('')}
                        </div>
                        ${d.wakes.length ? `<p class="text-[8px] text-slate-600 mt-1.5 truncate" title="${d.wakes.map(w => w.drive + ' ' + w.time).join(', ')}">喚醒時刻：${d.wakes.slice(0, 12).map(w => w.time).join(' ')}${d.wakes.length > 12 ? ' …' : ''}</p>` : ''}
                    </div>`).join('');
            } catch (e) { el.innerHTML = '<p class="text-xs text-red-400 text-center py-4">休眠統計讀取失敗</p>'; }
        }

        async function ackAlert(id) {
            try {
                await fetch(`/api/nas/alerts/${id}/ack`, { method: 'POST' });
                showToast('警報已確認');
                fetchNasAlerts();
            } catch (e) { showToast('操作失敗', true); }
        }

        /* ==================== 測速 ==================== */
        let speedtestTimer = null, speedtestStart = 0;

        async function checkLastSpeedtest() {
            try {
                const s = await (await fetch('/api/speedtest/status')).json();
                if (s.download && s.status !== 'running') showSpeedtestResult(s, false);
            } catch (error) { console.debug('Last speed test status unavailable', error); }
        }

        async function triggerSpeedtest() {
            document.getElementById('st-idle').classList.add('hidden');
            document.getElementById('st-result').classList.add('hidden');
            document.getElementById('st-running').classList.remove('hidden');
            speedtestStart = Date.now();
            const elapsedEl = document.getElementById('st-elapsed');
            try {
                const res = await fetch('/api/speedtest', { method: 'POST' });
                if (!res.ok) throw new Error();
                showToast('測速指令已派送至 UCG');
            } catch (e) {
                showToast('測速指令派送失敗', true);
                return resetSpeedtestUI();
            }
            if (speedtestTimer) clearInterval(speedtestTimer);
            speedtestTimer = setInterval(async () => {
                const elapsed = Math.round((Date.now() - speedtestStart) / 1000);
                elapsedEl.innerText = elapsed + 's';
                try {
                    const s = await (await fetch('/api/speedtest/status')).json();
                    // 等測速結束且結果時間比觸發晚 (避免撈到上一次的舊結果)
                    const fresh = !s.lastRun || new Date(s.lastRun).getTime() >= speedtestStart - 60000;
                    if (s.status !== 'running' && s.download && elapsed > 5 && fresh) {
                        clearInterval(speedtestTimer);
                        showSpeedtestResult(s, true);
                    }
                } catch (error) { console.debug('Speed test progress refresh failed', error); }
                if (elapsed > 120) {
                    clearInterval(speedtestTimer);
                    showToast('測速逾時，請稍後再試', true);
                    resetSpeedtestUI();
                }
            }, 2500);
        }

        function resetSpeedtestUI() {
            document.getElementById('st-running').classList.add('hidden');
            document.getElementById('st-result').classList.add('hidden');
            document.getElementById('st-idle').classList.remove('hidden');
        }

        function showSpeedtestResult(s, animate) {
            document.getElementById('st-idle').classList.add('hidden');
            document.getElementById('st-running').classList.add('hidden');
            document.getElementById('st-result').classList.remove('hidden');
            const down = Math.round(s.download * 10) / 10, upv = Math.round(s.upload * 10) / 10;
            const maxScale = Math.max(down, upv, 100) * 1.15;
            const setVal = (id, target) => {
                const el = document.getElementById(id);
                if (!animate) { el.innerText = target; return; }
                let cur = 0;
                const step = target / 30;
                const timer = setInterval(() => {
                    cur += step;
                    if (cur >= target) { cur = target; clearInterval(timer); }
                    el.innerText = Math.round(cur * 10) / 10;
                }, 30);
            };
            setVal('st-down', down);
            setVal('st-up', upv);
            document.getElementById('st-ping').innerText = s.ping != null ? Math.round(s.ping * 10) / 10 : '--';
            requestAnimationFrame(() => {
                document.getElementById('st-down-bar').style.width = (down / maxScale * 100) + '%';
                document.getElementById('st-up-bar').style.width = (upv / maxScale * 100) + '%';
            });
            if (s.lastRun) document.getElementById('st-lastrun').innerText = '上次測速: ' + new Date(s.lastRun).toLocaleString('zh-TW');
            if (animate) showToast('✅ 測速完成');
        }

        /* ==================== PoE ==================== */
        async function triggerPoECycle() {
            const mac = document.getElementById('p-mac').value.trim();
            const port = document.getElementById('p-port').value.trim();
            const portIndex = Number(port);
            if (!mac || !Number.isInteger(portIndex) || portIndex < 1 || portIndex > 128) {
                return showToast('請輸入 MAC 與 1–128 的 Port', true);
            }
            try {
                const response = await fetch('/api/poe/power-cycle', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ switchMac: mac, portIndex })
                });
                if (!response.ok) throw new Error('PoE command rejected');
                showToast(`已向 ${mac} Port ${port} 發送重啟脈衝`);
            } catch (e) { showToast('發送失敗', true); }
        }

        /* ==================== 通知推播 ==================== */
        let notifChannel = 'discord';

        function setNotifChannel(ch) {
            notifChannel = ch;
            document.querySelectorAll('.notif-ch').forEach(b => {
                const on = b.dataset.ch === ch;
                b.className = `notif-ch py-2 rounded-lg text-[11px] font-bold border transition ${on ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'}`;
            });
            document.getElementById('notif-webhook-field').classList.toggle('hidden', ch === 'telegram');
            document.getElementById('notif-telegram-fields').classList.toggle('hidden', ch !== 'telegram');
            const lbl = ch === 'discord' ? 'Discord Webhook URL' : '通用 Webhook URL';
            const field = document.querySelector('#notif-webhook-field label');
            if (field) field.childNodes[0].nodeValue = lbl + ' ';
        }

        async function fetchNotifSettings() {
            try {
                const s = await (await fetch('/api/notifications/settings')).json();
                document.getElementById('notif-enabled').checked = !!s.enabled;
                document.getElementById('notif-webpush-enabled').checked = !!s.webPushEnabled;
                document.getElementById('notif-chatid').value = s.chatId || '';
                document.getElementById('notif-trig-threats').checked = !!s.triggerThreats;
                document.getElementById('notif-trig-nas').checked = !!s.triggerNasAlerts;
                const tw = document.getElementById('notif-trig-wiim'); if (tw) tw.checked = s.triggerWiimTemp !== false;
                const setCk = (id, v) => { const e = document.getElementById(id); if (e) e.checked = v; };
                setCk('notif-telegram-commands', !!s.telegramCommandsEnabled);
                setCk('notif-trig-ups-outage', s.triggerUpsOutage !== false);
                setCk('notif-trig-ups-lowbatt', s.triggerUpsLowBatt !== false);
                setCk('notif-trig-newclient', !!s.triggerNewClient);
                setCk('notif-trig-client-ip-change', !!s.triggerClientIpChange);
                setCk('notif-trig-client-connectivity', !!s.triggerClientConnectivity);
                setCk('notif-trig-client-signal', !!s.triggerClientWeakSignal);
                setCk('notif-trig-network-device-offline', !!s.triggerNetworkDeviceOffline);
                setCk('notif-trig-wifi-ssid', !!s.triggerWifiSsidChange);
                setCk('notif-trig-unifi-upgrade', !!s.triggerUnifiUpgrade);
                setCk('notif-trig-cloud-offline', !!s.triggerCloudOffline);
                setCk('notif-trig-wiim-offline', !!s.triggerWiimOffline);
                setCk('notif-trig-wiim-volume', !!s.triggerWiimHighVolume);
                setCk('notif-trig-wiim-playback', !!s.triggerWiimPlaybackChange);
                setCk('notif-trig-block', s.triggerBlockAction !== false);
                setCk('notif-trig-nasdisk', !!s.triggerNasDiskTemp);
                setCk('notif-trig-nasspace', !!s.triggerNasSpace);
                setCk('notif-trig-nas-disk-health', s.triggerNasDiskHealth !== false);
                setCk('notif-trig-nas-offline', !!s.triggerNasOffline);
                setCk('notif-trig-nas-cpu', !!s.triggerNasHighCpu);
                setCk('notif-trig-nas-memory', !!s.triggerNasHighMemory);
                setCk('notif-trig-ucgtemp', !!s.triggerUcgTemp);
                setCk('notif-trig-unifi-device-temp', s.triggerUnifiDeviceTemp !== false);
                setCk('notif-trig-ucg-cpu', !!s.triggerUcgHighCpu);
                setCk('notif-trig-ucg-memory', !!s.triggerUcgHighMemory);
                setCk('notif-trig-ucg-disk', !!s.triggerUcgDisk);
                setCk('notif-trig-wandown', !!s.triggerWanDown);
                setCk('notif-trig-wan-latency', !!s.triggerWanLatency);
                setCk('notif-trig-unifi-offline', !!s.triggerUnifiOffline);
                setCk('notif-trig-naslog', !!s.triggerNasLog);
                setCk('notif-trig-nas-sleep-wake', !!s.triggerNasSleepWake);
                setCk('notif-trig-upsload', !!s.triggerUpsHighLoad);
                setCk('notif-trig-ups-runtime', !!s.triggerUpsLowRuntime);
                setCk('notif-trig-upsvolt', !!s.triggerUpsVoltAbnormal);
                setCk('notif-trig-ups-sag', s.triggerUpsSag !== false);
                setCk('notif-trig-upssrc', !!s.triggerUpsSourceChange);
                setCk('notif-trig-ups-offline', s.triggerUpsOffline !== false);
                setCk('notif-trig-adgprot', s.triggerAdgProtection !== false);
                setCk('notif-trig-adgoff', !!s.triggerAdgOffline);
                setCk('notif-trig-adg-block-rate', !!s.triggerAdgHighBlockRate);
                setCk('notif-trig-lnxtemp', s.triggerLinuxTemp !== false);
                setCk('notif-trig-lnxoff', !!s.triggerLinuxOffline);
                setCk('notif-trig-lnxdisk', !!s.triggerLinuxDisk);
                setCk('notif-trig-lnx-cpu', !!s.triggerLinuxHighCpu);
                setCk('notif-trig-lnx-memory', !!s.triggerLinuxHighMemory);
                setCk('notif-trig-lnx-load', !!s.triggerLinuxHighLoad);
                setCk('notif-trig-docker-critical', s.triggerDockerCriticalLog !== false);
                setCk('notif-trig-docker-error', !!s.triggerDockerErrorLog);
                setCk('notif-trig-docker-state', s.triggerDockerState !== false);
                setCk('notif-trig-docker-health', s.triggerDockerHealth !== false);
                setCk('notif-trig-docker-restart', s.triggerDockerRestart !== false);
                setCk('notif-trig-docker-inventory', !!s.triggerDockerInventory);
                setCk('notif-trig-docker-oom', s.triggerDockerOom !== false);
                setCk('notif-trig-docker-cpu', !!s.triggerDockerHighCpu);
                setCk('notif-trig-docker-memory', !!s.triggerDockerHighMemory);
                setCk('notif-trig-system-critical', s.triggerSystemCritical !== false);
                setCk('notif-trig-system-warning', !!s.triggerSystemWarning);
                setCk('notif-trig-system-recovery', s.triggerSystemRecovery !== false);
                setCk('notif-trig-system-startup', !!s.triggerSystemStartup);
                const setV = (id, v) => { const e = document.getElementById(id); if (e && document.activeElement !== e) e.value = v; };
                setV('notif-client-signal', s.clientSignalAlert ?? 75);
                setV('notif-wiim-volume', s.wiimVolumeAlert ?? 80);
                setV('notif-nasdisk-temp', s.nasDiskTempAlert ?? 50);
                setV('notif-nasspace-pct', s.nasSpaceAlert ?? 85);
                setV('notif-nas-cpu', s.nasCpuAlert ?? 90); setV('notif-nas-memory', s.nasMemoryAlert ?? 90);
                setV('notif-ucg-temp', s.ucgTempAlert ?? 75);
                setV('notif-unifi-device-temp', s.unifiDeviceTempAlert ?? 75);
                setV('notif-ucg-cpu', s.ucgCpuAlert ?? 90);
                setV('notif-ucg-memory', s.ucgMemoryAlert ?? 90); setV('notif-ucg-disk', s.ucgDiskAlert ?? 85);
                setV('notif-wan-latency', s.wanLatencyAlert ?? 100);
                setV('notif-ups-load', s.upsLoadAlert ?? 80);
                setV('notif-ups-runtime', s.upsRuntimeAlertMin ?? 10);
                setV('notif-ups-sag-threshold', s.upsSagThresholdV ?? 105);
                setV('notif-ups-volt', s.upsVoltDeviationPct ?? 10);
                setV('notif-lnx-temp', s.linuxTempAlert ?? 70);
                setV('notif-lnx-disk', s.linuxDiskAlert ?? 90);
                setV('notif-lnx-cpu', s.linuxCpuAlert ?? 90); setV('notif-lnx-memory', s.linuxMemoryAlert ?? 90);
                setV('notif-adg-block-rate', s.adgBlockRateAlert ?? 50);
                setV('notif-lnx-load', s.linuxLoadAlert ?? 4);
                setV('notif-docker-cpu', s.dockerCpuAlert ?? 90);
                setV('notif-docker-memory', s.dockerMemoryAlert ?? 90);
                document.getElementById('notif-webhook-set').classList.toggle('hidden', !s.webhookUrlSet);
                document.getElementById('notif-token-set').classList.toggle('hidden', !s.botTokenSet);
                setNotifChannel(s.channel || 'discord');
            } catch (e) { console.error('notif settings fetch failed', e); }
        }

        async function saveNotifSettings() {
            const body = {
                enabled: document.getElementById('notif-enabled').checked,
                webPushEnabled: document.getElementById('notif-webpush-enabled').checked,
                channel: notifChannel,
                chatId: document.getElementById('notif-chatid').value.trim(),
                telegramCommandsEnabled: document.getElementById('notif-telegram-commands')?.checked ?? false,
                triggerThreats: document.getElementById('notif-trig-threats').checked,
                triggerNasAlerts: document.getElementById('notif-trig-nas').checked,
                triggerWiimTemp: document.getElementById('notif-trig-wiim') ? document.getElementById('notif-trig-wiim').checked : true,
                triggerUpsOutage: document.getElementById('notif-trig-ups-outage')?.checked ?? true,
                triggerUpsLowBatt: document.getElementById('notif-trig-ups-lowbatt')?.checked ?? true,
                triggerNewClient: document.getElementById('notif-trig-newclient')?.checked ?? false,
                triggerClientIpChange: document.getElementById('notif-trig-client-ip-change')?.checked ?? false,
                triggerClientConnectivity: document.getElementById('notif-trig-client-connectivity')?.checked ?? false,
                triggerClientWeakSignal: document.getElementById('notif-trig-client-signal')?.checked ?? false,
                clientSignalAlert: parseInt(document.getElementById('notif-client-signal')?.value, 10) || 75,
                triggerNetworkDeviceOffline: document.getElementById('notif-trig-network-device-offline')?.checked ?? false,
                triggerWifiSsidChange: document.getElementById('notif-trig-wifi-ssid')?.checked ?? false,
                triggerUnifiUpgrade: document.getElementById('notif-trig-unifi-upgrade')?.checked ?? false,
                triggerCloudOffline: document.getElementById('notif-trig-cloud-offline')?.checked ?? false,
                triggerWiimOffline: document.getElementById('notif-trig-wiim-offline')?.checked ?? false,
                triggerWiimHighVolume: document.getElementById('notif-trig-wiim-volume')?.checked ?? false,
                triggerWiimPlaybackChange: document.getElementById('notif-trig-wiim-playback')?.checked ?? false,
                wiimVolumeAlert: parseInt(document.getElementById('notif-wiim-volume')?.value, 10) || 80,
                triggerBlockAction: document.getElementById('notif-trig-block')?.checked ?? true,
                triggerNasDiskTemp: document.getElementById('notif-trig-nasdisk')?.checked ?? false,
                triggerNasSpace: document.getElementById('notif-trig-nasspace')?.checked ?? false,
                triggerNasDiskHealth: document.getElementById('notif-trig-nas-disk-health')?.checked ?? true,
                triggerNasOffline: document.getElementById('notif-trig-nas-offline')?.checked ?? false,
                triggerNasHighCpu: document.getElementById('notif-trig-nas-cpu')?.checked ?? false,
                triggerNasHighMemory: document.getElementById('notif-trig-nas-memory')?.checked ?? false,
                triggerUcgTemp: document.getElementById('notif-trig-ucgtemp')?.checked ?? false,
                triggerUnifiDeviceTemp: document.getElementById('notif-trig-unifi-device-temp')?.checked ?? true,
                triggerUcgHighCpu: document.getElementById('notif-trig-ucg-cpu')?.checked ?? false,
                triggerUcgHighMemory: document.getElementById('notif-trig-ucg-memory')?.checked ?? false,
                triggerUcgDisk: document.getElementById('notif-trig-ucg-disk')?.checked ?? false,
                triggerWanDown: document.getElementById('notif-trig-wandown')?.checked ?? false,
                triggerWanLatency: document.getElementById('notif-trig-wan-latency')?.checked ?? false,
                wanLatencyAlert: parseInt(document.getElementById('notif-wan-latency')?.value, 10) || 100,
                triggerUnifiOffline: document.getElementById('notif-trig-unifi-offline')?.checked ?? false,
                triggerNasLog: document.getElementById('notif-trig-naslog')?.checked ?? false,
                triggerNasSleepWake: document.getElementById('notif-trig-nas-sleep-wake')?.checked ?? false,
                triggerUpsHighLoad: document.getElementById('notif-trig-upsload')?.checked ?? false,
                triggerUpsLowRuntime: document.getElementById('notif-trig-ups-runtime')?.checked ?? false,
                triggerUpsVoltAbnormal: document.getElementById('notif-trig-upsvolt')?.checked ?? false,
                triggerUpsSag: document.getElementById('notif-trig-ups-sag')?.checked ?? true,
                triggerUpsSourceChange: document.getElementById('notif-trig-upssrc')?.checked ?? false,
                triggerUpsOffline: document.getElementById('notif-trig-ups-offline')?.checked ?? true,
                nasDiskTempAlert: parseInt(document.getElementById('notif-nasdisk-temp')?.value, 10) || 50,
                nasSpaceAlert: parseInt(document.getElementById('notif-nasspace-pct')?.value, 10) || 85,
                nasCpuAlert: parseInt(document.getElementById('notif-nas-cpu')?.value, 10) || 90,
                nasMemoryAlert: parseInt(document.getElementById('notif-nas-memory')?.value, 10) || 90,
                ucgTempAlert: parseInt(document.getElementById('notif-ucg-temp')?.value, 10) || 75,
                unifiDeviceTempAlert: parseInt(document.getElementById('notif-unifi-device-temp')?.value, 10) || 75,
                ucgCpuAlert: parseInt(document.getElementById('notif-ucg-cpu')?.value, 10) || 90,
                ucgMemoryAlert: parseInt(document.getElementById('notif-ucg-memory')?.value, 10) || 90,
                ucgDiskAlert: parseInt(document.getElementById('notif-ucg-disk')?.value, 10) || 85,
                upsLoadAlert: parseInt(document.getElementById('notif-ups-load')?.value, 10) || 80,
                upsRuntimeAlertMin: parseInt(document.getElementById('notif-ups-runtime')?.value, 10) || 10,
                upsVoltDeviationPct: parseInt(document.getElementById('notif-ups-volt')?.value, 10) || 10,
                upsSagThresholdV: parseInt(document.getElementById('notif-ups-sag-threshold')?.value, 10) || 105,
                triggerAdgProtection: document.getElementById('notif-trig-adgprot')?.checked ?? true,
                triggerAdgOffline: document.getElementById('notif-trig-adgoff')?.checked ?? false,
                triggerAdgHighBlockRate: document.getElementById('notif-trig-adg-block-rate')?.checked ?? false,
                adgBlockRateAlert: parseInt(document.getElementById('notif-adg-block-rate')?.value, 10) || 50,
                triggerLinuxTemp: document.getElementById('notif-trig-lnxtemp')?.checked ?? true,
                triggerLinuxOffline: document.getElementById('notif-trig-lnxoff')?.checked ?? false,
                triggerLinuxDisk: document.getElementById('notif-trig-lnxdisk')?.checked ?? false,
                linuxTempAlert: parseInt(document.getElementById('notif-lnx-temp')?.value, 10) || 70,
                linuxDiskAlert: parseInt(document.getElementById('notif-lnx-disk')?.value, 10) || 90,
                triggerLinuxHighCpu: document.getElementById('notif-trig-lnx-cpu')?.checked ?? false,
                linuxCpuAlert: parseInt(document.getElementById('notif-lnx-cpu')?.value, 10) || 90,
                triggerLinuxHighMemory: document.getElementById('notif-trig-lnx-memory')?.checked ?? false,
                linuxMemoryAlert: parseInt(document.getElementById('notif-lnx-memory')?.value, 10) || 90,
                triggerLinuxHighLoad: document.getElementById('notif-trig-lnx-load')?.checked ?? false,
                linuxLoadAlert: parseFloat(document.getElementById('notif-lnx-load')?.value) || 4,
                triggerDockerCriticalLog: document.getElementById('notif-trig-docker-critical')?.checked ?? true,
                triggerDockerErrorLog: document.getElementById('notif-trig-docker-error')?.checked ?? false,
                triggerDockerState: document.getElementById('notif-trig-docker-state')?.checked ?? true,
                triggerDockerHealth: document.getElementById('notif-trig-docker-health')?.checked ?? true,
                triggerDockerRestart: document.getElementById('notif-trig-docker-restart')?.checked ?? true,
                triggerDockerInventory: document.getElementById('notif-trig-docker-inventory')?.checked ?? false,
                triggerDockerOom: document.getElementById('notif-trig-docker-oom')?.checked ?? true,
                triggerDockerHighCpu: document.getElementById('notif-trig-docker-cpu')?.checked ?? false,
                dockerCpuAlert: parseInt(document.getElementById('notif-docker-cpu')?.value, 10) || 90,
                triggerDockerHighMemory: document.getElementById('notif-trig-docker-memory')?.checked ?? false,
                dockerMemoryAlert: parseInt(document.getElementById('notif-docker-memory')?.value, 10) || 90,
                triggerSystemCritical: document.getElementById('notif-trig-system-critical')?.checked ?? true,
                triggerSystemWarning: document.getElementById('notif-trig-system-warning')?.checked ?? false,
                triggerSystemRecovery: document.getElementById('notif-trig-system-recovery')?.checked ?? true,
                triggerSystemStartup: document.getElementById('notif-trig-system-startup')?.checked ?? false
            };
            const wh = document.getElementById('notif-webhook').value.trim();
            const tk = document.getElementById('notif-token').value.trim();
            if (wh) body.webhookUrl = wh;
            if (tk) body.botToken = tk;
            try {
                const res = await fetch('/api/notifications/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!res.ok) throw new Error();
                showToast('推播設定已儲存');
                document.getElementById('notif-webhook').value = '';
                document.getElementById('notif-token').value = '';
                fetchNotifSettings();
            } catch (e) { showToast('儲存失敗', true); }
        }

        async function detectChatId() {
            showToast('查詢 Telegram Chat ID 中...');
            try {
                const res = await fetch('/api/notifications/telegram-chatid');
                const r = await res.json();
                if (!res.ok) return showToast(r.error || '查詢失敗', true);
                if (!r.chats.length) return showToast('沒找到聊天室：請先在 Telegram 對你的 bot 傳送任一訊息再試', true);
                document.getElementById('notif-chatid').value = r.chats[0].id;
                showToast(`✅ 已填入 Chat ID ${r.chats[0].id} (${r.chats[0].name})，記得按儲存`);
            } catch (e) { showToast('查詢失敗: ' + e.message, true); }
        }

        async function testNotif() {
            showToast('發送測試通知中...');
            try {
                const r = await (await fetch('/api/notifications/test', { method: 'POST' })).json();
                if (r.ok) showToast('✅ 測試通知已送出，請檢查你的裝置');
                else if (r.skipped) showToast('請先啟用推播並儲存設定', true);
                else showToast('測試失敗: ' + (r.error || '未知錯誤'), true);
                fetchNotifLog();
            } catch (e) { showToast('測試失敗', true); }
        }

        /* ==================== 主題 ==================== */
        function setTheme(t) {
            document.documentElement.classList.toggle('light', t === 'light');
            localStorage.setItem('theme', t);
            persistUiPreference('theme', t);
            const moon = document.getElementById('theme-icon-moon'), sun = document.getElementById('theme-icon-sun');
            if (moon && sun) { moon.classList.toggle('hidden', t === 'light'); sun.classList.toggle('hidden', t !== 'light'); }
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', t === 'light' ? '#eef2f7' : '#07101d');
            document.querySelectorAll('[data-theme-btn]').forEach(b => {
                const on = b.dataset.themeBtn === t;
                b.className = `theme-btn py-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-2 ${on ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'}`;
            });
            refreshChartTheme(t);
        }
        function toggleTheme() { setTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light'); }

        /* ==================== 設定頁 ==================== */
        const DIAG_TONES = {
            healthy: { label: 'Healthy', dot: 'bg-emerald-400', text: 'text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' },
            warning: { label: 'Warning', dot: 'bg-amber-400', text: 'text-amber-400', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/25' },
            critical: { label: 'Critical', dot: 'bg-rose-400', text: 'text-rose-400', badge: 'bg-rose-500/10 text-rose-400 border-rose-500/25' },
            error: { label: 'Error', dot: 'bg-red-400', text: 'text-red-400', badge: 'bg-red-500/10 text-red-400 border-red-500/25' },
            unknown: { label: 'Unknown', dot: 'bg-slate-500', text: 'text-slate-400', badge: 'bg-slate-800 text-slate-400 border-slate-700' }
        };
        function diagTone(status) { return DIAG_TONES[status] || DIAG_TONES.unknown; }
        function diagBytes(bytes) {
            if (bytes == null || !Number.isFinite(Number(bytes))) return '--';
            const n = Number(bytes); return n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`;
        }
        function diagUptime(seconds) {
            const s = Math.max(0, Number(seconds) || 0), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
            return `${d ? d + 'd ' : ''}${h}h ${m}m`;
        }
        function diagCard(name, status, value, detail) {
            const tone = diagTone(status);
            return `<div class="bg-slate-950/45 border border-slate-800/60 rounded-xl p-4">
                <div class="flex items-center justify-between gap-2 mb-2">
                    <p class="text-[10px] uppercase tracking-wider font-bold text-slate-500">${escapeHtml(name)}</p>
                    <span class="flex items-center gap-1.5 text-[9px] font-bold ${tone.text}"><span class="w-1.5 h-1.5 rounded-full ${tone.dot}"></span>${tone.label}</span>
                </div>
                <p class="text-lg font-black text-slate-100 mono">${escapeHtml(value)}</p>
                <p class="text-[9px] text-slate-500 mt-1 break-words">${escapeHtml(detail || '')}</p>
            </div>`;
        }
        async function fetchSystemStatus() {
            const badge = document.getElementById('sysdiag-overall');
            try {
                const response = await fetch('/api/system/status');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const d = await response.json();
                const tone = diagTone(d.status);
                if (badge) { badge.textContent = tone.label; badge.className = `px-2.5 py-1 rounded-full text-[9px] font-bold uppercase border ${tone.badge}`; }
                const cards = [
                    ['App', d.status, diagUptime(d.uptime_seconds), `v${d.app_version || '--'} · Uptime`],
                    ['CPU', d.cpu?.status, d.cpu?.usage_percent == null ? '--' : `${d.cpu.usage_percent}%`, `Process ${d.cpu?.process_usage_percent ?? '--'}% · Load ${(d.cpu?.load_average || []).map(v => Number(v).toFixed(2)).join(' / ')}`],
                    ['Memory', d.memory?.status, d.memory?.usage_percent == null ? '--' : `${d.memory.usage_percent}%`, `Process ${d.memory?.process_mb ?? '--'} MB · Available ${diagBytes(d.memory?.system_available_bytes)}`],
                    ['Disk', d.disk?.status, d.disk?.usage_percent == null ? '--' : `${d.disk.usage_percent}%`, `Free ${diagBytes(d.disk?.free_bytes)} · DATA_DIR`],
                    ['SQLite', d.database?.status, d.database?.latency_ms == null ? '--' : `${d.database.latency_ms} ms`, `Connection ${d.database?.pool?.active ?? 0}/${d.database?.pool?.size ?? 1} · Slow ${d.database?.slow_queries ?? 0} · Failed ${d.database?.failed_queries ?? 0}`],
                    ['Worker', d.worker?.status, `${d.worker?.active_tasks ?? 0} active`, `Queued ${d.worker?.queued_tasks ?? 0} · Failed ${d.worker?.failed_tasks ?? 0} · Completed ${d.worker?.completed_tasks ?? 0} · Stuck ${d.worker?.stuck_tasks ?? 0}`]
                ];
                const summary = document.getElementById('sysdiag-summary');
                if (summary) summary.innerHTML = cards.map(c => diagCard(...c)).join('');

                const issues = d.active_issues || [];
                const issueWrap = document.getElementById('sysdiag-issues');
                const count = document.getElementById('sysdiag-active-count');
                if (count) count.textContent = String(issues.length);
                if (issueWrap) issueWrap.innerHTML = issues.length ? issues.map(issue => {
                    const t = diagTone(issue.severity);
                    return `<div class="rounded-lg border ${issue.severity === 'critical' ? 'border-red-500/25 bg-red-500/5' : 'border-amber-500/25 bg-amber-500/5'} p-3">
                        <div class="flex items-center justify-between gap-2"><span class="text-[9px] font-black uppercase ${t.text}">${escapeHtml(issue.severity)}</span><code class="text-[9px] text-slate-400">${escapeHtml(issue.code || '')}</code></div>
                        <p class="text-[11px] font-bold text-slate-200 mt-1">${escapeHtml(issue.message || '')}</p>
                        <p class="text-[9px] text-slate-500 mt-1">First ${new Date(issue.first_seen).toLocaleString('zh-TW')} · Last ${new Date(issue.last_seen).toLocaleString('zh-TW')} · ${issue.occurrences || 1} 次</p>
                    </div>`;
                }).join('') : '<p class="text-[10px] text-emerald-400">目前沒有未解決問題</p>';

                const resolved = (d.resolved_issues || []).slice(0, 20);
                const resolvedWrap = document.getElementById('sysdiag-resolved');
                if (resolvedWrap) resolvedWrap.innerHTML = resolved.length ? resolved.map(issue => `<div class="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                    <div class="flex items-center justify-between gap-2"><span class="text-[9px] font-black uppercase text-emerald-400">Resolved</span><code class="text-[9px] text-slate-500">${escapeHtml(issue.code || '')}</code></div>
                    <p class="text-[10px] text-slate-300 mt-1">${escapeHtml(issue.message || '')}</p>
                    <p class="text-[9px] text-slate-600 mt-1">Duration ${diagUptime(issue.duration_seconds)} · ${new Date(issue.resolved_at).toLocaleString('zh-TW')}</p>
                </div>`).join('') : '<p class="text-[10px] text-slate-500">尚無已解除問題</p>';
                const version = document.getElementById('sysdiag-version'), sampled = document.getElementById('sysdiag-sampled');
                if (version) version.textContent = `Version ${d.app_version || '--'} · Trend ${(d.trend_data || []).length}/60 samples`;
                if (sampled) sampled.textContent = `Sampled ${new Date(d.sampled_at).toLocaleString('zh-TW')}`;
            } catch (error) {
                const tone = diagTone('unknown');
                if (badge) { badge.textContent = tone.label; badge.className = `px-2.5 py-1 rounded-full text-[9px] font-bold uppercase border ${tone.badge}`; }
                const wrap = document.getElementById('sysdiag-summary');
                if (wrap) wrap.innerHTML = `<div class="col-span-full rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-400">Diagnostics API 無法讀取：${escapeHtml(error.message)}</div>`;
            }
        }

        async function fetchAppSettings() {
            try {
                const s = await (await fetch('/api/settings')).json();
                const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
                set('srv-deviceActiveFrontendPollSec', s.deviceActiveFrontendPollSec);
                set('srv-deviceActiveBackendSampleSec', s.deviceActiveBackendSampleSec);
                set('srv-deviceIdleBackendSampleSec', s.deviceIdleBackendSampleSec);
                set('srv-unifiTelemetryActiveSec', s.unifiTelemetryActiveSec);
                set('srv-unifiTelemetryIdleSec', s.unifiTelemetryIdleSec);
                set('srv-heartbeatSec', s.heartbeatSec); set('srv-activeLeaseSec', s.activeLeaseSec);
                set('srv-upsFrontendPollSec', s.upsFrontendPollSec);
                set('srv-upsActiveBackendSampleSec', s.upsActiveBackendSampleSec);
                set('srv-upsIdleBackendSampleSec', s.upsIdleBackendSampleSec);
                set('srv-upsHistoryFrontendPollSec', s.upsHistoryFrontendPollSec);
                set('srv-upsPpbEventsFrontendPollSec', s.upsPpbEventsFrontendPollSec);
                set('srv-upsPpbEventActiveBackendSampleSec', s.upsPpbEventActiveBackendSampleSec);
                set('srv-upsPpbEventIdleBackendSampleSec', s.upsPpbEventIdleBackendSampleSec);
                set('srv-watcherSec', s.watcherSec);
                set('srv-autoDefenseSec', s.autoDefenseSec);
                set('srv-toastSec', s.toastSec ?? 10); toastSec = s.toastSec ?? 10;
                set('srv-historyFlushMin', s.historyFlushMin ?? 10);
                set('srv-historyKeepDays', s.historyKeepDays ?? 30);
                const re = document.getElementById('report-enabled'); if (re) re.checked = !!s.reportEnabled;
                set('report-freq', s.reportFreq); set('report-hour', s.reportHour);
                set('report-hour2', s.reportHour2 ?? 20); toggleReportHour2();
                frontendPollingSettings = s;
                applyPolling(true);
            } catch (e) { console.error('app settings fetch failed', e); }
        }
        /* ==================== 重大事件警報橫幅 ==================== */
        let critDismissed = new Set(JSON.parse(localStorage.getItem('critDismissed') || '[]'));
        let critActiveIds = [];
        async function fetchCritAlerts() {
            try {
                const d = await (await fetch('/api/alerts/critical')).json();
                const alerts = (d.alerts || []).filter(a => !critDismissed.has(a.id));
                critActiveIds = alerts.map(a => a.id);
                const banner = document.getElementById('crit-alert-banner'), txt = document.getElementById('crit-alert-text');
                if (!banner) return;
                if (alerts.length) {
                    txt.textContent = alerts.length > 1 ? `${alerts[0].msg}　(+${alerts.length - 1} 則警報)` : alerts[0].msg;
                    banner.classList.remove('hidden'); banner.classList.add('flex');
                } else {
                    banner.classList.add('hidden'); banner.classList.remove('flex');
                }
                // 已解除的事件從記憶名單移除，讓同類新事件 (新 id) 能再次彈出
                const liveIds = new Set((d.alerts || []).map(a => a.id));
                let changed = false;
                critDismissed.forEach(id => { if (!liveIds.has(id)) { critDismissed.delete(id); changed = true; } });
                if (changed) localStorage.setItem('critDismissed', JSON.stringify([...critDismissed]));
            } catch (error) { console.debug('Critical alert refresh failed', error); }
        }
        function dismissCritAlerts() {
            critActiveIds.forEach(id => critDismissed.add(id));
            localStorage.setItem('critDismissed', JSON.stringify([...critDismissed]));
            const banner = document.getElementById('crit-alert-banner');
            banner.classList.add('hidden'); banner.classList.remove('flex');
        }
        function toggleReportHour2() {
            const f = document.getElementById('report-freq')?.value;
            document.getElementById('report-hour2-wrap')?.classList.toggle('hidden', f !== 'twice');
        }
        async function saveServerSettings() {
            const num = id => parseInt(document.getElementById(id).value, 10);
            const body = {
                deviceActiveFrontendPollSec: num('srv-deviceActiveFrontendPollSec'),
                deviceActiveBackendSampleSec: num('srv-deviceActiveBackendSampleSec'),
                deviceIdleBackendSampleSec: num('srv-deviceIdleBackendSampleSec'),
                unifiTelemetryActiveSec: num('srv-unifiTelemetryActiveSec'),
                unifiTelemetryIdleSec: num('srv-unifiTelemetryIdleSec'),
                heartbeatSec: num('srv-heartbeatSec'), activeLeaseSec: num('srv-activeLeaseSec'),
                upsFrontendPollSec: num('srv-upsFrontendPollSec'),
                upsActiveBackendSampleSec: num('srv-upsActiveBackendSampleSec'),
                upsIdleBackendSampleSec: num('srv-upsIdleBackendSampleSec'),
                upsHistoryFrontendPollSec: num('srv-upsHistoryFrontendPollSec'),
                upsPpbEventsFrontendPollSec: num('srv-upsPpbEventsFrontendPollSec'),
                upsPpbEventActiveBackendSampleSec: num('srv-upsPpbEventActiveBackendSampleSec'),
                upsPpbEventIdleBackendSampleSec: num('srv-upsPpbEventIdleBackendSampleSec'),
                watcherSec: num('srv-watcherSec'),
                autoDefenseSec: num('srv-autoDefenseSec'),
                toastSec: num('srv-toastSec'),
                historyFlushMin: num('srv-historyFlushMin'),
                historyKeepDays: num('srv-historyKeepDays'),
                reportEnabled: document.getElementById('report-enabled').checked,
                reportFreq: document.getElementById('report-freq').value,
                reportHour: num('report-hour'),
                reportHour2: num('report-hour2')
            };
            try {
                const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(result.error || '儲存失敗');
                toastSec = num('srv-toastSec') || toastSec;
                frontendPollingSettings = result.settings;
                applyPolling(true);
                showToast('伺服器設定已儲存並套用');
            } catch (e) { showToast(`儲存失敗: ${e.message}`, true); }
        }
        /* ==================== 連線設定 (.env 網頁化) ==================== */
        async function fetchConnections() {
            try {
                const security = await loadPanelSecurityContext();
                const telemetrySettings = document.getElementById('unifi-telemetry-admin-settings');
                if (telemetrySettings) telemetrySettings.classList.toggle('hidden', security.role !== 'admin');
                const saveButton = document.getElementById('save-connections-button');
                if (saveButton) saveButton.classList.toggle('hidden', security.role !== 'admin');
                if (security.role !== 'admin') return;
                const d = await (await fetch('/api/connections')).json();
                dbg('Conn', '連線設定載入', d);
                connectionClearableFields = new Set(Array.isArray(d.clearableFields) ? d.clearableFields : DEFAULT_CONNECTION_CLEARABLE_FIELDS);
                for (const [k, v] of Object.entries(d.fields || {})) {
                    const el = document.getElementById('conn-' + k);
                    if (el) {
                        el.value = v || '';
                        el.dataset.connectionInitialValue = el.value;
                    }
                }
                document.querySelectorAll('.conn-input').forEach(el => {
                    const key = el.id.replace('conn-', '');
                    const clearable = connectionClearableFields.has(key);
                    el.dataset.clearable = clearable ? 'true' : 'false';
                    if (!Object.hasOwn(d.fields || {}, key)) el.dataset.connectionInitialValue = '';
                    if (clearable && !el.placeholder) el.placeholder = '留空=清除';
                });
                for (const key of d.restartRequiredFields || []) {
                    const badge = document.getElementById('connset-' + key);
                    if (badge) badge.innerHTML = '';
                }
                for (const [k, set] of Object.entries(d.secretsSet || {})) {
                    const badge = document.getElementById('connset-' + k);
                    const input = document.getElementById('conn-' + k);
                    if (badge) badge.innerHTML = set ? '<span class="text-emerald-400">✓ 已設定</span>' : '<span class="text-amber-400">尚未設定</span>';
                    if (input) input.placeholder = connectionClearableFields.has(k)
                        ? (set ? '已設定 (留空=清除)' : '尚未設定，留空=維持未設定')
                        : (set ? '已設定 (留空=不變更)' : '尚未設定，請填入');
                }
                for (const key of d.pendingRestartFields || []) {
                    const badge = document.getElementById('connset-' + key);
                    if (badge) badge.innerHTML = '<span class="text-amber-400">已儲存，待 recreate</span>';
                }
                renderConnStatus();
            } catch (e) { dbg('Conn', '載入失敗', e); }
        }

        // 由後端記憶體現況直接彙整 (原本從側邊欄 DOM 推斷，時常不準)
        async function renderConnStatus() {
            const list = document.getElementById('conn-status-list');
            if (!list) return;
            try {
                const d = await (await fetch('/api/connections/status')).json();
                const dot = ok => `<span class="w-2 h-2 rounded-full inline-block shrink-0 ${ok === true ? 'bg-emerald-500' : ok === false ? 'bg-red-500' : 'bg-slate-600'}"></span>`;
                list.innerHTML = (d.devices || []).map(v => {
                    const ok = v.configured ? v.ok : undefined;
                    const state = !v.configured ? '未設定' : v.ok === true ? '已連線' : v.ok === false ? '未連線' : '已設定';
                    return `<div class="flex items-center gap-2">${dot(ok)}<span class="text-slate-400">${escapeHtml(v.name)}</span><span class="ml-auto mono ${v.configured && v.ok === false ? 'text-red-400' : 'text-slate-300'} text-[10px]">${escapeHtml(state)}${v.configured && v.detail ? ' · ' + escapeHtml(v.detail) : ''}</span></div>`;
                }).join('');
            } catch { list.innerHTML = '<p class="text-red-400 text-xs">狀態讀取失敗</p>'; }
        }

        async function saveConnections() {
            if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可變更連線設定', true);
            const body = {};
            document.querySelectorAll('.conn-input').forEach(el => {
                const key = el.id.replace('conn-', '');
                const value = el.value.trim();
                const initial = el.dataset.connectionInitialValue ?? '';
                if (value || (connectionClearableFields.has(key) && initial !== value)) body[key] = value;
            });
            dbg('Conn', '儲存欄位:', Object.keys(body));
            try {
                const r = await (await fetch('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
                if (!r.ok) throw new Error(r.error || 'save failed');
                const pending = Array.isArray(r.restartRequired) ? r.restartRequired : [];
                showToast(pending.length
                    ? `✅ 已儲存 ${r.changed} 個設定；${pending.join(', ')} 需 recreate 服務後生效`
                    : `✅ 已套用 ${r.changed} 個連線設定 (免重啟)，各設備將於數秒內重新連線`);
                document.querySelectorAll('.conn-secret').forEach(el => el.value = '');
                // 立即觸發各設備重新抓取
                fetchHardware(); fetchClients(); fetchThreats(); fetchNas(); fetchWiimSystem(); fetchWiimPlayback(); fetchUps();
                setTimeout(fetchConnections, 1500);
                setTimeout(renderConnStatus, 12000);
            } catch (e) { showToast('儲存失敗: ' + e.message, true); }
        }

        /* ==================== 設定備份 / 還原 ==================== */
        async function fetchConfigBackupStatus() {
            const badge = document.getElementById('backup-restore-state');
            if (!badge) return;
            try {
                const response = await fetch('/api/config/backup/status', { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const state = await response.json();
                badge.textContent = state.pending ? '已驗證，待 restart 套用' : '無待套用還原';
                badge.className = state.pending
                    ? 'px-2 py-1 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-300 border border-amber-500/30'
                    : 'px-2 py-1 rounded-full text-[9px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
            } catch (error) {
                badge.textContent = '狀態不可用';
                badge.className = 'px-2 py-1 rounded-full text-[9px] font-bold bg-red-500/10 text-red-300 border border-red-500/30';
            }
        }

        async function downloadConfigBackup() {
            showToast('正在建立一致的安全備份...');
            try {
                const response = await fetch('/api/config/backup', { cache: 'no-store' });
                if (!response.ok) {
                    const failure = await response.json().catch(() => ({}));
                    throw new Error(failure.error || `HTTP ${response.status}`);
                }
                const blob = await response.blob();
                const disposition = response.headers.get('content-disposition') || '';
                const name = disposition.match(/filename="([^"]+)"/)?.[1] || `smarthub-backup-${new Date().toISOString().slice(0, 10)}.json`;
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = name;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                showToast('安全備份已建立；機密欄位未匯出');
            } catch (error) { showToast(`備份失敗: ${error.message}`, true); }
        }

        async function stageConfigRestore(input) {
            const file = input.files?.[0];
            input.value = '';
            if (!file) return;
            const confirmation = window.prompt('還原會在下一次服務啟動套用。請輸入 RESTORE 以驗證並排入還原：');
            if (confirmation !== 'RESTORE') {
                showToast('已取消還原；未變更任何資料');
                return;
            }
            showToast('正在驗證備份完整性...');
            try {
                const response = await fetch('/api/config/restore', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/vnd.unifi-smarthub.backup+json',
                        'X-SmartHub-Restore-Confirmation': 'RESTORE'
                    },
                    body: await file.arrayBuffer()
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                await fetchConfigBackupStatus();
                showToast('備份已驗證並排入還原；請協調 restart / recreate 服務');
            } catch (error) { showToast(`還原未排入: ${error.message}`, true); }
        }

        async function runReportNow() {
            showToast('產生報表中...');
            try {
                const response = await fetch('/api/reports/run', { method: 'POST' });
                const r = await response.json();
                if (!response.ok) throw new Error(r.error || '報表產生失敗');
                const pre = document.getElementById('report-preview');
                pre.classList.remove('hidden');
                pre.innerText = r.report + (r.delivery && r.delivery.ok ? '\n\n✅ 已透過推播送出' : r.delivery?.partial ? `\n\n⚠️ 僅部分送出（${r.delivery.sentParts}/${r.delivery.totalParts}），為避免重複不會自動重送：${r.delivery.error || ''}` : r.delivery && r.delivery.skipped ? `\n\n（未送出：${r.delivery.skipped}）` : r.delivery?.error ? `\n\n⚠️ 推播失敗：${r.delivery.error}` : '');
                fetchReportLog();
            } catch (e) { showToast('產生失敗: ' + e.message, true); }
        }

        async function fetchReportLog() {
            const el = document.getElementById('report-log');
            if (!el) return;
            try {
                const runs = (await (await fetch('/api/reports/log?limit=20')).json()).runs || [];
                if (!runs.length) { el.innerHTML = '<p class="text-[10px] text-slate-500 text-center py-3">尚無報表執行紀錄</p>'; return; }
                const statusMeta = status => status === 'sent'
                    ? ['✅ 已送出', 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5']
                    : status === 'partial'
                        ? ['⚠️ 部分送出', 'text-orange-400 border-orange-500/20 bg-orange-500/5']
                    : status?.startsWith('skipped')
                        ? ['◌ 僅產生', 'text-amber-400 border-amber-500/20 bg-amber-500/5']
                        : ['⚠️ 失敗', 'text-red-400 border-red-500/20 bg-red-500/5'];
                el.innerHTML = runs.map(run => {
                    const [label, cls] = statusMeta(run.deliveryStatus);
                    return `<details class="rounded-lg border ${cls} p-3 group">
                        <summary class="cursor-pointer list-none flex items-start gap-2">
                            <span class="text-[10px] font-bold ${cls.split(' ')[0]}">${label}</span>
                            <span class="text-[10px] text-slate-300 flex-grow">${escapeHtml(run.trigger === 'scheduled' ? '排程報表' : '手動報表')}</span>
                            <span class="text-[9px] text-slate-500 mono">${escapeHtml(new Date(run.ts).toLocaleString('zh-TW'))}</span>
                        </summary>
                        <p class="text-[9px] text-slate-500 mt-2">${escapeHtml(run.channel ? `管道：${run.channel}` : '未經推播管道送出')}</p>
                        ${run.deliveryError ? `<p class="text-[9px] text-red-400 mt-1">${escapeHtml(run.deliveryError)}</p>` : ''}
                        <pre class="mt-2 pt-2 border-t border-slate-700/40 whitespace-pre-wrap text-[10px] leading-relaxed text-slate-300 mono">${escapeHtml(run.body || '')}</pre>
                    </details>`;
                }).join('');
            } catch (e) { el.innerHTML = '<p class="text-[10px] text-red-400 text-center py-3">報表執行紀錄讀取失敗</p>'; }
        }

        async function fetchNotifLog() {
            try {
                const log = (await (await fetch('/api/notifications/log')).json()).log || [];
                const el = document.getElementById('notif-log');
                if (!log.length) { el.innerHTML = '<p class="text-xs text-slate-500 text-center py-8">尚無推播紀錄。啟用並設定管道後，威脅或 NAS 警報會自動推播。</p>'; return; }
                el.innerHTML = log.map(e => `
                <div class="flex items-start gap-3 p-3 rounded-lg border ${e.ok ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}">
                    <span class="text-sm shrink-0 mt-0.5">${e.ok ? '✅' : '⚠️'}</span>
                    <div class="flex-grow min-w-0">
                        <p class="text-[11px] font-bold text-slate-200">${escapeHtml(e.title)}</p>
                        <p class="text-[10px] text-slate-400 whitespace-pre-line break-all">${escapeHtml(e.body)}</p>
                        ${e.error ? `<p class="text-[9px] text-red-400 mt-0.5">${escapeHtml(e.error)}</p>` : ''}
                        <p class="text-[9px] text-slate-600 mono mt-0.5">${escapeHtml(e.channel)} · ${escapeHtml(new Date(e.ts).toLocaleString('zh-TW'))}</p>
                    </div>
                </div>`).join('');
            } catch (e) { console.error('notif log fetch failed', e); }
        }

        /* ==================== WiiM 音響整合前端 JS 邏輯 ==================== */
        let wiimChart = null;
        let wiimChartWindowMinutes = 120;
        let wiimRawHistory = [];
        let wiimPlayerState = null;
        let wiimIsMuted = false;
        let wiimLastStatusObj = null;
        let wiimLastIp = '';
        let wiimIsLive = false;
        let wiimPlaybackStale = false;
        let wiimCpuAlert = 70, wiimBoardAlert = 60; // 溫度警示門檻 (由後端 appSettings 同步) // 外部訊源 (Line-In/藍牙/光纖/同軸)：無曲目長度概念，進度顯示 LIVE

        // LinkPlay mode 欄位 → 訊源名稱（docs/integrations/wiim-amp-api.md）
        function wiimModeLabel(m) {
            m = parseInt(m);
            const map = { 1: 'AirPlay', 2: 'DLNA', 10: 'WiFi 串流', 11: 'USB 隨身碟', 31: 'Spotify Connect', 32: 'TIDAL Connect', 40: 'Line-In', 41: '藍牙', 43: '光纖', 47: 'Line-In 2', 51: '同軸' };
            return map[m] || (m >= 10 && m <= 19 ? '網路串流' : m ? '訊源 ' + m : '');
        }
        const wiimIsExternalInput = m => [40, 41, 43, 47, 51].includes(parseInt(m));
        // mode → 輸入源 chip key (播放卡快速切換列高亮用)
        function wiimModeToSrcKey(m) {
            m = parseInt(m);
            return ({ 11: 'udisk', 40: 'line-in', 41: 'bluetooth', 43: 'optical', 47: 'line-in', 51: 'co-axial' })[m] || 'wifi';
        }
        function wiimSwitchSource(src) {
            dbg('WiiM', '切換輸入源 →', src);
            wiimCmd('setPlayerCmd:switchmode:' + src);
            setTimeout(fetchWiimPlayback, 1200); // 切換需時，稍後刷新高亮
        }
        function wiimHighlightSource(mode) {
            const active = wiimModeToSrcKey(mode);
            document.querySelectorAll('.wiim-src-chip').forEach(b => {
                const on = b.dataset.src === active;
                b.className = `wiim-src-chip inline-flex items-center justify-center gap-1.5 min-w-[62px] h-9 px-3 rounded-full text-[10px] leading-none font-bold border transition ${on ? 'bg-blue-600 text-white border-blue-400 shadow-lg shadow-blue-500/20' : 'bg-slate-900/60 text-slate-400 border-slate-700/60 hover:text-slate-200 hover:border-slate-600'}`;
            });
        }
        // LinkPlay 無資料時回 "unknow"/"un_known" 等字串，一律視為空值
        const wiimBadVal = v => !v || /^un_?know/i.test(String(v).trim());

        // LinkPlay 的播放時間欄位即使代表毫秒，實機仍以字串回傳。
        // 若直接做 curpos + 1000 會變成字串串接並瞬間衝到 100%，因此在狀態入口統一數值化。
        function normalizeWiimPlayer(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const toNonNegativeNumber = value => {
                const parsed = Number(value);
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
            };
            return {
                ...raw,
                curpos: toNonNegativeNumber(raw.curpos),
                totlen: toNonNegativeNumber(raw.totlen)
            };
        }

        function initWiimPage() {
            // 產生捷徑按鈕 1-12
            const presetCont = document.getElementById('wiim-preset-container');
            if (presetCont) {
                presetCont.innerHTML = '';
                for (let i = 1; i <= 12; i++) {
                    const btn = document.createElement('button');
                    btn.className = 'py-2 bg-slate-800 hover:bg-slate-750 border border-slate-700 rounded-lg text-xs font-bold text-slate-300 transition active:scale-95';
                    btn.textContent = i;
                    btn.addEventListener('click', () => wiimCmd('MCUKeyShortClick:' + i));
                    presetCont.appendChild(btn);
                }
            }

            // 初始化溫度圖表
            const ctx = document.getElementById('wiim-chart-canvas');
            if (ctx) {
                wiimChart = new Chart(ctx.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: [],
                        datasets: [
                            { label: 'CPU 溫度 (°C)', data: [], borderColor: '#f43f5e', backgroundColor: 'rgba(244, 63, 94, 0.1)', borderWidth: 1.8, pointRadius: 0, tension: 0.4, cubicInterpolationMode: 'monotone', fill: true },
                            { label: '主機板 溫度 (°C)', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', borderWidth: 1.8, pointRadius: 0, tension: 0.4, cubicInterpolationMode: 'monotone', fill: true },
                            { label: 'CPU 門檻', data: [], borderColor: 'rgba(244,63,94,.45)', borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false },
                            { label: '主機板 門檻', data: [], borderColor: 'rgba(59,130,246,.45)', borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: {
                                labels: { color: '#64748b', font: { size: 10 } }
                            }
                        },
                        scales: {
                            x: {
                                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                                ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 0 }
                            },
                            y: {
                                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                                ticks: { color: '#64748b', font: { size: 9 }, callback: v => compactNumber(v) + '°C' }
                            }
                        }
                    }
                });
            }

            // 初始載入數據 (後續定時輪詢已註冊於全域 POLL_JOBS 中)
            fetchWiimPlayback();
            fetchWiimSystem();
            wiimLoadPresetNames();                 // 以 getPresetInfo 標記捷徑名稱
            wiimCheckEqStat();
            setInterval(tickWiimProg, 1000);       // 本地進度條毫秒級預估預測
        }

        async function fetchWiimPlayback() {
            try {
                const res = await fetch('/api/wiim/status?type=play');
                if (!res.ok) throw new Error();
                const data = await res.json();
                dbg('WiiM', '播放狀態', data.source, data.player && data.player.status);
                wiimPlaybackStale = data.stale === true || data.source === 'stale_cache';

                // 裝置無回應：誠實顯示連線失敗，不顯示假曲目
                if (data.source === 'not_configured' || data.source === 'unreachable') {
                    wiimPlayerState = null;
                    wiimIsLive = false;
                    wiimPlaybackStale = false;
                    document.getElementById('wiim-htitle').textContent = data.source === 'not_configured' ? 'WiiM 尚未設定' : '無法連線 WiiM 裝置';
                    document.getElementById('wiim-hartist').textContent = data.source === 'not_configured' ? '選配整合未啟用' : `請確認 WIIM_IP (${data.ip || '--'}) 與裝置電源`;
                    const t = document.getElementById('ov-wiim-track'); if (t) t.textContent = data.source === 'not_configured' ? '未設定' : '無法連線';
                    const p = document.getElementById('ov-wiim-play'); if (p) p.textContent = '--';
                    const v = document.getElementById('ov-wiim-vol'); if (v) v.textContent = '--';
                    updateWiimProgUI();
                    return;
                }

                // 播放器狀態 — 進度防抖動：輪詢回報常比本地秒針慢半拍，直接覆蓋會前進→倒退跳動。
                // 差距 <3 秒視為輪詢誤差取較大值 (時間軸永不倒退)；>3 秒視為使用者 seek 或換曲，採用裝置值。
                const dev = normalizeWiimPlayer(data.player);
                if (dev && wiimPlayerState && Date.now() < wiimSeekPendingUntil
                    && dev.totlen === wiimPlayerState.totlen) {
                    // Seek 指令送出後裝置可能短暫回傳舊位置；保留本地拖曳結果直到裝置完成跳轉。
                    dev.curpos = wiimPlayerState.curpos;
                } else if (dev && wiimPlayerState && dev.status === 'play' && wiimPlayerState.status === 'play'
                    && dev.totlen === wiimPlayerState.totlen
                    && Math.abs((dev.curpos || 0) - (wiimPlayerState.curpos || 0)) < 3000) {
                    dev.curpos = Math.max(dev.curpos || 0, wiimPlayerState.curpos || 0);
                } else if (dev && wiimPlayerState && dev.totlen > 0
                    && (dev.curpos || 0) >= dev.totlen - 1500
                    && (wiimPlayerState.curpos || 0) < dev.totlen - 8000) {
                    // 換曲瞬間 LinkPlay 常短暫回報 curpos≈totlen (舊曲殘值)，會讓進度條先衝到底再彈回。
                    // 若上一刻離曲尾還很遠卻突然「跳到底」，視為過渡假樣本，維持原進度等下一次輪詢。
                    dev.curpos = wiimPlayerState.curpos;
                }
                wiimPlayerState = dev;
                if (wiimPlayerState) {
                    wiimIsLive = !wiimPlaybackStale && wiimIsExternalInput(wiimPlayerState.mode);
                    wiimHighlightSource(wiimPlayerState.mode);
                    wiimIsMuted = parseInt(wiimPlayerState.mute) === 1;
                    document.getElementById('wiim-vico').innerHTML = wiimIsMuted
                        ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
                        : '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
                    syncWiimVolumeFromDevice(wiimPlayerState.vol);
                    document.getElementById('wiim-play-btn').innerHTML = wiimPlayerState.status === 'play'
                        ? '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
                        : '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
                    document.getElementById('wiim-play-btn').classList.toggle('play-pulsing', wiimPlayerState.status === 'play');
                    // 總覽 WiiM 卡：播放狀態/音量
                    const setOv = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
                    setOv('ov-wiim-play', ({ play: '▶ 播放中', pause: '⏸ 暫停', stop: '⏹ 停止', loading: '載入中' })[wiimPlayerState.status] || wiimPlayerState.status);
                    setOv('ov-wiim-vol', wiimPlayerState.vol + '%' + (wiimIsMuted ? ' 🔇' : ''));
                }

                // 曲目資訊 (Metadata)
                const meta = data.meta && data.meta.metaData;
                if (meta) {
                    // 外部訊源 (Line-In 等) 的 metadata 是 "unknow" → 改顯示訊源名稱，不顯示無意義字串
                    const srcLabel = wiimModeLabel(wiimPlayerState && wiimPlayerState.mode);
                    const title = wiimBadVal(meta.title) ? (wiimIsLive ? `${srcLabel} 輸入` : '無播放曲目') : meta.title;
                    const artist = wiimBadVal(meta.artist) ? (wiimIsLive ? '外部訊源即時輸入 · 無曲目資訊' : '-') : meta.artist;
                    document.getElementById('wiim-htitle').textContent = wiimPlaybackStale ? `⚠️ 最後已知：${title}` : title;
                    document.getElementById('wiim-hartist').textContent = wiimPlaybackStale ? `裝置目前未確認在線 · ${artist}` : artist;
                    const ovT = document.getElementById('ov-wiim-track');
                    if (ovT) ovT.textContent = wiimPlaybackStale
                        ? `⚠️ 最後已知 · ${title}`
                        : wiimIsLive ? `${srcLabel} 輸入 (LIVE)` : title + (artist && artist !== '-' ? ' — ' + artist : '');

                    let rateDepth = '';
                    if (meta.sampleRate) {
                        rateDepth = (meta.sampleRate / 1000) + ' kHz / ' + (meta.bitDepth || 16) + ' bit';
                    }
                    document.getElementById('wiim-hmeta').textContent = [srcLabel, wiimBadVal(meta.album) ? null : meta.album, rateDepth].filter(Boolean).join(' · ');

                    const artEl = document.getElementById('wiim-art');
                    const bgEl = document.getElementById('wiim-hero-bg');
                    if (!wiimBadVal(meta.albumArtURI) && /^https?:/i.test(meta.albumArtURI)) {
                        // 走後端代理：WiiM 的封面網址常是裝置自簽 HTTPS，瀏覽器直連會被擋
                        const artVersion = [meta.title, meta.artist, meta.album].filter(Boolean).join('|');
                        const artUrl = '/api/wiim/art?u=' + encodeURIComponent(meta.albumArtURI) + '&v=' + encodeURIComponent(artVersion);
                        if (artEl.dataset.artUrl !== artUrl) {
                            artEl.dataset.artUrl = artUrl;
                            artEl.style.backgroundImage = 'none';
                            artEl.innerHTML = '';
                            const image = document.createElement('img');
                            image.src = artUrl;
                            image.alt = `${title} 專輯封面`;
                            image.className = 'w-full h-full object-cover rounded-2xl';
                            image.addEventListener('error', () => {
                                artEl.dataset.artUrl = '';
                                artEl.innerHTML = '<svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
                            });
                            artEl.appendChild(image);
                        }
                        bgEl.style.backgroundImage = `url('${artUrl}')`;
                    } else {
                        artEl.dataset.artUrl = '';
                        artEl.style.backgroundImage = 'none';
                        artEl.innerHTML = '<svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
                        bgEl.style.backgroundImage = 'none';
                    }
                }
                updateWiimProgUI();
            } catch (e) {
                console.error('WiiM playback fetch failed', e);
            }
        }

        async function refreshWiimAccessories(button) {
            const icon = button?.querySelector('svg');
            button && (button.disabled = true);
            icon?.classList.add('animate-spin');
            try {
                await fetchWiimSystem();
                showToast('已重新整理 WiiM 遙控器與配件');
            } finally {
                button && (button.disabled = false);
                icon?.classList.remove('animate-spin');
            }
        }

        async function fetchWiimSystem() {
            try {
                const res = await fetch('/api/wiim/status?type=status');
                if (!res.ok) throw new Error();
                const data = await res.json();
                dbg('WiiM', '系統狀態', data.source);

                // 儲存最新的 IP 位址
                if (data.ip) {
                    wiimLastIp = data.ip;
                }

                // 側邊欄與總覽徽章 (真實 API 可達性)
                const stale = data.stale === true || data.source === 'stale_cache';
                const reachable = data.source === 'wiim_api' && !stale;
                const swDot = document.getElementById('side-wiim-dot');
                const swState = document.getElementById('side-wiim-state');
                const wiimStateClass = data.source === 'not_configured' ? 'bg-slate-600' : reachable ? 'bg-emerald-500' : 'bg-red-500';
                if (swDot) swDot.className = `w-1.5 h-1.5 rounded-full ${wiimStateClass}`;
                if (swState) swState.textContent = data.source === 'not_configured' ? '未設定' : reachable ? 'online' : stale ? 'stale' : 'offline';
                setOverviewStatusDot('ov-wiim-badge', reachable ? 'ok' : data.source === 'not_configured' ? 'idle' : 'error', reachable ? '連線正常' : data.source === 'not_configured' ? '未設定' : stale ? '最後已知資料' : '無法連線');

                // 遙控器與配件狀態動態讀取
                const statusObj = data.status;
                if (statusObj) {
                    wiimLastStatusObj = statusObj; // 全域儲存以利後續更新時間使用

                    // 總覽 WiiM 卡 + KPI：CPU / 主機板溫度
                    const wTemp = parseFloat(statusObj.temperature_cpu);
                    const wBoard = parseFloat(statusObj.temperature_tmp102);
                    if (!isNaN(wTemp)) {
                        const e1 = document.getElementById('ov-wiim-temp');
                        if (e1) { e1.textContent = Math.round(wTemp); e1.style.color = tempColor(wTemp); }
                        const e2 = document.getElementById('ov-wiim-temp-status');
                        if (e2) { e2.textContent = stale ? `最後已知 · ${tempLabel(wTemp)}` : tempLabel(wTemp); e2.style.color = stale ? '#f59e0b' : tempColor(wTemp); }
                        const e3 = document.getElementById('kpi-wiim-temp'); if (e3) e3.textContent = Math.round(wTemp);
                    }
                    if (!isNaN(wBoard)) {
                        const b1 = document.getElementById('ov-wiim-board'); if (b1) b1.textContent = wBoard.toFixed(1) + '°C';
                        const b2 = document.getElementById('ov-wiim-board-bar'); if (b2) b2.style.width = Math.min(100, wBoard / 80 * 100) + '%';
                    }
                    let remoteBat = null;
                    let remoteSig = null;
                    let remoteMac = null;
                    let remoteConnected = false;

                    for (const key in statusObj) {
                        const lowerKey = key.toLowerCase();
                        if (lowerKey.includes('remote')) {
                            if (lowerKey.includes('bat') || lowerKey.includes('percent')) {
                                remoteBat = statusObj[key];
                            } else if (lowerKey.includes('sig') || lowerKey.includes('rssi')) {
                                remoteSig = statusObj[key];
                            } else if (lowerKey.includes('mac')) {
                                remoteMac = statusObj[key];
                            } else if (lowerKey.includes('status') || lowerKey.includes('connect')) {
                                remoteConnected = statusObj[key] === 'connected' || parseInt(statusObj[key]) === 1 || statusObj[key] === 'true' || statusObj[key] === true;
                            }
                        }
                    }

                    // 更新 UI
                    const batVal = (remoteBat !== null && remoteBat !== undefined) ? parseInt(remoteBat) : null;
                    const batEl = document.getElementById('wiim-remote-bat');
                    const batIcon = document.getElementById('wiim-remote-bat-icon');
                    if (batVal !== null && !isNaN(batVal) && batVal >= 0 && batVal <= 100) {
                        batEl.textContent = batVal;
                        if (batVal <= 20) {
                            batIcon.textContent = '🪫';
                            batEl.className = 'text-2xl font-black text-rose-500';
                        } else {
                            batIcon.textContent = '🔋';
                            batEl.className = 'text-2xl font-black text-emerald-400';
                        }
                    } else {
                        batEl.textContent = '--';
                        batIcon.textContent = '🔋';
                        batEl.className = 'text-2xl font-black text-slate-500';
                    }

                    const sigVal = (remoteSig !== null && remoteSig !== undefined) ? parseInt(remoteSig) : null;
                    const sigEl = document.getElementById('wiim-remote-sig');
                    if (sigVal !== null && !isNaN(sigVal) && sigVal < 0) {
                        sigEl.textContent = sigVal;
                    } else {
                        sigEl.textContent = '--';
                    }

                    const macEl = document.getElementById('wiim-remote-mac');
                    if (remoteMac) {
                        macEl.textContent = remoteMac;
                    } else {
                        macEl.textContent = '--';
                    }

                    const statusEl = document.getElementById('wiim-remote-status');
                    if (stale) {
                        statusEl.textContent = '最後已知資料';
                        statusEl.className = 'text-amber-400 font-bold';
                    } else if (remoteConnected || (batVal !== null && batVal > 0)) {
                        statusEl.textContent = '已連線';
                        statusEl.className = 'text-emerald-400 font-bold';
                    } else {
                        statusEl.textContent = '未配對 / 離線';
                        statusEl.className = 'text-slate-500 font-bold';
                    }
                }
                if (!statusObj && !stale) {
                    wiimLastStatusObj = null;
                    const clearIds = [
                        ['ov-wiim-temp', '--'], ['ov-wiim-temp-status', '--'], ['kpi-wiim-temp', '--'],
                        ['ov-wiim-board', '--°C'], ['wiim-remote-bat', '--'], ['wiim-remote-sig', '--'],
                        ['wiim-remote-mac', '--'], ['wiim-remote-status', '未連線']
                    ];
                    clearIds.forEach(([id, value]) => { const element = document.getElementById(id); if (element) element.textContent = value; });
                }
            } catch (e) {
                console.error('WiiM system status fetch failed', e);
            }

            // 獲取歷史紀錄
            try {
                const res = await fetch('/api/wiim/history');
                if (!res.ok) throw new Error();
                const hist = await res.json();
                wiimRawHistory = hist.data || [];
                if (hist.cpu_alert) { wiimCpuAlert = hist.cpu_alert; const i = document.getElementById('wiim-cpu-alert'); if (i && document.activeElement !== i) i.value = hist.cpu_alert; }
                if (hist.board_alert) { wiimBoardAlert = hist.board_alert; const i = document.getElementById('wiim-board-alert'); if (i && document.activeElement !== i) i.value = hist.board_alert; }

                // 更新最後更新時間卡片與詳細連線資訊
                if (wiimRawHistory.length > 0) {
                    const last = wiimRawHistory[wiimRawHistory.length - 1];
                    const lastDate = new Date(last.ts * 1000);

                    // 格式化為 "下午5:09:03" 樣式
                    const hours = lastDate.getHours();
                    const ampm = hours >= 12 ? '下午' : '上午';
                    const showHours = hours % 12 === 0 ? 12 : hours % 12;
                    const mins = String(lastDate.getMinutes()).padStart(2, '0');
                    const secs = String(lastDate.getSeconds()).padStart(2, '0');
                    const timeStr = `${ampm}${showHours}:${mins}:${secs}`;

                    document.getElementById('wiim-last').textContent = timeStr;

                    // 計算相對時間差
                    const diffSec = Math.round(Date.now() / 1000 - last.ts);

                    const statusObj = wiimLastStatusObj || {};
                    const devName = statusObj.DeviceName || '--';
                    const fw = statusObj.firmware || '--';
                    const hw = statusObj.hardware || '--';

                    document.getElementById('wiim-agolbl').textContent = `${diffSec} 秒前更新`;
                    // 設備摘要移到 Hero 播放卡底部 (與溫度卡分離，版面協調)
                    const devLine = document.getElementById('wiim-hero-dev');
                    if (devLine) devLine.textContent = `${devName} · 韌體 ${fw} · ${hw} · IP ${wiimLastIp}`;
                }

                renderWiimChart();
                renderWiimLogTable();
            } catch (e) {
                console.error('WiiM history fetch failed', e);
            }
        }

        function fmtWiimDur(s) {
            if (s < 60) return s + '秒';
            if (s < 3600) return Math.round(s / 60) + '分';
            return (s / 3600).toFixed(1) + '小時';
        }

        function updateWiimStats(pts) {
            function agg(k) {
                const v = pts.map(d => d[k]).filter(x => x !== null && x !== undefined);
                if (!v.length) return null;
                return {
                    min: Math.min(...v),
                    max: Math.max(...v),
                    avg: v.reduce((a, b) => a + b, 0) / v.length
                };
            }
            const c = agg('cpu');
            const b = agg('board');
            document.getElementById('wiim-cpuMM').textContent = c ? `最低 ${c.min} / 平均 ${c.avg.toFixed(1)} / 最高 ${c.max}` : '—';
            document.getElementById('wiim-boardMM').textContent = b ? `最低 ${b.min} / 平均 ${b.avg.toFixed(1)} / 最高 ${b.max}` : '—';
        }

        function renderWiimChart() {
            if (!wiimChart) return;
            let visiblePoints = wiimRawHistory;
            if (wiimChartWindowMinutes > 0) {
                const cutoff = Date.now() - (wiimChartWindowMinutes * 60 * 1000);
                visiblePoints = wiimRawHistory.filter(d => (d.ts * 1000) >= cutoff);
            }
            let rawCpuData = visiblePoints.map(d => d.cpu);
            let rawBoardData = visiblePoints.map(d => d.board);
            const smoothOn = document.getElementById('wiim-smooth')?.checked;
            if (smoothOn) { rawCpuData = movAvg(rawCpuData, 5); rawBoardData = movAvg(rawBoardData, 5); }
            const plotRows = visiblePoints.map((point, index) => ({ ...point, __cpu: rawCpuData[index], __board: rawBoardData[index] }));
            const dataPoints = downsampleRows(plotRows, ['__cpu', '__board']);
            const labels = dataPoints.map(d => new Date(d.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            const cpuData = dataPoints.map(d => d.__cpu);
            const boardData = dataPoints.map(d => d.__board);

            wiimChart.data.labels = labels;
            wiimChart.data.datasets[0].data = cpuData;
            wiimChart.data.datasets[1].data = boardData;
            // 門檻虛線 (跨全圖；若超出自動縮放範圍會被裁切，不影響曲線解析度)
            wiimChart.data.datasets[2].data = labels.map(() => wiimCpuAlert);
            wiimChart.data.datasets[3].data = labels.map(() => wiimBoardAlert);
            // Y 軸自動貼合「實際溫度」範圍 (±2°C 邊距)：不被門檻線撐開，微小變化也看得清楚
            const vals = [...cpuData, ...boardData].filter(v => v != null && !isNaN(v));
            if (vals.length) {
                wiimChart.options.scales.y.min = Math.floor(Math.min(...vals)) - 2;
                wiimChart.options.scales.y.max = Math.ceil(Math.max(...vals)) + 2;
            }

            // 讀取顯示資料點核取方塊
            const showDots = document.getElementById('wiim-showDots') ? document.getElementById('wiim-showDots').checked : true;
            wiimChart.data.datasets[0].pointRadius = showDots ? 2.5 : 0;
            wiimChart.data.datasets[1].pointRadius = showDots ? 2.5 : 0;

            updateChartWithEntrance(wiimChart);

            // 更新圖表上方區間與點數說明 (卡片標題右側的範圍標籤一併同步)
            const rangeText = wiimChartWindowMinutes > 0
                ? (wiimChartWindowMinutes >= 60 ? `近 ${wiimChartWindowMinutes / 60} 小時` : `近 ${wiimChartWindowMinutes} 分`)
                : '全部記錄';
            const rangeLbl = document.getElementById('wiim-chart-status');
            if (rangeLbl) rangeLbl.textContent = visiblePoints.length > dataPoints.length ? `${rangeText} · ${visiblePoints.length} 點（繪製 ${dataPoints.length}）` : `${rangeText} · ${dataPoints.length} 點`;
            const hdrLbl = document.getElementById('wiim-rangelbl');
            if (hdrLbl) hdrLbl.textContent = rangeText;

            // 更新大數字與已記錄統計
            if (wiimRawHistory.length > 0) {
                const last = wiimRawHistory[wiimRawHistory.length - 1];
                const cpuEl = document.getElementById('wiim-cpuNow'), brdEl = document.getElementById('wiim-boardNow');
                cpuEl.textContent = last.cpu !== null ? last.cpu : '--';
                brdEl.textContent = last.board !== null ? last.board : '--';
                // 超標警示：數字轉紅 + 脈動
                const cpuHot = last.cpu != null && last.cpu >= wiimCpuAlert;
                const brdHot = last.board != null && last.board >= wiimBoardAlert;
                cpuEl.className = `text-3xl font-black ${cpuHot ? 'text-red-500 animate-pulse' : 'text-rose-500'}`;
                brdEl.className = `text-3xl font-black ${brdHot ? 'text-red-500 animate-pulse' : 'text-blue-400'}`;
                // 近 10 分鐘趨勢箭頭 (與 10 分鐘前樣本比較)
                const tenAgo = last.ts - 600;
                const ref = [...wiimRawHistory].reverse().find(d => d.ts <= tenAgo);
                const trend = (now, then, el) => {
                    if (!el) return;
                    if (now == null || !ref || then == null) { el.textContent = ''; return; }
                    const d = +(now - then).toFixed(1);
                    el.textContent = d > 0.3 ? `↗ +${d}` : d < -0.3 ? `↘ ${d}` : '→ 平穩';
                    el.style.color = d > 0.3 ? '#f59e0b' : d < -0.3 ? '#10b981' : '#64748b';
                    el.title = '與 10 分鐘前相比';
                };
                trend(last.cpu, ref && ref.cpu, document.getElementById('wiim-cpuTrend'));
                trend(last.board, ref && ref.board, document.getElementById('wiim-boardTrend'));
                document.getElementById('wiim-cnt').textContent = wiimRawHistory.length;

                const span = wiimRawHistory[wiimRawHistory.length - 1].ts - wiimRawHistory[0].ts;
                document.getElementById('wiim-spanlbl').textContent = '橫跨 ' + fmtWiimDur(span);
            }

            // 更新統計最小值/平均值/最大值
            updateWiimStats(visiblePoints);
        }

        // 移動平均 (忽略 null)
        function movAvg(arr, w = 5) {
            const out = [];
            for (let i = 0; i < arr.length; i++) {
                let sum = 0, c = 0;
                for (let j = Math.max(0, i - w + 1); j <= i; j++) { const v = arr[j]; if (v != null && !isNaN(v)) { sum += v; c++; } }
                out.push(c ? +(sum / c).toFixed(2) : null);
            }
            return out;
        }

        async function saveWiimAlerts() {
            const cpu = parseInt(document.getElementById('wiim-cpu-alert').value, 10);
            const board = parseInt(document.getElementById('wiim-board-alert').value, 10);
            if (!cpu || !board) return showToast('請輸入有效門檻', true);
            try {
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wiimCpuAlert: cpu, wiimBoardAlert: board }) });
                wiimCpuAlert = cpu; wiimBoardAlert = board;
                renderWiimChart();
                showToast(`✅ 溫度門檻已更新：CPU ${cpu}°C / 主機板 ${board}°C (推播警報同步生效)`);
                dbg('WiiM', '門檻更新', cpu, board);
            } catch (e) { showToast('儲存失敗', true); }
        }

        function toggleWiimDots() {
            renderWiimChart();
        }

        function downloadWiimCsv() {
            window.location.href = '/api/wiim/csv';
        }

        function renderWiimLogTable() {
            const tbody = document.getElementById('wiim-log-tbody');
            if (!wiimRawHistory.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="px-4 py-8 text-center text-slate-500">尚無資料，等待取樣中...</td></tr>';
                return;
            }
            const lines = [...wiimRawHistory].reverse().slice(0, 100);
            tbody.innerHTML = lines.map(l => `
            <tr class="border-b border-slate-800/40 hover:bg-slate-900/10">
                <td class="px-4 py-2 font-mono text-slate-400">${new Date(l.ts * 1000).toLocaleString('zh-TW')}</td>
                <td class="px-4 py-2 text-right font-bold text-rose-400 font-mono">${l.cpu !== null ? l.cpu + ' °C' : '—'}</td>
                <td class="px-4 py-2 text-right font-bold text-blue-400 font-mono">${l.board !== null ? l.board + ' °C' : '—'}</td>
            </tr>
        `).join('');
        }

        let wiimSeekDragging = false;
        let wiimSeekPendingUntil = 0;
        let wiimCatVisible = false;
        let wiimVolumeDragging = false;
        let wiimVolumePending = null;
        let wiimVolumePendingUntil = 0;

        function renderWiimVolume(value) {
            const volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            const slider = document.getElementById('wiim-vol');
            const label = document.getElementById('wiim-volval');
            if (slider) slider.value = volume;
            if (label) label.textContent = volume;
            return volume;
        }

        function previewWiimVolume(value) {
            wiimVolumeDragging = true;
            renderWiimVolume(value);
        }

        function syncWiimVolumeFromDevice(value) {
            const deviceVolume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            if (wiimVolumeDragging) return;
            if (wiimVolumePending !== null) {
                if (deviceVolume === wiimVolumePending || Date.now() >= wiimVolumePendingUntil) {
                    wiimVolumePending = null;
                    wiimVolumePendingUntil = 0;
                } else {
                    renderWiimVolume(wiimVolumePending);
                    return;
                }
            }
            renderWiimVolume(deviceVolume);
        }

        async function commitWiimVolume(value) {
            const volume = renderWiimVolume(value);
            wiimVolumeDragging = false;
            wiimVolumePending = volume;
            wiimVolumePendingUntil = Date.now() + 5000;
            if (wiimPlayerState) wiimPlayerState.vol = volume;
            const ok = await wiimCmd('setPlayerCmd:vol:' + volume);
            if (!ok) {
                wiimVolumePending = null;
                wiimVolumePendingUntil = 0;
                fetchWiimPlayback();
            }
        }

        function wiimStepVolume(delta) {
            const slider = document.getElementById('wiim-vol');
            const current = Number(slider?.value ?? wiimPlayerState?.vol ?? 0);
            commitWiimVolume(current + delta);
        }
        const wiimTimelineOwnedBySource = () => [1, 31, 32].includes(Number(wiimPlayerState?.mode));
        function setWiimCatPosition(percent) {
            const cat = document.getElementById('wiim-progress-cat');
            if (cat) cat.style.left = `${Math.min(100, Math.max(0, Number(percent) || 0))}%`;
        }
        function toggleWiimCat(event) {
            event?.preventDefault();
            wiimCatVisible = !wiimCatVisible;
            document.getElementById('wiim-progress-cat')?.classList.toggle('hidden', !wiimCatVisible);
        }
        function updateWiimProgUI() {
            if (wiimSeekDragging) return;
            const overviewBar = document.getElementById('ov-wiim-progress');
            const sourceOwnsTimeline = wiimTimelineOwnedBySource();
            const seekWrap = document.getElementById('wiim-pwrap');
            if (seekWrap) {
                seekWrap.classList.toggle('cursor-pointer', !sourceOwnsTimeline);
                seekWrap.classList.toggle('cursor-not-allowed', sourceOwnsTimeline);
                seekWrap.title = sourceOwnsTimeline ? '此訊源的播放時間由來源 App 控制' : '點擊或拖曳調整播放位置；雙擊顯示／隱藏小貓';
                seekWrap.setAttribute('aria-disabled', sourceOwnsTimeline ? 'true' : 'false');
            }
            // 外部訊源 (Line-In/藍牙/光纖/同軸)：curpos/totlen 為裝置回報的無意義亂值，凍結為 LIVE 顯示
            if (wiimIsLive) {
                document.getElementById('wiim-pbar').style.width = '100%';
                setWiimCatPosition(100);
                if (overviewBar) overviewBar.style.width = '100%';
                document.getElementById('wiim-pcur').textContent = 'LIVE';
                document.getElementById('wiim-ptot').textContent = '--:--';
                return;
            }
            if (!wiimPlayerState || wiimPlayerState.totlen <= 0) {
                document.getElementById('wiim-pbar').style.width = '0%';
                setWiimCatPosition(0);
                if (overviewBar) overviewBar.style.width = '0%';
                document.getElementById('wiim-pcur').textContent = '0:00';
                document.getElementById('wiim-ptot').textContent = '0:00';
                return;
            }
            const cur = wiimPlayerState.curpos / 1000;
            const tot = wiimPlayerState.totlen / 1000;
            const pct = Math.min(100, (cur / tot) * 100);

            document.getElementById('wiim-pbar').style.width = pct + '%';
            setWiimCatPosition(pct);
            if (overviewBar) overviewBar.style.width = pct + '%';
            document.getElementById('wiim-pcur').textContent = formatSec(cur);
            document.getElementById('wiim-ptot').textContent = formatSec(tot);
            const slider = document.getElementById('wiim-pwrap');
            if (slider) slider.setAttribute('aria-valuenow', String(Math.round(pct)));
        }

        function tickWiimProg() {
            if (wiimIsLive || wiimPlaybackStale || wiimSeekDragging) return; // LIVE/過期資料無法宣稱仍在播放；拖曳時不覆蓋預覽位置
            const currentMs = Number(wiimPlayerState?.curpos);
            const totalMs = Number(wiimPlayerState?.totlen);
            if (wiimPlayerState?.status === "play" && Number.isFinite(currentMs)
                && Number.isFinite(totalMs) && totalMs > 0) {
                wiimPlayerState.curpos = Math.min(totalMs, currentMs + 1000);
                updateWiimProgUI();
            }
        }

        function formatSec(s) {
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + (sec < 10 ? '0' : '') + sec;
        }

        function switchWiimSubTab(tab, btn) {
            const btns = document.querySelectorAll('.wiim-subtab-btn');
            btns.forEach(b => {
                b.className = 'wiim-subtab-btn px-3 py-2 text-xs font-bold text-slate-400 hover:text-slate-200 hover:bg-slate-800/70 rounded-lg transition shrink-0 whitespace-nowrap';
            });
            btn.className = 'wiim-subtab-btn px-3 py-2 text-xs font-bold text-white bg-blue-600 rounded-lg shadow-sm shadow-blue-500/20 transition shrink-0 whitespace-nowrap';

            const subpages = document.querySelectorAll('.wiim-subpage');
            subpages.forEach(p => p.classList.add('hidden'));

            document.getElementById('wiim-subpage-' + tab).classList.remove('hidden');
        }

        async function wiimCmd(command) {
            const highRisk = command === 'reboot' || command.startsWith('setShutdown:') || command.startsWith('ConnectMasterAp:');
            if (highRisk && !confirm(`這是高風險 WiiM 操作：${command}\n確定繼續？`)) return false;
            try {
                const res = await fetch('/api/wiim/cmd', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command, ...(highRisk ? { confirmation: command } : {}) })
                });
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
                showToast('已發送 WiiM 指令: ' + command);
                setTimeout(fetchWiimPlayback, 300);
                return true;
            } catch (e) {
                showToast('WiiM 指令發送失敗', true);
                return false;
            }
        }

        async function wiimGetVal(command, intoId) {
            try {
                const res = await fetch('/api/wiim/cmd?command=' + encodeURIComponent(command));
                if (!res.ok) throw new Error();
                const data = await res.json();
                const el = document.getElementById(intoId);
                el.classList.remove('hidden');
                try {
                    el.textContent = JSON.stringify(JSON.parse(data.result), null, 2);
                } catch {
                    el.textContent = data.result;
                }
            } catch (e) {
                showToast('讀取失敗', true);
            }
        }

        async function wiimClearHistory() {
            if (!confirm('確定要清空伺服器上記錄的溫度歷史資料嗎？')) return;
            try {
                const response = await fetch('/api/wiim/history', { method: 'DELETE' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                wiimRawHistory = [];
                renderWiimChart();
                renderWiimLogTable();
                showToast('歷史記錄已清空');
            } catch (e) {
                showToast('清空失敗', true);
            }
        }

        function wiimToggleMute() {
            wiimIsMuted = !wiimIsMuted;
            wiimCmd('setPlayerCmd:mute:' + (wiimIsMuted ? 1 : 0));
        }

        function wiimSyncTime() {
            const d = new Date();
            const p = n => (n < 10 ? '0' : '') + n;
            const s = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
            wiimCmd('timeSync:' + s);
        }

        async function wiimLoadPresets() {
            try {
                const res = await fetch('/api/wiim/cmd?command=EQGetList');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const select = document.getElementById('wiim-eq-list');
                select.innerHTML = '';
                try {
                    const arr = JSON.parse(data.result);
                    (arr.EQ || arr).forEach(n => {
                        const opt = document.createElement('option');
                        opt.value = n;
                        opt.textContent = n;
                        select.appendChild(opt);
                    });
                } catch (e) {
                    (data.result || '').split(/[",\[\]]+/).filter(x => x.trim()).forEach(n => {
                        const opt = document.createElement('option');
                        opt.value = n;
                        opt.textContent = n;
                        select.appendChild(opt);
                    });
                }
                showToast('已更新 EQ 預設清單');
            } catch (e) {
                showToast('取得 EQ 預設清單失敗', true);
            }
        }

        /* ==================== WiiM 進階功能 ==================== */
        // 點擊或拖曳進度條跳轉 (setPlayerCmd:seek:<絕對秒數>)
        function wiimSeekPreview(ev) {
            if (wiimPlaybackStale) return showToast('WiiM 目前只有最後已知資料，暫不能跳轉', true);
            if (wiimIsLive) return showToast('外部訊源 (LIVE) 模式無法跳轉進度', true);
            if (wiimTimelineOwnedBySource()) return null;
            if (!wiimPlayerState || !wiimPlayerState.totlen) return null;
            const rect = document.getElementById('wiim-pwrap').getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
            const sec = Math.round(wiimPlayerState.totlen / 1000 * ratio);
            document.getElementById('wiim-pbar').style.width = ratio * 100 + '%';
            setWiimCatPosition(ratio * 100);
            document.getElementById('wiim-pcur').textContent = formatSec(sec);
            document.getElementById('wiim-pwrap').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
            return { sec, ratio };
        }
        function wiimSeekStart(ev) {
            if (wiimPlaybackStale || wiimIsLive || wiimTimelineOwnedBySource() || !wiimPlayerState?.totlen) return;
            wiimSeekDragging = true;
            ev.currentTarget.setPointerCapture?.(ev.pointerId);
            wiimSeekPreview(ev);
        }
        function wiimSeekMove(ev) {
            if (wiimSeekDragging) wiimSeekPreview(ev);
        }
        function wiimSeekEnd(ev) {
            if (!wiimSeekDragging) return;
            const target = wiimSeekPreview(ev);
            wiimSeekDragging = false;
            ev.currentTarget.releasePointerCapture?.(ev.pointerId);
            if (!target) return updateWiimProgUI();
            const { sec, ratio } = target;
            dbg('WiiM', `Seek 至 ${sec}s (${Math.round(ratio * 100)}%)`);
            wiimPlayerState.curpos = sec * 1000;
            wiimSeekPendingUntil = Date.now() + 2500;
            updateWiimProgUI();
            wiimCmd('setPlayerCmd:seek:' + sec);
        }
        function wiimSeekCancel(ev) {
            wiimSeekDragging = false;
            ev.currentTarget.releasePointerCapture?.(ev.pointerId);
            updateWiimProgUI();
        }

        // 播放 URL：.m3u/.asx 用 playlist 指令，其餘用 play
        function wiimPlayUrl() {
            const url = document.getElementById('wiim-stream-url').value.trim();
            if (!url) return showToast('請先輸入串流網址', true);
            const isList = /\.(m3u8?|asx)(\?|$)/i.test(url);
            dbg('WiiM', `注入串流 (${isList ? 'playlist' : 'play'}):`, url);
            wiimCmd((isList ? 'setPlayerCmd:playlist:' : 'setPlayerCmd:play:') + url + (isList ? ':1' : ''));
        }

        async function wiimCheckEqStat() {
            try {
                const data = await (await fetch('/api/wiim/cmd?command=EQGetStat')).json();
                const on = /on/i.test(data.result || '');
                const el = document.getElementById('wiim-eq-stat');
                el.textContent = 'EQ: ' + (on ? 'ON' : 'OFF');
                el.className = `ml-auto cursor-pointer px-2.5 py-1 rounded-full text-[9px] font-bold uppercase border ${on ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-700/30 text-slate-400 border-slate-700/40'}`;
                dbg('WiiM', 'EQGetStat →', data.result);
            } catch (e) { dbg('WiiM', 'EQGetStat 失敗', e); }
        }

        // 設備與網路資訊面板 (getStatusEx + getStaticIpInfo)
        async function fetchWiimDeviceInfo() {
            const el = document.getElementById('wiim-devinfo');
            if (!el) return;
            try {
                const [st, ip] = await Promise.all([
                    fetch('/api/wiim/cmd?command=getStatusEx').then(r => r.json()),
                    fetch('/api/wiim/cmd?command=getStaticIpInfo').then(r => r.json())
                ]);
                let s = {}, n = {};
                try { s = JSON.parse(st.result); } catch (error) { dbg('WiiM', '設備資訊格式錯誤', error); }
                try { n = JSON.parse(ip.result); } catch (error) { dbg('WiiM', '網路資訊格式錯誤', error); }
                dbg('WiiM', '設備資訊', s, n);
                if (!Object.keys(s).length) { el.innerHTML = '<p class="text-slate-500 text-center py-4">裝置無回應 (檢查 WIIM_IP 與網路)</p>'; return; }
                const row = (k, v) => v ? `<div class="flex justify-between gap-3 border-b border-slate-800/40 pb-1.5"><span class="text-slate-500 shrink-0">${escapeHtml(k)}</span><span class="text-slate-300 mono text-right break-all">${escapeHtml(v)}</span></div>` : '';
                el.innerHTML =
                    row('設備名稱', s.DeviceName) + row('韌體', s.firmware) + row('硬體', s.hardware || s.project) +
                    row('PCB 版本', s.PCB_version) + row('MAC', s.MAC) + row('UUID', s.uuid || s.UUID) +
                    row('網路狀態', s.netstat != null ? (s.netstat == 2 ? '已連線' : s.netstat) : null) +
                    row('WLAN IP 模式', n.wlanStaticIpEnable == 1 ? '靜態' : 'DHCP') +
                    row('閘道', n.wlanGateWay) + row('DNS', n.wlanDnsServer) +
                    row('設備時間', s.date && s.time ? `${s.date} ${s.time}` : null);
            } catch (e) { dbg('WiiM', '設備資訊讀取失敗', e); el.innerHTML = '<p class="text-slate-500 text-center py-4">讀取失敗</p>'; }
        }

        // 以 getPresetInfo 取回捷徑名稱，為 1-12 按鈕加上標籤
        async function wiimLoadPresetNames() {
            try {
                const data = await (await fetch('/api/wiim/cmd?command=getPresetInfo')).json();
                const list = (JSON.parse(data.result).preset_list) || [];
                dbg('WiiM', 'getPresetInfo →', list.length, '組');
                const cont = document.getElementById('wiim-preset-container');
                if (!cont || !list.length) return;
                [...cont.children].forEach((btn, i) => {
                    const p = list.find(x => (x.number || x.index) == i + 1) || list[i];
                    if (p && (p.name || p.title)) {
                        btn.innerHTML = `<span class="block text-[10px] font-black">${i + 1}</span><span class="block text-[8px] text-slate-500 truncate px-1">${escapeHtml(p.name || p.title)}</span>`;
                        btn.title = p.name || p.title;
                    }
                });
            } catch (e) { dbg('WiiM', 'Preset 名稱載入失敗 (可能無預設)', e.message); }
        }

        /* ==================== UPS 電源監控 ==================== */
        /* ==================== UCG 歷史紀錄圖 ==================== */
        let ucgHistChart = null, ucgHistWinMin = 120, ucgHistRaw = [];
        function initUcgHistChart() {
            ucgHistChart = new Chart(document.getElementById('ucgHistChart'), {
                type: 'line',
                data: {
                    labels: [], datasets: [
                        { label: 'CPU 溫度 (°C)', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.06)', fill: true, tension: 0.25, pointRadius: 0, yAxisID: 'yTemp' },
                        { label: 'CPU 使用率 (%)', data: [], borderColor: '#f59e0b', fill: false, tension: 0.25, pointRadius: 0, yAxisID: 'yPct' },
                        { label: '記憶體 (%)', data: [], borderColor: '#a855f7', fill: false, tension: 0.25, pointRadius: 0, yAxisID: 'yPct' }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 9 } } } },
                    scales: {
                        x: { ticks: { color: '#64748b', font: { size: 8 }, maxTicksLimit: 10 }, grid: { display: false } },
                        yTemp: { position: 'left', ticks: { color: '#3b82f6', font: { size: 8 }, callback: v => v + '°C' }, grid: { color: 'rgba(30,41,59,0.4)' } },
                        yPct: { position: 'right', min: 0, max: 100, ticks: { color: '#94a3b8', font: { size: 8 }, callback: v => v + '%' }, grid: { display: false } }
                    }
                }
            });
        }
        async function fetchUcgHist() {
            try {
                const hours = ucgHistWinMin > 0 ? ucgHistWinMin / 60 : 720;
                const r = await (await fetch(`/api/hardware/history?hours=${hours}`)).json();
                ucgHistRaw = r.data || [];
                seedHeroChart(hwChart, chartLabels, [tempChartData, usageChartData], ucgHistRaw, [
                    point => point.cpuTemp, point => point.cpuUsage
                ]);
                renderUcgHistChart();
            } catch (e) { console.error('UCG history fetch failed', e); }
        }
        function renderUcgHistChart() {
            if (!ucgHistChart) return;
            const pts = ucgHistRaw;
            const plotted = downsampleRows(pts, ['cpuTemp', 'cpuUsage', 'memUsagePct']);
            const labels = plotted.map(p => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            ucgHistChart.data.labels = labels;
            ucgHistChart.data.datasets[0].data = plotted.map(p => p.cpuTemp);
            ucgHistChart.data.datasets[1].data = plotted.map(p => p.cpuUsage);
            ucgHistChart.data.datasets[2].data = plotted.map(p => p.memUsagePct);
            updateChartWithEntrance(ucgHistChart);
            const rangeText = ucgHistWinMin > 0 ? (ucgHistWinMin >= 60 ? `近 ${ucgHistWinMin / 60} 小時` : `近 ${ucgHistWinMin} 分`) : '全部記錄';
            const lbl = document.getElementById('ucg-rangelbl'); if (lbl) lbl.textContent = rangeText;
            document.getElementById('ucg-h-cnt').textContent = pts.length > plotted.length ? `${pts.length} / ${plotted.length}` : pts.length;
            const stat = (key, elPrefix) => {
                const vals = pts.map(p => p[key]).filter(v => v != null);
                const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
                if (!vals.length) { set(`${elPrefix}-min`, '--'); set(`${elPrefix}-avg`, '--'); set(`${elPrefix}-max`, '--'); return; }
                set(`${elPrefix}-min`, Math.min(...vals));
                set(`${elPrefix}-avg`, (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
                set(`${elPrefix}-max`, Math.max(...vals));
            };
            stat('cpuTemp', 'ucg-h-temp'); stat('cpuUsage', 'ucg-h-cpu'); stat('memUsagePct', 'ucg-h-mem');
        }
        function setUcgHistWin(minutes, btn) {
            ucgHistWinMin = minutes;
            document.querySelectorAll('.ucg-hist-win-btn').forEach(b => b.className = 'ucg-hist-win-btn px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition active:scale-95');
            if (btn) btn.className = 'ucg-hist-win-btn px-2.5 py-1 bg-blue-600/20 border border-blue-500/30 text-blue-400 rounded-lg transition font-bold active:scale-95';
            requestChartReplay(ucgHistChart);
            fetchUcgHist();
        }
        function downloadUcgHistCsv() {
            const rows = ['time,cpuTemp,cpuUsage,memUsagePct', ...ucgHistRaw.map(p => `${p.t},${p.cpuTemp},${p.cpuUsage},${p.memUsagePct}`)];
            const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ucg-history.csv'; a.click();
        }
        async function fetchUcgSpikes() {
            const el = document.getElementById('ucg-spike-list'); if (!el) return;
            try {
                const [settingsRes, histRes] = await Promise.all([
                    fetch('/api/notifications/settings'), fetch('/api/hardware/history?hours=168')
                ]);
                const threshold = (await settingsRes.json()).ucgTempAlert ?? 75;
                document.getElementById('ucg-spike-threshold').textContent = threshold;
                const pts = (await histRes.json()).data || [];
                const events = [];
                let open = null;
                pts.forEach(p => {
                    const hot = p.cpuTemp != null && p.cpuTemp >= threshold;
                    if (hot && !open) open = { start: p.t, max: p.cpuTemp };
                    else if (hot && open) open.max = Math.max(open.max, p.cpuTemp);
                    else if (!hot && open) { open.end = p.t; events.push(open); open = null; }
                });
                if (open) { open.end = pts[pts.length - 1].t; open.ongoing = true; events.push(open); }
                events.reverse();
                el.innerHTML = events.length ? events.slice(0, 20).map(e => {
                    const durMin = Math.round((new Date(e.end) - new Date(e.start)) / 60000);
                    return `<div class="flex items-center justify-between p-2.5 bg-red-500/5 border border-red-500/20 rounded-lg text-[11px]">
                        <span class="text-slate-300">${new Date(e.start).toLocaleString('zh-TW')} → ${e.ongoing ? '<span class="text-red-400 font-bold">進行中</span>' : new Date(e.end).toLocaleTimeString('zh-TW')}</span>
                        <span class="text-slate-500 mono">持續 ${durMin} 分</span>
                        <span class="text-red-400 font-bold mono">最高 ${e.max}°C</span>
                    </div>`;
                }).join('') : '<p class="text-xs text-emerald-400 text-center py-4">✅ 近 7 天沒有超過門檻的溫度事件</p>';
            } catch (e) { el.innerHTML = '<p class="text-xs text-red-400 text-center py-4">分析失敗</p>'; }
        }

        function initUpsCharts() {
            const base = { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 9 } } } } };
            const x = { ticks: { color: '#64748b', font: { size: 8 }, maxTicksLimit: 10 }, grid: { display: false } };
            upsVoltChart = new Chart(document.getElementById('upsVoltChart'), {
                type: 'line', data: {
                    labels: [], datasets: [
                        { label: '市電輸入 (V)', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.07)', fill: true, tension: 0.25, pointRadius: 0, spanGaps: false },
                        { label: 'UPS 輸出 (V)', data: [], borderColor: '#10b981', fill: false, tension: 0.25, pointRadius: 0, spanGaps: true }
                    ]
                },
                options: { ...base, scales: { x, y: { ticks: { color: '#64748b', font: { size: 8 }, callback: v => compactNumber(v) + ' V' }, grid: { color: 'rgba(30,41,59,0.4)' }, suggestedMin: 90, suggestedMax: 125 } } }
            });
            upsLoadChart = new Chart(document.getElementById('upsLoadChart'), {
                type: 'line', data: {
                    labels: [], datasets: [
                        { label: '電池 %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.06)', fill: true, tension: 0.25, pointRadius: 0 },
                        { label: '負載 %', data: [], borderColor: '#8b5cf6', fill: false, tension: 0.25, pointRadius: 0 }
                    ]
                },
                options: { ...base, scales: { x, y: { beginAtZero: true, max: 100, ticks: { color: '#64748b', font: { size: 8 }, callback: v => v + '%' }, grid: { color: 'rgba(30,41,59,0.4)' } } } }
            });
            dbg('UPS', '圖表初始化完成');
        }

        async function fetchUps(options = {}) {
            // 即時狀態
            try {
                const s = await (await fetch('/api/ups/status')).json();
                dbg('UPS', '即時狀態', s.source, s.status, `in=${s.inputV}V bat=${s.battery}%`);
                const sideOk = s.source && s.source !== 'unreachable';
                const sideDot = document.getElementById('side-ups-dot');
                const sideState = document.getElementById('side-ups-state');
                if (sideDot) sideDot.className = `w-1.5 h-1.5 rounded-full ${sideOk ? 'bg-emerald-500' : 'bg-red-500'}`;
                if (sideState) sideState.textContent = sideOk ? s.source : '未連接';
                const badge = document.getElementById('ups-source-badge');
                const setT = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
                const safeNum = value => Number.isFinite(Number(value)) ? Number(value) : null;
                if (s.source === 'unreachable') {
                    badge.textContent = '未連接 (檢視下方接入指南)';
                    badge.className = 'px-3 py-1 rounded-full text-[10px] font-bold mono uppercase tracking-wider border bg-red-500/10 text-red-400 border-red-500/20 self-start md:self-auto';
                    document.getElementById('ups-setup-guide').classList.remove('hidden');
                } else {
                    badge.textContent = `來源: ${s.source.toUpperCase()}`;
                    badge.className = 'px-3 py-1 rounded-full text-[10px] font-bold mono uppercase tracking-wider border bg-emerald-500/10 text-emerald-400 border-emerald-500/20 self-start md:self-auto';
                    if (s.source !== 'nut' || true) document.getElementById('ups-setup-guide').classList.toggle('hidden', s.source === 'nut');
                    document.getElementById('ups-model-line').textContent = `${s.model || 'UPS'} · 資料來源 ${s.source} · 後端每 ${safeNum(s.sampleSec) ?? '--'}s 取樣`;
                    setT('ups-kpi-inv', (safeNum(s.inputV) ?? '--') + '<span class="text-xs text-slate-500"> V</span>');
                    setT('ups-kpi-outv', (safeNum(s.outputV) ?? '--') + '<span class="text-xs text-slate-500"> V</span>');
                    setT('ups-kpi-batt', (safeNum(s.battery) ?? '--') + '<span class="text-xs text-slate-500"> %</span>');
                    document.getElementById('ups-kpi-batt-bar').style.width = (s.battery || 0) + '%';
                    setT('ups-kpi-load', (safeNum(s.loadPct) ?? '--') + '<span class="text-xs text-slate-500"> %</span>');
                    document.getElementById('ups-kpi-load-bar').style.width = (s.loadPct || 0) + '%';
                    setT('ups-kpi-rt', (s.runtimeSec != null ? Math.round(s.runtimeSec / 60) : '--') + '<span class="text-xs text-slate-500"> 分</span>');
                    const st = document.getElementById('ups-kpi-status');
                    st.textContent = s.onBattery ? '🔋 電池供電' : '🟢 市電正常';
                    st.className = `text-lg font-black mono mt-1.5 ${s.onBattery ? 'text-red-400' : 'text-emerald-400'}`;
                    const sl = document.getElementById('ups-samplelbl'); if (sl) sl.textContent = s.sampleSec;
                    // UPS 熱區卡 (仿 UCG 風格；輸出電壓為主要大數字，電池電量為次要)
                    const heroOutv = document.getElementById('ups-hero-outv');
                    if (heroOutv) {
                        heroOutv.textContent = s.outputV ?? '--';
                        document.getElementById('ups-hero-batt').textContent = (s.battery ?? '--') + '%';
                        document.getElementById('ups-hero-status').textContent = s.onBattery ? '🔋 電池供電' : '🟢 市電正常';
                        document.getElementById('ups-hero-dot').style.background = s.onBattery ? '#ef4444' : '#3b82f6';
                        document.getElementById('ups-hero-load-str').textContent = (s.loadPct ?? '--') + '%';
                        document.getElementById('ups-hero-load-bar').style.width = (s.loadPct || 0) + '%';
                        document.getElementById('ups-hero-inv').textContent = (s.inputV ?? '--') + 'V';
                        document.getElementById('ups-hero-rt').textContent = (s.runtimeSec != null ? Math.round(s.runtimeSec / 60) : '--') + ' 分';
                        document.getElementById('ups-hero-src').textContent = s.source.toUpperCase();
                        if (s.battery != null && s.outputV != null) {
                            if (upsHeroBattData.length >= 12) { upsHeroBattData.shift(); upsHeroVoltData.shift(); upsHeroLabels.shift(); }
                            upsHeroBattData.push(s.battery);
                            upsHeroVoltData.push(s.outputV);
                            upsHeroLabels.push(new Date().toLocaleTimeString());
                            updateChartWithEntrance(upsHeroChart);
                        }
                    }
                }
            } catch (e) { dbg('UPS', '狀態讀取失敗', e); }
            if (options.includeHistory === false) return;
            // 歷史 + 事件
            try {
                const h = (await (await fetch(`/api/ups/history?hours=${upsRangeHours}`)).json()).history || [];
                dbg('UPS', `歷史 ${upsRangeHours}h →`, h.length, '點');
                seedHeroChart(upsHeroChart, upsHeroLabels, [upsHeroBattData, upsHeroVoltData], h, [
                    point => point.batt, point => point.outV
                ]);
                const fmt = upsRangeHours > 24
                    ? p => new Date(p.t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit' })
                    : p => new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
                const plottedVolt = downsampleRows(h, ['inV', 'outV']);
                upsVoltChart.data.labels = plottedVolt.map(fmt);
                upsVoltChart.data.datasets[0].data = plottedVolt.map(p => p.inV);
                upsVoltChart.data.datasets[1].data = plottedVolt.map(p => p.outV);
                updateChartWithEntrance(upsVoltChart);
                const vstat = (key, prefix) => {
                    const vals = h.map(p => p[key]).filter(v => v != null && v > 0);
                    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
                    if (!vals.length) { set(`${prefix}-min`, '--'); set(`${prefix}-avg`, '--'); set(`${prefix}-max`, '--'); return; }
                    set(`${prefix}-min`, Math.min(...vals) + 'V');
                    set(`${prefix}-avg`, (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) + 'V');
                    set(`${prefix}-max`, Math.max(...vals) + 'V');
                };
                vstat('inV', 'ups-v-inv'); vstat('outV', 'ups-v-outv');
                // 電池/負載圖有自己的時間範圍;與電壓圖相同時共用資料省一次請求
                const hl = upsLoadRangeHours === upsRangeHours ? h
                    : ((await (await fetch(`/api/ups/history?hours=${upsLoadRangeHours}`)).json()).history || []);
                const fmtL = upsLoadRangeHours > 24
                    ? (p => new Date(p.t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) + ' ' + new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }))
                    : (p => new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }));
                const plottedLoad = downsampleRows(hl, ['batt', 'load']);
                upsLoadChart.data.labels = plottedLoad.map(fmtL);
                upsLoadChart.data.datasets[0].data = plottedLoad.map(p => p.batt);
                upsLoadChart.data.datasets[1].data = plottedLoad.map(p => p.load);
                updateChartWithEntrance(upsLoadChart);
            } catch (e) { dbg('UPS', '歷史讀取失敗', e); }
            try {
                const evs = (await (await fetch('/api/ups/events')).json()).events || [];
                document.getElementById('ups-event-count').textContent = evs.length ? `(共 ${evs.length} 次)` : '';
                const tb = document.getElementById('ups-event-tbody');
                tb.innerHTML = evs.length ? evs.map(e => `
                <tr class="border-b border-slate-800/40 ${!e.end ? 'bg-red-500/5' : ''}">
                    <td class="py-2 pr-3 mono text-slate-300">${new Date(e.start).toLocaleString('zh-TW')}</td>
                    <td class="py-2 pr-3 mono text-slate-400">${e.end ? new Date(e.end).toLocaleString('zh-TW') : '<span class="text-red-400 font-bold animate-pulse">⚡ 進行中</span>'}</td>
                    <td class="py-2 pr-3 mono text-slate-300">${e.durationSec != null ? (e.durationSec >= 60 ? Math.round(e.durationSec / 60) + ' 分' : e.durationSec + ' 秒') : '--'}</td>
                    <td class="py-2 pr-3 mono text-right ${e.minBattery <= 50 ? 'text-red-400' : 'text-slate-300'}">${e.minBattery ?? '--'}%</td>
                </tr>`).join('') : '<tr><td colspan="4" class="py-6 text-center text-slate-500">✅ 尚無斷電事件記錄</td></tr>';
            } catch (e) { dbg('UPS', '事件讀取失敗', e); }
        }

        function setUpsRange(hours, btn) {
            upsRangeHours = hours;
            document.querySelectorAll('.ups-range-btn').forEach(b => b.className = 'ups-range-btn px-2.5 py-1 rounded-md font-bold text-slate-400 hover:text-slate-200 transition');
            btn.className = 'ups-range-btn px-2.5 py-1 rounded-md font-bold bg-blue-600 text-white transition';
            dbg('UPS', '切換範圍', hours + 'h');
            requestChartReplay(upsVoltChart);
            fetchUps();
        }
        function setUpsLoadRange(hours, btn) {
            upsLoadRangeHours = hours;
            document.querySelectorAll('.ups-load-range-btn').forEach(b => b.className = 'ups-load-range-btn px-2 py-1 rounded-md font-bold text-slate-400 hover:text-slate-200 transition');
            btn.className = 'ups-load-range-btn px-2 py-1 rounded-md font-bold bg-blue-600 text-white transition';
            requestChartReplay(upsLoadChart);
            fetchUps();
        }
        function downloadUpsCsv() { window.location.href = '/api/ups/csv'; }

        async function fetchPpbEvents() {
            const card = document.getElementById('ppb-events-card'), list = document.getElementById('ppb-events-list');
            if (!list) return;
            try {
                const r = await (await fetch('/api/ups/ppb-events')).json();
                if (r.error) { card.classList.add('hidden'); return; } // 沒設定 PPB 帳密時直接隱藏整卡，不留錯誤訊息干擾
                card.classList.remove('hidden');
                const events = r.events || [];
                document.getElementById('ppb-events-count').textContent = events.length ? `共 ${events.length} 筆` : '';
                const cls = { error: 'text-red-400 border-red-500/20 bg-red-500/5', warning: 'text-amber-400 border-amber-500/20 bg-amber-500/5', ok: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5', test: 'text-blue-400 border-blue-500/20 bg-blue-500/5', info: 'text-slate-400 border-slate-700/40 bg-slate-900/30' };
                const svgI = (d, c) => `<svg class="w-3.5 h-3.5 ${c}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
                const icon = {
                    error: svgI('M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4m0 4h.01', 'text-red-400'),
                    warning: svgI('M13 10V3L4 14h7v7l9-11h-7z', 'text-amber-400'),
                    ok: svgI('M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3', 'text-emerald-400'),
                    test: svgI('M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z', 'text-blue-400'),
                    info: svgI('M12 16v-4m0-4h.01M22 12a10 10 0 11-20 0 10 10 0 0120 0z', 'text-slate-400')
                };
                list.innerHTML = events.length ? events.map(e => `
                    <div class="ppb-event-row flex items-center gap-3 p-2 rounded-lg border text-[11px] ${cls[e.level] || cls.info}">
                        <span class="shrink-0">${icon[e.level] || icon.info}</span>
                        <span class="text-[8px] uppercase text-slate-500 mono shrink-0">${escapeHtml(e.source || 'ups')}</span>
                        <span class="flex-grow text-slate-300">${escapeHtml(e.desc)}</span>
                        <span class="text-slate-500 mono shrink-0">${escapeHtml(e.ts)}</span>
                    </div>`).join('') : '<p class="text-xs text-slate-500 text-center py-4">尚無事件</p>';
            } catch (e) { list.innerHTML = '<p class="text-xs text-red-400 text-center py-4">讀取失敗</p>'; }
        }

        /* ==================== AdGuard Home ==================== */
        let adgProtectionOn = null;
        async function fetchAdguard() {
            try {
                const d = await (await fetch('/api/adguard/overview')).json();
                if (d.source !== 'adguard') return false;
                const st = d.stats || {}, sts = d.status || {};
                document.getElementById('adg-version').textContent = sts.version || '';
                document.getElementById('adg-queries').textContent = (st.num_dns_queries ?? 0).toLocaleString();
                document.getElementById('adg-blocked').textContent = (st.num_blocked_filtering ?? 0).toLocaleString();
                document.getElementById('adg-ratio').textContent = st.num_dns_queries ? (st.num_blocked_filtering / st.num_dns_queries * 100).toFixed(1) + '%' : '--';
                document.getElementById('adg-avgtime').textContent = st.avg_processing_time != null ? (st.avg_processing_time * 1000).toFixed(1) + ' ms' : '--';
                adgProtectionOn = !!sts.protection_enabled;
                const btn = document.getElementById('adg-toggle');
                btn.classList.remove('hidden');
                btn.textContent = adgProtectionOn ? '🟢 保護中 (點擊暫停)' : '⏸ 已暫停 (點擊恢復)';
                btn.className = `px-4 py-1.5 rounded-full text-[10px] font-bold border transition ${adgProtectionOn ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30 animate-pulse'}`;
                const bar = (n, max, name, val, color) => `
                    <div class="flex items-center gap-2 text-[11px]">
                        <span class="w-40 truncate text-slate-300" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                        <div class="flex-grow bg-slate-950 h-1.5 rounded-full overflow-hidden"><div class="${color} h-full rounded-full" style="width:${Math.max(val / max * 100, 2)}%"></div></div>
                        <span class="mono text-slate-500 w-12 text-right">${escapeHtml(val != null && val.toLocaleString ? val.toLocaleString() : val)}</span>
                    </div>`;
                const tb = st.top_blocked_domains || [];
                const maxB = tb.length ? Object.values(tb[0])[0] : 1;
                document.getElementById('adg-top-blocked').innerHTML = tb.slice(0, 10).map(o => { const [k, v] = Object.entries(o)[0]; return bar(0, maxB, k, v, 'bg-red-500'); }).join('') || '<p class="text-xs text-slate-500">無資料</p>';
                const tc = st.top_clients || [];
                const maxC = tc.length ? Object.values(tc[0])[0] : 1;
                const aliasName = ip => { const c = allClients.find(x => x.ip === ip); return c ? `${c.name} (${ip})` : ip; };
                document.getElementById('adg-top-clients').innerHTML = tc.slice(0, 10).map(o => { const [k, v] = Object.entries(o)[0]; return bar(0, maxC, aliasName(k), v, 'bg-blue-500'); }).join('') || '<p class="text-xs text-slate-500">無資料</p>';
                return true;
            } catch (e) { dbg('AdGuard', '讀取失敗', e); return false; }
        }
        function renderAdgLogRows(entries) {
            return (entries || []).map(e => `
                    <div class="flex items-center gap-3 p-1.5 rounded-lg text-[10px] ${e.blocked ? 'bg-red-500/5 border border-red-500/15' : 'bg-slate-950/30'}">
                        <span class="mono text-slate-500 shrink-0">${new Date(e.time).toLocaleTimeString('zh-TW', { hour12: false })}</span>
                        <span class="shrink-0 font-bold ${e.blocked ? 'text-red-400' : 'text-emerald-500'}">${e.blocked ? '攔截' : '放行'}</span>
                        <span class="flex-grow truncate mono text-slate-300" title="${escapeHtml(e.domain)}">${escapeHtml(e.domain)}</span>
                        <span class="mono text-slate-600 shrink-0">${escapeHtml(e.client)}</span>
                    </div>`).join('') || '<p class="text-xs text-slate-500 text-center py-4">無資料</p>';
        }
        async function fetchAdgLog() {
            try {
                const [all, blocked] = await Promise.all([
                    (await fetch('/api/adguard/querylog?limit=100')).json(),
                    (await fetch('/api/adguard/querylog?limit=100&filtered=1')).json()
                ]);
                if (all.source === 'adguard') document.getElementById('adg-querylog').innerHTML = renderAdgLogRows(all.entries);
                if (blocked.source === 'adguard') document.getElementById('adg-blockedlog').innerHTML = renderAdgLogRows((blocked.entries || []).map(e => ({ ...e, blocked: true })));
                return all.source === 'adguard' && blocked.source === 'adguard';
            } catch { return false; }
        }
        const ADG_POLICY_DAY_LABELS = { sun: '週日', mon: '週一', tue: '週二', wed: '週三', thu: '週四', fri: '週五', sat: '週六' };
        const ADG_POLICY_CATEGORY_LABELS = { youtube: 'YouTube', tiktok: 'TikTok', gaming: 'Gaming' };
        async function fetchAdguardServicePolicies() {
            const card = document.getElementById('adg-policy-card');
            if (!card) return false;
            if (document.documentElement.dataset.panelRole !== 'admin') {
                card.classList.add('hidden');
                return true;
            }
            card.classList.remove('hidden');
            const health = document.getElementById('adg-policy-health');
            const list = document.getElementById('adg-policy-list');
            try {
                const response = await fetch('/api/adguard/service-policies', { cache: 'no-store' });
                const state = await response.json();
                if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
                const reconcile = state.reconcile || {};
                const healthy = reconcile.status === 'healthy';
                health.textContent = healthy ? '● 協調正常' : reconcile.status === 'degraded' ? '⚠ 協調失敗' : '○ 等待首次協調';
                health.className = `px-2.5 py-1 rounded-full text-[9px] font-bold ${healthy ? 'bg-emerald-500/10 text-emerald-400' : reconcile.status === 'degraded' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-300'}`;
                const policies = state.policies || [];
                list.innerHTML = policies.length ? policies.map(policy => {
                    const windows = Object.entries(policy.allowWindows || {}).map(([day, window]) => `${ADG_POLICY_DAY_LABELS[day] || day} ${window.start}-${window.end}`).join(' · ');
                    const labels = (policy.categories || []).map(category => ADG_POLICY_CATEGORY_LABELS[category] || category).join(' / ');
                    const stateClass = policy.syncState === 'applied' ? 'text-emerald-400' : policy.syncState === 'error' ? 'text-red-400' : 'text-amber-300';
                    return `<div class="rounded-xl border border-slate-800/70 bg-slate-950/40 p-4">
                        <div class="flex items-start gap-3">
                            <div class="min-w-0 flex-grow">
                                <p class="text-xs font-bold text-slate-200 mono">${escapeHtml(policy.deviceId)}</p>
                                <p class="text-[10px] text-slate-400 mt-1">${escapeHtml(labels)} · ${escapeHtml(policy.timeZone)}</p>
                                <p class="text-[9px] text-slate-500 mt-1">允許：${escapeHtml(windows || '無（全天封鎖）')}</p>
                                <p class="text-[9px] ${stateClass} mt-2">${escapeHtml(policy.desiredState)} / ${escapeHtml(policy.syncState)}${policy.lastError ? ` · ${escapeHtml(policy.lastError)}` : ''}${policy.nextRetryAt ? ` · 重試 ${escapeHtml(new Date(policy.nextRetryAt).toLocaleString('zh-TW'))}` : ''}</p>
                            </div>
                            <button data-action="adguard-policy-remove" data-id="${escapeActionData(policy.id)}" class="shrink-0 px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-[10px] font-bold">移除並還原</button>
                        </div>
                    </div>`;
                }).join('') : '<p class="text-xs text-slate-500 text-center py-6">尚未建立裝置服務政策</p>';
                return true;
            } catch (error) {
                health.textContent = '讀取失敗';
                health.className = 'px-2.5 py-1 rounded-full text-[9px] font-bold bg-red-500/10 text-red-400';
                list.innerHTML = `<p class="text-xs text-red-400 text-center py-6">${escapeHtml(error.message)}</p>`;
                return false;
            }
        }
        async function saveAdguardServicePolicy() {
            if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可變更 AdGuard 政策', true);
            const categories = [...document.querySelectorAll('.adg-policy-category:checked')].map(input => input.value);
            const allowWindows = {};
            for (const row of document.querySelectorAll('.adg-policy-day')) {
                const [enabled, start, end] = row.querySelectorAll('input');
                if (enabled.checked) allowWindows[row.dataset.day] = { start: start.value, end: end.value };
            }
            const body = {
                deviceId: document.getElementById('adg-policy-device').value.trim(),
                categories,
                timeZone: document.getElementById('adg-policy-timezone').value.trim(),
                allowWindows
            };
            try {
                const response = await fetch('/api/adguard/service-policies', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                showToast(result.applied ? 'AdGuard 裝置政策已套用' : '政策已保存，等待 AdGuard 恢復後重試', !result.applied);
                await fetchAdguardServicePolicies();
            } catch (error) { showToast(`政策儲存失敗: ${error.message}`, true); }
        }
        async function removeAdguardServicePolicy(id) {
            if (document.documentElement.dataset.panelRole !== 'admin') return showToast('僅管理員可移除 AdGuard 政策', true);
            if (!confirm('確定移除此政策並還原首次套用前的 AdGuard blocked-services 設定？')) return;
            try {
                const response = await fetch(`/api/adguard/service-policies/${encodeURIComponent(id)}`, {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirmation: 'REMOVE_ADGUARD_SERVICE_POLICY' })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                showToast(result.applied ? '政策已移除，原設定已還原' : '移除已保存，等待 AdGuard 恢復後還原', !result.applied);
                await fetchAdguardServicePolicies();
            } catch (error) { showToast(`政策移除失敗: ${error.message}`, true); }
        }
        async function refreshAdguardNow() {
            const button = document.getElementById('adg-refresh');
            if (!button || button.disabled) return;
            const icon = button.querySelector('svg');
            button.disabled = true;
            button.setAttribute('aria-label', 'AdGuard 資料更新中');
            button.classList.add('opacity-60');
            icon?.classList.add('animate-spin');
            try {
                const results = await Promise.all([fetchAdguard(), fetchAdgLog(), fetchAdguardServicePolicies()]);
                showToast(results.every(Boolean) ? 'AdGuard 資料已立即更新' : 'AdGuard 部分資料更新失敗', !results.every(Boolean));
            } finally {
                button.disabled = false;
                button.setAttribute('aria-label', '立即更新 AdGuard 資料');
                button.classList.remove('opacity-60');
                icon?.classList.remove('animate-spin');
            }
        }
        async function toggleAdgProtection() {
            if (adgProtectionOn === null) return;
            if (adgProtectionOn && !confirm('確定要暫停 AdGuard 全網 DNS 防護？\n暫停期間廣告與追蹤將不被攔截。')) return;
            try {
                await fetch('/api/adguard/protection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !adgProtectionOn }) });
                showToast(adgProtectionOn ? 'AdGuard 保護已暫停' : 'AdGuard 保護已恢復');
                fetchAdguard();
            } catch { showToast('操作失敗', true); }
        }

        /* ==================== Linux 小主機 ==================== */
        let lnxChart = null, lnxRangeHours = 24;
        async function fetchLinux() {
            try {
                const d = await (await fetch('/api/linux/stats')).json();
                const badge = document.getElementById('lnx-status');
                if (d.source !== 'ssh') {
                    badge.textContent = d.source === 'not_configured' ? '未設定' : '連線失敗';
                    badge.className = 'px-3 py-1 rounded-full text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/25';
                    return;
                }
                badge.textContent = '● 連線正常';
                badge.className = 'px-3 py-1 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
                document.getElementById('lnx-hostname').textContent = d.hostname || '';
                document.getElementById('lnx-cpu').textContent = d.cpuUsage ?? '--';
                document.getElementById('lnx-temp').textContent = d.cpuTemp ?? '--';
                document.getElementById('lnx-temp-wrap').style.color = tempColor(d.cpuTemp);
                document.getElementById('lnx-mem').textContent = d.memUsagePct ?? '--';
                document.getElementById('lnx-mem-str').textContent = d.memStr || '';
                document.getElementById('lnx-disk').textContent = d.diskUsagePct ?? '--';
                document.getElementById('lnx-disk-str').textContent = d.diskStr || '';
                document.getElementById('lnx-load').textContent = d.load ? d.load[0].toFixed(2) : '--';
                document.getElementById('lnx-uptime').textContent = d.uptime || '--';
            } catch (error) { dbg('Linux', '即時狀態讀取失敗', error); }
        }
        async function fetchLnxChart() {
            try {
                const d = await (await fetch(`/api/linux/history?hours=${lnxRangeHours}`)).json();
                const pts = d.data || [];
                const plotted = downsampleRows(pts, ['cpu', 'temp', 'mem']);
                const fmt = p => lnxRangeHours > 24
                    ? new Date(p.t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) + ' ' + new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
                    : new Date(p.t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
                if (!lnxChart) {
                    lnxChart = new Chart(document.getElementById('lnxChart'), {
                        type: 'line',
                        data: { labels: [], datasets: [
                            { label: 'CPU %', data: [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.08)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: .3 },
                            { label: '溫度 °C', data: [], borderColor: '#f59e0b', borderWidth: 1.5, pointRadius: 0, tension: .3 },
                            { label: '記憶體 %', data: [], borderColor: '#8b5cf6', borderWidth: 1.5, pointRadius: 0, tension: .3 }
                        ] },
                        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: '#94a3b8', boxWidth: 20, boxHeight: 2, font: { size: 10 } } } }, scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 9 } }, grid: { color: 'rgba(51,65,85,.2)' } }, y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(51,65,85,.2)' } } } }
                    });
                }
                lnxChart.data.labels = plotted.map(fmt);
                lnxChart.data.datasets[0].data = plotted.map(p => p.cpu);
                lnxChart.data.datasets[1].data = plotted.map(p => p.temp);
                lnxChart.data.datasets[2].data = plotted.map(p => p.mem);
                updateChartWithEntrance(lnxChart);
            } catch (error) { dbg('Linux', '歷史圖讀取失敗', error); }
        }
        function setLnxRange(hours, btn) {
            lnxRangeHours = hours;
            document.querySelectorAll('.lnx-range-btn').forEach(b => b.className = 'lnx-range-btn px-2 py-1 rounded-md font-bold text-slate-400 hover:text-slate-200 transition');
            btn.className = 'lnx-range-btn px-2 py-1 rounded-md font-bold bg-blue-600 text-white transition';
            requestChartReplay(lnxChart);
            fetchLnxChart();
        }

        function setWiimChartWin(minutes, btn) {
            const btns = document.querySelectorAll('.wiim-win-btn');
            btns.forEach(b => {
                b.className = 'wiim-win-btn px-2.5 py-1 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded-lg transition';
            });
            btn.className = 'wiim-win-btn px-2.5 py-1 bg-blue-600/20 border border-blue-500/30 text-blue-400 rounded-lg transition font-bold';
            wiimChartWindowMinutes = minutes;
            requestChartReplay(wiimChart);
            renderWiimChart();
        }


/* Static HTML actions are external code; element attributes contain only opaque IDs. */
const STATIC_EVENT_HANDLERS = Object.freeze({
    "h1"(event) { toggleSidebar(false) },
    "h2"(event) { navigate('overview') },
    "h3"(event) { navigate('clients') },
    "h4"(event) { navigate('security') },
    "h5"(event) { navigate('wifi') },
    "h6"(event) { navigate('cloud') },
    "h7"(event) { navigate('ucg') },
    "h8"(event) { navigate('nas') },
    "h9"(event) { navigate('wiim') },
    "h10"(event) { navigate('ups') },
    "h11"(event) { navigate('adguard') },
    "h12"(event) { navigate('linuxhost') },
    "h13"(event) { navigate('tools') },
    "h14"(event) { navigate('notify') },
    "h15"(event) { navigate('settings') },
    "h16"(event) { toggleSidebar(true) },
    "h17"(event) { dismissCritAlerts() },
    "h18"(event) { toggleLayoutEdit() },
    "h19"(event) { toggleTheme() },
    "h20"(event) { logoutPanel() },
    "h21"(event) { document.getElementById('ov-vitals').scrollIntoView({behavior:'smooth'}) },
    "h22"(event) { document.getElementById('hw-detail').scrollIntoView({behavior:'smooth'}) },
    "h23"(event) { setTrendRange(1) },
    "h24"(event) { setTrendRange(6) },
    "h25"(event) { setTrendRange(24) },
    "h26"(event) { setTrendRange(72) },
    "h27"(event) { setTrendRange(168) },
    "h28"(event) { setTrendRange(720) },
    "h29"(event) { setUcgHistWin(10, this) },
    "h30"(event) { setUcgHistWin(30, this) },
    "h31"(event) { setUcgHistWin(120, this) },
    "h32"(event) { setUcgHistWin(360, this) },
    "h33"(event) { setUcgHistWin(1440, this) },
    "h34"(event) { setUcgHistWin(10080, this) },
    "h35"(event) { downloadUcgHistCsv() },
    "h36"(event) { saveAdguardServicePolicy() },
    "h37"(event) { filterClients() },
    "h38"(event) { toggleAutoDefense(this.checked) },
    "h39"(event) { resetSecStats() },
    "h40"(event) { renderThreatTable() },
    "h41"(event) { renderThreatTable() },
    "h42"(event) { setThreatTimeFilter(1) },
    "h43"(event) { setThreatTimeFilter(3) },
    "h44"(event) { setThreatTimeFilter(7) },
    "h45"(event) { setThreatTimeFilter(30) },
    "h46"(event) { exportThreatsCSV() },
    "h47"(event) { updateGuestQR() },
    "h48"(event) { switchCloudTab('sites') },
    "h49"(event) { switchCloudTab('devices') },
    "h50"(event) { switchCloudTab('hosts') },
    "h51"(event) { switchCloudTab('sdwan') },
    "h52"(event) { setNasHistWin(10, this) },
    "h53"(event) { setNasHistWin(30, this) },
    "h54"(event) { setNasHistWin(60, this) },
    "h55"(event) { setNasHistWin(360, this) },
    "h56"(event) { setNasHistWin(1440, this) },
    "h57"(event) { setNasHistWin(10080, this) },
    "h58"(event) { fetchNasDocker() },
    "h59"(event) { saveAlertConfig() },
    "h60"(event) { fetchNasAlerts() },
    "h61"(event) { refreshAdguardNow() },
    "h62"(event) { toggleAdgProtection() },
    "h63"(event) { setLnxRange(1, this) },
    "h64"(event) { setLnxRange(6, this) },
    "h65"(event) { setLnxRange(24, this) },
    "h66"(event) { setLnxRange(168, this) },
    "h67"(event) { triggerSpeedtest() },
    "h68"(event) { triggerPoECycle() },
    "h69"(event) { setNotifChannel('discord') },
    "h70"(event) { setNotifChannel('telegram') },
    "h71"(event) { setNotifChannel('generic') },
    "h72"(event) { subscribeWebPush() },
    "h73"(event) { unsubscribeWebPush() },
    "h74"(event) { detectChatId() },
    "h75"(event) { event.preventDefault() },
    "h76"(event) { saveNotifSettings() },
    "h77"(event) { testNotif() },
    "h78"(event) { fetchNotifLog() },
    "h79"(event) { setTheme('dark') },
    "h80"(event) { setTheme('light') },
    "h81"(event) { resetLayout() },
    "h82"(event) { fetchSystemStatus() },
    "h83"(event) { saveConnections() },
    "h84"(event) { downloadConfigBackup() },
    "h85"(event) { stageConfigRestore(this) },
    "h86"(event) { toggleReportHour2() },
    "h87"(event) { runReportNow() },
    "h88"(event) { fetchReportLog() },
    "h89"(event) { saveServerSettings() },
    "h90"(event) { wiimSeekStart(event) },
    "h91"(event) { wiimSeekMove(event) },
    "h92"(event) { wiimSeekEnd(event) },
    "h93"(event) { wiimSeekCancel(event) },
    "h94"(event) { toggleWiimCat(event) },
    "h95"(event) { wiimCmd('setPlayerCmd:prev') },
    "h96"(event) { wiimCmd('setPlayerCmd:onepause') },
    "h97"(event) { wiimCmd('setPlayerCmd:next') },
    "h98"(event) { wiimCmd('setPlayerCmd:stop') },
    "h99"(event) { wiimToggleMute() },
    "h100"(event) { wiimStepVolume(-1) },
    "h101"(event) { previewWiimVolume(this.value) },
    "h102"(event) { commitWiimVolume(this.value) },
    "h103"(event) { wiimStepVolume(1) },
    "h104"(event) { wiimCmd('setPlayerCmd:loopmode:0') },
    "h105"(event) { wiimCmd('setPlayerCmd:loopmode:-1') },
    "h106"(event) { wiimCmd('setPlayerCmd:loopmode:1') },
    "h107"(event) { wiimCmd('setPlayerCmd:loopmode:2') },
    "h108"(event) { wiimSwitchSource('wifi') },
    "h109"(event) { wiimSwitchSource('bluetooth') },
    "h110"(event) { wiimSwitchSource('line-in') },
    "h111"(event) { wiimSwitchSource('optical') },
    "h112"(event) { wiimSwitchSource('co-axial') },
    "h113"(event) { wiimSwitchSource('udisk') },
    "h114"(event) { toggleWiimDots() },
    "h115"(event) { renderWiimChart() },
    "h116"(event) { setWiimChartWin(10, this) },
    "h117"(event) { setWiimChartWin(30, this) },
    "h118"(event) { setWiimChartWin(120, this) },
    "h119"(event) { setWiimChartWin(720, this) },
    "h120"(event) { setWiimChartWin(0, this) },
    "h121"(event) { downloadWiimCsv() },
    "h122"(event) { wiimClearHistory() },
    "h123"(event) { saveWiimAlerts() },
    "h124"(event) { switchWiimSubTab('audio', this) },
    "h125"(event) { switchWiimSubTab('eq', this) },
    "h126"(event) { switchWiimSubTab('source', this) },
    "h127"(event) { switchWiimSubTab('bt', this) },
    "h128"(event) { switchWiimSubTab('stream', this) },
    "h129"(event) { switchWiimSubTab('sys', this) },
    "h130"(event) { document.getElementById('wiim-balval').textContent = this.value },
    "h131"(event) { wiimCmd('setChannelBalance:' + this.value) },
    "h132"(event) { wiimCmd('setSpdifOutSwitchDelayMs:' + document.getElementById('wiim-spdif').value) },
    "h133"(event) { wiimGetVal('getPlayModeGainConfig', 'wiim-gain-res') },
    "h134"(event) { wiimCmd('setPlayModeGainConfig:' + encodeURIComponent(document.getElementById('wiim-gain-json').value)) },
    "h135"(event) { wiimCmd('EQOn'); setTimeout(wiimCheckEqStat, 500) },
    "h136"(event) { wiimCmd('EQOff'); setTimeout(wiimCheckEqStat, 500) },
    "h137"(event) { wiimLoadPresets() },
    "h138"(event) { wiimCheckEqStat() },
    "h139"(event) { wiimCmd('EQLoad:' + encodeURIComponent(document.getElementById('wiim-eq-list').value)) },
    "h140"(event) { wiimGetVal('EQGetBand', 'wiim-eq-res') },
    "h141"(event) { wiimCmd('EQSetBand:' + encodeURIComponent(document.getElementById('wiim-eq-band').value)) },
    "h142"(event) { wiimCmd('setPlayerCmd:switchmode:wifi') },
    "h143"(event) { wiimCmd('setPlayerCmd:switchmode:bluetooth') },
    "h144"(event) { wiimCmd('setPlayerCmd:switchmode:line-in') },
    "h145"(event) { wiimCmd('setPlayerCmd:switchmode:optical') },
    "h146"(event) { wiimCmd('setPlayerCmd:switchmode:co-axial') },
    "h147"(event) { wiimCmd('setPlayerCmd:switchmode:udisk') },
    "h148"(event) { wiimCmd('startbtdiscovery:' + document.getElementById('wiim-btsec').value) },
    "h149"(event) { wiimGetVal('getbtdiscoveryresult', 'wiim-bt-res') },
    "h150"(event) { wiimCmd('clearbtdiscoveryresult') },
    "h151"(event) { wiimGetVal('getbthistory', 'wiim-bt-res') },
    "h152"(event) { wiimGetVal('getbtpairstatus', 'wiim-bt-res') },
    "h153"(event) { wiimCmd('connectbta2dpsynk:' + document.getElementById('wiim-btmac').value) },
    "h154"(event) { wiimCmd('disconnectbta2dpsynk:' + document.getElementById('wiim-btmac').value) },
    "h155"(event) { wiimPlayUrl() },
    "h156"(event) { wiimCmd('ConnectMasterAp:JoinGroupMaster:eth' + document.getElementById('wiim-group-ip').value) },
    "h157"(event) { wiimCmd('ConnectMasterAp:JoinGroupMaster:eth0') },
    "h158"(event) { wiimGetVal('Squeezelite:getState', 'wiim-stream-res') },
    "h159"(event) { wiimCmd('Cast:EnableCast') },
    "h160"(event) { wiimCmd('Cast:DisableCast') },
    "h161"(event) { wiimGetVal('wlanGetConnectState', 'wiim-stream-res') },
    "h162"(event) { wiimCmd('reboot') },
    "h163"(event) { wiimSyncTime() },
    "h164"(event) { wiimCmd('setShutdown:' + (document.getElementById('wiim-shutdown-sec').value || 0)) },
    "h165"(event) { wiimGetVal('getShutdown', 'wiim-sys-res') },
    "h166"(event) { wiimCmd('LED_SWITCH_SET:1') },
    "h167"(event) { wiimCmd('LED_SWITCH_SET:0') },
    "h168"(event) { wiimCmd('Button_Enable_SET:1') },
    "h169"(event) { wiimCmd('Button_Enable_SET:0') },
    "h170"(event) { wiimCmd('setLightOperationBrightConfig:' + encodeURIComponent(document.getElementById('wiim-lcd-json').value)) },
    "h171"(event) { refreshWiimAccessories(this) },
    "h172"(event) { fetchWiimDeviceInfo() },
    "h173"(event) { setUpsRange(1/6, this) },
    "h174"(event) { setUpsRange(0.5, this) },
    "h175"(event) { setUpsRange(1, this) },
    "h176"(event) { setUpsRange(6, this) },
    "h177"(event) { setUpsRange(24, this) },
    "h178"(event) { setUpsRange(168, this) },
    "h179"(event) { downloadUpsCsv() },
    "h180"(event) { setUpsLoadRange(1/6, this) },
    "h181"(event) { setUpsLoadRange(0.5, this) },
    "h182"(event) { setUpsLoadRange(1, this) },
    "h183"(event) { setUpsLoadRange(6, this) },
    "h184"(event) { setUpsLoadRange(24, this) },
    "h185"(event) { setUpsLoadRange(168, this) },
    "h186"(event) { if(event.target===this)closeClientDetail() },
    "h187"(event) { closeClientDetail() },
    "h188"(event) { if(event.target===this)closeDiskSmart() },
    "h189"(event) { closeDiskSmart() },
    "h190"(event) { if(event.target===this)closeDockerLog() },
    "h191"(event) { copyDockerLog() },
    "h192"(event) { closeDockerLog() }
});
for (const eventName of ["click","input","change","pointerdown","pointermove","pointerup","pointercancel","dblclick"]) {
    document.addEventListener(eventName, event => {
        const target = event.target?.closest?.(`[data-handler-${eventName}]`);
        if (!target) return;
        const handler = STATIC_EVENT_HANDLERS[target.dataset[`handler${eventName[0].toUpperCase()}${eventName.slice(1)}`]];
        if (handler) handler.call(target, event);
    });
}

document.addEventListener('click', window.SmartHubActionDispatcher.create({
    getRole: () => document.documentElement.dataset.panelRole,
    adminActions: ['threat-block', 'threat-unblock', 'nas-alert-delete', 'adguard-policy-remove'],
    actions: {
        'copy-src-ip': data => copySrcIp(data.ip),
        'threat-block': data => requestThreatBlock(data.ip),
        'threat-unblock': data => removeThreatBlock(data.id, data.ip),
        'nas-log-filter': data => setNasLogFilter(data.filter),
        'nas-alert-delete': data => deleteAlertConfig(data.metric),
        'adguard-policy-remove': data => removeAdguardServicePolicy(data.id)
    }
}));
