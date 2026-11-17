import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { localFileUrls, terminalPaths } from "../src/shared/terminal-paths";

test("terminal paths round-trip as literal shell arguments without expansion or submission", () => {
  const paths = [
    "/tmp/file with spaces.pdf",
    "/tmp/Sam's $(echo WRONG);`echo WRONG` & [test].txt",
    "/tmp/één map/📄.md",
  ];
  const text = terminalPaths(paths);
  assert.ok(!/[\r\n\x1b]/.test(text));
  assert.ok(text.endsWith(" "));
  const result = execFileSync("/bin/sh", [
    "-c",
    `printf '%s\\0' ${text}`,
  ]).toString();
  assert.deepEqual(result.split("\0").slice(0, -1), paths);
  assert.equal(terminalPaths([paths[0], paths[0]]), terminalPaths([paths[0]]));
});
test("terminal rejects control characters, relative paths and empty file paths", () => {
  for (const path of [
    "/tmp/x\ny",
    "/tmp/x\ry",
    "/tmp/\x1b[201~",
    "/tmp/x\0y",
    "file.txt",
    "",
  ])
    assert.throws(() => terminalPaths([path]));
  assert.equal(terminalPaths([]), "");
});
test("file URLs decode spaces and Unicode without accepting web or remote links", () => {
  assert.deepEqual(
    localFileUrls(
      "# paths\r\nfile:///tmp/a%20b.pdf\r\nfile://localhost/tmp/%C3%A9.txt\r\nhttps://example.com/file\r\nfile://remote/tmp/a\r\nnot-a-url",
    ),
    ["/tmp/a b.pdf", "/tmp/é.txt"],
  );
  assert.deepEqual(localFileUrls("file:///tmp/%invalid"), []);
});
