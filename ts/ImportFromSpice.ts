/*
    Copyright (C) Paul Falstad and Iain Sharp

    This file is part of CircuitJS1.

    CircuitJS1 is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    CircuitJS1 is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with CircuitJS1.  If not, see <http://www.gnu.org/licenses/>.
*/

// Reads a SPICE subcircuit into a node table, model cards and an element
// list.  Ported from ImportFromSpiceDialog.java in the Java branch
// `spiceimport`; the structure is the same, the error handling is not:
//
// - errors carry the line number and the offending token instead of being
//   swallowed, and
// - a node that never appears in an element is an error instead of being
//   silently tied to ground (the Java `findNode` returns indexOf+1, so an
//   unknown node lands on 0).
//
// Scope of this file is the parser only: values, models and controlled
// sources are turned into CircuitJS elements by the callers of TP2-TP4.
// `shortcut: no .param/.include/nested X support, add when those issues
// come up.`

import { ExtListEntry } from "./ExtListEntry";
import { SpiceTokenizer } from "./SpiceTokenizer";
import { CustomLogicModel } from "./CustomLogicModel";

export class SpiceParseError extends Error {
    line?: number;

    constructor(message: string, line?: number) {
        super(line != null ? `line ${line}: ${message}` : message);
        this.name = "SpiceParseError";
        this.line = line;
    }
}

export interface SpiceModelCard {
    name: string;
    type: string;
    params: Record<string, string>;
    line: number;
}

export interface SpiceElement {
    name: string;
    type: string;          // first letter of the name: r, c, l, v, ...
    nodes: number[];       // node table indices, 0 = ground
    rest: string[];        // everything after the nodes, still raw
    line: number;
}

export interface SpiceNetlist {
    subcircuitName: string;
    extList: ExtListEntry[];
    nodes: string[];       // 1-based; node "0" (ground) is implicit
    models: SpiceModelCard[];
    elements: SpiceElement[];
    nodeIndex(name: string): number;
    // nodes of the named voltage source, for the F and H sources that refer to it
    voltageSourceNodes(name: string): [number, number];
}

// One element of the imported circuit, in the terms CircuitJS needs: the element
// class, its nodes and its dump string (the old nodeList/elmDump format).
export interface SpicePart {
    className: string;
    nodes: number[];
    dump: string;
    line: number;
}

// Two nodes: b c d f h i l r v, three: q j m.  e and g take four (two output,
// two control nodes); the Java parser only read two of them.
const TWO_NODE = "bcdfhilrv";
const THREE_NODE = "qjm";
const FOUR_NODE = "eg";

