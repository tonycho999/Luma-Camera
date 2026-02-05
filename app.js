import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 극강의 안정성 모드
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    beautyLevel: 120,
    
    // [핵심] 데드존 (이 값보다 적게 움직이면 아예 화면 갱신을 안 함 = 떨림 0)
    deadzone: 1.5, // 픽셀 단위 (높을수록 안정적이나 반응이 둔함)
    
    // 분석 시간 (손 뗐을 때 안정화하는 시간 ms)
    analyzeTime: 600 
};

// DOM 요소
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const statusMsg = document.getElementById("ai-status");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");

// 변수
let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastVideoTime = -1;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// [안정화 로직 변수들]
let isAdjusting = false;   // 슬라이더 조작 중인가?
let isAnalyzing = false;   // 데이터 수집 중인가?
let landmarkHistory = [];  // 평균값을 내기 위한 데이터 버퍼
let lockedLandmarks = null; // 고정된 랜드마크 (떨림 방지용)
let analyzeTimeout = null; // 타이머

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

    // 64x64 메쉬
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

    applyBeautyFilter(); // 초기 뽀샤시

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
// 2. AI 모델
// ==========================================
async function createFaceLandmarker() {
    showStatus("AI 초기화 중...");
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
// 3. 웹캠
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
            showStatus("얼굴을 찾는 중...");
            renderLoop();
        };
    }).catch(err => console.error("카메라 에러:", err));
}

// ==========================================
// 4. 렌더링 루프 (스마트 고정 로직)
// ==========================================
function renderLoop() {
    // 1. AI 인식
    let results;
    if (video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        if (lastVideoTime !== video.currentTime) {
            lastVideoTime = video.currentTime;
            results = faceLandmarker.detectForVideo(video, startTimeMs);
        }
    }

    // 2. 메쉬 리셋 (항상 깨끗한 상태에서 시작)
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    // 3. 로직 분기
    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        // 얼굴 찾음
        if(statusMsg.innerText === "얼굴을 찾는 중...") hideStatus();

        const rawLandmarks = results.faceLandmarks[0];

        // A. 슬라이더 조절 중 -> 성형 안 함 (원본만 보여줌)
        if (isAdjusting) {
            // 아무것도 안 함 (메쉬 리셋 상태 유지)
        }
        // B. 분석 중 (데이터 수집) -> 성형 안 함, 데이터만 모음
        else if (isAnalyzing) {
            landmarkHistory.push(rawLandmarks);
        }
        // C. 평상시 (고정된 데이터로 성형)
        else {
            // 고정된 데이터가 없으면 현재 데이터로 즉시 고정
            if (!lockedLandmarks) {
                lockedLandmarks = JSON.parse(JSON.stringify(rawLandmarks));
            } else {
                // [데드존 체크]
                // 현재 얼굴이 고정된 얼굴과 얼마나 차이나는지 계산
                let diff = 0;
                // 코(1), 턱(152) 등 주요 포인트 5개만 비교해서 속도 향상
                const points = [1, 152, 33, 263, 132]; 
                for(let idx of points) {
                    const dx = (rawLandmarks[idx].x - lockedLandmarks[idx].x) * canvasElement.width;
                    const dy = (rawLandmarks[idx].y - lockedLandmarks[idx].y) * canvasElement.height;
                    diff += Math.sqrt(dx*dx + dy*dy);
                }
                diff /= points.length; // 평균 이동 거리 (픽셀)

                // 많이 움직였으면(데드존 이탈) -> 서서히 따라감 (Lerp)
                if (diff > SETTINGS.deadzone) {
                     for(let i=0; i<rawLandmarks.length; i++) {
                        lockedLandmarks[i].x += (rawLandmarks[i].x - lockedLandmarks[i].x) * 0.1; // 0.1 속도로 따라감
                        lockedLandmarks[i].y += (rawLandmarks[i].y - lockedLandmarks[i].y) * 0.1;
                     }
                }
                // 적게 움직였으면 -> lockedLandmarks 값 그대로 사용 (업데이트 안 함 = 떨림 0)
            }

            // 결정된 lockedLandmarks로 성형 적용
            applyFaceWarping(lockedLandmarks, positions);
        }

    } else {
        // 얼굴 놓침
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
// 5. 워핑 & 뽀샤시
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
        
        // 1차 필터: 사각형 범위 (빠름)
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

function applyBeautyFilter() {
    const val = SETTINGS.beautyLevel;
    const brightness = val / 100; 
    const saturate = val / 100;
    // blur를 0.8px로 더 강하게 줘서 확실히 뽀샤시하게
    canvasElement.style.filter = `brightness(${brightness}) saturate(${saturate}) contrast(0.95) blur(0.8px)`;
}

// ==========================================
// 6. UI 이벤트 핸들러 (핵심 로직)
// ==========================================

// 1. 슬라이더 잡았을 때 (조작 시작)
function onSliderStart() {
    isAdjusting = true;
    showStatus("설정 조절 중... (화면 고정)");
    // 락을 풀어버림
    lockedLandmarks = null;
}

// 2. 슬라이더 놓았을 때 (조작 끝 -> 분석 시작)
function onSliderEnd() {
    isAdjusting = false;
    isAnalyzing = true;
    landmarkHistory = []; // 버퍼 비우기
    showStatus("AI 정밀 분석 및 안정화 중...");

    // 일정 시간 후 분석 종료
    setTimeout(() => {
        isAnalyzing = false;
        hideStatus();
        
        // 모인 데이터 평균내서 'Lock' 걸기
        if (landmarkHistory.length > 0) {
            const avgLandmarks = JSON.parse(JSON.stringify(landmarkHistory[0]));
            const len = landmarkHistory.length;
            
            // 모든 프레임의 좌표를 더함
            for(let i=1; i<len; i++) {
                const frame = landmarkHistory[i];
                for(let k=0; k<frame.length; k++) {
                    avgLandmarks[k].x += frame[k].x;
                    avgLandmarks[k].y += frame[k].y;
                    avgLandmarks[k].z += frame[k].z;
                }
            }
            // 나누기
            for(let k=0; k<avgLandmarks.length; k++) {
                avgLandmarks[k].x /= len;
                avgLandmarks[k].y /= len;
                avgLandmarks[k].z /= len;
            }
            
            // 최종 고정값 설정!
            lockedLandmarks = avgLandmarks;
        }
    }, SETTINGS.analyzeTime); // 0.6초 동안 수집
}


// 슬라이더 이벤트 연결
// 'input': 드래그 중 계속 발생
// 'change': 손 뗐을 때 발생 (PC/모바일 공통 지원을 위해 pointer 이벤트 사용 권장하지만 간단히 처리)
slimRange.addEventListener('mousedown', onSliderStart);
slimRange.addEventListener('touchstart', onSliderStart);

slimRange.addEventListener('change', (e) => {
    // 값 적용
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
    
    // 분석 시작
    onSliderEnd();
});
// 터치 끝났을 때도 change가 안 먹을 수 있어서 추가 처리
slimRange.addEventListener('touchend', () => {
    const val = parseFloat(slimRange.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    onSliderEnd();
});


beautyRange.addEventListener('input', (e) => {
    SETTINGS.beautyLevel = parseInt(e.target.value);
    applyBeautyFilter();
});

// 안내 문구 제어
function showStatus(text) {
    statusMsg.innerText = text;
    statusMsg.style.display = "block";
}
function hideStatus() {
    statusMsg.style.display = "none";
}

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    lockedLandmarks = null;
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
