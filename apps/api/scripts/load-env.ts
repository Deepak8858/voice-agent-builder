import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
  }
}
