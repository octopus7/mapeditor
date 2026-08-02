import "./styles.css";
import {
  cellIndex, cloneMap, createInitialMap, deserializeMap, paintGround, placeProp, serializeMap,
  type GroundType, type MapDocument, type PropType,
} from "./editor-model";
import { AuthClient, parsePublicAppConfig, type AuthSession } from "./auth-client";

const CELL_SIZE = 36;
const STORAGE_KEY = "mapeditor-draft-v1";
const AUTH_STORAGE_KEY = "mapeditor-auth-v2";
const DEFAULT_DISPLAY_NAME = "새유저";
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

let map = restoreDraft() ?? createInitialMap();
let selectedLayer: Layer = "ground";
let selectedGround: GroundType = "grass";
let selectedProp: PropType = "broadleaf-tree";
let gridVisible = true;
let isDrawing = false;
let strokeChanged = false;
let eraseMode = false;
let lastPaintedCell = "";
let history: MapDocument[] = [];
let future: MapDocument[] = [];
let saveTimer: number | undefined;
let authClient: AuthClient | null = null;
let authSession: AuthSession | null = null;
let googleClientId = "";
let googleIdentityLoadPromise: Promise<void> | null = null;

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
        <button class="button export" id="export-json">JSON 저장</button>
        <button class="button primary" id="export-png">PNG 내보내기</button>
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
          <div class="section-label"><span>OBJECTS</span><span>6종</span></div>
          <div class="prop-grid">
            ${propOptions.map((item, index) => `
              <button class="prop-option ${index === 0 ? "selected" : ""}" data-prop="${item.id}" title="${item.label}">
                <img src="${item.image}" alt="" /><span>${item.label}</span>
              </button>`).join("")}
          </div>
          <button class="eraser" id="eraser">⌫ 사물 지우개 끄기</button>
        </section>
        <div class="tool-tip"><span>TIP</span> 누른 채 움직이면 연속으로 칠할 수 있어요. 오른쪽 클릭은 현재 레이어를 지웁니다.</div>
      </aside>

      <section class="canvas-stage" aria-label="지도 편집 영역">
        <div class="stage-toolbar">
          <div class="status-dot"><i></i><span id="save-status">브라우저에 자동 저장됨</span></div>
          <div class="stage-controls">
            <button class="icon-button active" id="toggle-grid" aria-pressed="true" title="격자 표시">#</button>
            <button class="icon-button" id="reset-map" title="예시 지도로 초기화">↺</button>
            <button class="icon-button" id="clear-map" title="빈 지도로 만들기">□</button>
          </div>
        </div>
        <div class="canvas-scroll"><div class="canvas-frame">
          <canvas id="map-canvas" aria-label="28 곱하기 18 타일 지도" tabindex="0"></canvas>
        </div></div>
        <div class="stage-footer"><span><b>28 × 18</b> 셀</span><span id="cursor-status">셀 위에 커서를 올려보세요</span><span class="footer-links">로컬 초안 · <button type="button" id="open-page-qr">page qr</button> · <a href="https://mapedit.pages.dev/cdn-cgi/trace" target="_blank" rel="noopener noreferrer">cdn trace</a> · <a href="https://github.com/octopus7/mapeditor" target="_blank" rel="noopener noreferrer">github</a></span></div>
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
      <p class="profile-message" id="profile-message">변경한 이름은 계정 설정에 저장됩니다.</p>
      <div class="profile-actions"><button class="button ghost" value="cancel">닫기</button><button class="button danger" type="button" id="logout">로그아웃</button><button class="button primary" type="button" id="save-profile">이름 저장</button></div>
    </form>
  </dialog>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#map-canvas")!;
