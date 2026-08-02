# mapeditor

[데모 페이지](https://mapeditor-c2n.pages.dev)

2D 기반 맵 에디터 웹

풀·흙·돌·물 바닥 타일과 숲 사물을 조합해 개울이 있는 숲의 레이아웃을 빠르게 구성한다. 현재 초안은 브라우저에 자동 저장되며 PNG와 JSON으로 내보낼 수 있다.

## 로컬 실행

```powershell
npm install
.\scripts\Start-Web.ps1
```

정적 검사와 Pages 운영 배포는 다음 스크립트로 실행한다.

```powershell
.\scripts\Deploy-Pages.ps1
```

## 이미지 업로드

이미지 업로드 기능은 [external-service-integration.md](https://github.com/octopus7/meme/blob/main/docs/external-service-integration.md)에 정의된 외부 서비스 연동 방식을 사용한다.
