'use strict';

/**
 * Vercel serverless 入口：导出 Express app。
 * 本地开发时 `node api/index.js` 也会起 HTTP 服务。
 */
const app = require('../src/index');

module.exports = app;

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`[podcast-cloud] 本地服务已启动: http://localhost:${port}`);
    console.log(`[podcast-cloud] Feed 接口: http://localhost:${port}/api/feed`);
    console.log(`[podcast-cloud] Cron 接口: POST http://localhost:${port}/api/cron/update`);
  });
}