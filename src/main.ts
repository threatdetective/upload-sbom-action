import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";

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
  rate_limited: "Rate limit exceeded. The action will retry automatically.",
  jwks_error:
    "Failed to fetch OIDC signing keys from the identity provider. This is usually a transient error — retry the workflow.",
  not_found: "Resource not found. Check your project-id and import-id values.",
};

async function run(): Promise<void> {
  try {
    const projectId = core.getInput("project-id", { required: true });
    const sbomFile = core.getInput("sbom-file", { required: true });
    const apiUrl = core
      .getInput("api-url", { required: false })
      .replace(/\/+$/, "");
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

    const resolvedPath = path.resolve(sbomFile);
    if (!fs.existsSync(resolvedPath)) {
      core.setFailed(`SBOM file not found: ${resolvedPath}`);
      return;
    }

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

    const uploadResponse = await fetch(uploadUrl, {
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
        parseInt(uploadResponse.headers.get("Retry-After") ?? "30", 10);
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
          `Upload failed (HTTP ${uploadResponse.status}): ${uploadBody}`,
        );
      }
      return;
    }

    const upload = safeParseJson<UploadResponse>(uploadBody);
    if (!upload) {
      core.setFailed(`Unexpected response from API: ${uploadBody}`);
      return;
    }

    core.setOutput("status", upload.status);
    if (upload.import_id) core.setOutput("import-id", upload.import_id);
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
    const response = await fetch(pollUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("Retry-After") ?? "10",
        10,
      );
      core.info(`Rate limited, retrying after ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (response.status >= 400) {
      const body = await response.text();
      core.warning(
        `Poll request failed (HTTP ${response.status}): ${body.substring(0, 200)}`,
      );
      await sleep(pollInterval);
      continue;
    }

    const status = safeParseJson<ImportStatusResponse>(await response.text());
    if (!status) {
      core.warning("Failed to parse import status response");
      await sleep(pollInterval);
      continue;
    }

    core.info(`Import status: ${status.status}`);

    if (status.status === "completed" || status.status === "failed") {
      return status;
    }

    await sleep(pollInterval);
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
      ["Status", `${statusEmoji} ${finalStatus}`],
      ["Software Item", upload.software_item_name ?? "—"],
      ["Version", upload.version ?? "—"],
      ["Components", String(componentCount)],
      ["Import ID", upload.import_id ?? "—"],
      ["Software Item Version ID", String(softwareItemVersionId)],
    ])
    .write();
}

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

run();
