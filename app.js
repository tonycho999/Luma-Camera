import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const captureBtn = document.getElementById("capture-btn");
let faceLandmarker;
let lastVideoTime = -1;
let results = undefined;

// ==========================================
// [설정] 뷰티 효과 강도 조절 (숫자를 바꿔보세요)
// ==========================================
const SETTINGS = {
    slimFactor: 0.96,     // 0.9 ~ 0.98 추천 (낮을수록 더 홀쭉해짐)
    brightness: 1.15,      // 1.0 = 기본, 1.2 = 20% 밝게
    saturate: 1.15,        // 1.0 = 기본, 1.2 = 색감 진하게
    contrast: 1.05         // 1.0 = 기본, 1.1 = 선명하게
};

// 1. AI 모델 로딩
async function createFaceLandmarker() {
  const filesetResolver = await FilesetResolver.forVisionTasks(
    "./assets/libs/wasm"
  );
  faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: "./assets/models/face_landmarker.task",
      delegate: "GPU"
    },
    outputFaceBlendshapes: true,
    runningMode: "VIDEO",
    numFaces: 1
  });
  startWebcam();
}

// 2. 웹캠 시작
function startWebcam() {
  navigator.mediaDevices.getUserMedia({ 
    video: { 
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    } 
  }).then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
  });
}

// 3. 실시간 예측 및 화면 그리기
async function predictWebcam() {
  // 캔버스 크기 맞춤
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
  
  // [핵심 1] 뷰티 필터 적용 (색상/밝기)
  canvasCtx.filter = `brightness(${SETTINGS.brightness}) saturate(${SETTINGS.saturate}) contrast(${SETTINGS.contrast})`;
  
  // [핵심 2] 슬림 효과 (가로를 살짝 줄여서 홀쭉하게 보임)
  // 원본 비율보다 가로(Width)를 살짝 줄여서 그립니다.
  const slimWidth = canvasElement.width * SETTINGS.slimFactor;
  const offsetX = (canvasElement.width - slimWidth) / 2; // 중앙 정렬
  
  // 비디오 그리기
  canvasCtx.drawImage(
      video, 
      offsetX, 0, slimWidth, canvasElement.height // 변형된 크기로 그리기
  );

  // [중요] 얼굴 메쉬(선) 그리기 코드는 모두 제거했습니다.
  // 이제 깔끔한 얼굴만 나옵니다.

  // 필터 초기화 (다음 프레임 영향 방지)
  canvasCtx.filter = 'none';
  
  // 반복 실행
  window.requestAnimationFrame(predictWebcam);
}

// 시작
createFaceLandmarker();

// 촬영 버튼 기능
captureBtn.addEventListener("click", () => {
    // 찰칵 애니메이션
    canvasElement.style.opacity = "0.5";
    setTimeout(() => canvasElement.style.opacity = "1", 100);

    // 이미지 저장
    const link = document.createElement('a');
    link.download = 'luma-photo.png';
    link.href = canvasElement.toDataURL("image/png");
    link.click();
});
