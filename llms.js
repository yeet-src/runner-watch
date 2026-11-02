// runner-watch llms.txt: a plain-text, agent-readable snapshot of this
// runner. Mounted at /llms.txt as a per-connection console route like
// /metrics: each GET spawns this isolate, which samples the system
// graph, prints a markdown document to its console and exits, ending
// the chunked response.
//
// Like the exporter it only sees the graph, so step names, run ids and
// completed-job history (which the job hook feeds the agent) are not
// here; the document points agents at /tty for those.
//
//   curl http://<runner>:9420/llms.txt
//   curl http://<hub>:9430/r/<runner>/llms.txt

import { DOCKER_QUERY, HOST_QUERY, PROCS_QUERY, WORK_PATH, cpuBusyTotal, graphQuery, jobLeaves, runnerHome, runningContainers, scanRunners, stepLabel } from "./lib/runner.js";
import { assess, cpuParts, diagSample, leftoversNow, listenerNet, waitState } from "./lib/diag.js";

const args = yeet.args ?? {};
const NAME = args.name != null ? String(args.name) : null;
const CPU_SAMPLE_MS = Math.max(50, Number(args.sample) || 250);
const TOP_PROCS = 8;

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const gb = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GiB` : `${Math.round(b / 2 ** 20)} MiB`);
const dur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const out = [];
const say = (...l) => out.push(...l);
const finish = (code = 0) => { console.log(out.join("\n")); yeet.exit(code); };

const sampledAt = new Date().toISOString();
const first = await yeet.graph.query(`{ kernel_stats { total { user_ms nice_ms system_ms idle_ms iowait_ms irq_ms softirq_ms steal_ms } } }`);
await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
const { data, errors } = await graphQuery(`{ ${HOST_QUERY} ${PROCS_QUERY} ${DOCKER_QUERY} }`);
const fatal = errors?.find((e) => !/docker/i.test(e.message ?? "") && !(Array.isArray(data?.procs) && e.path?.[0] === "procs"));
if (fatal || !data) {
  say(`# ${NAME ?? "runner"}`, "", `> runner-watch could not read the system graph at ${sampledAt}: ${fatal?.message ?? "no data"}`);
  finish();
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
const ctrName = new Map(jobCtrs.map((c) => [c.id, c.name || c.id.slice(0, 12)]));
const kids = new Map();
for (const p of procs) kids.set(p.stat.ppid, [...(kids.get(p.stat.ppid) ?? []), p]);
const mem = data.meminfo;
const avail = mem.mem_available ?? mem.mem_free;
const busy = runners.filter((r) => r.worker);

const leavesOf = new Map(busy.map((r) => [r.listener.pid, jobLeaves(r.work, kids, ctrProcs).slice(0, 4)]));
let diag = null, diagError = null;
try { diag = await diagSample([...runners.flatMap((r) => [r.listener.pid, r.worker?.pid]).filter(Boolean), ...[...leavesOf.values()].flat().map((p) => p.pid)]); }
catch (e) { diagError = e?.message ?? String(e); }
const inTree = new Set(runners.flatMap((r) => r.work.map((p) => p.pid)));
const view = runners.map((r) => {
  const sockets = diag?.sockets(r.listener.pid);
  const leaves = leavesOf.get(r.listener.pid) ?? [];
  const wait = r.worker ? waitState({ leaves, activity: { cpu: leaves.some((p) => p.stat.state === "R") ? 1 : 0, io: 0 }, sockets: leaves.flatMap((p) => diag?.sockets(p.pid) ?? []) }) : null;
  return { pid: r.listener.pid, net: sockets ? { ...listenerNet(sockets), disconnectedMs: 0 } : null, fd: { open: r.listener.fd_count ?? null, limit: diag?.fdsize.get(r.listener.pid) ?? null }, job: r.worker ? { wait } : null };
});
const viewOf = new Map(view.map((v) => [v.pid, v]));
const leftovers = leftoversNow(scan, procs, inTree, WORK_PATH);
const hostView = {
  cpus: system.numCpus, cpu, cpuParts: parts, load: [data.load_average.one, data.load_average.five, data.load_average.fifteen],
  blocked: data.kernel_stats.procs_blocked ?? null, zombies: procs.filter((p) => p.stat.state === "Z").length,
  mem: { total: mem.mem_total, available: avail }, swap: { total: mem.swap_total, free: mem.swap_free }, dirty: mem.dirty ?? null, writeback: mem.writeback ?? null,
};
const health = assess({ host: hostView, runners: view, leftovers, ifaces: diag?.ifaces ?? [], temp: diag?.temp ?? null });

