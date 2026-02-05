import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 앱 설치 버튼 로직 추가
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    updateInterval: 100, 
    maxFaces: 20,
    lightIntensity: 0.4, 
    flawlessBlur: 1.5,      
    flawlessContrast: 85    
};

// [번역 데이터 - 설치 버튼 추가]
const TRANSLATIONS = {
    ko: {
        slim: "턱선",
        beauty: "뽀샤시(조명)",
        flawless: "소프트 스킨",
        ad_multi_title: "👨‍👩‍👧‍👦 단체 사진 잠금 해제",
        ad_multi_desc: "2명 이상 감지되었습니다. 광고를 보고 활성화하세요.",
        ad_flawless_title: "✨ 소프트 스킨 잠금 해제",
        ad_flawless_desc: "부드러운 피부결 필터를 사용하려면 광고를 시청하세요.",
        ad_close: "광고 닫고 활성화",
        install: "앱 설치 📲" // [NEW]
    },
    en: {
        slim: "Slim",
        beauty: "Lighting",
        flawless: "Soft Skin",
        ad_multi_title: "👨‍👩‍👧‍👦 Unlock Group Photo",
        ad_multi_desc: "2+ people detected. Watch ad to unlock.",
        ad_flawless_title: "✨ Unlock Soft Skin",
        ad_flawless_desc: "Watch ad to enable soft skin texture filter.",
        ad_close: "Close & Enable",
        install: "Install App 📲"
    },
    cn: {
        slim: "瘦脸",
        beauty: "补光",
        flawless: "柔肤",
        ad_multi_title: "👨‍👩‍👧‍👦 解锁多人模式",
        ad_multi_desc: "检测到多人。观看广告以解锁。",
        ad_flawless_title: "✨ 解锁柔肤滤镜",
        ad_flawless_desc: "观看广告以启用柔肤模式。",
        ad_close: "关闭并启用",
        install: "下载应用 📲"
    },
    jp: {
        slim: "輪郭",
        beauty: "照明",
        flawless: "ソフト肌",
        ad_multi_title: "👨‍👩‍👧‍👦 グループ写真の解除",
        ad_multi_desc: "2人以上を検出しました。広告を見て解除します。",
        ad_flawless_title: "✨ ソフト肌の解除",
        ad_flawless_desc: "広告を見てソフト肌フィルターを有効にします。",
        ad_close: "閉じて有効化",
        install: "アプリ入手 📲"
    }
};

let currentLang = 'en';

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const flawlessToggle = document.getElementById("flawless-toggle");

// [설치 버튼]
const installBtn = document.getElementById("install-btn");
let deferredPrompt; // 설치 이벤트 저장용

const labelSlim = document.getElementById("label-slim");
const labelBeauty = document.getElementById("label-beauty");
const labelFlawless = document.getElementById("label-flawless");
const langBtns = document.querySelectorAll(".lang-btn");

const adModal = document.getElementById("ad-modal");
const adTitle = document.getElementById("ad-title");
const adDesc = document.getElementById("ad-desc");
const closeAdBtn = document.getElementById("close-ad-btn");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;

let isMultiUnlocked = false;    
let isFlawlessUnlocked = false; 
let isAdShowing = false;
let adTriggerSource = "";       

let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let beautySprites = []; 

let videoAspect = 1.0; 
let screenAspect = 1.0;

// ==========================================
// [NEW] 앱 설치 로직 (PWA)
// ==========================================

// 1. 브라우저가 "설치 가능한 상태"라고 신호를 보낼 때
window.addEventListener('beforeinstallprompt', (e) => {
    // 기본 배너 뜨는거 막고, 우리가 만든 버튼 보여주기 위해 저장
    e.preventDefault();
    deferredPrompt = e;
    
    // 이미 앱으로 실행 중이 아니면 버튼 표시
    if (!window.matchMedia('(display-mode: standalone)').matches) {
        installBtn.style.display = 'block';
    }
});

// 2. 설치 버튼 클릭 시
if(installBtn) {
    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        
        // 설치 팝업 띄우기
        deferredPrompt.prompt();
        
        // 유저가 설치했는지 취소했는지 확인
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`User response: ${outcome}`);
        
        // 한번 썼으니 초기화
        deferredPrompt = null;
        
        // 설치했거나 닫으면 버튼 숨김
        installBtn.style.display = 'none';
    });
}

