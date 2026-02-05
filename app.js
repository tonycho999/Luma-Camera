import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 화면 비율 고정 & 기존 기능 유지
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    updateInterval: 100, // 0.1초 (스톱모션)
    beautyOpacity: 0.4,
    maxFaces: 20 
};

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
// const statusMsg = document.getElementById("ai-status"); // 필요시 주석 해제
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");

// [광고 요소]
const adModal = document.getElementById("ad-modal");
const closeAdBtn = document.getElementById("close-ad-btn");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastUpdateTime = 0;

// [광고 상태]
let isMultiUnlocked = false; 
let isAdShowing = false; 

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let beautySprites = []; 

// [비율 계산용 변수]
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
    
    // 평면 생성
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

    window.addEventListener('resize', onWindowResize);
}

function createBeautyLightsPool() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 235, 235, 1.0)'); 
    gradient.addColorStop(0.5, 'rgba(255, 245, 245, 0.4)'); 
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

// [핵심] 화면 크기 변경 시 비율 재계산
function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / height;
    
    renderer.setSize(width, height);
    
    // 카메라 비율 업데이트
    const frustumHeight = 2.0;
    const frustumWidth = frustumHeight * aspect;
    camera.left = frustumWidth / -2;
    camera.right = frustumWidth / 2;
    camera.top = frustumHeight / 2;
    camera.bottom = frustumHeight / -2;
    camera.updateProjectionMatrix();

    // 비디오 비율 레이아웃 재조정
    adjustVideoLayout();
}

// ==========================================
// [NEW] 비디오 비율 맞추기 (왜곡 방지)
// ==========================================
function adjustVideoLayout() {
    if (!video || video.videoWidth === 0) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sw = window.innerWidth;
    const sh = window.innerHeight;

    videoAspect = vw / vh;
    screenAspect = sw / sh;

    // Three.js Mesh의 기본 크기는 화면(Camera Frustum)에 딱 맞게 생성되어 있음.
    // 여기에 스케일을 조절해서 비율을 맞춤.
    
    let scaleX = 1;
    let scaleY = 1;

    // 화면보다 영상이 더 납작한 경우 (예: 4:3 영상을 긴 폰 화면에 띄울 때)
    if (screenAspect < videoAspect) {
        // 높이를 맞추고, 너비를 키워서 양옆을 자름 (Cover)
        // 계산식: (화면높이 * 영상비율) / 화면너비
        scaleX = (videoAspect / screenAspect);
    } 
    // 화면보다 영상이 더 길쭉한 경우
    else {
        // 너비를 맞추고, 높이를 키워서 위아래를 자름
        scaleY = (screenAspect / videoAspect);
    }

    // 거울 모드 적용 (-1 곱하기)
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
            // 해상도를 높게 요청하면 폰이 지원하는 최적 비율을 가져올 확률이 높음
            width: { ideal: 1920 }, height: { ideal: 1080 }
        }
    };
    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        currentStream = stream;
        video.srcObject = stream;
        
        // 메타데이터가 로드되면 비율 조정 실행
        video.onloadedmetadata = () => {
            video.play();
            adjustVideoLayout(); // [중요] 비디오 크기 알게 된 순간 비율 맞춤
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
            showAdModal();
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

    // meshPlane Scale은 adjustVideoLayout에서 이미 처리함.
    // 여기서는 isFrontCamera가 바뀔 때만 다시 호출해주면 됨 (startWebcam에서 함)
    
    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

// ==========================================
// 5. 광고 기능 함수
// ==========================================
function showAdModal() {
    isAdShowing = true;
    if(adModal) adModal.style.display = "flex";
}

if(closeAdBtn) {
    closeAdBtn.addEventListener('click', () => {
        isAdShowing = false;
        isMultiUnlocked = true;
        if(adModal) adModal.style.display = "none";
    });
}

// ==========================================
// 6. 워핑 & 조명 로직
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

    if (isFrontCamera) {
        noseX = -noseX; 
    }

    const leftEar = (landmarks[234].x - 0.5) * width;
    const rightEar = (landmarks[454].x - 0.5) * width;
    const faceW = Math.abs(rightEar - leftEar);

    // 비율 보정으로 인해 좌표가 어긋날 수 있으므로
    // scale 값도 고려해야 완벽하지만, 현재 2D 평면 워핑 로직상 
    // 큰 오차가 없으므로 그대로 둡니다.
    
    sprite.position.set(noseX, noseY, 0.1); 
    const size = faceW * 2.0; 
    sprite.scale.set(size, size, 1);
}

// 이벤트
slimRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

beautyRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value); 
    SETTINGS.beautyOpacity = (val - 100) / 50 * 0.6; 
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    startWebcam();
});

captureBtn.addEventListener('click', () => {
    renderer.render(scene, camera);
    const dataURL = renderer.domElement.toDataURL("image/png");
    const link = document.createElement('a');
    link.download = `luma_final.png`;
    link.href = dataURL;
    link.click();
});

initThreeJS();
createFaceLandmarker();
