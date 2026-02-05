import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 조명(무료) / 잡티(광고) / 다중(광고)
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    updateInterval: 100, 
    beautyOpacity: 0.4,
    maxFaces: 20,
    
    // 잡티 제거 강도 (토글 켜졌을 때만 적용)
    filterBlur: 0,      
    filterContrast: 100 
};

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");

// [NEW] 토글 버튼
const flawlessToggle = document.getElementById("flawless-toggle");

// [광고 요소]
const adModal = document.getElementById("ad-modal");
const adTitle = document.getElementById("ad-title");
const adDesc = document.getElementById("ad-desc");
const closeAdBtn = document.getElementById("close-ad-btn");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;

// [잠금 상태 변수]
let isMultiUnlocked = false;    // 다중 얼굴 잠금해제 여부
let isFlawlessUnlocked = false; // 잡티 제거 잠금해제 여부
let isAdShowing = false;
let adTriggerSource = "";       // 광고를 부른 녀석이 누구냐 ('multi' 또는 'flawless')

let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let beautySprites = []; 

let videoAspect = 1.0; 
let screenAspect = 1.0;

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
    updateCSSFilters(); // 초기 필터

    window.addEventListener('resize', onWindowResize);
}

function createBeautyLightsPool() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 230, 230, 0.6)'); 
    gradient.addColorStop(0.7, 'rgba(255, 240, 240, 0.3)'); 
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
        
        // [광고 체크 1] 다중 얼굴
        if (results.faceLandmarks.length >= 2 && !isMultiUnlocked) {
            showAdModal('multi');
            return; 
        }

        results.faceLandmarks.forEach((landmarks, index) => {
            applyFaceWarping(landmarks, positions);
            
            if (index < beautySprites.length) {
                const sprite = beautySprites[index];
                updateBeautyPosition(landmarks, sprite);
                sprite.material.opacity = SETTINGS.beautyOpacity; 
            }
        });
    }
    
    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

// ==========================================
// 5. 잡티 제거 (조건부 필터 적용)
// ==========================================
function updateCSSFilters() {
    const intensity = SETTINGS.beautyOpacity; // 0.0 ~ 0.6
    
    // 기본 효과 (조명만)
    let blurVal = 0;
    let contrastVal = 100;
    let brightVal = 100 + (intensity * 10); 
    let saturateVal = 100 + (intensity * 5); 

    // [잡티 제거 토글이 켜져야만 실행]
    if (flawlessToggle.checked) {
        blurVal = intensity * 1.5;            // 모공 블러
        contrastVal = 100 - (intensity * 15); // 대비 낮춤 (잡티 숨김)
        brightVal += 10;                      // 더 밝게
    }

    canvasElement.style.filter = `
        blur(${blurVal}px) 
        brightness(${brightVal}%) 
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

// [광고 시스템]
function showAdModal(source) {
    adTriggerSource = source; // 누가 불렀는지 저장
    
    if (source === 'multi') {
        adTitle.innerText = "👨‍👩‍👧‍👦 단체 사진 잠금 해제";
        adDesc.innerText = "2명 이상 감지되었습니다. 광고를 보고 활성화하세요.";
    } else if (source === 'flawless') {
        adTitle.innerText = "✨ 잡티 제거 잠금 해제";
        adDesc.innerText = "도자기 피부 기능을 사용하려면 광고를 시청하세요.";
    }
    
    isAdShowing = true;
    adModal.style.display = "flex";
}

if(closeAdBtn) {
    closeAdBtn.addEventListener('click', () => {
        isAdShowing = false;
        adModal.style.display = "none";
        
        // 보상 지급
        if (adTriggerSource === 'multi') {
            isMultiUnlocked = true;
        } else if (adTriggerSource === 'flawless') {
            isFlawlessUnlocked = true;
            flawlessToggle.checked = true; // 자동으로 켜줌
            updateCSSFilters();
        }
    });
}

// [이벤트] 토글 클릭 시 광고 체크
flawlessToggle.addEventListener('click', (e) => {
    // 이미 해제되었으면 그냥 둠
    if (isFlawlessUnlocked) {
        updateCSSFilters();
        return;
    }
    
    // 해제 안 됐으면 체크 취소하고 광고 띄움
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
    SETTINGS.beautyOpacity = (val - 100) / 50 * 0.6;
    updateCSSFilters();
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
