import { onShutdownRequest } from '../src/process-lifecycle';

const mode = process.argv[2];
const counts = () => ['SIGTERM', 'SIGINT', 'message'].map((event) => process.listenerCount(event));
const initial = counts();
const keepAlive = setInterval(() => {}, 1000);
const report = (event: string, data: object = {}) => console.log(JSON.stringify({ event, ...data }));
const observe = () => report('received');
if (process.channel) process.on('message', observe);
let cleaned = false;
const removeShutdown = onShutdownRequest(() => {
  if (mode === 'ignore') {
    report('ignored');
    return;
  }
  if (cleaned) return;
  cleaned = true;
  clearInterval(keepAlive);
  removeShutdown();
  removeShutdown();
  process.off('message', observe);
  report('cleaned', { initial, remaining: counts() });
});
report('ready');
