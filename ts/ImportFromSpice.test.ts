import { describe, it, expect } from "vitest";
import { SpiceTokenizer } from "./SpiceTokenizer";
import { buildSpiceParts, parseSpiceNetlist, parseSpiceValue, SpiceParseError, toOldFormatModel } from "./ImportFromSpice";

function tokens(text: string, delim: string): string[] {
    const st = new SpiceTokenizer(text, delim);
    const out: string[] = [];
    while (st.hasMoreTokens())
        out.push(st.nextToken());
    return out;
}

describe("SpiceTokenizer", () => {
    it("splits a brace expression, a plain Java tokenizer would not", () => {
        // Java's version cannot: it has no way to keep "{" as its own token here
        expect(tokens("i={v(2)*2}", " \t\f{}=()*+/,")).toEqual(
            ["i", "=", "{", "v", "(", "2", ")", "*", "2", "}"]);
    });

    it("keeps the original case on request", () => {
        const st = new SpiceTokenizer("QNPN bf=100", " \t=");
        expect(st.nextToken()).toBe("qnpn");
        const st2 = new SpiceTokenizer("QNPN bf=100", " \t=");
        expect(st2.nextTokenPreserveCase()).toBe("QNPN");
    });

    it("switches delimiters mid-stream", () => {
        const st = new SpiceTokenizer("out 0 v(1,2)", " \t");
        expect(st.nextToken()).toBe("out");
        expect(st.nextToken()).toBe("0");
        st.setDelimiters(" \t(,)");
        expect(st.nextToken()).toBe("v");
        expect(st.nextToken()).toBe("(");
        expect(st.nextToken()).toBe("1");
        expect(st.nextToken()).toBe(",");
        expect(st.nextToken()).toBe("2");
        expect(st.nextToken()).toBe(")");
        expect(st.hasMoreTokens()).toBe(false);
        expect(st.nextToken()).toBe("");
    });
});

const NETLIST = `
* simple divider
.subckt divider in out

r1 in out 1k
r2 out 0 2k
c1 out 0 10n
v1 in 0 dc 5
.model QNPN npn (bf=100 is=1e-16)
.ends
`;

describe("parseSpiceNetlist", () => {
    it("names the subcircuit and lists its pins", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(nl.subcircuitName).toBe("divider");
        expect(nl.extList.map(e => e.name)).toEqual(["in", "out"]);
    });

    it("numbers nodes in order of first mention and keeps 0 out of the table", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(nl.nodes).toEqual(["in", "out"]);
        expect(nl.nodeIndex("in")).toBe(1);
        expect(nl.nodeIndex("out")).toBe(2);
        expect(nl.nodeIndex("0")).toBe(0);
    });

    it("builds the element list with resolved nodes and raw rest", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(nl.elements.map(e => e.name)).toEqual(["r1", "r2", "c1", "v1"]);
        expect(nl.elements[0].nodes).toEqual([1, 2]);
        expect(nl.elements[0].rest).toEqual(["1k"]);
        expect(nl.elements[1].nodes).toEqual([2, 0]);
        expect(nl.elements[3].rest).toEqual(["dc", "5"]);
    });

    it("collects model cards with their parameters", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(nl.models.length).toBe(1);
        expect(nl.models[0].name).toBe("QNPN");
        expect(nl.models[0].type).toBe("npn");
        expect(nl.models[0].params).toEqual({ bf: "100", is: "1e-16" });
    });

    it("joins continuation lines, so a wrapped .model equals a single-line one", () => {
        const wrapped = `
.subckt t a b
.model QNPN npn (bf=100
+ is=1e-16)
q1 a b 0 QNPN
.ends
`;
        const single = `
.subckt t a b
.model QNPN npn (bf=100 is=1e-16)
q1 a b 0 QNPN
.ends
`;
        const a = parseSpiceNetlist(wrapped);
        const b = parseSpiceNetlist(single);
        const strip = (nl: ReturnType<typeof parseSpiceNetlist>) => ({
            models: nl.models.map(({ line, ...m }) => m),
            elements: nl.elements.map(({ line, ...e }) => e),
        });
        expect(a.models.length).toBe(1);
        expect(strip(a)).toEqual(strip(b));
        expect(a.models[0].params).toEqual({ bf: "100", is: "1e-16" });
    });

    it("renames external pins positionally", () => {
        const nl = parseSpiceNetlist(`
.subckt amp in out vcc vee
.rename EIN AUS VCC VEE
r1 in out 1k
r2 out 0 1k
r3 vcc 0 1k
r4 vee 0 1k
.ends
`);
        expect(nl.extList.map(e => e.name)).toEqual(["EIN", "AUS", "VCC", "VEE"]);
        expect(nl.extList.map(e => e.node)).toEqual([1, 2, 3, 4]);
        expect(nl.extList.length).toBe(4);
    });

    it("takes four nodes for E and G sources", () => {
        const nl = parseSpiceNetlist(`
.subckt t a b c
e1 a b c 0 2
g1 a b c 0 1m
r1 c 0 1k
.ends
`);
        expect(nl.elements[0].nodes).toEqual([1, 2, 3, 0]);
        expect(nl.elements[1].nodes).toEqual([1, 2, 3, 0]);
    });

    it("stops reading pins at params:", () => {
        const nl = parseSpiceNetlist(`
.subckt t a b params: gain=2
r1 a b 1k
.ends
`);
        expect(nl.extList.map(e => e.name)).toEqual(["a", "b"]);
        expect(nl.nodes).toEqual(["a", "b"]);
    });

    it("reports the line and token for a missing node", () => {
        const broken = `.subckt t a b
r1 a 0 1k
q1 a b
.ends
`;
        let err: unknown;
        try { parseSpiceNetlist(broken); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(SpiceParseError);
        expect((err as SpiceParseError).line).toBe(3);
        expect((err as Error).message).toBe('line 3: element "q1" has 2 node(s), expected 3');
    });

    it("reports an unknown element type with its line", () => {
        let err: unknown;
        try {
            parseSpiceNetlist(`.subckt t a
z1 a 0 1k
.ends
`);
        } catch (e) { err = e; }
        expect((err as Error).message).toBe('line 2: unknown element type "z"');
    });

    it("refuses a node that was never declared instead of grounding it", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(() => nl.nodeIndex("nope")).toThrow(SpiceParseError);
        expect(() => nl.nodeIndex("nope")).toThrow('node "nope" was never declared');
    });

    it("refuses a netlist without a .subckt", () => {
        expect(() => parseSpiceNetlist("r1 a 0 1k\n")).toThrow("no .subckt found in the netlist");
    });
});
describe("parseSpiceValue", () => {
    it("reads the SPICE multipliers, where M is milli", () => {
        expect(parseSpiceValue("10k")).toBeCloseTo(1e4, 9);
        expect(parseSpiceValue("2k2")).toBeCloseTo(2200, 9);
        expect(parseSpiceValue("1MEG")).toBeCloseTo(1e6, 3);
        expect(parseSpiceValue("1M")).toBeCloseTo(1e-3, 12);
        expect(parseSpiceValue("10u")).toBeCloseTo(1e-5, 15);
        expect(parseSpiceValue("4k7")).toBeCloseTo(4700, 9);
        expect(parseSpiceValue("1e-3")).toBeCloseTo(1e-3, 12);
        expect(parseSpiceValue("2.5")).toBe(2.5);
    });

    it("ignores unit letters after the multiplier", () => {
        expect(parseSpiceValue("10uF")).toBe(parseSpiceValue("10u"));
        expect(parseSpiceValue("5V")).toBe(5);
        expect(parseSpiceValue("1nF")).toBeCloseTo(1e-9, 15);
    });

    it("rejects what is not a number", () => {
        expect(() => parseSpiceValue("rmod")).toThrow('not a number: "rmod"');
    });
});

