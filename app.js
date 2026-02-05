import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 단체 사진용 (최대 20명)
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    
    // 화면 갱신 간격 (0.1초)
    updateInterval: 100, 

    // 조명 강도
    beautyOpacity: 0.4,
    
    // [핵심] 최대 20명까지 인식 (성능에 따라 버벅일 수 있음)
    maxFaces: 20
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

// 시간 관리
let lastUpdateTime = 0;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// 조명 배열
let beautySprites = []; 

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

    // 20개의 조명을 미리 만들어둡니다.
    createBeautyLightsPool();

    window.addEventListener('resize', onWindowResize);
}

// 조명 풀 생성 (최대 인원수만큼)
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

    // 20개 생성
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
}

// ==========================================
// 2. AI 모델 (20명 설정)
// ==========================================
async function createFaceLandmarker() {
    const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" },
        outputFaceBlendshapes: false,
        runningMode: "VIDEO",
        // [수정됨] 20명
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
// 4. 렌더링 루프 (0.1초마다 실행)
// ==========================================
function renderLoop(timestamp) {
    requestAnimationFrame(renderLoop);

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

    // 조명 초기화
    beautySprites.forEach(sprite => {
        sprite.scale.set(0,0,1);
        sprite.material.opacity = 0;
    });

    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
        
        // 발견된 모든 얼굴(최대 20명) 처리
        results.faceLandmarks.forEach((landmarks, index) => {
            applyFaceWarping(landmarks, positions);
            
            if (index < beautySprites.length) {
                const sprite = beautySprites[index];
                updateBeautyPosition(landmarks, sprite);
                sprite.material.opacity = SETTINGS.beautyOpacity; 
            }
        });
    }

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
    link.download = `luma_group.png`;
    link.href = dataURL;
    link.click();
});

initThreeJS();
createFaceLandmarker();
