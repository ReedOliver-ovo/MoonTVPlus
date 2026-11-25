/* eslint-disable @next/next/no-img-element */

import React, { useEffect, useMemo, useState } from 'react';

export interface ServerDownloadEpisodeState {
  status: 'pending' | 'downloading' | 'remuxing' | 'completed' | 'error' | 'paused';
  playbackUrl?: string;
}

const EMPTY_EPISODE_URLS: string[] = [];

interface DownloadEpisodeSelectorProps {
  /** 是否显示弹窗 */
  isOpen: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 总集数 */
  totalEpisodes: number;
  /** 剧集标题 */
  episodesTitles?: string[];
  /** 视频标题 */
  videoTitle: string;
  /** 当前集数索引（0开始） */
  currentEpisodeIndex: number;
  /** 下载回调 - 支持批量下载 */
  onDownload: (
    episodeIndexes: number[],
    offlineMode: boolean
  ) => void | Promise<void>;
  forceOfflineMode?: boolean;
  episodeUrls?: string[];
  offlineEpisodeStates?: Record<number, ServerDownloadEpisodeState>;
  offlineStatesLoading?: boolean;
  /** 是否启用离线下载功能 */
  enableOfflineDownload?: boolean;
  /** 是否有离线下载权限（管理员或站长） */
  hasOfflinePermission?: boolean;
}

/**
 * 下载选集面板组件
 */
