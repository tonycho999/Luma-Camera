import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";
import { TRANSLATIONS } from "./lang.js";
import { FilterManager } from "./js/filter.js";
import { LipstickManager } from "./js/lipstick.js";
import { AccessoryManager } from "./js/accessory.js";

const SETTINGS = {
    slimStrength: 0.3, updateInterval: 100, maxFaces: 20, lightIntensity: 0.4, 
};

// ==========================================
// [핵심] 광고 로직 설정 (10분 무료 / 하루 10회)
// ==========================================
const AD_CONFIG = {
    FREE_DURATION_MS: 10 * 60 * 1000, // 10분
    MAX_DAILY_ADS: 10 // 하루 최대 10회
};

// 로컬 스토리지 키
const KEY_AD_COUNT = 'luma_ad_count';
const KEY_AD_DATE = 'luma_ad_date';
const KEY_FREE_UNTIL = 'luma_free_until';

// 현재 상태
let currentFilter = 'none';
let currentLipColor = 'none';
let currentAcc = 'none';
let currentLang = 'en';

// DOM
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const optionBtn = document.getElementById("option-btn");
const extraControls = document.getElementById("extra-controls");
const flashEffect = document.getElementById("flash-effect");

const adModal = document.getElementById("ad-modal");
const closeAdBtn = document.getElementById("close-ad-btn");
const adCountDisplay = document.getElementById("ad-count-display");

let faceLandmarker, renderer, scene, camera, meshPlane, originalPositions;
let beautySprites = [];
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;
let isAdShowing = false;
let isAdLoaded = false;
let pendingAction = null; // 광고 후 실행할 작업

// ==========================================
// 1. 광고 및 프리미엄 체크 로직
// ==========================================
function checkPremiumStatus() {
    const now = Date.now();
    const today = new Date().toDateString();
    
    // 1. 날짜가 바뀌었으면 카운트 초기화
    const lastDate = localStorage.getItem(KEY_AD_DATE);
    if (lastDate !== today) {
        localStorage.setItem(KEY_AD_DATE, today);
        localStorage.setItem(KEY_AD_COUNT, '0');
    }

    const count = parseInt(localStorage.getItem(KEY_AD_COUNT) || '0');
    const freeUntil = parseInt(localStorage.getItem(KEY_FREE_UNTIL) || '0');

    // [조건 1] 이미 하루 10번 다 봤으면 -> 무제한 무료
    if (count >= AD_CONFIG.MAX_DAILY_ADS) return true;

    // [조건 2] 무료 시간(10분)이 아직 안 끝났으면 -> 무료
    if (now < freeUntil) return true;

    // 아니면 광고 봐야 함
    return false;
}

function showAdIfNeeded(callback) {
    if (checkPremiumStatus()) {
        callback(); // 무료 상태면 바로 실행
    } else {
        pendingAction = callback; // 광고 보고 나서 실행할 함수 저장
        
        // 현재 카운트 표시
        const count = localStorage.getItem(KEY_AD_COUNT) || '0';
        adCountDisplay.innerText = count;
        
        // 광고 팝업 띄우기
        isAdShowing = true;
        adModal.style.display = 'flex';
        
        if (!isAdLoaded) {
            try { (window.adsbygoogle = window.adsbygoogle || []).push({}); isAdLoaded = true; } 
            catch (e) {}
        }
    }
}

// 광고 닫기 버튼 (광고 시청 완료 처리)
closeAdBtn.addEventListener('click', () => {
    isAdShowing = false;
    adModal.style.display = 'none';

    // 1. 카운트 증가
    let count = parseInt(localStorage.getItem(KEY_AD_COUNT) || '0');
    count++;
    localStorage.setItem(KEY_AD_COUNT, count.toString());

    // 2. 10분 무료 시간 부여
    const freeUntil = Date.now() + AD_CONFIG.FREE_DURATION_MS;
    localStorage.setItem(KEY_FREE_UNTIL, freeUntil.toString());

    // 3. 미뤄뒀던 작업 실행 (메뉴 열기 or 기능 적용)
    if (pendingAction) {
        pendingAction();
        pendingAction = null;
    }
});


// ==========================================
// 2. UI 이벤트 (옵션 버튼 & 기능 버튼)
// ==========================================

