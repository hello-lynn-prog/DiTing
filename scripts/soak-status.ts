import {join} from 'node:path';import {settings} from '../apps/server/settings.js';import {readSoakStatus} from '../packages/domain/soak-status.js';
console.log(JSON.stringify(readSoakStatus(join(settings().dataDir,'qa','soak-latest.json')),null,2));