say(`# ${NAME ?? "runner"}`, "");
say(`> GitHub Actions self-hosted runner host${NAME ? ` "${NAME}"` : ""}, sampled at ${sampledAt} by runner-watch from the yeet system graph. ${runners.length} listener${runners.length === 1 ? "" : "s"}, ${busy.length} running a job, cpu ${pct(cpu)} busy, ${gb(mem.mem_total - avail)} of ${gb(mem.mem_total)} memory used.`, "");
say("Values are a single point-in-time sample. For a live stream with step names, run links and job history, read the /tty websocket described under Endpoints.", "");

say(`## Health: ${health.level}`, "");
if (!health.reasons.length) say("Nothing wrong that a single sample can see.");
for (const x of health.reasons) say(`- ${x.level}: ${x.text}`);
if (diagError) say(`- warn: diagnostic sample (sockets, interfaces, sensors) failed: ${diagError}`);
say("", "Health covers memory, swap, dirty pages, iowait, steal, load, zombies, temperature, the listener's connection to GitHub, file descriptors, leftover job containers or processes, and the default route and dns. A stalled or slow step needs the agent's history and shows on /tty only.", "");

say("## Host", "");
say(`- cpus: ${system.numCpus}`);
say(`- cpu busy (last ${CPU_SAMPLE_MS}ms): ${pct(cpu)}`);
say(`- load average: ${[data.load_average.one, data.load_average.five, data.load_average.fifteen].map((x) => x.toFixed(2)).join(" / ")} (1m / 5m / 15m)`);
say(`- memory: ${gb(mem.mem_total - avail)} used of ${gb(mem.mem_total)} (${pct((mem.mem_total - avail) / mem.mem_total)})`);
if (mem.swap_total) say(`- swap: ${gb(mem.swap_total - mem.swap_free)} used of ${gb(mem.swap_total)}`);
say(`- uptime: ${dur(data.host.uptime.uptime * 1000)}`);
say(`- processes: ${procs.length} (${data.kernel_stats.procs_running} running)`);
say(`- docker: ${data.docker ? `${containers.length} running container${containers.length === 1 ? "" : "s"}` : "not reachable"}`);
if (parts) say(`- cpu split: ${pct(parts.user)} user, ${pct(parts.system)} system, ${pct(parts.iowait)} iowait, ${pct(parts.steal)} steal`);
say(`- pressure: ${hostView.blocked ?? 0} processes blocked on io, ${hostView.zombies} zombies, ${gb((mem.dirty ?? 0) + (mem.writeback ?? 0))} dirty pages`);
if (diag?.temp) say(`- hottest sensor: ${diag.temp.name} at ${Math.round(diag.temp.c)}°C${diag.temp.limit ? ` (limit ${Math.round(diag.temp.limit)}°C)` : ""}`);
say("");

say("## Network", "");
if (!diag) say("Not sampled.", "");
else {
  for (const i of diag.ifaces) say(`- ${i.name}: ${i.up ? "up" : "DOWN"}${i.default ? ", default route" : ""}${i.tun ? ", tunnel" : ""}${i.ipv4.length ? `, ${i.ipv4.join(" ")}` : ""}${i.dns.length ? `, dns ${i.dns.join(" ")}` : ""}${i.drops ? `, ${i.drops} drops` : ""}${i.errs ? `, ${i.errs} errors` : ""}`);
  say("", "Active probes (resolving github.com, connecting out) are not possible from inside the agent; the listener's own socket under each runner below is the reachability signal.", "");
}

