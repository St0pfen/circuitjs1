import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SPICE_IMPORT_HELP } from "./ImportFromSpiceModel";

// The strings the SPICE import dialog shows, and their translations.  Kept out of
// ImportFromSpiceDialog.test.ts because that file installs the headless DOM, whose
// global `Node` replacement upsets vitest's string matchers.

describe("dialog text", () => {
    it("states the real scope instead of just 'paste here'", () => {
        expect(SPICE_IMPORT_HELP).toContain(".subckt");
        expect(SPICE_IMPORT_HELP).toContain("DC");
        expect(SPICE_IMPORT_HELP).toContain(".tran");
        expect(SPICE_IMPORT_HELP).toContain(".ac");
        expect(SPICE_IMPORT_HELP).toContain(".include");
    });

    it("has a German label (English is the source language)", () => {
        const text = readFileSync(join(__dirname, "public", "locale", "locale_de.txt"), "utf8");
        expect(text).toContain('"Import Subcircuit From Spice..."=');
        // and the English base file carries no UI strings, only search terms
        const en = readFileSync(join(__dirname, "public", "locale", "locale_en.txt"), "utf8");
        expect(en).not.toContain('"Import Subcircuit From Spice..."=');
    });
});
