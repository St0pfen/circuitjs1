import { describe, it, expect } from "vitest";
import { buildSpiceParts, parseSpiceNetlist, SpiceParseError } from "./ImportFromSpice";
import { SpiceTokenizer } from "./SpiceTokenizer";

// Edge cases for TP1 (parser core) and TP2 (passives & sources) that the
// first round of tests did not reach.

const errorOf = (text: string): SpiceParseError => {
    try {
        parseSpiceNetlist(text);
    } catch (e) {
        return e as SpiceParseError;
    }
    throw new Error("expected the parse to fail");
};

describe("tokenizer edge cases", () => {
    it("treats every delimiter character as its own token", () => {
        const st = new SpiceTokenizer("=()", "=()");
        expect([st.nextToken(), st.nextToken(), st.nextToken()]).toEqual(["=", "(", ")"]);
        expect(st.hasMoreTokens()).toBe(false);
    });

    it("returns an empty token at the end instead of looping", () => {
        const st = new SpiceTokenizer("   ", " ");
        expect(st.hasMoreTokens()).toBe(false);
        expect(st.nextToken()).toBe("");
        expect(st.nextToken()).toBe("");
    });

    it("keeps a token that starts with a delimiter intact when it is not one", () => {
        // "{" is not in the delimiter set here, so the run continues to the space
        expect(new SpiceTokenizer("{v(1)} 2", " ").nextToken()).toBe("{v(1)}");
    });

    it("skips tabs as well as spaces", () => {
        const st = new SpiceTokenizer("a\t\tb  c", " \t");
        expect([st.nextToken(), st.nextToken(), st.nextToken()]).toEqual(["a", "b", "c"]);
    });
});

describe("netlist text handling", () => {
    it("reads CRLF line endings like LF", () => {
        const nl = parseSpiceNetlist(".subckt t a b\r\nr1 a b 1k\r\n.ends\r\n");
        expect(nl.elements.map(e => e.name)).toEqual(["r1"]);
    });

    it("accepts tabs between tokens", () => {
        const nl = parseSpiceNetlist(".subckt t a b\nr1\ta\tb\t1k\n.ends\n");
        expect(nl.elements[0].rest).toEqual(["1k"]);
    });

    it("does not treat a * inside a line as a comment", () => {
        const nl = parseSpiceNetlist(".subckt t a\nb1 a 0 v={2*3}\n.ends\n");
        expect(nl.elements[0].rest).toEqual(["v={2*3}"]);
    });

    it("ignores comment lines with leading spaces", () => {
        const nl = parseSpiceNetlist(".subckt t a b\n   * a comment\nr1 a b 1k\n.ends\n");
        expect(nl.elements.length).toBe(1);
    });

    it("keeps the line number of the first physical line of a continuation", () => {
        const err = errorOf(".subckt t a b\n.model qn npn\n+ (bf=100)\nq1 a b\n.ends\n");
        expect(err.line).toBe(4);
    });
});

describe("parser edge cases", () => {
    it("treats node names case-insensitively", () => {
        const nl = parseSpiceNetlist(".subckt t A B\nr1 a B 1k\nc1 A b 1u\n.ends\n");
        expect(nl.nodes).toEqual(["a", "b"]);
        expect(nl.elements[1].nodes).toEqual([1, 2]);
    });

    it("keeps numeric node names out of the table only for 0", () => {
        const nl = parseSpiceNetlist(".subckt t\nr1 1 0 1k\nr2 1 2 1k\n.ends\n");
        expect(nl.nodes).toEqual(["1", "2"]);
        expect(nl.elements[1].nodes).toEqual([1, 2]);
    });

    it("renames only the pins it has names for", () => {
        const nl = parseSpiceNetlist(".subckt t a b c\n.rename A\nr1 a b 1k\n.ends\n");
        expect(nl.extList.map(e => e.name)).toEqual(["A", "b", "c"]);
    });

    it("refuses a .rename with more names than pins", () => {
        const err = errorOf(".subckt t a\n.rename A B\nr1 a 0 1k\n.ends\n");
        expect(err.message).toBe("line 2: .rename has more names than the 1 pins");
    });

    it("refuses a second .subckt", () => {
        const err = errorOf(".subckt t a\n.subckt u b\nr1 a 0 1k\n.ends\n");
        expect(err.message).toBe("line 2: more than one .subckt in the netlist");
    });

    it("refuses a .subckt without a name", () => {
        expect(errorOf(".subckt\nr1 a 0 1k\n.ends\n").message).toBe("line 1: .subckt without a name");
    });

    it("refuses a .model without a type", () => {
        expect(errorOf(".subckt t a\n.model dmod\n.ends\n").message).toBe("line 2: .model needs a name and a type");
    });

    it("names the element and line when a node is missing", () => {
        const err = errorOf(".subckt t a b\nr1 a\n.ends\n");
        expect(err.message).toBe('line 2: element "r1" has 1 node(s), expected 2');
    });

    it("refuses an empty netlist", () => {
        expect(errorOf("").message).toBe("no .subckt found in the netlist");
    });
});

