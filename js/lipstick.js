// [립스틱 기능 모듈]
let lipMesh;

export const LipstickManager = {
    // 1. 초기화: 립스틱 메쉬 생성
    init: (scene) => {
        // 입술 윤곽 랜드마크 인덱스
        const lipIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]; 
        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(lipIndices.length * 3);
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.0 });
        lipMesh = new THREE.Mesh(geometry, material);
        lipMesh.renderOrder = 998; 
        scene.add(lipMesh);
    },

    // 2. 업데이트: 얼굴 움직임에 따라 위치 조정
    updatePosition: (landmarks, camera, isFrontCamera) => {
        if (!lipMesh) return;
        
        const lipIndices = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61];
        const positions = lipMesh.geometry.attributes.position.array;
        
        const width = camera.right - camera.left;
        const height = camera.top - camera.bottom;

        for (let i = 0; i < lipIndices.length; i++) {
            const lm = landmarks[lipIndices[i]];
            positions[i * 3] = (lm.x - 0.5) * width * (isFrontCamera ? -1 : 1);
            positions[i * 3 + 1] = -(lm.y - 0.5) * height;
            positions[i * 3 + 2] = -lm.z * width * 0.5 + 0.01; 
        }
        lipMesh.geometry.attributes.position.needsUpdate = true;
    },

    // 3. 색상 변경
    setColor: (colorName) => {
        if (!lipMesh) return;
        
        if (colorName === 'none') {
            lipMesh.material.opacity = 0;
            return;
        }

        let hex = 0xffffff;
        if(colorName === 'pink') hex = 0xFF69B4;
        else if(colorName === 'red') hex = 0xFF0000;
        else if(colorName === 'coral') hex = 0xFF7F50;

        lipMesh.material.color.setHex(hex);
        lipMesh.material.opacity = 0.5; // 색이 있을 때만 반투명
    }
};
