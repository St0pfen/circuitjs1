/// <reference types="node" />
// Compares a circuit's SPICE export against the simulator.  It loads a circuit file, runs
// the simulator on it headlessly, exports it and runs the netlist in ngspice, and reports
// each net whose voltage differs between the two:
//
//   CIRCUIT=../tests/custom.txt npx vitest run spice-compare
//
// CIRCUIT is the circuit file, text or XML.  STOP is how long to simulate (4000 time steps by default), RESET=0
// starts from the state the file was saved in instead of from reset, and OUT is where to
// write the netlist and both sets of voltages (the system's temporary directory by default).
// it needs ngspice, and skips itself without CIRCUIT.

import { it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";
import { makeApp, loadCircuit, startSimulator, runSimulator, readWrdata, differences } from "./simHarness";
import { exportSpiceNetlist } from "../SpiceExporter";

const FILE = process.env.CIRCUIT ?? "";
const OUT = process.env.OUT ?? join(tmpdir(), "spice-compare-" + basename(FILE).replace(/\.\w+$/, ""));
const SAMPLES = 200;

it.skipIf(!FILE)("matches the simulator", async () => {
    const app = await makeApp();
    vi.useFakeTimers();
    const timeStep = loadCircuit(readFileSync(FILE, "utf8"), app);
    const STOP = process.env.STOP ? parseFloat(process.env.STOP) : 4000 * timeStep;
    startSimulator(app, timeStep);

    const res = exportSpiceNetlist(app.elmList, { timeStep, stopTime: STOP });
    // each net, with a post on it to read the simulator's voltage from, and what's on it
    const probes = new Map<string, [any, number]>(), who = new Map<string, string[]>();
    for (const [ce, nets] of res.postNets)
        nets.forEach((n, j) => {
            const e = ce as any;
            if (n !== "0" && !probes.has(n) && e.nodes?.[j])
                probes.set(n, [e, j]);
            const pin = e.pins?.[j] ? ":" + (e.pins[j].text || "clk") : ":" + j;
            who.set(n, [...(who.get(n) ?? []), `${ce.getClassName().replace(/Elm$/, "")}@${e.x},${e.y}${pin}`]);
        });
    // (a net only a left-out part is on isn't in the netlist)
    const used = new Set(res.text.split("\n").filter(l => /^[A-Z]/.test(l)).flatMap(l => l.split(/[\s(),]+/)));
    const nets = [...probes.keys()].filter(n => used.has(n));

    // the simulator's voltages, after the first time step past each sample time
    const rows = runSimulator(app, STOP, SAMPLES, () => nets.map(n => { const [e, j] = probes.get(n)!; return e.nodes[j].v; }));
    vi.useRealTimers();

    // (without the .print line, whose table would only fill ngspice's output)
    const cir = res.text.replace(/^\.print .*\n(\+ .*\n)*/m, "").replace(/\n\.end\n$/,
        `\n.control\nrun\nwrdata ${OUT}.spice ${nets.map(n => `v(${n})`).join(" ")}\n.endc\n.end\n`);
    writeFileSync(OUT + ".cir", cir);
    writeFileSync(OUT + ".sim", rows.map(r => r.join(" ")).join("\n") + "\n");
    execFileSync("ngspice", ["-b", OUT + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const data = readWrdata(readFileSync(OUT + ".spice", "utf8"));
    const report = differences(nets, n => who.get(n)!.join(" "), rows, data, timeStep);
    const summary = `${FILE}: ${nets.length} nets, ${report.length} differ` +
                    (res.warnings.length ? `; left out of the export: ${[...new Set(res.warnings)].join(", ")}` : "") +
                    `\nnetlist and voltages in ${OUT}.*`;
    expect(report, summary + "\n" + report.join("\n")).toEqual([]);
});

// ---------------------------------------------------------------------------
// the other direction: a SPICE netlist, imported and placed as a circuit
// ---------------------------------------------------------------------------

const RLC = `
* RLC low-pass with two sources
.subckt rlc in mid out
r1 in mid 100
l1 mid out 1m
c1 out 0 1u
r2 out 0 1k
v1 in 0 dc 5
i1 mid 0 dc 1m
.ends
`;

// Import the netlist and lay the elements out the way the canvas does: node k at
// x = k*64, so elements that share a node share a post coordinate.  Node 0 gets a
// ground.  Returns the circuit, the element for each external node, and the netlist.
async function importCircuit(text: string) {
    const { parseSpiceNetlist, buildSpiceParts } = await import("../ImportFromSpice");
    const { ElementFactory } = await import("../ElementFactory");
    const { StringTokenizer } = await import("../StringTokenizer");
    const { parseIntStrict } = await import("../NumberParse");
    const { GroundElm } = await import("../GroundElm");
    const app = await makeApp();
    const nl = parseSpiceNetlist(text);
    const elms: any[] = [], probes: any[] = [];
    const at = (n: number): [number, number] => [n * 64, 0];
    for (const part of buildSpiceParts(nl)) {
        const st = new StringTokenizer(part.dump, " ");
        const flags = parseIntStrict(st.nextToken());
        const [x1, y1] = at(part.nodes[0]), [x2, y2] = at(part.nodes[1]);
        const ce: any = ElementFactory.create(part.className, x1, y1, x2, y2, flags, st);
        ce.x = x1; ce.y = y1; ce.x2 = x2; ce.y2 = y2;
        ce.setPoints();
        elms.push(ce);
        probes.push({ node: part.nodes[0], elm: ce, post: 0 });
        if (part.nodes[1] !== undefined)
            probes.push({ node: part.nodes[1], elm: ce, post: 1 });
    }
    const g: any = new GroundElm(0, 0);
    g.x = 0; g.y = 0; g.x2 = 0; g.y2 = 16; g.setPoints();
    elms.push(g);
    app.elmList.push(...elms);
    // the voltage of external node j: any element post that sits on it
    const voltage = (j: number) => {
        const p = probes.find(q => q.node === nl.extList[j].node)!;
        return p.elm.nodes[p.post].v;
    };
    return { app, nl, voltage };
}

// the netlist's body without the .subckt wrapper: same topology, node 0 is ground
function flatten(text: string): string {
    return text.split("\n").filter(l => !/^\s*\.(subckt|ends)\b/i.test(l)).join("\n");
}

it("imports a 5 V source with the right sign", async () => {
    const { app, voltage } = await importCircuit(`
.subckt src out
v1 out 0 dc 5
r1 out 0 1k
.ends
`);
    vi.useFakeTimers();
    startSimulator(app, 1e-6);
    const rows = runSimulator(app, 1e-3, 3, () => [voltage(0)]);
    vi.useRealTimers();
    expect(rows.at(-1)![1]).toBeCloseTo(5, 3);
});

it("matches ngspice on an imported RLC low-pass with two sources", async () => {
    const { app, nl, voltage } = await importCircuit(RLC);
    vi.useFakeTimers();
    const timeStep = 1e-6, stop = 20e-3;
    startSimulator(app, timeStep);
    const names = nl.extList.map(e => e.name);
    const rows = runSimulator(app, stop, 5, () => names.map((_, j) => voltage(j)));
    vi.useRealTimers();

    const out = join(tmpdir(), "spice-import-compare");
    writeFileSync(out + ".cir", flatten(RLC) +
        `\n.tran ${timeStep} ${stop}\n.control\nrun\nwrdata ${out}.spice ${names.map(n => `v(${n})`).join(" ")}\n.endc\n.end\n`);
    execFileSync("ngspice", ["-b", out + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const data = readWrdata(readFileSync(out + ".spice", "utf8"));
    const last = data.at(-1)!;

    // wrdata writes a scale column before each vector, so the values sit at 1, 3, 5
    const lastRow = rows.at(-1)!;   // column 0 is the time
    const report = names.map((n, j) =>
        `${n}: circuitjs ${lastRow[j + 1].toFixed(6)} V, ngspice ${last[2 * j + 1].toFixed(6)} V`);
    for (let j = 0; j < names.length; j++) {
        const sim = lastRow[j + 1], spice = last[2 * j + 1];
        expect(Math.abs(sim - spice), report.join("; ")).toBeLessThan(Math.max(0.01 * Math.abs(spice), 1e-6));
    }
});