describe("model cards", () => {
    it("reads parameters inside parentheses, with and without commas", () => {
        const nl = parseSpiceNetlist(`
.subckt t c b e
.model qn npn (is=1e-14, bf=100 , vaf=50)
q1 c b e qn
.ends
`);
        expect(nl.models[0].params).toEqual({ is: "1e-14", bf: "100", vaf: "50" });
    });

    it("reads a parameter with no space before the closing parenthesis", () => {
        const nl = parseSpiceNetlist(".subckt t a k\n.model d d(is=1e-14)\nd1 a k d\n.ends\n");
        expect(nl.models[0].params).toEqual({ is: "1e-14" });
    });

    it("keeps the card's original name case", () => {
        const nl = parseSpiceNetlist(".subckt t a k\n.model 1N4148 D (is=4.3n)\nd1 a k 1n4148\n.ends\n");
        expect(nl.models[0].name).toBe("1N4148");
    });
});

describe("values end to end", () => {
    const partsOf = (body: string) => buildSpiceParts(parseSpiceNetlist(`.subckt t a b\n${body}\n.ends\n`));

    it("reads a resistor with a MEG suffix and a shorthand", () => {
        expect(partsOf("r1 a b 1MEG")[0].dump).toBe("0 1000000");
        expect(partsOf("r1 a b 4k7")[0].dump).toBe("0 4700");
        expect(partsOf("r1 a b 1M")[0].dump).toBe("0 0.001");
    });

    it("reads capacitor and inductor values with unit letters", () => {
        expect(partsOf("c1 a b 10nF")[0].dump).toBe("2 1e-8 0 0");
        expect(partsOf("c1 a b 10n")[0].dump).toBe("2 1e-8 0 0");
        expect(partsOf("l1 a b 1mH")[0].dump).toBe("2 0.001 0");
    });

    it("takes a voltage source's value with or without DC, in either case", () => {
        expect(partsOf("v1 a 0 5")[0].dump).toBe("0 0 0 -5");
        expect(partsOf("v1 a 0 DC 5")[0].dump).toBe("0 0 0 -5");
        expect(partsOf("v1 a 0 dc 5")[0].dump).toBe("0 0 0 -5");
        expect(partsOf("v1 a 0 dc -5")[0].dump).toBe("0 0 0 5");
    });

    it("ignores what follows the value, e.g. an AC spec", () => {
        expect(partsOf("v1 a 0 dc 5 ac 1")[0].dump).toBe("0 0 0 -5");
    });

    it("says which element has no value", () => {
        const err = (() => {
            try { partsOf("r1 a b"); } catch (e) { return e as SpiceParseError; }
            throw new Error("expected a failure");
        })();
        expect(err.message).toBe('line 2: element "r1" has no value');
    });

    it("keeps every element's flags in its own dump string", () => {
        const parts = partsOf("r1 a b 1k\nc1 a b 1u\nl1 a b 1m\nv1 a 0 5\ni1 a 0 1m");
        expect(parts.map(p => p.dump.split(" ")[0])).toEqual(["0", "2", "2", "0", "0"]);
    });
});