describe("buildSpiceParts", () => {
    const netlist = (body: string) => parseSpiceNetlist(`.subckt t a b\n${body}\n.ends\n`);

    it("builds the passives with their values", () => {
        const parts = buildSpiceParts(netlist("r1 a b 2k2\nc1 b 0 10uF\nl1 a b 1m"));
        expect(parts.map(p => p.className)).toEqual(["ResistorElm", "CapacitorElm", "InductorElm"]);
        expect(parts[0].dump).toBe("0 2200");
        expect(parts[1].dump).toBe("2 0.00001 0 0");
        expect(parts[2].dump).toBe("2 0.001 0");
    });

    it("gives capacitors and inductors the backward-Euler flag", () => {
        const parts = buildSpiceParts(netlist("c1 a b 1u\nl1 a b 1m"));
        for (const p of parts)
            expect(p.dump.split(" ")[0]).toBe("2");
    });

    it("skips a resistor model name in front of the value", () => {
        const parts = buildSpiceParts(netlist("r1 a b rmod 1k"));
        expect(parts[0].dump).toBe("0 1000");
    });

    it("flips the sign of a voltage source, not its nodes", () => {
        const parts = buildSpiceParts(netlist("v1 a 0 dc 5"));
        expect(parts[0].className).toBe("VoltageElm");
        expect(parts[0].nodes).toEqual([1, 0]);
        expect(parts[0].dump).toBe("0 0 0 -5");
    });

    it("builds a current source, with DC or without", () => {
        expect(buildSpiceParts(netlist("i1 a 0 dc 1m"))[0].dump).toBe("0 0.001");
        expect(buildSpiceParts(netlist("i1 a 0 1m"))[0].dump).toBe("0 0.001");
    });

    it("names the element types it does not handle yet", () => {
        expect(() => buildSpiceParts(netlist("b1 a 0 v=1"))).toThrow('element type "b" is not supported yet');
    });
});

describe("voltage source registry", () => {
    it("finds the nodes of a source by name", () => {
        const nl = parseSpiceNetlist(`
.subckt t a b c
v1 vcc 0 dc 5
h1 out 0 v1 10
r1 out 0 1k
r2 vcc 0 1k
.ends
`);
        expect(nl.voltageSourceNodes("v1")).toEqual([4, 0]);
        expect(nl.voltageSourceNodes("V1")).toEqual([4, 0]);
    });

    it("says so when the name is unknown", () => {
        const nl = parseSpiceNetlist(NETLIST);
        expect(() => nl.voltageSourceNodes("v9")).toThrow('no voltage source named "v9"');
    });
});

describe("toOldFormatModel", () => {
    it("writes the nodeList/elmDump pair SubcircuitModel loads", () => {
        const nl = parseSpiceNetlist(`.subckt t a b\nr1 a b 1k\nc1 b 0 1u\n.ends\n`);
        const { nodeList, elmDump } = toOldFormatModel(buildSpiceParts(nl));
        expect(nodeList).toBe("ResistorElm 1 2\rCapacitorElm 2 0");
        // one token per element, spaces escaped so the tokenizer keeps them together
        expect(elmDump).toBe("0\\s1000 2\\s0.000001\\s0\\s0");
    });
});
