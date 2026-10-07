import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";

const benchmarkScript = resolve("scripts/benchmark-extension-startup.mjs");
const benchmarkUrl = pathToFileURL(benchmarkScript).href;

type BenchmarkModule = {
  main(args: string[]): Promise<void>;
  childEnvironment(environment: NodeJS.ProcessEnv, agentDir: string, cacheMode: "warm" | "cold"): NodeJS.ProcessEnv;
  parseArguments(
    args: string[],
    environment?: NodeJS.ProcessEnv,
  ): {
    baseline: boolean;
    cacheMode: "warm" | "cold";
    entries: string[];
    help: boolean;
    pi: string;
    piArgs: string[];
    runs: number;
    timeoutMs: number;
    readyTimeoutMs: number;
  };
  parseExtensionTimings(
    output: string,
    options?: { allowEmpty?: boolean },
  ): { imports: Array<{ entry: string; ms: number }>; total: number };
  summarize(values: number[]): {
    median: number | null;
    medianAbsoluteDeviation: number | null;
    min: number | null;
    max: number | null;
  };
};

async function loadBenchmark(): Promise<BenchmarkModule> {
  return (await import(`${benchmarkUrl}?test=${crypto.randomUUID()}`)) as BenchmarkModule;
}

test("startup benchmark parses cold, warm, baseline, and process options", async () => {
  const benchmark = await loadBenchmark();
  assert.deepEqual(benchmark.parseArguments([], { PI_STARTUP_BENCHMARK_PI: "custom-pi" }), {
    baseline: false,
    cacheMode: "warm",
    entries: [],
    help: false,
    pi: "custom-pi",
    piArgs: [],
    runs: 5,
    timeoutMs: 60_000,
    readyTimeoutMs: 60_000,
  });
  assert.deepEqual(
    benchmark.parseArguments([
      "--baseline",
      "--cache-mode",
      "cold",
      "--entry",
      "first.ts",
      "-e",
      "second.ts",
      "--pi",
      "pi-test",
      "--pi-arg",
      "custom-cli.mjs",
      "--runs",
      "3",
      "--timeout-ms",
      "2500",
      "--ready-timeout-ms",
      "3500",
    ]),
    {
      baseline: true,
      cacheMode: "cold",
      entries: ["first.ts", "second.ts"],
      help: false,
      pi: "pi-test",
      piArgs: ["custom-cli.mjs"],
      runs: 3,
      timeoutMs: 2500,
      readyTimeoutMs: 3500,
    },
  );

  for (const [args, expected] of [
    [["--cache-mode", "unknown"], /must be warm or cold/u],
    [["--cache-mode"], /requires a value/u],
    [["--runs", "0"], /positive integer/u],
    [["--timeout-ms", "1.5"], /positive integer/u],
    [["--ready-timeout-ms", "0"], /positive integer/u],
    [["--unknown"], /Unknown argument/u],
  ] as const) {
    assert.throws(() => benchmark.parseArguments([...args]), expected);
  }
});

test("startup benchmark controls Jiti cache state without dropping caller environment", async () => {
  const benchmark = await loadBenchmark();
  const base = {
    CUSTOM_VALUE: "preserved",
    JITI_FS_CACHE: "inherited",
    JITI_REBUILD_FS_CACHE: "inherited",
  };
  assert.deepEqual(benchmark.childEnvironment(base, "relative-agent", "cold"), {
    ...base,
    PI_CODING_AGENT_DIR: resolve("relative-agent"),
    PI_OFFLINE: "1",
    PI_TIMING: "1",
    JITI_FS_CACHE: "false",
    JITI_REBUILD_FS_CACHE: "false",
  });
  assert.equal(benchmark.childEnvironment(base, "relative-agent", "warm").JITI_FS_CACHE, "true");
});

test("startup benchmark parses per-extension timings and an empty baseline", async () => {
  const benchmark = await loadBenchmark();
  const output = [
    "unrelated",
    "--- Startup Timings: extensions ---",
    "  first.ts module import: 12ms",
    "  first.ts factory: 1ms",
    "  second.ts module import: 7ms",
    "-------------------------------",
  ].join("\n");
  assert.deepEqual(benchmark.parseExtensionTimings(output), {
    imports: [
      { entry: "first.ts", ms: 12 },
      { entry: "second.ts", ms: 7 },
    ],
    total: 19,
  });
  assert.deepEqual(benchmark.parseExtensionTimings("no extension timings", { allowEmpty: true }), {
    imports: [],
    total: 0,
  });
  assert.throws(() => benchmark.parseExtensionTimings("no extension timings"), /No extension module-import timings/u);
});

