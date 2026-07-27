# Upload SBOM to Threat Detective

[![CI](https://github.com/threatdetective/upload-sbom-action/actions/workflows/test.yml/badge.svg)](https://github.com/threatdetective/upload-sbom-action/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A GitHub Action that uploads a [CycloneDX](https://cyclonedx.org/) SBOM to [Threat Detective](https://threatdetectivehq.com) using OIDC workload identity federation. No long-lived secrets required.

## Prerequisites

1. **Create a trust policy** in your Threat Detective project at **Project → Settings → CI/CD Integrations**. Select "GitHub Actions" as the provider and configure the subject filter to match your repository.

2. **Grant OIDC permissions** in your workflow:

   ```yaml
   permissions:
     id-token: write   # required — lets the action request an OIDC token
     contents: read    # needed by actions/checkout, not by this action
   ```

   > **Without `id-token: write`, the action will fail.** This permission tells GitHub's runner to issue a short-lived JWT (typically valid for 5 minutes) that Threat Detective verifies — no API keys or secrets are needed.

## Quick Start

```yaml
- name: Upload SBOM
  uses: threatdetective/upload-sbom-action@v1
  with:
    project-id: ${{ vars.TD_PROJECT_ID }}
    sbom-file: sbom.json
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `project-id` | Yes | — | Threat Detective project ID |
| `sbom-file` | Yes | — | Path to CycloneDX JSON SBOM file |
| `api-url` | No | `https://eu.threatdetectivehq.com` | Threat Detective API base URL (must be HTTPS) |
| `software-item-name` | No | _(from SBOM)_ | Override the target software item name |
| `version` | No | _(from SBOM)_ | Override the version label |
| `auto-create` | No | `true` | Create the software item if it does not exist |
| `audience` | No | `https://eu.threatdetectivehq.com` | OIDC audience claim (must match your trust policy) |
| `wait-for-completion` | No | `false` | Poll the import status until processing completes |
| `poll-timeout` | No | `120` | Maximum seconds to wait for import completion |

## Outputs

| Output | Description |
|--------|-------------|
| `status` | Import status: `queued`, `existing`, `completed`, or `failed` |
| `import-id` | Import job ID (when queued) |
| `software-item-version-id` | ID of the created or matched software item version |
| `software-item-name` | Name of the software item |
| `version` | Version created or matched |
| `component-count` | Number of components imported |

## Examples

### Minimal — upload on push to main

```yaml
name: SBOM Upload

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  upload-sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          format: cyclonedx-json
          output-file: sbom.json

      - name: Upload SBOM
        uses: threatdetective/upload-sbom-action@v1
        with:
          project-id: ${{ vars.TD_PROJECT_ID }}
          sbom-file: sbom.json
```

### All options — wait for completion

```yaml
- name: Upload SBOM
  id: sbom
  uses: threatdetective/upload-sbom-action@v1
  with:
    project-id: ${{ vars.TD_PROJECT_ID }}
    sbom-file: sbom.json
    software-item-name: my-app
    version: ${{ github.ref_name }}
    auto-create: true
    wait-for-completion: true
    poll-timeout: 180

- name: Show results
  env:
    STATUS: ${{ steps.sbom.outputs.status }}
    COMPONENTS: ${{ steps.sbom.outputs.component-count }}
    VERSION_ID: ${{ steps.sbom.outputs.software-item-version-id }}
  run: |
    echo "Status: ${STATUS}"
    echo "Components: ${COMPONENTS}"
    echo "Version ID: ${VERSION_ID}"
```

### Docker build with SBOM

```yaml
name: Build and Upload SBOM

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker image
        run: docker build -t myapp:latest .

      - name: Generate SBOM from image
        uses: anchore/sbom-action@v0
        with:
          image: myapp:latest
          format: cyclonedx-json
          output-file: sbom.json

      - name: Upload SBOM
        uses: threatdetective/upload-sbom-action@v1
        with:
          project-id: ${{ vars.TD_PROJECT_ID }}
          sbom-file: sbom.json
          software-item-name: myapp
          version: ${{ github.sha }}
```

### Release workflow — upload on publish

```yaml
name: Release SBOM

on:
  release:
    types: [published]

permissions:
  id-token: write
  contents: read

jobs:
  upload-sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          format: cyclonedx-json
          output-file: sbom.json

      - name: Upload SBOM
        uses: threatdetective/upload-sbom-action@v1
        with:
          project-id: ${{ vars.TD_PROJECT_ID }}
          sbom-file: sbom.json
          version: ${{ github.event.release.tag_name }}
          wait-for-completion: true
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Failed to acquire OIDC token | Missing workflow permission | Add `permissions: id-token: write` to your workflow or job |
| No trust policy matches this token | No matching trust policy | Create one at Project → Settings → CI/CD Integrations |
| The matching trust policy is disabled | Policy exists but is disabled | Enable it in your project settings |
| Repository not allowed | Subject filter mismatch | Update the subject filter to include your repository (e.g. `repo:org/repo:*`) |
| OIDC audience does not match | Audience mismatch | Set the `audience` input to match your trust policy's audience value |
| OIDC token has expired | Token expired before upload | Reduce the number of steps before the upload, or increase token lifetime |
| Invalid SBOM | Bad file format | Ensure the file is valid CycloneDX JSON with `bomFormat: "CycloneDX"` |
| Rate limit exceeded | Too many uploads | Stagger your CI pipelines or reduce upload frequency |
| Project not found | Wrong project ID | Check `project-id` matches your Threat Detective project |

## How It Works

1. The action requests a short-lived OIDC JWT from GitHub's identity provider using `@actions/core.getIDToken()`.
2. It uploads the SBOM file to the Threat Detective API with the JWT as a Bearer token.
3. Threat Detective verifies the JWT signature against GitHub's JWKS endpoint and checks it against your trust policy (audience, subject filter, claim conditions).
4. If `wait-for-completion` is enabled, the action polls the import status endpoint until processing completes or the timeout is reached.
5. A job summary table is written with the upload results.

No secrets are stored or transmitted — authentication is entirely based on GitHub's OIDC identity federation.

## Security

- **HTTPS only**: The `api-url` input must use HTTPS. The action refuses to send OIDC tokens over plaintext HTTP.
- **Workspace confinement**: The `sbom-file` path is restricted to the GitHub Actions workspace directory, preventing path traversal on self-hosted runners.
- **Token masking**: The OIDC token is masked from workflow logs via `core.setSecret()`.
- **Request timeouts**: All HTTP requests have a 30-second timeout to prevent runner hang attacks.
- **Pinning**: For production workflows, pin this action to a specific commit SHA rather than a mutable tag:

  ```yaml
  - uses: threatdetective/upload-sbom-action@5598b3142c34c3b74ed984dc70bdb3c9bac045f7 # v1.0.0
  ```

## License

[MIT](LICENSE)
