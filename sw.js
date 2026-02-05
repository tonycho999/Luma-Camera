// 캐시 이름 (앱을 업데이트할 때 숫자를 올려주세요: v1 -> v2)
const CACHE_NAME = 'luma-cache-v1';

// 오프라인에서 실행하기 위해 저장해둘 파일 목록
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  
  // 아이콘들
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-180.png',
  
  // [중요] AI 모델 파일
  './assets/models/face_landmarker.task',

  // [추가됨] 오프라인용 MediaPipe 라이브러리
  './assets/libs/vision_bundle.js' 
];

// 1. 설치 (Install)
self.addEventListener('install', (event) => {
  console.log('[Service Worker] 설치 중...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] 파일 캐싱 시작');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. 활성화 (Activate)
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] 활성화 중...');
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] 구버전 캐시 삭제:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// 3. 요청 가로채기 (Fetch)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response; // 캐시에서 반환
      }
      return fetch(event.request); // 인터넷에서 다운로드
    })
  );
});
