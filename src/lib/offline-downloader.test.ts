/** @jest-environment node */

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';

import { OfflineDownloader, OfflineDownloadTask } from './offline-downloader';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const H264_AAC = JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264' },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
});

function makeChildProcess(
  stdout: string,
  closeCode: number | null = 0,
  onRun?: () => void
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: jest.Mock;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    setTimeout(() => child.emit('close', null, signal), 0);
    return true;
  });
  if (onRun) onRun();
  if (closeCode !== null) {
    setTimeout(() => {
      child.stdout.end(stdout);
      child.stderr.end();
      child.exitCode = closeCode;
      child.emit('close', closeCode, null);
    }, 0);
  }
  return child;
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

describe('OfflineDownloader MP4 export', () => {
  let temporaryRoot: string;
  let downloadRoot: string;
  let exportRoot: string;
  let downloader: OfflineDownloader;
  let task: OfflineDownloadTask;

  beforeEach(async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moontv-offline-remux-'));
    downloadRoot = path.join(temporaryRoot, 'hls');
    exportRoot = path.join(temporaryRoot, 'media');
    downloader = new OfflineDownloader(downloadRoot, undefined, exportRoot);
    task = downloader.createTask(
      'source.example',
      'video_1',
      0,
      '示例视频',
      'https://stream.example/playlist.m3u8'
    );
    fs.mkdirSync(task.downloadDir, { recursive: true });
    fs.writeFileSync(path.join(task.downloadDir, 'segment_00000.ts'), Buffer.from('video segment'));
    fs.writeFileSync(
      path.join(task.downloadDir, 'playlist.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:5',
        '#EXT-X-DEFINE:QUERYPARAM="uri=https://outside.example/evil.ts"',
        '#EXT-X-KEY:METHOD=NONE,URI="https://outside.example/evil.key"',
        '#EXTINF:4.8,Injected tag text is ignored',
        'segment_00000.ts',
        '#EXT-X-ENDLIST',
      ].join('\n')
    );
    mockSpawn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('builds a sanitized HLS playlist and atomically publishes an H.264 MP4 URL', async () => {
    mockSpawn.mockImplementation((command, args) => {
      if (command === 'ffprobe') {
        const remuxPlaylist = fs.readFileSync(String(args?.[args.length - 1]), 'utf-8');
        expect(remuxPlaylist).toContain('#EXTM3U');
        expect(remuxPlaylist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(remuxPlaylist).toContain('#EXT-X-KEY:METHOD=NONE');
        expect(remuxPlaylist).toContain('segment_00000.ts');
        expect(remuxPlaylist).not.toContain('https://');
        expect(remuxPlaylist).not.toContain('#EXT-X-DEFINE');
        expect(remuxPlaylist).not.toContain('Injected tag text');
        return makeChildProcess(H264_AAC) as unknown as ReturnType<typeof spawn>;
      }

      expect(command).toBe('ffmpeg');
      expect(args).toContain('-c');
      expect(args).toContain('copy');
      expect(args).toContain('+faststart');
      fs.writeFileSync(String(args?.[args.length - 1]), Buffer.from('mp4 output'));
      return makeChildProcess('') as unknown as ReturnType<typeof spawn>;
    });

    await downloader.remuxToMp4(task);

    const url = downloader.getPlaybackUrl(task);
    expect(url).toBe(`/media/${task.playbackId}.mp4`);
    expect(fs.readFileSync(path.join(exportRoot, `${task.playbackId}.mp4`), 'utf-8')).toBe('mp4 output');
    expect(fs.readdirSync(task.downloadDir)).not.toContain(`remux-${task.playbackId}.m3u8`);
    expect(fs.readdirSync(exportRoot).every((filename) => filename.endsWith('.mp4'))).toBe(true);
  });

  it('keeps the HLS files and rejects browser-incompatible codecs', async () => {
    mockSpawn.mockImplementation((command) => {
      expect(command).toBe('ffprobe');
      return makeChildProcess(JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'hevc' }],
      })) as unknown as ReturnType<typeof spawn>;
    });

    await expect(downloader.remuxToMp4(task)).rejects.toThrow('检测到视频编码 hevc');
    expect(fs.existsSync(path.join(task.downloadDir, 'playlist.m3u8'))).toBe(true);
    expect(downloader.getPlaybackUrl(task)).toBeUndefined();
    expect(fs.readdirSync(task.downloadDir)).not.toContain(`remux-${task.playbackId}.m3u8`);
  });

  it('waits for the FFmpeg child process to stop when the task is cancelled', async () => {
    let child: ReturnType<typeof makeChildProcess> | undefined;
    mockSpawn.mockImplementation(() => {
      child = makeChildProcess('', null);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const controller = new AbortController();

    const exportPromise = downloader.remuxToMp4(task, controller.signal);
    await waitFor(() => mockSpawn.mock.calls.length === 1);
    controller.abort();

    await expect(exportPromise).rejects.toThrow('任务已取消');
    expect(child?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fs.readdirSync(exportRoot)).toEqual([]);
    expect(fs.readdirSync(task.downloadDir)).not.toContain(`remux-${task.playbackId}.m3u8`);
  });

  it('removes only the selected task output and tolerates a missing export directory', async () => {
    task.playbackId = '00000000-0000-4000-8000-000000000001';
    fs.mkdirSync(exportRoot, { recursive: true });
    fs.writeFileSync(path.join(exportRoot, `${task.playbackId}.mp4`), 'selected');
    fs.writeFileSync(path.join(exportRoot, 'another.mp4'), 'other task');

    await downloader.deleteTask(task);

    expect(fs.existsSync(task.downloadDir)).toBe(false);
    expect(fs.readFileSync(path.join(exportRoot, 'another.mp4'), 'utf-8')).toBe('other task');
    fs.rmSync(exportRoot, { recursive: true, force: true });
    await expect(downloader.deleteTask(task)).resolves.toBeUndefined();
  });

  it('rejects task identifiers that escape the HLS storage directory', () => {
    expect(() => downloader.getDownloadDirectory('../outside', 'episode', 0)).toThrow('视频源标识无效');
    expect(() => downloader.getDownloadDirectory('source', '../outside', 0)).toThrow('视频标识无效');
  });
});
