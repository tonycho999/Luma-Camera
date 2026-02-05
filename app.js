import { FaceLandmarker, FilesetResolver } from "./assets/libs/vision_bundle.js";

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const captureBtn = document.getElementById("capture-btn");
let faceLandmarker;
let lastVideoTime = -1;
let results = undefined;

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
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } }).then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
  });
}

// 3. 실시간 예측 및 그리기
async function predictWebcam() {
  // 캔버스 크기를 비디오 크기에 맞춤
  if(video.videoWidth > 0 && canvasElement.width !== video.videoWidth){
      canvasElement.width = video.videoWidth;
      canvasElement.height = video.videoHeight;
  }

  let startTimeMs = performance.now();
  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;
    results = faceLandmarker.detectForVideo(video, startTimeMs);
  }

  // 화면 그리기 (거울 모드 등은 CSS에서 처리됨)
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  // 비디오 화면 그리기
  canvasCtx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

  // 얼굴에 메쉬 그리기 (확인용)
  if (results.faceLandmarks) {
    for (const landmarks of results.faceLandmarks) {
      drawConnectors(canvasCtx, landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#C0C0C070", lineWidth: 1 });
      drawConnectors(canvasCtx, landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: "#FF3030" });
      drawConnectors(canvasCtx, landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: "#30FF30" });
    }
  }
  
  // 다음 프레임 요청
  window.requestAnimationFrame(predictWebcam);
}

// 그리기 헬퍼 함수 (MediaPipe 기본 제공 기능을 단순화)
function drawConnectors(ctx, landmarks, connections, style) {
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth || 2;
  for (const connection of connections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];
    if(start && end) {
        ctx.beginPath();
        ctx.moveTo(start.x * canvasElement.width, start.y * canvasElement.height);
        ctx.lineTo(end.x * canvasElement.width, end.y * canvasElement.height);
        ctx.stroke();
    }
  }
  ctx.restore();
}

// 시작
createFaceLandmarker();

// 촬영 버튼 기능
captureBtn.addEventListener("click", () => {
    const link = document.createElement('a');
    link.download = 'luma-photo.png';
    link.href = canvasElement.toDataURL();
    link.click();
});
