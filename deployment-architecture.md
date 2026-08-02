# 배포 아키텍처

## 목적

맵 에디터는 Cloudflare에서 세 개의 독립적인 관리 지점으로 운영한다.

1. 정적 프론트엔드인 Cloudflare Pages
2. 영구 저장소인 Cloudflare D1
3. D1에 접근하는 별도 Cloudflare Worker API

현재 최초 페이지 단계에서는 Pages만 만들고 배포한다. D1과 API Worker는 편집 화면과 로컬 상태 관리가 안정된 이후에 추가한다.

## 전체 구성

```mermaid
flowchart LR
    U["사용자 브라우저"] --> P["Cloudflare Pages<br/>정적 맵 에디터"]
    P -. "향후 HTTPS API" .-> W["Cloudflare Worker<br/>맵 저장 API"]
    W -. "D1 Binding" .-> D["Cloudflare D1<br/>맵과 청크 저장"]
```

Pages는 D1에 직접 접근하지 않는다. 저장 기능이 추가되면 브라우저가 별도 Worker의 HTTPS API를 호출하고, Worker만 D1 바인딩을 사용한다.

## 관리 지점

| 관리 지점 | 역할 | 배포·변경 수단 | 현재 단계 |
|---|---|---|---|
| Cloudflare Pages | HTML, CSS, JavaScript, 이미지와 타일 자산 제공 | 로컬 빌드 후 Wrangler Direct Upload | 사용 |
| Cloudflare D1 | 맵, 레이어, 청크와 오브젝트 데이터 저장 | Wrangler 마이그레이션 | 아직 사용하지 않음 |
| Cloudflare Worker | 인증, 입력 검증, D1 읽기·쓰기 API | Wrangler Worker 배포 | 아직 사용하지 않음 |

## 저장소 구성 계획

```text
apps/
├─ web/                    Pages 정적 프론트엔드
│  ├─ src/
│  ├─ public/
│  └─ dist/               Pages 배포 산출물
└─ api/                    향후 별도 Worker API
   ├─ src/
   └─ wrangler.jsonc
database/
└─ migrations/            향후 D1 마이그레이션
scripts/
├─ Initialize-Secrets.ps1
├─ Deploy-Pages.ps1       향후 추가
├─ Deploy-Worker.ps1      향후 추가
└─ Apply-Migrations.ps1   향후 추가
```

실제 구현 과정에서 빌드 도구에 맞게 세부 경로는 변경할 수 있지만 Pages, API Worker와 D1 마이그레이션의 책임은 섞지 않는다.

## 1. Cloudflare Pages

### 역할

- 2D 타일 맵 편집 UI를 정적으로 제공한다.
- 흙, 돌, 물, 풀 바닥 타일과 나무, 수풀, 바위 같은 사물 이미지를 제공한다.
- 현재 단계에서는 브라우저 메모리 또는 임시 로컬 상태로만 편집한다.
- D1 바인딩, Worker Secret과 서버 코드를 포함하지 않는다.

### 배포 방식

- Pages 프로젝트는 Git 연동 대신 Direct Upload 방식으로 생성한다.
- GitHub Actions와 Pages Git 자동 배포는 사용하지 않는다.
- 에이전트가 작성한 PowerShell 스크립트에서 정적 검사, 빌드와 Wrangler 배포를 순서대로 실행한다.
- 빌드 산출물 디렉터리만 Pages에 업로드한다.

최초 프로젝트 생성 예시:

```powershell
npx wrangler pages project create
```

정적 빌드 결과 배포 예시:

```powershell
npx wrangler pages deploy .\apps\web\dist --project-name <PAGES_PROJECT_NAME>
```

미리보기 배포가 필요하면 운영 배포와 구분되는 branch 이름을 명시한다.

```powershell
npx wrangler pages deploy .\apps\web\dist --project-name <PAGES_PROJECT_NAME> --branch preview
```

Direct Upload 프로젝트는 나중에 Git 연동 방식으로 바로 전환할 수 없으므로, 계속 로컬 Wrangler 배포를 유지한다. Git 연동이 필요해지면 별도 Pages 프로젝트를 새로 만든다.

### 배포 순서

1. 의존성을 설치한다.
2. 린트, 타입 검사와 테스트를 실행한다.
3. 정적 페이지를 빌드한다.
4. 빌드 산출물과 필수 이미지가 존재하는지 확인한다.
5. Wrangler로 Pages에 Direct Upload 한다.
6. 배포 URL에서 초기 화면, 이미지 로딩과 기본 편집 동작을 확인한다.
7. 배포가 성공하면 영어 메시지로 커밋하고 현재 브랜치를 푸시한다.

## 2. Cloudflare D1

### 역할

- 맵 메타데이터, 레이어, 청크 payload, 오브젝트와 revision을 저장한다.
- 실제 시크릿 값은 D1에 저장하지 않는다.
- 스키마 변경은 `database/migrations`의 SQL 마이그레이션으로 관리한다.

