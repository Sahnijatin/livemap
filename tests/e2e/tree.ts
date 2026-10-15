import { expect, type Locator } from '@playwright/test';

/**
 * Opens the closed folders above `file` in a file tree (`scope` holds it), top down. Compact rows like
 * `src/app` stand for several folders and carry the deepest one's path, so missing rows are skipped.
 */
export async function openFolders(scope: Locator, file: string): Promise<void> {
  const parts = file.split('/');
  await expect(scope.locator('[role=treeitem]').first()).toBeVisible({ timeout: 15_000 });
  for (let i = 1; i < parts.length; i++) {
    const row = scope.locator(`[data-dir="${parts.slice(0, i).join('/')}"]`);
    if ((await row.count()) === 0) continue;
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  }
}
