import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";
import { TRANSLATIONS } from "./lang.js";
import { FilterManager } from "./js/filter.js";
import { LipstickManager } from "./js/lipstick.js";
import { AccessoryManager } from "./js/accessory.js";

const SETTINGS = {
    slimStrength: 0.3, updateInterval: 100, maxFaces: 20, lightIntensity: 0.4, 
};

// 광고 설정
const AD_CONFIG = { FREE_DURATION_MS: 10 * 60 * 1000, MAX_DAILY_ADS: 10 };
const KEY_AD_COUNT = 'luma_ad_count';
const KEY_AD_DATE = 'luma_ad_date';
const KEY_FREE_UNTIL = 'luma_free_until';

let currentFilter = 'none';
let currentLipColor = 'none';
let currentAcc = 'none';
let currentLang = 'en';

// DOM Elements
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const installBtn = document.getElementById("install-btn");
const optionBtn = document.getElementById("option-btn");
const extraControls = document.getElementById("extra-controls");
const flashEffect = document.getElementById("flash-effect");

// UI Labels (번역용)
const labelSlim = document.getElementById("label-slim");
const labelBeauty = document.getElementById("label-beauty");
const titleBeauty = document.getElementById("title-beauty");
const titleMakeup = document.getElementById("title-makeup");

// Buttons Text (번역용)
const btnFNorm = document.getElementById("btn-f-norm");
const btnFVin = document.getElementById("btn-f-vin");
const btnFMono = document.getElementById("btn-f-mono");
const btnANone = document.getElementById("btn-a-none");
const btnANose = document.getElementById("btn-a-nose");

// Ad Popup Elements
const adModal = document.getElementById("ad-modal");
const adTitle = document.getElementById("ad-title");
const adDesc = document.getElementById("ad-desc");
const adLimitText = document.getElementById("ad-limit-text");
const closeAdBtn = document.getElementById("close-ad-btn");

// [수정됨] videoTexture 변수 추가
let faceLandmarker, renderer, scene, camera, meshPlane, originalPositions, videoTexture;
let beautySprites = [];
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;
let isAdShowing = false;
let isAdLoaded = false;
let pendingAction = null;

// ==========================================
// 0. 언어 자동 감지 및 설정
// ==========================================
function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) lang = 'en'; 
    currentLang = lang;
    const t = TRANSLATIONS[lang];
    
    labelSlim.innerText = t.slim;
    labelBeauty.innerText = t.beauty;
    titleBeauty.innerText = t.section_beauty;
    titleMakeup.innerText = t.section_makeup;
    optionBtn.innerText = t.option_btn;
    installBtn.innerText = t.install;
    
    if(btnFNorm) btnFNorm.innerText = t.filter_norm;
    if(btnFVin) btnFVin.innerText = t.filter_vin;
    if(btnFMono) btnFMono.innerText = t.filter_mono;
    if(btnANone) btnANone.innerText = t.acc_none;
    if(btnANose) btnANose.innerText = t.acc_nose;

    adTitle.innerText = t.ad_title;
    adDesc.innerText = t.ad_desc;
    closeAdBtn.innerText = t.ad_close;
    updateAdCountDisplay();
}

function detectAndSetLanguage() {
    const userLang = navigator.language || navigator.userLanguage; 
    if (userLang.startsWith('ko')) setLanguage('ko');
    else if (userLang.startsWith('zh')) setLanguage('cn');
    else if (userLang.startsWith('ja')) setLanguage('jp');
    else setLanguage('en'); 
}

function updateAdCountDisplay() {
    const count = parseInt(localStorage.getItem(KEY_AD_COUNT) || '0');
    const remain = Math.max(0, AD_CONFIG.MAX_DAILY_ADS - count);
    const t = TRANSLATIONS[currentLang];
    if (adLimitText) {
        adLimitText.innerText = t.ad_limit.replace('{n}', remain);
    }
}


// ==========================================
// 1. 광고 로직
// ==========================================
function checkPremiumStatus() {
    const now = Date.now();
    const today = new Date().toDateString();
    
    const lastDate = localStorage.getItem(KEY_AD_DATE);
    if (lastDate !== today) {
        localStorage.setItem(KEY_AD_DATE, today);
        localStorage.setItem(KEY_AD_COUNT, '0');
    }

    const count = parseInt(localStorage.getItem(KEY_AD_COUNT) || '0');
    const freeUntil = parseInt(localStorage.getItem(KEY_FREE_UNTIL) || '0');

    if (count >= AD_CONFIG.MAX_DAILY_ADS) return true;
    if (now < freeUntil) return true;

    return false;
}

function showAdIfNeeded(callback) {
    if (checkPremiumStatus()) {
        callback(); 
    } else {
        pendingAction = callback;
        updateAdCountDisplay();
        
        isAdShowing = true;
        adModal.style.display = 'flex';
        
        if (!isAdLoaded) {
            try { (window.adsbygoogle = window.adsbygoogle || []).push({}); isAdLoaded = true; } 
            catch (e) {}
        }
    }
}

closeAdBtn.addEventListener('click', () => {
    isAdShowing = false;
    adModal.style.display = 'none';

    let count = parseInt(localStorage.getItem(KEY_AD_COUNT) || '0');
    count++;
    localStorage.setItem(KEY_AD_COUNT, count.toString());

    const freeUntil = Date.now() + AD_CONFIG.FREE_DURATION_MS;
    localStorage.setItem(KEY_FREE_UNTIL, freeUntil.toString());

    if (pendingAction) {
        pendingAction();
        pendingAction = null;
    }
});


