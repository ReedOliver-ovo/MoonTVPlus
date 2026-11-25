/** @jest-environment node */

import fs from 'fs';
import {
  Blob as EdgeBlob,
  FormData as EdgeFormData,
  Headers as EdgeHeaders,
  ReadableStream as EdgeReadableStream,
  Request as EdgeRequest,
  Response as EdgeResponse,
} from 'next/dist/compiled/@edge-runtime/primitives';
import type { NextRequest } from 'next/server';
import os from 'os';
import path from 'path';

Object.assign(globalThis, {
  Request: EdgeRequest,
  Response: EdgeResponse,
  Headers: EdgeHeaders,
  FormData: EdgeFormData,
  ReadableStream: EdgeReadableStream,
  Blob: EdgeBlob,
});

const mockPublishedIds = new Set<string>();
const mockLegacyMp4Ids = new Set<string>();
const mockLocalHlsKeys = new Set<string>();
const mockWork = new Map<string, { finish: () => void; fail: (error: Error) => void }>();
const mockStartedTasks: string[] = [];
const mockDeletedDirectories: string[] = [];
let mockPlaybackCounter = 0;

const mockDownloader = {
  getDownloadDirectory: jest.fn((source: string, videoId: string, episodeIndex: number) =>
    path.join(process.env.OFFLINE_DOWNLOAD_DIR || '', source, videoId, `ep${episodeIndex + 1}`)
  ),
  getOrCreatePlaybackId: jest.fn((task: { playbackId?: string }) => {
    task.playbackId ||= `00000000-0000-4000-8000-${String(++mockPlaybackCounter).padStart(12, '0')}`;
    return task.playbackId;
  }),
  getPlaybackUrl: jest.fn((task: { playbackId?: string }) =>
    task.playbackId && mockPublishedIds.has(task.playbackId)
      ? `/media/compat/${task.playbackId.toLowerCase()}`
      : undefined
  ),
  hasLegacyMp4: jest.fn((task: { playbackId?: string }) =>
    Boolean(task.playbackId && mockLegacyMp4Ids.has(task.playbackId))
  ),
  createTask: jest.fn((source: string, videoId: string, episodeIndex: number, title: string, m3u8Url: string) => ({
    id: `${source}_${videoId}_${episodeIndex}`,
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
    downloadDir: path.join(process.env.OFFLINE_DOWNLOAD_DIR || '', source, videoId, `ep${episodeIndex + 1}`),
  })),
  checkDownloaded: jest.fn((source: string, videoId: string, episodeIndex: number) =>
    mockLocalHlsKeys.has(`${source}/${videoId}/${episodeIndex}`)
  ),
  startDownload: jest.fn((
    task: { id: string; status: string; totalSegments: number; downloadedSegments: number },
    onProgress: (task: unknown) => void,
    signal: AbortSignal,
    shouldExport: boolean
  ) => {
    mockStartedTasks.push(task.id);
    task.status = 'downloading';
    task.totalSegments = 2;
    task.downloadedSegments = 0;
    onProgress(task);

    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        task.downloadedSegments = 2;
        task.status = shouldExport ? 'remuxing' : 'completed';
        onProgress(task);
        resolve();
      };
      const fail = (error: Error) => reject(error);
      const onAbort = () => {
        setTimeout(() => reject(new Error('模拟中的下载已停止')), 15);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      mockWork.set(task.id, { finish, fail });
    });
  }),
  publishHls: jest.fn(async (task: { playbackId?: string }) => {
    if (task.playbackId) mockPublishedIds.add(task.playbackId);
  }),
  requestCancel: jest.fn(),
  deleteTask: jest.fn(async (task: {
    downloadDir: string;
    playbackId?: string;
    source: string;
    videoId: string;
    episodeIndex: number;
  }) => {
    mockDeletedDirectories.push(task.downloadDir);
    if (task.playbackId) {
      mockPublishedIds.delete(task.playbackId);
      mockLegacyMp4Ids.delete(task.playbackId);
    }
    mockLocalHlsKeys.delete(`${task.source}/${task.videoId}/${task.episodeIndex}`);
  }),
};