// 옵션 버튼 누르면 -> 광고 체크 -> 메뉴 열기
optionBtn.addEventListener('click', () => {
    if (extraControls.style.display === 'block') {
        extraControls.style.display = 'none'; // 닫는 건 그냥 닫음
    } else {
        showAdIfNeeded(() => {
            extraControls.style.display = 'block'; // 광고 통과해야 열림
        });
    }
});

// 슬라이더/버튼 기능 적용 함수
const applyFilter = (val) => { currentFilter = val; FilterManager.applyFilter(canvasElement, val); };
const applyLip = (val) => { currentLipColor = val; LipstickManager.setColor(val); };
const applyAcc = (val) => { currentAcc = val; AccessoryManager.setAccessory(val); };
const updateUI = () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter));
    document.querySelectorAll('.color-btn').forEach(b => b.classList.toggle('active', b.dataset.color === currentLipColor));
    document.querySelectorAll('.acc-btn').forEach(b => b.classList.toggle('active', b.dataset.acc === currentAcc));
};

// 기능 버튼들 클릭 이벤트 (광고 체크 포함)
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyFilter(btn.dataset.filter); updateUI(); }));
});
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyLip(btn.dataset.color); updateUI(); }));
});
document.querySelectorAll('.acc-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyAcc(btn.dataset.acc); updateUI(); }));
});

// 슬라이더는 사용성 문제로 광고 없이 즉시 적용 (너무 자주 뜨면 불편함)
document.getElementById('slim-range').addEventListener('input', (e) => SETTINGS.slimStrength = (1.0 - parseFloat(e.target.value)) / 0.15);
document.getElementById('beauty-range').addEventListener('input', (e) => SETTINGS.lightIntensity = (parseInt(e.target.value) - 100) / 50 * 0.8);


// ==========================================
// 3. 카메라 & 촬영 (비율/저장 개선)
// ==========================================
async function startWebcam() {
    if (currentStream) currentStream.getTracks().forEach(track => track.stop());
    
    // [개선] 화면 비율에 맞춰서 최대 해상도 요청
    const constraints = {
        video: {
            facingMode: isFrontCamera ? "user" : "environment",
            width: { ideal: 4096 }, // 가능한 최대 해상도
            height: { ideal: 2160 },
            // 모바일 화면 비율에 맞추기 시도
            aspectRatio: { ideal: window.innerHeight / window.innerWidth }
        }
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentStream = stream;
        video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); adjustVideoLayout(); renderLoop(); };
    } catch (err) {
        console.error("Camera Error:", err);
        alert("카메라를 실행할 수 없습니다.");
    }
}

// [개선] 촬영 로직 (플래시 + 즉시 저장)
captureBtn.addEventListener('click', () => {
    // 1. 플래시 효과
    flashEffect.style.animation = 'none';
    flashEffect.offsetHeight; // reflow
    flashEffect.style.animation = 'flashAnim 0.3s';

    // 2. 렌더링
    renderer.render(scene, camera);
    
    // 3. 다운로드 (배경 저장)
    const link = document.createElement('a');
    // 파일명에 시간 추가 (중복 방지)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `Luma_${timestamp}.png`;
    link.href = renderer.domElement.toDataURL("image/png");
    link.click(); // 즉시 다운로드 트리거
    
    // 4. 별도 팝업 없음 -> 바로 다음 촬영 가능
});

function adjustVideoLayout() {
    if (!video || video.videoWidth === 0) return;
    // CSS object-fit: cover와 유사하게 Three.js Plane 비율 조정
    const videoRatio = video.videoWidth / video.videoHeight;
    const screenRatio = window.innerWidth / window.innerHeight;
    let scaleX = 1, scaleY = 1;
    
    // 화면을 꽉 채우도록 스케일링 (Crop)
    if (screenRatio < videoRatio) {
        scaleX = videoRatio / screenRatio;
    } else {
        scaleY = screenRatio / videoRatio;
    }
    meshPlane.scale.set(scaleX * (isFrontCamera ? -1 : 1), scaleY, 1);
}

// ... (Three.js 초기화, FaceLandmarker 로직 등은 기존과 동일하므로 생략하지 않고 포함) ...

