const summary = document.querySelector("#summary");
const summaryTitle = document.querySelector("#summary-title");
const summaryDetail = document.querySelector("#summary-detail");
const checks = document.querySelector("#checks");
const rawResponse = document.querySelector("#raw-response");
const checkedAt = document.querySelector("#checked-at");
const runButton = document.querySelector("#run-diagnostics");

const requiredTables = ["users", "image_assets", "maps"];

function setSummary(state, title, detail) {
  summary.className = `summary ${state}`;
  summaryTitle.textContent = title;
  summaryDetail.textContent = detail;
}

function addCheck(label, detail, state = "pending", status = "WAITING") {
  const item = document.createElement("article");
  item.className = `check ${state}`;
  item.innerHTML = `
    <span class="status-dot" aria-hidden="true"></span>
    <div class="check-copy"><strong></strong><span></span></div>
    <span class="check-status"></span>`;
  item.querySelector("strong").textContent = label;
  item.querySelector("span:not(.status-dot):not(.check-status)").textContent = detail;
  item.querySelector(".check-status").textContent = status;
  checks.append(item);
}

function formatCount(count) {
  return typeof count === "number" ? `${count.toLocaleString()} row${count === 1 ? "" : "s"}` : "row count unavailable";
}

async function requestJson(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { response, body };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runDiagnostics() {
  runButton.disabled = true;
  checks.replaceChildren();
  rawResponse.textContent = "No response yet.";
  setSummary("pending", "Running diagnostics", "Loading the public deployment configuration.");

  try {
    const configResponse = await requestJson("/app-config.json");
    const config = configResponse.body;
    if (!configResponse.response.ok || typeof config?.apiBaseUrl !== "string" || !config.apiBaseUrl) {
      addCheck("Deployment configuration", "app-config.json does not contain an API base URL.", "fail", "FAIL");
      setSummary("fail", "Configuration is incomplete", "Deploy the Pages site with MAPEDITOR_API_BASE_URL configured.");
      return;
    }
    const apiBaseUrl = config.apiBaseUrl.replace(/\/$/u, "");
    addCheck("Deployment configuration", apiBaseUrl, "ok", "PASS");

    const healthResult = await requestJson(`${apiBaseUrl}/health`);
    rawResponse.textContent = JSON.stringify(healthResult.body, null, 2);
    const health = healthResult.body;
    if (!healthResult.response.ok || health?.ok !== true) {
      addCheck("Worker reachability", `HTTP ${healthResult.response.status}: ${health?.error?.message ?? "health check failed"}`, "fail", "FAIL");
      setSummary("fail", "Worker check failed", "The API did not return a healthy response.");
      return;
    }
    addCheck("Worker reachability", `HTTP ${healthResult.response.status} · ${health.service ?? "unknown service"}`, "ok", "PASS");
    addCheck("Developer access", health.developerDebug === true ? "This IP is allowlisted for detailed diagnostics." : "This IP is not allowlisted for detailed diagnostics.", health.developerDebug === true ? "ok" : "warn", health.developerDebug === true ? "PASS" : "WARN");

    const d1Result = await requestJson(`${apiBaseUrl}/health?d1=1`);
    rawResponse.textContent = JSON.stringify({ health, d1: d1Result.body }, null, 2);
    if (!d1Result.response.ok || d1Result.body?.storage !== "d1") {
      const message = d1Result.response.status === 404
        ? "Detailed D1 diagnostics are restricted to the allowlisted developer IP."
        : `HTTP ${d1Result.response.status}: ${d1Result.body?.error?.message ?? "D1 diagnostic failed"}`;
      addCheck("D1 diagnostic query", message, "fail", "FAIL");
      setSummary("fail", "D1 diagnostics failed", "Worker is reachable, but detailed D1 checks did not complete.");
      return;
    }
    addCheck("D1 binding and query", "The Worker completed a live query through the D1 binding.", "ok", "PASS");

    const tableMap = new Map((d1Result.body.tables ?? []).map((table) => [table.name, table]));
    let tablesOk = true;
    for (const name of requiredTables) {
      const table = tableMap.get(name);
      const exists = table?.exists === true && typeof table?.rowCount === "number";
      tablesOk = tablesOk && exists;
      addCheck(name, exists ? formatCount(table.rowCount) : "Table is missing or could not be queried.", exists ? "ok" : "fail", exists ? "PASS" : "FAIL");
    }
    const migrationTable = d1Result.body.migrationTable;
    const migrationOk = migrationTable?.exists === true;
    addCheck("D1 migration metadata", migrationOk ? formatCount(migrationTable.rowCount) : "d1_migrations table was not found.", migrationOk ? "ok" : "warn", migrationOk ? "PASS" : "WARN");

    if (tablesOk) {
      setSummary("ok", "D1 is ready", migrationOk ? "Worker, D1, required tables, and migration metadata are available." : "Worker, D1, and required application tables are available.");
    } else {
      setSummary("fail", "D1 schema is incomplete", "At least one required application table is missing or unavailable.");
    }
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "Request timed out after 10 seconds."
      : error instanceof Error ? error.message : "Unknown diagnostic error.";
    addCheck("Diagnostic request", message, "fail", "FAIL");
    setSummary("fail", "Diagnostics could not complete", message);
    rawResponse.textContent = message;
  } finally {
    checkedAt.textContent = `Checked ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date())}`;
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => { void runDiagnostics(); });
void runDiagnostics();
