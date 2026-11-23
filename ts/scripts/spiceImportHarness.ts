/// <reference types="node" />
// Shared harness for the import direction: a SPICE netlist in, a placed circuit
// out, plus the ngspice comparison the fixture tests use.
//
// The layout is what the canvas does: each part gets its own row and the posts
// that belong to one node are joined with wires, because CircuitJS connects by
// coordinate, not by name.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { makeApp, readWrdata } from "./simHarness";

// ngspice is optional: without it the comparison tests skip instead of failing
export function ngspiceAvailable(): boolean {
    try {
        execFileSync("ngspice", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

// Import the netlist and lay the elements out the way the canvas does: each part
// gets its own row, and the posts that belong to one node are joined with wires.
// Returns the circuit, the netlist, and a reader for the voltage of an external node.
export async function importCircuit(text: string) {
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
    // chip elements draw their pins well below the row they start at, so give every
    // part room; 64 px put a resistor post on top of a POLY source's control pin
    const ROW = 256;
    const postAt = new Map<string, number>();
    for (const part of buildSpiceParts(nl, specs)) {
        const y = row++ * ROW;
        const st = new StringTokenizer(part.dump, " ");
        const flags = parseIntStrict(st.nextToken());
        const ce: any = ElementFactory.create(part.className, 0, y, 64, y, flags, st);
        ce.x = 0; ce.y = y; ce.x2 = 64; ce.y2 = y;
        ce.setPoints();
        elms.push(ce);
        part.nodes.forEach((node, j) => {
            const p = ce.getPost(j);
            // two nodes on one coordinate would be one node for the simulator, and the
            // comparison would silently test something else
            const key = `${p.x},${p.y}`, seen = postAt.get(key);
            if (seen !== undefined && seen !== node)
                throw new Error(`layout error: ${part.className} post ${j} sits on node ${seen} and ${node}`);
            postAt.set(key, node);
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
export function flatten(text: string): string {
    return text.split("\n").filter(l => !/^\s*\.(subckt|ends)\b/i.test(l)).join("\n");
}


// Every net with both voltages, and the ones that differ beyond the tolerance.
// wrdata writes a scale column before each vector, so the values sit at 1, 3, 5.
export function describeNets(names: string[], simRow: number[], spiceRow: number[], tolerance = 0.02) {
    const all: string[] = [], failures: string[] = [];
    names.forEach((n, j) => {
        const sim = simRow[j + 1];      // column 0 is the time
        const spice = spiceRow[2 * j + 1];
        const limit = Math.max(tolerance * Math.abs(spice), 5e-3);
        const off = !(Math.abs(sim - spice) < limit);
        all.push(`${n}: circuitjs ${sim.toFixed(6)} V, ngspice ${spice.toFixed(6)} V` +
                 (off ? "  <-- differs" : ""));
        if (off)
            failures.push(`${n}: circuitjs ${sim.toFixed(6)} V, ngspice ${spice.toFixed(6)} V`);
    });
    return { all, failures };
}

// Import a netlist, run it to a steady state, run the same netlist through ngspice,
// and report every net with both voltages.
export async function compareImportedNetlist(text: string, names: string[],
        opts: { timeStep?: number, stop?: number, out?: string, tolerance?: number } = {}) {
    const timeStep = opts.timeStep ?? 1e-6, stop = opts.stop ?? 20e-3;
    const { app, nl, voltage } = await importCircuit(text);
    const { startSimulator, runSimulator } = await import("./simHarness");
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    startSimulator(app, timeStep);
    // the names are nets, not pin positions: find each one's index in the pin list
    const idx = names.map(n => {
        const i = nl.extList.findIndex(e => e.name === n);
        if (i < 0)
            throw new Error(`net "${n}" is not a pin of this subcircuit`);
        return i;
    });
    const rows = runSimulator(app, stop, 5, () => idx.map(i => voltage(i)));
    vi.useRealTimers();

    const out = opts.out ?? "/tmp/spice-fixture";
    writeFileSync(out + ".cir", flatten(text) +
        `\n.tran ${timeStep} ${stop}\n.control\nrun\nwrdata ${out}.spice ${names.map(n => `v(${n})`).join(" ")}\n.endc\n.end\n`);
    execFileSync("ngspice", ["-b", out + ".cir"], { stdio: ["ignore", "pipe", "pipe"] });
    const data = readWrdata(readFileSync(out + ".spice", "utf8"));
    return describeNets(names, rows.at(-1)!, data.at(-1)!, opts.tolerance);
}
