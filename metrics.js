// runner-watch metrics exporter: one Prometheus scrape per run. Mounted
// at /metrics as a per-connection console route, so each GET spawns
// this isolate, which samples the system graph, prints the exposition
// text to its console and exits, ending the response body.
//
// Everything here comes from the graph, so it works without the job
// hook. What the hook feeds the agent (run ids, step names, completed
// job counts) lives in the agent's memory and is not exported.
//
//   curl http://<runner>:9420/metrics
//   curl http://<hub>:9430/r/<runner>/metrics

import { DOCKER_QUERY, HOST_QUERY, PROCS_QUERY, WORK_PATH, childrenIndex, cpuBusyTotal, graphQuery, jobLeaves, runningContainers, scanRunners } from "./lib/runner.js";
import { assess, cpuParts, diagSample, leftoversNow, listenerNet, waitState } from "./lib/diag.js";

const args = yeet.args ?? {};
const NAME = String(args.name ?? "runner");
const CPU_SAMPLE_MS = Math.max(50, Number(args.sample) || 250);

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (extra = {}) => {
  const all = { runner: NAME, ...extra };
  return `{${Object.entries(all).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;
};
const lines = [];
const metric = (name, type, help, samples) => {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [extra, value] of samples) if (value != null && Number.isFinite(value)) lines.push(`${name}${labels(extra)} ${value}`);
};

const t0 = Date.now();
const first = await yeet.graph.query(`{ kernel_stats { total { user_ms nice_ms system_ms idle_ms iowait_ms irq_ms softirq_ms steal_ms } } }`);
await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
const { data, errors } = await graphQuery(`{ ${HOST_QUERY} ${PROCS_QUERY} ${DOCKER_QUERY} }`);
const fatal = errors?.find((e) => !/docker/i.test(e.message ?? "") && !(Array.isArray(data?.procs) && e.path?.[0] === "procs"));
if (fatal || !data) {
  metric("runner_watch_up", "gauge", "1 when the exporter could read the system graph.", [[{}, 0]]);
  console.log(lines.join("\n"));
  console.error(`metrics: ${fatal?.message ?? "Graph returned no data"}`);
  yeet.exit(0);
}

const a = cpuBusyTotal(first.data.kernel_stats.total), b = cpuBusyTotal(data.kernel_stats.total);
const cpu = b.total > a.total ? (b.busy - a.busy) / (b.total - a.total) : null;
const parts = cpuParts(first.data.kernel_stats.total, data.kernel_stats.total);
const hz = data.host.ticks_per_second || 100;
const btime = data.kernel_stats.btime;
const procs = data.procs.filter((p) => p && p.stat);
const containers = runningContainers(data.docker?.list_containers);
const scan = scanRunners(procs, containers);
const { runners, jobCtrs, ctrProcs } = scan;
const now = Date.now();
const startOf = (p) => (btime + p.stat.starttime / hz) * 1000;
const mem = data.meminfo;
const kids = childrenIndex(procs);

// Diagnosis: sockets of the listeners and the step leaves, interfaces,
// sensors. Cpu and io activity need a second sample, so a step whose
// leaf is plainly computing is still reported by its process state.
const leavesOf = new Map(runners.filter((r) => r.worker).map((r) => [r.listener.pid, jobLeaves(r.work, kids, ctrProcs).slice(0, 4)]));
let diag = null, diagError = null;
try { diag = await diagSample([...runners.flatMap((r) => [r.listener.pid, r.worker?.pid]).filter(Boolean), ...[...leavesOf.values()].flat().map((p) => p.pid)]); }
catch (e) { diagError = e?.message ?? String(e); }
const inTree = new Set(runners.flatMap((r) => r.work.map((p) => p.pid)));
const view = runners.map((r) => {
  const sockets = diag?.sockets(r.listener.pid);
  const leaves = leavesOf.get(r.listener.pid) ?? [];
  const active = leaves.some((p) => p.stat.state === "R");
  const wait = r.worker ? waitState({ leaves, activity: { cpu: active ? 1 : 0, io: 0 }, sockets: leaves.flatMap((p) => diag?.sockets(p.pid) ?? []) }) : null;
  return { pid: r.listener.pid, repo: r.repo ?? "", net: sockets ? { ...listenerNet(sockets), disconnectedMs: 0 } : null, fd: { open: r.listener.fd_count ?? null, limit: diag?.fdsize.get(r.listener.pid) ?? null }, job: r.worker ? { wait } : null };
});
const leftovers = leftoversNow(scan, procs, inTree, WORK_PATH);
const hostView = {
  cpus: system.numCpus, cpu, cpuParts: parts, load: [data.load_average.one, data.load_average.five, data.load_average.fifteen],
  blocked: data.kernel_stats.procs_blocked ?? null, zombies: procs.filter((p) => p.stat.state === "Z").length,
  mem: { total: mem.mem_total, available: mem.mem_available ?? mem.mem_free }, swap: { total: mem.swap_total, free: mem.swap_free },
  dirty: mem.dirty ?? null, writeback: mem.writeback ?? null,
};
const health = assess({ host: hostView, runners: view, leftovers, ifaces: diag?.ifaces ?? [], temp: diag?.temp ?? null });

metric("runner_watch_up", "gauge", "1 when the exporter could read the system graph.", [[{}, 1]]);
metric("runner_watch_host_cpus", "gauge", "Logical cpus on the host.", [[{}, system.numCpus]]);
metric("runner_watch_host_cpu_ratio", "gauge", `Share of cpu time busy over the last ${CPU_SAMPLE_MS}ms, 0 to 1.`, [[{}, cpu]]);
metric("runner_watch_host_memory_bytes", "gauge", "Host memory by kind.", [
  [{ kind: "total" }, mem.mem_total], [{ kind: "available" }, mem.mem_available ?? mem.mem_free],
  [{ kind: "swap_total" }, mem.swap_total], [{ kind: "swap_free" }, mem.swap_free],
]);
metric("runner_watch_host_load", "gauge", "Load average.", [
  [{ period: "1m" }, data.load_average.one], [{ period: "5m" }, data.load_average.five], [{ period: "15m" }, data.load_average.fifteen],
]);
metric("runner_watch_host_uptime_seconds", "gauge", "Host uptime.", [[{}, data.host.uptime.uptime]]);
metric("runner_watch_host_processes", "gauge", "Processes on the host.", [[{}, procs.length]]);
metric("runner_watch_docker_containers", "gauge", "Running docker containers; absent when docker is not reachable.", data.docker ? [[{}, containers.length]] : []);
metric("runner_watch_listeners", "gauge", "Runner.Listener processes found.", [[{}, runners.length]]);
metric("runner_watch_listeners_busy", "gauge", "Listeners with a Runner.Worker child, i.e. running a job.", [[{}, runners.filter((r) => r.worker).length]]);
metric("runner_watch_listener_uptime_seconds", "gauge", "Seconds since each listener started.", runners.map((r) => [{ pid: r.listener.pid }, (now - startOf(r.listener)) / 1000]));
metric("runner_watch_job_running", "gauge", "1 per listener that is running a job.", runners.map((r) => [{ pid: r.listener.pid, repo: r.repo ?? "" }, r.worker ? 1 : 0]));
const busy = runners.filter((r) => r.worker);
metric("runner_watch_job_elapsed_seconds", "gauge", "Seconds the current job has been running.", busy.map((r) => [{ pid: r.listener.pid, repo: r.repo ?? "" }, (now - startOf(r.worker)) / 1000]));
metric("runner_watch_job_processes", "gauge", "Processes belonging to the current job, containers included.", busy.map((r) => [{ pid: r.listener.pid, repo: r.repo ?? "" }, r.work.length]));
metric("runner_watch_job_rss_bytes", "gauge", "Resident memory of the current job's processes.", busy.map((r) => [{ pid: r.listener.pid, repo: r.repo ?? "" }, r.work.reduce((s, p) => s + p.stat.rss_bytes, 0)]));
metric("runner_watch_job_cpu_seconds_total", "counter", "Cpu time consumed so far by the current job's live processes.", busy.map((r) => [{ pid: r.listener.pid, repo: r.repo ?? "" }, r.work.reduce((s, p) => s + (p.stat.utime + p.stat.stime) / hz, 0)]));
metric("runner_watch_job_containers", "gauge", "Containers mounting the runner's work tree.", [[{}, jobCtrs.length]]);
metric("runner_watch_health_level", "gauge", "0 ok, 1 warnings, 2 critical, as the agent's own assessment would say.", [[{}, { ok: 0, warn: 1, critical: 2 }[health.level]]]);
metric("runner_watch_health_reason", "gauge", "1 per active health reason; text carries the explanation.", health.reasons.map((x) => [{ code: x.code, level: x.level, text: x.text }, 1]));
metric("runner_watch_host_cpu_split_ratio", "gauge", "Share of cpu time by kind over the sample.", parts ? Object.entries(parts).map(([k, v]) => [{ kind: k }, v]) : []);
metric("runner_watch_host_procs_blocked", "gauge", "Processes blocked on io.", [[{}, hostView.blocked]]);
metric("runner_watch_host_zombies", "gauge", "Zombie processes.", [[{}, hostView.zombies]]);
metric("runner_watch_host_dirty_bytes", "gauge", "Dirty plus writeback pages waiting for disk.", [[{}, (mem.dirty ?? 0) + (mem.writeback ?? 0)]]);
metric("runner_watch_host_temperature_celsius", "gauge", "Hottest sensor.", diag?.temp ? [[{ sensor: diag.temp.name }, diag.temp.c]] : []);
metric("runner_watch_iface_up", "gauge", "1 when the interface is up and running; default=\"1\" marks the default route.", (diag?.ifaces ?? []).map((i) => [{ iface: i.name, default: i.default ? "1" : "0" }, i.up ? 1 : 0]));
metric("runner_watch_iface_drops_total", "counter", "Dropped packets, both directions.", (diag?.ifaces ?? []).filter((i) => i.drops != null).map((i) => [{ iface: i.name }, i.drops]));
metric("runner_watch_iface_errors_total", "counter", "Interface errors, both directions.", (diag?.ifaces ?? []).filter((i) => i.errs != null).map((i) => [{ iface: i.name }, i.errs]));
metric("runner_watch_listener_connected", "gauge", "1 when the listener holds an established public tcp connection; github=\"1\" when it is to a GitHub range.", view.filter((v) => v.net).map((v) => [{ pid: v.pid, github: v.net.github ? "1" : "0" }, v.net.connected ? 1 : 0]));
metric("runner_watch_listener_fds", "gauge", "Open file descriptors of the listener.", view.filter((v) => v.fd.open != null).map((v) => [{ pid: v.pid }, v.fd.open]));
metric("runner_watch_listener_fd_limit", "gauge", "File descriptor limit of the listener.", view.filter((v) => v.fd.limit != null).map((v) => [{ pid: v.pid }, v.fd.limit]));
metric("runner_watch_job_wait", "gauge", "1 for what the current step is waiting on: running, disk, network, connecting, sleeping, setup, zombie or stopped.", view.filter((v) => v.job?.wait).map((v) => [{ pid: v.pid, repo: v.repo, kind: v.job.wait.kind }, 1]));
metric("runner_watch_leftover_containers", "gauge", "Job containers still running with no job.", [[{}, leftovers?.containers.length ?? 0]]);
metric("runner_watch_leftover_processes", "gauge", "Work-tree processes still running with no job.", [[{}, leftovers?.procs.length ?? 0]]);
metric("runner_watch_diag_up", "gauge", "1 when the diagnostic sample (sockets, interfaces, sensors) succeeded.", [[{}, diag ? 1 : 0]]);
if (diagError) console.error(`metrics: diag ${diagError}`);
metric("runner_watch_scrape_duration_seconds", "gauge", "Time this scrape took inside the exporter.", [[{}, (Date.now() - t0) / 1000]]);

console.log(lines.join("\n"));
yeet.exit(0);
