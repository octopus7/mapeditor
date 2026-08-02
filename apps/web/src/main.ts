import "./styles.css";
import {
  cellIndex, cloneMap, createInitialMap, deserializeMap, moveProp, paintGround, placeProp, serializeMap,
  type GroundType, type MapDocument, type PropType,
} from "./editor-model";
import { getTransitionLayers, NEIGHBOR_MASK } from "./autotile";
import {
  AuthApiError, AuthClient, isAvatarIcon, parsePublicAppConfig,
  type AuthSession, type AvatarIcon,
} from "./auth-client";
import { ImageLibraryClient, ImageLibraryError, type ImageAsset } from "./image-library";
import { MapStorageClient, resizeMap } from "./map-library";
import { formatDeploymentTime, parseDeploymentMetadata } from "./deployment-meta";

const CELL_SIZE = 36;
const STORAGE_KEY = "mapeditor-draft-v1";
const AUTH_STORAGE_KEY = "mapeditor-auth-v3";
const LEGACY_AUTH_STORAGE_KEY = "mapeditor-auth-v2";
const DEFAULT_DISPLAY_NAME = "새유저";
const avatarOptions: Array<{ id: AvatarIcon; label: string; glyph: string }> = [
  { id: "initial", label: "글자", glyph: "가" },
  { id: "hidden", label: "숨김", glyph: "—" },
  { id: "leaf", label: "나뭇잎", glyph: "🌿" },
  { id: "pine", label: "소나무", glyph: "🌲" },
  { id: "water", label: "물방울", glyph: "💧" },
  { id: "stone", label: "바위", glyph: "🪨" },
];
const groundOptions: Array<{ id: GroundType; label: string; hint: string }> = [
  { id: "grass", label: "풀", hint: "부드러운 초지" },
  { id: "dirt", label: "흙", hint: "산책로와 둔덕" },
  { id: "stone", label: "돌", hint: "바위와 물가" },
  { id: "water", label: "물", hint: "개울과 연못" },
];
const propOptions: Array<{ id: PropType; label: string; image: string }> = [
  { id: "broadleaf-tree", label: "활엽수", image: "/assets/props/broadleaf-tree.png" },
  { id: "pine-tree", label: "소나무", image: "/assets/props/pine-tree.png" },
  { id: "shrub", label: "관목", image: "/assets/props/shrub.png" },
  { id: "boulder", label: "바위", image: "/assets/props/boulder.png" },
  { id: "fallen-log", label: "쓰러진 통나무", image: "/assets/props/fallen-log.png" },
  { id: "footbridge", label: "나무다리", image: "/assets/props/footbridge.png" },
];
type Layer = "ground" | "prop";
type PropMode = "place" | "move" | "erase";
type CellPosition = { column: number; row: number };
type MovingProp = {
  prop: PropType;
  fromColumn: number;
  fromRow: number;
  target: CellPosition | null;
};

