# Security Policy

## Supported Versions

Only the latest release of this action is supported. Pin to the `v1`
major tag to receive security fixes automatically, or pin to a commit
SHA and update it when new releases are published.

## Reporting a Vulnerability

Please report vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/threatdetective/upload-sbom-action/security/advisories/new)
— do **not** open a public issue for security reports.

We will acknowledge reports within 3 business days.

## Security Design Notes

- Authentication uses short-lived GitHub OIDC tokens only; the action
  stores no long-lived credentials.
- The OIDC token is masked from workflow logs and is only ever sent
  over HTTPS.
- The `sbom-file` path is confined to the workflow workspace
  (symlinks are resolved before the check).
- All third-party GitHub Actions used by this repository's workflows
  are pinned to commit SHAs, and npm dependencies are locked via
  `package-lock.json`.
