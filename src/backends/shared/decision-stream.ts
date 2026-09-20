// ---------------------------------------------------------------------------
// Incremental scanner for the clientTools decision JSON.
//
// The decision contract asks the model for raw JSON:
//   {"type":"function_call","calls":[{"name":...,"arguments":{...}}]}
//   {"type":"text","text":"<the answer>"}
//
// To stream the final answer token by token we cannot wait for the whole
// object: we scan the raw text as it arrives, and as soon as the top-level
// `type` is `text` we decode the `text` string value incrementally and hand
// the decoded characters to the SSE stream. Function-call decisions are
// accumulated (the tool call itself is not streamed to the client).
//
// The scanner tracks object depth so a `"type"` or `"text"` key nested inside
// tool arguments can never be mistaken for the top-level decision field.
// ---------------------------------------------------------------------------

type StringRole = 'key' | 'value' | 'skip';

export class DecisionStreamScanner {
  private raw = '';
  private pos = 0;
  private depth = 0;
  private mode: 'key' | 'value' = 'key';
  private currentKey = '';
  private keyBuffer = '';
  private typeBuffer = '';
  private stringRole: StringRole | null = null;
  private escapePending = false;
  private unicodeBuf: string | null = null;
  private decodedText = '';
  private type: string | null = null;
  private done = false;

  /** Top-level decision type once the scanner has seen it. */
  get decisionType(): 'text' | 'function_call' | null {
    return this.type === 'text' || this.type === 'function_call' ? this.type : null;
  }

  /** Characters of the `text` value already decoded and returned. */
  get emittedLength(): number {
    return this.decodedText.length;
  }

  /**
   * The decoded `text` value seen so far. Used to salvage a partial answer
   * when the surrounding decision JSON turns out to be invalid.
   */
  get decoded(): string {
    return this.decodedText;
  }

  get rawText(): string {
    return this.raw;
  }

  /**
   * Feeds newly arrived raw model text. Returns the newly decoded answer
   * characters (empty string when nothing is safe to emit yet).
   */
  push(chunk: string): string {
    if (!chunk || this.done) return '';
    this.raw += chunk;
    let out = '';
    while (this.pos < this.raw.length && !this.done) {
      const ch = this.raw[this.pos] as string;
      this.pos += 1;
      out += this.stringRole ? this.consumeStringChar(ch) : this.consumeStructuralChar(ch);
    }
    return out;
  }

  private consumeStructuralChar(ch: string): string {
    if (this.depth === 0) {
      if (ch === '{') {
        this.depth = 1;
        this.mode = 'key';
      } else if (ch === '[') {
        this.depth = 1;
        this.mode = 'value';
      }
      return '';
    }
    if (ch === '{' || ch === '[') {
      this.depth += 1;
      return '';
    }
    if (ch === '}' || ch === ']') {
      this.depth -= 1;
      if (this.depth === 0) {
        this.done = true;
      } else if (this.depth === 1) {
        this.mode = 'key';
        this.currentKey = '';
      }
      return '';
    }
    if (ch === '"') {
      if (this.depth === 1 && this.mode === 'key') {
        this.keyBuffer = '';
        this.startString('key');
      } else if (this.depth === 1) {
        this.startString('value');
      } else {
        this.startString('skip');
      }
      return '';
    }
    if (this.depth !== 1) return '';
    if (ch === ':') {
      this.mode = 'value';
    } else if (ch === ',') {
      this.mode = 'key';
      this.currentKey = '';
    }
    return '';
  }

  private startString(role: StringRole): void {
    this.stringRole = role;
    this.escapePending = false;
    this.unicodeBuf = null;
    if (role === 'key') this.keyBuffer = '';
    if (role === 'value' && this.currentKey === 'type') this.typeBuffer = '';
  }

  private consumeStringChar(ch: string): string {
    if (this.escapePending) {
      if (this.unicodeBuf !== null) {
        this.unicodeBuf += ch;
        if (this.unicodeBuf.length === 4) {
          if (/^[0-9a-fA-F]{4}$/.test(this.unicodeBuf)) {
            const decoded = String.fromCharCode(parseInt(this.unicodeBuf, 16));
            this.unicodeBuf = null;
            this.escapePending = false;
            return this.deliverChar(decoded);
          }
          this.done = true;
          return '';
        }
        return '';
      }
      this.escapePending = false;
      if (ch === 'u') {
        this.unicodeBuf = '';
        this.escapePending = true;
        return '';
      }
      const simple: Record<string, string> = {
        n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/',
      };
      if (!(ch in simple)) {
        this.done = true;
        return '';
      }
      return this.deliverChar(simple[ch] as string);
    }
    if (ch === '\\') {
      this.escapePending = true;
      return '';
    }
    if (ch === '"') {
      const role = this.stringRole;
      this.stringRole = null;
      if (role === 'key') {
        this.currentKey = this.keyBuffer;
        this.mode = 'value';
      } else if (role === 'value' && this.currentKey === 'type') {
        this.type = this.typeBuffer;
        this.mode = 'key';
      } else if (role === 'value' || this.depth === 1) {
        this.mode = 'key';
        this.currentKey = '';
      }
      return '';
    }
    return this.deliverChar(ch);
  }

  private deliverChar(ch: string): string {
    if (this.stringRole === 'key') {
      this.keyBuffer += ch;
      return '';
    }
    if (this.stringRole !== 'value') return '';
    if (this.currentKey === 'type') {
      this.typeBuffer += ch;
      return '';
    }
    if (this.currentKey === 'text') {
      this.decodedText += ch;
      return ch;
    }
    return '';
  }
}
