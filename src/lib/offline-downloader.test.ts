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
const UUID = '00000000-0000-4000-8000-000000000001';
const EXTRADATA = '00000000: 0142 001e ffe1 0005 6742 001e 8001 0002 68c0';

function makePacket(nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(nal.length);
    return [length, nal];
  }));
}

function makeInputPackets(includeSpsChange: boolean) {
  const packets = [
    makePacket([Buffer.from([0x65, 0xbc])]),
    makePacket([Buffer.from([0x41, 0x80])]),
    makePacket([
      ...(includeSpsChange ? [Buffer.from([0x67, 0x4d, 0x00, 0x1e, 0x80])] : []),
      Buffer.from([0x65, 0xbc]),
    ]),
    makePacket([Buffer.from([0x41, 0x80])]),
    makePacket([Buffer.from([0x65, 0xbc])]),
  ];
  let position = 0;
  const rows = packets.map((packet, index) => {
    const row = `pts_time=${index}|size=${packet.length}|pos=${position}|flags=${index % 2 === 0 ? 'K_' : '__'}`;
    position += packet.length;
    return row;
  });
  return { data: Buffer.concat(packets), rows };
}

function makeChildProcess(stdout: string, closeCode: number | null = 0, onRun?: () => void) {
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
  onRun?.();
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

function makeChunkedChildProcess(chunks: Buffer[], closeCode = 0) {
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
  setTimeout(() => {
    for (const chunk of chunks) child.stdout.write(chunk);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = closeCode;
    child.emit('close', closeCode, null);
  }, 0);
  return child;
}

function writeTsSegment(filePath: string) {
  const segment = Buffer.alloc(188);
  segment[0] = 0x47;
  fs.writeFileSync(filePath, segment);
}

function configureSuccessfulPublish(options: { spsChange?: boolean; sourceCodec?: string } = {}) {
  const packetData = makeInputPackets(options.spsChange ?? true);
  const inputMp4 = packetData.data;
  mockSpawn.mockImplementation((command, rawArgs) => {
    const args = (rawArgs || []).map(String);
    if (command === 'ffprobe') {
      if (args.includes('-show_packets')) {
        return makeChildProcess(`${packetData.rows.join('\n')}\n`) as unknown as ReturnType<typeof spawn>;
      }
      if (args.includes('-show_data')) {
        return makeChildProcess(JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264', extradata: EXTRADATA },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        })) as unknown as ReturnType<typeof spawn>;
      }
      return makeChildProcess(JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: options.sourceCodec || 'h264' },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      })) as unknown as ReturnType<typeof spawn>;
    }

    expect(command).toBe('ffmpeg');
    if (args.includes('mp4')) {
      const inputIndex = args.indexOf('-i');
      const playlistPath = args[inputIndex + 1];
      const playlist = fs.readFileSync(playlistPath, 'utf-8');
      expect(playlist).not.toContain('https://');
      expect(playlist).not.toContain('#EXT-X-DEFINE');
      expect(playlist).toContain('#EXT-X-KEY:METHOD=NONE');
      const outputPath = args[args.length - 1];
      fs.writeFileSync(outputPath, inputMp4);
      return makeChildProcess('') as unknown as ReturnType<typeof spawn>;
    }

    expect(args).toContain('segment');
    expect(args[args.indexOf('-reset_timestamps') + 1]).toBe('0');
    const csvPath = args[args.indexOf('-segment_list') + 1];
    const pattern = args[args.length - 1];
    const outputDirectory = path.dirname(pattern);
    const frameArgIndex = args.indexOf('-segment_frames');
    const expectsBoundary = options.spsChange ?? true;
    expect(frameArgIndex).toBeGreaterThan(-1);
    if (!expectsBoundary) expect(args[frameArgIndex + 1]).toBe(String(packetData.rows.length + 1));

    if (expectsBoundary) {
      writeTsSegment(path.join(outputDirectory, 'segment_00000.ts'));
      writeTsSegment(path.join(outputDirectory, 'segment_00001.ts'));
      fs.writeFileSync(csvPath, 'segment_00000.ts,0.000000,2.000000\nsegment_00001.ts,2.000000,4.000000\n');
    } else {
      writeTsSegment(path.join(outputDirectory, 'segment_00000.ts'));
      fs.writeFileSync(csvPath, 'segment_00000.ts,0.000000,4.000000\n');
    }
    return makeChildProcess('') as unknown as ReturnType<typeof spawn>;
  });
  return packetData;
}

