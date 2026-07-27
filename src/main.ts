import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_ERROR_BODY_LENGTH = 500;
const IMPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UploadResponse {
  status: "queued" | "existing";
  import_id?: string;
  project_id?: number;
  software_item_name?: string;
  version?: string;
  component_count?: number;
  software_item_version_id?: number;
  message?: string;
}

interface ImportStatusResponse {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  software_item_name?: string;
  version_label?: string;
  component_count?: number;
  software_item_version_id?: number;
  error_messages?: string[];
}

interface ApiErrorResponse {
  error: string;
  message: string;
  retry_after?: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_token:
    "Internal error — OIDC token was not sent correctly. Please report this as a bug.",
  invalid_format:
    "Internal error — Authorization header was malformed. Please report this as a bug.",
  decode_error: "OIDC token could not be decoded. The token may be corrupted.",
  signature_invalid:
    "OIDC token signature verification failed. Ensure your trust policy issuer URL is correct.",
  token_expired:
    "OIDC token has expired. This may happen if earlier workflow steps took too long.",
  unauthorized: "Project not found. Check your project-id input.",
  no_matching_policy:
    "No trust policy matches this token. Configure one at Project → Settings → CI/CD Integrations.",
  policy_disabled:
    "The matching trust policy is disabled. Enable it at Project → Settings → CI/CD Integrations.",
  insufficient_scope:
    'Trust policy does not allow SBOM uploads. Add "sbom:upload" to allowed scopes.',
  audience_mismatch:
    'OIDC audience does not match the trust policy. Check the "audience" input matches your trust policy configuration.',
  subject_mismatch:
    "Repository not allowed by the trust policy subject filter. Update the filter at Project → Settings → CI/CD Integrations.",
  claims_mismatch:
    "Token claims do not satisfy the trust policy conditions. Check claim_conditions in your trust policy.",
  validation_error:
    "Invalid SBOM — ensure the file is valid CycloneDX JSON format.",
  rate_limited:
    "Rate limit exceeded. Re-run the workflow, or stagger your CI pipelines.",
  jwks_error:
    "Failed to fetch OIDC signing keys from the identity provider. This is usually a transient error — retry the workflow.",
  not_found: "Resource not found. Check your project-id and import-id values.",
};

