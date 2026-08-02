# mapeditor

[데모 페이지](https://mapedit.pages.dev)

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

현재 배포 구조와 사람이 직접 준비해야 하는 설정은 각각 [deployment-architecture.md](./deployment-architecture.md)와 [setup-responsibilities.md](./setup-responsibilities.md)를 참고한다.