const context = canvas.getContext("2d")!;
canvas.width = map.columns * CELL_SIZE;
canvas.height = map.rows * CELL_SIZE;
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
function drawGround(column: number, row: number, ground: GroundType): void {
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
const propScale: Record<PropType, number> = {
  "broadleaf-tree": 2.15, "pine-tree": 2.05, shrub: 1.25, boulder: 1.35, "fallen-log": 1.65, footbridge: 1.65,
};
function render(): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < map.rows; row += 1) for (let column = 0; column < map.columns; column += 1) {
    drawGround(column, row, map.cells[cellIndex(map, column, row)].ground);
  }
  for (let row = 0; row < map.rows; row += 1) for (let column = 0; column < map.columns; column += 1) {
    const prop = map.cells[cellIndex(map, column, row)].prop;
    if (!prop) continue;
    const image = propImages.get(prop);
    if (!image?.complete) continue;
    const size = CELL_SIZE * propScale[prop];
    context.drawImage(image, column * CELL_SIZE + CELL_SIZE / 2 - size / 2, row * CELL_SIZE + CELL_SIZE - size * 0.78, size, size);
  }
  if (gridVisible) {
    context.save(); context.strokeStyle = "rgba(21,45,29,.17)"; context.lineWidth = 1; context.beginPath();
    for (let column = 0; column <= map.columns; column += 1) { context.moveTo(column * CELL_SIZE + .5, 0); context.lineTo(column * CELL_SIZE + .5, canvas.height); }
    for (let row = 0; row <= map.rows; row += 1) { context.moveTo(0, row * CELL_SIZE + .5); context.lineTo(canvas.width, row * CELL_SIZE + .5); }
    context.stroke(); context.restore();
  }
  updateHistoryButtons();
}
function getCell(event: PointerEvent): { column: number; row: number } {
  const rect = canvas.getBoundingClientRect();
  return { column: Math.floor(((event.clientX - rect.left) / rect.width) * map.columns), row: Math.floor(((event.clientY - rect.top) / rect.height) * map.rows) };
}
function paintAt(event: PointerEvent): void {
  const { column, row } = getCell(event);
  const key = `${column}:${row}`;
  if (key === lastPaintedCell) return;
  lastPaintedCell = key;
  document.querySelector("#cursor-status")!.textContent = `열 ${column + 1} · 행 ${row + 1}`;
  if (!isDrawing) return;
  const erase = eraseMode || event.button === 2 || (event.buttons & 2) === 2;
  const candidate = cloneMap(map);
  const changed = selectedLayer === "ground" ? paintGround(candidate, column, row, erase ? "grass" : selectedGround) : placeProp(candidate, column, row, erase ? null : selectedProp);
  if (!changed) return;
  if (!strokeChanged) { history.push(cloneMap(map)); if (history.length > 60) history.shift(); future = []; }
  strokeChanged = true; map = candidate; render();
}
function finishStroke(): void {
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
  future.push(cloneMap(map)); map = previous; syncName(); render(); scheduleSave();
}
function redo(): void {
  const next = future.pop(); if (!next) return;
  history.push(cloneMap(map)); map = next; syncName(); render(); scheduleSave();
}
function replaceMap(next: MapDocument): void {
  history.push(cloneMap(map)); future = []; map = next; syncName(); render(); scheduleSave();
}
function download(content: Blob, filename: string): void {
  const link = document.createElement("a"); link.href = URL.createObjectURL(content); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}

function saveAuthSession(session: AuthSession | null): void {
  authSession = session;
  if (session) sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

function restoreAuthSession(): AuthSession | null {
  const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Partial<AuthSession>;
    if (
      typeof session.token !== "string" ||
      typeof session.profile?.id !== "string" ||
      typeof session.profile.email !== "string" ||
      typeof session.profile.displayName !== "string"
    ) return null;
    return session as AuthSession;
  } catch {
    return null;
  }
}

function renderProfile(): void {
  const slot = document.querySelector<HTMLDivElement>("#auth-slot")!;
  if (!authSession) return;
  const button = document.createElement("button");
  const avatar = document.createElement("span");
  const name = document.createElement("strong");
  button.type = "button";
  button.className = "profile-button";
  const shouldRename = authSession.profile.displayName === DEFAULT_DISPLAY_NAME;
  button.title = shouldRename ? "표시 이름을 수정하세요." : "계정 정보 수정";
  button.setAttribute("aria-label", shouldRename ? "표시 이름 수정하기" : "내 계정 정보 열기");
  avatar.textContent = authSession.profile.displayName.trim().charAt(0).toUpperCase() || "?";
  name.textContent = authSession.profile.displayName;
  button.append(avatar, name);
  button.addEventListener("click", openProfileDialog);
  slot.replaceChildren(button);
}

function openProfileDialog(): void {
  if (!authSession) return;
  document.querySelector("#profile-avatar")!.textContent = authSession.profile.displayName.charAt(0).toUpperCase() || "?";
  document.querySelector("#profile-email")!.textContent = authSession.profile.email;
  (document.querySelector("#profile-name") as HTMLInputElement).value = authSession.profile.displayName;
  document.querySelector("#profile-message")!.textContent = "변경한 이름은 계정 설정에 저장됩니다.";
  document.querySelector<HTMLDialogElement>("#profile-dialog")!.showModal();
}

function renderAuthNote(message: string, title?: string): void {
  const note = document.createElement("span");
  note.className = "auth-note";
  note.textContent = message;
  if (title) note.title = title;
  document.querySelector<HTMLDivElement>("#auth-slot")!.replaceChildren(note);
}

function renderAuthRetry(label: string, retry: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "auth-retry";
  button.textContent = label;
  button.addEventListener("click", retry);
  document.querySelector<HTMLDivElement>("#auth-slot")!.replaceChildren(button);
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
  } catch (error) {
    console.error("Google login failed", error);
    renderAuthRetry("로그인 실패 · 다시 시도", () => { void renderGoogleSignIn(); });
  }
}

