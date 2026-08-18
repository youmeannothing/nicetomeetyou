# Nice to Meet You

지인을 구하는 게시판. 글은 작성자가 삭제할 때까지 남습니다.

## 기능

- 로그인 없이 글 작성 — 게시글마다 비밀번호를 정해 수정·삭제
- 게시글 영구 보존 (작성자가 비밀번호로 삭제할 때까지)
- 에디토리얼 인쇄물 스타일의 단색 디자인

## 배포 (GitHub Pages)

1. 저장소 **Settings → Pages**
2. Source: `Deploy from a branch`, Branch: `main` / `/ (root)` 선택
3. 잠시 후 `https://<계정명>.github.io/nicetomeetyou/` 에서 접속 가능

## 공유 모드 켜기 (Firebase)

기본 상태는 **로컬 모드**로, 글이 각자 브라우저에만 저장됩니다.
여러 사람이 같은 게시판을 보려면 Firebase(무료)를 연결하세요.

1. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성
2. **Firestore Database** 만들기 (테스트 모드로 시작)
3. 프로젝트 설정 → 웹 앱 추가 → `firebaseConfig` 값을 복사
4. [config.js](config.js)의 `window.FIREBASE_CONFIG = null;`을 복사한 값으로 교체

> 참고: 게시글 비밀번호는 SHA-256 해시로 저장되며, 검증은 브라우저에서 이뤄집니다.
> 지인끼리 쓰는 가벼운 게시판 용도로 설계되었습니다.
