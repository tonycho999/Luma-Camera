import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 강력한 떨림 방지 적용
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    warpRadius: 0.4,
    
    // [핵심] 떨림 방지 (숫자가 작을수록 안 떨림)
    // 0.3 -> 0.08로 대폭 낮춤 (아주 부드럽게 이동)
    smoothFactor: 0.08 
};

// 전역 변수
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastVideoTime = -1;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// [최적화] 이전 프레임 좌표 저장용 배열 (메모리 재사용)
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

    // 가로세로 64칸 그물망
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
// 2. AI 모델 로드 (엄격 모드 적용)
// ==========================================
async function createFaceLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { 
        modelAssetPath: "./assets/models/face_landmarker.task", 
        delegate: "GPU" 
    },
    outputFaceBlendshapes: false,
    runningMode: "VIDEO",
    numFaces: 1,
    // [중요] 신뢰도 기준을 높여서 이상한 값은 무시
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
// 4. 렌더링 루프 (강력한 스무딩)
// ==========================================
function renderLoop() {
    let results;
    if (video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        if (lastVideoTime !== video.currentTime) {
            lastVideoTime = video.currentTime;
            results = faceLandmarker.detectForVideo(video, startTimeMs);
        }
    }

    // 메쉬 초기화 (항상 원본에서 시작)
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        const currentLandmarks = results.faceLandmarks[0];

        // 첫 프레임이면 초기화
        if (previousLandmarks.length !== currentLandmarks.length) {
            previousLandmarks = [];
            for(let lm of currentLandmarks) {
                previousLandmarks.push({x: lm.x, y: lm.y, z: lm.z});
            }
        }

        // [핵심] 랜드마크 스무딩 (Exponential Moving Average)
        for (let i = 0; i < currentLandmarks.length; i++) {
            // 공식: 현재값 = 이전값 + (새값 - 이전값) * 0.08
            // 0.08은 아주 작은 숫자라 변화가 천천히 일어납니다 (물속에서 움직이는 느낌)
            const lx = previousLandmarks[i].x + (currentLandmarks[i].x - previousLandmarks[i].x) * SETTINGS.smoothFactor;
            const ly = previousLandmarks[i].y + (currentLandmarks[i].y - previousLandmarks[i].y) * SETTINGS.smoothFactor;
            
            // 보정된 값을 현재 값으로 사용
            currentLandmarks[i].x = lx;
            currentLandmarks[i].y = ly;
            
            // 다음 프레임을 위해 저장
            previousLandmarks[i].x = lx;
            previousLandmarks[i].y = ly;
        }

        // 보정된 랜드마크로 성형 적용
        applyFaceWarping(currentLandmarks, positions);
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
// 5. 워핑 알고리즘
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

    // 턱선 포인트들
    const chin = toWorld(landmarks[152]);
    const leftJaw = toWorld(landmarks[132]);
    const rightJaw = toWorld(landmarks[361]);
    const nose = toWorld(landmarks[1]);

    const faceSize = Math.abs(leftJaw.x - rightJaw.x);
    // 영향 범위를 살짝 줄여서(1.5 -> 1.3) 불필요한 배경 움직임 최소화
    const radius = faceSize * 1.3; 
    const force = SETTINGS.slimStrength * 0.15;

    // 최적화: 전체 버텍스를 다 돌지만, 거리가 멀면 빠르게 스킵
    for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i+1];

        // 턱 끝과의 거리 계산
        const dx = vx - chin.x;
        const dy = vy - chin.y;
        
        // 간단한 사각형 박스 체크로 먼저 걸러내기 (속도 향상)
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;

        const distSq = dx*dx + dy*dy;
        if (distSq < radius * radius) {
            const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4)));
            
            const dirX = nose.x - vx;
            const dirY = nose.y - vy;
            
            positions[i] += dirX * factor * force;
            positions[i+1] += dirY * factor * force * 0.5;
        }
    }
}

// 이벤트 핸들러
slimRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    previousLandmarks = []; // 초기화
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
