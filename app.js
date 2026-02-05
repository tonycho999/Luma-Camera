import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정]
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    warpRadius: 0.4,
    // [NEW] 떨림 방지 강도 (0.0 ~ 1.0)
    // 0.1: 아주 부드럽지만 반응이 느림
    // 0.8: 반응이 빠르지만 조금 떨림
    // 0.5: 적당함
    smoothFactor: 0.3 
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

// [NEW] 이전 프레임의 랜드마크를 기억할 변수 (떨림 방지용)
let previousLandmarks = null; 

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
// 2. AI 모델 로드
// ==========================================
async function createFaceLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" },
    outputFaceBlendshapes: false,
    runningMode: "VIDEO",
    numFaces: 1
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
// 4. 렌더링 루프 (스무딩 적용)
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

    // 메쉬 초기화
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        const currentLandmarks = results.faceLandmarks[0];

        // [핵심] 떨림 방지 (Smoothing)
        if (previousLandmarks) {
            for (let i = 0; i < currentLandmarks.length; i++) {
                // 이전 위치와 현재 위치 사이를 부드럽게 이동 (Lerp)
                // 공식: 현재값 = 이전값 + (새값 - 이전값) * 0.3
                const lx = previousLandmarks[i].x + (currentLandmarks[i].x - previousLandmarks[i].x) * SETTINGS.smoothFactor;
                const ly = previousLandmarks[i].y + (currentLandmarks[i].y - previousLandmarks[i].y) * SETTINGS.smoothFactor;
                
                // 보정된 값을 현재 값으로 덮어쓰기 (화면엔 보정된 값이 나감)
                currentLandmarks[i].x = lx;
                currentLandmarks[i].y = ly;
            }
        }
        // 현재 보정된 값을 '이전 값'으로 저장해둠
        // (깊은 복사가 필요함)
        previousLandmarks = JSON.parse(JSON.stringify(currentLandmarks));

        // 보정된 랜드마크로 성형 적용
        applyFaceWarping(currentLandmarks, positions);
    } else {
        // 얼굴 놓치면 초기화
        previousLandmarks = null;
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

        const dx = vx - chin.x;
        const dy = vy - chin.y;
        const distSq = dx*dx + dy*dy;
        
        if (distSq < radius * radius) {
            const dist = Math.sqrt(distSq);
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

// 뽀샤시는 아직 미구현이지만 에러 방지용
if(beautyRange) {
    beautyRange.addEventListener('input', (e) => {
        // 나중에 쉐이더로 구현
    });
}

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    previousLandmarks = null; // 카메라 바꾸면 초기화
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