let map = restoreDraft() ?? createInitialMap();
let savedMapId: string | null = null;
let selectedLayer: Layer = "ground";
let selectedGround: GroundType = "grass";
let selectedProp: PropType = "broadleaf-tree";
let gridVisible = true;
let isDrawing = false;
let strokeChanged = false;
let propMode: PropMode = "place";
let movingProp: MovingProp | null = null;
let lastPaintedCell = "";
let history: MapDocument[] = [];
let future: MapDocument[] = [];
let saveTimer: number | undefined;
let authClient: AuthClient | null = null;
let imageLibraryClient: ImageLibraryClient | null = null;
let mapStorageClient: MapStorageClient | null = null;
let authSession: AuthSession | null = null;
let googleClientId = "";
let googleIdentityLoadPromise: Promise<void> | null = null;
let fileMenuOpen = false;
let saveAsMode = false;
let fullscreenFallback = false;
let pendingAvatarIcon: AvatarIcon = "initial";
let zoom = 1;
let panX = 0;
let panY = 0;
let panMode = false;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;
let spacePressed = false;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#workspace" aria-label="Forest Map Editor 홈">
        <span class="brand-mark" aria-hidden="true">✦</span>
        <span><strong>FOREST</strong><small>MAP EDITOR</small></span>
      </a>
      <div class="document-title">
        <label for="map-name">현재 지도</label>
        <input id="map-name" value="${escapeHtml(map.name)}" maxlength="48" />
      </div>
      <div class="top-actions">
        <div class="auth-slot" id="auth-slot"><span class="auth-note">로그인 준비 중</span></div>
        <button class="button ghost" id="undo" title="실행 취소 (Ctrl+Z)">↶ <span>실행 취소</span></button>
        <button class="button ghost" id="redo" title="다시 실행 (Ctrl+Shift+Z)">↷</button>
        <button class="icon-button fullscreen-toggle" id="toggle-fullscreen" aria-expanded="false" aria-pressed="false" title="전체 화면으로 전환" aria-label="전체 화면으로 전환">
          <svg class="fullscreen-icon" data-fullscreen-icon="expand" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4" /></svg>
          <svg class="fullscreen-icon hidden" data-fullscreen-icon="contract" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M20 15h-5v5M9 20v-5H4" /></svg>
        </button>
        <div class="file-menu-wrap">
          <button class="icon-button file-menu-toggle" id="file-menu-toggle" aria-expanded="false" aria-controls="file-menu" aria-haspopup="menu" title="파일 메뉴" aria-label="파일 메뉴">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div class="file-menu hidden" id="file-menu" role="menu" aria-label="파일 기능">
            <span class="file-menu-heading">지도 작업</span>
            <button class="button export" id="save-map" role="menuitem">지도 저장</button>
            <button class="button export" id="save-map-as" role="menuitem">다른 이름으로 저장</button>
            <button class="button export" id="open-map-library" role="menuitem">저장한 지도 목록</button>
            <button class="button export" id="open-image-library" role="menuitem">내 이미지</button>
            <button class="button export" id="open-resize-map" role="menuitem">맵 크기 조정</button>
            <span class="file-menu-heading">파일 내보내기</span>
            <button class="button export" id="export-json" role="menuitem">JSON 저장</button>
            <button class="button primary" id="export-png" role="menuitem">PNG 내보내기</button>
          </div>
        </div>
      </div>
    </header>

    <main class="workspace" id="workspace">
      <aside class="tools-panel" aria-label="타일 도구">
        <div class="panel-heading"><span class="eyebrow">PALETTE</span><h2>지도 재료</h2></div>
        <div class="layer-tabs" role="tablist" aria-label="편집 레이어">
          <button class="layer-tab active" data-layer="ground">바닥 타일</button>
          <button class="layer-tab" data-layer="prop">사물</button>
        </div>
        <section class="palette-section" id="ground-palette">
          <div class="section-label"><span>GROUND</span><span>4종</span></div>
          <div class="ground-list">
            ${groundOptions.map((item, index) => `
              <button class="ground-option ${index === 0 ? "selected" : ""}" data-ground="${item.id}">
                <span class="ground-swatch ${item.id}"></span>
                <span><strong>${item.label}</strong><small>${item.hint}</small></span><span class="check">✓</span>
              </button>`).join("")}
          </div>
        </section>
        <section class="palette-section hidden" id="prop-palette">
          <div class="section-label"><span>EDIT MODE</span><span id="prop-mode-label">배치</span></div>
          <div class="prop-mode-list" role="group" aria-label="사물 편집 모드">
            <button class="prop-mode active" data-prop-mode="place" aria-pressed="true">배치</button>
            <button class="prop-mode" data-prop-mode="move" aria-pressed="false">이동</button>
            <button class="prop-mode" data-prop-mode="erase" aria-pressed="false">지우개</button>
          </div>
          <p class="prop-mode-hint" id="prop-mode-hint">사물을 누른 채 움직여 연속으로 배치합니다.</p>
          <div class="section-label"><span>OBJECTS</span><span>6종</span></div>
          <div class="prop-grid">
            ${propOptions.map((item, index) => `
              <button class="prop-option ${index === 0 ? "selected" : ""}" data-prop="${item.id}" title="${item.label}">
                <img src="${item.image}" alt="" /><span>${item.label}</span>
              </button>`).join("")}
          </div>
        </section>
        <div class="tool-tip"><span>TIP</span> 사물은 배치·이동·지우개 모드로 편집합니다. 바닥 타일에서는 오른쪽 클릭으로 지울 수 있어요.</div>
      </aside>

      <section class="canvas-stage" aria-label="지도 편집 영역">
        <div class="stage-toolbar">
          <div class="status-dot"><i></i><span id="save-status">브라우저에 자동 저장됨</span></div>
          <div class="stage-controls">
            <div class="viewport-controls" aria-label="작업 영역 뷰포트">
              <button class="icon-button" id="zoom-out" title="축소" aria-label="축소">−</button>
              <button class="zoom-readout" id="zoom-reset" title="확대/축소와 위치 초기화" aria-label="확대/축소와 위치 초기화">100%</button>
              <button class="icon-button" id="zoom-in" title="확대" aria-label="확대">+</button>
              <button class="icon-button pan-toggle" id="toggle-pan" aria-pressed="false" title="작업 영역 이동 모드" aria-label="작업 영역 이동 모드">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11V6.5a1.5 1.5 0 0 1 3 0V11m0-1V5.5a1.5 1.5 0 0 1 3 0V11m0-1V7a1.5 1.5 0 0 1 3 0v6m0-1v-1a1.5 1.5 0 0 1 3 0v3.5c0 4.1-2.6 6.5-6.5 6.5h-1.2c-2.1 0-3.5-.8-4.7-2.3L5 16.8a1.7 1.7 0 0 1 2.4-2.4L8 15" /></svg>
              </button>
            </div>
            <div class="stage-map-controls">
              <button class="icon-button active" id="toggle-grid" aria-pressed="true" title="격자 표시">#</button>
              <button class="icon-button" id="reset-map" title="예시 지도로 초기화">↺</button>
              <button class="icon-button" id="clear-map" title="빈 지도로 만들기">□</button>
            </div>
          </div>
        </div>
        <div class="canvas-scroll"><div class="canvas-frame" id="canvas-frame">
          <canvas id="map-canvas" aria-label="28 곱하기 18 타일 지도" tabindex="0"></canvas>
        </div></div>
        <div class="stage-footer"><span><b id="map-size">28 × 18</b> 셀</span><span id="cursor-status">셀 위에 커서를 올려보세요</span><span class="footer-links"><span id="developer-access" class="developer-access">Developer: checking</span> · <span id="deployment-time" class="deployment-time">Deployment: checking</span> · 로컬 초안 · <button type="button" id="open-page-qr">page qr</button> · <a href="https://mapedit.pages.dev/cdn-cgi/trace" target="_blank" rel="noopener noreferrer">cdn trace</a> · <a href="https://github.com/octopus7/mapeditor" target="_blank" rel="noopener noreferrer">github</a></span></div>
      </section>

      <aside class="reference-panel" aria-label="레이아웃 참고 이미지">
        <div class="panel-heading"><span class="eyebrow">REFERENCE</span><h2>개울이 있는 숲</h2><p>레이아웃의 흐름과 오브젝트 밀도를 참고하세요.</p></div>
        <button class="reference-image" id="open-reference" aria-label="참고 이미지 크게 보기">
          <img src="/assets/forest-creek-reference.png" alt="위에서 본 개울과 나무다리가 있는 숲" /><span>이미지 크게 보기 ↗</span>
        </button>
        <div class="reference-notes"><h3>구성 힌트</h3><ul>
          <li><i class="water-dot"></i><span><strong>개울</strong>지도 가장자리 사이를 끊김 없이 연결</span></li>
          <li><i class="path-dot"></i><span><strong>동선</strong>흙길과 다리가 자연스럽게 만나도록 배치</span></li>
          <li><i class="forest-dot"></i><span><strong>밀도</strong>중앙은 여유롭게, 외곽은 나무로 감싸기</span></li>
        </ul></div>
        <div class="reference-credit">AI로 생성한 레이아웃 참고 이미지</div>
      </aside>
    </main>
  </div>
  <dialog id="reference-dialog"><button id="close-reference" aria-label="닫기">×</button><img src="/assets/forest-creek-reference.png" alt="개울이 있는 숲 레이아웃 참고 이미지" /></dialog>
  <dialog id="page-qr-dialog" class="qr-dialog" aria-labelledby="page-qr-title">
    <strong id="page-qr-title">페이지 접속 QR 코드</strong>
    <img src="/assets/mapedit-page-qr.svg" alt="https://mapedit.pages.dev 접속 QR 코드" />
    <span>아무 곳이나 누르면 닫힙니다.</span>
  </dialog>
  <dialog id="profile-dialog" class="profile-dialog">
    <form method="dialog">
      <div class="profile-heading"><span class="profile-avatar" id="profile-avatar">?</span><div><small>Google 계정</small><strong id="profile-email"></strong></div></div>
      <label for="profile-name">표시 이름</label>
      <input id="profile-name" maxlength="40" autocomplete="nickname" />
      <fieldset class="avatar-settings">
        <legend>프로필 아이콘</legend>
        <div class="avatar-options" aria-label="프로필 아이콘 선택">
          ${avatarOptions.map((option) => `<button type="button" data-avatar-icon="${option.id}" aria-pressed="false" title="${option.label}"><span aria-hidden="true">${option.glyph}</span><small>${option.label}</small></button>`).join("")}
        </div>
      </fieldset>
      <p class="profile-message" id="profile-message">변경한 이름과 아이콘은 계정 설정에 저장됩니다.</p>
      <div class="profile-actions"><button class="button ghost" value="cancel">닫기</button><button class="button danger" type="button" id="logout">로그아웃</button><button class="button primary" type="button" id="save-profile">설정 저장</button></div>
    </form>
  </dialog>
  <dialog id="auth-debug-dialog" class="auth-debug-dialog" aria-labelledby="auth-debug-title">
    <form method="dialog">
      <h2 id="auth-debug-title">개발자 로그인 진단</h2>
      <p id="auth-debug-message">허용된 개발자 접속에서만 표시되는 상세 오류입니다.</p>
      <pre id="auth-debug-details"></pre>
      <div class="dialog-actions"><button class="button primary">닫기</button></div>
    </form>
  </dialog>
  <dialog id="image-debug-dialog" class="auth-debug-dialog" aria-labelledby="image-debug-title">
    <form method="dialog">
      <h2 id="image-debug-title">이미지 저장 개발자 진단</h2>
      <p id="image-debug-message">허용된 개발자 접속에서만 표시되는 상세 오류입니다.</p>
      <pre id="image-debug-details"></pre>
      <div class="dialog-actions"><button class="button primary">닫기</button></div>
    </form>
  </dialog>
  <dialog id="map-save-dialog" class="editor-dialog">
    <form method="dialog">
      <h2 id="map-save-title">지도 저장</h2>
      <p class="dialog-note">로그인한 사용자만 개인 지도 목록에 저장할 수 있습니다.</p>
      <label for="map-save-name">지도 이름</label>
      <input id="map-save-name" maxlength="80" autocomplete="off" />
      <p class="dialog-message" id="map-save-message"></p>
      <div class="dialog-actions"><button class="button ghost" value="cancel">취소</button><button class="button primary" type="button" id="confirm-map-save">저장</button></div>
    </form>
  </dialog>
  <dialog id="map-library-dialog" class="editor-dialog map-library-dialog">
    <form method="dialog">
      <h2>저장한 지도 목록</h2>
      <p class="dialog-note" id="map-library-message">로그인 후 저장한 지도를 불러올 수 있습니다.</p>
      <div id="map-library-list" class="map-library-list"></div>
      <div class="dialog-actions"><button class="button ghost" value="cancel">닫기</button></div>
    </form>
  </dialog>
  <dialog id="image-library-dialog" class="editor-dialog image-library-dialog">
    <form method="dialog">
      <h2>내 이미지</h2>
      <p class="dialog-note">로그인한 사용자만 이미지를 저장하고 목록을 볼 수 있습니다.</p>
      <div class="image-upload-row"><input id="image-upload-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /><button class="button primary" type="button" id="upload-image">이미지 저장</button></div>
      <p class="dialog-message" id="image-library-message"></p>
      <div id="image-library-list" class="image-library-list"></div>
      <div class="dialog-actions"><button class="button ghost" value="cancel">닫기</button></div>
    </form>
  </dialog>
  <dialog id="resize-map-dialog" class="editor-dialog">
    <form method="dialog">
      <h2>맵 크기 조정</h2>
      <p class="dialog-note">새 크기를 입력하면 현재 셀을 기준 위치에 맞춰 보존합니다.</p>
      <div class="resize-fields"><label for="resize-columns">가로<input id="resize-columns" type="number" min="8" max="200" /></label><label for="resize-rows">세로<input id="resize-rows" type="number" min="8" max="200" /></label></div>
      <label for="resize-anchor">기준 위치</label>
      <select id="resize-anchor"><option value="center">가운데</option><option value="top-left">왼쪽 위</option><option value="top">위쪽 가운데</option><option value="top-right">오른쪽 위</option><option value="left">왼쪽 가운데</option><option value="right">오른쪽 가운데</option><option value="bottom-left">왼쪽 아래</option><option value="bottom">아래쪽 가운데</option><option value="bottom-right">오른쪽 아래</option></select>
      <p class="dialog-message" id="resize-map-message"></p>
      <div class="dialog-actions"><button class="button ghost" value="cancel">취소</button><button class="button primary" type="button" id="confirm-resize-map">적용</button></div>
    </form>
  </dialog>
