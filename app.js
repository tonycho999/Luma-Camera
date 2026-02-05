import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 초기값 (슬라이더와 연결됨)
// ==========================================
const SETTINGS = {
    slimStrength: 0.3,   // 턱 깎기 강도 (0.0 ~ 1.0)
    bigEyeStrength: 0.0, // 눈 키우기 (아직 미구현, 다음 단계)
    warpRadius: 0.4      // 성형 범위 (얼굴 크기 대비)
};

// ==========================================
// [전역 변수]
// ==========================================
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
// UI 요소
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const slimRange = document.getElementById("slim-range");
// const beautyRange = document.getElementById("beauty-range"); // 3D에서는 쉐이더로 구현해야 함 (일단 보류)

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastVideoTime = -1;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions; // 고무판의 원래 모양 기억용

// ==========================================
// 1. Three.js 엔진 초기화 (고무판 만들기)
// ==========================================
function initThreeJS() {
    // 캔버스 크기 설정
    const width = window.innerWidth;
    const height = window.innerHeight;

    // 렌더러 생성
    renderer = new THREE.WebGLRenderer({ 
        canvas: canvasElement, 
        antialias: false, // 성능을 위해 끔
        powerPreference: "high-performance"
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 픽셀 비율 제한 (발열 방지)

    // 씬 생성
    scene = new THREE.Scene();

    // 카메라 생성 (직교 카메라 - 원근감 없음)
    // 화면 비율 계산
    const aspect = width / height;
    // 세로 길이를 2.0으로 고정 (-1 ~ +1)
    const frustumHeight = 2.0;
    const frustumWidth = frustumHeight * aspect;

    camera = new THREE.OrthographicCamera(
        frustumWidth / -2, frustumWidth / 2,
        frustumHeight / 2, frustumHeight / -2,
        0.1, 100
    );
    camera.position.z = 10;

    // 비디오 텍스처 생성
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.format = THREE.RGBFormat;
    videoTexture.generateMipmaps = false;

    // [핵심] 고해상도 평면 메쉬 생성 (가로 64칸, 세로 64칸)
    // 칸이 많을수록 성형이 부드럽지만 느려짐 (64x64가 모바일에 적당)
    const geometry = new THREE.PlaneGeometry(frustumWidth, frustumHeight, 64, 64);
    
    // 원래 정점 위치 저장 (나중에 복구하기 위해)
    const count = geometry.attributes.position.count;
    originalPositions = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
        originalPositions[i] = geometry.attributes.position.array[i];
    }

    // 재질 생성 (비디오를 입힘)
    const material = new THREE.MeshBasicMaterial({ 
        map: videoTexture,
        side: THREE.DoubleSide
    });

    meshPlane = new THREE.Mesh(geometry, material);
    scene.add(meshPlane);

    // 창 크기 변경 대응
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

    // 메쉬 크기도 재조정해야 하지만, 복잡하므로 여기선 생략 (새로고침 권장)
}

// ==========================================
// 2. AI 모델 로딩
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
// 4. [핵심] 렌더링 루프 (매 프레임 실행)
// ==========================================
function renderLoop() {
    // 1. 얼굴 인식
    let results;
    if (video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        if (lastVideoTime !== video.currentTime) {
            lastVideoTime = video.currentTime;
            results = faceLandmarker.detectForVideo(video, startTimeMs);
        }
    }

    // 2. 메쉬 초기화 (원래 모양으로 복구)
    // 매 프레임마다 고무판을 펴줘야 성형이 중첩되지 않음
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    // 3. 성형 로직 적용 (얼굴이 발견되면)
    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        applyFaceWarping(results.faceLandmarks[0], positions);
    }
    
    // 거울 모드 처리 (Mesh 자체를 뒤집음)
    if (isFrontCamera) {
        meshPlane.scale.x = -1;
    } else {
        meshPlane.scale.x = 1;
    }

    // 변경된 메쉬 업데이트 알림
    meshPlane.geometry.attributes.position.needsUpdate = true;

    // 4. 그리기
    renderer.render(scene, camera);
    requestAnimationFrame(renderLoop);
}

// ==========================================
// 5. [마법] 워핑 알고리즘 (성형 수술)
// ==========================================
function applyFaceWarping(landmarks, positions) {
    // 턱 깎기 강도가 0이면 실행 안 함
    if (SETTINGS.slimStrength <= 0.01) return;

    // 1. 주요 좌표 찾기 (MediaPipe 기준)
    // 턱 끝(152), 왼쪽 턱각(172), 오른쪽 턱각(397)
    // 좌표계 변환: AI(0~1) -> Three.js 월드 좌표
    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    
    function toWorld(lm) {
        // AI 좌표(y는 아래가 1) -> Three.js(y는 위가 양수)
        // 비디오 비율 고려 필요... 일단 단순 매핑
        return {
            x: (lm.x - 0.5) * width,
            y: -(lm.y - 0.5) * height // Y축 반전
        };
    }

    const chin = toWorld(landmarks[152]);
    const leftJaw = toWorld(landmarks[132]);  // 귀 밑 턱
    const rightJaw = toWorld(landmarks[361]); // 귀 밑 턱
    
    // 얼굴 중심 (코 끝)
    const nose = toWorld(landmarks[1]);

    // 2. 워핑 적용 (모든 점을 검사하며 턱 주변 점을 안으로 당김)
    // *최적화*: 전체 점을 다 돌면 느림. 턱 주변만 돌면 좋지만, 여기선 일단 전체 루프 (64x64 = 4096번이라 괜찮음)
    
    // 턱 깎기 반경 (얼굴 크기에 비례)
    const faceSize = Math.abs(leftJaw.x - rightJaw.x);
    const radius = faceSize * 1.5; // 영향 범위
    const force = SETTINGS.slimStrength * 0.15; // 당기는 힘

    for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i+1];
        // vz는 positions[i+2] (사용 안 함)

        // 턱 끝과의 거리 계산
        const dx = vx - chin.x;
        const dy = vy - chin.y;
        const distSq = dx*dx + dy*dy;
        
        // 영향 범위 안이면 당기기
        if (distSq < radius * radius) {
            const dist = Math.sqrt(distSq);
            // 가우시안 곡선 (중심일수록 세게 당김)
            const factor = Math.exp(-distSq / (2 * (radius * 0.4) * (radius * 0.4)));
            
            // 이동 방향: 현재 점 -> 얼굴 중심(코) 쪽으로
            const dirX = nose.x - vx;
            const dirY = nose.y - vy;
            
            // 적용
            positions[i] += dirX * factor * force;
            positions[i+1] += dirY * factor * force * 0.5; // Y축은 조금만
        }
    }
}

// ==========================================
// 이벤트 핸들러
// ==========================================
slimRange.addEventListener('input', (e) => {
    // 슬라이더 값 매핑 (1.0 = 원본, 0.85 = 최대 깎기)
    // UI: 0.85(최대) ~ 1.0(원본)
    // 내부 로직: 강도 0.0 ~ 1.0
    const val = parseFloat(e.target.value);
    // val이 1.0이면 강도 0, val이 0.85면 강도 1
    // (1 - 0.85) = 0.15 범위
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
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

// 시작
initThreeJS();
createFaceLandmarker();
