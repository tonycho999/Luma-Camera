import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";
import { TRANSLATIONS } from "./lang.js";

// [NEW] 기능별 모듈 불러오기
import { FilterManager } from "./js/filter.js";
import { LipstickManager } from "./js/lipstick.js";
import { AccessoryManager } from "./js/accessory.js";

// ==========================================
// [설정] 뷰티 + 필터 + 메이크업 + AR
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    updateInterval: 100, 
    maxFaces: 20,
    lightIntensity: 0.4, 
};

// [현재 상태 & 잠금 여부]
let currentFilter = 'none';
let currentLipColor = 'none';
let currentAcc = 'none';

let isMultiUnlocked = false;    
let isFilterUnlocked = false;
let isLipUnlocked = false;
let isAccUnlocked = false;

let currentLang = 'en';

// DOM Elements
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const installBtn = document.getElementById("install-btn");

const labelSlim = document.getElementById("label-slim");
const labelBeauty = document.getElementById("label-beauty");
const labelFilter = document.getElementById("label-filter");
const labelLip = document.getElementById("label-lip");
const labelAcc = document.getElementById("label-acc");

const langBtns = document.querySelectorAll(".lang-btn");
const filterBtns = document.querySelectorAll(".filter-btn");
const colorBtns = document.querySelectorAll(".color-btn");
const accBtns = document.querySelectorAll(".acc-btn");

const adModal = document.getElementById("ad-modal");
const adTitle = document.getElementById("ad-title");
const adDesc = document.getElementById("ad-desc");
const closeAdBtn = document.getElementById("close-ad-btn");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;
let isAdShowing = false;
let adTriggerSource = "";       
let isAdLoaded = false; // [FIX] 광고 로딩 체크 변수

// Three.js variables
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let beautySprites = []; 

let videoAspect = 1.0; 
let screenAspect = 1.0;

// ==========================================
// 0. 언어 & UI 초기화
// ==========================================
function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) lang = 'en'; // fallback
    currentLang = lang;
    const t = TRANSLATIONS[lang];
    
    labelSlim.innerText = t.slim;
    labelBeauty.innerText = t.beauty;
    labelFilter.innerText = t.filter;
    labelLip.innerText = t.lip;
    labelAcc.innerText = t.acc;
    closeAdBtn.innerText = t.ad_close;
    if(installBtn) installBtn.innerText = t.install;

    langBtns.forEach(btn => {
        if(btn.dataset.lang === lang) btn.classList.add("active");
        else btn.classList.remove("active");
    });
}

function detectAndSetLanguage() {
    const userLang = navigator.language || navigator.userLanguage; 
    if (userLang.startsWith('ko')) setLanguage('ko');
    else setLanguage('en'); 
}

// ==========================================
// 1. Three.js 초기화
// ==========================================
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
    
    // [NEW] 모듈 초기화
    LipstickManager.init(scene);
    AccessoryManager.init(scene);

    applyFeatures(); 
    detectAndSetLanguage();
    window.addEventListener('resize', onWindowResize);
}

function createBeautyLightsPool() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255, 255, 255, 0.5)'); 
    grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false });
    for(let i=0; i<SETTINGS.maxFaces; i++) {
        const sprite = new THREE.Sprite(mat.clone()); sprite.scale.set(0,0,1);
        scene.add(sprite); beautySprites.push(sprite);
    }
}

function onWindowResize() {
    const width = window.innerWidth; const height = window.innerHeight;
    renderer.setSize(width, height);
    const aspect = width / height;
    camera.left = -aspect; camera.right = aspect;
    camera.updateProjectionMatrix();
    adjustVideoLayout();
}

function adjustVideoLayout() {
    if (!video || video.videoWidth === 0) return;
    videoAspect = video.videoWidth / video.videoHeight;
    screenAspect = window.innerWidth / window.innerHeight;
    let sx = 1, sy = 1;
    if (screenAspect < videoAspect) sx = videoAspect / screenAspect;
    else sy = screenAspect / videoAspect;
    meshPlane.scale.set(sx * (isFrontCamera ? -1 : 1), sy, 1);
}

