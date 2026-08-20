# Regional Health — Reliability On-Call Lab 🧪

> **A2 Rehost Progress:** this repo extends the A1 capacity lab with a 
> cloud-shaped deployment: hardened multi-stage Docker image, Terraform 
> IaC composing group modules (RDS-as-Secrets + EC2), Aiven MySQL as 
> managed DB, TLS to the database, `/healthz` + `/readyz` + 
> `/debug/secret-source` endpoints, Prometheus alert rules mapped to the 
> A1 incidents, and CI gates (gitleaks + trivy + zizmor) enforcing 
> supply-chain hygiene.
>
> **Start here for A2 grading:**
> - `evidence/README.md` — full evidence index (baseline monitoring + 
>   incident replays for OPS-2201..2204)
> - `FIDELITY.md` — 6 documented trade-offs / gaps for C9
> - `CONTRIBUTIONS.md` — individual + group PR log for anti-free-rider
> - `terraform/` — root module composing group's `modules/data` + 
>   `modules/service` from 
>   [regional-health-platform](https://github.com/aine-mbabazi/regional-health-platform)
> - `api/secrets.js`, `api/database.js` — Secrets Manager + TLS wiring
> - `api/Dockerfile` — hardened multi-stage build (digest-pinned, non-root, 
>   node-based healthcheck)
> - `.github/workflows/ci.yml` — this repo's CI, calls group's golden 
>   reusable workflow
>
> **A2 port map** (differs from A1 to avoid host collisions with local 
> tools):  
> Grafana: `http://localhost:3002` · Prometheus: `http://localhost:9091` · 
> capacity-api: `http://localhost:3003`

---


A hands-on "Lab-in-a-Box" for learning **database mechanics, performance tuning,
and capacity engineering** the way you actually learn them on the job: by picking
up an incident ticket, reproducing the symptom, and investigating until you find
the root cause.

You are the on-call engineer for the **Regional Health** platform — a healthcare
API backed by MySQL. There is an [incident queue](./incidents/README.md) of open
tickets. Each ticket is a symptom report from a user or another team. **No ticket
tells you the cause, and there is no answer key in this repo.** You diagnose it
from evidence: query plans, connection behaviour, locks, and memory, observed
through Prometheus and Grafana.

> This is a training environment seeded with realistic data and realistic
> problems. Treat it like production you've just been handed.

---

## The environment

| Component        | Tech                  | Port  | Role                                  |
|------------------|-----------------------|-------|---------------------------------------|
| `capacity-api`   | Node.js + Express     | 3000  | The application under investigation   |
| `mysql-db`       | MySQL 8.0             | 3306  | Primary relational store              |
| `mongo-db`       | MongoDB 6.0           | 27017 | Audit store                           |
| `prometheus`     | Prometheus            | 9090  | Metrics scraping                      |
| `grafana`        | Grafana               | 3001  | Dashboards                            |
| load generator   | k6                    | —     | Reproduces each incident's traffic    |

---

## Quick start (3 steps)

### 1. Start the environment
```bash
docker compose up -d --build
```
Wait ~30–60s for MySQL to become healthy (`docker compose ps`).

### 2. Seed realistic data (100,000 patients, 5 hospitals)
The seed script runs *inside* the API container:
```bash
docker compose exec capacity-api bash /usr/local/bin/seed.sh
```

### 3. Open the dashboards
- **Grafana:**    http://localhost:3001  (user `admin` / pass `admin`; anonymous admin is also enabled)
- **Prometheus:** http://localhost:9090
- **API health:** http://localhost:3000/health
- **API metrics:** http://localhost:3000/metrics

In Grafana, add Prometheus as a data source at `http://prometheus:9090`, then
chart `http_request_duration_seconds`, `http_requests_total`,
`db_errors_total`, and `nodejs_heap_size_used_bytes`. Suggested queries are in
[`LAB_JOURNAL.md`](./LAB_JOURNAL.md).

---

## Your job: work the incident queue

Open **[`incidents/README.md`](./incidents/README.md)** and pick a ticket.

The general loop for every incident:

1. **Baseline** the healthy system so you have a control group:
   ```bash
   k6 run load-tests/00-baseline.js
   ```
2. **Reproduce** the reported symptom using that ticket's script, e.g.:
   ```bash
   k6 run load-tests/reproduce-OPS-2201.js
   ```
   (Each `reproduce-OPS-XXXX.js` recreates the *traffic pattern* from ticket
   `OPS-XXXX` — it does not tell you the cause.)
3. **Investigate** with the tools below while the load runs.
4. **Diagnose, fix, and re-run** to prove the fix.
5. **Write it up** in [`LAB_JOURNAL.md`](./LAB_JOURNAL.md).

> No installed k6? Run it in Docker (Linux host networking):
> ```bash
> docker run --rm -i --network host grafana/k6 run - < load-tests/reproduce-OPS-2201.js
> ```

---

## Investigation toolbox

```bash
# Follow the application logs (crashes, errors, restarts)
docker compose logs -f capacity-api

# Live memory / CPU / restart counts per container
docker stats

# Open a MySQL shell to inspect plans, locks, and schema
docker compose exec mysql-db mysql -uroot -plabpassword capacity_lab
```

Inside the MySQL shell, techniques worth knowing:
`EXPLAIN ANALYZE <query>`, `SHOW CREATE TABLE <t>`, `SHOW ENGINE INNODB STATUS`,
and the `performance_schema` / `sys` views for locking. Which ones matter for a
given ticket is part of the exercise.

---

## Teardown
```bash
docker compose down -v
```

Good luck, on-call. 📟
