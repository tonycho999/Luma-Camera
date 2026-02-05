// [액세서리 기능 모듈]
let noseMesh;

export const AccessoryManager = {
    // 1. 초기화
    init: (scene) => {
        const geometry = new THREE.SphereGeometry(0.05, 16, 16); 
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        noseMesh = new THREE.Mesh(geometry, material);
        noseMesh.scale.set(0,0,0); 
        noseMesh.renderOrder = 1000;
        scene.add(noseMesh);
    },

    // 2. 업데이트
    updatePosition: (landmarks, camera, isFrontCamera) => {
        if (!noseMesh) return;

        const noseTip = landmarks[1]; 
        const width = camera.right - camera.left;
        const height = camera.top - camera.bottom;

        noseMesh.position.set(
            (noseTip.x - 0.5) * width * (isFrontCamera ? -1 : 1),
            -(noseTip.y - 0.5) * height,
            -noseTip.z * width * 0.5 + 0.05 
        );
        
        const faceW = Math.abs(landmarks[454].x - landmarks[234].x) * width;
        const s = faceW * 0.25;
        noseMesh.scale.set(s, s, s);
        
        // 거울모드 반전 처리
        noseMesh.scale.x = isFrontCamera ? -Math.abs(s) : Math.abs(s);
    },

    // 3. 액세서리 선택
    setAccessory: (accName) => {
        if (!noseMesh) return;
        
        if (accName === 'nose') {
            noseMesh.visible = true;
        } else {
            noseMesh.visible = false;
            noseMesh.scale.set(0,0,0);
        }
    }
};
