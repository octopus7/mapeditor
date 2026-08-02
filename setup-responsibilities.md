# 설정 책임 구분

## 사람이 반드시 직접 해야 하는 항목

- [ ] Cloudflare와 Google Cloud 계정의 소유권, 약관, 결제 수단과 요금제를 확인한다.
- [ ] Wrangler 및 Google Cloud Console 로그인 과정에서 브라우저 인증, SSO 또는 MFA 승인을 완료한다.
- [ ] Google Cloud Console에서 OAuth 동의 화면 또는 Google Auth Platform 브랜딩을 설정하고 Web application OAuth Client를 생성한다.
- [ ] OAuth Client의 `Authorized JavaScript origins`에 `https://mapedit.pages.dev`를 등록한다. 로컬 로그인이 필요하면 `http://localhost:4173`과 `http://127.0.0.1:4173`도 등록한다.
- [ ] 팝업 로그인 구성에서는 `Authorized redirect URIs`를 비워 둔다. 별도 콜백 URL이 필요하지 않으며 애플리케이션에서 Google OAuth Client Secret을 사용하지 않는다.
- [ ] `scripts/Initialize-Secrets.ps1`을 실행하고 생성된 `.dev.vars`에 실제 값을 직접 입력한다.
- [ ] 에이전트가 사용할 Cloudflare, Google 설정 조회 및 Git 권한을 최소 범위로 부여한다.
- [ ] 운영 데이터나 Cloudflare 리소스 삭제처럼 복구가 어려운 작업은 실행 전에 명시적으로 승인한다.

실제 시크릿 값, Google ID 토큰과 Cloudflare API 토큰은 대화, 코드, 문서, 로그 또는 Git 이력에 남기지 않는다.

## 사람이 생성하는 Google OAuth 항목

Google Cloud Console에서 애플리케이션 유형을 `Web application`으로 선택해 OAuth Client ID를 만든다. `Authorized JavaScript origins`는 위 체크리스트대로 등록하고 `Authorized redirect URIs`는 빈 상태로 저장한다. 리다이렉트 URI가 비어 있어도 Client ID는 생성되며, 사용자가 팝업 로그인을 완료하면 JavaScript 콜백으로 로그인 신원을 증명하는 ID 토큰(JWT)이 반환된다.

이 ID 토큰은 Google Drive 등의 API 호출에 사용하는 access token이 아니다. Google Cloud Console이 Web application Client Secret을 표시하더라도 현재 로그인 범위에서는 코드, 로컬 파일 또는 Worker에 등록하지 않는다. 생성된 Client ID는 브라우저 코드에 노출되는 공개 식별자이며 Pages 로그인 버튼과 Worker의 audience 검증 설정에 동일한 값을 연결한다.

## 권한 확보 후 에이전트가 수행할 수 있는 영역

| 영역 | 에이전트가 수행할 수 있는 작업 | 필요한 선행 조건 |
|---|---|---|
| Pages | 공개 설정 연결, 정적 검사와 빌드, Wrangler Direct Upload, 운영 페이지 확인 | Wrangler 인증과 Pages 배포 권한 |
| Worker | `mapeditor-api` 구성, Google ID 토큰 검증, 세션과 프로필 API 구현, CORS 설정, Wrangler 배포 | Workers 배포 권한 |
| D1 | 데이터베이스 생성, 바인딩 연결, 사용자·프로필 마이그레이션 작성, 로컬 검증과 원격 적용 | D1 관리 권한과 Wrangler 인증 |
| Worker Secrets | 필요한 키 이름 선언, 예시 및 초기화 스크립트 유지, 사람이 입력한 값을 Worker Secret으로 등록 | 실제 값이 입력된 로컬 `.dev.vars`와 Workers 배포 권한 |
| Google OAuth 연결 | 사람이 발급한 Client ID를 Pages와 Worker 설정에 연결하고 팝업 로그인 동작 검증 | OAuth Client가 생성되고 origin이 등록되어 있음 |
| Git | 정적 검사와 배포 성공 후 영어 메시지로 커밋하고 현재 브랜치 푸시 | Git 원격 인증과 푸시 권한 |

에이전트는 권한이 있더라도 결제·소유권 변경, MFA 승인, 동의 화면의 법적 정보 확정, 명시적 승인 없는 운영 데이터 삭제를 대신하지 않는다.

## 로컬 시크릿 파일 사용법

버전 관리되는 예시 파일을 이용해 실제 값 파일을 최초 한 번 생성한다.

```powershell
.\scripts\Initialize-Secrets.ps1
```

- `secrets.example.env`에는 실제 값 없이 키 이름, 용도와 획득 방법만 기록한다.
- `.dev.vars`가 없으면 초기화 스크립트가 예시 파일을 복사해 생성한다.
- `.dev.vars`가 이미 있으면 스크립트는 파일을 덮어쓰거나 내용을 출력하지 않는다.
- 예시 파일에 키가 새로 추가된 뒤 기존 `.dev.vars`를 사용 중이라면 사람이 새 키를 직접 추가한다.
- 실제 값은 `.dev.vars`에만 입력한다. 이 파일과 `.dev.vars.*`는 `.gitignore`로 제외한다.
- Worker 배포 시 민감한 값은 Wrangler를 통해 Worker Secrets로 등록하며 `wrangler.jsonc`의 평문 `vars`에 넣지 않는다.

Google OAuth Client ID는 공개 식별자이므로 필요하면 Pages 빌드 설정과 Worker의 비민감 환경 설정에 둘 수 있다. `SESSION_SECRET`과 `BOOTSTRAP_TOKEN`은 민감한 값이므로 Worker Secrets로 관리한다.

## 로컬 실행 및 배포 원칙

- GitHub Actions와 `.github/workflows`를 사용하지 않는다.
- 개발, 정적 검사, D1 마이그레이션, 배포, 커밋과 푸시는 권한이 설정된 로컬 환경에서 수행한다.
- 자동화와 배포 보조 스크립트는 PowerShell로 작성한다.
- 기본 순서는 `로컬 검증 → 정적 검사 → 원격 D1 마이그레이션 → Wrangler 배포 → 배포 확인 → 커밋 → 푸시`이다.
- 정적 검사, 원격 마이그레이션 또는 배포가 실패하면 커밋과 푸시를 진행하지 않는다.