// 3. 이미 앱이 설치되어 실행 중이면 버튼 숨김 (한번 더 체크)
if (window.matchMedia('(display-mode: standalone)').matches) {
    if(installBtn) installBtn.style.display = 'none';
}


// ==========================================
// 0. 언어 설정 & 자동 감지
// ==========================================
function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    currentLang = lang;

    const t = TRANSLATIONS[lang];
    
    labelSlim.innerText = t.slim;
    labelBeauty.innerText = t.beauty;
    labelFlawless.innerText = t.flawless;
    closeAdBtn.innerText = t.ad_close;
    if(installBtn) installBtn.innerText = t.install; // 설치 버튼 번역

    langBtns.forEach(btn => {
        if(btn.dataset.lang === lang) btn.classList.add("active");
        else btn.classList.remove("active");
    });
}

function detectAndSetLanguage() {
    const userLang = navigator.language || navigator.userLanguage; 
    if (userLang.startsWith('ko')) setLanguage('ko');
    else if (userLang.startsWith('zh')) setLanguage('cn');
    else if (userLang.startsWith('ja')) setLanguage('jp');
    else setLanguage('en');
}

langBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        setLanguage(btn.dataset.lang);
    });
});


// ==========================================
// 1. Three.js 초기화
// ==========================================
function initThreeJS() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    renderer = new THREE.WebGLRenderer({ 
        canvas: canvasElement, 
        antialias: false, 
        preserveDrawingBuffer: true 
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    scene = new THREE.Scene();

    const aspect = width / height;
    const frustumHeight = 2.0;
    const frustumWidth = frustumHeight * aspect;

    camera = new THREE.OrthographicCamera(
        frustumWidth / -2, frustumWidth / 2,
        frustumHeight / 2, frustumHeight / -2,
        0.1, 100
    );
    camera.position.z = 10;

    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.format = THREE.RGBFormat;
    videoTexture.generateMipmaps = false;
    
    const geometry = new THREE.PlaneGeometry(frustumWidth, frustumHeight, 64, 64);
    const count = geometry.attributes.position.count;
    originalPositions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
        originalPositions[i] = geometry.attributes.position.array[i];
    }

    const material = new THREE.MeshBasicMaterial({ 
        map: videoTexture,
        side: THREE.DoubleSide
    });

    meshPlane = new THREE.Mesh(geometry, material);
    scene.add(meshPlane);

    createBeautyLightsPool();
    updateCSSFilters(); 
    detectAndSetLanguage();

    window.addEventListener('resize', onWindowResize);
}

function createBeautyLightsPool() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.5)'); 
    gradient.addColorStop(0.6, 'rgba(255, 240, 240, 0.2)'); 
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    const materialBase = new THREE.SpriteMaterial({ 
        map: texture, 
        transparent: true,
        opacity: 0, 
        blending: THREE.AdditiveBlending, 
        depthTest: false
    });

    for(let i=0; i<SETTINGS.maxFaces; i++) {
        const sprite = new THREE.Sprite(materialBase.clone()); 
        sprite.scale.set(0, 0, 1);
        sprite.renderOrder = 999; 
        scene.add(sprite);
        beautySprites.push(sprite);
    }
}

function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / height;
    
    renderer.setSize(width, height);
    
    const frustumHeight = 2.0;
    const frustumWidth = frustumHeight * aspect;
    camera.left = frustumWidth / -2;
    camera.right = frustumWidth / 2;
    camera.top = frustumHeight / 2;
    camera.bottom = frustumHeight / -2;
    camera.updateProjectionMatrix();

    adjustVideoLayout();
}

function adjustVideoLayout() {
    if (!video || video.videoWidth === 0) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sw = window.innerWidth;
    const sh = window.innerHeight;

    videoAspect = vw / vh;
    screenAspect = sw / sh;
    
    let scaleX = 1;
    let scaleY = 1;

    if (screenAspect < videoAspect) {
        scaleX = (videoAspect / screenAspect);
    } else {
        scaleY = (screenAspect / videoAspect);
    }

    const mirrorFactor = isFrontCamera ? -1 : 1;
    meshPlane.scale.set(scaleX * mirrorFactor, scaleY, 1);
}

