import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 0.1초 스텝 & 조명 위치 버그 수정
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    
    // [핵심] 화면 갱신 간격 (ms)
    // 100ms = 0.1초 (초당 10프레임)
    // 0.2초보다 부드럽지만, 여전히 떨림은 물리적으로 차단됨
    updateInterval: 100, 

    // 조명 강도
    beautyOpacity: 0.4 
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

// 시간 관리 변수
let lastUpdateTime = 0;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// [조명 변수]
let beautySprite; 

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

    createBeautyLight();

    window.addEventListener('resize', onWindowResize);
}

// 부드러운 조명 생성
function createBeautyLight() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    
    // 핑크빛 화사한 조명
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 235, 235, 1.0)'); 
    gradient.addColorStop(0.5, 'rgba(255, 245, 245, 0.4)'); 
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ 
        map: texture, 
        transparent: true,
        opacity: 0, 
        blending: THREE.AdditiveBlending,
        depthTest: false
    });

    beautySprite = new THREE.Sprite(material);
    beautySprite.scale.set(1, 1, 1);
    beautySprite.renderOrder = 999; 
    scene.add(beautySprite);
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
// 4. 렌더링 루프 (0.1초 스텝)
// ==========================================
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);

    // [핵심] 0.1초(100ms)마다 업데이트
    if (timestamp - lastUpdateTime < SETTINGS.updateInterval) {
        return; 
    }
    lastUpdateTime = timestamp;

    let results;
    if (video.readyState >= 2 && faceLandmarker) {
        let startTimeMs = performance.now();
        results = faceLandmarker.detectForVideo(video, startTimeMs);
    }

    // 메쉬 리셋
    const positions = meshPlane.geometry.attributes.position.array;
    for (let i = 0; i < positions.length; i++) {
        positions[i] = originalPositions[i];
    }

    let faceFound = false;

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        faceFound = true;
        const landmarks = results.faceLandmarks[0];

        // 워핑 적용
        applyFaceWarping(landmarks, positions);
        
        // 조명 위치 이동 (좌우 반전 보정 포함)
        updateBeautyPosition(landmarks);
    }

    // 조명 투명도 갱신
    const targetOpacity = faceFound ? SETTINGS.beautyOpacity : 0;
    if (beautySprite) {
        beautySprite.material.opacity = targetOpacity;
    }

    // 거울 모드 (메쉬 좌우 반전)
    if (isFrontCamera) {
        meshPlane.scale.x = -1;
    } else {
        meshPlane.scale.x = 1;
    }

    meshPlane.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}

// ==========================================
// 5. 워핑 & 조명 로직
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

// [핵심] 조명 위치 계산 (거울모드 버그 수정)
function updateBeautyPosition(landmarks) {
    if (!beautySprite) return;

    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;

    // 코 위치 계산 (0.0 ~ 1.0 -> 월드 좌표)
    let noseX = (landmarks[1].x - 0.5) * width;
    const noseY = -(landmarks[1].y - 0.5) * height;

    // [중요] 전면 카메라(거울모드)일 경우, 조명 위치도 반대로 뒤집어야 함!
    // 메쉬는 scale.x = -1로 뒤집히지만, 스프라이트는 독립적이라서 직접 좌표를 뒤집어줘야 함.
    if (isFrontCamera) {
        noseX = -noseX; 
    }

    const leftEar = (landmarks[234].x - 0.5) * width;
    const rightEar = (landmarks[454].x - 0.5) * width;
    const faceW = Math.abs(rightEar - leftEar);

    beautySprite.position.set(noseX, noseY, 0.1); 
    const size = faceW * 2.0; 
    beautySprite.scale.set(size, size, 1);
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
    link.download = `luma_photo.png`;
    link.href = dataURL;
    link.click();
});

initThreeJS();
createFaceLandmarker();
