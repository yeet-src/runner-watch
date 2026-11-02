// runner-watch agent — what this GitHub Actions runner is doing, right
// now. Runs on each runner host as a yeet service. Every tick it reads
// the daemon's system graph (processes, cpu, memory, load, docker),
// finds the runner's Listener/Worker processes, works out whether a
// job is running and what it is touching, and emits one JSON frame
// down its tty portal. The hub dashboard dials that portal through a
// proxy route on the hub's web server.
//
//   yeet run -p tty:ws://127.0.0.1:3001 ./agent.js -- --name local   dev
//   yeet run ./agent.js -- --plain                                    text per tick
//
// Flags (after --):  --name=<runner>   name shown on the dashboard
//                    --interval=1000   tick cadence in ms
//                    --history=50      completed jobs to remember
//                    --diag=5000       slow sample cadence (sockets, interfaces, sensors)
//                    --plain           print a text summary instead of frames
//
// hooks/job-hook.sh, wired into the runner's .env, writes the job's
// GitHub identity and each step's real name into this isolate's tty.

import { encodeFrame } from "./portal.js";
import { DOCKER_QUERY, HOST_QUERY, MAX_STEPS, PROCS_QUERY, WORK_PATH, childrenIndex, cpuBusyTotal, graphQuery, jobLeaves, metaView, runnerHome, runningContainers, scanRunners, stepsView, trackSteps } from "./lib/runner.js";
import { DIAG_HOST_QUERY, TCP_QUERY, assess, cpuParts, fdsOf, hottest, ifaceView, listenerNet, socketsOf, tcpIndex, waitState } from "./lib/diag.js";

const args = yeet.args ?? {};
// The name is what /metrics and /llms.txt call this host. Without
// `--name` it is learned from the first job hook message, whose
// `runner` is the RUNNER_NAME GitHub registered.
let NAME = args.name != null ? String(args.name) : null;
const INTERVAL_MS = Math.max(250, Number(args.interval) || 1000);
const HISTORY = Math.max(1, Number(args.history) || 50);
const PLAIN = Boolean(args.plain);
const TOP_PROCS = 8;
const DIAG_MS = Math.max(INTERVAL_MS, Number(args.diag) || 5000);
const DIAG_PIDS = 16;
const TYPICAL_SAMPLES = 30;

const QUERY = `{ ${HOST_QUERY} ${PROCS_QUERY} ${DOCKER_QUERY} }`;

// ---------------------------------------------------------------------------
// Messages from the job hook (hooks/job-hook.sh) arrive on the tty as
// JSON lines: the job's identity at start and end, and each step's name
// and result relayed from the worker's log. A message names its job by
// `key`; it lands on the worker carrying that key, or on the busiest
// unclaimed worker when the hook fires before the tick that sees it.

const pendingMeta = [];      // job messages waiting for a worker
const pendingMsgs = [];      // step messages that arrived before their worker was seen
const PENDING_MS = 30_000;
let line = "";

function jobEntryFor(key) {
  for (const entry of workers.values()) if (entry.meta?.key === key) return entry;
  return null;
}

