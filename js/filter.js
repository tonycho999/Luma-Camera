// [필터 기능 모듈]
export const FilterManager = {
    // 필터 적용 함수
    applyFilter: (canvasElement, filterType) => {
        let filterString = '';
        
        if (filterType === 'vintage') {
            filterString = 'sepia(0.5) contrast(0.9) brightness(1.1)';
        } else if (filterType === 'mono') {
            filterString = 'grayscale(1) contrast(1.1)';
        }
        
        // 기본값(none)일 때는 빈 문자열 ''이 들어가서 필터 꺼짐
        canvasElement.style.filter = filterString;
    }
};
