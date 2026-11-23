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

// Tokenizer for SPICE netlists, ported from BetterStringTokenizer.java.
// Every delimiter character is a token of its own, so callers can walk
// "name=value(1)" without regexes.  Tokens come back lower-cased, or with
// their original case for names that are shown to the user.

export class SpiceTokenizer {
    private text: string;
    private delim: string;
    private pos = 0;

    constructor(text: string, delim: string) {
        this.text = text;
        this.delim = delim;
        this.skipBlanks();
    }

    setDelimiters(delim: string): void {
        this.delim = delim;
    }

    hasMoreTokens(): boolean {
        return this.pos < this.text.length;
    }

    nextToken(): string {
        return this.nextTokenPreserveCase().toLowerCase();
    }

    nextTokenPreserveCase(): string {
        if (this.pos >= this.text.length)
            return "";
        const start = this.pos;
        let i = start + 1;
        if (this.delim.indexOf(this.text[start]) < 0) {
            while (i < this.text.length && this.delim.indexOf(this.text[i]) < 0)
                i++;
        }
        this.pos = i;
        this.skipBlanks();
        return this.text.substring(start, i);
    }

    private skipBlanks(): void {
        while (this.pos < this.text.length && (this.text[this.pos] === " " || this.text[this.pos] === "\t"))
            this.pos++;
    }
}