// ==========================================
// 2. UI 이벤트
// ==========================================
optionBtn.addEventListener('click', () => {
    if (extraControls.style.display === 'block') {
        extraControls.style.display = 'none';
    } else {
        showAdIfNeeded(() => {
            extraControls.style.display = 'block';
        });
    }
});

const applyFilter = (val) => { currentFilter = val; FilterManager.applyFilter(canvasElement, val); };
const applyLip = (val) => { currentLipColor = val; LipstickManager.setColor(val); };
const applyAcc = (val) => { currentAcc = val; AccessoryManager.setAccessory(val); };
const updateUI = () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === currentFilter));
    document.querySelectorAll('.color-btn').forEach(b => b.classList.toggle('active', b.dataset.color === currentLipColor));
    document.querySelectorAll('.acc-btn').forEach(b => b.classList.toggle('active', b.dataset.acc === currentAcc));
};

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyFilter(btn.dataset.filter); updateUI(); }));
});
document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyLip(btn.dataset.color); updateUI(); }));
});
document.querySelectorAll('.acc-btn').forEach(btn => {
    btn.addEventListener('click', () => showAdIfNeeded(() => { applyAcc(btn.dataset.acc); updateUI(); }));
});

document.getElementById('slim-range').addEventListener('input', (e) => SETTINGS.slimStrength = (1.0 - parseFloat(e.target.value)) / 0.15);
document.getElementById('beauty-range').addEventListener('input', (e) => SETTINGS.lightIntensity = (parseInt(e.target.value) - 100) / 50 * 0.8);


// ==========================================
// 3. 카메라 & 촬영
// ==========================================
async function startWebcam() {
    if (currentStream) currentStream.getTracks().forEach(track => track.stop());
    const constraints = {
        video: {
            facingMode: isFrontCamera ? "user" : "environment",
            width: { ideal: 4096 }, 
            height: { ideal: 2160 },
            aspectRatio: { ideal: window.innerHeight / window.innerWidth }
        }
    };
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentStream = stream;
        video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); adjustVideoLayout(); renderLoop(); };
    } catch (err) {
        console.error(err);
        alert("Camera Error");
    }
}

captureBtn.addEventListener('click', () => {
    flashEffect.style.animation = 'none';
    flashEffect.offsetHeight; 
    flashEffect.style.animation = 'flashAnim 0.3s';
    renderer.render(scene, camera);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `Luma_${timestamp}.png`;
    link.href = renderer.domElement.toDataURL("image/png");
    link.click();
});

function adjustVideoLayout() {
    if (!video || video.videoWidth === 0) return;
    const videoRatio = video.videoWidth / video.videoHeight;
    const screenRatio = window.innerWidth / window.innerHeight;
    let scaleX = 1, scaleY = 1;
    if (screenRatio < videoRatio) scaleX = videoRatio / screenRatio;
    else scaleY = screenRatio / videoRatio;
    meshPlane.scale.set(scaleX * (isFrontCamera ? -1 : 1), scaleY, 1);
}

// Three.js & AI Init
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
    
    // [수정 완료] videoTexture 정의됨
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
    
    detectAndSetLanguage();
    
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

function applyFaceWarping(landmarks, positions) { if (SETTINGS.slimStrength <= 0.01) return; const width = camera.right - camera.left; const height = camera.top - camera.bottom; function toWorld(lm) { return { x: (lm.x - 0.5) * width, y: -(lm.y - 0.5) * height }; } const chin = toWorld(landmarks[152]); const nose = toWorld(landmarks[1]); const faceWidth = Math.abs(toWorld(landmarks[234]).x - toWorld(landmarks[454]).x); const radius = faceWidth * 1.3; const force = SETTINGS.slimStrength * 0.2; for (let i = 0; i < positions.length; i += 3) { const vx = positions[i]; const vy = positions[i+1]; if (Math.abs(vx - chin.x) > radius || Math.abs(vy - chin.y) > radius) continue; const dx = vx - chin.x; const dy = vy - chin.y; const distSq = dx*dx + dy*dy; if (distSq < radius * radius) { const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4))); positions[i] += (nose.x - vx) * factor * force; positions[i+1] += (nose.y - vy) * factor * force * 0.5; } } }
function updateBeautyPosition(landmarks, sprite) { if (!sprite) return; const width = camera.right - camera.left; const height = camera.top - camera.bottom; let noseX = (landmarks[1].x - 0.5) * width; const noseY = -(landmarks[1].y - 0.5) * height; if (isFrontCamera) noseX = -noseX; const leftEar = (landmarks[234].x - 0.5) * width; const rightEar = (landmarks[454].x - 0.5) * width; const faceW = Math.abs(rightEar - leftEar); sprite.position.set(noseX, noseY, 0.1); const size = faceW * 4.0; sprite.scale.set(size, size, 1); }
async function createFaceLandmarker() { const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm"); faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, { baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" }, outputFaceBlendshapes: false, runningMode: "VIDEO", numFaces: SETTINGS.maxFaces }); startWebcam(); }

initThreeJS();
createFaceLandmarker();
switchBtn.addEventListener('click', () => { isFrontCamera = !isFrontCamera; startWebcam(); });
let deferredPrompt; window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; if (!window.matchMedia('(display-mode: standalone)').matches) installBtn.style.display = 'block'; });
installBtn.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt = null; installBtn.style.display = 'none'; });
