import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

export async function checkTerminalFiles({ app, page, call, root, sessionId }) {
  const paths = [join(root, "file with spaces.txt"), join(root, "Sam's $(echo WRONG);é.txt")];
  for (const path of paths) await writeFile(path, "test fixture");
  const capture = join(root, "terminal-input.txt");
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const quotedPaths = paths.map(quote).join(" ") + " ";
  let expected = "";
  const wait = async (check) => {
    for (let i = 0; i < 120; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("Terminal file test timed out");
  };
  await call("session.write", { id: sessionId, data: `printf 'CAPTURE_%s\\n' READY; stty -echo -icanon; cat > ${quote(capture)}\r` });
  await wait(async () => (await call("session.screen", { id: sessionId })).screen.includes("CAPTURE_READY"));
  const received = async (addition) => {
    expected += addition;
    await wait(async () => { try { return (await readFile(capture, "utf8")) === expected; } catch { return false; } });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await readFile(capture, "utf8"), expected, "Paths inserted exactly once, no Enter or control characters");
  };
  // Use disk-backed browser File objects: getPathForFile must return actual paths,
  // not invented File.name or the obsolete Electron File.path property.
  await page.evaluate(() => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true; input.id = "file-drop-fixture"; document.body.append(input);
  });
  await page.locator("#file-drop-fixture").setInputFiles(paths);
  await page.evaluate(() => {
    const data = new DataTransfer();
    for (const file of document.querySelector("#file-drop-fixture").files) data.items.add(file);
    const target = document.querySelector('[data-test="terminal-host"]');
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    if (target.dataset.fileDrop !== "true") throw new Error("Missing drop highlight");
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    document.querySelector("#file-drop-fixture").remove();
  });
  await received(quotedPaths);
  // Fake only the OS clipboard reader, never overwrite the user's clipboard.
  await app.evaluate(({ clipboard }, paths) => {
    globalThis.originalClipboardFiles = { formats: clipboard.availableFormats, read: clipboard.readBuffer };
    const xml = '<?xml version="1.0"?><plist version="1.0"><array>' + paths.map((p) => `<string>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("") + '</array></plist>';
    clipboard.availableFormats = () => ["NSFilenamesPboardType"];
    clipboard.readBuffer = () => Buffer.from(xml);
  }, paths);
  const paste = async (text) => page.evaluate((text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    document.querySelector('[data-test="terminal-host"] textarea').dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
  try {
    await paste("file with spaces.txt\nSam's file.txt");
    await received(quotedPaths);
    await app.evaluate(({ clipboard }, path) => {
      clipboard.availableFormats = () => ["public.file-url"];
      clipboard.readBuffer = () => Buffer.from(new URL(`file://${path}`).href);
    }, paths[0]);
    await paste("file with spaces.txt");
    await received(quote(paths[0]) + " ");
    await app.evaluate(({ clipboard }) => { clipboard.availableFormats = () => []; });
    await paste("ordinary terminal text");
    await received("ordinary terminal text");
    await page.evaluate(() => {
      const data = new DataTransfer(); data.setData("text/uri-list", "file:///tmp/another%20file.pdf");
      document.querySelector('[data-test="terminal-host"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await received("'/tmp/another file.pdf' ");
  } finally {
    await app.evaluate(({ clipboard }) => {
      clipboard.availableFormats = globalThis.originalClipboardFiles.formats;
      clipboard.readBuffer = globalThis.originalClipboardFiles.read;
      delete globalThis.originalClipboardFiles;
    });
    await call("session.write", { id: sessionId, data: "\x03stty sane\r" });
  }
  console.log("File paths passed: real disk-backed multi-file drop, Finder plist/URL paste, normal text, URI drops, quoting and no automatic Enter. User clipboard untouched.");
}