`;

function setupAuthUi(): void {
  const authSlot = document.querySelector<HTMLDivElement>("#auth-slot");
  const fileMenu = document.querySelector<HTMLElement>("#file-menu");
  if (!authSlot || !fileMenu) return;

  const loginTrigger = document.createElement("button");
  loginTrigger.type = "button";
  loginTrigger.className = "button ghost login-trigger";
  loginTrigger.id = "login-trigger";
  loginTrigger.textContent = "로그인";
  loginTrigger.setAttribute("aria-haspopup", "dialog");

  const accountSection = document.createElement("div");
  accountSection.className = "account-menu-section hidden";
  accountSection.id = "account-menu-section";
  accountSection.innerHTML = `
    <span class="file-menu-heading">계정</span>
    <div id="account-menu-slot" class="account-menu-slot"></div>`;
  accountSection.append(loginTrigger);
  fileMenu.prepend(accountSection);

  const authDialog = document.createElement("dialog");
  authDialog.id = "auth-dialog";
  authDialog.className = "auth-dialog";
  authDialog.setAttribute("aria-labelledby", "auth-dialog-title");
  authDialog.innerHTML = `
    <form method="dialog">
      <div class="auth-dialog-heading">
        <span class="eyebrow">ACCOUNT</span>
        <h2 id="auth-dialog-title">로그인</h2>
        <p>Google 계정으로 로그인하면 나만의 지도와 이미지를 저장할 수 있습니다.</p>
      </div>
      <div class="auth-dialog-slot"></div>
      <div class="dialog-actions"><button class="button ghost" value="cancel">닫기</button></div>
    </form>`;
  authDialog.querySelector<HTMLDivElement>(".auth-dialog-slot")!.append(authSlot);
  document.body.append(authDialog);
}
setupAuthUi();

function setupDeveloperAccessUi(): void {
  const existing = document.querySelector<HTMLSpanElement>("#developer-access");
  if (!existing) return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = existing.id;
  button.className = existing.className;
  button.textContent = existing.textContent;
  button.disabled = true;
  existing.replaceWith(button);
}
setupDeveloperAccessUi();

const canvas = document.querySelector<HTMLCanvasElement>("#map-canvas")!;
const canvasFrame = document.querySelector<HTMLDivElement>("#canvas-frame")!;
const context = canvas.getContext("2d")!;
function syncCanvasSize(): void {
  canvas.width = map.columns * CELL_SIZE;
  canvas.height = map.rows * CELL_SIZE;
  document.querySelector("#map-size")!.textContent = `${map.columns} × ${map.rows}`;
  canvas.setAttribute("aria-label", `${map.columns} 곱하기 ${map.rows} 타일 지도`);
}
syncCanvasSize();
const propImages = new Map<PropType, HTMLImageElement>();
for (const prop of propOptions) {
  const image = new Image();
  image.src = prop.image;
  image.addEventListener("load", render);
  propImages.set(prop.id, image);
}

function restoreDraft(): MapDocument | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? deserializeMap(raw) : null;
}
function escapeHtml(value: string): string {
  const characters: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" };
  return value.replace(/[&<>'"]/g, (character) => characters[character]);
}
function colorNoise(column: number, row: number): number {
  return ((column * 31 + row * 17 + 26) % 11) - 5;
}
function drawGroundTexture(column: number, row: number, ground: GroundType): void {
  const x = column * CELL_SIZE;
  const y = row * CELL_SIZE;
  const noise = colorNoise(column, row);
  const palettes: Record<GroundType, [number, number, number]> = {
    grass: [104, 151, 85], dirt: [162, 126, 79], stone: [127, 132, 121], water: [58, 137, 153],
  };
  const [r, g, b] = palettes[ground];
  context.fillStyle = `rgb(${r + noise}, ${g + noise}, ${b + noise})`;
  context.fillRect(x, y, CELL_SIZE, CELL_SIZE);
  context.save(); context.globalAlpha = 0.22;
  if (ground === "grass") {
    context.strokeStyle = "#d9e6a2"; context.beginPath();
    context.moveTo(x + 9, y + 25); context.lineTo(x + 11, y + 20); context.moveTo(x + 25, y + 15); context.lineTo(x + 27, y + 10); context.stroke();
  } else if (ground === "water") {
    context.strokeStyle = "#d5f2e9"; context.beginPath();
    context.moveTo(x + 5, y + 12); context.quadraticCurveTo(x + 13, y + 9, x + 21, y + 12);
    context.moveTo(x + 15, y + 25); context.quadraticCurveTo(x + 23, y + 22, x + 31, y + 25); context.stroke();
  } else {
    context.fillStyle = ground === "stone" ? "#e2e0cf" : "#6e4c2f";
    context.beginPath(); context.arc(x + 10, y + 11, ground === "stone" ? 2.5 : 1.4, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(x + 26, y + 25, ground === "stone" ? 3 : 1.2, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}
function createTransitionPath(column: number, row: number, mask: number): Path2D {
  const x = column * CELL_SIZE;
  const y = row * CELL_SIZE;
  const edge = CELL_SIZE * .25;
  const path = new Path2D();
  if (mask & NEIGHBOR_MASK.N) path.rect(x, y, CELL_SIZE, edge);
  if (mask & NEIGHBOR_MASK.E) path.rect(x + CELL_SIZE - edge, y, edge, CELL_SIZE);
  if (mask & NEIGHBOR_MASK.S) path.rect(x, y + CELL_SIZE - edge, CELL_SIZE, edge);
  if (mask & NEIGHBOR_MASK.W) path.rect(x, y, edge, CELL_SIZE);
  const cornerRadius = edge * .9;
  if (mask & NEIGHBOR_MASK.NE) path.arc(x + CELL_SIZE - edge / 2, y + edge / 2, cornerRadius, 0, Math.PI * 2);
  if (mask & NEIGHBOR_MASK.SE) path.arc(x + CELL_SIZE - edge / 2, y + CELL_SIZE - edge / 2, cornerRadius, 0, Math.PI * 2);
  if (mask & NEIGHBOR_MASK.SW) path.arc(x + edge / 2, y + CELL_SIZE - edge / 2, cornerRadius, 0, Math.PI * 2);
  if (mask & NEIGHBOR_MASK.NW) path.arc(x + edge / 2, y + edge / 2, cornerRadius, 0, Math.PI * 2);
  return path;
}
function drawGround(column: number, row: number, ground: GroundType): void {
  drawGroundTexture(column, row, ground);
  for (const layer of getTransitionLayers(map, column, row)) {
    context.save();
    context.clip(createTransitionPath(column, row, layer.mask));
    drawGroundTexture(column, row, layer.ground);
    context.restore();
  }
}
const propScale: Record<PropType, number> = {
  "broadleaf-tree": 2.15, "pine-tree": 2.05, shrub: 1.25, boulder: 1.35, "fallen-log": 1.65, footbridge: 1.65,
};
function drawProp(column: number, row: number, prop: PropType, opacity = 1): void {
  const image = propImages.get(prop);
  if (!image?.complete) return;
  const size = CELL_SIZE * propScale[prop];
  context.save();
  context.globalAlpha = opacity;
  context.drawImage(image, column * CELL_SIZE + CELL_SIZE / 2 - size / 2, row * CELL_SIZE + CELL_SIZE - size * 0.78, size, size);
  context.restore();
}
function render(): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < map.rows; row += 1) for (let column = 0; column < map.columns; column += 1) {
    drawGround(column, row, map.cells[cellIndex(map, column, row)].ground);
  }
  for (let row = 0; row < map.rows; row += 1) for (let column = 0; column < map.columns; column += 1) {
    const prop = map.cells[cellIndex(map, column, row)].prop;
    if (!prop) continue;
    if (movingProp && movingProp.fromColumn === column && movingProp.fromRow === row) continue;
    drawProp(column, row, prop);
  }
  if (movingProp?.target) {
    drawProp(movingProp.target.column, movingProp.target.row, movingProp.prop, .62);
  }
  if (gridVisible) {
    context.save(); context.strokeStyle = "rgba(21,45,29,.17)"; context.lineWidth = 1; context.beginPath();
    for (let column = 0; column <= map.columns; column += 1) { context.moveTo(column * CELL_SIZE + .5, 0); context.lineTo(column * CELL_SIZE + .5, canvas.height); }
    for (let row = 0; row <= map.rows; row += 1) { context.moveTo(0, row * CELL_SIZE + .5); context.lineTo(canvas.width, row * CELL_SIZE + .5); }
    context.stroke(); context.restore();
  }
  updateHistoryButtons();
}
const MIN_ZOOM = .5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = .25;
function updateViewport(): void {
  canvasFrame.style.setProperty("--map-zoom", String(zoom));
  canvasFrame.style.setProperty("--pan-x", `${panX}px`);
  canvasFrame.style.setProperty("--pan-y", `${panY}px`);
  const readout = document.querySelector<HTMLButtonElement>("#zoom-reset")!;
  readout.textContent = `${Math.round(zoom * 100)}%`;
  readout.setAttribute("aria-label", `확대/축소 ${Math.round(zoom * 100)}%, 클릭하면 위치와 함께 초기화`);
  canvas.classList.toggle("pan-mode", panMode || spacePressed || isPanning);
  canvas.classList.toggle("is-panning", isPanning);
  document.querySelector<HTMLButtonElement>("#toggle-pan")!.classList.toggle("active", panMode);
  document.querySelector<HTMLButtonElement>("#toggle-pan")!.setAttribute("aria-pressed", String(panMode));
}
function setZoom(nextZoom: number): void {
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  updateViewport();
}
function resetViewport(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  updateViewport();
}
function beginPan(event: PointerEvent): void {
  isPanning = true;
  panStartX = event.clientX;
  panStartY = event.clientY;
  panOriginX = panX;
  panOriginY = panY;
  canvas.setPointerCapture(event.pointerId);
  updateViewport();
}
function panAt(event: PointerEvent): void {
  if (!isPanning) return;
  panX = panOriginX + event.clientX - panStartX;
  panY = panOriginY + event.clientY - panStartY;
  updateViewport();
}
function getCell(event: PointerEvent): CellPosition | null {
  const rect = canvas.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
  return { column: Math.floor(((event.clientX - rect.left) / rect.width) * map.columns), row: Math.floor(((event.clientY - rect.top) / rect.height) * map.rows) };
}
function paintAt(event: PointerEvent): void {
  const cell = getCell(event);
  const key = cell ? `${cell.column}:${cell.row}` : "outside";
  if (key === lastPaintedCell) return;
  lastPaintedCell = key;
  if (!cell) {
    if (movingProp) {
      movingProp.target = null;
      render();
    }
    return;
  }
  const { column, row } = cell;
  document.querySelector("#cursor-status")!.textContent = `열 ${column + 1} · 행 ${row + 1}`;
  if (!isDrawing) return;
  if (selectedLayer === "prop" && propMode === "move" && movingProp) {
    movingProp.target = cell;
    render();
    return;
  }
  const erase = (selectedLayer === "prop" && propMode === "erase") || event.button === 2 || (event.buttons & 2) === 2;
  const candidate = cloneMap(map);
  const changed = selectedLayer === "ground" ? paintGround(candidate, column, row, erase ? "grass" : selectedGround) : placeProp(candidate, column, row, erase ? null : selectedProp);
  if (!changed) return;
  if (!strokeChanged) { history.push(cloneMap(map)); if (history.length > 60) history.shift(); future = []; }
  strokeChanged = true; map = candidate; render();
}
function finishStroke(): void {
  if (isPanning) {
    isPanning = false;
    isDrawing = false;
    lastPaintedCell = "";
    updateViewport();
    return;
  }
  if (movingProp) {
    const move = movingProp;
    if (move.target) {
      const candidate = cloneMap(map);
      const changed = moveProp(candidate, move.fromColumn, move.fromRow, move.target.column, move.target.row);
      if (changed) {
        history.push(cloneMap(map));
        if (history.length > 60) history.shift();
        future = [];
        strokeChanged = true;
        map = candidate;
      }
    }
    movingProp = null;
    render();
  }
  if (strokeChanged) scheduleSave();
  isDrawing = false; strokeChanged = false; lastPaintedCell = "";
}
function scheduleSave(): void {
  const status = document.querySelector("#save-status")!;
  status.textContent = "저장 중…"; window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { localStorage.setItem(STORAGE_KEY, serializeMap(map)); status.textContent = "브라우저에 자동 저장됨"; }, 260);
}
function updateHistoryButtons(): void {
  (document.querySelector("#undo") as HTMLButtonElement).disabled = history.length === 0;
  (document.querySelector("#redo") as HTMLButtonElement).disabled = future.length === 0;
}
function syncName(): void { (document.querySelector("#map-name") as HTMLInputElement).value = map.name; }
function undo(): void {
  const previous = history.pop(); if (!previous) return;
  future.push(cloneMap(map)); map = previous; syncCanvasSize(); syncName(); render(); scheduleSave();
}
function redo(): void {
  const next = future.pop(); if (!next) return;
  history.push(cloneMap(map)); map = next; syncCanvasSize(); syncName(); render(); scheduleSave();
}
function replaceMap(next: MapDocument): void {
  history.push(cloneMap(map)); future = []; map = next; syncCanvasSize(); syncName(); render(); scheduleSave();
}
function download(content: Blob, filename: string): void {
  const link = document.createElement("a"); link.href = URL.createObjectURL(content); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}
function setFileMenuOpen(open: boolean): void {
  fileMenuOpen = open;
  document.querySelector("#file-menu")!.classList.toggle("hidden", !open);
  document.querySelector("#file-menu-toggle")!.setAttribute("aria-expanded", String(open));
}
function setDialogMessage(selector: string, message: string, kind: "error" | "success" | "" = ""): void {
  const element = document.querySelector<HTMLElement>(selector)!;
  element.textContent = message;
  element.classList.toggle("is-error", kind === "error");
  element.classList.toggle("is-success", kind === "success");
}
function openMapSaveDialog(asNew = false): void {
  setFileMenuOpen(false);
  saveAsMode = asNew;
  const dialog = document.querySelector<HTMLDialogElement>("#map-save-dialog")!;
  const input = document.querySelector<HTMLInputElement>("#map-save-name")!;
  const button = document.querySelector<HTMLButtonElement>("#confirm-map-save")!;
  input.value = map.name;
  document.querySelector("#map-save-title")!.textContent = asNew ? "다른 이름으로 저장" : "지도 저장";
  button.disabled = !authSession || !mapStorageClient;
  setDialogMessage("#map-save-message", authSession ? "" : "DB 저장은 로그인이 필요합니다.");
  dialog.showModal();
}
async function saveMapToCloud(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#confirm-map-save")!;
  if (!authSession || !mapStorageClient) {
    setDialogMessage("#map-save-message", "DB 저장은 로그인이 필요합니다.", "error");
    return;
  }
  const name = document.querySelector<HTMLInputElement>("#map-save-name")!.value.trim();
  if (!name) {
    setDialogMessage("#map-save-message", "지도 이름을 입력해 주세요.", "error");
    return;
  }
  button.disabled = true;
  setDialogMessage("#map-save-message", "저장 중입니다.");
  try {
    const saved = saveAsMode || !savedMapId
      ? await mapStorageClient.saveMap(authSession.token, map, name)
      : await mapStorageClient.updateMap(authSession.token, savedMapId, map, name);
    savedMapId = saved.id;
    map.name = saved.name;
    syncName();
    scheduleSave();
    setDialogMessage("#map-save-message", "개인 지도 목록에 저장했습니다.", "success");
    window.setTimeout(() => document.querySelector<HTMLDialogElement>("#map-save-dialog")!.close(), 450);
  } catch (error) {
    setDialogMessage("#map-save-message", error instanceof Error ? error.message : "지도를 저장하지 못했습니다.", "error");
  } finally {
    button.disabled = false;
  }
}
function renderMapLibrary(items: readonly { id: string; name: string; createdAt?: string; updatedAt?: string }[]): void {
  const list = document.querySelector<HTMLDivElement>("#map-library-list")!;
  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-library";
    empty.textContent = "저장한 지도가 없습니다.";
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "map-library-item";
    const detail = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const date = document.createElement("small");
    date.textContent = item.updatedAt ?? item.createdAt ?? "";
    detail.append(name, date);
    const load = document.createElement("button");
    load.type = "button";
    load.className = "button export";
    load.textContent = "불러오기";
    load.addEventListener("click", () => { void loadSavedMap(item.id, load); });
    row.append(detail, load);
    list.append(row);
  }
}
async function loadSavedMap(id: string, button: HTMLButtonElement): Promise<void> {
  if (!authSession || !mapStorageClient) return;
  button.disabled = true;
  setDialogMessage("#map-library-message", "지도를 불러오는 중입니다.");
  try {
    const loaded = await mapStorageClient.loadMap(authSession.token, id);
    savedMapId = id;
    replaceMap(loaded);
    document.querySelector<HTMLDialogElement>("#map-library-dialog")!.close();
  } catch (error) {
    setDialogMessage("#map-library-message", error instanceof Error ? error.message : "지도를 불러오지 못했습니다.", "error");
  } finally {
    button.disabled = false;
  }
}
async function openMapLibrary(): Promise<void> {
  setFileMenuOpen(false);
  const dialog = document.querySelector<HTMLDialogElement>("#map-library-dialog")!;
  const list = document.querySelector<HTMLDivElement>("#map-library-list")!;
  list.replaceChildren();
  if (!authSession || !mapStorageClient) {
    setDialogMessage("#map-library-message", "DB 저장과 목록 조회는 로그인이 필요합니다.", "error");
    dialog.showModal();
    return;
  }
  setDialogMessage("#map-library-message", "저장한 지도를 불러오는 중입니다.");
  dialog.showModal();
  try {
    const items = await mapStorageClient.listMaps(authSession.token);
    setDialogMessage("#map-library-message", items.length ? "불러올 지도를 선택하세요." : "");
    renderMapLibrary(items);
  } catch (error) {
    setDialogMessage("#map-library-message", error instanceof Error ? error.message : "지도 목록을 불러오지 못했습니다.", "error");
  }
}
function renderImageLibrary(items: readonly ImageAsset[]): void {
  const list = document.querySelector<HTMLDivElement>("#image-library-list")!;
  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-library";
    empty.textContent = "저장한 이미지가 없습니다.";
    list.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "image-library-grid";
  for (const asset of items) {
    const card = document.createElement("figure");
    card.className = "image-library-card";
    const image = document.createElement("img");
    image.src = asset.thumbnailUrl;
    image.alt = asset.originalFilename;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    const caption = document.createElement("figcaption");
    const filename = document.createElement("strong");
    filename.textContent = asset.originalFilename;
    const metadata = document.createElement("small");
    metadata.textContent = `${Math.ceil(asset.byteSize / 1024)} KB`;
    caption.append(filename, metadata);
    card.append(image, caption);
    grid.append(card);
  }
  list.append(grid);
}
async function openImageLibrary(): Promise<void> {
  setFileMenuOpen(false);
  const dialog = document.querySelector<HTMLDialogElement>("#image-library-dialog")!;
  document.querySelector<HTMLInputElement>("#image-upload-input")!.value = "";
  document.querySelector<HTMLButtonElement>("#upload-image")!.disabled = !authSession || !imageLibraryClient;
  if (!authSession || !imageLibraryClient) {
    setDialogMessage("#image-library-message", "이미지 저장과 목록 조회는 로그인이 필요합니다.", "error");
    dialog.showModal();
    return;
  }
  setDialogMessage("#image-library-message", "저장한 이미지를 불러오는 중입니다.");
  dialog.showModal();
  try {
    const result = await imageLibraryClient.listImages(authSession.token);
    setDialogMessage("#image-library-message", result.images.length ? "저장한 이미지" : "");
    renderImageLibrary(result.images);
  } catch (error) {
    setDialogMessage("#image-library-message", error instanceof Error ? error.message : "이미지 목록을 불러오지 못했습니다.", "error");
    showImageDebugDialog(error);
  }
}
async function uploadSelectedImage(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#image-upload-input")!;
  const button = document.querySelector<HTMLButtonElement>("#upload-image")!;
  if (!authSession || !imageLibraryClient) {
    setDialogMessage("#image-library-message", "이미지 저장은 로그인이 필요합니다.", "error");
    return;
  }
  const file = input.files?.[0];
  if (!file) {
    setDialogMessage("#image-library-message", "첨부할 이미지를 선택해 주세요.", "error");
    return;
  }
  button.disabled = true;
  setDialogMessage("#image-library-message", "이미지를 저장하는 중입니다.");
  try {
    await imageLibraryClient.uploadImage(authSession.token, file);
    const result = await imageLibraryClient.listImages(authSession.token);
    renderImageLibrary(result.images);
    input.value = "";
    setDialogMessage("#image-library-message", "이미지를 저장했습니다.", "success");
  } catch (error) {
    setDialogMessage("#image-library-message", error instanceof Error ? error.message : "이미지를 저장하지 못했습니다.", "error");
    showImageDebugDialog(error);
  } finally {
    button.disabled = false;
  }
}
function openResizeMapDialog(): void {
  setFileMenuOpen(false);
  (document.querySelector<HTMLInputElement>("#resize-columns")!).value = String(map.columns);
  (document.querySelector<HTMLInputElement>("#resize-rows")!).value = String(map.rows);
  setDialogMessage("#resize-map-message", "");
  document.querySelector<HTMLDialogElement>("#resize-map-dialog")!.showModal();
}
function applyMapResize(): void {
  const columns = Number(document.querySelector<HTMLInputElement>("#resize-columns")!.value);
  const rows = Number(document.querySelector<HTMLInputElement>("#resize-rows")!.value);
  const anchor = document.querySelector<HTMLSelectElement>("#resize-anchor")!.value as Parameters<typeof resizeMap>[3];
  try {
    replaceMap(resizeMap(map, columns, rows, anchor));
    document.querySelector<HTMLDialogElement>("#resize-map-dialog")!.close();
  } catch (error) {
    setDialogMessage("#resize-map-message", error instanceof Error ? error.message : "맵 크기를 적용하지 못했습니다.", "error");
  }
}
type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
function getFullscreenElement(): Element | null {
  const safariDocument = document as WebkitDocument;
  return document.fullscreenElement ?? safariDocument.webkitFullscreenElement ?? null;
}
function updateFullscreenButton(): void {
  const nativeFullscreen = getFullscreenElement() !== null;
  const active = nativeFullscreen || fullscreenFallback;
  document.querySelectorAll<SVGElement>("[data-fullscreen-icon]").forEach((icon) => {
    icon.classList.toggle("hidden", icon.dataset.fullscreenIcon !== (active ? "contract" : "expand"));
  });
  const button = document.querySelector<HTMLButtonElement>("#toggle-fullscreen")!;
  const label = active ? "표준 모드로 돌아가기" : "전체 화면으로 전환";
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", label);
  button.title = label;
  document.body.classList.toggle("fullscreen-fallback", active && !nativeFullscreen);
}
async function toggleFullscreen(): Promise<void> {
  const safariDocument = document as WebkitDocument;
  const current = getFullscreenElement();
  try {
    if (current) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (safariDocument.webkitExitFullscreen) await safariDocument.webkitExitFullscreen();
      fullscreenFallback = false;
    } else {
      const root = document.documentElement as WebkitFullscreenElement;
      if (root.requestFullscreen) await root.requestFullscreen();
      else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
      else fullscreenFallback = true;
    }
  } catch (error) {
    console.warn("Fullscreen mode is unavailable", error);
    fullscreenFallback = true;
  }
  updateFullscreenButton();
}

function saveAuthSession(session: AuthSession | null): void {
  authSession = session;
  if (session) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    sessionStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
  }
}

function restoreAuthSession(): AuthSession | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY) ?? sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Partial<AuthSession>;
    if (
      typeof session.token !== "string" ||
      typeof session.profile?.id !== "string" ||
      typeof session.profile.email !== "string" ||
      typeof session.profile.displayName !== "string" ||
      !isAvatarIcon(session.profile.avatarIcon)
    ) return null;
    return session as AuthSession;
  } catch {
    return null;
  }
}

function renderProfile(): void {
  const slot = document.querySelector<HTMLDivElement>("#account-menu-slot")!;
  const accountSection = document.querySelector<HTMLElement>("#account-menu-section");
  const loginTrigger = document.querySelector<HTMLButtonElement>("#login-trigger");
  slot.classList.remove("auth-ready");
  slot.classList.remove("auth-logged-out");
  slot.classList.add("auth-visible");
  accountSection?.classList.remove("hidden");
  loginTrigger?.classList.add("hidden");
  if (!authSession) return;
  const button = document.createElement("button");
  const avatar = document.createElement("span");
  const name = document.createElement("strong");
  button.type = "button";
  button.className = "profile-button";
  const shouldRename = authSession.profile.displayName === DEFAULT_DISPLAY_NAME;
  button.title = shouldRename ? "표시 이름을 수정하세요." : "계정 정보 수정";
  button.setAttribute("aria-label", shouldRename ? "표시 이름 수정하기" : "내 계정 정보 열기");
  avatar.textContent = avatarGlyph(authSession.profile.avatarIcon, authSession.profile.displayName);
  name.textContent = authSession.profile.displayName;
  if (authSession.profile.avatarIcon === "hidden") button.classList.add("icon-hidden");
  else button.append(avatar);
  button.append(name);
  button.addEventListener("click", openProfileDialog);
  slot.replaceChildren(button);
}

function renderLoggedOut(): void {
  document.querySelector<HTMLElement>("#account-menu-section")?.classList.remove("hidden");
  document.querySelector<HTMLDivElement>("#account-menu-slot")?.replaceChildren();
  document.querySelector<HTMLButtonElement>("#login-trigger")?.classList.remove("hidden");
}

function avatarGlyph(icon: AvatarIcon, displayName: string): string {
  if (icon === "initial") return displayName.trim().charAt(0).toUpperCase() || "?";
  return avatarOptions.find((option) => option.id === icon)?.glyph ?? "";
}

function selectAvatarIcon(icon: AvatarIcon): void {
  pendingAvatarIcon = icon;
  document.querySelectorAll<HTMLButtonElement>("[data-avatar-icon]").forEach((button) => {
    const selected = button.dataset.avatarIcon === icon;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (!authSession) return;
  const preview = document.querySelector<HTMLSpanElement>("#profile-avatar")!;
  preview.classList.toggle("is-hidden", icon === "hidden");
  preview.textContent = avatarGlyph(icon, authSession.profile.displayName);
}

function openProfileDialog(): void {
  if (!authSession) return;
  document.querySelector("#profile-email")!.textContent = authSession.profile.email;
  (document.querySelector("#profile-name") as HTMLInputElement).value = authSession.profile.displayName;
  document.querySelector("#profile-message")!.textContent = "변경한 이름과 아이콘은 계정 설정에 저장됩니다.";
  selectAvatarIcon(authSession.profile.avatarIcon);
  document.querySelector<HTMLDialogElement>("#profile-dialog")!.showModal();
}

function renderAuthNote(message: string, title?: string): void {
  const note = document.createElement("span");
  note.className = "auth-note";
  note.textContent = message;
  if (title) note.title = title;
  const slot = document.querySelector<HTMLDivElement>("#auth-slot")!;
  slot.classList.remove("auth-ready");
  slot.classList.remove("auth-logged-out");
  slot.classList.add("auth-visible");
  slot.replaceChildren(note);
}

function showAuthDebugDialog(error: unknown): void {
  if (!(error instanceof AuthApiError) || !error.debug) return;
  const dialog = document.querySelector<HTMLDialogElement>("#auth-debug-dialog");
  const message = document.querySelector("#auth-debug-message");
  const details = document.querySelector("#auth-debug-details");
  if (!dialog || !message || !details) return;
  message.textContent = `${error.status} ${error.code}: ${error.message}`;
  details.textContent = JSON.stringify(error.debug, null, 2);
  if (!dialog.open) dialog.showModal();
}

function showImageDebugDialog(error: unknown): void {
  if (!(error instanceof ImageLibraryError) || !error.debug) return;
  const dialog = document.querySelector<HTMLDialogElement>("#image-debug-dialog");
  const message = document.querySelector("#image-debug-message");
  const details = document.querySelector("#image-debug-details");
  if (!dialog || !message || !details) return;
  message.textContent = `${error.status ?? "?"} ${error.code ?? "REQUEST_FAILED"}: ${error.message}`;
  details.textContent = JSON.stringify(error.debug, null, 2);
  if (!dialog.open) dialog.showModal();
}

function renderAuthRetry(label: string, retry: () => void, error?: unknown): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "auth-retry";
  button.textContent = label;
  button.addEventListener("click", retry);
  const slot = document.querySelector<HTMLDivElement>("#auth-slot")!;
  slot.classList.remove("auth-ready");
  slot.classList.remove("auth-logged-out");
  slot.classList.add("auth-visible");
  slot.replaceChildren(button);
  showAuthDebugDialog(error);
}

function openAuthDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#auth-dialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  void renderGoogleSignIn();
}

async function loadGoogleIdentity(): Promise<void> {
  if (window.google) return;
  if (googleIdentityLoadPromise) return googleIdentityLoadPromise;
  googleIdentityLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    const script = existing ?? document.createElement("script");
    const onLoad = (): void => window.google
      ? resolve()
      : reject(new Error("Google Identity API가 준비되지 않았습니다."));
    const onError = (): void => reject(new Error("Google 로그인 라이브러리를 불러오지 못했습니다."));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      document.head.append(script);
    }
  });
  try {
    await googleIdentityLoadPromise;
  } catch (error) {
    googleIdentityLoadPromise = null;
    throw error;
  }
}

async function handleGoogleCredential(response: GoogleCredentialResponse): Promise<void> {
  if (!authClient) return;
  renderAuthNote("로그인 확인 중…");
  try {
    saveAuthSession(await authClient.login(response.credential));
    renderProfile();
    document.querySelector<HTMLDialogElement>("#auth-dialog")?.close();
  } catch (error) {
    console.error("Google login failed", error);
    renderAuthRetry("로그인 실패 · 다시 시도", () => { void renderGoogleSignIn(); }, error);
  }
}

async function renderGoogleSignIn(): Promise<void> {
  const slot = document.querySelector<HTMLDivElement>("#auth-slot")!;
  slot.classList.remove("auth-visible");
  if (!googleClientId) {
    renderAuthNote("로그인 설정 필요", "app-config.json에 Google OAuth 클라이언트 ID를 설정해야 합니다.");
    return;
  }
  renderAuthNote("Google 로그인 로딩…");
  slot.classList.remove("auth-visible");
  try {
    await loadGoogleIdentity();
    if (!window.google) throw new Error("Google Identity API가 준비되지 않았습니다.");
    slot.replaceChildren();
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response) => { void handleGoogleCredential(response); },
      ux_mode: "popup",
    });
    window.google.accounts.id.renderButton(slot, {
      theme: "outline", size: "medium", shape: "rectangular", text: "signin_with", locale: "ko", width: 200,
    });
    slot.classList.add("auth-ready");
    slot.classList.add("auth-visible");
  } catch (error) {
    console.error("Google Identity initialization failed", error);
    renderAuthRetry("로그인 다시 시도", () => { void renderGoogleSignIn(); });
  }
}

async function initializeAuth(): Promise<void> {
  renderLoggedOut();
  renderAuthNote("로그인 준비 중");
  try {
    const configResponse = await fetch("/app-config.json", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("앱 설정 파일을 불러오지 못했습니다.");
    const config = parsePublicAppConfig(await configResponse.json());
    if (!config.apiBaseUrl || !config.googleClientId) {
      renderAuthNote("로그인 설정 필요", "app-config.json에 API 주소와 Google OAuth 클라이언트 ID를 설정해야 합니다.");
      return;
    }
    authClient = new AuthClient(config.apiBaseUrl);
    imageLibraryClient = new ImageLibraryClient(config.apiBaseUrl);
    mapStorageClient = new MapStorageClient(config.apiBaseUrl);
    googleClientId = config.googleClientId;
    void initializeDeveloperAccess(config.apiBaseUrl);
    const restored = restoreAuthSession();
    if (restored) {
      try {
        const verified = await authClient.me(restored.token);
        saveAuthSession({ token: restored.token, profile: verified.profile });
        renderProfile();
        return;
      } catch {
        saveAuthSession(null);
      }
    }
    renderLoggedOut();
  } catch (error) {
    console.error("Authentication setup failed", error);
    renderAuthRetry("로그인 서버 다시 연결", () => { void initializeAuth(); });
  }
}

async function initializeDeploymentTime(): Promise<void> {
  const target = document.querySelector<HTMLSpanElement>("#deployment-time");
  if (!target) return;
  try {
    const response = await fetch("/deployment-meta.json", { cache: "no-store" });
    if (!response.ok) throw new Error("deployment metadata unavailable");
    const metadata = parseDeploymentMetadata(await response.json());
    target.textContent = formatDeploymentTime(metadata.deployedAt);
  } catch {
    target.textContent = "배포 시각 확인 불가";
  }
}

async function initializeDeveloperAccess(apiBaseUrl: string): Promise<void> {
  const target = document.querySelector<HTMLButtonElement>("#developer-access");
  if (!target) return;
  target.disabled = true;
  target.onclick = () => {
    if (!target.disabled) window.location.assign("/diag/");
  };
  try {
    const response = await fetch(`${apiBaseUrl}/health`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("health check failed");
    const body = await response.json() as { developerDebug?: unknown };
    target.classList.remove("is-on", "is-off", "is-old", "is-unavailable", "is-link");
    if (typeof body.developerDebug !== "boolean") {
      target.textContent = "Developer: old API";
      target.classList.add("is-old");
      target.title = "The deployed Worker does not expose developer access status.";
      return;
    }
    target.textContent = body.developerDebug ? "Developer: yes" : "Developer: no";
    target.classList.add(body.developerDebug ? "is-on" : "is-off");
    target.disabled = !body.developerDebug;
    if (body.developerDebug) target.classList.add("is-link");
    target.title = body.developerDebug
      ? "This browser IP is allowlisted for developer diagnostics."
      : "This browser IP is not allowlisted for developer diagnostics.";
  } catch {
    target.textContent = "Developer: unavailable";
    target.classList.remove("is-on", "is-off", "is-old");
    target.classList.add("is-unavailable");
    target.classList.remove("is-link");
    target.disabled = true;
    target.title = "The Worker health check could not be completed.";
  }
}

const propModeCopy: Record<PropMode, { label: string; hint: string }> = {
  place: { label: "배치", hint: "사물을 누른 채 움직여 연속으로 배치합니다." },
  move: { label: "이동", hint: "사물을 드래그해 다른 셀로 옮깁니다. 도착한 사물은 덮어씁니다." },
  erase: { label: "지우개", hint: "셀을 누르거나 드래그해 사물만 지웁니다." },
};
function setPropMode(mode: PropMode): void {
  propMode = mode;
  document.querySelectorAll<HTMLButtonElement>("[data-prop-mode]").forEach((button) => {
    const active = button.dataset.propMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#prop-mode-label")!.textContent = propModeCopy[mode].label;
  document.querySelector("#prop-mode-hint")!.textContent = propModeCopy[mode].hint;
  canvas.classList.remove("prop-mode-place", "prop-mode-move", "prop-mode-erase");
  canvas.classList.add(`prop-mode-${mode}`);
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1 || (event.button === 0 && (panMode || spacePressed))) {
    event.preventDefault();
    isDrawing = false;
    beginPan(event);
    return;
  }
  if (selectedLayer === "prop" && propMode === "move") {
    if (event.button !== 0) return;
    const cell = getCell(event);
    const prop = cell ? map.cells[cellIndex(map, cell.column, cell.row)].prop : null;
    if (!cell || !prop) return;
    event.preventDefault();
    isDrawing = true;
    strokeChanged = false;
    lastPaintedCell = `${cell.column}:${cell.row}`;
    movingProp = { prop, fromColumn: cell.column, fromRow: cell.row, target: cell };
    canvas.setPointerCapture(event.pointerId);
    render();
    return;
  }
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault(); isDrawing = true; canvas.setPointerCapture(event.pointerId); paintAt(event);
});
canvas.addEventListener("pointermove", (event) => {
  if (isPanning) panAt(event);
  else paintAt(event);
});
canvas.addEventListener("pointerup", (event) => {
  finishStroke();
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("pointercancel", (event) => {
  movingProp = null;
  finishStroke();
  render();
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerleave", () => { document.querySelector("#cursor-status")!.textContent = "셀 위에 커서를 올려보세요"; });

document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((button) => button.addEventListener("click", () => {
  selectedLayer = button.dataset.layer as Layer;
  if (selectedLayer === "prop") setPropMode("place");
  document.querySelectorAll("[data-layer]").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelector("#ground-palette")!.classList.toggle("hidden", selectedLayer !== "ground");
  document.querySelector("#prop-palette")!.classList.toggle("hidden", selectedLayer !== "prop");
}));
document.querySelectorAll<HTMLButtonElement>("[data-ground]").forEach((button) => button.addEventListener("click", () => {
  selectedGround = button.dataset.ground as GroundType;
  document.querySelectorAll("[data-ground]").forEach((item) => item.classList.toggle("selected", item === button));
}));
document.querySelectorAll<HTMLButtonElement>("[data-prop]").forEach((button) => button.addEventListener("click", () => {
  selectedProp = button.dataset.prop as PropType;
  setPropMode("place");
  document.querySelectorAll("[data-prop]").forEach((item) => item.classList.toggle("selected", item === button));
}));
document.querySelectorAll<HTMLButtonElement>("[data-prop-mode]").forEach((button) => button.addEventListener("click", () => {
  setPropMode(button.dataset.propMode as PropMode);
}));
document.querySelector("#map-name")!.addEventListener("input", (event) => {
  map.name = (event.target as HTMLInputElement).value || "이름 없는 지도"; map.updatedAt = new Date().toISOString(); scheduleSave();
});
document.querySelector("#undo")!.addEventListener("click", undo);
document.querySelector("#redo")!.addEventListener("click", redo);
document.querySelector("#toggle-grid")!.addEventListener("click", (event) => {
  gridVisible = !gridVisible; const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle("active", gridVisible); button.setAttribute("aria-pressed", String(gridVisible)); render();
});
document.querySelector("#zoom-out")!.addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
document.querySelector("#zoom-in")!.addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
document.querySelector("#zoom-reset")!.addEventListener("click", resetViewport);
document.querySelector("#toggle-pan")!.addEventListener("click", () => {
  panMode = !panMode;
  updateViewport();
});
document.querySelector("#reset-map")!.addEventListener("click", () => { savedMapId = null; replaceMap(createInitialMap()); });
document.querySelector("#clear-map")!.addEventListener("click", () => {
  const next = createInitialMap(); next.name = "새로운 숲"; next.cells = next.cells.map(() => ({ ground: "grass", prop: null })); savedMapId = null; replaceMap(next);
});
document.querySelector("#export-json")!.addEventListener("click", () => {
  setFileMenuOpen(false);
  download(new Blob([serializeMap(map)], { type: "application/json" }), "forest-map.json");
});
document.querySelector("#export-png")!.addEventListener("click", () => {
  setFileMenuOpen(false);
  const wasVisible = gridVisible; gridVisible = false; render();
  canvas.toBlob((blob) => { if (blob) download(blob, "forest-map.png"); gridVisible = wasVisible; render(); }, "image/png");
});
document.querySelector("#save-map")!.addEventListener("click", () => openMapSaveDialog(false));
document.querySelector("#save-map-as")!.addEventListener("click", () => openMapSaveDialog(true));
document.querySelector("#open-map-library")!.addEventListener("click", () => { void openMapLibrary(); });
document.querySelector("#open-image-library")!.addEventListener("click", () => { void openImageLibrary(); });
document.querySelector("#open-resize-map")!.addEventListener("click", openResizeMapDialog);
document.querySelector("#confirm-map-save")!.addEventListener("click", () => { void saveMapToCloud(); });
document.querySelector("#upload-image")!.addEventListener("click", () => { void uploadSelectedImage(); });
document.querySelector("#confirm-resize-map")!.addEventListener("click", applyMapResize);
document.querySelector("#file-menu-toggle")!.addEventListener("click", (event) => {
  event.stopPropagation();
  setFileMenuOpen(!fileMenuOpen);
});
document.querySelector("#login-trigger")!.addEventListener("click", () => {
  setFileMenuOpen(false);
  openAuthDialog();
});
document.querySelector("#toggle-fullscreen")!.addEventListener("click", () => { void toggleFullscreen(); });
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
document.addEventListener("click", (event) => {
  const menu = document.querySelector(".file-menu-wrap");
  if (fileMenuOpen && menu && event.target instanceof Node && !menu.contains(event.target)) setFileMenuOpen(false);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setFileMenuOpen(false);
});
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || document.activeElement !== canvas) return;
  event.preventDefault();
  spacePressed = true;
  updateViewport();
});
window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  spacePressed = false;
  updateViewport();
});
window.addEventListener("blur", () => {
  spacePressed = false;
  if (isPanning) finishStroke();
  updateViewport();
});
const dialog = document.querySelector<HTMLDialogElement>("#reference-dialog")!;
document.querySelector("#open-reference")!.addEventListener("click", () => dialog.showModal());
document.querySelector("#close-reference")!.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
const pageQrDialog = document.querySelector<HTMLDialogElement>("#page-qr-dialog")!;
document.querySelector("#open-page-qr")!.addEventListener("click", () => pageQrDialog.showModal());
pageQrDialog.addEventListener("click", () => pageQrDialog.close());
document.querySelectorAll<HTMLButtonElement>("[data-avatar-icon]").forEach((button) => {
  button.addEventListener("click", () => {
    if (isAvatarIcon(button.dataset.avatarIcon)) selectAvatarIcon(button.dataset.avatarIcon);
  });
});
document.querySelector("#save-profile")!.addEventListener("click", async () => {
  if (!authClient || !authSession) return;
  const button = document.querySelector<HTMLButtonElement>("#save-profile")!;
  const message = document.querySelector("#profile-message")!;
  button.disabled = true;
  message.textContent = "이름을 저장하는 중…";
  try {
    const displayName = (document.querySelector("#profile-name") as HTMLInputElement).value.trim();
    if (!displayName) throw new Error("표시 이름을 입력해 주세요.");
    const { profile } = await authClient.updateProfile(
      authSession.token,
      displayName,
      pendingAvatarIcon,
    );
    saveAuthSession({ token: authSession.token, profile });
    renderProfile();
    document.querySelector<HTMLDialogElement>("#profile-dialog")!.close();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "이름을 변경하지 못했습니다.";
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#logout")!.addEventListener("click", async () => {
  if (!authClient || !authSession) return;
  const button = document.querySelector<HTMLButtonElement>("#logout")!;
  const token = authSession.token;
  button.disabled = true;
  try {
    await authClient.logout(token);
  } catch (error) {
    console.error("Logout request failed", error);
  } finally {
    saveAuthSession(null);
    window.google?.accounts.id.disableAutoSelect();
    document.querySelector<HTMLDialogElement>("#profile-dialog")!.close();
    for (const id of ["#map-save-dialog", "#map-library-dialog", "#image-library-dialog"]) {
      const dialog = document.querySelector<HTMLDialogElement>(id);
      if (dialog?.open) dialog.close();
    }
    button.disabled = false;
    renderLoggedOut();
  }
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
setPropMode(propMode);
updateFullscreenButton();
updateViewport();
render();
void initializeDeploymentTime();
void initializeAuth();
