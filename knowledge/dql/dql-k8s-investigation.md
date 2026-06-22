# DQL Kubernetes Investigation — `saas-demo-eks`

Live investigation of the Kubernetes cluster on tenant `asn8731h.sprint`, by trial-and-error. Captures
the **working query patterns**, the **gotchas hit**, and the **actual diagnosis** found.

## Cluster shape

- **1 cluster** `saas-demo-eks`, **4 nodes** (the eu-central-1 EC2 hosts), **~63 pods** across 4 namespaces.
- Pods per namespace: `apps` 21, `kube-system` 20, `dynatrace` 17, `opentelemetry` 5.
- ~38 workloads — an e-commerce microservice demo: `frontend`, `api-gateway`, `payment-service`,
  `order-service`, `notification-service`, `postgres`, `redis`, `keycloak`, `nginx-proxy`, `traffic-gen`,
  plus platform: Dynatrace agents/AG, OTel collectors, EBS CSI, CoreDNS, kube-proxy.

## k8s entity types & metric families

| Entities | `dt.entity.kubernetes_cluster`, `kubernetes_node`, `cloud_application` (workload), `cloud_application_instance` (pod), `cloud_application_namespace` |
|---|---|
| **Metrics** (25 families) | `dt.kubernetes.container.{cpu_usage,cpu_throttled,memory_working_set,limits_cpu,limits_memory,requests_cpu,requests_memory}`, `dt.kubernetes.pod.{network_*,containers_desired}`, `dt.kubernetes.{pods,workloads,nodes,events}`, `dt.kubernetes.workload.{conditions,pods_desired}`, `dt.kubernetes.node.{cpu_allocatable,memory_allocatable,pods_allocatable,conditions}`, `dt.kubernetes.persistentvolumeclaim.{available,capacity,used}` |

Container metrics carry deep dimensions: `k8s.namespace.name`, `k8s.workload.name`, `k8s.workload.kind`,
`k8s.pod.name`, `k8s.container.name`, `k8s.node.name`, `dt.entity.cloud_application*`, `dt.entity.kubernetes_node`.

## Working diagnostic queries

**Top workloads by CPU:**
```dql
timeseries cpu = avg(dt.kubernetes.container.cpu_usage), by: {k8s.namespace.name, k8s.workload.name}, from: now()-1h
| fieldsAdd cpu_avg = round(arrayAvg(cpu), 4)
| fields k8s.namespace.name, k8s.workload.name, cpu_avg
| sort cpu_avg desc | limit 10
```

**CPU throttling (perf problem signal):**
```dql
timeseries thr = avg(dt.kubernetes.container.cpu_throttled), by: {k8s.workload.name}, from: now()-1h
| fieldsAdd throttle = round(arrayAvg(thr), 4)
| filter throttle > 0
| sort throttle desc
```

**Memory vs limit (saturation):**
```dql
timeseries used = avg(dt.kubernetes.container.memory_working_set), lim = avg(dt.kubernetes.container.limits_memory),
           by: {k8s.workload.name}, from: now()-1h
| fieldsAdd used_mb = round(arrayAvg(used)/1048576, 1), lim_mb = round(arrayAvg(lim)/1048576, 1),
            pct_of_limit = round((arrayAvg(used) * 100.0) / arrayAvg(lim), 1)
| filter isNotNull(pct_of_limit)
| sort pct_of_limit desc
```

**Pods per namespace** — count series, NOT `avg` (the gauge is 1 per pod):
```dql
fetch metric.series, from: now()-30m
| filter metric.key == "dt.kubernetes.pods"
| summarize pods = count(), by: {k8s.namespace.name}
| sort pods desc
```

**Cluster events by reason/type** (find Warnings):
```dql
timeseries ev = sum(dt.kubernetes.events), by: {k8s.event.reason, k8s.event.type}, from: now()-3h
| fieldsAdd total = arraySum(ev)
| filter total > 0
| sort total desc
```
Event dimensions: `k8s.event.reason`, `k8s.event.type` (Normal/Warning), `k8s.event.involved_object.kind`.

**Workload conditions** (deployment health) — dims `workload_condition` (Available/Progressing),
`condition_reason`, `condition_status` (bool):
```dql
fetch metric.series, from: now()-1h
| filter metric.key == "dt.kubernetes.workload.conditions" and k8s.workload.name == "<wl>"
```

## Gotchas hit (trial-and-error log)

1. **Pod/container counts: use `count()` of series or `sum`, never `avg`** — `avg(dt.kubernetes.pods)`
   returns 1 (each pod-series carries value 1). Got "1 pod per namespace" until switched to counting series.
2. **`percentile(...)`/`median(...)` as timeseries aggregations return 0 rows on gauges** — build an
   `avg` series then reduce the array: `arrayPercentile(cpu, 95)`, `arrayMedian(cpu)`.
3. **Repeated 400s scoping a container metric to one workload were a TRANSIENT BACKEND OUTAGE, not a
   query bug.** Initially this looked like "filtering `dt.kubernetes.container.*` by `k8s.workload.name`
   is broken." A controlled retest disproved it: re-running a *previously rock-solid* query
   (`timeseries cpu = avg(dt.host.cpu.usage)`) **also** started returning 400, while `fetch metric.series`
   (12,219 series) and `data record(...)` kept working. **Conclusion: the `timeseries` / metric-data-point
   query path was temporarily erroring tenant-wide; metric *metadata* and non-metric DQL were unaffected.**
   Lesson for skill design: **when a query 400s, re-run a known-good query of the same kind before
   blaming the query shape** — isolate subsystem (timeseries vs fetch vs data) to tell a real bug from
   an outage. The opaque `400: request failed` message gives no hint, so this control test is essential.
4. (Was "multi-metric instability" — same root cause as #3: the timeseries path outage, not the query.)

## Diagnosis found

- 🔴 **`otelcollector-opentelemetry-collector` (ns `opentelemetry`) is failing.** Workload condition
  `Available = false`, reason `MinimumReplicasUnavailable`; **49 `Failed` Warning events in the last 30 min**
  (none before) — an active failure, likely crash-looping / unschedulable.
- 🟠 **`admin-api` (ns `apps`) is CPU-throttled** (~8.06, highest in cluster) at ~16.4 CPU usage — its
  CPU limit is too low.
- Top CPU consumers: `frontend` (~74), `api-gateway` (~50), Dynatrace agents.
- Memory: nothing critical (admin-api highest at 56.9% of its 512Mi limit).
- Other events: `Killing` (5, Normal — normal pod churn), `Workload spec change` (6), `Unhealthy` (1 Warning).
