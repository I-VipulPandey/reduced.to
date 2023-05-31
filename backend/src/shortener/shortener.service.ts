import { AppCacheService } from '../cache/cache.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShortenerDto } from './dto';
import { UserContext } from '../auth/interfaces/user-context';
import { convertExpirationTimeToTtl } from '../cache/utils/ttl.util';
import { Url } from '@prisma/client';

@Injectable()
export class ShortenerService {
  constructor(
    private readonly appCacheService: AppCacheService,
    private readonly prisma: PrismaService,
    private readonly appConfigService: AppConfigService
  ) {}

  /**
   * Retrieves the original URL associated with a given shortened URL.
   * @param {string} shortenedUrl - The shortened URL.
   * @returns {Promise<string|null>} - The original URL if found, otherwise null.
   */
  getOriginalUrl = async (shortenedUrl: string): Promise<string | null> => {
    const originalUrl = await this.getUrlFromCache(shortenedUrl);
    if (originalUrl) {
      return originalUrl;
    }
    return this.getUrlFromDb(shortenedUrl);
  };

  /**
   * Retrieves the original URL from the cache based on a given shortened URL.
   * @param {string} shortenedUrl - The shortened URL.
   * @returns {Promise<string|null>} - The original URL if found in the cache, otherwise null.
   */
  getUrlFromCache = async (shortenedUrl: string): Promise<string> => {
    const originalUrl = await this.appCacheService.get(shortenedUrl);
    return originalUrl ? originalUrl.toString() : null;
  };

  /**
   * Checks if the url has already been shortened by a using a Regular Expression.
   * @param {String} shortUrl The short url
   * @returns {Boolean} Returns a boolean
   */
  isUrlAlreadyShortened = (shortUrl: string): boolean => {
    const domainRegex = new RegExp(this.appConfigService.getConfig().front.domain);
    return domainRegex.test(shortUrl);
  };

  /**
   * Generating the short url
   * @returns {String} Returns a random 5 characters url
   */
  generateShortenedUrl = (): string => {
    return Math.random().toString(36).substring(2, 7);
  };

  /**
   * Checks if a shortened URL is available (not in use).
   * @param {string} shortenedUrl - The shortened URL.
   * @returns {Promise<boolean>} - True if the shortened URL is available, false otherwise.
   */
  isShortenedUrlAvailable = async (shortenedUrl: string): Promise<boolean> => {
    const originalUrl = await this.getOriginalUrl(shortenedUrl);
    return originalUrl === null;
  };

  /**
   * Add the short url to the cache
   * @param {String} originalUrl The original url.
   * @param {String} shortenedUrl The shorten url.
   * @param {String} expirationTime The expiration time.
   */
  addUrlToCache = async (originalUrl: string, shortenedUrl: string, expirationTime?: Date) => {
    const ttl = convertExpirationTimeToTtl(expirationTime);
    if (!ttl) {
      await this.appCacheService.set(shortenedUrl, originalUrl);
    } else {
      const smallerTtl = Math.min(ttl, this.appConfigService.getConfig().redis.ttl);
      await this.appCacheService.set(shortenedUrl, originalUrl, smallerTtl);
    }
  };

  /**
   * Create a short URL based on the provided data.
   * @param {string} originalUrl - The original URL.
   * @param {string} [expirationTime] - The expiration time.
   * @returns {Promise<{ newUrl: string }>} Returns an object containing the newly created short URL.
   */
  createShortenedUrl = async (originalUrl: string, expirationTime?: Date): Promise<{ newUrl: string }> => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(originalUrl);

      // Checks if the URL is already reduced.
      if (this.isUrlAlreadyShortened(originalUrl)) {
        throw new Error('The URL is already shortened...');
      }
    } catch (err: any) {
      throw new BadRequestException(err.message || 'URL is invalid');
    }

    let shortUrl: string;

    do {
      shortUrl = this.generateShortenedUrl();
    } while (!(await this.isShortenedUrlAvailable(shortUrl)));

    await this.addUrlToCache(parsedUrl.href, shortUrl, expirationTime);
    return { newUrl: shortUrl };
  };

  /**
   * Create a db URL based on the provided data and user context.
   * @param {ShortenerDto} shortenerDto The data for creating a db URL.
   * @param {UserContext} user The user context.
   * @param {string} shortenedUrl The shortened URL.
   * @returns {Promise<any>} Returns the created db URL.
   */
  createDbUrl = async (shortenerDto: ShortenerDto, user: UserContext, shortenedUrl: string): Promise<Url> => {
    return this.prisma.url.create({
      data: {
        shortenedUrl: shortenedUrl,
        originalUrl: shortenerDto.originalUrl,
        userId: user.id,
        description: shortenerDto.description,
        expirationTime: shortenerDto.expirationTime,
      },
    });
  };

  /**
   * Retrieves the original URL associated with a given short URL from the database.
   * @param {string} shortenedUrl - The short URL.
   * @returns {Promise<string|null>} - The original URL if the original URL is found and valid, otherwise null.
   */
  getUrlFromDb = async (shortenedUrl: string): Promise<string | null> => {
    const url = await this.prisma.url.findFirst({
      where: {
        shortenedUrl,
      },
    });
    if (url?.expirationTime && url.expirationTime < new Date()) {
      return null;
    }
    return url ? url.originalUrl : null;
  };

  /**
   * Creates a shortened URL for a user based on the provided data.
   * @param {UserContext} user - The user context.
   * @param {ShortenerDto} shortenerDto - The request body containing the original URL and optional expiration time.
   * @returns {Promise<{ newUrl: string }>} - Returns an object containing the newly created short URL.
   */
  createUsersShortenedUrl = async (user: UserContext, shortenerDto: ShortenerDto): Promise<{ newUrl: string }> => {
    const { newUrl } = await this.createShortenedUrl(shortenerDto.originalUrl, new Date(shortenerDto.expirationTime));
    await this.createDbUrl(shortenerDto, user, newUrl);
    return { newUrl };
  };
}