// ==========================================
// 2. AI & Webcam
// ==========================================
async function createFaceLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" },
        outputFaceBlendshapes: false, runningMode: "VIDEO", numFaces: SETTINGS.maxFaces 
    });
    startWebcam();
}

function startWebcam() {
    if (currentStream) currentStream.getTracks().forEach(track => track.stop());
    navigator.mediaDevices.getUserMedia({ video: { facingMode: isFrontCamera ? "user" : "environment", width: { ideal: 1280 }, height: { ideal: 720 } } }).then((stream) => {
        currentStream = stream; video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); adjustVideoLayout(); renderLoop(); };
    });
}

// ==========================================
// 3. 렌더링 루프
// ==========================================
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);
    if (isAdShowing) return;
    if (timestamp - lastUpdateTime < SETTINGS.updateInterval) return;
    lastUpdateTime = timestamp;

    let results;
    if (video.readyState >= 2 && faceLandmarker) results = faceLandmarker.detectForVideo(video, performance.now());

    meshPlane.geometry.attributes.position.array.set(originalPositions);
    beautySprites.forEach(s => s.scale.set(0,0,1));
    
    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        if (results.faceLandmarks.length >= 2 && !isMultiUnlocked) { showAdModal('multi'); return; }

        results.faceLandmarks.forEach((landmarks, index) => {
            applyFaceWarping(landmarks, meshPlane.geometry.attributes.position.array);
            
            if (index < beautySprites.length) {
                updateBeautyPosition(landmarks, beautySprites[index]);
                beautySprites[index].material.opacity = SETTINGS.lightIntensity;
            }
            
            // 첫 번째 얼굴에만 립스틱/액세서리 위치 업데이트
            if (index === 0) {
                if (currentLipColor !== 'none') {
                    LipstickManager.updatePosition(landmarks, camera, isFrontCamera);
                }
                if (currentAcc !== 'none') {
                    AccessoryManager.updatePosition(landmarks, camera, isFrontCamera);
                }
            }
        });
    }
    
    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}


// ==========================================
// 4. 기능 적용 & 이벤트 핸들러
// ==========================================

function updateUIActiveState() {
    filterBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.filter === currentFilter));
    colorBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.color === currentLipColor));
    accBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.acc === currentAcc));
    
    if(isFilterUnlocked) filterBtns.forEach(btn => btn.classList.remove('locked'));
    if(isLipUnlocked) colorBtns.forEach(btn => btn.classList.remove('locked'));
    if(isAccUnlocked) accBtns.forEach(btn => btn.classList.remove('locked'));
}

function applyFeatures() {
    FilterManager.applyFilter(canvasElement, currentFilter);
    LipstickManager.setColor(currentLipColor);
    AccessoryManager.setAccessory(currentAcc);
    updateUIActiveState();
}

filterBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('filter', btn.dataset.filter)));
colorBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('lip', btn.dataset.color)));
accBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('acc', btn.dataset.acc)));

function handleFeatureClick(type, value) {
    if (value === 'none') { 
        if(type === 'filter') currentFilter = value;
        if(type === 'lip') currentLipColor = value;
        if(type === 'acc') currentAcc = value;
        applyFeatures();
        return;
    }

    if (type === 'filter' && !isFilterUnlocked) { showAdModal('filter'); return; }
    if (type === 'lip' && !isLipUnlocked) { showAdModal('lip'); return; }
    if (type === 'acc' && !isAccUnlocked) { showAdModal('acc'); return; }

    if(type === 'filter') currentFilter = value;
    if(type === 'lip') currentLipColor = value;
    if(type === 'acc') currentAcc = value;
    applyFeatures();
}

