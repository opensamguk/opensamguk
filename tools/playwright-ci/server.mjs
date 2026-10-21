// fixture.config.ts의 webServer가 띄우는 시험용 서버. 받은 표식 문자열만 돌려준다.
import { createServer } from 'node:http';

const port = Number(process.env.FIXTURE_PORT);
const token = process.env.FIXTURE_SERVER_TOKEN ?? '';

createServer((_request, response) => {
  response.end(token);
}).listen(port, '127.0.0.1');
