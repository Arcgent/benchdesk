import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { localFileUrls } from "../shared/terminal-paths";

// Finder exposes all copied files (including folders) as a property-list array.
// plutil supports both Apple's binary plist and XML; no shell or copied text is executed.
export async function clipboardFiles(): Promise<string[]> {
  const formats = clipboard.availableFormats();
  if (
    process.platform === "darwin" &&
    formats.includes("NSFilenamesPboardType")
  ) {
    const data = clipboard.readBuffer("NSFilenamesPboardType");
    if (data.length > 1024 * 1024)
      throw new Error("Te veel bestandspaden op het klembord.");
    const json = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", "--", "-"],
        { timeout: 1500, maxBuffer: 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(data);
    });
    const paths: unknown = JSON.parse(json);
    if (Array.isArray(paths) && paths.every((path) => typeof path === "string"))
      return paths;
  }
  for (const format of ["public.file-url", "text/uri-list"]) {
    if (formats.includes(format)) {
      const paths = localFileUrls(
        clipboard.readBuffer(format).toString("utf8").replace(/\0+$/, ""),
      );
      if (paths.length) return paths;
    }
  }
  return [];
}
