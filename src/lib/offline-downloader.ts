/**
 * 服务器端离线下载器
 * 用于在服务器端下载 M3U8 视频到本地文件系统
 */
/* eslint-disable no-console */

import { type ChildProcess,spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { URL } from 'url';

import { safeFetch } from './safe-http';

export interface OfflineDownloadTask {
  id: string;
  source: string;
  videoId: string;
  episodeIndex: number;
  title: string;
  m3u8Url: string;
  status: 'pending' | 'downloading' | 'remuxing' | 'completed' | 'error' | 'paused';
  progress: number;
  totalSegments: number;
  downloadedSegments: number;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  downloadDir: string;
  playbackId?: string;
  // 视频元数据
  metadata?: {
    videoTitle?: string; // 视频总标题（如：某某动漫）
    cover?: string; // 封面图片URL
    description?: string; // 视频描述
    year?: string; // 年份
    rating?: number; // 评分
    totalEpisodes?: number; // 总集数
  };
}

interface SegmentInfo {
  url: string;
  filename: string;
  duration: number;
}

interface KeyInfo {
  method: string;
  uri: string;
  iv?: string;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const abortSignalConstructor = AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof abortSignalConstructor.any === 'function') {
    return abortSignalConstructor.any(signals);
  }

  const controller = new AbortController();
  const forwardAbort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const listeners = signals.map((signal) => {
    const listener = () => forwardAbort(signal);
    signal.addEventListener('abort', listener, { once: true });
    return { signal, listener };
  });
  controller.signal.addEventListener(
    'abort',
    () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener);
      }
    },
    { once: true }
  );
  for (const signal of signals) {
    if (signal.aborted) {
      forwardAbort(signal);
      break;
    }
  }
  return controller.signal;
}

export class OfflineDownloader {
  private baseDir: string;
  private exportDir: string | undefined;
  private maxRetries = 3;
  private retryDelay = 1000; // ms
  private concurrency = 6;
  private proxy?: string;
  private childProcesses = new Map<string, ChildProcess>();

  constructor(baseDir: string, proxy?: string, exportDir?: string) {
    this.baseDir = baseDir;
    this.proxy = proxy?.trim() || undefined;
    this.exportDir = exportDir?.trim() ? path.resolve(exportDir.trim()) : undefined;
    this.ensureDir(this.baseDir);
  }

  /**
   * 创建下载任务
   */
  createTask(
    source: string,
    videoId: string,
    episodeIndex: number,
    title: string,
    m3u8Url: string,
    metadata?: {
      videoTitle?: string;
      cover?: string;
      description?: string;
      year?: string;
      rating?: number;
      totalEpisodes?: number;
    }
  ): OfflineDownloadTask {
    const taskId = `${source}_${videoId}_${episodeIndex}_${Date.now()}_${randomUUID()}`;
    const downloadDir = this.getDownloadDirectory(source, videoId, episodeIndex);

    const task: OfflineDownloadTask = {
      id: taskId,
      source,
      videoId,
      episodeIndex,
      title,
      m3u8Url,
      status: 'pending',
      progress: 0,
      totalSegments: 0,
      downloadedSegments: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      downloadDir,
      playbackId: this.exportDir ? randomUUID() : undefined,
      metadata,
    };

    return task;
  }

