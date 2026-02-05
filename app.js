import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";
// [NEW] 분리된 언어 파일 불러오기
import { TRANSLATIONS } from "./lang.js";

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

// Three.js variables
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let beautySprites = []; 

// 추가된 Three.js 객체들
let lipMesh; // 립스틱 메쉬
let noseMesh; // 루돌프 코 메쉬

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
// 1. Three.js 초기화 (립스틱, 코 추가)
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
    
    // [NEW] 립스틱 메쉬 생성
    createLipMesh();
    // [NEW] 루돌프 코 메쉬 생성
    createNoseMesh();

    updateCSSFilters(); 
    detectAndSetLanguage();
    window.addEventListener('resize', onWindowResize);
}

// 립스틱용 메쉬 만들기
function createLipMesh() {
    const lipIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]; 
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(lipIndices.length * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.0 });
    lipMesh = new THREE.Mesh(geometry, material);
    lipMesh.renderOrder = 998; 
    scene.add(lipMesh);
}

// 루돌프 코 메쉬 만들기
function createNoseMesh() {
    const geometry = new THREE.SphereGeometry(0.05, 16, 16); 
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    noseMesh = new THREE.Mesh(geometry, material);
    noseMesh.scale.set(0,0,0); 
    noseMesh.renderOrder = 1000;
    scene.add(noseMesh);
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
// 3. 렌더링 루프 (핵심 업데이트)
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
    // 립스틱, 코 초기화
    if(lipMesh) lipMesh.material.opacity = 0;
    if(noseMesh) noseMesh.scale.set(0,0,0);

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        if (results.faceLandmarks.length >= 2 && !isMultiUnlocked) { showAdModal('multi'); return; }

        results.faceLandmarks.forEach((landmarks, index) => {
            applyFaceWarping(landmarks, meshPlane.geometry.attributes.position.array);
            
            if (index < beautySprites.length) {
                updateBeautyPosition(landmarks, beautySprites[index]);
                beautySprites[index].material.opacity = SETTINGS.lightIntensity;
            }
            
            // 첫 번째 얼굴에만 립스틱/액세서리 적용
            if (index === 0) {
                updateLipMesh(landmarks);
                updateNoseMesh(landmarks);
            }
        });
    }
    meshPlane.geometry.attributes.position.needsUpdate = true;
    // 거울모드에 따라 액세서리도 반전 필요
    if(noseMesh) noseMesh.scale.x = isFrontCamera ? -Math.abs(noseMesh.scale.x) : Math.abs(noseMesh.scale.x);

    renderer.render(scene, camera);
}

// 립스틱 위치 업데이트
function updateLipMesh(landmarks) {
    if (currentLipColor === 'none' || !lipMesh) return;
    
    const positions = lipMesh.geometry.attributes.position.array;
    const lipIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61];
    
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;

    for (let i = 0; i < lipIndices.length; i++) {
        const lm = landmarks[lipIndices[i]];
        // 월드 좌표로 변환 (거울모드 고려)
        positions[i * 3] = (lm.x - 0.5) * width * (isFrontCamera ? -1 : 1);
        positions[i * 3 + 1] = -(lm.y - 0.5) * height;
        positions[i * 3 + 2] = -lm.z * width * 0.5 + 0.01; 
    }
    lipMesh.geometry.attributes.position.needsUpdate = true;
    lipMesh.material.opacity = 0.5; // 반투명
}

// 루돌프 코 위치 업데이트
function updateNoseMesh(landmarks) {
    if (currentAcc !== 'nose' || !noseMesh) return;

    const noseTip = landmarks[1]; // 코 끝
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;

    noseMesh.position.set(
        (noseTip.x - 0.5) * width * (isFrontCamera ? -1 : 1),
        -(noseTip.y - 0.5) * height,
        -noseTip.z * width * 0.5 + 0.05 // 코보다 더 앞
    );
    
    // 얼굴 크기에 맞춰 코 크기 조절
    const faceW = Math.abs(landmarks[454].x - landmarks[234].x) * width;
    const s = faceW * 0.25;
    noseMesh.scale.set(s, s, s);
}


