/**
 * URL 路由分发
 */
import Router from '@koa/router';
import NodeRSS from 'rss';
import axios from 'axios';
import { RSSKoaContext, RSSKoaState } from '../types';
import config from '../config';
import { DomainNotFoundError, getFirstImageUrl, statusToHTML, UserNotFoundError } from './weibo/weibo';
import { ThrottledError } from './throttler';
import { logger } from './logger';

export class UidInvalidError extends Error {
  constructor(uid: string) {
    super(`uid: ${uid}`);
  }
}

export class DomainInvalidError extends Error {
  constructor(domain: string) {
    super(`domain: ${domain}`);
  }
}

export const registerRoutes = (
  router: Router<RSSKoaState, RSSKoaContext>
) => {
  // 圖片代理路由，解決防盜鏈並統一域名
  router.get('/proxy/image', async (ctx) => {
    const url = ctx.query['url'] as string;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      ctx.status = 400;
      return;
    }
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          'Referer': 'https://weibo.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      ctx.set('Content-Type', (response.headers['content-type'] as string) || 'image/jpeg');
      ctx.set('Cache-Control', 'public, max-age=31536000'); // 緩存一年
      ctx.body = response.data;
    } catch (error) {
      ctx.status = 500;
      logger.error(`Proxy image failed: ${url}`, error);
    }
  });

  router.get(['/rss/user/:id', '/rss/user/:id.xml'], async (ctx) => {
    const uid = ctx.params['id'].replace('.xml', '');
    try {
      // check uid format
      if (!/^[0-9]{10}$/.test(uid)) {
        throw new UidInvalidError(uid);
      }

      // get data
      let cacheMiss = false;
      const xmlData = await ctx.cache.memo(async () => {
        const weiboData = await ctx.weibo.fetchUserLatestWeibo(uid);
        if (weiboData) {
          const host = ctx.host;
          const protocol = ctx.protocol;
          
          // 處理博主頭像代理，解決防盜鏈問題
          let avatarUrl = weiboData.avatarUrl;
          if (avatarUrl) {
            avatarUrl = `${protocol}://${host}/proxy/image?url=${encodeURIComponent(avatarUrl)}`;
          }

          // basic info
          const feed = new NodeRSS({
            // 將 site_url 改為博主的頭像代理網址或中性網址，避免 Launcher 強制抓取 weibo.com 的 favicon
            site_url: avatarUrl || ("https://weibo.com/" + uid),
            feed_url: '',
            title: weiboData.screenName + '的微博',
            description: weiboData.description,
            image_url: avatarUrl || 'https://weibo.com/favicon.ico',
            generator: 'https://github.com/zgq354/weibo-rss',
            ttl: config.rssTTL,
            custom_namespaces: {
              'media': 'http://search.yahoo.com/mrss/',
              'dc': 'http://purl.org/dc/elements/1.1/',
              'webfeeds': 'http://webfeeds.org/rss/1.0'
            },
            custom_elements: [
              { 'icon': avatarUrl || 'https://weibo.com/favicon.ico' },
              { 'logo': avatarUrl || 'https://weibo.com/favicon.ico' },
              { 'webfeeds:icon': avatarUrl || 'https://weibo.com/favicon.ico' },
              { 'webfeeds:accentColor': 'FF8200' }
            ]
          });
          // item
          weiboData.statusList?.forEach((status) => {
            if (!status) return;
            let imageUrl = getFirstImageUrl(status);
            // 將圖片 URL 轉換為本地代理 URL
            if (imageUrl) {
              // 從 status 中獲取原始微博 URL
              const rawWeiboUrl = status.pics?.[0]?.large?.url || status.retweeted_status?.pics?.[0]?.large?.url;
              if (rawWeiboUrl) {
                const host = ctx.host;
                const protocol = ctx.protocol;
                // 使用當前服務器的代理路由
                imageUrl = `${protocol}://${host}/proxy/image?url=${encodeURIComponent(rawWeiboUrl)}`;
              }
            }
            
            const custom_elements: any[] = [];
            if (imageUrl) {
              custom_elements.push({ 'media:content': { _attr: { url: imageUrl, medium: 'image' } } });
            }
            custom_elements.push({ 'dc:creator': { _cdata: weiboData.screenName } });
            // 將 guid 放入 custom_elements 以繞過類型限制，並精確控制屬性
            custom_elements.push({ 'guid': { _attr: { isPermaLink: 'false' }, _cdata: status.bid } });

            feed.item({
              title: status.status_title || (status.text ? status.text.replace(/<[^>]+>/g, '').replace(/[\n]/g, '').substr(0, 25) : null),
              description: statusToHTML(status, true),
              url: 'https://weibo.com/' + uid + '/' + status.bid,
              date: new Date(status.created_at),
              custom_elements
            });
          });
          cacheMiss = true;
          return feed.xml();
        }
      }, `xml-${uid}`, config.cacheTTL.rssXml);

      // send data
      ctx.set('Content-Type', 'text/xml; charset=utf-8');
      ctx.body = xmlData;

      // mark hit cache
      ctx.state.hit = cacheMiss ? 0 : 1;
    } catch (error) {
      if (error instanceof UidInvalidError) {
        ctx.status = 404;
        ctx.body = `找不到用户，传入 UID 格式有误。uid: ${uid}`;
        return;
      }
      if (error instanceof UserNotFoundError) {
        ctx.status = 404;
        ctx.body = `找不到用户，可能用户仅登录可见，不支持订阅。可以通过打开 https://m.weibo.cn/u/:uid 验证（<a href="https://m.weibo.cn/u/${uid}" target="_blank">uid: ${uid}</a>）`;
        return;
      }
      if (error instanceof ThrottledError) {
        ctx.status = 503;
        ctx.body = `暂时无法拉取到数据，请稍后再试。uid: ${uid}`;
        return;
      }
      ctx.status = 500;
      ctx.body = `未知错误，需管理员检查日志。uid: ${uid}`;
      logger.error(error);
    }
  });

  router.get('/api/domain2uid', async (ctx) => {
    const domain = ctx.request.query['domain'] as string;
    try {
      // verify
      if (!domain || !/^[A-Za-z0-9]{3,20}$/.test(domain)) {
        throw new DomainInvalidError(domain);
      }
      // start fetching
      let cacheMiss = false;
      const uid = await ctx.cache.memo(
        () => {
          cacheMiss = true;
          return ctx.weibo.fetchUIDByDomain(domain);
        },
        `dm-${domain}`,
        config.cacheTTL.apiDomain,
      );
      logger.debug(`domain: ${domain}, uid: ${uid}`);
      ctx.body = {
        success: true,
        uid
      };

      // mark hit cache
      ctx.state.hit = cacheMiss ? 0 : 1;
    } catch (error) {
      if (error instanceof DomainInvalidError || error instanceof DomainNotFoundError) {
        ctx.status = 404;
        ctx.body = {
          success: false,
          msg: '找不到用户，可能是地址格式不正确',
        };
        return;
      }
      logger.error(error);
      ctx.status = 500;
      ctx.body = {
        success: false,
        msg: '获取数据时发生了错误'
      };
    }
  })
};