### 도입 시점

- 최초 Pages 편집 화면과 셀·레이어 모델이 안정된 이후에 생성한다.
- 로컬 D1에서 마이그레이션과 저장 테스트를 먼저 통과시킨 뒤 원격 D1에 적용한다.
- Pages 배포와 D1 마이그레이션을 하나의 리소스로 취급하지 않는다.

### 변경 순서

1. 새 마이그레이션을 작성한다.
2. 로컬 D1에 적용하고 테스트한다.
3. 하위 호환성을 확인한다.
4. 원격 D1에 적용한다.
5. D1을 사용하는 Worker를 배포한다.

## 3. Cloudflare Worker API

### 역할

- Pages에서 전달한 요청의 인증과 입력값을 검증한다.
- D1 바인딩을 통해서만 맵 데이터를 읽고 쓴다.
- revision 충돌과 오류 응답을 처리한다.
- `BOOTSTRAP_TOKEN`과 향후 필요한 민감한 값은 Worker Secrets로 사용한다.

### Pages와의 연결

- Pages는 공개 HTTPS 주소를 통해 Worker API를 호출한다.
- Worker는 허용된 Pages 운영 도메인과 필요한 미리보기 도메인만 CORS 허용 목록에 둔다.
- 운영에서는 무조건 `*` CORS를 사용하지 않고 요청의 Origin을 검증한다.
- API 기본 주소는 빌드 시 주입 가능한 비민감 설정으로 관리한다.
- Cloudflare 배포용 API Token과 애플리케이션의 `BOOTSTRAP_TOKEN`을 분리한다.

### 배포 순서

1. Worker 타입, 린트와 테스트를 실행한다.
2. D1 마이그레이션 호환성을 확인한다.
3. 필요한 시크릿 이름과 등록 상태를 확인한다.
4. Wrangler로 Worker를 배포한다.
5. 상태 확인과 핵심 API 호출을 검증한다.
6. 배포가 성공하면 영어 메시지로 커밋하고 현재 브랜치를 푸시한다.

## 환경과 주소

| 환경 | Pages | Worker | D1 |
|---|---|---|---|
| 로컬 | 프론트엔드 개발 서버 | Wrangler 로컬 Worker | Wrangler 로컬 D1 |
| 미리보기 | Pages branch preview | 필요할 때 별도 Worker 환경 | 운영 D1과 분리된 테스트 DB 권장 |
| 운영 | `*.pages.dev` 또는 Pages 사용자 도메인 | `*.workers.dev` 또는 API 사용자 도메인 | 운영 D1 |

프로젝트 이름, Worker 이름, D1 이름과 사용자 도메인은 실제 리소스를 만들기 전에 확정한다. 문서나 스크립트에 임의의 운영 이름을 하드코딩하지 않는다.

## 시크릿 경계

- Pages 정적 파일에는 시크릿을 넣지 않는다. 브라우저에 전달되는 값은 모두 공개된 것으로 간주한다.
- Worker Secret의 실제 값은 Git에서 제외된 `.dev.vars`에만 입력한다.
- 배포 스크립트는 시크릿 파일 내용을 출력하지 않는다.
- D1에는 애플리케이션 시크릿 원문을 저장하지 않는다.

## 장애와 롤백 원칙

- Pages 배포 실패는 Worker와 D1에 영향을 주지 않아야 한다.
- Worker 배포 실패 시 기존 Worker 버전을 유지하거나 직전 정상 버전으로 되돌린다.
- D1 스키마는 가능한 한 추가 방식으로 변경하고, 파괴적 변경 전에 백업과 복구 절차를 준비한다.
- 세 관리 지점의 배포 결과와 URL을 각각 기록한다.
- 정적 검사, 마이그레이션 또는 배포가 실패하면 커밋과 푸시를 진행하지 않는다.

## 현재 작업 범위

- ImageGen으로 2D 탑다운 숲과 개울용 타일·사물 이미지를 준비한다.
- D1과 API Worker 없이 동작하는 최초 정적 맵 편집 페이지를 만든다.
- 정적 검사를 통과한 빌드 산출물을 Cloudflare Pages에 Direct Upload 한다.
- D1과 별도 Worker는 이후 단계에서 추가한다.

## 참고 문서

- Pages Direct Upload: https://developers.cloudflare.com/pages/get-started/direct-upload/
- Pages 사용자 도메인: https://developers.cloudflare.com/pages/configuration/custom-domains/
- Pages 정적 파일 제공: https://developers.cloudflare.com/pages/configuration/serving-pages/
- Workers 사용자 도메인: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Workers CORS 예제: https://developers.cloudflare.com/workers/examples/cors-header-proxy/
- D1: https://developers.cloudflare.com/d1/
