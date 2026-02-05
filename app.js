import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");

// UI 요소들
const captureBtn = document.getElementById("capture-btn");
const switchBtn = document.getElementById("switch-camera-btn");
const slimRange = document.getElementById("slim-range");
const beautyRange = document.getElementById("beauty-range");

let faceLandmarker;
let lastVideoTime = -1;
let results = undefined;
let isFrontCamera = true;
let currentStream = null;

// 필터 설정값
const SETTINGS = {
    slimFactor: 0.96, // 1.0 = 원본, 낮을수록 갸름함
    beautyLevel: 1.15 // 1.0 = 원본, 높을수록 뽀샤시
};

// 1. AI 모델 로딩
async function createFaceLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks("./assets/libs/wasm");
  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: "./assets/models/face_landmarker.task", delegate: "GPU" },
    outputFaceBlendshapes: true,
    runningMode: "VIDEO",
    numFaces: 1
  });
  startWebcam();
}

// 2. 웹캠 시작
function startWebcam() {
  if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
  }

  const constraints = {
    video: {
      facingMode: isFrontCamera ? "user" : "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };

  navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    currentStream = stream;
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
  }).catch(err => {
      console.error("카메라 에러:", err);
      // alert("카메라 권한을 확인해주세요.");
  });
}

// 3. 실시간 그리기 (수정된 로직)
async function predictWebcam() {
  if (!currentStream) return;

  // 캔버스 크기 동기화
  if(video.videoWidth > 0 && canvasElement.width !== video.videoWidth){
      canvasElement.width = video.videoWidth;
      canvasElement.height = video.videoHeight;
  }

  let startTimeMs = performance.now();
  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;
    results = faceLandmarker.detectForVideo(video, startTimeMs);
  }

  // 화면 지우기
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  // [1] 뽀샤시 필터 적용
  const brightness = SETTINGS.beautyLevel;
  const saturate = Math.max(1.0, SETTINGS.beautyLevel - 0.1); 
  canvasCtx.filter = `brightness(${brightness}) saturate(${saturate}) contrast(1.05)`;
  
  // [2] 슬림 모드 (핵심 수정 부분)
  // 이전: 가로를 줄임 -> 화면이 움직임 (X)
  // 지금: 세로를 늘림 -> 화면이 꽉 찬 상태 유지 (O)
  
  // 슬림 팩터가 0.95라면 가로가 95%로 보이는 효과를 내야 함.
  // 이를 위해 세로를 역수(1/0.95)만큼 늘려서 그림.
  const heightScale = 1 / SETTINGS.slimFactor; 
  const newHeight = canvasElement.height * heightScale;
  const offsetY = (canvasElement.height - newHeight) / 2; // 중앙 정렬 (위아래가 살짝 잘림)

  canvasCtx.save();
  
  // 거울 모드 (전면 카메라일 때만)
  if (isFrontCamera) {
      canvasCtx.translate(canvasElement.width, 0);
      canvasCtx.scale(-1, 1);
  }

  // 변경된 높이로 그리기 (가로 폭은 캔버스 꽉 채움)
  canvasCtx.drawImage(
      video, 
      0, offsetY, canvasElement.width, newHeight
  );
  
  canvasCtx.restore();
  canvasCtx.filter = 'none';
  
  window.requestAnimationFrame(predictWebcam);
}

// ========================
// 이벤트 리스너
// ========================

slimRange.addEventListener('input', (e) => {
    SETTINGS.slimFactor = parseFloat(e.target.value);
});

beautyRange.addEventListener('input', (e) => {
    SETTINGS.beautyLevel = parseFloat(e.target.value);
});

switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera;
    startWebcam();
});

captureBtn.addEventListener('click', () => {
    // 촬영 시 찰칵 효과
    canvasElement.style.opacity = "0.5";
    setTimeout(() => canvasElement.style.opacity = "1", 100);
    
    const link = document.createElement('a');
    const now = new Date();
    const fileName = `luma_${now.getFullYear()}${now.getMonth()+1}${now.getDate()}_${now.getHours()}${now.getMinutes()}.png`;
    
    link.download = fileName;
    link.href = canvasElement.toDataURL("image/png");
    link.click();
});

// 시작
createFaceLandmarker();