function initThreeJS() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene = new THREE.Scene();
    const aspect = width / height;
    camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 100);
    camera.position.z = 10;
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    const geometry = new THREE.PlaneGeometry(aspect * 2, 2, 64, 64);
    originalPositions = new Float32Array(geometry.attributes.position.count * 3);
    originalPositions.set(geometry.attributes.position.array);
    meshPlane = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: videoTexture, side: THREE.DoubleSide }));
    scene.add(meshPlane);
    
    createBeautyLightsPool();
    LipstickManager.init(scene);
    AccessoryManager.init(scene);
    
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        const asp = window.innerWidth / window.innerHeight;
        camera.left = -asp; camera.right = asp;
        camera.updateProjectionMatrix();
        adjustVideoLayout();
    });
}

function createBeautyLightsPool() {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(64,64,0,64,64,64);
    grd.addColorStop(0,'rgba(255,255,255,0.5)'); grd.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = grd; ctx.fillRect(0,0,128,128);
    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false });
    for(let i=0; i<SETTINGS.maxFaces; i++) {
        const s = new THREE.Sprite(mat.clone()); s.scale.set(0,0,1); scene.add(s); beautySprites.push(s);
    }
}

function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);
    if (isAdShowing) return;
    if (timestamp - lastUpdateTime < SETTINGS.updateInterval) return;
    lastUpdateTime = timestamp;
    
    let results;
    if (video.readyState >= 2 && faceLandmarker) results = faceLandmarker.detectForVideo(video, performance.now());
    
    meshPlane.geometry.attributes.position.array.set(originalPositions);
    beautySprites.forEach(s => s.scale.set(0,0,1));
    
    if (results?.faceLandmarks?.length > 0) {
        results.faceLandmarks.forEach((lm, i) => {
            applyFaceWarping(lm, meshPlane.geometry.attributes.position.array);
            if(i < beautySprites.length) { updateBeautyPosition(lm, beautySprites[i]); beautySprites[i].material.opacity = SETTINGS.lightIntensity; }
            if(i === 0) {
                if(currentLipColor !== 'none') LipstickManager.updatePosition(lm, camera, isFrontCamera);
                if(currentAcc !== 'none') AccessoryManager.updatePosition(lm, camera, isFrontCamera);
            }
        });
    }
    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

// ... (applyFaceWarping, updateBeautyPosition, createFaceLandmarker 로직은 기존 유지) ...
// (코드 길이상 생략된 부분은 이전에 작성된 함수 그대로 사용하시면 됩니다.)
function applyFaceWarping(landmarks, positions) { if (SETTINGS.slimStrength <= 0.01) return; const width = camera.right - camera.left; const height = camera.top - camera.bottom; function toWorld(lm) { return { x: (lm.x - 0.5) * width, y: -(lm.y - 0.5) * height }; } const chin = toWorld(landmarks[152]); const nose = toWorld(landmarks[1]); const faceWidth = Math.abs(toWorld(landmarks[234]).x - toWorld(landmarks[454]).x); const radius = faceWidth * 1.3; const force = SETTINGS.slimStrength * 0.2; for (let i = 0; i < positions.length; i += 3) { const vx = positions[i]; const vy = positions[i+1]; if (Math.abs(vx - chin.x) > radius || Math.abs(vy - chin.y) > radius) continue; const dx = vx - chin.x; const dy = vy - chin.y; const distSq = dx*dx + dy*dy; if (distSq < radius * radius) { const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4))); positions[i] += (nose.x - vx) * factor * force; positions[i+1] += (nose.y - vy) * factor * force * 0.5; } } }
function updateBeautyPosition(landmarks, sprite) { if (!sprite) return; const width = camera.right - camera.left; const height = camera.top - camera.bottom; let noseX = (landmarks[1].x - 0.5) * width; const noseY = -(landmarks[1].y - 0.5) * height; if (isFrontCamera) noseX = -noseX; const leftEar = (landmarks[234].x - 0.5) * width; const rightEar = (landmarks[454].x - 0.5) * width; const faceW = Math.abs(rightEar - leftEar); sprite.position.set(noseX, noseY, 0.1); const size = faceW * 4.0; sprite.scale.set(size, size, 1); }
async function createFaceLandmarker() { const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm"); faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, { baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" }, outputFaceBlendshapes: false, runningMode: "VIDEO", numFaces: SETTINGS.maxFaces }); startWebcam(); }

// 초기화
initThreeJS();
createFaceLandmarker();
switchBtn.addEventListener('click', () => { isFrontCamera = !isFrontCamera; startWebcam(); });
