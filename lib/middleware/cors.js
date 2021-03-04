'use strict';

const S3Error = require('../models/error');

/**
 * Derived from https://docs.aws.amazon.com/AmazonS3/latest/dev/cors.html
 */
module.exports = () =>
  async function cors(ctx, next) {
    const config = await ctx.store.getSubresource(
      ctx.params.bucket,
      undefined,
      'cors',
    );
    // Prefer the Access-Control-Request-Method header if supplied
    const origin = ctx.get('origin');
    const method = ctx.get('access-control-request-method') || ctx.method;
    const matchedRule = config ? config.matchRule(origin, method) : undefined;

    if (ctx.method === 'OPTIONS') {
      if (!origin) {
        throw new S3Error(
          'BadRequest',
          'Insufficient information. Origin request header needed.',
        );
      }

      if (!ctx.get('access-control-request-method')) {
        throw new S3Error(
          'BadRequest',
          'Invalid Access-Control-Request-Method: null',
        );
      }

      // S3 only checks if CORS is enabled *after* checking the existence of access control headers
      if (!config) {
        throw new S3Error(
          'CORSResponse',
          'CORS is not enabled for this bucket.',
        );
      }

      const requestHeaders = ctx.get('access-control-request-headers')
        ? ctx.get('access-control-request-headers').split(',')
        : [];

      const allowedHeaders = matchedRule
        ? requestHeaders
            .map((header) => header.trim().toLowerCase())
            .filter((header) =>
              matchedRule.allowedHeaders.some((pattern) =>
                pattern.test(header),
              ),
            )
        : [];

      if (!matchedRule || allowedHeaders.length < requestHeaders.length) {
        throw new S3Error(
          'CORSResponse',
          'This CORS request is not allowed. This is usually because the ' +
            'evalution of Origin, request method / ' +
            'Access-Control-Request-Method or Access-Control-Request-Headers ' +
            "are not whitelisted by the resource's CORS spec.",
        );
      }

      ctx.set('Access-Control-Allow-Origin', '*');
      ctx.set(
        'Access-Control-Allow-Methods',
        matchedRule.allowedMethods.join(', '),
      );
      if (ctx.get('access-control-request-headers')) {
        ctx.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      }

      ctx.set(
        'Vary',
        'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      );

      ctx.body = '';
    } else if (config && matchedRule) {
      ctx.set(
        'Access-Control-Allow-Origin',
        matchedRule.hasWildcardOrigin ? '*' : origin,
      );
      if (matchedRule.exposeHeaders.length) {
        ctx.set(
          'Access-Control-Expose-Headers',
          matchedRule.exposeHeaders.join(', '),
        );
      }
      if (matchedRule.maxAgeSeconds != null) {
        ctx.set('Access-Control-Max-Age', matchedRule.maxAgeSeconds);
      }
      ctx.set('Access-Control-Allow-Credentials', true);
      ctx.set(
        'Vary',
        'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      );
    }
    return next();
  };