test("startup benchmark summarizes stable and empty samples", async () => {
  const benchmark = await loadBenchmark();
  assert.deepEqual(benchmark.summarize([10, 14, 30]), {
    median: 14,
    medianAbsoluteDeviation: 4,
    min: 10,
    max: 30,
  });
  assert.deepEqual(benchmark.summarize([]), {
    median: null,
    medianAbsoluteDeviation: null,
    min: null,
    max: null,
  });
});

test("cold benchmark reports a baseline and cleans every isolated agent directory", () => {
  const fixture = createFakePi();
  try {
    const result = spawnSync(
      process.execPath,
      [
        benchmarkScript,
        "--baseline",
        "--cache-mode",
        "cold",
        "--entry",
        "fixture-extension.ts",
        "--pi",
        process.execPath,
        "--pi-arg",
        fixture.script,
        "--runs",
        "1",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, FAKE_PI_CAPTURE: fixture.capture },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      protocolVersion: number;
      cacheMode: string;
      environment: { node: string; platform: string };
      warmup: { importTotalMs: number };
      baseline: { measurements: Array<{ importTotalMs: number }> };
      measurements: Array<{ imports: Array<{ entry: string; ms: number }> }>;
    };
    assert.equal(report.protocolVersion, 2);
    assert.equal(report.cacheMode, "cold");
    assert.equal(report.environment.node, process.version);
    assert.equal(report.environment.platform, process.platform);
    assert.equal(report.warmup.importTotalMs, 3);
    assert.deepEqual(report.measurements[0]?.imports, [{ entry: resolve("fixture-extension.ts"), ms: 3 }]);
    assert.equal(report.baseline.measurements[0]?.importTotalMs, 0);

    const captures = readFileSync(fixture.capture, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { agentDir: string; fsCache: string; rebuildCache: string; commands: string[] },
      );
    assert.equal(captures.length, 4);
    for (const capture of captures) {
      assert.deepEqual(capture.commands, ["get_state", "get_commands"]);
      assert.equal(capture.fsCache, "false");
      assert.equal(capture.rebuildCache, "false");
      assert.equal(existsSync(capture.agentDir), false);
    }
  } finally {
    fixture.cleanup();
  }
});

