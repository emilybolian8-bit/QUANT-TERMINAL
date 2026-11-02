/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeSeriesLiquidations } from "../types";

/**
 * Browser-side CPython (Pyodide) for the Code Lab tab.
 *
 * The interpreter runs entirely in the page as WebAssembly: user code is never
 * sent to our server, so the public deployment cannot be turned into a remote
 * code execution host by anything typed into the editor. The tradeoff is that
 * this is the Pyodide package set (numpy/pandas/scipy/matplotlib ship with the
 * runtime), not an arbitrary pip environment, and there is no filesystem or
 * network access.
 *
 * CPython 3.14 + pandas 3.0 + matplotlib, pinned so a CDN side-release cannot
 * change behaviour under a saved notebook. Bump this to re-pick wheels.
 */
export const PYODIDE_VERSION = "314.0.7";

const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Wheel packages loaded on boot, beyond the stdlib baked into the runtime. */
const BOOT_PACKAGES = ["numpy", "pandas", "matplotlib"] as const;

/**
 * The slice of the Pyodide API this module uses. Declared locally rather than
 * pulling in the `pyodide` npm package: we never want the interpreter's ~10MB
 * of wasm/data in the JavaScript bundle, only fetched from the CDN on demand.
 */
interface PyodideRuntime {
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(names: string[]): Promise<void>;
  setStdout(handler: { batched: (message: string) => void }): void;
  setStderr(handler: { batched: (message: string) => void }): void;
  globals: { set(name: string, value: unknown): void };
}

export interface CodeRunResult {
  /** `repr()` of the last expression in the snippet, REPL style. */
  value: string;
  /** Base64 PNGs of every matplotlib figure left open by the snippet. */
  figures: string[];
}

export interface KernelStatus {
  phase: "idle" | "booting" | "ready" | "failed";
  message: string;
}

type LoadPyodide = (options: { indexURL: string }) => Promise<PyodideRuntime>;

interface Kernel {
  runtime: PyodideRuntime;
  seeded: boolean;
  /** Rows the `liq` frame holds after the last `loadFrame`; 0 when the tape was empty. */
  liqRows: number;
  out: string[];
  err: string[];
}

let kernel: Kernel | null = null;
let booting: Promise<Kernel> | null = null;

/**
 * Boot-time Python. Everything the Code Lab promises is defined here rather
 * than in user snippets, so a user can experiment without re-importing pandas.
 */
const BOOTSTRAP_PY = `
import ast, base64, io, json as _json, math, statistics, textwrap

import numpy as np
import pandas as pd

import matplotlib
matplotlib.use("AGG")
import matplotlib.pyplot as plt

pd.set_option("display.width", 140)
pd.set_option("display.max_columns", 60)

def _seed(payload):
    """Build the starter DataFrame from the JSON the server sent."""
    global df, meta
    parsed = _json.loads(payload)
    frame = pd.DataFrame(parsed["rows"], columns=parsed["columns"])
    frame["time"] = pd.to_datetime(frame["time"], unit="ms", utc=True)
    df = frame
    meta = parsed["meta"]
    return len(df)

def _seed_liq(payload):
    """Build the liq frame: recent force-orders for the subject, or None.

    payload is a JSON string; the literal "null" means the tape carried no
    prints for this symbol, so liq exists but is None rather than undefined.
    """
    global liq, liq_meta
    parsed = _json.loads(payload) if payload else None
    if parsed is None:
        liq = None
        liq_meta = None
        return 0
    frame = pd.DataFrame(parsed["rows"], columns=parsed["columns"])
    for column in ("time", "event_time"):
        frame[column] = pd.to_datetime(frame[column], unit="ms", utc=True)
    for column in ("price", "qty", "notional"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    liq = frame
    liq_meta = parsed
    return len(liq)

def _repr(value):
    """REPL-ish rendering: tables print as tables, everything else as repr."""
    if value is None:
        return ""
    if isinstance(value, pd.DataFrame):
        with pd.option_context("display.max_rows", 60, "display.max_columns", 60):
            return value.to_string()
    if isinstance(value, pd.Series):
        return value.to_string()
    if hasattr(value, "_repr_html_"):
        return repr(value)
    text = repr(value)
    return text if len(text) <= 20000 else text[:20000] + "\\n... [truncated]"

def _drain_figures():
    """PNG-encode every open figure, then close it so the next run is clean."""
    images = []
    for number in plt.get_fignums():
        fig = plt.figure(number)
        buffer = io.BytesIO()
        fig.savefig(buffer, format="png", dpi=110, bbox_inches="tight")
        images.append(base64.b64encode(buffer.getvalue()).decode("ascii"))
        plt.close(fig)
    return images

def _run(code):
    """
    Run a snippet with notebook semantics.

    ast.parse splits a trailing bare expression off from the statements so it
    can be eval'd and displayed the way a REPL would. A snippet ending in an
    assignment (a very common last line) therefore returns nothing rather
    than raising, and the value of the *last statement* is not shown.
    """
    tree = ast.parse(code, mode="exec")
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)
    scope = globals()
    if tree.body:
        exec(compile(tree, "<code-lab>", "exec"), scope)
    value = eval(compile(tail, "<code-lab>", "eval"), scope) if tail else None
    return _json.dumps({"value": _repr(value), "figures": _drain_figures()})
`;

