'use strict';

/**
 * 统一时间工具：所有对外输出均为 ISO 8601 字符串（UTC）。
 */

function toISOString(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function nowISO() {
  return new Date().toISOString();
}

function parseISO(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function epochSeconds(value) {
  const d = parseISO(value);
  return d ? Math.floor(d.getTime() / 1000) : null;
}

module.exports = { toISOString, nowISO, parseISO, epochSeconds };