  /**
   * 开始下载任务
   */
  async startDownload(
    task: OfflineDownloadTask,
    onProgress?: (task: OfflineDownloadTask) => void,
    signal?: AbortSignal,
    shouldExport = false
  ): Promise<void> {
    try {
      this.throwIfAborted(signal);
      task.status = 'downloading';
      task.updatedAt = new Date();
      onProgress?.(task);

      // 确保下载目录存在
      this.ensureDir(task.downloadDir);

      // 检查是否已经下载过（避免重复下载）
      const playlistPath = path.join(task.downloadDir, 'playlist.m3u8');
      if (fs.existsSync(playlistPath)) {
        // 检查所有文件是否完整
        const isComplete = await this.verifyDownload(task.downloadDir);
        if (isComplete) {
          task.status = shouldExport ? 'remuxing' : 'completed';
          task.progress = 100;
          task.updatedAt = new Date();
          onProgress?.(task);
          return;
        }
      }

      // 下载 M3U8 文件
      let m3u8Content = await this.fetchContent(task.m3u8Url, signal);
      let finalM3u8Url = task.m3u8Url;

      // 检查是否为主播放列表（包含多个分辨率）
      if (this.isMasterPlaylist(m3u8Content)) {
        console.log('检测到主播放列表，正在选择最高分辨率...');

        // 解析主播放列表，获取最高分辨率的子播放列表URL
        const bestVariantUrl = this.selectBestVariant(m3u8Content, task.m3u8Url);

        if (bestVariantUrl) {
          console.log('已选择最高分辨率流:', bestVariantUrl);
          finalM3u8Url = bestVariantUrl;

          // 下载子播放列表
          m3u8Content = await this.fetchContent(bestVariantUrl, signal);
        } else {
          console.warn('无法找到子播放列表，使用原始URL');
        }
      }

      // 解析 M3U8 文件
      const { segments, keyInfo } = this.parseM3U8(m3u8Content, finalM3u8Url);

      if (segments.length === 0) {
        throw new Error('M3U8 播放列表中没有可下载的视频分片');
      }

      task.totalSegments = segments.length;
      onProgress?.(task);

      // 下载解密 Key（如果有）
      if (keyInfo && keyInfo.uri) {
        await this.downloadKey(keyInfo, task.downloadDir, signal);
      }

      // 下载所有片段
      await this.downloadSegments(segments, task, onProgress, signal);

      this.throwIfAborted(signal);

      // 生成本地播放列表，保持原始格式
      this.generateLocalPlaylist(m3u8Content, segments, keyInfo, task.downloadDir);

      task.status = shouldExport ? 'remuxing' : 'completed';
      task.progress = 100;
      task.updatedAt = new Date();
      onProgress?.(task);
    } catch (error) {
      if (!signal?.aborted) {
        task.status = 'error';
        task.errorMessage = this.formatError(error);
        task.updatedAt = new Date();
        onProgress?.(task);
      }
      throw error;
    }
  }

  /**
   * 检查是否为主播放列表（Master Playlist）
   */
  private isMasterPlaylist(content: string): boolean {
    return content.includes('#EXT-X-STREAM-INF:');
  }