const DownloadEpisodeSelector: React.FC<DownloadEpisodeSelectorProps> = ({
  isOpen,
  onClose,
  totalEpisodes,
  episodesTitles = [],
  videoTitle,
  currentEpisodeIndex,
  onDownload,
  forceOfflineMode = false,
  episodeUrls = EMPTY_EPISODE_URLS,
  offlineEpisodeStates = {},
  offlineStatesLoading = false,
  enableOfflineDownload = false,
  hasOfflinePermission = false,
}) => {
  // 多选状态 - 使用 Set 存储选中的集数索引
  const [selectedEpisodes, setSelectedEpisodes] = useState<Set<number>>(
    new Set([currentEpisodeIndex])
  );

  // 离线下载模式
  const [offlineMode, setOfflineMode] = useState(forceOfflineMode);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // 每页显示的集数
  const episodesPerPage = 50;
  const pageCount = Math.ceil(totalEpisodes / episodesPerPage);
  const isServerDownload = forceOfflineMode || offlineMode;
  const eligibleEpisodes = useMemo(
    () =>
      Array.from({ length: totalEpisodes }, (_, index) => index).filter(
        (index) =>
          !offlineEpisodeStates[index] &&
          (!isServerDownload || Boolean(episodeUrls[index]?.match(/m3u8/i)))
      ),
    [episodeUrls, isServerDownload, offlineEpisodeStates, totalEpisodes]
  );

  useEffect(() => {
    if (!isOpen) return;
    setOfflineMode(forceOfflineMode);
    setSelectedEpisodes(new Set([currentEpisodeIndex]));
    setSubmitError('');
    setIsSubmitting(false);
  }, [currentEpisodeIndex, forceOfflineMode, isOpen]);

  useEffect(() => {
    const eligible = new Set(eligibleEpisodes);
    setSelectedEpisodes((previous) => {
      const next = new Set(
        Array.from(previous).filter((index) => eligible.has(index))
      );
      if (next.size === 0 && eligible.has(currentEpisodeIndex)) {
        next.add(currentEpisodeIndex);
      }
      if (next.size === 0 && eligibleEpisodes.length > 0) {
        next.add(eligibleEpisodes[0]);
      }
      return next;
    });
  }, [currentEpisodeIndex, eligibleEpisodes]);

  // 当前分页索引（0 开始）
  const initialPage = Math.floor(currentEpisodeIndex / episodesPerPage);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);

  // 是否倒序显示
  const [descending, setDescending] = useState<boolean>(false);

  // 根据 descending 状态计算实际显示的分页索引
  const displayPage = useMemo(() => {
    if (descending) {
      return pageCount - 1 - currentPage;
    }
    return currentPage;
  }, [currentPage, descending, pageCount]);

  // 升序分页标签
  const categoriesAsc = useMemo(() => {
    return Array.from({ length: pageCount }, (_, i) => {
      const start = i * episodesPerPage + 1;
      const end = Math.min(start + episodesPerPage - 1, totalEpisodes);
      return { start, end };
    });
  }, [pageCount, episodesPerPage, totalEpisodes]);

  // 根据 descending 状态决定分页标签的排序和内容
  const categories = useMemo(() => {
    if (descending) {
      return [...categoriesAsc]
        .reverse()
        .map(({ start, end }) => `${end}-${start}`);
    }
    return categoriesAsc.map(({ start, end }) => `${start}-${end}`);
  }, [categoriesAsc, descending]);

  const handleCategoryClick = (index: number) => {
    if (descending) {
      setCurrentPage(pageCount - 1 - index);
    } else {
      setCurrentPage(index);
    }
  };

  const handleEpisodeClick = (episodeIndex: number) => {
    if (isSubmitting || offlineEpisodeStates[episodeIndex]) return;

    setSelectedEpisodes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(episodeIndex)) {
        newSet.delete(episodeIndex);
      } else {
        newSet.add(episodeIndex);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (isSubmitting) return;
    setSelectedEpisodes(new Set(eligibleEpisodes));
  };

  const handleClearAll = () => {
    if (isSubmitting) return;
    setSelectedEpisodes(new Set());
  };

  const handleDownload = async () => {
    const episodeIndexes = Array.from(selectedEpisodes)
      .filter((index) => eligibleEpisodes.includes(index))
      .sort((a, b) => a - b);
    if (episodeIndexes.length === 0 || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError('');
    try {
      await onDownload(episodeIndexes, isServerDownload);
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : '提交下载任务失败'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentStart = currentPage * episodesPerPage;
  const currentEnd = Math.min(currentStart + episodesPerPage - 1, totalEpisodes - 1);

  if (!isOpen) return null;

  return (
    <div className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm'>
      <div className='bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-[90vw] max-w-4xl max-h-[80vh] flex flex-col overflow-hidden border border-gray-200 dark:border-gray-700'>
        {/* 标题栏 */}
        <div className='flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700'>
          <div className='flex-1'>
            <h2 className='text-xl font-bold text-gray-900 dark:text-gray-100'>
              {forceOfflineMode ? '选择缓存集数' : '选择要下载的集数'}
            </h2>
            <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
              {videoTitle}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <button
              onClick={handleSelectAll}
              className='px-3 py-1.5 text-xs font-medium text-green-600 hover:text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:text-green-300 dark:hover:bg-green-900/20 rounded-md transition-colors'
            >
              全选
            </button>
            <button
              onClick={handleClearAll}
              className='px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-300 dark:hover:bg-gray-700 rounded-md transition-colors'
            >
              清空
            </button>
            <button
              onClick={onClose}
              className='flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700 transition-colors'
            >
              <svg
                className='w-5 h-5'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M6 18L18 6M6 6l12 12'
                />
              </svg>
            </button>
          </div>
        </div>

        {/* 离线下载开关 - 仅管理员和站长可见 */}
        {forceOfflineMode ? (
          <div className='border-b border-blue-100 bg-blue-50 px-6 py-3 text-sm text-blue-800 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-200'>
            任务会在服务器后台继续运行，完成后可在下载文件管理中查看。
          </div>
        ) : enableOfflineDownload && hasOfflinePermission ? (
          <div className='flex items-center justify-between px-6 py-3 bg-blue-50 dark:bg-blue-900/10 border-b border-blue-100 dark:border-blue-900/30'>
            <div className='flex items-center gap-3'>
              {/* 服务器图标 */}
              <div className='flex-shrink-0 w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center'>
                <svg className='w-5 h-5 text-blue-600 dark:text-blue-400' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                  <path strokeLinecap='round' strokeLinejoin='round' strokeWidth='2' d='M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01' />
                </svg>
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-2'>
                  <h3 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                    服务器离线下载
                  </h3>
                  {offlineMode && (
                    <span className='px-2 py-0.5 text-xs font-medium bg-blue-500 text-white rounded'>
                      已启用
                    </span>
                  )}
                </div>
                <p className='text-xs text-gray-600 dark:text-gray-400 mt-0.5'>
                  开启后将在服务器端下载视频文件，支持断点续传和后台下载
                </p>
              </div>
            </div>
            {/* 开关 */}
            <button
              onClick={() => setOfflineMode(!offlineMode)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                offlineMode
                  ? 'bg-blue-600'
                  : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                  offlineMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        ) : null}

        {isServerDownload && offlineStatesLoading ? (
          <p className='border-b border-gray-200 px-6 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400' role='status'>
            正在读取缓存状态…
          </p>
        ) : null}

        {/* 分页标签 */}
        {pageCount > 1 && (
          <div className='flex items-center gap-4 px-6 py-3 border-b border-gray-200 dark:border-gray-700'>
            <div className='flex-1 overflow-x-auto'>
              <div className='flex gap-2 min-w-max'>
                {categories.map((label, idx) => {
                  const isActive = idx === displayPage;
                  return (
                    <button
                      key={label}
                      onClick={() => handleCategoryClick(idx)}
                      className={`px-4 py-2 text-sm font-medium rounded-md transition-all whitespace-nowrap
                        ${
                          isActive
                            ? 'bg-green-500 text-white shadow-md'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                        }
                      `.trim()}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 向上/向下按钮 */}
            <button
              className='flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-gray-700 hover:text-green-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-gray-700 transition-colors'
              onClick={() => setDescending((prev) => !prev)}
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4'
                />
              </svg>
            </button>
          </div>
        )}

        {/* 集数网格 */}
        <div className='flex-1 overflow-y-auto px-6 py-4'>
          <div className='flex flex-wrap gap-3'>
            {(() => {
              const len = currentEnd - currentStart + 1;
              const episodes = Array.from({ length: len }, (_, i) =>
                descending ? currentEnd - i : currentStart + i
              );
              return episodes;
            })().map((episodeIndex) => {
              const isSelected = selectedEpisodes.has(episodeIndex);
              const isCurrent = episodeIndex === currentEpisodeIndex;
              const episodeNumber = episodeIndex + 1;
              const downloadState = isServerDownload
                ? offlineEpisodeStates[episodeIndex]
                : undefined;
              const hasEpisodeUrl = Boolean(episodeUrls[episodeIndex]?.match(/m3u8/i));
              const isDisabled =
                isSubmitting ||
                Boolean(downloadState) ||
                (isServerDownload && !hasEpisodeUrl);
              return (
                <button
                  key={episodeIndex}
                  onClick={() => handleEpisodeClick(episodeIndex)}
                  disabled={isDisabled}
                  title={
                    downloadState?.status === 'completed'
                      ? downloadState.playbackUrl
                        ? '该集已缓存完成'
                        : '该集已有缓存任务'
                      : downloadState
                        ? '该集已有服务端缓存任务'
                        : isServerDownload && !hasEpisodeUrl
                          ? '没有该集的片源地址'
                          : undefined
                  }
                  className={`h-10 min-w-10 px-3 py-2 flex items-center justify-center text-sm font-medium rounded-md transition-all duration-200 whitespace-nowrap font-mono relative
                    ${
                      isSelected
                        ? 'bg-green-500 text-white shadow-lg shadow-green-500/25 dark:bg-green-600'
                        : downloadState?.status === 'completed'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                          : downloadState
                            ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200'
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300 hover:scale-105 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }
                    disabled:cursor-not-allowed disabled:opacity-60
                  `.trim()}
                >
                  {(() => {
                    const title = episodesTitles?.[episodeIndex];
                    if (!title) {
                      return episodeNumber;
                    }
                    // 如果是 OVA 格式，直接返回完整标题
                    if (title.match(/^OVA\s+\d+/i)) {
                      return title;
                    }
                    // 如果匹配"第X集"、"第X话"、"X集"、"X话"格式，提取中间的数字
                    const match = title.match(/(?:第)?(\d+)(?:集|话)/);
                    if (match) {
                      return match[1];
                    }
                    return title;
                  })()}
                  {isCurrent && !forceOfflineMode && (
                    <span className='absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full'></span>
                  )}
                  {downloadState ? (
                    <span className='ml-1 font-sans text-[10px]'>
                      {downloadState.status === 'completed'
                        ? '已缓存'
                        : downloadState.status === 'remuxing'
                          ? '封装中'
                          : downloadState.status === 'error' || downloadState.status === 'paused'
                            ? '可重试'
                            : '缓存中'}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {submitError ? (
          <p className='border-t border-red-200 px-6 py-2 text-sm text-red-600 dark:border-red-800 dark:text-red-300' role='alert'>
            {submitError}
          </p>
        ) : null}

        {/* 底部操作栏 */}
        <div
          className={`${
            forceOfflineMode
              ? 'flex flex-col items-stretch gap-3 px-4 py-3 sm:px-6 sm:py-4'
              : 'flex items-center justify-between px-6 py-4'
          } border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900`}
        >
          <div className={`${forceOfflineMode ? 'text-xs sm:text-sm' : 'text-sm'} text-gray-600 dark:text-gray-400`}>
            已选择：
            {selectedEpisodes.size === 0 ? (
              <span className='text-red-500 dark:text-red-400'>未选择任何集数</span>
            ) : selectedEpisodes.size === 1 ? (
              <>
                第 {Array.from(selectedEpisodes)[0] + 1} 集
                {!forceOfflineMode && Array.from(selectedEpisodes)[0] === currentEpisodeIndex && (
                  <span className='ml-2 text-blue-500 dark:text-blue-400'>(当前播放)</span>
                )}
              </>
            ) : (
              <span className='font-medium text-green-600 dark:text-green-400'>
                {selectedEpisodes.size} 集
            </span>
            )}
          </div>
          <div className={`flex gap-3 ${forceOfflineMode ? 'justify-end' : ''}`}>
            <button
              onClick={onClose}
              className={`px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 rounded-md transition-colors ${forceOfflineMode ? 'shrink-0 whitespace-nowrap' : ''}`}
            >
              取消
            </button>
            <button
              onClick={handleDownload}
              disabled={selectedEpisodes.size === 0 || isSubmitting || offlineStatesLoading}
              className={`px-4 py-2 text-sm font-medium text-white rounded-md transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${forceOfflineMode ? 'shrink-0 whitespace-nowrap' : ''} ${
                isServerDownload && enableOfflineDownload && hasOfflinePermission
                  ? 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800'
                  : 'bg-green-500 hover:bg-green-600 dark:bg-green-600 dark:hover:bg-green-700 disabled:hover:bg-green-500'
              }`}
            >
              {isSubmitting
                ? '正在提交…'
                : `${isServerDownload && enableOfflineDownload && hasOfflinePermission ? '加入服务器缓存' : '下载'} ${selectedEpisodes.size > 0 ? `(${selectedEpisodes.size})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DownloadEpisodeSelector;
