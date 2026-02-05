import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 느리지만 안정적인 버전
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    warpRadius: 0.4,
    
    // 떨림 방지 (0.1 정도면 적당)
    smoothFactor: 0.1,
    
    // [NEW] 뽀샤시 초기값 (120%)
    beautyLevel: 120 
};

// 요소 가져오기
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const statusMsg = document.getElementById("ai-status"); // 안내 문구

const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");

// 변수들
let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastVideoTime = -1;

// [NEW] 속도 조절용 카운터
let frameCounter = 0; 

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;
let previousLandmarks = []; 

// ==========================================
// 1. Three.js 초기화
// ==========================================
function initThreeJS() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    renderer = new THREE.WebGLRenderer({ 
        canvas: canvasElement, 
        antialias: false,
        powerPreference: "high-performance"
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

    // 메쉬 생성 (64x64)
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

    // [중요] 시작하자마자 뽀샤시 적용
    applyBeautyFilter();

    window.addEventListener('resize', onWindowResize);
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
}

// ==========================================
// 2. AI 모델 로드
// ==========================================
async function createFaceLandmarker() {
    statusMsg.style.display = "block"; // "분석중..." 표시
    
    const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { 
            modelAssetPath: "./assets/models/face_landmarker.task", 
            delegate: "GPU" 
        },
        outputFaceBlendshapes: false,
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    startWebcam();
}

// ==========================================
// 3. 웹캠 시작
// ==========================================
function startWebcam() {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }
    const constraints = {
        video: {
            facingMode: isFrontCamera ? "user" : "environment",
            width: { ideal: 1280 }, height: { ideal: 720 }
        }
    };
    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        currentStream = stream;
        video.srcObject = stream;
        video.onloadeddata = () => {
            video.play();
            renderLoop();
        };
    }).catch(err => console.error("카메라 에러:", err));
}

// ==========================================
// 4. 렌더링 루프 (천천히 업데이트)
// ==========================================
function renderLoop() {
    // 1. 프레임 카운트 증가
    frameCounter++;

    let results;
    
    // [핵심] 3프레임마다 1번씩만 AI 돌림 (속도 조절)
    // 60fps 화면 -> 20fps AI 업데이트
    // 이렇게 하면 떨림이 물리적으로 줄어듭니다.
    const shouldUpdateAI = (frameCounter % 3 === 0);

    if (shouldUpdateAI && video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        if (lastVideoTime !== video.currentTime) {
            lastVideoTime = video.currentTime;
            results = faceLandmarker.detectForVideo(video, startTimeMs);
        }
    }

    // 메쉬 초기화
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    // AI 결과가 있으면 (혹은 이전 결과 유지)
    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        // 얼굴 찾음 -> "분석중" 메시지 숨김
        statusMsg.style.display = "none";

        const currentLandmarks = results.faceLandmarks[0];

        if (previousLandmarks.length !== currentLandmarks.length) {
            previousLandmarks = [];
            for(let lm of currentLandmarks) {
                previousLandmarks.push({x: lm.x, y: lm.y});
            }
        }

        // 스무딩 (이전 위치와 섞기)
        for (let i = 0; i < currentLandmarks.length; i++) {
            const lx = previousLandmarks[i].x + (currentLandmarks[i].x - previousLandmarks[i].x) * SETTINGS.smoothFactor;
            const ly = previousLandmarks[i].y + (currentLandmarks[i].y - previousLandmarks[i].y) * SETTINGS.smoothFactor;
            
            currentLandmarks[i].x = lx;
            currentLandmarks[i].y = ly;
            previousLandmarks[i].x = lx;
            previousLandmarks[i].y = ly;
        }

        applyFaceWarping(currentLandmarks, positions);
    
    } else {
        // 얼굴 못 찾음 -> 일정 시간 지나면 "분석중" 띄울 수도 있음 (여기선 생략)
        // 만약 AI 업데이트 턴인데 얼굴이 없으면, 
        // 그냥 원본 메쉬(초기화된 상태)가 그려짐
    }

    // 거울 모드
    if (isFrontCamera) {
        meshPlane.scale.x = -1;
    } else {
        meshPlane.scale.x = 1;
    }

    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
}

// ==========================================
// 5. 워핑 및 뽀샤시
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
    const leftJaw = toWorld(landmarks[132]);
    const rightJaw = toWorld(landmarks[361]);
    const nose = toWorld(landmarks[1]);

    const faceSize = Math.abs(leftJaw.x - rightJaw.x);
    const radius = faceSize * 1.5;
    const force = SETTINGS.slimStrength * 0.15;

    for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i+1];
        
        // 거리 체크
        const dx = vx - chin.x;
        const dy = vy - chin.y;
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;

        const distSq = dx*dx + dy*dy;
        if (distSq < radius * radius) {
            const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4)));
            positions[i] += (nose.x - vx) * factor * force;
            positions[i+1] += (nose.y - vy) * factor * force * 0.5;
        }
    }
}

// [핵심] 뽀샤시 필터 적용 함수
function applyBeautyFilter() {
    const val = SETTINGS.beautyLevel; // ex: 120
    const brightness = val / 100;     // 1.2
    const saturate = val / 100;       // 1.2
    
    // Blur를 조금 더 강하게 줘서 피부 잡티를 가림 (0.5px)
    // 대비(Contrast)는 살짝 낮춰서 부드럽게
    canvasElement.style.filter = `brightness(${brightness}) saturate(${saturate}) contrast(0.95) blur(0.5px)`;
}

// 이벤트 핸들러
slimRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

beautyRange.addEventListener('input', (e) => {
    SETTINGS.beautyLevel = parseInt(e.target.value);
    applyBeautyFilter();
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    previousLandmarks = [];
    statusMsg.style.display = "block"; // 카메라 바꿀 때도 메시지 표시
    startWebcam();
});

captureBtn.addEventListener('click', () => {
    renderer.render(scene, camera);
    const dataURL = renderer.domElement.toDataURL("image/png");
    const link = document.createElement('a');
    link.download = `luma_warp.png`;
    link.href = dataURL;
    link.click();
});

initThreeJS();
createFaceLandmarker();
