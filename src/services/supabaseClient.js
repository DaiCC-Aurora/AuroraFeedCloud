'use strict';

const { createClient } = require('@supabase/supabase-js');

let client = null;

/**
 * 懒加载 Supabase 客户端。
 * 使用 Service Role Key（服务端专用）。Vercel 无状态环境下每次冷启动会新建，
 * 模块级缓存可避免同一实例内重复创建。
 */
function getSupabase() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      '缺少环境变量 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY（参见 .env.example）'
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** 可选：测试时重置缓存（一般用不到）。 */
function resetSupabase() {
  client = null;
}

module.exports = { getSupabase, resetSupabase };