// ==========================================
// 4. 기능 구현 (필터, 립스틱, 액세서리)
// ==========================================

// 필터 CSS 적용
function updateCSSFilters() {
    let filterString = '';
    if (currentFilter === 'vintage') filterString = 'sepia(0.5) contrast(0.9) brightness(1.1)';
    else if (currentFilter === 'mono') filterString = 'grayscale(1) contrast(1.1)';
    canvasElement.style.filter = filterString;
}

// 립스틱 색상 변경
function updateLipColor() {
    if(!lipMesh) return;
    let color = 0xffffff;
    if(currentLipColor === 'pink') color = 0xFF69B4;
    else if(currentLipColor === 'red') color = 0xFF0000;
    else if(currentLipColor === 'coral') color = 0xFF7F50;
    lipMesh.material.color.setHex(color);
}


// ==========================================
// 5. UI 이벤트 및 광고 로직
// ==========================================

function updateUIActiveState() {
    filterBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.filter === currentFilter));
    colorBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.color === currentLipColor));
    accBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.acc === currentAcc));
    
    // 잠금 아이콘 제거
    if(isFilterUnlocked) filterBtns.forEach(btn => btn.classList.remove('locked'));
    if(isLipUnlocked) colorBtns.forEach(btn => btn.classList.remove('locked'));
    if(isAccUnlocked) accBtns.forEach(btn => btn.classList.remove('locked'));
}

// 이벤트 리스너 연결
filterBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('filter', btn.dataset.filter)));
colorBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('lip', btn.dataset.color)));
accBtns.forEach(btn => btn.addEventListener('click', () => handleFeatureClick('acc', btn.dataset.acc)));

function handleFeatureClick(type, value) {
    if (value === 'none') { // '없음'은 항상 무료
        if(type === 'filter') currentFilter = value;
        if(type === 'lip') currentLipColor = value;
        if(type === 'acc') currentAcc = value;
        applyFeatures();
        return;
    }

    // 잠겨있으면 광고 표시
    if (type === 'filter' && !isFilterUnlocked) { showAdModal('filter'); return; }
    if (type === 'lip' && !isLipUnlocked) { showAdModal('lip'); return; }
    if (type === 'acc' && !isAccUnlocked) { showAdModal('acc'); return; }

    // 해제되었으면 적용
    if(type === 'filter') currentFilter = value;
    if(type === 'lip') currentLipColor = value;
    if(type === 'acc') currentAcc = value;
    applyFeatures();
}

function applyFeatures() {
    updateCSSFilters();
    updateLipColor();
    updateUIActiveState();
}

// [광고 팝업]
function showAdModal(source) {
    adTriggerSource = source; 
    const t = TRANSLATIONS[currentLang];
    if (source === 'multi') { adTitle.innerText = t.ad_multi_title; adDesc.innerText = t.ad_multi_desc; }
    else if (source === 'filter') { adTitle.innerText = t.ad_filter_title; adDesc.innerText = t.ad_filter_desc; }
    else if (source === 'lip') { adTitle.innerText = t.ad_lip_title; adDesc.innerText = t.ad_lip_desc; }
    else if (source === 'acc') { adTitle.innerText = t.ad_acc_title; adDesc.innerText = t.ad_acc_desc; }
    isAdShowing = true;
    adModal.style.display = "flex";
}

closeAdBtn.addEventListener('click', () => {
    isAdShowing = false;
    adModal.style.display = "none";
    if (adTriggerSource === 'multi') isMultiUnlocked = true;
    else if (adTriggerSource === 'filter') { isFilterUnlocked = true; }
    else if (adTriggerSource === 'lip') { isLipUnlocked = true; }
    else if (adTriggerSource === 'acc') { isAccUnlocked = true; }
    updateUIActiveState(); // 잠금 아이콘 제거
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
