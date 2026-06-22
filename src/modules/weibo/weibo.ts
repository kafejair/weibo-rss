import config from "../../config";
import { CacheInterface, LoggerInterface, WeiboStatus, WeiboUserData } from "../../types";
import { logger } from "../logger";
import { createDetailAPI, GetWeiboDetailFunc } from "./api/detailAPI";
import { createDomainAPI, DomainNotFoundError, GetUIDByDomainFunc } from "./api/domainAPI";
import { createIndexAPI, GetIndexUserInfoFunc, GetWeiboContentListFunc, UserNotFoundError } from "./api/indexAPI";
import { createLongTextAPI, GetWeiboLongTextFunc } from "./api/longTextAPI";

export {
  DomainNotFoundError,
  UserNotFoundError,
};

export class WeiboData {
  private cache: CacheInterface;
  private logger: LoggerInterface;
  private getIndexUserInfo: GetIndexUserInfoFunc;
  private getWeiboContentList: GetWeiboContentListFunc;
  private getWeiboDetail: GetWeiboDetailFunc;
  private getWeiboLongText: GetWeiboLongTextFunc;
  private getUIDByDomain: GetUIDByDomainFunc;

  constructor(cache: CacheInterface, log: LoggerInterface = logger) {
    this.cache = cache;
    this.logger = log;
    const { getIndexUserInfo, getWeiboContentList } = createIndexAPI();
    const { getWeiboDetail } = createDetailAPI();
    const { getWeiboLongText } = createLongTextAPI();
    const { getUIDByDomain } = createDomainAPI();
    // bind to this
    Object.assign(this, {
      getIndexUserInfo,
      getWeiboContentList,
      getWeiboDetail,
      getWeiboLongText,
      getUIDByDomain,
    });
  }

  /**
   * get user's weibo
   */
  fetchUserLatestWeibo = async (uid: string) => {
    const indexInfo = await this.cache.memo(() => this.getIndexUserInfo(uid), `info-${uid}`, config.cacheTTL.apiIndexInfo);
    const { containerId } = indexInfo;
    const statusList = await this.cache.memo(async () => {
      const wbList = await this.getWeiboContentList(uid, containerId);
      return await Promise.all(
        wbList.map(status => this.fillStatusWithLongText(status))
      );
    }, `list-${uid}`, config.cacheTTL.apiStatusList);

    return {
      ...indexInfo,
      statusList,
    } as WeiboUserData;
  };

  /**
   * allow failure
   */
  fillStatusWithLongText = async (status: WeiboStatus) => {
    let newStatus = status;
    try {
      if (status.isLongText) {
        try {
          const longTextContent = await this.cache.memo(
            () => this.getWeiboLongText(status.id),
            `long-${status.id}`,
            config.cacheTTL.apiLongText,
          );
          newStatus = {
            ...status,
            text: longTextContent
          };
        } catch (error) {
          logger.error(error, `uid: ${status?.user?.id}, status: ${status.id}`);
          // fallback to detail
          newStatus = await this.cache.memo(
            () => this.getWeiboDetail(status.id),
            `dt-${status.id}`,
            config.cacheTTL.apiDetail,
          );
        }
      }
      // 转发的微博全文
      if (status.retweeted_status) {
        newStatus = {
          ...status,
          retweeted_status: await this.fillStatusWithLongText(status.retweeted_status),
        }
      }
    } catch (error) {
      logger.error(error, `uid: ${status?.user?.id}, status: ${status.id}`);
    }
    return newStatus;
  };

  /**
   * domain -> uid
   */
  fetchUIDByDomain = async (domain: string) => this.getUIDByDomain(domain);
}

export const getFirstImageUrl = (status: WeiboStatus): string | null => {
  if (status.pics && status.pics.length > 0) {
    return 'https://i0.wp.com/' + status.pics[0].large.url.replace('https://', '').replace('http://', '');
  }
  if (status.retweeted_status) {
    return getFirstImageUrl(status.retweeted_status);
  }
  return null;
};

export const statusToHTML = (status: WeiboStatus, includeImages: boolean = true) => {
  // 提取純文字內容，移除所有 HTML 標籤，避免干擾 Widget 解析器
  let pureText = status.text.replace(/<[^>]+>/g, '');
  
  // 轉發的微博也只取文字
  if (status.retweeted_status) {
    const retweetText = status.retweeted_status.text.replace(/<[^>]+>/g, '');
    const retweetUser = status.retweeted_status.user?.screen_name || '未知用戶';
    pureText += ` // 轉發 @${retweetUser}: ${retweetText}`;
  }

  if (includeImages) {
    let imageUrl = getFirstImageUrl(status);
    if (imageUrl) {
      // 在 HTML 中也使用本地代理 URL (這裡需要動態獲取 host，但 statusToHTML 沒傳入 ctx，
      // 所以我們先保留 getFirstImageUrl 的原始邏輯，它目前使用的是 i0.wp.com。
      // 為了保持一致，我們在 routes.ts 中已經處理了 XML 標籤的代理。
      // 如果 Widget 是讀取 HTML 裡的 img，i0.wp.com 應該是沒問題的（長按能顯示證明了這一點）。
      return `<div><img src="${imageUrl}" style="width: 100%;" /><div>${pureText}</div></div>`;
    }
  }

  return pureText;
};
