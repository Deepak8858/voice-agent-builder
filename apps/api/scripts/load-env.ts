import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

const envPaths = [
  path.resolve(__dirname, '../../../.env'),
  path.resolve(process.cwd(), '.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
  }
}
