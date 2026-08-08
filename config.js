// ————————————————————————————————————————————
// Firebase 설정 (선택)
//
// 비워두면(null) 로컬 모드로 동작합니다.
// 로컬 모드에서는 글이 각자의 브라우저에만 저장되어
// 다른 사람에게 보이지 않습니다.
//
// 여러 사람이 같은 게시판을 공유하려면:
//   1. https://console.firebase.google.com 에서 무료 프로젝트 생성
//   2. Firestore Database 만들기 (테스트 모드로 시작)
//   3. 프로젝트 설정 > 웹 앱 추가 > firebaseConfig 값을 아래에 붙여넣기
//
// 예시:
// window.FIREBASE_CONFIG = {
//   apiKey: "...",
//   authDomain: "xxx.firebaseapp.com",
//   projectId: "xxx",
//   storageBucket: "xxx.appspot.com",
//   messagingSenderId: "...",
//   appId: "..."
// };
// ————————————————————————————————————————————

window.FIREBASE_CONFIG = null;
