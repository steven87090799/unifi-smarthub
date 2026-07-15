'use strict';

const PWA_SHELL = Object.freeze([
    '/',
    '/assets/tailwind.css',
    '/js/web-push.js',
    '/vendor/chart.js/4.5.1/chart.umd.js',
    '/vendor/d3/7.9.0/d3.min.js',
    '/vendor/topojson-client/3.1.0/topojson-client.min.js',
    '/vendor/world-atlas/2.0.2/countries-110m.json'
]);

function renderPwaServiceWorker(cacheName) {
    if (typeof cacheName !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(cacheName)) {
        throw new TypeError('cacheName must be a bounded cache-safe identifier');
    }
    return `'use strict';
const C=${JSON.stringify(cacheName)};
const SHELL=${JSON.stringify(PWA_SHELL)};
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(C).then(cache=>cache.addAll(SHELL)))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==C).map(key=>caches.delete(key)))));self.clients.claim()});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/health'))return;
  event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(C).then(cache=>cache.put(event.request,copy));return response}).catch(()=>caches.match(event.request).then(match=>match||caches.match('/'))));
});
self.addEventListener('push',event=>{
  let payload={title:'SmartHub',body:'有新的系統通知',url:'/',tag:'smarthub'};
  try{const value=event.data?event.data.json():null;if(value&&typeof value==='object')payload=value}catch{}
  const title=typeof payload.title==='string'&&payload.title?payload.title.slice(0,120):'SmartHub';
  const body=typeof payload.body==='string'?payload.body.slice(0,2000):'有新的系統通知';
  const url=typeof payload.url==='string'&&/^\\/(?!\\/)/.test(payload.url)?payload.url.slice(0,512):'/';
  const tag=typeof payload.tag==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(payload.tag)?payload.tag:'smarthub';
  event.waitUntil(self.registration.showNotification(title,{body,tag,data:{url}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const path=event.notification&&event.notification.data&&typeof event.notification.data.url==='string'?event.notification.data.url:'/';
  const target=new URL(/^\\/(?!\\/)/.test(path)?path:'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
    const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
    if(existing){if('navigate' in existing)await existing.navigate(target);return existing.focus()}
    return self.clients.openWindow(target);
  }));
});`;
}

module.exports = { PWA_SHELL, renderPwaServiceWorker };