async function renderGoogleSignIn(): Promise<void> {
  const slot = document.querySelector<HTMLDivElement>("#auth-slot")!;
  if (!googleClientId) {
    renderAuthNote("로그인 설정 필요", "app-config.json에 Google OAuth 클라이언트 ID를 설정해야 합니다.");
    return;
  }
  renderAuthNote("Google 로그인 로딩…");
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
  } catch (error) {
    console.error("Google Identity initialization failed", error);
    renderAuthRetry("로그인 다시 시도", () => { void renderGoogleSignIn(); });
  }
}

async function initializeAuth(): Promise<void> {
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
    googleClientId = config.googleClientId;
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
    await renderGoogleSignIn();
  } catch (error) {
    console.error("Authentication setup failed", error);
    renderAuthRetry("로그인 서버 다시 연결", () => { void initializeAuth(); });
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  event.preventDefault(); isDrawing = true; canvas.setPointerCapture(event.pointerId); paintAt(event);
});
canvas.addEventListener("pointermove", paintAt);
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointerleave", () => { document.querySelector("#cursor-status")!.textContent = "셀 위에 커서를 올려보세요"; });

document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((button) => button.addEventListener("click", () => {
  selectedLayer = button.dataset.layer as Layer; eraseMode = false;
  document.querySelectorAll("[data-layer]").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelector("#ground-palette")!.classList.toggle("hidden", selectedLayer !== "ground");
  document.querySelector("#prop-palette")!.classList.toggle("hidden", selectedLayer !== "prop");
}));
document.querySelectorAll<HTMLButtonElement>("[data-ground]").forEach((button) => button.addEventListener("click", () => {
  selectedGround = button.dataset.ground as GroundType;
  document.querySelectorAll("[data-ground]").forEach((item) => item.classList.toggle("selected", item === button));
}));
document.querySelectorAll<HTMLButtonElement>("[data-prop]").forEach((button) => button.addEventListener("click", () => {
  selectedProp = button.dataset.prop as PropType; eraseMode = false;
  document.querySelector("#eraser")!.classList.remove("active");
  document.querySelectorAll("[data-prop]").forEach((item) => item.classList.toggle("selected", item === button));
}));
document.querySelector("#eraser")!.addEventListener("click", (event) => {
  eraseMode = !eraseMode; (event.currentTarget as HTMLElement).classList.toggle("active", eraseMode);
  (event.currentTarget as HTMLElement).textContent = eraseMode ? "⌫ 사물 지우개 켜짐" : "⌫ 사물 지우개 끄기";
});
document.querySelector("#map-name")!.addEventListener("input", (event) => {
  map.name = (event.target as HTMLInputElement).value || "이름 없는 지도"; map.updatedAt = new Date().toISOString(); scheduleSave();
});
document.querySelector("#undo")!.addEventListener("click", undo);
document.querySelector("#redo")!.addEventListener("click", redo);
document.querySelector("#toggle-grid")!.addEventListener("click", (event) => {
  gridVisible = !gridVisible; const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle("active", gridVisible); button.setAttribute("aria-pressed", String(gridVisible)); render();
});
document.querySelector("#reset-map")!.addEventListener("click", () => replaceMap(createInitialMap()));
document.querySelector("#clear-map")!.addEventListener("click", () => {
  const next = createInitialMap(); next.name = "새로운 숲"; next.cells = next.cells.map(() => ({ ground: "grass", prop: null })); replaceMap(next);
});
document.querySelector("#export-json")!.addEventListener("click", () => download(new Blob([serializeMap(map)], { type: "application/json" }), "forest-map.json"));
document.querySelector("#export-png")!.addEventListener("click", () => {
  const wasVisible = gridVisible; gridVisible = false; render();
  canvas.toBlob((blob) => { if (blob) download(blob, "forest-map.png"); gridVisible = wasVisible; render(); }, "image/png");
});
const dialog = document.querySelector<HTMLDialogElement>("#reference-dialog")!;
document.querySelector("#open-reference")!.addEventListener("click", () => dialog.showModal());
document.querySelector("#close-reference")!.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
const pageQrDialog = document.querySelector<HTMLDialogElement>("#page-qr-dialog")!;
document.querySelector("#open-page-qr")!.addEventListener("click", () => pageQrDialog.showModal());
pageQrDialog.addEventListener("click", () => pageQrDialog.close());
document.querySelector("#save-profile")!.addEventListener("click", async () => {
  if (!authClient || !authSession) return;
  const button = document.querySelector<HTMLButtonElement>("#save-profile")!;
  const message = document.querySelector("#profile-message")!;
  button.disabled = true;
  message.textContent = "이름을 저장하는 중…";
  try {
    const displayName = (document.querySelector("#profile-name") as HTMLInputElement).value.trim();
    if (!displayName) throw new Error("표시 이름을 입력해 주세요.");
    const { profile } = await authClient.updateProfile(authSession.token, displayName);
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
    button.disabled = false;
    void renderGoogleSignIn();
  }
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
});
render();
void initializeAuth();
