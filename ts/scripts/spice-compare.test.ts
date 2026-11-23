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

// Import the netlist and lay the elements out the way the canvas does: each part
// gets its own row, and the posts that belong to one node are joined with wires.
// Returns the circuit, the netlist, and a reader for the voltage of an external node.
async function importCircuit(text: string) {
    const { parseSpiceNetlist, buildSpiceParts, buildSpiceModels, registerSpiceModels } = await import("../ImportFromSpice");
    const { ElementFactory } = await import("../ElementFactory");
    const { StringTokenizer } = await import("../StringTokenizer");
    const { parseIntStrict } = await import("../NumberParse");
    const { WireElm } = await import("../WireElm");
    const { GroundElm } = await import("../GroundElm");
    const app = await makeApp();
    const nl = parseSpiceNetlist(text);
    const specs = buildSpiceModels(nl);
    registerSpiceModels(specs);
    const elms: any[] = [];
    const postsByNode = new Map<number, { x: number, y: number }[]>();
    const probe = new Map<number, { elm: any, post: number }>();
    let row = 0;
    for (const part of buildSpiceParts(nl, specs)) {
        const y = row++ * 64;
        const st = new StringTokenizer(part.dump, " ");
        const flags = parseIntStrict(st.nextToken());
        const ce: any = ElementFactory.create(part.className, 0, y, 64, y, flags, st);
        ce.x = 0; ce.y = y; ce.x2 = 64; ce.y2 = y;
        ce.setPoints();
        elms.push(ce);
        part.nodes.forEach((node, j) => {
            const p = ce.getPost(j);
            postsByNode.set(node, [...(postsByNode.get(node) ?? []), { x: p.x, y: p.y }]);
            if (!probe.has(node))
                probe.set(node, { elm: ce, post: j });
        });
    }
    // the canvas joins posts by coordinate, so one wire per extra post of a node
    for (const posts of postsByNode.values()) {
        for (let i = 1; i < posts.length; i++) {
            const w: any = new WireElm(0, 0);
            w.x = posts[i - 1].x; w.y = posts[i - 1].y; w.x2 = posts[i].x; w.y2 = posts[i].y;
            w.setPoints();
            elms.push(w);
        }
    }
    const ground = postsByNode.get(0)![0];
    const g: any = new GroundElm(0, 0);
    g.x = ground.x; g.y = ground.y; g.x2 = ground.x; g.y2 = ground.y + 16;
    g.setPoints();
    elms.push(g);
    app.elmList.push(...elms);
    const voltage = (j: number) => {
        const p = probe.get(nl.extList[j].node)!;
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

// one sample circuit per device type, compared against ngspice's operating point
const DEVICES: [string, string, string[]][] = [
    ["diode", `
* diode with series resistance
.subckt dtest in a
v1 in 0 dc 1
r1 in a 1k
d1 a 0 dmod
.model dmod d (is=1e-14 n=1.75 rs=0.1)
.ends
`, ["in", "a"]],
    ["bjt", `
* common emitter, biased by a base resistor
.subckt qtest vcc c b
v1 vcc 0 dc 5
rc vcc c 1k
rb vcc b 470k
q1 c b 0 qn
.model qn npn (bf=100 is=1e-14)
.ends
`, ["vcc", "c", "b"]],
    ["jfet", `
* n-channel JFET with a gate bias
.subckt jtest vdd d g
vdd vdd 0 dc 10
rd vdd d 1k
vg g 0 dc -1
j1 d g 0 jn
.model jn njf (vto=-2 beta=1m)
.ends
`, ["vdd", "d", "g"]],
];

it.each(DEVICES)("matches ngspice on an imported %s", async (_kind, netlist, names) => {
    const { app, nl, voltage } = await importCircuit(netlist);
    vi.useFakeTimers();
    const timeStep = 1e-6, stop = 20e-3;
    startSimulator(app, timeStep);
    const rows = runSimulator(app, stop, 5, () => nl.extList.map((_, j) => voltage(j)));
    vi.useRealTimers();

    const out = join(tmpdir(), "spice-device-" + _kind);
    writeFileSync(out + ".cir", flatten(netlist) +
        `\n.tran ${timeStep} ${stop}\n.control\nrun\nwrdata ${out}.spice ${names.map(n => `v(${n})`).join(" ")}\n.endc\n.end\n`);
    execFileSync("ngspice", ["-b", out + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const last = readWrdata(readFileSync(out + ".spice", "utf8")).at(-1)!;

    const lastRow = rows.at(-1)!;
    const report = names.map((n, j) =>
        `${n}: circuitjs ${lastRow[j + 1].toFixed(4)} V, ngspice ${last[2 * j + 1].toFixed(4)} V`);
    for (let j = 0; j < names.length; j++) {
        const sim = lastRow[j + 1], spice = last[2 * j + 1];
        expect(Math.abs(sim - spice), report.join("; ")).toBeLessThan(Math.max(0.02 * Math.abs(spice), 5e-3));
    }
});

it("imports a current source with SPICE's direction", async () => {
    // SPICE drives the current from n+ through the source to n-, so it pulls
    // node a down through the resistor
    const netlist = `
* current source into a resistor
.subckt itest a
i1 a 0 dc 1m
r1 a 0 1k
.ends
`;
    const { app, nl, voltage } = await importCircuit(netlist);
    vi.useFakeTimers();
    const timeStep = 1e-6, stop = 20e-3;
    startSimulator(app, timeStep);
    const rows = runSimulator(app, stop, 5, () => nl.extList.map((_, j) => voltage(j)));
    vi.useRealTimers();

    const out = join(tmpdir(), "spice-import-isrc");
    writeFileSync(out + ".cir", flatten(netlist) +
        `\n.tran ${timeStep} ${stop}\n.control\nrun\nwrdata ${out}.spice v(a)\n.endc\n.end\n`);
    execFileSync("ngspice", ["-b", out + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const spice = readWrdata(readFileSync(out + ".spice", "utf8")).at(-1)![1];
    const sim = rows.at(-1)![1];
    expect(sim, `circuitjs ${sim} V, ngspice ${spice} V`).toBeCloseTo(spice, 3);
});

// one sample circuit per controlled-source type
const CONTROLLED_SOURCES: [string, string, string[]][] = [
    ["VCVS", `
.subckt etest in out
v1 in 0 dc 1
e1 out 0 in 0 2
r1 out 0 1k
.ends
`, ["in", "out"]],
    ["VCCS", `
.subckt gtest in out
v1 in 0 dc 1
g1 out 0 in 0 1m
r1 out 0 1k
.ends
`, ["in", "out"]],
    ["CCVS", `
.subckt htest in out
v1 in 0 dc 1
r1 in 0 1k
h1 out 0 v1 10
r2 out 0 1k
.ends
`, ["in", "out"]],
    ["CCCS", `
.subckt ftest in out
v1 in 0 dc 1
r1 in 0 1k
f1 out 0 v1 2
r2 out 0 1k
.ends
`, ["in", "out"]],
    ["B current", `
.subckt btest in out
v1 in 0 dc 1
b1 out 0 i={v(in)*1m}
r1 out 0 1k
.ends
`, ["in", "out"]],
    ["B voltage", `
.subckt btest in out
v1 in 0 dc 1
b1 out 0 v={v(in)*3}
r1 out 0 1k
.ends
`, ["in", "out"]],
];

it.each(CONTROLLED_SOURCES)("matches ngspice on an imported %s", async (_kind, netlist, names) => {
    const { app, nl, voltage } = await importCircuit(netlist);
    vi.useFakeTimers();
    const timeStep = 1e-6, stop = 20e-3;
    startSimulator(app, timeStep);
    const rows = runSimulator(app, stop, 5, () => nl.extList.map((_, j) => voltage(j)));
    vi.useRealTimers();

    const out = join(tmpdir(), "spice-cs-" + _kind.replace(/ /g, "-"));
    writeFileSync(out + ".cir", flatten(netlist) +
        `\n.tran ${timeStep} ${stop}\n.control\nrun\nwrdata ${out}.spice ${names.map(n => `v(${n})`).join(" ")}\n.endc\n.end\n`);
    execFileSync("ngspice", ["-b", out + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const last = readWrdata(readFileSync(out + ".spice", "utf8")).at(-1)!;

    const lastRow = rows.at(-1)!;
    const report = names.map((n, j) =>
        `${n}: circuitjs ${lastRow[j + 1].toFixed(4)} V, ngspice ${last[2 * j + 1].toFixed(4)} V`);
    for (let j = 0; j < names.length; j++) {
        const sim = lastRow[j + 1], spice = last[2 * j + 1];
        expect(Math.abs(sim - spice), report.join("; ")).toBeLessThan(Math.max(0.02 * Math.abs(spice), 5e-3));
    }
});
