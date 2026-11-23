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
import { DiodeModel } from "./DiodeModel";
import { TransistorModel } from "./TransistorModel";

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
    voltageSourceNodes(name: string, line?: number): [number, number];
}

// A .model card in the terms the model registries need.  Building one does not
// register anything: the dialog only calls registerSpiceModels() when the user
// confirms, so cancelling leaves no models behind.
export interface SpiceModelSpec {
    kind: "diode" | "transistor" | "jfet";
    name: string;                    // <subcircuit>-<card name>, plus -A<area> for a variant
    params: Record<string, number>;  // field names of the CircuitJS model class
    polarity?: number;               // transistor: 1 = npn, -1 = pnp
    beta?: number;                   // transistor: forward beta, which lives on the element
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

// "poly(2)" -> 2
function polyDim(token: string, line: number): number {
    const m = /^poly\((\d+)\)$/i.exec(token);
    if (m == null)
        throw new SpiceParseError(`cannot read the POLY order from "${token}"`, line);
    return Number(m[1]);
}

function readNodes(count: number, st: SpiceTokenizer, name: string, line: number): string[] {
    const nodes: string[] = [];
    for (let i = 0; i < count; i++) {
        if (!st.hasMoreTokens())
            throw new SpiceParseError(`element "${name}" has ${i} node(s), expected ${count}`, line);
        nodes.push(st.nextToken());
    }
    return nodes;
}

// The node tokens of an element line.  E and G are the awkward ones: after the
// output pair comes either POLY(n) with 2n control nodes, VALUE={...} with none,
// or two control nodes.
function readElementNodes(type: string, st: SpiceTokenizer, name: string, line: number):
        { nodes: string[], poly?: string } {
    if (type !== "e" && type !== "g")
        return { nodes: readNodes(nodeCountFor(type, line), st, name, line) };
    const nodes = readNodes(2, st, name, line);
    const peek = st.peekToken();
    let poly: string | undefined;
    if (peek === "poly" || peek.startsWith("poly(")) {
        st.nextToken();
        poly = peek;
        if (peek === "poly") {
            // this tokenizer splits the parentheses off, so read "(" dim ")"
            st.nextToken();
            poly = "poly(" + st.nextToken() + ")";
            st.nextToken();
        }
        nodes.push(...readNodes(2 * polyDim(poly, line), st, name, line));
    } else if (!peek.startsWith("value")) {
        nodes.push(...readNodes(2, st, name, line));
    }
    return { nodes, poly };
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
            if (!st.hasMoreTokens())
                throw new SpiceParseError(".model needs a name and a type", ll.line);
            const name = st.nextTokenPreserveCase();
            if (!st.hasMoreTokens())
                throw new SpiceParseError(".model needs a name and a type", ll.line);
            const type = st.nextToken();
            const params: Record<string, string> = {};
            while (st.hasMoreTokens()) {
                // some netlists separate parameters with commas
                const tok = st.nextTokenPreserveCase().replace(/,$/, "");
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
        for (const node of readElementNodes(type, st, first, ll.line).nodes)
            addNode(node);
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
        const read = readElementNodes(type, st, name, ll.line);
        const elementNodes = read.nodes.map(n => nodeIndex(n));
        const rest: string[] = read.poly === undefined ? [] : [read.poly];
        while (st.hasMoreTokens())
            rest.push(st.nextTokenPreserveCase());
        elements.push({ name, type, nodes: elementNodes, rest, line: ll.line });
        if (type === "v")
            voltageSources.set(name, [elementNodes[0], elementNodes[1]]);
    }

    if (subcircuitName === "")
        throw new SpiceParseError("no .subckt found in the netlist");

    const voltageSourceNodes = (name: string, line?: number): [number, number] => {
        const vs = voltageSources.get(name.toLowerCase());
        if (vs == null)
            throw new SpiceParseError(`no voltage source named "${name}"`, line);
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

// SPICE card parameter -> TransistorModel field.  vaf/var/ikf/ikr are stored as
// reciprocals in CircuitJS, so they are converted instead of copied.
const TRANSISTOR_PARAMS: Record<string, string> = {
    is: "satCur", br: "betaR", ne: "leakBEemissionCoeff", nc: "leakBCemissionCoeff",
    nf: "emissionCoeffF", nr: "emissionCoeffR", ise: "BEleakCur", isc: "BCleakCur",
};
const TRANSISTOR_RECIPROCALS: Record<string, string> = {
    vaf: "invEarlyVoltF", var: "invEarlyVoltR", ikf: "invRollOffF", ikr: "invRollOffR",
};
const DIODE_PARAMS: Record<string, string> = {
    is: "saturationCurrent", rs: "seriesResistance", n: "emissionCoefficient", bv: "breakdownVoltage",
};

function modelCardFor(nl: SpiceNetlist, name: string, line: number): SpiceModelCard {
    const card = nl.models.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (card == null)
        throw new SpiceParseError(`no .model named "${name}"`, line);
    return card;
}

function diodeSpec(nl: SpiceNetlist, card: SpiceModelCard): SpiceModelSpec {
    const params: Record<string, number> = {};
    for (const [key, field] of Object.entries(DIODE_PARAMS))
        if (card.params[key] !== undefined)
            params[field] = parseSpiceValue(card.params[key], card.line);
    return { kind: "diode", name: nl.subcircuitName + "-" + card.name, params };
}

function transistorSpec(nl: SpiceNetlist, card: SpiceModelCard, area: number): SpiceModelSpec {
    const params: Record<string, number> = { satCur: 1e-16 };   // Java's default
    for (const [key, field] of Object.entries(TRANSISTOR_PARAMS))
        if (card.params[key] !== undefined)
            params[field] = parseSpiceValue(card.params[key], card.line);
    for (const [key, field] of Object.entries(TRANSISTOR_RECIPROCALS))
        if (card.params[key] !== undefined)
            params[field] = 1 / parseSpiceValue(card.params[key], card.line);
    if (area !== 1) {
        // a bigger device: more leakage current, less roll-off
        params.satCur *= area;
        params.BEleakCur *= area;
        params.BCleakCur *= area;
        params.invRollOffF /= area;
        params.invRollOffR /= area;
    }
    const beta = card.params["bf"] !== undefined ? parseSpiceValue(card.params["bf"], card.line) : 100;
    const name = nl.subcircuitName + "-" + card.name + (area === 1 ? "" : "-A" + area);
    const polarity = card.type === "pnp" ? -1 : 1;
    return { kind: "transistor", name, params, polarity, beta };
}

function jfetSpec(nl: SpiceNetlist, card: SpiceModelCard): SpiceModelSpec {
    const params: Record<string, number> = {};
    for (const key of ["vto", "beta"])
        if (card.params[key] !== undefined)
            params[key] = parseSpiceValue(card.params[key], card.line);
    // SPICE has Id = beta*(vgs-vt)^2, CircuitJS 0.5*beta*(vgs-vt)^2
    if (params.beta !== undefined)
        params.beta *= 2;
    return {
        kind: "jfet", name: nl.subcircuitName + "-" + card.name, params,
        polarity: card.type === "pjf" ? -1 : 1,
    };
}

// The model an element line names: the token right after its nodes, for d, q and j.
function modelNameOf(el: SpiceElement): string {
    return el.rest[0];
}

// The area= of a q line, defaulting to 1.  SPICE also allows a bare number.
function areaOf(el: SpiceElement): number {
    const token = el.rest[1];
    if (token === undefined)
        return 1;
    const value = token.toLowerCase().startsWith("area=") ? token.substring(5) : token;
    const area = parseSpiceValue(value, el.line);
    if (!(area > 0))
        throw new SpiceParseError(`area must be positive, got "${token}"`, el.line);
    return area;
}

// the registry name an element's model gets: prefixed with the subcircuit, plus
// the area suffix for a transistor variant
function specNameFor(nl: SpiceNetlist, el: SpiceElement): string {
    const base = nl.subcircuitName + "-" + modelNameOf(el);
    return el.type === "q" && areaOf(el) !== 1 ? base + "-A" + areaOf(el) : base;
}

export function buildSpiceModels(nl: SpiceNetlist): SpiceModelSpec[] {
    const specs = new Map<string, SpiceModelSpec>();
    for (const el of nl.elements) {
        if (el.type !== "d" && el.type !== "q" && el.type !== "j")
            continue;
        const name = modelNameOf(el);
        if (name === undefined)
            throw new SpiceParseError(`element "${el.name}" names no model`, el.line);
        const card = modelCardFor(nl, name, el.line);
        let spec: SpiceModelSpec;
        if (el.type === "d")
            spec = diodeSpec(nl, card);
        else if (el.type === "q")
            spec = transistorSpec(nl, card, areaOf(el));
        else if (el.type === "j")
            spec = jfetSpec(nl, card);
        else
            continue;
        specs.set(spec.name, spec);
    }
    return [...specs.values()];
}

// Only called when the user confirms the import.  The models go into the local
// registry tier, so they travel with the circuit and not into the global list.
export function registerSpiceModels(specs: SpiceModelSpec[]): void {
    for (const spec of specs) {
        if (spec.kind === "diode") {
            const dm = new DiodeModel();
            dm.name = spec.name;
            Object.assign(dm, spec.params);
            dm.updateModel();
            DiodeModel.registry.setLocal(dm);
        } else if (spec.kind === "transistor") {
            const tm = new TransistorModel();
            tm.name = spec.name;
            Object.assign(tm, spec.params);
            tm.updateModel();
            TransistorModel.registry.setLocal(tm);
        }
        // a JFET carries its vto/beta on the element, so there is no model to register
    }
}

// Capacitors and inductors get FLAG_BACK_EULER (2): SPICE models assume backward
// Euler, and trapezoidal ringing ruins the operating point of an imported circuit.
const BACK_EULER = 2;

const LETTERS = "abcdefghi";

function letterFor(index: number, line: number): string {
    if (index >= LETTERS.length)
        throw new SpiceParseError("more than 9 expression inputs are not supported", line);
    return LETTERS[index];
}

// Turns SPICE's v(a) and v(a,b) into CircuitJS expression inputs: every referenced
// node becomes one input pin, in the order the expression first mentions it.
function convertSpiceExpr(text: string, nl: SpiceNetlist, line: number): { expr: string, inputs: number[] } {
    const inputs: number[] = [];
    let expr = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "{" || c === "}" || c === " " || c === "\t")
            continue;
        if (/[0-9.]/.test(c)) {
            // SPICE numbers carry suffixes (1m, 2k2, 10uF); the expression parser does not
            const m = /^(\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:[a-z]+\d*)?/i.exec(text.substring(i));
            const token = m![0];
            expr += num(parseSpiceValue(token, line));
            i += token.length - 1;
            continue;
        }
        if (!/[A-Za-z_]/.test(c)) {
            expr += c;
            continue;
        }
        let j = i;
        while (j < text.length && /[A-Za-z_0-9]/.test(text[j]))
            j++;
        const word = text.substring(i, j).toLowerCase();
        if (text[j] === "(" && (word === "v" || word === "i")) {
            if (word === "i")
                throw new SpiceParseError("i() references are not supported yet", line);
            const close = text.indexOf(")", j);
            if (close < 0)
                throw new SpiceParseError("unbalanced v( in the expression", line);
            const args = text.substring(j + 1, close).split(",").map(a => a.trim());
            if (args.length === 1) {
                inputs.push(nl.nodeIndex(args[0]));
                expr += letterFor(inputs.length - 1, line);
            } else if (args.length === 2) {
                inputs.push(nl.nodeIndex(args[0]), nl.nodeIndex(args[1]));
                expr += `(${letterFor(inputs.length - 2, line)}-${letterFor(inputs.length - 1, line)})`;
            } else
                throw new SpiceParseError(`v() takes one or two nodes, got ${args.length}`, line);
            i = close;
            continue;
        }
        expr += word;
        i = j - 1;
    }
    return { expr, inputs };
}

// POLY(n): c0 + c1*x1 + ... + quadratic cross terms for n = 2.  Higher orders are
// not expressible here yet, and saying so beats a silently wrong expression.
function polyExpr(dim: number, coeffs: number[], inputs: string[], line: number): string {
    if (dim > 2)
        throw new SpiceParseError(`POLY(${dim}) is not supported yet`, line);
    const terms: string[] = [];
    if (coeffs[0])
        terms.push(num(coeffs[0]));
    for (let i = 1; i <= dim; i++)
        if (coeffs[i])
            terms.push(`${num(coeffs[i])}*${inputs[i - 1]}`);
    if (dim === 2) {
        const pairs = [[0, 0], [0, 1], [1, 1]];
        for (let k = 0; k < 3; k++) {
            const c = coeffs[3 + k];
            if (c)
                terms.push(`${num(c)}*${inputs[pairs[k][0]]}*${inputs[pairs[k][1]]}`);
        }
    }
    return terms.length ? terms.join("+") : "0";
}

export function buildSpiceParts(nl: SpiceNetlist, specs: SpiceModelSpec[] = buildSpiceModels(nl)): SpicePart[] {
    const byName = new Map(specs.map(s => [s.name, s]));
    const specFor = (el: SpiceElement): SpiceModelSpec => {
        const spec = byName.get(specNameFor(nl, el));
        if (spec == null)
            throw new SpiceParseError(`model "${modelNameOf(el)}" was not built`, el.line);
        return spec;
    };
    const parts: SpicePart[] = [];
    // nodes the model needs beyond the netlist's own: bulk resistors, junction caps
    let extraNode = nl.nodes.length + 1;
    for (const el of nl.elements) {
        const part = (className: string, nodes: number[], dump: string) =>
            parts.push({ className, nodes, dump, line: el.line });
        switch (el.type) {
            case "r":
                part("ResistorElm", el.nodes, "0 " + num(resistorValue(el)));
                break;
            case "c":
                part("CapacitorElm", el.nodes, `${BACK_EULER} ${num(elementValue(el))} 0 0`);
                break;
            case "l":
                part("InductorElm", el.nodes, `${BACK_EULER} ${num(elementValue(el))} 0`);
                break;
            // SPICE puts the higher node first, CircuitJS the last, so the sign is
            // flipped instead of swapping the nodes (which keeps F/H simple)
            case "v":
                part("VoltageElm", el.nodes, `0 0 0 ${num(-elementValue(el))}`);
                break;
            case "i":
                part("CurrentElm", el.nodes, "0 " + num(elementValue(el)));
                break;
            case "d":
                part("DiodeElm", el.nodes, "2 " + specFor(el).name);
                break;
            // E (VCVS) and G (VCCS): out+, out-, then control nodes, POLY() or VALUE=
            case "e":
            case "g": {
                const head = el.rest[0] ?? "";
                let inputs: number[], expr: string;
                if (head.toLowerCase().startsWith("poly")) {
                    const dim = polyDim(head, el.line);
                    const pairs: string[] = [];
                    for (let k = 0; k < dim; k++)
                        pairs.push(`(${letterFor(2 * k, el.line)}-${letterFor(2 * k + 1, el.line)})`);
                    inputs = el.nodes.slice(2);
                    expr = polyExpr(dim, el.rest.slice(1).map(t => parseSpiceValue(t, el.line)), pairs, el.line);
                } else if (head.toLowerCase().startsWith("value=")) {
                    const body = el.rest.join(" ").substring("value=".length);
                    ({ expr, inputs } = convertSpiceExpr(body, nl, el.line));
                } else {
                    inputs = [el.nodes[2], el.nodes[3]];
                    expr = `${num(parseSpiceValue(head, el.line))}*(a-b)`;
                }
                const voltage = el.type === "e";
                part(voltage ? "VCVSElm" : "VCCSElm",
                    [...inputs, voltage ? el.nodes[0] : el.nodes[1], voltage ? el.nodes[1] : el.nodes[0]],
                    `0 ${inputs.length} ${expr}`);
                break;
            }
            // F (CCCS) and H (CCVS) sense the current through a named voltage source
            case "f":
            case "h": {
                const head = el.rest[0] ?? "";
                let inputs: number[], expr: string;
                if (head.toLowerCase().startsWith("poly")) {
                    const dim = polyDim(head, el.line);
                    const names = el.rest.slice(1, 1 + dim);
                    inputs = names.flatMap(n => nl.voltageSourceNodes(n, el.line));
                    const exprs = names.map((_, k) => letterFor(k, el.line));
                    expr = polyExpr(dim, el.rest.slice(1 + dim).map(t => parseSpiceValue(t, el.line)), exprs, el.line);
                } else {
                    inputs = nl.voltageSourceNodes(head, el.line);
                    expr = `${num(parseSpiceValue(el.rest[1], el.line))}*a`;
                }
                const voltage = el.type === "h";
                part(voltage ? "CCVSElm" : "CCCSElm",
                    [...inputs, voltage ? el.nodes[0] : el.nodes[1], voltage ? el.nodes[1] : el.nodes[0]],
                    `2 ${inputs.length} ${expr}`);
                break;
            }
            // B source: I={...} is a current source, V={...} a voltage source
            case "b": {
                const text = el.rest.join(" ");
                const eq = text.indexOf("=");
                const kind = eq < 0 ? "" : text.substring(0, eq).trim().toLowerCase();
                if (kind !== "i" && kind !== "v")
                    throw new SpiceParseError(`B source with "${kind}=" is not supported yet`, el.line);
                const { expr, inputs } = convertSpiceExpr(text.substring(eq + 1), nl, el.line);
                const voltage = kind === "v";
                part(voltage ? "VCVSElm" : "VCCSElm",
                    [...inputs, voltage ? el.nodes[0] : el.nodes[1], voltage ? el.nodes[1] : el.nodes[0]],
                    `0 ${inputs.length} ${expr}`);
                break;
            }
            case "q": {
                const spec = specFor(el);
                const area = areaOf(el);
                const card = modelCardFor(nl, modelNameOf(el), el.line);
                const value = (key: string) => card.params[key] === undefined
                    ? 0 : parseSpiceValue(card.params[key], card.line);
                const rc = value("rc"), rb = value("rb"), re = value("re");
                const cje = value("cje"), cjc = value("cjc");
                let [collector, base, emitter] = el.nodes;
                // SPICE's rc/rb/re are the bulk resistances of the terminals; they are
                // real resistors between the terminal and the intrinsic transistor
                if (rc > 0) { const n = extraNode++; part("ResistorElm", [collector, n], "0 " + num(rc / area)); collector = n; }
                if (rb > 0) { const n = extraNode++; part("ResistorElm", [base, n], "0 " + num(rb / area)); base = n; }
                if (re > 0) { const n = extraNode++; part("ResistorElm", [emitter, n], "0 " + num(re / area)); emitter = n; }
                if (cje > 0) part("CapacitorElm", [base, emitter], `${BACK_EULER} ${num(cje * area)} 0 0`);
                if (cjc > 0) part("CapacitorElm", [base, collector], `${BACK_EULER} ${num(cjc * area)} 0 0`);
                part("TransistorElm", [base, collector, emitter],
                    `0 ${spec.polarity} 0 0 ${num(spec.beta!)} ${spec.name}`);
                break;
            }
            case "j": {
                const spec = specFor(el);
                // SPICE writes drain gate source, CircuitJS draws gate source drain
                const [drain, gate, source] = el.nodes;
                const pnp = spec.polarity === -1 ? 1 : 0;
                part("JfetElm", [gate, source, drain],
                    `${pnp} ${num(spec.params.vto ?? 0)} ${num(spec.params.beta ?? 0)}`);
                break;
            }
            default:
                throw new SpiceParseError(`element type "${el.type}" is not supported yet`, el.line);
        }
    }
    return parts;
}

// The strings SubcircuitModel.createModelFromOldFormat() takes.
export function toOldFormatModel(parts: SpicePart[]): { nodeList: string; elmDump: string } {
    return {
        nodeList: parts.map(p => p.className + " " + p.nodes.join(" ")).join("\r"),
        elmDump: parts.map(p => CustomLogicModel.escape(p.dump)).join(" "),
    };
}