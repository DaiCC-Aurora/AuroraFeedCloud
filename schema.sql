-- 英语听力播客云后端：数据库结构
-- 在 Supabase SQL Editor 中执行本文件全部内容

-- 若使用本表默认的 gen_random_uuid()，需要启用 pgcrypto 扩展
create extension if not exists pgcrypto;

create table if not exists episodes (
    id uuid primary key default gen_random_uuid(),
    guid text unique not null,          -- 节目唯一标识（由 RSS guid/link 归一化）
    title text not null,
    description text,
    published_at timestamptz not null,
    duration_seconds int not null default 0,
    audio_url text not null,            -- 云端音频 URL（手表端下载）
    subtitle_text text,                 -- 字幕纯文本（transcript）
    subtitle_url text,                  -- 若字幕另存为文件（VTT/LRC）则填 URL
    subtitle_vtt text,                  -- 可选：带时间戳的 VTT 字幕文本
    transcription_status text not null default 'pending',  -- pending | ready | failed
    transcription_error text,
    attempts int not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
);

create index if not exists idx_episodes_published on episodes(published_at desc);
create index if not exists idx_episodes_guid on episodes(guid);