// SPICE multipliers.  M is milli, not mega (that is MEG) — the opposite of SI.
const SPICE_MULTIPLIER: Record<string, number> = {
    t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

// A value as SPICE writes it: 10k, 2k2, 1MEG, 10uF, 5V, 1e-3.  Letters after the
// multiplier are units and are ignored, so 10uF and 10u are the same capacitance.
export function parseSpiceValue(raw: string, line?: number): number {
    // 2k2 means 2.2k
    const text = raw.trim().toLowerCase().replace(/(\d)(meg|[tgkmunpf])(\d)/, "$1.$3$2");
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/.exec(text);
    if (m == null)
        throw new SpiceParseError(`not a number: "${raw}"`, line);
    const suffix = m[2];
    let mult = 1;
    if (suffix.startsWith("meg"))
        mult = 1e6;
    else if (suffix !== "" && SPICE_MULTIPLIER[suffix[0]] !== undefined)
        mult = SPICE_MULTIPLIER[suffix[0]];
    return parseFloat(m[1]) * mult;
}

export function nodeCountFor(type: string, line: number): number {
    if (TWO_NODE.indexOf(type) >= 0) return 2;
    if (THREE_NODE.indexOf(type) >= 0) return 3;
    if (FOUR_NODE.indexOf(type) >= 0) return 4;
    if (type === "x")
        throw new SpiceParseError(".subckt instance (X) is not supported yet", line);
    throw new SpiceParseError(`unknown element type "${type}"`, line);
}

interface LogicalLine {
    text: string;
    line: number;
}

// Joins "+" continuation lines, drops "*" comments and blank lines.  Every
// logical line keeps the number of its first physical line.
function logicalLines(text: string): LogicalLine[] {
    const out: LogicalLine[] = [];
    text.split(/\r\n|\r|\n/).forEach((raw, i) => {
        const trimmed = raw.trimStart();
        if (trimmed.startsWith("+") && out.length > 0) {
            out[out.length - 1].text += " " + trimmed.substring(1).trim();
            return;
        }
        if (trimmed === "" || trimmed.startsWith("*"))
            return;
        out.push({ text: raw, line: i + 1 });
    });
    return out;
}

export function parseSpiceNetlist(text: string): SpiceNetlist {
    const lines = logicalLines(text);
    const nodes: string[] = [];
    const models: SpiceModelCard[] = [];
    const extList: ExtListEntry[] = [];
    let subcircuitName = "";

    const addNode = (name: string) => {
        const key = name.toLowerCase();
        if (key !== "0" && nodes.indexOf(key) < 0)
            nodes.push(key);
    };

    // first pass: models, subcircuit header, node table
    for (const ll of lines) {
        const st = new SpiceTokenizer(ll.text, " \t\f()");
        if (!st.hasMoreTokens())
            continue;
        const first = st.nextToken();

        if (first === ".subckt") {
            if (subcircuitName !== "")
                throw new SpiceParseError("more than one .subckt in the netlist", ll.line);
            if (!st.hasMoreTokens())
                throw new SpiceParseError(".subckt without a name", ll.line);
            subcircuitName = st.nextTokenPreserveCase();
            while (st.hasMoreTokens()) {
                const pin = st.nextTokenPreserveCase();
                // "params:" starts a parameter list, not a pin
                if (pin.toLowerCase() === "params:")
                    break;
                addNode(pin);
                extList.push(new ExtListEntry(pin, nodes.indexOf(pin.toLowerCase()) + 1));
            }
            continue;
        }
        if (first === ".ends")
            continue;
        if (first === ".model") {
            if (!st.hasMoreTokens() || !st.hasMoreTokens())
                throw new SpiceParseError(".model needs a name and a type", ll.line);
            const name = st.nextTokenPreserveCase();
            const type = st.nextToken();
            const params: Record<string, string> = {};
            while (st.hasMoreTokens()) {
                const tok = st.nextTokenPreserveCase();
                const eq = tok.indexOf("=");
                if (eq > 0)
                    params[tok.substring(0, eq).toLowerCase()] = tok.substring(eq + 1);
            }
            models.push({ name, type, params, line: ll.line });
            continue;
        }
        if (first === ".rename") {
            let i = 0;
            while (st.hasMoreTokens()) {
                if (i >= extList.length)
                    throw new SpiceParseError(`.rename has more names than the ${extList.length} pins`, ll.line);
                extList[i++].name = st.nextTokenPreserveCase();
            }
            continue;
        }

        const type = first.charAt(0);
        const count = nodeCountFor(type, ll.line);
        for (let i = 0; i < count; i++) {
            if (!st.hasMoreTokens())
                throw new SpiceParseError(`element "${first}" has ${i} node(s), expected ${count}`, ll.line);
            addNode(st.nextToken());
        }
    }

    const nodeIndex = (name: string): number => {
        const key = name.toLowerCase();
        if (key === "0")
            return 0;
        const idx = nodes.indexOf(key);
        if (idx < 0)
            throw new SpiceParseError(`node "${name}" was never declared`);
        return idx + 1;
    };

    // second pass: elements, with nodes resolved through the finished table
    const elements: SpiceElement[] = [];
    const voltageSources = new Map<string, [number, number]>();
    for (const ll of lines) {
        const st = new SpiceTokenizer(ll.text, " \t\f");
        if (!st.hasMoreTokens())
            continue;
        const name = st.nextToken();
        const type = name.charAt(0);
        if (type === "." || type === "*")
            continue;
        const count = nodeCountFor(type, ll.line);
        const elementNodes: number[] = [];
        for (let i = 0; i < count; i++) {
            if (!st.hasMoreTokens())
                throw new SpiceParseError(`element "${name}" has ${i} node(s), expected ${count}`, ll.line);
            elementNodes.push(nodeIndex(st.nextToken()));
        }
        const rest: string[] = [];
        while (st.hasMoreTokens())
            rest.push(st.nextTokenPreserveCase());
        elements.push({ name, type, nodes: elementNodes, rest, line: ll.line });
        if (type === "v")
            voltageSources.set(name, [elementNodes[0], elementNodes[1]]);
    }

    if (subcircuitName === "")
        throw new SpiceParseError("no .subckt found in the netlist");

    const voltageSourceNodes = (name: string): [number, number] => {
        const vs = voltageSources.get(name.toLowerCase());
        if (vs == null)
            throw new SpiceParseError(`no voltage source named "${name}"`);
        return vs;
    };

    return { subcircuitName, extList, nodes, models, elements, nodeIndex, voltageSourceNodes };
}

// The value of an element line: "DC 5", "5", or a bare number after a model name.
function elementValue(el: SpiceElement, index = 0): number {
    let token = el.rest[index];
    if (token !== undefined && token.toLowerCase() === "dc")
        token = el.rest[++index];
    if (token === undefined)
        throw new SpiceParseError(`element "${el.name}" has no value`, el.line);
    return parseSpiceValue(token, el.line);
}

// Resistors may name a model instead of a value: "r1 a b 1k" or "r1 a b rmod".
function resistorValue(el: SpiceElement): number {
    const first = el.rest[0];
    if (first === undefined)
        throw new SpiceParseError(`element "${el.name}" has no value`, el.line);
    const isValue = /^[+-]?[0-9.]/.test(first);
    return elementValue(el, isValue ? 0 : 1);
}

// keep dump strings readable: 10*1e-6 is 9.999999999999999e-6 as a double
function num(v: number): string {
    return String(parseFloat(v.toPrecision(12)));
}

// Capacitors and inductors get FLAG_BACK_EULER (2): SPICE models assume backward
// Euler, and trapezoidal ringing ruins the operating point of an imported circuit.
const BACK_EULER = 2;

export function buildSpiceParts(nl: SpiceNetlist): SpicePart[] {
    return nl.elements.map(el => {
        const part = (className: string, dump: string): SpicePart =>
            ({ className, nodes: el.nodes, dump, line: el.line });
        switch (el.type) {
            case "r":
                return part("ResistorElm", "0 " + num(resistorValue(el)));
            case "c":
                return part("CapacitorElm", `${BACK_EULER} ${num(elementValue(el))} 0 0`);
            case "l":
                return part("InductorElm", `${BACK_EULER} ${num(elementValue(el))} 0`);
            // SPICE puts the higher node first, CircuitJS the last, so the sign is
            // flipped instead of swapping the nodes (which keeps F/H simple)
            case "v":
                return part("VoltageElm", `0 0 0 ${num(-elementValue(el))}`);
            case "i":
                return part("CurrentElm", "0 " + num(elementValue(el)));
            default:
                throw new SpiceParseError(`element type "${el.type}" is not supported yet`, el.line);
        }
    });
}

// The strings SubcircuitModel.createModelFromOldFormat() takes.
export function toOldFormatModel(parts: SpicePart[]): { nodeList: string; elmDump: string } {
    return {
        nodeList: parts.map(p => p.className + " " + p.nodes.join(" ")).join("\r"),
        elmDump: parts.map(p => CustomLogicModel.escape(p.dump)).join(" "),
    };
}