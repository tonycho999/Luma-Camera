// [중요] 버전을 v2로 올려야 새 파일을 받아옵니다!
const CACHE_NAME = 'luma-cache-v2';

// 오프라인 저장 목록
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  
  // 아이콘
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-180.png',
  
  // AI 모델 & 엔진
  './assets/models/face_landmarker.task',
  './assets/libs/vision_bundle.js',
  './assets/libs/wasm/vision_wasm_internal.js',
  './assets/libs/wasm/vision_wasm_internal.wasm',
  
  // [추가됨] 3D 엔진 (이제 오프라인에서도 됩니다!)
  './assets/libs/three.min.js'
];

// 설치
self.addEventListener('install', (event) => {
  console.log('[Service Worker] 설치 및 캐싱 중...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 활성화 (구버전 청소)
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] 활성화 및 구버전 정리...');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] 삭제됨:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// 요청 가로채기
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
