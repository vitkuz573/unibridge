export { start } from './server.js';

if (process.argv[1]?.endsWith('proxy.ts')) {
  const { start } = await import('./server.js');
  start();
}
