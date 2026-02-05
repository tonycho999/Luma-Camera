// 캐시 이름 (앱을 업데이트할 때 'v2', 'v3'로 숫자를 올려주면 새 버전이 반영됩니다)
const CACHE_NAME = 'luma-cache-v1';

// 오프라인에서 실행하기 위해 저장해둘 파일 목록
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
  
  // [중요] AI 모델 파일 (이게 없으면 오프라인 얼굴 인식 불가)
  './assets/models/face_landmarker.task'
];

// 1. 설치 (Install): 파일들을 캐시에 저장
self.addEventListener('install', (event) => {
  console.log('[Service Worker] 설치 중...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] 파일 캐싱 시작');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  // 대기하지 않고 바로 활성화
  self.skipWaiting();
});

// 2. 활성화 (Activate): 구버전 캐시 정리
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
  // 페이지를 다시 로드하지 않아도 즉시 제어권 가져오기
  return self.clients.claim();
});

// 3. 요청 가로채기 (Fetch): 인터넷 대신 캐시에서 파일 꺼내주기
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // 1) 캐시에 파일이 있으면 그거 반환 (오프라인 동작)
      if (response) {
        return response;
      }
      // 2) 없으면 인터넷에서 가져오기
      return fetch(event.request);
    })
  );
});
