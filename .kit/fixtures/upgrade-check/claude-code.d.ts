// Written by Claude Code 9.9.9.
// A stand-in for the engine's own declaration file, for
// .kit/upgrade-check-unit-test.mjs. It carries the two declarations the
// fixture hooks read and one the fixture hooks do not, so the diff step can
// be driven both ways: a changed declaration the hooks read, and one they do
// not.

declare module 'claude-code' {
  export type Register = (on: unknown) => void;
  export type PromptSubmitResult = { text?: string };
  export type NothingTheHooksRead = { spare?: string };
}
