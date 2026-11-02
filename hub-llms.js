// runner-watch hub llms.txt: the agent-readable index of the fleet.
// Mounted at /llms.txt on the hub as a per-connection console route,
// so each GET spawns this isolate, which prints the document and
// exits. Isolates have no network access, so this cannot aggregate
// the runners itself; it tells an agent where each runner's own
// /llms.txt, /metrics and /tty live behind the hub's proxy routes.
//
//   curl http://<hub>:9430/llms.txt

const args = yeet.args ?? {};
const runners = [args.runner ?? []].flat().map(String).filter(Boolean);
const port = Number(args.port) || 9430;
const out = [];
const say = (...l) => out.push(...l);

say("# runner-watch hub", "");
say(`> Dashboard and proxy for ${runners.length} GitHub Actions self-hosted runner${runners.length === 1 ? "" : "s"}, generated at ${new Date().toISOString()}. Every runner runs a runner-watch agent; the hub forwards /r/<runner>/ to it, so one host name and port (${port}) reach the whole fleet.`, "");
say("The hub has no aggregate endpoint: fetch each runner's /llms.txt below (one request each, they return in well under a second) and combine them. A runner whose request fails with 502 or times out is unreachable, which usually means the host is down.", "");

say("## Runners", "");
if (!runners.length) say("No runners were configured; rerun scripts/install-hub.sh.", "");
for (const r of runners) say(`- ${r}: snapshot at /r/${r}/llms.txt, metrics at /r/${r}/metrics, live frames at ws://<hub>:${port}/r/${r}/tty`);
say("");

say("## Per-runner endpoints", "");
say("- /r/<runner>/llms.txt: plain-text snapshot of that host and its listeners: cpu, memory, load, the running job's repository, elapsed time, inferred current step, containers and top processes.");
say("- /r/<runner>/metrics: the same sample as Prometheus exposition, metric names prefixed runner_watch_, every series labelled runner=\"<name>\".");
say("- /r/<runner>/tty: websocket streaming one OSC 7880 frame per second, ESC ] 7880 ; <json> BEL. The json is {t:\"tick\", ts, name, host, runners[], stats, history[]}; runners[].job carries step names, per-step timings, repo/run/commit links when the job hook is installed, containers and top processes; history[] holds recent completed jobs. This is the only place hook-fed detail is available.");
say("");

say("## Hub endpoints", "");
say("- /: the human dashboard (static html, reads the same /r/<runner>/tty streams).");
say("- /runners.json: the configured runner names as a json array.");
say("- /llms.txt: this document.");
say("- /.well-known/yeet/manifest.json: the route manifest, which also lists the routes reachable through each proxy.");
say("");
say("## About", "");
say("runner-watch is a pair of yeet services; source at https://github.com/yeet-src/runner-watch. Each runner runs the repository's service.toml via `yeet service apply`; the hub is hub.toml, written by scripts/install-hub.sh.");
console.log(out.join("\n"));
yeet.exit(0);
