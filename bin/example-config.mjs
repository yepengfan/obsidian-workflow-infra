import { constants, copyFileSync, readdirSync } from 'node:fs';

for (const file of readdirSync('config/examples')) {
  try {
    copyFileSync('config/examples/' + file, 'config/' + file, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
