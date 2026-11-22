// Tiny stack VM for make.fun's ISA v1 (kit generator/subject/ISA.md).
// For each <id> in MAKEFUN_INPUT_DIR (/input): runs <id>/program.bin on
// <id>/input.bin, writes <id>/stdout.bin and <id>/exit.txt (0..255).
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode tables indexed by opcode byte: immediate length, pops, pushes.
const IMM = new Uint8Array(256), POP = new Uint8Array(256), PSH = new Uint8Array(256), KNOWN = new Uint8Array(256);
for (const [op, imm, pops, pushes] of [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
]) { IMM[op] = imm; POP[op] = pops; PSH[op] = pushes; KNOWN[op] = 1; }

const STEP_LIMIT = 1000000, OUTPUT_MAX = 65536;
const enc = new TextEncoder();

// Run one program; returns { out: Uint8Array, exit: number }.
function run(program, input) {
  const n = program.length;
  const D = new Int32Array(256); // data stack
  let sp = 0;
  const C = new Int32Array(64); // call stack
  let csp = 0;
  const M = new Int32Array(256); // memory
  const out = new Uint8Array(OUTPUT_MAX);
  let olen = 0, inPos = 0, pc = 0, steps = 0;
  const trap = (code) => ({ out: out.subarray(0, olen), exit: code });
  for (;;) {
    if (steps === STEP_LIMIT) return trap(10); // step limit
    if (pc < 0 || pc >= n) return trap(9); // pc outside the program
    const op = program[pc];
    if (!KNOWN[op]) return trap(5); // unknown opcode
    const imm = IMM[op];
    if (pc + imm >= n) return trap(9); // immediate cut off by program end
    steps++;
    const next = pc + 1 + imm;
    if (sp < POP[op]) return trap(2); // stack underflow
    if (sp - POP[op] + PSH[op] > 256) return trap(3); // stack overflow
    pc = next;
    switch (op) {
      case 0x00: return { out: out.subarray(0, olen), exit: 0 }; // HALT
      case 0x01: D[sp++] = (program[next - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian signed
        D[sp++] = program[next - 4] | (program[next - 3] << 8) | (program[next - 2] << 16) | (program[next - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG (wraps: -INT_MIN is INT_MIN)
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ, signed 16-bit offset
        const rel = ((program[next - 2] | (program[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) { const v = D[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL, unsigned 16-bit target
        if (csp === 64) return trap(7);
        C[csp++] = next;
        pc = program[next - 2] | (program[next - 1] << 8);
        break;
      case 0x34: // RET
        if (csp === 0) return trap(8);
        pc = C[--csp];
        break;
      case 0x40: { // LOAD
        const addr = D[sp - 1];
        if (addr < 0 || addr >= 256) return trap(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE (v addr --)
        const addr = D[sp - 1];
        const v = D[sp - 2];
        if (addr < 0 || addr >= 256) return trap(6);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        const bytes = enc.encode(String(D[sp - 1]));
        if (olen + bytes.length > OUTPUT_MAX) return trap(11);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51: // PUTC: one byte, low 8 bits
        if (olen + 1 > OUTPUT_MAX) return trap(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = inPos < input.length ? input[inPos++] : -1; break; // IN (-1 past end)
      case 0x53: return { out: out.subarray(0, olen), exit: D[--sp] & 255 }; // EXIT (low byte)
      default: { // binary ops 0x10-0x16, 0x18-0x1a, 0x1c-0x1e, 0x20-0x22
        const b = D[sp - 1], a = D[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b); // low 32 bits of exact product
        else if (op === 0x13) { // DIV, truncated toward zero
          if (b === 0) return trap(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) { // MOD, sign of a
          if (b === 0) return trap(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU, unsigned
          if (b === 0) return trap(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU, unsigned
          if (b === 0) return trap(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31); // arithmetic shift
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // logical shift
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp -= 2;
        D[sp++] = r;
        break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const dir = join(I, id);
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { /* not a directory */ }
  if (!isDir) continue;
  mkdirSync(join(O, id), { recursive: true });
  let result;
  try {
    result = run(readFileSync(join(dir, 'program.bin')), readFileSync(join(dir, 'input.bin')));
  } catch {
    result = { out: new Uint8Array(0), exit: 0 };
  }
  writeFileSync(join(O, id, 'stdout.bin'), result.out);
  writeFileSync(join(O, id, 'exit.txt'), String(result.exit) + '\n');
}
