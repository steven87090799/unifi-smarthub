// 儘早套用主題，避免載入閃爍
        if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light');
        // 註冊 Service Worker (PWA 可安裝 + 離線殼層)
        if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
