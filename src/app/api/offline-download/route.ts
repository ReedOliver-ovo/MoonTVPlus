/**
 * 离线下载任务管理 API
 */
/* eslint-disable no-console */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import * as path from 'path';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { OfflineDownloader, OfflineDownloadTask } from '@/lib/offline-downloader';

const OFFLINE_DOWNLOAD_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_OFFLINE_DOWNLOAD === 'true';
const OFFLINE_DOWNLOAD_DIR = process.env.OFFLINE_DOWNLOAD_DIR || '/data';
const OFFLINE_DOWNLOAD_PROXY = process.env.OFFLINE_DOWNLOAD_PROXY || '';
const OFFLINE_DOWNLOAD_EXPORT_DIR =
  process.env.OFFLINE_DOWNLOAD_EXPORT_DIR?.trim() || undefined;
const PLAYBACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let downloader: OfflineDownloader | null = null;
const tasks = new Map<string, OfflineDownloadTask>();
const activeDownloads = new Map<string, Promise<void>>();
const cancellationControllers = new Map<string, AbortController>();
const deletingTasks = new Set<string>();
const TASKS_FILE = path.join(OFFLINE_DOWNLOAD_DIR, 'tasks.json');
let queueRunner: Promise<void> | null = null;

function saveTasks(): void {
  const temporaryPath = `${TASKS_FILE}.${randomUUID()}.tmp`;
  try {
    const taskData = Array.from(tasks.values()).map((task) => ({
      ...task,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
    fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(taskData, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, TASKS_FILE);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Leave the persistence error as the reported failure.
    }
    throw error;
  }
}

function loadTasks(): void {
  if (!fs.existsSync(TASKS_FILE)) return;

  try {
    const storedTasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    if (!Array.isArray(storedTasks)) throw new Error('任务文件格式无效');

    for (const taskData of storedTasks) {
      const episodeIndex = Number(taskData.episodeIndex);
      if (
        typeof taskData.id !== 'string' ||
        !taskData.id ||
        typeof taskData.source !== 'string' ||
        typeof taskData.videoId !== 'string' ||
        !Number.isInteger(episodeIndex) ||
        episodeIndex < 0
      ) {
        continue;
      }

      let downloadDir: string;
      try {
        downloadDir = getDownloader().getDownloadDirectory(
          taskData.source,
          taskData.videoId,
          episodeIndex
        );
      } catch {
        continue;
      }

      const task: OfflineDownloadTask = {
        ...taskData,
        episodeIndex,
        downloadDir,
        createdAt: new Date(taskData.createdAt),
        updatedAt: new Date(taskData.updatedAt),
        playbackId:
          typeof taskData.playbackId === 'string' &&
          PLAYBACK_ID_PATTERN.test(taskData.playbackId)
            ? taskData.playbackId
            : undefined,
      };

      if (task.status === 'downloading' || task.status === 'pending') {
        task.status = 'paused';
        task.errorMessage = '服务器重启，任务已暂停';
      } else if (task.status === 'remuxing') {
        if (getDownloader().getPlaybackUrl(task)) {
          task.status = 'completed';
          task.errorMessage = undefined;
        } else {
          task.status = 'paused';
          task.errorMessage = '服务器重启，MP4 封装已暂停，请重试';
        }
      }

      tasks.set(task.id, task);
    }
  } catch (error) {
    console.error('加载离线下载任务失败:', error);
  }
}

function getDownloader(): OfflineDownloader {
  if (!downloader) {
    downloader = new OfflineDownloader(
      OFFLINE_DOWNLOAD_DIR,
      OFFLINE_DOWNLOAD_PROXY,
      OFFLINE_DOWNLOAD_EXPORT_DIR
    );
    loadTasks();
  }
  return downloader;
}

function checkPermission(request: NextRequest): boolean {
  if (!OFFLINE_DOWNLOAD_ENABLED) return false;
  const authInfo = getAuthInfoFromCookie(request);
  return Boolean(
    authInfo?.username &&
      (authInfo.role === 'owner' || authInfo.role === 'admin')
  );
}

function serializeTask(task: OfflineDownloadTask) {
  const { playbackId: _playbackId, ...publicTask } = task;
  const playbackUrl = getDownloader().getPlaybackUrl(task);
  return {
    ...publicTask,
    ...(playbackUrl ? { playbackUrl } : {}),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

function getNextQueuedTask(): OfflineDownloadTask | undefined {
  return Array.from(tasks.values())
    .filter(
      (task) => task.status === 'pending' && !deletingTasks.has(task.id)
    )
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id)
    )[0];
}

function updateTask(task: OfflineDownloadTask): void {
  if (deletingTasks.has(task.id)) return;
  tasks.set(task.id, task);
  saveTasks();
}

async function processTask(
  task: OfflineDownloadTask,
  signal: AbortSignal
): Promise<void> {
  const taskDownloader = getDownloader();
  const exportToMp4 = Boolean(OFFLINE_DOWNLOAD_EXPORT_DIR);

  try {
    if (exportToMp4) taskDownloader.getOrCreatePlaybackId(task);
    await taskDownloader.startDownload(
      task,
      updateTask,
      signal,
      exportToMp4
    );
    if (signal.aborted || deletingTasks.has(task.id)) return;

    if (exportToMp4) {
      task.status = 'remuxing';
      task.errorMessage = undefined;
      task.updatedAt = new Date();
      updateTask(task);
      await taskDownloader.remuxToMp4(task, signal);
      if (signal.aborted || deletingTasks.has(task.id)) return;
    }

    task.status = 'completed';
    task.progress = 100;
    task.errorMessage = undefined;
    task.updatedAt = new Date();
    updateTask(task);
  } catch (error) {
    if (signal.aborted || deletingTasks.has(task.id)) return;
    task.status = 'error';
    task.errorMessage =
      error instanceof Error ? error.message : '离线下载或 MP4 封装失败';
    task.updatedAt = new Date();
    tasks.set(task.id, task);
    try {
      saveTasks();
    } catch (saveError) {
      console.error('保存缓存任务错误状态失败:', saveError);
    }
    console.error('服务器离线缓存任务失败:', error);
  }
}

function scheduleQueuedTasks(): void {
  if (queueRunner) return;

  queueRunner = Promise.resolve()
    .then(async () => {
      let nextTask = getNextQueuedTask();
      while (nextTask) {
        const controller = new AbortController();
        cancellationControllers.set(nextTask.id, controller);
        const work = processTask(nextTask, controller.signal);
        activeDownloads.set(nextTask.id, work);

        try {
          await work;
        } finally {
          activeDownloads.delete(nextTask.id);
          cancellationControllers.delete(nextTask.id);
        }
        nextTask = getNextQueuedTask();
      }
    })
    .catch((error) => {
      console.error('离线下载队列异常:', error);
    })
    .finally(() => {
      queueRunner = null;
      if (
        Array.from(tasks.values()).some((task) => task.status === 'pending')
      ) {
        scheduleQueuedTasks();
      }
    });
}

export async function GET(request: NextRequest) {
  if (!checkPermission(request)) {
    return NextResponse.json({ error: '无权限' }, { status: 403 });
  }

  getDownloader();
  const { searchParams } = new URL(request.url);
  if (searchParams.get('action') === 'check') {
    const source = searchParams.get('source');
    const videoId = searchParams.get('videoId');
    const episodeIndexValue = searchParams.get('episodeIndex');
    const episodeIndex = Number(episodeIndexValue);
    if (!source || !videoId || episodeIndexValue === null || !Number.isInteger(episodeIndex)) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }
    try {
      return NextResponse.json({
        downloaded: getDownloader().checkDownloaded(
          source,
          videoId,
          episodeIndex
        ),
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '参数无效' },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ tasks: Array.from(tasks.values()).map(serializeTask) });
}

export async function POST(request: NextRequest) {
  if (!checkPermission(request)) {
    return NextResponse.json({ error: '无权限' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { source, videoId, episodeIndex, title, m3u8Url, metadata } = body;
    if (
      !source ||
      !videoId ||
      !Number.isInteger(episodeIndex) ||
      !title ||
      typeof m3u8Url !== 'string'
    ) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 });
    }

    const taskDownloader = getDownloader();
    try {
      taskDownloader.getDownloadDirectory(
        source,
        videoId,
        episodeIndex
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '参数无效' },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(m3u8Url);
    } catch {
      return NextResponse.json({ error: '播放列表地址无效' }, { status: 400 });
    }
    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
      parsedUrl.href.length > 8192
    ) {
      return NextResponse.json({ error: '仅支持 HTTP 或 HTTPS 播放地址' }, { status: 400 });
    }

    const existingTask = Array.from(tasks.values()).find(
      (task) =>
        task.source === source &&
        task.videoId === videoId &&
        task.episodeIndex === episodeIndex
    );
    if (existingTask && deletingTasks.has(existingTask.id)) {
      return NextResponse.json({ error: '该缓存任务正在删除，请稍后重试' }, { status: 409 });
    }

    if (
      existingTask?.status === 'pending' ||
      existingTask?.status === 'downloading' ||
      existingTask?.status === 'remuxing'
    ) {
      return NextResponse.json(
        { task: serializeTask(existingTask), message: '该视频已在缓存队列中' },
        { status: 202 }
      );
    }

    if (existingTask?.status === 'completed') {
      if (taskDownloader.getPlaybackUrl(existingTask)) {
        return NextResponse.json(
          { task: serializeTask(existingTask), message: '该视频已缓存，可复制现有播放链接' },
          { status: 409 }
        );
      }
      const previousStatus = existingTask.status;
      const previousErrorMessage = existingTask.errorMessage;
      const previousUpdatedAt = existingTask.updatedAt;
      existingTask.status = 'pending';
      existingTask.errorMessage = undefined;
      existingTask.updatedAt = new Date();
      tasks.set(existingTask.id, existingTask);
      try {
        saveTasks();
      } catch (error) {
        existingTask.status = previousStatus;
        existingTask.errorMessage = previousErrorMessage;
        existingTask.updatedAt = previousUpdatedAt;
        return NextResponse.json(
          { error: error instanceof Error ? error.message : '任务状态保存失败' },
          { status: 507 }
        );
      }
      scheduleQueuedTasks();
      return NextResponse.json(
        { task: serializeTask(existingTask), message: '已加入服务器缓存队列' },
        { status: 202 }
      );
    }

    if (existingTask) {
      return NextResponse.json(
        { task: serializeTask(existingTask), message: '该任务未完成，请在下载管理中重试' },
        { status: 409 }
      );
    }

    if (taskDownloader.checkDownloaded(source, videoId, episodeIndex)) {
      return NextResponse.json(
        { error: '该视频 HLS 分片已存在，但没有任务记录。请通过下载管理恢复该任务' },
        { status: 409 }
      );
    }

    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : undefined;
    const task = taskDownloader.createTask(
      source,
      videoId,
      episodeIndex,
      String(title).slice(0, 240),
      parsedUrl.href,
      safeMetadata
    );
    task.status = 'pending';
    tasks.set(task.id, task);
    try {
      saveTasks();
    } catch (error) {
      tasks.delete(task.id);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '任务状态保存失败' },
        { status: 507 }
      );
    }
    scheduleQueuedTasks();

    return NextResponse.json(
      { task: serializeTask(task), message: '已加入服务器缓存队列' },
      { status: 202 }
    );
  } catch (error) {
    console.error('创建服务器缓存任务失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '创建服务器缓存任务失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!checkPermission(request)) {
    return NextResponse.json({ error: '无权限' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  if (!taskId) {
    return NextResponse.json({ error: '缺少任务ID' }, { status: 400 });
  }
  if (deletingTasks.has(taskId)) {
    return NextResponse.json({ error: '该任务正在删除' }, { status: 409 });
  }
  const task = tasks.get(taskId);
  if (!task) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  }

  deletingTasks.add(taskId);
  try {
    cancellationControllers.get(taskId)?.abort();
    getDownloader().requestCancel(taskId);
    const activeWork = activeDownloads.get(taskId);
    if (activeWork) await activeWork;

    await getDownloader().deleteTask(task);
    tasks.delete(taskId);
    try {
      saveTasks();
    } catch (error) {
      task.status = 'error';
      task.errorMessage = '视频文件已删除，但任务记录保存失败。请刷新下载管理后重试清理任务';
      task.updatedAt = new Date();
      tasks.set(taskId, task);
      try {
        saveTasks();
      } catch (recoveryError) {
        console.error('恢复已删除任务记录失败:', recoveryError);
      }
      throw error;
    }
    return NextResponse.json({ message: '服务器缓存及任务记录已删除' });
  } catch (error) {
    task.status = 'error';
    task.errorMessage = `删除缓存失败：${
      error instanceof Error ? error.message : '未知错误'
    }`;
    task.updatedAt = new Date();
    tasks.set(taskId, task);
    try {
      saveTasks();
    } catch (saveError) {
      console.error('保存删除错误状态失败:', saveError);
    }
    console.error('删除服务器缓存失败:', error);
    return NextResponse.json(
      { error: task.errorMessage },
      { status: 500 }
    );
  } finally {
    deletingTasks.delete(taskId);
  }
}

export async function PUT(request: NextRequest) {
  if (!checkPermission(request)) {
    return NextResponse.json({ error: '无权限' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    if (!taskId) {
      return NextResponse.json({ error: '缺少任务ID' }, { status: 400 });
    }
    if (searchParams.get('action') !== 'retry') {
      return NextResponse.json({ error: '无效的操作' }, { status: 400 });
    }
    if (deletingTasks.has(taskId)) {
      return NextResponse.json({ error: '该任务正在删除' }, { status: 409 });
    }

    const task = tasks.get(taskId);
    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }
    if (
      task.status === 'pending' ||
      task.status === 'downloading' ||
      task.status === 'remuxing' ||
      activeDownloads.has(taskId)
    ) {
      return NextResponse.json({ error: '任务正在进行中，无法重试' }, { status: 409 });
    }
    if (getDownloader().getPlaybackUrl(task)) {
      return NextResponse.json({
        error: '该任务已生成播放链接，无需重试',
        task: serializeTask(task),
      }, { status: 409 });
    }

    const previousStatus = task.status;
    const previousErrorMessage = task.errorMessage;
    const previousUpdatedAt = task.updatedAt;
    task.status = 'pending';
    task.errorMessage = undefined;
    task.updatedAt = new Date();
    tasks.set(taskId, task);
    try {
      saveTasks();
    } catch (error) {
      task.status = previousStatus;
      task.errorMessage = previousErrorMessage;
      task.updatedAt = previousUpdatedAt;
      tasks.set(taskId, task);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '任务状态保存失败' },
        { status: 507 }
      );
    }
    scheduleQueuedTasks();

    return NextResponse.json(
      { task: serializeTask(task), message: '已重新加入服务器缓存队列' },
      { status: 202 }
    );
  } catch (error) {
    console.error('重试服务器缓存任务失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '重试服务器缓存任务失败' },
      { status: 500 }
    );
  }
}
