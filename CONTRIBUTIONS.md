# CONTRIBUTIONS.md — aine-mbabazi

Documents individual contributions to A2 across both the group platform 
repo and this individual service repo, for anti-free-rider grading 
(§ group rules: sole author of ≥1 module PR, reviewer on ≥2 others).

## Group platform repo: `aine-mbabazi/regional-health-platform`

### Sole-authored PRs (2)

**PR #1 — Golden CI reusable workflow** (merged)
- File: `.github/workflows/ci.yml`
- Reusable workflow (`on: workflow_call`) callable from every group 
  member's individual repo via `uses:`
- Three security gates: gitleaks (secrets), trivy (Terraform/Dockerfile 
  misconfig), zizmor (GitHub Actions security)
- All actions pinned to full commit SHAs (defends against tj-actions-style 
  supply chain attacks)
- `step-security/harden-runner` audit on every job with 
  `permissions: contents: read` (least privilege)
- gitleaks installed by downloading pinned tarball + verifying sha256 
  checksum, avoiding third-party action supply-chain risk
- Also created `.gitleaks.toml` with justified allowlist for 
  `.devcontainer/`
- Updated repo `README.md` with calling contract for member repos

**PR #2 — Rewrite modules/data for Aiven MySQL** (merged, reviewed by 
cheshari-pearl)
- Rewrote `modules/data/main.tf`, `variables.tf`, `outputs.tf` after 
  instructor moved managed DB from RDS-on-LocalStack to Aiven MySQL 
  (external, TLS-required)
- Module no longer provisions a database — it publishes caller-supplied 
  Aiven connection details to Secrets Manager using shared envelope
- Added new `ca_cert` envelope key (Aiven requires TLS)
- Preserved sensitive-variable marking, updated outputs with correct 
  `sensitive = true` where needed

### Repo scaffolding
- Created initial repo structure (`modules/`, `.github/workflows/`, 
  `scripts/`, `.devcontainer/`, README.md) — committed before the 
  golden-ci-workflow PR

### Cross-repo access work
- Configured `Settings → Actions → Access → Accessible from repositories 
  owned by the user 'aine-mbabazi'` so the reusable workflow can be 
  called from individual repos

## Individual repo: `aine-mbabazi/db-capacity-engineering-lab`

All work below is on `main` and self-merged from feature branches. All 
commits authored by aine-mbabazi.

### C3 — Secrets flow
- `api/secrets.js` — Secrets Manager resolver with env-var fallback, 
  no `if (isLocalStack)` branching (same binary works against real AWS)
- `api/database.js` — accepts credentials from secrets.js, supports 
  TLS via `ssl: { ca: creds.ca_cert }` for Aiven
- `api/package.json` + `package-lock.json` — added 
  `@aws-sdk/client-secrets-manager`

### C4 — Health, readiness, secret-source endpoints
- `api/server.js` — `/healthz`, `/readyz`, `/debug/secret-source`
- Dedicated probe pool isolation in `database.js` (see FIDELITY.md #1 
  for design trade-off)
- `capacity_api_ready` Prometheus gauge for observability of readiness

### C5 — Caller CI + Dockerfile hardening
- `.github/workflows/ci.yml` — calls group's golden CI via pinned SHA, 
  adds this repo's individually-owned docker-build-and-scan job (buildx 
  + trivy image scanning) and a `tflocal-apply` placeholder
- `api/Dockerfile` — multi-stage build, digest-pinned base 
  (`node:20-slim@sha256:...`), non-root UID 10001, only mysql-client + 
  ca-certificates in runtime, node-based healthcheck (no curl)
- `api/.dockerignore` — excludes `.git`, node_modules, dotfiles

### C1 — Terraform root
- `terraform/main.tf` — composes group's `modules/data` and 
  `modules/service` via git source pinned to golden-ci-workflow merge SHA
- `terraform/variables.tf`, `outputs.tf` — parameterized for LocalStack 
  or real AWS (provider endpoints conditional on `aws_endpoint_url`)
- `terraform/backend.tf` — uses `-backend-config=backend.hcl` since 
  Terraform can't interpolate variables in backend blocks

### C6 — Alert rules + readiness gauge
- `monitoring/alert-rules.yml` — 4 alerts mapped to OPS-2201..2204 
  incidents
- `monitoring/prometheus.yml` — added `rule_files:` block
- `docker-compose.yml` — mounted rule file into Prometheus container

### C7 — Incident replay evidence
- `evidence/07-incidents/OPS-2201/` — 8 screenshots + README
- `evidence/07-incidents/OPS-2202/` — 9 screenshots + README (with 
  design finding on probe pool isolation)
- `evidence/07-incidents/OPS-2203/` — 3 screenshots + README (with 
  instrumentation gap finding)
- `evidence/07-incidents/OPS-2204/` — 7 screenshots + README

### C6 baseline / observability
- `evidence/06-observability/` — 5 Prometheus + Grafana baseline 
  screenshots

### C9 — FIDELITY.md
- Documented 6 trade-offs and gaps between lab and production

## Peer review activity

Reviewer on group PRs (anti-free-rider requires ≥2):
- (Pending — reviews to be logged as teammates open PRs on 
  regional-health-platform)

Reviews received:
- Group PR #2 (Rewrite modules/data for Aiven MySQL) — reviewed and 
  merged by `cheshari-pearl`

## Git history verification

For grader:
git log --author=aine-mbabazi --oneline # in either repo
git log --graph --oneline --all --author=aine-mbabazi

## Timeline summary

- Aug 18 morning: A1 → A2 transition, secrets.js + terraform root drafted
- Aug 18 afternoon: Golden CI workflow authored + PR opened + merged
- Aug 18 evening: Aiven MySQL setup + secrets loaded + TLS wiring
- Aug 19 morning: Aiven-Terraform module rewrite PR opened + merged
- Aug 19 midday: Docker Compose + Prometheus + Grafana stack brought up
- Aug 19-20: Incident replays for OPS-2201..2204 with evidence capture
- Aug 20: FIDELITY.md + CONTRIBUTIONS.md + evidence indexing