say("## Runners", "");
if (!runners.length) say("No Runner.Listener process was found on this host; the runner service is down or not installed.", "");
for (const { listener, worker, work, repo } of runners) {
  const state = worker ? "busy" : "idle";
  say(`### listener pid ${listener.pid}: ${state}`, "");
  say(`- home: ${runnerHome(listener) ?? "unknown"}`);
  say(`- listener up: ${dur(now - startOf(listener))}`);
  const v = viewOf.get(listener.pid);
  if (v?.net) say(`- github connection: ${v.net.connected ? `${v.net.established} established${v.net.github ? " to a GitHub range" : ""}: ${v.net.remotes.join(", ")}` : `NONE${v.net.connecting ? ` (${v.net.connecting} connect pending)` : ""}: the listener is not long-polling GitHub and will not receive jobs`}`);
  if (v?.fd.open != null) say(`- file descriptors: ${v.fd.open}${v.fd.limit ? ` of ${v.fd.limit}` : ""}, threads ${listener.stat.num_threads ?? "?"}`);
  if (!worker) { say("- job: none, waiting for work", ""); continue; }
  const rss = work.reduce((s, p) => s + p.stat.rss_bytes, 0);
  const cpuSec = work.reduce((s, p) => s + (p.stat.utime + p.stat.stime) / hz, 0);
  say(`- job: ${repo ? `repository ${repo}` : "repository unknown (not derivable from process paths)"}`);
  say(`- job started: ${new Date(startOf(worker)).toISOString()} (elapsed ${dur(now - startOf(worker))})`);
  say(`- job processes: ${work.length}, resident memory ${gb(rss)}, cpu time consumed ${cpuSec.toFixed(1)}s`);
  const live = (kids.get(worker.pid) ?? []).sort((x, y) => x.stat.starttime - y.stat.starttime);
  if (live.length) {
    const st = live[live.length - 1];
    const label = stepLabel(st);
    say(`- current step (inferred from the worker's child process): ${label.label} [${label.kind}], running ${dur(now - startOf(st))}`);
  } else say("- current step: none visible (between steps, or worker setting up)");
  const w = viewOf.get(listener.pid)?.job?.wait;
  if (w) say(`- waiting on: ${w.kind}: ${w.detail}`);
  const states = work.reduce((m, p) => m.set(p.stat.state, (m.get(p.stat.state) ?? 0) + 1), new Map());
  say(`- process states: ${[...states].map(([k, n]) => `${n} ${{ R: "running", S: "sleeping", D: "disk wait", Z: "zombie", T: "stopped", I: "idle" }[k] ?? k}`).join(", ")}`);
  if (jobCtrs.length) {
    say(`- containers mounting the work tree:`);
    for (const c of jobCtrs) say(`  - ${c.name || c.id.slice(0, 12)} (${c.image}), ${[...ctrProcs.values()].filter((id) => id === c.id).length} processes`);
  }
  const top = work
    .map((p) => ({ pid: p.pid, comm: p.stat.comm, cpuSec: (p.stat.utime + p.stat.stime) / hz, rss: p.stat.rss_bytes, container: ctrName.get(ctrProcs.get(p.pid)) ?? null, cmd: (p.cmdline ?? []).join(" ") }))
    .sort((x, y) => y.cpuSec - x.cpuSec || y.rss - x.rss)
    .slice(0, TOP_PROCS);
  say(`- top job processes by cpu time (of ${work.length}):`);
  for (const p of top) say(`  - pid ${p.pid} ${p.comm}: ${p.cpuSec.toFixed(1)}s cpu, ${gb(p.rss)}${p.container ? `, in container ${p.container}` : ""}${p.cmd ? `: ${p.cmd.slice(0, 160)}` : ""}`);
  say("");
}
if (leftovers) {
  say("### leftovers from a finished job", "");
  for (const c of leftovers.containers) say(`- container ${c.name || c.id} (${c.image}) still running`);
  for (const p of leftovers.procs) say(`- pid ${p.pid} ${p.comm} still running in ${p.cwd ?? "the work tree"}`);
  say("");
}

if (data.docker) {
  say("## Containers", "");
  if (!containers.length) say("None running.", "");
  const jobIds = new Set(jobCtrs.map((c) => c.id));
  for (const c of containers) {
    const n = [...ctrProcs.values()].filter((id) => id === c.id).length;
    say(`- ${c.name || c.id.slice(0, 12)} (${c.image}): ${jobIds.has(c.id) ? `job container, ${n} processes` : "not attributed to a job"}${c.mounts.length ? `; mounts ${c.mounts.slice(0, 6).map((m) => `${m.source}→${m.destination}`).join(", ")}` : "; no bind mounts"}`);
  }
  say("", "A container is attributed to the job when it mounts the runner's _work tree or a docker exec in the worker's tree names it; its processes are found by cgroup.", "");
}

say("## Endpoints", "");
say("All paths are relative to this agent's web server (port 9420 by default), or to /r/<runner>/ on the hub.", "");
say("- /llms.txt: this document. One sample per request; the body ends when the sample is written.");
say("- /metrics: the same sample as Prometheus exposition, metric names prefixed runner_watch_.");
say("- /tty: websocket. Every second the agent emits one OSC 7880 frame, ESC ] 7880 ; <json> BEL, where <json> is {t:\"tick\", ts, name, host, runners[], stats, history[]}. runners[].job carries repo, elapsedMs, step, steps[] with per-step durationMs and result, meta with repoUrl/runUrl/commitUrl when the job hook is installed, containers[] and top[]. history[] holds recent completed jobs with their step timings.");
say("- /.well-known/yeet/manifest.json: the route manifest for this web server.");
say("");
say("## About", "");
say("runner-watch is a yeet service: agent.js streams the live state, metrics.js and llms.js are spawned per request. Source: https://github.com/yeet-src/runner-watch");
finish();