describe('OfflineDownloader HLS publication', () => {
  let temporaryRoot: string;
  let downloadRoot: string;
  let exportRoot: string;
  let downloader: OfflineDownloader;
  let task: OfflineDownloadTask;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moontv-offline-hls-'));
    downloadRoot = path.join(temporaryRoot, 'downloads');
    exportRoot = path.join(temporaryRoot, 'media');
    fs.mkdirSync(exportRoot, { recursive: true });
    downloader = new OfflineDownloader(downloadRoot, undefined, exportRoot);
    task = downloader.createTask(
      'source.example',
      'video_1',
      0,
      '示例视频',
      'https://stream.example/playlist.m3u8'
    );
    task.playbackId = UUID;
    fs.mkdirSync(task.downloadDir, { recursive: true });
    fs.writeFileSync(path.join(task.downloadDir, 'segment_00000.ts'), Buffer.from('source segment'));
    fs.writeFileSync(
      path.join(task.downloadDir, 'playlist.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:5',
        '#EXT-X-DEFINE:QUERYPARAM="uri=https://outside.example/evil.ts"',
        '#EXT-X-KEY:METHOD=NONE,URI="https://outside.example/evil.key"',
        '#EXTINF:4.8,ignored source metadata',
        'segment_00000.ts',
        '#EXT-X-ENDLIST',
      ].join('\n')
    );
    mockSpawn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('sanitizes local HLS, segments SPS changes, and atomically publishes a ready URL', async () => {
    configureSuccessfulPublish();

    await downloader.publishHls(task);

    const playlistPath = path.join(exportRoot, 'hls', UUID, 'index.m3u8');
    const playlist = fs.readFileSync(playlistPath, 'utf-8');
    expect(playlist).toContain('#EXT-X-DISCONTINUITY\n#EXTINF:2.000');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(downloader.getPlaybackUrl(task)).toBe(`/media/compat/${UUID}`);
    expect(downloader.hasLegacyMp4(task)).toBe(false);
    expect(fs.readdirSync(exportRoot).some((name) => name.endsWith('.stage.mp4'))).toBe(false);
  });

  it('uses a legacy MP4 as the source and preserves it after HLS publication', async () => {
    const packetData = configureSuccessfulPublish();
    const legacyPath = path.join(exportRoot, `${UUID}.mp4`);
    fs.writeFileSync(legacyPath, packetData.data);

    await downloader.publishHls(task);

    expect(fs.readFileSync(legacyPath)).toEqual(packetData.data);
    expect(downloader.getPlaybackUrl(task)).toBe(`/media/compat/${UUID}`);
    expect(mockSpawn.mock.calls.some(([, args]) => (args as string[]).includes('-movflags'))).toBe(false);
  });

  it('enforces one segment for short inputs without parameter changes', async () => {
    configureSuccessfulPublish({ spsChange: false });

    await downloader.publishHls(task);

    const directory = path.join(exportRoot, 'hls', UUID);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.ts'))).toEqual(['segment_00000.ts']);
    expect(fs.readFileSync(path.join(directory, 'index.m3u8'), 'utf-8')).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('rejects unsupported codecs while retaining the original HLS cache', async () => {
    configureSuccessfulPublish({ sourceCodec: 'hevc' });

    await expect(downloader.publishHls(task)).rejects.toThrow('视频编码 hevc');
    expect(fs.existsSync(path.join(task.downloadDir, 'playlist.m3u8'))).toBe(true);
    expect(downloader.getPlaybackUrl(task)).toBeUndefined();
  });

  it('waits for and cancels the active FFmpeg child before cleaning staging data', async () => {
    const childProcesses: ReturnType<typeof makeChildProcess>[] = [];
    mockSpawn.mockImplementation((command) => {
      if (command === 'ffprobe') {
        return makeChildProcess(JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        })) as unknown as ReturnType<typeof spawn>;
      }
      expect(command).toBe('ffmpeg');
      const child = makeChildProcess('', null);
      childProcesses.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });
    const controller = new AbortController();
    const publishPromise = downloader.publishHls(task, controller.signal);
    for (let attempt = 0; attempt < 50 && childProcesses.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(publishPromise).rejects.toThrow('任务已取消');
    expect(childProcesses[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(fs.existsSync(path.join(exportRoot, 'hls', UUID))).toBe(false);
    expect(fs.readdirSync(exportRoot)).toEqual(['hls']);
    expect(fs.existsSync(path.join(task.downloadDir, 'playlist.m3u8'))).toBe(true);
  });

  it('streams large FFprobe stdout with backpressure and consumes an unterminated UTF-8 tail', async () => {
    const output = Buffer.from(
      `${Array.from({ length: 5000 }, (_, index) => `packet-${index.toString().padStart(5, '0')}`).join('\n')}\n尾行无换行`,
      'utf8'
    );
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < output.length; offset += 8192) {
      chunks.push(output.subarray(offset, Math.min(offset + 8192, output.length)));
    }
    const child = makeChunkedChildProcess(chunks);
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const received: string[] = [];
    const downloaderInternals = downloader as unknown as {
      runProcessLines: (
        command: string,
        taskId: string,
        args: string[],
        signal: AbortSignal,
        onLine: (line: string) => Promise<void>
      ) => Promise<void>;
    };

    await downloaderInternals.runProcessLines(
      'ffprobe',
      'large-output',
      [],
      new AbortController().signal,
      async (line) => {
        await Promise.resolve();
        received.push(line);
      }
    );

    expect(received).toHaveLength(5001);
    expect(received[0]).toBe('packet-00000');
    expect(received[4999]).toBe('packet-04999');
    expect(received[5000]).toBe('尾行无换行');
  });

  it('deletes private HLS, public HLS, legacy MP4, and only this task temp files', async () => {
    const publicDirectory = path.join(exportRoot, 'hls', UUID);
    const tempDirectory = path.join(exportRoot, 'hls', `.${UUID}.00000000-0000-4000-8000-000000000002.tmp`);
    fs.mkdirSync(publicDirectory, { recursive: true });
    fs.mkdirSync(tempDirectory, { recursive: true });
    writeTsSegment(path.join(publicDirectory, 'segment_00000.ts'));
    fs.writeFileSync(path.join(publicDirectory, 'index.m3u8'), '#EXTM3U\n#EXTINF:1,\nsegment_00000.ts\n#EXT-X-ENDLIST\n');
    fs.writeFileSync(path.join(exportRoot, `${UUID}.mp4`), 'legacy');
    fs.writeFileSync(path.join(exportRoot, `.${UUID}.00000000-0000-4000-8000-000000000003.stage.mp4`), 'stage');
    fs.writeFileSync(path.join(exportRoot, '.another.mp4'), 'keep');

    await downloader.deleteTask(task);

    expect(fs.existsSync(task.downloadDir)).toBe(false);
    expect(fs.existsSync(publicDirectory)).toBe(false);
    expect(fs.existsSync(tempDirectory)).toBe(false);
    expect(fs.existsSync(path.join(exportRoot, `${UUID}.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(exportRoot, '.another.mp4'))).toBe(true);
  });

  it('rejects a task whose private path does not match its source identity', async () => {
    task.downloadDir = path.join(temporaryRoot, 'outside');
    await expect(downloader.deleteTask(task)).rejects.toThrow('下载目录路径与任务不匹配');
  });
});
