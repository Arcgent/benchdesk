export async function exportBackup(
  backup: () => Promise<string | null>,
  success: () => void,
) {
  const path = await backup();
  if (path) success();
  return path;
}