jest.mock('@/lib/auth', () => ({
  getAuthInfoFromCookie: () => ({ username: 'owner', role: 'owner' }),
}));

jest.mock('@/lib/offline-downloader', () => ({
  OfflineDownloader: jest.fn(() => mockDownloader),
}));

type OfflineDownloadRoute = typeof import('./route');

let route: OfflineDownloadRoute;
let temporaryRoot: string;

function makeRequest(pathname: string, method = 'GET', body?: Record<string, unknown>) {
  return new EdgeRequest(new URL(pathname, 'http://localhost'), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

async function postTask(videoId: string, source = 'ffzyapi.com') {
  return route.POST(makeRequest('/api/offline-download', 'POST', {
    source,
    videoId,
    episodeIndex: 0,
    title: `视频 ${videoId}`,
    m3u8Url: `https://stream.example/${videoId}/playlist.m3u8`,
    metadata: { videoTitle: `视频 ${videoId}`, totalEpisodes: 1 },
  }));
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function readTasks() {
  const response = await route.GET(makeRequest('/api/offline-download'));
  return (await response.json()).tasks as {
    id: string;
    status: string;
    playbackUrl?: string;
    errorMessage?: string;
  }[];
}

describe('offline-download server cache queue', () => {
  beforeEach(async () => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD = 'true';
    process.env.OFFLINE_DOWNLOAD_EXPORT_DIR = '/test-media';
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moontv-offline-route-'));
    process.env.OFFLINE_DOWNLOAD_DIR = temporaryRoot;
    mockPublishedIds.clear();
    mockLegacyMp4Ids.clear();
    mockLocalHlsKeys.clear();
    mockWork.clear();
    mockStartedTasks.length = 0;
    mockDeletedDirectories.length = 0;
    mockPlaybackCounter = 0;
    mockDownloader.getDownloadDirectory.mockClear();
    mockDownloader.getOrCreatePlaybackId.mockClear();
    mockDownloader.getPlaybackUrl.mockClear();
    mockDownloader.hasLegacyMp4.mockClear();
    mockDownloader.checkDownloaded.mockClear();
    mockDownloader.createTask.mockClear();
    mockDownloader.startDownload.mockClear();
    mockDownloader.publishHls.mockClear();
    mockDownloader.requestCancel.mockClear();
    mockDownloader.deleteTask.mockClear();
    mockDownloader.deleteTask.mockImplementation(async (task) => {
      mockDeletedDirectories.push(task.downloadDir);
      if (task.playbackId) {
        mockPublishedIds.delete(task.playbackId);
        mockLegacyMp4Ids.delete(task.playbackId);
      }
      mockLocalHlsKeys.delete(`${task.source}/${task.videoId}/${task.episodeIndex}`);
    });
    mockDownloader.startDownload.mockImplementation((task, onProgress, signal, shouldExport) => {
      mockStartedTasks.push(task.id);
      task.status = 'downloading';
      task.totalSegments = 2;
      task.downloadedSegments = 0;
      onProgress(task);
      return new Promise<void>((resolve, reject) => {
        const finish = () => {
          task.downloadedSegments = 2;
          task.status = shouldExport ? 'remuxing' : 'completed';
          mockLocalHlsKeys.add(`${task.id.split('_')[0]}/${task.id.split('_')[1]}/${Number(task.id.split('_')[2])}`);
          onProgress(task);
          resolve();
        };
        const fail = (error: Error) => reject(error);
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(new Error('模拟中的下载已停止')), 15);
        }, { once: true });
        mockWork.set(task.id, { finish, fail });
      });
    });
    route = await import('./route');
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('queues jobs sequentially and publishes HLS compatibility pages', async () => {
    const firstResponse = await postTask('episode-a');
    const secondResponse = await postTask('episode-b');
    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);

    await waitFor(() => mockStartedTasks.length === 1);
    expect((await readTasks()).map((task) => task.status)).toEqual(['downloading', 'pending']);

    mockWork.get('ffzyapi.com_episode-a_0')?.finish();
    await waitFor(() => mockStartedTasks.length === 2);
    mockWork.get('ffzyapi.com_episode-b_0')?.finish();
    await waitFor(async () => (await readTasks()).every((task) => task.status === 'completed'));

    const saved = await readTasks();
    expect(saved.every((task) => task.playbackUrl?.startsWith('/media/compat/'))).toBe(true);
    expect(mockStartedTasks).toEqual(['ffzyapi.com_episode-a_0', 'ffzyapi.com_episode-b_0']);

    const persisted = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'tasks.json'), 'utf-8'));
    expect(persisted).toHaveLength(2);
    expect(persisted.every((task: { playbackId?: string }) => task.playbackId)).toBe(true);

    jest.resetModules();
    route = await import('./route');
    const restored = await readTasks();
    expect(restored).toHaveLength(2);
    expect(restored.every((task) => task.status === 'completed' && task.playbackUrl)).toBe(true);
  });

  it('does not create duplicate tasks for simultaneous requests of the same episode', async () => {
    const responses = await Promise.all([postTask('same-episode'), postTask('same-episode')]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(mockDownloader.createTask).toHaveBeenCalledTimes(1);
    expect((await readTasks())).toHaveLength(1);
  });

  it('keeps download-only behavior when playback export is not configured', async () => {
    delete process.env.OFFLINE_DOWNLOAD_EXPORT_DIR;
    jest.resetModules();
    route = await import('./route');

    const response = await postTask('download-only');
    expect(response.status).toBe(202);
    await waitFor(() => mockStartedTasks.length === 1);
    expect(mockDownloader.startDownload.mock.calls[0]?.[3]).toBe(false);
    mockWork.get('ffzyapi.com_download-only_0')?.finish();
    await waitFor(async () => (await readTasks())[0]?.status === 'completed');

    expect((await readTasks())[0]?.playbackUrl).toBeUndefined();
    expect(mockDownloader.publishHls).not.toHaveBeenCalled();
  });

  it('waits for an active task to stop before removing its HLS and MP4 files', async () => {
    const response = await postTask('delete-me');
    expect(response.status).toBe(202);
    await waitFor(() => mockStartedTasks.length === 1);

    const taskId = 'ffzyapi.com_delete-me_0';
    const deletion = route.DELETE(makeRequest(`/api/offline-download?taskId=${taskId}`, 'DELETE'));
    expect(mockDownloader.deleteTask).not.toHaveBeenCalled();
    const deleteResponse = await deletion;
    expect(deleteResponse.status).toBe(200);
    expect(mockDownloader.deleteTask).toHaveBeenCalledTimes(1);
    expect(await readTasks()).toEqual([]);
  });

  it('keeps a task visible when deleting its server files fails', async () => {
    const response = await postTask('delete-failure');
    expect(response.status).toBe(202);
    await waitFor(() => mockStartedTasks.length === 1);
    mockWork.get('ffzyapi.com_delete-failure_0')?.finish();
    await waitFor(() => mockPublishedIds.size === 1);

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockDownloader.deleteTask.mockRejectedValueOnce(new Error('filesystem is read-only'));
    const deletion = await route.DELETE(makeRequest('/api/offline-download?taskId=ffzyapi.com_delete-failure_0', 'DELETE'));
    consoleError.mockRestore();
    expect(deletion.status).toBe(500);
    const [remaining] = await readTasks();
    expect(remaining.status).toBe('error');
    expect(remaining.errorMessage).toContain('filesystem is read-only');
    expect(remaining.playbackUrl).toBeTruthy();
  });

  it('re-publishes an existing completed HLS cache without downloading the source again', async () => {
    const response = await postTask('retry-remux');
    expect(response.status).toBe(202);
    await waitFor(() => mockStartedTasks.length === 1);
    mockWork.get('ffzyapi.com_retry-remux_0')?.finish();
    await waitFor(() => mockPublishedIds.size === 1);

    const [completed] = await readTasks();
    const playbackId = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'tasks.json'), 'utf-8'))[0].playbackId;
    mockPublishedIds.delete(playbackId);

    const retry = await route.PUT(makeRequest('/api/offline-download?taskId=ffzyapi.com_retry-remux_0&action=retry', 'PUT'));
    expect(retry.status).toBe(202);
    await waitFor(async () => {
      const [task] = await readTasks();
      return task?.status === 'completed' || task?.status === 'error';
    });
    const [retried] = await readTasks();
    expect(completed.status).toBe('completed');
    expect(retried.status).toBe('completed');
    expect(retried.playbackUrl).toContain(playbackId);
    expect(mockStartedTasks).toEqual(['ffzyapi.com_retry-remux_0']);
    expect(mockDownloader.publishHls).toHaveBeenCalledTimes(2);
  });

  it('removes a published HLS page and task record on deletion', async () => {
    const response = await postTask('delete-published');
    expect(response.status).toBe(202);
    await waitFor(() => mockStartedTasks.length === 1);
    mockWork.get('ffzyapi.com_delete-published_0')?.finish();
    await waitFor(() => mockPublishedIds.size === 1);

    const persisted = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'tasks.json'), 'utf-8'));
    const [storedTask] = persisted as { id: string; playbackId: string }[];
    expect(storedTask.playbackId).toBeTruthy();
    const deletion = await route.DELETE(makeRequest(`/api/offline-download?taskId=${storedTask.id}`, 'DELETE'));

    expect(deletion.status).toBe(200);
    expect(mockPublishedIds.has(storedTask.playbackId)).toBe(false);
    expect(mockLocalHlsKeys.has('ffzyapi.com/delete-published/0')).toBe(false);
    expect(await readTasks()).toEqual([]);
  });

  it('backfills a legacy MP4 task on startup without requesting the source', async () => {
    const playbackId = '00000000-0000-4000-8000-000000000101';
    mockLegacyMp4Ids.add(playbackId);
    fs.writeFileSync(path.join(temporaryRoot, 'tasks.json'), JSON.stringify([{
      id: 'legacy_mp4_task',
      source: 'ffzyapi.com',
      videoId: 'legacy-mp4',
      episodeIndex: 0,
      title: '旧 MP4 缓存',
      m3u8Url: 'https://stream.example/legacy/playlist.m3u8',
      status: 'completed',
      progress: 100,
      totalSegments: 2,
      downloadedSegments: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadDir: path.join(temporaryRoot, 'ffzyapi.com', 'legacy-mp4', 'ep1'),
      playbackId,
    }]));
    jest.resetModules();
    route = await import('./route');

    await waitFor(async () => {
      const [task] = await readTasks();
      return task?.status === 'completed' || task?.status === 'error';
    });
    const [task] = await readTasks();
    expect(task.status).toBe('completed');
    expect(task.playbackUrl).toBe(`/media/compat/${playbackId}`);
    expect(mockDownloader.publishHls).toHaveBeenCalledTimes(1);
    expect(mockDownloader.startDownload).not.toHaveBeenCalled();
  });

  it('backfills a complete private HLS cache on startup without requesting the source', async () => {
    const playbackId = '00000000-0000-4000-8000-000000000102';
    mockLocalHlsKeys.add('ffzyapi.com/legacy-hls/0');
    fs.writeFileSync(path.join(temporaryRoot, 'tasks.json'), JSON.stringify([{
      id: 'legacy_hls_task',
      source: 'ffzyapi.com',
      videoId: 'legacy-hls',
      episodeIndex: 0,
      title: '旧 HLS 缓存',
      m3u8Url: 'https://stream.example/legacy-hls/playlist.m3u8',
      status: 'completed',
      progress: 100,
      totalSegments: 2,
      downloadedSegments: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadDir: path.join(temporaryRoot, 'ffzyapi.com', 'legacy-hls', 'ep1'),
      playbackId,
    }]));
    jest.resetModules();
    route = await import('./route');

    await waitFor(async () => {
      const [task] = await readTasks();
      return task?.status === 'completed' || task?.status === 'error';
    });
    const [task] = await readTasks();
    expect(task.status).toBe('completed');
    expect(task.playbackUrl).toBe(`/media/compat/${playbackId}`);
    expect(mockDownloader.publishHls).toHaveBeenCalledTimes(1);
    expect(mockDownloader.startDownload).not.toHaveBeenCalled();
  });

  it('restores an already-published HLS task as completed without re-queueing it', async () => {
    const playbackId = '00000000-0000-4000-8000-000000000104';
    mockPublishedIds.add(playbackId);
    fs.writeFileSync(path.join(temporaryRoot, 'tasks.json'), JSON.stringify([{
      id: 'ready_hls_task',
      source: 'ffzyapi.com',
      videoId: 'ready-hls',
      episodeIndex: 0,
      title: '已发布 HLS 缓存',
      m3u8Url: 'https://stream.example/ready-hls/playlist.m3u8',
      status: 'remuxing',
      progress: 100,
      totalSegments: 2,
      downloadedSegments: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadDir: path.join(temporaryRoot, 'ffzyapi.com', 'ready-hls', 'ep1'),
      playbackId,
    }]));
    jest.resetModules();
    route = await import('./route');

    const [task] = await readTasks();
    expect(task.status).toBe('completed');
    expect(task.playbackUrl).toBe(`/media/compat/${playbackId}`);
    expect(mockDownloader.publishHls).not.toHaveBeenCalled();
    expect(mockDownloader.startDownload).not.toHaveBeenCalled();
  });

  it('preserves an existing error even when its published HLS page is still available', async () => {
    const playbackId = '00000000-0000-4000-8000-000000000105';
    mockPublishedIds.add(playbackId);
    fs.writeFileSync(path.join(temporaryRoot, 'tasks.json'), JSON.stringify([{
      id: 'failed_delete_task',
      source: 'ffzyapi.com',
      videoId: 'failed-delete',
      episodeIndex: 0,
      title: '删除失败任务',
      m3u8Url: 'https://stream.example/failed-delete/playlist.m3u8',
      status: 'error',
      progress: 100,
      totalSegments: 2,
      downloadedSegments: 2,
      errorMessage: '删除缓存失败：文件系统只读',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadDir: path.join(temporaryRoot, 'ffzyapi.com', 'failed-delete', 'ep1'),
      playbackId,
    }]));
    jest.resetModules();
    route = await import('./route');

    const [task] = await readTasks();
    expect(task.status).toBe('error');
    expect(task.errorMessage).toContain('文件系统只读');
    expect(task.playbackUrl).toBe(`/media/compat/${playbackId}`);
    expect(mockDownloader.publishHls).not.toHaveBeenCalled();
    expect(mockDownloader.startDownload).not.toHaveBeenCalled();
  });

  it('keeps a failed startup backfill retryable and retries without requesting the source', async () => {
    const playbackId = '00000000-0000-4000-8000-000000000103';
    mockLegacyMp4Ids.add(playbackId);
    mockDownloader.publishHls.mockRejectedValueOnce(new Error('发布目录暂不可写'));
    fs.writeFileSync(path.join(temporaryRoot, 'tasks.json'), JSON.stringify([{
      id: 'legacy_retry_task',
      source: 'ffzyapi.com',
      videoId: 'legacy-retry',
      episodeIndex: 0,
      title: '待重试旧缓存',
      m3u8Url: 'https://stream.example/legacy-retry/playlist.m3u8',
      status: 'completed',
      progress: 100,
      totalSegments: 2,
      downloadedSegments: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadDir: path.join(temporaryRoot, 'ffzyapi.com', 'legacy-retry', 'ep1'),
      playbackId,
    }]));
    jest.resetModules();
    route = await import('./route');

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await waitFor(async () => (await readTasks())[0]?.status === 'error');
      const [failed] = await readTasks();
      expect(failed.errorMessage).toContain('HLS 兼容播放发布失败');
    } finally {
      consoleError.mockRestore();
    }

    const retry = await route.PUT(makeRequest('/api/offline-download?taskId=legacy_retry_task&action=retry', 'PUT'));
    expect(retry.status).toBe(202);
    await waitFor(async () => {
      const [task] = await readTasks();
      return task?.status === 'completed' || task?.status === 'error';
    });
    const [task] = await readTasks();
    expect(task.status).toBe('completed');
    expect(task.playbackUrl).toBe(`/media/compat/${playbackId}`);
    expect(mockDownloader.startDownload).not.toHaveBeenCalled();
  });
});
