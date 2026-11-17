import { opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { SessionFile, SessionFileList, Snapshot } from "../shared/types";

const ignored = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
  "venv",
  "Pods",
  "Library",
]);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
};
type Scan = { files: SessionFile[]; truncated: boolean; unavailable: boolean };
type ModifiedDuring = { start: number; end: number };

// Read-only discovery runs in the app, independently of live terminal processes.
// Legacy result directories can be shared by multiple sessions. Workspace files
// are a time-based convenience view, never proof of an individual writer.
export class SessionFiles {
  private scans = new Map<string, { at: number; value: Promise<Scan> }>();
  private grants = new Map<string, Set<string>>();

  private scan(root: string, during?: ModifiedDuring): Promise<Scan> {
    const key = `${root}\0${during ? `${during.start}:${during.end}` : "output"}`;
    const cached = this.scans.get(key);
    if (cached && Date.now() - cached.at < 2500) return cached.value;
    for (const [id, entry] of this.scans)
      if (Date.now() - entry.at > 30_000) this.scans.delete(id);
    const value = this.walk(root, during);
    this.scans.set(key, { at: Date.now(), value });
    return value;
  }

  private async walk(root: string, during?: ModifiedDuring): Promise<Scan> {
    const result: Scan = { files: [], truncated: false, unavailable: false };
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      return { ...result, unavailable: true };
    }
    const queue = [{ path: canonical, depth: 0 }];
    let visited = 0;
    for (let i = 0; i < queue.length; i++) {
      if (i >= 500) {
        result.truncated = true;
        break;
      }
      const dir = queue[i];
      try {
        for await (const entry of await opendir(dir.path)) {
          if (++visited > 15_000) {
            result.truncated = true;
            return result;
          }
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const path = join(dir.path, entry.name);
          if (entry.isDirectory()) {
            if (ignored.has(entry.name) || entry.name.startsWith("release"))
              continue;
            if (dir.depth < 12) queue.push({ path, depth: dir.depth + 1 });
            else result.truncated = true;
          } else if (entry.isFile()) {
            try {
              // Recheck canonical paths so replaced directories cannot escape the root.
              const resolved = await realpath(path);
              if (!inside(canonical, resolved)) continue;
              const info = await stat(resolved);
              if (!info.isFile()) continue;
              if (during && (info.mtimeMs < during.start || info.mtimeMs > during.end))
                continue;
              result.files.push({
                path: resolved,
                name: basename(path),
                relativePath: relative(canonical, path),
                source: during ? "workspace" : "output",
                modifiedAt: info.mtime.toISOString(),
                size: info.size,
              });
              if (result.files.length >= 3000) {
                result.truncated = true;
                return result;
              }
            } catch {
              /* A file can be moved while the assistant writes it. */
            }
          }
        }
      } catch {
        result.unavailable = true;
      }
    }
    return result;
  }

  async list(snap: Snapshot, id: string): Promise<SessionFileList> {
    const session = snap.sessions.find((s) => s.id === id);
    if (!session) throw new Error("Gesprek niet gevonden.");
    let outputAllowed = false;
    let sharedOutput = false;
    try {
      const cwd = await realpath(session.cwd);
      const output = await realpath(session.outputDir);
      outputAllowed = inside(cwd, output);
      sharedOutput = cwd === output;
    } catch {
      /* Missing workspaces are reported below. */
    }
    const [output, workspace] = await Promise.all([
      outputAllowed && !sharedOutput
        ? this.scan(session.outputDir)
        : Promise.resolve({
            files: [],
            truncated: false,
            unavailable: !!session.outputDir && !outputAllowed,
          }),
      session.cwd
        ? this.scan(session.cwd, {
            start: Date.parse(session.createdAt),
            end: session.alive ? Infinity : Date.parse(session.updatedAt),
          })
        : Promise.resolve({ files: [], truncated: false, unavailable: false }),
    ]);
    const found = new Map<string, SessionFile>();
    for (const file of workspace.files) found.set(file.path, file);
    for (const file of output.files) found.set(file.path, file);
    for (const artifact of snap.artifacts.filter((a) => a.sessionId === id)) {
      let path = artifact.path,
        modifiedAt = artifact.createdAt,
        size = 0;
      if (!/^https?:\/\//i.test(path)) {
        try {
          path = await realpath(path);
          const info = await stat(path);
          if (!info.isFile()) continue;
          modifiedAt = info.mtime.toISOString();
          size = info.size;
        } catch {
          continue;
        }
      }
      found.set(path, {
        path,
        name: artifact.name,
        relativePath: artifact.name,
        source: "linked",
        modifiedAt,
        size,
      });
    }
    const files = [...found.values()]
      .sort((a, b) => {
        const md = (file: SessionFile) =>
          /\.(md|markdown)$/i.test(extname(file.path)) ? 1 : 0;
        return (
          md(b) - md(a) ||
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          a.path.localeCompare(b.path)
        );
      })
      .slice(0, 200);
    const validIds = new Set(snap.sessions.map((s) => s.id));
    for (const key of this.grants.keys())
      if (!validIds.has(key)) this.grants.delete(key);
    this.grants.set(id, new Set(files.map((file) => file.path)));
    return {
      files,
      truncated:
        found.size > files.length || output.truncated || workspace.truncated,
      unavailable: output.unavailable || workspace.unavailable,
    };
  }

  async authorizes(path: string): Promise<boolean> {
    // Only exact discovered paths. A symlink substituted after discovery is denied.
    if (![...this.grants.values()].some((paths) => paths.has(path)))
      return false;
    try {
      return (await realpath(path)) === path && (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}
