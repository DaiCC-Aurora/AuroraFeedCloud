'use strict';

require('dotenv').config();

const express = require('express');
const feedRouter = require('./routes/feed');
const cronRouter = require('./routes/cron');
const { nowISO } = require('./utils/dateUtils');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 简单请求日志
app.use((req, res, next) => {
  console.log(`[${nowISO()}] ${req.method} ${req.originalUrl}`);
  next();
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// 业务路由
app.use('/api/feed', feedRouter);
app.use('/api/cron', cronRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${err.stack || err.message}`);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;