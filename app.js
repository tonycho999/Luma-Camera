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
let isFrontCamera = true; // 현재 카메라 상태 (true: 전면, false: 후면)
let currentStream = null;

// 필터 설정값 (슬라이더와 연결됨)
const SETTINGS = {
    slimFactor: 0.96,
    beautyLevel: 1.15
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

// 2. 웹캠 시작 (카메라 전환 기능 포함)
function startWebcam() {
  // 기존 스트림이 있다면 멈춤 (카메라 전환 시 필요)
  if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
  }

  const constraints = {
    video: {
      // 전면이면 'user', 후면이면 'environment'
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
      alert("카메라를 켤 수 없습니다.");
  });
}

// 3. 실시간 그리기
async function predictWebcam() {
  if (!currentStream) return; // 스트림 없으면 중단

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

  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  // [설정 적용] 슬라이더 값 가져오기
  const brightness = SETTINGS.beautyLevel;
  const saturate = SETTINGS.beautyLevel; // 뽀샤시는 밝기와 채도를 같이 올림
  
  canvasCtx.filter = `brightness(${brightness}) saturate(${saturate}) contrast(1.05)`;
  
  // [슬림 모드 계산]
  const slimWidth = canvasElement.width * SETTINGS.slimFactor;
  const offsetX = (canvasElement.width - slimWidth) / 2;
  
  // 거울 모드 처리 (전면 카메라일 때만 좌우 반전)
  canvasCtx.save();
  if (isFrontCamera) {
      canvasCtx.translate(canvasElement.width, 0);
      canvasCtx.scale(-1, 1);
  }

  // 그리기
  canvasCtx.drawImage(video, offsetX, 0, slimWidth, canvasElement.height);
  
  canvasCtx.restore();
  canvasCtx.filter = 'none'; // 필터 초기화
  
  window.requestAnimationFrame(predictWebcam);
}

// ========================
// [이벤트 리스너] 버튼 동작
// ========================

// 1. 슬라이더 조절 이벤트
slimRange.addEventListener('input', (e) => {
    SETTINGS.slimFactor = parseFloat(e.target.value);
});

beautyRange.addEventListener('input', (e) => {
    SETTINGS.beautyLevel = parseFloat(e.target.value);
});

// 2. 카메라 전환 버튼
switchBtn.addEventListener('click', () => {
    isFrontCamera = !isFrontCamera; // 상태 반전
    startWebcam(); // 카메라 재시작
});

// 3. 촬영 버튼
captureBtn.addEventListener('click', () => {
    canvasElement.style.opacity = "0.5";
    setTimeout(() => canvasElement.style.opacity = "1", 100);
    const link = document.createElement('a');
    link.download = 'luma-photo.png';
    link.href = canvasElement.toDataURL("image/png");
    link.click();
});

// 시작
createFaceLandmarker();