  /**
   * 从主播放列表中选择最高分辨率的变体
   */
  private selectBestVariant(content: string, baseUrl: string): string | null {
    const lines = content.split('\n').map((line) => line.trim());

    interface Variant {
      url: string;
      bandwidth: number;
      resolution?: { width: number; height: number };
    }

    const variants: Variant[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        // 提取带宽信息
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

        // 提取分辨率信息
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const resolution = resolutionMatch
          ? { width: parseInt(resolutionMatch[1], 10), height: parseInt(resolutionMatch[2], 10) }
          : undefined;

        // 下一行应该是子播放列表的URL
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (nextLine && !nextLine.startsWith('#')) {
            const variantUrl = this.resolveUrl(nextLine, baseUrl);
            variants.push({ url: variantUrl, bandwidth, resolution });
          }
        }
      }
    }

    if (variants.length === 0) {
      return null;
    }

    // 优先按分辨率排序（宽度 * 高度），如果没有分辨率信息则按带宽排序
    variants.sort((a, b) => {
      // 如果两者都有分辨率信息，按分辨率排序
      if (a.resolution && b.resolution) {
        const aPixels = a.resolution.width * a.resolution.height;
        const bPixels = b.resolution.width * b.resolution.height;
        if (aPixels !== bPixels) {
          return bPixels - aPixels; // 降序
        }
      }

      // 如果只有一个有分辨率信息，优先选择有分辨率的
      if (a.resolution && !b.resolution) return -1;
      if (!a.resolution && b.resolution) return 1;

      // 都没有分辨率信息，或分辨率相同，则按带宽排序
      return b.bandwidth - a.bandwidth; // 降序
    });

    console.log('可用的流变体:', variants.map(v => ({
      url: v.url,
      bandwidth: v.bandwidth,
      resolution: v.resolution ? `${v.resolution.width}x${v.resolution.height}` : '未知',
    })));

    return variants[0].url;
  }

  /**
   * 解析 M3U8 文件
   */
  private parseM3U8(
    content: string,
    baseUrl: string
  ): { segments: SegmentInfo[]; keyInfo: KeyInfo | null } {
    const lines = content.split('\n').map((line) => line.trim());
    const segments: SegmentInfo[] = [];
    let keyInfo: KeyInfo | null = null;
    let currentDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 解析时长
      if (line.startsWith('#EXTINF:')) {
        const match = line.match(/#EXTINF:([\d.]+)/);
        if (match) {
          currentDuration = parseFloat(match[1]);
        }
      }
      // 解析加密信息
      else if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([^,]+)/);
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=([^,\s]+)/);

        if (methodMatch && methodMatch[1] !== 'NONE') {
          keyInfo = {
            method: methodMatch[1],
            uri: uriMatch ? this.resolveUrl(uriMatch[1], baseUrl) : '',
            iv: ivMatch ? ivMatch[1] : undefined,
          };
        }
      }
      // 解析片段 URL
      else if (line && !line.startsWith('#')) {
        const segmentUrl = this.resolveUrl(line, baseUrl);
        const filename = `segment_${segments.length.toString().padStart(5, '0')}.ts`;

        segments.push({
          url: segmentUrl,
          filename,
          duration: currentDuration,
        });

        currentDuration = 0;
      }
    }

    return { segments, keyInfo };
  }

  /**
   * 下载所有片段（带重试和并发控制）
   */
  private async downloadSegments(
    segments: SegmentInfo[],
    task: OfflineDownloadTask,
    onProgress?: (task: OfflineDownloadTask) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const queue = [...segments];
    const downloading: Promise<void>[] = [];
    let downloadedCount = 0;

    const downloadNext = async (): Promise<void> => {
      this.throwIfAborted(signal);
      if (queue.length === 0) return;

      const segment = queue.shift();
      if (!segment) return;
      const segmentPath = path.join(task.downloadDir, segment.filename);

      // 如果文件已存在且大小 > 0，跳过下载
      if (fs.existsSync(segmentPath) && fs.statSync(segmentPath).size > 0) {
        downloadedCount++;
        task.downloadedSegments = downloadedCount;
        task.progress = Math.round((downloadedCount / task.totalSegments) * 100);
        task.updatedAt = new Date();
        onProgress?.(task);
        return downloadNext();
      }

      // 下载片段（带重试）
      await this.downloadWithRetry(segment.url, segmentPath, signal);

      downloadedCount++;
      task.downloadedSegments = downloadedCount;
      task.progress = Math.round((downloadedCount / task.totalSegments) * 100);
      task.updatedAt = new Date();
      onProgress?.(task);

      return downloadNext();
    };

    // 并发下载
    for (let i = 0; i < Math.min(this.concurrency, segments.length); i++) {
      downloading.push(downloadNext());
    }

    const results = await Promise.allSettled(downloading);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }

  /**
   * 下载解密 Key
   */
  private async downloadKey(keyInfo: KeyInfo, downloadDir: string, signal?: AbortSignal): Promise<void> {
    if (!keyInfo.uri) return;

    const keyPath = path.join(downloadDir, 'key.key');

    // 如果 key 已存在，跳过下载
    if (fs.existsSync(keyPath) && fs.statSync(keyPath).size > 0) {
      return;
    }

    await this.downloadWithRetry(keyInfo.uri, keyPath, signal);
  }

  /**
   * 下载文件（带重试）
   */
  private async downloadWithRetry(url: string, savePath: string, signal?: AbortSignal): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      this.throwIfAborted(signal);
      try {
        await this.downloadFile(url, savePath, signal);
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`下载失败 (尝试 ${attempt + 1}/${this.maxRetries})`, error);

        if (attempt < this.maxRetries - 1) {
          await this.sleep(this.retryDelay * (attempt + 1));
        }
      }
    }

    throw new Error(`下载失败（已重试 ${this.maxRetries} 次）: ${url}\n${lastError?.message}`);
  }

  /**
   * 获取标准浏览器请求头
   */
  private getHeaders(url: string): Record<string, string> {
    const urlObj = new URL(url);
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Origin': `${urlObj.protocol}//${urlObj.host}`,
      'Referer': `${urlObj.protocol}//${urlObj.host}/`,
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
  }

  /**
   * 检测是否在 Cloudflare 环境中运行。Cloudflare Workers 不支持 Node.js Agent，
   * 因此系统代理配置在该环境下无效。
   */
  private isCloudflareEnvironment(): boolean {
    return (
      process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare'
    );
  }

  private getRequestOptions(url: string, timeout = 30000, signal?: AbortSignal): RequestInit {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combinedSignal = signal
      ? combineAbortSignals([signal, timeoutSignal])
      : timeoutSignal;
    return {
      headers: this.getHeaders(url),
      signal: combinedSignal as unknown as RequestInit['signal'],
    };
  }

  private async fetchUrl(url: string, timeout = 30000, signal?: AbortSignal): Promise<Response> {
    if (this.isCloudflareEnvironment()) {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const combinedSignal = signal
        ? combineAbortSignals([signal, timeoutSignal])
        : timeoutSignal;
      return fetch(url, {
        headers: this.getHeaders(url),
        signal: combinedSignal,
      });
    }

    return safeFetch(url, this.getRequestOptions(url, timeout, signal), this.proxy) as unknown as Promise<Response>;
  }

  /**
   * 下载单个文件
   */
  private async downloadFile(url: string, savePath: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchUrl(url, 30000, signal);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('响应体为空');
    }

    const responseWithNodeBody = response as Response & {
      getBody?: () =>
        | Promise<NodeJS.ReadableStream | null>
        | NodeJS.ReadableStream
        | null;
    };
    const body =
      (await responseWithNodeBody.getBody?.()) ??
      (response.body as unknown as NodeJS.ReadableStream | null);

    if (!body || typeof body.pipe !== 'function') {
      const arrayBuffer = await response.arrayBuffer();
      this.throwIfAborted(signal);
      fs.writeFileSync(savePath, Buffer.from(arrayBuffer));
      return;
    }

    const fileStream = fs.createWriteStream(savePath);
    try {
      await pipeline(body, fileStream, signal ? { signal } : {});
    } catch (error) {
      await fs.promises.rm(savePath, { force: true });
      throw error;
    }
  }

  /**
   * 获取内容（用于 M3U8 文件）
   */
  private async fetchContent(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchUrl(url, 10000, signal);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  async remuxToMp4(task: OfflineDownloadTask, signal?: AbortSignal): Promise<void> {
    if (!this.exportDir) throw new Error('服务器 MP4 发布目录未配置');
    this.throwIfAborted(signal);
    if (!task.playbackId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(task.playbackId)) {
      throw new Error('缓存链接标识无效');
    }

    const outputPath = this.getPublishedPath(task.playbackId);
    this.ensureDir(this.exportDir);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return;

    const playlistPath = path.join(task.downloadDir, 'playlist.m3u8');
    if (!await this.verifyDownload(task.downloadDir)) {
      throw new Error('本地 HLS 缓存不完整，无法生成 MP4');
    }
    const tempPlaylist = path.join(task.downloadDir, `remux-${task.playbackId}.m3u8`);
    const tempOutput = path.join(this.exportDir, `.${task.playbackId}.${randomUUID()}.part.mp4`);
    const localLines = this.createRemuxPlaylist(playlistPath, task.downloadDir);
    fs.writeFileSync(tempPlaylist, localLines.join('\n') + '\n', 'utf-8');

    try {
      const outputBytes = await this.getAvailableOutputBytes(task.downloadDir);
      const minimumFreeBytes = Math.max(32 * 1024 * 1024, outputBytes * 1.1 + 8 * 1024 * 1024);
      const filesystemStats = await fs.promises.statfs(this.exportDir);
      const availableBytes = Number(filesystemStats.bavail) * Number(filesystemStats.bsize);
      if (availableBytes < minimumFreeBytes) {
        throw new Error('服务器磁盘剩余空间不足，MP4 封装暂未开始；已缓存的 HLS 分片仍可在 MoonTVPlus 内播放');
      }

      const probeOutput = await this.runProcess('ffprobe', task.id, [
        '-v', 'error',
        '-protocol_whitelist', 'file,crypto,data',
        '-allowed_extensions', 'ALL',
        '-show_entries', 'stream=codec_type,codec_name',
        '-of', 'json',
        tempPlaylist,
      ], signal);
      const streams = (JSON.parse(probeOutput) as { streams?: { codec_type?: string; codec_name?: string }[] }).streams || [];
      const videoCodec = streams.find((stream) => stream.codec_type === 'video')?.codec_name;
      const audioCodecs = streams.filter((stream) => stream.codec_type === 'audio').map((stream) => stream.codec_name);
      if (videoCodec !== 'h264' || audioCodecs.some((codec) => codec !== 'aac')) {
        const audioText = audioCodecs.length > 0 ? audioCodecs.join(', ') : '无音轨';
        throw new Error(`检测到视频编码 ${videoCodec || '未知'}、音频编码 ${audioText}，当前不能保证手机和电脑浏览器播放。原 HLS 缓存仍保留，可在 MoonTVPlus 内播放`);
      }

      await this.runProcess('ffmpeg', task.id, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file,crypto,data',
        '-allowed_extensions', 'ALL',
        '-i', tempPlaylist,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-movflags', '+faststart',
        '-f', 'mp4', tempOutput,
      ], signal);
      this.throwIfAborted(signal);
      const exportedStats = await fs.promises.stat(tempOutput);
      if (exportedStats.size === 0) throw new Error('FFmpeg 封装完成，但生成的 MP4 文件为空');
      await fs.promises.rename(tempOutput, outputPath);
    } catch (error) {
      await fs.promises.rm(tempOutput, { force: true });
      const message = this.formatError(error);
      if (message.includes('space left') || (error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new Error('服务器磁盘空间不足，MP4 封装失败；HLS 缓存仍保留，可在 MoonTVPlus 内播放');
      }
      throw new Error(message);
    } finally {
      this.childProcesses.delete(task.id);
      await fs.promises.rm(tempPlaylist, { force: true });
    }
  }

  getPlaybackUrl(task: OfflineDownloadTask): string | undefined {
    if (!this.exportDir || !task.playbackId) return undefined;
    const outputPath = this.getPublishedPath(task.playbackId);
    if (!fs.existsSync(outputPath)) return undefined;
    try {
      if (fs.statSync(outputPath).size === 0) return undefined;
    } catch {
      return undefined;
    }
    return `/media/${task.playbackId}.mp4`;
  }

  getOrCreatePlaybackId(task: OfflineDownloadTask): string {
    task.playbackId ||= randomUUID();
    return task.playbackId;
  }

  requestCancel(taskId: string): void {
    const child = this.childProcesses.get(taskId);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }

  private async getAvailableOutputBytes(downloadDir: string): Promise<number> {
    let total = 0;
    for (const entry of await fs.promises.readdir(downloadDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^segment_\d+\.ts$/i.test(entry.name)) continue;
      total += (await fs.promises.stat(path.join(downloadDir, entry.name))).size;
    }
    return total;
  }

  private createRemuxPlaylist(playlistPath: string, downloadDir: string): string[] {
    const sourceLines = fs.readFileSync(playlistPath, 'utf-8').split(/\r?\n/);
    const remuxLines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD'];
    let duration = '';
    let segmentCount = 0;
    let hasEncryptionKey = false;

    for (const rawLine of sourceLines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-BYTERANGE:')) {
        throw new Error('该片源使用 fMP4 初始化段或字节范围，当前无法封装为浏览器播放文件');
      }

      if (line.startsWith('#EXT-X-KEY:')) {
        const method = line.match(/METHOD=([^,]+)/i)?.[1]?.trim().toUpperCase();
        if (method === 'NONE') {
          remuxLines.push('#EXT-X-KEY:METHOD=NONE');
          hasEncryptionKey = false;
          continue;
        }
        if (method !== 'AES-128') {
          throw new Error('该片源使用浏览器兼容模式无法处理的加密方式，HLS 缓存仍可在 MoonTVPlus 内播放');
        }

        const keyFormat = line.match(/KEYFORMAT="?([^,"]+)/i)?.[1]?.trim();
        if (keyFormat && keyFormat.toLowerCase() !== 'identity') {
          throw new Error('该片源使用浏览器兼容模式无法处理的密钥格式，HLS 缓存仍可在 MoonTVPlus 内播放');
        }

        const keyPath = path.join(downloadDir, 'key.key');
        if (!fs.existsSync(keyPath) || fs.statSync(keyPath).size === 0) {
          throw new Error('本地 AES-128 密钥缺失，无法生成 MP4');
        }
        const iv = line.match(/IV=(0x[0-9a-f]+)(?:,|$)/i)?.[1];
        remuxLines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.key"${iv ? `,IV=${iv}` : ''}`);
        hasEncryptionKey = true;
        continue;
      }

      const extinfMatch = line.match(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)(?:,.*)?$/i);
      if (extinfMatch) {
        duration = extinfMatch[1];
        continue;
      }

      if (line.startsWith('#EXT-X-VERSION:')) {
        const version = line.slice('#EXT-X-VERSION:'.length).trim();
        if (/^\d+$/.test(version)) remuxLines.push(`#EXT-X-VERSION:${version}`);
        continue;
      }

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        const targetDuration = line.slice('#EXT-X-TARGETDURATION:'.length).trim();
        if (/^\d+$/.test(targetDuration)) remuxLines.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
        continue;
      }

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const sequence = line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim();
        if (/^\d+$/.test(sequence)) remuxLines.push(`#EXT-X-MEDIA-SEQUENCE:${sequence}`);
        continue;
      }

      if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        const sequence = line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length).trim();
        if (/^\d+$/.test(sequence)) remuxLines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${sequence}`);
        continue;
      }

      if (line === '#EXT-X-DISCONTINUITY' || line === '#EXT-X-INDEPENDENT-SEGMENTS') {
        remuxLines.push(line);
        continue;
      }

      if (line.startsWith('#')) continue;
      if (!/^segment_\d+\.ts$/i.test(line) || path.basename(line) !== line) {
        throw new Error('本地播放列表包含无效的视频分片地址');
      }
      const segmentPath = path.resolve(downloadDir, line);
      if (path.dirname(segmentPath) !== path.resolve(downloadDir)) {
        throw new Error('本地播放列表的视频分片路径无效');
      }
      if (!duration) throw new Error('本地播放列表缺少视频分片时长');
      if (!fs.existsSync(segmentPath) || fs.statSync(segmentPath).size === 0) {
        throw new Error(`视频分片缺失或为空：${line}`);
      }

      remuxLines.push(`#EXTINF:${duration},`);
      remuxLines.push(line);
      duration = '';
      segmentCount++;
    }

    if (hasEncryptionKey && !fs.existsSync(path.join(downloadDir, 'key.key'))) {
      throw new Error('本地 AES-128 密钥缺失，无法生成 MP4');
    }
    if (segmentCount === 0) throw new Error('本地播放列表没有可封装的视频分片');
    if (duration) throw new Error('本地播放列表最后一个视频分片不完整');
    remuxLines.push('#EXT-X-ENDLIST');
    return remuxLines;
  }

  private getPublishedPath(playbackId: string): string {
    if (!this.exportDir || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(playbackId)) {
      throw new Error('缓存链接标识无效');
    }
    const filePath = path.resolve(this.exportDir, `${playbackId}.mp4`);
    if (path.dirname(filePath) !== this.exportDir) throw new Error('缓存链接路径无效');
    return filePath;
  }

  private async runProcess(command: string, taskId: string, args: string[], signal?: AbortSignal): Promise<string> {
    this.throwIfAborted(signal);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.childProcesses.set(taskId, child);
    let stdout = '';
    let stderr = '';
    const maxOutputLength = 32 * 1024;
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + chunk.toString()).slice(-maxOutputLength);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-maxOutputLength);
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let killTimeout: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (killTimeout) clearTimeout(killTimeout);
        signal?.removeEventListener('abort', abortProcess);
        this.childProcesses.delete(taskId);
        if (error) reject(error);
        else resolve(stdout);
      };
      const abortProcess = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        killTimeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 5000);
        killTimeout.unref();
      };
      child.once('error', (error) => finish(error));
      child.once('close', (code, childSignal) => {
        if (signal?.aborted) {
          finish(new Error('任务已取消'));
        } else if (code !== 0) {
          const details = stderr.trim().slice(-4000);
          finish(new Error(details || `${command} exited with ${childSignal || code}`));
        } else {
          finish();
        }
      });
      signal?.addEventListener('abort', abortProcess, { once: true });
      if (signal?.aborted) abortProcess();
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('任务已取消');
    error.name = 'AbortError';
    throw error;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return '未知错误';
  }

  getDownloadDirectory(source: string, videoId: string, episodeIndex: number): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(source) || source === '.' || source === '..') {
      throw new Error('视频源标识无效');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(videoId) || videoId === '.' || videoId === '..') {
      throw new Error('视频标识无效');
    }
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0 || episodeIndex > 9999) {
      throw new Error('集数索引无效');
    }
    const baseDir = path.resolve(this.baseDir);
    const downloadDir = path.resolve(baseDir, source, videoId, `ep${episodeIndex + 1}`);
    if (!downloadDir.startsWith(baseDir + path.sep)) throw new Error('下载目录路径无效');
    return downloadDir;
  }

  /**
   * 生成本地播放列表（保持原始格式，只替换片段URL）
   */
  private generateLocalPlaylist(
    originalM3u8Content: string,
    segments: SegmentInfo[],
    keyInfo: KeyInfo | null,
    downloadDir: string
  ): void {
    const lines = originalM3u8Content.split('\n');
    const modifiedLines: string[] = [];
    let segmentIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 替换 Key URI
      if (trimmedLine.startsWith('#EXT-X-KEY:')) {
        if (keyInfo && keyInfo.method !== 'NONE') {
          // 替换 URI 为本地 key.key
          const modifiedLine = line.replace(/URI="[^"]+"/g, 'URI="key.key"');
          modifiedLines.push(modifiedLine);
        } else {
          modifiedLines.push(line);
        }
      }
      // 替换视频片段 URL
      else if (trimmedLine && !trimmedLine.startsWith('#')) {
        // 这是一个视频片段，替换为本地文件名
        if (segmentIndex < segments.length) {
          const indent = line.match(/^\s*/)?.[0] || '';
          modifiedLines.push(indent + segments[segmentIndex].filename);
          segmentIndex++;
        } else {
          // 如果超出了片段数量，保留原始行（不应该发生）
          modifiedLines.push(line);
        }
      }
      // 保持其他所有行不变
      else {
        modifiedLines.push(line);
      }
    }

    const playlistPath = path.join(downloadDir, 'playlist.m3u8');
    fs.writeFileSync(playlistPath, modifiedLines.join('\n'), 'utf-8');
  }

  /**
   * 验证下载是否完整
   */
  private async verifyDownload(downloadDir: string): Promise<boolean> {
    try {
      const playlistPath = path.join(downloadDir, 'playlist.m3u8');
      if (!fs.existsSync(playlistPath)) {
        return false;
      }

      const content = fs.readFileSync(playlistPath, 'utf-8');
      const lines = content.split('\n').map((line) => line.trim());

      // 检查所有 ts 文件是否存在
      for (const line of lines) {
        if (line && !line.startsWith('#')) {
          const segmentPath = path.join(downloadDir, line);
          if (!fs.existsSync(segmentPath) || fs.statSync(segmentPath).size === 0) {
            return false;
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析相对 URL
   */
  private resolveUrl(targetUrl: string, baseUrl: string): string {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      return targetUrl;
    }

    try {
      const base = new URL(baseUrl);
      if (targetUrl.startsWith('/')) {
        return `${base.protocol}//${base.host}${targetUrl}`;
      } else {
        const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
        return `${base.protocol}//${base.host}${basePath}${targetUrl}`;
      }
    } catch {
      return targetUrl;
    }
  }

  /**
   * 确保目录存在
   */
  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 删除下载任务的所有文件
   */
  async deleteTask(task: OfflineDownloadTask): Promise<void> {
    const expectedDownloadDir = this.getDownloadDirectory(task.source, task.videoId, task.episodeIndex);
    if (path.resolve(task.downloadDir) !== expectedDownloadDir) throw new Error('下载目录路径与任务不匹配，拒绝删除');
    await fs.promises.rm(expectedDownloadDir, { recursive: true, force: true });
    if (this.exportDir && task.playbackId) {
      if (fs.existsSync(this.exportDir)) {
        await fs.promises.rm(this.getPublishedPath(task.playbackId), { force: true });
        for (const entry of await fs.promises.readdir(this.exportDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.startsWith(`.${task.playbackId}.`) && entry.name.endsWith('.part.mp4')) {
            await fs.promises.rm(path.join(this.exportDir, entry.name), { force: true });
          }
        }
      }
    }
  }

  /**
   * 检查视频是否已下载
   */
  checkDownloaded(source: string, videoId: string, episodeIndex: number): boolean {
    const downloadDir = this.getDownloadDirectory(source, videoId, episodeIndex);
    const playlistPath = path.join(downloadDir, 'playlist.m3u8');
    return fs.existsSync(playlistPath);
  }

  /**
   * 获取本地播放列表路径
   */
  getLocalPlaylistPath(source: string, videoId: string, episodeIndex: number): string | null {
    const downloadDir = this.getDownloadDirectory(source, videoId, episodeIndex);
    const playlistPath = path.join(downloadDir, 'playlist.m3u8');
    return fs.existsSync(playlistPath) ? playlistPath : null;
  }
}