async function run(): Promise<void> {
  try {
    const projectId = core.getInput("project-id", { required: true });
    const sbomFile = core.getInput("sbom-file", { required: true });
    const apiUrl = validateApiUrl(
      core.getInput("api-url", { required: false }),
    );
    const softwareItemName = core.getInput("software-item-name", {
      required: false,
    });
    const version = core.getInput("version", { required: false });
    const autoCreate = core.getBooleanInput("auto-create", { required: false });
    const audience = core.getInput("audience", { required: false });
    const waitForCompletion = core.getBooleanInput("wait-for-completion", {
      required: false,
    });
    const pollTimeout = parseInt(
      core.getInput("poll-timeout", { required: false }),
      10,
    );

    if (isNaN(pollTimeout) || pollTimeout <= 0) {
      core.setFailed("poll-timeout must be a positive integer");
      return;
    }

    const resolvedPath = validateSbomPath(sbomFile);

    const stats = fs.statSync(resolvedPath);
    if (stats.size > 50 * 1024 * 1024) {
      core.setFailed("SBOM file exceeds the maximum size of 50MB");
      return;
    }

    core.info(`SBOM file: ${resolvedPath} (${formatBytes(stats.size)})`);

    // Step 1: Acquire OIDC token
    core.startGroup("Requesting OIDC token");
    let token: string;
    try {
      token = await core.getIDToken(audience);
      core.setSecret(token);
      core.info("OIDC token acquired successfully");
    } catch (error) {
      core.endGroup();
      core.setFailed(
        "Failed to acquire OIDC token. Ensure your workflow has:\n\n" +
          "  permissions:\n" +
          "    id-token: write\n\n" +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    core.endGroup();

    // Step 2: Upload SBOM
    core.startGroup("Uploading SBOM");
    const uploadUrl = `${apiUrl}/api/v1/projects/${encodeURIComponent(projectId)}/sbom`;
    core.info(`POST ${uploadUrl}`);

    const fileContent = fs.readFileSync(resolvedPath);
    const fileName = path.basename(resolvedPath);

    const formData = new FormData();
    formData.append(
      "sbom",
      new Blob([fileContent], { type: "application/json" }),
      fileName,
    );
    formData.append("auto_create", autoCreate ? "true" : "false");
    if (softwareItemName) {
      formData.append("software_item_name", softwareItemName);
    }
    if (version) {
      formData.append("version", version);
    }

    const uploadResponse = await fetchWithTimeout(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: formData,
    });

    const uploadBody = await uploadResponse.text();
    core.endGroup();

    if (uploadResponse.status === 429) {
      const parsed = safeParseJson<ApiErrorResponse>(uploadBody);
      const retryAfter =
        parsed?.retry_after ??
        parseRetryAfterSeconds(uploadResponse.headers.get("Retry-After"), 30);
      core.setFailed(
        `Rate limit exceeded. Retry after ${retryAfter} seconds. ` +
          "Reduce upload frequency or stagger your CI pipelines.",
      );
      return;
    }

    if (uploadResponse.status >= 400) {
      const parsed = safeParseJson<ApiErrorResponse>(uploadBody);
      if (parsed?.error) {
        const friendly =
          ERROR_MESSAGES[parsed.error] ?? `${parsed.error}: ${parsed.message}`;
        core.setFailed(
          `Upload failed (HTTP ${uploadResponse.status}): ${friendly}`,
        );
      } else {
        core.setFailed(
          `Upload failed (HTTP ${uploadResponse.status}): ${truncate(uploadBody)}`,
        );
      }
      return;
    }

    const upload = safeParseJson<UploadResponse>(uploadBody);
    if (!upload) {
      core.setFailed(`Unexpected response from API: ${truncate(uploadBody)}`);
      return;
    }

    core.setOutput("status", upload.status);
    if (upload.import_id) {
      if (!IMPORT_ID_PATTERN.test(upload.import_id)) {
        core.setFailed(
          `Unexpected import_id format returned by API: ${truncate(upload.import_id)}`,
        );
        return;
      }
      core.setOutput("import-id", upload.import_id);
    }
    if (upload.software_item_name)
      core.setOutput("software-item-name", upload.software_item_name);
    if (upload.version) core.setOutput("version", upload.version);
    if (upload.component_count !== undefined)
      core.setOutput("component-count", upload.component_count.toString());
    if (upload.software_item_version_id !== undefined)
      core.setOutput(
        "software-item-version-id",
        upload.software_item_version_id.toString(),
      );

    if (upload.status === "existing") {
      core.info(
        `SBOM already imported: ${upload.message ?? "duplicate serial number"}`,
      );
    } else {
      core.info(
        `SBOM queued for import (ID: ${upload.import_id}, ` +
          `software item: ${upload.software_item_name}, ` +
          `version: ${upload.version}, ` +
          `components: ${upload.component_count})`,
      );
    }

    // Step 3: Poll for completion (if requested)
    if (waitForCompletion && upload.status === "queued" && upload.import_id) {
      core.startGroup("Waiting for import completion");
      const importStatus = await pollImportStatus(
        apiUrl,
        projectId,
        upload.import_id,
        token,
        pollTimeout,
      );

      if (importStatus) {
        core.setOutput("status", importStatus.status);
        if (importStatus.component_count !== undefined) {
          core.setOutput(
            "component-count",
            importStatus.component_count.toString(),
          );
        }
        if (importStatus.software_item_version_id !== undefined) {
          core.setOutput(
            "software-item-version-id",
            importStatus.software_item_version_id.toString(),
          );
        }

        if (importStatus.status === "failed") {
          const errors = importStatus.error_messages?.join(", ") ?? "unknown";
          core.setFailed(`Import failed: ${errors}`);
          core.endGroup();
          await writeSummary(upload, importStatus);
          return;
        }

        core.info(
          `Import completed: ${importStatus.component_count ?? 0} components`,
        );
      }
      core.endGroup();

      await writeSummary(upload, importStatus);
    } else {
      await writeSummary(upload, null);
    }
  } catch (error) {
    core.setFailed(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function pollImportStatus(
  apiUrl: string,
  projectId: string,
  importId: string,
  token: string,
  timeoutSeconds: number,
): Promise<ImportStatusResponse | null> {
  const pollUrl = `${apiUrl}/api/v1/projects/${encodeURIComponent(projectId)}/sbom/imports/${encodeURIComponent(importId)}`;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const pollInterval = 5000;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const response = await fetchWithTimeout(pollUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.status === 429) {
      const rawRetryAfter = parseRetryAfterSeconds(
        response.headers.get("Retry-After"),
        10,
      );
      const retryAfter = Math.min(rawRetryAfter, MAX_RETRY_AFTER_SECONDS);
      const sleepMs = Math.min(retryAfter * 1000, deadline - Date.now());
      if (sleepMs <= 0) break;
      core.info(`Rate limited, retrying after ${retryAfter}s...`);
      await sleep(sleepMs);
      continue;
    }

    if (response.status >= 400) {
      const body = await response.text();
      core.warning(
        `Poll request failed (HTTP ${response.status}): ${truncate(body, 200)}`,
      );
      await sleep(Math.min(pollInterval, deadline - Date.now()));
      continue;
    }

    const status = safeParseJson<ImportStatusResponse>(await response.text());
    if (!status) {
      core.warning("Failed to parse import status response");
      await sleep(Math.min(pollInterval, deadline - Date.now()));
      continue;
    }

    core.info(`Import status: ${status.status}`);

    if (status.status === "completed" || status.status === "failed") {
      return status;
    }

    await sleep(Math.min(pollInterval, deadline - Date.now()));
  }

  core.setFailed(
    `Timed out after ${timeoutSeconds}s waiting for import to complete. ` +
      `The import is still processing — check the Threat Detective dashboard for results.`,
  );
  return null;
}

async function writeSummary(
  upload: UploadResponse,
  importStatus: ImportStatusResponse | null,
): Promise<void> {
  const finalStatus = importStatus?.status ?? upload.status;
  const componentCount =
    importStatus?.component_count ?? upload.component_count ?? "—";
  const softwareItemVersionId =
    importStatus?.software_item_version_id ??
    upload.software_item_version_id ??
    "—";

  const statusEmoji =
    finalStatus === "completed"
      ? "\u2705"
      : finalStatus === "failed"
        ? "\u274c"
        : finalStatus === "existing"
          ? "\u2139\ufe0f"
          : "\u23f3";

  await core.summary
    .addHeading("SBOM Upload — Threat Detective")
    .addTable([
      [
        { data: "Field", header: true },
        { data: "Value", header: true },
      ],
      ["Status", `${statusEmoji} ${escapeHtml(finalStatus)}`],
      ["Software Item", escapeHtml(upload.software_item_name ?? "—")],
      ["Version", escapeHtml(upload.version ?? "—")],
      ["Components", escapeHtml(String(componentCount))],
      ["Import ID", escapeHtml(upload.import_id ?? "—")],
      ["Software Item Version ID", escapeHtml(String(softwareItemVersionId))],
    ])
    .write();
}

function validateApiUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`api-url is not a valid URL: ${trimmed}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `api-url must use HTTPS (got ${parsed.protocol}). ` +
        "Sending OIDC tokens over plaintext HTTP is not allowed.",
    );
  }
  return trimmed;
}

function validateSbomPath(sbomFile: string): string {
  const resolvedPath = path.resolve(sbomFile);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`SBOM file not found: ${resolvedPath}`);
  }

  // realpath resolves symlinks so a link inside the workspace cannot
  // point the upload at a file outside it
  const realPath = fs.realpathSync(resolvedPath);

  const workspace = process.env["GITHUB_WORKSPACE"];
  if (workspace) {
    const realWorkspace = fs.realpathSync(path.resolve(workspace));
    if (
      realPath !== realWorkspace &&
      !realPath.startsWith(realWorkspace + path.sep)
    ) {
      throw new Error(
        `sbom-file must be within the workspace directory (${realWorkspace}). Got: ${realPath}`,
      );
    }
  }

  return realPath;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        `HTTP request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(
  s: string,
  maxLength: number = MAX_ERROR_BODY_LENGTH,
): string {
  if (s.length <= maxLength) return s;
  return s.substring(0, maxLength) + "... (truncated)";
}

function parseRetryAfterSeconds(
  header: string | null,
  fallback: number,
): number {
  // Retry-After may be an HTTP-date rather than delta-seconds; treat
  // anything non-numeric as the fallback instead of propagating NaN
  const parsed = parseInt(header ?? "", 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

run();