function unclaimedWorker() {
  return [...workers.values()].filter((e) => !e.meta).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

function onMessage(msg) {
  if (msg.t === "job") {
    if (args.name == null && msg.runner) NAME = String(msg.runner);
    if (msg.phase === "completed") { const e = jobEntryFor(msg.key); if (e) e.completedAt = msg.ts; return; }
    const entry = unclaimedWorker();
    if (entry) entry.meta = msg; else pendingMeta.push(msg);
    return;
  }
  const entry = jobEntryFor(msg.key) ?? unclaimedWorker() ?? [...workers.values()].pop();
  if (!entry) { if (pendingMsgs.length < 1000) pendingMsgs.push(msg); return; }
  if (msg.t === "step") {
    const last = entry.named[entry.named.length - 1];
    if (last && last.endedAt == null) last.endedAt = msg.ts;
    if (entry.named.length < MAX_STEPS) entry.named.push({ n: entry.named.length + 1, label: msg.name, kind: "named", startedAt: msg.ts, endedAt: null, result: null });
  } else if (msg.t === "stepResult") {
    const last = entry.named[entry.named.length - 1];
    if (last) { last.result = msg.result; last.endedAt ??= msg.ts; }
  }
}

if (typeof tty !== "undefined") tty.on("keydown", (e) => {
  if (e.code === "Enter") {
    const text = line.trim(); line = "";
    if (!text.startsWith("{")) return;
    try { onMessage(JSON.parse(text)); } catch (err) { console.error(`hook message: ${err?.message ?? err}`); }
    return;
  }
  if (e.key != null && !e.ctrlKey && !e.altKey) line += e.key;
  if (line.length > 65536) line = "";
});

// ---------------------------------------------------------------------------
// Sampling: cpu is a delta over the previous tick, per host and per process.

let prevCpu = null;                 // { busy, total }
let prevTotal = null;               // raw kernel cpu totals, for the iowait/steal split
const prevProc = new Map();         // pid -> { ticks, starttime, rbytes, wbytes }
const ioOf = new Map();             // pid -> bytes/s over the last tick
const typical = new Map();          // "repo|step label" -> recent durations (ms)
let leftoverSince = null;
const workers = new Map();          // worker pid -> { startedAt, repo, listener }
const history = [];                 // completed jobs, newest first
const netState = new Map();         // listener pid -> { disconnectedSince }
let jobsCompleted = 0;
let busyMs = 0;
let lastTickAt = Date.now();
const startedAt = Date.now();
let lastError = null;

function hostCpu(total) {
  const cur = cpuBusyTotal(total);
  const last = prevCpu;
  prevCpu = cur;
  if (!last || cur.total <= last.total) return null;
  return (cur.busy - last.busy) / (cur.total - last.total);
}

// Children's cpu lands on the parent when they are reaped, so a shell
// looping over short-lived commands is charged for them.
function procCpu(p, dtMs, hz, seen) {
  const ticks = p.stat.utime + p.stat.stime + (p.stat.cutime ?? 0) + (p.stat.cstime ?? 0);
  const rbytes = p.io?.read_bytes ?? 0, wbytes = p.io?.write_bytes ?? 0;
  const last = prevProc.get(p.pid);
  seen.set(p.pid, { ticks, starttime: p.stat.starttime, rbytes, wbytes });
  if (!last || last.starttime !== p.stat.starttime || dtMs <= 0) { ioOf.set(p.pid, 0); return 0; }
  ioOf.set(p.pid, Math.max(0, (rbytes - last.rbytes + wbytes - last.wbytes) / (dtMs / 1000)));
  const cpuMs = ((ticks - last.ticks) / hz) * 1000;
  return Math.max(0, cpuMs / dtMs);
}

// ---------------------------------------------------------------------------
// The slow sample: tcp tables, the fds of the few processes we care
// about (listeners, workers, the current step's leaves), interfaces and
// sensors. A few hundred ms on a loaded box, so every DIAG_MS, not
// every tick, and only when a listener exists.

const diag = { at: 0, tcp: new Map(), fds: new Map(), fdsize: new Map(), host: null, ifaces: [], temp: null, ifaceStats: null, error: null };
let diagBusy = false;
async function sampleDiag(pids, now) {
  if (diagBusy || now - diag.at < DIAG_MS) return;
  diagBusy = true;
  try {
    const [{ data, errors }, { fds, fdsize }] = await Promise.all([graphQuery(`{ ${TCP_QUERY} ${DIAG_HOST_QUERY} }`), fdsOf(pids, DIAG_PIDS)]);
    if (!data) throw new Error(errors?.[0]?.message ?? "no data");
    diag.tcp = tcpIndex(data);
    diag.fds = fds; diag.fdsize = fdsize;
    const view = ifaceView(data, diag.ifaceStats, diag.at ? now - diag.at : 0);
    diag.ifaces = view.ifaces; diag.ifaceStats = view.stats;
    diag.temp = hottest(data.hwmons);
    diag.error = null;
  } catch (e) {
    diag.error = e?.message ?? String(e);
  } finally {
    diag.at = now;
    diagBusy = false;
  }
}
const socketsFor = (pid) => (diag.fds.has(pid) ? socketsOf(diag.fds.get(pid), diag.tcp) : null);

function typicalFor(repo, label) {
  const arr = typical.get(`${repo ?? "?"}|${label}`);
  if (!arr || arr.length < 3) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function learn(repo, steps) {
  for (const st of steps) {
    if (st.kind !== "named" || !st.done || !st.result || /skip/i.test(st.result)) continue;
    const key = `${repo ?? "?"}|${st.label}`;
    const arr = typical.get(key) ?? [];
    arr.push(st.durationMs);
    if (arr.length > TYPICAL_SAMPLES) arr.shift();
    typical.set(key, arr);
  }
}

function summarize(data, now) {
  const hz = data.host.ticks_per_second || 100;
  const btime = data.kernel_stats.btime;
  const procs = data.procs.filter((p) => p && p.stat);
  const kids = childrenIndex(procs);
  const dtMs = now - lastTickAt;
  const seen = new Map();
  const cpuOf = new Map();
  for (const p of procs) cpuOf.set(p.pid, procCpu(p, dtMs, hz, seen));
  prevProc.clear();
  for (const [k, v] of seen) prevProc.set(k, v);
  for (const pid of [...ioOf.keys()]) if (!seen.has(pid)) ioOf.delete(pid);

  const startOf = (p) => (btime + p.stat.starttime / hz) * 1000;
  const liveWorkers = new Set();
  const runners = [];
  const diagPids = [];

  const docker = data.docker?.list_containers ?? null;
  const containers = runningContainers(docker);
  const scan = scanRunners(procs, containers);
  const ctrName = new Map(scan.jobCtrs.map((c) => [c.id, c.name || c.id.slice(0, 12)]));
  const inTree = new Set();

  for (const { listener, worker, work, repo } of scan.runners) {
    let job = null;
    diagPids.push(listener.pid);
    for (const p of work) inTree.add(p.pid);
    if (worker) {
      liveWorkers.add(worker.pid);
      diagPids.push(worker.pid);
      const entry = workers.get(worker.pid) ?? { startedAt: startOf(worker), repo: null, listener: listener.pid, steps: [], named: [], meta: null, completedAt: null, activeAt: now, wait: null, waitSince: now };
      if (repo) entry.repo = repo;
      if (!entry.meta && pendingMeta.length) entry.meta = pendingMeta.shift();
      if (entry.meta?.repo) entry.repo = entry.meta.repo;
      workers.set(worker.pid, entry);
      trackSteps(entry, worker, kids, startOf, now);
      const steps = stepsView(entry, now);
      const current = steps.filter((st) => !st.done).pop() ?? null;
      if (current) {
        current.typicalMs = typicalFor(entry.repo, current.label);
        current.slow = current.typicalMs != null && current.durationMs > Math.max(2 * current.typicalMs, current.typicalMs + 30_000);
      }
      const cpu = work.reduce((s, p) => s + (cpuOf.get(p.pid) ?? 0), 0);
      const io = work.reduce((s, p) => s + (ioOf.get(p.pid) ?? 0), 0);
      if (cpu >= 0.05 || io >= 1 << 20) entry.activeAt = now;
      const leaves = jobLeaves(work, kids, scan.ctrProcs, cpuOf);
      for (const p of leaves.slice(0, 4)) diagPids.push(p.pid);
      const sockets = leaves.slice(0, 4).flatMap((p) => socketsFor(p.pid) ?? []);
      const wait = waitState({ leaves, activity: { cpu, io }, sockets });
      if (entry.wait?.kind !== wait.kind) entry.waitSince = now;
      entry.wait = wait;
      const top = work
        .map((p) => ({
          pid: p.pid, comm: p.stat.comm, state: p.stat.state, cpu: cpuOf.get(p.pid) ?? 0, io: ioOf.get(p.pid) ?? 0, rss: p.stat.rss_bytes, cwd: p.cwd ?? null,
          container: ctrName.get(scan.ctrProcs.get(p.pid)) ?? null,
        }))
        .sort((a, b) => b.cpu - a.cpu || b.io - a.io || b.rss - a.rss)
        .slice(0, TOP_PROCS);
      job = {
        id: worker.pid, repo: entry.repo, startedAt: entry.startedAt,
        elapsedMs: now - entry.startedAt, procs: work.length, cpu, io,
        rss: work.reduce((s, p) => s + p.stat.rss_bytes, 0),
        threads: work.reduce((s, p) => s + (p.stat.num_threads ?? 0), 0),
        containers: scan.jobCtrs.map((c) => ({ id: c.id.slice(0, 12), name: c.name, image: c.image, procs: [...scan.ctrProcs.values()].filter((id) => id === c.id).length })),
        step: current, steps, meta: metaView(entry.meta),
        wait: { ...wait, sinceMs: now - entry.waitSince, idleMs: now - entry.activeAt, leaf: leaves[0] ? { pid: leaves[0].pid, comm: leaves[0].stat.comm, state: leaves[0].stat.state } : null },
        top,
      };
    }
    const lsock = socketsFor(listener.pid);
    const net = lsock ? listenerNet(lsock) : null;
    const prevNet = netState.get(listener.pid) ?? { disconnectedSince: null };
    if (net) prevNet.disconnectedSince = net.connected ? null : (prevNet.disconnectedSince ?? now);
    netState.set(listener.pid, prevNet);
    runners.push({
      pid: listener.pid, home: runnerHome(listener), startedAt: startOf(listener),
      state: worker ? "busy" : "idle", job,
      net: net ? { ...net, disconnectedMs: prevNet.disconnectedSince ? now - prevNet.disconnectedSince : 0 } : null,
      fd: { open: listener.fd_count ?? null, limit: diag.fdsize.get(listener.pid) ?? null },
      threads: listener.stat.num_threads ?? null,
    });
  }
  for (const pid of [...netState.keys()]) if (!scan.runners.some((r) => r.listener.pid === pid)) netState.delete(pid);

  if (pendingMsgs.length && workers.size) {
    const replay = pendingMsgs.splice(0);
    for (const msg of replay) if (now - msg.ts < PENDING_MS) onMessage(msg);
  }

  for (const [pid, entry] of workers) {
    if (liveWorkers.has(pid)) continue;
    workers.delete(pid);
    jobsCompleted += 1;
    const endedAt = entry.completedAt ?? now;
    for (const st of [...entry.steps, ...entry.named]) if (st.endedAt == null) st.endedAt = endedAt;
    const steps = stepsView(entry, endedAt);
    learn(entry.repo, steps);
    history.unshift({ id: pid, repo: entry.repo, startedAt: entry.startedAt, endedAt, durationMs: endedAt - entry.startedAt, steps, meta: metaView(entry.meta) });
    if (history.length > HISTORY) history.length = HISTORY;
  }
  if (liveWorkers.size) busyMs += dtMs;
  lastTickAt = now;

  // Leftovers: job containers and work-tree processes that outlived
  // their job. Only meaningful once no worker is running; a grace
  // period covers the runner's own cleanup.
  let leftovers = null;
  if (scan.runners.length && !liveWorkers.size) {
    const orphans = procs.filter((p) => !inTree.has(p.pid) && !scan.runners.some((r) => r.listener.pid === p.pid) && (WORK_PATH.test(p.cwd ?? "") || scan.ctrProcs.has(p.pid)));
    const ctrs = scan.jobCtrs.map((c) => ({ id: c.id.slice(0, 12), name: c.name, image: c.image }));
    if (orphans.length || ctrs.length) {
      leftoverSince ??= now;
      if (now - leftoverSince > 30_000) leftovers = { sinceMs: now - leftoverSince, containers: ctrs, procs: orphans.slice(0, 10).map((p) => ({ pid: p.pid, comm: p.stat.comm, cwd: p.cwd ?? null, ageMs: now - startOf(p) })) };
    } else leftoverSince = null;
  } else leftoverSince = null;

  sampleDiag(diagPids, now);

  const mem = data.meminfo;
  const parts = cpuParts(prevTotal, data.kernel_stats.total);
  prevTotal = data.kernel_stats.total;
  const host = {
    cpus: system.numCpus, cpu: hostCpu(data.kernel_stats.total), cpuParts: parts,
    load: [data.load_average.one, data.load_average.five, data.load_average.fifteen],
    uptime: data.host.uptime.uptime, procs: procs.length, running: data.kernel_stats.procs_running ?? null, blocked: data.kernel_stats.procs_blocked ?? null,
    zombies: procs.filter((p) => p.stat.state === "Z").length,
    mem: { total: mem.mem_total, available: mem.mem_available ?? mem.mem_free },
    swap: { total: mem.swap_total, free: mem.swap_free },
    dirty: mem.dirty ?? null, writeback: mem.writeback ?? null,
    ifaces: diag.ifaces, temp: diag.temp,
  };
  const health = assess({ host, runners, leftovers, ifaces: diag.ifaces, temp: diag.temp });
  return {
    t: "tick", ts: now, name: NAME, interval: INTERVAL_MS, agentStartedAt: startedAt,
    error: lastError, diagError: diag.error, diagAt: diag.at || null,
    host, runners, health, leftovers,
    stats: { jobsCompleted, busyMs, upMs: now - startedAt },
    history,
    docker: docker ? containers.map((c) => ({ id: c.id.slice(0, 12), name: c.name, image: c.image })) : null,
  };
}

// ---------------------------------------------------------------------------
// Output

const pct = (x) => (x == null ? " n/a" : `${Math.round(x * 100)}%`.padStart(4));
const gb = (b) => `${(b / 2 ** 30).toFixed(1)}G`;
const dur = (ms) => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

function printPlain(f) {
  const h = f.host;
  const lines = [
    `${f.name}  ${new Date(f.ts).toISOString()}  cpu ${pct(h.cpu)}  mem ${gb(h.mem.total - h.mem.available)}/${gb(h.mem.total)}  load ${h.load.map((x) => x.toFixed(2)).join(" ")}  jobs done ${f.stats.jobsCompleted}`,
  ];
  if (f.health.reasons.length) lines.push(`  health ${f.health.level}: ${f.health.reasons.map((x) => x.text).join("; ")}`);
  if (!f.runners.length) lines.push("  (no Runner.Listener process found)");
  for (const r of f.runners) {
    const net = r.net ? (r.net.connected ? `github ${r.net.github ? "ok" : "via " + r.net.remotes[0]}` : "DISCONNECTED") : "net ?";
    if (!r.job) { lines.push(`  runner ${r.pid} idle  up ${dur(f.ts - r.startedAt)}  ${net}`); continue; }
    const j = r.job;
    lines.push(`  runner ${r.pid} BUSY  ${j.repo ?? "?"}  ${dur(j.elapsedMs)}  ${j.procs} procs  cpu ${pct(j.cpu)}  rss ${gb(j.rss)}`);
    if (j.meta) lines.push(`      ${j.meta.workflow} / ${j.meta.job}  run #${j.meta.runNumber}  ${j.meta.runUrl}`);
    lines.push(`      wait: ${j.wait.kind}  ${j.wait.detail}  (${dur(j.wait.sinceMs)}, idle ${dur(j.wait.idleMs)})`);
    for (const st of j.steps) lines.push(`      step ${String(st.n).padStart(2)}  ${st.label.padEnd(32)} ${dur(st.durationMs).padStart(7)}  ${st.result ?? (st.done ? "" : "<- running")}`);
    for (const c of j.containers) lines.push(`      container ${c.name || c.id}  ${c.image}  ${c.procs} procs`);
    for (const p of j.top.slice(0, 4)) lines.push(`      ${String(p.pid).padStart(7)}  ${p.comm.padEnd(16)} ${pct(p.cpu)}  ${gb(p.rss)}${p.container ? `  in ${p.container}` : ""}`);
  }
  if (f.docker?.length) lines.push(`  docker: ${f.docker.map((c) => c.name).join(", ")}`);
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Main

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const { data, errors } = await graphQuery(QUERY);
    const fatal = errors?.find((e) => !/docker/i.test(e.message ?? "") && !(Array.isArray(data?.procs) && e.path?.[0] === "procs"));
    if (fatal || !data) throw new Error(fatal?.message ?? "Graph returned no data");
    lastError = null;
    const frame = summarize(data, Date.now());
    if (PLAIN) printPlain(frame);
    else tty.write(encodeFrame(frame));
  } catch (e) {
    lastError = e?.message ?? String(e);
    console.error(`tick: ${lastError}`);
  } finally {
    busy = false;
  }
}

console.error(`runner-watch: ${NAME ?? "unnamed"}, ${system.numCpus} cpus, polling every ${INTERVAL_MS}ms`);
await tick();
setInterval(tick, INTERVAL_MS);