// ==========================================
// 2. AI 모델
// ==========================================
async function createFaceLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" },
        outputFaceBlendshapes: false,
        runningMode: "VIDEO",
        numFaces: SETTINGS.maxFaces 
    });
    startWebcam();
}

// ==========================================
// 3. 웹캠
// ==========================================
function startWebcam() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }
    const constraints = {
        video: {
            facingMode: isFrontCamera ? "user" : "environment",
            width: { ideal: 1920 }, height: { ideal: 1080 }
        }
    };
    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        currentStream = stream;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            adjustVideoLayout();
            renderLoop();
        };
    }).catch(err => console.error("카메라 에러:", err));
}

// ==========================================
// 4. 렌더링 루프
// ==========================================
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);

    if (isAdShowing) return;
    if (timestamp - lastUpdateTime < SETTINGS.updateInterval) return;
    lastUpdateTime = timestamp;

    let results;
    if (video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        results = faceLandmarker.detectForVideo(video, startTimeMs);
    }

    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    beautySprites.forEach(sprite => {
        sprite.scale.set(0,0,1);
        sprite.material.opacity = 0;
    });

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        
        if (results.faceLandmarks.length >= 2 && !isMultiUnlocked) {
            showAdModal('multi');
            return; 
        }

        results.faceLandmarks.forEach((landmarks, index) => {
            applyFaceWarping(landmarks, positions);
            
            if (index < beautySprites.length) {
                const sprite = beautySprites[index];
                updateBeautyPosition(landmarks, sprite);
                sprite.material.opacity = SETTINGS.lightIntensity; 
            }
        });
    }
    
    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

// ==========================================
// 5. 잡티 제거 (조건부 필터)
// ==========================================
function updateCSSFilters() {
    let blurVal = 0;
    let contrastVal = 100;
    let saturateVal = 100;

    if (flawlessToggle.checked) {
        blurVal = SETTINGS.flawlessBlur;        
        contrastVal = SETTINGS.flawlessContrast; 
        saturateVal = 105;                      
    }

    canvasElement.style.filter = `
        blur(${blurVal}px) 
        contrast(${contrastVal}%) 
        saturate(${saturateVal}%)
    `;
}

// ==========================================
// 6. 워핑 & 조명 & UI
// ==========================================
function applyFaceWarping(landmarks, positions) {
    if (SETTINGS.slimStrength <= 0.01) return;

    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    
    function toWorld(lm) {
        return {
            x: (lm.x - 0.5) * width,
            y: -(lm.y - 0.5) * height 
        };
    }

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

// [광고 팝업]
function showAdModal(source) {
    adTriggerSource = source; 
    const t = TRANSLATIONS[currentLang];

    if (source === 'multi') {
        adTitle.innerText = t.ad_multi_title;
        adDesc.innerText = t.ad_multi_desc;
    } else if (source === 'flawless') {
        adTitle.innerText = t.ad_flawless_title;
        adDesc.innerText = t.ad_flawless_desc;
    }
    
    isAdShowing = true;
    adModal.style.display = "flex";
}

if(closeAdBtn) {
    closeAdBtn.addEventListener('click', () => {
        isAdShowing = false;
        adModal.style.display = "none";
        
        if (adTriggerSource === 'multi') {
            isMultiUnlocked = true;
        } else if (adTriggerSource === 'flawless') {
            isFlawlessUnlocked = true;
            flawlessToggle.checked = true; 
            updateCSSFilters();
        }
    });
}

flawlessToggle.addEventListener('click', (e) => {
    if (isFlawlessUnlocked) {
        updateCSSFilters();
        return;
    }
    e.preventDefault(); 
    showAdModal('flawless');
});


slimRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

beautyRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value); 
    SETTINGS.lightIntensity = (val - 100) / 50 * 0.8;
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    startWebcam();
});

captureBtn.addEventListener('click', () => {
    renderer.render(scene, camera);
    const dataURL = renderer.domElement.toDataURL("image/png");
    const link = document.createElement('a');
    link.download = `luma_capture.png`;
    link.href = dataURL;
    link.click();
});

initThreeJS();
createFaceLandmarker();
