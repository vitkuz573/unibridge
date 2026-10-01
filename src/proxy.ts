export { start } from './server.ts';

if (process.argv[1]?.endsWith('proxy.ts')) {
  const { start } = await import('./server.ts');
  start();
}
