import type { Provider } from "../shared/types";

export type PendingQuickTask = {
  id: string;
  title: string;
  companyId: string;
  provider: Provider;
};

export type ComposerDraft = {
  draft: string;
  files: string[];
  pending?: PendingQuickTask;
  expanded?: { title: string; known: string[] };
};

const empty = (): ComposerDraft => ({ draft: "", files: [] });

export function createComposerDraftStore() {
  const values = new Map<string, ComposerDraft>();
  return {
    get(key: string): ComposerDraft {
      const value = values.get(key);
      return value
        ? {
            ...value,
            files: [...value.files],
            ...(value.expanded
              ? {
                  expanded: {
                    ...value.expanded,
                    known: [...value.expanded.known],
                  },
                }
              : {}),
          }
        : empty();
    },
    set(key: string, value: ComposerDraft) {
      if (!value.draft && !value.files.length && !value.pending)
        values.delete(key);
      else
        values.set(key, {
          ...value,
          files: [...value.files],
          ...(value.expanded
            ? {
                expanded: {
                  ...value.expanded,
                  known: [...value.expanded.known],
                },
              }
            : {}),
        });
    },
  };
}

export const composerDrafts = createComposerDraftStore();

export async function attachFilesBeforeStart(
  paths: string[],
  add: (path: string) => Promise<void>,
) {
  const failedFiles: string[] = [],
    problems: string[] = [];
  for (const path of paths)
    try {
      await add(path);
    } catch (error) {
      failedFiles.push(path);
      problems.push(error instanceof Error ? error.message : String(error));
    }
  return { failedFiles, problems: [...new Set(problems)] };
}
