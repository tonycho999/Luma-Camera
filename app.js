import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 최후의 수단: 강제 고정 모드
// ==========================================
const SETTINGS = {
    slimStrength: 0.3,
    beautyLevel: 120,
    
    // [핵심] 고정 강도 (높을수록 안 떨림)
    // 0.9 = 90%는 이전 위치 유지, 10%만 반영 (엄청 뻑뻑함)
    anchorStrength: 0.92, 

    // [핵심] 무시 임계값 (이 값보다 작게 움직이면 무시)
    ignoreThreshold: 2.5 // 픽셀 단위
};

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const statusMsg = document.getElementById("ai-status");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");

let faceLandmarker;
let isFrontCamera = true;
let currentStream = null;
let lastVideoTime = -1;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// [떨림 방지용 변수]
let stableLandmarks = []; // 화면에 그려지고 있는 '진짜' 좌표

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
// 2. AI 모델
// ==========================================
async function createFaceLandmarker() {
    if(statusMsg) statusMsg.style.display = "block";
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
            renderLoop();
        };
    }).catch(err => console.error("카메라 에러:", err));
}

// ==========================================
// 4. 렌더링 루프 (강력한 안정화 적용)
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

    // 메쉬 리셋
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        if(statusMsg) statusMsg.style.display = "none";
        
        const rawLandmarks = results.faceLandmarks[0];

        // [초기화] 첫 프레임이면 그냥 저장
        if (stableLandmarks.length === 0) {
            for(let lm of rawLandmarks) {
                stableLandmarks.push({x: lm.x, y: lm.y});
            }
        }

        // [핵심 알고리즘] 앵커(Anchor) 방식
        // 새로 들어온 좌표(raw)가 기존 좌표(stable)와 얼마나 다른지 검사
        for (let i = 0; i < rawLandmarks.length; i++) {
            const oldX = stableLandmarks[i].x;
            const oldY = stableLandmarks[i].y;
            const newX = rawLandmarks[i].x;
            const newY = rawLandmarks[i].y;

            // 픽셀 단위 차이 계산 (대략적)
            const diffX = Math.abs((newX - oldX) * canvasElement.width);
            const diffY = Math.abs((newY - oldY) * canvasElement.height);
            const dist = Math.sqrt(diffX*diffX + diffY*diffY);

            // 1. 변화량이 너무 작으면(2.5픽셀 미만) -> 무시! (이전 좌표 유지)
            if (dist < SETTINGS.ignoreThreshold) {
                // 업데이트 안 함 (old 값 유지)
            } 
            // 2. 변화량이 크면 -> 아주 천천히 따라감 (0.08 속도)
            else {
                // 공식: 이전값 * 0.92 + 새값 * 0.08
                stableLandmarks[i].x = oldX * SETTINGS.anchorStrength + newX * (1 - SETTINGS.anchorStrength);
                stableLandmarks[i].y = oldY * SETTINGS.anchorStrength + newY * (1 - SETTINGS.anchorStrength);
            }
        }

        // 이렇게 계산된 '아주 둔감한' 좌표로 성형을 합니다.
        applyFaceWarping(stableLandmarks, positions);

    } else {
        // 얼굴 놓치면 초기화 하지 않고 마지막 모습 유지 (깜빡임 방지)
    }

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

    // 최적화된 워핑 루프
    for (let i = 0; i < positions.length; i += 3) {
        const vx = positions[i];
        const vy = positions[i+1];
        
        // 1차 필터 (박스 체크)
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
    // blur를 0.5px로 줘서 뽀샤시 효과 (너무 강하면 흐려보임)
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
    stableLandmarks = []; // 초기화
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
