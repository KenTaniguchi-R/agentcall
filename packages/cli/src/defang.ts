// The prompt in prompt.ts separates the owner's instructions from the caller's
// message with literal strings — `<<TASK-INSTRUCTIONS>>` around the SKILL.md
// body, a `---` divider before the message. Framing alone makes that separation
// a *claim in the prompt* rather than a property of the string: the caller's
// message is interpolated last and can contain the same reserved syntax, so a
// message carrying its own `<<TASK-INSTRUCTIONS>>` block arrives rendered in the
// exact form the prompt has just told the model means "the owner's instructions
// for this task".
//
// Defanging closes that by making the reserved syntax unwritable by a caller.
// It is not a classifier and does not try to detect intent — an instruction to
// do something harmful, written as ordinary prose, passes through untouched and
// is the answering agent's and the policy's problem, not this function's.

/** What a caller sees in place of neutralized syntax. Visible on purpose. */
export const FILTERED_MARKER = "[filtered]";

// Our own reserved fence. Case-insensitive and whitespace-tolerant because the
// model reads these as words, not as an exact byte sequence — `<< task-
// instructions >>` frames just as convincingly as the canonical spelling.
const RESERVED_FENCE = /<<\s*(?:END-)?TASK-INSTRUCTIONS\s*>>/gi;

// Model control tokens, matched by shape rather than by name. Enumerating
// `<|im_start|>` and friends would cover today's vocabularies and miss the next
// one; the `<|…|>` shape is what runtimes treat structurally. Bounded length and
// no newline so an unterminated `<|` in ordinary prose cannot swallow the rest
// of the message.
const CONTROL_TOKEN = /<\|[^|>\n]{0,64}\|>/g;

/**
 * Neutralize syntax a caller must not be able to write, before their message is
 * placed in the answering agent's prompt.
 *
 * Deliberately narrow. Two things a caller *can* still write, because filtering
 * them costs more than it buys:
 *
 * - **The `---` divider.** A bare horizontal rule claims no authority on its
 *   own, and Markdown documents and YAML frontmatter are full of them. Filtering
 *   it would mangle any pasted document — and a filter that fires on ordinary
 *   messages is a filter someone turns off.
 * - **Role-prefixed lines** (`User:`, `Assistant:`). Pasting a transcript for
 *   review is a legitimate thing to ask an agent to do.
 *
 * Single pass by construction: each pattern is applied once, over the original
 * or already-substituted text, and {@link FILTERED_MARKER} contains none of the
 * syntax either pattern matches. A caller cannot write text that only becomes a
 * marker after a substitution.
 */
export function defangInbound(message: string): string {
  return message
    .replace(RESERVED_FENCE, FILTERED_MARKER)
    .replace(CONTROL_TOKEN, FILTERED_MARKER);
}
