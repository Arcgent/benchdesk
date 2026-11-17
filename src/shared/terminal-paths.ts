// Never submit pasted paths as commands. Reject terminal control characters rather
// than allowing a filename to inject an Enter or escape sequence into a shell/TUI.
export function terminalPaths(paths: string[]): string {
  if (!paths.length) return "";
  if (
    paths.some((path) => !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path))
  )
    throw new Error(
      "Dit bestandspad kan niet veilig in de terminal worden geplakt.",
    );
  return (
    [...new Set(paths)]
      .map((path) => `'${path.replace(/'/g, "'\\''")}'`)
      .join(" ") + " "
  );
}

export function localFileUrls(value: string): string[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      try {
        const url = new URL(line);
        if (
          url.protocol !== "file:" ||
          (url.hostname && url.hostname !== "localhost")
        )
          return [];
        return [decodeURIComponent(url.pathname)];
      } catch {
        return [];
      }
    });
}
