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
      ? `/media/${task.playbackId}.mp4`
      : undefined
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
  checkDownloaded: jest.fn(() => false),
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
  remuxToMp4: jest.fn(async (task: { playbackId?: string }) => {
    if (task.playbackId) mockPublishedIds.add(task.playbackId);
  }),
  requestCancel: jest.fn(),
  deleteTask: jest.fn(async (task: { downloadDir: string; playbackId?: string }) => {
    mockDeletedDirectories.push(task.downloadDir);
    if (task.playbackId) mockPublishedIds.delete(task.playbackId);
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
    mockWork.clear();
    mockStartedTasks.length = 0;
    mockDeletedDirectories.length = 0;
    mockPlaybackCounter = 0;
    mockDownloader.getDownloadDirectory.mockClear();
    mockDownloader.getOrCreatePlaybackId.mockClear();
    mockDownloader.getPlaybackUrl.mockClear();
    mockDownloader.checkDownloaded.mockClear();
    mockDownloader.createTask.mockClear();
    mockDownloader.startDownload.mockClear();
    mockDownloader.remuxToMp4.mockClear();
    mockDownloader.requestCancel.mockClear();
    mockDownloader.deleteTask.mockClear();
    mockDownloader.deleteTask.mockImplementation(async (task) => {
      mockDeletedDirectories.push(task.downloadDir);
      if (task.playbackId) mockPublishedIds.delete(task.playbackId);
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

  it('queues jobs sequentially and persists playback links after remux', async () => {
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
    expect(saved.every((task) => task.playbackUrl?.startsWith('/media/'))).toBe(true);
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

  it('remuxes an existing completed HLS task when its generated playback file is missing', async () => {
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
    await waitFor(() => mockStartedTasks.length === 2);
    mockWork.get('ffzyapi.com_retry-remux_0')?.finish();
    await waitFor(() => mockPublishedIds.has(playbackId));
    const [retried] = await readTasks();
    expect(completed.status).toBe('completed');
    expect(retried.status).toBe('completed');
    expect(retried.playbackUrl).toContain(playbackId);
  });
});
