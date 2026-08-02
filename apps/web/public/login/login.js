(async () => {
  const AUTH_STORAGE_KEY = "mapeditor-auth-v3";
  const stateKey = "mapeditor-google-state";
  const nonceKey = "mapeditor-google-nonce";
  const button = document.querySelector("#google-login");
  const status = document.querySelector("#login-status");

  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };

  const randomValue = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
  };

  const clearRedirectState = () => {
    sessionStorage.removeItem(stateKey);
    sessionStorage.removeItem(nonceKey);
    window.history.replaceState({}, document.title, "/login/");
  };

  try {
    const configResponse = await fetch("/app-config.json", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("로그인 설정을 불러오지 못했습니다.");
    const config = await configResponse.json();
    if (typeof config.apiBaseUrl !== "string" || typeof config.googleClientId !== "string" || !config.apiBaseUrl || !config.googleClientId) {
      throw new Error("Google 로그인 설정이 준비되지 않았습니다.");
    }

    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const credential = hash.get("id_token");
    const googleError = hash.get("error");
    if (credential || googleError) {
      const expectedState = sessionStorage.getItem(stateKey);
      const expectedNonce = sessionStorage.getItem(nonceKey);
      clearRedirectState();
      if (googleError || !credential || !expectedState || hash.get("state") !== expectedState || !expectedNonce) {
        throw new Error("Google 로그인 요청을 확인할 수 없습니다.");
      }
      setStatus("Google 로그인 확인 중…");
      const response = await fetch(`${config.apiBaseUrl.replace(/\/+$/u, "")}/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ credential, nonce: expectedNonce }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.token || !result.profile) {
        throw new Error(result?.error?.message || result?.message || "Google 로그인에 실패했습니다.");
      }
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: result.token, profile: result.profile }));
      window.location.replace("/");
      return;
    }

    button.disabled = false;
    setStatus("Google 계정으로 계속하려면 버튼을 눌러주세요.");
    button.addEventListener("click", () => {
      button.disabled = true;
      setStatus("Google 로그인 화면으로 이동 중…");
      const state = randomValue();
      const nonce = randomValue();
      sessionStorage.setItem(stateKey, state);
      sessionStorage.setItem(nonceKey, nonce);
      const redirectUri = new URL("/login/", window.location.origin).href;
      const params = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: redirectUri,
        response_type: "id_token",
        response_mode: "fragment",
        scope: "openid email profile",
        state,
        nonce,
        prompt: "select_account",
      });
      window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    });
  } catch (error) {
    button.disabled = true;
    setStatus(error instanceof Error ? error.message : "Google 로그인에 실패했습니다.", true);
  }
})();