/**
 * Loads Pyodide once per page and keeps it warm. Reopening the tab reuses the
 * interpreter, and because globals persist a user's `import`/`df` survive
 * between runs until they press Restart.
 */
export async function getKernel(
  onStatus?: (status: KernelStatus) => void
): Promise<Kernel> {
  if (kernel) return kernel;
  if (booting) return booting;

  booting = (async () => {
    onStatus?.({ phase: "booting", message: "Fetching CPython runtime (cached after first load)..." });
    const module = (await import(/* @vite-ignore */ `${CDN_BASE}pyodide.mjs`)) as {
      default?: LoadPyodide;
      loadPyodide?: LoadPyodide;
    };
    const load = module.loadPyodide ?? module.default;
    if (typeof load !== "function") {
      throw new Error(`Pyodide ${PYODIDE_VERSION} did not export loadPyodide from the CDN.`);
    }

    onStatus?.({ phase: "booting", message: "Starting interpreter..." });
    const runtime = await load({ indexURL: CDN_BASE });

    onStatus?.({
      phase: "booting",
      message: `Loading ${BOOT_PACKAGES.join(", ")}...`,
    });
    await runtime.loadPackage([...BOOT_PACKAGES]);

    // Registered before the bootstrap runs so anything it prints is captured.
    const created: Kernel = { runtime, seeded: false, liqRows: 0, out: [], err: [] };
    kernel = created;
    runtime.setStdout({ batched: (message) => created.out.push(message) });
    runtime.setStderr({ batched: (message) => created.err.push(message) });

    await runtime.runPythonAsync(BOOTSTRAP_PY);

    onStatus?.({ phase: "ready", message: `Python ready (v${PYODIDE_VERSION})` });
    return created;
  })();

  try {
    return await booting;
  } catch (error: any) {
    booting = null;
    onStatus?.({ phase: "failed", message: error?.message || "Python failed to start" });
    throw error;
  } finally {
    booting = null;
  }
}

/**
 * Hands the aligned OHLCV columns to the kernel as the global `df`, and the
 * subject's force-orders as `liq`. Runs after boot; safe to call again to swap
 * the loaded dataset. `liquidations` may be omitted — `liq` is then seeded to
 * None so a snippet can test it without a NameError.
 */
export async function loadFrame(
  payload: {
    columns: string[];
    rows: Array<Array<number | null>>;
    meta: unknown;
    liquidations?: CodeSeriesLiquidations | null;
  },
  onStatus?: (status: KernelStatus) => void
): Promise<number> {
  const active = await getKernel(onStatus);
  active.out = [];
  active.err = [];
  active.runtime.globals.set(
    "__code_lab_payload",
    JSON.stringify({ columns: payload.columns, rows: payload.rows, meta: payload.meta })
  );
  const result = await active.runtime.runPythonAsync("_seed(__code_lab_payload)");
  active.runtime.globals.set(
    "__code_lab_liq_payload",
    JSON.stringify(payload.liquidations ?? null)
  );
  const liqRows = await active.runtime.runPythonAsync("_seed_liq(__code_lab_liq_payload)");
  active.liqRows = Number(liqRows ?? 0);
  active.seeded = true;
  return Number(result ?? 0);
}

/**
 * Executes one snippet. Returns the trailing expression's repr plus any
 * figures it plotted. Throws on a Python exception so the caller can show the
 * traceback verbatim.
 */
export async function runCode(code: string): Promise<CodeRunResult> {
  const active = await getKernel();
  active.out = [];
  active.err = [];
  active.runtime.globals.set("__code_lab_snippet", code);
  const raw = (await active.runtime.runPythonAsync("_run(__code_lab_snippet)")) as string;
  return JSON.parse(raw) as CodeRunResult;
}

/** stdout/stderr produced by the most recent run, joined and then drained. */
export function drainOutput(): { out: string; err: string } {
  if (!kernel) return { out: "", err: "" };
  const captured = { out: kernel.out.join(""), err: kernel.err.join("") };
  kernel.out = [];
  kernel.err = [];
  return captured;
}

/** Drops the dataset and imported names so the next run starts from scratch. */
export async function restartKernel(): Promise<void> {
  const active = kernel;
  if (!active) return;
  active.out = [];
  active.err = [];
  active.seeded = false;
  active.liqRows = 0;
  try {
    await active.runtime.runPythonAsync(
      "globals().pop('df', None); globals().pop('meta', None); " +
        "globals().pop('liq', None); globals().pop('liq_meta', None); plt.close('all')"
    );
  } catch {
    // State that cannot be cleared means the interpreter is already unusable.
  }
}

/** Row count of the resident `liq` frame: 0 before a load or when the tape was empty. */
export function residentLiqRows(): number {
  return kernel?.liqRows ?? 0;
}