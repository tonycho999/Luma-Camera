import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

// ==========================================
// [설정] 떨림 차단 & 얼굴 조명
// ==========================================
const SETTINGS = {
    slimStrength: 0.3, 
    
    // [핵심 1] 떨림 차단 임계값 (이 값보다 적게 움직이면 절대 갱신 안 함)
    // 3.5픽셀: 숨 쉴 때의 미세한 움직임은 무시함 (고정됨)
    movementThreshold: 3.5, 

    // [핵심 2] 얼굴 조명 강도 (0.0 ~ 1.0)
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
let lastVideoTime = -1;

// Three.js 변수
let renderer, scene, camera;
let videoTexture, meshPlane;
let originalPositions;

// [얼굴 조명용 변수]
let beautySprite; 

// [떨림 방지용 변수]
let currentDisplayLandmarks = null; // 현재 화면에 그려진 좌표

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

    // 비디오 평면
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

    // [NEW] 얼굴 조명 (Sprite) 생성
    createBeautyLight();

    window.addEventListener('resize', onWindowResize);
}

// 얼굴만 밝혀주는 '조명(Sprite)' 만들기
function createBeautyLight() {
    // 캔버스에 그라데이션 원을 그려서 텍스처로 만듦
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    
    // 흰색 -> 투명 그라데이션 (얼굴 하이라이트 효과)
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 230, 230, 1.0)'); // 중심: 살짝 핑크빛 흰색
    gradient.addColorStop(0.4, 'rgba(255, 240, 240, 0.5)'); 
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');   // 외곽: 투명

    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ 
        map: texture, 
        transparent: true,
        opacity: SETTINGS.beautyOpacity,
        blending: THREE.AdditiveBlending // 빛을 더해주는 효과
    });

    beautySprite = new THREE.Sprite(material);
    beautySprite.scale.set(0, 0, 1); // 처음엔 안 보이게
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
// 4. 렌더링 루프 (떨림 차단 & 조명 추적)
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
        let shouldUpdate = false;

        // [떨림 차단 로직]
        if (!currentDisplayLandmarks) {
            // 처음엔 무조건 업데이트
            currentDisplayLandmarks = JSON.parse(JSON.stringify(rawLandmarks));
            shouldUpdate = true;
        } else {
            // 움직임 계산 (코, 턱, 눈 등 주요 포인트만 비교)
            let totalDiff = 0;
            const checkPoints = [1, 152, 33, 263, 132]; // 5개 포인트
            
            for (let idx of checkPoints) {
                const dx = (rawLandmarks[idx].x - currentDisplayLandmarks[idx].x) * canvasElement.width;
                const dy = (rawLandmarks[idx].y - currentDisplayLandmarks[idx].y) * canvasElement.height;
                totalDiff += Math.sqrt(dx*dx + dy*dy);
            }
            const avgDiff = totalDiff / checkPoints.length;

            // [판단] 움직임이 임계값(3.5px)을 넘었는가?
            if (avgDiff > SETTINGS.movementThreshold) {
                // 크게 움직였으므로 업데이트 (부드럽게 따라가기)
                // 0.2 속도로 Lerp
                for (let i = 0; i < rawLandmarks.length; i++) {
                    currentDisplayLandmarks[i].x += (rawLandmarks[i].x - currentDisplayLandmarks[i].x) * 0.2;
                    currentDisplayLandmarks[i].y += (rawLandmarks[i].y - currentDisplayLandmarks[i].y) * 0.2;
                }
                shouldUpdate = true;
            } else {
                // 조금 움직였으면 업데이트 안 함 (이전 좌표 그대로 유지 -> 고정됨)
                shouldUpdate = false; 
            }
        }

        // 결정된 좌표(currentDisplayLandmarks)로 성형 수행
        applyFaceWarping(currentDisplayLandmarks, positions);
        
        // [얼굴 조명 이동]
        updateBeautyPosition(currentDisplayLandmarks);

    } else {
        // 얼굴 없으면 조명 숨김
        if(beautySprite) beautySprite.scale.set(0,0,1);
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
// 5. 워핑 & 조명 위치
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
    const faceWidth = Math.abs(toWorld(landmarks[234]).x - toWorld(landmarks[454]).x); // 얼굴 너비

    const radius = faceWidth * 1.2; // 얼굴 크기에 맞춰 영향력 조절
    const force = SETTINGS.slimStrength * 0.15;

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

// [NEW] 얼굴 위치에 조명(Sprite) 이동시키기
function updateBeautyPosition(landmarks) {
    if (!beautySprite) return;

    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;

    // 코(1) 위치 가져오기
    const noseX = (landmarks[1].x - 0.5) * width;
    const noseY = -(landmarks[1].y - 0.5) * height;

    // 얼굴 너비 계산 (귀 대 귀)
    const leftEar = (landmarks[234].x - 0.5) * width;
    const rightEar = (landmarks[454].x - 0.5) * width;
    const faceW = Math.abs(rightEar - leftEar);

    // 조명 위치 & 크기 설정
    beautySprite.position.set(noseX, noseY, 0.1); // 얼굴보다 살짝 앞에(0.1)
    
    // 얼굴 크기보다 살짝 크게 조명 생성 (1.5배)
    const size = faceW * 1.8; 
    beautySprite.scale.set(size, size, 1);
    
    // 투명도 조절
    beautySprite.material.opacity = SETTINGS.beautyOpacity;
}


// 이벤트 핸들러
slimRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    SETTINGS.slimStrength = (1.0 - val) / 0.15;
    if(SETTINGS.slimStrength < 0) SETTINGS.slimStrength = 0;
});

beautyRange.addEventListener('input', (e) => {
    // 100~150 -> 0.0 ~ 0.8 투명도로 변환
    const val = parseInt(e.target.value); // 100 ~ 150
    SETTINGS.beautyOpacity = (val - 100) / 50 * 0.8; 
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    currentDisplayLandmarks = null;
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