test("startup benchmark kills a timed-out child and removes its agent directory", () => {
  const fixture = createFakePi();
  try {
    const result = spawnSync(
      process.execPath,
      [
        benchmarkScript,
        "--entry",
        "fixture-extension.ts",
        "--pi",
        process.execPath,
        "--pi-arg",
        fixture.script,
        "--runs",
        "1",
        "--timeout-ms",
        "100",
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        env: { ...process.env, FAKE_PI_CAPTURE: fixture.capture, FAKE_PI_HANG: "1" },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Pi benchmark failed.*phase=command/u);
    const capture = JSON.parse(readFileSync(fixture.capture, "utf8").trim()) as { agentDir: string };
    assert.equal(existsSync(capture.agentDir), false);
  } finally {
    fixture.cleanup();
  }
});

test("command deadline does not consume time before the child readiness handshake", async () => {
  const fixture = createFakePi();
  const server = createServer();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const previousCapture = process.env.FAKE_PI_CAPTURE;
  const previousGate = process.env.FAKE_PI_READY_GATE;
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.FAKE_PI_CAPTURE = fixture.capture;
    process.env.FAKE_PI_READY_GATE = String(address.port);
    let handshakes = 0;
    server.on("connection", (socket) => {
      socket.on("error", () => socket.destroy()); // A falsified deadline may kill the waiting child.
      socket.once("data", () => {
        // Advance the operational budget while the child explicitly withholds readiness.
        // A timer armed at spawn kills this child; the separate readiness budget does not.
        vi.advanceTimersByTime(101);
        handshakes++;
        socket.end("ready");
      });
    });
    const benchmark = await loadBenchmark();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = benchmark.main([
      "--entry",
      "fixture.ts",
      "--pi",
      process.execPath,
      "--pi-arg",
      fixture.script,
      "--runs",
      "1",
      "--ready-timeout-ms",
      "1000",
      "--timeout-ms",
      "100",
    ]);
    await run;
    assert.equal(handshakes, 2, "warmup and measured child both wait for readiness");
    const captures = readFileSync(fixture.capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(captures.length, 2);
    for (const capture of captures) {
      assert.deepEqual(capture.commands, ["get_state", "get_commands"]);
      assert.equal(existsSync(capture.agentDir), false);
    }
  } finally {
    vi.useRealTimers();
    stdout.mockRestore();
    if (previousCapture === undefined) delete process.env.FAKE_PI_CAPTURE;
    else process.env.FAKE_PI_CAPTURE = previousCapture;
    if (previousGate === undefined) delete process.env.FAKE_PI_READY_GATE;
    else process.env.FAKE_PI_READY_GATE = previousGate;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    fixture.cleanup();
  }
});

for (const readiness of ["absent", "false", "mismatched", "exit"]) {
  test(`startup benchmark bounds ${readiness} readiness and cleans the isolated agent directory`, () => {
    const fixture = createFakePi();
    try {
      const result = spawnSync(
        process.execPath,
        [
          benchmarkScript,
          "--entry",
          "fixture.ts",
          "--pi",
          process.execPath,
          "--pi-arg",
          fixture.script,
          "--runs",
          "1",
          "--ready-timeout-ms",
          "100",
          "--timeout-ms",
          "100",
        ],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            TMPDIR: fixture.root,
            TMP: fixture.root,
            TEMP: fixture.root,
            FAKE_PI_CAPTURE: fixture.capture,
            FAKE_PI_READY: readiness,
          },
        },
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Pi benchmark failed.*phase=readiness/u);
      assert.equal(existsSync(fixture.capture), false, "must not dispatch get_commands before readiness");
      assert.deepEqual(readdirSync(fixture.root), ["fake-pi.mjs"], "failed startup must remove its agent directory");
    } finally {
      fixture.cleanup();
    }
  });
}

function createFakePi() {
  const root = mkdtempSync(join(tmpdir(), "pi-startup-benchmark-fixture-"));
  const capture = join(root, "capture.jsonl");
  const script = join(root, "fake-pi.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { connect } from "node:net";
const extensions = process.argv.flatMap((argument, index, args) => argument === "--extension" ? [args[index + 1]] : []);
const capture = { agentDir: process.env.PI_CODING_AGENT_DIR, fsCache: process.env.JITI_FS_CACHE, rebuildCache: process.env.JITI_REBUILD_FS_CACHE, commands: [] };
if (process.env.FAKE_PI_READY === "exit") process.exit(0);
const input = createInterface({ input: process.stdin });
let ready = false;
input.on("line", async line => {
  const command = JSON.parse(line);
  capture.commands.push(command.type);
  if (command.type === "get_state") {
    if (process.env.FAKE_PI_READY_GATE) await new Promise(resolveReady => {
      const socket = connect(Number(process.env.FAKE_PI_READY_GATE), "127.0.0.1", () => socket.write("waiting"));
      socket.once("data", () => { socket.end(); resolveReady(); });
    });
    ready = true;
    if (process.env.FAKE_PI_READY === "absent") return;
    const response = { type: "response", id: command.id, command: "get_state", success: true };
    if (process.env.FAKE_PI_READY === "false") response.success = false;
    if (process.env.FAKE_PI_READY === "mismatched") response.id = "unrelated";
    process.stdout.write(JSON.stringify(response) + "\\n");
  } else if (command.type === "get_commands") {
    if (!ready) {
      process.stderr.write("get_commands dispatched before readiness handshake\\n");
      process.exit(3);
    }
    appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify(capture) + "\\n");
    if (process.env.FAKE_PI_HANG === "1") return;
    process.stderr.write("--- Startup Timings: extensions ---\\n");
    for (const extension of extensions) process.stderr.write("  " + extension + " module import: 3ms\\n");
    process.stderr.write("-------------------------------\\n");
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_commands", success: true }) + "\\n");
  }
});
input.on("close", () => {
  if (process.env.FAKE_PI_HANG === "1") setInterval(() => {}, 1000);
});
`,
    "utf8",
  );

  return {
    root,
    capture,
    script,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}