// [FIX] 광고 팝업: 에러 수정 적용됨
function showAdModal(source) {
    adTriggerSource = source; 
    const t = TRANSLATIONS[currentLang];
    
    if (source === 'multi') { adTitle.innerText = t.ad_multi_title; adDesc.innerText = t.ad_multi_desc; }
    else if (source === 'filter') { adTitle.innerText = t.ad_filter_title; adDesc.innerText = t.ad_filter_desc; }
    else if (source === 'lip') { adTitle.innerText = t.ad_lip_title; adDesc.innerText = t.ad_lip_desc; }
    else if (source === 'acc') { adTitle.innerText = t.ad_acc_title; adDesc.innerText = t.ad_acc_desc; }
    
    isAdShowing = true;
    adModal.style.display = "flex"; // 1. 먼저 창을 띄움 (너비 확보)
    
    // 2. 그 다음 광고 요청 (딱 한 번만 실행)
    if (!isAdLoaded) {
        try {
            (window.adsbygoogle = window.adsbygoogle || []).push({});
            isAdLoaded = true;
            console.log("AdSense loaded");
        } catch (e) {
            console.log("AdSense error (ignored):", e);
        }
    }
}

closeAdBtn.addEventListener('click', () => {
    isAdShowing = false;
    adModal.style.display = "none";
    if (adTriggerSource === 'multi') isMultiUnlocked = true;
    else if (adTriggerSource === 'filter') { isFilterUnlocked = true; }
    else if (adTriggerSource === 'lip') { isLipUnlocked = true; }
    else if (adTriggerSource === 'acc') { isAccUnlocked = true; }
    updateUIActiveState();
});

// 기타 이벤트
langBtns.forEach(btn => btn.addEventListener('click', () => setLanguage(btn.dataset.lang)));
slimRange.addEventListener('input', (e) => SETTINGS.slimStrength = (1.0 - parseFloat(e.target.value)) / 0.15);
beautyRange.addEventListener('input', (e) => SETTINGS.lightIntensity = (parseInt(e.target.value) - 100) / 50 * 0.8);
switchBtn.addEventListener('click', () => { isFrontCamera = !isFrontCamera; startWebcam(); });
captureBtn.addEventListener('click', () => { renderer.render(scene, camera); const link = document.createElement('a'); link.download = `luma_capture.png`; link.href = renderer.domElement.toDataURL("image/png"); link.click(); });
let deferredPrompt; window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; if (!window.matchMedia('(display-mode: standalone)').matches) installBtn.style.display = 'block'; });
installBtn.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt = null; installBtn.style.display = 'none'; });

// 워핑 함수
function applyFaceWarping(landmarks, positions) {
    if (SETTINGS.slimStrength <= 0.01) return;
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    function toWorld(lm) { return { x: (lm.x - 0.5) * width, y: -(lm.y - 0.5) * height }; }
    const chin = toWorld(landmarks[152]);
    const nose = toWorld(landmarks[1]);
    const faceWidth = Math.abs(toWorld(landmarks[234]).x - toWorld(landmarks[454]).x);
    const radius = faceWidth * 1.3;
    const force = SETTINGS.slimStrength * 0.2;
    for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i+1];
        if (Math.abs(vx - chin.x) > radius || Math.abs(vy - chin.y) > radius) continue;
        const dx = vx - chin.x;
        const dy = vy - chin.y;
        const distSq = dx*dx + dy*dy;
        if (distSq < radius * radius) {
            const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4)));
            positions[i] += (nose.x - vx) * factor * force;
            positions[i+1] += (nose.y - vy) * factor * force * 0.5;
        }
    }
}

// 조명 위치 함수
function updateBeautyPosition(landmarks, sprite) {
    if (!sprite) return;
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    let noseX = (landmarks[1].x - 0.5) * width;
    const noseY = -(landmarks[1].y - 0.5) * height;
    if (isFrontCamera) noseX = -noseX;
    const leftEar = (landmarks[234].x - 0.5) * width;
    const rightEar = (landmarks[454].x - 0.5) * width;
    const faceW = Math.abs(rightEar - leftEar);
    sprite.position.set(noseX, noseY, 0.1);
    const size = faceW * 4.0;
    sprite.scale.set(size, size, 1);
}

initThreeJS();
createFaceLandmarker();
