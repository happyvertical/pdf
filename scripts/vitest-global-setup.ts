import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const tesseractCache = join(process.cwd(), 'eng.traineddata');
  const existedBeforeTests = await pathExists(tesseractCache);

  return async () => {
    if (!existedBeforeTests) {
      await rm(tesseractCache, { force: true });
    }
  };
}
